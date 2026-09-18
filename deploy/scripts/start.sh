#!/usr/bin/env bash
# Starts (or restarts) the production FinancialOS containers with the recorded release.
#
# Usage:
#   deploy/scripts/start.sh [--restart [service...]] [--timeout <seconds>]
#
#   (no options)        start db, then app and worker, and wait until they are healthy
#   --restart [svc...]  restart the named services (default: app worker), e.g. after write-config.sh
#
# Only the "financialos" Compose project is touched. Migrations are not run here (use deploy.sh or migrate.sh).
set -euo pipefail
FOS_SCRIPT_NAME=start
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

restart=0
services=()
timeout=180
while [ $# -gt 0 ]; do
  case "$1" in
    --restart) restart=1; shift ;;
    --timeout) timeout="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    db | app | worker) services+=("$1"); shift ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

fos_require_cmd docker curl flock
fos_acquire_deploy_lock 120
image="$(fos_current_image)"
[ -n "$image" ] || fos_die "nothing has been deployed yet; use deploy/scripts/deploy.sh <tag>"
fos_prod_preflight

if [ "$restart" = 1 ]; then
  [ "${#services[@]}" -gt 0 ] || services=(app worker)
  fos_log "restarting ${services[*]} ($image)"
  fos_prod_compose restart "${services[@]}" >&2
else
  [ "${#services[@]}" -eq 0 ] || fos_die "service names are only accepted with --restart"
  fos_log "starting db ($image release)"
  fos_prod_compose up -d --wait --wait-timeout "$timeout" db >&2
  fos_log "starting app and worker"
  fos_prod_compose up -d --no-deps --wait --wait-timeout "$timeout" app worker >&2
fi
fos_wait_healthy "$timeout" fos_prod_compose db app worker || fos_die "services did not become healthy; see deploy/scripts/logs.sh"
fos_smoke_check "http://127.0.0.1:$FOS_APP_PORT" || fos_die "smoke checks failed"
fos_append_release_log "start-ok image=$image restart=$restart ${services[*]:-}"
