#!/usr/bin/env node
// heap.mjs: which struct/union types must live in the byte heap (CLAUDE.md 2.1,
// 2.2)? Evidence per type comes from the hard-pattern sites in the per-TU
// inventories; marks then propagate to a fixed point.
//
// Evidence (per record type T):
//   union      T is a union (type punning possible)
//   save-io    bwrite/mread/fread/fwrite of a whole T (save/bones files)
//   mem-raw    memcpy/memset/memcmp on T that is NOT a whole-object clear/copy
//   cast       pointer cast between T and an unrelated struct/union or char
//              (byte view); casts from void/long (allocation) are excluded
//   offsetof   offsetof(T, ...)
// Recorded but not heap evidence: obj-copy (memcpy/memset of a whole T or
// T[] to/from T or an untyped buffer: deep copy, array grow, snapshot).
// Casts inside sfo_*/sfi_* (save-file macros) count as save-io.
// Not evidence for the heap (handled by fat pointers {array, index}):
//   ptr-arith / ptr-diff / ptr-compare on T*
//
// Propagation:
//   contain    a record containing a heap type by value (field T or T[n]) is heap
//   pointer    a heap record with a field `U *` forces U into the heap (an
//              address stored in heap bytes must point into the heap)
// Scenarios:
//   S0  literal CLAUDE.md rule: all evidence, contain + pointer propagation
//   S1  as S0, but save-io handled by generated per-type serializers (save
//       files are only written and read by the JS port itself)
//   S2  as S1, but pointer fields inside heap records hold object handles
//       (propagation by containment only)
//   S3  as S2, and unions as shared-slot objects (no union evidence)
// Output: transpiler/out/inventory/heap.json and a printed summary.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';
import { short } from './aggregate-lib.mjs';

const INV = path.join(ROOT, 'transpiler/out/inventory');
const tus = readdirSync(path.join(INV, 'tu')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(INV, 'tu', f), 'utf8')));

// ---- record definitions (deduped), keyed "struct x" / "union u" ----
const recs = new Map();
for (const tu of tus) for (const r of tu.records) {
    const key = r.name ? `${r.tag} ${r.name}` : `${r.tag} <anon@${short(r.file)}:${r.line}>`;
    if (!recs.has(key)) recs.set(key, { ...r, file: short(r.file), key, group: short(r.file).startsWith('lib/lua') ? 'lua' : 'nethack' });
}
const recKeyFromType = (t) => {
    const m = t && t.match(/\b(struct|union)\s+([A-Za-z_]\w*)/);
    return m ? `${m[1]} ${m[2]}` : null;
};

// ---- evidence ----
const ev = new Map();   // key -> {kind -> [site...]}
const addEv = (key, kind, s) => {
    if (!key || !recs.has(key)) return;
    if (!ev.has(key)) ev.set(key, {});
    const e = ev.get(key);
    (e[kind] || (e[kind] = [])).push(`${short(s.file)}:${s.line} ${s.fn || ''} ${s.d}`);
};
const seen = new Set();
for (const tu of tus) for (const s of tu.sites) {
    const id = `${s.p}|${s.file}:${s.line}|${s.d}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (s.p === 'io') {
        const k = recKeyFromType(s.d.replace(/;.*$/, ''));
        if (k) addEv(k, 'save-io', s);
    } else if (s.p === 'mem') {
        if (/ partial$/.test(s.d)) {
            const ts = s.d.replace(/^\w+\(/, '').replace(/;.*$/, '').split(',').map((x) => x.trim());
            const ks = ts.map(recKeyFromType).filter(Boolean);
            const others = ts.filter((t) => !recKeyFromType(t));
            // copy/clear of T (or T[]) to/from T or an untyped buffer: a
            // (deep) object copy, an array grow, or a snapshot; expressible
            // in the object model -> recorded, but not heap evidence
            const sameType = ks.length && ks.every((k) => k === ks[0]) && others.every((t) => /^void/.test(t));
            for (const k of ks) addEv(k, sameType ? 'obj-copy' : 'mem-raw', s);
        }
    } else if ((s.p === 'ptr-cast' || s.p === 'ptr-cast-implicit') && /^sf[oi]_/.test(s.fn || '')) {
        // save-file macros (sfmacros.h, sfbase.c): struct -> char* for bwrite/mread
        const [a, b] = s.d.split(' -> ').map((x) => x.trim());
        addEv(recKeyFromType(a) || recKeyFromType(b), 'save-io', s);
    } else if (s.p === 'ptr-cast' || s.p === 'ptr-cast-implicit') {
        const [a, b] = s.d.split(' -> ').map((x) => x.trim());
        const ka = recKeyFromType(a), kb = recKeyFromType(b);
        const isAllocSrc = (x) => x === 'void' || x === 'long';
        if (ka && kb && ka !== kb) { addEv(ka, 'cast', s); addEv(kb, 'cast', s); }
        else if (ka && !kb && /char/.test(b)) addEv(ka, 'cast', s);            // struct -> byte view
        else if (kb && !ka && /char/.test(a)) addEv(kb, 'cast', s);            // bytes -> struct
        else if (kb && !ka && !isAllocSrc(a) && a !== 'void') addEv(kb, 'cast', s);
    } else if (s.p === 'offsetof') {
        addEv(recKeyFromType(s.d), 'offsetof', s);
    }
}
for (const [k, r] of recs) if (r.tag === 'union') addEv(k, 'union', { file: r.file, line: r.line, d: 'union definition' });

// ---- propagation ----
function containedTypes(r) {
    const out = [];
    for (const f of r.fields) {
        const t = f.type || '';
        if (/\*/.test(t) || /\(\*/.test(t)) continue;
        const k = recKeyFromType(t);
        if (k) out.push(k);
    }
    return out;
}
function pointerTypes(r) {
    const out = [];
    for (const f of r.fields) {
        const t = f.type || '';
        if (!/\*/.test(t) || /\(\*/.test(t)) continue;
        const k = recKeyFromType(t);
        if (k) out.push(k);
    }
    return out;
}
// anonymous records nested in a parent: the parent contains them by value; the
// field type string names them "struct (unnamed struct at file:line:col)".
function scenario(kinds, { pointer }) {
    const heap = new Map();   // key -> reason
    for (const [k, e] of ev) for (const kind of kinds) if (e[kind]) { if (!heap.has(k)) heap.set(k, kind); }
    let changed = true;
    while (changed) {
        changed = false;
        for (const [k, r] of recs) {
            if (heap.has(k)) {
                if (pointer) for (const p of pointerTypes(r)) if (!heap.has(p) && recs.has(p)) { heap.set(p, `pointed-to by ${k}`); changed = true; }
                continue;
            }
            for (const c of containedTypes(r)) if (heap.has(c)) { heap.set(k, `contains ${c}`); changed = true; break; }
        }
    }
    const count = (g) => [...heap.keys()].filter((k) => recs.get(k).group === g).length;
    return { size: heap.size, nethack: count('nethack'), lua: count('lua'), types: Object.fromEntries([...heap].sort()) };
}

const ALL = ['union', 'save-io', 'mem-raw', 'cast', 'offsetof'];
const res = {
    records: { total: recs.size, nethack: [...recs.values()].filter((r) => r.group === 'nethack').length, lua: [...recs.values()].filter((r) => r.group === 'lua').length },
    evidence: Object.fromEntries([...ev].sort().map(([k, e]) => [k, Object.fromEntries(Object.entries(e).map(([kk, v]) => [kk, v.length > 6 ? [...v.slice(0, 6), `... ${v.length} total`] : v]))])),
    S0: scenario(ALL, { pointer: true }),
    S1: scenario(ALL.filter((x) => x !== 'save-io'), { pointer: true }),
    S2: scenario(ALL.filter((x) => x !== 'save-io'), { pointer: false }),
    // S3: as S2, and unions represented as a shared-slot object (see design)
    S3: scenario(ALL.filter((x) => x !== 'save-io' && x !== 'union'), { pointer: false }),
};
writeFileSync(path.join(INV, 'heap.json'), JSON.stringify(res, null, 1));
console.log(`records: ${res.records.total} (nethack ${res.records.nethack}, lua ${res.records.lua})`);
const evc = {};
for (const e of ev.values()) for (const k of Object.keys(e)) evc[k] = (evc[k] || 0) + 1;
console.log('types with evidence, by kind:', evc);
for (const s of ['S0', 'S1', 'S2', 'S3']) console.log(`${s}: heap=${res[s].size} (nethack ${res[s].nethack}, lua ${res[s].lua})`);
