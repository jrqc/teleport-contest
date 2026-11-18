#!/usr/bin/env node
// run-inventory.mjs: run inventory-tu over every translation unit in
// transpiler/out/compile_commands.json; write one small JSON per TU to
// transpiler/out/inventory/tu/. Usage: node run-inventory.mjs [filter-substring]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadAst, ROOT } from '../frontend/ast.mjs';
import { inventoryTU } from './inventory-tu.mjs';

const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8'));
const filter = process.argv[2];
const todo = db.filter((e) => !filter || e.file.includes(filter));
const OUT = path.join(ROOT, 'transpiler/out/inventory/tu');
mkdirSync(OUT, { recursive: true });
const CONC = Number(process.env.INV_JOBS || 2);

let next = 0, failed = 0;
async function worker() {
    while (next < todo.length) {
        const e = todo[next++];
        const t0 = Date.now();
        try {
            const { root, stderr } = await loadAst(e);
            const inv = inventoryTU(root, e.file);
            inv.group = e.group;
            inv.clangWarnings = (stderr.match(/warning:/g) || []).length;
            const name = e.file.replace(/^tools\/recorder-env\/build\/nethack-c\/recorder\//, '').replace(/\//g, '__');
            writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(inv));
            console.log(`[ok] ${e.file.split('/').slice(-1)[0]} fns=${inv.functions.length} sites=${inv.sites.length} ${Date.now() - t0}ms`);
        } catch (err) {
            failed++;
            console.log(`[FAIL] ${e.file}: ${err.message.split('\n').slice(0, 3).join(' | ')}`);
        }
    }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`done: ${todo.length - failed}/${todo.length} ok`);
process.exit(failed ? 1 : 0);
