// inventory-tu.mjs: extract a compact inventory from one translation unit.
//
// Count maps use Object.create(null): C names such as `constructor`
// (lparser.c) would otherwise hit Object.prototype.
//
// Input: a resolved clang AST (frontend/ast.mjs). Output: a small JSON object
// with everything Stage 1 needs, restricted to project files (system headers
// are only used to classify calls as libc):
//   functions  definitions with line range, storage, variadic, goto/label,
//              static locals, direct calls, indirect calls, RNG calls
//   globals    file-scope variables defined/declared in project files
//   records    struct/union definitions with fields (type, bit-field width)
//   sites      hard-pattern sites (CLAUDE.md 2.2), each {p, file, line, fn, d}
//   fnDecls    every function name seen, with whether it is declared only in
//              system headers (libc/system) or in the project
//   addrTaken  functions whose address is taken (function-pointer targets)
import { nodePos, inMacro, isSystemFile } from '../frontend/ast.mjs';

const RNG_FUNCS = new Set(['rn2', 'rnd', 'rn1', 'rnl', 'rne', 'rnz', 'd',
    'rn2_on_display_rng', 'nhl_rn2', 'nhl_random', 'random', 'rand', 'srandom', 'srand']);
const MEM_FUNCS = new Set(['memcpy', 'memmove', 'memset', 'memcmp', 'bcopy', 'bzero',
    '__builtin___memcpy_chk', '__builtin___memmove_chk', '__builtin___memset_chk',
    '__builtin_memcpy', '__builtin_memmove', '__builtin_memset', '__builtin_memcmp']);
const IO_FUNCS = new Set(['fread', 'fwrite', 'read', 'write', 'bwrite', 'mread', 'dlb_fread']);
const JMP_FUNCS = new Set(['setjmp', 'longjmp', '_setjmp', '_longjmp', 'sigsetjmp', 'siglongjmp']);
const ALLOC_FUNCS = new Set(['alloc', 'malloc', 'calloc', 'realloc', 're_alloc', 'nhalloc',
    'dupstr', 'luaM_malloc_', 'luaM_realloc_']);

// Canonical type strings: clang only desugars a typedef at the top level
// ("NhRect" -> "struct nhrect", but not "NhRect *"), so typedef names are
// expanded textually using the TU's TypedefDecls (set per TU in inventoryTU).
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
    canonCache.set(t, c);
    return c;
}
const qt = (n) => (n && n.type) ? canon(n.type.qualType) : '';
const isPtr = (t) => /\*\s*(const\s*|volatile\s*|restrict\s*|__restrict\s*)*$/.test(t);
const pointee = (t) => t.replace(/\*\s*(const\s*|volatile\s*|restrict\s*|__restrict\s*)*$/, '').trim()
    .replace(/^(const|volatile)\s+/, '').replace(/\s+(const|volatile)$/, '');
const isFnPtr = (t) => /\(\*\s*\w*\s*\)\s*\(/.test(t) || /\(\*const\)\s*\(/.test(t);
// strip implicit AND explicit casts, parens and a leading '&': the original
// object behind (genericptr_t) &x
const deep = (n) => {
    while (n && n.inner && (n.kind === 'ImplicitCastExpr' || n.kind === 'ParenExpr' || n.kind === 'CStyleCastExpr')) n = n.inner[0];
    return n;
};
const objType = (n) => {
    const d = deep(n);
    if (!d) return '?';
    if (d.kind === 'UnaryOperator' && d.opcode === '&') return qt(d.inner && d.inner[0]);   // &x -> type of x
    const t = qt(d);
    return isPtr(t) ? pointee(t) : (/\[\d*\]$/.test(t) ? t : `${t}(value)`);
};
const sizeofArg = (n) => {
    const d = deep(n);
    if (d && d.kind === 'UnaryExprOrTypeTraitExpr' && d.name === 'sizeof') {
        return d.argType ? canon(d.argType.qualType) : qt(deep(d.inner && d.inner[0]));
    }
    return d && d.kind === 'IntegerLiteral' ? `lit:${d.value}` : `expr:${d ? d.kind : '?'}`;
};
const strip = (n) => {
    while (n && (n.kind === 'ImplicitCastExpr' || n.kind === 'ParenExpr') && n.inner) n = n.inner[0];
    return n;
};

function classifyPtrType(t) {
    const p = pointee(t);
    if (/^void$/.test(p)) return 'void';
    if (/^(unsigned |signed )?char$/.test(p)) return 'char';
    if (/^(struct|union) /.test(p)) return p;
    if (isPtr(p)) return 'ptr';
    if (/\(/.test(p)) return 'fn';
    return p;
}

export function inventoryTU(root, tuFile) {
    const out = {
        tu: tuFile, functions: [], globals: [], records: [], sites: [],
        fnDecls: Object.create(null), addrTaken: Object.create(null),
    };
    const fieldOwner = new Map();     // FieldDecl id -> "union u" / "struct s"
    const recordById = new Map();     // RecordDecl id -> record descriptor
    let fn = null;                    // current function descriptor
    const anc = [];                   // ancestor stack (nodes)

    const site = (p, n, d) => {
        const pos = nodePos(n) || (anc.length && nodePos(anc[anc.length - 1])) || {};
        if (isSystemFile(pos.file)) return;
        out.sites.push({ p, file: pos.file, line: pos.line, fn: fn ? fn.name : null, d, m: inMacro(n) || undefined });
    };
    const enclosingCallee = () => {
        for (let i = anc.length - 1; i >= 0 && i >= anc.length - 6; i--) {
            const a = anc[i];
            if (a.kind === 'CallExpr') {
                const c = strip(a.inner && a.inner[0]);
                if (c && c.kind === 'DeclRefExpr' && c.referencedDecl) return c.referencedDecl.name;
                return '(indirect)';
            }
        }
        return null;
    };

    function visit(n, parent) {
        if (!n || typeof n !== 'object' || !n.kind) return;
        const pos = nodePos(n);
        const sys = pos ? isSystemFile(pos.file) : false;
        const k = n.kind;

        // ---- declarations ----
        if (k === 'FunctionDecl') {
            const name = n.name;
            const d = out.fnDecls[name] || (out.fnDecls[name] = { sys: true, proj: false });
            if (pos && !isSystemFile(pos.file)) { d.proj = true; d.sys = false; }
            if (n.isImplicit && !d.proj) d.builtin = true;
            const body = n.inner && n.inner.find((c) => c.kind === 'CompoundStmt');
            if (body && pos && !sys) {
                const end = n.range && n.range.end && (n.range.end.expansionLoc || n.range.end);
                fn = {
                    name, file: pos.file, line: pos.line, endLine: end ? end._l : null,
                    static: n.storageClass === 'static' || undefined,
                    inline: n.inline || undefined,
                    variadic: n.variadic || /\.\.\.\)$/.test(n.type && n.type.qualType) || undefined,
                    type: n.type && n.type.qualType,
                    ctype: canon(n.type && n.type.qualType).replace(/\s+/g, ' ').trim(),
                    calls: Object.create(null), icalls: Object.create(null), rng: Object.create(null), gotos: 0, labels: 0, staticLocals: [],
                    switches: 0, returnsStruct: undefined,
                };
                const rt = (n.type && n.type.qualType || '').split('(')[0].trim();
                if (/^(struct|union) /.test(rt) && !isPtr(rt)) fn.returnsStruct = rt;
                out.functions.push(fn);
                anc.push(n);
                for (const c of n.inner || []) visit(c, n);
                anc.pop();
                fn = null;
                return;
            }
        } else if (k === 'RecordDecl' && n.completeDefinition && pos && !sys) {
            const rec = {
                tag: n.tagUsed, name: n.name || null, file: pos.file, line: pos.line,
                fields: [], anon: !n.name || undefined,
            };
            recordById.set(n.id, rec);
            out.records.push(rec);
            for (const c of n.inner || []) {
                if (c.kind === 'FieldDecl') {
                    const f = { name: c.name || null, type: qt(c) };
                    if (c.isBitfield) {
                        const w = c.inner && c.inner[0];
                        f.bits = w && w.value !== undefined ? Number(w.value)
                            : (w && w.inner && w.inner[0] && w.inner[0].value !== undefined ? Number(w.inner[0].value) : '?');
                    }
                    if (isFnPtr(f.type)) f.fnptr = true;
                    rec.fields.push(f);
                    fieldOwner.set(c.id, `${n.tagUsed} ${n.name || `<anon@${pos.file}:${pos.line}>`}`);
                } else if (c.kind === 'RecordDecl' && c.completeDefinition) {
                    // nested definition: visited below as its own record
                }
            }
            if (n.tagUsed === 'union') site('union-def', n, rec.name || `<anon@${pos.line}>`);
        } else if (k === 'VarDecl' && pos && !sys) {
            const t = qt(n);
            if (!fn) {
                out.globals.push({
                    name: n.name, file: pos.file, line: pos.line, type: t,
                    storage: n.storageClass || undefined, init: !!(n.inner && n.inner.length) || undefined,
                    fnptr: isFnPtr(t) || undefined,
                });
            } else if (n.storageClass === 'static') {
                fn.staticLocals.push({ name: n.name, type: t, line: pos.line });
            }
            if (fn && isFnPtr(t)) site('fnptr-var', n, `${n.name}: ${t}`);
        } else if (k === 'ParmVarDecl' && fn && isFnPtr(qt(n))) {
            site('fnptr-param', n, `${n.name}: ${qt(n)}`);
        }

        // function address taken in a file-scope initializer (e.g. the
        // window-procs table tty_procs, the extended-command table)
        if (!fn && k === 'DeclRefExpr' && n.referencedDecl && n.referencedDecl.kind === 'FunctionDecl'
            && pos && !sys) {
            out.addrTaken[n.referencedDecl.name] = (out.addrTaken[n.referencedDecl.name] || 0) + 1;
        }

        // ---- statements / expressions (inside functions only) ----
        if (fn) {
            switch (k) {
            case 'GotoStmt': fn.gotos++; break;
            case 'IndirectGotoStmt': fn.gotos++; site('indirect-goto', n); break;
            case 'LabelStmt': fn.labels++; break;
            case 'SwitchStmt': fn.switches++; break;
            case 'VAArgExpr': site('va_arg', n, qt(n)); break;
            case 'CallExpr': {
                const callee = strip(n.inner && n.inner[0]);
                if (callee && callee.kind === 'DeclRefExpr' && callee.referencedDecl
                    && callee.referencedDecl.kind === 'FunctionDecl') {
                    const name = callee.referencedDecl.name;
                    fn.calls[name] = (fn.calls[name] || 0) + 1;
                    if (RNG_FUNCS.has(name)) fn.rng[name] = (fn.rng[name] || 0) + 1;
                    const args = (n.inner || []).slice(1).map((a) => qt(strip(a)));
                    if (MEM_FUNCS.has(name)) {
                        const a = (n.inner || []).slice(1);
                        const base = name.replace(/^__builtin___|^__builtin_/, '').replace(/_chk$/, '');
                        const t0 = objType(a[0]);
                        const t1 = base === 'memset' || base === 'bzero' ? null : objType(a[1]);
                        const sz = sizeofArg(base === 'bzero' ? a[1] : a[2]);
                        // whole-object forms are expressible in the object model
                        let form = 'partial';
                        if (sz === t0 && (t1 === null || t1 === t0)) form = base === 'memset' || base === 'bzero' ? 'whole-clear' : 'whole-copy';
                        if (base === 'memcmp' && sz === t0 && t1 === t0) form = 'whole-compare';
                        site('mem', n, `${base}(${t0}${t1 !== null ? ', ' + t1 : ''}; size=${sz}) ${form}`);
                    } else if (IO_FUNCS.has(name)) {
                        const a = (n.inner || []).slice(1);
                        const bufIdx = name === 'fread' || name === 'fwrite' ? 0 : 1;
                        const szIdx = name === 'fread' || name === 'fwrite' ? 1 : 2;
                        site('io', n, `${name}(${objType(a[bufIdx])}; size=${sizeofArg(a[szIdx])})`);
                    } else if (JMP_FUNCS.has(name)) {
                        site('setjmp', n, name);
                    } else if (name === '__builtin_va_start' || name === '__builtin_c23_va_start') {
                        site('va_start', n);
                    }
                } else {
                    // call through a function pointer
                    let desc = callee ? callee.kind : '?';
                    if (callee && callee.kind === 'MemberExpr') desc = `member:${callee.name}`;
                    else if (callee && callee.kind === 'DeclRefExpr' && callee.referencedDecl) desc = `var:${callee.referencedDecl.name}`;
                    else if (callee && callee.kind === 'UnaryOperator') {
                        const s = strip(callee.inner && callee.inner[0]);
                        desc = s && s.kind === 'MemberExpr' ? `member:${s.name}` : (s && s.referencedDecl ? `var:${s.referencedDecl.name}` : 'deref');
                    } else if (callee && callee.kind === 'ArraySubscriptExpr') {
                        const b = strip(callee.inner && callee.inner[0]);
                        desc = b && b.kind === 'MemberExpr' ? `array-member:${b.name}` : (b && b.referencedDecl ? `array:${b.referencedDecl.name}` : 'array');
                    }
                    // function type of the pointer, for type-based target sets
                    const ft = qt(callee).replace(/\(\*\s*(const\s*)?\)/, '').replace(/\s+/g, ' ').trim();
                    const key = `${desc}|${ft}`;
                    fn.icalls[key] = (fn.icalls[key] || 0) + 1;
                }
                break;
            }
            case 'DeclRefExpr': {
                const r = n.referencedDecl;
                if (r && r.kind === 'FunctionDecl') {
                    // address taken unless this is the callee of a CallExpr
                    const p = parent;
                    const gp = anc.length >= 2 ? anc[anc.length - 2] : null;
                    const isCallee = p && p.kind === 'ImplicitCastExpr' && p.castKind === 'FunctionToPointerDecay'
                        && gp && gp.kind === 'CallExpr' && gp.inner && gp.inner[0] === p;
                    if (!isCallee) {
                        out.addrTaken[r.name] = (out.addrTaken[r.name] || 0) + 1;
                    }
                }
                break;
            }
            case 'MemberExpr': {
                const owner = fieldOwner.get(n.referencedMemberDecl);
                if (owner && owner.startsWith('union')) site('union-access', n, `${owner}.${n.name}`);
                break;
            }
            case 'CStyleCastExpr':
            case 'ImplicitCastExpr': {
                const ck = n.castKind;
                const from = qt(strip(n.inner && n.inner[0]) || {});
                const to = qt(n);
                if (ck === 'BitCast' && isPtr(from) && isPtr(to)) {
                    const a = classifyPtrType(from), b = classifyPtrType(to);
                    if (a !== b) site(k === 'CStyleCastExpr' ? 'ptr-cast' : 'ptr-cast-implicit', n, `${a} -> ${b}`);
                } else if (ck === 'IntegralToPointer' && !/^(0|NULL)$/.test(String(n.inner && n.inner[0] && n.inner[0].value))) {
                    site('int-to-ptr', n, `${from} -> ${to}`);
                } else if (ck === 'PointerToIntegral') {
                    site('ptr-to-int', n, `${from} -> ${to}`);
                }
                break;
            }
            case 'UnaryExprOrTypeTraitExpr': {
                const what = n.argType ? canon(n.argType.qualType)
                    : qt(strip(n.inner && n.inner[0]) || {});
                site(n.name === 'sizeof' ? 'sizeof' : n.name, n, `${what} @${enclosingCallee() || '-'}`);
                break;
            }
            case 'OffsetOfExpr': site('offsetof', n, qt(n)); break;
            case 'BinaryOperator': {
                const op = n.opcode;
                const L = qt(n.inner && n.inner[0]), R = qt(n.inner && n.inner[1]);
                const lp = isPtr(L), rp = isPtr(R);
                if ((op === '+' || op === '-') && (lp || rp)) {
                    if (lp && rp) site('ptr-diff', n, `${classifyPtrType(L)} - ${classifyPtrType(R)}`);
                    else site('ptr-arith', n, `${classifyPtrType(lp ? L : R)} ${op} int`);
                } else if (['<', '>', '<=', '>='].includes(op) && lp && rp) {
                    site('ptr-compare', n, `${classifyPtrType(L)} ${op} ${classifyPtrType(R)}`);
                }
                break;
            }
            case 'CompoundAssignOperator': {
                const L = qt(n.inner && n.inner[0]);
                if ((n.opcode === '+=' || n.opcode === '-=') && isPtr(L)) site('ptr-arith', n, `${classifyPtrType(L)} ${n.opcode} int`);
                break;
            }
            case 'UnaryOperator': {
                if (['++', '--'].includes(n.opcode) && isPtr(qt(n))) site('ptr-incdec', n, `${classifyPtrType(qt(n))} ${n.opcode}`);
                if (n.opcode === '&') {
                    // address-of: what is pointed to decides the pointer representation
                    const o = strip(n.inner && n.inner[0]);
                    const ot = qt(o);
                    const tkind = /^(struct|union) /.test(ot) ? 'record' : (/\[/.test(ot) ? 'array' : (/\(/.test(ot) ? 'function' : 'scalar'));
                    let okind = o ? o.kind : '?';
                    if (o && o.kind === 'DeclRefExpr' && o.referencedDecl) {
                        okind = o.referencedDecl.kind === 'ParmVarDecl' ? 'param' : 'var';
                    } else if (o && o.kind === 'MemberExpr') okind = 'field';
                    else if (o && o.kind === 'ArraySubscriptExpr') okind = 'element';
                    site('addr-of', n, `${okind} ${tkind}`);
                }
                break;
            }
            default: break;
            }
        }

        anc.push(n);
        for (const c of n.inner || []) visit(c, n);
        // FunctionDecl without body / RecordDecl etc.: nested RecordDecls are in inner
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
    // keep only libc-relevant declaration info
    const fnDecls = Object.create(null);
    for (const [name, d] of Object.entries(out.fnDecls)) {
        fnDecls[name] = d.proj ? 'proj' : (d.builtin || name.startsWith('__builtin') ? 'builtin' : 'sys');
    }
    out.fnDecls = fnDecls;
    return out;
}
