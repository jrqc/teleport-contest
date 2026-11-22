# Readability and Phase 2 plan

Owner request, 2026-11-19. Moved out of the postmortem (`method/postmortem.md`, formerly
section 1A) on 2026-11-19. **Approved by the owner on 2026-11-22** with the additions marked
"(owner, 2026-11-22)" below. Status: in progress; results per step in "Progress" at the end.

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
   `export const PM_GIANT_ANT = 0;`) and reference it by an **imported binding**, so the code
   reads like the C: `mons[PM_ANGEL]`, not `PM.PM_GIANT_ANT` (owner, 2026-11-22). A renumbering then changes one line per constant in one file. Exceptions,
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
   to its arguments, and it does not depend on the caller's local names. **A macro whose body
   can reach a blocking function becomes an `async` JS function, and its calls are awaited**
   (owner, 2026-11-22): it joins the async set like any function, so the equivalence covers the
   `await` as well. Other sites keep the expansion. Property macros (`Blind`, `Levitation`, …) and predicates (`IS_POOL`, `rn1`)
   qualify. Check: score, and the count of expansion sites converted.
4. **P4, comments.** Carry C comments from the source text (clang's AST omits most of them):
   attach each comment to the next emitted statement by source location. Free in Phase 2.
   **License headers** (owner, 2026-11-22): every generated file starts with the license notice
   of the C file it comes from (NetHack General Public License for NetHack, the MIT notice for
   Lua, Apple's/TRE's notices for the regex sources), as a comment.
5. **P5 (optional, after P1-P4; owner, 2026-11-22), wrapper reduction.** Emit plain JS where a
   runtime wrapper is provably a no-op at that site (for example `$c.i8(...)` around a value
   already known to be 0 or 1, `$c.peq(a, b)` where both sides are records or null, so `===`
   is exact, `$c.relem(mons, PM_ANGEL)` where a record reference does the same). Every
   rewrite needs the same kind of exactness proof as P3.

Order (owner, 2026-11-22): baseline churn numbers first, then P1, P2, P3, P4, then P5 if time
allows. Each step is a separate transpiler commit plus a generated commit.

**Checks after each step** (owner, 2026-11-22): 44/44 public sessions, `npm test`,
`npm run fuzz-regress`, one fuzz batch, the sandbox run, playability, byte-identical
determinism (two transpiles), the churn benchmark, and the generated `onscary()` before and
after. Then commit and push.

**Churn benchmark** (`tools/churn/bench.mjs`; owner, 2026-11-22). Three edits to the C, applied
through a clang VFS overlay (the recorder tree is not touched), each transpiled and compared with
an unmodified transpile, counting changed `js/` lines the way the Phase 2 judge does (added +
deleted, comment-only and whitespace-only changes normalized out):
- **monster**: a new monster inserted early in `monsters.h` (renumbers every later `PM_*`);
- **field**: a new field in the middle of `struct monst`;
- **yn**: a `yn()` call inside a deep non-async function; the **async ripple** (lines that
  change only because functions became `async` or calls `await`) is reported separately.

**Rendering without the capture layer (owner request, longer term; deferred by the owner until after the Phase 1 freeze, 2026-11-22).** Today screens come from
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

## Progress

| Step | Date | Commit | Churn: monster / field / yn (async ripple) | Checks | Notes |
|---|---|---|---|---|---|
| Baseline | 2026-11-22 | `8a5bfb6` | 17,690 / 70 / 123 (ripple 76; 4 functions became async) | determinism byte-identical | 275,754 normalized lines; monster churn is mostly `monst.js` (11,514: the `mons[]` initializers are indexed by position) |
| P1 RNG caller tags | 2026-11-22 | see git log | 17,690 / 70 / 79 (ripple 76; 3 without it, was 47) | 44/44, tests 60/60, fuzz-regress 4/4, batch 990/990 (seeds 10220-10329), sandbox 45/45, playability 2.14 ms/move, determinism byte-identical | 2,545 tagged sites now plain calls (2,634 lines changed once); `onscary()` unchanged (no RNG calls). Triage keeps naming C callers from the recordings (it never read the JS tags), so no source map was needed |
