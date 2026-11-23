// tools/tablecheck-helper.mjs: imported by a NH_TABLE_CHECK transpile (tools/tablecheck.mjs).
// Each converted table is built with the per-element assignments, snapshotted, zeroed,
// rebuilt from the literal (readability plan P2c) and compared field by field.
import { peq } from '../js/crt/index.js';

export const checked = [];
const isRec = (x) => x !== null && typeof x === 'object' && typeof x.constructor.$fields === 'function';
function snap(v, spec) {
    if (spec && typeof spec === 'object' && spec.rec) return snapRec(v);
    if (spec && typeof spec === 'object' && spec.arr) return Array.from(v, (e) => snap(e, spec.arr));
    if (spec === undefined) {   // top level, or a type $fields does not describe
        if (isRec(v)) return snapRec(v);
        if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, (e) => snap(e, undefined));
    }
    return { ref: v };   // a scalar, or a pointer (compared with peq)
}
function snapRec(r) {
    const o = {};
    for (const [name, , spec] of r.constructor.$fields()) o[name] = snap(r[name], spec);
    return o;
}
export const snapshot = (x) => snap(x, undefined);
function same(a, b, where, out) {
    if (a && 'ref' in a) {
        const x = a.ref, y = b && b.ref;
        const eq = (typeof x === 'object' && x !== null) || (typeof y === 'object' && y !== null) ? peq(x, y) : Object.is(x, y);
        if (!eq) out.push(`${where}: ${String(x)} vs ${String(y)}`);
        return;
    }
    if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) { out.push(`${where}: length`); return; } a.forEach((e, i) => same(e, b[i], `${where}[${i}]`, out)); return; }
    for (const k of Object.keys(a)) same(a[k], b[k], `${where}.${k}`, out);
}
export function compare(name, a, b) {
    const out = [];
    same(a, b, name, out);
    checked.push(name);
    if (out.length) throw new Error(`table check failed: ${out.slice(0, 5).join('; ')}${out.length > 5 ? ` (+${out.length - 5})` : ''}`);
}
