#!/usr/bin/env node
// tools/fuzz/triage.mjs: first divergence of the port on a recorded session (CLAUDE.md 4.2).
// Runs every segment through js/jsmain.js as the judge does (one shared storage, no
// prevGame) and reports, as JSON on stdout: the first RNG call that differs (global
// index, segment, step, the C caller tag from the recording, the last matching calls),
// the first screen that differs (segment, step, key), and any JS error.
// Usage: node tools/fuzz/triage.mjs rec.session.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.__nhQuiet = true;
const { runSegment } = await import(path.join(ROOT, 'js/jsmain.js'));
const { decodeScreen, diffCell } = await import(path.join(ROOT, 'frozen/screen-decode.mjs'));
const { normalizeSession } = await import(path.join(ROOT, 'frozen/session_loader.mjs'));

const isRng = (x) => /^(rn2|rnd|rn1|rnl|rne|rnz|d)\(/.test(x);
const strip = (x) => x.replace(/ @ .*$/, '').trim();
const banner = (s) => String(s).replace(/^\d{2}:\d{2}:\d{2}\.$/gm, '<time>.');
function sameScreen(a, b) {
    const ga = decodeScreen(banner(a)), gb = decodeScreen(banner(b));
    for (let r = 0; r < 24; r++) for (let c = 0; c < 80; c++) if (diffCell(ga[r][c], gb[r][c])) return false;
    return true;
}

export async function triage(file) {
    const s = normalizeSession(JSON.parse(readFileSync(file, 'utf8')));
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, clear: () => store.clear() };
    const out = { file: path.basename(file), rng: null, screen: null, error: null, steps: 0 };
    let gi = 0;   // global RNG index
    for (let si = 0; si < s.segments.length; si++) {
        const seg = s.segments[si];
        const input = { seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc, moves: seg.moves, storage };
        let g;
        try { g = await runSegment(input); } catch (e) { out.error = `segment ${si}: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`; }
        const jr = g ? g.getRngLog().filter(isRng).map(strip) : [];
        const js = g ? g.getStepScreens() : [], jc = g ? g.getStepCursors() : [];
        // C calls with their step and caller
        const cr = [];
        seg.steps.forEach((st, k) => (st.rng || []).filter(isRng).forEach((x) => cr.push({ call: strip(x), tag: (x.match(/ @ (.*)$/) || [])[1] || '', step: k })));
        if (!out.rng) {
            for (let i = 0; i < Math.max(cr.length, jr.length); i++) {
                if (!cr[i] || !jr[i] || cr[i].call !== jr[i]) {
                    out.rng = { index: gi + i, segment: si, step: cr[i] ? cr[i].step : null, c: cr[i] ? `${cr[i].call} @ ${cr[i].tag}` : '(C has no more calls)', js: jr[i] ?? '(JS has no more calls)',
                        before: cr.slice(Math.max(0, i - 4), i).map((x) => `${x.call} @ ${x.tag}`) };
                    break;
                }
            }
        }
        gi += cr.length;
        // the judge's alignment: blank ("") screens are dropped on both sides
        if (!out.screen && g && g.getScreens().length !== seg.steps.filter((x) => x.screen).length)
            out.screen = { segment: si, step: null, countMismatch: `C ${seg.steps.filter((x) => x.screen).length} non-blank screens, JS ${g.getScreens().length}` };
        if (!out.screen) {
            for (let k = 0; k < seg.steps.length; k++) {
                const st = seg.steps[k];
                const cc = st.cursor, jcur = jc[k];
                const curOk = !Array.isArray(cc) || (Array.isArray(jcur) && cc[0] === jcur[0] && cc[1] === jcur[1] && cc[2] === jcur[2]);
                if (js[k] === undefined || !sameScreen(js[k], st.screen) || !curOk) {
                    out.screen = { segment: si, step: k, key: st.key ?? null, cursorOnly: js[k] !== undefined && sameScreen(js[k], st.screen), keysBefore: seg.steps.slice(Math.max(0, k - 12), k).map((x) => x.key ?? '').join('') };
                    break;
                }
            }
        }
        out.steps += seg.steps.length;
        if (out.error) break;
    }
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await triage(process.argv[2]), null, 1));
