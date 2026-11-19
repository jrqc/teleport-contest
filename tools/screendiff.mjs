#!/usr/bin/env node
// tools/screendiff.mjs: cell-level screen diff, C vs JS (CLAUDE.md tool 4.3).
// Runs every segment of a session through js/jsmain.js the way the judge does
// (one shared storage, the judge's input fields, no prevGame; cells and cursor compared), finds the first step whose screen differs (or the step
// given), and prints both screens as text with the differing cells listed
// (char / color / attr), plus the cursor and the keys leading there.
// Usage: node tools/screendiff.mjs sessions/X.session.json [step] [--all]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.__nhQuiet = true;
const { runSegment } = await import(path.join(ROOT, 'js/jsmain.js'));
const { decodeScreen } = await import(path.join(ROOT, 'frozen/screen-decode.mjs'));
const { normalizeSession } = await import(path.join(ROOT, 'frozen/session_loader.mjs'));

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json'));
const want = args.find((a) => /^\d+$/.test(a));
const all = args.includes('--all');
const segs = normalizeSession(JSON.parse(readFileSync(file, 'utf8'))).segments;
const store = new Map();
const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null };
const C = [], J = [], keys = [];
for (const seg of segs) {
    // exactly the judge's input (frozen/ps_test_runner.mjs replayInputFor): no prevGame, no steps
    const g = await runSegment({ seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc, moves: seg.moves, storage });
    const n = seg.steps.length;
    for (let i = 0; i < n; i++) {
        C.push({ screen: seg.steps[i].screen, cursor: seg.steps[i].cursor });
        J.push({ screen: g.getStepScreens()[i], cursor: g.getStepCursors()[i] });
        keys.push(seg.steps[i].key);
    }
    if (g.error) console.log(`[segment error] ${g.error.stack.split('\n').slice(0, process.env.STACK ? 14 : 4).join(' | ')}`);
}
const text = (grid) => grid.map((r) => r.map((c) => c.ch || ' ').join('').replace(/\s+$/, ''));
const cellsDiffer = (a, b) => a.ch !== b.ch || a.color !== b.color || a.attr !== b.attr;
function show(i) {
    const a = decodeScreen(C[i].screen), b = J[i].screen === undefined ? null : decodeScreen(J[i].screen);
    console.log(`step ${i} (key ${JSON.stringify(keys[i])}; previous keys ${JSON.stringify(keys.slice(Math.max(0, i - 12), i).join(''))})`);
    console.log(`cursor C ${JSON.stringify(C[i].cursor)} JS ${JSON.stringify(J[i].cursor)}`);
    if (!b) { console.log('JS: no screen (segment ended)'); return; }
    const ta = text(a), tb = text(b);
    for (let r = 0; r < 24; r++) {
        const diff = [];
        for (let c = 0; c < 80; c++) if (cellsDiffer(a[r][c], b[r][c])) diff.push(c);
        const mark = diff.length ? '*' : ' ';
        console.log(`${mark}C  ${String(r).padStart(2)}|${ta[r] || ''}`);
        if (diff.length) {
            console.log(`${mark}JS ${String(r).padStart(2)}|${tb[r] || ''}`);
            const d = diff.slice(0, 6).map((c) => `col ${c}: C ${JSON.stringify(a[r][c])} JS ${JSON.stringify(b[r][c])}`);
            console.log(`      ${d.join('; ')}${diff.length > 6 ? ` (+${diff.length - 6})` : ''}`);
        }
    }
}
// as the judge (frozen/ps_test_runner.mjs): cells and the cursor
const cursorOk = (c, j) => !Array.isArray(c) || (Array.isArray(j) && c[0] === j[0] && c[1] === j[1] && c[2] === j[2]);
const same = (i) => J[i].screen !== undefined && cursorOk(C[i].cursor, J[i].cursor)
    && JSON.stringify(decodeScreen(C[i].screen)) === JSON.stringify(decodeScreen(J[i].screen));
if (want !== undefined) show(Number(want));
else {
    const bad = [];
    for (let i = 0; i < C.length; i++) if (!same(i)) bad.push(i);
    console.log(`${C.length - bad.length}/${C.length} screens match; differing steps: ${bad.slice(0, 30).join(' ')}${bad.length > 30 ? ' ...' : ''}`);
    if (bad.length) show(bad[0]);
    if (all) for (const i of bad.slice(1, 6)) show(i);
}
