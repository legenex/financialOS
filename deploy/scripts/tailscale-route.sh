#!/usr/bin/env bash
# Plans, inspects and verifies the private HTTPS route (Tailscale Serve) to the FinancialOS app. READ-ONLY:
# it never changes Tailscale configuration; it prints the exact command the owner runs.
#
# Usage:
#   deploy/scripts/tailscale-route.sh plan   [--https-port <port>]
#   deploy/scripts/tailscale-route.sh status [--https-port <port>]
#   deploy/scripts/tailscale-route.sh verify [--https-port <port>]
#
#   plan    reads `tailscale status --json` and `tailscale serve status --json`, checks that the HTTPS port
#           (default $FOS_TS_HTTPS_PORT = 8443) is unused by Serve and not listened on, backs up the current Serve
#           config to $FOS_RUNTIME_DIR/tailscale-backup/, and prints the additive activation command, its
#           prerequisite and its rollback command.
#   status  shows whether a Serve handler for the app (http://127.0.0.1:$FOS_APP_PORT) exists and whether
#           Funnel (public exposure) is enabled for it; a quick HTTPS health probe marks it active.
#   verify  requests the HTTPS origin from this host with full certificate validation (never -k): /healthz must
#           return 200 and the security headers must be present; also checks certificate expiry.
#
# Every mode writes $FOS_RUNTIME_DIR/config/route-status.json, which Settings -> System shows.
# Exit status: plan 0 when the plan is safe; status 0 when a handler exists; verify 0 when all checks pass.
set -euo pipefail
FOS_SCRIPT_NAME=tailscale-route
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

mode="${1:-}"
[ $# -gt 0 ] && shift
port="$FOS_TS_HTTPS_PORT"
while [ $# -gt 0 ]; do
  case "$1" in
    --https-port) port="${2:?}"; shift 2 ;;
    -h | --help) fos_usage_from_header "$0" 0 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done
case "$mode" in
  plan | status | verify) ;;
  -h | --help | help) fos_usage_from_header "$0" 0 ;;
  *) fos_usage_from_header "$0" 2 ;;
esac
[[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fos_die "invalid --https-port"
fos_require_cmd tailscale python3 curl ss

backend="http://127.0.0.1:$FOS_APP_PORT"
status_file="$FOS_RUNTIME_DIR/config/route-status.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! tailscale status --json >"$work/status.json" 2>"$work/status.err"; then
  fos_warn "tailscale status is unavailable: $(head -n1 "$work/status.err")"
  printf '{}' >"$work/status.json"
fi
if ! tailscale serve status --json >"$work/serve.json" 2>"$work/serve.err"; then
  fos_warn "tailscale serve status is unavailable: $(head -n1 "$work/serve.err")"
  printf 'null' >"$work/serve.json"
fi
[ -s "$work/serve.json" ] || printf '{}' >"$work/serve.json"
listeners="$(ss -Htln "( sport = :$port )" | awk '{print $4}' | paste -sd, -)"

# Analyse both documents once; the result is a small JSON object used by every mode.
analysis="$(
  python3 - "$work/status.json" "$work/serve.json" "$port" "$backend" "$FOS_APP_PORT" <<'PY'
import json, sys
status_path, serve_path, port, backend, app_port = sys.argv[1:6]
status = json.load(open(status_path)) or {}
serve_raw = json.load(open(serve_path))
serve_ok = serve_raw is not None
serve = serve_raw or {}
self_node = status.get("Self") or {}
dns = (self_node.get("DNSName") or "").rstrip(".")
cert_domains = status.get("CertDomains") or []

def configs(cfg):
    yield cfg
    for fg in (cfg.get("Foreground") or {}).values():
        yield fg or {}

used_ports, handlers, funnel = set(), [], []
for cfg in configs(serve):
    for p in (cfg.get("TCP") or {}):
        used_ports.add(str(p))
    for hostport, web in (cfg.get("Web") or {}).items():
        hp_port = hostport.rsplit(":", 1)[-1]
        used_ports.add(hp_port)
        for path, h in ((web or {}).get("Handlers") or {}).items():
            target = (h or {}).get("Proxy") or ""
            handlers.append({"hostPort": hostport, "path": path, "proxy": target})
    for hostport, enabled in (cfg.get("AllowFunnel") or {}).items():
        if enabled:
            funnel.append(hostport)
    for svc in (cfg.get("Services") or {}).values():
        for p in ((svc or {}).get("TCP") or {}):
            used_ports.add(str(p))

ours = [h for h in handlers if h["proxy"].rstrip("/") in (backend, f"http://localhost:{app_port}")]
print(json.dumps({
    "serveReadable": serve_ok,
    "backendState": status.get("BackendState"),
    "dnsName": dns,
    "certDomains": cert_domains,
    "httpsCertsEnabled": bool(cert_domains) and (dns in cert_domains or any(dns.endswith(d.lstrip("*")) for d in cert_domains)),
    "portInServe": port in used_ports,
    "usedPorts": sorted(used_ports),
    "handlers": handlers,
    "ourHandlers": ours,
    "funnelOnOurs": [f for f in funnel if any(f == h["hostPort"] for h in ours)],
    "funnelAny": funnel,
}))
PY
)"
field() { printf '%s' "$analysis" | python3 -c "import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; print(json.dumps(v) if isinstance(v,(list,dict)) else ('' if v is None else v))" "$1"; }

dns="$(field dnsName)"
origin=""
[ -n "$dns" ] && origin="https://$dns:$port"
[ "$port" = 443 ] && [ -n "$dns" ] && origin="https://$dns"
activate_cmd="sudo tailscale serve --bg --https=$port $backend"
rollback_cmd="sudo tailscale serve --https=$port off"

write_status() {
  local status="$1" handler="$2" cert="$3" healthz="$4" headers="$5" action="$6" detail="$7"
  [ -d "$FOS_RUNTIME_DIR/config" ] || return 0
  fos_write_json_file "$status_file" "$(
    python3 - "$status" "$handler" "$cert" "$healthz" "$headers" "$action" "$detail" "$origin" "$port" "$backend" <<'PY'
import datetime, json, sys
status, handler, cert, healthz, headers, action, detail, origin, port, backend = sys.argv[1:11]
def tri(v):
    return None if v == "" else v == "true"
print(json.dumps({
    "schemaVersion": 1,
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "mode": "tailscale-serve",
    "httpsPort": int(port),
    "canonicalOrigin": origin or None,
    "handlerPresent": handler == "true",
    "backend": backend,
    "certificateValid": tri(cert),
    "healthz": int(healthz) if healthz.isdigit() else None,
    "headersOk": tri(headers),
    "status": status,
    "ownerAction": action or None,
    "detail": detail,
}))
PY
  )"
}

owner_action_text="Enable HTTPS certificates for the tailnet (admin console, DNS page), then run on the host: $activate_cmd ; rollback: $rollback_cmd"

case "$mode" in
  plan)
    mkdir -p "$FOS_RUNTIME_DIR/tailscale-backup"
    chmod 0700 "$FOS_RUNTIME_DIR/tailscale-backup"
    backup="$FOS_RUNTIME_DIR/tailscale-backup/serve-$(fos_timestamp).json"
    (umask 077 && cp "$work/serve.json" "$backup")
    fos_log "current Serve configuration backed up to $backup"
    problems=0
    echo "Tailscale backend state: $(field backendState)"
    echo "Node DNS name:           ${dns:-<unknown>}"
    if [ "$(field serveReadable)" != True ]; then
      echo "BLOCKER  cannot read the Serve configuration"
      problems=1
    fi
    if [ "$(field backendState)" != Running ] || [ -z "$dns" ]; then
      echo "BLOCKER  Tailscale is not running or MagicDNS has no name for this node"
      problems=1
    fi
    if [ "$(field portInServe)" = True ]; then
      echo "BLOCKER  HTTPS port $port is already used in the Serve configuration: choose another --https-port"
      problems=1
    else
      echo "ok       port $port is not used by Serve (used: $(field usedPorts))"
    fi
    if [ -n "$listeners" ]; then
      echo "BLOCKER  something already listens on port $port ($listeners): choose another --https-port"
      problems=1
    else
      echo "ok       nothing listens on port $port"
    fi
    if [ "$(field ourHandlers)" != "[]" ]; then
      echo "note     a FinancialOS handler already exists: $(field ourHandlers)"
    fi
    if [ "$(field funnelAny)" != "[]" ]; then
      echo "note     Funnel is enabled for other entries ($(field funnelAny)); FinancialOS must never use Funnel"
    fi
    if [ "$(field httpsCertsEnabled)" = True ]; then
      echo "ok       HTTPS certificates are enabled for this node"
      cert_note="already enabled"
    else
      echo "OWNER    HTTPS certificates are not enabled for the tailnet (CertDomains is empty)"
      cert_note="REQUIRED: in the Tailscale admin console, open DNS and enable HTTPS Certificates (MagicDNS must be on)"
    fi
    if curl -fsS -o /dev/null --max-time 3 "$backend/healthz" 2>/dev/null; then
      echo "ok       the app answers on $backend"
    else
      echo "note     the app does not answer on $backend yet (deploy it before activating the route)"
    fi
    cat <<EOF

Owner activation (additive; does not touch existing Serve entries; tailnet-only, no Funnel):
  1. Prerequisite: $cert_note
  2. On the host, run:
       $activate_cmd
  3. Tell FinancialOS its origin, then restart the app:
       deploy/scripts/write-config.sh --force --origin $origin --extra-origin http://localhost:$FOS_APP_PORT
       deploy/scripts/start.sh --restart app
  4. Verify from the host:
       deploy/scripts/tailscale-route.sh verify --https-port $port
Rollback (removes only this entry):
       $rollback_cmd
Serve config backup: $backup
EOF
    if [ "$(field ourHandlers)" != "[]" ]; then
      write_status configured true "" "" "" "" "handler exists; run verify"
    else
      write_status owner_action_required false "" "" "" "$owner_action_text" "route not active yet"
    fi
    [ "$problems" = 0 ]
    ;;

  status)
    handlers="$(field ourHandlers)"
    if [ "$(field funnelOnOurs)" != "[]" ]; then
      echo "ERROR    Funnel (public internet exposure) is enabled for the FinancialOS handler: $(field funnelOnOurs)"
      echo "         disable it with: sudo tailscale funnel --https=$port off"
      write_status error true "" "" "" "Disable Funnel for the FinancialOS route" "funnel enabled"
      exit 1
    fi
    if [ "$handlers" = "[]" ]; then
      echo "no FinancialOS Serve handler (expected a proxy to $backend)"
      echo "run: deploy/scripts/tailscale-route.sh plan"
      write_status owner_action_required false "" "" "" "$owner_action_text" "no handler for $backend"
      exit 1
    fi
    echo "FinancialOS handler(s): $handlers"
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$origin/healthz" 2>/dev/null || true)"
    if [ "$code" = 200 ]; then
      echo "HTTPS probe $origin/healthz -> 200"
      write_status active true true "$code" "" "" "handler present and healthy"
    else
      echo "HTTPS probe $origin/healthz -> ${code:-no response}"
      write_status error true "" "${code:-}" "" "Check HTTPS certificates and the app" "handler present but the HTTPS probe failed"
    fi
    ;;

  verify)
    [ -n "$origin" ] || fos_die "cannot determine the node's DNS name"
    failures=0
    cert_ok=false
    if curl -sS -o /dev/null --max-time 10 "$origin/healthz" 2>"$work/tls.err"; then
      cert_ok=true
      echo "ok    TLS certificate for $dns is valid (verified by curl, no -k)"
    else
      echo "FAIL  TLS/HTTPS request failed: $(head -n1 "$work/tls.err")"
      failures=$((failures + 1))
    fi
    if command -v openssl >/dev/null 2>&1; then
      enddate="$(openssl s_client -connect "$dns:$port" -servername "$dns" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
      if [ -n "$enddate" ]; then
        days=$(( ($(date -d "$enddate" +%s) - $(date +%s)) / 86400 ))
        if [ "$days" -lt 7 ]; then echo "WARN  certificate expires in $days day(s) ($enddate)"; else echo "ok    certificate valid for $days more day(s)"; fi
      fi
    fi
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$origin/healthz" 2>/dev/null || true)"
    headers_ok=false
    if [ "$cert_ok" = true ] && fos_smoke_check "$origin" >"$work/smoke.txt"; then
      headers_ok=true
    else
      failures=$((failures + 1))
    fi
    cat "$work/smoke.txt" 2>/dev/null || true
    hsts="$(curl -sS -D - -o /dev/null --max-time 10 "$origin/" 2>/dev/null | grep -i '^strict-transport-security:' || true)"
    if [ -n "$hsts" ]; then echo "ok    Strict-Transport-Security present"; else echo "WARN  no Strict-Transport-Security header on the HTTPS origin"; fi
    if [ "$(field funnelOnOurs)" != "[]" ]; then
      echo "FAIL  Funnel is enabled for the FinancialOS route (public exposure)"
      failures=$((failures + 1))
    fi
    if [ "$failures" -eq 0 ]; then
      write_status active true "$cert_ok" "$code" "$headers_ok" "" "verified from the host"
      echo "route verified: $origin"
    else
      write_status error "$([ "$(field ourHandlers)" != "[]" ] && echo true || echo false)" "$cert_ok" "${code:-}" "$headers_ok" \
        "$owner_action_text" "verification failed ($failures check(s))"
      exit 1
    fi
    ;;
esac
