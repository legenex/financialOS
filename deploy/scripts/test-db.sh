#!/usr/bin/env bash
# Starts (or stops) the isolated test database used by integration tests.
#   deploy/scripts/test-db.sh up|down|url|reset
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
compose=(docker compose -f "$root/deploy/compose/test-db.compose.yml")
url="postgres://fos_test:fos_test_only_not_a_secret@127.0.0.1:55432/financialos_test"
case "${1:-up}" in
  up)
    "${compose[@]}" up -d --wait >/dev/null
    echo "$url"
    ;;
  down) "${compose[@]}" down -v ;;
  reset)
    "${compose[@]}" down -v >/dev/null
    "${compose[@]}" up -d --wait >/dev/null
    echo "$url"
    ;;
  url) echo "$url" ;;
  *) echo "usage: $0 up|down|url|reset" >&2; exit 2 ;;
esac
