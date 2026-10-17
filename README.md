<img width="80" height="80" alt="e48047189483de2534eb929b89a09a7b" src="https://github.com/user-attachments/assets/8353cc36-5c0a-4ec1-a581-660ae9d4d03e" />

# ClamAV Web UI (clamav-web-client)

A lightweight web interface for running ClamAV scans through one or more **clamd** endpoints, tracking **scan jobs**, and managing **admin settings** such as allowed scan roots, watch directories, webhook notifications, and audit logging.

This repository contains the **web client** application (Spring Boot) that:
- Accepts scan requests (upload / path scan)
- Dispatches scans to a configured **clamd** endpoint
- Stores job state/results in its internal database
- Shows results, job details, and audit events in the UI

> **Important:** This app tracks **jobs that are created through this web client (UI or its REST API)**.  
> If another server talks to `clamd` directly (e.g., via `clamdscan`), those scans are **not visible** here unless they were initiated via this app.

---

## What it does (high level)

### Scan types
- **Upload scan**: you upload one or more files → the web app stores them → sends them to clamd via streaming (`INSTREAM`) → records result.
- **Path scan**: you provide an absolute path (must be under allowed roots) → web app asks clamd to scan that path (or streams contents depending on configuration) → records result.

### Jobs
Every scan request becomes a **job** with:
- **ID**
- **Type** (UPLOAD / PATH / WATCH)
- **Status** (QUEUED → RUNNING → FINISHED / ERROR)
- **Verdict** (OK / VIRUS_FOUND / ERROR)
- Target (filename or path)
- Endpoint used
- Submitted by / timestamps
- Detected signatures (when virus found)
- Error message (if any)

### Admin features
- Manage clamd endpoints
- Manage users (basic auth)
- Configure allowed scan roots
- Watch directories (periodic polling)
- Webhook notifications (optional)
- Audit log (admin events)

---

## UI tabs & what each one contains

<img width="1695" height="703" alt="Screenshot 2026-02-05 at 21 42 05" src="https://github.com/user-attachments/assets/66f74f23-f326-4774-ba59-e0ba33c1ffa3" />

### 1) Dashboard
Purpose: quick overview.
- Endpoint count, recent jobs, default endpoint
- “Latest scan jobs” snapshot
- Endpoint health preview (status + basic ping/version output)

### 2) Main
Purpose: **only** Endpoint Health.
- Select an endpoint
- Refresh health data (ping/version/stats depending on endpoint response)

### 3) Scan
Purpose: submit scans.
- **Upload scan**
  - Choose files
  - Select endpoint
  - Queue scan
- **Path scan**
  - Absolute path
  - Select endpoint
  - Queue scan
- Short “Scan jobs” table snippet (recent results)

### 4) Clamdtop
Purpose: live view of clamd’s internal state.
- Runs the **native `clamdtop`** TUI inside the web-client container and streams it to the browser over a WebSocket (`/ws/clamdtop`)
- Select an endpoint (defaults to the default endpoint)
- Needs the `clamdtop` binary in the image (installed from the `clamav-daemon` package in the `Dockerfile`)

> Clamdtop talks to clamd directly; it does **not** create scan jobs.

### 5) Scan jobs
Purpose: operations view.
- Full jobs list with status/verdict/target/endpoint/user
- Click a job ID for job detail:
  - timestamps
  - detected signatures
  - stored file path (if enabled/visible)
  - quarantine info (if enabled)
  - error message/log details

### 6) Settings
Purpose: configuration view.
- **Quick settings** (read-only summary on the UI)
- **Admin settings** (editable):
  - Allowed scan roots (for path scans and watch)
  - Upload max size
  - Concurrent scans (executor threads)
  - Quarantine on/off
  - Webhook on/off + URL
  - Watch on/off + poll interval

> Some settings may require an app restart to fully apply (e.g., concurrency).

### 7) Endpoints
Admin page: **ClamD endpoints**
- Create/update/delete endpoints
- Enable/disable endpoint
- Configure host/port/platform (platform only affects path handling: `UNIX`, `WINDOWS`, `JVM`; the connection is always TCP `host:port`)

### 8) Users
Admin page: **Users**
- Create users
- Change passwords
- Enable/disable users

### 9) Watch
Admin page: **Watch directories**
- Add watched directories (must be inside allowed roots)
- Enable/disable watch entries
- When enabled globally, watcher queues scan jobs for new/changed files

### 10) Audit
Admin page: **Audit log**
- Records admin actions such as:
  - endpoint changes
  - user changes
  - settings changes
  - watch changes

---

## Watch directories: how it works

The watcher runs **inside the web client container** and periodically polls configured directories:
- Poll interval is controlled by the **Watch poll seconds** setting (in Settings).
- For each watched directory, the service detects changes (new/modified files).
- For each detected change, a **scan job** is queued automatically.

### Can I set scan interval from GUI?
Yes — via **Watch poll seconds** in *Settings*.

**Notes**
- Paths must be under **Allowed scan roots**.
- If the web client container cannot see the path (missing volume mount), watch will not work.

---

## Webhook URL: how it works

If webhooks are enabled:
- On job completion (FINISHED/ERROR), the app can POST a payload to the configured URL.
- Typical use: notify another system (Home Assistant, Slack gateway, custom API) that a scan completed.

Payload content depends on your build, but generally includes:
- jobId, status, verdict
- endpoint
- target
- timestamps
- detected signatures (if any)

---

## Quarantine: how it works

When enabled:
- If a job verdict is **VIRUS_FOUND**, the uploaded file may be moved or copied into a quarantine directory.
- The job record stores `quarantinePath`.

**Important**
- Quarantine applies primarily to **upload scans** (where the app owns the file).
- For path scans, quarantine depends on implementation and permissions.

---

## REST API usage (CLI examples)

### Authentication
Most `/api/**` endpoints are protected with **Basic Auth**.

Example:
```bash
curl -u 'admin:admin' http://HOST:8080/api/jobs
```

### List jobs
```bash
curl -sS -u 'admin:admin' 'http://HOST:8080/api/jobs'
```

### Upload scan (correct multipart fields)
In your build, the upload endpoint expects:
- `endpointId` (numeric)
- `files` (one or more file parts)

```bash
curl -v -u 'admin:admin' \
  -F 'endpointId=33' \
  -F 'files=@/path/to/test.txt' \
  'http://HOST:8080/api/scan/upload'
```

Multiple files:
```bash
curl -v -u 'admin:admin' \
  -F 'endpointId=33' \
  -F 'files=@/path/a.txt' \
  -F 'files=@/path/b.txt' \
  'http://HOST:8080/api/scan/upload'
```

### Path scan
```bash
curl -v -u 'admin:admin' \
  -H 'Content-Type: application/json' \
  -d '{"endpointId":33,"path":"/scandir/somefile"}' \
  'http://HOST:8080/api/scan/path'
```

### Why an unauthenticated curl returns 401
If you see `HTTP/1.1 401` and `WWW-Authenticate: Basic ...`, add `-u user:pass`.

---

## How to run scans from terminal (direct ClamAV vs via this app)

### A) Via this Web UI (recommended for tracking jobs)
Use the **API** commands above (`/api/scan/upload`, `/api/scan/path`) so the scan appears in:
- Scan jobs
- Job details
- Audit / webhook (if enabled)

### B) Directly against clamd (not tracked in this app)
Example from a host that can reach clamd:
```bash
clamdscan --fdpass --host=192.18.68.1 --port=3310 /path/to/file
```

These scans will show in **clamd logs**, but **will not create jobs** in this web UI.

---

## ClamAV logs: where to see scan logs

### In Docker
```bash
docker logs -n 200 clamav
```

### Can clamd log the original filename for INSTREAM scans?
Usually **no**, because INSTREAM is a byte stream; clamd doesn’t know the original filename.  
You’ll see entries like:
- `instream(172.18.0.1@PORT): OK`
- `instream(...): Eicar-Test-Signature FOUND`

If you need filenames in server logs, prefer **path scans** (where clamd sees a real file path) and enable logging options in `clamd.conf`.

---

## Docker deployment (model docker-compose.yml)

```yaml

services:
  clamav-server:
    image: clamav/clamav:latest
    container_name: clamav
    restart: unless-stopped
    ports:
      - "3310:3310"
    volumes:
      - clamav-db:/var/lib/clamav
    environment:
      - TZ=UTC

  clamav-web-client:
    build: .
    container_name: clamav-web-client
    restart: unless-stopped
    depends_on:
      - clamav-server
    ports:
      - "8080:8080"
    environment:
      - TZ=UTC
      - CLAMAV_HOST=clamav-server
      - CLAMAV_PORT=3310
    volumes:
      - ./data:/app/data
      # Seed settings, read-only. Optional - the runtime store is ./data/settings.properties.
      - ./conf:/app/conf:ro
      # If you use PATH scan / WATCH you MUST mount your scan roots:
      - /scandir:/scandir:ro

volumes:
  clamav-db: {}
```

> The official `clamav/clamav` image already exposes clamd over TCP on `3310`, so no custom
> `clamd.conf` is required. If you want to customise it, mount a file (not a whole directory):
> `./clamd.conf:/etc/clamav/clamd.conf:ro`.

### Common volume mistake (file vs directory)
If you mount a **file** onto a **directory** path (or vice versa), Docker errors like:
> "Are you trying to mount a directory onto a file (or vice-versa)?"

Good:
- `./conf:/app/conf:ro`  ✅ (directory → directory, read-only seed)

If you want to mount a single file:
- `./clamd.conf:/etc/clamav/clamd.conf:ro` ✅ (file → file)

---

## Database & schema migrations

By default the app uses an embedded H2 file database at `./data/clamav-web-client.mv.db`
(that is what the `./data:/app/data` volume keeps). PostgreSQL is supported as well - just
point the datasource at it:

```yaml
    environment:
      - SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/clamavweb
      - SPRING_DATASOURCE_USERNAME=clamavweb
      - SPRING_DATASOURCE_PASSWORD=changeme
```

The schema is **owned by Flyway**, not by Hibernate:

- migration scripts live in `src/main/resources/db/migration/h2/` and
  `src/main/resources/db/migration/postgresql/` (Flyway picks the matching folder via
  `spring.flyway.locations=classpath:db/migration/{vendor}`);
- Spring Boot runs the migrations before the app starts, and Hibernate only *validates*
  that the entities match the migrated schema (`spring.jpa.hibernate.ddl-auto=validate`);
- the applied migrations are recorded in the `flyway_schema_history` table.

Databases created by older versions of the app (when Hibernate still used
`ddl-auto=update`) are **baselined automatically** at version 1 (`spring.flyway.baseline-on-migrate`),
so an existing installation keeps its data instead of being recreated. PostgreSQL databases
whose `scan_jobs.found_viruses_json` / `error_message` columns are still OID large objects
are converted to `TEXT` by `V2__lo_to_text.sql` during that first startup.

To change the schema, add a new script with the next version, e.g.
`db/migration/h2/V3__add_something.sql` (and the matching `postgresql/V3__add_something.sql`).
Never edit a migration that has already been released - Flyway checksums it.

---

## Settings: seed file vs runtime store

Settings are split into two files so that a configuration file from your machine is
never rewritten by the running container:

- **`data/settings.properties`** - the writable **runtime store**. It lives in the data
  volume next to the database and is what the *Admin settings* page writes.
- **`conf/clamav-web-client.properties`** - an optional, **read-only seed**. It is only
  read at startup, and only for keys the runtime store does not have yet.

Effective precedence for a key is:

```
environment variable  >  runtime store  >  seed file  >  built-in default
```

Because the runtime store wins, editing the seed file does **not** override a value you
already changed in the UI - delete the key from `data/settings.properties` (or the whole
file) if you want the seed to apply again. Mount the seed directory read-only
(`./conf:/app/conf:ro`); the app never needs to write there.

Upgrading from an older version needs no manual step: those installations kept their
settings in `conf/clamav-web-client.properties`, and the first start imports them into
the new runtime store.

Container environment variables still override everything (`CLAMAV_HOST`,
`CLAMAV_PORT`, `CLAMAV_UPLOAD_PATH_SCAN_ENABLED`,
`CLAMAV_UPLOAD_PATH_SCAN_FALLBACK_TO_INSTREAM`).

---

## Troubleshooting quick hits

### Jobs stuck in QUEUED
Check web-client logs:
```bash
docker logs -n 300 clamav-web-client | egrep -i "scan|job|queue|error|exception"
```

Check clamd reachability:
```bash
docker run --rm --network container:clamav-web-client alpine sh -lc '
  apk add --no-cache busybox-extras >/dev/null
  nc -vz -w 3 clamav-server 3310 || true
'
```

### “Required part 'files' is not present.”
Use `files=@...` (not `file=@...`).

### “Required parameter 'endpointId' is not present.”
Use numeric `endpointId=<number>` (not `endpointName`).

---

## Security notes
- Change default credentials (`admin/admin`) immediately.
- Do not expose directly to the internet without TLS + an auth gateway.
- Restrict allowed scan roots to minimal paths.

  ## This application was inspired and contains code from https://github.com/rguziy/clamav-web-client
