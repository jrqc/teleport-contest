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

## 3. Memory model

Two worlds, decided **per type** (CLAUDE.md 2.1) and recorded in `transpiler/annotations.yaml`:

- **Object world** (default, all of NetHack but one type): records are JS objects, arrays
  are JS arrays or typed arrays, pointers are JS values (3.3). Generated code reads like C:
  `mtmp.data.mlet`, `levl[x][y].typ`.
- **Heap world** (Lua, plus `struct engr` unless rewritten, 3.5): C-exact bytes in one
  `ArrayBuffer` with clang's layout; pointers are integer addresses. Object-world code that
  touches a heap type goes through generated accessor classes (`get mhp()` over a `DataView`),
  so there is exactly one copy of the data (the one-copy rule).

### 3.1 Scalars

| C type (LP64, Darwin) | JS representation | Operations |
|---|---|---|
| `char` (signed on Darwin x86_64), `schar`, `short`, `int`, `unsigned char/short` | Number holding the exact C value | After each arithmetic result: the C conversion via a runtime helper (`i32(x)` = `x|0`, `i8`, `u8`, `i16`, `u16`); division `idiv(a,b)` truncates; `%` via `irem` |
| `unsigned int` | Number in 0..2³²−1 | `u32(x)` = `x>>>0`; multiplication via `Math.imul` + `>>>0` |
| `long`, `unsigned long`, `long long`, `size_t`, `time_t` (64-bit) | Number while the value is in ±2⁵³; exact 64-bit path via BigInt | Emitted as checked helpers (`add64`, `mul64`, ...) that stay on Number unless the exact result leaves ±2⁵³, then compute in BigInt and wrap. Values that really need 64 bits (hashes, ISAAC, MD4) are rare and live in byte-level code |
| `float`, `double` | Number (`float` stored via `Math.fround`) | x86-64 SSE: no excess precision, so JS doubles match |
| `_Bool`/`boolean` (`boolean` is `signed char` in NetHack) | Number 0/1 per C rules | Conversions exactly as clang's AST marks them |

Integer promotion and the usual arithmetic conversions are **not re-derived**: clang's AST
already contains every implicit cast (`IntegralCast`, `IntegralToBoolean`, ...), and the
emitter turns each one into its helper. Constant expressions are emitted as the value clang
folded.

### 3.2 Records and arrays

- **Records** → one JS class per struct, fields in declaration order, constructor
  zero-initializes (C `alloc` + `memset 0` and static zero-init both map to it). Embedded
  records (`struct you` inside instance globals, `coord` fields) are **owned sub-objects**:
  assignment `a = b` of a record is a generated `copyInto(a, b)` (deep for embedded records and
  arrays, shallow for pointer fields), never reference aliasing.
- **Bit-fields** (241 in 27 records) → ordinary numeric fields; stores apply the field's width
  and signedness (`f = sext(v, w)` / `v & mask`). No packing, because nothing in the object
  world can observe the packing (save files are JS-to-JS, 3.6).
- **Arrays**: scalar arrays → typed arrays of the exact element type (`Int8Array`,
  `Int16Array`, `Int32Array`, `Uint8Array`, ...; 64-bit elements → `Float64Array` holding exact
  integers, or `BigInt64Array` where byte-level code needs it). Multi-dimensional arrays
  (`levl[COLNO][ROWNO]`) → arrays of arrays (readable indexing). Arrays of records → JS arrays
  of objects, created full. `char` arrays → `Uint8Array` (C strings are bytes; 3.4 of the
  runtime handles text).
- **Static and global initializers** are emitted as data (object literals or constructor calls)
  in source order; large constant tables (`mons[]`, `objects[]`) become frozen-shape object
  arrays in their own modules.

### 3.3 Pointers

A pointer is always a JS value; the representation depends on what it points to:

| Kind | Points to | JS value | Arithmetic / comparison |
|---|---|---|---|
| Record pointer | a record object | the object itself | Objects that live in an array carry a hidden back-reference (`__arr`, `__idx`) set when the array is built. `p + n` → `p.__arr[p.__idx + n]`; `p - q` → index difference; `p < q` → index comparison. One-past-the-end and other out-of-range positions → a small `ElemPtr{arr, idx}` value |
| Scalar reference (`&x`, `&s.f`, `&a[i]`: 1,445 sites) | a scalar variable, field or element | `Ref` variants: `FieldRef{obj, key}`, `ElemRef{typedArray, i}`, `VarRef{get, set}` for locals that have their address taken (those locals are boxed) | `ElemRef` supports arithmetic; others only deref/compare |
| Byte pointer (`char *`, `unsigned char *`) | inside a `Uint8Array` | `BytePtr{buf, off}`; for local variables the emitter **splits it into two locals** (`p_buf`, `p_off`) so string loops allocate nothing | Offset arithmetic; comparisons require the same buffer (else a runtime error) |
| Function pointer | a function | the JS function (`null` for NULL) | Identity comparison only |
| `void *` / `genericptr_t` | anything | whatever pointer value was stored | Casting back is the identity; `void*` arithmetic is a byte-pointer operation |
| Heap pointer (heap world) | heap bytes | integer address | Exact C arithmetic |
| NULL, sentinels | — | `null`; `(struct bill_x *) -1000` → a unique runtime constant `ptrConst(-1000)` | Equality only |

Static rules decide the kind per expression from the C type and the address-of analysis, so
the emitted code never inspects pointer kinds at run time, except in the few generic paths
(`void *` round trips, `memcpy`), which dispatch on the value.

### 3.4 Unions

Unions are what separates 104 heap types from 1 (3.5). **[DECISION U]** Proposed: a union in
the object world is a **shared-slot object** that reproduces little-endian punning exactly for
the cases NetHack uses:

- One integer slot holds the union's low 64 bits as an exact integer. Writing an integer
  member replaces only that member's bytes (writing `a_char` changes the low 8 bits; writing
  `a_long` all 64); reading an integer member extracts its bytes with its signedness. This is
  exactly what x86-64 does for every integer-to-integer pun (e.g. write `a_int`, read
  `a_long`), including leftover upper bytes.
- One reference slot holds a pointer member's value. Reading a pointer member returns it, so
  pointer-to-pointer puns (`a_obj` read as `a_void`) behave as in C.
- Integer-to-pointer or pointer-to-integer punning cannot be represented: the accessor
  **throws** (`UnionPunError`, always on, cheap). It can never silently diverge; if a session
  ever hits it, that union becomes heap-backed by annotation.
- Record members made only of integers are encoded into the integer slot by their clang
  byte layout, so they pun with integer members exactly: `union vlaunchinfo` (`trap.h`) mixes
  `coord v_launch2` with `short`/`uchar` members.
- A union with other record members is shared-slot only if a static check shows each object
  is accessed through one member; otherwise it goes to the heap. To check in Stage 2:
  `union customization_content` (`sym.h`: three record members, selected by the containing
  `customization_detail`'s kind; not yet verified).
- Pointer/integer unions are fine while the code reads what it wrote: `union str_or_len`
  (`hack.h`: `char *str` / `int len`); only `.str` is accessed in the analyzed code.

Alternative: unions heap-backed (scenario S2): `obj`, `trap` and 21 more NetHack types in the
heap, every access through accessors. Correct by construction but much less readable, slower,
and with more Phase 2 churn.

### 3.5 Heap-backed type set (the feasibility number)

| Scenario | NetHack types (of 345) | Lua types (of 83) |
|---|---|---|
| S0 literal rule | 104 | 40 |
| S1 + save files via serializers (3.6) | 37 | 40 |
| S2 + pointer fields in heap records hold object handles | 23 | 35 |
| **S3 + unions as shared-slot objects (proposed)** | **1** (`struct engr`) | 20 |

With S3 the only NetHack type with byte-level evidence is `struct engr`, whose three text
buffers live in the same allocation right after the struct (`newengr(smem * 3)`,
`engr_text_space(ep)`, `src/engrave.c:428`). Proposed: an annotation that models it as an
object with three `Uint8Array` text fields (one escape hatch, `js/hand/engr.js` if the
generated form is not enough), so **NetHack stays entirely in the object world**.

**Lua goes to the heap world as a whole** (all 32 Lua TUs in heap mode), regardless of the
scenario: its value stack is pointer arithmetic on `StackValue` (about 480 sites), the GC casts
between `GCObject` and `GCUnion`, it uses `offsetof` and computed gotos. That is
Emscripten-style code over a typed-array heap, generated by the same transpiler. It is not
NetHack code and Lua 5.4.8 will not change in Phase 2, so its readability costs nothing.
Boundary with NetHack: only the Lua C API (`lua_*`, `luaL_*`) called from `nhlua.c`,
`nhlsel.c`, `nhlobj.c`. Strings are copied across; NetHack pointers stored in Lua (light
userdata) go through a handle table; `lua_State *` is a heap address.

### 3.6 Save and bones files

C writes whole structs with `bwrite`/`mread` (`include/sfmacros.h`, `src/sfstruct.c`: 44
types). The JS port only needs to read what it wrote itself, so the transpiler generates a
**per-type serializer** (field by field, in declaration order, from the record definition)
and lowers the `sfo_*`/`sfi_*` functions to call it. Pointer fields are written as
null/non-null flags, because C's restore code tests the stale pointer values it reads back
(`if (mtmp->minvent) ...`). Files go through the frozen `js/storage.js` VFS. Save code then
stays in the object world and needs no hand-written code.

### 3.7 Globals, statics, allocation

- NetHack 5.0 keeps most state in instance-global structs (`ga`…`gz`, `sv*`, `u`, `flags`):
  each is one exported object, so `gs.spl_orderindx` stays readable.
- Other file-scope variables: `static` → module-level `let`; external scalars → a property on
  their defining module's exported state object (ES module bindings cannot be assigned from
  other modules). Names are the C names.
- Function `static` locals (545) → module-level variables named `<function>$<name>`.
- `alloc`/`malloc` of a record → `new T()`; of bytes → `new Uint8Array(n)`; `free` → no-op in
  the object world (GC), real `free` in the heap world. Reading freed memory in C would behave
  differently; any such case is a C bug that must then be modeled explicitly (risk R5).

## 4. Translation rules

The emitter works on the lowered IR (section 2), where every implicit conversion is explicit and
every evaluation order is fixed. One JS module per C file, functions in source order, C names
kept (CLAUDE.md 2.6). Each emitted statement carries a `// file.c:line` comment, which is free
in the Phase 2 diff and maps JS stack traces and the debug RNG log back to C.

### 4.1 Evaluation order

C leaves most operand orders unspecified; the recorder fixes them the way **clang's code
generator** does. The IR records that order explicitly and introduces temporaries only where JS
would otherwise evaluate differently. Every rule is pinned by a differential test in
`tests/c-diff/order/`, compiled with the recorder's flags. The rows below are **measured**
(`eval-order.c`, same result at `-g` and `-O2`):

| Construct | Measured clang order | JS difference |
|---|---|---|
| Function arguments | left to right (`xy`) | Same as JS |
| Binary operators | left operand, then right (`lr`) | Same as JS |
| Simple assignment `a[i][j] = r` | **right side first**, then the lvalue (`rij`) | JS evaluates the lvalue's object and index first: `levl[rn2(x)][rn2(y)].typ = f(rn2(z))` needs temporaries |
| Compound assignment `a[i][j] += r` | **right side first**, then the lvalue (`rij`) | Same treatment as simple assignment |
| `b[i]++` | the lvalue's index (`i`) | Same as JS |
| `&&`, `||`, `?:`, `,` | sequenced as C defines | Same as JS |

### 4.2 Expressions

| C | JS |
|---|---|
| Integer arithmetic | Exact helpers per result type (3.1); `x / y` → `idiv(x, y)`, `x % y` → `irem(x, y)`, shifts with C width/sign rules; division by zero → a runtime trap (C would crash; such a case is a divergence to investigate) |
| Implicit/explicit integer conversions | One helper per conversion (`i8`, `u8`, `i16`, `u16`, `i32`, `u32`, `i64`, `u64`), straight from the AST cast nodes |
| Floating point | Native Number; `float` via `Math.fround`; float→int conversion truncates (`Math.trunc` + range rules) |
| `sizeof`, `offsetof`, `_Alignof` | The constant clang computes for the recorder's ABI (from `-fdump-record-layouts`), even in the object world, because the values flow into logic (`SIZE(arr)`, buffer sizes for `Snprintf`) |
| Record assignment / pass by value | `copyInto(dst, src)` / `clone(src)` (3.2) |
| Member access `p->f`, `s.f` | `p.f` (object world) or accessor `p.f` on a heap view class (heap types) |
| Address-of, pointer arithmetic, deref | Per pointer kind (3.3) |
| String literals | Interned read-only `Uint8Array` constants per module (NUL-terminated) |
| Compound literals, designated initializers | Constructor call plus field stores in initializer order |

### 4.3 Statements and control flow

| C | JS |
|---|---|
| `if`, `while`, `do`, `for`, `break`, `continue`, `return` | The same JS statements |
| `switch` with fall-through | JS `switch` (same fall-through semantics); `case` labels nested inside inner blocks fall back to the goto lowering |
| `goto` (536 in NetHack, 117 in Lua) | Structured lowering: a forward jump becomes a labeled block (`L: { ... break L; }`), a backward jump a labeled loop (`L: for (;;) { ... continue L; }`). Irreducible control flow falls back to a `switch`-in-a-loop state machine for that function only |
| Computed goto (`lvm.c` jump table, 78 sites) | Lowered to a `switch` over the jump table's label set (same semantics as the non-jump-table build of the same source) |
| `setjmp`/`longjmp` (4 sites) | `try`/`catch` with a unique token per `jmp_buf`; `longjmp` throws it. Lua's `luaD_throw`/`luaD_rawrunprotected` and the `nhl_pcall` step-limit sandbox |
| Labels used only as `goto` targets | No output beyond the lowering |

### 4.4 Functions

| C | JS |
|---|---|
| Function definition | `function name(...)` (or `async function`, section 6); `static` → not exported; others exported |
| Parameters | By value; record parameters are cloned at entry if the function writes to them |
| Variadic functions (23 in NetHack) | Rest parameter plus a `VaList` object; `va_start`/`va_arg(ap, T)`/`va_end` → `VaList` methods that read the next argument with T's conversion |
| Calls through function pointers (1,671) | Call of the JS function value (`await`ed if any possible target is async) |
| Static locals (545) | Module-level variables `<function>$<name>`, initialized once in source order |
| Macros | Already expanded in the AST. The patch 003 RNG macros therefore become calls that set the caller tag with the literal `__FILE__`/`__LINE__`/`__func__` values, which reproduces the recorder's tags exactly |

### 4.5 Names and stability

- C identifiers kept; collisions with JS reserved words or globals (`delete`, `new`,
  `constructor`, `arguments`, ...) get a fixed suffix (`delete_`), from a fixed list.
- No counters or hashes in generated names. Temporaries are named after the C construct and
  numbered per function (`t1`, `t2`, ...), so a change inside one function cannot rename
  anything elsewhere.
- Struct layouts, sizes and offsets live in one generated module per header
  (`js/nh/layout/<header>.js`), so a changed struct changes one file.

## 5. Runtime and libc (`js/crt/`)

All semantic-gap code is hand-written once, in `js/crt/`, and unit-tested against native C
(CLAUDE.md 2.4). Generated code only calls it. The libc surface is measured: 190 distinct
functions, 130 used by NetHack (`transpiler/out/inventory/summary.md`); on macOS most string
and format calls arrive as fortified builtins (`__builtin___sprintf_chk` 1,341 sites,
`__builtin___strcpy_chk` 883, `__builtin___strcat_chk` 555), which behave like the plain
functions unless a buffer would overflow (then the process aborts; the runtime throws).

| Module | Contents | Verified against |
|---|---|---|
| `int.js` | Conversions and exact arithmetic (3.1), 64-bit checked helpers | Fuzzed against native C for every operator × type pair |
| `mem.js` | `BytePtr`, `Ref` kinds, `ElemPtr`, `copyInto`/`clone`, union slots, `ptrConst`, `memcpy`/`memset`/`memcmp` dispatch over pointer kinds | Unit tests |
| `heap.js` | Typed-array heap for the heap world: growable `ArrayBuffer`, `DataView` accessors, a deterministic `malloc`/`realloc`/`free` | Unit tests; Lua test scripts |
| `string.js`, `ctype.js` | `str*`, `mem*`, `strto*`, `ato*`, `ctype` in the C locale (byte semantics, Darwin's tables) | Native differential tests |
| `printf.js` | One formatting engine for `sprintf`/`snprintf`/`vsnprintf`/`fprintf` and `sscanf` parsing | Byte-exact against Darwin libc: every format string literal found in the AST plus fuzzed values; includes `%g`/`%.14g` (Lua `tostring` of numbers) |
| `qsort.js` | **Darwin libc `qsort`**, ported exactly (patch 002 sorts an index array with it, and `sortloot_cmp` can consume RNG, so the comparator call sequence is observable) | Comparator call sequences logged in native C vs JS on random, sorted, reversed and inconsistent inputs |
| `time.js` | `time()` returns the recorder's pinned "real now" (a US-daylight instant, see the `tm_isdst` quirk), `localtime`/`mktime`/`difftime` with `America/New_York` rules coded explicitly (US rules before and after 2007; no dependency on `Intl` data) | Native `localtime`/`mktime` with `TZ=America/New_York` for 1970–2100 |
| `stdio.js` | `FILE` objects: read-only embedded data files (section 8), writable files (`record`, `logfile`, `xlogfile`, saves, bones) through the frozen `js/storage.js` VFS | Unit tests |
| `env.js` | The recorder environment as constants: `getenv` table (exactly the variables `record-session.mjs` sets: `HOME`, `TERM`, `TZ`, `NETHACK_SEED`, `NETHACK_FIXED_DATETIME`, `NETHACK_RNGLOG`, `NETHACK_NO_DELAY`, `NOMUX_MARKERS`, `NETHACK_RAW_KEYS`, `NETHACKDIR`/`HACKDIR`), the documented `HOME` path, `getuid`/`getpid` constants | Re-recorded sessions |
| `sys.js` | Process and system calls only reachable outside normal play: `signal` (no-op), `fork`/`exec*`/`popen` (fail like a missing program), `sleep` (no-op), `chdir`, `access`, `stat`, `unlink` on the VFS | — |
| `term.js` | termcap/terminfo for `TERM=xterm-256color` as a static capability table captured from the recorder machine (`tgetstr`, `tgetnum`, `tgetflag`, `tgoto`, `tparm`, `tputs`) | Captured once from native |
| `screen.js` | Screen capture glue: the patched tty keeps its own shadow screen (patch 006, transpiled); at each input boundary the runtime encodes it in the session format (port of `encodeScreenAnsiRle`/`payloadToLines` from `scripts/record-session.mjs`), records the cursor, and mirrors it into the frozen `Terminal` (`setCell`) for the browser | `frozen/screen-decode.mjs` on recorded sessions |

The values that come from the recording machine (`HOME`, `TERM`, `TZ`, the daylight-time
"now", Darwin libc behavior) are documented constants (`docs/recording-environment.md`, issues
#16/#17) and live only in `env.js` and `time.js`.

## 6. Async plan

The problem that sank Bau's first attempt (CLAUDE.md 1.8, 2.5). The rule here: async-ness is a
**computed whole-program fact**, emitted mechanically, and checked; never decided by hand.

### 6.1 Roots

From the patched C code (step 1.5):

| Root | Why it blocks | JS |
|---|---|---|
| `tty_nhgetch` | The only key read that captures a screen (`nomux_capture_write_input_boundary`, then `getchar`/`read`). Every step boundary | `await input.nextKey()` |
| `tty_delay_output` | Captures an animation frame (`nomux_capture_write_screen` under `NETHACK_NO_DELAY`) | `await game.animationFrame()` (contract, `docs/API.md`) |

Other `getchar` callers (`getlock`'s "Destroy old game?", `ask_about_panic_save`, `dumpit`)
read stdin outside normal play; they become async through the same rule if reachable.

### 6.2 Computing the set

1. Call graph from the IR: direct edges plus function-pointer edges.
2. Function-pointer targets, most precise first: (a) **field-sensitive** sets, i.e. which
   functions are stored into which struct field or variable (initializers such as `tty_procs`
   and the extended-command table, plus assignments); (b) fallback: every address-taken function
   of the same type. Stage 1 used only (b): 4,467 async functions (68%); direct edges alone
   give 3,349 (51%). (a) will land in between.
3. Reverse reachability from the roots, fixed point.
4. Unresolvable sites (5 in Stage 1: `member:fn`, `member:sf_genericptr`) must be decided
   in `annotations.yaml` (`pointers:` with explicit targets); the checker fails otherwise.
5. Edge cuts are allowed only as annotations with a reason, and only for paths that cannot run
   in the port (e.g. `SIGWINCH` resize). `panic` is **not** cut: it can display messages and
   prompt.

Being conservative is safe: an extra `async` changes no behavior, only speed (section 11).

### 6.3 Emission

- Functions in the set are emitted `async`; every call to one is `await`ed. A call through a
  function pointer is awaited if any possible target is async (`await` on a non-promise value is
  harmless).
- **Callbacks into runtime code.** Runtime routines that call generated code must accept async
  callbacks: `qsort.js` (comparators such as `sortloot_cmp` are in the async set through
  `panic`) gets an async variant used whenever the comparator is async, with the identical
  algorithm.
- **Lua.** Lua scripts call NetHack C functions (`nh.pline`, `nh.getlin`, ...) that can block
  on `--More--` or input, so the Lua VM's call path (`luaD_call`, `luaV_execute`, ...) is in
  the async set too (755 Lua functions in the conservative set). Lua is generated code, so this
  follows from the same rule with no special case.
- **Static check** (part of tool 4.9): parse every generated module and fail the build on any
  call to an async function without `await`, and on any `await` inside a function not in the
  set.

### 6.4 Input and segment end

- Scoring (`runSegment`): keys come from `input.moves`, one byte per key (latin1, matching the
  fixed recorder, issue #23). When `tty_nhgetch` needs a key and none is left, the boundary screen
  has already been captured; the read throws `SegmentEnd`, which `runSegment` catches to return
  the game. Death or quit before the keys run out ends the segment the same way C does
  (`nh_terminate`, final capture).
- Browser play (`/play/<owner>/`): `nextKey()` awaits the frozen `Terminal`'s keyboard queue.
  Same generated code, different key source, so live play is O(1) per key (no replay).

## 7. Lua

**Decision proposed: transpile Lua 5.4.8's C source with the same transpiler, in heap mode,
and embed the `.lua` scripts as strings.** (CLAUDE.md 2.7 prefers this; the numbers support it.)

| Fact (Stage 1) | Consequence |
|---|---|
| NetHack 5.0 uses Lua **5.4.8**, downloaded at build time (`make fetch-lua`), 32 files in `liblua.a`, built with `-O2 -DLUA_COMPAT_5_3 -DLUA_USE_MACOSX` | The exact source is in the reference tree; transpile it with those flags |
| Scripts get randomness only through the **core** RNG: `nhlib.lua` replaces `math.random` with a shim over `nh.rn2`/`nh.random`; Lua's own xoshiro generator is seeded but unused | No separate Lua RNG to emulate; RNG order is fixed by the scripts' execution order, which the transpiled VM reproduces exactly |
| 25,078 Lua-tagged RNG calls in the public sessions; the tags come from `nhl_rnglog_set_lua_caller` (patch 004) reading `lua_Debug` | Transpiling the VM and `ldebug.c` reproduces the tags (source names and line numbers) for the debug log |
| Lua internals are raw memory (stack pointer arithmetic, GC unions, `offsetof`, computed goto) | Heap mode for all Lua TUs (3.5) |
| Lua's string-hash seed (`luai_makeseed`, `lstate.c:71`) mixes `time()` with heap and stack addresses | Address-dependent: in C it varies with ASLR; only `pairs()` iteration order over string keys depends on it. The scripts use `pairs()` in 3 places (`nhlib.lua:159` save-variable serialization, `nhlib.lua:233` tutorial events, `nhcore.lua:48` callbacks). The JS heap gives fixed addresses. Since the 44 public sessions re-record identically across runs, recorded output does not depend on that order; risk R4 tracks it |

Why not an existing JS Lua (fengari or similar): different hashing, different GC timing (Lua
`__gc` and weak tables), different error messages and number formatting (`%.14g`), and
different `lua_Debug` information, any of which can change screens or RNG order. A
transpiled VM is behaviorally identical by construction and costs no extra method.

Script loading: `luaL_loadbuffer` on the embedded script text with the same chunk names
(`@dat/xxx.lua` style names as the C build uses), so error messages and debug info match.
Lua's standard I/O and OS libraries (`liolib.c`, `loslib.c`) are transpiled too but sandboxed
by NetHack itself (`NHL_SB_*` flags); their libc needs map to `stdio.js`/`sys.js`.
