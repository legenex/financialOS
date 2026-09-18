#!/usr/bin/env bash
# DANGEROUS: restores a backup into PRODUCTION, replacing the live database and documents.
#
# Usage:
#   deploy/scripts/restore.sh --file <backup file name> --i-understand [--skip-verify] [--timeout <seconds>]
#
# What it does, under the deploy lock:
#   1. verifies the chosen backup in an isolated project first (restore-verify.sh) unless --skip-verify;
#   2. takes a safety backup of the current state (backup.sh) and aborts if that fails;
#   3. stops app and worker;
#   4. creates NEW volumes financialos_pgdata_r<ts> and financialos_documents_r<ts>, starts PostgreSQL on them
#      (fresh cluster, roles from the current secrets) and runs `cli.mjs backup-restore` into the empty database
#      and documents volume;
#   5. runs migrations, starts app and worker, revokes all sessions, and runs the smoke checks;
#   6. records the new volume names in release.env. The previous volumes are KEPT (names printed) so the owner
#      can inspect them and remove them later with `docker volume rm`.
# If any step after 3 fails, the stack is switched back to the previous volumes and restarted.
#
# The backup must have been made with the same keyring and backup key as the current secrets/ directory.
set -euo pipefail
FOS_SCRIPT_NAME=restore
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

file=""
confirmed=0
verify=1
timeout=240
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="${2:?}"; shift 2 ;;
    --i-understand) confirmed=1; shift ;;
    --skip-verify) verify=0; shift ;;
    --timeout) timeout="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$file" ] || fos_die "--file is required (see --help)"
[ "$confirmed" = 1 ] || fos_die "this replaces the production database; re-run with --i-understand"
case "$file" in
  */* | .*) fos_die "--file must be a plain file name inside $FOS_RUNTIME_DIR/backups" ;;
esac

fos_require_cmd docker curl python3 flock
fos_acquire_deploy_lock 120
fos_prod_preflight
[ -f "$FOS_RUNTIME_DIR/backups/$file" ] || fos_die "backup not found: $FOS_RUNTIME_DIR/backups/$file"
image="$(fos_current_image)"
[ -n "$image" ] || fos_die "no release is deployed; deploy first, then restore"
fos_image_exists_locally "$image" || fos_die "the deployed image $image is not present locally"
export FOS_IMAGE="$image"

old_pgdata="$(fos_pgdata_volume)"
old_documents="$(fos_documents_volume)"
ts="$(fos_timestamp)"
new_pgdata="financialos_pgdata_r${ts,,}"
new_documents="financialos_documents_r${ts,,}"

fos_warn "restoring $file into production with $image"
fos_append_release_log "restore-start file=$file image=$image old_volumes=$old_pgdata,$old_documents"

if [ "$verify" = 1 ]; then
  fos_log "step 1: verifying the backup in an isolated project"
  "$FOS_SCRIPTS_DIR/restore-verify.sh" --file "$file" --image "$image" >&2 ||
    fos_die "the backup did not pass verification; production was not changed"
else
  fos_warn "step 1 skipped: backup not verified first"
fi

fos_log "step 2: safety backup of the current state"
"$FOS_SCRIPTS_DIR/backup.sh" >&2 || fos_die "safety backup failed; production was not changed"

switch_back() {
  local reason="$1"
  fos_warn "restore failed: $reason; switching back to $old_pgdata / $old_documents"
  fos_prod_compose --profile restore rm -fsv restore >/dev/null 2>&1 || true
  FOS_PGDATA_VOLUME="$new_pgdata" FOS_DOCUMENTS_VOLUME="$new_documents" fos_prod_compose stop app worker db >&2 || true
  FOS_PGDATA_VOLUME="$old_pgdata" FOS_DOCUMENTS_VOLUME="$old_documents" fos_prod_compose up -d --wait --wait-timeout "$timeout" db >&2 || true
  FOS_PGDATA_VOLUME="$old_pgdata" FOS_DOCUMENTS_VOLUME="$old_documents" fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2 || true
  docker volume rm financialos_restore_scratch >/dev/null 2>&1 || true
  fos_append_release_log "restore-failed file=$file reason=$reason restored_volumes_left=$new_pgdata,$new_documents"
  fos_die "restore failed ($reason). Production runs on the previous volumes again; the partial restore is kept in $new_pgdata / $new_documents for inspection."
}

fos_log "step 3: stopping app and worker"
fos_prod_compose stop app worker >&2

fos_log "step 4: fresh database cluster on $new_pgdata, documents on $new_documents"
fos_ensure_volume "$new_pgdata"
fos_ensure_volume "$new_documents"
export FOS_PGDATA_VOLUME="$new_pgdata" FOS_DOCUMENTS_VOLUME="$new_documents"
fos_prod_compose up -d --wait --wait-timeout "$timeout" db >&2 || switch_back "fresh database did not start"
fos_prod_compose --profile restore run --rm -T restore \
  node apps/worker/dist/cli.mjs backup-restore \
  --file "/data/backups/$file" \
  --target-url postgres://fos_migrator@db:5432/financialos \
  --documents-dir /data/documents >&2 || switch_back "backup-restore failed"
docker volume rm financialos_restore_scratch >/dev/null 2>&1 || true

fos_log "step 5: migrations, start, session revocation, smoke checks"
fos_prod_compose run --rm -T migrate >&2 || switch_back "migrate failed after restore"
fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2 || switch_back "app or worker unhealthy after restore"
fos_prod_compose exec -T app node apps/api/dist/cli.mjs sessions:revoke-all >&2 || switch_back "sessions:revoke-all failed"
fos_smoke_check "http://127.0.0.1:$FOS_APP_PORT" >&2 || switch_back "smoke checks failed after restore"

fos_env_set "$FOS_RELEASE_ENV" FOS_PGDATA_VOLUME "$new_pgdata"
fos_env_set "$FOS_RELEASE_ENV" FOS_DOCUMENTS_VOLUME "$new_documents"
fos_env_set "$FOS_RELEASE_ENV" FOS_PRE_RESTORE_VOLUMES "$old_pgdata,$old_documents"
fos_append_release_log "restore-ok file=$file volumes=$new_pgdata,$new_documents previous_volumes=$old_pgdata,$old_documents"
fos_log "restore complete. Production now uses $new_pgdata and $new_documents."
fos_log "the previous data is still in $old_pgdata and $old_documents; remove them with 'docker volume rm' once you are satisfied."
