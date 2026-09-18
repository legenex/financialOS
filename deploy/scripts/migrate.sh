#!/usr/bin/env bash
# Runs database migrations (and the idempotent private bootstrap) for the production project.
#
# Usage:
#   deploy/scripts/migrate.sh [--image <tag|financialos:tag>]
#
# Uses the one-shot "migrate" service (role fos_migrator) of the recorded release, or of --image. Migrations are
# forward-only and run under the deploy lock and a database advisory lock. deploy.sh already runs this step;
# use this script only to re-run migrations for the current release.
set -euo pipefail
FOS_SCRIPT_NAME=migrate
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --image)
      FOS_IMAGE="$(fos_normalize_image "${2:?}")"
      export FOS_IMAGE
      shift 2
      ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

fos_require_cmd docker flock
image="${FOS_IMAGE:-$(fos_current_image)}"
[ -n "$image" ] || fos_die "no release recorded; pass --image"
fos_validate_image_ref "$image"
fos_image_exists_locally "$image" || fos_die "image $image is not present locally"
export FOS_IMAGE="$image"

fos_acquire_deploy_lock 120
fos_prod_preflight
fos_ensure_volume "$(fos_pgdata_volume)"
fos_log "starting the database"
fos_prod_compose up -d --wait db >&2
fos_log "running migrate with $image"
fos_prod_compose run --rm -T migrate
fos_append_release_log "migrate-ok image=$image"
fos_log "migrations complete"
