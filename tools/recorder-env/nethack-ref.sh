#!/bin/bash
# Run the reference recorder (build-reference.sh) with time() pinned.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env DYLD_INSERT_LIBRARIES="$HERE/build/realnow.dylib" \
    "$HERE/build/nethack-c/recorder/install/games/lib/nethackdir/nethack" "$@"
