// gen-cases.mjs: regex differential cases (postmortem F2, test T12).
// node gen-cases.mjs <count> <seed> [datafile-dir]   -> TSV on stdout
// Flags: NetHack uses REG_EXTENDED|REG_NOSUB (posixregex.c:70); other
// combinations are included so the comparison also covers TRE's other paths.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const [n = 2000, seed0 = 1, dataDir] = process.argv.slice(2);
let seed = Number(seed0) >>> 0 || 1;
const rnd = (k) => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % k; };
const REG_EXTENDED = 1, REG_ICASE = 2, REG_NOSUB = 4, REG_NEWLINE = 8;
const FLAGS = [REG_EXTENDED | REG_NOSUB, REG_EXTENDED | REG_NOSUB, REG_EXTENDED | REG_NOSUB, REG_EXTENDED, REG_EXTENDED | REG_ICASE, 0, REG_EXTENDED | REG_NEWLINE, REG_EXTENDED | REG_ICASE | REG_NOSUB];
const esc = (s) => [...s].map((c) => { const k = c.charCodeAt(0); return k < 32 || k > 126 || c === '\\' ? '\\x' + k.toString(16).padStart(2, '0') : c; }).join('');
const ATOMS = ['a', 'b', 'c', 'x', 'A', 'B', '0', '9', ' ', '.', '\\.', '\\*', '[abc]', '[^a]', '[a-z]', '[[:alpha:]]', '[[:digit:]]', '[[:space:]]', '[[:upper:]]', '[]a]', '[a-]', '[\xe9\xe0]',
    '\xe9', '\xff', '\x80', '^', '$', '(', ')', '|', '*', '+', '?', '{2}', '{1,3}', '{,2}', '\\(', '\\)', '\\{', '\\1', '[[=a=]]', '[[.a.]]', 'ab|cd', '(a|b)*', '.*', '[', ']', '\\', '{'];
const SUBJ = 'abcxAB09 .*\xe9\xe0\xff\x80\n';
const out = [];
for (let i = 0; i < Number(n); i++) {
    let p = ''; const k = 1 + rnd(6);
    for (let j = 0; j < k; j++) p += ATOMS[rnd(ATOMS.length)];
    let s = ''; const m = rnd(12);
    for (let j = 0; j < m; j++) s += SUBJ[rnd(SUBJ.length)];
    out.push(`${FLAGS[rnd(FLAGS.length)]}\t0\t${esc(p)}\t${esc(s)}`);
}
// NetHack-style patterns (Guidebook examples of MENUCOLOR / MSGTYPE / autopickup exceptions)
for (const p of ['blessed', 'cursed', 'uncursed', '\\(being worn\\)', '^You see here', 'You hear the footsteps of a guard on patrol\\.', '.* corpse', '"*.wand"', '<.*>', '^[a-z] - ', 'loadstone|luckstone', 'You displace .*\\.', '^Elbereth$', '\\((weapon|wielded)( in hand)?\\)'])
    for (const s of ['a blessed +1 long sword', 'an uncursed ring', 'You see here a lichen corpse.', 'a loadstone', 'You hear the footsteps of a guard on patrol.', 'a wand of wishing (0:3)', 'Elbereth', 'a dagger (weapon in hand)', ''])
        out.push(`${REG_EXTENDED | REG_NOSUB}\t0\t${esc(p)}\t${esc(s)}`);
// Apple's own regex test data (tests/regex/datafiles, AT&T format: flags TAB pattern TAB subject TAB ...)
if (dataDir && existsSync(dataDir)) for (const f of readdirSync(dataDir).filter((f) => f.endsWith('.dat')).sort()) {
    for (const line of readFileSync(`${dataDir}/${f}`, 'latin1').split('\n')) {
        const t = line.split('\t').filter((x) => x !== '');
        if (t.length < 3 || /^#|^NOTE|^:/.test(t[0]) || !/^[A-Za-z]/.test(t[0])) continue;
        const fl = (t[0].includes('E') ? REG_EXTENDED : 0) | (t[0].includes('i') ? REG_ICASE : 0) | (t[0].includes('n') ? REG_NEWLINE : 0);
        if (/[\t]/.test(t[1] + t[2])) continue;
        const subj = t[2] === 'NULL' ? '' : t[2];
        out.push(`${fl}\t0\t${esc(t[1])}\t${esc(subj)}`, `${fl | REG_NOSUB}\t0\t${esc(t[1])}\t${esc(subj)}`);
    }
}
process.stdout.write(out.join('\n') + '\n');
