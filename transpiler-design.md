# Transpiler design: NetHack 5.0 → JavaScript

Stage 1 output (CLAUDE.md section 3). Status: **approved by the owner on 2026-11-18 with the
conditions recorded in section 12.2**; Stage 2 started. All numbers come from
`transpiler/out/stage1-findings.md`, which also lists the commands that regenerate them.

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
| How much needs async? | 3,349–4,469 functions (51–68%) | Async is the normal case, not the exception; must be computed, never hand-patched |
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

Two worlds, decided **per type** (CLAUDE.md 2.1) and recorded in `transpiler/annotations.jsonc`:

- **Object world** (default, all of NetHack but one type): records are JS objects, arrays
  are JS arrays or typed arrays, pointers are JS values (3.3). Generated code reads like C:
  `mtmp.data.mlet`, `levl[x][y].typ`.
- **Heap world** (Lua, and punning unions as union cells, 3.4): C-exact bytes in one
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

### 3.4 Unions (decision D1, approved with the punning condition)

**Rule: a union whose objects are ever written through one member and read through a member
of a different type ("punning") is heap-backed. Only unions proven free of punning are
objects.** "Different type" means different canonical C type: `int` vs `long`, but also
`struct obj *` vs `void *` (`a_obj` written, `a_void` read). Zero-initialization (static
init, `memset`, `= zeroany`) and whole-union copies are not member accesses.

**Per-union punning check** (`transpiler/analysis/union-pun.mjs`, part of the analysis and
of the annotation checker, 9.3):

1. **Access census.** Every member access on a union value in the AST, with the member's
   canonical type and its kind: write (left side of `=`), read-write (`op=`, `++`, `--`),
   read, or address-taken (`&u.m`).
2. **Storage classes.** Each access is attributed to the storage it touches: a record field
   path (`struct light_source.id`), a global, or a function's local or parameter. Classes are
   merged (union-find) across whole-union assignments, initializers, argument passing and
   return values, so a value written in one function and read in another lands in one class.
3. **Verdict per union.**
   - **No punning (proven)**: in every class, all member reads and writes have one canonical
     type, and no member's address escapes. → object world (3.4.1).
   - **Possible punning**: anything else, including an address-taken member. → heap-backed
     (3.4.2). Conservative by construction: a union is only an object when the census proves it.
4. **Report** (`transpiler/out/union-pun.md`): per union, the classes, the member types
   written and read in each, and the sites that make it punning.
5. **Runtime confirmation.** Debug builds record, per union object, the type of the member
   last written; a read of a different type throws `UnionPunError` in object unions (it
   cannot happen if the census is right) and is logged in heap unions (actual puns, as
   evidence for the report).

An annotation can override "possible punning" only for a union whose member is selected by
a tag field (`discriminant: "kind"`, checked at run time as in step 5), and only with the
owner's approval, listed in the report.

**3.4.1 Object unions.** A JS object with one slot per member type (in practice one): reads
return what was written. Integer-only record members (`coord v_launch2` in `union
vlaunchinfo`) are stored as a sub-object.

**3.4.2 Heap unions.** The union's bytes live in the heap with clang's layout, so every pun
behaves exactly as on x86-64 (little-endian, leftover upper bytes included). A heap union
embedded in an object record (e.g. `union any id` in `struct light_source`) is a **union
cell**: the container stays an object, and its field holds a view over the union's own heap
bytes, created with the container. Whole-record copies copy the cell's bytes, so there is still
one copy of the data (one-copy rule). Pointer members store a **handle that behaves like an
address**: handles are allocated deterministically from a high, aligned range (above 2⁴⁰), so
they never equal a small integer. A pointer written as `a_obj` and read as `a_void` gives back
the same object, as in C. An integer read of a pointer member returns the handle number (C
returns an address; C addresses vary between runs, so recorded output cannot depend on them).
A pointer read of bytes that were written as an integer returns an interned non-dereferenceable
pointer value `ptrConst(n)`: equal values compare equal, never equal to a real object, and a
dereference throws. NetHack really does this: `del_light_source` (`src/light.c:104`) writes an
object id into `tmp_id.a_uint` and compares it as `tmp_id.a_obj` with `curr->id.a_obj`, which
holds an id as well while a restored light source awaits fixup (`LSF_NEEDS_FIXUP`).

**Result of the check (Stage 2, `transpiler/out/union-pun.md`):** of NetHack's 5 unions,
1 is an object and 4 are union cells.

| Union | Accesses | Verdict | Why |
|---|---|---|---|
| `union str_or_len` (`hack.h`) | 33 | object | every class reads what it writes |
| `union any` (`hack.h`) | 760 | union cell | definite pun (`light.c` above), 496 possible pun pairs, one escaping member address (`botl.c:1611`, `&istat_s.a.a_ulong`) |
| `union vptrs` (`obj.h`, `struct obj.v`) | 198 | union cell | `v_ocarry` (`struct monst *`) and `v_nexthere`/`v_ocontainer` (`struct obj *`) share `obj.v`; selected by `obj->where`, which the static check cannot prove |
| `union vlaunchinfo` (`trap.h`, `struct trap.vl`) | 37 | union cell | `short`, `coord` and `uchar` members share `trap.vl`, selected by trap type |
| `union customization_content` (`sym.h`) | 27 | union cell | three record members selected by the customization kind |

The last three look tag-discriminated, not punned. Moving one of them to the object world
would need an owner-approved `discriminant:` annotation (above); until then they stay cells.

### 3.5 Heap-backed type set (the feasibility number)

| Scenario | NetHack types (of 345) | Lua types (of 83) |
|---|---|---|
| S0 literal rule | 104 | 40 |
| S1 + save files via serializers (3.6) | 37 | 40 |
| S2 + pointer fields in heap records hold object handles | 23 | 35 |
| **S3 + unions as objects or union cells (approved D1)** | **1** (`struct engr`) + punning unions as cells | 20 |

S3's record count no longer depends on unions: a punning union becomes a union cell (3.4.2)
and does not move its container to the heap. How many of the 23 unions are cells is measured
by the punning check, the first Stage 2 analysis; candidates are `union any` (342 `a_int`
accesses, read through `a_void` in generic code) and `union vptrs` in `struct obj`.

The only NetHack record with byte-level evidence is then **`struct engr` (decision D4)**. C
allocates the struct and its text in one block: `newengr(smem * 3)` (`src/engrave.c:429`),
`engr_text_space(ep)` = `(char *) (ep + 1)`, and the three `engr_txt[]` pointers point into
that space at offsets 0, `smem`, `2 * smem`. The code then treats them as real byte pointers:
it advances `engr_txt[actual_text]++` past leading spaces (line 285), computes
`engr_txt[actual_text] - engr_text_space(ep)` (line 378), copies with `strncpy`/`Strcpy` (lines
381, 398), and resets the pointers to the buffer starts when saving (line 1565), which brings
stripped leading spaces back after a restore. The annotation therefore gives `struct engr` a
**trailing byte area**: `newengr(n)` creates the object plus one `Uint8Array(n)`,
`engr_text_space(ep)` is `BytePtr(ep.__tail, 0)`, and the three pointers are ordinary byte
pointers into it. Lengths, truncation, NUL handling, pointer increments and differences, and
the save-time reset then behave as in C, from generated code. A write past the end of the
area throws where C would corrupt memory. The `memset` over struct plus text (line 430) maps to
a helper that clears both.

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
| `qsort.js` | **Darwin libc `qsort`**, ported exactly (patch 002 sorts an index array with it, and `sortloot_cmp` can consume RNG, so the comparator call sequence is observable). Reference platform: **macOS 15.8.1 (build 24H32), Darwin 24.6.0, x86_64**, the machine on which the 44/44 byte-identical re-record was verified. The macOS version of the official recording machine is not documented; the 44/44 result shows its `qsort` behaves the same on every sort the public sessions perform | Comparator call sequences logged in native C (on the reference platform) vs JS on random, sorted, reversed and inconsistent inputs |
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
   of the same type. Stage 1 used only (b): 4,469 async functions (68%); direct edges alone
   give 3,349 (51%). (a) will land in between.
3. Reverse reachability from the roots, fixed point.
4. Unresolvable sites must be decided in `annotations.jsonc` (`pointers:` with explicit
   targets); the checker fails otherwise. Stage 1 reported 5 (`member:fn`,
   `member:sf_genericptr`); both were type-normalization bugs (a `const`-qualified pointer
   typedef, `void * *` vs `void **`), fixed in Stage 2: now 0.
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

Script loading needs no special code: C loads each script in `nhl_loadlua` (`src/nhlua.c:2343`)
by reading it through `dlb_fopen`, preprocessing the text, and calling `luaL_loadbuffer` with
the chunk name `"(<file>.lua)"`. That function is transpiled like any other, so the port only
has to make the embedded files readable through `dlb_fopen` (section 8); chunk names, error
messages and debug info then match by construction.
Lua's standard I/O and OS libraries (`liolib.c`, `loslib.c`) are transpiled too but sandboxed
by NetHack itself (`NHL_SB_*` flags); their libc needs map to `stdio.js`/`sys.js`.

## 8. Data files, output layout and glue

### 8.1 Embedded data

Every file the game opens from its data directory is embedded: 131 `*.lua` scripts (~0.9 MB),
the `makedefs` outputs and text files (`data`, `rumors`, `oracles`, `engrave`, `epitaph`,
`bogusmon`, `options`, `tribute`, help files; ~0.9 MB) and the reference `sysconf`. They are
taken **from the reference recorder's install directory** (so they are byte-identical to what
the recorder read), one generated module per file in `js/data/`, as string literals (non-ASCII
bytes escaped) decoded to a `Uint8Array` on first open. `dlb_fopen`/`fopen` on the data
directory resolve to them through `stdio.js`. The segment's `nethackrc` is written to the VFS
as `$HOME/.nethackrc` before start, as the recorder harness does.

### 8.2 Layout under `js/`

```
js/jsmain.js            hand-written glue: runSegment (8.3)
js/rng.js               hand-written: RNG log sink and contract exports, uses frozen isaac64.js
js/crt/*.js             hand-written runtime (section 5)
js/nh/src/<file>.js     generated, one per NetHack .c (src/, win/tty/, sys/unix/, sys/share/)
js/nh/layout/<hdr>.js   generated record classes, sizes, offsets, one per header
js/lua/<file>.js        generated Lua 5.4.8 (heap mode)
js/data/<file>.js       generated embedded data files
js/hand/*.js            escape hatches listed in annotations.jsonc (target: very few)
js/isaac64.js, js/terminal.js, js/storage.js   frozen, untouched
```

The current skeleton modules from the contest template (`allmain.js`, `mklev.js`,
`fastforward.js`, ...) are removed once generated code replaces them (CLAUDE.md 2).

### 8.3 Glue

- **`runSegment(input, prevGame)`**: (1) resets all module state, (2) installs the segment's
  environment (seed, datetime, nethackrc, storage, key queue), (3) runs the transpiled
  `main()` of `sys/unix/unixmain.c` with the recorder's argument vector (`nethack -u <name>`),
  (4) stops at `SegmentEnd` or process exit (`nh_terminate`), (5) returns the game object with
  `getScreens()`, `getRngLog()`, `getCursors()`, `getAnimationFramesByStep()` for this segment
  only.
- **Module state reset.** C runs every segment as a new process; ES modules are singletons in
  one JS process. Each generated module therefore exports `__reset()`, which re-runs its
  file-scope initializers (globals, static locals, string tables); `jsmain.js` calls all of them
  in a generated, fixed order before each segment. Nothing else carries over: cross-segment
  state goes only through `storage` (saves, bones, `record`).
- **RNG.** `rnd.c` (patched) is transpiled, except its ISAAC64 calls, which an annotation maps to
  the frozen `js/isaac64.js` (contract: `rng.js` must use it). The patched code writes log lines
  to the `NETHACK_RNGLOG` file (`2808 rn2(12) = 2 @ mon.c:1145`). `rng.js` provides that file as
  an in-memory sink and applies exactly the transformation `record-session.mjs`'s
  `parseRngLines` applies; `getRngLog()` returns entries **without** the `@ caller` tag
  (contract), and a separate debug log keeps the full line for the triage tool (4.2).
- **Screens.** At each `nomux_capture_write_input_boundary` the runtime records screen, cursor
  and RNG delta (5, `screen.js`); `nomux_capture_write_screen` from `tty_delay_output` becomes
  `await game.animationFrame()`.

## 9. Annotations and checker

### 9.1 Format

**`transpiler/annotations.jsonc`** (decision D3): JSON with `//` comments, read with a
20-line comment stripper and `JSON.parse`. A YAML parser would be possible: only `js/**`
counts in the Phase 2 diff (`docs/PHASES.md`), and transpiler dependencies go in
`transpiler/package.json`, outside both the diff and the judged files. JSONC is chosen
because it needs no dependency at all and the annotations are small, regular data. Keys are C names (`file::name` for `static`
functions and file-scope variables), so they survive line-number changes.

```jsonc
{
  "types": {
    "struct engr": { "repr": "object", "tail": { "alloc": "newengr", "space": "engr_text_space" },
                     "why": "text buffers allocated after the struct (engrave.c newengr)" },
    "union any":   { "repr": "union-cell" }   // from the punning check; "object" needs proof
  },
  "groups": {
    "lua": { "files": "lib/lua-5.4.8/src/*.c", "repr": "heap" }
  },
  "functions": {
    "isaac64_init":        { "extern": "js/isaac64.js" },     // frozen implementation
    "isaac64_next_uint64": { "extern": "js/isaac64.js" },
    "nh_deterministic_qsort": { "handwritten": "js/crt/qsort.js", "c": "src/hacklib.c" }
  },
  "pointers": {
    "src/sfstruct.c::sf_genericptr": { "targets": ["..."] }  // unresolved indirect call
  },
  "edges": {
    "cut": [ { "from": "win/tty/wintty.c::cls", "to": "win/tty/wintty.c::winch_handler",
               "why": "SIGWINCH cannot occur in the port" } ]
  }
}
```

### 9.2 Rules

- The analyzer produces a default for every type, union, pointer site and function; an
  annotation **overrides** it and must say why (`why`). Representation is never decided in
  generated code.
- Hand-written replacements (`handwritten:`) are the last resort: each points at its C
  function, and the checker reports their total line count (target: under 1% of the output).
- Edge cuts are only allowed for paths that cannot run in the port, never to make code faster.

### 9.3 Checker (tool 4.8, runs on every transpile)

Fails on: (1) a hard-pattern site with no decision (no analyzer default and no annotation);
(2) a **stale** annotation (its C name no longer exists in the call graph or record set);
(3) an unresolved indirect call site without `pointers:` targets; (4) a union marked
`object` that the punning check (3.4) does not prove free of punning, unless
it has an owner-approved `discriminant:`; (5) a `handwritten:` entry whose C
function changed since the annotation was written (hash of the function's source text stored
next to the entry). It prints the decision table, the heap-backed type set, the async-set
size and the hand-written line count, so every run shows the current state.

## 10. Test tooling and the iteration loop

Everything lives outside `js/` and runs from one entry point, `node tools/loop.mjs`, which
writes `results/<timestamp>/` (machine-readable) and appends a summary to `results/LOG.md`.

| # | Tool | Built from | Gate |
|---|---|---|---|
| 4.1 | Score runner | `frozen/score.sh`, parses `__RESULTS_JSON__`, diffs per session against the previous run | Any per-session drop in screens or RNG = **regression**, printed first, loop stops |
| 4.2 | First-divergence triage | Recorded RNG (with `@ caller` tags) vs the JS debug log (full lines, same tags, because patch 003 is transpiled) | Groups failing sessions by the first diverging C function |
| 4.3 | Screen diff | `frozen/screen-decode.mjs`, cell-level char/color/attr/cursor | — |
| 4.4 | Targeted recorder | `tools/recorder-env/record-session.mjs` (fixed recorder) | Own sessions in `tests/sessions/`, never in `sessions/` |
| 4.5 | Differential C corpus | `tests/c-diff/` (started: `order/eval-order.c`): one program per construct and hotspot pattern, run native vs transpiled | Byte-identical stdout |
| 4.6 | Runtime unit tests | `js/crt/` against native results (int ops, `printf` formats from the AST, Darwin `qsort` comparator sequences, `localtime`) | All green |
| 4.7 | Determinism and churn | Transpile twice → byte-identical; `git diff --numstat -- js/` vs a baseline tag | Non-identical output fails |
| 4.8 | Annotation checker | Section 9.3 | Fails on missing/stale decisions |
| 4.9 | Static checks | `node --check`, import graph, forbidden APIs (`fs`, `child_process`, network, `WebAssembly`), frozen files unchanged, async/await consistency (6.3) | Any failure stops the loop |
| 4.10 | Performance | Wall time per session | Warn above 90 s (10% of the limit) |

Loop: transpile → 4.7/4.8/4.9 → 4.5/4.6 → 4.1 → 4.2 on the first failing sessions → fix the
**transpiler, runtime or an annotation** (never generated `js/`) → repeat. Fixes start at the
earliest divergence of the most blocking C function (CLAUDE.md section 4 loop rules).

Bootstrapping before the full game runs: the C corpus (4.5) and **function-level differential
tests**: selected pure NetHack functions (`rnd.c`, `hacklib.c` string helpers, `objnam.c`
naming, `mkobj.c` with a seeded RNG) linked natively into a small C driver and compared with
their transpiled versions. This catches most translation bugs before any session runs.

## 11. Performance estimate

Measured: the longest public session (seed4500: 1,814 steps, 108,275 RNG calls) runs in
**1.25 s** in C including the harness; the limit is 900 s per session, a factor of 720.

Estimated (not measured; first real number at milestone M3):

| Cost | Estimate | Reasoning |
|---|---|---|
| Object-world NetHack code vs `-g -O0` C | 1–5× | V8 JIT on monomorphic classes is competitive with unoptimized C; integer helpers inline |
| `async`/`await` on ~60% of functions | 2–10× on call-heavy paths | Each async call allocates a promise; most calls complete synchronously but still pay the microtask |
| Lua in heap mode (DataView accessors) | 10–50× for Lua time | Emscripten-like code without WASM; Lua is a fraction of runtime (level creation) |
| Screen capture per step | small | 1,920 cells per step |

Even a combined 100× slowdown gives ~125 s for the longest session: within the limit with
7× headroom. Mitigations if needed, in order: field-sensitive function-pointer resolution
(smaller async set), sync clones of hot functions that cannot block (selected by annotation,
checked statically), typed-array fast paths in the heap accessors. The browser `/play/` path
is unaffected (one key at a time).

## 12. Risks, open decisions and milestones

### 12.1 Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | A union pun the static check misses (integer ↔ pointer) | Low / one session diverges | Accessor throws `UnionPunError` (never silent); move that union to the heap by annotation |
| R2 | Irreducible `goto` graphs make some functions unreadable | Medium / readability only | State-machine fallback per function; counted in the checker output |
| R3 | Reads of uninitialized memory: C reads stack garbage or stale heap, JS reads zero | Low–medium / hard to find | Clang `-Wuninitialized`/`-Wsometimes-uninitialized` pass over the tree listed in the report; fixed behavior is only matched where the recordings show it |
| R4 | Lua `pairs()` order depends on the address-seeded string hash | Low / save-variable or event order | Recorded sessions are stable across C runs; if a divergence points here, reproduce C's seed computation with the JS heap's addresses |
| R5 | Use-after-free that C "gets away with" | Low / divergence | `free` in the object world can poison objects in debug runs to find such reads |
| R6 | Darwin libc details (`qsort`, `%g`, `strtod`, `localtime`) | Medium / screens or RNG | Ported from Darwin's libc source and fuzzed against native (4.6) |
| R7 | Async overhead exceeds the time budget | Low / timeouts | Section 11 mitigations; measured at M3 |
| R8 | Schedule: Phase 1 freeze is **2026-11-29**, 11 days away | High / no Phase 1 qualification | The owner's goal is a working port by transpiling, not a ranking; work continues after the freeze (CLAUDE.md 1.3) |
| R9 | Phase 2 churn: a changed header shifts layouts or async marks in many files | Medium / diff penalty | Layout modules per header (4.5), stable names, per-function temporaries; churn report (4.7) from M1 |

### 12.2 Decisions (owner review, 2026-11-18)

| ID | Decision | Outcome |
|---|---|---|
| D1 | Union representation | **Approved with a condition**: unions with type punning stay heap-backed (as union cells, 3.4.2); only unions the per-union punning check proves free of punning are objects (3.4) |
| D2 | Lua | **Approved**: transpile Lua 5.4.8 in heap mode (section 7) |
| D3 | Annotation format | **Approved**: `transpiler/annotations.jsonc`; reasoning corrected (9.1): only `js/**` counts in the Phase 2 diff, and transpiler dependencies go in `transpiler/package.json` |
| D4 | `struct engr` | **Approved**: object with a trailing byte area, matching C's truncation and length behavior (3.5) |
| D5 | Template skeleton in `js/` | Delete it in **one separate commit**, once the first generated build runs end to end through `runSegment` |
| D6 | Upstream report | Issue texts drafted in `transpiler/out/upstream-issue-drafts.md`; **the owner posts them** |
| D7 | Push | **After M3** |

### 12.3 Milestones

| M | Scope | Exit criterion (measurable) |
|---|---|---|
| M0 | Runtime core + C corpus | `tests/c-diff/` constructs and `js/crt/` unit tests green against native clang (int ops, `printf` formats from the AST, Darwin `qsort` sequences, `localtime`) |
| M1 | Punning check, IR + emitter for the whole tree | Union verdicts in `union-pun.md`; all 172 TUs emit; `node --check` and import graph pass; two transpiles byte-identical; annotation checker clean |
| M2 | Function-level differential tests | `rnd.c`, `hacklib.c`, `objnam.c`, `mkobj.c` samples byte-identical to native |
| M3 | Game boots in JS | Step-0 screen matches for all 44 public sessions; first wall-time measurement. The first end-to-end `runSegment` run triggers the skeleton deletion commit (D5); M3 reached → push (D7) |
| M4 | Character creation | All chargen screens and RNG through `u_init` match for all 44 sessions |
| M5 | Level 1 (incl. Lua special levels and dungeon setup) | RNG matches through the first `mklev` for all 44 sessions |
| M6 | Full play, save/restore, bones | Score climbs with no regressions; target: majority of public steps |

## 13. Feasibility verdict

**Feasible, with the design above.** The numbers that decide it:

- **NetHack fits the readable object world almost entirely.** With save files through
  generated serializers and punning unions as union cells, 1 of 345 NetHack record types has
  byte-level evidence (`struct engr`), and it has a small, local model. Punning unions add
  heap-backed union cells without moving their containers (`monst`, `obj`) to the heap.
  Without those decisions the set would be 104 types including `monst` and `obj`, which would
  make most of the game accessor code: still correct, but far less readable.
- **Lua is raw memory but self-contained.** Heap mode for 32 files (23k lines) behind a narrow
  C API boundary, transpiled by the same tool. It does not change in Phase 2.
- **Async is large (51–68% of functions) but fully mechanical**: computed from the call graph,
  emitted, and checked statically. That avoids the failure mode of Bau's first attempt.
- **Every other hard construct has a mechanical rule**: 653 gotos, 4 `setjmp` sites, 28
  variadic functions, 1,671 indirect calls, 241 bit-fields.
- **Performance** has a 720× budget over C (estimate, to measure at M3).
- **Reproducibility is proven at the C level**: 44/44 sessions re-record byte-identical, so
  every divergence the JS port shows will be a translation bug, not an environment mystery.

What is *not* realistic: a scoring port before the Phase 1 freeze on 2026-11-29 (R8). M0–M2
are weeks of work; the first matching screens come at M3.

No fallback is needed. If union cells turn out impractical, the same transpiler still works with unions in the
heap (scenario S2: 23 NetHack heap types), at a readability and speed cost.
