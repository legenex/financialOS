#!/usr/bin/env bash
# Stops the synthetic development stack (Compose project financialos-dev only).
#
# Usage:
#   deploy/scripts/dev-down.sh [--volumes]
#
#   --volumes  also delete the financialos_dev_* volumes (demo database, documents, backups). The dev secrets
#              and config in $FOS_RUNTIME_DIR/dev/ are kept.
set -euo pipefail
FOS_SCRIPT_NAME=dev-down
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

args=(down --remove-orphans)
while [ $# -gt 0 ]; do
  case "$1" in
    --volumes | -v) args+=(--volumes); shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
fos_require_cmd docker
# The image reference only matters for interpolation; down does not start anything.
export FOS_IMAGE="${FOS_IMAGE:-financialos:down}"
fos_log "stopping $FOS_DEV_PROJECT ${args[*]:1}"
fos_dev_compose "${args[@]}" >&2
