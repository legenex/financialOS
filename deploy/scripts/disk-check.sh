#!/usr/bin/env bash
# Checks free disk space where FinancialOS keeps data and writes a status file the app can show.
#
# Usage:
#   deploy/scripts/disk-check.sh [--warn-percent <n>] [--critical-percent <n>] [--min-free-gib <n>] [--quiet]
#
# Checked file systems: $FOS_RUNTIME_DIR (backups, config) and Docker's data root (database and document
# volumes). Defaults: warn at 85 % used, critical at 95 % used or below 5 GiB free.
# Writes $FOS_RUNTIME_DIR/config/disk-status.json (schemaVersion 1) and exits 1 when any path is critical.
# The worker may perform the same check in-process for its own mounts.
set -euo pipefail
FOS_SCRIPT_NAME=disk-check
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

warn=85
crit=95
min_free_gib=5
quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --warn-percent) warn="${2:?}"; shift 2 ;;
    --critical-percent) crit="${2:?}"; shift 2 ;;
    --min-free-gib) min_free_gib="${2:?}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
for n in "$warn" "$crit" "$min_free_gib"; do
  [[ "$n" =~ ^[0-9]+$ ]] || fos_die "thresholds must be whole numbers"
done
fos_require_cmd df python3

paths=("$FOS_RUNTIME_DIR")
if command -v docker >/dev/null 2>&1; then
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$docker_root" ] && paths+=("$docker_root")
fi

report="$(
  for p in "${paths[@]}"; do
    df -PB1 "$p" 2>/dev/null | awk -v p="$p" 'NR == 2 { print p "\t" $2 "\t" $4 }'
  done | python3 -c '
import datetime, json, sys
warn, crit, min_free = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]) * 1024 ** 3
entries, worst = [], "ok"
order = {"ok": 0, "warn": 1, "critical": 2}
for line in sys.stdin:
    path, total, avail = line.rstrip("\n").split("\t")
    total, avail = int(total), int(avail)
    used = round(100 * (total - avail) / total, 1) if total else 0.0
    level = "ok"
    if used >= warn:
        level = "warn"
    if used >= crit or avail < min_free:
        level = "critical"
    worst = max(worst, level, key=order.get)
    entries.append({"path": path, "totalBytes": total, "availBytes": avail, "usedPercent": used, "level": level})
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({"schemaVersion": 1, "checkedAt": now, "level": worst,
                  "thresholds": {"warnPercent": warn, "criticalPercent": crit, "minFreeBytes": min_free},
                  "paths": entries}))
' "$warn" "$crit" "$min_free_gib"
)"

if [ -d "$FOS_RUNTIME_DIR/config" ]; then
  fos_write_json_file "$FOS_RUNTIME_DIR/config/disk-status.json" "$report"
fi
level="$(printf '%s' "$report" | python3 -c 'import json,sys; print(json.load(sys.stdin)["level"])')"
if [ "$quiet" != 1 ]; then
  printf '%s' "$report" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for e in d["paths"]:
    print("%-8s %5.1f%% used  %6d GiB free  %s" % (e["level"], e["usedPercent"], e["availBytes"] // 1024 ** 3, e["path"]))
'
fi
[ "$level" != critical ]
