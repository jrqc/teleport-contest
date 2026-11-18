// js/crt/string.js: <string.h> and <stdlib.h> string/number parsing on byte
// pointers (transpiler-design.md 5). Hand-written runtime.
//
// Pointers are BytePtr (js/crt/mem.js); NULL is null. Functions returning a
// pointer into an argument return a BytePtr into the same buffer. Reading or
// writing past a buffer throws CTrap where C would read or corrupt other memory.
// The macOS fortified forms (__builtin___strcpy_chk etc.) take clang's
// __builtin_object_size of the destination; (size_t)-1 means unknown. Darwin
// aborts on overflow; these throw CTrap.
import { CTrap, i32, u64, i64, norm } from './int.js';
import { BytePtr, Ptr, cstrlen } from './mem.js';
import { RawBlock, asArr } from './alloc.js';
import { isspace, isdigit, isalpha, tolower } from './ctype.js';

// bytes compare as unsigned char (Darwin); char buffers are Int8Array, so mask
const at = (p, i) => p.get(i) & 0xff;
const UNKNOWN = (s) => s === -1 || s === 18446744073709551615n || s === 2 ** 64 - 1;
function chk(objsize, need, what) {
    if (!UNKNOWN(objsize) && need > Number(objsize)) throw new CTrap(`detected buffer overflow (${what})`);
}

export const strlen = (s) => cstrlen(s);

export function strcmp(a, b) {
    for (let i = 0; ; i++) {
        const x = at(a, i), y = at(b, i);
        if (x !== y) return x - y;   // Darwin: difference of unsigned chars
        if (x === 0) return 0;
    }
}
export function strncmp(a, b, n) {
    n = Number(n);
    for (let i = 0; i < n; i++) {
        const x = at(a, i), y = at(b, i);
        if (x !== y) return x - y;
        if (x === 0) return 0;
    }
    return 0;
}
export const strcoll = strcmp;   // "C" locale

export function strchr(s, c) {
    c &= 0xff;
    for (let i = 0; ; i++) {
        const x = at(s, i);
        if (x === c) return s.add(i);
        if (x === 0) return null;
    }
}
export function strrchr(s, c) {
    c &= 0xff;
    let r = null;
    for (let i = 0; ; i++) {
        const x = at(s, i);
        if (x === c) r = s.add(i);
        if (x === 0) return r;
    }
}
export function strstr(h, n) {
    const nl = cstrlen(n);
    if (nl === 0) return h;
    for (let i = 0; at(h, i) !== 0; i++) {
        let j = 0;
        while (j < nl && at(h, i + j) === at(n, j)) j++;
        if (j === nl) return h.add(i);
    }
    return null;
}
function inSet(set, c) { for (let k = 0; ; k++) { const x = at(set, k); if (x === 0) return false; if (x === c) return true; } }
export function strspn(s, set) { let i = 0; while (at(s, i) !== 0 && inSet(set, at(s, i))) i++; return i; }
export function strcspn(s, set) { let i = 0; while (at(s, i) !== 0 && !inSet(set, at(s, i))) i++; return i; }
export function strpbrk(s, set) {
    for (let i = 0; at(s, i) !== 0; i++) if (inSet(set, at(s, i))) return s.add(i);
    return null;
}

export function strcpy(d, s) {
    for (let i = 0; ; i++) { const x = at(s, i); d.set(i, x); if (x === 0) return d; }
}
export function strncpy(d, s, n) {
    n = Number(n);
    let i = 0;
    for (; i < n; i++) { const x = at(s, i); d.set(i, x); if (x === 0) break; }
    for (; i < n; i++) d.set(i, 0);   // pad with NULs
    return d;
}
export function strcat(d, s) { strcpy(d.add(cstrlen(d)), s); return d; }
export function strncat(d, s, n) {
    n = Number(n);
    const dl = cstrlen(d);
    let i = 0;
    for (; i < n; i++) { const x = at(s, i); if (x === 0) break; d.set(dl + i, x); }
    d.set(dl + i, 0);
    return d;
}
export function __builtin___strcpy_chk(d, s, objsize) { chk(objsize, cstrlen(s) + 1, 'strcpy'); return strcpy(d, s); }
export function __builtin___strcat_chk(d, s, objsize) { chk(objsize, cstrlen(d) + cstrlen(s) + 1, 'strcat'); return strcat(d, s); }
export function __builtin___strncpy_chk(d, s, n, objsize) { chk(objsize, Number(n), 'strncpy'); return strncpy(d, s, n); }
export function __builtin___strncat_chk(d, s, n, objsize) {
    let sl = 0; while (sl < Number(n) && at(s, sl) !== 0) sl++;
    chk(objsize, cstrlen(d) + sl + 1, 'strncat');
    return strncat(d, s, n);
}

// ---------- byte memory (BytePtr operands) ----------
// Object-world operands: a record object (memset to 0 resets it, memcpy of a
// whole record copies it), a RawBlock (bytes not yet typed), or a Ptr.
const isRec = (x) => x !== null && typeof x === 'object' && typeof x.$copyFrom === 'function';
function asBytes(p) {
    if (p instanceof RawBlock) return p.obj !== null ? p.obj : asArr(p, Uint8Array);
    return p;
}
export function memset(d, c, n) {
    n = Number(n); c &= 0xff;
    const D = asBytes(d);
    if (isRec(D)) {
        if (c !== 0) throw new CTrap('memset of a record with a nonzero byte');
        D.$copyFrom(new D.constructor());
        if (D.__tail) D.__tail.fill(0);   // struct + trailing area (struct engr)
        return d;
    }
    if (D instanceof Ptr && !ArrayBuffer.isView(D.buf)) {   // array of pointers / 64-bit values: only 0 is meaningful
        if (c !== 0 || n % 8 !== 0) throw new CTrap('memset of a pointer array with a nonzero byte');
        const z = D.buf.$kind === 'i64' || typeof D.buf[D.off] === 'number' ? 0 : null;
        for (let i = 0; i < n / 8; i++) D.set(i, z);
        return d;
    }
    bytesView(D, n).fill(c);
    return d;
}
export function memcpy(d, s, n) {   // overlapping memcpy is undefined in C; copy like memmove
    return memmove(d, s, n);
}
export function memmove(d, s, n) {
    n = Number(n);
    const D = asBytes(d), Sx = asBytes(s);
    if (isRec(D) || isRec(Sx)) {
        if (!(isRec(D) && isRec(Sx) && D.constructor === Sx.constructor)) throw new CTrap('memcpy between a record and other data');
        D.$copyFrom(Sx);
        return d;
    }
    if (!ArrayBuffer.isView(D.buf) || !ArrayBuffer.isView(Sx.buf)) {   // pointer arrays: element-wise (8 bytes each)
        if (n % 8 !== 0) throw new CTrap('partial copy of a pointer array');
        const k = n / 8;
        if (D.buf === Sx.buf && D.off > Sx.off) for (let i = k - 1; i >= 0; i--) D.set(i, Sx.get(i));
        else for (let i = 0; i < k; i++) D.set(i, Sx.get(i));
        return d;
    }
    bytesView(D, n).set(bytesView(Sx, n));   // TypedArray.set copies as if through a temporary (memmove)
    return d;
}
/** The n bytes at typed-array pointer p, as a Uint8Array over the same memory (bounds-checked). */
export function bytesView(p, n) {
    const b = p.buf, bpe = b.BYTES_PER_ELEMENT;
    const start = p.off * bpe;
    if (p.off < 0 || start + n > b.byteLength) throw new CTrap(`memory access out of bounds (${start}+${n} of ${b.byteLength} bytes)`);
    return new Uint8Array(b.buffer, b.byteOffset + start, n);
}
export function memcmp(a, b, n) {
    n = Number(n);
    const A = asBytes(a), B = asBytes(b);
    if (!ArrayBuffer.isView(A.buf) || !ArrayBuffer.isView(B.buf)) throw new CTrap('memcmp of non-byte data');
    const x = bytesView(A, n), y = bytesView(B, n);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}
export function memchr(s, c, n) {
    n = Number(n); c &= 0xff;
    for (let i = 0; i < n; i++) if (at(s, i) === c) return s.add(i);
    return null;
}
export function __builtin___memset_chk(d, c, n, objsize) { chk(objsize, Number(n), 'memset'); return memset(d, c, n); }
export function __builtin___memcpy_chk(d, s, n, objsize) { chk(objsize, Number(n), 'memcpy'); return memcpy(d, s, n); }
export function __builtin___memmove_chk(d, s, n, objsize) { chk(objsize, Number(n), 'memmove'); return memmove(d, s, n); }

// ---------- number parsing ----------
export const abs = (x) => (x < 0 ? (x === -2147483648 ? x : -x) : x);   // abs(INT_MIN) wraps
export const labs = (x) => i64(x < 0 ? -BigInt(x) : x);

/**
 * strtol / strtoul / strtoll / strtoull core (Darwin, C locale).
 * endptr: null or a reference with set(BytePtr). Returns the clamped value
 * (LONG_MAX/LONG_MIN/ULONG_MAX on overflow; errno is not modeled yet).
 */
function strtoX(s, endptr, base, unsigned, bits) {
    let i = 0;
    while (isspace(at(s, i))) i++;
    let neg = false;
    if (at(s, i) === 45) { neg = true; i++; } else if (at(s, i) === 43) i++;
    const start = i;
    if ((base === 0 || base === 16) && at(s, i) === 48 && (at(s, i + 1) | 0x20) === 120) {
        const d = digit(at(s, i + 2));
        if (d >= 0 && d < 16) { i += 2; base = 16; }
    }
    if (base === 0) base = at(s, i) === 48 ? 8 : 10;
    let acc = 0n, any = false, over = false;
    const B = BigInt(base);
    const LIM = unsigned ? (1n << BigInt(bits)) - 1n : (neg ? (1n << BigInt(bits - 1)) : (1n << BigInt(bits - 1)) - 1n);
    for (;; i++) {
        const d = digit(at(s, i));
        if (d < 0 || d >= base) break;
        any = true;
        if (!over) { acc = acc * B + BigInt(d); if (acc > LIM) over = true; }
    }
    if (endptr) endptr.set(any ? s.add(i) : s);   // no digits: endptr = the original string
    if (!any) { void start; return 0; }
    let v;
    if (over) v = unsigned ? LIM : (neg ? -LIM : LIM);
    else v = neg ? -acc : acc;
    if (unsigned) v = BigInt.asUintN(bits, v);   // strtoul("-1") == ULONG_MAX
    return norm(v);
}
function digit(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 122) return c - 87;
    if (c >= 65 && c <= 90) return c - 55;
    return -1;
}
export const strtol = (s, e, b) => strtoX(s, e, b, false, 64);
export const strtoll = strtol;
export const strtoul = (s, e, b) => strtoX(s, e, b, true, 64);
export const strtoull = strtoul;
export const atoi = (s) => i32(strtoX(s, null, 10, false, 64));
export const atol = (s) => strtoX(s, null, 10, false, 64);

/** strtod (C locale): decimal and hex floats, inf/infinity/nan(...). Correctly rounded. */
export function strtod(s, endptr) {
    let i = 0;
    while (isspace(at(s, i))) i++;
    const begin = i;
    let txt = '';
    if (at(s, i) === 45 || at(s, i) === 43) txt += String.fromCharCode(at(s, i++));
    const word = (w) => { for (let k = 0; k < w.length; k++) if (tolower(at(s, i + k)) !== w.charCodeAt(k)) return false; return true; };
    let v;
    if (word('inf')) { i += word('infinity') ? 8 : 3; v = txt === '-' ? -Infinity : Infinity; }
    else if (word('nan')) {
        i += 3;
        if (at(s, i) === 40) { let k = i + 1; while (isalpha(at(s, k)) || isdigit(at(s, k)) || at(s, k) === 95) k++; if (at(s, k) === 41) i = k + 1; }
        v = NaN;
    } else if (at(s, i) === 48 && (at(s, i + 1) | 0x20) === 120 && (digit(at(s, i + 2)) >= 0 && digit(at(s, i + 2)) < 16 || (at(s, i + 2) === 46 && digit(at(s, i + 3)) >= 0 && digit(at(s, i + 3)) < 16))) {
        i += 2;
        let mant = 0n, exp2 = 0, any = false;
        while (digit(at(s, i)) >= 0 && digit(at(s, i)) < 16) { mant = mant * 16n + BigInt(digit(at(s, i++))); any = true; }
        if (at(s, i) === 46) { i++; while (digit(at(s, i)) >= 0 && digit(at(s, i)) < 16) { mant = mant * 16n + BigInt(digit(at(s, i++))); exp2 -= 4; any = true; } }
        if (any && (at(s, i) | 0x20) === 112) {
            let k = i + 1, eneg = false;
            if (at(s, k) === 45 || at(s, k) === 43) eneg = at(s, k++) === 45;
            if (isdigit(at(s, k))) { let e = 0; while (isdigit(at(s, k))) e = Math.min(e * 10 + (at(s, k++) - 48), 1e6); exp2 += eneg ? -e : e; i = k; }
        }
        v = hexToDouble(mant, exp2);
        if (txt === '-') v = -v;
    } else {
        let digits = '', anyd = false;
        while (isdigit(at(s, i))) { digits += String.fromCharCode(at(s, i++)); anyd = true; }
        if (at(s, i) === 46) { const save = i; i++; let frac = ''; while (isdigit(at(s, i))) { frac += String.fromCharCode(at(s, i++)); anyd = true; } if (!anyd) i = save; else digits += '.' + frac; }
        if (!anyd) { if (endptr) endptr.set(s); return 0; }
        if ((at(s, i) | 0x20) === 101) {
            let k = i + 1, e = '';
            if (at(s, k) === 45 || at(s, k) === 43) e += String.fromCharCode(at(s, k++));
            if (isdigit(at(s, k))) { while (isdigit(at(s, k))) e += String.fromCharCode(at(s, k++)); digits += 'e' + e; i = k; }
        }
        v = Number(txt + (digits.startsWith('.') ? '0' + digits : digits));   // JS parsing is correctly rounded
    }
    void begin;
    if (endptr) endptr.set(s.add(i));
    return v;
}
function hexToDouble(mant, exp2) {
    if (mant === 0n) return 0;
    // exact rounding: reduce the mantissa to 54 bits with a sticky bit, then let Number round once
    let bits = mant.toString(2).length;
    if (bits > 64) {
        const drop = bits - 64;
        const sticky = (mant & ((1n << BigInt(drop)) - 1n)) !== 0n ? 1n : 0n;
        mant = (mant >> BigInt(drop)) | sticky;
        exp2 += drop;
    }
    // Number(BigInt) rounds to nearest even; scaling by a power of two is exact unless subnormal
    let v = Number(mant);
    if (v === Infinity) return Infinity;
    // scale in exact steps while the value stays normal; the last step rounds once
    // (results in the subnormal range can be double-rounded: not needed by NetHack/Lua)
    while (exp2 < -1000) { v *= 2 ** -1000; exp2 += 1000; }
    while (exp2 > 1000) { v *= 2 ** 1000; exp2 -= 1000; if (v === Infinity) return v; }
    return v * 2 ** exp2;
}
export const atof = (s) => strtod(s, null);

