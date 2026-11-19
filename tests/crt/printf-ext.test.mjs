// Differential test: js/crt/printf.js conversions added by the trap audit (%a/%A, %n,
// %lc/%ls, L) against Darwin printf (tests/c-diff/printf-ext/printf-ext.c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as $c from '../../js/crt/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (out, f, ...a) => out.push(String.fromCharCode(...$c.cformat($c.lit(f), new $c.VaList(a))));
const hex = (m, e) => m * 2 ** e;   // C hex float literal: mantissa digits as an integer, exponent

test('%a %A %n %lc %ls %L match Darwin printf', () => {
    const exe = path.join(mkdtempSync(path.join(tmpdir(), 'pfx-')), 'printf-ext');
    execFileSync('clang', ['-O0', '-o', exe, path.join(HERE, '../c-diff/printf-ext/printf-ext.c')]);
    const want = execFileSync(exe).toString('latin1').split('\n');
    const out = [];
    const v = [0.0, -0.0, 1.0, 1.5, 0.1, -3.75, 1e300, 4.9e-324, 2.2250738585072014e-308, 1.0000000000000002, 0.9999999999999999, 255.5, 1.0 / 3, 6.103515625e-05, 1.96875];
    const f = ['%a', '%A', '%.0a', '%.1a', '%.2a', '%.3a', '%#.0a', '%20a', '%-20a|', '%020a', '%+a', '% a', '%.13a', '%.15a', '%La'];
    for (const x of v) for (const g of f) P(out, g, x);
    const n = new $c.Ptr(new Int32Array(1), 0), h = new $c.Ptr(new Int16Array(1), 0);
    P(out, 'abc%n%hndef', n, h); out.push(`${n.get(0)} ${h.get(0)}`);
    const w = () => new $c.Ptr(new Int32Array([104, 101, 121, 0]), 0);
    P(out, '%lc|%5lc|%ls|%.2ls', 120, 0xe9, w(), w());
    P(out, '%Lf %Le %10.3Lf', 2.5, 1e10, 3.14159);
    // ties and near-ties of the rounding digit (_hdtoa.c dorounding)
    const t = [hex(0x108, -8), hex(0x118, -8), hex(0x128, -8), hex(0x138, -8), hex(0x1f8, -8), hex(0x1e8, -8), hex(0x18, -4), hex(0x1081, -12), hex(0x1181, -12),
        hex(0x10800000000001, -52), hex(0x18000000000001, -52), hex(0x1ffffffffffff8, -52), hex(0x1fffffffffff8, -48), hex(0x10000000000008, -52), hex(0x10000000000018, -52)];
    for (const x of t) P(out, '%.1a %.0a %.12a %.11a', x, x, x, x);
    assert.deepEqual(out, want.slice(0, out.length));
    assert.equal(want.length, out.length + 1);   // the trailing newline
});
