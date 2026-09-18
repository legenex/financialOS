#!/usr/bin/env bash
# Shows recent production logs (app and worker by default). The app and worker redact secrets and financial
# values before logging; database statement logging is disabled.
#
# Usage:
#   deploy/scripts/logs.sh [app|worker|db|migrate ...] [--since <duration>] [--tail <lines>] [--follow]
#
#   --since   e.g. 30m, 2h (default 1h)
#   --tail    lines per service (default 200)
#   --follow  keep streaming (Ctrl+C to stop)
#
# Container logs rotate at 10 MiB x 5 files per container (json-file driver).
set -euo pipefail
FOS_SCRIPT_NAME=logs
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

services=()
since=1h
tail=200
follow=()
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="${2:?}"; shift 2 ;;
    --tail) tail="${2:?}"; shift 2 ;;
    --follow | -f) follow=(--follow); shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    db | app | worker | migrate) services+=("$1"); shift ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ "$tail" =~ ^[0-9]+$ ]] || fos_die "--tail must be a number"
[[ "$since" =~ ^[0-9]+[smhd]?$ ]] || fos_die "--since must look like 30m or 2h"
[ "${#services[@]}" -gt 0 ] || services=(app worker)
fos_require_cmd docker
fos_prod_compose logs --timestamps --since "$since" --tail "$tail" "${follow[@]+"${follow[@]}"}" "${services[@]}"
