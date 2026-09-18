#!/usr/bin/env bash
# Stops the production FinancialOS containers (project "financialos" only). Data volumes are kept.
#
# Usage:
#   deploy/scripts/stop.sh [app|worker|db ...]
#
# Without arguments, stops app and worker first (so jobs can finish within the grace period) and then the
# database. Containers stay stopped until deploy/scripts/start.sh (they do not restart at boot while stopped).
set -euo pipefail
FOS_SCRIPT_NAME=stop
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

services=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) fos_usage_from_header "$0" 0 ;;
    db | app | worker) services+=("$1"); shift ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

fos_require_cmd docker flock
fos_acquire_deploy_lock 120
[ -n "$(fos_current_image)" ] || fos_die "nothing has been deployed yet"
if [ "${#services[@]}" -gt 0 ]; then
  fos_log "stopping ${services[*]}"
  fos_prod_compose stop "${services[@]}" >&2
else
  fos_log "stopping app and worker"
  fos_prod_compose stop app worker >&2
  fos_log "stopping db"
  fos_prod_compose stop db >&2
fi
fos_append_release_log "stop ${services[*]:-all}"
fos_prod_compose ps -a >&2
