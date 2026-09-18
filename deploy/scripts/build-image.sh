#!/usr/bin/env bash
# Builds the FinancialOS image at low priority and scans the shipped browser artifacts for private data.
#
# Usage:
#   deploy/scripts/build-image.sh [--no-cache] [--partial]
#
# Tags: financialos:<git-sha> and financialos:<git-sha>-<UTC timestamp> (the timestamped tag is immutable;
# deploy that one). A working tree with uncommitted changes gets a "-dirty" suffix on the sha; a repository
# without commits uses "uncommitted".
#
# Safety on a shared host:
#   * waits for the shared build lock and for enough free memory (scripts/dev/with-lock.sh,
#     FOS_MIN_AVAILABLE_GIB, default 12), and runs the client under nice; heavy steps inside the build also use
#     nice and a 2 GiB Node heap limit; npm uses at most 4 sockets;
#   * never pulls implicitly beyond the base images named in the Dockerfile (already cached on this host).
#
# After the build it copies the web bundle and the extension package out of the image and runs
#   node scripts/privacy/privacy-check.mjs --dir <dir>   and   scripts/privacy/secret-scan.sh --dir <dir>
# on both. Any finding fails the build and removes the new tags.
#
# --partial  (integration testing only) tolerate missing worker/extension bundles; the privacy scan still runs
#            on whatever was built. Never deploy a partial image.
#
# Prints the timestamped image reference on stdout and records it in $FOS_RUNTIME_DIR/build.env.
set -euo pipefail
FOS_SCRIPT_NAME=build-image
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

no_cache=()
partial=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-cache) no_cache=(--no-cache); shift ;;
    --partial) partial=1; shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

fos_require_cmd docker git node python3 nice
cd "$FOS_REPO_ROOT"

if sha="$(git rev-parse --short=12 HEAD 2>/dev/null)"; then
  :
else
  sha="uncommitted"
fi
if [ "$sha" = uncommitted ] || [ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null | head -n1)" ]; then
  sha="${sha}-dirty"
fi
ts="$(fos_timestamp)"
ts_tag="${ts,,}"
image_base="financialos:$sha"
image_ts="financialos:$sha-$ts_tag"
version="$(node -p "require('./package.json').version")"
host_arch="$(docker version --format '{{.Server.Arch}}')"

fos_log "building $image_ts (revision $sha, arch $host_arch)"
build_args=(
  --file deploy/docker/Dockerfile
  --tag "$image_base"
  --tag "$image_ts"
  --build-arg "FOS_VERSION=$version"
  --build-arg "FOS_REVISION=$sha"
  --build-arg "FOS_CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --build-arg "FOS_PARTIAL_BUILD=$partial"
  --progress plain
)
FOS_MIN_AVAILABLE_GIB="${FOS_MIN_AVAILABLE_GIB:-12}" \
  "$FOS_REPO_ROOT/scripts/dev/with-lock.sh" \
  docker build "${no_cache[@]+"${no_cache[@]}"}" "${build_args[@]}" "$FOS_REPO_ROOT" >&2

arch="$(docker image inspect --format '{{.Architecture}}' "$image_ts")"
user="$(docker image inspect --format '{{.Config.User}}' "$image_ts")"
[ "$arch" = "$host_arch" ] || fos_die "built image architecture $arch does not match host $host_arch"
[ "$user" = "10001:10001" ] || fos_die "image user is '$user', expected 10001:10001"

scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/financialos-scan.XXXXXX")"
cid=""
cleanup() {
  if [ -n "$cid" ]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi
  rm -rf "$scan_dir"
}
trap cleanup EXIT

fail_build() {
  fos_warn "$1; removing tags $image_base and $image_ts"
  docker image rm "$image_ts" >/dev/null 2>&1 || true
  if [ "$(docker image inspect --format '{{.Id}}' "$image_base" 2>/dev/null)" != "" ]; then
    docker image rm "$image_base" >/dev/null 2>&1 || true
  fi
  exit 1
}

cid="$(docker create --network none "$image_ts" true)"
mkdir -p "$scan_dir/web" "$scan_dir/extension"
docker cp "$cid:/app/apps/web/dist/." "$scan_dir/web/" >/dev/null
docker cp "$cid:/app/extension/." "$scan_dir/extension/" >/dev/null
zip="$scan_dir/extension/financialos-extension.zip"
scan_targets=("$scan_dir/web")
if [ -f "$zip" ]; then
  mkdir -p "$scan_dir/extension-unpacked"
  python3 - "$zip" "$scan_dir/extension-unpacked" <<'PY'
import os
import sys
import zipfile

src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zf:
    for info in zf.infolist():
        target = os.path.realpath(os.path.join(dest, info.filename))
        if not target.startswith(os.path.realpath(dest) + os.sep):
            sys.exit(f"unsafe path in extension package: {info.filename}")
    zf.extractall(dest)
PY
  scan_targets+=("$scan_dir/extension-unpacked")
  (cd "$scan_dir/extension" && sha256sum -c --quiet financialos-extension.zip.sha256) ||
    fail_build "extension package checksum mismatch"
elif [ "$partial" != 1 ]; then
  fail_build "the image does not contain the extension package"
fi

for target in "${scan_targets[@]}"; do
  label="${target#"$scan_dir"/}"
  fos_log "privacy scan: $label"
  if ! node "$FOS_REPO_ROOT/scripts/privacy/privacy-check.mjs" --dir "$target" >&2; then
    fail_build "privacy check reported findings in $label"
  fi
  if ! "$FOS_REPO_ROOT/scripts/privacy/secret-scan.sh" --dir "$target" >&2; then
    fail_build "secret scan reported findings in $label"
  fi
done

size="$(docker image inspect --format '{{.Size}}' "$image_ts")"
mkdir -p "$FOS_RUNTIME_DIR/notes"
fos_env_set "$FOS_RUNTIME_DIR/build.env" FOS_LAST_BUILT_IMAGE "$image_ts"
printf '%s\t%s\tarch=%s\tsize=%s\tpartial=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$image_ts" "$arch" "$size" "$partial" \
  >>"$FOS_RUNTIME_DIR/notes/builds.log"
fos_log "built $image_ts ($arch, $((size / 1024 / 1024)) MiB); privacy and secret scans passed"
printf '%s\n' "$image_ts"
