#!/usr/bin/env node
// async.mjs: compute the async set (CLAUDE.md 2.5) from callgraph.json.
//
// A function must be `async` in JS if it can transitively reach a blocking
// root. Roots:
//   input  tty_nhgetch: the only key read that captures a screen
//          (nomux_capture_write_input_boundary); every step boundary.
//   anim   tty_delay_output: animation-frame capture (supplemental Anim%).
// Calls through function pointers are resolved conservatively by type: an
// indirect call `desc|T` may reach every address-taken function whose
// canonical type is T. Output: transpiler/out/inventory/async.json + summary.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';

const INV = path.join(ROOT, 'transpiler/out/inventory');
const { nodes, addrTaken } = JSON.parse(readFileSync(path.join(INV, 'callgraph.json'), 'utf8'));
// Qualifiers are ignored when matching pointer types to targets (coarser
// matching only adds targets: conservative); "* *" and "**" are the same type.
const norm = (t) => (t || '').replace(/\b(const|volatile|restrict|__restrict)\b/g, ' ')
    .replace(/\s+/g, ' ').replace(/\*\s+(?=\*)/g, '*').replace(/\( /g, '(').replace(/ \)/g, ')')
    .replace(/ ,/g, ',').trim();

// address-taken definitions grouped by canonical function type
const byType = new Map();
for (const [k, n] of Object.entries(nodes)) {
    if (!Object.hasOwn(addrTaken, n.name)) continue;
    const t = norm(n.ctype);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(k);
}

// forward edges: direct + indirect (type-based)
const fwd = new Map();
const unresolved = {};
for (const [k, n] of Object.entries(nodes)) {
    const e = new Set(n.calls);
    for (const key of Object.keys(n.icalls)) {
        const t = norm(key.split('|')[1]);
        const targets = byType.get(t) || [];
        if (!targets.length) unresolved[key] = (unresolved[key] || 0) + n.icalls[key];
        for (const x of targets) e.add(`@${x}`);   // mark as indirect edge
    }
    fwd.set(k, e);
}
const rev = new Map();
for (const [k, es] of fwd) for (const e of es) {
    const t = e.startsWith('@') ? e.slice(1) : e;
    if (!rev.has(t)) rev.set(t, []);
    rev.get(t).push({ from: k, indirect: e.startsWith('@') });
}

// Experiment only (not a decision): edges into these error-only paths, to
// measure how much of the async set exists only because of them.
const ERROR_PATHS = ['panic', 'nh_compress', 'nh_uncompress', 'win/tty/wintty.c::winch_handler', 'src/nhlua.c::nhl_panic'];
function reach(roots, { directOnly = false, cut = [] } = {}) {
    const seen = new Map();   // fn -> {via, indirect}
    const q = [];
    for (const r of roots) if (nodes[r]) { seen.set(r, { via: null }); q.push(r); }
    while (q.length) {
        const x = q.shift();
        for (const { from, indirect } of rev.get(x) || []) {
            if (directOnly && indirect) continue;
            if (cut.includes(x)) continue;
            if (!seen.has(from)) { seen.set(from, { via: x, indirect }); q.push(from); }
        }
    }
    return seen;
}

const total = Object.keys(nodes).length;
const res = {};
for (const [label, roots] of Object.entries({ input: ['tty_nhgetch'], anim: ['tty_delay_output'], both: ['tty_nhgetch', 'tty_delay_output'] })) {
    const all = reach(roots);
    const direct = reach(roots, { directOnly: true });
    const byFile = {};
    for (const k of all.keys()) { const f = nodes[k].file; byFile[f] = (byFile[f] || 0) + 1; }
    res[label] = {
        roots, size: all.size, directOnlySize: direct.size,
        withoutErrorPaths: reach(roots, { cut: ERROR_PATHS }).size,
        lua: [...all.keys()].filter((k) => nodes[k].file.startsWith('lib/lua')).length,
        byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1])),
        members: [...all.keys()].sort(),
    };
}
// why are Lua functions in the set? show one chain each
const chain = (seen, k) => { const c = [k]; let x = k; for (let i = 0; i < 40 && seen.get(x) && seen.get(x).via; i++) { x = seen.get(x).via; c.push(x); } return c; };
const inputSeen = reach(['tty_nhgetch']);
const luaExamples = [...inputSeen.keys()].filter((k) => nodes[k].file.startsWith('lib/lua')).slice(0, 5).map((k) => chain(inputSeen, k).join(' -> '));
const examples = ['moveloop', 'rn2', 'mklev', 'makemon', 'dosearch0', 'pline', 'yn_function', 'getpos', 'display_nhwindow', 'docrt']
    .map((n) => `${n}: ${inputSeen.has(n) ? 'async via ' + chain(inputSeen, n).slice(0, 8).join(' -> ') : 'sync'}`);
writeFileSync(path.join(INV, 'async.json'), JSON.stringify({ total, ...res, unresolvedIndirect: unresolved, luaExamples, examples }, null, 1));
console.log(`functions: ${total}`);
for (const [l, r] of Object.entries(res)) console.log(`${l}: async=${r.size} (${(100 * r.size / total).toFixed(1)}%), direct-edges-only=${r.directOnlySize}, without-error-paths=${r.withoutErrorPaths}, lua=${r.lua}`);
console.log('unresolved indirect call sites:', Object.values(unresolved).reduce((a, b) => a + b, 0), Object.keys(unresolved).slice(0, 10));
console.log(examples.join('\n'));
console.log('lua chains:', luaExamples.join('\n  '));
