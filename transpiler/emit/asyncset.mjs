// asyncset.mjs: the async set for code generation (CLAUDE.md 2.5, design 6).
//
// Built from the same ASTs the emitter reads, during Program's facts pass, so
// that the functions emitted `async` and the calls emitted `await` come from
// one source and are consistent by construction:
//   - every function that can reach a blocking root is async;
//   - an indirect call is awaited when some address-taken async function has
//     the callee's (coarse) signature, and such a call makes its caller async.
// Signatures are coarse (integers by size, all data pointers alike), which can
// only add targets: conservative. Roots: tty_nhgetch (input boundary) and
// tty_delay_output (animation frames), plus annotation "blocking" entries.
// transpiler/analysis/async.mjs is the Stage 1 inventory of the same idea.
const kids = (n) => n.inner || [];

export function sigOf(scope, t) {
    t = scope.resolve(t);
    switch (t.k) {
    case 'void': return 'v';
    case 'int': return `i${t.size}`;
    case 'float': return `f${t.size}`;
    case 'ptr': { const to = scope.resolve(t.to); return to.k === 'ptr' ? 'pp' : to.k === 'fn' ? 'pf' : 'p' + sigOf(scope, to); }
    case 'rec': return `r:${t.key}`;
    case 'fn': return `(${sigOf(scope, t.ret)};${t.params ? t.params.map((p) => sigOf(scope, p)).join(',') : '?'}${t.variadic ? ',...' : ''})`;
    default: return t.k;
    }
}

export class AsyncSet {
    constructor({ roots = ['tty_nhgetch', 'tty_delay_output'], cut = [] } = {}) {
        this.roots = roots;
        this.cut = new Set(cut);
        this.calls = new Map();       // fn key -> Set(callee key | '#'+sig)
        this.addrSig = new Map();     // sig -> Set(fn key)  (address-taken definitions)
        this.members = null;
        this.asyncSigs = null;
    }
    /** Function key: statics are per file. */
    static key(file, name, isStatic) { return isStatic ? `${file}::${name}` : name; }

    addTU(tu) {
        const statics = new Set();
        for (const n of kids(tu.root)) if (n.kind === 'FunctionDecl' && n.storageClass === 'static') statics.add(n.name);
        const keyOf = (name) => AsyncSet.key(tu.file, name, statics.has(name));
        const typeOf = (n) => tu.scope.type(n.type.desugaredQualType || n.type.qualType);
        const strip = (n) => { while (n && (n.kind === 'ImplicitCastExpr' || n.kind === 'ParenExpr')) n = kids(n)[0]; return n; };
        const fnSigOfCallee = (c) => {
            let t = tu.scope.resolve(typeOf(c));
            if (t.k === 'ptr') t = tu.scope.resolve(t.to);
            return t.k === 'fn' ? sigOf(tu.scope, t) : null;
        };
        const walk = (n, edges, calleeNode) => {
            if (!n || typeof n !== 'object') return;
            if (n.kind === 'CallExpr') {
                const c = kids(n)[0];
                const s = strip(c);
                if (s && s.kind === 'DeclRefExpr' && s.referencedDecl && s.referencedDecl.kind === 'FunctionDecl') {
                    if (edges) edges.add(keyOf(s.referencedDecl.name));
                    walk(c, edges, s);
                } else {
                    const sig = c && c.type ? fnSigOfCallee(c) : null;
                    if (edges && sig) edges.add('#' + sig);
                    walk(c, edges, null);
                }
                for (const a of kids(n).slice(1)) {
                    // a function passed as an argument may be called by the callee (qsort, callbacks)
                    const sa = strip(a);
                    if (edges && sa && sa.kind === 'DeclRefExpr' && sa.referencedDecl && sa.referencedDecl.kind === 'FunctionDecl') edges.add(keyOf(sa.referencedDecl.name));
                    else if (edges && a.type) { const sig = fnSigOfCallee(a); if (sig) edges.add('#' + sig); }
                    walk(a, edges, null);
                }
                return;
            }
            if (n.kind === 'DeclRefExpr' && n !== calleeNode && n.referencedDecl && n.referencedDecl.kind === 'FunctionDecl' && n.type) {
                // address taken (a function used as a value)
                const t = tu.scope.resolve(typeOf(n));
                const ft = t.k === 'ptr' ? tu.scope.resolve(t.to) : t;
                if (ft.k === 'fn') {
                    const sig = sigOf(tu.scope, ft);
                    if (!this.addrSig.has(sig)) this.addrSig.set(sig, new Set());
                    this.addrSig.get(sig).add(keyOf(n.referencedDecl.name));
                }
            }
            for (const k of kids(n)) walk(k, edges, calleeNode);
        };
        for (const n of kids(tu.root)) {
            if (n.kind === 'FunctionDecl' && kids(n).some((c) => c.kind === 'CompoundStmt')) {
                const k = keyOf(n.name);
                if (!this.calls.has(k)) this.calls.set(k, new Set());
                walk(n, this.calls.get(k), null);
            } else if (n.kind === 'VarDecl') walk(n, null, null);   // initializers: function tables
        }
    }

    finish() {
        const rev = new Map();
        const addRev = (to, from) => { if (!rev.has(to)) rev.set(to, []); rev.get(to).push(from); };
        for (const [from, es] of this.calls) {
            for (const e of es) {
                if (e.startsWith('#')) { for (const t of this.addrSig.get(e.slice(1)) || []) addRev(t, from); }
                else addRev(e, from);
            }
        }
        const seen = new Set();
        this.via = new Map();
        const q = [];
        for (const r of this.roots) if (this.calls.has(r)) { seen.add(r); q.push(r); }
        while (q.length) {
            const x = q.pop();
            if (this.cut.has(x)) continue;
            for (const f of rev.get(x) || []) if (!seen.has(f)) { seen.add(f); this.via.set(f, x); q.push(f); }
        }
        this.members = seen;
        this.asyncSigs = new Set();
        for (const [sig, fns] of this.addrSig) if ([...fns].some((f) => seen.has(f))) this.asyncSigs.add(sig);
        return this;
    }
    has(key) { return this.members.has(key); }
    hasSig(sig) { return this.asyncSigs.has(sig); }
    /** Address-taken async functions with signature sig (diagnostics). */
    asyncWithSig(sig) { return [...(this.addrSig.get(sig) || [])].filter((f) => this.members.has(f)); }
    /** Why key is async: the chain of callees down to a root. */
    chain(key) { const c = [key]; let x = key; while (this.via.has(x) && c.length < 40) { x = this.via.get(x); c.push(x); } return c; }
    stats() { return { functions: this.calls.size, async: this.members.size, asyncSigs: this.asyncSigs.size }; }
}
