// nh_deterministic_qsort override: stable, same comparator sequence sync and async,
// pointer arrays and record arrays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nh_deterministic_qsort, nh_deterministic_qsort$async } from '../../js/crt/qsort.js';
import { Ptr, recArray } from '../../js/crt/mem.js';

class R { constructor() { this.k = 0; this.tag = 0; } $copyFrom(s) { this.k = s.k; this.tag = s.tag; return this; } $clone() { return new R().$copyFrom(this); } }

test('pointer array: stable by index, comparator sees element pointers', async () => {
    const mk = () => { const objs = [3, 1, 3, 2, 1, 3, 0, 2].map((k, i) => ({ k, i })); return new Ptr(objs.slice(), 0); };
    const log1 = [], log2 = [];
    const cmp = (log) => (pa, pb) => { const a = pa.get(0), b = pb.get(0); log.push(`${a.i}:${b.i}`); return a.k - b.k; };
    const p1 = mk(); nh_deterministic_qsort(p1, 8, 8, cmp(log1));
    const p2 = mk(); await nh_deterministic_qsort$async(p2, 8, 8, async (a, b) => cmp(log2)(a, b));
    assert.deepEqual(p1.buf.map((o) => o.i), [6, 1, 4, 3, 7, 0, 2, 5]);
    assert.deepEqual(p2.buf.map((o) => o.i), p1.buf.map((o) => o.i));
    assert.deepEqual(log2, log1);
});
test('record array: elements move by value, identities stay at positions', () => {
    const a = recArray(R, 5);
    [4, 2, 4, 1, 2].forEach((k, i) => { a[i].k = k; a[i].tag = i; });
    const ids = a.slice();
    nh_deterministic_qsort(a[0], 5, 8, (x, y) => x.k - y.k);
    assert.deepEqual(a.map((r) => r.tag), [3, 1, 4, 0, 2]);
    assert.ok(a.every((r, i) => r === ids[i] && r.__idx === i));
});
