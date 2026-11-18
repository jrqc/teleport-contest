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
