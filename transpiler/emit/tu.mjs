// tu.mjs: one translation unit -> one JS module (method/design.md 3-4).
//
// Input: the resolved clang AST of a TU, its ctypes Scope, and a Program
// object that answers whole-program questions (which module defines a
// function or global, record class names, the async set). Output: the
// module's source text.
//
// Value representations (design 3.1-3.3):
//   integers <= 32 bits: Number holding the exact C value; 64-bit: Number
//   while safe, else BigInt ($c.norm); floating: Number (float via fround).
//   records: class instances ($T.<name>); unions: objects with one slot.
//   arrays: typed arrays (scalars <= 32 bit, floats), plain arrays (64-bit,
//   pointers, records with __arr/__idx back-references, arrays of arrays).
//   pointers by pointee: record -> the object (or $c.ElemPtr); function -> the
//   function; other -> $c.Ptr{buf, off} or $c.FieldRef; void * -> any of these.
//   NULL is null.
// Every function's locals are hoisted to the top (`let`), numbered when C
// shadows a name, so goto lowering and switch case jumps never meet JS's
// temporal dead zone; at -O0 an uninitialized local also keeps its slot's
// previous value across loop iterations, which hoisting reproduces.
// Address-taken scalar locals are one-element arrays (`x[0]`, `&x` = Ptr(x, 0)).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { show } from '../ir/ctypes.mjs';
import { preprocess } from '../frontend/ast.mjs';
import { jsName, field } from './names.mjs';
import { zeroOf, typedArrayOf, arrayInit } from './classes.mjs';

export const PREC = { comma: 1, assign: 2, cond: 2, or: 3, and: 4, bor: 5, bxor: 6, band: 7, eq: 8, rel: 9, shift: 10, add: 11, mul: 12, unary: 14, postfix: 15, call: 17, prim: 18 };
export const E = (c, p = PREC.prim) => ({ c, p });
export const par = (e, p) => (e.p < p ? `(${e.c})` : e.c);
/** Unary minus text of E e (never `--x`). */
export const neg = (e) => (e.c.startsWith('-') ? `-(${e.c})` : `-${par(e, PREC.unary)}`);

export const isEmpty = (n) => !n || !n.kind;
export const kids = (n) => (n.inner || []);

export class EmitError extends Error {}

// ---------- C string literal decoding ----------
/** clang prints string literals with C escapes; return one JS char per byte. */
export function decodeCString(lit) {
    if (lit[0] === 'L' || lit[0] === 'u' || lit[0] === 'U') throw new EmitError(`wide string literal ${lit}`);
    return decodeEscapes(lit, lit.slice(1, -1), false);
}
/** A wide (L"...") literal: its wchar_t values (Darwin: 32-bit, one per code point). */
export function decodeWideString(lit) {
    if (lit[0] !== 'L') throw new EmitError(`u/U string literal ${lit}`);
    const s = decodeEscapes(lit, lit.slice(2, -1), true);
    return Array.from(s, (c) => c.codePointAt(0));
}
function decodeEscapes(lit, s, wide) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c !== '\\') {
            const code = c.codePointAt(0);
            if (code > 0x7f && wide) { out += String.fromCodePoint(code); if (code > 0xffff) i++; } else if (code > 0x7f) {   // UTF-8 source text: emit its bytes
                const bytes = Buffer.from(String.fromCodePoint(code), 'utf8');
                for (const b of bytes) out += String.fromCharCode(b);
                if (code > 0xffff) i++;
            } else out += c;
            continue;
        }
        const d = s[++i];
        const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, e: 27, '\\': 92, '"': 34, "'": 39, '?': 63 };
        if (d in simple) { out += String.fromCharCode(simple[d]); continue; }
        if (d === 'x') {
            let h = '';
            while (/[0-9a-fA-F]/.test(s[i + 1] || '')) h += s[++i];
            out += wide ? String.fromCodePoint(parseInt(h, 16)) : String.fromCharCode(parseInt(h, 16) & 0xff);
            continue;
        }
        if (/[0-7]/.test(d)) {
            let o = d;
            while (o.length < 3 && /[0-7]/.test(s[i + 1] || '')) o += s[++i];
            out += String.fromCharCode(parseInt(o, 8) & 0xff);
            continue;
        }
        throw new EmitError(`unknown escape \\${d} in ${lit}`);
    }
    return out;
}
/** A JS string literal for byte text (one char per byte). */
export function jsStr(s) {
    let o = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34) o += '\\"';
        else if (c === 92) o += '\\\\';
        else if (c === 10) o += '\\n';
        else if (c === 9) o += '\\t';
        else if (c === 13) o += '\\r';
        else if (c < 32 || c >= 127) o += '\\x' + c.toString(16).padStart(2, '0');
        else o += s[i];
    }
    return o + '"';
}

// ---------- integer helpers ----------
const is64 = (t) => t.k === 'int' && t.size === 8;
const isU = (t) => t.k === 'int' && !t.signed;
const isInt = (t) => t.k === 'int';
const isFloat = (t) => t.k === 'float';
const isPtr = (t) => t.k === 'ptr';
/** Pointer kind by pointee: 'rec', 'fn', 'void', 'ref'. */
export function pkind(t) {
    const p = t.to;
    if (p.k === 'rec') return 'rec';
    if (p.k === 'fn' || p.k === 'builtinfn') return 'fn';
    if (p.k === 'void') return 'void';
    return 'ref';
}
/** Integer literal text for value v (BigInt) of type t. */
export function intLit(v, t) {
    if (t && t.size === 8 && (v > 9007199254740991n || v < -9007199254740991n)) return E(`${v}n`);
    if (v < 0n) return E(`${v}`, PREC.unary);
    return E(`${v}`);
}

/** The functions patch 003 wraps in an RNG caller tag (rngTagMacro). */
const RNG_TAGGED = new Set(['rn2', 'rnd', 'rnl', 'd', 'rne', 'rnz']);

export class TUEmitter {
    /**
     * @param tu { root, scope, file (repo-relative .c), dir (TU directory), src (absolute .c path) }
     * @param prog Program (see program.mjs)
     */
    constructor(tu, prog) {
        this.tu = tu;
        this.S = tu.scope;
        this.prog = prog;
        this.out = [];
        this.errors = [];
        this.texts = new Map();   // file -> source text (offsetof)
    }

    T(n) {   // resolved type of a node
        if (n._ty) return n._ty;
        const s = n.type && (n.type.desugaredQualType || n.type.qualType);
        if (!s) throw new EmitError(`node ${n.kind} has no type`);
        n._ty = this.S.type(s);
        return n._ty;
    }
    /** The serializer kind of scalar or pointer type t (js/crt/serial.js): FieldRef reads restore it. */
    serialKind(t) {
        t = this.S.resolve(t);
        if (t.k === 'int') return `${t.signed ? 'i' : 'u'}${t.size * 8}`;
        if (t.k === 'float') return t.size === 4 ? 'f32' : 'f64';
        return 'ptr';
    }
    cls(key) { if (!this.heap) this.prog.objKeys.add(key); return this.prog.className(key, this.S); }
    zero(t) { return zeroOf(t, (k) => this.cls(k)); }
    err(n, msg) {
        const l = n && n.loc && (n.loc.expansionLoc || n.loc);
        throw new EmitError(`${l ? `${l._f}:${l._l}: ` : ''}${msg}`);
    }

    // ================= module =================
    run() {
        const fns = [], globals = [];
        for (const n of kids(this.tu.root)) {
            if (!this.isOwn(n)) continue;
            if (n.kind === 'FunctionDecl' && kids(n).some((c) => c.kind === 'CompoundStmt')) { if (!this.prog.handwritten.has(n.name)) fns.push(n); }
            else if (n.kind === 'VarDecl' && n.storageClass !== 'extern') globals.push(n);
        }
        this.globalDecls = globals;
        const body = [];
        const init = [];
        // globals: declarations (zero values) at module level, initializers in $init
        for (const g of globals) {
            // a global's declaration line is pushed first; a failure loses only its initializer
            const b = [], i = [];
            try { this.emitGlobal(g, b, i); body.push(...b); init.push(...i); } catch (e) { body.push(...b); this.fail(e, g, body, init); }
        }
        for (const f of fns) {
            try { body.push(this.emitFunction(f)); } catch (e) { this.fail(e, f, body); }
        }
        // static locals were collected while emitting functions
        const statics = this.staticLocals || [];
        const head = [];
        head.push(`// ${this.tu.file}: generated by transpiler/emit from the C source. Do not edit.`);
        head.push("import * as $c from '../crt/index.js';");
        head.push("import * as $T from './types.js';");
        head.push("import { $G } from './globals.js';");
        for (const line of this.prog.importsFor(this)) head.push(line);
        const lines = [...head, ''];
        for (const s of statics) lines.push(s.decl);
        lines.push(...body);
        lines.push('');
        lines.push('export function $init() {');
        for (const s of init) lines.push('    ' + s);
        for (const s of statics) for (const x of s.init) lines.push('    ' + x);
        lines.push('}');
        return lines.join('\n') + '\n';
    }
    fail(e, n, body, init) {
        if (!(e instanceof EmitError) && !/^ctypes:/.test(e.message)) throw e;
        this.errors.push(e.message);
        body.push(`// EMIT ERROR (${n.name}): ${e.message.replace(/\n/g, ' ')}`);
        if (n.kind === 'FunctionDecl') body.push(`${n.storageClass === 'static' ? '' : 'export '}function ${jsName(n.name)}() { throw new $c.CTrap(${jsStr('not transpiled: ' + n.name)}); }`);
        else if (init) init.push(`throw new $c.CTrap(${jsStr('initializer not transpiled: ' + n.name)});`);
    }
    isOwn(n) {   // see program.mjs own()
        const l = n.loc && (n.loc.expansionLoc || n.loc);
        return !!(l && l._f && !path.isAbsolute(l._f));
    }

    // ================= globals =================
    globalName(d) { return jsName(d.name); }
    /** How a file-scope variable is accessed: '$G.x' for external scalars, else the module binding. */
    globalAccess(name, t, isStatic) {
        if (!isStatic && !(t.k === 'rec' || t.k === 'arr')) return `$G.${field(name)}`;
        return isStatic ? this.prog.staticName(this, name) : jsName(name);
    }
    emitGlobal(g, body, init) {
        const t = this.T(g);
        const isStatic = g.storageClass === 'static';
        if (!isStatic && !this.prog.ownsVar(this, g.name)) return;   // another TU's tentative definition
        const name = this.globalAccess(g.name, t, isStatic);
        this.fn = null;
        this.temps = null;
        const initExpr = g.init ? kids(g)[0] : null;
        if (t.k === 'rec' || t.k === 'arr') {
            const tt = t.k === 'arr' && t.n === null && initExpr ? this.T(initExpr) : t;
            body.push(`${isStatic ? '' : 'export '}const ${name} = ${this.zero(tt)};`);
            init.push(...this.zeroStmts(name, tt, ''));   // $init runs once per segment: a fresh C process each time
            if (initExpr) this.emitInitInto(name, tt, initExpr, init, '');
        } else if (!isStatic) {
            // external scalar: lives on $G (globals.js declares it with its zero value)
            if (initExpr) init.push(`${name} = ${this.rv(initExpr).c};`);
        } else if (this.prog.isBoxedGlobal(this, g.name)) {
            body.push(`const ${name} = ${this.box(t, this.zero(t))};   // address taken`);
            init.push(`${name}[0] = ${initExpr ? this.rv(initExpr).c : this.zero(t)};`);
        } else {
            body.push(`let ${name} = ${this.zero(t)};`);
            init.push(`${name} = ${initExpr ? this.rv(initExpr).c : this.zero(t)};`);
        }
    }

    /** Statements initializing lvalue `dst` (JS expr) of type t from initializer n. */
    emitInitInto(dst, t, n, out, ind) {
        n = this.skipParens(n);
        if (n.kind === 'ImplicitValueInitExpr') return;   // already zero
        if (t.k === 'arr' && n.kind === 'StringLiteral') {
            const s = decodeCString(n.value);
            const m = Math.min(s.length, t.n === null ? s.length + 1 : t.n);
            const bytes = [];
            for (let i = 0; i < m; i++) bytes.push(s.charCodeAt(i) << 24 >> 24);
            if (bytes.length) out.push(`${ind}${dst}.set([${bytes.join(', ')}]);   // ${jsStr(s)}`);
            return;
        }
        if (n.kind === 'InitListExpr') {
            const { items, filler } = this.initItems(n);
            if (t.k === 'arr') {
                items.forEach((it, i) => this.emitInitInto(`${dst}[${i}]`, t.of, it, out, ind));
                if (filler && filler.kind !== 'ImplicitValueInitExpr') {
                    const L = t.n || 0;
                    for (let i = items.length; i < L; i++) this.emitInitInto(`${dst}[${i}]`, t.of, filler, out, ind);
                }
                return;
            }
            if (t.k === 'rec') {
                const L = this.S.recordLayout(t.key);
                const r = this.S.record(t.key);
                if (r.union) {
                    const f = n.field ? L.fields.find((x) => x.name === n.field.name) : L.fields.find((x) => x.js);
                    if (items[0]) this.emitInitInto(`${dst}.${field(f.js)}`, f.type, items[0], out, ind);
                    return;
                }
                const named = L.fields.filter((f) => f.js || f.bits === null);
                // InitListExpr lists every field (unnamed bit-fields excluded)
                const fs = L.fields.filter((f) => !(f.bits !== null && !f.name));
                items.forEach((it, i) => {
                    const f = fs[i];
                    if (!f) this.err(n, `initializer for ${t.key} has too many items`);
                    if (this.skipParens(it).kind === 'ImplicitValueInitExpr') return;
                    if (f.bits !== null) out.push(`${ind}${dst}.${field(f.js)} = ${this.bitStore(this.rv(it).c, f)};`);
                    else this.emitInitInto(`${dst}.${field(f.js)}`, f.type, it, out, ind);
                });
                void named;
                return;
            }
            // scalar in braces: int x = { 3 };
            if (items[0]) out.push(`${ind}${dst} = ${this.rv(items[0]).c};`);
            return;
        }
        if (t.k === 'rec') { out.push(`${ind}${dst}.$copyFrom(${this.rv(n).c});`); return; }
        if (t.k === 'arr') this.err(n, `array initializer ${n.kind}`);
        out.push(`${ind}${dst} = ${this.rv(n).c};`);
    }
    /** Statements resetting aggregate `dst` of type t to zero in place. */
    zeroStmts(dst, t, ind) {
        if (t.k === 'rec') return [`${ind}${dst}.$copyFrom(new $T.${this.cls(t.key)}());`];
        if (t.k !== 'arr') return [`${ind}${dst} = ${this.zero(t)};`];
        const e = t.of;
        if (typedArrayOf(e) || e.k === 'int') return [`${ind}${dst}.fill(0);`];
        if (e.k === 'ptr' || e.k === 'fn') return [`${ind}${dst}.fill(null);`];
        const i = `$i${ind.length}`;
        return [`${ind}for (let ${i} = 0; ${i} < ${t.n || 0}; ${i}++) {`, ...this.zeroStmts(`${dst}[${i}]`, e, ind + '    '), `${ind}}`];
    }
    initItems(n) {
        if (n.array_filler) return { filler: n.array_filler[0], items: n.inner ? n.inner : n.array_filler.slice(1) };
        return { filler: null, items: kids(n) };
    }

    // ================= functions =================
    emitFunction(f) {
        const t = this.T(f);
        const params = kids(f).filter((c) => c.kind === 'ParmVarDecl');
        const body = kids(f).find((c) => c.kind === 'CompoundStmt');
        this.fn = { name: f.name, decl: f, t, locals: new Map(), names: new Set(), vars: [], temps: 0, tempNames: [], labels: new Map(), labelSeq: 0, isVariadic: t.variadic, isAsync: this.prog.isAsync(this, f.name) };
        // locals: hoist every VarDecl
        const addrTaken = this.addressTaken(body);
        const declare = (d, isParam) => {
            let nm = jsName(d.name || 'p');
            if (this.fn.names.has(nm)) { let i = 2; while (this.fn.names.has(`${nm}$${i}`)) i++; nm = `${nm}$${i}`; }
            this.fn.names.add(nm);
            const ty = this.T(d);
            const boxed = addrTaken.has(d.id) && ty.k !== 'rec' && ty.k !== 'arr';
            const isVa = /\bva_list\b/.test(d.type.qualType);
            const info = { name: nm, t: ty, boxed, isParam, isVa, decl: d };
            this.fn.locals.set(d.id, info);
            return info;
        };
        const ps = params.map((p) => declare(p, true));
        const statics = [];
        const walkDecls = (n) => {
            if (!n || typeof n !== 'object') return;
            if (n.kind === 'VarDecl') {
                if (n.storageClass === 'static') statics.push(n);
                else if (n.storageClass !== 'extern') this.fn.vars.push(declare(n, false));
            }
            for (const c of kids(n)) walkDecls(c);
        };
        walkDecls(body);
        for (const s of statics) this.declareStaticLocal(s);
        this.planGotos(body);
        const stmts = this.block(body, '    ');
        const lines = [];
        const pos = this.posOf(f);
        const exp = f.storageClass === 'static' ? '' : 'export ';
        const pnames = ps.map((p) => (p.boxed || (p.t.k === 'rec') ? `${p.name}$in` : p.name));
        if (this.fn.isVariadic) pnames.push('...$va');
        const asyncKw = this.fn.isAsync ? 'async ' : '';
        lines.push(`${exp}${asyncKw}function ${jsName(f.name)}(${pnames.join(', ')}) {   // ${pos}`);
        // parameter boxing / struct copies
        for (const p of ps) {
            if (p.boxed) lines.push(`    const ${p.name} = ${this.box(p.t, `${p.name}$in`)};`);
            else if (p.t.k === 'rec') lines.push(`    const ${p.name} = ${p.name}$in;   // passed by value: the caller copies`);
        }
        const decls = [];
        for (const v of this.fn.vars) {
            if (v.boxed) decls.push(`${v.name} = ${this.box(v.t, this.zero(v.t))}`);
            else if (v.isVa) decls.push(`${v.name} = null`);
            else decls.push(`${v.name} = ${this.zero(v.t)}`);
        }
        if (this.fn.usesGoto) decls.push('$goto = null');
        for (const tn of this.fn.tempNames) decls.push(tn);
        if (decls.length) lines.push(`    let ${decls.join(', ')};`);
        if (this.fn.setjmp) {   // objectSetjmp
            const { jb, handler } = this.fn.setjmp;
            lines.push('    try {', ...stmts.map((l) => (l ? '    ' + l : l)), '    } catch ($e) {',
                `        if (!$c.isLongJmpTo($e, ${jb})) throw $e;`, ...handler, '    }');
        } else lines.push(...stmts);
        lines.push('}');
        this.fn = null;
        return lines.join('\n');
    }
    box(t, v) {
        const ta = typedArrayOf(t);
        return ta ? `${ta}.of(${v})` : `[${v}]`;
    }
    declareStaticLocal(d) {
        const t = this.T(d);
        const nm = `${jsName(this.fn.name)}$${d.name}`;
        const info = { name: nm, t, boxed: false, isStatic: true, decl: d };
        // address-taken scalar statics: box
        this.fn.locals.set(d.id, info);
        this.staticLocals = this.staticLocals || [];
        const init = [];
        const saveFn = this.fn;
        if (t.k === 'rec' || t.k === 'arr') {
            const tt = t.k === 'arr' && t.n === null && d.init ? this.T(kids(d)[0]) : t;
            init.push(...this.zeroStmts(nm, tt, ''));
            if (d.init) this.emitInitInto(nm, tt, kids(d)[0], init, '');
            this.staticLocals.push({ decl: `const ${nm} = ${this.zero(tt)};   // static in ${this.fn.name}()`, init });
        } else {
            const addr = this.addressTaken(saveFn.decl).has(d.id);
            if (addr) {
                info.boxed = true;
                init.push(`${nm}[0] = ${d.init ? this.rv(kids(d)[0]).c : this.zero(t)};`);
                this.staticLocals.push({ decl: `const ${nm} = ${this.box(t, this.zero(t))};   // static in ${this.fn.name}()`, init });
            } else {
                init.push(`${nm} = ${d.init ? this.rv(kids(d)[0]).c : this.zero(t)};`);
                this.staticLocals.push({ decl: `let ${nm} = ${this.zero(t)};   // static in ${this.fn.name}()`, init });
            }
        }
    }
    /** VarDecl ids whose address is taken (&x) in subtree n. */
    addressTaken(n) {
        if (!n._addr) {
            const s = new Set();
            const walk = (x) => {
                if (!x || typeof x !== 'object') return;
                if (x.kind === 'UnaryOperator' && x.opcode === '&') {
                    const d = this.skipParens(kids(x)[0]);
                    if (d.kind === 'DeclRefExpr' && d.referencedDecl) s.add(d.referencedDecl.id);
                }
                for (const c of kids(x)) walk(c);
            };
            walk(n);
            n._addr = s;
        }
        return n._addr;
    }
    posOf(n) {
        const l = n.loc && (n.loc.expansionLoc || n.loc);
        return l ? `${path.basename(l._f || '')}:${l._l}` : '';
    }
    /**
     * setjmp in the object world (nhlua.c nhl_pcall): `if (setjmp(buf)) S`, where S does
     * not fall through (it ends in a noreturn call or a return). setjmp arms the buffer
     * and returns 0; S becomes the handler of a try around the whole function body
     * (emitFunction), entered by a longjmp to that buffer from any depth while this
     * frame is live. Since S never falls through, where C would resume after the if
     * does not matter. Locals are hoisted, so S sees them. Other shapes are errors.
     */
    objectSetjmp(n, ind, tag) {
        const [c, th] = kids(n);
        let cc = c;
        while (cc && (cc.kind === 'ImplicitCastExpr' || cc.kind === 'ParenExpr' || cc.kind === 'CStyleCastExpr')) cc = kids(cc)[0];
        if (!cc || cc.kind !== 'CallExpr') return null;
        let f = kids(cc)[0];
        while (f && (f.kind === 'ImplicitCastExpr' || f.kind === 'ParenExpr')) f = kids(f)[0];
        if (!(f && f.kind === 'DeclRefExpr' && /^_?setjmp$/.test(f.referencedDecl.name))) return null;
        if (this.heapWorld) return null;   // heap.mjs LUAI_TRY handles its own pattern
        if (n.hasElse) this.err(n, 'setjmp: an if with an else is not translated');
        if (this.fn.setjmp) this.err(n, 'setjmp: more than one in a function');
        const last = th.kind === 'CompoundStmt' ? kids(th).at(-1) : th;
        const noReturn = (x) => {
            if (!x) return false;
            if (x.kind === 'ReturnStmt') return true;
            if (x.kind !== 'CallExpr') return false;
            let g = kids(x)[0];
            while (g && (g.kind === 'ImplicitCastExpr' || g.kind === 'ParenExpr')) g = kids(g)[0];
            return !!(g && g.kind === 'DeclRefExpr' && /noreturn/.test(g.referencedDecl.type?.qualType || ''));
        };
        if (!noReturn(last)) this.err(n, 'setjmp: the handler falls through');
        const jb = this.temp();
        this.fn.setjmp = { jb, handler: this.block(th, '        ') };
        return [`${ind}${jb} = ${this.rv(kids(cc)[1]).c}, $c.setjmp(${jb});   // setjmp: armed; a longjmp here runs the handler at the end of the function${tag}`];
    }
    temp() {
        const n = `$t${++this.fn.temps}`;
        this.fn.tempNames.push(n);
        return n;
    }

    // ================= statements =================
    block(n, ind) {
        if (n.kind === 'CompoundStmt') return this.stmtList(kids(n), ind, n);
        return this.stmt(n, ind);
    }
    /** A statement list, with goto lowering (planGotos) when it holds jump targets. */
    stmtList(list, ind, node) {
        if (node && node._dispatch) return this.emitDispatch(list, node, ind);
        const plan = node && node._simple ? this.gotoPlan(list) : null;
        if (!plan) return list.flatMap((s) => this.stmt(s, ind));
        return this.emitRegions(list, plan, 0, list.length, ind);
    }
    stmt(n, ind) {
        if (isEmpty(n)) return [];
        const pos = this.posOf(n);
        const tag = pos ? `   // ${pos}` : '';
        switch (n.kind) {
        case 'CompoundStmt': return [`${ind}{`, ...this.stmtList(kids(n), ind + '    ', n), `${ind}}`];
        case 'NullStmt': return [];
        case 'DeclStmt': {
            const out = [];
            for (const d of kids(n)) {
                if (d.kind !== 'VarDecl' || d.storageClass === 'static' || d.storageClass === 'extern') continue;
                const v = this.fn.locals.get(d.id);
                if (!d.init) {
                    // a declaration without initializer: an uninitialized record/array local
                    // keeps its slot (hoisted), like clang -O0; scalars too
                    continue;
                }
                const init = kids(d)[0];
                if (v.t.k === 'rec' || v.t.k === 'arr') {
                    // an initialized aggregate: reset the (hoisted) storage in place, then
                    // store the initializers; C reuses the same storage on every pass
                    const it = v.t.k === 'arr' && v.t.n === null ? this.T(init) : v.t;
                    if (v.t.k === 'arr' || this.skipParens(init).kind === 'InitListExpr') out.push(...this.zeroStmts(v.name, it, ind));
                    this.emitInitInto(v.name, it, init, out, ind);
                } else if (v.boxed) out.push(`${ind}${v.name}[0] = ${this.rv(init).c};${tag}`);
                else if (v.isVa) out.push(`${ind}${v.name} = ${this.rv(init).c};${tag}`);
                else out.push(`${ind}${v.name} = ${this.rv(init).c};${tag}`);
            }
            return out;
        }
        case 'IfStmt': {
            const sj = this.objectSetjmp(n, ind, tag);
            if (sj) return sj;
            const [c, th, el] = kids(n);
            const out = [`${ind}if (${this.inwardIf(n, th, el, this.cond(c))}) {${tag}`, ...this.block(th, ind + '    ')];
            if (n.hasElse) {
                if (el.kind === 'IfStmt') {
                    const rest = this.stmt(el, ind);
                    rest[0] = rest[0].replace(/^\s*/, '');
                    out.push(`${ind}} else ${rest[0]}`, ...rest.slice(1));
                    return out;
                }
                out.push(`${ind}} else {`, ...this.block(el, ind + '    '));
            }
            out.push(`${ind}}`);
            return out;
        }
        case 'WhileStmt': {
            const [c, b] = kids(n);
            return this.loop(n, ind, (lab) => [`${ind}${lab}while (${this.inwardLoop(n, this.cond(c))}) {${tag}`, ...this.loopBody(n, b, ind), `${ind}}`]);
        }
        case 'DoStmt': {
            const [b, c] = kids(n);
            return this.loop(n, ind, (lab) => [`${ind}${lab}do {${tag}`, ...this.loopBody(n, b, ind), `${ind}} while (${this.cond(c).c});`]);
        }
        case 'ForStmt': {
            const [init, , c, inc, b] = kids(n);
            let i = isEmpty(init) ? '' : init.kind === 'DeclStmt' ? this.declInitExpr(init) : this.exprStmtText(init);
            const cc = isEmpty(c) ? (n._inward ? this.inwardLoop(n, E('true')) : '') : this.inwardLoop(n, this.cond(c));
            const ic = isEmpty(inc) ? '' : this.exprStmtText(inc);
            const pre = [];
            if (n._inward && i) { pre.push(`${ind}if ($goto === null) ${i};   // a jump into the loop skips its initialization`); i = ''; }
            return [...pre, ...this.loop(n, ind, (lab) => [`${ind}${lab}for (${i}; ${cc}; ${ic}) {${tag}`, ...this.loopBody(n, b, ind), `${ind}}`])];
        }
        case 'SwitchStmt': return this.switchStmt(n, ind, tag);
        case 'BreakStmt': return [`${ind}${this.jumpText('break')};`];
        case 'ContinueStmt': return [`${ind}${this.jumpText('continue')};`];
        case 'ReturnStmt': {
            const e = kids(n)[0];
            if (!e) return [`${ind}return;${tag}`];
            const ft = this.fn.t.ret;
            if (ft.k === 'void') return [`${ind}${this.exprStmtText(e)};`, `${ind}return;${tag}`];
            let v = this.rv(e).c;
            if (ft.k === 'rec' && !this.isFresh(e)) v = `${v}.$clone()`;
            return [`${ind}return ${v};${tag}`];
        }
        case 'LabelStmt': {
            const sub = this.stmt(kids(n)[0], ind);
            if (this.fn.dispatchTargets && this.fn.dispatchTargets.has(n.declId)) return [`${ind}$goto = null;   // ${n.name}:`, ...sub];
            return sub;
        }
        case 'GotoStmt': {
            const g = this.fn.gotoMode.get(n);
            if (g && g.mode === 'switch') {
                if (!g.sw._sjs) this.err(n, 'goto: switch re-entry loop not active');
                return [`${ind}$goto = ${jsStr(this.labelName(n.targetLabelDeclId))}; continue ${g.sw._sjs};${tag}`];
            }
            if (g && g.mode === 'dispatch') {
                if (!g.list._djs) this.err(n, 'goto: dispatch loop not active');
                return [`${ind}$goto = ${jsStr(this.labelName(n.targetLabelDeclId))}; continue ${g.list._djs};${tag}`];
            }
            const L = this.fn.labels.get(n.targetLabelDeclId);
            if (!L || !L.active) this.err(n, 'goto into or out of an unsupported region');
            L.used = true;
            return [`${ind}${L.mode === 'fwd' ? 'break' : 'continue'} ${L.js};${tag}`];
        }
        case 'AttributedStmt': return this.stmt(kids(n).find((c) => !/Attr$/.test(c.kind)), ind);
        case 'CaseStmt': case 'DefaultStmt': this.err(n, 'case label outside the switch body list');
        // eslint-disable-next-line no-fallthrough
        default:
            if (n.kind.endsWith('Expr') || n.kind.endsWith('Operator') || n.kind.endsWith('Literal')) return [`${ind}${this.exprStmtText(n)};${tag}`];
            this.err(n, `unsupported statement ${n.kind}`);
        }
        return [];
    }
    exprStmtText(n) { return this.ex(n, 'd').c; }
    /** `for (int i = 0, j = 1; ...)`: the declarations' scalar initializers as one comma expression. */
    declInitExpr(ds) {
        const parts = [];
        for (const d of kids(ds)) {
            if (d.kind !== 'VarDecl' || !d.init) continue;
            const v = this.fn.locals.get(d.id);
            if (v.t.k === 'rec' || v.t.k === 'arr') this.err(ds, 'aggregate declared in a for initializer');
            const val = this.rv(kids(d)[0]).c;
            parts.push(v.boxed ? `${v.name}[0] = ${val}` : `${v.name} = ${val}`);
        }
        return parts.join(', ');
    }

    // break/continue targets: each C loop/switch pushes a frame; jumps go to the innermost
    // C target, labeled when a JS construct (goto lowering) sits in between.
    loop(n, ind, gen) {
        const fr = { kind: 'loop', js: null, n };
        this.fn.jumps = this.fn.jumps || [];
        this.fn.jumps.push(fr);
        const lines = gen('$LABEL$');
        this.fn.jumps.pop();
        lines[0] = lines[0].replace('$LABEL$', fr.js ? `${fr.js}: ` : '');
        return lines;
    }
    loopBody(n, b, ind) { return this.block(b, ind + '    '); }
    jumpText(kind) {
        const st = this.fn.jumps || [];
        // innermost C construct accepting this jump
        let i = st.length - 1;
        let crossed = false;
        for (; i >= 0; i--) {
            const f = st[i];
            if (f.kind === 'js') { crossed = crossed || f.captures(kind); continue; }
            if (kind === 'continue' && f.kind === 'switch') { crossed = true; continue; }
            break;
        }
        if (i < 0) throw new EmitError(`${kind} outside a loop`);
        const f = st[i];
        if (!crossed) return kind;
        if (!f.js) f.js = `L${++this.fn.labelSeq}`;
        return `${kind} ${f.js}`;
    }

    switchStmt(n, ind, tag) {
        const [c, body] = kids(n);
        const fr = { kind: 'switch', js: null, n };
        this.fn.jumps = this.fn.jumps || [];
        this.fn.jumps.push(fr);
        const out = [];
        const list = body.kind === 'CompoundStmt' ? kids(body) : [body];
        // flatten: each top-level item may be a (nested) case/default chain
        const items = [];
        for (const s of list) {
            let x = s;
            const labels = [];
            while (x && (x.kind === 'CaseStmt' || x.kind === 'DefaultStmt')) {
                if (x.kind === 'CaseStmt') {
                    if (kids(x).length > 2) this.err(x, 'GNU case range');
                    labels.push(`case ${this.caseValue(kids(x)[0])}:`);
                    x = kids(x)[1];
                } else { labels.push('default:'); x = kids(x)[0]; }
            }
            items.push({ labels, stmt: x });
        }
        // a case label nested deeper (inside an if/loop) is not supported yet
        const nested = (x) => x && typeof x === 'object' && (x.kind === 'CaseStmt' || x.kind === 'DefaultStmt' || (x.kind !== 'SwitchStmt' && kids(x).some(nested)));
        for (const it of items) if (it.stmt && kids(it.stmt).some(nested) && it.stmt.kind !== 'SwitchStmt') this.err(n, 'case label inside a nested statement');
        const inner = [];
        const stmts = [];
        const targets = n._targets ? [...n._targets] : [];
        for (const it of items) {
            for (const l of it.labels) inner.push({ label: `${ind}    ${l}` });
            // jump targets inside this item: a synthetic case to enter it ($goto holds the label)
            for (const id of targets) if (this.containsLabel(it.stmt, id)) inner.push({ label: `${ind}    case ${jsStr(this.labelName(id))}:` });
            if (it.stmt) inner.push({ stmt: it.stmt });
        }
        // re-entry loop for jumps inside the switch body (break leaves the switch, then the loop)
        let sjs = null, sfr = null;
        if (n._internal) {
            sjs = `S${++this.fn.labelSeq}`;
            n._sjs = sjs;
            sfr = { kind: 'js', captures: (k) => k === 'continue' };
            this.fn.jumps.splice(this.fn.jumps.length - 1, 0, sfr);   // outside the C switch frame
        }
        // goto lowering among the switch body's statements is not needed so far
        for (const x of inner) {
            if (x.label) stmts.push(x.label);
            else stmts.push(...this.stmt(x.stmt, ind + '        '));
        }
        this.fn.jumps.pop();
        if (sfr) { this.fn.jumps.splice(this.fn.jumps.indexOf(sfr), 1); n._sjs = null; }
        let sv = this.rv(c).c;
        if (targets.length) sv = `$goto !== null ? $goto : ${par(this.rv(c), PREC.cond + 1)}`;   // entered by a jump: the C expression is not evaluated
        if (sjs) {
            out.push(`${ind}${sjs}: for (;;) {`);
            out.push(`${ind}    ${fr.js ? fr.js + ': ' : ''}switch (${sv}) {${tag}`);
            out.push(...stmts.map((x) => '    ' + x));
            out.push(`${ind}    }`, `${ind}    break;`, `${ind}}`);
            return out;
        }
        out.push(`${ind}${fr.js ? fr.js + ': ' : ''}switch (${sv}) {${tag}`);
        out.push(...stmts);
        out.push(`${ind}}`);
        return out;
    }
    caseValue(ce) {
        if (ce.kind === 'ConstantExpr' && ce.value !== undefined) {
            const t = this.T(ce);
            return intLit(BigInt(ce.value), t).c + this.enumComment(ce);
        }
        return this.rv(ce).c;
    }
    enumComment(ce) {
        const x = this.skipParens(kids(ce)[0] || {});
        const d = this.stripCasts(x);
        if (d && d.kind === 'DeclRefExpr' && d.referencedDecl && d.referencedDecl.kind === 'EnumConstantDecl') return ` /* ${d.referencedDecl.name} */`;
        return '';
    }

    // ---------- goto lowering ----------
    // planGotos decides, per statement list, how its jumps are lowered:
    //  simple:   every label is a direct member and the jump regions nest ->
    //            labeled blocks (forward) and labeled loops (backward), gotoPlan.
    //  dispatch: otherwise, and for every list a jump passes through on its way
    //            into a nested label -> `D: for (;;) { switch ($goto) { case null:
    //            ... case 'L': ... } break; }`; goto L is `$goto = 'L'; continue D`.
    // Statements on the path from a list into a nested label get `_inward`
    // (the labels): if/while/for/switch conditions then steer to the label
    // without evaluating the C condition, and the label resets $goto.
    planGotos(body) {
        const labels = new Map(), gotos = [];
        const walk = (n, path) => {
            if (!n || typeof n !== 'object' || !n.kind) return;
            if (n.kind === 'LabelStmt') labels.set(n.declId, { node: n, path });
            if (n.kind === 'GotoStmt') gotos.push({ node: n, path });
            if (n.kind === 'CompoundStmt') kids(n).forEach((c, i) => walk(c, [...path, { node: n, idx: i }]));
            else if (/Stmt$/.test(n.kind) || n.kind === 'LabelStmt') {
                const sw = n.kind === 'SwitchStmt';
                for (const c of kids(n)) {
                    if (sw && c.kind === 'CompoundStmt') { c._switchBody = true; c._switchOf = n; kids(c).forEach((x, i) => walk(x, [...path, { node: n }, { node: c, idx: i }])); }
                    else walk(c, [...path, { node: n }]);
                }
            }
        };
        walk(body, []);
        this.fn.labelNames = new Map([...labels].map(([id, l]) => [id, l.node.name]));
        this.fn.gotoMode = new Map();
        if (!gotos.length) return;
        const pairsBy = new Map();   // list node -> [{ g, L, direct }]
        const inwardLists = new Set();
        for (const g of gotos) {
            const L = labels.get(g.node.targetLabelDeclId);
            if (!L) this.err(g.node, 'goto to an unknown label');
            const full = [...L.path, { node: L.node }];
            let lca = null, k = -1;
            for (let i = 0; i < Math.min(g.path.length, full.length); i++) {
                if (g.path[i].node !== full[i].node) break;
                const nd = g.path[i].node;
                if (nd.kind === 'CompoundStmt') { lca = nd; k = i; }
                if (g.path[i].idx !== full[i].idx) break;
            }
            if (!lca) this.err(g.node, 'goto without a common statement list');
            // direct: below the list entry there are only LabelStmts down to the label
            const below = full.slice(k + 1);
            const direct = below.every((x) => x.node.kind === 'LabelStmt');
            if (!pairsBy.has(lca)) pairsBy.set(lca, []);
            pairsBy.get(lca).push({ g, L, direct, below });
        }
        this.fn.dispatchTargets = new Set();
        const markBelow = (p, id) => {
            for (const x of p.below) {
                if (x.node.kind === 'CompoundStmt' && x.node._switchBody) { this.switchTarget(x.node._switchOf, id); continue; }
                if (x.node.kind === 'CompoundStmt') {
                    x.node._entries = x.node._entries || new Set();
                    x.node._entries.add(x.idx);
                    inwardLists.add(x.node);
                    x.node._dispatch = x.node._dispatch || new Set();
                    x.node._dispatch.add(id);
                } else if (x.node.kind !== 'LabelStmt' && x.node.kind !== 'SwitchStmt') { x.node._inward = x.node._inward || new Set(); x.node._inward.add(id); }
            }
        };
        for (const [list, pairs] of pairsBy) {
            if (list._switchBody) {
                // jumps within one switch body: re-enter the switch at a synthetic case
                const sw = list._switchOf;
                sw._internal = true;
                for (const p of pairs) {
                    const id = p.L.node.declId;
                    this.fn.gotoMode.set(p.g.node, { mode: 'switch', sw });
                    this.switchTarget(sw, id);
                    markBelow(p, id);
                }
                continue;
            }
            let simple = pairs.every((p) => p.direct);
            if (simple) { try { this.gotoPlan(kids(list)); } catch (e) { if (!(e instanceof EmitError)) throw e; simple = false; } }
            if (simple) { list._simple = true; for (const p of pairs) this.fn.gotoMode.set(p.g.node, { mode: 'simple' }); continue; }
            list._dispatch = list._dispatch || new Set();
            for (const p of pairs) {
                this.fn.gotoMode.set(p.g.node, { mode: 'dispatch', list });
                const id = p.L.node.declId;
                list._dispatch.add(id);
                this.fn.dispatchTargets.add(id);
                // the path below the list entry: lists dispatch (an inner list only to enter
                // past its first statement), switches get a synthetic case, others steer
                markBelow(p, id);
            }
        }
        for (const l of inwardLists) {
            if (!pairsBy.has(l) && [...l._entries].every((i) => i === 0)) { l._dispatch = null; inwardLists.delete(l); }
        }
        // a list both simple and on an inward path becomes dispatch (its own jumps too)
        for (const [list, pairs] of pairsBy) {
            if (!list._simple || !inwardLists.has(list)) continue;
            list._simple = false;
            for (const p of pairs) {
                this.fn.gotoMode.set(p.g.node, { mode: 'dispatch', list });
                list._dispatch.add(p.L.node.declId);
                this.fn.dispatchTargets.add(p.L.node.declId);
            }
        }
        if (this.fn.dispatchTargets.size) this.fn.usesGoto = true;
    }
    switchTarget(sw, id) {
        sw._targets = sw._targets || new Set();
        sw._targets.add(id);
        this.fn.dispatchTargets.add(id);
        this.fn.usesGoto = true;
    }
    labelName(id) { return this.fn.labelNames.get(id); }
    containsLabel(n, id) {
        if (!n || typeof n !== 'object') return false;
        if (n.kind === 'LabelStmt' && n.declId === id) return true;
        return kids(n).some((c) => this.containsLabel(c, id));
    }
    /** if condition with jumps into the then- or else-branch. */
    inwardIf(n, th, el, cond) {
        if (!n._inward) return cond.c;
        const inThen = [...n._inward].filter((l) => this.containsLabel(th, l)).map((l) => `$goto === ${jsStr(this.labelName(l))}`);
        const inElse = [...n._inward].filter((l) => el && this.containsLabel(el, l)).map((l) => `$goto !== ${jsStr(this.labelName(l))}`);
        let c = par(cond, PREC.and + 1);
        if (inElse.length) c = `${inElse.join(' && ')} && ${c}`;
        if (inThen.length) c = `${inThen.join(' || ')} || ${inElse.length ? `(${c})` : par(cond, PREC.or + 1)}`;
        return c;
    }
    inwardLoop(n, cond) {
        if (!n._inward) return cond.c;
        return `${[...n._inward].map((l) => `$goto === ${jsStr(this.labelName(l))}`).join(' || ')} || ${par(cond, PREC.or + 1)}`;
    }
    emitDispatch(list, node, ind) {
        const js = `D${++this.fn.labelSeq}`;
        node._djs = js;
        const fr = { kind: 'js', captures: () => true };   // the loop and the switch capture plain break/continue
        this.fn.jumps = this.fn.jumps || [];
        this.fn.jumps.push(fr);
        // entry points: the child holding each target label
        const entry = new Map();   // child index -> [label ids]
        for (const id of node._dispatch) {
            const i = list.findIndex((c) => this.containsLabel(c, id));
            if (i < 0) this.err(node, 'dispatch target not in its list');
            if (!entry.has(i)) entry.set(i, []);
            entry.get(i).push(id);
        }
        const body = [];
        const ind2 = ind + '        ';
        body.push(`${ind}    switch ($goto) {`);
        if (!entry.has(0)) body.push(`${ind}    case null:`);
        list.forEach((c, i) => {
            if (entry.has(i)) {
                const labs = entry.get(i).map((id) => `case ${jsStr(this.labelName(id))}:`);
                if (i === 0) labs.unshift('case null:');
                body.push(`${ind}    ${labs.join(' ')}`);
            }
            body.push(...this.stmt(c, ind2));
        });
        body.push(`${ind}    }`);
        this.fn.jumps.pop();
        node._djs = null;
        return [`${ind}${js}: for (;;) {`, ...body, `${ind}    break;`, `${ind}}`];
    }
    /**
     * For a statement list: find labels that are direct members and gotos to
     * them from inside the list. A forward goto becomes `break L` out of a
     * labeled block that ends just before the label; a backward goto becomes
     * `continue L` of a labeled loop that starts at the label. Returns null when
     * the list has no such label.
     */
    gotoPlan(list) {
        const labelsAt = new Map();   // declId -> index
        list.forEach((s, i) => { let x = s; while (x && x.kind === 'LabelStmt') { labelsAt.set(x.declId, i); x = kids(x)[0]; } });
        if (!labelsAt.size) return null;
        const regions = [];
        list.forEach((s, i) => {
            const gotos = new Set();
            const walk = (x) => { if (!x || typeof x !== 'object') return; if (x.kind === 'GotoStmt') gotos.add(x.targetLabelDeclId); for (const c of kids(x)) walk(c); };
            walk(s);
            for (const id of gotos) {
                if (!labelsAt.has(id)) continue;
                const li = labelsAt.get(id);
                if (li > i) regions.push({ id, mode: 'fwd', from: i, to: li });          // [from, li) wrapped in a block
                else regions.push({ id, mode: 'back', from: li, to: i + 1 });           // [li, i] wrapped in a loop
            }
        });
        if (!regions.length) return null;
        // merge regions per label: fwd -> earliest from; back -> latest to
        const by = new Map();
        for (const r of regions) {
            const k = `${r.id}:${r.mode}`;
            const p = by.get(k);
            if (!p) by.set(k, { ...r });
            else { p.from = Math.min(p.from, r.from); p.to = Math.max(p.to, r.to); }
        }
        const rs = [...by.values()];
        // a label with both forward and backward gotos is not supported yet
        const ids = new Map();
        for (const r of rs) { if (ids.has(r.id)) throw new EmitError('label with forward and backward gotos'); ids.set(r.id, r); }
        // regions must nest: sort by from asc, to desc
        rs.sort((a, b) => a.from - b.from || b.to - a.to);
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i], b = rs[j];
            if (b.from < a.to && b.to > a.to) throw new EmitError('crossing goto regions');   // planGotos then dispatches
        }
        return rs;
    }
    emitRegions(list, rs, from, to, ind) {
        const out = [];
        let i = from;
        while (i < to) {
            const r = rs.find((x) => x.from === i && x.to <= to && !x.taken);
            if (!r) {
                out.push(...this.stmt(list[i], ind));
                i++;
                continue;
            }
            r.taken = true;
            const labelNode = (() => { let x = list[r.mode === 'fwd' ? r.to : r.from]; while (x && x.kind === 'LabelStmt' && x.declId !== r.id) x = kids(x)[0]; return x; })();
            const js = `${jsName(labelNode.name)}$`;
            const L = { js, mode: r.mode, active: true, used: false, handled: true };
            this.fn.labels.set(r.id, L);
            const fr = { kind: 'js', captures: (k) => r.mode === 'back' };   // a loop captures plain break/continue
            this.fn.jumps = this.fn.jumps || [];
            this.fn.jumps.push(fr);
            const innerTo = r.to;
            const body = this.emitRegions(list, rs, i, innerTo, ind + '    ');
            this.fn.jumps.pop();
            L.active = false;
            if (r.mode === 'fwd') out.push(`${ind}${js}: {`, ...body, `${ind}}`);
            else out.push(`${ind}${js}: for (;;) {`, ...body, `${ind}    break;`, `${ind}}`);
            i = innerTo;
        }
        return out;
    }

    // ================= expressions =================
    skipParens(n) { while (n && (n.kind === 'ParenExpr' || (n.kind === 'ConstantExpr' && n.value === undefined))) n = kids(n)[0]; return n; }
    stripCasts(n) { while (n && (n.kind === 'ImplicitCastExpr' || n.kind === 'CStyleCastExpr' || n.kind === 'ParenExpr' || n.kind === 'ConstantExpr')) n = kids(n)[0]; return n; }
    isFresh(n) { n = this.skipParens(n); return n.kind === 'CallExpr'; }

    /** rvalue */
    rv(n) {
        if (n.kind === 'InitListExpr' && this.T(n).k !== 'rec' && this.T(n).k !== 'arr') {   // int x = { 3 }; p = DUMMY
            const { items } = this.initItems(n);
            return items.length ? this.rv(items[0]) : E(this.zero(this.T(n)));
        }
        // a comma expression as a value is parenthesized: consumers splice .c into
        // initializers, assignments and argument lists
        const e = this.ex(n, 'v');
        return e.p <= PREC.comma ? E(`(${e.c})`) : e;
    }
    /** condition context: a JS truthy value is enough */
    cond(n) {
        n = this.skipParens(n);
        const t = this.T(n);
        if (isFloat(t)) return E(`${par(this.rv(n), PREC.eq)} !== 0`, PREC.eq);
        return this.ex(n, 'c');
    }
    /** Turn a JS boolean expression into a C int (0/1) when a value is needed. */
    boolVal(e, ctx) { return ctx === 'c' ? e : E(`${par(e, PREC.cond + 1)} ? 1 : 0`, PREC.cond); }

    /**
     * Integer constant folding with C semantics: the value (BigInt) of n if it
     * is an integer expression built only from literals, enum constants, casts
     * and operators without side effects; else null. Wraps to the node's type.
     */
    fold(n) {
        if (n._fold !== undefined) return n._fold;
        let v = null;
        try { v = this.fold1(n); } catch (e) { if (!(e instanceof EmitError)) throw e; v = null; }
        n._fold = v;
        return v;
    }
    fold1(n) {
        const t = n.type ? this.T(n) : null;
        if (!t || t.k !== 'int') return null;
        const wrap = (x) => (t.signed ? BigInt.asIntN(t.size * 8, x) : BigInt.asUintN(t.size * 8, x));
        const k = kids(n);
        switch (n.kind) {
        case 'IntegerLiteral': return wrap(BigInt(n.value));
        case 'CharacterLiteral': return wrap(BigInt(n.value));
        case 'ConstantExpr': if (n.value !== undefined) return wrap(BigInt(n.value)); return this.fold(k[0]);
        case 'ParenExpr': return this.fold(k[0]);
        case 'DeclRefExpr':
            if (n.referencedDecl.kind === 'EnumConstantDecl') { const x = this.S.enumConsts.get(n.referencedDecl.name); return x === undefined ? null : wrap(x); }
            return null;
        case 'ImplicitCastExpr': case 'CStyleCastExpr': {
            if (n.castKind !== 'IntegralCast' && n.castKind !== 'NoOp') return null;
            const x = this.fold(k[0]);
            return x === null ? null : wrap(x);
        }
        case 'UnaryExprOrTypeTraitExpr': { try { return BigInt(this.sizeofExpr(n).c); } catch { return null; } }
        case 'UnaryOperator': {
            const x = this.fold(k[0]);
            if (x === null) return null;
            switch (n.opcode) {
            case '-': return wrap(-x);
            case '+': return wrap(x);
            case '~': return wrap(~x);
            case '!': return x === 0n ? 1n : 0n;
            default: return null;
            }
        }
        case 'BinaryOperator': {
            const a = this.fold(k[0]);
            if (a === null) return null;
            if (n.opcode === '&&' && a === 0n) return 0n;
            if (n.opcode === '||' && a !== 0n) return 1n;
            const b = this.fold(k[1]);
            if (b === null) return null;
            const ta = this.T(k[0]);
            switch (n.opcode) {
            case '+': return wrap(a + b);
            case '-': return wrap(a - b);
            case '*': return wrap(a * b);
            case '/': return b === 0n ? null : wrap(a / b);    // BigInt division truncates, like C
            case '%': return b === 0n ? null : wrap(a % b);
            case '&': return wrap(a & b);
            case '|': return wrap(a | b);
            case '^': return wrap(a ^ b);
            case '<<': return wrap(a << (b & BigInt(t.size * 8 - 1)));
            case '>>': return wrap(a >> (b & BigInt(t.size * 8 - 1)));   // operand already has its own (promoted) type
            case '<': return a < b ? 1n : 0n;
            case '>': return a > b ? 1n : 0n;
            case '<=': return a <= b ? 1n : 0n;
            case '>=': return a >= b ? 1n : 0n;
            case '==': return a === b ? 1n : 0n;
            case '!=': return a !== b ? 1n : 0n;
            case '&&': return b !== 0n ? 1n : 0n;
            case '||': return b !== 0n ? 1n : 0n;
            default: void ta; return null;
            }
        }
        case 'ConditionalOperator': {
            const c = this.fold(k[0]);
            if (c === null) return null;
            const r = this.fold(c !== 0n ? k[1] : k[2]);
            return r === null ? null : wrap(r);
        }
        default: return null;
        }
    }

    ex(n, ctx) {
        if (n.kind !== 'IntegerLiteral' && n.kind !== 'CharacterLiteral' && n.kind !== 'DeclRefExpr' && n.kind !== 'ConstantExpr' && n.type) {
            const v = this.fold(n);
            if (v !== null) {
                const e = intLit(v, this.T(n));
                if (ctx === 'c' && (n.kind === 'BinaryOperator' || n.kind === 'UnaryOperator')) return e;
                return e;
            }
        }
        switch (n.kind) {
        case 'ParenExpr': { const e = this.ex(kids(n)[0], ctx); return e; }
        case 'ConstantExpr':
            if (n.value !== undefined) {
                const t = this.T(n);
                if (isInt(t)) return E(intLit(BigInt(n.value), t).c + this.enumComment(n), intLit(BigInt(n.value), t).p);
            }
            return this.ex(kids(n)[0], ctx);
        case 'IntegerLiteral': return intLit(BigInt(n.value), this.T(n));
        case 'CharacterLiteral': return E(String(n.value), n.value < 0 ? PREC.unary : PREC.prim);
        case 'FloatingLiteral': {
            const v = Number(n.value);
            const t = this.T(n);
            const s = Number.isInteger(v) ? v.toFixed(1) : String(v);
            return E(t.size === 4 ? `Math.fround(${s})` : s);
        }
        case 'StringLiteral': return E(`$c.lit(${jsStr(decodeCString(n.value))})`, PREC.call);
        case 'PredefinedExpr': return this.ex(kids(n)[0], ctx);
        case 'DeclRefExpr': return this.declRef(n, ctx);
        case 'ImplicitCastExpr': case 'CStyleCastExpr': return this.cast(n, ctx);
        case 'BinaryOperator': return this.binary(n, ctx);
        case 'CompoundAssignOperator': return this.compoundAssign(n, ctx);
        case 'UnaryOperator': return this.unary(n, ctx);
        case 'ConditionalOperator': {
            const tagged = this.rngTagMacro(n);
            if (tagged) return this.ex(tagged, ctx);
            const [c, a, b] = kids(n);
            const t = this.T(n);
            const sub = (x) => (t.k === 'void' ? this.ex(x, 'd') : this.ex(x, ctx === 'c' && isInt(t) ? 'c' : 'v'));
            return E(`${par(this.cond(c), PREC.or)} ? ${par(sub(a), PREC.assign)} : ${par(sub(b), PREC.assign)}`, PREC.cond);
        }
        case 'CallExpr': return this.call(n, ctx);
        case 'MemberExpr': case 'ArraySubscriptExpr': return this.lvalue(n).get();
        case 'UnaryExprOrTypeTraitExpr': return this.sizeofExpr(n);
        case 'OffsetOfExpr': return E(String(this.offsetofValue(n)));
        case 'VAArgExpr': {
            const ap = this.rv(kids(n)[0]);
            return E(`${par(ap, PREC.call)}.next()`, PREC.call);
        }
        case 'ImplicitValueInitExpr': {
            const t = this.T(n);
            if (t.k === 'rec' || t.k === 'arr') this.err(n, 'aggregate zero value in an expression');
            return E(this.zero(t));
        }
        case 'InitListExpr': this.err(n, 'initializer list in an expression');
        // eslint-disable-next-line no-fallthrough
        default: this.err(n, `unsupported expression ${n.kind}`);
        }
        return null;
    }

    /**
     * Readability plan P1 (method/readability-plan.md): patch 003 (hack.h) defines
     * `rn2(x)` (and rnd, rnl, d, rne, rnz) as
     *     rng_log_enabled() ? (rng_log_set_caller(__FILE__, __LINE__, __func__), rn2(x)) : rn2(x)
     * The tag only labels the RNG log line with the C caller, and getRngLog() strips it
     * (the judge compares calls and values only). The expansion is emitted as its else
     * branch, the plain call: the same RNG calls in the same order. Returns that branch,
     * or null when n is not this expansion. Patch 004's explicit tags for Lua calls
     * (nhl_rnglog_set_lua_caller) are ordinary C code and stay.
     */
    rngTagMacro(n) {
        const callee = (x) => {
            x = this.stripCasts(x);
            if (!x || x.kind !== 'CallExpr') return null;
            const f = this.stripCasts(kids(x)[0]);
            return f && f.kind === 'DeclRefExpr' && f.referencedDecl && f.referencedDecl.kind === 'FunctionDecl' ? f.referencedDecl.name : null;
        };
        const [c, a, b] = kids(n);
        if (callee(c) !== 'rng_log_enabled' || kids(this.stripCasts(c)).length !== 1) return null;
        const a0 = this.skipParens(a);
        if (!a0 || a0.kind !== 'BinaryOperator' || a0.opcode !== ',') return null;
        const [tag, call] = kids(a0);
        const fn = callee(call);
        if (callee(tag) !== 'rng_log_set_caller' || !RNG_TAGGED.has(fn) || callee(b) !== fn) return null;
        return b;
    }

    declRef(n, ctx) {
        const d = n.referencedDecl;
        if (d.kind === 'EnumConstantDecl') {
            const v = this.S.enumConsts.get(d.name);
            if (v === undefined) this.err(n, `unknown enum constant ${d.name}`);
            const e = intLit(v, this.T(n));
            return E(`${e.c} /* ${d.name} */`, e.p);
        }
        if (d.kind === 'FunctionDecl') return E(this.prog.functionRef(this, d.name));
        return this.lvalue(n).get();
    }

    // ---------- lvalues ----------
    /**
     * An lvalue as { get(), set(vCode), addr(), t, simple }.
     * get() -> E; set(v) -> E of the assignment (value = the stored value).
     */
    lvalue(n) {
        n = this.skipParens(n);
        const t = this.T(n);
        switch (n.kind) {
        case 'DeclRefExpr': {
            const d = n.referencedDecl;
            if (d.kind === 'FunctionDecl') return { t, get: () => E(this.prog.functionRef(this, d.name)), addr: () => E(this.prog.functionRef(this, d.name)), simple: true };
            const v = this.fn && this.fn.locals.get(d.id);
            let base;
            let boxed = false;
            if (v) { base = v.name; boxed = v.boxed; }
            else base = this.prog.globalRef(this, d.name, t);
            if (boxed) {
                return { t, simple: true, get: () => E(`${base}[0]`, PREC.call), set: (x) => E(`${base}[0] = ${x}`, PREC.assign), addr: () => E(`new $c.Ptr(${base}, 0)`, PREC.call) };
            }
            const ref = this.prog.isBoxedGlobal(this, d.name);
            if (!v && ref) {
                return { t, simple: true, get: () => E(`${base}[0]`, PREC.call), set: (x) => E(`${base}[0] = ${x}`, PREC.assign), addr: () => E(`new $c.Ptr(${base}, 0)`, PREC.call) };
            }
            const isG = base.startsWith('$G.');
            return {
                t, simple: true,
                get: () => E(base, base.includes('.') ? PREC.call : PREC.prim),
                set: (x) => E(`${base} = ${x}`, PREC.assign),
                addr: () => {
                    if (t.k === 'rec') return E(base);
                    if (t.k === 'arr') return E(`new $c.Ptr([${base}], 0)`, PREC.call);
                    if (isG) return E(`new $c.FieldRef($G, ${jsStr(base.slice(3))}, ${jsStr(this.serialKind(t))})`, PREC.call);
                    this.err(n, `address of unboxed variable ${base}`);
                    return null;
                },
            };
        }
        case 'MemberExpr': {
            const baseN = kids(n)[0];
            const f = this.S.fieldById.get(n.referencedMemberDecl) || this.fieldByName(baseN, n);
            const fname = field(f.js);
            let objE;
            if (n.isArrow) objE = this.rv(baseN);
            else objE = this.lvalue(baseN).get();
            const simple = this.isSimple(baseN);
            const mk = (o) => {
                const acc = `${par(o, PREC.call)}.${fname}`;
                return {
                    t, simple, objE: o,
                    get: () => E(acc, PREC.call),
                    set: (x) => E(`${acc} = ${f.bits !== null ? this.bitStore(x, f) : x}`, PREC.assign),
                    addr: () => {
                        if (t.k === 'rec') return E(acc, PREC.call);
                        if (t.k === 'arr') return E(`new $c.Ptr([${acc}], 0)`, PREC.call);
                        if (f.bits !== null) this.err(n, 'address of a bit-field');
                        return E(`new $c.FieldRef(${o.c}, ${jsStr(fname)}, ${jsStr(this.serialKind(t))})`, PREC.call);
                    },
                    rebase: mk,
                };
            };
            return mk(objE);
        }
        case 'ArraySubscriptExpr': {
            const [a, i] = kids(n);
            // decayed array lvalue: index it directly
            const a0 = this.skipParens(a);
            const idx = this.rv(i);
            const idxC = this.toIndex(idx, this.T(i));
            if (a0.kind === 'ImplicitCastExpr' && a0.castKind === 'ArrayToPointerDecay') {
                const arr = this.lvalue(kids(a0)[0]).get();
                const acc = `${par(arr, PREC.call)}[${idxC}]`;
                return {
                    t, simple: this.isSimple(a0) && this.isSimple(i),
                    get: () => E(acc, PREC.call),
                    set: (x) => E(`${acc} = ${x}`, PREC.assign),
                    addr: () => (t.k === 'rec' ? E(`$c.relem(${arr.c}, ${idxC})`, PREC.call) : E(`new $c.Ptr(${arr.c}, ${idxC})`, PREC.call)),
                };
            }
            const pt = this.T(a);
            if (!isPtr(pt)) this.err(n, 'subscript of a non-pointer (index[array] form?)');
            const p = this.rv(a);
            const simple = this.isSimple(a) && this.isSimple(i);
            if (pkind(pt) === 'rec' || t.k === 'rec') {
                const acc = E(`$c.radd(${p.c}, ${idxC})`, PREC.call);
                return { t, simple, get: () => acc, set: () => this.err(n, 'assignment to a record through a subscript'), addr: () => acc, rec: true };
            }
            return {
                t, simple,
                get: () => E(`${par(p, PREC.call)}.get(${idxC})`, PREC.call),
                set: (x) => E(`${par(p, PREC.call)}.set(${idxC}, ${x})`, PREC.call),
                addr: () => E(`${par(p, PREC.call)}.add(${idxC})`, PREC.call),
            };
        }
        case 'UnaryOperator':
            if (n.opcode === '*') {
                const pn = kids(n)[0];
                const pt = this.T(pn);
                const p = this.rv(pn);
                if (pt.k === 'ptr' && (pkind(pt) === 'rec' || pkind(pt) === 'fn' || t.k === 'rec')) {
                    return { t, simple: this.isSimple(pn), get: () => p, set: () => this.err(n, 'assignment through *record pointer'), addr: () => p };
                }
                return {
                    t, simple: this.isSimple(pn),
                    get: () => E(`${par(p, PREC.call)}.get(0)`, PREC.call),
                    set: (x) => E(`${par(p, PREC.call)}.set(0, ${x})`, PREC.call),
                    addr: () => p,
                };
            }
            break;
        case 'StringLiteral': case 'PredefinedExpr': {
            const e = this.ex(n, 'v');
            return { t, simple: true, get: () => E(`${e.c}.buf`, PREC.call), addr: () => E(`new $c.Ptr([${e.c}.buf], 0)`, PREC.call), lit: e };
        }
        case 'CallExpr': {   // record-returning call used as an lvalue base (f().x)
            const e = this.rv(n);
            return { t, simple: false, get: () => e, set: () => this.err(n, 'assignment to a call result'), addr: () => e };
        }
        case 'ConditionalOperator': case 'BinaryOperator': case 'CompoundAssignOperator': {
            // record-valued (a ? s1 : s2).f or (s = t).f
            const e = this.rv(n);
            return { t, simple: false, get: () => e, set: () => this.err(n, 'assignment to an rvalue'), addr: () => e };
        }
        default: break;
        }
        this.err(n, `unsupported lvalue ${n.kind}`);
        return null;
    }
    fieldByName(baseN, n) {
        let bt = this.T(baseN);
        if (n.isArrow) bt = bt.to;
        if (bt.k !== 'rec') this.err(n, 'member of a non-record');
        const L = this.S.recordLayout(bt.key);
        const f = L.fields.find((x) => x.name === n.name);
        if (!f) this.err(n, `no field ${n.name} in ${bt.key}`);
        return f;
    }
    bitStore(x, f) {
        const w = f.bits;
        if (f.type.signed) return w >= 32 ? `(${x}) | 0` : `((${x}) << ${32 - w}) >> ${32 - w}`;
        return w >= 32 ? `(${x}) >>> 0` : `(${x}) & ${(2 ** w - 1)}`;
    }
    toIndex(e, t) {
        if (is64(t)) return `$c.idx(${e.c})`;   // 64-bit index: Number (throws if not safe)
        return e.c;
    }
    /** True when evaluating n twice is harmless and gives the same result (no side effects, no calls). */
    isSimple(n) {
        if (!n || typeof n !== 'object') return true;
        switch (n.kind) {
        case 'CallExpr': case 'CompoundAssignOperator': case 'VAArgExpr': return false;
        case 'BinaryOperator': if (n.opcode === '=' || n.opcode === ',') return false; break;
        case 'UnaryOperator': if (n.opcode === '++' || n.opcode === '--') return false; break;
        default: break;
        }
        return kids(n).every((c) => this.isSimple(c));
    }
    /** True when n may have a side effect or read state a call could change. */
    hasEffects(n) {
        return !this.isSimple(n);
    }
    /** Bind an lvalue's object (and index) to temporaries when it is not simple. */
    stable(lv, n) {
        if (lv.simple) return lv;
        if (lv.rebase && lv.objE) {
            const t = this.temp();
            const pre = `${t} = ${lv.objE.c}`;
            const l2 = lv.rebase(E(t));
            l2.pre = pre;
            return l2;
        }
        // generic: evaluate the address once
        const t = this.temp();
        const a = lv.addr();
        const pre = `${t} = ${a.c}`;
        const lt = lv.t;
        if (lt.k === 'rec') return { t: lt, simple: true, pre, get: () => E(t), set: lv.set, addr: () => E(t) };
        return { t: lt, simple: true, pre, get: () => E(`${t}.get(0)`, PREC.call), set: (x) => E(`${t}.set(0, ${x})`, PREC.call), addr: () => E(t) };
    }
    withPre(lv, e) { return lv.pre ? E(`${lv.pre}, ${par(e, PREC.assign)}`, PREC.comma) : e; }

    // ---------- casts ----------
    cast(n, ctx) {
        const sub = kids(n)[0];
        const to = this.T(n);
        switch (n.castKind) {
        case 'LValueToRValue': {
            const lv = this.lvalue(sub);
            if (to.k === 'rec') return lv.get();   // record rvalue: the object (copies happen at stores)
            return lv.get();
        }
        case 'NoOp': return this.ex(sub, ctx);
        case 'ToVoid': return this.ex(sub, 'd');
        case 'FunctionToPointerDecay': case 'BuiltinFnToFnPtr': return this.ex(sub, 'v');
        case 'ArrayToPointerDecay': {
            const s0 = this.skipParens(sub);
            if (s0.kind === 'StringLiteral' || s0.kind === 'PredefinedExpr') return this.ex(s0, 'v');
            const at = this.T(sub);
            const arr = this.lvalue(sub).get();
            if (at.of.k === 'rec') return E(`$c.relem(${arr.c}, 0)`, PREC.call);
            return E(`new $c.Ptr(${arr.c}, 0)`, PREC.call);
        }
        case 'NullToPointer': return E('null');
        case 'BitCast': {
            const from = this.T(sub);
            const e = this.rv(sub);
            // void * (malloc's RawBlock, or any pointer) -> typed pointer: materialize once (js/crt/alloc.js)
            if (isPtr(from) && isPtr(to) && pkind(to) === 'rec' && pkind(from) !== 'rec' && this.S.records.has(to.to.key)) {
                return E(`$c.asRec(${e.c}, $T.${this.cls(to.to.key)}, ${this.S.sizeof(to.to)})`, PREC.call);
            }
            // (char *) (p + 1) for a record with a trailing area (annotations types[].tail)
            if (isPtr(from) && isPtr(to) && pkind(from) === 'rec' && to.to.k === 'int' && to.to.size === 1 && this.prog.tails.has(from.to.key)) {
                const s0 = this.skipParens(sub);
                if (s0.kind === 'BinaryOperator' && s0.opcode === '+' && this.fold(kids(s0)[1]) !== null && Number(this.fold(kids(s0)[1])) === 1) {
                    return E(`$c.recTail(${this.rv(kids(s0)[0]).c})`, PREC.call);
                }
            }
            // void *, and long * (alloc()'s return type, still an untyped block) -> typed pointer
            const fromLong = isPtr(from) && from.to.k === 'int' && from.to.size === 8;
            if (isPtr(from) && isPtr(to) && (pkind(from) === 'void' || fromLong) && pkind(to) === 'ref' && !(to.to.k === 'int' && to.to.size === 8)) {
                const el = to.to;
                const view = typedArrayOf(el) || (el.k === 'ptr' ? "'ptr'" : el.k === 'int' ? "'i64'" : null);
                if (view) return E(`$c.asArr(${e.c}, ${view})`, PREC.call);
            }
            // char * <-> unsigned char * (and other scalar element types): a view with the new signedness
            if (isPtr(from) && isPtr(to) && typedArrayOf(to.to) && typedArrayOf(from.to) && typedArrayOf(to.to) !== typedArrayOf(from.to)) {
                return E(`$c.retype(${e.c}, ${typedArrayOf(to.to)})`, PREC.call);
            }
            return e;
        }
        case 'IntegralCast': return this.convInt(this.rv(sub), this.T(sub), to);
        case 'IntegralToBoolean': return this.boolVal(E(`${par(this.rv(sub), PREC.eq)} != 0`, PREC.eq), ctx);
        case 'PointerToBoolean': return this.boolVal(E(`${par(this.rv(sub), PREC.eq)} !== null`, PREC.eq), ctx);
        case 'FloatingToBoolean': return this.boolVal(E(`${par(this.rv(sub), PREC.eq)} !== 0`, PREC.eq), ctx);
        case 'IntegralToFloating': {
            const from = this.T(sub);
            const e = this.rv(sub);
            const d = is64(from) ? E(`Number(${e.c})`, PREC.call) : e;
            return to.size === 4 ? E(`Math.fround(${d.c})`, PREC.call) : d;
        }
        case 'FloatingToIntegral': {
            const e = this.rv(sub);
            const h = to.size === 8 ? (to.signed ? 'dtoi64' : 'dtou64') : (to.signed ? 'dtoi32' : 'dtou32');
            const v = E(`$c.${h}(${e.c})`, PREC.call);
            return to.size < 4 ? this.convInt(v, { k: 'int', size: 4, signed: to.signed }, to) : v;
        }
        case 'FloatingCast': return to.size === 4 ? E(`Math.fround(${this.rv(sub).c})`, PREC.call) : this.rv(sub);
        case 'IntegralToPointer': return E(`$c.ptrConst(${this.rv(sub).c})`, PREC.call);
        case 'PointerToIntegral': return this.convInt(E(`$c.ptrToInt(${this.rv(sub).c})`, PREC.call), { k: 'int', size: 8, signed: false }, to);
        default: this.err(n, `unsupported cast ${n.castKind}`);
        }
        return null;
    }
    /** Integer conversion of value e from type `from` to type `to`. */
    convInt(e, from, to) {
        if (to.k !== 'int') return e;
        if (from.k !== 'int') return e;
        if (to.size === from.size && to.signed === from.signed) return e;
        if (to.size === 1) return E(`$c.${to.signed ? 'i8' : 'u8'}(${e.c})`, PREC.call);
        if (to.size === 2) return E(`$c.${to.signed ? 'i16' : 'u16'}(${e.c})`, PREC.call);
        if (to.size === 4) {
            if (from.size < 4 && to.signed) return e;                  // widening into int
            if (from.size < 4 && !from.signed === true) return e;      // unsigned narrow -> unsigned int: same value
            if (from.size === 4 || from.size < 4) return to.signed ? E(`${par(e, PREC.bor)} | 0`, PREC.bor) : E(`${par(e, PREC.shift)} >>> 0`, PREC.shift);
            return E(`$c.${to.signed ? 'i32' : 'u32'}(${e.c})`, PREC.call);
        }
        // to 64-bit
        if (to.signed) {
            if (from.size < 8) return e;                               // widening: same value
            return E(`$c.i64(${e.c})`, PREC.call);
        }
        if (from.size < 8 && !from.signed) return e;                   // unsigned widening: same value
        return E(`$c.u64(${e.c})`, PREC.call);
    }

    // ---------- operators ----------
    binary(n, ctx) {
        const op = n.opcode;
        const [a, b] = kids(n);
        if (op === '=') return this.assign(n, a, b, ctx);
        if (op === ',') return E(`${par(this.ex(a, 'd'), PREC.comma)}, ${par(this.ex(b, ctx === 'd' ? 'd' : 'v'), PREC.assign)}`, PREC.comma);
        if (op === '&&' || op === '||') {
            const e = E(`${par(this.cond(a), op === '&&' ? PREC.and : PREC.or)} ${op} ${par(this.cond(b), (op === '&&' ? PREC.and : PREC.or) + 1)}`, op === '&&' ? PREC.and : PREC.or);
            return ctx === 'd' ? e : this.boolVal(e, ctx);
        }
        const t = this.T(n);
        const ta = this.T(a), tb = this.T(b);
        // pointer arithmetic and comparison
        if (isPtr(ta) || isPtr(tb)) return this.ptrBinary(n, op, a, b, ta, tb, ctx);
        const A = this.rv(a), B = this.rv(b);
        if (['<', '>', '<=', '>=', '==', '!='].includes(op)) {
            const jop = op === '==' ? '===' : op === '!=' ? '!==' : op;
            if (isFloat(ta) && (op === '==' || op === '!=')) return this.boolVal(E(`${par(A, PREC.eq)} ${op === '==' ? '===' : '!=='} ${par(B, PREC.eq + 1)}`, PREC.eq), ctx);
            const p = op === '==' || op === '!=' ? PREC.eq : PREC.rel;
            return this.boolVal(E(`${par(A, p)} ${jop} ${par(B, p + 1)}`, p), ctx);
        }
        if (isFloat(t)) {
            const p = op === '+' || op === '-' ? PREC.add : PREC.mul;
            const e = E(`${par(A, p)} ${op} ${par(B, p + 1)}`, p);
            return t.size === 4 ? E(`Math.fround(${e.c})`, PREC.call) : e;
        }
        return this.intOp(op, A, B, t, this.T(a), this.T(b));
    }
    intOp(op, A, B, t, ta) {
        if (t.size === 8) {
            const name = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem', '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'shr' }[op];
            return E(`$c.${name}${t.signed ? '64' : 'u64'}(${A.c}, ${B.c})`, PREC.call);
        }
        if (t.size !== 4) throw new EmitError(`integer operation on ${show(t)}`);
        void ta;
        if (t.signed) {
            switch (op) {
            case '+': case '-': return E(`${par(E(`${par(A, PREC.add)} ${op} ${par(B, PREC.add + 1)}`, PREC.add), PREC.bor)} | 0`, PREC.bor);
            case '*': return E(`Math.imul(${A.c}, ${B.c})`, PREC.call);
            case '/': return E(`$c.div32(${A.c}, ${B.c})`, PREC.call);
            case '%': return E(`$c.rem32(${A.c}, ${B.c})`, PREC.call);
            case '&': return E(`${par(A, PREC.band)} & ${par(B, PREC.band + 1)}`, PREC.band);
            case '|': return E(`${par(A, PREC.bor)} | ${par(B, PREC.bor + 1)}`, PREC.bor);
            case '^': return E(`${par(A, PREC.bxor)} ^ ${par(B, PREC.bxor + 1)}`, PREC.bxor);
            case '<<': return E(`${par(A, PREC.shift)} << ${par(this.shiftCount(B), PREC.shift + 1)}`, PREC.shift);
            case '>>': return E(`${par(A, PREC.shift)} >> ${par(this.shiftCount(B), PREC.shift + 1)}`, PREC.shift);
            default: break;
            }
        } else {
            const u = (e) => E(`${par(e, PREC.shift)} >>> 0`, PREC.shift);
            switch (op) {
            case '+': case '-': return u(E(`${par(A, PREC.add)} ${op} ${par(B, PREC.add + 1)}`, PREC.add));
            case '*': return u(E(`Math.imul(${A.c}, ${B.c})`, PREC.call));
            case '/': return E(`$c.divu32(${A.c}, ${B.c})`, PREC.call);
            case '%': return E(`$c.remu32(${A.c}, ${B.c})`, PREC.call);
            case '&': return u(E(`${par(A, PREC.band)} & ${par(B, PREC.band + 1)}`, PREC.band));
            case '|': return u(E(`${par(A, PREC.bor)} | ${par(B, PREC.bor + 1)}`, PREC.bor));
            case '^': return u(E(`${par(A, PREC.bxor)} ^ ${par(B, PREC.bxor + 1)}`, PREC.bxor));
            case '<<': return u(E(`${par(A, PREC.shift)} << ${par(this.shiftCount(B), PREC.shift + 1)}`, PREC.shift));
            case '>>': return E(`${par(A, PREC.shift)} >>> ${par(this.shiftCount(B), PREC.shift + 1)}`, PREC.shift);
            default: break;
            }
        }
        throw new EmitError(`operator ${op}`);
    }
    shiftCount(B) { return /^\d+n$/.test(B.c) ? E(B.c.slice(0, -1)) : (/n$/.test(B.c) ? E(`Number(${B.c})`, PREC.call) : B); }

    ptrBinary(n, op, a, b, ta, tb, ctx) {
        if (['==', '!='].includes(op)) {
            const A = this.rv(a), B = this.rv(b);
            const fnp = (isPtr(ta) && pkind(ta) === 'fn') || (isPtr(tb) && pkind(tb) === 'fn');
            if (fnp || B.c === 'null' || A.c === 'null') {
                return this.boolVal(E(`${par(A, PREC.eq)} ${op === '==' ? '===' : '!=='} ${par(B, PREC.eq + 1)}`, PREC.eq), ctx);
            }
            const e = E(`$c.peq(${A.c}, ${B.c})`, PREC.call);
            return this.boolVal(op === '==' ? e : E(`!${par(e, PREC.unary)}`, PREC.unary), ctx);
        }
        if (['<', '>', '<=', '>='].includes(op)) {
            return this.boolVal(E(`$c.pcmp(${this.rv(a).c}, ${this.rv(b).c}) ${op} 0`, PREC.rel), ctx);
        }
        if (op === '-' && isPtr(ta) && isPtr(tb)) {
            const h = pkind(ta) === 'rec' ? 'rdiff' : 'pdiff';
            return E(`$c.${h}(${this.rv(a).c}, ${this.rv(b).c})`, PREC.call);
        }
        if (op === '+' || op === '-') {
            const [p, i, pt, it] = isPtr(ta) ? [a, b, ta, this.T(b)] : [b, a, tb, this.T(a)];
            const P = this.rv(p);
            let I = this.rv(i);
            if (is64(it)) I = E(`$c.idx(${I.c})`, PREC.call);
            if (op === '-') I = E(`${neg(I)}`, PREC.unary);
            return this.padd(P, I, pt);
        }
        this.err(n, `pointer operator ${op}`);
        return null;
    }
    padd(P, I, pt) {
        if (I.c === '0') return P;
        if (pkind(pt) === 'rec') return E(`$c.radd(${P.c}, ${I.c})`, PREC.call);
        return E(`${par(P, PREC.call)}.add(${I.c})`, PREC.call);
    }

    assign(n, a, b, ctx) {
        const t = this.T(n);
        if (t.k === 'rec') {
            // struct assignment: copy into the destination object
            const lv = this.lvalue(a);
            const dst = lv.get();
            const src = this.rv(b);
            const e = E(`${par(dst, PREC.call)}.$copyFrom(${src.c})`, PREC.call);
            return e;
        }
        let lv = this.lvalue(a);
        const R = this.rv(b);
        // clang evaluates the right side first (design 4.1); keep that order when the
        // lvalue's evaluation could observe or change the right side's effects.
        if (!this.isSimple(b) && !lv.simple) {
            const tmp = this.temp();
            lv = this.stable(lv, a);
            const set = lv.set(tmp);
            const parts = [`${tmp} = ${R.c}`];
            if (lv.pre) parts.push(lv.pre);
            parts.push(set.c);
            return E(parts.join(', '), PREC.comma);
        }
        if (!this.isSimple(b) && this.lvalueReadsState(a)) {
            const tmp = this.temp();
            return E(`${tmp} = ${R.c}, ${lv.set(tmp).c}`, PREC.comma);
        }
        return lv.set(R.c);
    }
    /** An lvalue whose location depends on mutable state (pointer deref or member through a pointer, global index). */
    lvalueReadsState(a) {
        a = this.skipParens(a);
        if (a.kind === 'DeclRefExpr') return false;
        return true;
    }

    compoundAssign(n, ctx) {
        const [a, b] = kids(n);
        const op = n.opcode.slice(0, -1);
        const lt = this.T(a);
        const ct = this.S.type(n.computeLHSType.desugaredQualType || n.computeLHSType.qualType);
        const rt = this.S.type(n.computeResultType.desugaredQualType || n.computeResultType.qualType);
        const R = this.rv(b);
        let lv = this.lvalue(a);
        let pre = [];
        let Rc = R;
        if (!this.isSimple(b) && (!lv.simple || this.lvalueReadsState(a))) {
            const tmp = this.temp();
            pre.push(`${tmp} = ${R.c}`);
            Rc = E(tmp);
        }
        lv = this.stable(lv, a);
        if (lv.pre) pre.push(lv.pre);
        const cur = lv.get();
        let v;
        if (isPtr(lt)) {
            let I = Rc;
            if (is64(this.T(b))) I = E(`$c.idx(${I.c})`, PREC.call);
            if (op === '-') I = E(`${neg(I)}`, PREC.unary);
            v = this.padd(cur, I, lt);
        } else if (isFloat(ct)) {
            const L = isInt(lt) ? (is64(lt) ? E(`Number(${cur.c})`, PREC.call) : cur) : cur;
            const p = op === '+' || op === '-' ? PREC.add : PREC.mul;
            v = E(`${par(L, p)} ${op} ${par(Rc, p + 1)}`, p);
            if (ct.size === 4) v = E(`Math.fround(${v.c})`, PREC.call);
            if (isInt(lt)) {
                const h = lt.size === 8 ? (lt.signed ? 'dtoi64' : 'dtou64') : (lt.signed ? 'dtoi32' : 'dtou32');
                v = E(`$c.${h}(${v.c})`, PREC.call);
                if (lt.size < 4) v = this.convInt(v, { k: 'int', size: 4, signed: lt.signed }, lt);
            }
        } else {
            const L = this.convInt(cur, lt, ct);
            v = this.intOp(op, L, Rc, rt, ct);
            v = this.convInt(v, rt, lt);
        }
        const set = lv.set(v.c);
        if (!pre.length) return set;
        return E([...pre, set.c].join(', '), PREC.comma);
    }

    unary(n, ctx) {
        const op = n.opcode;
        const sub = kids(n)[0];
        const t = this.T(n);
        switch (op) {
        case '&': {
            const s0 = this.skipParens(sub);
            if (s0.kind === 'UnaryOperator' && s0.opcode === '*') return this.rv(kids(s0)[0]);
            const st = this.T(sub);
            if (st.k === 'fn') return this.rv(sub);
            return this.lvalue(sub).addr();
        }
        case '*': return this.lvalue(n).get();
        case '!': {
            const e = E(`!${par(this.cond(sub), PREC.unary)}`, PREC.unary);
            return this.boolVal(e, ctx);
        }
        case '-': {
            const A = this.rv(sub);
            if (isFloat(t)) return E(`${neg(A)}`, PREC.unary);
            if (t.size === 8) return E(`$c.${t.signed ? 'neg64' : 'negu64'}(${A.c})`, PREC.call);
            if (t.signed) return E(`${neg(A)} | 0`, PREC.bor);
            return E(`${neg(A)} >>> 0`, PREC.shift);
        }
        case '+': return this.rv(sub);
        case '~': {
            const A = this.rv(sub);
            if (t.size === 8) return E(`$c.${t.signed ? 'not64' : 'notu64'}(${A.c})`, PREC.call);
            if (t.signed) return E(`~${par(A, PREC.unary)}`, PREC.unary);
            return E(`~${par(A, PREC.unary)} >>> 0`, PREC.shift);
        }
        case '__extension__': return this.ex(sub, ctx);
        case '++': case '--': return this.incdec(n, sub, op, ctx);
        default: this.err(n, `unary ${op}`);
        }
        return null;
    }
    incdec(n, sub, op, ctx) {
        const t = this.T(sub);
        let lv = this.stable(this.lvalue(sub), sub);
        const cur = lv.get();
        const one = E(op === '++' ? '1' : '-1', op === '++' ? PREC.prim : PREC.unary);
        // the new value computed from `v` (the operand, or the postfix temporary)
        const next = (v) => {
            if (isPtr(t)) return this.padd(v, one, t);
            if (isFloat(t)) return E(`${par(v, PREC.add)} ${op === '++' ? '+' : '-'} 1`, PREC.add);
            if (t.k === 'int') {
                if (t.size === 8) return E(`$c.${op === '++' ? 'add' : 'sub'}${t.signed ? '64' : 'u64'}(${v.c}, 1)`, PREC.call);
                const sum = E(`${par(v, PREC.add)} ${op === '++' ? '+' : '-'} 1`, PREC.add);
                return t.size === 4 ? (t.signed ? E(`${par(sum, PREC.bor)} | 0`, PREC.bor) : E(`${par(sum, PREC.shift)} >>> 0`, PREC.shift))
                    : E(`$c.${t.signed ? 'i' : 'u'}${t.size * 8}(${sum.c})`, PREC.call);
            }
            this.err(n, `++/-- on ${show(t)}`);
        };
        const pre = lv.pre ? [lv.pre] : [];
        if (ctx === 'd' || n.isPostfix === false) {
            const set = lv.set(next(cur).c);
            return pre.length ? E([...pre, set.c].join(', '), PREC.comma) : set;
        }
        // postfix with a used value: old value through a temporary
        const tmp = this.temp();
        return E([...pre, `${tmp} = ${cur.c}`, lv.set(next(E(tmp, PREC.prim)).c).c, tmp].join(', '), PREC.comma);
    }

    sizeofExpr(n) {
        const t = n.argType ? this.S.type(n.argType.desugaredQualType || n.argType.qualType) : this.T(kids(n)[0]);
        if (n.name === 'sizeof') return E(String(this.S.sizeof(t)));
        if (n.name === 'alignof' || n.name === '_Alignof' || n.name === '__alignof') return E(String(this.S.alignof(t)));
        this.err(n, `unsupported ${n.name}`);
        return null;
    }
    /**
     * The OffsetOfExprs of a TU, in AST (source) order, pair one to one with the
     * __builtin_offsetof( occurrences of its preprocessed text: [, type, member path].
     */
    offsetofFromPreprocessed(n) {
        if (!this.tu.entry) return null;
        if (!this._ofs) {
            const nodes = [];
            const walk = (x) => { if (!x || typeof x !== 'object') return; if (x.kind === 'OffsetOfExpr') nodes.push(x); for (const c of kids(x)) walk(c); };
            walk(this.tu.root);
            const text = preprocess(this.tu.entry);
            const occ = [];
            const re = /__builtin_offsetof\s*\(/g;
            let mm;
            while ((mm = re.exec(text))) {
                // the balanced argument text
                let i = re.lastIndex, depth = 1;
                while (depth && i < text.length) { const ch = text[i++]; if (ch === '(') depth++; else if (ch === ')') depth--; }
                const inner = text.slice(re.lastIndex, i - 1);
                const comma = inner.lastIndexOf(',');
                occ.push([null, inner.slice(0, comma).trim(), inner.slice(comma + 1).trim()]);
            }
            if (occ.length !== nodes.length) this.err(n, `offsetof: ${nodes.length} AST nodes but ${occ.length} in the preprocessed text`);
            this._ofs = new Map(nodes.map((x, i) => [x, occ[i]]));
        }
        return this._ofs.get(n) || null;
    }
    offsetofValue(n) {
        // the JSON AST has no member path for offsetof: read it from the source text
        const r = n.range && n.range.begin;
        const b = r && (r.expansionLoc || r);
        const e = n.range && n.range.end && (n.range.end.expansionLoc || n.range.end);
        if (!b || b.offset === undefined || !e) this.err(n, 'offsetof without a source range');
        const file = path.resolve(this.prog.root, b._f);
        let text = this.texts.get(file);
        if (!text) { text = readFileSync(file, 'latin1'); this.texts.set(file, text); }
        const src = text.slice(b.offset, e.offset + (e.tokLen || 1));
        let m = /offsetof\s*\(\s*(.+?)\s*,\s*([A-Za-z_][\w.[\]\s]*)\)\s*$/s.exec(src);
        if (!m) m = this.offsetofFromPreprocessed(n);   // inside a macro: the k-th __builtin_offsetof of the TU
        if (!m) this.err(n, `cannot parse offsetof from ${JSON.stringify(src)}`);
        let t = this.S.type(m[1]);
        let off = 0;
        for (const part of m[2].replace(/\s+/g, '').split('.')) {
            const mm = /^(\w+)((?:\[\d+\])*)$/.exec(part);
            if (!mm || t.k !== 'rec') this.err(n, `offsetof member path ${m[2]}`);
            const f = this.S.recordLayout(t.key).fields.find((x) => x.name === mm[1]);
            if (!f) this.err(n, `offsetof: no field ${mm[1]}`);
            off += f.offset;
            t = f.type;
            for (const ix of mm[2].match(/\d+/g) || []) { off += Number(ix) * this.S.sizeof(t.of); t = t.of; }
        }
        return off;
    }

    // ---------- calls ----------
    call(n, ctx) {
        const [callee, ...args] = kids(n);
        const c0 = this.stripCasts(callee);
        let fnName = null;
        if (c0.kind === 'DeclRefExpr' && c0.referencedDecl.kind === 'FunctionDecl') fnName = c0.referencedDecl.name;
        const special = fnName && this.specialCall(fnName, args, n, ctx);
        if (special) return special;
        const argc = args.map((a) => this.argValue(a));
        let f;
        if (fnName) f = this.prog.functionRef(this, fnName);
        else f = par(this.rv(callee), PREC.call);
        let asyncCall;
        if (fnName && f.startsWith('$c.') && !f.startsWith('$c.missing(')) {
            // runtime (or hand-written) function: async only through a callback argument that may
            // be async, and then through its `$async` twin (signal handlers never run)
            asyncCall = this.prog.blockingCrt.has(fnName) || (fnName !== 'signal' && args.some((a) => this.mayBeAsyncFn(a)));
            if (asyncCall) {
                if (!this.prog.crt.has(`${fnName}$async`)) this.err(n, `possibly async callback passed to runtime function ${fnName}, which has no $async variant`);
                f = `$c.${fnName}$async`;
            }
        } else asyncCall = fnName ? this.prog.isAsync(this, fnName) : this.prog.isAsyncIndirect(this, this.T(callee));
        let e = E(`${f}(${argc.join(', ')})`, PREC.call);
        if (asyncCall) {
            if (!this.fn || !this.fn.isAsync) this.err(n, `await of ${fnName || 'an indirect call'} in a function outside the async set`);
            e = E(`await ${par(e, PREC.unary)}`, PREC.unary);
        }
        return e;
    }
    /** Whether an argument is a function (pointer) that may be async. */
    mayBeAsyncFn(a) {
        const s = this.stripCasts(a);
        if (s.kind === 'DeclRefExpr' && s.referencedDecl && s.referencedDecl.kind === 'FunctionDecl') return this.prog.isAsync(this, s.referencedDecl.name);
        let t = this.tu.scope.resolve(this.T(a));
        if (t.k === 'ptr') t = this.tu.scope.resolve(t.to);
        return t.k === 'fn' && this.prog.isAsyncIndirect(this, t);
    }
    argValue(a) {
        const t = this.T(a);
        const v = this.rv(a);
        if (t.k === 'rec' && !this.isFresh(a)) return `${par(v, PREC.call)}.$clone()`;
        return v.c;
    }
    /** Builtins and va_* handled inline; returns null for ordinary calls. */
    specialCall(name, args, n, ctx) {
        switch (name) {
        case '__builtin_va_start': {
            const ap = this.lvalue(args[0]);
            return ap.set('new $c.VaList($va)');
        }
        case '__builtin_va_end': return E('void 0', PREC.unary);
        case '__builtin_va_copy': return this.lvalue(args[0]).set(`${this.rv(args[1]).c}.copy()`);
        case '__builtin_expect': return this.rv(args[0]);
        case '__builtin_object_size': {
            // clang folds __builtin_object_size at compile time; at -O0 (NetHack's -g build)
            // it cannot see through pointers and returns (size_t)-1 except for direct arrays.
            return E(this.objectSize(args[0], this.rv(args[1])), PREC.unary);
        }
        case '__builtin_unreachable': return E('$c.unreachable()', PREC.call);
        case '__builtin_huge_val': return E('Infinity');
        default: return null;
        }
    }
    /**
     * __builtin_object_size(arg, mode) as clang folds it at -O0 (measured:
     * tests/c-diff/corpus/c04-objsize.c). Mode 0: bytes from the pointer to the
     * end of the complete object, known only for declared objects (not through a
     * pointer). Mode 1: bytes to the end of the innermost subobject; through a
     * pointer the member's size is known unless it is the record's trailing
     * array. Anything else (pointer variables, variable indexes): -1.
     */
    objectSize(arg, modeE) {
        const mode = Number(modeE.c);
        const r = this.objAddr(arg);
        if (!r) return '-1';
        if (mode === 0 || mode === 2) return r.complete === null ? (mode === 2 ? '0' : '-1') : String(Math.max(0, r.complete - r.off));
        if (r.sub === null) return '-1';
        return String(Math.max(0, r.sub - r.subOff));
    }
    /** { complete, off, sub, subOff } for a pointer expression, or null if unknown. */
    objAddr(n) {
        n = this.skipParens(n);
        if ((n.kind === 'ImplicitCastExpr' || n.kind === 'CStyleCastExpr') && (n.castKind === 'BitCast' || n.castKind === 'NoOp')) return this.objAddr(kids(n)[0]);
        if (n.kind === 'ImplicitCastExpr' && n.castKind === 'ArrayToPointerDecay') {
            const s0 = this.skipParens(kids(n)[0]);
            if (s0.kind === 'StringLiteral') { const z = this.S.sizeof(this.T(s0)); return { complete: z, off: 0, sub: z, subOff: 0 }; }
            return this.objLv(kids(n)[0]);
        }
        if (n.kind === 'UnaryOperator' && n.opcode === '&') return this.objLv(kids(n)[0]);
        if (n.kind === 'BinaryOperator' && (n.opcode === '+' || n.opcode === '-')) {
            const [a, b] = kids(n);
            const pa = isPtr(this.T(a));
            const k = this.fold(pa ? b : a);
            if (k === null) return null;
            const r = this.objAddr(pa ? a : b);
            if (!r) return null;
            const d = Number(k) * this.S.sizeof(this.T(n).to) * (n.opcode === '-' ? -1 : 1);
            return { ...r, off: r.off + d, subOff: r.subOff + d };
        }
        return null;
    }
    objLv(n) {
        n = this.skipParens(n);
        const t = this.T(n);
        switch (n.kind) {
        case 'DeclRefExpr': {
            if (n.referencedDecl.kind !== 'VarDecl' && n.referencedDecl.kind !== 'ParmVarDecl') return null;
            const z = this.S.sizeof(t);
            return { complete: z, off: 0, sub: z, subOff: 0 };
        }
        case 'MemberExpr': {
            const base = kids(n)[0];
            const f = this.S.fieldById.get(n.referencedMemberDecl) || this.fieldByName(base, n);
            const z = this.S.sizeof(f.type);
            if (n.isArrow) {
                const rt = this.T(base).to;
                const L = this.S.recordLayout(rt.key);
                const last = L.fields[L.fields.length - 1] === f && f.type.k === 'arr';
                return { complete: null, off: 0, sub: last ? null : z, subOff: 0 };
            }
            const r = this.objLv(base);
            if (!r) return null;
            return { complete: r.complete, off: r.off + f.offset, sub: z, subOff: 0 };
        }
        case 'ArraySubscriptExpr': {
            const [a, i] = kids(n);
            const k = this.fold(i);
            const a0 = this.skipParens(a);
            if (k === null || !(a0.kind === 'ImplicitCastExpr' && a0.castKind === 'ArrayToPointerDecay')) return null;
            const r = this.objLv(kids(a0)[0]);
            if (!r) return null;
            const d = Number(k) * this.S.sizeof(t);
            return { complete: r.complete, off: r.off + d, sub: r.sub, subOff: r.subOff + d };
        }
        default: return null;
        }
    }
}
