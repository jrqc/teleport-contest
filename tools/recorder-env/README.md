# Reference recorder environment

`bash tools/recorder-env/build-reference.sh` builds a NetHack 5.0 recorder that
re-records **all 44 public sessions byte-identically**:

    node tools/recorder-env/verify-rerecord.mjs        # → 44/44 pass
    node tools/recorder-env/record-session.mjs in.session.json out.session.json

Nothing under `nethack-c/` or `scripts/` is modified; the differences from the
contest-provided path live here.

| Problem with the contest-provided path | Symptom | Fix here |
|---|---|---|
| Minimal hints install no `sysconf`, but SYSCF is compiled in | `Unable to open SYSCF_FILE.`, game exits, 0 steps | Install upstream `sys/unix/sysconf` with `WIZARDS=*`, minus `GDBPATH`/`GREPPATH`/`PANICTRACE_*` (paths absent on macOS; errors shown on screen 0) |
| Patch 001 `time_from_yyyymmddhhmmss()` copies the real clock's `struct tm` (incl. `tm_isdst`) before `mktime()` | Pinned time shifts ±1 h depending on when you record ("It was nighttime.") | `realnow.dylib` pins `time()` to 2026-05-02 12:00 UTC (US daylight time), like the official spring-2026 recordings |
| Patch 006 at HEAD (6ee30e6) resets the raw-output row at exit | Final cursor after save/quit differs (seed0013) | Use patch 006 from 52960eb |
| `record-session.mjs` resolves on process close while the last marker is still queued | Last step dropped at random | Wait for the marker chain |
| Killed segments leave lock/level files (`501wizard.0`, ...) | Next segment: "Destroy old game?" | Delete `*.N` lock/level files after a kill (saves, bones, record kept) |
| `nh_getenv()` ignores values > 128 chars | `NETHACKDIR` silently ignored for deep paths | Build checks the install path length |

Recording environment otherwise as the contest scripts set it: `TZ=America/New_York`,
`TERM=xterm-256color`, `SOURCE_DATE_EPOCH=1777723200`.

## Architecture

On an Apple Silicon Mac the reference recorder builds as an **arm64** binary, even when the
calling shell runs x86_64 under Rosetta (check with `file build/nethack-c/recorder/install/games/lib/nethackdir/nethack`).
The 44/44 result was obtained with that arm64 binary, so arm64 is the reference ABI
(method/design.md 3.1). An x86_64 build differs only where C is undefined (it traps on
integer division by zero, for example).

