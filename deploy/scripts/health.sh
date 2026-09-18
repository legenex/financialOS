#!/usr/bin/env bash
# Reports the health of a FinancialOS stack. Exit status 0 = healthy, 1 = unhealthy.
#
# Usage:
#   deploy/scripts/health.sh [--project prod|dev|e2e] [--quiet]
#
# Checks: container state and Docker health for db, app and worker; GET /healthz and /readyz on the loopback
# port (and, for production, also on the Tailscale IP); that nothing but 127.0.0.1:<port> (and, for production,
# FOS_TAILSCALE_IP:<port>) is published. For production it also reports (as warnings) the age of the newest
# backup, the last restore verification, disk space and the private route status.
set -euo pipefail
FOS_SCRIPT_NAME=health
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

target=prod
quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) target="${2:?}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
case "$target" in
  prod) project="$FOS_PROD_PROJECT"; port="$FOS_APP_PORT" ;;
  dev) project="$FOS_DEV_PROJECT"; port="$FOS_DEV_PORT" ;;
  e2e) project="$FOS_E2E_PROJECT"; port="$FOS_E2E_PORT" ;;
  *) fos_die "unknown project: $target" ;;
esac
fos_require_cmd docker curl python3

out() { [ "$quiet" = 1 ] || printf '%s\n' "$*"; }
failures=0

for svc in db app worker; do
  cid="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$svc" | head -n1)"
  if [ -z "$cid" ]; then
    out "FAIL  $svc: no container"
    failures=$((failures + 1))
    continue
  fi
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}}' "$cid")"
  case "$state" in
    "running healthy"*) out "ok    $svc: $state" ;;
    *) out "FAIL  $svc: $state"; failures=$((failures + 1)) ;;
  esac
done

for path in healthz readyz; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/$path" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then out "ok    GET /$path -> 200"; else out "FAIL  GET /$path -> ${code:-no response}"; failures=$((failures + 1)); fi
done

extra_ip=""
if [ "$target" = prod ]; then
  extra_ip="$FOS_TAILSCALE_IP"
  if [ -z "$extra_ip" ]; then
    out "FAIL  FOS_TAILSCALE_IP is not set (see \$FOS_RUNTIME_DIR/network.env)"
    failures=$((failures + 1))
  else
    for path in healthz readyz; do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://$extra_ip:$port/$path" 2>/dev/null || true)"
      if [ "$code" = 200 ]; then out "ok    GET http://$extra_ip:$port/$path -> 200"; else out "FAIL  GET http://$extra_ip:$port/$path -> ${code:-no response}"; failures=$((failures + 1)); fi
    done
  fi
fi

if ports_report="$(fos_check_published_ports "$project" "$port" "$extra_ip")"; then
  [ "$quiet" = 1 ] || [ -z "$ports_report" ] || printf '%s\n' "$ports_report"
else
  printf '%s\n' "$ports_report"
  failures=$((failures + 1))
fi

if [ "$target" = prod ]; then
  newest="$(find "$FOS_RUNTIME_DIR/backups" -maxdepth 1 -type f -name 'financialos-backup-*' ! -name '*.partial' ! -name '*.tmp' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n1)"
  if [ -z "$newest" ]; then
    out "warn  backups: none yet in $FOS_RUNTIME_DIR/backups"
  else
    age_h=$(( ($(date +%s) - ${newest%%.*}) / 3600 ))
    if [ "$age_h" -gt 26 ]; then out "warn  backups: newest is ${age_h}h old"; else out "ok    backups: newest is ${age_h}h old"; fi
  fi
  for status_file in restore-verify-status route-status disk-status; do
    f="$FOS_RUNTIME_DIR/config/$status_file.json"
    if [ -f "$f" ]; then
      out "$(python3 - "$f" "$status_file" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
d = json.load(open(path))
if name == "restore-verify-status":
    ok = d.get("ok") is True
    print(("ok    " if ok else "warn  ") + f"restore verification: {'passed' if ok else 'FAILED'} at {d.get('checkedAt')} ({d.get('backupFile')})")
elif name == "route-status":
    ok = d.get("status") == "active"
    print(("ok    " if ok else "warn  ") + f"private route: {d.get('status')} (checked {d.get('checkedAt')})")
else:
    ok = d.get("level") == "ok"
    print(("ok    " if ok else "warn  ") + f"disk: {d.get('level')} (checked {d.get('checkedAt')})")
PY
)"
    else
      out "warn  $status_file.json not written yet"
    fi
  done
fi

if [ "$failures" -gt 0 ]; then
  out "UNHEALTHY ($failures failing check(s))"
  exit 1
fi
out "HEALTHY"
