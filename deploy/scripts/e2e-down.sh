#!/usr/bin/env bash
# Removes the end-to-end test stack (Compose project financialos-e2e) with its volumes and temporary secrets.
#
# Usage:
#   deploy/scripts/e2e-down.sh
#
# Reads $FOS_RUNTIME_DIR/e2e/current.env written by e2e-up.sh. Safe to run when nothing is running.
set -euo pipefail
FOS_SCRIPT_NAME=e2e-down
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

case "${1:-}" in
  -h | --help) fos_usage_from_header "$0" 0 ;;
  "") ;;
  *) fos_die "unknown argument: $1 (see --help)" ;;
esac
fos_require_cmd docker
state="$FOS_RUNTIME_DIR/e2e/current.env"
dir="$(fos_env_get "$state" FOS_E2E_DIR)"
tmp_root="${TMPDIR:-/tmp}"
if [ -z "$dir" ]; then
  # Nothing recorded: still make sure no stale project is left behind. The directory is only interpolated.
  dir="$(mktemp -d "$tmp_root/financialos-e2e.XXXXXXXX")"
fi
export FOS_E2E_DIR="$dir" FOS_IMAGE="${FOS_IMAGE:-financialos:down}"
fos_log "removing $FOS_E2E_PROJECT and its volumes"
fos_e2e_compose --profile seed down --volumes --remove-orphans --timeout 10 >&2
case "$dir" in
  "$tmp_root"/financialos-e2e.*)
    rm -rf -- "$dir"
    ;;
  *) fos_warn "not removing unexpected directory $dir" ;;
esac
rm -f "$state"
fos_log "e2e stack removed"
