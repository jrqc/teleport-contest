#!/usr/bin/env node
// run.mjs: transpile the recorder's NetHack TUs (M1). Two passes over the
// compile database (facts, then emit), one AST in memory at a time.
// Usage: node transpiler/emit/run.mjs [--out DIR] [tu-basename ...]
// Writes DIR/<tu>.js, types.js, globals.js, index.js (and luabridge.js); the report goes to transpiler/build/emit-report.md.
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
const ann0 = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
// extern groups (isaac64): not transpiled; the runtime adapter defines their functions
const externFiles = Object.values(ann0.groups || {}).filter((g) => g.repr === 'extern').map((g) => g.files);
const isExtern = (e) => externFiles.some((f) => path.relative(ROOT, path.resolve(ROOT, e.file)).endsWith(f));
const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8')).filter((e) => e.group === 'nethack' && !isExtern(e));
const only = new Set(args);
const crtNames = new Set(Object.keys(await import('../../js/crt/index.js')));
const heapCrtNames = new Set(Object.keys(await import('../../js/crt/heaplibc.js')));
const ann = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
const handwritten = Object.entries(ann.functions || {}).filter(([, f]) => f.handwritten).map(([k]) => k.replace(/^.*::/, ''));   // "file::name" for statics
const tails = Object.entries(ann.types || {}).filter(([, t]) => t.tail).map(([k]) => k.replace(/^(struct|union) /, ''));
// union cells (design 3.4.2, D1): the punning check's verdict; an annotation types["union X"].repr overrides
const punVerdicts = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/union-pun.json'), 'utf8'));
const cells = Object.entries(punVerdicts).filter(([k, v]) => {
    const a = (ann.types || {})[k];
    return a && a.repr ? a.repr === 'union-cell' : v.verdict === 'union-cell';
}).map(([k]) => k.replace(/^union /, ''));
const handModules = Object.fromEntries(Object.entries(ann.functions || {}).filter(([, f]) => f.handwritten && f.handwritten.startsWith('js/hand/'))
    .map(([k, f]) => [k.replace(/^.*::/, ''), '../' + f.handwritten.replace(/^js\//, '').replace(/\.js$/, '')]));
// heap-world groups (annotations groups[].repr "heap"): Lua, and the vendored Darwin regex
const heapGroups = Object.values(ann0.groups || {}).filter((g) => g.repr === 'heap');
const isHeapFile = (file) => heapGroups.some((g) => file.includes(g.files));
const prog = new Program({ crtNames, heapCrtNames, handwritten, handModules, tails, cells, isHeapFile, asyncCut: (ann.edges && ann.edges.cut || []).map((c) => c.to) });
const luaDb = [
    ...JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8')).filter((e) => e.group === 'lua'),
    // transpiler/third_party/README.md (postmortem F2)
    ...JSON.parse(readFileSync(path.join(ROOT, 'transpiler/third_party/compile_commands.json'), 'utf8')),
];
prog.missingFn = new Set();

// group defines (annotations groups[].defines) apply to the group's files
const groupOf = (e) => Object.values(ann0.groups || {}).find((g) => path.relative(ROOT, path.resolve(ROOT, e.file)).includes(g.files));
const load = async (e0) => {
    const g = groupOf(e0);
    const e = g && g.defines ? { ...e0, extraArgs: g.defines } : e0;
    const { root } = await loadAst(e);
    return { root, scope: tuScope(root, e.directory), file: path.relative(ROOT, path.resolve(ROOT, e.file)), dir: e.directory, entry: e };
};
const t0 = Date.now();
for (const e of db) { prog.addFacts(await load(e)); process.stderr.write('.'); }
// the Lua interpreter: heap world (decision D2)
for (const e of luaDb) { prog.addFacts(await load(e)); process.stderr.write(','); }
process.stderr.write(` async ${JSON.stringify(prog.asyncReady().stats())}\n`);
process.stderr.write(` facts ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
mkdirSync(out, { recursive: true });
const crtLink = path.join(out, '..', 'crt');
if (!existsSync(crtLink)) symlinkSync(path.join(ROOT, 'js/crt'), crtLink);
const errors = [];
const perTu = [];
const results = [];
for (const e of [...db, ...luaDb]) {
    if (only.size && !only.has(path.basename(e.file))) continue;
    const tu = await load(e);
    const r = prog.emitTU(tu);
    results.push(r);
    errors.push(...r.errors);
    perTu.push({ file: tu.file, errors: r.errors.length });
    process.stderr.write(r.errors.length ? 'x' : '.');
}
// readability plan P3: macro sites are resolved once every TU is emitted
const finalCode = prog.resolveTUs(results);
perTu.forEach((t, i) => { const code = finalCode.get(results[i].path); writeFileSync(path.join(out, results[i].path), code); t.lines = code.split('\n').length; });
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
writeFileSync(path.join(ROOT, 'transpiler/build/emit-report.md'), rep.join('\n') + '\n');   // never inside js/ (judged)
console.log(rep.slice(0, 40).join('\n'));
