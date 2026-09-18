#!/usr/bin/env bash
# Records and compares the state of the shared host, to prove that FinancialOS did not disturb other workloads.
#
# Usage:
#   deploy/scripts/host-check.sh snapshot <name>   record $FOS_RUNTIME_DIR/baseline/<name>.txt
#   deploy/scripts/host-check.sh compare <a> <b>   compare two snapshots (names or file paths)
#   deploy/scripts/host-check.sh list              list recorded snapshots
#
# A snapshot records containers (name, image, state, health; no uptimes), published ports, Compose projects,
# networks, volumes, listening TCP sockets, running user services, user timers, and the Tailscale Serve config.
# Everything is read-only: this script never changes Docker, systemd, or Tailscale state.
#
# compare classifies every difference:
#   FAIL  a pre-existing, non-FinancialOS resource disappeared or changed state
#   WARN  a non-FinancialOS change that is not a disruption (new resources, ephemeral listener ports,
#         desktop-session services)
#   info  changes attributable to financialos* resources
# The exit status is 1 when any FAIL is reported, 0 otherwise.
#
# compare also accepts the older baseline format (pre-deploy-latest.txt) and normalises it.
#
# Environment: FOS_RUNTIME_DIR (default /srv/projects/financialos), FOS_TS_HTTPS_PORT (default 8443).
set -euo pipefail
FOS_SCRIPT_NAME=host-check
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

baseline_dir="$FOS_RUNTIME_DIR/baseline"

section() { printf '## %s\n' "$1"; }

take_snapshot() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || fos_die "snapshot name may only contain letters, digits, dot, dash, underscore"
  fos_require_cmd docker ss systemctl python3
  mkdir -p "$baseline_dir"
  chmod 0700 "$baseline_dir"
  local ts out tmp
  ts="$(fos_timestamp)"
  out="$baseline_dir/$name.txt"
  tmp="$(mktemp "$baseline_dir/.snapshot.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" EXIT
  {
    printf '# financialos-host-check v1\n'
    printf '# taken %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    section containers
    local ids
    ids="$(docker ps -aq)"
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      docker inspect --format '{{slice .Name 1}}|{{.Config.Image}}|{{.State.Status}}{{if eq .State.Status "exited"}}({{.State.ExitCode}}){{end}}|{{if and .State.Health (eq .State.Status "running")}}{{.State.Health.Status}}{{end}}' $ids | sort
    fi
    section published-ports
    docker ps -a --format '{{.Names}}|{{.Ports}}' | awk -F'|' '$2 != ""' | sort
    section compose
    docker compose ls -a --format json | python3 -c 'import json,sys
for p in sorted(json.load(sys.stdin) or [], key=lambda p: p["Name"]):
    print(p["Name"] + "|" + p["Status"])'
    section networks
    docker network ls --format '{{.Name}}|{{.Driver}}|internal={{.Internal}}' | sort
    section volumes
    docker volume ls --format '{{.Name}}' | sort
    section listeners
    ss -Htln | awk '{print $4}' | sort -u
    section user-services
    systemctl --user list-units --type=service --state=running --no-legend --plain | awk '{print $1}' | sort
    section timers
    systemctl --user list-units --type=timer --all --no-legend --plain | awk '{print $1 "|" $2 "|" $3}' | sort
    section tailscale-serve
    if command -v tailscale >/dev/null 2>&1; then
      tailscale serve status --json 2>/dev/null | python3 -c 'import json,sys
raw = sys.stdin.read().strip() or "{}"
print(json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":")))' || printf 'unavailable\n'
    else
      printf 'unavailable\n'
    fi
    section info
    printf 'mem_available_mib=%s\n' "$(($(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024))"
    printf 'root_disk_avail=%s\n' "$(df -Ph / | awk 'NR == 2 {print $4}')"
  } >"$tmp"
  chmod 0600 "$tmp"
  cp "$tmp" "$baseline_dir/$name-$ts.txt"
  mv -f "$tmp" "$out"
  fos_log "snapshot written: $out (history copy $baseline_dir/$name-$ts.txt)"
  printf '%s\n' "$out"
}

resolve_snapshot() {
  local ref="$1"
  if [ -f "$ref" ]; then
    printf '%s\n' "$ref"
  elif [ -f "$baseline_dir/$ref.txt" ]; then
    printf '%s\n' "$baseline_dir/$ref.txt"
  elif [ -f "$baseline_dir/$ref-latest.txt" ]; then
    printf '%s\n' "$baseline_dir/$ref-latest.txt"
  else
    fos_die "snapshot not found: $ref (looked in $baseline_dir)"
  fi
}

compare_snapshots() {
  local a b
  a="$(resolve_snapshot "$1")"
  b="$(resolve_snapshot "$2")"
  fos_log "comparing $a -> $b"
  FOS_TS_HTTPS_PORT="$FOS_TS_HTTPS_PORT" python3 - "$a" "$b" <<'PY'
import json
import os
import re
import sys

FOS_PORTS = {"3180", "3181", "3190", "55432"}
TS_PORT = os.environ.get("FOS_TS_HTTPS_PORT", "8443")
EPHEMERAL_MIN = 32768
DESKTOP_PREFIXES = (
    "org.gnome.", "org.freedesktop.", "xdg-", "gvfs-", "tracker-", "evolution-", "pipewire", "wireplumber",
    "filter-chain", "dconf", "dbus", "snap.", "gnome-", "gcr-", "gpg-agent", "at-spi", "ibus",
)


def load(path):
    text = open(path, encoding="utf-8").read().splitlines()
    legacy = not (text and text[0].startswith("# financialos-host-check v1"))
    sections, current = {}, None
    for line in text:
        if line.startswith("## "):
            current = line[3:].strip().replace(" ", "-")
            sections.setdefault(current, [])
        elif current is not None and line.strip() and not line.startswith("# "):
            sections[current].append(line.rstrip())
    return normalise(sections, legacy), legacy


def normalise(s, legacy):
    out = {}
    if legacy:
        containers, ports = {}, {}
        for line in s.get("containers", []):
            parts = line.split("|")
            name, image = parts[0], parts[1] if len(parts) > 1 else ""
            status = parts[2] if len(parts) > 2 else ""
            state = "running" if status.startswith("Up") else "exited"
            containers[name] = f"{image}|{state}"
            if len(parts) > 3 and parts[3]:
                ports[name] = parts[3]
        out["containers"] = containers
        out["published-ports"] = ports
        compose = {}
        for line in s.get("compose", []):
            fields = line.split()
            if len(fields) >= 2 and fields[0] != "NAME":
                compose[fields[0]] = fields[1]
        out["compose"] = compose
        out["networks"] = {n: "" for n in s.get("networks", [])}
        out["timers"] = {re.sub(r"\.(service|timer)$", "", t): "" for t in s.get("timers", [])}
    else:
        containers = {}
        for line in s.get("containers", []):
            name, image, state, health = (line.split("|") + ["", "", ""])[:4]
            containers[name] = f"{image}|{state}|{health}"
        out["containers"] = containers
        out["published-ports"] = dict(l.split("|", 1) for l in s.get("published-ports", []))
        out["compose"] = dict(l.split("|", 1) for l in s.get("compose", []))
        out["networks"] = {l.split("|", 1)[0]: l.split("|", 1)[1] for l in s.get("networks", [])}
        out["timers"] = {l.split("|", 1)[0]: l.split("|", 1)[1] for l in s.get("timers", [])}
    out["volumes"] = {v: "" for v in s.get("volumes", [])}
    out["listeners"] = {v: "" for v in s.get("listeners", [])}
    out["user-services"] = {v: "" for v in s.get("user-services", [])}
    serve = (s.get("tailscale-serve") or ["unavailable"])[0]
    out["tailscale-serve"] = serve
    return out


def is_fos_name(name):
    return name.startswith("financialos")


def listener_port(addr):
    return addr.rsplit(":", 1)[-1]


def fos_listener(addr):
    return listener_port(addr) in FOS_PORTS and (addr.startswith("127.0.0.1:") or addr.startswith("[::1]:"))


def ephemeral(addr):
    port = listener_port(addr)
    return port.isdigit() and int(port) >= EPHEMERAL_MIN


def desktop(unit):
    return unit.startswith(DESKTOP_PREFIXES)


findings = {"FAIL": [], "WARN": [], "info": []}


def add(level, msg):
    findings[level].append(msg)


def diff_keyed(section, a, b, attributable, soft_removed=lambda k: False, compare_values=True, value_view=None):
    view = value_view or (lambda v: v)
    for key in sorted(set(a) - set(b)):
        if attributable(key):
            add("info", f"{section}: financialos resource removed: {key}")
        elif soft_removed(key):
            add("WARN", f"{section}: removed (not a protected resource): {key}")
        else:
            add("FAIL", f"{section}: pre-existing resource disappeared: {key}")
    for key in sorted(set(b) - set(a)):
        if attributable(key):
            add("info", f"{section}: financialos resource added: {key}")
        else:
            add("WARN", f"{section}: new resource NOT attributable to FinancialOS: {key}")
    if compare_values:
        for key in sorted(set(a) & set(b)):
            if view(a[key]) != view(b[key]):
                level = "info" if attributable(key) else "FAIL"
                add(level, f"{section}: {key} changed: {view(a[key])!r} -> {view(b[key])!r}")


def serve_handlers(raw):
    if raw == "unavailable":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def fos_serve_part(key, value):
    text = json.dumps(value)
    return f":{TS_PORT}" in key or key == TS_PORT or "127.0.0.1:3180" in text


def main():
    (a, legacy_a), (b, legacy_b) = load(sys.argv[1]), load(sys.argv[2])
    legacy = legacy_a or legacy_b

    def container_view(v):
        parts = v.split("|")
        return "|".join(parts[:2]) if legacy else v

    a_containers, b_containers = dict(a["containers"]), dict(b["containers"])
    if legacy_a and not legacy_b:
        # The older format recorded running containers only.
        b_containers = {k: v for k, v in b_containers.items() if container_view(v).endswith("|running") or k in a_containers}
    b_ports, b_compose = dict(b["published-ports"]), dict(b["compose"])
    if legacy_a and not legacy_b:
        b_ports = {k: v for k, v in b_ports.items() if k in b_containers}
        b_compose = {k: v for k, v in b_compose.items() if not v.startswith("exited") or k in a["compose"]}
    diff_keyed("containers", a_containers, b_containers, is_fos_name, value_view=container_view)
    diff_keyed("published-ports", a["published-ports"], b_ports, is_fos_name)
    diff_keyed("compose", a["compose"], b_compose, is_fos_name)
    diff_keyed("networks", a["networks"], b["networks"], is_fos_name, compare_values=not legacy)
    diff_keyed("volumes", a["volumes"], b["volumes"], is_fos_name, compare_values=False)
    diff_keyed("listeners", a["listeners"], b["listeners"], fos_listener, soft_removed=ephemeral, compare_values=False)
    diff_keyed("user-services", a["user-services"], b["user-services"], is_fos_name, soft_removed=desktop, compare_values=False)
    ta, tb = a["timers"], b["timers"]
    if legacy:
        ta = {re.sub(r"\.(service|timer)$", "", k): "" for k in ta}
        tb = {re.sub(r"\.(service|timer)$", "", k): "" for k in tb}
    diff_keyed("timers", ta, tb, is_fos_name, compare_values=not legacy)

    sa, sb = serve_handlers(a["tailscale-serve"]), serve_handlers(b["tailscale-serve"])
    if sa is None or sb is None:
        add("WARN", "tailscale-serve: configuration unavailable in one snapshot; not compared")
    else:
        def flatten(cfg):
            flat = {}
            for top, value in (cfg or {}).items():
                if isinstance(value, dict):
                    for k, v in value.items():
                        flat[f"{top}/{k}"] = v
                else:
                    flat[top] = value
            return flat
        fa, fb = flatten(sa), flatten(sb)
        for key in sorted(set(fa) | set(fb)):
            va, vb = fa.get(key), fb.get(key)
            if va == vb:
                continue
            ours = fos_serve_part(key, va if va is not None else vb)
            if ours:
                add("info", f"tailscale-serve: financialos handler {key} {'added' if va is None else 'changed or removed'}")
            elif va is None:
                add("WARN", f"tailscale-serve: new entry NOT attributable to FinancialOS: {key}")
            else:
                add("FAIL", f"tailscale-serve: pre-existing entry changed or removed: {key}")

    for level in ("FAIL", "WARN", "info"):
        for msg in findings[level]:
            print(f"{level:4}  {msg}")
    print(f"summary: {len(findings['FAIL'])} fail, {len(findings['WARN'])} warn, {len(findings['info'])} financialos change(s)"
          + (" (legacy baseline format normalised)" if legacy else ""))
    sys.exit(1 if findings["FAIL"] else 0)


main()
PY
}

cmd="${1:-}"
case "$cmd" in
  snapshot)
    [ $# -eq 2 ] || fos_usage_from_header "$0" 2
    take_snapshot "$2"
    ;;
  compare)
    [ $# -eq 3 ] || fos_usage_from_header "$0" 2
    compare_snapshots "$2" "$3"
    ;;
  list)
    ls -1t "$baseline_dir" 2>/dev/null || true
    ;;
  -h | --help | help) fos_usage_from_header "$0" 0 ;;
  *) fos_usage_from_header "$0" 2 ;;
esac
