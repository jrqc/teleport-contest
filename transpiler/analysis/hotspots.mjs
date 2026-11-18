#!/usr/bin/env node
// hotspots.mjs: group hard-pattern sites by file, excluding ordinary string
// handling (char* arithmetic/compare, char<->void casts) and benign forms
// (sizeof in allocation/formatting, whole-object mem ops). Output:
// transpiler/out/inventory/hotspots.json + printed table.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';
import { short } from './aggregate-lib.mjs';

const INV = path.join(ROOT, 'transpiler/out/inventory');
const seen = new Set();
const byFile = {};
for (const f of readdirSync(path.join(INV, 'tu')).filter((x) => x.endsWith('.json'))) {
    const tu = JSON.parse(readFileSync(path.join(INV, 'tu', f), 'utf8'));
    for (const s of tu.sites) {
        const file = short(s.file);
        const id = `${s.p}|${file}:${s.line}|${s.d}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const d = String(s.d || '');
        let cls = null;
        switch (s.p) {
        case 'union-access': cls = `union ${d.replace(/^union /, '').split('.')[0]}`; break;
        case 'ptr-cast': case 'ptr-cast-implicit':
            if (/^(char|void|long) -> (char|void)$/.test(d) || /^(void|long) -> /.test(d) || / -> void$/.test(d)) break;
            cls = `cast ${d}`; break;
        case 'mem': if (/ whole-/.test(d)) break; cls = `mem ${d.replace(/;.*$/, ')')}`; break;
        case 'io': if (/^\w+\((char|unsigned char|signed char|short|int|long|unsigned \w+|char\[\d+\]|long long)\b/.test(d)) { cls = 'io scalar'; break; } cls = `io ${d.replace(/;.*$/, ')')}`; break;
        case 'ptr-arith': case 'ptr-incdec': case 'ptr-diff': case 'ptr-compare':
            if (/^(const )?(unsigned |signed )?char\b/.test(d)) break;
            cls = `${s.p} ${d.replace(/ (\+|-|\+=|-=|\+\+|--|<|>|<=|>=) .*/, '').replace(/ (\+\+|--)$/, '')}`; break;
        case 'int-to-ptr': case 'ptr-to-int': case 'setjmp': case 'offsetof': case 'indirect-goto': case 'va_arg':
            cls = `${s.p} ${d}`; break;
        default: break;
        }
        if (!cls) continue;
        const e = byFile[file] || (byFile[file] = { total: 0, classes: {} });
        e.total++;
        e.classes[cls] = (e.classes[cls] || 0) + 1;
    }
}
const rows = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total);
writeFileSync(path.join(INV, 'hotspots.json'), JSON.stringify(Object.fromEntries(rows), null, 1));
for (const [f, e] of rows.slice(0, Number(process.argv[2] || 45))) {
    console.log(`${String(e.total).padStart(4)}  ${f}  ` + Object.entries(e.classes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} ×${n}`).join('; '));
}
console.log('files with sites:', rows.length, 'sites:', rows.reduce((a, [, e]) => a + e.total, 0),
    ' nethack:', rows.filter(([f]) => !f.startsWith('lib/')).reduce((a, [, e]) => a + e.total, 0));
