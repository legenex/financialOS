#!/usr/bin/env bash
# Creates an encrypted backup of the production database and documents now.
#
# Usage:
#   deploy/scripts/backup.sh
#
# Runs `node apps/worker/dist/cli.mjs backup-now` inside the running production worker. When the worker is not
# running (for example before the first start of a new release), it runs the same command in a one-off worker
# container of the recorded release, starting only the database if needed.
# The backup is written to $FOS_RUNTIME_DIR/backups (encrypted with secrets/backup-key); retention is applied by
# the worker (default: 14 daily + 8 weekly). Prints the worker's report on stdout.
set -euo pipefail
FOS_SCRIPT_NAME=backup
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

case "${1:-}" in
  -h | --help) fos_usage_from_header "$0" 0 ;;
  "") ;;
  *) fos_die "unknown argument: $1 (see --help)" ;;
esac

fos_require_cmd docker
fos_require_runtime_dir
backups="$FOS_RUNTIME_DIR/backups"
newest() { find "$backups" -maxdepth 1 -type f -name 'financialos-backup-*' ! -name '*.partial' ! -name '*.tmp' -printf '%T@ %p\n' | sort -n | tail -n1 | cut -d' ' -f2-; }
before="$(newest)"

if fos_prod_service_running worker; then
  fos_log "running backup-now in the production worker"
  fos_prod_compose exec -T worker node apps/worker/dist/cli.mjs backup-now
else
  fos_log "worker is not running; using a one-off worker container of $(fos_current_image)"
  fos_prod_compose up -d --wait db >&2
  fos_prod_compose run --rm --no-deps -T worker node apps/worker/dist/cli.mjs backup-now
fi

after="$(newest)"
if [ -z "$after" ] || [ "$after" = "$before" ]; then
  fos_die "backup-now finished but no new backup file appeared in $backups"
fi
fos_log "backup written: $after ($(stat -c %s "$after") bytes)"
