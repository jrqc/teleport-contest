// Differential test: js/crt/int.js against native clang (tests/c-diff/int/int-vectors.c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as I from '../../js/crt/int.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../c-diff/int/int-vectors.c');
const CASES = Number(process.env.INT_CASES || 3000);

function nativeVectors() {
    const dir = mkdtempSync(path.join(tmpdir(), 'intvec-'));
    const exe = path.join(dir, 'int-vectors');
    execFileSync('clang', ['-O0', '-fwrapv', '-o', exe, SRC]);
    return execFileSync(exe, [String(CASES)], { maxBuffer: 1 << 30 }).toString().trim().split('\n');
}
// decimal -> the runtime's representation (Number if safe, else BigInt)
const parseInt64 = (s) => I.norm(BigInt(s));
const isDouble = (s) => /[.eEn]/.test(s) || s === 'inf' || s === '-inf';

const FP_IN = new Set(['dtoi32', 'dtoi64', 'dtou32']);
const FP_OUT = new Set(['itod']);

test('integer semantics match native clang', () => {
    const lines = nativeVectors();
    const fails = [];
    let checked = 0;
    for (const line of lines) {
        const [op, sa, sb, sr] = line.split(' ');
        if (op === 'char_is_signed') { assert.equal(sr, '1'); continue; }
        const f = I[op];
        assert.equal(typeof f, 'function', `missing helper ${op}`);
        const a = FP_IN.has(op) ? Number(sa) : parseInt64(sa);
        const b = parseInt64(sb);
        let got;
        try { got = f(a, b); } catch (e) { fails.push(`${line}: threw ${e.message}`); continue; }
        const want = FP_OUT.has(op) || isDouble(sr) ? Number(sr) : parseInt64(sr);
        const okRepr = typeof got === 'bigint' ? !(got >= -(2n ** 53n - 1n) && got <= 2n ** 53n - 1n)
            : (Number.isFinite(got) && (FP_OUT.has(op) || Number.isSafeInteger(got)) && !Object.is(got, -0));
        if (got !== want || !okRepr) fails.push(`${line}: got ${String(got)} (${typeof got})`);
        checked++;
    }
    assert.ok(checked > CASES * 50, `only ${checked} vectors checked`);
    assert.deepEqual(fails.slice(0, 20), [], `${fails.length} mismatches of ${checked}`);
});

test('traps where x86-64 traps', () => {
    assert.throws(() => I.div32(1, 0), I.CTrap);
    assert.throws(() => I.div32(-2147483648, -1), I.CTrap);
    assert.throws(() => I.rem32(-2147483648, -1), I.CTrap);
    assert.throws(() => I.div64(1, 0), I.CTrap);
    assert.throws(() => I.div64(-(2n ** 63n), -1), I.CTrap);
    assert.throws(() => I.divu64(5, 0), I.CTrap);
});

test('shift counts are masked like x86-64', () => {
    assert.equal(I.shl32(1, 33), 2);
    assert.equal(I.shru32(0x80000000, 32), 0x80000000);
    assert.equal(I.shl64(1, 65), 2);
});

test('out-of-range float conversions give the x86 integer-indefinite value', () => {
    assert.equal(I.dtoi32(3e10), -2147483648);
    assert.equal(I.dtoi32(NaN), -2147483648);
    assert.equal(I.dtoi64(1e300), -(2n ** 63n));
});
