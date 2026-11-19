# Third-party C sources transpiled into the port

## `darwin-libc/`: Darwin's POSIX regex (TRE) and the C-locale parts it uses

Unmodified files from Apple's Libc, tag **Libc-1752.120.2**
(<https://github.com/apple-oss-distributions/Libc>), license `APPLE_LICENSE` (APSL 2.0) and
the BSD notices in the files (`regex/FreeBSD/COPYRIGHT`).

| Path | Why |
|---|---|
| `regex/TRE/lib/*.c`, `*.h`, `regex/TRE/config.h`, `tre-config.h` | Libc's `regcomp`/`regexec`/`regfree` (TRE 0.8.0 as Apple ships it) |
| `regex/FreeBSD/regerror.c`, `utils.h`, `cname.h` | Libc's `regerror` |
| `locale/FreeBSD/{runetype,tolower,toupper,table,none,mbrtowc,wctype,wcsrtombs}.c`, `mblocal.h` | The C locale's rune table (`table.c`: `_DefaultRuneLocale`, `_DefaultRuneXLocale`) and the multibyte/ctype entry points TRE calls |
| `include/_regex.h` | Libc-1752's error codes (`REG_BADMAX` = 18), which the installed system returns |

**Why 1752 and not 1669.** The reference machine runs macOS 15.8.1 (24H32), whose Libc
tag would be 1669.x; but its `regcomp` returns error 18 ("maximum repetition exceeds 255")
for `{256}`, which only Libc-1752 has (a backported fix). With 1669.60.4 sources, 12 of
30,292 differential cases differed; with 1752.120.2, none do. Built below macOS 26.4, so
`_regex.h`'s 26.4-only internal flag aliases are not used (they matter only to callers
that pass `REG_DUMP` or `REG_LARGE`; NetHack passes `REG_EXTENDED | REG_NOSUB`).

**Build flags** (Libc's own for TRE: `-DHAVE_CONFIG_H -I regex/TRE -I regex/FreeBSD`), plus
`-D__LIBC__` (Libc builds define it; without it TRE calls `duplocale`) and
`-D_DONT_USE_CTYPE_INLINE_` (every ctype/wctype call becomes a call to the shim's definition
instead of the SDK's `gnu_inline` wrappers, which at -O0 resolve to the system library).

## `darwin-c-locale/`: the C-locale shim (written for this project)

`xlocale_private.h` and `c_locale.c` replace Libc's private locale machinery (threads,
locks, locale loading) for the one locale the recorder runs in: NetHack never calls
`setlocale` or `uselocale`, so every locale argument is the C locale. Each definition in
`c_locale.c` is copied from the named Libc-1752.120.2 source; where Libc's function serves all
locales, only its C-locale branch is kept. One documented quirk: Libc links TRE's
three-argument `__collate_range_cmp(wchar_t, wchar_t, locale_t)` calls to `collcmp.c`'s
two-argument `char` function, and the shim reproduces that call's effect.

## Checks

- `build-native.sh OUT` compiles all of it natively (entry points renamed `x_*`).
- `tests/c-diff/regex/`: the same cases through the system's regex and through this build
  (and through the transpiled JS once it exists); must agree on every compile result,
  `regerror` text, match result and submatch offsets.
