# Readability and Phase 2 plan

Owner request, 2026-11-19. Moved out of the postmortem (`method/postmortem.md`, formerly
section 1A) on 2026-11-19. **Approved by the owner on 2026-11-22** with the additions marked
"(owner, 2026-11-22)" below. Status: in progress; results per step in "Progress" at the end.

Phase 2 scores `parity / (1 + lines_changed_in_js / N)`, with comment-only and whitespace-only
changes normalized out. Every line of generated code that encodes something incidental to the
C source (a line number, a renumbered constant, an inlined macro body) changes whenever 5.1
moves that incidental thing, so these are churn as well as readability problems. Figures are
for `js/nh` as generated on 2026-11-19 (about 246,000 lines, Lua excluded).

**Principle (owner, 2026-11-23).** The readers of `js/` are JavaScript developers. Generated
code is idiomatic JavaScript wherever that costs no fidelity (identical behavior, RNG and
screens, values checked against clang) and no extra churn (a C edit changes no more JS lines
than before); it keeps C names wherever they are needed to trace the code back to the C.

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
| P2 named constants | 2026-11-23 | see git log | 14,091 / 70 / 79 (ripple 76; 3 without it) | 44/44, tests 60/60, fuzz-regress 4/4 (one earlier run failed saves-128 on a recorder race, see LOG), batch 990/990 (seeds 10330-10439), sandbox 45/45, playability 2.03 ms/move, playcheck 44/44, determinism byte-identical | Enum constants from 53 `<header>.h.js` modules plus object-like `#define`s whose body is only numbers and operators; every name checked against clang's value. `onscary()` now reads `mons[PM_ANGEL]`, `M2_MINION`, `A_LAWFUL`, `G_UNIQ`, `ALTAR`, `SCR_SCARE_MONSTER`, `u.uprops[DISPLACED]`. Remaining monster churn (~13,800 of 14,091) comes from positional array initializers emitted with literal indices (`mons_init[1].pmidx = PM_KILLER_BEE`): see P2c |
| P3 macros as functions | 2026-11-23 | see git log | 14,101 / 62 / 79 (ripple 76; 3 without it) | 44/44, tests 60/60, fuzz-regress 4/4, batch 990/990 (seeds 10440-10549), sandbox 45/45, playability 2.03 ms/move, playcheck 44/44, determinism byte-identical | 630 header macros in 41 `<header>.macros.js` modules (28 async: their bodies reach a blocking function; every call awaited) plus .c-local macros; object-like integer constants (`TRUE`, `FALSE`) are P2 constants with clang's value. `onscary()` reads `is_rider(mtmp.data)`, `unique_corpstat(...)`, `is_vampshifter(mtmp)`, `u_at(x, y)`, `Displaced()`, `vobj_at(x, y)`. Generated code 281,717 -> 285,011 normalized lines (the function definitions) |
| P2c-1 tables as literals | 2026-11-23 | see git log | 295 / 62 / 79 (ripple 76; 3 without it) | 44/44, tests 60/60, fuzz-regress 4/4, batch 990/990 (seeds 10550-10659), sandbox 45/45, playability 2.05 ms/move, playcheck 44/44, tablecheck 547/547, determinism byte-identical | 547 initialized arrays as `$c.init(table, [...])` literals mirroring the C initializer (C text order, C line breaks, 160-column wrap); constants inside macro arguments now named too. Generated code 285,011 -> 243,740 normalized lines; monster churn 14,101 -> 295 (the rest: glyph offsets in display.js/display.h.js and detect.js that P2 could not name). `onscary()` unchanged |
| P2c-2 constant namespaces | 2026-11-23 | see git log | 289 / 62 / 79 (ripple 76; 3 without it) | 44/44, tests 61/61 (new: consts.test.mjs, 3,977 constants equal clang's), fuzz-regress 4/4, batch 990/990 (seeds 10660-10769), sandbox 45/45, playability 2.11-2.46 ms/move (tables build 2.15-2.52 in the same runs: no measurable cost), playcheck 44/44, tablecheck 547/547, determinism byte-identical | Enum and `#define` families with an upper-case prefix as namespace objects (`$c.cenum([...])` in C order, `Object.freeze({...})` for `#define` runs); `onscary()` reads `M2.MINION`, `A.LAWFUL`, `PM.ANGEL`, `S.HUMAN`, `S.VAMPIRE`. A `#define` joins a namespace only if object-world code expands it and no other header defines it (the consts test caught winami.h's inactive `NHW_BASE 6`). A name blocks a namespace if a macro of that name is invoked in function code: `G` stays flat (`G_GENO`) because of nhmd4.c's `G(x, y, z)`. Locals named like a namespace get a `$` suffix (`P$`, 9 uses). Generated code 243,740 -> 244,112 normalized lines |
| P4 C comments and notices | 2026-11-23 | see git log | 289 / 62 / 79 (ripple 76; 3 without it) | 44/44, tests 61/61, fuzz-regress 4/4, batch 990/990 (seeds 10770-10879), sandbox 45/45, playability 2.11-2.15 ms/move, playcheck 44/44, tablecheck 547/547, determinism byte-identical; after comment and whitespace normalization every changed js/ file equals the P2c-2 build except one table line in botl.js (a field-name search no longer runs past the initializer's end) | 31,374 of 32,536 C comments carried (96%), placed by source offset (transpiler/emit/comments.mjs): before the next statement, a statement's own and its condition's comments before it, a one-line comment after a statement or a condition at the end of that JS line, end-of-block comments before the closing brace, table and record-initializer comments by C line. Not carried: comments on preprocessor lines and prototypes, functions not emitted, Lua's heap-world opcode table. Every module starts with its C file's notice (NetHack, Lua plus lua.h's MIT notice, TRE plus its LICENSE, Apple's APSL headers); aggregate and data modules carry a NetHack notice. `onscary()` gains its C comments (24 -> 50 lines). Generated code 244,112 -> 244,111 normalized lines |
| Fortify names | 2026-11-23 | see git log | 289 / 62 / 79 (ripple 76; 3 without it) | 44/44, tests 61/61, fuzz-regress 4/4, batch 990/990 (seeds 10880-10989), sandbox 45/45, playability 2.05 ms/move, playcheck 44/44, determinism byte-identical | All 3,029 macOS fortify calls (`__builtin___sprintf_chk(buf, 0, objsize, fmt, ...)`, `__builtin___strcpy_chk(d, s, objsize)`, ...) emitted as the C writes them: `$c.sprintf(buf, fmt, ...)`, `$c.strcpy(d, s)`, `$hl.memcpy(...)` (tu.mjs unfortify; heap calls into the object-world runtime keep the prototype's parameter types). The dropped flag and object-size arguments have no side effects; the plain runtime functions trap on a write past the destination, so an overflow, where Darwin aborts, still traps. `onscary()` unchanged (no such calls) |

### P2c: constant namespaces and table literals (owner direction 2026-11-23; approved 2026-11-23)

Supersedes the P2 instruction "imported bindings (`mons[PM_ANGEL]`), not `PM.PM_GIANT_ANT`"
(owner, 2026-11-22): the new form strips the prefix, `mons[PM.ANGEL]`. The conversion is a
one-time change before the Phase 1 tag, so it costs nothing in the Phase 2 diff.

Measured on the P3 build (4,110 named constants: 2,910 enum, 1,200 numeric
`#define`; 70,603 references in object-world code).

**Approved (owner, 2026-11-23):** merge families that share a prefix; lower-case families stay
flat; tables first as their own step, then the namespaces, each checked, committed and pushed
separately; long C lines wrap at 160 columns inside their element; editor completion for the
`cenum` namespaces from one generic JSDoc signature on `$c.cenum` in the runtime (TypeScript
>= 5.0 infers the member names), no per-namespace `@type` comments (go-to-definition on a cenum
member then finds nothing; tested with VS Code's TypeScript 6.0.3); a one-line header comment
in each constants module states the flat-vs-namespace rule; playability re-measured after the
namespace step.

**Rule.**

1. *Family.* A family is one C enum declaration, or one run of consecutive numeric object-like
   `#define`s in one header. Its prefix is the longest prefix ending in `_` that at least two
   and at least 80% of its members share (`PM_` for `monnums`, `M_AP_` for `m_ap_types`,
   `M2_` for the `M2_*` flag run).
2. *Namespace.* A family whose prefix starts with an upper-case letter becomes a namespace
   named after the prefix without its `_`: `PM_ANGEL` → `PM.ANGEL`, `M2_MINION` → `M2.MINION`.
   The mapping is mechanical both ways, so every name still greps to its C name.
3. *Merging.* Families with the same prefix form one namespace, as they share one prefix in C:
   `A` holds `attrib_types` (`A.STR` … `A.CHA`) and the alignment `#define`s (`A.LAWFUL`); `S`
   holds `mon_syms` (`S.HUMAN`) and `cmap_symbols` (`S.vwall`); `P` holds skills and skill
   levels. A merged namespace is defined in the header that declares most of its members
   (ties: path order). There are no member name clashes.
4. *Stays flat, C name.* (a) Enums without a shared prefix: `objects_nums` (`BOULDER`,
   `SCR_SCARE_MONSTER`), `prop_types` (`BLINDED`, `FIRE_RES`), `levl_typ_types` (`ALTAR`),
   `*_CLASS`, trap, room and material types. Inventing a namespace (`PROP.BLINDED`) would
   add a name the C does not have. (b) Members outside the family prefix: `NUMMONS`, `NON_PM`,
   `MAX_GLYPH`, `MAXPCHARS`. (c) Standalone constants: `TRUE`, `FALSE`, `COLNO`, `ROWNO`,
   `BUFSZ`. `TRUE`/`FALSE` stay the C ints 1/0, not JS `true`/`false`: C stores them in int
   fields, compares and adds them, and JS booleans would change both. (d) Lower-case
   prefixes (`opt_`, `se_`, `bl_`, `set_`: 31 families, 599 constants): they read as C
   identifiers and collide with locals. (e) A namespace name that is already a global C name
   (`ARM`, `TREE`, `SICK`, `MR`, `AS`, `BC`, `DISP`, `ONAME`): that family stays flat
   (`ARM_SUIT`, `MR_FIRE`). (f) Members whose short name would not be an identifier
   (`CLICK_1`).
5. *Shadowing.* A C local or parameter with a namespace's name (`P` in `readobjnam`, `D`, `H`)
   is renamed `P$` in that function only.
6. *Form.* Enums keep C's implicit numbering, so inserting a constant changes one line:
   ```js
   export const PM = $c.cenum([      // enum monnums
       'GIANT_ANT',                  // 0; a name alone is the previous value + 1
       'KILLER_BEE',
       ...
   ]);
   export const GLYPH = $c.cenum([
       ['MON_OFF', 0],               // explicit C initializers: [name, value]
       ['PET_OFF', (e) => NUMMONS + e.MON_OFF],
       ...
   ]);
   ```
   `#define` families are frozen object literals with the C text's values (suffixes removed):
   `export const M2 = Object.freeze({ NOPOLY: 0x00000001, UNDEAD: 0x00000002, ... });`
   Header modules still import nothing (no import cycles); a value that would need an import
   keeps its number, as in P2. The heap world (Lua, regex) keeps numbers.
7. *Tables.* Initialized arrays of records (`mons_init`, `objects`, `allopt_init`, `roles`,
   `artilist`, `extcmdlist`, `colortable`, `monsdump`, ...: about 47,000 lines of indexed
   assignments today) become array literals that mirror the C initializers. Each element is an
   object with the fields the C initializer writes, in C text order, broken into lines where
   the C breaks them, so a C edit to one line changes one JS line. An all-zero element (C
   `NO_ATTK`) is `{}`. Field values go through the same conversions as today; constants are
   named by this rule.

Coverage: 179 namespaces hold 2,240 constants and receive 31,492 of the 70,603 references
(45%); 1,870 constants stay flat (the most used: `TRUE` 4,735, `FALSE` 4,401, `BOULDER` 372,
`NON_PM` 341, `FLYING` 340, `WEAPON_CLASS` 281, `BLINDED` 196).

**Examples** (sketches of the intended output, not generated yet).

`onscary()`, P3 build → proposed:
```js
$c.andu64(mtmp.data.mflags2, M2_MINION) !== 0 && mon_aligntyp(mtmp) === A_LAWFUL || $c.peq(mtmp.data, $c.relem(mons, PM_ANGEL))
$c.andu64(mtmp.data.mflags2, M2.MINION) !== 0 && mon_aligntyp(mtmp) === A.LAWFUL || $c.peq(mtmp.data, $c.relem(mons, PM.ANGEL))
mtmp.data.mlet === S_HUMAN            →  mtmp.data.mlet === S.HUMAN
svl.level.locations[x][y].typ === ALTAR && mtmp.data.mlet === S_VAMPIRE   →  ... === ALTAR && ... === S.VAMPIRE
sobj_at(SCR_SCARE_MONSTER, x, y), return FALSE, Displaced()   (unchanged: no family prefix / standalone)
```

`mons_init[1]` (46 lines of `mons_init[1].geno = 98;`, `mons_init[1].mflags1 = 268705793;`) →
```js
    { pmnames: [null, null, $c.lit("killer bee")], mlet: S.ANT,
      mlevel: 1, mmove: 18, ac: -1, mr: 0, maligntyp: 0, geno: G.GENO | G.LGROUP | 2,
      mattk: [{ aatyp: AT.STNG, adtyp: AD.DRST, damn: 1, damd: 3 },
          {}, {}, {}, {}, {}],
      cwt: 1, cnutrit: 5, msound: MS.BUZZ, msize: MZ.TINY, mresists: MR_POISON, mconveys: MR_POISON,
      mflags1: M1.ANIMAL | M1.FLY | M1.NOHANDS | M1.POIS, mflags2: M2.HOSTILE | M2.FEMALE, mflags3: 0,
      difficulty: 6, mcolor: CLR.YELLOW, pmidx: PM.KILLER_BEE },
```
for the C
```c
    MON(NAM("killer bee"), S_ANT,
        LVL(1, 18, -1, 0, 0), (G_GENO | G_LGROUP | 2),
        A(ATTK(AT_STNG, AD_DRST, 1, 3),
          NO_ATTK, NO_ATTK, NO_ATTK, NO_ATTK, NO_ATTK),
        SIZ(1, 5, MS_BUZZ, MZ_TINY), MR_POISON, MR_POISON,
        M1_ANIMAL | M1_FLY | M1_NOHANDS | M1_POIS, M2_HOSTILE | M2_FEMALE, 0,
        6, CLR_YELLOW, KILLER_BEE),
```

**Tests.** (1) `tests/transpiler/consts.test.mjs`: generates a C program that includes the
headers with the recorder's flags and prints every named constant (namespace members and flat
ones), compiles it with clang, runs it, and requires each value to equal the JS module's value.
(2) A table test: every record of every converted table equals, field by field, the record the
current indexed-assignment emitter builds (kept behind an option for the test). Plus the usual
checks after the step.

**Expected churn.** Monster benchmark from 14,101 to roughly the new monster's own lines (about
10 in `monst.js`, one in `monsters.h.js`, one in `earlyarg.js`); field and `y_n` unchanged.
Performance: property loads on frozen module-level objects instead of bindings; measured by the
playability check.
