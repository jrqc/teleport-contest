// Pointer rules of js/crt/mem.js found by fuzzing (tools/fuzz, 2026-11-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { radd, rdiff, peq, recArray, relem, Ptr, FieldRef } from '../../js/crt/mem.js';
import { STALE } from '../../js/crt/serial.js';

class R { constructor() { this.x = 1; } }

test('p + 1 on a record that is not an array element: one past the end (C11 6.5.6p7)', () => {
    const p = new R(), q = new R();
    const e = radd(p, 1);
    assert.ok(peq(e, radd(p, 1)), 'the same one-past pointer');
    assert.ok(!peq(e, p) && !peq(e, q) && !peq(e, radd(q, 1)), 'unequal to every object');
    assert.equal(radd(e, -1), p);
    assert.equal(rdiff(e, p), 1);
    assert.throws(() => e.x, /outside its array/);
    assert.throws(() => radd(p, 2), /not an array element/);
    // mhitu.c hitmsg: mattk == hitmsg_prev + 1 with mattk in an array, hitmsg_prev a lone record
    const arr = recArray(R, 3);
    assert.ok(!peq(arr[1], radd(p, 1)));
    assert.ok(peq(arr[1], radd(arr[0], 1)));
});

test('a pointer read from a save file is unequal to every live object', () => {
    const arr = recArray(R, 2);
    assert.ok(!peq(arr[0], STALE) && !peq(STALE, arr[0]) && !peq(new R(), STALE));
    assert.ok(peq(STALE, STALE));
    assert.ok(!peq(radd(new R(), 1), STALE));
});

test('one object per record position: peq of record pointers is === (readability step a)', () => {
    const a = recArray(R, 3), b = recArray(R, 3), solo = new R();
    // positions outside the array, made several ways, are one object each
    assert.equal(relem(a, 3), relem(a, 3));
    assert.equal(relem(a, -1), relem(a, -1));
    assert.equal(radd(a[2], 1), relem(a, 3));
    assert.equal(radd(relem(a, 3), -1), a[2]);
    assert.equal(radd(solo, 1), radd(solo, 1));
    assert.notEqual(relem(a, 3), relem(b, 3));
    // with a record pointer on one side, peq is === whatever the other side is
    const recs = [a[0], a[2], relem(a, 3), relem(a, -1), relem(b, 3), solo, radd(solo, 1), STALE, null];
    const others = [...recs, new Ptr(new Int8Array(4), 0), new FieldRef(solo, 'x', 'i32')];
    recs.forEach((x, i) => others.forEach((y, j) => {
        assert.equal(peq(x, y), x === y, `peq vs === for recs[${i}] / others[${j}]`);
        assert.equal(peq(y, x), x === y, `peq vs === for others[${j}] / recs[${i}]`);
    }));
});
