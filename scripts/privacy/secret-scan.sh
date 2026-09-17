#!/usr/bin/env bash
# Credential scan using gitleaks (project-scoped binary in .tools/, or gitleaks on PATH).
#   secret-scan.sh --staged        staged changes
#   secret-scan.sh --range A..B    commits being pushed
#   secret-scan.sh --dir <path>    build artifacts or an extracted package
#   secret-scan.sh                 working tree
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
bin="$root/.tools/gitleaks"
if [ ! -x "$bin" ]; then
  bin="$(command -v gitleaks || true)"
fi
if [ -z "$bin" ]; then
  echo "secret-scan: gitleaks not found. Run scripts/dev/install-tools.sh" >&2
  exit 2
fi
cfg="$root/scripts/privacy/gitleaks.toml"
case "${1:-}" in
  --staged) exec "$bin" git --staged --no-banner --redact --config "$cfg" "$root" ;;
  --range) exec "$bin" git --no-banner --redact --config "$cfg" --log-opts="${2}" "$root" ;;
  --dir) exec "$bin" dir --no-banner --redact --config "$cfg" "${2}" ;;
  *) exec "$bin" dir --no-banner --redact --config "$cfg" "$root" ;;
esac
