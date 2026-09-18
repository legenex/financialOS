#!/usr/bin/env bash
# Proves that a backup can be restored: restores it into a throwaway, isolated PostgreSQL and checks record
# counts and document decryptability. Production is not touched.
#
# Usage:
#   deploy/scripts/restore-verify.sh [--file <backup file name>] [--image <tag|financialos:tag>]
#
#   --file    a file in $FOS_RUNTIME_DIR/backups (default: the newest financialos-backup-* file)
#   --image   image providing `cli.mjs backup-verify` (default: the deployed release)
#
# Runs Compose project financialos-restore-<timestamp> (deploy/compose/restore-verify.compose.yml): PostgreSQL on
# tmpfs with throwaway passwords, an internal-only network, no published ports, and a one-shot verifier that
# reads the backup read-only with the production keyring and backup key. The project and its volumes are removed
# afterwards, whatever the outcome.
#
# Writes the worker's JSON report to $FOS_RUNTIME_DIR/reports/restore-verify-<timestamp>.json and a summary the
# app shows in Settings -> System to $FOS_RUNTIME_DIR/config/restore-verify-status.json. Exit 0 only on success.
set -euo pipefail
FOS_SCRIPT_NAME=restore-verify
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

file=""
image=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="${2:?}"; shift 2 ;;
    --image) image="$(fos_normalize_image "${2:?}")"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

fos_require_cmd docker python3 openssl
fos_require_runtime_dir
backups="$FOS_RUNTIME_DIR/backups"
if [ -z "$file" ]; then
  file="$(find "$backups" -maxdepth 1 -type f -name 'financialos-backup-*' ! -name '*.partial' ! -name '*.tmp' -printf '%T@ %f\n' | sort -n | tail -n1 | cut -d' ' -f2-)"
  [ -n "$file" ] || fos_die "no backups found in $backups"
fi
case "$file" in
  */* | .* | "") fos_die "--file must be a plain file name inside $backups" ;;
esac
[ -f "$backups/$file" ] || fos_die "backup not found: $backups/$file"
image="${image:-$(fos_current_image)}"
[ -n "$image" ] || fos_die "no release recorded; pass --image"
fos_validate_image_ref "$image"
fos_image_exists_locally "$image" || fos_die "image $image is not present locally"
for f in keyring.json backup-key; do
  [ -s "$FOS_RUNTIME_DIR/secrets/$f" ] || fos_die "missing $FOS_RUNTIME_DIR/secrets/$f"
done
fos_check_memory 4 || fos_die "less than 4 GiB of memory available; try again later"

ts="$(fos_timestamp)"
project="financialos-restore-${ts,,}"
mkdir -p "$FOS_RUNTIME_DIR/tmp" "$FOS_RUNTIME_DIR/reports"
chmod 0700 "$FOS_RUNTIME_DIR/tmp" "$FOS_RUNTIME_DIR/reports"
work="$(mktemp -d "$FOS_RUNTIME_DIR/tmp/restore-verify.XXXXXX")"
report="$FOS_RUNTIME_DIR/reports/restore-verify-$ts.json"
stderr_log="$work/verify.stderr"

compose() {
  FOS_IMAGE="$image" FOS_RESTORE_DIR="$work/secrets" FOS_RESTORE_BACKUP_FILE="$file" \
    docker compose --project-name "$project" --file "$FOS_COMPOSE_DIR/restore-verify.compose.yml" "$@"
}
cleanup() {
  fos_log "removing project $project and its volumes"
  compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fos_export_compose_env
umask 077
mkdir -p "$work/secrets"
chmod 0700 "$work/secrets"
for role in superuser migrator app worker backup; do
  openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | tr -d '=' >"$work/secrets/db-$role-password"
  chmod 0640 "$work/secrets/db-$role-password"
done

fos_log "verifying $file with $image in project $project"
status=0
if ! compose up -d --wait --wait-timeout 120 restoredb >&2; then
  status=1
  : >"$report.tmp"
  echo "restore database did not start" >"$stderr_log"
elif ! compose run --rm -T verify >"$report.tmp" 2>"$stderr_log"; then
  status=1
fi

detail="$(tail -n 20 "$stderr_log" 2>/dev/null | tr -d '\000' || true)"
summary="$(
  python3 - "$report.tmp" "$file" "$status" "$image" "$detail" <<'PY'
import datetime, json, sys
path, backup_file, status, image, detail = sys.argv[1:6]
raw = open(path, encoding="utf-8", errors="replace").read().strip()
report = None
if raw:
    try:
        report = json.loads(raw.splitlines()[-1]) if not raw.startswith("{") else json.loads(raw)
    except json.JSONDecodeError:
        report = None
ok = status == "0" and isinstance(report, dict) and report.get("ok", True) is not False
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({
    "schemaVersion": 1,
    "checkedAt": now,
    "backupFile": backup_file,
    "image": image,
    "ok": ok,
    "report": report,
    "detail": None if ok else (detail[-2000:] or "verification failed without a report"),
}))
PY
)"
if [ -s "$report.tmp" ]; then
  mv -f "$report.tmp" "$report"
  chmod 0600 "$report"
else
  rm -f "$report.tmp"
  report=""
fi
fos_write_json_file "$FOS_RUNTIME_DIR/config/restore-verify-status.json" "$summary"
ok="$(printf '%s' "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ok"])')"
fos_append_release_log "restore-verify file=$file image=$image ok=$ok"
if [ "$ok" = True ]; then
  fos_log "restore verification PASSED for $file${report:+ (report: $report)}"
  exit 0
fi
[ -s "$stderr_log" ] && tail -n 20 "$stderr_log" >&2
fos_die "restore verification FAILED for $file (status: $FOS_RUNTIME_DIR/config/restore-verify-status.json)"
