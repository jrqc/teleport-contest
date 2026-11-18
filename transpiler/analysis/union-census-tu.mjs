// union-census-tu.mjs: per-TU facts for the union punning check
// (transpiler-design.md 3.4, decision D1).
//
// For every member access on a union value: the union, the member's canonical
// type, the access kind and the storage class it touches. For every whole-union
// value copy: a directed flow edge between storage classes.
//
// Access kinds:
//   w     the member is the left side of `=` (also partial: u.rec.x = ...)
//   rw    `op=`, `++`, `--`
//   r     the member's value is read
//   addr  the member's address escapes (`&u.m`, or an array member decayed to a
//         pointer that is not just subscripted): counts as possible punning
//   init  written by an initializer (InitListExpr naming the member)
// Storage classes (strings):
//   g:<name> / g:<file>::<name>   global (static globals qualified by file)
//   l:<fn>::<name>@<line>         local variable (incl. function statics)
//   a:<fn>#<i>                    parameter i of function fn (callers flow into it)
//   r:<fn>                        return value of fn
//   f:<record>.<field>            a union-typed field, any object of that record
//   d:<union>                     anything reached through a pointer to the union
//   x:<kind>@<file>:<line>        other temporaries (compound literals, ...)
// Flows: [src, dst] means a whole-union value moves from src to dst. `&u` adds
// flows in both directions between u's class and d:<union> (aliasing).
import { nodePos, isSystemFile } from '../frontend/ast.mjs';
import { short } from './aggregate-lib.mjs';

let TYPEDEFS = new Map();
const canonCache = new Map();
function canon(t) {
    if (!t) return '';
    let c = canonCache.get(t);
    if (c !== undefined) return c;
    c = t;
    for (let i = 0; i < 12; i++) {
        const next = c.replace(/(\b(?:struct|union|enum)\s+)?\b([A-Za-z_]\w*)\b/g, (m, tag, id) => {
            if (tag) return m;
            const u = TYPEDEFS.get(id);
            return u === undefined ? m : u;
        });
        if (next === c) break;
        c = next;
    }
    // qualifiers do not change the stored representation
    c = c.replace(/\b(const|volatile|restrict|__restrict)\b/g, ' ').replace(/\s+/g, ' ')
        .replace(/\s*\*\s*/g, ' *').replace(/\*\s+\*/g, '**').trim();
    canonCache.set(t, c);
    return c;
}
const qt = (n) => (n && n.type) ? canon(n.type.desugaredQualType || n.type.qualType) : '';
const strip = (n) => {
    while (n && n.inner && (n.kind === 'ImplicitCastExpr' || n.kind === 'ParenExpr' || n.kind === 'CStyleCastExpr')) n = n.inner[0];
    return n;
};

export function unionCensusTU(root) {
    const out = { unions: Object.create(null), acc: [], flow: [], params: [] };
    const fieldOwner = new Map();     // FieldDecl id -> record key
    const recFields = new Map();      // record key -> [{name, type}]
    const anonKey = new Map();        // canonical "(unnamed ... at f:l:c)" type -> record key
    const declCls = new Map();        // VarDecl/ParmVarDecl id -> storage class
    const anc = [];
    let fn = null;

    const recKey = (n, pos) => `${n.tagUsed} ${n.name || `<anon@${short(pos.file)}:${pos.line}>`}`;
    // canonical record type -> record key ("union any", or the anon key)
    const recOfType = (t) => {
        if (!t) return null;
        if (anonKey.has(t)) return anonKey.get(t);
        const m = t.match(/^(struct|union) ([A-Za-z_]\w*)$/);
        return m ? `${m[1]} ${m[2]}` : null;
    };
    const unionOfType = (t) => { const k = recOfType(t); return k && k.startsWith('union ') && recFields.has(k) ? k : null; };
    const pointee = (t) => /\*$/.test(t) ? t.slice(0, -1).trim() : null;
    const here = (n) => {
        const p = nodePos(n) || (anc.length && nodePos(anc[anc.length - 1])) || {};
        return { file: p.file ? short(p.file) : '?', line: p.line || 0 };
    };

    // storage classes of a union-typed expression (an array: ?: yields two)
    function cls(e, u) {
        e = strip(e);
        if (!e) return [`x:?`];
        switch (e.kind) {
        case 'DeclRefExpr': {
            const r = e.referencedDecl;
            if (r && declCls.has(r.id)) return [declCls.get(r.id)];
            return [`g:${r ? r.name : '?'}`];
        }
        case 'MemberExpr': {
            const owner = fieldOwner.get(e.referencedMemberDecl);
            return [`f:${owner || '?'}.${e.name}`];
        }
        case 'ArraySubscriptExpr': {
            const b = e.inner && e.inner[0];
            const sb = strip(b);
            // a real array (decayed) keeps its storage; a pointer means "through a pointer"
            if (b && b.kind === 'ImplicitCastExpr' && b.castKind === 'ArrayToPointerDecay') return cls(sb, u);
            return [`d:${u}`];
        }
        case 'UnaryOperator':
            if (e.opcode === '*') return [`d:${u}`];
            break;
        case 'CallExpr': {
            const c = strip(e.inner && e.inner[0]);
            return [c && c.kind === 'DeclRefExpr' && c.referencedDecl ? `r:${c.referencedDecl.name}` : 'r:?'];
        }
        case 'ConditionalOperator':
            return [...cls(e.inner[1], u), ...cls(e.inner[2], u)];
        case 'BinaryOperator':
            if (e.opcode === ',') return cls(e.inner[1], u);
            if (e.opcode === '=') return cls(e.inner[0], u);
            break;
        default: break;
        }
        const h = here(e);
        return [`x:${e.kind}@${h.file}:${h.line}`];
    }

    function access(u, mtype, kind, classes, n) {
        const h = here(n);
        for (const c of classes) out.acc.push({ u, t: mtype, k: kind, c, file: h.file, line: h.line, fn: fn ? fn.name : null });
    }
    function flow(srcs, dsts, n) {
        const h = here(n);
        for (const s of srcs) for (const d of dsts) if (s !== d) out.flow.push([s, d, `${h.file}:${h.line}`]);
    }

    // classify the context of a union member access M (ancestors on `anc`)
    function accessKind(M) {
        let cur = M;
        for (let i = anc.length - 1; i >= 0; i--) {
            const p = anc[i];
            const first = p.inner && p.inner[0] === cur;
            if (p.kind === 'ParenExpr') { cur = p; continue; }
            if (p.kind === 'MemberExpr' && !p.isArrow && first) { cur = p; continue; }
            if (p.kind === 'ImplicitCastExpr' && p.castKind === 'ArrayToPointerDecay') {
                const g = anc[i - 1];
                if (g && g.kind === 'ArraySubscriptExpr' && g.inner[0] === p) { cur = g; i--; continue; }
                return 'addr';
            }
            if (p.kind === 'ImplicitCastExpr' && p.castKind === 'LValueToRValue') return 'r';
            if (p.kind === 'BinaryOperator' && p.opcode === '=' && first) return 'w';
            if (p.kind === 'CompoundAssignOperator' && first) return 'rw';
            if (p.kind === 'UnaryOperator') {
                if (p.opcode === '++' || p.opcode === '--') return 'rw';
                if (p.opcode === '&') return 'addr';
            }
            if (p.kind === 'UnaryExprOrTypeTraitExpr') return 'none';
            return 'r';
        }
        return 'r';
    }

    // initializer of a target class: union InitListExprs name the member they write
    function initWrites(init, target, n) {
        if (!init) return;
        const t = qt(init);
        const u = unionOfType(t);
        if (u) {
            if (init.kind === 'InitListExpr') {
                const f = init.field;
                const val = init.inner && init.inner[0];
                if (f && val && val.kind !== 'ImplicitValueInitExpr') {
                    access(u, canon(f.type && (f.type.desugaredQualType || f.type.qualType)), 'init', [target], init);
                }
            } else if (init.kind !== 'ImplicitValueInitExpr') {
                flow(cls(init, u), [target], init);
            }
            return;
        }
        if (init.kind !== 'InitListExpr') return;
        const rk = recOfType(t);
        if (rk && recFields.has(rk)) {
            const fields = recFields.get(rk);
            (init.inner || []).forEach((c, i) => {
                if (fields[i]) initWrites(c, `f:${rk}.${fields[i].name}`, n);
            });
        } else if (/\]$/.test(t)) {
            for (const c of init.inner || []) initWrites(c, target, n);   // array: same storage
        }
    }

    function visit(n, parent) {
        if (!n || typeof n !== 'object' || !n.kind) return;
        const pos = nodePos(n);
        const k = n.kind;
        if (k === 'RecordDecl' && n.completeDefinition && pos) {
            const key = recKey(n, pos);
            const fields = [];
            for (const c of n.inner || []) {
                if (c.kind === 'FieldDecl') {
                    fields.push({ name: c.name || '', type: qt(c) });
                    fieldOwner.set(c.id, key);
                }
            }
            recFields.set(key, fields);
            if (!n.name) {
                // the canonical type string clang uses for this anonymous record
                anonKey.set(`${n.tagUsed} (unnamed ${n.tagUsed} at ${pos.file}:${pos.line}:${pos.col})`, key);
                anonKey.set(`${n.tagUsed} (anonymous ${n.tagUsed} at ${pos.file}:${pos.line}:${pos.col})`, key);
            }
            if (n.tagUsed === 'union' && !isSystemFile(pos.file)) {
                out.unions[key] = { file: short(pos.file), line: pos.line, members: fields };
            }
        }
        if (k === 'FunctionDecl') {
            const body = n.inner && n.inner.find((c) => c.kind === 'CompoundStmt');
            let pi = 0;
            for (const c of n.inner || []) {
                if (c.kind === 'ParmVarDecl') {
                    declCls.set(c.id, `a:${n.name}#${pi}`);
                    if (unionOfType(qt(c))) out.params.push([n.name, pi, unionOfType(qt(c))]);
                    pi++;
                }
            }
            if (body) {
                const save = fn;
                fn = { name: n.name };
                anc.push(n);
                for (const c of n.inner || []) visit(c, n);
                anc.pop();
                fn = save;
                return;
            }
        }
        if (k === 'VarDecl') {
            let c;
            if (!fn) c = n.storageClass === 'static' && pos ? `g:${short(pos.file)}::${n.name}` : `g:${n.name}`;
            else c = `l:${fn.name}::${n.name}@${pos ? pos.line : 0}`;
            declCls.set(n.id, c);
            if (n.inner && n.inner.length) initWrites(n.inner[n.inner.length - 1], c, n);
        }

        if (k === 'MemberExpr') {
            const owner = fieldOwner.get(n.referencedMemberDecl);
            if (owner && owner.startsWith('union ')) {
                const kind = accessKind(n);
                if (kind !== 'none') {
                    const base = n.inner && n.inner[0];
                    const classes = n.isArrow ? [`d:${owner}`] : cls(base, owner);
                    access(owner, qt(n), kind, classes, n);
                }
            }
        } else if (k === 'BinaryOperator' && n.opcode === '=') {
            const u = unionOfType(qt(n.inner[0]));
            if (u) flow(cls(n.inner[1], u), cls(n.inner[0], u), n);
        } else if (k === 'UnaryOperator' && n.opcode === '&') {
            const o = n.inner && n.inner[0];
            const u = unionOfType(qt(strip(o)));
            if (u) { const cs = cls(o, u); flow(cs, [`d:${u}`], n); flow([`d:${u}`], cs, n); }
        } else if (k === 'ImplicitCastExpr' && n.castKind === 'ArrayToPointerDecay') {
            const et = qt(n.inner && n.inner[0]).replace(/\s*\[\d*\]$/, '');
            const u = unionOfType(et);
            const g = parent;
            if (u && !(g && g.kind === 'ArraySubscriptExpr' && g.inner[0] === n)) {
                const cs = cls(n.inner[0], u); flow(cs, [`d:${u}`], n); flow([`d:${u}`], cs, n);
            }
        } else if (k === 'CallExpr') {
            const c = strip(n.inner && n.inner[0]);
            const callee = c && c.kind === 'DeclRefExpr' && c.referencedDecl ? c.referencedDecl.name : '?';
            (n.inner || []).slice(1).forEach((a, i) => {
                const u = unionOfType(qt(a));
                if (u) flow(cls(a, u), [`a:${callee}#${i}`], a);
            });
        } else if (k === 'ReturnStmt' && fn && n.inner && n.inner[0]) {
            const u = unionOfType(qt(n.inner[0]));
            if (u) flow(cls(n.inner[0], u), [`r:${fn.name}`], n);
        } else if (k === 'CompoundLiteralExpr') {
            const h = here(n);
            initWrites(n.inner && n.inner[0], `x:CompoundLiteralExpr@${h.file}:${h.line}`, n);
        }

        anc.push(n);
        for (const c of n.inner || []) visit(c, n);
        anc.pop();
    }

    TYPEDEFS = new Map();
    canonCache.clear();
    for (const c of root.inner || []) {
        if (c.kind === 'TypedefDecl' && c.type) {
            const u = c.type.desugaredQualType || c.type.qualType;
            if (u && u !== c.name) TYPEDEFS.set(c.name, u);
        }
    }
    for (const c of root.inner || []) visit(c, root);
    return out;
}
