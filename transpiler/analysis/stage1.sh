#!/bin/bash
# stage1.sh: regenerate every Stage 1 inventory output under transpiler/out/.
# Prerequisite: bash tools/recorder-env/build-reference.sh (the analyzed tree).
set -euo pipefail
cd "$(dirname "$0")/../.."
node transpiler/frontend/compile-db.mjs
node --stack-size=16000 --max-old-space-size=5500 transpiler/analysis/run-inventory.mjs > transpiler/out/inventory/run.log
tail -1 transpiler/out/inventory/run.log
node --max-old-space-size=4000 transpiler/analysis/aggregate.mjs
node transpiler/analysis/macros.mjs > /dev/null
node --max-old-space-size=4000 transpiler/analysis/heap.mjs
node --max-old-space-size=4000 transpiler/analysis/union-pun.mjs
node transpiler/analysis/async.mjs | head -5
node transpiler/analysis/hotspots.mjs 0 | tail -1
