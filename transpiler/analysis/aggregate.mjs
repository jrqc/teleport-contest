#!/usr/bin/env node
// aggregate.mjs: merge per-TU inventories (transpiler/out/inventory/tu/*.json)
// into whole-program tables:
//   transpiler/out/inventory/summary.json   all numbers
//   transpiler/out/inventory/summary.md     human-readable tables
//   transpiler/out/inventory/callgraph.json functions, direct edges, indirect calls
// Header definitions seen by many TUs are counted once (deduped by file:line).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';

const INV = path.join(ROOT, 'transpiler/out/inventory');
import { TREE_PREFIX, short } from './aggregate-lib.mjs';

const tus = readdirSync(path.join(INV, 'tu')).filter((f) => f.endsWith('.json'))
    .sort().map((f) => JSON.parse(readFileSync(path.join(INV, 'tu', f), 'utf8')));

const groupOfFile = (f) => (f.startsWith('lib/lua') ? 'lua' : 'nethack');
const inc = (o, k, n = 1) => { o[k] = (Object.hasOwn(o, k) ? o[k] : 0) + n; };
const top = (o, n = 15) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

// ---------- dedupe ----------
const functions = new Map();   // file:line:name -> fn (+tu)
const records = new Map();
const globals = new Map();
const sites = new Map();
const fnDeclKind = Object.create(null);         // name -> proj|sys|builtin (proj wins)
const addrTaken = Object.create(null);
for (const tu of tus) {
    for (const f of tu.functions) {
        f.file = short(f.file);
        const k = `${f.file}:${f.line}:${f.name}`;
        if (!functions.has(k)) functions.set(k, { ...f, tu: short(tu.tu) });
    }
    for (const r of tu.records) {
        r.file = short(r.file);
        const k = `${r.file}:${r.line}`;
        if (!records.has(k)) records.set(k, r);
    }
    for (const g of tu.globals) {
        g.file = short(g.file);
        const k = `${g.name}@${g.file}:${g.line}`;
        if (!globals.has(k)) globals.set(k, g);
    }
    for (const s of tu.sites) {
        s.file = short(s.file);
        const k = `${s.p}|${s.file}:${s.line}|${s.d}|${s.fn}`;
        const prev = sites.get(k);
        if (prev) prev.n = Math.max(prev.n, (tu._seen || 0) + 1); else sites.set(k, { ...s, n: 1 });
    }
    for (const [n, kind] of Object.entries(tu.fnDecls)) {
        if (kind === 'proj' || !fnDeclKind[n]) fnDeclKind[n] = kind;
    }
    for (const [n, c] of Object.entries(tu.addrTaken)) inc(addrTaken, n, c);
}
// a site inside one function can repeat on one line; count each occurrence once per TU
// (n above is advisory); the counts below use unique (pattern, file, line, detail, fn).

const FN = [...functions.values()];
const SITES = [...sites.values()];
const RECS = [...records.values()];
const GLOBS = [...globals.values()];

// ---------- line counts ----------
function countLines(rel) { return readFileSync(path.join(ROOT, TREE_PREFIX, rel), 'utf8').split('\n').length - 1; }
function listDir(rel, re) {
    const d = path.join(ROOT, TREE_PREFIX, rel);
    return existsSync(d) ? readdirSync(d).filter((f) => re.test(f)).map((f) => `${rel}/${f}`) : [];
}
const tuFiles = tus.map((t) => short(t.tu));
const lineTable = [];
const addRow = (label, files, how) => lineTable.push({ label, files: files.length, lines: files.reduce((a, f) => a + countLines(f), 0), how });
addRow('src/*.c (game core, linked)', tuFiles.filter((f) => f.startsWith('src/')), 'full');
addRow('include/*.h', listDir('include', /\.h$/), 'full');
addRow('win/tty/*.c (linked)', tuFiles.filter((f) => f.startsWith('win/tty/')), 'full');
addRow('sys/unix + sys/share (linked)', tuFiles.filter((f) => f.startsWith('sys/')), 'full');
addRow('Lua 5.4.8 *.c (liblua.a: core + libs)', tuFiles.filter((f) => f.startsWith('lib/lua')), 'full');
addRow('Lua 5.4.8 *.h', listDir('lib/lua-5.4.8/src', /\.h$/), 'full');
addRow('dat/*.lua (level/dungeon scripts)', listDir('dat', /\.lua$/), 'data + RNG scan');
const headersUsed = new Set();
for (const f of FN) if (f.file.endsWith('.h')) headersUsed.add(f.file);

// ---------- function stats ----------
const fstats = (g) => {
    const fs = FN.filter((f) => groupOfFile(f.file) === g);
    return {
        definitions: fs.length,
        static: fs.filter((f) => f.static).length,
        variadic: fs.filter((f) => f.variadic).length,
        withGoto: fs.filter((f) => f.gotos > 0).length,
        gotos: fs.reduce((a, f) => a + f.gotos, 0),
        labels: fs.reduce((a, f) => a + f.labels, 0),
        withStaticLocals: fs.filter((f) => f.staticLocals.length).length,
        staticLocals: fs.reduce((a, f) => a + f.staticLocals.length, 0),
        switches: fs.reduce((a, f) => a + f.switches, 0),
        returnsStructByValue: fs.filter((f) => f.returnsStruct).length,
        directCallSites: fs.reduce((a, f) => a + Object.values(f.calls).reduce((x, y) => x + y, 0), 0),
        indirectCallSites: fs.reduce((a, f) => a + Object.values(f.icalls).reduce((x, y) => x + y, 0), 0),
    };
};

// ---------- sites ----------
const sitesBy = Object.create(null);
for (const s of SITES) {
    const g = groupOfFile(s.file);
    const e = sitesBy[s.p] || (sitesBy[s.p] = { nethack: 0, lua: 0, detail: Object.create(null), files: Object.create(null), inMacro: 0 });
    e[g]++;
    if (s.m) e.inMacro++;
    inc(e.detail, s.d == null ? '' : String(s.d).replace(/ @.*$/, (m) => m));
    inc(e.files, s.file);
}

// ---------- libc / system calls ----------
const globalDefsAll = new Set(FN.map((f) => f.name));
const libc = Object.create(null);
for (const f of FN) {
    for (const [callee, c] of Object.entries(f.calls)) {
        // implicit builtins (e.g. __builtin___sprintf_chk from macOS fortify
        // macros) have no FunctionDecl node: no kind -> builtin
        // clang places an implicit builtin's declaration at its first use (a
        // project file), so __builtin* names are classified by name
        const kind = callee.startsWith('__builtin') ? 'builtin'
            : (fnDeclKind[callee] || (globalDefsAll.has(callee) ? 'proj' : 'builtin'));
        if (kind === 'sys' || kind === 'builtin') {
            const e = libc[callee] || (libc[callee] = { kind, nethack: 0, lua: 0, callers: new Set() });
            e[groupOfFile(f.file)] += c;
            e.callers.add(f.file.split('/').pop());
        }
    }
}

// ---------- indirect calls ----------
const icalls = Object.create(null);
for (const f of FN) for (const [k, c] of Object.entries(f.icalls)) inc(icalls, `${groupOfFile(f.file)}  ${k.split('|')[0]}`, c);

// ---------- RNG ----------
const RNG_CORE = ['rn2', 'rnd', 'rnl', 'rne', 'rnz', 'd'];
const rng = { core: Object.create(null), display: 0, coreFns: 0, displayFns: 0, otherPrng: Object.create(null) };
for (const f of FN) {
    let any = false;
    for (const n of RNG_CORE) if (f.rng[n]) { inc(rng.core, n, f.rng[n]); any = true; }
    if (any) rng.coreFns++;
    if (f.rng.rn2_on_display_rng) { rng.display += f.rng.rn2_on_display_rng; rng.displayFns++; }
    for (const n of ['random', 'rand', 'nhl_rn2', 'nhl_random', 'srandom', 'srand']) if (f.rng[n]) inc(rng.otherPrng, `${n} @ ${f.name} (${f.file})`, f.rng[n]);
}

// ---------- records ----------
const unions = RECS.filter((r) => r.tag === 'union');
const bitfieldRecs = RECS.filter((r) => r.fields.some((x) => x.bits !== undefined));
const fnptrFields = RECS.flatMap((r) => r.fields.filter((x) => x.fnptr).map((x) => `${r.tag} ${r.name || '<anon>'}.${x.name}`));

// ---------- globals ----------
const defs = GLOBS.filter((g) => g.storage !== 'extern');
const globalsByGroup = { nethack: defs.filter((g) => groupOfFile(g.file) === 'nethack').length, lua: defs.filter((g) => groupOfFile(g.file) === 'lua').length };
const staticLocalsAll = FN.flatMap((f) => f.staticLocals.map((s) => ({ fn: f.name, file: f.file, ...s })));

// ---------- call graph ----------
const keyOf = (f) => (f.static ? `${f.file}::${f.name}` : f.name);
const byTuStatic = new Map();   // tu|name -> key (static fns visible in a TU, incl. header statics)
const globalDefs = new Map();
for (const f of FN) {
    if (f.static) byTuStatic.set(`${f.tu}|${f.name}`, keyOf(f));
    else if (!globalDefs.has(f.name)) globalDefs.set(f.name, keyOf(f));
}
// header static inline functions are visible in every TU that includes them
const headerStatics = new Map();
for (const f of FN) if (f.static && f.file.endsWith('.h')) headerStatics.set(f.name, keyOf(f));
const nodes = {};
for (const f of FN) {
    const calls = new Set(); const ext = new Set();
    for (const callee of Object.keys(f.calls)) {
        const k = byTuStatic.get(`${f.tu}|${callee}`) || headerStatics.get(callee) || globalDefs.get(callee);
        if (k) calls.add(k); else ext.add(callee);
    }
    nodes[keyOf(f)] = {
        name: f.name, file: f.file, line: f.line, endLine: f.endLine, static: !!f.static,
        ctype: f.ctype, calls: [...calls].sort(), ext: [...ext].sort(), icalls: f.icalls,
    };
}
writeFileSync(path.join(INV, 'callgraph.json'), JSON.stringify({ nodes, addrTaken }, null, 0));

// ---------- write summary ----------
const summary = {
    generated: 'transpiler/analysis/aggregate.mjs',
    translationUnits: { total: tus.length, nethack: tus.filter((t) => t.group === 'nethack').length, lua: tus.filter((t) => t.group === 'lua').length },
    lines: lineTable,
    functions: { nethack: fstats('nethack'), lua: fstats('lua') },
    globals: { definitions: globalsByGroup, staticLocals: staticLocalsAll.length },
    records: { total: RECS.length, structs: RECS.filter((r) => r.tag === 'struct').length, unions: unions.length,
        withBitfields: bitfieldRecs.length, bitfields: bitfieldRecs.reduce((a, r) => a + r.fields.filter((x) => x.bits !== undefined).length, 0),
        fnptrFields: fnptrFields.length },
    sites: Object.fromEntries(Object.entries(sitesBy).map(([p, e]) => [p, { nethack: e.nethack, lua: e.lua, inMacro: e.inMacro, topDetail: top(e.detail, 25), topFiles: top(e.files, 12) }])),
    libc: Object.fromEntries(Object.entries(libc).sort((a, b) => (b[1].nethack + b[1].lua) - (a[1].nethack + a[1].lua))
        .map(([n, e]) => [n, { kind: e.kind, nethack: e.nethack, lua: e.lua, files: [...e.callers].sort().slice(0, 8) }])),
    indirectCalls: top(icalls, 80),
    addrTakenFunctions: Object.keys(addrTaken).length,
    rng,
    unions: unions.map((u) => ({ name: u.name, file: u.file, line: u.line, fields: u.fields.map((x) => `${x.name}: ${x.type}`) })),
    bitfieldRecords: bitfieldRecs.map((r) => `${r.tag} ${r.name || '<anon>'} (${r.file}:${r.line}): ${r.fields.filter((x) => x.bits !== undefined).length}`),
    fnptrFields,
};
writeFileSync(path.join(INV, 'summary.json'), JSON.stringify(summary, null, 1));

// markdown
const md = [];
const tbl = (head, rows) => { md.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`); for (const r of rows) md.push(`| ${r.join(' | ')} |`); md.push(''); };
md.push('# Stage 1 inventory (generated by transpiler/analysis/aggregate.mjs)', '');
md.push('## Lines', '');
tbl(['Part', 'Files', 'Lines', 'Analysis'], lineTable.map((r) => [r.label, r.files, r.lines.toLocaleString('en-US'), r.how]));
md.push('## Functions', '');
const fsN = summary.functions.nethack, fsL = summary.functions.lua;
tbl(['Metric', 'NetHack', 'Lua'], Object.keys(fsN).map((k) => [k, fsN[k], fsL[k]]));
md.push('## Globals and records', '');
tbl(['Metric', 'Value'], [
    ['global variable definitions (NetHack / Lua)', `${globalsByGroup.nethack} / ${globalsByGroup.lua}`],
    ['static locals', staticLocalsAll.length],
    ['struct/union definitions (project)', `${summary.records.structs} / ${summary.records.unions}`],
    ['records with bit-fields / bit-fields', `${summary.records.withBitfields} / ${summary.records.bitfields}`],
    ['function-pointer fields', summary.records.fnptrFields],
    ['functions whose address is taken', summary.addrTakenFunctions],
]);
md.push('## Hard-pattern sites (unique file:line)', '');
tbl(['Pattern', 'NetHack', 'Lua', 'in macro', 'Top details'], Object.entries(sitesBy).sort((a, b) => (b[1].nethack + b[1].lua) - (a[1].nethack + a[1].lua))
    .map(([p, e]) => [p, e.nethack, e.lua, e.inMacro, top(e.detail, 6).map(([d, c]) => `${d.replace(/\|/g, '\\|')} (${c})`).join('; ')]));
md.push('## libc / system calls', '');
tbl(['Function', 'kind', 'NetHack sites', 'Lua sites', 'files'], Object.entries(summary.libc).map(([n, e]) => [n, e.kind, e.nethack, e.lua, e.files.join(' ')]));
md.push('## RNG call sites (direct calls)', '');
tbl(['Context', 'Sites', 'Functions'], [
    ['core: ' + Object.entries(rng.core).map(([n, c]) => `${n} ${c}`).join(', '), Object.values(rng.core).reduce((a, b) => a + b, 0), rng.coreFns],
    ['display: rn2_on_display_rng', rng.display, rng.displayFns],
]);
md.push('Other PRNG entry points: ' + (Object.keys(rng.otherPrng).length ? Object.entries(rng.otherPrng).map(([k, c]) => `${k} ×${c}`).join('; ') : 'none'), '');
md.push('## Indirect calls (callee expression)', '');
tbl(['Group  callee', 'Sites'], top(icalls, 40));
md.push('## Unions', '');
tbl(['Union', 'Where', 'Fields'], unions.map((u) => [u.name || '<anon>', `${u.file}:${u.line}`, u.fields.map((x) => `${x.name}: ${x.type}`).join('; ').replace(/\|/g, '\\|').slice(0, 200)]));
writeFileSync(path.join(INV, 'summary.md'), md.join('\n') + '\n');
console.log(`[ok] ${FN.length} functions, ${SITES.length} sites, ${RECS.length} records -> transpiler/out/inventory/summary.{json,md}, callgraph.json`);
