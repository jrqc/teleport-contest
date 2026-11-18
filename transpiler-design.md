# Transpiler design: NetHack 5.0 → JavaScript

Stage 1 output (CLAUDE.md section 3). Status: **draft for owner review**. Nothing in Stage 2 starts
before approval. All numbers come from `transpiler/out/stage1-findings.md`, which also lists the
commands that regenerate them. Open decisions for the owner are marked **[DECISION]** and collected
in section 12.

## 1. Scope, inputs and the numbers that drive the design

### 1.1 What is transpiled

The input is the **patched, configured tree that the reference recorder builds**
(`tools/recorder-env/build/nethack-c/recorder/`, from `tools/recorder-env/build-reference.sh`),
not raw upstream. It is the only tree known to reproduce all 44 public sessions byte for byte.
The translation units are exactly the ones linked into the recorder binary
(`transpiler/out/compile_commands.json`, generated from the recorder's make rules), compiled
with the recorder's flags:

| Group | TUs | Lines (.c) | Flags |
|---|---|---|---|
| NetHack core, tty window port, unix glue | 140 | 261,506 | `-g -I../include -DNOTPARMDECL -DNO_TIMED_DELAY` |
| Lua 5.4.8 (`liblua.a`: core + standard libraries) | 32 | 23,274 | `-O2 -Wall -Wextra -DLUA_COMPAT_5_3 -DLUA_USE_MACOSX` |
| Headers (NetHack `include/`, Lua `*.h`) | — | 36,507 | — |
| Data: `dat/*.lua` scripts and text data files | 131 + 20 | 17,223 (Lua) | embedded, not transpiled |

Patches 001–006 are part of the input, so their behavior (pinned clock, RNG caller tags, screen
capture at input boundaries) is transpiled along with the game. That is deliberate: the JS port
then produces the same RNG caller tags and captures at the same points as the recorder.

### 1.2 Numbers that drive the design

| Question | Measured | Consequence |
|---|---|---|
| How much code? | 6,592 functions (NetHack 5,533, Lua 1,059), 65k call sites | Too much to hand-port; generation must be complete and mechanical |
| How much needs async? | 3,349–4,467 functions (51–68%) | Async is the normal case, not the exception; must be computed, never hand-patched |
| Which types must be byte-level? | NetHack: 104 → 37 → 23 → **1** depending on decisions (section 3.5); Lua: 20–40 | Readable object code is feasible for NetHack; Lua is raw memory throughout |
| Hard sites in NetHack | 1,481 after excluding string handling; unions dominate | A small number of rules covers most of them |
| `goto` | 536 in 172 NetHack functions, 117 + 78 computed in Lua | Needs a general goto lowering, not pattern matching |
| `setjmp`/`longjmp` | 4 sites (Lua errors, Lua step limit) | Exceptions |
| RNG | 2 ISAAC64 streams; 5,444 core call sites | Exact reproduction of `rnd.c` plus the frozen `isaac64.js` |
| Speed budget | Longest session: 1.25 s in C; limit 900 s | Up to ~100× slower than C is acceptable (section 11) |

### 1.3 Non-goals

- Byte compatibility of save and bones files with C. They only travel from one JS segment to
  the next through `input.storage`, so any faithful JS serialization works (section 3.6).
- Window ports other than tty, platforms other than the recorder's (macOS, Darwin libc).
- "Fixing" anything: bugs, unspecified behavior and Darwin libc quirks are reproduced as the
  recorder resolves them.

## 2. Front end and implementation language

**Choice: Node.js (plain ES modules), driving `clang -fsyntax-only -Xclang -ast-dump=json`,
with the recorder's exact compile commands.** This is already built and tested in Stage 1
(`transpiler/frontend/`): all 172 TUs parse, in 36 s, with locations resolved.

Reasons:

- **Same compiler as the recorder.** The AST comes from the same Apple clang 17 with the same
  flags and headers, so macro expansion, `sizeof`, struct layout, implicit conversions and
  constant folding are exactly what the recorder binary was built from. No second C parser to
  disagree with clang.
- **Full semantic information.** The JSON AST carries resolved types, implicit casts
  (`IntegralCast`, `LValueToRValue`, `BitCast`, ...), referenced declarations, and both
  spelling and expansion locations for macros (needed for RNG caller tags and readable output).
- **One language for tooling and output.** Transpiler, runtime, tests and the scoring harness are
  all JS; runtime helpers can be unit-tested in the same process that generates code.
- **No native dependencies.** libclang bindings (Python `clang.cindex` or a Node addon) would
  pin a second clang version; the JSON dump is the stable interface of the clang we already run.

Known costs and how they are handled:

| Cost | Handling |
|---|---|
| Dumps are large (up to 133 MB per TU, ~10 GB total) | Processed one TU at a time in memory (two in parallel on 8 GB); never written to disk |
| Locations are delta-encoded (file/line omitted when unchanged) | `resolveLocations()` replays them in output order (done) |
| Typedefs only desugared at the top level (`NhRect *` stays sugared) | Canonicalize types from the TU's `TypedefDecl`s (done); for codegen use clang's `-ast-dump` type IDs where needed |
| Headers are re-parsed in every TU | Declarations are merged across TUs by `file:line` (done in the inventory) |
| Some facts are not in the AST (record layout, bit-field offsets) | `-Xclang -fdump-record-layouts` for heap-backed records; checked against `sizeof`/`offsetof` probes compiled with the same flags |
| Macro bodies are not in the JSON AST | Read from source (`transpiler/analysis/macros.mjs`) only for readability decisions; semantics always come from the expanded AST |

Pipeline per TU: clang JSON → resolved AST → **lowered IR** (a small, typed C-level tree
with explicit evaluation order, explicit conversions and explicit lvalues) → analysis passes
(heap marks, async marks, goto structuring) → JS emitter. Whole-program facts (call graph,
async set, heap set, function-pointer targets) are computed once over all IR and cached in
`transpiler/out/`, so each TU can then be emitted independently and deterministically.
