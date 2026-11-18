// Differential test: js/crt/string.js and ctype.js against Darwin libc (tests/c-diff/string/string-ref.c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../../js/crt/string.js';
import * as C from '../../js/crt/ctype.js';
import { BytePtr } from '../../js/crt/mem.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('') || '-';
const bytesOf = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cstr = (bytes, extra = 0) => { const b = new Uint8Array(bytes.length + 1 + extra); b.set(bytes); return new BytePtr(b, 0); };

// inputs: numbers in every syntax the parsers accept, plus junk
const NUMS = ['0', '1', '-1', '+7', '  42', '\t\n 13x', '0x1f', '0X1F', '0x', '0xg', '017', '08', '-0', '9223372036854775807',
    '9223372036854775808', '-9223372036854775808', '-9223372036854775809', '18446744073709551615', '18446744073709551616',
    '99999999999999999999999', 'abc', '', '-', '+', ' -x', '1e5', '1.5', '.5', '5.', '.', '-.5e-3', '1e', '1e+', '0x1p3',
    '0x.8p1', '0x1.fffffffffffffp1023', '0x1p-1074', 'inf', 'INFINITY', '-Inf', 'nan', 'nan(123)', 'NaNx', '1e309', '1e-400',
    '2.2250738585072014e-308', '0.1', '123456789012345678901234567890', '3.14159265358979323846', '1,5', '12abc', 'z', 'Z',
    '7fffffff', '2147483648', '-2147483649', '4294967296'];
const STRS = ['', 'a', 'abc', 'hello world', 'Elbereth', 'aaaa', 'abcabc', 'caf\xe9', '\xff\x80', 'x y\tz', 'The quick brown fox'];

function cases() {
    const out = [];
    for (const s of NUMS) {
        const h = hex(bytesOf(s));
        for (const b of [0, 8, 10, 16, 36, 2]) { out.push(['strtol', h, '-', b]); out.push(['strtoul', h, '-', b]); }
        out.push(['strtod', h, '-', 0], ['atoi', h, '-', 0], ['atol', h, '-', 0]);
    }
    for (const a of STRS) for (const b of STRS) {
        const ha = hex(bytesOf(a)), hb = hex(bytesOf(b));
        out.push(['strcmp', ha, hb, 0], ['strstr', ha, hb, 0], ['strpbrk', ha, hb, 0], ['strspn', ha, hb, 0], ['strcspn', ha, hb, 0]);
        for (const n of [0, 1, 2, 3, 5, 20]) out.push(['strncmp', ha, hb, n], ['strncpy', ha, hb, n], ['strncat', ha, hb, n]);
        out.push(['strcat', ha, hb, 0], ['strcpy', ha, hb, 0]);
        if (a.length === b.length) out.push(['memcmp', ha, hb, a.length]);
    }
    for (const a of STRS) {
        const ha = hex(bytesOf(a));
        out.push(['strlen', ha, '-', 0]);
        for (const c of [0, 97, 98, 32, 0xe9, -23, 0x161]) out.push(['strchr', ha, '-', c], ['strrchr', ha, '-', c], ['memchr', ha, '-', c]);
    }
    return out;
}

function runJs([op, ha, hb, n]) {
    const A = ha === '-' ? new Uint8Array(0) : Uint8Array.from(Buffer.from(ha, 'hex'));
    const B = hb === '-' ? new Uint8Array(0) : Uint8Array.from(Buffer.from(hb, 'hex'));
    const a = cstr(A), b = cstr(B);
    let endp = null;
    const ref = { set: (p) => { endp = p; } };
    const off = (p) => (p === null ? -1 : p.off);
    const sgn = (x) => Math.sign(x);
    switch (op) {
    case 'strtol': { const v = S.strtol(a, ref, n); return `${v} ${endp.off}`; }
    case 'strtoul': { const v = S.strtoul(a, ref, n); return `${v} ${endp.off}`; }
    case 'strtod': { const v = S.strtod(a, ref); return `${hexFloat(v)} ${endp.off}`; }
    case 'atoi': return `${S.atoi(a)}`;
    case 'atol': return `${S.atol(a)}`;
    case 'strcmp': return `${sgn(S.strcmp(a, b))}`;
    case 'strncmp': return `${sgn(S.strncmp(a, b, n))}`;
    case 'memcmp': return `${sgn(S.memcmp(a, b, n))}`;
    case 'strchr': return `${off(S.strchr(a, n))}`;
    case 'strrchr': return `${off(S.strrchr(a, n))}`;
    case 'memchr': return `${off(S.memchr(a, n, A.length + 1))}`;
    case 'strstr': return `${off(S.strstr(a, b))}`;
    case 'strpbrk': return `${off(S.strpbrk(a, b))}`;
    case 'strspn': return `${S.strspn(a, b)}`;
    case 'strcspn': return `${S.strcspn(a, b)}`;
    case 'strlen': return `${S.strlen(a)}`;
    default: {   // buffer writers
        const d = new BytePtr(new Uint8Array(96).fill(0x55), 0);
        d.buf.set(A); d.buf[A.length] = 0;
        S[op](d, b, n);
        return hex(d.buf);
    }
    }
}
// %a as Darwin prints it (normalized 0x1.<hex>p<exp>, 0x0p+0, inf, nan)
function hexFloat(v) {
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    const neg = v < 0 || Object.is(v, -0);
    const sign = neg ? '-' : '';
    v = Math.abs(v);
    if (v === 0) return `${sign}0x0p+0`;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v);
    let e = (dv.getUint16(0) >> 4) & 0x7ff;
    let m = (BigInt(dv.getUint32(0) & 0xfffff) << 32n) | BigInt(dv.getUint32(4));
    if (e === 0) { e = -1022; while (!(m & (1n << 52n))) { m <<= 1n; e--; } m &= (1n << 52n) - 1n; } else e -= 1023;
    let frac = m.toString(16).padStart(13, '0').replace(/0+$/, '');
    return `${sign}0x1${frac ? '.' + frac : ''}p${e >= 0 ? '+' : ''}${e}`;
}

test('ctype matches Darwin in the C locale for -1..255', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'str-'));
    const exe = path.join(dir, 'string-ref');
    execFileSync('clang', ['-arch', 'arm64', '-O0', '-w', '-o', exe, path.join(HERE, '../c-diff/string/string-ref.c')]);
    const lines = execFileSync(exe, { input: '' }).toString().trim().split('\n');
    const fails = [];
    for (const l of lines) {
        const [, c, flags, up, lo] = l.split(' ');
        const x = Number(c);
        const f = [C.isupper, C.islower, C.isalpha, C.isdigit, C.isxdigit, C.isalnum, C.isspace, C.ispunct, C.iscntrl, C.isprint, C.isgraph]
            .map((g) => (g(x) ? 1 : 0)).join('');
        const got = `${f} ${C.toupper(x)} ${C.tolower(x)}`;
        if (got !== `${flags} ${up} ${lo}`) fails.push(`${c}: C ${flags} ${up} ${lo} JS ${got}`);
    }
    assert.equal(lines.length, 257);
    assert.deepEqual(fails, []);
});

test('string functions and number parsing match Darwin', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'str-'));
    const exe = path.join(dir, 'string-ref');
    execFileSync('clang', ['-arch', 'arm64', '-O0', '-w', '-o', exe, path.join(HERE, '../c-diff/string/string-ref.c')]);
    const all = cases();
    const out = execFileSync(exe, { input: all.map((c) => c.join(' ')).join('\n') + '\n', maxBuffer: 1 << 28 })
        .toString().trim().split('\n').filter((l) => !l.startsWith('ctype '));
    assert.equal(out.length, all.length);
    const fails = [];
    all.forEach((c, i) => {
        let got;
        try { got = `${c[0]} ${runJs(c)}`; } catch (e) { got = `${c[0]} threw ${e.message}`; }
        if (got !== out[i]) fails.push(`${c.join(' ')}: C "${out[i]}" JS "${got}"`);
    });
    assert.ok(all.length > 3000, `${all.length} cases`);
    assert.deepEqual(fails.slice(0, 20), [], `${fails.length} of ${all.length} differ`);
});

test('fortified forms trap on overflow', () => {
    const d = new BytePtr(new Uint8Array(4), 0);
    assert.throws(() => S.__builtin___strcpy_chk(d, cstr(bytesOf('abcd')), 4), /buffer overflow/);
    assert.equal(S.__builtin___strcpy_chk(d, cstr(bytesOf('abc')), 4), d);
    assert.throws(() => S.__builtin___strcat_chk(d, cstr(bytesOf('x')), 4), /buffer overflow/);
    assert.throws(() => S.strcpy(d, cstr(bytesOf('abcdef'))), /out of bounds/);
});
