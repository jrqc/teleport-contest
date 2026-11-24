// Profile the per-key path the playability runner times (frozen/playability_runner.mjs):
// the same driving (start() untimed, then one moveloop_core() per queued key), with the V8
// sampling profiler on only around the interactive loop of each session. Prints ms/move and
// self time by area, module and function, summed over all sessions.
// Usage: node tools/analysis/playprof.mjs [sessions-dir-or-files...] [--top N] [--interval us]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const TOP = Number(opt('--top', '25')), INTERVAL = Number(opt('--interval', '100'));
const CALLERS = opt('--callers', null);   // also list the callers of the leaf function with this name
const targets = args.length ? args : [path.join(ROOT, 'sessions')];
const files = targets.flatMap((t) => (existsSync(t) && statSync(t).isDirectory() ? readdirSync(t).filter((f) => f.endsWith('.session.json')).map((f) => path.join(t, f)) : [t])).sort();

const url = (p) => new URL(p, `file://${ROOT}/`).href;
const M = { ...(await import(url('js/jsmain.js'))), ...(await import(url('js/allmain.js'))), ...(await import(url('js/gstate.js'))), ...(await import(url('js/game_display.js'))) };
class QueueEmpty extends Error {}

const insp = new Session();
insp.connect();
await insp.post('Profiler.enable');
await insp.post('Profiler.setSamplingInterval', { interval: INTERVAL });

const LUA = /^js\/nh\/(l[a-z]+|lua|lauxlib|lbaselib|lcorolib|ldblib|liolib|lmathlib|loslib|lstrlib|ltablib|lutf8lib|linit|loadlib)\.js$/;
const area = (m) => (m.startsWith('(') ? m : LUA.test(m) ? 'Lua (js/nh/l*.js)' : m.startsWith('js/nh/') ? 'game (js/nh)' : m.startsWith('js/crt/') ? 'C runtime (js/crt)' : m.startsWith('js/hand/') ? 'hand (js/hand)' : m.startsWith('js/') ? 'glue (js/*.js)' : 'node');
const modOf = (cf) => {
    if (!cf.url) return cf.functionName.startsWith('(') ? cf.functionName : '(native)';
    const m = /\/js\/(.*)$/.exec(cf.url.replace(/^file:\/\//, ''));
    return m ? `js/${m[1]}` : path.basename(cf.url);
};
const fn = new Map(), md = new Map(), ar = new Map(), incl = new Map(), callers = new Map();
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
let totalUs = 0, totalMs = 0, totalKeys = 0;

for (const f of files) {
    const seg = JSON.parse(readFileSync(f, 'utf8')).segments?.[0];
    if (!seg) continue;
    const display = new M.GameDisplay(null);
    display.onEmptyQueue = () => { throw new QueueEmpty(); };
    const term = display.terminal || display;
    const qlen = () => term?.inputQueueLength ?? term?._inputQueue?.length ?? 0;
    const g = new M.NethackGame({ seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc });
    g._pendingDisplay = display;
    M.game.nhDisplay = display;
    for (let i = 0; i < seg.moves.length; i++) display.pushKey(seg.moves.charCodeAt(i));
    await g.start();
    const q0 = qlen();
    await insp.post('Profiler.start');
    const t0 = performance.now();
    for (let it = 0, max = Math.max(seg.moves.length * 8, 1024); it < max; it++) {
        try { await M.moveloop_core(); } catch (e) { if (e instanceof QueueEmpty) break; throw e; }
        if (M.game.program_state?.gameover || qlen() === 0) break;
    }
    const ms = performance.now() - t0;
    const { profile } = await insp.post('Profiler.stop');
    totalMs += ms; totalKeys += Math.max(0, q0 - qlen());
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    for (let i = 0; i < profile.samples.length; i++) {
        const cf = byId.get(profile.samples[i]).callFrame;
        const us = profile.timeDeltas[i] || 0;
        const m = modOf(cf);
        if (m === 'node:inspector') continue;   // the profiler's own Profiler.stop, not the game
        if (CALLERS && cf.functionName === CALLERS) {
            let up = parent.get(profile.samples[i]);
            while (up !== undefined && !byId.get(up).callFrame.url) up = parent.get(up);
            const c = up === undefined ? null : byId.get(up).callFrame;
            add(callers, c ? `${c.functionName || '(anonymous)'}  ${modOf(c)}:${c.lineNumber + 1}` : '(root)', us);
        }
        // inclusive: every function on the sampled stack, once
        const seen = new Set();
        for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) {
            const c = byId.get(id).callFrame;
            if (!c.url) continue;
            const k = `${c.functionName || '(anonymous)'}  ${modOf(c)}:${c.lineNumber + 1}`;
            if (!seen.has(k)) { seen.add(k); add(incl, k, us); }
        }
        add(fn, `${cf.functionName || '(anonymous)'}  ${m}:${cf.lineNumber + 1}`, us);
        add(md, m, us);
        add(ar, area(m), us);
        totalUs += us;
    }
    process.stderr.write('.');
}
const pct = (t) => `${((100 * t) / totalUs).toFixed(1).padStart(5)}%`;
const show = (title, m, n) => { console.log(`-- ${title} --`); for (const [k, t] of [...m].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`${pct(t)} ${(t / 1000).toFixed(0).padStart(6)} ms  ${k}`); };
console.log(`\n${files.length} sessions, ${totalKeys} keys, interactive ${totalMs.toFixed(0)} ms: ${(totalMs / totalKeys).toFixed(3)} ms/move (profiler on; sampled ${(totalUs / 1000).toFixed(0)} ms)`);
show('self time by area', ar, 12);
show('self time by module', md, TOP);
show('self time by function', fn, TOP);
if (CALLERS) show(`callers of ${CALLERS} (self time of ${CALLERS})`, callers, TOP);
show('inclusive time by function (game and runtime)', new Map([...incl].filter(([k]) => /js\//.test(k))), TOP + 15);
