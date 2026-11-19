#!/usr/bin/env node
// tools/sandbox-score.mjs: T7 (postmortem F17). Score every session with
// runSegment running under the judge's sandbox (docs/API.md "Scoring isolation"):
// Node's permission model (--permission), reads limited by --allow-fs-read, so no
// filesystem writes, child processes, worker threads, native addons or WASI.
// The frozen runner's own worker mode (--worker-session) is the process that
// imports js/jsmain.js and calls runSegment; this tool runs that worker sandboxed
// and compares each session with the latest unsandboxed run (results/*/score.json).
// The judge also keeps the recording out of that process; that changes nothing our
// code can observe, so it is not modeled.
//
// Policies:
//   judge   --allow-fs-read=<fork>  (the fork tree, which contains the runner)
//   strict  --allow-fs-read=js/,frozen/,<the session file>: any other file read by
//           our code fails, which a run with the whole fork readable would hide
// Usage: node tools/sandbox-score.mjs [--policy judge|strict|both] [session ...]
// Exit 1 if any session fails, differs from the unsandboxed run, or logs an
// access denial.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'frozen/ps_test_runner.mjs');
const args = process.argv.slice(2);
const pi = args.indexOf('--policy');
const policyArg = pi >= 0 ? args.splice(pi, 2)[1] : 'both';
const policies = policyArg === 'both' ? ['judge', 'strict'] : [policyArg];
let files = args.length ? args.map((a) => path.resolve(a))
    : readdirSync(path.join(ROOT, 'sessions')).filter((f) => f.endsWith('.session.json')).sort().map((f) => path.join(ROOT, 'sessions', f));

// the judge overlays the frozen files; a run with different copies would not be its run
for (const f of ['isaac64.js', 'terminal.js', 'storage.js']) {
    if (!readFileSync(path.join(ROOT, 'js', f)).equals(readFileSync(path.join(ROOT, 'frozen', f)))) {
        console.error(`js/${f} differs from frozen/${f}: run bash frozen/score.sh once (it overlays them)`); process.exit(2);
    }
}
const runs = readdirSync(path.join(ROOT, 'results')).filter((d) => /^\d{8}T\d{6}$/.test(d) && existsSync(path.join(ROOT, 'results', d, 'score.json'))).sort();
const base = runs.length ? JSON.parse(readFileSync(path.join(ROOT, 'results', runs.at(-1), 'score.json'), 'utf8')) : null;

function flags(policy, sf) {
    const reads = policy === 'judge' ? [ROOT] : [path.join(ROOT, 'js') + '/', path.join(ROOT, 'frozen') + '/', sf];
    return ['--permission', ...reads.map((r) => `--allow-fs-read=${r}`)];
}
const out = { policies: {}, baseline: runs.at(-1) || null, node: process.version };
let bad = 0;
for (const policy of policies) {
    const rows = {};
    let pass = 0, scr = 0, scrT = 0, rng = 0, rngT = 0;
    for (const sf of files) {
        const name = path.basename(sf).replace(/\.session\.json$/, '');
        const t0 = performance.now();
        const c = spawnSync(process.execPath, [...flags(policy, sf), RUNNER, `--worker-session=${sf}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000 });
        const ms = performance.now() - t0;
        const idx = (c.stdout || '').lastIndexOf('__RESULT_ONE__');
        const denied = /ERR_ACCESS_DENIED|permission/i.test(c.stderr || '') ? (c.stderr.match(/.*(ERR_ACCESS_DENIED|ermission).*/) || [''])[0].trim() : null;
        let r = null, problem = null;
        if (idx < 0) problem = `no result (status ${c.status}${c.error ? ', ' + c.error.message : ''}): ${(c.stderr || '').trim().split('\n').slice(-3).join(' | ')}`;
        else r = JSON.parse(c.stdout.slice(idx + 14).trim());
        const m = r ? r.metrics : null;
        const row = r ? { passed: r.passed, screens: m.screens.matched, screensTotal: m.screens.total, rng: m.rngCalls.matched, rngTotal: m.rngCalls.total, ms: Math.round(ms) } : { passed: false, ms: Math.round(ms) };
        const b = base && base.sessions[name];
        if (!problem && b && (b.screens !== row.screens || b.rng !== row.rng || b.passed !== row.passed)) problem = `differs from unsandboxed ${runs.at(-1)}: screens ${b.screens}->${row.screens}, rng ${b.rng}->${row.rng}`;
        if (!problem && !row.passed) problem = 'failed';
        if (denied) problem = (problem ? problem + '; ' : '') + `access denial logged: ${denied}`;
        if (problem) { bad++; row.problem = problem; }
        rows[name] = row;
        if (row.passed) pass++;
        scr += row.screens || 0; scrT += row.screensTotal || 0; rng += row.rng || 0; rngT += row.rngTotal || 0;
        process.stderr.write(`${policy.padEnd(6)} ${problem ? 'BAD ' : 'ok  '} ${name} ${row.screens ?? '-'}/${row.screensTotal ?? '-'} ${Math.round(ms)} ms${problem ? '  ' + problem : ''}\n`);
    }
    out.policies[policy] = { totals: { passed: pass, sessions: files.length, screens: scr, screensTotal: scrT, rng, rngTotal: rngT }, sessions: rows };
    console.log(`${policy}: passed ${pass}/${files.length}; screens ${scr}/${scrT}; RNG ${rng}/${rngT}`);
}
const dir = path.join(ROOT, 'results', 'sandbox');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(out, null, 1) + '\n');
console.log(bad ? `${bad} problem(s)` : `no problems (baseline ${out.baseline}, node ${process.version})`);
process.exit(bad ? 1 : 0);
