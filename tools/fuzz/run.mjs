#!/usr/bin/env node
// tools/fuzz/run.mjs: random differential testing (postmortem T2 + T3, and T6's
// bones and save chains): generate recipes (gen.mjs), record each with the reference
// C recorder, score the port on the recording with the frozen runner's worker,
// and triage failures (triage.mjs).
//
// Usage: node tools/fuzz/run.mjs [--kinds opts,play,deep,bones,saves] [--n 40]
//                                [--seed 1] [--jobs 6] [--out DIR] [--keep]
//        node tools/fuzz/run.mjs --regress   (the cases in regress.json: found bugs)
// Output: DIR (default results/fuzz/<timestamp>/): summary.json, summary.md, and
// fail/<kind>-<seed>.session.json (the recording) + .triage.json for each failure.
// Groups failures by the C caller of the first differing RNG call (or by error), so
// one root cause is one line. Exit 1 if any case failed.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gen, KINDS } from './gen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const kinds = opt('kinds', KINDS.join(',')).split(',');
const n = Number(opt('n', 40)), seed0 = Number(opt('seed', 1)), jobs = Number(opt('jobs', Math.max(2, Math.floor(os.cpus().length / 2))));
const keep = process.argv.includes('--keep');   // also keep passing recordings (OUT/all/)
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const OUT = path.resolve(opt('out', path.join(ROOT, 'results', 'fuzz', ts)));
mkdirSync(path.join(OUT, 'fail'), { recursive: true });
const INSTALL = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder/install/games/lib/nethackdir');
if (!existsSync(INSTALL)) { console.error('reference recorder missing: bash tools/recorder-env/build-reference.sh'); process.exit(2); }

function sh(cmd, args, env = {}, timeout = 300_000) {
    return new Promise((resolve) => {
        const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
        let out = '', err = '';
        const t = setTimeout(() => c.kill('SIGKILL'), timeout);
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
}

const cases = [];
if (process.argv.includes('--regress')) cases.push(...JSON.parse(readFileSync(new URL('./regress.json', import.meta.url), 'utf8')).cases);
else for (let i = 0; i < n; i++) for (const k of kinds) cases.push({ kind: k, seed: seed0 + i });
const results = [];
async function worker(w) {
    // a private copy of the game directory: bones, saves and the record file are per recording
    const dir = mkdtempSync(path.join(os.tmpdir(), `nhfz${w}-`));
    const inst = path.join(dir, 'nethackdir');
    cpSync(INSTALL, inst, { recursive: true });
    for (;;) {
        const c = cases.shift();
        if (!c) break;
        const name = `${c.kind}-${c.seed}`;
        const recipe = path.join(dir, `${name}.recipe.json`), rec = path.join(dir, `${name}.session.json`);
        writeFileSync(recipe, JSON.stringify(gen(c.kind, c.seed)));
        const t0 = performance.now();
        const r = await sh('node', ['tools/recorder-env/record-session.mjs', recipe, rec], { NETHACK_INSTALL: inst, RERECORD_CANON_HOME: '1' });
        const recMs = performance.now() - t0;
        const row = { name, kind: c.kind, seed: c.seed, recMs: Math.round(recMs) };
        if (r.code !== 0 || !existsSync(rec)) { row.recordError = r.err.trim().split('\n').slice(-3).join(' | '); results.push(row); log(row); continue; }
        const s = await sh('node', ['frozen/ps_test_runner.mjs', `--worker-session=${rec}`], {}, 900_000);
        const idx = s.out.lastIndexOf('__RESULT_ONE__');
        if (idx < 0) { row.error = `runner: ${s.err.trim().split('\n').slice(-3).join(' | ')}`; }
        else {
            const m = JSON.parse(s.out.slice(idx + 14)).metrics;
            Object.assign(row, { passed: m.screens.matched === m.screens.total && m.rngCalls.matched === m.rngCalls.total, screens: m.screens.matched, screensTotal: m.screens.total, rng: m.rngCalls.matched, rngTotal: m.rngCalls.total });
        }
        if (!row.passed) {
            const t = await sh('node', ['tools/fuzz/triage.mjs', rec], {}, 900_000);
            try { row.triage = JSON.parse(t.out); } catch { row.triage = { error: t.err.trim().split('\n').slice(-3).join(' | ') }; }
            cpSync(rec, path.join(OUT, 'fail', `${name}.session.json`));
            writeFileSync(path.join(OUT, 'fail', `${name}.triage.json`), JSON.stringify(row.triage, null, 1));
        }
        // the levels it visited (the port's game state: dungeon, level, special level)
        const lv = await sh('node', ['tools/fuzz/levels.mjs', rec], {}, 900_000);
        try { row.levels = JSON.parse(lv.out); } catch { row.levels = null; }
        if (keep) { mkdirSync(path.join(OUT, 'all'), { recursive: true }); cpSync(rec, path.join(OUT, 'all', `${name}.session.json`)); }
        results.push(row);
        log(row);
    }
    rmSync(dir, { recursive: true, force: true });
}
function log(r) {
    const st = r.recordError ? `RECORD-ERROR ${r.recordError}` : r.passed ? 'ok' : `FAIL screens ${r.screens}/${r.screensTotal} rng ${r.rng}/${r.rngTotal}`;
    process.stderr.write(`${r.name.padEnd(12)} ${st}${r.triage ? '  ' + cause(r) : ''}\n`);
}
function cause(r) {
    const t = r.triage || {};
    if (t.error) return `error: ${t.error.slice(0, 160)}`;
    if (t.rng) return `rng@${t.rng.index} C ${t.rng.c} | JS ${t.rng.js}`;
    if (t.screen) return `screen s${t.screen.segment}/${t.screen.step}${t.screen.cursorOnly ? ' (cursor only)' : ''} key ${JSON.stringify(t.screen.key)}`;
    return r.error || 'unknown';
}
await Promise.all(Array.from({ length: jobs }, (_, w) => worker(w)));

results.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.seed - b.seed));
const fails = results.filter((r) => !r.passed && !r.recordError);
const groups = new Map();
for (const r of fails) {
    const t = r.triage || {};
    const key = t.error ? `error: ${t.error.replace(/segment \d+: /, '').split(' | ')[0].slice(0, 120)}`
        : t.rng ? `rng: ${(t.rng.c.match(/@ (\S+)/) || [])[1] || t.rng.c}` : t.screen ? `screen only${t.screen.cursorOnly ? ' (cursor)' : ''}` : r.error || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.name);
}
// levels reached in this run: label -> cases that visited it (special levels by name)
const levelCount = new Map();
for (const r of results) for (const l of r.levels || []) levelCount.set(l, (levelCount.get(l) || 0) + 1);
const levelKey = (l) => { const m = l.match(/^(.*):(\d+)( .*)?$/); return m ? [m[1], Number(m[2])] : [l, 0]; };
const levelsReached = [...levelCount].sort((a, b) => { const [da, la] = levelKey(a[0]), [db, lb] = levelKey(b[0]); return da < db ? -1 : da > db ? 1 : la - lb; });
const summary = { ts, commit: (await sh('git', ['rev-parse', '--short', 'HEAD'])).out.trim(), cases: results.length, levelsReached: Object.fromEntries(levelsReached),
    passed: results.filter((r) => r.passed).length, failed: fails.length, recordErrors: results.filter((r) => r.recordError).length,
    groups: Object.fromEntries([...groups].sort((a, b) => b[1].length - a[1].length)), results };
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
const md = [`# Fuzz ${ts} (commit ${summary.commit})`, '', `${summary.cases} cases: ${summary.passed} pass, ${summary.failed} fail, ${summary.recordErrors} not recorded`, '',
    '| Cases | First divergence (C caller of the first differing RNG call, or error) | Examples |', '|---|---|---|',
    ...[...groups].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `| ${v.length} | ${k.replace(/\|/g, '/')} | ${v.slice(0, 4).join(', ')} |`),
    '', `## Levels reached (${levelsReached.length} distinct; cases that visited each)`, '',
    ...[...new Set(levelsReached.map(([l]) => levelKey(l)[0]))].map((d) => `- **${d}**: ` + levelsReached.filter(([l]) => levelKey(l)[0] === d)
        .map(([l, c]) => `${l.slice(d.length + 1)} (${c})`).join(', ')),
    '', `Special levels: ${[...new Set(levelsReached.filter(([l]) => / /.test(l.replace(/^.*?:\d+/, ''))).map(([l]) => l.replace(/^.*?:\d+ /, '')))].join(', ') || 'none'}`];
writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
process.exit(fails.length ? 1 : 0);
