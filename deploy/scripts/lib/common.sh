# shellcheck shell=bash
# Shared helpers for the FinancialOS operational scripts. Source this file; do not run it.
#
# Conventions:
#   * progress messages go to stderr, machine-readable output (paths, JSON) to stdout;
#   * secret values are never printed, only file paths;
#   * every Docker command targets an explicit financialos* Compose project.

if [ -n "${FOS_COMMON_SH_LOADED:-}" ]; then
  return 0
fi
FOS_COMMON_SH_LOADED=1

FOS_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOS_REPO_ROOT="$(cd "$FOS_SCRIPTS_DIR/../.." && pwd)"
FOS_COMPOSE_DIR="$FOS_REPO_ROOT/deploy/compose"
FOS_RUNTIME_DIR="${FOS_RUNTIME_DIR:-/srv/projects/financialos}"
FOS_PROD_PROJECT="financialos"
FOS_DEV_PROJECT="financialos-dev"
FOS_E2E_PROJECT="financialos-e2e"
FOS_APP_PORT="${FOS_APP_PORT:-3180}"
FOS_DEV_PORT="${FOS_DEV_PORT:-3190}"
FOS_E2E_PORT="${FOS_E2E_PORT:-3181}"
FOS_TS_HTTPS_PORT="${FOS_TS_HTTPS_PORT:-8443}"
# The host's Tailscale IP (kept out of tracked files; see $FOS_RUNTIME_DIR/network.env). Only the prod
# compose file requires it (it publishes the app port there in addition to 127.0.0.1); dev/e2e never read it.
FOS_TAILSCALE_IP="${FOS_TAILSCALE_IP:-}"
export FOS_RUNTIME_DIR

# Containers run as this uid; secret files are shared with it through the group of the runtime directory.
FOS_CONTAINER_UID=10001

fos_log() { printf '%s [%s] %s\n' "$(date +%H:%M:%S)" "${FOS_SCRIPT_NAME:-fos}" "$*" >&2; }
fos_warn() { printf '%s [%s] WARNING: %s\n' "$(date +%H:%M:%S)" "${FOS_SCRIPT_NAME:-fos}" "$*" >&2; }
fos_die() {
  printf '%s [%s] ERROR: %s\n' "$(date +%H:%M:%S)" "${FOS_SCRIPT_NAME:-fos}" "$*" >&2
  exit 1
}

fos_require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || fos_die "required command not found: $c"
  done
}

# Prints the leading comment block of the calling script (its usage text) and exits.
fos_usage_from_header() {
  local file="$1" code="${2:-0}"
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$file"
  exit "$code"
}

fos_timestamp() { date -u +%Y%m%dT%H%M%SZ; }

fos_require_runtime_dir() {
  [ -d "$FOS_RUNTIME_DIR" ] || fos_die "runtime directory $FOS_RUNTIME_DIR does not exist; run deploy/scripts/init-runtime.sh"
  [ -d "$FOS_RUNTIME_DIR/secrets" ] || fos_die "$FOS_RUNTIME_DIR/secrets is missing; run deploy/scripts/init-runtime.sh"
}

# The gid that may read secret and config files inside the containers (group_add). It is the group of the
# runtime secrets directory, which init-runtime.sh sets to the operator's primary group.
fos_secrets_gid() {
  if [ -d "$FOS_RUNTIME_DIR/secrets" ]; then
    stat -c %g "$FOS_RUNTIME_DIR/secrets"
  else
    id -g
  fi
}

fos_export_compose_env() {
  FOS_SECRETS_GID="$(fos_secrets_gid)"
  export FOS_SECRETS_GID FOS_RUNTIME_DIR FOS_APP_PORT FOS_DEV_PORT FOS_E2E_PORT FOS_TAILSCALE_IP
}

# Reads KEY from an env-style file without sourcing it. Prints an empty string when absent.
fos_env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { if (v != "") print v }' "$file"
}

# Writes KEY=VALUE into an env-style file atomically, preserving other keys.
fos_env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if [ -f "$file" ]; then
    awk -F= -v k="$key" '$1 != k' "$file" >"$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$file"
}

# FOS_TAILSCALE_IP is deployment-specific and never lives in a tracked file; fall back to the private
# runtime directory's network.env (created once with: deploy/scripts/lib/common.sh sourced, then
# `fos_env_set "$FOS_RUNTIME_DIR/network.env" FOS_TAILSCALE_IP <ip>`).
if [ -z "$FOS_TAILSCALE_IP" ]; then
  FOS_TAILSCALE_IP="$(fos_env_get "$FOS_RUNTIME_DIR/network.env" FOS_TAILSCALE_IP)"
fi

FOS_RELEASE_ENV="$FOS_RUNTIME_DIR/release.env"

fos_validate_image_ref() {
  local image="$1"
  case "$image" in
    *:latest | *:) fos_die "refusing image reference '$image': use an explicit, immutable tag" ;;
  esac
  [[ "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] ||
    fos_die "invalid image reference '$image' (expected name:tag)"
}

# Accepts either a bare tag (resolved to financialos:<tag>) or a full name:tag reference.
fos_normalize_image() {
  local ref="$1"
  if [[ "$ref" == *:* ]]; then
    printf '%s\n' "$ref"
  else
    printf 'financialos:%s\n' "$ref"
  fi
}

fos_image_exists_locally() { docker image inspect "$1" >/dev/null 2>&1; }

fos_current_image() { fos_env_get "$FOS_RELEASE_ENV" FOS_IMAGE; }
fos_previous_image() { fos_env_get "$FOS_RELEASE_ENV" FOS_PREVIOUS_IMAGE; }

# Production data volume names (restore.sh switches them; defaults otherwise).
fos_pgdata_volume() {
  local v
  v="$(fos_env_get "$FOS_RELEASE_ENV" FOS_PGDATA_VOLUME)"
  printf '%s\n' "${v:-financialos_pgdata}"
}
fos_documents_volume() {
  local v
  v="$(fos_env_get "$FOS_RELEASE_ENV" FOS_DOCUMENTS_VOLUME)"
  printf '%s\n' "${v:-financialos_documents}"
}

# Runs docker compose for the production project. FOS_IMAGE may be set by the caller (deploy/rollback);
# otherwise the recorded release is used.
fos_prod_compose() {
  fos_export_compose_env
  local image
  image="${FOS_IMAGE:-$(fos_current_image)}"
  [ -n "$image" ] || fos_die "no release recorded in $FOS_RELEASE_ENV; deploy an explicit tag with deploy/scripts/deploy.sh <tag>"
  FOS_IMAGE="$image" \
    FOS_PGDATA_VOLUME="${FOS_PGDATA_VOLUME:-$(fos_pgdata_volume)}" \
    FOS_DOCUMENTS_VOLUME="${FOS_DOCUMENTS_VOLUME:-$(fos_documents_volume)}" \
    docker compose --project-name "$FOS_PROD_PROJECT" --file "$FOS_COMPOSE_DIR/prod.compose.yml" "$@"
}

fos_prod_service_running() {
  local cid
  cid="$(fos_prod_compose ps -q "$1" 2>/dev/null | head -n1)"
  [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null)" = true ]
}

# HTTP smoke checks against a running app. Prints one line per check; returns non-zero on any failure.
fos_smoke_check() {
  local base="$1" failures=0 code headers
  headers="$(mktemp)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base/healthz" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then echo "ok    GET /healthz -> 200"; else echo "FAIL  GET /healthz -> ${code:-no response}"; failures=$((failures + 1)); fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base/readyz" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then echo "ok    GET /readyz -> 200"; else echo "FAIL  GET /readyz -> ${code:-no response}"; failures=$((failures + 1)); fi
  code="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 10 "$base/" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then echo "ok    GET / -> 200"; else echo "FAIL  GET / -> ${code:-no response}"; failures=$((failures + 1)); fi
  if grep -qi '^content-type:[[:space:]]*text/html' "$headers"; then echo "ok    / is text/html"; else echo "FAIL  / is not served as text/html"; failures=$((failures + 1)); fi
  if grep -qi '^content-security-policy:' "$headers"; then echo "ok    / sends Content-Security-Policy"; else echo "FAIL  / has no Content-Security-Policy header"; failures=$((failures + 1)); fi
  if grep -i '^cache-control:' "$headers" | grep -qi 'no-store'; then echo "ok    / sends Cache-Control: no-store"; else echo "FAIL  / does not send Cache-Control: no-store"; failures=$((failures + 1)); fi
  if grep -qi '^x-content-type-options:[[:space:]]*nosniff' "$headers"; then echo "ok    / sends X-Content-Type-Options: nosniff"; else echo "FAIL  / has no X-Content-Type-Options: nosniff"; failures=$((failures + 1)); fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base/api/today" 2>/dev/null || true)"
  if [ "$code" = 401 ]; then echo "ok    GET /api/today without a session -> 401"; else echo "FAIL  GET /api/today without a session -> ${code:-no response} (expected 401)"; failures=$((failures + 1)); fi
  rm -f "$headers"
  [ "$failures" -eq 0 ]
}

# Verifies that a compose project publishes nothing except 127.0.0.1:<expected_port> -> 3000 (and, when
# extra_ip is given -- production only -- also extra_ip:<expected_port> -> 3000) on its app service.
# Exposed-but-unpublished ports (for example "5432/tcp") are fine. Never accepts 0.0.0.0 or any other address.
fos_check_published_ports() {
  local project="$1" expected_port="$2" extra_ip="${3:-}" name ports entry bad=0
  local allowed_loopback="127.0.0.1:${expected_port}->3000/tcp"
  local allowed_extra=""
  [ -n "$extra_ip" ] && allowed_extra="${extra_ip}:${expected_port}->3000/tcp"
  while IFS='|' read -r name ports; do
    [ -n "$ports" ] || continue
    IFS=',' read -ra entries <<<"$ports"
    for entry in "${entries[@]}"; do
      entry="${entry# }"
      case "$entry" in
        *"->"*) ;;
        *) continue ;;
      esac
      if [[ "$name" == *-app-* ]] && { [ "$entry" = "$allowed_loopback" ] || { [ -n "$allowed_extra" ] && [ "$entry" = "$allowed_extra" ]; }; }; then
        echo "ok    $name publishes $entry"
      else
        echo "FAIL  $name publishes $entry (only ${allowed_loopback}${allowed_extra:+ and $allowed_extra} on the app is allowed)"
        bad=1
      fi
    done
  done < <(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}|{{.Ports}}')
  [ "$bad" = 0 ]
}

fos_dev_compose() {
  fos_export_compose_env
  [ -n "${FOS_IMAGE:-}" ] || fos_die "FOS_IMAGE is not set for the dev stack"
  docker compose --project-name "$FOS_DEV_PROJECT" --file "$FOS_COMPOSE_DIR/dev.compose.yml" "$@"
}

fos_e2e_compose() {
  fos_export_compose_env
  [ -n "${FOS_IMAGE:-}" ] || fos_die "FOS_IMAGE is not set for the e2e stack"
  [ -n "${FOS_E2E_DIR:-}" ] || fos_die "FOS_E2E_DIR is not set for the e2e stack"
  export FOS_E2E_DIR
  docker compose --project-name "$FOS_E2E_PROJECT" --file "$FOS_COMPOSE_DIR/e2e.compose.yml" "$@"
}

# Waits until every listed service of a compose invocation reports healthy. Arguments: timeout seconds,
# compose function name, services...
fos_wait_healthy() {
  local timeout="$1" fn="$2"
  shift 2
  local deadline=$((SECONDS + timeout)) svc cid state all_ok
  while :; do
    all_ok=1
    for svc in "$@"; do
      cid="$("$fn" ps -q "$svc" 2>/dev/null | head -n1)"
      if [ -z "$cid" ]; then
        all_ok=0
        continue
      fi
      state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
      case "$state" in
        running/healthy) ;;
        exited/* | dead/*)
          fos_warn "service $svc is $state"
          return 1
          ;;
        *) all_ok=0 ;;
      esac
    done
    [ "$all_ok" = 1 ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      fos_warn "timed out after ${timeout}s waiting for: $*"
      return 1
    fi
    sleep 2
  done
}

# Refuses to continue when available memory is below the threshold (GiB). Builds on this host share memory
# with GPU inference.
fos_check_memory() {
  local min_gib="$1" avail_kib
  avail_kib="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  if [ "$((avail_kib / 1024 / 1024))" -lt "$min_gib" ]; then
    return 1
  fi
  return 0
}

fos_append_release_log() {
  mkdir -p "$FOS_RUNTIME_DIR/notes"
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$FOS_RUNTIME_DIR/notes/releases.log"
}

# Writes a JSON document atomically with mode 0640 (readable by the app container via the secrets group).
fos_write_json_file() {
  local target="$1" content="$2" tmp
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "${target}.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$target"
}

# Serialises deploy, rollback, migrate, restore and start/stop on the production project.
fos_acquire_deploy_lock() {
  local wait_s="${1:-60}"
  if [ "${FOS_DEPLOY_LOCK_HELD:-}" = 1 ]; then
    return 0
  fi
  fos_require_cmd flock
  mkdir -p "$FOS_RUNTIME_DIR"
  exec 8>>"$FOS_RUNTIME_DIR/deploy.lock"
  if ! flock -w "$wait_s" 8; then
    fos_die "another FinancialOS operation holds $FOS_RUNTIME_DIR/deploy.lock"
  fi
  export FOS_DEPLOY_LOCK_HELD=1
}

FOS_PROD_SECRET_FILES=(
  db-superuser-password db-migrator-password db-app-password db-worker-password db-backup-password
  keyring.json session-pepper backup-key bootstrap-secret.sha256
)

# Checks the files the production stack mounts. Never prints secret contents.
fos_prod_preflight() {
  fos_require_runtime_dir
  local f path mode problems=0
  for f in "${FOS_PROD_SECRET_FILES[@]}"; do
    path="$FOS_RUNTIME_DIR/secrets/$f"
    if [ ! -s "$path" ]; then
      fos_warn "missing secret file: $path (run deploy/scripts/init-runtime.sh)"
      problems=1
      continue
    fi
    mode="$(stat -c %a "$path")"
    if [ "$((8#$mode & 8#007))" -ne 0 ]; then
      fos_warn "$path is accessible to other users (mode $mode)"
      problems=1
    fi
    if [ "$((8#$mode & 8#040))" -eq 0 ]; then
      fos_warn "$path is not group-readable (mode $mode); the containers cannot read it (run init-runtime.sh)"
      problems=1
    fi
  done
  path="$FOS_RUNTIME_DIR/config/app-config.json"
  if [ ! -s "$path" ]; then
    fos_warn "missing $path (run deploy/scripts/write-config.sh --origin ...)"
    problems=1
  elif ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$path" 2>/dev/null; then
    fos_warn "$path is not valid JSON"
    problems=1
  fi
  if [ ! -d "$FOS_RUNTIME_DIR/backups" ] || [ "$(stat -c %a "$FOS_RUNTIME_DIR/backups")" != 2770 ]; then
    fos_warn "$FOS_RUNTIME_DIR/backups must exist with mode 2770 (run init-runtime.sh)"
    problems=1
  fi
  [ "$problems" = 0 ] || fos_die "preflight failed"
}

fos_ensure_volume() {
  local name="$1"
  if ! docker volume inspect "$name" >/dev/null 2>&1; then
    docker volume create --label com.financialos.managed=true "$name" >/dev/null
    fos_log "created volume $name"
  fi
}

# True when a PostgreSQL data directory has been initialised in the named volume.
fos_pgdata_initialised() {
  local name="$1"
  docker volume inspect "$name" >/dev/null 2>&1 || return 1
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user 999:999 -v "$name:/v:ro" --entrypoint test "${FOS_POSTGRES_IMAGE:-postgres:17-bookworm}" -f /v/PG_VERSION
}

fos_write_release_status() {
  local image="$1" previous="$2" result="$3"
  fos_write_json_file "$FOS_RUNTIME_DIR/config/release.json" "$(
    python3 -c 'import json,sys,datetime
image, previous, result = sys.argv[1:4]
print(json.dumps({"schemaVersion": 1, "image": image, "previousImage": previous or None,
  "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "result": result}))' \
      "$image" "$previous" "$result"
  )"
}
