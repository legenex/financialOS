#!/usr/bin/env bash
# Creates or updates the private runtime configuration (app-config.json) with validation.
#
# Usage:
#   deploy/scripts/write-config.sh [--profile prod|dev|e2e] [--out <file>] [--force] [--dry-run]
#       [--origin <origin>] [--extra-origin <origin>]... [--clear-extra-origins]
#       [--extension-id <id>]... [--clear-extension-ids]
#       [--trusted-proxy-cidr <cidr>]... [--clear-trusted-proxies]
#       [--oauth-base <origin>] [--log-level <level>] [--rp-name <name>] [--body-limit-bytes <n>]
#
#   --profile prod  (default) writes $FOS_RUNTIME_DIR/config/app-config.json; --origin is required
#                   the first time. Plain http origins are accepted only for loopback (SSH tunnel access).
#   --profile dev   writes $FOS_RUNTIME_DIR/dev/config/app-config.json; default origin http://localhost:<dev port>
#   --profile e2e   requires --out; default origin http://localhost:<e2e port>
#   --origin        canonical origin, exactly scheme://host[:port] (for example https://finance.example.test:8443)
#   --extra-origin  additional allowed origin (repeatable), e.g. http://localhost:3180 for an SSH tunnel
#   --extension-id  paired Chrome extension id (32 letters a-p, repeatable)
#   --oauth-base    origin used for OAuth callback URLs (default: the canonical origin)
#   --force         required to change an existing file; the previous file is kept as <file>.bak-<timestamp>.
#                   Values that are not given on the command line are kept from the existing file.
#   --dry-run       validate and print the resulting JSON without writing it
#
# The file contains no secrets (only paths to secret files inside the containers) and is written with mode 0640.
# The app reads it at start-up: restart the app after a change (deploy/scripts/start.sh --restart app).
set -euo pipefail
FOS_SCRIPT_NAME=write-config
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

profile=prod
out=""
force=0
dry_run=0
origin=""
oauth_base=""
log_level=""
rp_name=""
body_limit=""
extra_origins=()
extension_ids=()
proxy_cidrs=()
clear_extra=0
clear_ext=0
clear_proxies=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --force) force=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --origin) origin="${2:?}"; shift 2 ;;
    --extra-origin) extra_origins+=("${2:?}"); shift 2 ;;
    --clear-extra-origins) clear_extra=1; shift ;;
    --extension-id) extension_ids+=("${2:?}"); shift 2 ;;
    --clear-extension-ids) clear_ext=1; shift ;;
    --trusted-proxy-cidr) proxy_cidrs+=("${2:?}"); shift 2 ;;
    --clear-trusted-proxies) clear_proxies=1; shift ;;
    --oauth-base) oauth_base="${2:?}"; shift 2 ;;
    --log-level) log_level="${2:?}"; shift 2 ;;
    --rp-name) rp_name="${2:?}"; shift 2 ;;
    --body-limit-bytes) body_limit="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$profile" in
  prod) out="${out:-$FOS_RUNTIME_DIR/config/app-config.json}"; environment=production; default_origin="" ;;
  dev) out="${out:-$FOS_RUNTIME_DIR/dev/config/app-config.json}"; environment=development; default_origin="http://localhost:$FOS_DEV_PORT" ;;
  e2e)
    [ -n "$out" ] || fos_die "--profile e2e requires --out"
    environment=test
    default_origin="${FOS_E2E_ORIGIN:-http://localhost:$FOS_E2E_PORT}"
    ;;
  *) fos_die "unknown profile: $profile" ;;
esac
fos_require_cmd python3

if [ -e "$out" ] && [ "$force" != 1 ] && [ "$dry_run" != 1 ]; then
  fos_log "$out already exists; not changing it (use --force to update; a backup is kept)"
  printf '%s\n' "$out"
  exit 0
fi

join() {
  local IFS=$'\n'
  printf '%s' "$*"
}

result="$(
  FOS_WC_OUT="$out" FOS_WC_ENV="$environment" FOS_WC_DEFAULT_ORIGIN="$default_origin" \
  FOS_WC_ORIGIN="$origin" FOS_WC_OAUTH="$oauth_base" FOS_WC_LOG="$log_level" FOS_WC_RP="$rp_name" \
  FOS_WC_BODY="$body_limit" FOS_WC_EXTRA="$(join "${extra_origins[@]+"${extra_origins[@]}"}")" \
  FOS_WC_EXT="$(join "${extension_ids[@]+"${extension_ids[@]}"}")" \
  FOS_WC_PROXY="$(join "${proxy_cidrs[@]+"${proxy_cidrs[@]}"}")" \
  FOS_WC_CLEAR_EXTRA="$clear_extra" FOS_WC_CLEAR_EXT="$clear_ext" FOS_WC_CLEAR_PROXY="$clear_proxies" \
  python3 - <<'PY'
import ipaddress
import json
import os
import re
import sys
from urllib.parse import urlsplit

env = os.environ
out = env["FOS_WC_OUT"]
environment = env["FOS_WC_ENV"]
errors = []


def lines(name):
    return [v for v in env.get(name, "").split("\n") if v]


def check_origin(value, label):
    try:
        parts = urlsplit(value)
    except ValueError:
        errors.append(f"{label}: not a URL: {value}")
        return
    host = parts.hostname or ""
    rebuilt = f"{parts.scheme}://{parts.netloc}"
    if parts.scheme not in ("https", "http") or not host or rebuilt != value or parts.path or parts.query or parts.fragment:
        errors.append(f"{label}: expected an exact origin like https://host[:port] without path or trailing slash: {value}")
        return
    if parts.username or parts.password:
        errors.append(f"{label}: credentials are not allowed in an origin")
    if value != value.lower():
        errors.append(f"{label}: use lower case: {value}")
    if parts.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
        errors.append(f"{label}: plain http is only allowed for loopback origins: {value}")
    try:
        parts.port
    except ValueError:
        errors.append(f"{label}: invalid port: {value}")


existing = {}
if os.path.exists(out):
    try:
        with open(out, encoding="utf-8") as fh:
            existing = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"existing config {out} is unreadable or invalid JSON ({exc.__class__.__name__}); move it away first")

canonical = env["FOS_WC_ORIGIN"] or existing.get("canonicalOrigin") or env["FOS_WC_DEFAULT_ORIGIN"]
if not canonical:
    errors.append("--origin is required (for example --origin https://finance.example.test:8443)")
else:
    check_origin(canonical, "--origin")

extra = lines("FOS_WC_EXTRA")
if not extra and env["FOS_WC_CLEAR_EXTRA"] != "1":
    old = [o for o in existing.get("allowedOrigins", []) if o != existing.get("canonicalOrigin")]
    extra = old
if not extra and not existing and environment != "production":
    parts = urlsplit(canonical) if canonical else None
    if parts and parts.hostname == "localhost":
        extra = [f"{parts.scheme}://127.0.0.1" + (f":{parts.port}" if parts.port else "")]
for value in extra:
    check_origin(value, "--extra-origin")
allowed = [canonical] + [o for o in dict.fromkeys(extra) if o != canonical]

ext_ids = lines("FOS_WC_EXT")
if not ext_ids and env["FOS_WC_CLEAR_EXT"] != "1":
    ext_ids = existing.get("allowedExtensionIds", [])
for value in ext_ids:
    if not re.fullmatch(r"[a-p]{32}", value):
        errors.append(f"--extension-id: expected 32 letters a-p: {value}")
ext_ids = list(dict.fromkeys(ext_ids))

proxies = lines("FOS_WC_PROXY")
if not proxies and env["FOS_WC_CLEAR_PROXY"] != "1":
    proxies = existing.get("trustedProxyCidrs", [])
for value in proxies:
    try:
        ipaddress.ip_network(value, strict=True)
    except ValueError:
        errors.append(f"--trusted-proxy-cidr: invalid CIDR: {value}")

oauth = env["FOS_WC_OAUTH"] or existing.get("publicBaseForOAuthCallbacks") or canonical
if env["FOS_WC_ORIGIN"] and not env["FOS_WC_OAUTH"] and existing.get("publicBaseForOAuthCallbacks") == existing.get("canonicalOrigin"):
    oauth = canonical
if oauth:
    check_origin(oauth, "--oauth-base")

log_level = env["FOS_WC_LOG"] or existing.get("logLevel") or ("info" if environment == "production" else "debug")
if log_level not in ("fatal", "error", "warn", "info", "debug", "trace", "silent"):
    errors.append(f"--log-level: unsupported level {log_level}")

rp_name = env["FOS_WC_RP"] or existing.get("rpName") or "FinancialOS"
if not (1 <= len(rp_name) <= 64):
    errors.append("--rp-name must be 1-64 characters")

body = env["FOS_WC_BODY"] or existing.get("bodyLimitBytes") or 1048576
try:
    body = int(body)
    if not 1024 <= body <= 10 * 1024 * 1024:
        raise ValueError
except ValueError:
    errors.append("--body-limit-bytes must be an integer between 1024 and 10485760")

if errors:
    for e in errors:
        print(f"write-config: {e}", file=sys.stderr)
    sys.exit(1)

config = {
    "environment": environment,
    "listen": {"host": "0.0.0.0", "port": 3000},
    "canonicalOrigin": canonical,
    "allowedOrigins": allowed,
    "trustedProxyCidrs": proxies,
    "rpName": rp_name,
    "webDistDir": "/app/apps/web/dist",
    "extensionPackagePath": "/app/extension/financialos-extension.zip",
    "allowedExtensionIds": ext_ids,
    "keyringPath": "/run/secrets/keyring.json",
    "sessionPepperPath": "/run/secrets/session-pepper",
    "bootstrapHashPath": "/run/secrets/bootstrap-secret-hash",
    "database": {
        "url": "postgres://fos_app@db:5432/financialos",
        "role": "fos_app",
        "passwordFile": "/run/secrets/db-password",
    },
    "documentsDir": "/data/documents",
    "logLevel": log_level,
    "publicBaseForOAuthCallbacks": oauth,
    "bodyLimitBytes": body,
}
# Keep keys this script does not manage (for example settings added by later releases).
for key, value in existing.items():
    config.setdefault(key, value)
print(json.dumps(config, indent=2))
PY
)"

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$result"
  exit 0
fi

mkdir -p "$(dirname "$out")"
if [ -e "$out" ]; then
  if [ "$(cat "$out")" = "$result" ]; then
    fos_log "$out is already up to date"
    printf '%s\n' "$out"
    exit 0
  fi
  backup="$out.bak-$(fos_timestamp)"
  cp -p "$out" "$backup"
  fos_log "previous config kept as $backup"
fi
fos_write_json_file "$out" "$result"
chgrp "$(id -g)" "$out"
fos_log "wrote $out (restart the app to apply)"
printf '%s\n' "$out"
