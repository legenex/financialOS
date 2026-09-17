#!/usr/bin/env bash
# Serialises dependency changes and heavy builds across parallel agents.
#   scripts/dev/with-lock.sh npm install -w packages/domain decimal.js@10.6.0
# Waits for the shared project lock, then checks available memory before running.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
lock="${FOS_DEV_LOCK:-/tmp/financialos-dev.lock}"
min_avail_gib="${FOS_MIN_AVAILABLE_GIB:-12}"
exec 9>"$lock"
flock 9
for _ in $(seq 1 60); do
  avail_kib="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  if [ "$((avail_kib / 1024 / 1024))" -ge "$min_avail_gib" ]; then
    break
  fi
  echo "with-lock: host memory is busy (< ${min_avail_gib} GiB available); waiting" >&2
  sleep 10
done
cd "$root"
nice -n 10 "$@"
