// regex-js.mjs: run regex cases through the transpiled Darwin regex (js/nh/regcomp.js
// etc., heap world) and print the lines regex-native.c prints for its "our" side.
// Input: <cflags>\t<eflags>\t<pattern>\t<subject>, with \xNN escapes (gen-cases.mjs).
//   node tests/c-diff/regex/regex-js.mjs < cases.tsv > js.out
// As a module: runCases(text) -> array of result lines (side "our").
import * as H from '../../../js/crt/heap.js';
import * as $c from '../../../js/crt/index.js';
import { $initAll } from '../../../js/nh/index.js';
import { regcomp, regfree } from '../../../js/nh/regcomp.js';
import { regexec } from '../../../js/nh/regexec.js';
import { regerror } from '../../../js/nh/regerror.js';

const REG_NOSUB = 4;

/** regex-native.c unesc(): \xNN (two characters, read with strtol base 16) */
export function unesc(s) {
    let d = '';
    for (let i = 0; i < s.length;) {
        if (s[i] === '\\' && s[i + 1] === 'x' && i + 3 < s.length) {
            const h = s.slice(i + 2, i + 4);
            const m = /^[0-9a-fA-F]*/.exec(h)[0];
            d += String.fromCharCode((m ? parseInt(m, 16) : 0) & 0xff);
            i += 4;
        } else d += s[i++];
    }
    return d;
}
/** regex-native.c main(): strtok(line, "\t") fields (runs of tabs are one separator) */
export function parseLine(line) {
    const f = line.split('\t').filter((x) => x !== '');
    if (f.length < 3) return null;
    const p = unesc(f[2]).split('\0')[0], s = unesc(f[3] ?? '').split('\0')[0];
    return { cf: atoi(f[0]), ef: atoi(f[1]), p, s };
}
const atoi = (s) => { const m = /^\s*[-+]?\d+/.exec(s); return m ? parseInt(m[0], 10) | 0 : 0; };

function heapStr(s) {
    const a = H.malloc(s.length + 1);
    for (let i = 0; i < s.length; i++) H.u8[a + i] = s.charCodeAt(i);
    H.u8[a + s.length] = 0;
    return a;
}
let ready = false;
function init() {
    if (ready) return;
    $c.resetProcess({ env: {}, keys: '', cwd: '/' });
    $initAll();
    ready = true;
}
/** One case, as regex-native.c run() prints it. */
export function runCase({ cf, ef, p, s }, side = 'our') {
    init();
    const re = H.malloc(32), eb = H.malloc(128), m = H.malloc(16 * 10);
    const pa = heapStr(p), sa = heapStr(s);
    const rc = regcomp(re, pa, cf);
    regerror(rc, re, eb, 128n);
    let out = `${side}:${rc}:${H.str(eb)}:`;
    if (rc === 0) {
        const nosub = (cf & REG_NOSUB) !== 0;
        const x = regexec(re, sa, nosub ? 0n : 10n, nosub ? 0 : m, ef);
        out += `${x}:`;
        if (x === 0 && !nosub) {
            const nsub = Number(H.ldu64(re + 8));
            for (let i = 0; i < 10 && i <= nsub; i++) out += `${H.ld64(m + 16 * i)},${H.ld64(m + 16 * i + 8)} `;
        }
        regfree(re);
    }
    for (const a of [re, eb, m, pa, sa]) H.free(a);
    return out;
}
export function runCases(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (line === '') continue;
        const c = parseLine(line);
        if (c) out.push(runCase(c));
    }
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const lines = runCases(Buffer.concat(chunks).toString('latin1'));
    process.stdout.write(Buffer.from(lines.join('\n') + '\n', 'latin1'));
}
