#!/bin/bash
# build-native.sh: compile the vendored Darwin regex (TRE) + C-locale shim natively,
# with the four regex entry points renamed x_*, into OUT/libtre-native.a; used by
# tests/c-diff/regex to compare against the system's regcomp/regexec (postmortem F2).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build-native.sh OUTDIR}"
mkdir -p "$OUT"
T="$HERE/darwin-libc"
FILES="regex/TRE/lib/regcomp.c regex/TRE/lib/regexec.c regex/TRE/lib/tre-ast.c regex/TRE/lib/tre-compile.c
regex/TRE/lib/tre-match-backtrack.c regex/TRE/lib/tre-match-parallel.c regex/TRE/lib/tre-mem.c regex/TRE/lib/tre-parse.c
regex/TRE/lib/tre-stack.c regex/FreeBSD/regerror.c locale/FreeBSD/runetype.c locale/FreeBSD/tolower.c
locale/FreeBSD/toupper.c locale/FreeBSD/table.c locale/FreeBSD/none.c locale/FreeBSD/mbrtowc.c
locale/FreeBSD/wctype.c locale/FreeBSD/wcsrtombs.c string/FreeBSD/wcslen.c string/FreeBSD/wcsncmp.c string/FreeBSD/wcsncpy.c string/FreeBSD/wmemcmp.c"
OBJS=()
for f in $FILES "$HERE/darwin-c-locale/c_locale.c"; do
    src="$f"; [ -f "$src" ] || src="$T/$f"
    o="$OUT/$(basename "$src" .c).o"
    clang -arch arm64 -c -O0 -g -D__LIBC__ -D_DONT_USE_CTYPE_INLINE_ -DREG_BADMAX=18 -DHAVE_CONFIG_H -I"$HERE/darwin-c-locale" -I"$T/regex/TRE" -I"$T/regex/TRE/lib" \
        -I"$T/regex/FreeBSD" -I"$T/locale/FreeBSD" \
        -Dregcomp=x_regcomp -Dregexec=x_regexec -Dregfree=x_regfree -Dregerror=x_regerror "$src" -o "$o"
    OBJS+=("$o")
done
rm -f "$OUT/libtre-native.a"; ar rcs "$OUT/libtre-native.a" "${OBJS[@]}"
echo "[ok] $OUT/libtre-native.a"
