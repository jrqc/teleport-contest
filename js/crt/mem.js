// js/crt/mem.js: pointer representations of the object world
// (transpiler-design.md 3.3). Hand-written runtime. This file grows with the
// emitter; it starts with byte pointers, which the string and format code need.

import { CTrap } from './int.js';

/**
 * A pointer into a byte array: C `char *`, `unsigned char *`.
 * A value: arithmetic returns a new BytePtr; `buf` is shared, like the memory
 * it points into. NULL is `null`, never a BytePtr.
 */
export class BytePtr {
    constructor(buf, off = 0) { this.buf = buf; this.off = off; }
    add(n) { return new BytePtr(this.buf, this.off + n); }
    get(i = 0) {
        const j = this.off + i;
        if (j < 0 || j >= this.buf.length) throw new CTrap(`byte read out of bounds (${j} of ${this.buf.length})`);
        return this.buf[j];
    }
    set(i, v) {
        const j = this.off + i;
        if (j < 0 || j >= this.buf.length) throw new CTrap(`byte write out of bounds (${j} of ${this.buf.length})`);
        this.buf[j] = v;
    }
}

/** Bytes available from p to the end of its buffer (clang's __builtin_object_size, mode 0, when known). */
export const bytesLeft = (p) => p.buf.length - p.off;

const enc = new TextEncoder();
/** A NUL-terminated byte string literal (Latin-1 / ASCII source text). */
export function cstrLiteral(s) {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xff) throw new Error(`cstrLiteral: non-byte character in ${JSON.stringify(s)}`);
        b[i] = c;
    }
    return new BytePtr(b, 0);
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
    for (let i = 0; i < n; i++) s += String.fromCharCode(p.buf[p.off + i]);
    return s;
}
