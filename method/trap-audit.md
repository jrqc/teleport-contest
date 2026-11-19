# Trap audit of the runtime (`js/crt/`), 2026-11-19

A `CTrap` ends the segment; the C program would go on (or crash in its own way), so a trap
on legal C loses every later step and RNG call. That is what the three fuzz failures of
2026-11-19 were (`mhitu.c hitmsg`: `p + 1` on a lone record; `save.c savemonchn`: `==` on
a pointer read from a save file). This audit went through all 93 trap sites in
`js/crt/` (plus the one `Error` in `mem.js cstrLiteral`, a test helper) and sorted them:

- **legal C the runtime did not support**: fixed (the table below); none remains;
- **undefined behavior in C, or a C abort** (fortify checks, `abort`, `assert`): kept;
- **port invariants** (emitter, bridge and serializer consistency): kept, checked statically;
- **one block used as two types** (REPR, 3 sites): legal C that the object model only
  represents in the heap world, by design (the one-copy rule, CLAUDE.md 2.1); the remedy is
  an annotation, not runtime code. Not hit by any session or by 1,604 fuzz cases;
- **resource limits** of the heap world (3 sites).

`tools/trap-audit.mjs` holds the classification as rules and fails on a trap that matches
none (run by `npm test`, `tests/crt/legal-c.test.mjs`), so a new trap needs a decision.
Score after the fixes: 44/44, 11,405/11,405 screens, 792,838/792,838 RNG calls.

## Fixed: legal C that trapped

| C construct | Was | Now | Test |
|---|---|---|---|
| `p + 1` on a record that is not an array element (`mhitu.c hitmsg`) | trap | one-past pointer (C11 6.5.6p7), compares, not dereferenceable | `tests/crt/mem.test.mjs` |
| `p == q` with `q` read from a save file (`save.c savemonchn`) | trap | unequal to every live object | `mem.test.mjs` |
| `&s.f + 1` (a scalar field as an array of one) | trap | one-past `FieldRef` (`d = 1`); `pdiff`, `peq` | `legal-c.test.mjs` |
| `(char *) (p + 1)` of a record without a trailing area | trap | one-past byte pointer (empty, the same per record) | `legal-c` |
| `p - q` across views of one object (matrix rows, `retype` views, rows of `arrayOf`) | trap | element distance in the flat layout | `legal-c` |
| `(T *) (intptr_t) p` | a non-dereferenceable constant | `p` again, within the process (segment); stale across segments and from save files (`resetHandles`, `ptrConstStale`) | `legal-c` |
| `realloc` of a record array (or a block that became records) | trap | a new array, records copied | `legal-c` |
| `malloc(sizeof (T) + k)` with `8 <= k < sizeof (T)` used as one `T` | the extra bytes dropped | record + `__tail` of `k` bytes (alloc's rounding, under 8, stays slack) | `legal-c` |
| `memset` with a nonzero byte of a field, nested arrays, pointer arrays; of part of an element | trap | through the object's bytes (`serial.js memImage/memStore`) | `legal-c` |
| `memcpy` of part of an element or record, between a record and bytes, records of two types, pointers and bytes | trap | through the bytes; pointers survive as handles | `legal-c` |
| `memcpy(&a.f, &b.f, k)` with `k` smaller than the field | copied the whole field | `k` bytes | `legal-c` |
| `memcmp` of records, fields, pointer arrays | trap | compares the C byte images (pointers by handle: equal iff equal) | `legal-c` |
| `memset`/`memcpy`/`memcmp` with `n == 0` | could trap on a one-past pointer | no-op | `legal-c` |
| `fread`/`fwrite`/`read`/`write` of part of a record or field, arrays of rows, raw blocks | trap | truncated / concatenated regions (`serial.js region`) | score (save/restore sessions) |
| `printf %p` of an object pointer | trap | its handle (equal pointers print alike; C's digits are addresses) | `legal-c` |
| `printf %s` of a fresh `malloc` block | trap | its bytes | `legal-c` |
| `printf %n`, `%a`/`%A`, `L`, `q`, `%lc`/`%ls` (Latin-1) | trap | as Darwin; `%a` follows `_hdtoa.c dorounding` (rounds up when the next digit is > 8, or 8 followed by an odd digit) | `tests/crt/printf-ext.test.mjs` (native diff) |
| `setjmp`/`longjmp` in the object world (`nhlua.c nhl_pcall` / `nhl_hookfn`: panic "Lua time exceeded") | trap | `tu.mjs objectSetjmp`: the handler becomes the catch of a try around the function; `longjmp` throws `ObjLongJmp` | `legal-c` |
| `localtime`/`mktime` before 1955 (LMT before 1883-11-18, 1918-1954 rules, war time EWT/EPT) | trap | table from Darwin's tz database (`tools/tz/gen-ny-early.mjs` → `js/crt/tz-ny-early.js`) | `tests/crt/time.test.mjs`, now 1800-2100 |

## Kept: the classification

| Site | Trap | Class | Why |
|---|---|---|---|
| `js/crt/alloc.js:65` | realloc of a block that is not a plain buffer | UB | realloc of a pointer that malloc did not return |
| `js/crt/alloc.js:72` | block used as bytes, then as a record | REPR | one malloc block used as two types |
| `js/crt/alloc.js:82` | block of … bytes used as a record of … | UB | a record in a block smaller than it |
| `js/crt/alloc.js:97` | block used as a record, then as an array | REPR | one malloc block used as two types |
| `js/crt/alloc.js:107` | block used as pointers and as other data | REPR | one malloc block used as two types |
| `js/crt/bridge.js:92` | bridge: an object passed as an opaque heap pointer | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:108` | bridge: no conversion to the heap for … | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:113` | bridge: a char * that is not a byte pointer | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:127` | bridge: a char * that is not a byte pointer | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:157` | bridge: no record table for … | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:197` | bridge: no conversion from the heap for … | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/bridge.js:242` | bridge: a callback returning a pointer into object memory | INTERNAL | the bridge descriptors are generated for every object/heap call (emit/bridge.mjs) |
| `js/crt/fs.js:161` | read() from a standard stream | INTERNAL | input arrives only through the async getchar (design 6) |
| `js/crt/heap.js:55` | static data region full | LIMIT | heap world: 16 MiB static data, 4 MiB stack, 1 GiB heap |
| `js/crt/heap.js:91` | heap stack overflow | LIMIT | heap world: 16 MiB static data, 4 MiB stack, 1 GiB heap |
| `js/crt/heap.js:108` | heap exhausted | LIMIT | heap world: 16 MiB static data, 4 MiB stack, 1 GiB heap |
| `js/crt/heap.js:159` | struct return too large | INTERNAL | heap-world calling convention |
| `js/crt/heap.js:175` | call through an invalid function pointer (…) | UB | calling through a pointer that is not a function |
| `js/crt/heap.js:191` | not a handle: … | INTERNAL | heap-world calling convention |
| `js/crt/heap.js:203` | runtime returned a pointer outside the heap | INTERNAL | heap-world calling convention |
| `js/crt/heaplibc.js:66` | __memcpy_chk: buffer overflow | UB | Darwin _FORTIFY_SOURCE aborts the process |
| `js/crt/heaplibc.js:70` | __strcpy_chk: buffer overflow | UB | Darwin _FORTIFY_SOURCE aborts the process |
| `js/crt/mem.js:19` | read out of bounds (… of …) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:24` | write out of bounds (… of …) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:54` | arithmetic on the address of field … beyond one past it | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:57` | index … from field … | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:58` | index … from field … | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:71` | read of .… through a pointer outside its array (index … of …) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:73` | write of .… through a pointer outside its array (index … of …) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:138` | arithmetic on a pointer to a record that is not an array element | UB | p + n beyond one past a lone object (p + 1 is supported) |
| `js/crt/mem.js:154` | difference of pointers to different arrays | UB | p - q of pointers into different objects (6.5.6p9) |
| `js/crt/mem.js:171` | difference of pointers to different buffers | UB | p - q of pointers into different objects (6.5.6p9) |
| `js/crt/mem.js:214` | ordering of a pointer made from an integer | UB | relational comparison of pointers into different objects (6.5.8p5) |
| `js/crt/mem.js:256` | strlen: no NUL terminator before the end of the buffer | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/mem.js:308` | index … out of range | UB | an index beyond 2^53: outside any object |
| `js/crt/mem.js:363` | __builtin_unreachable reached | UB | reaching unreachable code |
| `js/crt/mem.js:364` | call of …, which is not defined in the transpiled program | INTERNAL | a link error: emit-report.md lists undefined functions |
| `js/crt/printf.js:125` | format string not NUL-terminated | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/printf.js:152` | incomplete conversion at end of format | UB | an invalid conversion specification or argument type (7.21.6.1p9) |
| `js/crt/printf.js:167` | unsupported length modifier %…… | UB | an invalid conversion specification or argument type (7.21.6.1p9) |
| `js/crt/printf.js:203` | %s argument is not a byte pointer | UB | an invalid conversion specification or argument type (7.21.6.1p9) |
| `js/crt/printf.js:207` | %s: string not NUL-terminated | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/printf.js:242` | unsupported conversion %…… | UB | an invalid conversion specification or argument type (7.21.6.1p9) |
| `js/crt/printf.js:258` | %lc/%ls of wide character …: EILSEQ in the C locale (printf returning -1 is not modeled) | INPUT | printf fails with EILSEQ in C; NetHack never prints wide strings |
| `js/crt/printf.js:317` | detected buffer overflow (sprintf) | UB | Darwin _FORTIFY_SOURCE aborts the process |
| `js/crt/printf.js:322` | detected buffer overflow (vsnprintf) | UB | Darwin _FORTIFY_SOURCE aborts the process |
| `js/crt/proc.js:68` | abort() | UB | the C program aborts |
| `js/crt/proc.js:70` | assertion failed: … (…, …:…) | UB | the C program aborts |
| `js/crt/proc.js:83` | getchar() outside the async set | INTERNAL | input arrives only through the async getchar (design 6) |
| `js/crt/qsort.js:183` | qsort past the end of a record array | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/qsort.js:187` | qsort of a base that is neither a scalar/pointer array nor a record array | INTERNAL | qsort bases are arrays the emitter produced |
| `js/crt/serial.js:29` | use of a stale pointer read from a save file (.…) | UB | dereferencing an address of an earlier process (or freed memory) |
| `js/crt/serial.js:65` | serialize: kind … | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:73` | serialize: bit-field outside a record | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:77` | serialize: not a record | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:111` | deserialize: kind … | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:127` | deserialize: bit-field outside a record | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:131` | deserialize: not a record | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:187` | memory access out of bounds (…+… of … bytes) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/serial.js:193` | serialize: … bytes of a …-byte object | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:205` | serialize: past the end of the array | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/serial.js:229` | serialize: not an aggregate | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:235` | sizeof of an unknown value | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/serial.js:281` | serialize: a buffer that is not bytes, a scalar, a record or an array | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/stdio.js:28` | read from … | INTERNAL | input arrives only through the async getchar (design 6) |
| `js/crt/string.js:20` | detected buffer overflow (…) | UB | Darwin _FORTIFY_SOURCE aborts the process |
| `js/crt/string.js:116` | … of … records past the end of the array | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/string.js:124` | sizeof of an unknown value | INTERNAL | serializer kinds come from the generated $fields tables |
| `js/crt/string.js:169` | memset past the end of an array | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/string.js:247` | memcpy past the end of an array | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/string.js:272` | memory access out of bounds (…+… of … bytes) | UB | access outside an object (C11 6.5.6p8) |
| `js/crt/termcap.js:123` | tparm: %… in … | INPUT | an invalid terminfo string (TERM is fixed: xterm-256color) |
| `js/crt/time.js:57` | dstRange(…): the 1955 rules asked about an earlier year (zoneAt uses the tz table there) | INTERNAL | the 1955 rules are only asked about 1955 on |
| `js/crt/ucell.js:46` | union cell: member kind … | INTERNAL | cell member kinds: tests/crt/legal-c.test.mjs checks every generated union cell |
| `js/crt/ucell.js:65` | union cell: member kind … | INTERNAL | cell member kinds: tests/crt/legal-c.test.mjs checks every generated union cell |
| `js/crt/ucell.js:88` | union cell: member … of kind … | INTERNAL | cell member kinds: tests/crt/legal-c.test.mjs checks every generated union cell |
| `js/crt/ucell.js:127` | union cell: copy from a value that is not a cell | INTERNAL | cell member kinds: tests/crt/legal-c.test.mjs checks every generated union cell |
| `js/crt/va.js:10` | va_arg past the last argument | UB | access outside an object (C11 6.5.6p8) |

## REPR: one block used as two types

`alloc.js` traps when one `malloc` block is cast to a record and then used as bytes or
an array of another type (or the other way round). C allows it (the storage takes the
effective type of what is stored, C11 6.5p6), but the object world keeps a record as an
object, and two views of one block would be two copies of the data. The design answer is
the heap world (`repr: heap` for the type, CLAUDE.md 2.1-2.3). No session or fuzz case
reaches these traps. If one does, the fix is an annotation decided by the owner, not a
runtime change.
