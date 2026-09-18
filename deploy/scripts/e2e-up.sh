#!/usr/bin/env bash
# Starts a disposable end-to-end test stack (Compose project financialos-e2e) on 127.0.0.1:$FOS_E2E_PORT.
#
# Usage:
#   deploy/scripts/e2e-up.sh [--image <tag|financialos:tag>] [--seed] [--origin <origin>]
#
#   --image   image to test (default: the last image built by build-image.sh)
#   --seed    also load synthetic demo data (seed-demo) after migrations
#   --origin  canonical origin for the test config (default http://localhost:$FOS_E2E_PORT, or $FOS_E2E_ORIGIN)
#
# Creates a private temporary directory (mode 0700) with generated test secrets and config; the database and
# documents live in tmpfs. Prints, as KEY=VALUE lines, the values the e2e harness needs, and stores them in
# $FOS_RUNTIME_DIR/e2e/current.env:
#   FOS_E2E_BASE_URL               app URL
#   FOS_E2E_BOOTSTRAP_SECRET_FILE  file holding the one-time setup secret for this stack (read it; never log it)
#   FOS_E2E_DIR                    the temporary directory (removed by e2e-down.sh)
#   FOS_E2E_IMAGE                  the image under test
set -euo pipefail
FOS_SCRIPT_NAME=e2e-up
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

image=""
seed=0
origin="${FOS_E2E_ORIGIN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="$(fos_normalize_image "${2:?}")"; shift 2 ;;
    --seed) seed=1; shift ;;
    --origin) origin="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
fos_require_cmd docker curl python3 openssl
image="${image:-$(fos_env_get "$FOS_RUNTIME_DIR/build.env" FOS_LAST_BUILT_IMAGE)}"
[ -n "$image" ] || fos_die "no image given and none recorded by build-image.sh; pass --image"
fos_validate_image_ref "$image"
fos_image_exists_locally "$image" || fos_die "image $image is not present locally"
fos_check_memory 4 || fos_die "less than 4 GiB of memory available; not starting the e2e stack now"

state_dir="$FOS_RUNTIME_DIR/e2e"
state="$state_dir/current.env"
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
if [ -f "$state" ]; then
  fos_log "an e2e stack is already recorded; replacing it"
  "$FOS_SCRIPTS_DIR/e2e-down.sh" >&2
fi

FOS_E2E_DIR="$(mktemp -d "${TMPDIR:-/tmp}/financialos-e2e.XXXXXXXX")"
chmod 0700 "$FOS_E2E_DIR"
export FOS_E2E_DIR FOS_IMAGE="$image"
"$FOS_SCRIPTS_DIR/init-runtime.sh" --profile e2e --dir "$FOS_E2E_DIR" >/dev/null
config_args=(--profile e2e --out "$FOS_E2E_DIR/config/app-config.json")
[ -n "$origin" ] && config_args+=(--origin "$origin")
"$FOS_SCRIPTS_DIR/write-config.sh" "${config_args[@]}" >/dev/null

base_url="http://127.0.0.1:$FOS_E2E_PORT"
{
  printf 'FOS_E2E_BASE_URL=%s\n' "$base_url"
  printf 'FOS_E2E_BOOTSTRAP_SECRET_FILE=%s\n' "$FOS_E2E_DIR/secrets/bootstrap-secret"
  printf 'FOS_E2E_DIR=%s\n' "$FOS_E2E_DIR"
  printf 'FOS_E2E_IMAGE=%s\n' "$image"
} >"$state.tmp"
chmod 0600 "$state.tmp"
mv -f "$state.tmp" "$state"

fos_log "starting $FOS_E2E_PROJECT with $image (state in $FOS_E2E_DIR)"
fos_e2e_compose up -d --wait --wait-timeout 180 db >&2
fos_e2e_compose run --rm -T migrate >&2 || fos_die "e2e migrate failed"
if [ "$seed" = 1 ]; then
  fos_e2e_compose --profile seed run --rm -T seed >&2 || fos_die "e2e seed-demo failed"
fi
fos_e2e_compose up -d --no-deps --wait --wait-timeout 180 app worker >&2 || {
  fos_e2e_compose logs --tail 60 app worker >&2 || true
  fos_die "e2e stack did not become healthy"
}
fos_check_published_ports "$FOS_E2E_PROJECT" "$FOS_E2E_PORT" >&2 || fos_die "unexpected published ports in $FOS_E2E_PROJECT"
fos_log "e2e stack healthy on $base_url"
cat "$state"
