#!/usr/bin/env node
// run.mjs: transpile the recorder's NetHack TUs (M1). Two passes over the
// compile database (facts, then emit), one AST in memory at a time.
// Usage: node transpiler/emit/run.mjs [--out DIR] [tu-basename ...]
// Writes DIR/<tu>.js, types.js, globals.js, index.js and DIR/../emit-report.md.
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadAst, ROOT } from '../frontend/ast.mjs';
import { tuScope } from '../ir/scope.mjs';
import { Program } from './program.mjs';
import { parseJsonc } from '../annotations/jsonc.mjs';

const args = process.argv.slice(2);
let out = path.join(ROOT, 'transpiler/build/nh');
const oi = args.indexOf('--out');
if (oi >= 0) { out = path.resolve(args[oi + 1]); args.splice(oi, 2); }
const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8')).filter((e) => e.group === 'nethack');
const only = new Set(args);
const crtNames = new Set(Object.keys(await import('../../js/crt/index.js')));
const ann = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
const handwritten = Object.entries(ann.functions || {}).filter(([, f]) => f.handwritten).map(([k]) => k);
const prog = new Program({ crtNames, handwritten, asyncCut: (ann.edges && ann.edges.cut || []).map((c) => c.to) });
const luaDb = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8')).filter((e) => e.group === 'lua');
prog.missingFn = new Set();

const load = async (e) => {
    const { root } = await loadAst(e);
    return { root, scope: tuScope(root, e.directory), file: path.relative(ROOT, path.resolve(ROOT, e.file)), dir: e.directory };
};
const t0 = Date.now();
for (const e of db) { prog.addFacts(await load(e)); process.stderr.write('.'); }
// Lua is not emitted yet (heap backend), but its calls back into NetHack shape the async set
for (const e of luaDb) { prog.addCallFacts(await load(e)); process.stderr.write(','); }
process.stderr.write(` async ${JSON.stringify(prog.asyncReady().stats())}\n`);
process.stderr.write(` facts ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
mkdirSync(out, { recursive: true });
const crtLink = path.join(out, '..', 'crt');
if (!existsSync(crtLink)) symlinkSync(path.join(ROOT, 'js/crt'), crtLink);
const errors = [];
const perTu = [];
for (const e of db) {
    if (only.size && !only.has(path.basename(e.file))) continue;
    const tu = await load(e);
    const r = prog.emitTU(tu);
    writeFileSync(path.join(out, r.path), r.code);
    errors.push(...r.errors);
    perTu.push({ file: tu.file, lines: r.code.split('\n').length, errors: r.errors.length });
    process.stderr.write(r.errors.length ? 'x' : '.');
}
for (const [f, text] of prog.finish()) writeFileSync(path.join(out, f), text);
process.stderr.write(` emit ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
// syntax check
const bad = [];
for (const t of perTu) {
    const f = path.join(out, path.basename(t.file).replace(/\.c$/, '.js'));
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (err) { bad.push(`${path.basename(f)}: ${String(err.stderr).split('\n').slice(0, 5).join(' | ')}`); }
}
// group errors by message shape
const groups = new Map();
for (const e of errors) {
    const k = e.replace(/^[^:]+: /, '').replace(/^[^ ]+:\d+: /, '').replace(/\b[a-z_][a-z_0-9]*\b(?=[,)]| \()/gi, 'X').replace(/\d+/g, 'N').slice(0, 90);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
}
const rep = [];
rep.push('# Emit report (M1)', '', `${perTu.length} TUs, ${perTu.reduce((a, t) => a + t.lines, 0)} lines of JS, ${errors.length} functions/globals not emitted, ${bad.length} files fail node --check, ${prog.missingFn.size} called functions undefined`, '');
rep.push('## Errors by kind', '', '| Count | Kind | Example |', '|---|---|---|');
for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length)) rep.push(`| ${v.length} | ${k.replace(/\|/g, '\\|')} | ${v[0].replace(/\|/g, '\\|').slice(0, 140)} |`);
rep.push('', '## node --check failures', '', ...bad.map((b) => `- ${b}`));
rep.push('', '## Undefined functions (called, not defined in any TU or the runtime)', '', [...prog.missingFn].sort().join(', '));
writeFileSync(path.join(out, '..', 'emit-report.md'), rep.join('\n') + '\n');
console.log(rep.slice(0, 40).join('\n'));
