#!/usr/bin/env bash
# Installs host-side schedules as systemd USER timers (no root needed; requires lingering for the user so they
# run without a login session). Only units named financialos-* are created, changed or removed.
#
# Usage:
#   deploy/scripts/install-timers.sh install [--unit-dir <dir>]
#   deploy/scripts/install-timers.sh remove  [--unit-dir <dir>]
#   deploy/scripts/install-timers.sh status
#   deploy/scripts/install-timers.sh render <dir>     write the unit files to <dir> only (for review)
#
# Timers:
#   financialos-disk-check       hourly   deploy/scripts/disk-check.sh --quiet (config/disk-status.json)
#   financialos-route-status     every 30 min  deploy/scripts/tailscale-route.sh status (config/route-status.json)
#   financialos-restore-verify   weekly (Sunday 04:30 local, randomised by up to 30 min)
#                                deploy/scripts/restore-verify.sh (config/restore-verify-status.json)
# Backups themselves are scheduled inside the worker (default daily; retention 14 daily + 8 weekly).
# The jobs run with Nice=15 and idle I/O priority. Default unit directory: ~/.config/systemd/user.
set -euo pipefail
FOS_SCRIPT_NAME=install-timers
# shellcheck source=deploy/scripts/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

mode="${1:-}"
[ $# -gt 0 ] && shift
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
render_dir=""
case "$mode" in
  render)
    render_dir="${1:?render needs a target directory}"
    shift
    ;;
  install | remove | status) ;;
  -h | --help | help) fos_usage_from_header "$0" 0 ;;
  *) fos_usage_from_header "$0" 2 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --unit-dir) unit_dir="${2:?}"; shift 2 ;;
    *) fos_die "unknown argument: $1 (see --help)" ;;
  esac
done

names=(financialos-disk-check financialos-route-status financialos-restore-verify)

service_unit() {
  local description="$1" command="$2" timeout="$3"
  cat <<EOF
[Unit]
Description=$description
Documentation=file://$FOS_REPO_ROOT/docs/OPERATIONS.md

[Service]
Type=oneshot
Environment=FOS_RUNTIME_DIR=$FOS_RUNTIME_DIR
Environment=FOS_APP_PORT=$FOS_APP_PORT
Environment=FOS_TS_HTTPS_PORT=$FOS_TS_HTTPS_PORT
ExecStart=$command
Nice=15
IOSchedulingClass=idle
TimeoutStartSec=$timeout
EOF
}

timer_unit() {
  local description="$1" schedule="$2" delay="$3"
  cat <<EOF
[Unit]
Description=$description

[Timer]
OnCalendar=$schedule
RandomizedDelaySec=$delay
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

render() {
  local dir="$1"
  mkdir -p "$dir"
  service_unit "FinancialOS disk space check" "$FOS_SCRIPTS_DIR/disk-check.sh --quiet" 120 >"$dir/financialos-disk-check.service"
  timer_unit "FinancialOS disk space check (hourly)" "hourly" "5min" >"$dir/financialos-disk-check.timer"
  service_unit "FinancialOS private route status" "$FOS_SCRIPTS_DIR/tailscale-route.sh status" 60 >"$dir/financialos-route-status.service"
  timer_unit "FinancialOS private route status (every 30 minutes)" "*:0/30" "2min" >"$dir/financialos-route-status.timer"
  service_unit "FinancialOS isolated restore verification" "$FOS_SCRIPTS_DIR/restore-verify.sh" 3600 >"$dir/financialos-restore-verify.service"
  timer_unit "FinancialOS isolated restore verification (weekly)" "Sun *-*-* 04:30:00" "30min" >"$dir/financialos-restore-verify.timer"
  chmod 0644 "$dir"/financialos-*.service "$dir"/financialos-*.timer
}

case "$mode" in
  render)
    render "$render_dir"
    ls -1 "$render_dir"/financialos-*
    ;;
  install)
    fos_require_cmd systemctl
    if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)" != yes ]; then
      fos_warn "lingering is not enabled for $(id -un): timers only run while the user is logged in"
    fi
    render "$unit_dir"
    systemctl --user daemon-reload
    for n in "${names[@]}"; do
      systemctl --user enable --now "$n.timer" >&2
      fos_log "enabled $n.timer"
    done
    systemctl --user list-timers 'financialos-*' --all --no-pager
    ;;
  remove)
    fos_require_cmd systemctl
    for n in "${names[@]}"; do
      systemctl --user disable --now "$n.timer" >/dev/null 2>&1 || true
      rm -f "$unit_dir/$n.timer" "$unit_dir/$n.service"
      fos_log "removed $n"
    done
    systemctl --user daemon-reload
    ;;
  status)
    fos_require_cmd systemctl
    systemctl --user list-timers 'financialos-*' --all --no-pager
    for n in "${names[@]}"; do
      systemctl --user --no-pager --lines=0 status "$n.service" 2>/dev/null | sed -n '1,3p' || true
    done
    ;;
esac
