#!/usr/bin/env bash
# Summarises the production deployment: release, containers, resource use, backups, route and host checks.
#
# Usage:
#   deploy/scripts/status.sh
#
# Read-only. Shows only financialos* resources.
set -euo pipefail
FOS_SCRIPT_NAME=status
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

case "${1:-}" in
  -h | --help) fos_usage_from_header "$0" 0 ;;
  "") ;;
  *) fos_die "unknown argument: $1 (see --help)" ;;
esac
fos_require_cmd docker

echo "== release"
echo "current:  $(fos_current_image || true)"
echo "previous: $(fos_previous_image || true)"
echo "volumes:  $(fos_pgdata_volume), $(fos_documents_volume)"
if [ -f "$FOS_RUNTIME_DIR/notes/releases.log" ]; then
  echo "recent release log:"
  tail -n 5 "$FOS_RUNTIME_DIR/notes/releases.log" | sed 's/^/  /'
fi

echo
echo "== containers (all financialos* projects)"
docker ps -a --filter 'name=^financialos' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

echo
echo "== resource use"
ids="$(docker ps -q --filter 'name=^financialos')"
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' $ids
else
  echo "no running financialos containers"
fi

echo
echo "== backups ($FOS_RUNTIME_DIR/backups)"
count="$(find "$FOS_RUNTIME_DIR/backups" -maxdepth 1 -type f -name 'financialos-backup-*' 2>/dev/null | wc -l)"
echo "files: $count"
find "$FOS_RUNTIME_DIR/backups" -maxdepth 1 -type f -name 'financialos-backup-*' -printf '%TY-%Tm-%Td %TH:%TM  %s bytes  %f\n' 2>/dev/null | sort | tail -n 3 | sed 's/^/  /'
echo "off-host copies: not configured by FinancialOS (see docs/BACKUP_AND_RECOVERY.md)"

echo
echo "== status files ($FOS_RUNTIME_DIR/config)"
for f in release restore-verify-status route-status disk-status; do
  if [ -f "$FOS_RUNTIME_DIR/config/$f.json" ]; then
    printf '%s: ' "$f"
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(", ".join(f"{k}={d[k]}" for k in ("status","level","ok","result","image","checkedAt","deployedAt") if k in d))' "$FOS_RUNTIME_DIR/config/$f.json"
  else
    echo "$f: not written yet"
  fi
done

echo
echo "== health"
"$FOS_SCRIPTS_DIR/health.sh" --project prod || true
