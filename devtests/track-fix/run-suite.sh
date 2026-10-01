#!/bin/sh
# Runs the track-related test battery; logs go to devtests/track-fix/<outdir>/.
# usage: sh devtests/track-fix/run-suite.sh <outdir>
cd "$(dirname "$0")/../.."
OUT=devtests/track-fix/${1:-after}
mkdir -p "$OUT"
run() { name=$1; shift; start=$(date +%s); "$@" > "$OUT/$name.log" 2>&1; rc=$?; echo "$name rc=$rc $(( $(date +%s) - start ))s" | tee -a "$OUT/summary.txt"; }
: > "$OUT/summary.txt"
run track-test node devtests/track-test/test.js
run 3d-build node devtests/3d-test/build.js
run raceline-build node devtests/raceline-test/test.js build
run raceline-drive node devtests/raceline-test/test.js drive
run laps-drive node devtests/laps-test/drive.js
run laps-grid node devtests/laps-test/grid.js
run pit-check node devtests/pit-test/check.js
run pit-drive node devtests/pit-test/drive.js
run car-test node test/car.test.js
run laps-test node test/laps.test.js
echo done >> "$OUT/summary.txt"
