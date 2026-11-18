#!/usr/bin/env node
// tools/score.mjs: score runner (CLAUDE.md tool 4.1).
// Runs frozen/score.sh (the judge's runner, which overlays the frozen files),
// parses its __RESULTS_JSON__ block, writes results/<timestamp>/score.json and
// summary.md, and compares every session with the previous run: any session
// whose screens, RNG or pass status went down is a REGRESSION (exit status 1).
// Usage: node tools/score.mjs [--from FILE]   (--from: parse a saved score.sh output instead of running it)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'results');
const args = process.argv.slice(2);
let text;
if (args[0] === '--from') text = readFileSync(args[1], 'utf8');
else {
    try { text = execFileSync('bash', ['frozen/score.sh'], { cwd: ROOT, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
    catch (e) { text = String(e.stdout || ''); if (!text.includes('__RESULTS_JSON__')) { console.error(String(e.stderr || e)); process.exit(2); } }
}
const j = JSON.parse(text.slice(text.indexOf('__RESULTS_JSON__') + '__RESULTS_JSON__'.length));
const per = {};
for (const r of j.results) {
    per[r.session.replace(/\.session\.json$/, '')] = {
        passed: r.passed, screens: r.metrics.screens.matched, screensTotal: r.metrics.screens.total,
        rng: r.metrics.rngCalls.matched, rngTotal: r.metrics.rngCalls.total,
        cursors: r.metrics.cursors.matched, ms: r.time && r.time.ms, error: r.error,
    };
}
const sum = (k) => Object.values(per).reduce((a, x) => a + (x[k] || 0), 0);
const totals = { passed: Object.values(per).filter((x) => x.passed).length, sessions: j.results.length,
    screens: sum('screens'), screensTotal: sum('screensTotal'), rng: sum('rng'), rngTotal: sum('rngTotal'),
    maxMs: Math.max(...Object.values(per).map((x) => x.ms || 0)) };

// previous run
mkdirSync(RES, { recursive: true });
const prevDirs = readdirSync(RES).filter((d) => /^\d{8}T\d{6}/.test(d) && existsSync(path.join(RES, d, 'score.json'))).sort();
const prev = prevDirs.length ? JSON.parse(readFileSync(path.join(RES, prevDirs[prevDirs.length - 1], 'score.json'), 'utf8')) : null;
const regressions = [], gains = [];
if (prev) {
    for (const [s, x] of Object.entries(per)) {
        const p = prev.sessions[s];
        if (!p) continue;
        if (x.screens < p.screens || x.rng < p.rng || (p.passed && !x.passed)) regressions.push(`${s}: screens ${p.screens} -> ${x.screens}, rng ${p.rng} -> ${x.rng}${p.passed && !x.passed ? ', no longer passes' : ''}`);
        else if (x.screens > p.screens || x.rng > p.rng) gains.push(`${s}: screens ${p.screens} -> ${x.screens}, rng ${p.rng} -> ${x.rng}`);
    }
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
const dir = path.join(RES, stamp);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'score.json'), JSON.stringify({ commit: j.commit, timestamp: j.timestamp, totals, sessions: per }, null, 1) + '\n');
const lines = [`# Score ${stamp} (commit ${j.commit})`, '',
    `- passed ${totals.passed}/${totals.sessions}; screens ${totals.screens}/${totals.screensTotal}; RNG ${totals.rng}/${totals.rngTotal}; slowest session ${(totals.maxMs / 1000).toFixed(1)} s`,
    prev ? `- previous (${prevDirs[prevDirs.length - 1]}): passed ${prev.totals.passed}, screens ${prev.totals.screens}, RNG ${prev.totals.rng}` : '- no previous run', '',
    regressions.length ? `## REGRESSIONS (${regressions.length})\n\n${regressions.map((r) => `- ${r}`).join('\n')}\n` : '## No regressions\n',
    gains.length ? `## Gains (${gains.length})\n\n${gains.map((r) => `- ${r}`).join('\n')}\n` : ''];
writeFileSync(path.join(dir, 'summary.md'), lines.join('\n'));
console.log(lines.join('\n'));
process.exit(regressions.length ? 1 : 0);
