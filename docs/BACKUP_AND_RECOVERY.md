# Backup and recovery

This document describes what FinancialOS backs up, how backups are protected, how restores are proved, and what
you must keep safe yourself. It is generic: real paths, host names and key material stay in the private runtime
directory (`FOS_RUNTIME_DIR`, see [OPERATIONS.md](OPERATIONS.md)).

## 1. What is backed up

The worker's `backup-now` job, and the daily schedule inside the worker, write one encrypted archive per run to
`$FOS_RUNTIME_DIR/backups/financialos-backup-<UTC timestamp>.<ext>`. Each archive contains:

* **The database.** `pg_dump` of the application schema runs as the read-only `fos_backup` role. The job queue
  schema (`pgboss`) is excluded because it holds only transient job state.
* **Documents.** The uploaded files are included exactly as stored: already encrypted by the app, and encrypted
  again by the archive.
* **Essential non-secret configuration** the worker needs to describe the backup: the schema version, record
  counts and a manifest.

Not in the archive:

* **The secrets.** These are `keyring.json`, `backup-key`, the database passwords and the session pepper. A backup
  must not carry the keys that open it.
* **The private bootstrap file.** It is loaded once and kept by the owner.
* **Container images.** Rebuild them from source at the release's commit (`build-image.sh`).

Files are written atomically (a temporary name, then a rename) with mode `0640`, in a setgid directory, so the
operator account can copy them. Retention runs in the worker and keeps **14 daily and 8 weekly** backups by
default. Run `deploy/scripts/backup.sh` for an immediate backup; `deploy.sh` also takes one before every release.

## 2. Encryption

* Each archive is encrypted with **AES-256-GCM** under the backup key in `secrets/backup-key` (32 random bytes).
  The authentication tag means a modified or truncated archive fails to decrypt instead of restoring silently
  corrupted data.
* Document blobs and provider credentials inside the database are additionally encrypted with the application
  keyring (`secrets/keyring.json`, versioned AES-256-GCM keys; see [SECURITY.md](SECURITY.md)).
* Backups are therefore safe to copy to storage you do not fully trust, **provided the two key files are not
  stored with them**.

Disk-level encryption of the host is outside FinancialOS's control and is not claimed. The database files in the
Docker volume are protected by file permissions only; document blobs and stored credentials are encrypted.

## 3. Key recovery: what you must keep offline

Without the keys, every backup is unrecoverable, and nobody can recover the data for you.

Store copies of these two files **offline and separately from the backups**, for example in a password manager
entry and on an encrypted USB key kept elsewhere:

| File | Needed for |
|---|---|
| `secrets/backup-key` | decrypting backup archives |
| `secrets/keyring.json` | decrypting documents and stored provider credentials inside a restored database |

Also keep:

* your password, TOTP authenticator and recovery codes (to sign in after a restore);
* the private bootstrap file, if you still need it.

The database passwords and the session pepper do not need to be kept. A new host can generate new ones with
`init-runtime.sh`, because the restore recreates the roles with the current passwords.

When you rotate the keyring, add the new key and keep the old keys in the file, then store the updated file
offline again. Old backups need the key versions that were active when they were made.

## 4. Proving that backups restore

`deploy/scripts/restore-verify.sh [--file <name>]` restores a backup without touching production.

* It starts the throwaway project `financialos-restore-<timestamp>`:
  * PostgreSQL runs on tmpfs with random one-time passwords.
  * Its network is internal only, and it publishes no ports.
* A one-shot verifier then runs `cli.mjs backup-verify`. It uses the production keyring and backup key, and reads
  the backups directory read-only. The verifier:
  1. restores the database into the empty target;
  2. checks the record counts against the backup manifest;
  3. checks that every document decrypts.
* The report is written to `$FOS_RUNTIME_DIR/reports/restore-verify-<timestamp>.json`.
* A summary goes to `config/restore-verify-status.json`, which **Settings → System** shows.
* The project and its volumes are removed afterwards, whatever the outcome. The script exits non-zero if
  verification fails.

The `financialos-restore-verify` user timer runs this weekly on the newest backup
(`deploy/scripts/install-timers.sh install`). A backup that has never been verified should not be trusted.

## 5. Restoring production

`deploy/scripts/restore.sh --file <name> --i-understand` replaces the live data. It always works in this order:

1. **Verify** the chosen backup in an isolated project (skip only with `--skip-verify`).
2. **Take a safety backup** of the current state. If that fails, the restore stops.
3. Stop `app` and `worker`.
4. **Create new volumes** `financialos_pgdata_r<ts>` and `financialos_documents_r<ts>`, and start a fresh
   PostgreSQL cluster on them. Then run `cli.mjs backup-restore` into the empty database and documents volume.
5. Run the migrations, start `app` and `worker`, **revoke all sessions**, and run the smoke checks.
6. Record the new volume names in `release.env`.

If any step after step 3 fails, the stack switches back to the previous volumes automatically. The previous
volumes are never deleted by the script. Once you are satisfied, remove them yourself with `docker volume rm` and
the names the script printed.

**Restoring on a new machine:**

1. Install Docker and check out the source at the release commit.
2. Run `init-runtime.sh`.
3. Put your offline `backup-key` and `keyring.json` into `secrets/`, replacing the generated ones before anything
   is deployed. Use mode `0640`.
4. Copy the backup archive into `backups/`.
5. Run `write-config.sh`.
6. Build and deploy the image.
7. Run `restore.sh --file <name> --i-understand`.
8. Sign in with your password and TOTP.

Passkeys keep working only if the new machine uses the same host name. Otherwise, enrol them again.

**After a rollback across a migration:** migrations are forward-only. If an older release cannot run on the newer
schema, restore the backup that `deploy.sh` took before the upgrade, then deploy the older tag.

## 6. Off-host backups

**Not configured by default.** FinancialOS does not copy backups anywhere by itself, and it never uses paid
storage without the owner's explicit decision. `status.sh` and the System page say "off-host not configured"
until you set it up.

To configure a destination you have authorised, such as another machine you own, an external disk, or storage
you already pay for, copy the files from `$FOS_RUNTIME_DIR/backups/` with a tool you control. For example, a user
cron job or systemd timer on the host could run:

```bash
rsync -a --ignore-existing "$FOS_RUNTIME_DIR/backups/" backup-user@backup-host:/srv/financialos-backups/
```

* Copy the archives only, never `secrets/`. The archives are encrypted, and the keys stay offline (section 3).
* Use a destination that keeps its own history or is append-only, so that a compromised host cannot delete the
  off-host copies.
* Test a restore from the off-host copy with `restore-verify.sh --file <name>` after copying it back into
  `backups/`.

## 7. Limits

* **Same-disk backups do not protect against losing the machine.** Backups in `$FOS_RUNTIME_DIR/backups` share
  hardware with the live database. They protect against mistakes, bad releases and corruption, not against disk
  failure, theft, fire or a compromised host. Only off-host copies and offline keys do.
* Backups are only as fresh as the schedule: work done after the last backup is lost in a restore.
* Anyone with root or `docker` group access on the host can read the live database. Encryption protects backups
  and stored credentials, not a running system.
