// Postmortem F2: NetHack's regex (menucolors, msgtype, autopickup exceptions) is the
// recorder's Darwin Libc regcomp/regexec/regerror, transpiled from the vendored
// sources (transpiler/third_party/README.md). golden.out is the system regex's
// output for golden.tsv (tests/c-diff/regex/run.mjs --golden; the full native
// differential is run.mjs, which needs clang).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as $c from '../../js/crt/index.js';
import * as $T from '../../js/nh/types.js';
import { runCases, parseLine } from '../c-diff/regex/regex-js.mjs';
import { regex_compile, regex_error_desc, regex_match } from '../../js/nh/posixregex.js';
import { regfree } from '../../js/nh/luabridge.js';

const dir = new URL('../c-diff/regex/', import.meta.url);
const cases = readFileSync(new URL('golden.tsv', dir), 'latin1');
const golden = readFileSync(new URL('golden.out', dir), 'latin1').trim().split('\n');

test('transpiled regex matches the system regex on the golden cases', () => {
    const js = runCases(cases);
    assert.equal(js.length, golden.length);
    const bad = [];
    js.forEach((l, i) => { if (l.slice(4) !== golden[i].slice(4)) bad.push(`#${i}: sys ${golden[i]} | js ${l}`); });
    assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${js.length} differ`);
});

test("NetHack's posixregex.c through the bridge agrees with the system regex", () => {
    const bytes = (s) => new $c.Ptr(Int8Array.from([...s].map((c) => c.charCodeAt(0) << 24 >> 24).concat(0)), 0);
    const cstr = (p) => { let t = ''; for (let i = 0; p.get(i) !== 0; i++) t += String.fromCharCode(p.get(i) & 0xff); return t; };
    const lines = cases.trim().split('\n');
    let n = 0;
    lines.forEach((line, i) => {
        const c = parseLine(line);
        if (!c || c.cf !== 5 || c.ef !== 0) return;   // REG_EXTENDED|REG_NOSUB, as posixregex.c:70
        const [, rc, errtext, execrc] = golden[i].split(':');
        const re = new $T.nhregex();
        const ok = regex_compile(bytes(c.p), re);
        assert.equal(ok, rc === '0' ? 1 : 0, `compile ${JSON.stringify(c.p)}`);
        if (!ok) {
            const buf = new $c.Ptr(new Int8Array(256), 0);   // BUFSZ, as NetHack's callers
            regex_error_desc(re, buf);
            assert.equal(cstr(buf), errtext, `regerror for ${JSON.stringify(c.p)}`);
        } else {
            assert.equal(regex_match(bytes(c.s), re), execrc === '0' ? 1 : 0, `match ${JSON.stringify(c.p)} ~ ${JSON.stringify(c.s)}`);
            regfree(re.re);
        }
        n++;
    });
    assert.ok(n > 1000, `only ${n} NetHack-flag cases`);
});
