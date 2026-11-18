# Stage 1 findings

Date: 2026-11-18. Everything here was measured with the scripts in `transpiler/analysis/`
(regenerate all numbers with `transpiler/analysis/stage1.sh`) and the reference recorder in
`tools/recorder-env/`. Machine: macOS 15.8.1 (24H32), Apple M2, Apple clang 17.0.0, 8 GB RAM. **The reference recorder
is an arm64 binary** (the analysis shell runs x86_64 Node under Rosetta, but clang builds arm64).

## 1. Reference recorder (steps 1.1–1.2)

**Result: 44/44 public sessions re-record byte-identical** (two consecutive full runs), with
`bash tools/recorder-env/build-reference.sh` + `node tools/recorder-env/verify-rerecord.mjs`.

The contest-provided path (`nethack-c/build-recorder.sh` + `scripts/verify-rerecord.mjs`)
does not reproduce the sessions. Six problems, each found from a concrete failure:

| # | Problem | Symptom | Fix (in `tools/recorder-env/`) |
|---|---|---|---|
| 1 | Minimal hints install no `sysconf`, but SYSCF is compiled in | `Unable to open SYSCF_FILE.`, 0 steps for all sessions | Install upstream `sys/unix/sysconf`, `WIZARDS=*`, minus `GDBPATH`/`GREPPATH`/`PANICTRACE_*` (paths missing on macOS; their errors appear on screen 0) |
| 2 | Patch 001 `time_from_yyyymmddhhmmss()` (`src/calendar.c:126`) copies the real clock's `struct tm`, incl. `tm_isdst`, then `mktime()` | Pinned time shifted +1 h when recording in November: "It was nighttime." (seed0009), seed0002/0012/0030 | `realnow.dylib` interposes `time()` → 2026-05-02 12:00 UTC (US daylight time) |
| 3 | Patch 006 at HEAD (6ee30e6) adds `nomux_reset_raw_mode()` at exit | Final cursor row after save/quit differs (seed0013, both segments) | Patch 006 from 52960eb |
| 4 | `record-session.mjs` resolves on process close while the last marker is still in its async queue | Last step dropped at random (seen on seed0009, seed0030) | Wait for the marker chain |
| 5 | A segment that ends while the game waits for a key is killed with SIGTERM, leaving `501wizard.0`, `alock.N` | Next segment prompts "There is already a game in progress… Destroy old game?" (seed5002, seed5006) | Delete `*.N` lock/level files after a kill; keep saves, bones, record |
| 6 | `nh_getenv()` ignores values longer than `BUFSZ/2` = 128 chars (`src/options.c:6852`) | `NETHACKDIR` silently ignored for deep install paths | Build checks the path length |

Build facts (`transpiler/out/build-flags.txt`): NetHack compiles with
`-g -I../include -DNOTPARMDECL -DNO_TIMED_DELAY` (no optimization), tty window port only;
Lua 5.4.8 with `-O2 -Wall -Wextra -DLUA_COMPAT_5_3 -DLUA_USE_MACOSX`;
`SOURCE_DATE_EPOCH=1777723200`. The longest public session (seed4500, 1,814 steps, 108,275
RNG calls) takes **1.25 s** in C including the harness.

Recording-environment constants (`docs/recording-environment.md`, issues #16/#17; davidbau
on #16: "Hard-coding it is a legitimate way to match the screens"): `HOME=/Users/davidbau/git/mazesofmenace/teleport/maud/test/comparison/c-harness/results`,
`TERM=xterm-256color`, `TZ=America/New_York`, Darwin libc. Not in that document: the
`tm_isdst` leak (#2) and the missing `sysconf` (#1).

## 2. What gets analyzed (steps 1.3–1.4)

172 translation units from the recorder's own make rules (`transpiler/out/compile_commands.json`):
140 NetHack, 32 Lua. All parse with clang's JSON AST dump, in 36 s total (largest dump
133 MB for `trap.c`; processed in memory, never written to disk).

| Part | Files | Lines |
|---|---|---|
| `src/*.c` (game core) | 130 | 250,645 |
| `include/*.h` | 90 | 31,071 |
| `win/tty/*.c` | 4 | 8,445 |
| `sys/unix` + `sys/share` (linked only) | 6 | 2,416 |
| Lua 5.4.8 `*.c` (liblua.a) | 32 | 23,274 |
| Lua 5.4.8 `*.h` | 27 | 5,436 |
| `dat/*.lua` (level/dungeon scripts, data) | 131 | 17,223 |

| Metric | NetHack | Lua |
|---|---|---|
| Function definitions | 5,533 | 1,059 |
| `static` functions | 2,102 | 721 |
| Variadic functions | 23 | 5 |
| Functions with `goto` / gotos | 172 / 536 | 8 / 117 (+78 computed gotos, `lvm.c` jump table) |
| Static locals (in functions) | 525 (349) | 20 (15) |
| `switch` statements | 677 | 89 |
| Direct / indirect call sites | 60,728 / 1,671 | 4,516 / 17 |
| Global variable definitions | 827 | 32 |
| `setjmp`/`longjmp` sites | 2 (`nhlua.c` Lua step-limit sandbox) | 2 (`ldo.c` error handling) |

Records: 404 structs, 23 unions (project-wide, incl. Lua); 241 bit-fields in 27 records;
146 function-pointer fields; 1,127 functions whose address is taken. No function returns a
struct by value. Macros: 6,060 `#define`s; about 190 NetHack macros expand to statements
(45 `do { } while (0)`). The transpiler works on the expanded AST, so macros matter only for
output readability and churn.

libc: 190 distinct functions (130 used by NetHack). macOS compiles string/format calls into
fortified builtins, so the largest are `sprintf` → `__builtin___sprintf_chk` (1,341 sites),
`strcpy` → `__builtin___strcpy_chk` (883), `strcat` → `__builtin___strcat_chk` (555),
`memset_chk` (113), plus `free` 491, `strlen` 442, `strchr` 313, `strcmp` 234, `strncmp` 142.
The `_chk` variants behave like the plain functions unless a buffer would overflow (then they
abort). Other groups: stdio files (`fopen`/`fgets`/`fclose`), `sscanf`, ctype, time (`time`,
`localtime`, `mktime`), termcap (`tgetstr`, `tgoto`, `tputs`), and process/system calls only
on paths outside normal play (`fork`, `exec*`, `signal`, `getuid`).
Full table: `transpiler/out/inventory/summary.md`.

Runtime data files (install dir): 131 `*.lua` scripts (~0.9 MB) and text data (~0.9 MB:
`data` 287 KB, `tribute` 384 KB, `rumors`, `oracles`, `engrave`, `epitaph`, `bogusmon`,
`options` from `makedefs`; help files copied). All small enough to embed as JS strings.

## 3. RNG

- Two ISAAC64 streams in `rnd.c`: **core** and **display** (`rn2_on_display_rng`).
- Direct call sites: core 5,444 in 868 functions (`rn2` 3,937, `rnd` 1,024, `d` 374, `rnl` 72,
  `rnz` 20, `rne` 17); display 28 in 21 functions. RNG is also called through function
  pointers (`var:rn2`, `var:rn2_on_display_rng`, e.g. `newsym_rn2`).
- Patch 003 turns `rn2`/`rnd`/`rnl`/`d`/`rne`/`rnz` into macros that record
  `__FILE__`/`__LINE__`/`__func__` before the call; inner calls (`rnz → rn2`) inherit the outer
  caller. Transpiling the patched tree therefore reproduces the caller tags for free.
- **Lua has no RNG stream of its own.** `dat/nhlib.lua` replaces `math.random` with a shim over
  `nh.rn2` / `nh.random` (core). Patch 004 tags these calls with the Lua location. In the 44
  public sessions: 724,406 `rn2`, 38,037 `rnd`, 25,078 Lua-tagged `rn2`, 3,393 `d`, 1,062
  `rne`, 707 `rnz`, 155 `rnl`. The display stream is not in the session logs.
- Lua's xoshiro `math.random` is seeded from `NETHACK_SEED` by the patched `nhlua.c` but unused.

## 4. Sorting (patch 002)

`nh_deterministic_qsort` (`src/hacklib.c`) sorts an index array with **Darwin libc `qsort`**
and breaks ties by index. 14 comparators are used (all `qsort` sites in `src/`). Checked with
the call graph: 13 reach no RNG. **`sortloot_cmp` can consume core RNG** on normal paths:
`loot_classify → observe_object → discover_object → exercise → rn2(19)`,
`loot_xname → xname_flags → tin_details → tin_variety → rn2`,
`xname_flags → apron_text → erode_obj_text → wipeout_text → rn2`. So the comparator call
sequence (which depends on the sort algorithm) is observable: the runtime must reproduce
Darwin's `qsort` exactly.

Reference platform for that port and its tests: **macOS 15.8.1 (build 24H32), Darwin 24.6.0
(xnu-11417.140.6), Apple M2, arm64**, the machine where the 44/44 re-record was verified. The official
recording machine's macOS version is not documented.

## 5. Async set (step 1.5)

Blocking roots (from the patched code): `tty_nhgetch` is the only key read that captures a
screen (`nomux_capture_write_input_boundary`); `nh_terminate` does a final capture;
`tty_delay_output` captures animation frames (`await game.animationFrame()` in JS).

| Async set | Functions |
|---|---|
| Direct calls only (lower bound) | 3,349 of 6,592 (51%) |
| Conservative: + every address-taken function of matching type | 4,467 (68%) |
| Conservative, without five error-only entry points (`panic`, compress, SIGWINCH, Lua panic) | 4,249 |

Stage 2 update: fixing type normalization in `async.mjs` (qualifiers, `void * *`) resolves the 5
unresolved sites below; the conservative set becomes 4,469 (4,251 without error paths).

The conservative set is inflated by type-only function-pointer resolution (e.g. every
`void (void)` pointer may reach every address-taken `void (void)` function). Field-sensitive
resolution (which functions are stored into which struct field) will tighten it in Stage 2.
Extra `async` is safe (behavior unchanged) and costs only speed. 5 indirect call sites remain
unresolved (`member:fn`, `member:sf_genericptr`).

## 6. Heap-backed types (step 1.6)

Evidence per record type: union; save I/O (`bwrite`/`mread`, incl. casts in `sfo_*/sfi_*`);
`memcpy`/`memset`/`memcmp` that is not a whole-object or same-type copy; pointer casts between
unrelated records or to/from bytes (allocation casts excluded); `offsetof`. Pointer arithmetic
on `T*` is *not* evidence: an array-plus-index pointer handles it.

| Scenario | NetHack (of 345) | Lua (of 83) |
|---|---|---|
| S0: literal rule, propagate by containment and pointers | 104 (incl. `monst`, `obj`) | 40 |
| S1: save/bones via generated per-type serializers | 37 (still `monst`, `obj` via `union any`) | 40 |
| S2: S1 + pointer fields in heap records hold object handles | 23 (`obj`, `trap`, ... contain unions) | 35 |
| S3: S2 + unions as shared-slot objects | **1** (`struct engr`) | 20 |

Save files are only written and read by the JS port itself (segment to segment through
`storage`), never exchanged with C, so S1 is safe. Unions decide the rest (design question).

Union member usage in NetHack: `union any` (a_int 342, a_char 110, a_obj 72, a_long 43,
a_void 26, a_uint 22, a_monst 16, a_ulong 15, pointer-to-scalar members a_iptr/a_lptr/a_uptr/
a_ulptr 7 each, ...), `union vptrs` (in `struct obj`: v_nexthere 118, v_ocarry 44,
v_ocontainer 31), `union vlaunchinfo` (in `struct trap`), `union str_or_len` (sp_lev),
`union customization_content` (glyphs).

Address-of (`&`), which decides pointer representations: fields of record type 2,169,
array elements of record type 1,464, record variables 1,228, **scalar variables 979, scalar
fields 309, scalar array elements 157** (pointers to scalars need a reference pointer kind).

## 7. Hotspots (step 1.7)

After excluding ordinary string handling and benign forms: 4,601 sites in 122 files; NetHack
1,481, Lua ~3,100. Full list: `transpiler/out/inventory/hotspots.json`.

| Hotspot | Where | What | Proposed decision |
|---|---|---|---|
| `union any` | botl.c 198, options.c 98, light.c 43, timeout.c 32, pager.c 32, role.c 30, ... | tagged by context (timer kind, option type) | object with one shared slot (owner decision) |
| `union vptrs` in `struct obj` | mkobj.c 44, pickup.c 22, invent.c 18, trap.c 10 | three pointer members | same; all members are `struct obj *`-like pointers |
| `union vlaunchinfo`, `str_or_len`, `customization_content` | trap.c, sp_lev.c, glyphs.c | small tagged unions | same |
| Save/restore | sfmacros.h, sfstruct.c, sfbase.c, save.c, restore.c | whole-struct `bwrite`/`mread`, 44 types | generated per-type serializers (S1) |
| `struct engr` | engrave.c:430 | text stored in the same allocation after the struct (`newengr(smem*3)`, `engr_text_space`) | hand-written override or annotation: object + text fields |
| Array pointer arithmetic | mons[] (mon.c, zap.c, do_name.c), rooms[] (mklev.c), levl (mkmaze.c), bill[] (shk.c), ext_func_tab (cmd.c), artifacts | `p++`, `p - base`, `p < end` | array-plus-index pointers |
| Sentinel pointer | shk.c:295 and 3 more | `(struct bill_x *) -1000` | special pointer constant in the runtime |
| Game-state snapshot | nhlua.c:1907–1944 `nhl_gamestate` | `memcpy` of `struct you`, `mvitals[]` to/from a buffer | deep copy helper |
| Signal handler constants | end.c, files.c, save.c, unixmain.c | `SIG_IGN`/`SIG_DFL` int → function pointer | runtime no-ops |
| Lua VM | lvm.c 1,149, lapi.c 537, ldo.c 293, lgc.c 222, ... | value-stack pointer arithmetic, GC unions/casts, `offsetof`, computed goto | heap mode for all of Lua |

## 8. Corrections made to CLAUDE.md (commit 6307e81)

Two PRNG streams, not three; the plain recorder build does not reproduce the sessions;
patch 002 wraps Darwin `qsort` and `sortloot_cmp` can consume RNG; time needs
`TZ=America/New_York` and the `tm_isdst` quirk; recorder-environment constants; Lua 5.4.8 is
fetched at build time; contest docs win on rules/API, the C source wins on game behavior.

## 9. Open items for the owner

- Report the `tm_isdst` leak, the missing `sysconf` and the `record-session.mjs` race upstream?
  (Outward-facing: not done without your go-ahead.)
- Union representation (S2 vs S3) decides most of the memory model.
