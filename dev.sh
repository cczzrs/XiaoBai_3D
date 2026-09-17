#!/bin/zsh
set -eu
cd "${0:A:h}"
if command -v python3 >/dev/null 2>&1; then
  exec python3 scripts/serve.py "$@"
else
  exec /Users/cong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/serve.py "$@"
fi
