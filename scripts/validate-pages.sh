#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${root}/out"

[[ -d "${out}" ]] || { echo "Missing canonical Pages output directory: out/" >&2; exit 66; }
[[ -f "${out}/index.html" ]] || { echo "Missing canonical route artifact: out/index.html" >&2; exit 66; }
[[ -f "${out}/review/index.html" ]] || { echo "Missing review route artifact: out/review/index.html" >&2; exit 66; }
[[ -f "${out}/.nojekyll" ]] || { echo "Missing GitHub Pages marker: out/.nojekyll" >&2; exit 66; }

echo "Validated canonical GitHub Pages artifact: out/index.html and out/review/index.html are present."
