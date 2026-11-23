#!/usr/bin/env node
// tools/tablecheck.mjs: checks the table literals of readability plan P2c.
//
// Transpiles with NH_TABLE_CHECK set, so every table the emitter writes as a literal is
// also built the old way (per-element assignments) in the same $init; the two builds are
// compared field by field (tools/tablecheck-helper.mjs: C layout from $fields, pointers by
// peq). Then runs the first segment of a session so every module's $init runs.
// Usage: node tools/tablecheck.mjs [sessions/X.session.json]
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, symlinkSync, cpSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = process.argv[2] || path.join(ROOT, 'sessions/seed8000-tourist-starter.session.json');
const T = mkdtempSync(path.join(os.tmpdir(), 'nhtablecheck-'));
const J = path.join(T, 'js');
mkdirSync(J);
// modules that import nh/ are copied (a symlink would resolve to the real js/nh)
for (const f of readdirSync(path.join(ROOT, 'js'))) {
    const src = path.join(ROOT, 'js', f);
    if (f === 'nh') continue;
    if (f === 'hand') cpSync(src, path.join(J, f), { recursive: true });
    else if (f.endsWith('.js')) copyFileSync(src, path.join(J, f));
    else symlinkSync(src, path.join(J, f));
}
const helper = pathToFileURL(path.join(ROOT, 'tools/tablecheck-helper.mjs')).href;
const r = spawnSync(process.execPath, [path.join(ROOT, 'transpiler/emit/run.mjs'), '--out', path.join(J, 'nh')], { cwd: ROOT, env: { ...process.env, NH_TABLE_CHECK: helper }, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 26 });
if (r.status !== 0) { console.error(String(r.stderr).slice(-2000)); process.exit(1); }
const { runSegment } = await import(pathToFileURL(path.join(J, 'jsmain.js')).href);
const { checked } = await import(helper);
const seg = JSON.parse(readFileSync(session, 'utf8')).segments[0];
const storage = new Map();
const store = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), key: (i) => [...storage.keys()][i] ?? null, get length() { return storage.size; }, clear: () => storage.clear() };
let ok = true;
try { await runSegment({ seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc, moves: seg.moves, storage: store }); }
catch (e) { ok = false; console.error(e.message); }
console.log(`${ok ? 'ok' : 'FAILED'}: ${new Set(checked).size} tables built both ways and compared (${checked.length} $init runs)`);
rmSync(T, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
