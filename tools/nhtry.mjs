#!/usr/bin/env node
// tools/nhtry.mjs: run js/jsmain.js on sessions and report matched screens / RNG prefix
// per session (a quick development aid; frozen/score.sh is the judge).
// Usage: node tools/nhtry.mjs [session.json ...]   (default: all of sessions/)
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
globalThis.__nhQuiet = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runSegment } = await import(path.join(ROOT, 'js/jsmain.js'));
const { decodeScreen } = await import(path.join(ROOT, 'frozen/screen-decode.mjs'));
const strip = (r) => r.replace(/ @ .*$/, '');
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(path.join(ROOT, 'sessions')).filter((f) => f.endsWith('.session.json')).map((f) => path.join(ROOT, 'sessions', f));
let tot = 0, totOk = 0;
const errs = new Map();
for (const f of files) {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    const seg = s.segments[0];
    const g = await runSegment({ ...seg, storage: new Map2() });
    const cr = seg.steps.flatMap((st) => (st.rng || []).filter((x) => /^(rn2|rnd|rn1|rnl|rne|rnz|d)\(/.test(x)).map(strip));
    let rp = 0; while (rp < cr.length && cr[rp] === g.rng[rp]) rp++;
    let sp = 0;
    const same = (a, b) => JSON.stringify(decodeScreen(a)) === JSON.stringify(decodeScreen(b));
    while (sp < seg.steps.length && sp < g.screens.length && same(seg.steps[sp].screen, g.screens[sp])) sp++;
    tot += seg.steps.length; totOk += sp;
    const e = g.error ? String(g.error.message).slice(0, 80) : '';
    if (e) errs.set(e, (errs.get(e) || 0) + 1);
    console.log(`${path.basename(f).padEnd(48)} screens ${String(sp).padStart(4)}/${seg.steps.length}  rng ${rp}/${cr.length}${rp < g.rng.length && rp < cr.length ? `  first diff C ${cr[rp]} JS ${g.rng[rp]}` : ''}  ${e}`);
}
console.log(`\nprefix screens (segment 1): ${totOk}/${tot}`);
for (const [e, n] of [...errs].sort((a, b) => b[1] - a[1])) console.log(`${n}  ${e}`);
function Map2() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; }
