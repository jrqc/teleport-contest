#!/bin/bash
# Run the reference recorder (build-reference.sh) with time() pinned and, when
# record-session.mjs asks for it (RERECORD_CANON_HOME=1), the recording machine's HOME.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env DYLD_INSERT_LIBRARIES="$HERE/build/realnow.dylib:$HERE/build/homemap.dylib" \
    "$HERE/build/nethack-c/recorder/install/games/lib/nethackdir/nethack" "$@"
