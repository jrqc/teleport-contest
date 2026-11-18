// Differential test: js/crt/printf.js against Darwin libc snprintf (tests/c-diff/printf/printf-ref.c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cformat, snprintf, sprintf, __builtin___sprintf_chk, __builtin___snprintf_chk } from '../../js/crt/printf.js';
import { BytePtr, cstrLiteral, cstrToJs } from '../../js/crt/mem.js';
import { VaList } from '../../js/crt/va.js';
import { CTrap, norm } from '../../js/crt/int.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// specs found in the NetHack + Lua sources (transpiler-design.md 5), plus a grid
const SOURCE_SPECS = ['%s', '%d', '%ld', '%c', '%u', '%i', '%lu', '%08lx', '%p', '%02d', '%.60s', '%lx', '%.20s',
    '%.*s', '%2d', '%06ld', '%-1d', '%2.2s', '%03x', '%4d', '%08ld', '%02x', '%.3s', '%12s', '%*s', '%x', '%f',
    '%8ld', '%3d', '%06lx', '%8s', '%4s', '%4ld', '%1c', '%-7s', '%zu', '%*c', '%.40s', '%-20s', '%-12.12s', '%o',
    '%7s', '%03d', '%+d', '%.31s', '%e', '%9s', '%5d', '%02X', '%.99s', '%-2d', '%ti', '%8.8s', '%5u', '%07u',
    '%04X', '%02lu', '%-d', '%-30.30s', '%-1ld', '%lld', '%li', '%g', '%8lx', '%63s', '%6.2f', '%5lx', '%4o',
    '%20i', '%20p', '%10ld', '%0x', '%08x', '%011lx', '%*ld', '%.99f', '%.7g', '%.14g', '%-45.*s', '%-099.99d',
    '%-12.33s', '%-10.10s', '%03o', '%-*s'];
const FLAGS = ['', '-', '+', ' ', '#', '0', '-0', '+0', '#0', '- ', '+#'];
const WIDTHS = ['', '1', '5', '12', '*'];
const PRECS = ['', '.', '.0', '.1', '.3', '.6', '.14', '.17', '.*'];
const CONV = { i: ['d', 'i', 'u', 'o', 'x', 'X', 'c', 'hd', 'hhd', 'hu', 'hhx'], l: ['ld', 'li', 'lu', 'lx', 'lld', 'zu', 'ti', 'lo'],
    d: ['f', 'e', 'E', 'g', 'G', 'F'], s: ['s'], p: ['p'] };
const VALUES = {
    i: ['0', '1', '-1', '7', '-42', '255', '256', '65535', '-32768', '100000', '2147483647', '-2147483648'],
    l: ['0', '-1', '4294967296', '9007199254740993', '-9223372036854775808', '9223372036854775807', '123456789012'],
    d: ['0', '-0', '0.5', '1.5', '2.5', '0.125', '0.1', '-0.1', '1e-5', '1e-4', '0.0001234567', '123456.789', '999999.5',
        '9.9999995', '1e15', '1e16', '1e21', '1e22', '-1.5e300', '5e-324', '2.2250738585072014e-308', '3.141592653589793',
        '1234567.0', '0.000015', '100', '99.995', 'inf', '-inf', 'nan', '-nan', '1e100', '0.95', '0.05'],
    s: ['NULL', '', 'a', 'hello', 'Elbereth', 'a long string with spaces', 'caf\xe9'],
    p: ['0', '4660', '16'],
};
const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function cases() {
    const out = new Set();
    const typeOfConv = (cv) => (CONV.d.includes(cv) ? 'd' : CONV.l.includes(cv) ? 'l' : cv === 's' ? 's' : cv === 'p' ? 'p' : cv === 'c' ? 'c' : 'i');
    const add = (spec) => {
        const m = spec.match(/%[-+ #0]*(?:\*|\d+)?(?:\.(?:\*|\d*))?([a-zA-Z]+)[^%]*$/);
        const cv = m ? m[1] : 'd';
        const t = typeOfConv(cv);
        const unsigned = /[uoxX]$/.test(cv) || cv === 'zu';
        const stars = (spec.match(/\*/g) || []).length;
        const vals = t === 'c' ? ['65', '48', '0', '-1', '255'] : VALUES[t === 'l' ? 'l' : t];
        for (const v of vals) {
            let type = t;
            if (t === 'l') type = unsigned ? 'U' : 'l';
            if (t === 'i' && unsigned) type = 'u';
            let val = v;
            if (type === 'u') val = String(BigInt.asUintN(32, BigInt(v)));
            if (type === 'U') val = String(BigInt.asUintN(64, BigInt(v)));
            if (type === 's' && v !== 'NULL') val = hex(v);
            for (const [s1, s2] of stars ? [[-3, 2], [4, 0], [7, 3], [0, -1]] : [[0, 0]]) out.add([type, spec, stars, s1, s2, val].join('\t'));
        }
    };
    for (const s of SOURCE_SPECS) add(s);
    for (const [t, convs] of Object.entries(CONV)) for (const cv of convs) for (const f of FLAGS) for (const w of WIDTHS) for (const p of PRECS) {
        if (t === 's' && (f.includes('#') || f.includes('+'))) continue;   // undefined combinations
        if ((cv === 'c' || t === 'p') && p) continue;
        add(`%${f}${w}${p}${cv}`);
    }
    // text around conversions, %%, several in one format
    for (const s of ['abc%dxyz', '%%', '100%% %d', '%%%5d%%']) add(s);
    return [...out];
}

function argOf(type, v) {
    switch (type) {
    case 'd': return ({ nan: NaN, '-nan': -NaN, inf: Infinity, '-inf': -Infinity })[v] ?? Number(v);
    case 's': return v === 'NULL' ? null : new BytePtr(Uint8Array.from([...Buffer.from(v, 'hex'), 0]), 0);
    case 'p': return BigInt(v) === 0n ? null : norm(BigInt(v));
    default: return norm(BigInt(v));
    }
}

test('formatting matches Darwin snprintf byte for byte', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'printf-'));
    const exe = path.join(dir, 'printf-ref');
    execFileSync('clang', ['-O0', '-w', '-o', exe, path.join(HERE, '../c-diff/printf/printf-ref.c')]);
    const all = cases();
    const native = execFileSync(exe, { input: all.join('\n') + '\n', maxBuffer: 1 << 28 }).toString().trim().split('\n');
    assert.equal(native.length, all.length);
    const fails = [];
    all.forEach((c, n) => {
        const [type, spec, stars, s1, s2, val] = c.split('\t');
        const args = [];
        if (+stars >= 1) args.push(+s1);
        if (+stars >= 2) args.push(+s2);
        args.push(argOf(type, val));
        let got;
        try {
            const bytes = cformat(cstrLiteral(spec), new VaList(args));
            got = `${bytes.length} ${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        } catch (e) { got = `threw ${e.message}`; }
        if (got !== native[n]) fails.push(`${JSON.stringify(spec)} ${type} ${val} stars=${s1},${s2}: C "${Buffer.from(native[n].split(' ')[1] || '', 'hex').toString('latin1')}" JS "${got.startsWith('threw') ? got : Buffer.from(got.split(' ')[1] || '', 'hex').toString('latin1')}"`);
    });
    assert.ok(all.length > 10000, `only ${all.length} cases`);
    assert.deepEqual(fails.slice(0, 25), [], `${fails.length} of ${all.length} cases differ`);
});

test('snprintf truncates and returns the full length; sprintf_chk traps on overflow', () => {
    const buf = new BytePtr(new Uint8Array(8).fill(0x55), 0);
    assert.equal(snprintf(buf, 5, cstrLiteral('%d-%s'), 12345, cstrLiteral('ab')), 8);
    assert.equal(cstrToJs(buf), '1234');
    assert.equal(snprintf(buf, 0, cstrLiteral('xyz')), 3);
    assert.equal(sprintf(buf, cstrLiteral('%s'), cstrLiteral('1234567')), 7);
    assert.equal(cstrToJs(buf), '1234567');
    assert.throws(() => sprintf(buf, cstrLiteral('%s'), cstrLiteral('12345678')), CTrap);
    assert.throws(() => __builtin___sprintf_chk(buf, 0, 4, cstrLiteral('%d'), 1234), /buffer overflow/);
    assert.equal(__builtin___sprintf_chk(buf, 0, -1, cstrLiteral('%d'), 1234), 4);
    assert.throws(() => __builtin___snprintf_chk(buf, 16, 0, 8, cstrLiteral('x')), /buffer overflow/);
    assert.equal(__builtin___snprintf_chk(buf, 8, 0, 8, cstrLiteral('%c%c'), 0x41, 0), 2);
});
