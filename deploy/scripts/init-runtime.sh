#!/usr/bin/env bash
# Creates the private runtime directory layout and generates missing secrets. Never overwrites a secret.
#
# Usage:
#   deploy/scripts/init-runtime.sh [--profile prod|dev|e2e] [--dir <path>] [--image <name:tag>]
#                                  [--rotate-bootstrap-secret]
#
#   --profile prod   (default) $FOS_RUNTIME_DIR with config/ secrets/ backups/ bootstrap/ notes/ baseline/
#                    tailscale-backup/ logs/ reports/ tmp/
#   --profile dev    $FOS_RUNTIME_DIR/dev with config/ secrets/ (synthetic demo stack only)
#   --profile e2e    --dir <path> is required; config/ secrets/ for a disposable test stack
#   --dir <path>     override the base directory for the profile
#   --image <ref>    use the image's `cli.mjs keys:generate` for the keyring and cross-check the bootstrap hash
#                    with `cli.mjs bootstrap-secret:hash` (otherwise OpenSSL randomness in the same format)
#   --rotate-bootstrap-secret
#                    replace the one-time bootstrap secret (only useful before owner setup is sealed;
#                    restart the app afterwards)
#
# Generated in <base>/secrets (mode 0640, group = your primary group, which the containers join):
#   db-superuser-password db-migrator-password db-app-password db-worker-password db-backup-password
#                    32 random bytes, base64url
#   keyring.json     {"active":"k1","keys":{"k1":"<base64 of 32 random bytes>"}} (AES-256-GCM keyring)
#   session-pepper   48 random bytes, base64url
#   backup-key       32 random bytes, base64 (backup encryption key)
#   bootstrap-secret.sha256   sha256 hex of the bootstrap secret (mounted into the app)
# and, mode 0600 and never mounted into any container:
#   bootstrap-secret one-time owner setup secret, 256 bits, base64url
#
# Only file paths are printed, never secret values. Keep offline copies of keyring.json and backup-key:
# without them, backups cannot be decrypted (docs/BACKUP_AND_RECOVERY.md).
set -euo pipefail
FOS_SCRIPT_NAME=init-runtime
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

profile=prod
base=""
image=""
rotate_bootstrap=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="${2:?--profile needs a value}"; shift 2 ;;
    --dir) base="${2:?--dir needs a value}"; shift 2 ;;
    --image) image="${2:?--image needs a value}"; shift 2 ;;
    --rotate-bootstrap-secret) rotate_bootstrap=1; shift ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$profile" in
  prod) base="${base:-$FOS_RUNTIME_DIR}" ;;
  dev) base="${base:-$FOS_RUNTIME_DIR/dev}" ;;
  e2e) [ -n "$base" ] || fos_die "--profile e2e requires --dir" ;;
  *) fos_die "unknown profile: $profile" ;;
esac
case "$base" in
  /*) ;;
  *) fos_die "the base directory must be an absolute path" ;;
esac

fos_require_cmd openssl sha256sum stat
if [ -n "$image" ]; then
  image="$(fos_normalize_image "$image")"
  fos_validate_image_ref "$image"
  fos_require_cmd docker
  fos_image_exists_locally "$image" || fos_die "image $image is not present locally (no pulls are performed)"
fi

umask 077
gid="$(id -g)"

make_dir() {
  local dir="$1" mode="$2"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    fos_log "created $dir"
  fi
  chmod "$mode" "$dir"
  chgrp "$gid" "$dir"
}

# Creates <file> from the generator's stdout with O_EXCL semantics (noclobber); never replaces a file.
create_secret() {
  local file="$1" mode="$2"
  shift 2
  if [ -e "$file" ]; then
    chgrp "$gid" "$file"
    chmod "$mode" "$file"
    printf 'kept      %s\n' "$file"
    return 0
  fi
  local tmp
  tmp="$(mktemp "$(dirname "$file")/.new.XXXXXX")"
  if ! "$@" >"$tmp" || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    fos_die "could not generate $file"
  fi
  chgrp "$gid" "$tmp"
  chmod "$mode" "$tmp"
  # ln fails if the target appeared meanwhile, so an existing secret is never replaced.
  if ln "$tmp" "$file" 2>/dev/null; then
    rm -f "$tmp"
    printf 'generated %s\n' "$file"
  else
    rm -f "$tmp"
    printf 'kept      %s\n' "$file"
  fi
}

gen_b64url() {
  openssl rand -base64 "$1" | tr -d '\n' | tr '+/' '-_' | tr -d '='
  printf '\n'
}
gen_b64() {
  openssl rand -base64 "$1" | tr -d '\n'
  printf '\n'
}
gen_keyring() {
  if [ -n "$image" ]; then
    local out
    out="$(mktemp -d "$secrets_dir/.keygen.XXXXXX")"
    chmod 0700 "$out"
    if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --user "$(id -u):$gid" -v "$out:/out" "$image" \
      node apps/api/dist/cli.mjs keys:generate --out /out/keyring.json >/dev/null; then
      cat "$out/keyring.json"
      rm -rf "$out"
      return 0
    fi
    rm -rf "$out"
    fos_die "keys:generate failed in $image"
  fi
  local key
  key="$(openssl rand -base64 32 | tr -d '\n')"
  printf '{"active":"k1","keys":{"k1":"%s"}}\n' "$key"
}
gen_bootstrap_hash() {
  tr -d '\r\n' <"$secrets_dir/bootstrap-secret" | sha256sum | awk '{print $1}'
}

make_dir "$base" 0700
# config/ and secrets/ hold files the containers read by bind mount (uid 10001, supplementary group
# $gid via group_add): the directories need group search access, or the group-readable 0640 files
# inside them are unreachable. The files themselves stay 0640; nothing here becomes group-writable.
make_dir "$base/config" 0750
make_dir "$base/secrets" 0750
if [ "$profile" = prod ]; then
  make_dir "$base/bootstrap" 0750
  for sub in notes baseline tailscale-backup logs reports tmp; do
    make_dir "$base/$sub" 0700
  done
  # The worker (uid 10001, supplementary group $gid) writes backups here; setgid keeps files in the group.
  make_dir "$base/backups" 2770
  if [ -f "$base/bootstrap/owner-bootstrap.json" ]; then
    chgrp "$gid" "$base/bootstrap/owner-bootstrap.json"
    chmod 0640 "$base/bootstrap/owner-bootstrap.json"
  fi
fi

secrets_dir="$base/secrets"
for role in superuser migrator app worker backup; do
  create_secret "$secrets_dir/db-$role-password" 0640 gen_b64url 32
done
create_secret "$secrets_dir/keyring.json" 0640 gen_keyring
create_secret "$secrets_dir/session-pepper" 0640 gen_b64url 48
create_secret "$secrets_dir/backup-key" 0640 gen_b64 32

if [ "$rotate_bootstrap" = 1 ]; then
  rm -f "$secrets_dir/bootstrap-secret" "$secrets_dir/bootstrap-secret.sha256"
  fos_warn "bootstrap secret rotated; restart the app so it loads the new hash"
fi
if [ -e "$secrets_dir/bootstrap-secret" ] || [ ! -e "$secrets_dir/bootstrap-secret.sha256" ]; then
  create_secret "$secrets_dir/bootstrap-secret" 0600 gen_b64url 32
  if [ -e "$secrets_dir/bootstrap-secret.sha256" ]; then
    if [ "$(cat "$secrets_dir/bootstrap-secret.sha256")" != "$(gen_bootstrap_hash)" ]; then
      fos_die "bootstrap-secret.sha256 does not match bootstrap-secret; use --rotate-bootstrap-secret before setup"
    fi
  fi
  create_secret "$secrets_dir/bootstrap-secret.sha256" 0640 gen_bootstrap_hash
else
  printf 'kept      %s (the one-time secret itself was removed after setup)\n' "$secrets_dir/bootstrap-secret.sha256"
fi

if [ -n "$image" ] && [ -e "$secrets_dir/bootstrap-secret" ]; then
  expected="$(cat "$secrets_dir/bootstrap-secret.sha256")"
  actual="$(docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    "$image" node apps/api/dist/cli.mjs bootstrap-secret:hash <"$secrets_dir/bootstrap-secret" | tr -d '\r\n')"
  [ "$actual" = "$expected" ] || fos_die "the image's bootstrap-secret:hash disagrees with bootstrap-secret.sha256"
  fos_log "bootstrap hash cross-checked with $image"
fi

# Final permission audit: nothing in secrets/ may be accessible to other users.
bad="$(find "$secrets_dir" -mindepth 1 -perm /o=rwx -print)"
[ -z "$bad" ] || fos_die "files accessible to other users in $secrets_dir: $bad"
fos_log "runtime directory ready: $base (profile $profile)"
