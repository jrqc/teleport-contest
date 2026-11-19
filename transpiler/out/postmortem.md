# Postmortem: first judged result (analysis only, no code changed)

Written 2026-11-19 for the owner's review. Subject: where the port can differ from the real
NetHack recorder outside the 44 public sessions.

## 0. The result

| | Sessions | Points (steps) | Screen % | RNG % | Anim frames |
|---|---|---|---|---|---|
| Public | 44/44 | 11,405/11,405 | 100 | 100 | 1,483/1,483 |
| Held-out | 52/56 | 12,009/13,126 (1,117 unmatched) | 91.49 | 93.37 | 1,834/3,006 |

Judge run 2026-11-19 00:50 UTC; the latest pushed commit at that time was `9e66cf2` (the
leaderboard does not publish the sha). Judge timing: 2,842 ms startup + 3.89 ms per turn;
playability 6.9 ms/move against the judge's 25 ms limit, browser check OK.

The judge publishes no per-session detail for held-out sessions, so the 4 failing sessions
cannot be identified directly. What is known:

- 4 sessions lose 1,117 steps, about 280 each: these are failures part-way through long
  sessions, not crashes at startup (a startup trap would also lose about that much, so this
  is not conclusive).
- Held-out animation frames are 61% matched against 100% on public, so the failing sessions
  are heavy on animation (zaps, throws, explosions), or they fail early in such sessions.
- **The held-out pool changed on 2026-10-25** (11,265 → 13,126 points, first seen on the
  leaderboard histories), and upstream then fixed the recorder on **2026-11-14** (commit
  `6ee30e6`, "recorder key encoding, capture patch fixes"). The fixes name their triggers:
  (a) "Gehennom water/lava maps with dark-gray recoloring exceeded the old 24*256 buffer",
  (b) a key above U+007F (a meta key such as M-e) sent as two UTF-8 bytes, (c) raw output
  during suspend leaking into later topten output. These describe recordings that the public
  sessions (recorded in May, `ba8547e`) never exercise, which makes them strong hints about
  what the new held-out sessions contain. Three teams pass all 56, so the held-out recordings
  themselves are clean.

## 1. Findings, ranked by likelihood of causing held-out divergences

Likelihood: **H** = probably causes some of the 1,117 lost steps now; **M** = plausible in a
held-out session, untested; **L** = possible, but needs an unusual input.

| # | Area | Likelihood | Effect when hit |
|---|---|---|---|
| F1 | Capture buffer: our port uses the old patch 006 `nomux_out[24*256]` | **H** | Trap, rest of segment lost |
| F2 | `regcomp`/`regexec` not implemented | **M–H** | Trap during option parsing: whole session lost |
| F3 | Bones files are written but never loaded in any public session | **M** | Divergence after a bones level loads |
| F4 | Keys above 0x7f (meta keys) never exercised | **M** | Wrong command, or divergence |
| F5 | Patch 006 version mismatch beyond the buffer (raw-mode reset at suspend) | **M** | Final screens after save/quit/death |
| F6 | Silent out-of-bounds reads and writes on typed arrays | **M** | Silent divergence (no trap) |
| F7 | Option coverage: public configs use about 25 options | **M** | Any untested option path |
| F8 | Uninitialized locals: C at `-O0` reads stack garbage, JS reads zero | L–M | Silent divergence |
| F9 | Time and DST: pinned "real now" in US daylight time | L–M | Hour-dependent behavior |
| F10 | Lua address-dependent behavior (string-hash seed, `pairs` order, `%p`) | L | Order of Lua table iteration |
| F11 | Lua `io`/`os`/`package` libc and `table.sort`'s `clock()` | L | Trap, only in wizard Lua debugging |
| F12 | `setjmp`/`longjmp` in the object world | L | Trap if a Lua script exceeds its budget |
| F13 | Save/restore beyond the one public case | L–M | Trap or divergence after restore |
| F14 | Deep dungeon, special levels, quest | M | Same as F1 plus untested generators |
| F15 | Long sessions and the time limit | L | Timeout |
| F16 | Darwin libc corners (`printf`, `strtod`, `qsort`) | L | Screen text |
| F17 | Sandbox differences (judge runs under `node --permission`) | L | Startup failure |
| F18 | Memory model: row crossing, the out-of-bounds Proxy, union punning, struct copies | L | Trap (loud) |
| F19 | Regex source version: Libc-1752.120.2 vendored; the recording machine's macOS version is unknown | L | Different regex error code/text, or match result on an unusual pattern |
| F20 | Blank ("") screens: the judge skips them on the C side only | **fixed** | Every later screen of the session one step off |

### F1. Capture buffer overflow (old patch 006) — H

- **Evidence.** The transpiler reads `tools/recorder-env/build/...`, which applies patch 006
  from `52960eb` (README there: HEAD's 006 changes seed0013's final cursor). That version has
  `static char nomux_out[24 * 256]` (6,144 bytes); generated `js/nh/termcap.js:57`
  `const nomux_out = new Int8Array(6144)`. `nomux_capture_screen` writes through `$c.Ptr.set`,
  which traps `write out of bounds` (`js/crt/mem.js:24`). HEAD enlarged the buffer to
  `24*80*32 + 24*16 + 1` (61,825 bytes) because Gehennom maps overflowed it. The largest
  public capture is 5,208 bytes (seed4500 step 1277), 85% of the limit; p99 is 4,550.
- **Effect.** The first screen over 6,143 bytes (many colors and DEC shifts: lava, water,
  dark-gray recoloring, a full map of lit rooms) traps. `runSegment` returns the screens it
  has, and every later step of the segment is lost. This matches "a few sessions lose a few
  hundred steps each" and the low animation-frame match.
- **Fix direction (for review).** Model the buffer as HEAD sizes it. That is not a session
  special case: HEAD is the recorder the 56/56 recordings need. Doing it as a recorder-env
  patch mix (HEAD's buffer size, old raw-mode behavior; see F5) needs a check that public
  sessions still re-record 44/44.
- **Status 2026-11-19: fixed** (owner-approved). `tools/recorder-env/build-reference.sh` now
  applies 6ee30e6's buffer size on top of 52960eb's patch 006; the C recorder built that way
  still re-records 44/44; regenerating changed exactly one line in `js/nh` (`termcap.js`:
  `new Int8Array(61825)`); score unchanged. Test T1 below is in place.
- **Test.** A unit test that fills a capture with the worst case (80 columns of alternating
  fg colors and DEC shifts on all 24 rows); a recorded session in Gehennom or on a lava-heavy
  level (wizard-mode `^V` to Gehennom, `#terrain`).

### F2. regex is unimplemented — M–H

> **Fixed 2026-11-19.** Darwin's own regex is now transpiled: TRE and `regerror` from Apple
> Libc-1752.120.2 plus a C-locale shim (`transpiler/third_party/README.md`), in the heap
> world behind the generated bridge (`regex_t` copied in and out; `regerror`'s buffer copied
> back). Libc-1669.60.4, the tag macOS 15 nominally ships, differed from the installed
> system on `{256}` (error 18, `REG_BADMAX`); 1752 matches. Differential: 80,418 cases
> (fuzzed, NetHack-style, Apple's `tests/regex/datafiles`, six flag combinations): the
> system regex, the vendored build compiled natively and the transpiled JS agree on every
> compile code, `regerror` text, match result and submatch offset. Loop test:
> `tests/nh/regex.test.mjs` (4,126 golden cases, plus NetHack's `posixregex.c` path).

- **Evidence.** `js/nh/posixregex.js` binds `regcomp`, `regexec`, `regerror`, `regfree` to
  `missing(...)`, which traps (`js/crt/mem.js:305`). Callers: `MENUCOLOR` (coloratt.c:596),
  `MSGTYPE` (options.c:7740), autopickup exceptions (options.c:9331),
  `test_regex_pattern` (options.c:7889), sound mappings (sounds.c:1596). No public config uses
  any of them (the 56 public segments use about 25 distinct options; `MENUCOLOR`, `MSGTYPE`,
  `AUTOPICKUP_EXCEPTION` and `SOUND` never appear).
- **Effect.** One such line in a held-out nethackrc traps during option parsing, before step 0:
  the whole session is lost. (That would cost a session's full step count; with 4 sessions
  averaging 280 lost steps, one such session fits.)
- **Fix direction.** Darwin's regex (TRE in Libc, `REG_EXTENDED | REG_NOSUB`, match only),
  ported like `qsort`, or a POSIX ERE engine checked against native `regexec` on fuzzed
  patterns. JS `RegExp` is not POSIX ERE (leftmost-longest, bracket expressions, `\`
  escapes differ), though with `REG_NOSUB` only match/no-match is observable, which narrows
  the gap.
- **Test.** Differential test of `regexec` results against native Darwin libc on the
  patterns from the NetHack docs and fuzzed ones; sessions with `MENUCOLOR`/`MSGTYPE` configs.

### F3. Bones loading has no public coverage — M

- **Evidence.** RNG caller tags in the public recordings: bones are *written* (`drop_upon_death`
  in seed0030 segment 6 and seed5006 segment 0) and `getbones` rolls its `rn2(3)` in every
  session, but no RNG call ever comes from the bones-loading path (`getlev` from a bones file,
  `resetobjs`, ghost creation). No public segment loads a bones level.
- **Effect.** A multi-segment held-out session that dies and then finds the bones level
  exercises the restore code on a bones file, ghost naming and the cursed-item pass, all
  untested. `serial.js` restores pointers as `STALE` (traps on use): a path that uses a
  stale pointer C tolerates would trap.
- **Test.** Record chains of "die on DL2–4, new game, descend to the same level" (seeds varied;
  bones are created with probability, so a fixed recipe will need a few seeds).

### F4. Keys above 0x7f — M

- **Evidence.** `js/crt/proc.js:33` turns each code point into one byte (`& 0xff`), matching
  the fixed recorder's latin1 write. No public session sends a key above 0x7f, so meta
  commands (`M-e` = `#enhance`, `M-p` = `#pray`, …, `altmeta`) are untested. The upstream fix
  on 11-14 shows a held-out recording uses them.
- **Effect.** The C side is transpiled, so the handling should be faithful, but signed `char`
  conversions (Darwin arm64 `char` is signed) on bytes ≥ 0x80 are exactly where an emitter
  bug would hide.
- **Test.** Record sessions with every `M-` command NetHack binds, with `altmeta` on and off.

### F5. Patch 006 behavior beyond the buffer — M

- **Evidence.** HEAD's 006 also calls `nomux_reset_raw_mode()` in `tty_suspend_nhwindows`,
  so raw output during teardown no longer shifts the row of later raw output such as the
  topten list. The reference environment keeps the old behavior because seed0013 (recorded in
  May) needs it.
- **Effect.** If held-out sessions were recorded with HEAD, their final screens after
  save, quit or death (raw output after the windows are suspended) differ from ours. Public
  sessions need the old behavior. If both are true, the held-out recordings come from a
  different recorder version than the public ones, and the port cannot match both with one
  behavior unless the difference is not reachable in the public cases.
- **Test.** Re-record the 44 public sessions with HEAD's 006 and list exactly which steps
  differ (only seed0013's final cursor per the README); this decides how wide the conflict is.
- **T10 result (2026-11-19): settled, low impact.** With 6ee30e6's patch 006 unchanged
  (`PATCH006=head BUILD_DIR=tools/recorder-env/build-head`), 43/44 public sessions re-record
  byte-identically. The only difference in all 11,405 steps is the **cursor** at seed0013
  segment 0 step 48, the last screen after `S` `y` ("Be seeing you..."): public `[0,1]`,
  HEAD `[0,0]`. Every screen is identical, and the sessions that end in death (seed0030's ten
  deaths, seed5006) are unaffected. A cursor mismatch costs that step, so if the held-out
  sessions were recorded with HEAD, the cost is **at most one step per segment that ends in
  a save** (raw output after the windows are suspended). The port keeps the public behavior.

### F6. Silent out-of-bounds access on arrays — M

- **Evidence.** The emitter indexes arrays directly (`svl.level.locations[x][y]`,
  `js/nh/hack.js:135`); there is no bounds helper. Byte pointers (`Ptr`) and pointer
  arithmetic past an array (`ElemPtr` Proxy) trap, but a plain `a[i]` on a typed array out of
  range reads `undefined` and drops writes silently, and on a record array it throws a
  `TypeError` only when a field is read. In C the access reaches the neighboring memory.
- **Effect.** Silent divergence wherever NetHack reads one element out of range (it has known
  off-by-one reads at map edges). `undefined` then becomes 0 or `NaN` in arithmetic helpers.
- **Test.** A debug build mode in the emitter that wraps subscripts in a bounds check that
  traps (not shipped); run every session and every recorded test under it.

### F7. Option coverage — M

- **Evidence.** Distinct options in the 56 public segments: `symset` (always DECgraphics),
  `role/race/gender/align/name`, `autopickup`, `tutorial`, `disclose`, `legacy`, `playmode`,
  `showexp`, `time`, `color`, `lit_corridor`, `pushweapon`, `msg_window`, `splash_screen`,
  `pettype`, `runmode`, `pickup_types`, `verbose`, `mention_walls`, `horsename`, one
  `SYMBOLS`, one `BIND`. Never: `number_pad`, other symsets (IBMgraphics, plain, curses
  default), `MENUCOLOR`, `MSGTYPE`, `hilite_status`, `statushilites`, `menustyle`,
  `fruit`, `packorder`, `paranoid_confirmation`, `perm_invent`, `sortloot`, `boulder`,
  `autoquiver`, `safe_pet`, …
- **Effect.** The code is transpiled, so most options should be right; but each one is a code
  path no test has run, and `hilite_status`/status highlighting goes through regex-like
  matching and color code in botl.c.

### F8. Uninitialized locals — L–M

- **Evidence.** The emitter zero-initializes every local (`let p = null, row = 0, …`,
  `js/nh/termcap.js:414`). The recorder is built at `-O0`, where an uninitialized local holds
  whatever an earlier call left in that stack slot, deterministically. Risk R3 in the design;
  the `-Wuninitialized` pass it proposed has not been run.
- **Test.** Run clang `-Wuninitialized -Wsometimes-uninitialized` and the static analyzer over
  the tree; check each reported site that is reachable.

### F9. Time and DST — L–M

- **Evidence.** `js/crt/time.js:25` pins the recorder's "real now" at 1777723200
  (2026-05-02 12:00 UTC, US daylight time), reproducing patch 001's `tm_isdst` copy. If the
  held-out sessions added on 2026-10-25 were recorded after US daylight time ended
  (2026-11-01), the recorder's copy has `tm_isdst = 0` and every pinned time shifts by one
  hour relative to ours. Dates before 1955 trap (`time.js`, not reachable from realistic
  sessions).
- **Effect.** Only behavior that depends on the hour: `night()`/`midnight()` (undead, gremlins,
  "Good evening" greetings). The moon phase and Friday the 13th depend on the date and are
  unaffected unless the shift crosses midnight.
- **Test.** Record with the reference recorder and a `realnow` in standard time; compare which
  public sessions change (those with datetimes near an hour boundary that matters).

### F10. Lua behavior that depends on addresses — L

- **Evidence.** `luai_makeseed` (lstate.c:71) mixes heap/stack addresses into the string-hash
  seed; our heap (`js/crt/heap.js`, segregated free lists from a fixed base) gives different
  addresses from Darwin's `malloc`. Iteration order of `pairs()` over string keys and over
  table keys follows the hash. The scripts call `pairs()` in 3 places (design 7). Because C's
  addresses change from run to run under ASLR and the recordings still re-record identically,
  recorded output cannot depend on this, except by accident in one recording.
- **Test.** Re-record a sample of sessions several times on native C; any run-to-run difference
  would show such a dependence.

### F11. Lua `io`, `os`, `package` and `table.sort` — L

- **Evidence.** Missing in generated Lua libraries: `clock`, `gmtime_r`, `mkstemp`, `remove`,
  `strftime`, `system` (loslib), `__srget`, `flockfile`, `fseeko`, `ftello`, `funlockfile`,
  `tmpfile` (liolib), `dlopen`… (loadlib), `clock` (ltablib's pivot randomization for
  `table.sort` over more than 100 elements). NetHack opens `io`/`os` only with
  `NHL_SB_IO`/`NHL_SB_OSMASK`, which only wizard-mode Lua debugging (`wizcmds.c:359`) sets;
  the single `io.open` in the scripts (`nhcore.lua:63`, dgamelaunch extra info) is never
  registered as a callback. No script calls `table.sort`.
- **Effect.** A trap only if a held-out session runs `#wizloadlua` or similar.

### F12. `setjmp`/`longjmp` — L

- **Evidence.** Lua's own error handling is in the heap world (`js/crt/heap.js:230`,
  `LongJmp` exception) and is exercised by every `pcall` error path. The only object-world use
  is nhlua.c:2127/3036, the Lua step-budget panic ("Lua time exceeded"), which traps in
  `js/crt/proc.js:120`. Scripts that NetHack ships stay far below their budgets.

### F13. Save and restore — L–M

- **Evidence.** One public save/restore (seed0013, saved early in the game). Restore on a
  developed game (many levels, shops, pets, worms, light sources, timers, regions, engraving
  tails, the Lua state of the tutorial or quest) is untested. The serializer writes pointers as
  flags and the restore traps on the use of a stale one.
- **Test.** Recorded chains of save/restore at different points of a long game, including on a
  special level and after level changes.

### F14. Deep dungeon content — M

- **Evidence.** Public coverage of the dungeon: Dlvl 1–4 for most sessions; wizard tours
  (seed0360, 0361, 0367, 0373, 4500) visit more via level teleport, quest home. Gehennom,
  Medusa, the Castle, the Wizard's tower, the Planes, Fort Ludios, Sokoban beyond level 1 and
  big rooms are untested. F1 is the most likely failure there; the Lua level generators
  themselves are transpiled and generic.
- **Test.** Wizard-mode recordings that visit every special level (`^V` with a level name)
  and look around (`#terrain`, `^F`, `^X`).

### F15. Long sessions and the time limit — L

- **Evidence.** Judge: 2.8 s startup + 3.9 ms per turn; the longest public session (1,813 keys)
  takes 7 s locally. 900 s allows about 230,000 turns at that rate; no held-out session is that
  long. The Lua heap grows to 1 GB at most (`js/crt/heap.js:18`, then `heap exhausted`); blocks
  are reused through free lists, so long sessions do not leak.

### F16. Darwin libc corner cases — L

- **Evidence.** `printf.js`, `qsort.js`, `time.js` were fuzzed against Darwin. `printf` traps on
  unsupported conversions instead of guessing. `strtod`/`atof` and `sscanf` (`scanf.js`) have
  unit tests but no native fuzzing against Darwin; options with numbers in nethackrc go through
  them.

### F17. Sandbox — L

- **Evidence.** The port uses no Node APIs (checked: no `node:` imports or `require` in `js/`
  except a function named `ll_require` in generated Lua). The judge ran it successfully, so the
  sandbox works for the paths taken; a path that touches `process`, `fs` or a timer would fail
  only under the judge.
- **T7 result 2026-11-19 (commit 208d3d2).** `tools/sandbox-score.mjs` runs the frozen
  runner's worker (the process that calls `runSegment`) under `--permission`, with reads
  limited to the fork ("judge") or to `js/`, `frozen/` and the session file ("strict"), and
  compares with the unsandboxed run. Node 26.5.0 and 22.23.5: 44/44 sessions, 11405/11405
  screens, 792838/792838 RNG under both policies; no access denial logged; slowest session
  8.1 s. A negative check confirms the flags deny reads elsewhere, writes, child processes and
  workers. Not modeled: the judge's IPC split (our code cannot observe it) and its machine
  speed. In the loop: `npm run sandbox` (in `transpiler/`).

### F18. Memory model — L

- **Row-crossing pointers**: record arrays carry `__outer`/`__oidx`, and `relem`/`rowAt`
  (`js/crt/mem.js:79`) carry a position into neighboring rows; scalar matrices are views of one
  flat array (`matrix`, `mem.js:252`). Correct by construction for C's layout.
- **The out-of-bounds Proxy** (`ElemPtr`, `mem.js:68`) traps on any dereference outside the
  array; it is loud, so it cannot cause silent divergences, only lost segments.
- **Unions**: punning unions are union cells (decided by `transpiler/out/union-pun.json`); a
  union the static check misclassified would trap on a member of the wrong kind.
- **Struct copies**: generated `$copyFrom`/`$clone` copy embedded records and arrays deeply and
  pointers shallowly; union cells copy their bytes and side map. No known gap.
- **Effective type and contiguous fields** were found by public sessions (design 14.5–14.6);
  other blocks used in two ways trap with named messages (`alloc.js`).

All the traps above are loud: a trap ends the segment with an error on stderr. The judge's
output is not visible to us, but the same trap in our own runs names the C construct.

### F20. Blank screens shift the judge's alignment — fixed 2026-11-19

- **Found by** T2 (`tools/fuzz/run.mjs`, case saves-128): a recording that the port reproduces
  exactly (per segment, every screen and RNG call equal) scored 412/463 screens.
- **Cause.** `frozen/ps_test_runner.mjs` builds the C screen list with `if (step.screen)`: a
  step whose screen is the empty string (a completely blank terminal; here after "Do you want
  to see your conduct?" answered with ESC at the end of a game) is not compared. Our
  `getScreens()` returned that step's `""` too, so from there to the end of the session every
  JS screen was compared with the next C screen. A judged session with a blank screen in an
  early segment loses nearly all later screens while its RNG still matches.
- **Fix.** `js/jsmain.js` `getScreens()`/`getCursors()` leave out `""` screens by the same rule
  (per-step arrays stay available to tools as `getStepScreens()`/`getStepCursors()`).
- **Test.** `tests/sessions/blank-screen-midsession` (own recording; 16/22 before, 22/22 after),
  run by `tests/nh/own-sessions.test.mjs` and the sandbox run.

### F19. Regex Libc version — L (known risk, accepted 2026-11-19)

- **What we chose.** The F2 fix transpiles TRE from Apple **Libc-1752.120.2**, because it
  matches the regex of *our* machine (macOS 15.8.1, 24H32) on all 80,418 differential cases.
  Libc-1669.60.4 (the tag macOS 15 nominally ships) differs on 12 of 30,292: `{256}` and
  other counts above `RE_DUP_MAX` give error 10 "invalid repetition count(s)" there and error
  18 "maximum repetition exceeds 255" on our system, so Apple has backported the 1752 code.
- **What we don't know.** The macOS version of the machine that recorded the official
  sessions (davidbau's) is not documented (`docs/recording-environment.md` names `HOME`,
  `TERM`, `TZ` and Darwin libc, but no OS build). An older or newer macOS could have a TRE
  between or beyond these two tags.
- **Why it is low.** NetHack calls regex only with `REG_EXTENDED | REG_NOSUB`, for
  match/no-match of user patterns from the nethackrc (`MENUCOLOR`, `MSGTYPE`,
  autopickup exceptions). The two tags agree on every such case that compiles; they
  differ only in which error a malformed pattern reports, and NetHack shows that text
  only in an option-error message (`config_error_add`), for an invalid pattern. A held-out
  session would need a pattern with a repetition count above 255, or another construct
  the versions treat differently, to see it.
- **How to settle it.** Any held-out failure in a session whose nethackrc has a regex
  option; or a recording with a malformed pattern made on the recorder machine (needs the
  contest author). Switching tags is a re-vendor plus regenerate, no transpiler change.

## 1A. Readability and Phase 2 (owner request, 2026-11-19)

Phase 2 scores `parity / (1 + lines_changed_in_js / N)`, with comment-only and whitespace-only
changes normalized out. Every line of generated code that encodes something incidental to the
C source (a line number, a renumbered constant, an inlined macro body) changes whenever 5.1
moves that incidental thing, so these are churn as well as readability problems. Figures are
for `js/nh` as generated on 2026-11-19 (about 246,000 lines, Lua excluded).

| # | Issue | Evidence | Churn risk | Readability |
|---|---|---|---|---|
| P1 | **C line numbers in code** (RNG caller tags) | Patch 003's `rn2`/`rnd`/… macros expand at every call site to `rng_log_enabled() ? (rng_log_set_caller("mon.c", 597, "make_corpse"), rn2(x)) : rn2(x)` (`js/nh/mon.js:452`). 2,719 sites on 2,547 lines | **Very high**: any line added or removed above a call in a C file changes the line number of every later RNG site in that file. A typical 5.1 change to `mon.c` would touch most of its RNG lines | Poor: each RNG call is written twice inside a conditional |
| P2 | **Numeric constants** | Enum values and `#define` constants are emitted as clang's folded value with the name in a comment: `mksobj_at(461 /* FIRST_GLASS_GEM */ + …)`, `typ < 16 /* POOL */`. 27,665 occurrences on 16,420 lines; most frequent families: `PM_*` monster indices (2,920), `GLYPH_*` (1,619), `S_*`, `A_*` and property indices | **High**: 5.1 adding one monster or object renumbers every later `PM_*` / object index, and every use site changes (only the number changes; the comment keeps the name) | Fair (the comment names it) |
| P3 | **Expanded macros** | Function-like macros are inlined: `Blind` (youprop.h:103) becomes `(u.uprops[15 /* BLINDED */].intrinsic \|\| u.uprops[15 /* BLINDED */].extrinsic) && !u.uprops[15 /* BLINDED */].blocked` at every use; `rn1`, `IS_POOL`, `isok`-style predicates likewise | High: a changed macro body changes every use site in every file instead of one definition | Poor: the C reads `Blind`, the JS reads its expansion |
| P4 | **Dropped comments** | C comments are not carried; only a `// file.c:line` marker per function | None (comments are free in the diff) | Losing them makes the output harder to follow; carrying them costs nothing in Phase 2 |
| P5 | **Function line markers** | `export function nomux_capture_screen() {   // termcap.c:796` | None (comment-only lines normalize out) | Good; keep |

Fix plan (in the transpiler only; no hand edits):

1. **P1, RNG caller tags out of the code.** The tags only feed our debug log; `getRngLog()`
   strips them and scoring never sees them. Recognize the patch-003 macro expansion at the
   call site (clang's macro-expansion locations identify it) and emit the plain call,
   `rn2(x)`. The C caller for triage then comes from a **source map written outside `js/`**
   (`transpiler/out/srcmap/<file>.json`: generated JS line → C file, line and function) plus the
   JS stack at the RNG call in debug runs only (`tools/`, not shipped). Removes about 2,550
   lines of line-number churn and halves the text of every RNG call. Check: the RNG sequence is
   unchanged (score) and tool 4.2 still names C callers.
2. **P2, named constants.** Emit each enum constant and object-like `#define` that the code uses
   as a named export of a generated constants module per header (`js/nh/consts/<hdr>.js`:
   `export const PM_GIANT_ANT = 0;`) and reference it by name (`PM.PM_GIANT_ANT` or an
   imported binding). A renumbering then changes one line per constant in one file. Exceptions,
   emitted as values: constants inside `case` labels where the switch must stay a JS `switch`
   (named constants work there too, so probably none), array sizes in typed-array constructors
   (keep the value; the name in a comment). Check: generated code byte-identical in behavior
   (score), and a churn experiment: insert a monster in a scratch copy of `monst.c`/`monsters.h`
   and count changed `js/` lines before and after.
3. **P3, macros as functions where it is exact.** For function-like macros whose expansion is
   an expression, emit one JS function per macro in the header's module and call it, **only
   when the call is semantically identical to the expansion**: each argument at the call site
   is free of side effects and of `await` (otherwise evaluating it once instead of N times or
   in a different order would change behavior), the macro does not take addresses of or assign
   to its arguments, and it does not depend on the caller's local names. Other sites keep the
   expansion. Property macros (`Blind`, `Levitation`, …) and predicates (`IS_POOL`, `rn1`)
   qualify. Check: score, and the count of expansion sites converted.
4. **P4, comments.** Carry C comments from the source text (clang's AST omits most of them):
   attach each comment to the next emitted statement by source location. Free in Phase 2.

Order: P1 (largest churn per unit of work), P2, P3, P4. Each step is a separate transpiler
commit plus a generated commit, with a score run and the churn report (T13).

**Rendering without the capture layer (owner request, longer term).** Today screens come from
the recorder's patch 006, transpiled: a shadow screen in `termcap.c`, captured into a marker on
stdout at every input boundary, parsed and re-encoded by `js/nhprocess.js`. That ties the port
to one patch version (F1, F5) and keeps recorder code in `js/`. Plan:

- Render from the tty port's own state: wintty keeps its window buffers, and `tty_curs`/
  `xputs`/`cmov`/SGR output go through termcap.c. A JS terminal emulator over the tty's stdout
  bytes (the escape sequences the real terminal would receive, under `TERM=xterm-256color`),
  feeding the frozen `Terminal`, gives the screen a real xterm would show, with no capture code.
- The capture points stay where the C recorder takes them (`tty_nhgetch` input boundaries and
  `tty_delay_output` frames), but as a small hand-written hook, not patch code.
- Risk: the recorder's capture and a terminal emulator differ wherever patch 006 models the
  screen differently from what xterm does (it has its own raw-mode row counter, the cause of
  F5). Building it means a side-by-side run: emulator grid vs capture payload at every step of
  every session, until they agree everywhere; only then switch. Outcome on the 44 public sessions
  decides whether the scored screens can come from the emulator.
- Effect on Phase 2: patch 006 changes would no longer reach `js/`; 5.1 changes to tty output
  would reach it only through the transpiled wintty/termcap code, as they should.

## 2. What the evidence suggests for the 4 failing sessions

Most likely, in order: **F1** (a big colored screen deep in the dungeon or on lava/water),
**F2** (a config with `MENUCOLOR`/`MSGTYPE`), **F3/F13** (bones or restore on a developed
game), **F4** (meta keys). F1, F2 and F4 are tied to the upstream recorder fixes of 11-14 or
to untested config features, and each is a loud trap, so each would show up immediately in a
targeted recording.

## 3. Testing plan (proposal, to build after approval)

Principle: aim at fidelity, not at the hidden sessions. Every test runs from `tools/loop.mjs`
(the automated loop), writes results under `results/<stamp>/`, and must stay green once it is
green. Recorded tests live in `tests/sessions/` (not `sessions/`) and are scored with the same
`frozen/ps_test_runner.mjs`.

| # | Test | What it does | Build cost | Catches |
|---|---|---|---|---|
| T1 | **Capture worst case** | Unit test of `nomux_capture_screen` with a maximal screen; then a Gehennom/lava recording | Small | F1 |
| T2 | **Random differential play** | Generate key sequences, record them with the reference recorder, score the port on them. Three generators: uniform printable keys; a weighted command grammar (movement runs, `s`, `i`, `a`, `z`, `t`, `f`, `e`, `q`, `r`, `#` commands, menus answered with menu letters, `--More--` with space); and wizard-mode tours (`^V`, `^W`, `^F`, `#terrain`) for the deep dungeon. Each run: random seed, datetime and config; a mismatch is shrunk to the shortest failing prefix (delta debugging on the key string) and kept as a regression test | Medium | Everything reachable by play |
| T3 | **Option fuzzing** | Random nethackrc files from the option table in `options.c` (booleans, compound options with valid values from the docs), plus `MENUCOLOR`, `MSGTYPE`, `AUTOPICKUP_EXCEPTION`, `SYMBOLS`, `BIND`, `symset` (each symset in `dat/symbols`), `number_pad` (0–4, −1), `altmeta`, `hilite_status`. Paired with short T2 key scripts | Small (generator) | F2, F4, F7 |
| T4 | **Coverage measurement** | Build the reference recorder a second time with `-fprofile-instr-generate -fcoverage-mapping`, replay every public and own session through it, and report function and branch coverage per file (`llvm-cov`). The report lists unreached functions (bones loading, meta commands, regex, special levels) and drives T2/T3 targets. The coverage binary is only for measurement; recordings still come from the reference binary | Medium | Blind spots, all areas |
| T5 | **Function-level differential tests (M2)** | Extract pure functions (`rnd.c`, `hacklib.c`, `objnam.c` naming, `mkobj.c` creation) into small C drivers linked against the recorder objects; call each with fuzzed arguments and seeded RNG natively and in the transpiled JS; compare return values, buffers and RNG logs | Medium | Emitter bugs on paths sessions miss (signed char, ≥0x80 bytes, integer edges) |
| T6 | **Save/restore, bones and multi-game chains** | Scripted recordings: save and restore at random points of long T2 games; die, new game, reach the bones level (several seeds, as bones are probabilistic); chains of quit/new game; restore after level changes and on special levels | Medium | F3, F13, F5 |
| T7 | **Sandbox run** | Run the scorer exactly as the judge does: `node --permission --allow-fs-read=<repo>` with no write or child-process permission, frozen files overlaid, on all public and own sessions | Small | F17 |
| T8 | **Bounds-check build** | An emitter debug flag that wraps array subscripts in a trapping bounds check; run all sessions and T2 under it (never shipped to `js/`) | Small–medium | F6 |
| T9 | **Uninitialized-read audit** | clang `-Wuninitialized` and the static analyzer over the recorder tree; each reachable site gets a decision | Small | F8 |
| T10 | **Recorder-version check** | Re-record the public sessions with HEAD's patch 006 and with a standard-time `realnow`; list the steps that change. Decides F1/F5/F9 | Small | F1, F5, F9 |
| T11 | **Native run-to-run stability** | Record the same recipe several times with ASLR on; any difference marks an address-dependent behavior | Small | F10 |
| T12 | **libc differential fuzzing** | Extend the `printf` fuzzing to `strtod`, `atoi`/`atol`, `sscanf`, `strncpy`/`strncat` truncation, `regexec` once it exists, against native Darwin | Small | F16, F2 |
| T13 | **Determinism and churn** (exists: 4.7) | Kept in the loop; add the Phase 2 `git diff --numstat -- js/` report per commit | — | Phase 2 |

Built so far: **T10** (done, settled F5), **T1** (`tests/nh/capture-buffer.test.mjs`), **T7**
(`tools/sandbox-score.mjs`, see F17), and the regex part of **T12** (`tests/c-diff/regex/`,
`tests/nh/regex.test.mjs`, see F2).

Order proposed: T10 and T1 first (they decide how to fix F1/F5, the likeliest causes), then
T7, T3 + T2 (they find the most per hour), T4 (it tells where to aim T2/T3), T6, T5, T8, T9,
T11, T12.

Cost note: T2/T3/T6 run the native recorder, which takes about 1–3 s per short session, plus
the port; a nightly batch of a few hundred random sessions fits in minutes. Recorded tests
that fail are kept (after shrinking) so the suite grows only with useful cases.

No code was changed for this analysis.
