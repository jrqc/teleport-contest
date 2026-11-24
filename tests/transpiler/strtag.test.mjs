// String literals as tagged templates ($C`text`, readability step "String literals"):
// 1. jsTemplate's escaping round-trips every byte string: the cooked template text is the
//    text, and $C gives the same shared array (the same pointer) as lit.
// 2. The conversion changed no literal: in every generated module, the literals of the last
//    $c.lit build (BASE) and of the $C build give the same bytes, in the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lit, $C } from '../../js/crt/mem.js';
import { jsTemplate } from '../../transpiler/emit/tu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = '104ebaa';            // the last commit whose js/nh uses $c.lit(...)
const AFTER = process.env.STRTAG_AFTER ?? '67da88f';   // the first $C build; STRTAG_AFTER= (empty) compares the working tree

const bytes = (p) => Array.from(p.buf.subarray(p.off), (b) => b & 0xff);
const viaTag = (s) => new Function('$C', `return $C${jsTemplate(s)};`)($C);

test('jsTemplate round-trips byte strings through $C', () => {
    const cases = [''];
    for (let c = 0; c < 256; c++) cases.push(String.fromCharCode(c));
    const special = ['$', '{', '}', '`', '\\', '\r', '\n', '\0', '0', '7', 'x', 'u'];
    for (const a of special) for (const b of special) cases.push(a + b, `a${a}${b}z`);
    cases.push('${x}', '$${', '\\${', '\0' + '12', '\r\n', '`${`}`', 'a\\`b');
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
    for (let k = 0; k < 20000; k++) {
        let s = '';
        const n = rnd(12);
        for (let i = 0; i < n; i++) s += String.fromCharCode(rnd(4) ? [36, 123, 96, 92, 13, 10, 0, 48][rnd(8)] : rnd(256));
        cases.push(s);
    }
    for (const s of cases) {
        const p = viaTag(s);
        assert.equal(p, lit(s), `same shared literal for ${JSON.stringify(s)}`);
        assert.deepEqual(bytes(p), [...Array.from(s, (c) => c.charCodeAt(0)), 0]);
    }
});

/** The literals of a module's text, in order, as byte strings. */
function oldLiterals(text) {
    return [...text.matchAll(/\$c\.lit\(("(?:[^"\\\n]|\\.)*")\)/g)].map((m) => new Function(`return ${m[1]};`)());
}
function newLiterals(text) {
    return [...text.matchAll(/\$C(`(?:[^`\\]|\\[\s\S])*`)/g)].map((m) => new Function('t', `return t${m[1]};`)((strs) => strs[0]));
}
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'latin1', maxBuffer: 1 << 28 });

test('every converted literal gives the same bytes as the $c.lit build', () => {
    const files = git(['ls-tree', '--name-only', `${BASE}:js/nh`]).split('\n').filter((f) => f.endsWith('.js'));
    const now = AFTER ? git(['ls-tree', '--name-only', `${AFTER}:js/nh`]).split('\n') : readdirSync(path.join(ROOT, 'js/nh'));
    let total = 0;
    for (const f of files) {
        const before = oldLiterals(git(['show', `${BASE}:js/nh/${f}`]));
        if (!now.includes(f)) { assert.equal(before.length, 0, `${f} is gone but had literals`); continue; }
        const text = AFTER ? git(['show', `${AFTER}:js/nh/${f}`]) : readFileSync(path.join(ROOT, 'js/nh', f), 'latin1');
        assert.equal(oldLiterals(text).length, 0, `${f}: $c.lit left`);
        const after = newLiterals(text);
        assert.deepEqual(after, before, `${f}: literals differ`);
        total += before.length;
    }
    assert.ok(total > 27000, `compared ${total} literals`);
});
