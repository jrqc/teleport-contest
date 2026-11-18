#!/usr/bin/env node
// macros.mjs: inventory #define macros in project sources (NetHack include/,
// src/, win/tty, sys/{unix,share} and Lua src), classified by what the body
// expands to. Output: transpiler/out/inventory/macros.json (+ printed summary).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';

const T = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder');
const dirs = ['include', 'src', 'win/tty', 'sys/unix', 'sys/share', 'lib/lua-5.4.8/src'];
const out = [];
for (const d of dirs) {
    for (const f of readdirSync(path.join(T, d)).filter((x) => /\.[ch]$/.test(x))) {
        const text = readFileSync(path.join(T, d, f), 'utf8').replace(/\\\r?\n/g, ' ');
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)$/);
            if (!m) continue;
            const body = m[3].replace(/\/\*.*?\*\//g, '').replace(/\/\*.*$/, '').replace(/\/\/.*$/, '').trim();
            let kind;
            if (!body) kind = 'empty';
            else if (/^do\s*\{/.test(body) || /\bwhile\s*\(\s*0\s*\)\s*$/.test(body)) kind = 'stmt:do-while';
            else if (/^\{/.test(body)) kind = 'stmt:block';
            else if (/(^|[^=!<>])\b(if|for|while|switch|return|goto|break|continue)\b/.test(body) && !/^\(/.test(body)) kind = 'stmt:control';
            else if (/;/.test(body)) kind = 'stmt:semicolon';
            else if (/^(static|extern|struct|union|enum|typedef|const|unsigned|int|char|long|short|void|boolean|xint\d+|schar|uchar)\b/.test(body) && !m[2]) kind = 'decl/type';
            else if (/^-?(0x[0-9a-f]+|\d+)[lLuU]*$/i.test(body) || /^'.*'$/.test(body) || /^".*"$/.test(body)) kind = 'constant';
            else kind = m[2] ? 'expr:function-like' : 'expr:object-like';
            out.push({ name: m[1], fnlike: !!m[2], kind, file: path.join(d, f), group: d.startsWith('lib') ? 'lua' : 'nethack', body: body.slice(0, 160) });
        }
    }
}
writeFileSync(path.join(ROOT, 'transpiler/out/inventory/macros.json'), JSON.stringify(out, null, 0));
const c = {};
for (const x of out) { const k = `${x.group} ${x.kind}`; c[k] = (c[k] || 0) + 1; }
console.log(`${out.length} #defines`); for (const [k, v] of Object.entries(c).sort()) console.log(`  ${k}: ${v}`);
for (const k of ['stmt:do-while', 'stmt:block', 'stmt:control', 'stmt:semicolon', 'decl/type'])
    console.log(`\n${k} (nethack) e.g.:`, out.filter((x) => x.kind === k && x.group === 'nethack').slice(0, 6).map((x) => `${x.name} [${x.file}] ${x.body.slice(0, 70)}`).join('\n   '));
