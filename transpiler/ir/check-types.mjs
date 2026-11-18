#!/usr/bin/env node
// check-types.mjs: parse and resolve every type string in every TU (M1 gate).
// Usage: node transpiler/ir/check-types.mjs [tu-basename ...]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAst, ROOT } from '../frontend/ast.mjs';
import { tuScope } from './scope.mjs';

const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8'));
const want = process.argv.slice(2);
const tus = want.length ? db.filter((e) => want.includes(path.basename(e.file))) : db;
let total = 0;
const fails = new Map();
for (const e of tus) {
    const { root } = await loadAst(e);
    const scope = tuScope(root, e.directory);
    const seen = new Set();
    const walk = (n) => {
        for (const t of [n.type, n.argType]) {
            if (!t) continue;
            for (const s of [t.qualType, t.desugaredQualType]) {
                if (!s || seen.has(s)) continue;
                seen.add(s);
                total++;
                try {
                    const ty = scope.type(s);
                    // layout of complete object types must be computable
                    if (ty.k === 'rec' && scope.records.has(ty.key)) scope.layoutOf(ty);
                } catch (err) {
                    const k = err.message.replace(/ in ".*$/, '');
                    if (!fails.has(k)) fails.set(k, `${path.basename(e.file)}: ${s}: ${err.message}`);
                }
            }
        }
        for (const c of n.inner || []) walk(c);
    };
    walk(root);
    process.stderr.write('.');
}
process.stderr.write('\n');
console.log(`${tus.length} TUs, ${total} distinct type strings (per TU), ${fails.size} distinct failures`);
for (const v of [...fails.values()].slice(0, 40)) console.log('  ' + v);
process.exitCode = fails.size ? 1 : 0;
