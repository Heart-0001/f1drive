#!/bin/sh
# sh devtests/track-audit/perception/variants.sh <track> <plan> [variant ...]   (from the repo root)
# Runs the plan once per variant: base = the snapshot as is; fov / stab / all = patched/cockpit.js with a PERC_CFG;
# rec = all + patched/scenery.js with the debris fence along the banked stretches (SCN bankFence 8 deg).
# Then: TRACK=<id> ROWS=a,b COLS=base,rec npx electron devtests/track-audit/perception/compose.js (contact sheet).
P="js/cockpit.js=devtests/track-audit/perception/patched/cockpit.js"
PS="$P,js/scenery.js=devtests/track-audit/perception/patched/scenery.js"
REC='{"fovMin":58,"fovMax":62,"stabPitch":0.5,"stabRoll":0.4,"gHeave":0.03,"gNod":1.5,"gLong":0.8,"gShake":0.004}'
T=$1; PL=$2; shift 2
for v in "$@"; do
  unset SCN
  case $v in
    base) C='' ; PP='' ;;
    fov)  C='{"fovMin":58,"fovMax":62}' ; PP=$P ;;
    stab) C='{"stabPitch":0.5,"stabRoll":0.4}' ; PP=$P ;;
    all)  C='{"fovMin":58,"fovMax":62,"stabPitch":0.5,"stabRoll":0.4,"gHeave":0.03,"gNod":1.5,"gLong":0.8,"gShake":0.004}' ; PP=$P ;;
    fence) C=$REC ; PP=$PS ; export SCN='{"bankFence":8}' ;;
    rec)  C=$REC ; PP=$PS ; export SCN='{"bankFence":8}' ;;
    *) echo "unknown variant $v"; continue ;;
  esac
  rm -f devtests/track-audit/perception/out/$T-$v.jsonl
  echo "== $T $PL $v $C"
  node devtests/track-audit/perception/run.js $T $PL -$v "$PP" "$C"
done
