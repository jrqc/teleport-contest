#!/usr/bin/env node
// tools/fuzz/batch.mjs: one fuzz batch on fresh seeds. Seeds rotate: each batch starts
// where the last ended (results/fuzz/next-seed.json), so no batch repeats a case. Runs
// every kind (gen.mjs KINDS) through run.mjs and appends a row to results/fuzz/BATCHES.md:
// seeds, cases, failures by root cause, and the levels reached (special levels by name).
// Usage: node tools/fuzz/batch.mjs [--n 110] [--jobs 8] [--kinds a,b]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS } from './gen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results/fuzz');
mkdirSync(DIR, { recursive: true });
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const n = Number(opt('n', 110)), jobs = opt('jobs', '8'), kinds = opt('kinds', KINDS.join(','));
const STATE = path.join(DIR, 'next-seed.json');
const seed = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).next : 10000;
writeFileSync(STATE, JSON.stringify({ next: seed + n }) + '\n');   // claimed before running: a crashed batch's seeds are not reused
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const out = path.join(DIR, ts);
const code = await new Promise((res) => {
    const c = spawn('node', ['tools/fuzz/run.mjs', '--kinds', kinds, '--n', String(n), '--seed', String(seed), '--jobs', jobs, '--out', out], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('close', res);
});
const s = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
const levels = Object.keys(s.levelsReached || {});
const special = [...new Set(levels.map((l) => (l.match(/^.*?:\d+ (.+)$/) || [])[1]).filter(Boolean))];
const groups = Object.entries(s.groups).map(([k, v]) => `${v.length}× ${k.replace(/\|/g, '/')} (${v.slice(0, 3).join(', ')})`).join('; ') || '-';
const BATCHES = path.join(DIR, 'BATCHES.md');
if (!existsSync(BATCHES)) writeFileSync(BATCHES, '# Fuzz batches (tools/fuzz/batch.mjs)\n\nSeeds rotate; failing recordings stay in results/fuzz/<run>/fail/.\n\n| Run | Commit | Kinds | Seeds | Cases | Pass | Fail | Not recorded | Failures by first divergence | Levels | Special levels reached |\n|---|---|---|---|---|---|---|---|---|---|---|\n');
appendFileSync(BATCHES, `| ${ts} | ${s.commit} | ${kinds === KINDS.join(',') ? 'all' : kinds} | ${seed}-${seed + n - 1} | ${s.cases} | ${s.passed} | ${s.failed} | ${s.recordErrors} | ${groups} | ${levels.length} | ${special.sort().join(', ')} |\n`);
console.log(`batch ${ts}: seeds ${seed}-${seed + n - 1}, ${s.passed}/${s.cases} pass; ${levels.length} levels, ${special.length} special`);
process.exit(code);
