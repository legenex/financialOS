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
  --dir)
    # Build artifacts (dist/, release/) are git-ignored, and gitleaks skips ignored paths when the
    # target sits inside the work tree. Copy the artifact outside the repository so it is really
    # scanned before it is published.
    target="$(realpath "${2}")"
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/fos-artifact-scan.XXXXXX")"
    trap 'rm -rf "$scratch"' EXIT
    cp -r "$target" "$scratch/artifact"
    "$bin" dir --no-banner --redact --config "$cfg" "$scratch/artifact"
    ;;
  *) exec "$bin" dir --no-banner --redact --config "$cfg" "$root" ;;
esac
