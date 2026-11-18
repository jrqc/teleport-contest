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
- A union with record members that are accessed through more than one member goes to the heap
  (none in NetHack: `customization_content` members are accessed by kind).

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
scenario: its value stack is pointer arithmetic on `StackValue` (∼700 sites), the GC casts
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
