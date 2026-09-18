#!/usr/bin/env bash
# Starts the synthetic development/demo stack (Compose project financialos-dev) on 127.0.0.1:$FOS_DEV_PORT.
#
# Usage:
#   deploy/scripts/dev-up.sh [--image <tag|financialos:tag>] [--origin <origin>]
#
#   --image   image to run (default: the last image built by build-image.sh, from $FOS_RUNTIME_DIR/build.env)
#   --origin  canonical origin written to the dev config the first time (default http://localhost:$FOS_DEV_PORT)
#
# Uses dedicated dev secrets and config under $FOS_RUNTIME_DIR/dev/ (created on first use; never the production
# secrets), named volumes financialos_dev_*, runs migrations and `seed-demo` (synthetic data only), then waits
# for healthy app and worker. The private owner bootstrap is never mounted. Prints the app URL and the path of
# the dev bootstrap secret (read it with cat to complete setup in the demo stack).
set -euo pipefail
FOS_SCRIPT_NAME=dev-up
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

image=""
origin=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="$(fos_normalize_image "${2:?}")"; shift 2 ;;
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
fos_check_memory 4 || fos_die "less than 4 GiB of memory available; not starting the dev stack now"

dev_dir="$FOS_RUNTIME_DIR/dev"
"$FOS_SCRIPTS_DIR/init-runtime.sh" --profile dev >/dev/null
config_args=(--profile dev)
[ -n "$origin" ] && config_args+=(--origin "$origin")
"$FOS_SCRIPTS_DIR/write-config.sh" "${config_args[@]}" >/dev/null

export FOS_IMAGE="$image"
fos_log "starting $FOS_DEV_PROJECT with $image"
fos_dev_compose up -d --wait --wait-timeout 300 db app worker >&2 || {
  fos_dev_compose ps -a >&2 || true
  fos_dev_compose logs --tail 60 migrate seed app worker >&2 || true
  fos_die "dev stack did not become healthy"
}
fos_check_published_ports "$FOS_DEV_PROJECT" "$FOS_DEV_PORT" >&2 || fos_die "unexpected published ports in $FOS_DEV_PROJECT"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$FOS_DEV_PORT/healthz" || true)"
[ "$code" = 200 ] || fos_die "dev app /healthz returned ${code:-nothing}"
fos_log "dev stack healthy"
printf 'FOS_DEV_URL=http://127.0.0.1:%s\n' "$FOS_DEV_PORT"
printf 'FOS_DEV_BOOTSTRAP_SECRET_FILE=%s\n' "$dev_dir/secrets/bootstrap-secret"
