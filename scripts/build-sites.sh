#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${script_dir}/.." && pwd)"

if [[ ! -f "${root}/.openai/hosting.json" ]]; then
  echo "Experimental Sites build requires .openai/hosting.json; canonical production frontend uses npm run build." >&2
  exit 66
fi

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec bash "${script_dir}/sites-env.sh" -- bash "$0" "$@"
fi

command -v timeout >/dev/null || { echo "build:sites requires GNU timeout." >&2; exit 69; }
vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
[[ -x "${vinext}" ]] || { echo "vinext is unavailable. Run npm ci first." >&2; exit 69; }

echo "Running experimental Vinext/Sites build..."
timeout --signal=TERM --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" "${SITES_BUILD_TIMEOUT:-3m}" "${vinext}" build
npm run validate:sites
