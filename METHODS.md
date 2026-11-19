# Methods: NetHack 5.0 → JavaScript with a hybrid transpiler

## 1. Summary

This fork ports NetHack 5.0 to JavaScript by **transpiling the C source with our own tool**, not by
hand-porting or compiling it to a machine-like target. The transpiler emits one readable JavaScript
module per C file. Data structures become plain JavaScript objects wherever the C allows it; the few
places where the C treats memory as raw bytes run on a C-exact byte heap behind accessor wrappers.
The same transpiler also translates the Lua 5.4.8 interpreter and Apple's POSIX regex library.

The work was done by one person directing two AI assistants with a strict division of labor (section 3),
and verified mainly by **differential testing against the C recorder** (section 5). From the first
commit (2026-11-18 04:35 UTC) to a perfect judge score (2026-11-19 18:34 UTC) took about 38 hours;
the port reached 100/100 without ever seeing a held-out session, fixing only problems found by its
own analysis and testing.

| Result | Value |
|---|---|
| Judge result (2026-11-19 18:34 UTC, commit `f63c072`) | **100/100 sessions, 0 of 24,531 screens unmatched, PRNG and screens 100%** |
| Public sessions | 44/44 (11,405/11,405 screens, 792,838/792,838 RNG calls) |
| Held-out sessions | 56/56 (13,126/13,126 screens) |
| Random differential cases | 3,580 in the four reported runs (plus 68 smoke and trial cases), 4 failures from 3 root causes, all fixed |
| Determinism | Two transpiles produce byte-identical output |
| Hand-written game code | 3 overrides, about 190 lines (`js/hand/nhlua.js` 49, `js/hand/files.js` 71, the `nh_deterministic_qsort` part of `js/crt/qsort.js` 67); the C runtime `js/crt/` is a further 4,058 hand-written lines |

## 2. Key decisions

| Decision | Alternatives considered | Why |
|---|---|---|
| **Transpile, don't hand-port** | Agent-assisted port of the contest skeleton | A transpiler's cost depends on the C features used, not on the size or complexity of the game logic. It translates mechanically, so it can't invent workarounds, which is how the organizer's own first attempt failed. |
| **Our own transpiler, not Emscripten** | `emcc -sWASM=0` (wasm2js) | Compiled output is unreadable and regenerates almost entirely when the C changes, which the Phase 2 diff penalty punishes. Emscripten also targets 32-bit `long` and musl libc, while the recordings use 64-bit `long` and Darwin libc. |
| **Hybrid memory model** | All data in one byte heap; all data as objects | Objects keep the code readable and debuggable. A byte heap is needed only where C reinterprets memory. Stage 1 measured how far the byte-level requirement spreads before committing (section 4.2). |
| **Analyze before designing** | Design first, discover later | Stage 1 inventoried every hard C pattern with clang before any design was approved (section 3.2). |
| **Don't use the skeleton's game logic** | Build on the provided skeleton | A transpiler replaces it wholesale. We kept only what the contract requires: the frozen files and the `runSegment` API. |
| **Loud failures during development** | Silent best-effort translation | Unsupported constructs trap with a named error instead of producing a wrong value. A later audit (section 5.5) removed every trap on legal C. |
| **Source of truth** | Contest docs | Contest docs win on rules and API; **the C source wins on game behavior**. Stage 1 found places where they disagree (section 7). |

## 3. Workflow

### 3.1 Roles

| Role | Who | Responsibilities |
|---|---|---|
| Owner | Gürbüz Demiroğlu | Goals, approvals, every decision with lasting consequences, pushes during freeze windows |
| Planning and review assistant | Claude (chat) | Reading the contest material, drafting the standing brief, reviewing reports and designs, challenging claims, turning decisions into precise instructions |
| Implementation agent | Claude Code | Investigation, design documents, the transpiler, runtime, tests and fixes, under the rules in `CLAUDE.md` |

The two assistants never talk to each other directly. The owner carries reports from the
implementation agent to the reviewer and decisions back, which keeps a human in every loop.

### 3.2 Stage gates

| Stage | Output | Gate |
|---|---|---|
| 1. Investigate | Inventory of C patterns, call graphs, recorder setup, `method/design.md` with a feasibility verdict | Owner approves the design and decisions D1–D7 |
| 2. Implement | Transpiler, runtime, glue, test tooling | Full NetHack transpiles; public sessions pass |
| 3. Iterate | Judge results, postmortem, fuzzing, fixes | No regressions; every fix at its root cause |

No stage started without the owner's approval. Decisions are recorded with their reasons in
`method/decisions.md`.

### 3.3 The standing brief

`CLAUDE.md` holds everything the implementation agent must know in every session: contest rules, the
API contract, the recording environment, the chosen approach, the test loop, the results table and
working rules. It was written from the contest repository before any code existed, then corrected
whenever investigation proved it wrong. Stage 1 corrected it in five places in one commit (`6307e81`): two RNG streams, not three; the contest's recorder build does not reproduce the sessions; patch 002 wraps Darwin's `qsort` rather than defining an algorithm; the pinned time's daylight-saving quirk; where Lua's source comes from (section 7).

### 3.4 Working rules

- Never hand-edit generated files in `js/`. Fix the transpiler, runtime or an annotation, then regenerate.
- No special-casing of sessions, seeds, roles or steps. A fix must explain the C behavior.
- Root cause first: fix the earliest divergence.
- No regressions: every change keeps 44/44 and determinism.
- Optimize for a faithful port, not for the hidden test sessions. Tests are evidence, not the target.
- Be skeptical of explanations that need a special mechanism (the organizer's lesson from his own attempt).

## 4. Architecture

### 4.1 Pipeline

```
patched NetHack C (same flags as the recorder)
  → clang AST (JSON)
  → analysis: unsafe-pattern inventory, async set, annotations check
  → C type layer → emitter → js/nh/*.js (one module per C file)
  + js/crt/  (hand-written C runtime)
  + js/hand/ (rare hand-written overrides, each registered with a source hash)
  + glue: jsmain.js (runSegment), browser play
```

The transpiler sees exactly the preprocessed source the recorder was built from: the same patches,
defines and hints. It is about 4,150 lines (front end 204, type layer 515, emitter 3,239, annotation
checker 194), or 5,523 with the Stage 1 analysis scripts.

### 4.2 Memory model

| Data | Representation | Why |
|---|---|---|
| Most NetHack structs | Plain JavaScript objects | Readable; nothing treats them as bytes |
| Unions used for type punning (`any`, `vptrs`, `vlaunchinfo`, `customization_content`) | "Union cells" that keep C's bytes | Code writes one member and reads another |
| `struct engr` (text stored after the struct) | An object with a trailing byte area (decision D4), matching C's truncation | Avoids a byte-level type for one trick |
| 2-D arrays reached by pointer arithmetic across rows | Flat typed arrays with row views; record arrays with row back-references | C memory is contiguous |
| The Lua interpreter | A C-exact byte heap | Raw memory throughout |
| Save files | Per-type serializers | Saves never cross between C and JavaScript |

The decision is **per data type, not per function**: a type has exactly one representation.
Stage 1 measured the consequence before committing: if unions are handled as union cells, only one
of NetHack's 345 struct types needs byte-level storage.

### 4.3 C semantics

All semantic-gap handling lives in the runtime, tested against native results: exact integer
arithmetic, 64-bit values, clang's evaluation order (with temporaries where JavaScript's order
differs), struct copy semantics, byte-exact `printf`, Darwin's `qsort` (one comparator draws random
numbers), pinned time including the recorder's daylight-saving quirk, and the `xterm-256color`
terminal capabilities the recorder ran with.

### 4.4 Blocking input

C blocks in `tty_nhgetch()`; JavaScript must `await`. The async set is computed from the
transpiler's own call graph, rooted at `getchar`, `tty_nhgetch` and `tty_delay_output`: 4,484
of 7,302 functions. Every `await` sits inside an async function by construction, and the transpiler checks
this. Nothing about async behavior is patched by hand.

### 4.5 Reusing the transpiler

- **Lua 5.4.8:** transpiled whole in byte-heap mode, with a generated bridge to the object-based code
- **POSIX regex:** NetHack's option parsing needs `regcomp`/`regexec`. Instead of writing an engine,
  we vendored Apple's own source (Libc-1752.120.2) and transpiled it. It agrees with the system
  regex on 80,418 test cases.

## 5. Verification

### 5.1 Layers

| Layer | What it checks |
|---|---|
| Public sessions | All 44, every screen and RNG call, after every change |
| Determinism | Two transpiles are byte-identical |
| Runtime differential tests | Integer ops, `printf`, `qsort`, time, regex against native Darwin results |
| Sandbox run | The scorer under Node's permission model, as the judge runs it |
| Browser playback | The first segment of each public session replayed through the interactive path (`tools/playcheck.mjs`); the frozen playability runner times all of them |
| Fuzz regressions | Every fuzz case that ever failed, re-recorded and replayed |
| **Random differential testing** | Section 5.3 |
| **Trap audit** | Section 5.5 |

### 5.2 The recorder as an oracle

The contest's C recorder was built locally and checked: all 44 public sessions re-record
byte-identically. That turned the recorder from a fixed answer key into a test generator: any input
can be recorded in C and compared with the port.

### 5.3 Random differential testing

Each case generates a random game recipe, records it with the C recorder and scores the port with
the judge's own runner. Generators:

| Kind | Targets |
|---|---|
| `opts` | Random config files, including regex-based options |
| `play` | Random commands with prompt answers |
| `meta` | Meta keys as ESC sequences and 8-bit bytes, `altmeta`, `number_pad` |
| `deep` | Wizard-mode trips into Gehennom |
| `bones` | Dying, then loading the bones level in a new game |
| `saves` | Chains of save and restore |
| `long`, `longopts` | Games of 1,500–4,000 keys, with and without random options |
| `special` | Named special levels, with save and restore on them |

Seeds rotate so no case repeats. Every batch logs the levels it reached (`results/fuzz/BATCHES.md`).
Coverage after batch 2: 121 distinct levels and 43 special levels, including all four Sokoban
levels, Vlad's Tower, quest levels, Gehennom down to the Sanctum, and the Elemental and Astral
Planes. Not yet reached: Fort Ludios and the ordinary Gnomish Mines filler levels (only Minetown and
Mines' End).

### 5.4 Results

| Run | Cases | Failures | Root causes |
|---|---|---|---|
| First run | 300 | 1 | F20: the runner skips empty recorded screens |
| Second run | 1,000 | 3 | A one-past-the-end pointer on a single struct; a stale pointer compared during restore |
| Long and special | 300 | 0 | — |
| Rotating batches 1–2 | 1,980 | 0 | — |

The next judge run after these fixes scored 56/56 on the held-out sessions. The judge does not say
which held-out session failed or why, so we cannot prove the fuzz bugs were the ones costing the
held-out points; the timing makes it plausible. Either way it supports the approach: aim at
fidelity, and the hidden results follow.

### 5.5 Trap audit

Two of the three fuzz root causes (the third, F20, was in how screens are aligned for scoring) were traps on **legal C**: the port was stricter than the language. Instead of
waiting for fuzzing to hit the rest, we classified every trap in the runtime:

| Class | Sites | Action |
|---|---|---|
| Legal C the port didn't support | 19 constructs (2 found by fuzzing, 17 by the audit) | Fixed: one-past pointers, cross-row pointer differences, partial-record `memcpy`/`memcmp`, more `printf` conversions, object-world `setjmp`, pre-1955 time zones |
| Undefined behavior, or C aborts too | 39 | Kept |
| Internal consistency checks | 31 | Kept |
| One block used as two types | 3 | Kept, documented; never hit |
| Memory limits, invalid input | 5 | Kept |

A checker now fails the build on any new trap without a classification.

## 6. Timeline

| Date (2026) | Milestone | Public | Held-out |
|---|---|---|---|
| Before Nov 18 | Contest read; approach chosen; standing brief written (not in the git history) | — | — |
| Nov 18, 04:35 UTC | First commit: Stage 1 investigation starts | — | — |
| Nov 18, about 13:30 UTC | Stage 1 design and decisions D1–D7 approved | — | — |
| Nov 18, 17:40 UTC | First end-to-end run (`e5acdec`) | 17/44 | — |
| Nov 18 | Root-cause fixes: `struct engr` trailing area, union cells, postfix `++`, pointer ordering, save/restore, `memset`, score files | 44/44 | — |
| Nov 19, 00:50 UTC | First judge result (`9e66cf2`) | 44/44 | 52/56 (1,117 screens lost) |
| Nov 19, 06:40 UTC | Capture buffer (F1), regex (F2) (`5a185bd`) | 44/44 | 55/56 (700 screens lost) |
| Nov 19, 18:34 UTC | Fuzzing, F20, traps A and B, trap audit (`f63c072`) | 44/44 | **56/56 (0 screens lost)** |

## 7. What went wrong, and what we learned

| Finding | Lesson |
|---|---|
| Traps on legal C (pointer one past a single object, comparing a stale pointer) end a segment where C continues; they plausibly cost the last held-out points (the judge does not say) | A safety net that's stricter than C costs real sessions. Audit traps against the language, not just against tests. |
| The capture buffer came from an older recorder patch version than the held-out recordings needed | The test environment is part of the specification. Public sessions only prove fidelity to the environment they were recorded in. |
| Regex was skipped because no public config used it | "Untested" is not "unused." Hidden tests probe exactly the paths the public ones skip. |
| The runner silently skips empty recorded screens, documented nowhere | Read the scorer's code, not just its docs. |
| Contest docs were wrong in places: `prevGame` is never passed, there is no separate Lua RNG stream, 6 patches not 8 | When docs and code disagree, the code is right. |
| The recorder's environment leaks into recordings: real-clock daylight-saving flag, the organizer's `$HOME` path, a missing config file | Reproduce the recorder first, byte for byte, before porting anything. |
| Held-out failures fell from 4 to 1 to 0 by fixing findings from our own analysis and fuzzing, never by guessing at the hidden sessions | Generality comes from testing the port against the real program, not from optimizing for a benchmark. |

## 8. Phase 2 readiness

Phase 2 scores parity on a newer NetHack divided by the number of changed `js/` lines. With a
transpiler, retargeting means re-running it on the new C, so the question is how much the output
changes when the input changes.

- **Already in place:** one module per C file, source order preserved, deterministic output, the
  transpiler and annotations outside `js/` (where changes cost nothing).
- **Known churn sources, planned before the freeze:** numeric constants instead of names, C line
  numbers in emitted RNG logging, expanded macros, dropped comments. Plan:
  `method/readability-plan.md`.

## 9. Limitations

- The port's screen capture is transpiled from the recorder's capture patch, so the port contains
  test-harness code, not just NetHack.
- The generated code is readable but noisy (section 8).
- Startup takes about 2.8 s on the judge (2,768 ms), the second slowest of 26 entries, though speed isn't ranked.
- Not yet built: function-level differential tests (milestone M2, `method/design.md` 12.3 and 14.11),
  C coverage measurement, a bounds-check build, an uninitialized-read audit, native run-to-run
  stability and wider libc fuzzing (postmortem T4, T5, T8, T9, T11, T12).
- Known low risks: the regex library version used by the organizer's machine (F19), uninitialized
  locals (F8). Details: `method/postmortem.md`.

## 10. Reproducing

From the repository root:

```bash
git submodule update --init
bash tools/recorder-env/build-reference.sh      # build the reference C recorder
node tools/recorder-env/verify-rerecord.mjs     # 44/44 byte-identical re-recording
node transpiler/emit/run.mjs                    # transpile into transpiler/build/nh
# copy transpiler/build/nh/*.js to js/nh/, except isaac64.js (the frozen js/isaac64.js is used)
bash frozen/score.sh                            # score the public sessions (or node tools/score.mjs)
node tools/fuzz/batch.mjs --n 110 --jobs 8      # one rotating fuzz batch
cd transpiler
npm test                                        # unit, differential and own-session tests
npm run sandbox                                 # judge-like sandbox run
npm run fuzz-regress                            # replay every past failure
```

## Further reading

| Document | Contents |
|---|---|
| `CLAUDE.md` | The standing brief for the implementation agent |
| `method/design.md` | Stage 1 design and its updates |
| `method/decisions.md` | Every decision with lasting consequences, with dates and reasons |
| `method/postmortem.md` | Analysis of the first judge result |
| `method/trap-audit.md` | The trap classification |
| `method/readability-plan.md` | Readability and Phase 2 churn plan |
| `transpiler/out/` | Generated reports: Stage 1 findings, inventory, unsafe-pattern and union reports |
| `results/` | Score log and fuzz batches |
