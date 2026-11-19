// heap.mjs: heap-world code generation (transpiler-design.md 3.5, 7; decision D2).
//
// A HeapEmitter emits a TU whose data lives in the byte heap of
// js/crt/heap.js ($h) with the C layout: the Lua 5.4.8 TUs, which treat memory
// as bytes throughout (stack pointer arithmetic, GC casts, offsetof, flexible
// trailing arrays). Statements, control flow, goto/switch lowering, integer
// and floating arithmetic and the async transform are inherited from
// TUEmitter; what changes is where values live:
//   - pointers are Numbers (byte addresses, 0 = NULL); function pointers are
//     function-table indices ($h.fn(f), called through $h.fnAt(p));
//   - records and arrays are always in memory; a record rvalue is its address,
//     assignment copies bytes ($h.copy), a by-value parameter is copied into
//     the callee's frame, a returned record goes through $h.ret;
//   - globals and static locals are static data ($h.data at module evaluation;
//     $init zeroes and re-initializes them for each run);
//   - address-taken scalar locals, and all record/array locals, live in a stack
//     frame ($h.enter / restored in finally); other scalars are JS locals.
// Calls into the object-world runtime ($c) pass byte pointers as Ptr over the
// heap ($h.P) and scalar pointers as Ptr over a typed view ($h.PV); handles
// carry runtime objects (FILE *) through heap memory.
import { TUEmitter, EmitError, E, PREC, par, neg, kids, pkind, jsStr, decodeCString, decodeWideString } from './tu.mjs';
import { jsName } from './names.mjs';

const isPtr = (t) => t.k === 'ptr';
const isInt = (t) => t.k === 'int';
const is64 = (t) => t.k === 'int' && t.size === 8;

export class HeapEmitter extends TUEmitter {
    get heapWorld() { return true; }
    constructor(tu, prog) { super(tu, prog); this.heap = true; }

    run() {
        const code = super.run();
        return code.replace("import * as $c from '../crt/index.js';\n", "import * as $c from '../crt/index.js';\nimport * as $h from '../crt/heap.js';\nimport * as $hl from '../crt/heaplibc.js';\n");
    }
    sz(t) { return this.S.sizeof(t); }
    al(t) { return this.S.alignof(t); }
    /** Element size for pointer arithmetic on pointer type pt (void *: 1, GNU). */
    esz(pt) { const to = this.S.resolve(pt.to); return to.k === 'void' || to.k === 'fn' ? 1 : this.sz(to); }

    // ---------- memory access ----------
    load(t, a) {
        t = this.S.resolve(t);
        const A = `${a}`;
        switch (t.k) {
        case 'int':
            if (t.size === 1) return E(`$h.${t.signed ? 'i8' : 'u8'}[${A}]`, PREC.call);
            if (t.size === 2) return E(`$h.${t.signed ? 'i16' : 'u16'}[${par0(A)} >>> 1]`, PREC.call);
            if (t.size === 4) return E(`$h.${t.signed ? 'i32' : 'u32'}[${par0(A)} >>> 2]`, PREC.call);
            return E(`$h.${t.signed ? 'ld64' : 'ldu64'}(${A})`, PREC.call);
        case 'float':
            return t.size === 4 ? E(`$h.f32[${par0(A)} >>> 2]`, PREC.call) : E(`$h.f64[${par0(A)} >>> 3]`, PREC.call);
        case 'ptr': case 'fn': return E(`$h.u32[${par0(A)} >>> 2]`, PREC.call);
        case 'rec': case 'arr': return E(A, /^[\w$.]+$/.test(A) ? PREC.prim : PREC.add);
        default: throw new EmitError(`heap load of ${t.k}`);
        }
    }
    store(t, a, v) {
        t = this.S.resolve(t);
        switch (t.k) {
        case 'int':
            if (t.size === 1) return E(`$h.${t.signed ? 'i8' : 'u8'}[${a}] = ${v}`, PREC.assign);
            if (t.size === 2) return E(`$h.${t.signed ? 'i16' : 'u16'}[${par0(a)} >>> 1] = ${v}`, PREC.assign);
            if (t.size === 4) return E(`$h.${t.signed ? 'i32' : 'u32'}[${par0(a)} >>> 2] = ${v}`, PREC.assign);
            return E(`$h.st64(${a}, ${v})`, PREC.call);
        case 'float':
            return t.size === 4 ? E(`$h.f32[${par0(a)} >>> 2] = ${v}`, PREC.assign) : E(`$h.f64[${par0(a)} >>> 3] = ${v}`, PREC.assign);
        case 'ptr': case 'fn': return E(`$h.stp(${a}, ${v})`, PREC.call);
        case 'rec': case 'arr': return E(`$h.copy(${a}, ${v}, ${this.sz(t)})`, PREC.call);
        default: throw new EmitError(`heap store of ${t.k}`);
        }
    }
    /** An lvalue in memory at address expression aE. */
    mem(t, aE, simple, f = null) {
        const a = aE.c;
        if (f && f.bits !== null) return this.bitLv(t, a, simple, f);
        return {
            t, simple, heap: true, aE,
            get: () => this.load(t, a),
            set: (x) => this.store(t, a, x),
            addr: () => aE,
        };
    }
    bitLv(t, a, simple, f) {
        const ut = { k: 'int', size: this.S.sizeof(f.type) > 4 ? 8 : 4, signed: false };
        if (ut.size === 8) throw new EmitError('64-bit bit-field in the heap world');
        const sh = f.bitOffset, w = f.bits;
        const mask = w >= 32 ? 0xffffffff : 2 ** w - 1;
        const unit = this.load(ut, a).c;   // f.offset is a multiple of the unit size: aligned word read of the unit
        const get = t.signed ? E(`(${unit} << ${32 - sh - w}) >> ${32 - w}`, PREC.shift) : E(`(${unit} >>> ${sh}) & ${mask}`, PREC.band);
        return {
            t, simple, heap: true,
            get: () => get,
            set: (x) => E(`$h.u32[${par0(a)} >>> 2] = ($h.u32[${par0(a)} >>> 2] & ${~(mask << sh) >>> 0}) | (((${x}) & ${mask}) << ${sh}) >>> 0, ${t.signed ? `((${x}) << ${32 - w}) >> ${32 - w}` : `(${x}) & ${mask}`}`, PREC.comma),
            addr: () => { throw new EmitError('address of a bit-field'); },
        };
    }

    // ---------- globals ----------
    emitGlobal(g, body, init) {
        const t = this.T(g);
        const isStatic = g.storageClass === 'static';
        if (!isStatic && !this.prog.ownsVar(this, g.name)) return;
        const initExpr = g.init ? kids(g)[0] : null;
        const tt = t.k === 'arr' && t.n === null && initExpr ? this.T(initExpr) : t;
        const name = jsName(g.name);
        this.fn = null;
        body.push(`${isStatic ? '' : 'export '}const ${name} = $h.data(${this.sz(tt)}, ${this.al(tt)});`);
        init.push(`$h.zero(${name}, ${this.sz(tt)});`);
        if (initExpr) this.hInit(name, tt, initExpr, init, '');
    }
    declareStaticLocal(d) {
        const t = this.T(d);
        const nm = `${jsName(this.fn.name)}$${d.name}`;
        const tt = t.k === 'arr' && t.n === null && d.init ? this.T(kids(d)[0]) : t;
        this.fn.locals.set(d.id, { name: nm, t: tt, frame: false, isStatic: true, addrConst: nm, decl: d });
        this.staticLocals = this.staticLocals || [];
        const init = [`$h.zero(${nm}, ${this.sz(tt)});`];
        if (d.init) this.hInit(nm, tt, kids(d)[0], init, '');
        this.staticLocals.push({ decl: `const ${nm} = $h.data(${this.sz(tt)}, ${this.al(tt)});   // static in ${this.fn.name}()`, init });
    }
    /** Stores initializing the object of type t at address expression `a` (memory is already zero). */
    hInit(a, t, n, out, ind) {
        n = this.skipParens(n);
        t = this.S.resolve(t);
        if (n.kind === 'ImplicitValueInitExpr') return;
        if (t.k === 'arr' && n.kind === 'StringLiteral' && n.value[0] === 'L') {
            const w = decodeWideString(n.value);
            const m = Math.min(w.length, t.n === null ? w.length + 1 : t.n);
            if (m) out.push(`${ind}$h.i32.set([${w.slice(0, m).join(', ')}], (${a}) >>> 2);   // L${jsStr(String.fromCodePoint(...w.slice(0, 40)).replace(/[^\x20-\x7e]/g, '?'))}`);
            return;
        }
        if (t.k === 'arr' && n.kind === 'StringLiteral') {
            const s = decodeCString(n.value);
            const m = Math.min(s.length, t.n === null ? s.length + 1 : t.n);
            if (m) out.push(`${ind}$h.u8.set([${Array.from(s.slice(0, m), (c) => c.charCodeAt(0)).join(', ')}], ${a});   // ${jsStr(s.slice(0, 40))}`);
            return;
        }
        if (n.kind === 'InitListExpr') {
            const { items, filler } = this.initItems(n);
            if (t.k === 'arr') {
                const es = this.sz(t.of);
                const at = (i) => (i === 0 ? a : `${a} + ${i * es}`);
                items.forEach((it, i) => this.hInit(at(i), t.of, it, out, ind));
                if (filler && filler.kind !== 'ImplicitValueInitExpr') for (let i = items.length; i < (t.n || 0); i++) this.hInit(at(i), t.of, filler, out, ind);
                return;
            }
            if (t.k === 'rec') {
                const L = this.S.recordLayout(t.key);
                const r = this.S.record(t.key);
                const at = (f) => (f.offset === 0 ? a : `${a} + ${f.offset}`);
                if (r.union) {
                    const f = n.field ? L.fields.find((x) => x.name === n.field.name) : L.fields.find((x) => x.name || x.type.k === 'rec');
                    if (items[0]) this.hInit(at(f), f.type, items[0], out, ind);
                    return;
                }
                const fs = L.fields.filter((f) => !(f.bits !== null && !f.name));
                items.forEach((it, i) => {
                    const f = fs[i];
                    if (!f) this.err(n, `initializer for ${t.key} has too many items`);
                    if (this.skipParens(it).kind === 'ImplicitValueInitExpr') return;
                    if (f.bits !== null) out.push(`${ind}${this.bitLv(f.type, at(f), true, f).set(this.rv(it).c).c};`);
                    else this.hInit(at(f), f.type, it, out, ind);
                });
                return;
            }
            if (items[0]) out.push(`${ind}${this.store(t, a, this.rv(items[0]).c).c};`);
            return;
        }
        if (t.k === 'arr') this.err(n, `array initializer ${n.kind}`);
        out.push(`${ind}${this.store(t, a, this.rv(n).c).c};`);
    }

    // ---------- functions ----------
    emitFunction(f) {
        const t = this.T(f);
        const params = kids(f).filter((c) => c.kind === 'ParmVarDecl');
        const body = kids(f).find((c) => c.kind === 'CompoundStmt');
        this.fn = { name: f.name, decl: f, t, locals: new Map(), names: new Set(['$fp', '$sp0']), vars: [], temps: 0, tempNames: [], labels: new Map(), labelSeq: 0, isVariadic: t.variadic, isAsync: this.prog.isAsync(this, f.name), frame: 0 };
        const addrTaken = this.addressTaken(body);
        const declare = (d, isParam) => {
            let nm = jsName(d.name || 'p');
            if (this.fn.names.has(nm)) { let i = 2; while (this.fn.names.has(`${nm}$${i}`)) i++; nm = `${nm}$${i}`; }
            this.fn.names.add(nm);
            const ty = this.T(d);
            const isVa = /\bva_list\b/.test(d.type.qualType) || /__builtin_va_list/.test(d.type.qualType);
            const inFrame = !isVa && (addrTaken.has(d.id) || ty.k === 'rec' || ty.k === 'arr');
            const info = { name: nm, t: ty, isParam, isVa, decl: d, frame: inFrame, off: 0 };
            if (inFrame) {
                const al = Math.max(this.al(ty), 1);
                this.fn.frame = Math.ceil(this.fn.frame / al) * al;
                info.off = this.fn.frame;
                this.fn.frame += this.sz(ty);
            }
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
        const stmts = this.block(body, this.fn.frame ? '        ' : '    ');
        const lines = [];
        const exp = f.storageClass === 'static' ? '' : 'export ';
        const pnames = ps.map((p) => (p.frame ? `${p.name}$in` : p.name));
        if (this.fn.isVariadic) pnames.push('...$va');
        lines.push(`${exp}${this.fn.isAsync ? 'async ' : ''}function ${jsName(f.name)}(${pnames.join(', ')}) {   // ${this.posOf(f)}`);
        const decls = [];
        for (const v of this.fn.vars) if (!v.frame) decls.push(`${v.name} = ${v.isVa ? 'null' : this.hzero(v.t)}`);
        if (this.fn.usesGoto) decls.push('$goto = null');
        for (const tn of this.fn.tempNames) decls.push(tn);
        if (decls.length) lines.push(`    let ${decls.join(', ')};`);
        if (this.fn.frame) {
            lines.push(`    const $sp0 = $h.st.sp, $fp = $h.enter(${this.fn.frame});`);
            lines.push('    try {');
            for (const p of ps) if (p.frame) lines.push(`        ${this.store(p.t, this.frameAddr(p).c, `${p.name}$in`).c};`);
            lines.push(...stmts);
            lines.push('    } finally { $h.st.sp = $sp0; }');
        } else lines.push(...stmts);
        lines.push('}');
        this.fn = null;
        return lines.join('\n');
    }
    hzero(t) { t = this.S.resolve(t); return t.k === 'int' && t.size === 8 ? '0' : '0'; }
    frameAddr(v) { return v.off ? E(`$fp + ${v.off}`, PREC.add) : E('$fp'); }

    // ---------- statements that differ ----------
    stmt(n, ind) {
        if (n && n.kind === 'DeclStmt') {
            const out = [];
            for (const d of kids(n)) {
                if (d.kind !== 'VarDecl' || d.storageClass === 'static' || d.storageClass === 'extern' || !d.init) continue;
                const v = this.fn.locals.get(d.id);
                const init = kids(d)[0];
                if (v.frame) {
                    const a = this.frameAddr(v).c;
                    const t = this.S.resolve(v.t);
                    if (t.k === 'rec' || t.k === 'arr') {
                        if (t.k === 'arr' || this.skipParens(init).kind === 'InitListExpr') out.push(`${ind}$h.zero(${a}, ${this.sz(t)});`);
                    }
                    this.hInit(a, t, init, out, ind);
                } else out.push(`${ind}${v.name} = ${this.rv(init).c};`);
            }
            return out;
        }
        if (n && n.kind === 'IfStmt') {
            const sj = this.setjmpIf(n);
            if (sj) return sj(ind);
        }
        if (n && n.kind === 'ReturnStmt') {
            const e = kids(n)[0];
            const ft = this.S.resolve(this.fn.t.ret);
            if (e && ft.k === 'rec') return [`${ind}return $h.ret(${this.rv(e).c}, ${this.sz(ft)});`];
        }
        return super.stmt(n, ind);
    }
    /**
     * LUAI_TRY: `if (_setjmp(buf) == 0) { a } [else { b }]` becomes try { a } catch
     * of the LongJmp to that buffer [then b]. A longjmp unwinds the JS frames (their
     * finally blocks restore the heap stack pointer), as it unwinds the C stack.
     */
    setjmpIf(n) {
        const [c, th, el] = kids(n);
        const cc = this.skipParens(c);
        if (cc.kind !== 'BinaryOperator' || cc.opcode !== '==') return null;
        const [l, r] = kids(cc);
        const call = this.stripCasts(l);
        if (call.kind !== 'CallExpr' || this.fold(r) === null || Number(this.fold(r)) !== 0) return null;
        const f = this.stripCasts(kids(call)[0]);
        if (!(f.kind === 'DeclRefExpr' && /^_?setjmp$/.test(f.referencedDecl.name))) return null;
        return (ind) => {
            const b = this.temp();
            const out = [`${ind}${b} = ${this.rv(kids(call)[1]).c};   // setjmp buffer`, `${ind}try {`];
            out.push(...this.block(th, ind + '    '));
            out.push(`${ind}} catch ($e) {`, `${ind}    if (!($e instanceof $h.LongJmp) || $e.buf !== ${b}) throw $e;`);
            if (n.hasElse) out.push(...this.block(el, ind + '    '));
            out.push(`${ind}}`);
            return out;
        };
    }
    jmpCall(name, args, n) {
        if (/longjmp$/.test(name)) return E(`$h.longjmp(${this.rv(args[0]).c}, ${this.rv(args[1]).c})`, PREC.call);
        this.err(n, 'setjmp outside the LUAI_TRY pattern');
        return null;
    }
    declInitExpr(ds) {
        const parts = [];
        for (const d of kids(ds)) {
            if (d.kind !== 'VarDecl' || !d.init) continue;
            const v = this.fn.locals.get(d.id);
            if (v.frame) parts.push(this.store(v.t, this.frameAddr(v).c, this.rv(kids(d)[0]).c).c);
            else parts.push(`${v.name} = ${this.rv(kids(d)[0]).c}`);
        }
        return parts.join(', ');
    }

    // ---------- lvalues ----------
    lvalue(n) {
        n = this.skipParens(n);
        const t = this.T(n);
        switch (n.kind) {
        case 'DeclRefExpr': {
            const d = n.referencedDecl;
            if (d.kind === 'FunctionDecl') { const f = this.prog.heapFunctionRef(this, d.name).code; return { t, simple: true, get: () => E(`$h.fn(${f})`, PREC.call), addr: () => E(`$h.fn(${f})`, PREC.call) }; }
            const v = this.fn && this.fn.locals.get(d.id);
            if (v && v.isStatic) return this.mem(t, E(v.addrConst), true);
            if (v && v.frame) return this.mem(t, this.frameAddr(v), true);
            if (v) return { t, simple: true, get: () => E(v.name), set: (x) => E(`${v.name} = ${x}`, PREC.assign), addr: () => this.err(n, `address of register local ${v.name}`) };
            return this.mem(t, E(this.prog.heapGlobalRef(this, d.name)), true);
        }
        case 'MemberExpr': {
            const baseN = kids(n)[0];
            const f = this.S.fieldById.get(n.referencedMemberDecl) || this.fieldByName(baseN, n);
            const base = n.isArrow ? this.rv(baseN) : this.lvalue(baseN).addr();
            const aE = f.offset ? E(`${par(base, PREC.add)} + ${f.offset}`, PREC.add) : base;
            return this.mem(t, aE, this.isSimple(baseN), f);
        }
        case 'ArraySubscriptExpr': {
            const [a, i] = kids(n);
            const pt = this.T(a);
            const [P, I, it] = isPtr(pt) ? [this.rv(a), i, this.T(i)] : [this.rv(i), a, this.T(a)];
            const ptT = isPtr(pt) ? pt : this.T(i);
            return this.mem(t, this.padd(P, this.idxE(this.rv(I), it), ptT), this.isSimple(a) && this.isSimple(i));
        }
        case 'UnaryOperator':
            if (n.opcode === '*') {
                const pn = kids(n)[0];
                const pt = this.S.resolve(this.T(pn));
                const p = this.rv(pn);
                if (pt.k === 'ptr' && this.S.resolve(pt.to).k === 'fn') return { t, simple: this.isSimple(pn), get: () => p, addr: () => p };
                return this.mem(t, p, this.isSimple(pn));
            }
            break;
        case 'StringLiteral': return this.mem(t, this.ex(n, 'v'), true);
        case 'PredefinedExpr': return this.lvalue(kids(n)[0]);
        case 'CallExpr': case 'ConditionalOperator': case 'BinaryOperator': case 'CompoundAssignOperator': {
            const e = this.rv(n);   // a record value: its address
            return this.mem(t, e, false);
        }
        case 'CompoundLiteralExpr': {
            // (T){...}: a frame slot initialized in place
            const v = this.compoundSlot(n);
            const init = [];
            this.hInit(v.c, t, kids(n)[0], init, '');
            return this.mem(t, E(`($h.zero(${v.c}, ${this.sz(t)}), ${init.map((s) => s.replace(/;$/, '')).join(', ') || '0'}, ${v.c})`, PREC.prim), false);
        }
        default: break;
        }
        this.err(n, `unsupported heap lvalue ${n.kind}`);
        return null;
    }
    compoundSlot(n) {
        const t = this.T(n);
        const al = Math.max(this.al(t), 1);
        this.fn.frame = Math.ceil(this.fn.frame / al) * al;
        const off = this.fn.frame;
        this.fn.frame += this.sz(t);
        return E(`($fp + ${off})`);
    }
    stable(lv, _n) {
        if (lv.simple) return lv;
        if (!lv.heap) return lv;
        const tmp = this.temp();
        const l2 = this.mem(lv.t, E(tmp), true);
        l2.pre = `${tmp} = ${lv.addr().c}`;
        return l2;
    }
    idxE(e, t) { return is64(t) ? E(`$c.idx(${e.c})`, PREC.call) : e; }

    // ---------- expressions ----------
    ex(n, ctx) {
        if (n.kind === 'StringLiteral' && n.value[0] === 'L') return E(`$h.wlit([${decodeWideString(n.value).join(', ')}])`, PREC.call);
        if (n.kind === 'StringLiteral') return E(`$h.lit(${jsStr(decodeCString(n.value))})`, PREC.call);
        if (n.kind === 'MemberExpr' || n.kind === 'ArraySubscriptExpr') return this.lvalue(n).get();
        if (n.kind === 'CompoundLiteralExpr') return this.lvalue(n).get();
        return super.ex(n, ctx);
    }
    declRef(n, ctx) {
        const d = n.referencedDecl;
        if (d.kind === 'FunctionDecl') return E(this.prog.heapFunctionRef(this, d.name).code);   // decays below (FunctionToPointerDecay)
        return super.declRef(n, ctx);
    }
    cast(n, ctx) {
        const sub = kids(n)[0];
        const to = this.S.resolve(this.T(n));
        switch (n.castKind) {
        case 'LValueToRValue': return this.lvalue(sub).get();
        case 'ArrayToPointerDecay': return this.lvalue(sub).addr();
        case 'FunctionToPointerDecay': case 'BuiltinFnToFnPtr': {
            const s = this.stripCasts(sub);
            if (s.kind === 'DeclRefExpr' && s.referencedDecl.kind === 'FunctionDecl') return E(`$h.fn(${this.prog.heapFunctionRef(this, s.referencedDecl.name).code})`, PREC.call);
            return this.rv(sub);
        }
        case 'NullToPointer': return E('0');
        case 'BitCast': case 'NoOp': case 'AddressSpaceConversion': return this.rv(sub);
        case 'IntegralToPointer': { const e = this.rv(sub); return is64(this.T(sub)) ? E(`Number(${e.c})`, PREC.call) : (this.T(sub).signed ? E(`${par(e, PREC.shift)} >>> 0`, PREC.shift) : e); }
        case 'PointerToIntegral': return this.convInt(this.rv(sub), { k: 'int', size: 8, signed: false }, to);
        case 'PointerToBoolean': return this.boolVal(E(`${par(this.rv(sub), PREC.eq)} !== 0`, PREC.eq), ctx);
        default: return super.cast(n, ctx);
        }
    }
    ptrBinary(n, op, a, b, ta, tb, ctx) {
        const A = () => this.rv(a), B = () => this.rv(b);
        if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
            const jop = op === '==' ? '===' : op === '!=' ? '!==' : op;
            const p = op === '==' || op === '!=' ? PREC.eq : PREC.rel;
            return this.boolVal(E(`${par(A(), p)} ${jop} ${par(B(), p + 1)}`, p), ctx);
        }
        if (op === '-' && isPtr(ta) && isPtr(tb)) {
            const s = this.esz(ta);
            const d = E(`${par(A(), PREC.add)} - ${par(B(), PREC.add + 1)}`, PREC.add);
            return s === 1 ? d : E(`(${d.c}) / ${s}`, PREC.mul);
        }
        if (op === '+' || op === '-') {
            const [p, i, pt, it] = isPtr(ta) ? [a, b, ta, tb] : [b, a, tb, ta];
            let I = this.idxE(this.rv(i), it);
            if (op === '-') I = E(`${neg(I)}`, PREC.unary);
            return this.padd(this.rv(p), I, pt);
        }
        this.err(n, `pointer operator ${op}`);
        return null;
    }
    padd(P, I, pt) {
        if (I.c === '0') return P;
        const s = this.esz(this.S.resolve(pt));
        const off = s === 1 ? I : (/^-?\d+$/.test(I.c) ? E(String(Number(I.c) * s)) : E(`${par(I, PREC.mul)} * ${s}`, PREC.mul));
        if (/^-\d+$/.test(off.c)) return E(`${par(P, PREC.add)} - ${off.c.slice(1)}`, PREC.add);
        return E(`${par(P, PREC.add)} + ${par(off, PREC.add + 1)}`, PREC.add);
    }
    assign(n, a, b, ctx) {
        const t = this.S.resolve(this.T(n));
        if (t.k === 'rec') {
            const dst = this.lvalue(a).addr();
            return E(`$h.copy(${dst.c}, ${this.rv(b).c}, ${this.sz(t)})`, PREC.call);
        }
        return super.assign(n, a, b, ctx);
    }
    unary(n, ctx) {
        if (n.opcode === '&') {
            const sub = kids(n)[0];
            const s0 = this.skipParens(sub);
            if (s0.kind === 'UnaryOperator' && s0.opcode === '*') return this.rv(kids(s0)[0]);
            if (this.T(sub).k === 'fn') return this.cast({ kind: 'ImplicitCastExpr', castKind: 'FunctionToPointerDecay', inner: [sub], type: n.type }, ctx);
            return this.lvalue(sub).addr();
        }
        return super.unary(n, ctx);
    }
    argValue(a) { return this.rv(a).c; }   // records: the address; the callee copies

    // ---------- calls ----------
    call(n, ctx) {
        const [callee, ...args] = kids(n);
        const c0 = this.stripCasts(callee);
        let fnName = null;
        if (c0.kind === 'DeclRefExpr' && c0.referencedDecl.kind === 'FunctionDecl') fnName = c0.referencedDecl.name;
        if (fnName === 'setjmp' || fnName === '_setjmp' || fnName === 'longjmp' || fnName === '_longjmp') return this.jmpCall(fnName, args, n);
        const special = fnName && this.specialCall(fnName, args, n, ctx);
        if (special) return special;
        let f, asyncCall, conv = null;
        if (fnName) {
            const ref = this.prog.heapFunctionRef(this, fnName);
            f = ref.code;
            if (ref.kind === 'crt') conv = ref;
            asyncCall = ref.kind === 'crt' ? ref.async : this.prog.isAsync(this, fnName);
        } else {
            f = `$h.fnAt(${this.rv(callee).c})`;
            asyncCall = this.prog.isAsyncIndirect(this, this.T(callee));
        }
        const argc = conv ? this.marshalArgs(callee, args, n) : args.map((a) => this.argValue(a));
        let e = E(`${f}(${argc.join(', ')})`, PREC.call);
        if (asyncCall) {
            if (!this.fn || !this.fn.isAsync) this.err(n, `await of ${fnName || 'an indirect call'} in a function outside the async set`);
            e = E(`await ${par(e, PREC.unary)}`, PREC.unary);
        }
        if (conv) e = this.marshalRet(n, e);
        return e;
    }
    specialCall(name, args, n, ctx) {
        if (name === '__builtin_object_size') return E('-1', PREC.unary);   // unknown in the heap world: _chk checks pass
        return super.specialCall(name, args, n, ctx);
    }
    /** Arguments of a call into the object-world runtime. */
    marshalArgs(callee, args, n) {
        let ft = this.S.resolve(this.T(callee));
        if (ft.k === 'ptr') ft = this.S.resolve(ft.to);
        const params = (ft.k === 'fn' && ft.params) || [];
        return args.map((a, i) => {
            const t = this.S.resolve(params[i] || this.T(a));
            const v = this.rv(a);
            return this.toRuntime(t, v, n);
        });
    }
    toRuntime(t, v, n) {
        t = this.S.resolve(t);
        if (t.k !== 'ptr') return v.c;
        const to = this.S.resolve(t.to);
        if (to.k === 'fn') this.err(n, 'function pointer passed to the runtime');
        if (to.k === 'void' || (to.k === 'int' && to.size === 1)) return `$h.P(${v.c})`;
        if (to.k === 'rec') return `$h.deref(${v.c})`;   // FILE * and other runtime objects: handles
        if (to.k === 'int' && to.size === 8) return `$h.${to.signed ? 'PI64' : 'PU64'}(${v.c})`;
        const view = to.k === 'float' ? (to.size === 4 ? 'f32' : 'f64') : to.k === 'int' ? `${to.signed ? 'i' : 'u'}${to.size * 8}` : null;
        if (!view) this.err(n, `pointer to ${to.k}${to.size * 8 || ''} passed to the runtime`);
        return `$h.PV(${v.c}, $h.${view})`;
    }
    marshalRet(n, e) {
        const t = this.S.resolve(this.T(n));
        if (t.k !== 'ptr') return e;
        const to = this.S.resolve(t.to);
        if (to.k === 'rec') return E(`$h.handle(${e.c})`, PREC.call);
        return E(`$h.A(${e.c})`, PREC.call);
    }
}
const par0 = (a) => (/^[\w$.]+$/.test(a) ? a : `(${a})`);
