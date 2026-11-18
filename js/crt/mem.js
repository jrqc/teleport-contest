// js/crt/mem.js: pointer representations of the object world
// (transpiler-design.md 3.3). Hand-written runtime.

import { CTrap } from './int.js';

/**
 * Ptr: a pointer into an indexable buffer: `Int8Array` for `char *` (char is
 * signed), `Uint8Array` for `unsigned char *`, other
 * typed arrays for scalar elements, JS arrays for pointer or 64-bit elements
 * and for arrays of arrays. A value: arithmetic returns a new Ptr; `buf` is
 * shared, like the memory it points into. NULL is `null`, never a Ptr.
 * Address-taken scalar variables are one-element buffers, so `&x` is Ptr(x, 0).
 */
export class Ptr {
    constructor(buf, off = 0) { this.buf = buf; this.off = off; }
    add(n) { return new Ptr(this.buf, this.off + Number(n)); }
    get(i = 0) {
        const j = this.off + i;
        if (j < 0 || j >= this.buf.length) throw new CTrap(`read out of bounds (${j} of ${this.buf.length})`);
        return this.buf[j];
    }
    set(i, v) {
        const j = this.off + i;
        if (j < 0 || j >= this.buf.length) throw new CTrap(`write out of bounds (${j} of ${this.buf.length})`);
        this.buf[j] = v;
        return v;
    }
}
export { Ptr as BytePtr };   // char * is a Ptr over an Int8Array (or Uint8Array)

/**
 * A pointer cast between char * and unsigned char * (or other scalar element
 * types): a typed-array view of the same memory, so reads get the new type's
 * signedness. Equality with the original pointer is not preserved (rare).
 */
export function retype(p, View) {
    if (p === null || !(p instanceof Ptr) || !ArrayBuffer.isView(p.buf) || p.buf instanceof View) return p;
    const b = p.buf;
    const scale = b.BYTES_PER_ELEMENT / View.BYTES_PER_ELEMENT;
    return new Ptr(new View(b.buffer, b.byteOffset, b.byteLength / View.BYTES_PER_ELEMENT), p.off * scale);
}

/** &obj.field for a scalar or pointer field: deref only (arithmetic beyond +0 traps). */
export class FieldRef {
    constructor(obj, key) { this.obj = obj; this.key = key; }
    add(n) { if (Number(n) !== 0) throw new CTrap(`arithmetic on the address of field ${this.key}`); return this; }
    get(i = 0) { if (i !== 0) throw new CTrap(`index ${i} from field ${this.key}`); return this.obj[this.key]; }
    set(i, v) { if (i !== 0) throw new CTrap(`index ${i} from field ${this.key}`); this.obj[this.key] = v; return v; }
}

/**
 * Record pointers are the record objects. Records created as array elements
 * carry __arr and __idx (recArray), so pointer arithmetic works; a position
 * outside the array (one past the end, or before the start while iterating) is
 * an ElemPtr, which can be compared and moved but not dereferenced.
 */
export class ElemPtr {
    constructor(arr, idx) { this.__arr = arr; this.__idx = idx; }
}
/** An array of n records of class T (zero-initialized), with back-references. */
export function recArray(T, n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) { const o = new T(); o.__arr = a; o.__idx = i; a[i] = o; }
    return a;
}
/** Element i of a record array as a pointer value (&a[i]): the object, or an ElemPtr outside it. */
export const relem = (a, i) => (i >= 0 && i < a.length ? a[i] : new ElemPtr(a, i));
/** p + n for a record pointer. */
export function radd(p, n) {
    if (n === 0) return p;
    const a = p.__arr;
    if (a === undefined) throw new CTrap('arithmetic on a pointer to a record that is not an array element');
    return relem(a, p.__idx + Number(n));
}
/** p - q for record pointers into the same array (element count). */
export function rdiff(p, q) {
    if (p.__arr === undefined || p.__arr !== q.__arr) {
        if (p === q) return 0;
        throw new CTrap('difference of pointers to different arrays');
    }
    return p.__idx - q.__idx;
}
/** p - q for Ptr values (element count). */
export function pdiff(p, q) {
    if (p.buf !== q.buf) throw new CTrap('difference of pointers to different buffers');
    return p.off - q.off;
}
/**
 * Pointer equality for data pointers of any kind (== in C). null equals only null.
 * Element positions compare by (array, index), so a freshly made ElemPtr equals the
 * object at the same place.
 */
export function peq(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a instanceof Ptr) return b instanceof Ptr && a.buf === b.buf && a.off === b.off;
    if (a instanceof FieldRef) return b instanceof FieldRef && a.obj === b.obj && a.key === b.key;
    if (a.__arr !== undefined) return a.__arr === b.__arr && a.__idx === b.__idx;
    return false;
}
/** Ordering of data pointers (<, <=, >, >= in C): -1, 0, 1. Only within one buffer/array. */
export function pcmp(a, b) {
    let x, y;
    if (a instanceof Ptr && b instanceof Ptr && a.buf === b.buf) { x = a.off; y = b.off; }
    else if (a && b && a.__arr !== undefined && a.__arr === b.__arr) { x = a.__idx; y = b.__idx; }
    else if (peq(a, b)) return 0;
    else throw new CTrap('ordering of unrelated pointers');
    return x < y ? -1 : x > y ? 1 : 0;
}

const LITS = new Map();
/**
 * A string literal: one shared NUL-terminated Int8Array per distinct text,
 * like ld64's cstring merging. `s` holds one char per byte (\xNN escapes).
 * Literals are read-only in C; writing to one is a C bug.
 */
export function lit(s) {
    let p = LITS.get(s);
    if (p === undefined) {
        const b = new Int8Array(s.length + 1);   // char[]: char is signed
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        p = new Ptr(b, 0);
        LITS.set(s, p);
    }
    return p;
}

/** Bytes available from p to the end of its buffer (clang's __builtin_object_size, mode 0, when known). */
export const bytesLeft = (p) => p.buf.length - p.off;

const enc = new TextEncoder();
/** A fresh NUL-terminated byte string (Latin-1 / ASCII text); tests and diagnostics. */
export function cstrLiteral(s) {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xff) throw new Error(`cstrLiteral: non-byte character in ${JSON.stringify(s)}`);
        b[i] = c;
    }
    return new Ptr(b, 0);
}
export const utf8 = (s) => enc.encode(s);

/** strlen with C semantics (throws instead of reading past the buffer). */
export function cstrlen(p) {
    const { buf, off } = p;
    let i = off;
    while (i < buf.length && buf[i] !== 0) i++;
    if (i >= buf.length) throw new CTrap('strlen: no NUL terminator before the end of the buffer');
    return i - off;
}

/** The bytes of a NUL-terminated string, as a JS string with one char per byte (for diagnostics and tests). */
export function cstrToJs(p) {
    const n = cstrlen(p);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(p.buf[p.off + i] & 0xff);
    return s;
}

// ---------- helpers for generated code ----------
/** n zeros: arrays of 64-bit integers (Number|BigInt elements). */
export const zeros = (n) => new Array(n).fill(0);
/** n NULL pointers. */
export const nulls = (n) => new Array(n).fill(null);
/** An array of n sub-arrays (multi-dimensional C arrays). */
export function arrayOf(n, make) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = make(); return a; }
/** A 64-bit integer used as an index or pointer offset: a safe Number. */
export function idx(x) {
    if (typeof x === 'number') return x;
    throw new CTrap(`index ${x} out of range`);
}
const CONSTS = new Map();
/**
 * An integer converted to a pointer: (T *) 0 is NULL; any other value is an
 * interned, non-dereferenceable pointer value (design 3.3), equal only to
 * itself, so sentinels like (struct bill_x *) -1000 compare as in C.
 */
export function ptrConst(n) {
    if (n == 0) return null;
    const k = String(n);
    let p = CONSTS.get(k);
    if (p === undefined) { p = Object.freeze({ $const: k }); CONSTS.set(k, p); }
    return p;
}
/** A pointer converted to an integer: 0 for NULL, the value for ptrConst, else a handle number. */
let nextHandle = 2 ** 40;
const HANDLES = new WeakMap();
export function ptrToInt(p) {
    if (p === null) return 0;
    if (p.$const !== undefined) return Number(p.$const);
    let h = HANDLES.get(p);
    if (h === undefined) { h = nextHandle; nextHandle += 16; HANDLES.set(p, h); }
    return h;
}
export function unreachable() { throw new CTrap('__builtin_unreachable reached'); }
export function missing(name) { return () => { throw new CTrap(`call of ${name}, which is not defined in the transpiled program`); }; }
