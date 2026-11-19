// Legal C the object model used to trap on (trap audit, transpiler/out/trap-audit.md, 2026-11-19).
// Each test is a C construct with defined behavior; the comment gives the C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ptr, FieldRef, peq, pdiff, recTail, matrix, ptrToInt, ptrConst, ptrConstStale, resetHandles, recArray } from '../../js/crt/mem.js';
import { malloc, realloc, asRec, asArr } from '../../js/crt/alloc.js';
import { memcpy, memset, memcmp } from '../../js/crt/string.js';
import { cformat } from '../../js/crt/printf.js';
import { VaList } from '../../js/crt/va.js';
import { setjmp, longjmp, isLongJmpTo } from '../../js/crt/proc.js';
import { lit } from '../../js/crt/mem.js';

// struct pr { short x, y; struct pr *next; long n; }  (16 + 8 bytes, C layout)
class Pr {
    static $size = 24;
    static $fields() { return [['x', 0, 'i16'], ['y', 2, 'i16'], ['next', 8, 'ptr'], ['n', 16, 'i64']]; }
    constructor() { this.x = 0; this.y = 0; this.next = null; this.n = 0; }
    $copyFrom(s) { this.x = s.x; this.y = s.y; this.next = s.next; this.n = s.n; return this; }
    $clone() { return new Pr().$copyFrom(this); }
}
const fmt = (f, ...a) => String.fromCharCode(...cformat(lit(f), new VaList(a)));

test('&s.f + 1: one past a scalar field', () => {
    const o = { a: 5 };
    const p = new FieldRef(o, 'a', 'i32'), e = p.add(1);
    assert.ok(!peq(p, e) && peq(e, p.add(1)) && peq(e.add(-1), p));
    assert.equal(pdiff(e, p), 1);
    assert.throws(() => e.get(0), /index 1/);
    assert.throws(() => p.add(2), /beyond one past/);
});

test('(char *) (p + 1) of a record without a trailing area: one past it', () => {
    const r = new Pr();
    const a = recTail(r), b = recTail(r);
    assert.ok(peq(a, b) && !peq(a, recTail(new Pr())));
    assert.throws(() => a.get(0), /out of bounds/);
});

test('p - q across rows of one matrix (char m[3][4])', () => {
    const m = matrix(Int8Array, [3, 4]);
    assert.equal(pdiff(new Ptr(m[2], 1), new Ptr(m[0], 3)), 6);
});

test('(T *) (intptr_t) p == p within a process; stale across processes and save files', () => {
    const r = new Pr();
    const n = ptrToInt(r);
    assert.equal(ptrConst(n), r);
    assert.notEqual(ptrConstStale(n), r);
    resetHandles();   // a new segment (C process)
    assert.notEqual(ptrConst(n), r);
    assert.equal(ptrConst(n).$const, String(n));
});

test('realloc of a record array keeps the records', () => {
    const a = asRec(malloc(2 * 24), Pr, 24);
    a.x = 7; a.__arr[1].y = 9;
    const b = asRec(realloc(a, 4 * 24), Pr, 24);
    assert.equal(b.__arr.length, 4);
    assert.equal(b.x, 7); assert.equal(b.__arr[1].y, 9);
});

test('a block larger than its record, not a multiple: the record and bytes past it', () => {
    const r = asRec(malloc(24 + 10), Pr, 24);
    assert.equal(r.__tail.length, 10);
    assert.throws(() => asRec(malloc(20), Pr, 24), /20 bytes used as a record of 24/);
});

test('memcpy / memset / memcmp on parts of records, fields and mixed data', () => {
    const a = new Pr(), b = new Pr(), t = new Pr();
    Object.assign(a, { x: 1, y: 2, next: t, n: 3 });
    memcpy(b, a, 4);                                   // memcpy(&b, &a, offsetof(struct pr, next))
    assert.deepEqual([b.x, b.y, b.next, b.n], [1, 2, null, 0]);
    const buf = new Ptr(new Int8Array(24), 0);
    memcpy(buf, a, 24); memcpy(b, buf, 24);            // struct -> char[] -> struct keeps the pointer
    assert.equal(b.next, t); assert.equal(b.n, 3);
    assert.equal(memcmp(a, b, 24), 0);
    b.n = 4; assert.notEqual(memcmp(a, b, 24), 0);
    const i = { v: 0 };
    memset(new FieldRef(i, 'v', 'i32'), 0xff, 4);      // memset(&i, 0xff, sizeof i)
    assert.equal(i.v, -1);
    memset(new FieldRef(i, 'v', 'i32'), 0, 2);         // the low two bytes
    assert.equal(i.v, -65536);
    const arr = recArray(Pr, 2);
    arr[1].x = 5;
    memset(arr[0], 0x01, 26);                          // one record and two bytes of the next
    assert.equal(arr[0].x, 0x0101); assert.equal(arr[1].x, 0x0101); assert.equal(arr[1].y, 0);
    assert.ok(arr[0].next !== null);                   // a pointer of 0x0101... bytes: non-null
    const ps = new Ptr(Object.assign([t, null], { $kind: 'ptr' }), 0), w = new Ptr(new Int8Array(16), 0);
    memcpy(w, ps, 16); memcpy(new Ptr(ps.buf, 1), w, 8);   // pointers through bytes
    assert.equal(ps.buf[1], t);
    assert.equal(memset(a, 1, 0), a);                  // n == 0: nothing, whatever the pointer
});

test('printf: %p of any pointer, %s of a fresh malloc block, %n', () => {
    const r = new Pr();
    assert.equal(fmt('%p', r), fmt('%p', r));
    assert.notEqual(fmt('%p', r), fmt('%p', new Pr()));
    const blk = malloc(4); asArr(blk, Int8Array).buf.set([104, 105, 0]);
    assert.equal(fmt('[%s]', blk), '[hi]');
    const n = new Ptr(new Int32Array(1), 0);
    assert.equal(fmt('ab%ncd', n), 'abcd'); assert.equal(n.get(0), 2);
});

test('longjmp to an armed buffer reaches the frame that called setjmp', async () => {
    const jb = new Int32Array(48);
    async function hook() { longjmp(new Ptr(jb, 0), 1); }
    async function pcall() {   // as tu.mjs objectSetjmp emits nhlua.c nhl_pcall
        let $t1;
        try {
            $t1 = new Ptr(jb, 0), setjmp($t1);
            await hook();
            return 'returned';
        } catch ($e) {
            if (!isLongJmpTo($e, $t1)) throw $e;
            return 'handler';
        }
    }
    assert.equal(await pcall(), 'handler');
    await assert.rejects(hook(), /longjmp/);           // not armed: escapes (undefined in C)
});

test('every union cell member has a kind the cell accessors support (ucell.js)', async () => {
    const T = await import('../../js/nh/types.js');
    const TYPED = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'f32', 'f64']);
    const bad = [];
    const walk = (R, at, seen) => {
        if (seen.has(R)) return; seen.add(R);
        for (const [js, , k] of R.$fields ? R.$fields() : []) {
            if (typeof k === 'string' || k.bits || k.raw || (k.arr && typeof k.arr === 'string' && TYPED.has(k.arr))) continue;
            if (k.rec) walk(k.rec, `${at}.${js}`, seen); else bad.push(`${at}.${js}`);
        }
    };
    let cells = 0;
    for (const [n, C] of Object.entries(T)) if (typeof C === 'function' && C.$cell) { cells++; walk(C, n, new Set()); }
    assert.ok(cells > 0);
    assert.deepEqual(bad, []);
});

test('every runtime trap is classified (tools/trap-audit.mjs)', async () => {
    const { execFileSync } = await import('node:child_process');
    const url = new URL('../../tools/trap-audit.mjs', import.meta.url);
    const out = execFileSync(process.execPath, [url.pathname]).toString();
    assert.match(out, /^\d+ trap sites: /);
    assert.doesNotMatch(out, /UNCLASSIFIED/);
});
