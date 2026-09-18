# Operations

This guide covers how to install, run, update, observe and recover a FinancialOS deployment on a single host.
Everything here is generic. Host names, addresses and other deployment-specific notes live only in the private
runtime directory, never in this repository.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) (runtime topology), [SECURITY.md](SECURITY.md),
[BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md), [DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md).

## 1. What runs where

| Compose project | Purpose | App port (host) | Data |
|---|---|---|---|
| `financialos` | production | `127.0.0.1:3180`, plus `$FOS_TAILSCALE_IP:3180` when the direct-Tailscale-IP access method (section 10) is configured | volumes `financialos_pgdata`, `financialos_documents` (external) and `$FOS_RUNTIME_DIR/backups` |
| `financialos-dev` | synthetic demo data | `127.0.0.1:3190` | volumes `financialos_dev_*`, secrets in `$FOS_RUNTIME_DIR/dev/` |
| `financialos-e2e` | disposable end-to-end tests | `127.0.0.1:3181` | tmpfs only, secrets in a temporary directory |
| `financialos-test` | integration-test database (`deploy/scripts/test-db.sh`) | `127.0.0.1:55432` (database) | tmpfs |
| `financialos-restore-<ts>` | isolated restore verification | none | tmpfs, removed after each run |

Each production stack has four services built from one image (`financialos:<tag>`):

* `db`: PostgreSQL 17. It sits on the `internal` network only (`internal: true`, no published port).
* `migrate`: a one-shot job. It applies migrations as `fos_migrator`, then loads the private owner bootstrap file
  if one is present. The load is idempotent.
* `app`: the Fastify API that also serves the SPA. It is published on `127.0.0.1` and, optionally, the host's
  Tailscale address (never `0.0.0.0` or the LAN; see section 10). It sits on the `internal`
  network plus an `egress` bridge for provider APIs.
* `worker`: runs background jobs, scheduled backups and retention, on the `internal` and `egress` networks.

Hardening applies to every application container:

* The user is `10001:10001`, the root filesystem is read-only, and `/tmp` is a tmpfs.
* `cap_drop: ALL` and `no-new-privileges` are set, and an init process runs as PID 1.
* Memory, CPU and PID limits are set.
* The Docker socket is never mounted, and no container is privileged.
* The database runs as the `postgres` user (uid 999) with a read-only root filesystem.

Statement logging is disabled (`log_statement=none`, `log_min_error_statement=panic`), so SQL text containing
financial values never reaches the logs.

## 2. Runtime directory

`FOS_RUNTIME_DIR` (default `/srv/projects/financialos`) holds everything private. `init-runtime.sh` creates this
layout:

```
$FOS_RUNTIME_DIR/                 0700
├── config/                       0700  app-config.json (0640) and status files the app shows:
│                                       route-status.json, restore-verify-status.json, release.json, disk-status.json
├── secrets/                      0700  db-*-password, keyring.json, session-pepper, backup-key,
│                                       bootstrap-secret.sha256 (all 0640), bootstrap-secret (0600, never mounted)
├── bootstrap/                    0700  owner-bootstrap.json (optional private initial data, 0640)
├── backups/                      2770  encrypted backups written by the worker
├── reports/                      0700  restore-verification reports
├── baseline/                     0700  host-check snapshots
├── tailscale-backup/             0700  copies of the Tailscale Serve config taken before route changes
├── notes/                        0700  releases.log, builds.log, private operator notes
├── logs/  tmp/                   0700
├── dev/                          0700  secrets and config of the demo stack
├── e2e/current.env               0600  pointer to the running e2e stack
├── release.env                   0640  FOS_IMAGE, FOS_PREVIOUS_IMAGE, data volume names
├── build.env                     0640  last image built by build-image.sh
└── deploy.lock                         serialises deploy, rollback, migrate, restore, start and stop
```

**How secrets reach uid 10001.** Outside swarm mode, Compose file secrets are bind mounts, and their `uid`,
`gid` and `mode` options are ignored (verified with Compose v5). Secret and config files are therefore mode
`0640`, and their group is the operator's primary group. Every container joins that group through `group_add`,
and the scripts pass it as `FOS_SECRETS_GID`, the group of `secrets/`.

The files are never readable by other users, and the parent directory is `0700`. The application refuses secret
files that are readable by "other". Inside the container, each role's database password is always mounted at
`/run/secrets/db-password`.

## 3. Requirements

* Docker Engine with Compose v2.24 or later (tested with Engine 29 and Compose v5), with the Docker daemon enabled
  at boot. No root is needed beyond membership in the `docker` group.
* `bash`, `python3`, `openssl`, `curl`, `flock`, `git`, and Node.js 22 on the host. Node.js runs the privacy
  scan in `build-image.sh`.
* Optional: Tailscale with MagicDNS for the private HTTPS route.

## 4. First-time installation

```bash
# 1. Private runtime directory and secrets (prints file paths only)
deploy/scripts/init-runtime.sh

# 2. Optional: private initial data (never committed)
cp /path/to/owner-bootstrap.json "$FOS_RUNTIME_DIR/bootstrap/" && chmod 0640 "$FOS_RUNTIME_DIR/bootstrap/owner-bootstrap.json"

# 3. Runtime configuration. The origin is the URL you will open in the browser (see section 10).
deploy/scripts/write-config.sh --origin https://<node>.<tailnet>.ts.net:8443 --extra-origin http://localhost:3180

# 4. Record the state of the shared host before anything is deployed
deploy/scripts/host-check.sh snapshot pre-deploy

# 5. Build the image. It is tagged financialos:<sha> and financialos:<sha>-<timestamp>, and its browser
#    artifacts are privacy-scanned.
deploy/scripts/build-image.sh

# 6. Deploy the timestamped tag printed by the build
deploy/scripts/deploy.sh financialos:<sha>-<timestamp>

# 7. Plan the private HTTPS route and hand the printed command to the owner (section 10)
deploy/scripts/tailscale-route.sh plan

# 8. Host-side schedules (disk check, route status, weekly restore verification)
deploy/scripts/install-timers.sh install

# 9. Prove nothing else on the host changed
deploy/scripts/host-check.sh snapshot post-deploy
deploy/scripts/host-check.sh compare pre-deploy post-deploy
```

Keep offline copies of `secrets/keyring.json` and `secrets/backup-key` somewhere other than this machine (see
[BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).

## 5. Owner setup (one-time bootstrap secret)

A fresh deployment has no owner account. The first visit starts a setup flow, which asks for the one-time
bootstrap secret that `init-runtime.sh` generated.

1. On the host (for example over SSH), print the secret:
   `cat "$FOS_RUNTIME_DIR/secrets/bootstrap-secret"`.
   Type or paste it only into the FinancialOS setup screen. Never send it by chat or email, and never store it
   anywhere else.
2. Open the app (section 10), enter the secret, create the password, enrol TOTP, and save the recovery codes.
   Optionally, add a passkey.
3. Seal the setup. From then on, every setup endpoint returns `410 Gone`, and the bootstrap secret is useless.
   The app only ever holds its SHA-256 hash, `bootstrap-secret.sha256`. That file must stay in place because
   Compose mounts it, but it is inert after sealing. You may delete `secrets/bootstrap-secret` itself.

To replace an unused secret before setup, run `init-runtime.sh --rotate-bootstrap-secret`, then
`start.sh --restart app`.

## 6. Releases

* **Build.** `build-image.sh` builds natively on the host architecture. It runs under `nice` behind a shared
  build lock, and only after checking free memory. It uses a 2 GiB Node heap limit and at most 4 npm sockets.
  After the build, it copies the web bundle and the extension package out of the image. It runs
  `scripts/privacy/privacy-check.mjs --dir` and `scripts/privacy/secret-scan.sh --dir` on both, and deletes the
  new tags if either scan reports a finding. A working tree with uncommitted changes is tagged `<sha>-dirty-…`.
* **Deploy.** Run `deploy.sh <tag>`. The tag is always explicit: `latest` and implicit pulls are refused. The
  script works in this order:
  1. Takes the deploy lock and checks the runtime files and free memory and disk.
  2. Records the previous tag.
  3. Takes an encrypted pre-deploy backup, if a database exists.
  4. Starts `db`, then runs `migrate`, then recreates `app` and `worker`.
  5. Waits for health, then runs the smoke checks.
  6. On failure, rolls back to the previous tag automatically.

  Results go to `release.env`, `config/release.json` and `notes/releases.log`.
* **Smoke checks** (deploy, rollback and start):
  * `/healthz` and `/readyz` return 200.
  * `/` returns HTML with `Content-Security-Policy`, `Cache-Control: no-store` and `nosniff`.
  * `/api/today` returns 401 without a session.
  * The only published port(s) are `127.0.0.1:3180->3000` on the app, plus `$FOS_TAILSCALE_IP:3180->3000` when
    the direct-Tailscale-IP access method (section 10) is configured -- never `0.0.0.0`.
* **Rollback.** Run `rollback.sh [tag]`. It uses the previous tag by default and asks for confirmation (use
  `--yes` in scripts).
* **Migrations are forward-only.** A rollback changes only the application image. If the older release cannot
  run against the newer schema, restore the pre-deploy backup with `restore.sh`
  (see [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).
* `migrate.sh` re-runs migrations for the current release. Migrations run under the deploy lock and a database
  advisory lock.

## 7. Health, status and logs

| Command | Shows |
|---|---|
| `deploy/scripts/health.sh [--project prod\|dev\|e2e]` | Container health, `/healthz`, `/readyz`, published ports, newest backup age, restore verification, route and disk status. Exits 1 when unhealthy. |
| `deploy/scripts/status.sh` | Release, all `financialos*` containers, `docker stats`, backups, status files, health. |
| `deploy/scripts/logs.sh [app\|worker\|db\|migrate] [--since 2h] [--follow]` | Container logs. The app and worker redact secrets and amounts before logging. |
| `deploy/scripts/disk-check.sh` | Free space for the runtime directory and Docker's data root. Writes `config/disk-status.json` and exits 1 when critical (default: 95 % used, or less than 5 GiB free). |
| `deploy/scripts/stop.sh` / `start.sh [--restart app]` | Stop or start the `financialos` project only. After `write-config.sh`, restart the app. |

Container logs use the `json-file` driver with 10 MiB × 5 files per production container (3 files for dev,
2 for e2e and restore).

Containers use `restart: unless-stopped`, so they come back after a reboot or a Docker restart. Containers
stopped with `stop.sh` stay stopped.

## 8. Scheduled work

* **Backups** run inside the worker on its own schedule, daily by default. Retention keeps 14 daily and 8 weekly
  backups by default. The worker also records job health and disk space for its own mounts.
* **Host timers** are systemd user units installed by `install-timers.sh install`. Lingering must be enabled for
  the user so they run without a login session.
  * `financialos-disk-check`: hourly.
  * `financialos-route-status`: every 30 minutes.
  * `financialos-restore-verify`: weekly, Sunday 04:30.

  All of them run with `Nice=15` and idle I/O priority. `install-timers.sh render <dir>` writes the unit files for
  review, and `remove` uninstalls them.

## 9. Resource budget

Production limits:

| Service | Memory limit | CPUs | PIDs | Notes |
|---|---|---|---|---|
| db | 768 MiB (+128 MiB shm) | 1.5 | 200 | `shared_buffers=128MB`, `work_mem=8MB`, `max_connections=40` |
| app | 512 MiB | 1.0 | 256 | Node heap capped at 320 MiB, `/tmp` 64 MiB |
| worker | 768 MiB | 1.0 | 256 | Node heap capped at 448 MiB, `/tmp` 256 MiB |
| migrate | 512 MiB | 1.0 | 128 | one-shot, not concurrent with steady state |
| **steady state total** | **≈ 2 GiB** | | | |

tmpfs pages count against the container that writes them. The e2e and restore-verification databases have larger
limits because their data lives in memory, but they run only briefly.

Measured usage (`docker stats --no-stream`, `financialos*` containers only) is recorded in the table below. The
numbers come from the demo stack and are refreshed after each production deployment.

| Measurement | db | app | worker |
|---|---|---|---|
| see "Measured usage" below | | | |

### Measured usage

Measurements are added here when a stack has been run on the target host with the release being documented.

## 10. Private access

### Tailscale Serve (preferred)

`deploy/scripts/tailscale-route.sh plan` is read-only. It works as follows:

1. Reads the node's DNS name and the current Serve configuration, and backs the configuration up to
   `tailscale-backup/`.
2. Checks that HTTPS port 8443 is unused, both in Serve and by any listener.
3. Prints the exact steps below and writes `config/route-status.json`.

The owner then completes the route:

1. **Prerequisite:** in the Tailscale admin console, open **DNS** and enable **HTTPS Certificates**. MagicDNS
   must be on.
2. Add the route. The command is additive: it does not touch other Serve entries, and it never enables Funnel.
   ```bash
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:3180
   ```
3. Set the origin and restart the app:
   ```bash
   deploy/scripts/write-config.sh --force --origin https://<node>.<tailnet>.ts.net:8443 --extra-origin http://localhost:3180
   deploy/scripts/start.sh --restart app
   ```
4. Verify from the host with full certificate validation. `verify` never uses `-k`.
   ```bash
   deploy/scripts/tailscale-route.sh verify
   ```

To roll back, remove only this entry:

```bash
sudo tailscale serve --https=8443 off
```

The scripts never run a modifying `tailscale serve` command, never reset the Serve configuration, and never
enable Funnel. `tailscale-route.sh status` fails if Funnel is ever enabled for the FinancialOS handler.
`--bg` routes persist across reboots.

If HTTPS certificates cannot be enabled (for example, no sudo / not the tailnet's Tailscale operator on a
shared host), use the SSH tunnel or the direct Tailscale IP method below instead. Never bind the app to
`0.0.0.0` or the LAN, and never weaken TLS on a route that has it.

### SSH tunnel (alternative)

```bash
ssh -L 3180:127.0.0.1:3180 <host>
# then open http://localhost:3180
```

The configuration must list `http://localhost:3180` as an allowed origin (`--extra-origin`). Password + TOTP
works through the tunnel. A passkey enrolled for the HTTPS origin does not, because WebAuthn binds it to that
host name. This keeps the app's own origin at loopback; nothing below applies.

### Direct Tailscale IP, plain HTTP (alternative, no sudo required)

Use this when Tailscale Serve is unavailable (no sudo, not the tailnet operator) and an SSH tunnel is not
practical for the client. The app is published directly on the host's Tailscale address, over plain HTTP: the
tailnet's own WireGuard tunnel between devices is the encryption layer, in place of TLS terminated at the app.

1. Publish the port on the Tailscale interface as well as loopback. `FOS_TAILSCALE_IP` is deployment-specific
   and lives only in `$FOS_RUNTIME_DIR/network.env` (never a tracked file):
   ```bash
   fos_env_set "$FOS_RUNTIME_DIR/network.env" FOS_TAILSCALE_IP <the host's tailnet IP>
   ```
   `deploy/compose/prod.compose.yml` then publishes the app port on both `127.0.0.1` and that address; never
   on `0.0.0.0`. Redeploy or restart the `app` service to pick up the new binding.
2. Set the origin and restart the app. `apps/api/src/config.ts` accepts plain `http://` for loopback origins and, as the one other exception, hosts in Tailscale's own CGNAT range (`100.64.0.0/10`, privacy-check: allow-generic) -- nothing else:
   ```bash
   deploy/scripts/write-config.sh --force --origin http://<tailnet-ip>:3180 --extra-origin http://localhost:3180
   deploy/scripts/start.sh --restart app
   ```
   Loopback stays allowed for local/SSH-tunnel access; nothing about CSRF, `Origin` checking, `SameSite`,
   authentication, or the ten-minute absolute session lifetime changes.
3. Verify: `deploy/scripts/health.sh` checks `/healthz` and `/readyz` on both addresses when the target is
   `prod`, and confirms only those two publish the app port.

Consequences, all inherent to plain HTTP rather than to this app's implementation:

* The session cookie drops the `Secure` attribute and the `__Host-` prefix (browsers refuse `__Host-` cookies
  over plain HTTP); it becomes `fos_session` instead of `__Host-fos_session`. `HttpOnly` and `SameSite=Strict`
  are unchanged, and the cookie is still tied to the exact origin.
* WebAuthn/passkeys require a secure context (HTTPS or `localhost`) and are unavailable at a plain-HTTP
  Tailscale-IP origin. Password + TOTP/recovery login is unaffected. Passkeys become available again once
  Tailscale Serve HTTPS or another TLS-terminated route is configured for this host.
* Anyone who can reach the Tailscale IP on the tailnet (per its ACLs) can reach the login page; this is no
  different from what Tailscale Serve HTTPS or the SSH tunnel already allow to devices with tailnet access.

### Same-host trust boundary

* **Cookies are not isolated by port.** A browser sends cookies for a host name to every port on that host.
  Other web apps served under the same host name (other Serve ports, other `localhost` ports) can receive the
  FinancialOS cookies if they are not host-only.
  * FinancialOS uses `__Host-` prefixed cookies (`Secure`, `Path=/`, no `Domain`), plus `HttpOnly` and
    `SameSite=Strict`.
  * It checks the exact `Origin`, including the port, on every mutation, and requires a CSRF token.
  * It keeps the session lifetime to ten minutes.
  * An app on another port of the same host is still a different origin. It cannot read FinancialOS responses,
    but it shares cookie scope and should be trusted accordingly.
* **Passkeys** are bound to the relying-party ID, which is the host name without a port. Every app on the same
  host name shares that RP ID. A dedicated host name (a Tailscale service name or a custom domain) gives a
  cleaner boundary; see [DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md).
* **The database is not reachable** from the host or the tailnet. It has no published port and sits on an
  internal Docker network. The worker has no published port either.
* **Anyone with root or `docker` group rights on the host** can read the runtime directory and the volumes.
  Treat host access as equivalent to data access.

## 11. Coexistence rules for shared hosts

The host also runs other workloads, such as GPU inference. FinancialOS tooling follows these rules:

* It only creates, changes or removes Docker resources whose names start with `financialos`. It uses no fixed
  container names, never mounts the Docker socket, and runs no privileged containers.
* It never runs `docker system|volume|network prune`, `docker image prune -a`, or a Docker daemon restart.
* It never binds to `0.0.0.0` or the LAN. Only `127.0.0.1` and, when the "Direct Tailscale IP" method in
  section 10 is in use, the host's own Tailscale address are published, and only for the app port.
* It builds and tests at low priority behind a shared lock (`scripts/dev/with-lock.sh`), with memory checks and
  bounded Node heaps.
* It changes Tailscale only through the owner's explicit additive command.
* `host-check.sh snapshot|compare` records the host's state before and after a change. The state covers:
  * containers and their states, published ports, Compose projects, networks and volumes;
  * listening sockets, user services and timers;
  * the Serve configuration.

  `compare` exits non-zero when a pre-existing resource disappeared or changed state. It flags changes that
  FinancialOS did not cause, and it also reads the older baseline format.

## 12. Development and end-to-end stacks

```bash
deploy/scripts/dev-up.sh --image financialos:<tag>   # synthetic demo on http://127.0.0.1:3190
deploy/scripts/dev-down.sh [--volumes]

deploy/scripts/e2e-up.sh --image financialos:<tag> [--seed]
#   prints FOS_E2E_BASE_URL, FOS_E2E_BOOTSTRAP_SECRET_FILE, FOS_E2E_DIR, FOS_E2E_IMAGE
#   (also stored in $FOS_RUNTIME_DIR/e2e/current.env)
deploy/scripts/e2e-down.sh
```

The dev stack uses its own secrets in `$FOS_RUNTIME_DIR/dev/` and never mounts the private bootstrap file. The e2e
stack keeps everything in tmpfs and a temporary directory. `e2e-down.sh` removes both. Synthetic data exists only
in these projects; the production database never contains it.

## 13. Script reference

| Script | Purpose |
|---|---|
| `init-runtime.sh` | Directory layout and missing secrets (never overwrites) |
| `write-config.sh` | Validated `app-config.json` (backup kept; `--force` to change) |
| `build-image.sh` | Low-priority image build with privacy and secret scans |
| `deploy.sh` / `rollback.sh` / `migrate.sh` | Releases under the deploy lock |
| `start.sh` / `stop.sh` / `health.sh` / `status.sh` / `logs.sh` / `disk-check.sh` | Day-to-day operation |
| `backup.sh` / `restore-verify.sh` / `restore.sh` | Backups and recovery |
| `tailscale-route.sh plan\|status\|verify` | Private HTTPS route (read-only) |
| `host-check.sh snapshot\|compare\|list` | Shared-host coexistence evidence |
| `install-timers.sh install\|remove\|status\|render` | Host-side schedules |
| `dev-up.sh` / `dev-down.sh` / `e2e-up.sh` / `e2e-down.sh` / `test-db.sh` | Non-production stacks |

Every script accepts `--help`, uses `set -euo pipefail`, prints what it does, and never prints secret values.
