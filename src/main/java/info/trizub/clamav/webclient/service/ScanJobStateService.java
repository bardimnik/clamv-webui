package info.trizub.clamav.webclient.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import info.trizub.clamav.webclient.model.ScanJob;
import info.trizub.clamav.webclient.model.ScanJobStatus;
import info.trizub.clamav.webclient.model.ScanVerdict;
import info.trizub.clamav.webclient.repo.ScanJobRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;

/**
 * Single owner of scan-job state transitions.
 *
 * <p>These methods used to be duplicated in {@link ScanJobService} (unused) and
 * {@link ScanExecutionService} (used), and the webhook notification was triggered
 * from several call sites - which meant clean scans never produced a notification.
 * Routing every transition through this class keeps the behaviour in one place:
 * a job always ends up with a consistent status/verdict/timestamps and, when
 * webhooks are enabled, exactly one notification per finished job.</p>
 */
@Service
public class ScanJobStateService {

    private final ScanJobRepository repo;
    private final ObjectMapper mapper;
    private final NotificationService notifications;

    public ScanJobStateService(ScanJobRepository repo, ObjectMapper mapper, NotificationService notifications) {
        this.repo = repo;
        this.mapper = mapper;
        this.notifications = notifications;
    }

    @Transactional
    public void markRunning(String id) {
        ScanJob job = repo.findById(id).orElseThrow();
        job.setStatus(ScanJobStatus.RUNNING);
        job.setStartedAt(Instant.now());
        repo.save(job);
    }

    @Transactional
    public void finishOk(String id) {
        ScanJob job = repo.findById(id).orElseThrow();
        job.setStatus(ScanJobStatus.FINISHED);
        job.setVerdict(ScanVerdict.OK);
        job.setFinishedAt(Instant.now());
        repo.save(job);
        notifyAfterCommit(job);
    }

    @Transactional
    public void finishFound(String id, Object foundViruses) {
        ScanJob job = repo.findById(id).orElseThrow();
        job.setStatus(ScanJobStatus.FINISHED);
        job.setVerdict(ScanVerdict.VIRUS_FOUND);
        try {
            job.setFoundVirusesJson(mapper.writeValueAsString(foundViruses));
        } catch (Exception e) {
            job.setFoundVirusesJson(String.valueOf(foundViruses));
        }
        job.setFinishedAt(Instant.now());
        repo.save(job);
        notifyAfterCommit(job);
    }

    @Transactional
    public void finishError(String id, String message) {
        ScanJob job = repo.findById(id).orElseThrow();
        job.setStatus(ScanJobStatus.FINISHED);
        job.setVerdict(ScanVerdict.ERROR);
        job.setErrorMessage(message);
        job.setFinishedAt(Instant.now());
        repo.save(job);
        notifyAfterCommit(job);
    }

    @Transactional
    public void setQuarantinePath(String id, String quarantinePath) {
        ScanJob job = repo.findById(id).orElseThrow();
        job.setQuarantinePath(quarantinePath);
        repo.save(job);
    }

    /**
     * Fire the webhook only once the transaction that persisted the final state has
     * committed, so a rolled-back transition never notifies and the HTTP call does not
     * run while the database transaction is still open.
     */
    private void notifyAfterCommit(ScanJob job) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    safeNotify(job);
                }
            });
        } else {
            safeNotify(job);
        }
    }

    private void safeNotify(ScanJob job) {
        try {
            notifications.notifyIfNeeded(job);
        } catch (Exception ignored) {
            // Notification failures must never break scan bookkeeping.
        }
    }
}
