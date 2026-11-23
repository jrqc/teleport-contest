// Where do string literals go in object-world NetHack code? (analysis for the string-literal step; writes transpiler/out/litflow.txt)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadAst, ROOT } from '../../transpiler/frontend/ast.mjs';
import { parseJsonc } from '../../transpiler/annotations/jsonc.mjs';

const ann = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
const externFiles = Object.values(ann.groups || {}).filter((g) => g.repr === 'extern').map((g) => g.files);
const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8'))
    .filter((e) => e.group === 'nethack' && !externFiles.some((f) => e.file.endsWith(f)));
const crt = new Set(Object.keys(await import('../../js/crt/index.js')));
const kids = (n) => n.inner || [];
const SKIP = new Set(['ImplicitCastExpr', 'ParenExpr', 'CStyleCastExpr']);
const count = new Map(), callees = new Map(), params = new Map();
const add = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
const fnDecls = new Map();   // name -> params count, variadic
let total = 0;
for (const e of db) {
    const { root } = await loadAst(e);
    const file = path.relative(ROOT, path.resolve(ROOT, e.file));
    for (const d of kids(root)) if (d.kind === 'FunctionDecl') fnDecls.set(d.name, { n: kids(d).filter((c) => c.kind === 'ParmVarDecl').length, variadic: /\.\.\.\)/.test(d.type.qualType), params: kids(d).filter((c) => c.kind === 'ParmVarDecl').map((p) => p.name) });
    const stack = [];
    const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.kind === 'StringLiteral') {
            total++;
            // the consumer: the first ancestor that is not a cast or a paren
            let i = stack.length - 1, child = n, via = '';
            while (i >= 0 && (SKIP.has(stack[i].kind) || stack[i].kind === 'ConditionalOperator')) { if (stack[i].kind === 'ConditionalOperator') via = ' (via ?:)'; child = stack[i]; i--; }
            const p = stack[i];
            let k = p ? p.kind : 'top';
            if (p && p.kind === 'CallExpr') {
                const ks = kids(p);
                let c = ks[0]; while (c && SKIP.has(c.kind)) c = kids(c)[0];
                const name = c && c.kind === 'DeclRefExpr' && c.referencedDecl ? c.referencedDecl.name : null;
                const plain = name && name.replace(/^__builtin___(\w+)_chk$/, '$1');
                const argi = ks.indexOf(child) - 1;
                if (!name) k = 'call: indirect';
                else if (crt.has(plain)) k = `call: runtime`;
                else { k = 'call: generated'; add(callees, name); add(params, `${name}#${argi}`); }
            } else if (p && p.kind === 'BinaryOperator') k = `binop ${p.opcode}`;
            else if (p && p.kind === 'UnaryOperator') k = `unary ${p.opcode}`;
            count.set(k + via, (count.get(k + via) || 0) + 1);
        }
        stack.push(n);
        for (const c of kids(n)) visit(c);
        stack.pop();
    };
    for (const d of kids(root)) { const l = d.loc && (d.loc.expansionLoc || d.loc); if (l && l._f === file) visit(d); }
    process.stderr.write('.');
}
const out = [`total ${total}`, ...[...count].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}\t${k}`), '', 'top generated callees:', ...[...callees].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v}\t${k} ${JSON.stringify(fnDecls.get(k) || {})}`)];
writeFileSync(path.join(ROOT, 'transpiler/out/litflow.txt'), out.join('\n') + '\n');
console.log(out.slice(0, 30).join('\n'));
