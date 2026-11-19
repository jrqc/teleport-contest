#!/bin/bash
# build-reference.sh: build the *reference* recorder that re-records all 44
# public sessions byte-identically (verified 2026-11-18). It differs from a
# plain `bash nethack-c/build-recorder.sh` in exactly these ways:
#
#  1. Patch 006 is taken from commit 52960eb (before 6ee30e6). The 6ee30e6
#     version adds nomux_reset_raw_mode() at exit, which moves the final
#     cursor after save/quit (seed0013 fails). It also enlarges the capture
#     buffer (24*256 bytes overflowed on colorful Gehennom maps); that one fix
#     is applied on top of 52960eb (postmortem F1: no public screen comes
#     close to either size, so public sessions are unaffected).
#     PATCH006=head builds with 6ee30e6's patch 006 unchanged instead (test
#     T10), and BUILD_DIR=<dir> builds elsewhere so both can coexist.
#  2. A sysconf is installed (minimal hints install none, but SYSCF is on and
#     the game refuses to start without it): upstream sys/unix/sysconf with
#     WIZARDS=* and the GDBPATH/GREPPATH/PANICTRACE_* lines removed (those
#     paths do not exist on macOS and the errors show on the first screen).
#  3. realnow.dylib pins time() to a US-daylight-time instant (see realnow.c).
#
# nethack-c/ is left untouched; everything is built under build/ here.
# Output: tools/recorder-env/build/nethack-c/recorder/install/games/lib/nethackdir
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
B="${BUILD_DIR:-$HERE/build}"
PATCH006="${PATCH006:-ref}"     # ref: 52960eb + HEAD's capture buffer; head: 6ee30e6 as is
PATCH006_COMMIT=52960eb

rm -rf "$B"
mkdir -p "$B/nethack-c"
cp "$ROOT/nethack-c/build-recorder.sh" "$ROOT/nethack-c/macosx-minimal" "$B/nethack-c/"
cp -R "$ROOT/nethack-c/patches" "$B/nethack-c/"
if [ "$PATCH006" = ref ]; then
    git -C "$ROOT" show "$PATCH006_COMMIT:nethack-c/patches/006-nomux-capture.patch" \
        > "$B/nethack-c/patches/006-nomux-capture.patch"
    # 6ee30e6's buffer size (a one-line change inside the patch's added code)
    OLD='+static char nomux_out[24 * 256];'
    NEW='+static char nomux_out[(24 * 80 * 32) + (24 * 16) + 1];'
    grep -qxF "$OLD" "$B/nethack-c/patches/006-nomux-capture.patch" \
        || { echo "[FAIL] capture buffer line not found in patch 006" >&2; exit 1; }
    python3 -c 'import sys; p=sys.argv[1]; s=open(p).read(); open(p,"w").write(s.replace(sys.argv[2]+"\n", sys.argv[3]+"\n", 1))' \
        "$B/nethack-c/patches/006-nomux-capture.patch" "$OLD" "$NEW"
elif [ "$PATCH006" != head ]; then
    echo "[FAIL] PATCH006 must be ref or head" >&2; exit 1
fi
ln -s "$ROOT/nethack-c/upstream" "$B/nethack-c/upstream"
bash "$B/nethack-c/build-recorder.sh" > "$B/build.log" 2>&1 \
    || { echo "[FAIL] recorder build, see $B/build.log" >&2; exit 1; }

INST="$B/nethack-c/recorder/install/games/lib/nethackdir"
sed -e 's/^WIZARDS=.*/WIZARDS=*/' -e '/^GDBPATH=/d' -e '/^GREPPATH=/d' \
    -e '/^PANICTRACE_/d' "$B/nethack-c/recorder/sys/unix/sysconf" > "$INST/sysconf"
chmod 0600 "$INST/sysconf"

clang -dynamiclib -O2 -o "$B/realnow.dylib" "$HERE/realnow.c"

# nh_getenv() ignores values longer than BUFSZ/2 = 128 chars (options.c).
if [ "${#INST}" -gt 128 ]; then
    echo "[FAIL] install path is ${#INST} chars (> 128): NETHACKDIR would be ignored" >&2
    exit 1
fi
echo "[ok] reference recorder: $INST"
