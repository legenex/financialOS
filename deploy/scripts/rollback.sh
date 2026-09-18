#!/usr/bin/env bash
# Rolls the production app and worker back to the previous release (or to a given, locally present tag).
#
# Usage:
#   deploy/scripts/rollback.sh [<tag|financialos:tag>] [--yes] [--timeout <seconds>]
#
# IMPORTANT: database migrations are forward-only. Rolling back only changes the application image; the schema
# stays at the newer version. If the older release cannot work with the newer schema, restore the pre-deploy
# backup instead (deploy/scripts/restore.sh, docs/BACKUP_AND_RECOVERY.md). --yes skips the confirmation prompt.
#
# The rollback runs under the deploy lock, waits for healthy containers, runs the smoke checks, and records the
# result in release.env (the replaced release becomes the new "previous"), config/release.json and
# notes/releases.log.
set -euo pipefail
FOS_SCRIPT_NAME=rollback
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

ref=""
assume_yes=0
timeout=180
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) assume_yes=1; shift ;;
    --timeout) timeout="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    -*) fos_die "unknown option: $1 (see --help)" ;;
    *) ref="$1"; shift ;;
  esac
done

fos_require_cmd docker curl flock
fos_acquire_deploy_lock 120
current="$(fos_current_image)"
if [ -n "$ref" ]; then
  target="$(fos_normalize_image "$ref")"
else
  target="$(fos_previous_image)"
  [ -n "$target" ] || fos_die "no previous release is recorded in $FOS_RELEASE_ENV; name a tag explicitly"
fi
fos_validate_image_ref "$target"
fos_image_exists_locally "$target" || fos_die "image $target is not present locally (no pulls are performed)"
[ "$target" != "$current" ] || fos_die "$target is already the deployed release"

fos_warn "rolling back from ${current:-none} to $target"
fos_warn "migrations are forward-only: the database schema is NOT rolled back. If $target cannot run against the"
fos_warn "current schema, restore the pre-deploy backup with deploy/scripts/restore.sh instead."
if [ "$assume_yes" != 1 ]; then
  if [ ! -t 0 ]; then
    fos_die "confirmation required: re-run with --yes"
  fi
  read -r -p "Type 'rollback' to continue: " answer
  [ "$answer" = rollback ] || fos_die "aborted"
fi

fos_prod_preflight
fos_append_release_log "rollback-start from=${current:-none} to=$target"
export FOS_IMAGE="$target"
if fos_prod_compose up -d --wait --wait-timeout "$timeout" db >&2 &&
  fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2 &&
  fos_smoke_check "http://127.0.0.1:$FOS_APP_PORT" >&2 &&
  fos_check_published_ports "$FOS_PROD_PROJECT" "$FOS_APP_PORT" >&2; then
  fos_env_set "$FOS_RELEASE_ENV" FOS_PREVIOUS_IMAGE "${current:-}"
  fos_env_set "$FOS_RELEASE_ENV" FOS_IMAGE "$target"
  fos_write_release_status "$target" "$current" "rolled_back"
  fos_append_release_log "rollback-ok from=${current:-none} to=$target"
  fos_log "rolled back to $target"
  printf '%s\n' "$target"
else
  fos_append_release_log "rollback-failed from=${current:-none} to=$target"
  fos_write_release_status "$target" "$current" "rollback_failed"
  fos_die "rollback to $target failed health or smoke checks; see deploy/scripts/logs.sh. Consider restore.sh."
fi
