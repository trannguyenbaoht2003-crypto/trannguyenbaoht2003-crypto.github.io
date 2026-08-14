#!/bin/sh
set -eu

node scripts/collect-community-candidates.mjs
node backend/dist/src/community-import-cli.js \
  --inbox data/community-inbox.json \
  --report community-watch-report.json
