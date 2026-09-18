# Security model

FinancialOS holds a single owner's complete financial picture. This document is the threat model: each threat
is listed with the controls that address it and how those controls are tested. Verification evidence for a
particular release is recorded in `docs/VERIFICATION.md`.

## Assets

* Financial records: balances, transactions, holdings, documents, and third-party balances.
* Provider credentials and OAuth tokens (read-only bank, broker, and wallet access).
* Owner authentication factors: password hash, TOTP secret, passkeys, and recovery codes.
* Device and agent credentials.
* Encryption keys and backups.

## Trust boundaries

1. **Browser ↔ private route ↔ app.** The app is published only on loopback and, optionally, the host's
   Tailscale address (never `0.0.0.0` or the LAN) -- see `docs/OPERATIONS.md` section 10 for the access methods
   and their trade-offs. TLS is preferably terminated by a private route in front of the app (for example,
   Tailscale Serve); a Tailscale-address origin without TLS relies instead on the tailnet's own WireGuard
   encryption between devices, keeps sessions to a non-`Secure`, `__Host-`-unprefixed cookie, and cannot use
   WebAuthn/passkeys (they require a secure context).
2. **App ↔ database.** The database is reachable only on an internal Docker network. There is no published port.
3. **Worker ↔ provider APIs.** Outbound traffic goes through the SSRF-guarded client.
4. **Extension ↔ app.** A device credential grants access to one sanitized summary endpoint.
5. **Agents (MCP/API) ↔ app.** An agent credential grants scoped, read-only tools.
6. **Same-host neighbours.** Other applications on the same machine or hostname are outside FinancialOS's control
   (see "Shared host").

## Threats and controls

### Public source code

* No secrets, real data, hostnames, or addresses in the repository.
* The `privacy-check` gate runs on commit and push. It combines a private denylist with generic patterns for
  wallets, IBANs, cards, keys, tailnet addresses, and email addresses. gitleaks runs alongside it.
* Build artefacts are scanned before release: the web bundle, the extension ZIP, and the image layers FinancialOS
  adds.
* Production bundles contain no source maps and no build-time financial values.

### Stolen browser session

* Absolute session lifetime of 600 seconds from authentication. Activity, polling, rotation, and extension
  traffic never extend it.
* Idle timeout of at most 600 seconds. Background requests do not count as activity.
* Cookies use the `__Host-` prefix and are `HttpOnly`, `Secure`, and `SameSite=Strict`. The database stores only a
  SHA-256 hash of each session token.
* A new login revokes older sessions. "Sign out everywhere" and per-session revocation are available.
* The server checks the session on every private request. Streams close at expiry. Downloads and long-running
  responses re-check the session before delivering data.
* Private responses are `no-store`. The service worker caches only the static shell. The client clears in-memory
  data at lock, locks all tabs through a `BroadcastChannel`, and re-checks the session after sleep, resume, and
  back/forward-cache restore.

### Cross-site request forgery and redirects

* `SameSite=Strict` cookies.
* Exact `Origin` allowlist on every mutation, and `Sec-Fetch-Site` rejection of cross-site requests.
* A per-session CSRF token (an HMAC of the session hash) is required on every mutation.
* Redirects go only to allowlisted internal paths.

### Authentication attacks

* Argon2id password hashing with a minimum length of 15 characters. TOTP is mandatory and replay-protected.
* Recovery codes are hashed and single-use.
* Passkeys use user verification and are bound to the relying-party ID.
* Login and setup throttling uses exponential backoff and lockout, with generic error messages.
* Owner bootstrap uses a one-time 256-bit secret generated on the host. The database stores only its hash. Setup is
  sealed after completion, and there is no public registration.

### Compromised or malicious extension

* The device credential is accepted only by `GET /api/ext/v1/glance`, and only from the paired extension origin.
* Responses are masked by default. Amounts are sent only for fields the owner explicitly enabled.
* The credential expires and can be revoked individually or all at once. It cannot mint or extend web sessions.
* Pairing is bound to an installation verifier and is single-use.
* The extension requests only `storage`, and host access to the exact configured origin at runtime. It has no
  content scripts, no history or cookie permissions, and no remote code.
* Opening the app from the extension requires fresh authentication through a server-side launch request.

### Hostile statements and files

* Content sniffing, size, row, and page limits, and a zip-bomb guard.
* Macro-enabled and encrypted Office files are rejected.
* XML is parsed with no DTD or entity processing. PDF parsing runs with JavaScript evaluation disabled.
* Files are stored encrypted under generated keys. Filenames are never used as storage paths.
* CSV exports neutralise formula injection.
* Document text is data only and is never treated as instructions.

### SSRF and credential exfiltration

* Outbound HTTP resolves DNS itself, validates every resolved address, and connects to the validated IP.
* Private, loopback, link-local, metadata, CGNAT, and multicast ranges are blocked. The only exceptions are
  owner-allowlisted exact `host:port` pairs.
* Every redirect is re-validated. Authorization headers are dropped when the origin changes, and HTTPS→HTTP
  downgrades are refused.
* Response size, timeout, and retry limits apply.
* Credentials are write-only through the API and never appear in responses, bundles, logs, or coach context.

### Malicious MCP or provider output

* Remote MCP tools are filtered to read-only operations. Unknown tools are denied.
* Tool output is size-limited, treated as data, and never executed or followed as instructions.
* Custom MCP supports remote HTTPS servers only. Stdio or command transports are never supported.

### Leaked backup

* Backups are encrypted with AES-256-GCM using a dedicated backup key. Documents inside a backup remain encrypted
  under the document keyring.
* Keys are never stored inside backups.
* Restore verification runs in an isolated, disposable environment.

### Excessive agent permissions

* Agent credentials are scoped: read scopes, `simulate`, `draft`, and `suggest`. They are also limited to specific
  entities, expire, and can be revoked.
* Every agent call is audited.
* Agents cannot move money, trade, change settings, or alter their own limits.
* Live trade execution is disabled and has no connector.

### Shared host

* FinancialOS runs in its own Compose project, networks, and volumes, with no Docker socket and no privileged
  containers.
* Containers run as a non-root user with a read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, and memory, CPU, and PID limits.
* Separate database roles are used for migrations, the app, and the worker.
* **Residual risk:** another application served under the same hostname (on a different port) shares the browser
  cookie jar and the WebAuthn relying-party ID. `__Host-` cookies and exact origin checks limit cookie injection.
  Anyone with root on the host can read memory, keys, and the database. Container isolation does not protect
  against host compromise.

## Encryption at rest (actual coverage)

| Data | Protection |
|---|---|
| Provider credentials, OAuth tokens, TOTP secret | AES-256-GCM, versioned keyring stored outside the database |
| Uploaded documents | Per-file key wrapped by the keyring, chunked AES-256-GCM |
| Backups | AES-256-GCM with a separate backup key |
| Database tables (transactions, balances) | **Not application-encrypted.** Protected by database access controls and host file permissions |
| Host disk | Not verified by FinancialOS. No disk-encryption claim is made |

## Audit log

Authentication, setup, export, import, classification, rule, integration, permission, device, and agent events are
appended to `audit_events`. The application role can only insert into and read that table, and a trigger rejects
updates and deletes. A database superuser can still alter it, so the log is **append-only by policy, not
tamper-proof**.
