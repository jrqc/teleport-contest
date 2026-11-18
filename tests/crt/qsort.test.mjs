// Differential test: js/crt/qsort.js against Darwin libc qsort (tests/c-diff/qsort/qsort-ref.c).
// Checks the exact sequence of comparator calls (which elements, in which
// order) and the final order. For the inconsistent comparator, JS replays the
// result C's comparator returned for the same call number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qsortSync, qsortAsync, TEMP } from '../../js/crt/qsort.js';

const REPLAY = new Set(['inconsistent', 'always1', 'biased']);   // comparator results replayed from C
const HERE = path.dirname(fileURLToPath(import.meta.url));

function nativeCases() {
    const dir = mkdtempSync(path.join(tmpdir(), 'qsort-'));
    const exe = path.join(dir, 'qsort-ref');
    execFileSync('clang', ['-arch', 'arm64', '-O0', '-o', exe, path.join(HERE, '../c-diff/qsort/qsort-ref.c')]);
    const lines = execFileSync(exe, { maxBuffer: 1 << 30 }).toString().trim().split('\n');
    const cases = [];
    let cur = null;
    for (const l of lines) {
        const [t, ...rest] = l.split(' ');
        if (t === 'case') { cur = { n: +rest[0], mode: rest[1], calls: [] }; cases.push(cur); }
        else if (t === 'k') cur.keys = rest.map(Number);
        else if (t === 'c') cur.calls.push(rest.map(Number));
        else if (t === 'r') cur.result = rest.map(Number);
    }
    return cases;
}

function makeOps(c, log) {
    const arr = c.keys.map((key, id) => ({ key, id }));
    let tmp = null;
    const get = (i) => (i === TEMP ? tmp : arr[i]);
    const set = (i, v) => { if (i === TEMP) tmp = v; else arr[i] = v; };
    return {
        arr,
        ops: {
            cmp(i, j) {
                const a = get(i), b = get(j);
                const k = log.length;
                const r = REPLAY.has(c.mode) ? (c.calls[k] ? c.calls[k][2] : 0) : Math.sign(a.key - b.key);
                log.push([a.id, b.id, r]);
                return r;
            },
            swap(i, j) { const t = get(i); set(i, get(j)); set(j, t); },
            copy(d, s) { set(d, { ...get(s) }); },   // C copies bytes: a fresh element value
        },
    };
}

const cases = nativeCases();
const diff = (c, log, arr) => {
    const n = Math.min(log.length, c.calls.length);
    for (let k = 0; k < n; k++) if (log[k].join() !== c.calls[k].join()) return `call ${k}: C ${c.calls[k]} JS ${log[k]}`;
    if (log.length !== c.calls.length) return `calls: C ${c.calls.length} JS ${log.length}`;
    const ids = arr.map((e) => e.id).join();
    return ids === c.result.join() ? null : `result C ${c.result.slice(0, 12)} JS ${ids.slice(0, 40)}`;
};

test('comparator call sequence and result match Darwin qsort (sync driver)', () => {
    const fails = [];
    let calls = 0;
    for (const c of cases) {
        const log = [];
        const { arr, ops } = makeOps(c, log);
        qsortSync(c.n, ops);
        calls += log.length;
        const d = diff(c, log, arr);
        if (d) fails.push(`n=${c.n} ${c.mode}: ${d}`);
    }
    assert.ok(cases.length > 1000 && calls > 100000, `${cases.length} cases, ${calls} calls`);
    assert.deepEqual(fails.slice(0, 10), [], `${fails.length} of ${cases.length} cases differ`);
});

test('async driver gives the same sequence', async () => {
    for (const c of cases.filter((_, i) => i % 7 === 0)) {
        const log = [];
        const { arr, ops } = makeOps(c, log);
        const cmp = ops.cmp;
        ops.cmp = async (i, j) => { await null; return cmp(i, j); };
        await qsortAsync(c.n, ops);
        assert.equal(diff(c, log, arr), null, `n=${c.n} ${c.mode}`);
    }
});
