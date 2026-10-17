package info.trizub.clamav.webclient.service;

import info.trizub.clamav.webclient.model.*;
import info.trizub.clamav.webclient.repo.ScanJobRepository;
import info.trizub.clamav.webclient.util.HashUtils;
import info.trizub.clamav.webclient.util.PathPolicy;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

/**
 * Creates and queries scan jobs (uploads, path scans, watched files) and hands them
 * over to {@link ScanExecutionService}. Job state transitions live in
 * {@link ScanJobStateService}.
 */
@Service
public class ScanJobService {

    private static final Logger log = LoggerFactory.getLogger(ScanJobService.class);

    private final ScanJobRepository repo;
    private final SettingsService settings;
    private final ScanExecutionService executor;

    public ScanJobService(ScanJobRepository repo, SettingsService settings, ScanExecutionService executor) {
        this.repo = repo;
        this.settings = settings;
        this.executor = executor;
    }

    @PostConstruct
    public void resumeQueued() {
        // If app restarts, re-enqueue queued/running jobs as queued
        repo.findAll().stream()
                .filter(j -> j.getStatus() != ScanJobStatus.FINISHED)
                .forEach(j -> {
                    j.setStatus(ScanJobStatus.QUEUED);
                    repo.save(j);
                    executor.enqueue(j.getId());
                });
    }

    public List<ScanJob> latest() {
        return repo.findTop200ByOrderBySubmittedAtDesc();
    }

    /**
     * Fetch a job by id.
     *
     * NOTE: The web UI should not 500 if a job id is missing (e.g. stale link),
     * so this method returns null when not found.
     */
    public ScanJob getOrNull(String id) {
        return repo.findById(id).orElse(null);
    }

    @Transactional
    public List<ScanJob> createUploadJobs(List<MultipartFile> files, ClamdEndpoint endpoint, String username) {
        List<ScanJob> jobs = new ArrayList<>();
        for (MultipartFile f : files) {
            if (f == null || f.isEmpty()) continue;
            if (f.getSize() > settings.uploadMaxBytes()) {
                throw new IllegalArgumentException("File too large: " + f.getOriginalFilename());
            }
            try {
                Path uploadDir = settings.uploadDir();
                Files.createDirectories(uploadDir);
                String safeName = (f.getOriginalFilename() == null ? "upload" : f.getOriginalFilename())
                        .replaceAll("[^a-zA-Z0-9._-]", "_");
                String id = newJobId();
                Path stored = uploadDir.resolve(id + "-" + safeName);

                // Save file
                try (InputStream in = f.getInputStream()) {
                    Files.copy(in, stored, StandardCopyOption.REPLACE_EXISTING);
                }

                // Hash
                String sha;
                try (InputStream in2 = Files.newInputStream(stored)) {
                    sha = HashUtils.sha256(in2);
                }

                ScanJob job = new ScanJob();
                job.setId(id);
                job.setType(ScanJobType.UPLOAD);
                job.setTarget(safeName);
                job.setStoredPath(stored.toString());
                job.setSha256(sha);
                job.setSizeBytes(f.getSize());
                job.setEndpoint(endpoint);
                jobs.add(startScan(job, username));
            } catch (Exception e) {
                log.error("Failed to create upload job: {}", e.getMessage());
            }
        }
        return jobs;
    }

    @Transactional
    public ScanJob createPathJob(String path, ClamdEndpoint endpoint, String username) {
        Path requested = PathPolicy.normalize(path);

        if (!PathPolicy.isUnderAllowedRoots(requested, settings.allowedRoots())) {
            throw new IllegalArgumentException("Path is not allowed by policy. Allowed roots: " + settings.allowedRoots());
        }

        ScanJob job = new ScanJob();
        job.setType(ScanJobType.PATH);
        job.setTarget(requested.toString());
        job.setEndpoint(endpoint);
        return startScan(job, username);
    }

    @Transactional
    public ScanJob createWatchFileJob(Path file, ClamdEndpoint endpoint, String username) {
        ScanJob job = new ScanJob();
        job.setType(ScanJobType.WATCH);
        job.setTarget(file.toAbsolutePath().normalize().toString());
        job.setEndpoint(endpoint);
        return startScan(job, username != null ? username : "watcher");
    }

    /**
     * Single point where a new scan job is persisted and scheduled for execution.
     * Callers only pre-fill the type, target, endpoint and any type-specific fields.
     */
    private ScanJob startScan(ScanJob job, String submittedBy) {
        job.setId(newJobId());
        job.setStatus(ScanJobStatus.QUEUED);
        job.setSubmittedBy(submittedBy);
        job.setSubmittedAt(Instant.now());
        repo.save(job);
        enqueueAfterCommit(job.getId());
        return job;
    }

    private static String newJobId() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    private void enqueueAfterCommit(String jobId) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    executor.enqueue(jobId);
                }
            });
        } else {
            executor.enqueue(jobId);
        }
    }
}
