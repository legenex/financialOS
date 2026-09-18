#!/usr/bin/env bash
# Deploys an explicit, locally built image to the production project "financialos".
#
# Usage:
#   deploy/scripts/deploy.sh <tag|financialos:tag> [--skip-backup] [--no-rollback] [--timeout <seconds>]
#
# Steps (under $FOS_RUNTIME_DIR/deploy.lock):
#   1. validate the tag (no "latest", image must already exist locally: no pulls) and the runtime files;
#   2. record the currently deployed image as the rollback target;
#   3. take an encrypted pre-deploy backup when a database already exists (--skip-backup to skip; not advised);
#   4. start the database, run the one-shot migrate service (migrations + idempotent private bootstrap) with the
#      new image, then recreate app and worker with the new image;
#   5. wait for healthy containers and run smoke checks (healthz, readyz, index.html with CSP and no-store,
#      /api/today -> 401 without a session, only 127.0.0.1:$FOS_APP_PORT published);
#   6. on failure, automatically roll app and worker back to the previous image (migrations are forward-only:
#      see docs/OPERATIONS.md) unless --no-rollback;
#   7. record the result in $FOS_RUNTIME_DIR/release.env, config/release.json and notes/releases.log.
#
# Environment: FOS_RUNTIME_DIR, FOS_APP_PORT (default 3180).
set -euo pipefail
FOS_SCRIPT_NAME=deploy
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

ref=""
skip_backup=0
auto_rollback=1
timeout=240
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-backup) skip_backup=1; shift ;;
    --no-rollback) auto_rollback=0; shift ;;
    --timeout) timeout="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    -*) fos_die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "$ref" ] || fos_die "only one image tag may be given"
      ref="$1"
      shift
      ;;
  esac
done
[ -n "$ref" ] || fos_die "an explicit image tag is required (see --help)"
[[ "$timeout" =~ ^[0-9]+$ ]] || fos_die "--timeout must be a number of seconds"

fos_require_cmd docker curl python3 flock
image="$(fos_normalize_image "$ref")"
fos_validate_image_ref "$image"
fos_image_exists_locally "$image" || fos_die "image $image is not present locally; build it with deploy/scripts/build-image.sh (no pulls are performed)"
host_arch="$(docker version --format '{{.Server.Arch}}')"
image_arch="$(docker image inspect --format '{{.Architecture}}' "$image")"
[ "$image_arch" = "$host_arch" ] || fos_die "image architecture $image_arch does not match host $host_arch"
for required in apps/api/dist/main.mjs apps/worker/dist/main.mjs apps/worker/dist/cli.mjs apps/web/dist/index.html extension/financialos-extension.zip; do
  docker run --rm --network none --read-only --entrypoint test "$image" -f "/app/$required" ||
    fos_die "image $image is incomplete (missing /app/$required); partial builds cannot be deployed"
done

fos_acquire_deploy_lock 120
fos_prod_preflight
if ! fos_check_memory 3; then
  fos_die "less than 3 GiB of memory is available on the host; not deploying now"
fi
if [ -x "$FOS_SCRIPTS_DIR/disk-check.sh" ]; then
  "$FOS_SCRIPTS_DIR/disk-check.sh" --quiet || fos_die "disk space is critical; see $FOS_RUNTIME_DIR/config/disk-status.json"
fi

previous="$(fos_current_image)"
pgdata_volume="$(fos_pgdata_volume)"
documents_volume="$(fos_documents_volume)"
fos_log "deploying $image (previous: ${previous:-none})"
fos_append_release_log "deploy-start image=$image previous=${previous:-none}"

fos_ensure_volume "$pgdata_volume"
fos_ensure_volume "$documents_volume"

if [ "$skip_backup" = 1 ]; then
  fos_warn "pre-deploy backup skipped on request"
elif fos_pgdata_initialised "$pgdata_volume"; then
  if [ -n "$previous" ]; then
    fos_log "taking the pre-deploy backup with $previous"
    FOS_IMAGE="$previous" "$FOS_SCRIPTS_DIR/backup.sh" >&2 || fos_die "pre-deploy backup failed; nothing was changed"
  else
    fos_log "database exists but no previous release is recorded; taking the pre-deploy backup with $image"
    FOS_IMAGE="$image" "$FOS_SCRIPTS_DIR/backup.sh" >&2 || fos_die "pre-deploy backup failed; nothing was changed"
  fi
else
  fos_log "no database yet (first deploy); no pre-deploy backup needed"
fi

smoke_and_ports() {
  local ok=0
  fos_smoke_check "http://127.0.0.1:$FOS_APP_PORT" || ok=1
  fos_check_published_ports "$FOS_PROD_PROJECT" "$FOS_APP_PORT" || ok=1
  return "$ok"
}

rollback() {
  local reason="$1"
  fos_warn "deploy of $image failed: $reason"
  if [ "$auto_rollback" != 1 ]; then
    fos_append_release_log "deploy-failed image=$image reason=$reason rollback=disabled"
    fos_write_release_status "$image" "$previous" "failed"
    fos_die "automatic rollback disabled; inspect with deploy/scripts/logs.sh and deploy/scripts/status.sh"
  fi
  if [ -z "$previous" ]; then
    fos_warn "no previous release to roll back to; stopping app and worker"
    fos_prod_compose stop app worker >&2 || true
    fos_append_release_log "deploy-failed image=$image reason=$reason rollback=none-available"
    fos_write_release_status "$image" "" "failed"
    fos_die "first deploy failed; the database was left running. Fix the problem and deploy again."
  fi
  fos_warn "rolling app and worker back to $previous (migrations already applied are NOT reverted)"
  if FOS_IMAGE="$previous" fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2 &&
    FOS_IMAGE="$previous" smoke_and_ports; then
    fos_append_release_log "deploy-failed image=$image reason=$reason rolled-back-to=$previous"
    fos_write_release_status "$previous" "" "rolled_back"
    fos_die "deploy failed and was rolled back to $previous. If the new migrations are incompatible with it, restore the pre-deploy backup (docs/BACKUP_AND_RECOVERY.md)."
  fi
  fos_append_release_log "deploy-failed image=$image reason=$reason rollback-to=$previous FAILED"
  fos_write_release_status "$previous" "" "rollback_failed"
  fos_die "rollback to $previous also failed; the stack needs manual attention (deploy/scripts/status.sh, logs.sh)"
}

export FOS_IMAGE="$image"
fos_log "starting the database"
fos_prod_compose up -d --wait --wait-timeout "$timeout" db >&2 || rollback "database did not become healthy"
fos_log "running migrations and the idempotent private bootstrap"
fos_prod_compose run --rm -T migrate >&2 || rollback "migrate failed"
fos_log "starting app and worker"
fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2 || rollback "app or worker did not become healthy"
fos_log "smoke checks"
smoke_and_ports >&2 || rollback "smoke checks failed"

fos_env_set "$FOS_RELEASE_ENV" FOS_PREVIOUS_IMAGE "${previous:-}"
fos_env_set "$FOS_RELEASE_ENV" FOS_IMAGE "$image"
fos_env_set "$FOS_RELEASE_ENV" FOS_PGDATA_VOLUME "$pgdata_volume"
fos_env_set "$FOS_RELEASE_ENV" FOS_DOCUMENTS_VOLUME "$documents_volume"
fos_write_release_status "$image" "$previous" "deployed"
fos_append_release_log "deploy-ok image=$image previous=${previous:-none}"
fos_log "deployed $image; app on http://127.0.0.1:$FOS_APP_PORT (loopback only)"
printf '%s\n' "$image"
