# CLAUDE.md — Teleport Contest: NetHack 5.0 → JavaScript via a hybrid transpiler

This file is the standing brief for Claude Code in this repository. Read it fully before doing
anything. It covers (1) the contest and its rules, (2) the approach we chose, (3) the staged
workflow, and (4) the automated test loop.

Owner: Gürbüz Demiroğlu. Goal: **build a working port by transpiling, not to win**. Leaderboard
placement is a side effect. Correctness, generality and a clean, repeatable method matter more
than points.

---

## 1. The contest

### 1.1 What it is

The Teleport Contest (David Bau, announced 2026-05-06,
<https://davidbau.com/archives/2026/05/06/the_teleport_contest.html>) asks entrants to port
**NetHack 5.0** (released 2026-05-02; about 442,901 lines of C and Lua) to plain JavaScript whose
external behavior is **bit-exact** with the C original: the same PRNG (pseudo-random number
generator) sequence and the same 24×80 terminal screen after every keystroke.

| Resource | Location |
|---|---|
| Announcement post | davidbau.com/archives/2026/05/06/the_teleport_contest.html |
| Contest repo (fork this) | github.com/davidbau/teleport-contest |
| Leaderboard | mazesofmenace.ai/leaderboard/ |
| Session viewer | mazesofmenace.ai/sessions-viewer/ (local copy: `tools/session-viewer/`) |
| Reference C source | github.com/NetHack/NetHack, tag `NetHack-5.0.0_Release`, submodule at `nethack-c/upstream/` |
| Contract details | `docs/API.md` (runSegment API, comparator, sandbox), `docs/PHASES.md` (phases, diff penalty) |

### 1.2 How to participate

1. Fork and clone: `gh repo fork davidbau/teleport-contest --clone --remote`
2. `git submodule update --init` (pulls the NetHack C source into `nethack-c/upstream/`)
3. Set the category: `bash frozen/set-category.sh transpiled` (scoring refuses to run until a
   category is set; ours is **transpiled**: more than 50% of the code is produced by tools from
   the C source).
4. Score locally: `bash frozen/score.sh`. Score one session:
   `node frozen/ps_test_runner.mjs sessions/<name>.session.json`
5. Push to `main`. GitHub Actions on the fork scores the 44 public sessions on every push. The
   official judge auto-discovers forks every **2 hours** and scores the latest commit against
   all **88** sessions (44 public + 44 held-out). There is no other submission step.

### 1.3 Dates (all 00:00 UTC)

| Date | Event |
|---|---|
| 2026-05-06 | Contest opened |
| 2026-11-29 | Phase 1 freeze: judge tags `phase1/<owner>/<sha>`; top 10 qualify for Phase 2 |
| 2026-11-30 | Phase 2 target ("NetHack 5.1") and diff-penalty formula announced |
| 2026-12-31 | Phase 2 deadline |

Everyone may keep submitting after the Phase 1 freeze; only the top 10 compete in Phase 2.
**Our own stages (section 3) are named "Stage", not "Phase", to avoid confusion.**

### 1.4 Scoring

- **One point per step**: a step is an input boundary (each time C's `tty_nhgetch()` blocks for
  a key; the first frame is before any key). A step scores if the 24×80 grid matches exactly:
  character + color + attributes (+ cursor position). Partial sessions earn partial credit.
- Public pool: 11,284 steps. Held-out pool: 10,538 steps. Maximum: **21,822**. (The leaderboard
  data on 2026-11-18 shows different pools: public 44 sessions / 11,405 points, held-out
  **56 sessions / 13,126 points**, 100 sessions in all. Trust the leaderboard.)
- PRNG match is reported as advisory progress only, but it is the prerequisite: one wrong or
  missing RNG call cascades and every later screen diverges.
- Whole-session passes (every screen and RNG call) are the tiebreaker. Cursor is a tiebreaker.
- Animation frames (`await game.animationFrame()` inside the `nh_delay_output()` equivalent) are
  a supplemental `Anim%` column, not part of the ranking.
- Screen comparator (`frozen/screen-decode.mjs`): both sides are decoded to a cell grid, so
  encodings that render the same pixels match. Version banner lines are collapsed; DEC
  line-drawing glyphs are translated; invisible attributes on spaces are ignored, but inverse
  video and underline on spaces count.
- The runner prints human-readable output to stderr and a JSON block after the marker
  `__RESULTS_JSON__` on stdout. Our tooling parses that block.

**Phase 2 scoring** (`docs/PHASES.md`): `final ≈ parity_on_5.1 / (1 + lines_changed_in_js / N)`.
The diff is `git diff phase1/<tag> HEAD -- 'js/**'` (excluding frozen files), summing added and
deleted lines; whitespace-only and comment-only changes are normalized out. **Only `js/` (plus
`package.json`, `index.html`) is judged. Code outside `js/` (our transpiler, annotations,
tooling) never counts toward the diff.** This is the single most important design constraint
for a transpiler: when the C source changes, re-running the transpiler must change as few
`js/` lines as possible (see 2.6).

### 1.5 The API contract (`docs/API.md`)

`js/jsmain.js` must export:

```js
export async function runSegment(input, prevGame = null) → game
// input: { seed, datetime /* "YYYYMMDDHHMMSS" */, nethackrc /* OPTIONS=… text */,
//          moves /* raw key string from the first keystroke, incl. chargen */, storage }
// game:  { getScreens(): string[], getRngLog(): string[], getCursors(): [col,row,vis][],
//          getAnimationFramesByStep?(): {screen,cursor}[][] }
```

- A session is one or more segments (save/restore, chained `#quit`/new game, bones). The harness
  calls `runSegment` once per segment and concatenates per-segment outputs itself. Each returned
  game reports **only its own segment**.
- **`docs/API.md` is wrong about `prevGame`** (and README.md implies the same): it says each
  segment gets the previous segment's `game`. The judge's runner (`frozen/ps_test_runner.mjs`,
  `runSession`) calls `runSegment(input)` with **no `prevGame`**, and `input` has only `seed`,
  `datetime`, `nethackrc`, `moves`, `storage`. Never use `prevGame` to tell a first segment from
  a later one, and carry no cross-segment state except through `input.storage`. (Found
  2026-11-18: emptying the record file when `prevGame` was null broke seed0030 under the judge.)
- Cross-segment state (save files, bones, the record file) goes through `input.storage`
  (Web-Storage-shaped; the same instance for every segment of a session) via the frozen
  `js/storage.js` VFS (`vfsReadFile` / `vfsWriteFile` / `vfsDeleteFile` / `vfsListFiles`).
- RNG log entries are exactly `rn2(N)=M`, `rnd(N)=M`, `rn1(N,B)=M`, `rnl(N)=M`, `rne(N)=M`,
  `rnz(N)=M`, `d(N,B)=M`, compared positionally. The C recordings carry `@ caller(file:line)`
  tags; **never put those in `getRngLog()`** (keep a separate debug log, see 4.2).
- NetHack has **two PRNG streams** (two ISAAC64 states in `rnd.c`): **core** and **display**
  (hallucination; logged separately via `NETHACK_RNGLOG_DISP`, not part of the session RNG
  logs). Both must be reproduced in the right order with the right values. The contest README
  speaks of three contexts, but the C source shows that Lua special-level scripts have no
  stream of their own: `dat/nhlib.lua` replaces `math.random` with a shim that calls `nh.rn2` /
  `nh.random`, i.e. the **core** RNG. Patch 004 ("Lua context") only tags those core calls with
  the Lua source location (`@ random src=nhlib.lua:8 ...`). Lua's own xoshiro `math.random` is
  seeded but never used by the scripts. (Verified in Stage 1; see
  `transpiler/out/stage1-findings.md`.)
- Recorded screens/RNG are never passed in. 900-second wall-clock limit per session.

### 1.6 Rules and hard constraints

| Constraint | Consequence for us |
|---|---|
| Plain ES6 modules, run as-is in Node 22+ and Chrome, **no build step** | The transpiler runs offline; we commit its generated JS into `js/`. |
| **No WASM**, no network, no filesystem, no threads, no native addons | The "Emscripten-like" part must be pure JS (typed arrays/`DataView`), not WebAssembly. Game data files and `.lua` scripts must be embedded into JS modules. |
| Frozen files `js/isaac64.js`, `js/terminal.js`, `js/storage.js` (copies in `frozen/`) are overlaid by the judge | Never edit them. Import and use them. `rng.js` may be replaced but must use `isaac64.js` and the exact log format. |
| Sandbox: Node `--permission`, read-only access to the fork, no `child_process` | No runtime tricks; everything happens in-process. |
| Port faithfully, **including bugs** | The transpiler must preserve C semantics, never "fix" behavior. |
| All forks are public | Method, prompts and harness are visible. That is intended. |

### 1.7 The C reference build (`nethack-c/`)

- `nethack-c/build-recorder.sh` applies the patches in `nethack-c/patches/` (001 seed + fixed
  datetime, 002 deterministic/stable `qsort`, 003–005 RNG logging: core, Lua call-site tags
  on the core stream, display, 006 deterministic 24×80 capture) and builds the recorder with **clang** (needs
  `clang`, `make`, `bison`, `flex`). Env vars: `NETHACK_SEED`, `NETHACK_FIXED_DATETIME`,
  `NETHACK_RNGLOG`, `NETHACK_RNGLOG_DISP`, `HACKDIR`.
- **That build alone does not reproduce the sessions.** It installs no `sysconf` (the game
  refuses to start), the HEAD version of patch 006 fails seed0013, the recorder's `time()`
  leaks the real clock's DST flag (2.4, Time), and `scripts/record-session.mjs` drops the last
  step at random and leaves lock files between segments. Use the reference environment
  instead: `bash tools/recorder-env/build-reference.sh`, then
  `node tools/recorder-env/verify-rerecord.mjs` (44/44 byte-identical) and
  `tools/recorder-env/record-session.mjs` for our own recordings. Details:
  `tools/recorder-env/README.md`. `nethack-c/` and `scripts/` stay unmodified.
- **Why clang:** C argument evaluation order is unspecified. Clang evaluates left to right (like
  JS); gcc right to left. `d(rn2(5), rn2(3))` consumes RNG in a different order under gcc. The
  transpiler must preserve **clang's** evaluation order everywhere, and the same for any other
  unspecified behavior clang resolves a particular way.
- The transpiler must see the **same preprocessed source** as the recorder: the same `#define`s,
  hints file, config headers and patches. Port the patched tree, not raw upstream.
- `scripts/record-session.mjs` re-records a session from a recipe using the recorder binary. We
  use it to record our own targeted sessions (4.4).
- Session files (`sessions/*.session.json`, v5): `segments[] → {seed, datetime, nethackrc,
  moves, steps[] → {key, rng[] (with "@ caller(file:line)"), screen, cursor,
  animation_frames?}}`. The C caller tags tell us exactly which C function made each RNG call.
  That is the backbone of our debugging tools.

### 1.8 Bau's lessons (from the post; treat as rules)

1. **Be skeptical.** His agents invented a confident but false explanation ("sparse boundary
   frames" in `replay_core.js`) for failing tests. The real bug was async/await not wired
   correctly for waiting on input. Agents resisted removing workarounds because removal exposed
   real bugs. If an explanation needs a special mechanism, assume it is wrong until proven.
2. **Strategy over stats.** Progress stalled for weeks on a few failing sessions while agents
   padded results with easy new tests. Fix architectural root causes first; write tests that
   break a long-term problem into short-term ones.
3. **Invest in tooling** for humans and agents to understand code and game state.
4. **Restart when contaminated.** He discarded more than 200,000 lines because wrong async
   assumptions had spread into comments, names and architecture. For us, the equivalent is that
   generated code is disposable: fix the transpiler and regenerate.

---

## 2. Our approach: hybrid transpiler (C → readable JS + byte-level fallback)

We are **not** building on Bau's skeleton game logic this iteration (`js/fastforward.js`,
`js/mklev.js`, etc. are discarded). We keep only what the contract requires: the frozen files,
the `runSegment` contract and the RNG log format. Everything else in `js/` is generated by our
transpiler or is a small, tracked hand-written runtime. Bau's `js/jsmain.js` and `js/rng.js` may
be read and partly reused as a reference for the API glue and the exact RNG log format.

### 2.1 Core idea

| Part of the C code | Translation |
|---|---|
| Code that uses structs through field names, arrays by index, plain control flow (the vast majority) | **Readable JS**: one JS module per C file, same function names and order, structs as objects/classes. |
| Code that treats memory as raw bytes (unions, pointer casts between types, `memcpy`/`fwrite`/`fread` of structs, `sizeof`-dependent logic, cross-object pointer arithmetic) | **Emscripten-like fallback in pure JS**: affected data types live in a flat byte heap (`ArrayBuffer` + `DataView`/typed arrays) with C-exact layout. |
| Readable code that touches a heap-backed type | Goes through **generated accessor wrappers** (getters/setters on a class), so the code still reads `mon.mhp -= 3` while the single copy lives in the heap. |

**The one-copy rule:** a data type has exactly one representation. If any code treats a type
as bytes, every instance of that type lives in the heap and all readable code reaches it
through wrappers. Never keep an object copy and a byte copy of the same data. The decision is
**per data type, not per function**, and it propagates: a heap-backed struct pointing to
another struct may force that struct into the heap too. Iterate to a fixed point.

### 2.2 Unsafe-pattern analysis (automatic)

Before generating code, the transpiler runs an analysis over the clang AST (abstract syntax
tree) that:

1. Finds raw-memory operations: unions; casts between unrelated pointer types; `void*` /
   `genericptr_t` round trips; `memcpy`/`memmove`/`memset`/`memcmp` on structs; `fwrite`/
   `fread`/`bwrite`/`mread`-style I/O of structs; `sizeof`/`offsetof` used in logic; pointer
   subtraction/comparison across objects; pointer arithmetic beyond a single array.
2. Marks the affected struct types heap-backed, propagates marks to a fixed point, and marks the
   functions that need byte-level code.
3. Writes a report (`transpiler/out/unsafe-report.md`): each site, file:line, pattern, the
   resulting decision, and how far marks propagated.

The analysis is **conservative**: when it cannot prove a type is safe, it marks it heap-backed.
Correctness never depends on human review; review only removes marks to regain readability.

### 2.3 Annotations ("decorator-like" pattern)

Decisions are recorded in a **side file**, not in the C source and not as JS decorators (JS
decorators are not part of ES6/Node 22 without a build step, and the output must not depend on
them). Proposed file: `transpiler/annotations.yaml` (format decided in Stage 1), keyed by C
names so it survives C version changes:

```yaml
types:
  monst:   { repr: object }          # override: proven safe after hand-rewriting savemon()
  obj:     { repr: heap }            # touched by byte-level save code
functions:
  savemon: { handwritten: js/hand/save.js }   # escape hatch, keep rare
  tty_nhgetch: { blocking: true }             # async root
pointers:
  "genericptr_t@restore.c:123": { points_to: obj }
```

Rules:
- The analyzer produces defaults; annotations **override**. A checker fails the build on any
  unsafe site that has no decision (default or explicit), and on stale annotations whose C name
  no longer exists.
- Hand-written replacements (`js/hand/`) are a last resort, listed in annotations, each with a
  comment linking the C function. Track their total line count; it should stay small.
- Agents never decide data representation ad hoc in generated code. Representation lives in the
  annotation file and the analyzer only.

### 2.4 C semantics the runtime must get exactly right

All semantic-gap handling lives in one hand-written, heavily tested runtime (`js/crt/` or
similar). Generated code calls helpers and never re-implements semantics inline.

| Area | Requirement |
|---|---|
| Data model | Match the recorder's ABI (LP64 on Linux/macOS: `int` 32, `long` 64, pointers 64). `sizeof` and struct layout/padding must equal clang's for heap-backed types. |
| Integers | Exact C arithmetic: truncating division and `%`, unsigned wraparound, integer promotions, signed/unsigned `char`, shifts, 64-bit via `BigInt` only where needed (performance). |
| Evaluation order | Left to right, matching clang (side effects in arguments and operands). |
| Structs | Assignment and pass-by-value **copy**; object references must never alias where C copies. |
| Strings | `char` arrays with NUL terminator semantics; `strcpy`/`strcat`/`strncpy`/`sprintf` into buffers must behave like C (including truncation). |
| Formatting | `sprintf`/`snprintf` must be byte-exact for every format NetHack uses (`%d %ld %s %-10s %c %x %5.2f …`). Screens depend on it. |
| Control flow | `goto`, `switch` fall-through, `setjmp`/`longjmp` (as exceptions) translated mechanically. |
| Sorting | Patch 002 (`nh_deterministic_qsort`, `src/hacklib.c`) is a wrapper, not an algorithm: it sorts an index array with **Darwin libc `qsort`**, breaking ties by original index (stable). The runtime must reproduce **Darwin's `qsort` exactly** (never JS `Array.sort`), because comparator call order is observable: `sortloot_cmp` can consume core RNG (`observe_object → discover_object → exercise → rn2`, `xname → tin_variety → rn2`, `wipeout_text → rn2`). The other 13 comparators reach no RNG. Verify by logging comparator call sequences against native C. |
| Time | `time()`/`localtime()` must use the segment's pinned `datetime` (moon phase, Friday 13th, shopkeeper greetings) in `TZ=America/New_York`. Quirk to reproduce: patch 001's `time_from_yyyymmddhhmmss()` copies the recording machine's *real* `struct tm` (incl. `tm_isdst`) before `mktime()`; the official recordings were made in US daylight time, so the pinned time behaves as `mktime` with `tm_isdst=1` (a winter date's local hour comes out one hour earlier, e.g. 12:00 → 11:00). |
| Recorder environment | Strings that come from the recording machine are documented constants (`docs/recording-environment.md`, contest issues #16/#17; davidbau: hard-coding them is legitimate): `HOME=/Users/davidbau/git/mazesofmenace/teleport/maud/test/comparison/c-harness/results` (config file shown as `$HOME/.nethackrc`, wrapped at column 80, e.g. seed2200 step 158), `TERM=xterm-256color`, `TZ=America/New_York`, Darwin libc behavior. Keep them in one runtime module, never scattered in generated code. |
| libc | Implement only the libc subset NetHack actually calls; the Stage 1 inventory lists it. |

### 2.5 Async input (the problem that sank Bau's first attempt)

C blocks in `tty_nhgetch()`; JS must `await`. The transpiler computes the **async set**
automatically from the call graph: every function that can transitively reach a blocking root
(`tty_nhgetch`, and others the investigation finds, e.g. `--More--` waits, `getlin`,
`yn_function`, `nh_delay_output` for animation frames) is emitted `async`, and every call to it
becomes `await`. Calls through function pointers (e.g. the window-procs table) must be handled
conservatively. Screen capture happens immediately before each blocking key read, mirroring the
recorder. Never hand-patch async behavior in generated code.

### 2.6 Output stability (Phase 2 readiness)

Generated `js/` must be **deterministic and low-churn**:
- Same input → byte-identical output (test this).
- One JS file per C file, functions in source order, C names preserved. No global counters,
  hashes or traversal-order-dependent names in identifiers.
- Struct layouts and offsets as named constants in one place per struct, so a changed struct
  does not ripple through every file.
- No cross-file inlining or whole-program renumbering.
- Optionally carry C comments/line markers into the output (comment-only changes are free in
  the diff).

### 2.7 Lua

NetHack 5.0 runs special levels and dungeon descriptions through Lua; their randomness goes
through the core RNG (1.5). **Source (answered in Stage 1):** NetHack 5.0 uses **Lua 5.4.8**,
not vendored in the repo: the build downloads it (`make fetch-lua`) into `lib/lua-5.4.8/` and
builds `liblua.a` (32 files: core + standard libraries, `-O2 -DLUA_COMPAT_5_3
-DLUA_USE_MACOSX`). The open question is whether to **transpile the
Lua interpreter's C source with the same transpiler** (preferred: one method, faithful
semantics) and embed the `.lua` scripts as string data, versus an existing JS Lua
implementation (riskier: subtle semantic and RNG-order differences).

---

## 3. Staged workflow

| Stage | Who triggers | Output | Done when |
|---|---|---|---|
| **1. Investigate and design** | Owner asks | `method/design.md` | Design reviewed and approved by the owner |
| **2. Implement the transpiler** | Owner asks after approval | `transpiler/` + runtime + tooling | Transpiler unit/differential tests green; full NetHack transpiles without errors |
| **3. Run and iterate** | Owner asks | Generated `js/`, scores | Automated loop running; score climbing; no regressions |

Do not start a later stage without the owner's go-ahead.

### Stage 1: investigate the code, then write `method/design.md`

Investigate with tools, not by reading 443k lines end to end:

1. **Set up:** init the submodule, build the recorder (`nethack-c/build-recorder.sh`; in
   practice `tools/recorder-env/build-reference.sh`, see 1.7), record the exact clang command
   lines/defines used, and confirm the public sessions re-record byte-equal
   (`tools/recorder-env/verify-rerecord.mjs`). Done in Stage 1: 44/44.
2. **Inventory** (clang AST queries, script it and save outputs under `transpiler/out/`):
   - Files and line counts per directory (C vs Lua vs generated/data).
   - Counts and locations of every hard pattern from 2.2, plus `goto`, `setjmp`/`longjmp`,
     varargs, function pointers, bit-fields, `static` locals, global state, macros that expand
     to statements or declarations.
   - The libc and system calls actually used.
   - The call graph from `main`/`moveloop` to every blocking input function; size of the async set.
   - Every runtime data file the game opens and how it is generated (`makedefs`, Lua files).
   - Every PRNG call site per stream (core, display), plus Lua-script call sites.
3. **Hotspots:** group the unsafe sites by file and type. Read only those closely and propose a
   decision for each (auto-object, heap-backed, hand rewrite).
4. **Write `method/design.md`** containing at least:
   - Inventory summary tables and the hotspot list, with the propagated heap-backed type set and
     its size (the key feasibility number).
   - Implementation language and front end (e.g. libclang/`clang -Xclang -ast-dump=json` from
     Node or Python), with reasoning.
   - Memory model: object representation, pointer representation (object reference, array +
     index, heap address), and the boundary between object and heap worlds.
   - Translation rules per C construct; runtime/libc plan; async plan; Lua plan; data-file
     embedding plan; output layout under `js/` and how `jsmain.js`/`rng.js` glue it to the API.
   - Annotation file format and checker.
   - Test tooling plan (section 4) and the iteration loop.
   - Performance estimate against the 900-second session limit.
   - Risks, open questions for the owner, and a milestone plan with measurable exit criteria
     (e.g. "chargen screens match for all sessions").
   - An honest feasibility verdict. If the numbers say a pure transpiler is unrealistic, say so
     and propose the fallback.

### Stage 2: implement the transpiler

Build in this order, test-first: front end → analysis and annotations checker → runtime/libc
with differential tests → per-construct code generation with golden and differential tests →
async transform → whole-program emit → glue (`jsmain.js`, `rng.js` with the core and display streams and Lua call-site tags, data
embedding) → test tooling from section 4.

### Stage 3: run, test, improve (automated loop)

```
transpile → static checks → transpiler test suite → score → triage first divergences
     ↑                                                                  │
     └──────────────── fix the transpiler / runtime / annotations ──────┘
```

---

## 4. Test tooling (automated)

All tools live outside `js/` (e.g. `tools/` and `transpiler/`) and run headless from one entry
point (e.g. `npm run loop` / `node tools/loop.mjs`). Every run writes machine-readable results
to `results/<timestamp>/` and a short human summary.

| # | Tool | What it does |
|---|---|---|
| 4.1 | **Score runner** | Runs `frozen/score.sh` (overlays frozen files first), parses `__RESULTS_JSON__`, stores per-session screen/RNG scores, diffs against the previous run, and flags **any regression** loudly. |
| 4.2 | **First-divergence triage** | For each failing session: first mismatching RNG index, the C caller `func(file:line)` from the recording, the JS-side caller from our separate debug log (generated code knows its C origin), the last N matching calls for context, and the first mismatching screen step. Output groups failures by C function, so one root cause shows up as one item. |
| 4.3 | **Screen diff** | Uses `frozen/screen-decode.mjs` to print a cell-level diff (char/color/attr/cursor) of C vs JS at a given step. Works with `tools/session-viewer/`. |
| 4.4 | **Targeted session recorder** | Wraps `scripts/record-session.mjs` to record short sessions that exercise a specific subsystem or a hotspot, so failures can be isolated. These form our own extra test set (separate from `sessions/`). |
| 4.5 | **Transpiler differential tests** | A corpus of small C programs (one per construct and per hotspot pattern; plus extracted NetHack functions where feasible). Compile with clang and run natively; transpile and run in Node; compare output byte for byte. Includes integer-semantics and `sprintf` fuzzing against native C. |
| 4.6 | **Runtime unit tests** | `crt` helpers (integer ops, string functions, `qsort` from patch 002, time) tested against native results. |
| 4.7 | **Determinism and churn check** | Transpile twice and require byte-identical output. Report `git diff --numstat -- js/` against a baseline tag, to watch Phase-2-style churn. |
| 4.8 | **Annotation checker** | Fails on unsafe sites without a decision and on stale annotations. |
| 4.9 | **Static checks** | `node --check` on every generated file; import graph resolves; no forbidden APIs (`fs`, `child_process`, network, `WebAssembly`); frozen files untouched. |
| 4.10 | **Performance check** | Per-session wall time against the 900 s limit, with headroom. |

### Loop rules

- **Never hand-edit generated files in `js/`.** Fix the transpiler, the runtime or an
  annotation, then regenerate. Hand-written code is only allowed in the runtime and in the
  listed `js/hand/` escape hatches.
- **No special-casing sessions, seeds, roles or steps**, and no tables of expected values. Any
  such fix will fail on held-out sessions.
- **Root cause first:** fix the earliest divergence of the most-blocking C function before
  anything downstream. Do not chase easy screens.
- **No regressions:** a change that raises one session but lowers another is rejected unless the
  owner approves.
- **Skepticism (Bau's lesson 1):** if a proposed fix needs a new special mechanism to explain the
  data, stop and look for the simpler underlying bug.
- Keep a short `results/LOG.md`: date, change, score delta, root cause found.

---

## 5. Repository layout (target)

```
CLAUDE.md                 ← this file
METHODS.md                ← how the port was made (summary for readers)
method/                   ← method documents (NOT judged)
  design.md               ← Stage 1 output, with implementation updates (section 14)
  decisions.md            ← every lasting decision, with date and reason
  postmortem.md, trap-audit.md, readability-plan.md
transpiler/               ← transpiler source, annotations, analyzer (NOT judged)
  annotations.yaml
  out/                    ← inventory, unsafe report, call graphs
tools/                    ← test loop, triage, screen diff, recorders (NOT judged)
tests/                    ← C differential corpus, runtime tests (NOT judged)
results/                  ← per-run results + LOG.md (NOT judged)
js/                       ← judged: generated modules + runtime + glue + frozen files
  jsmain.js, rng.js       ← glue to the contest API
  crt/                    ← hand-written C runtime (semantics helpers, libc subset)
  hand/                   ← rare hand-written overrides, each listed in annotations
  isaac64.js, terminal.js, storage.js   ← FROZEN, never edit
frozen/, sessions/, nethack-c/, docs/   ← contest-provided; do not modify
```

## 6. Working conventions for Claude Code

- **Sources of truth.** Contest rules, API and scoring come from the repo's `README.md`,
  `docs/API.md`, `docs/PHASES.md` and `docs/recording-environment.md`: if this file and those
  disagree on rules or the API, those win. **Game behavior** (what the C program actually
  does: RNG streams, call order, screens) is decided by the **C source** (the patched tree
  the reference recorder builds) and the recordings it reproduces: if the docs describe
  behavior differently from the code, the code wins. Either way, point out the difference.
- When unsure about C behavior, write a tiny C test, compile it with clang, and check. Don't guess.
- Commit in small steps with clear messages. Keep generated `js/` in separate commits from
  transpiler changes so diffs stay reviewable.
- Report progress as numbers (screens matched, RNG %, sessions passed, regressions) plus the top
  root causes. No claims of "fixed" without a score run.
- Ask the owner before: changing the overall approach, adding hand-written overrides beyond a
  few, deleting large parts of the transpiler, or pushing to `main`.

## 7. Judge results

The official judge's scores for this fork, from the leaderboard data
(`https://mazesofmenace.ai/leaderboard/data.json`, our entry `name == "jrqc"`). Until the
Phase 1 freeze (2026-11-29 00:00 UTC), check it after every judge run (about every 2 hours)
and add a row **only when the score or the scored commit changed**. The judge does not
publish the commit it scored: the commit column is the latest commit on `origin/main` pushed
before `lastScored`. Unmatched = maximum points − points (public + held-out). Screen % and
PRNG % are given as public / held-out, as the leaderboard reports them. Rank is by total
points (public + held-out) within the `transpiled` category.

**Rule: at the start of every session** (no timers, no background polling), fetch the
leaderboard data, compare our entry with the last row below, and add a row if the score or the
scored commit changed. Do this until the Phase 1 freeze (2026-11-29 00:00 UTC).

**Playability.** `frozen/playability_runner.mjs` and the leaderboard page say the limit is
**5 ms/move**; the judge's data records `threshold_ms_per_move: 25` for every team (seen
2026-11-19). Hold ourselves to 5 ms **as measured by the judge**, whose machine measured
6.9 ms where ours measured 2.0 (about 3.4× slower): keep the local figure under about 1.4 ms.

| Scored (UTC) | Commit | Public | Held-out | Unmatched (pub + held) | Screen % (pub / held) | PRNG % (pub / held) | Rank (transpiled) | Note |
|---|---|---|---|---|---|---|---|---|
| 2026-11-19 00:50 | `9e66cf2` | 44/44 | 52/56 | 0 + 1,117 | 100 / 91.49 | 100 / 93.37 | 4 of 7 | First judged transpiled build (previous scored commit was the template skeleton: 15 points); analysis in `method/postmortem.md` |
| 2026-11-19 06:40 | `5a185bd` | 44/44 | 55/56 | 0 + 700 | 100 / 94.67 | 100 / 96.39 | 4 of 6 | F1 capture buffer + F2 regex: held-out +417 points, 3 more sessions pass; one held-out session still loses ~700 steps. Playability 6.88 ms/move on the judge |
| 2026-11-19 18:34 | `f63c072` | 44/44 | 56/56 | 0 + 0 | 100 / 100 | 100 / 100 | 1 (tied with 2 others) of 6 | F20 blank screens, traps A/B (one-past pointer on a lone record, stale save-file pointer), trap audit, fuzzing: every session passes, 24,531/24,531 points. Playability 6.57 ms/move on the judge |
| 2026-11-22 18:29 | `8a5bfb6` | 44/44 | 56/56 | 0 + 0 | 100 / 100 | 100 / 100 | 1 (tied with 2 others) of 6 | Docs-only commit (METHODS.md, method/); js/ changes comment-only. Judge startup 2,103 ms, playability 4.94 ms/move |
