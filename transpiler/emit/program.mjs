// program.mjs: whole-program facts for the emitter, and module assembly.
//
// A Program is built from the TUs of one program (the 172 recorder TUs, or a
// test program of a few files). It knows which TU defines each external
// function and variable, gives every record a class name, and writes the
// shared modules: types.js (record classes), globals.js ($G: external
// scalars and pointers, with their zero values) and index.js (the $init
// order: TU link order, like C's static initialization, which has no order).
import path from 'node:path';
import { TUEmitter, EmitError, IMPORTS_MARK, LOCAL_MACROS_MARK, SITE_RE } from './tu.mjs';
import { HeapEmitter } from './heap.mjs';
import { bridgeModule } from './bridge.mjs';
import { classSource, zeroOf } from './classes.mjs';
import { jsName, field } from './names.mjs';
import { ROOT } from '../frontend/ast.mjs';
import { AsyncSet, sigOf } from './asyncset.mjs';
import { ConstTable, headerModule } from './consts.mjs';
import { Namespaces, addExpanded } from './namespaces.mjs';

const kids = (n) => n.inner || [];
const hasBody = (n) => kids(n).some((c) => c.kind === 'CompoundStmt');
// A definition belongs to the TU being compiled when it comes from any non-system file (the
// .c file, or a header or macro expansion it includes: artilist.h, sfprocs.h).
const own = (n) => { const l = n.loc && (n.loc.expansionLoc || n.loc); return !!(l && l._f && !path.isAbsolute(l._f)); };
const LIBC_VARS = new Set(['errno', 'ospeed', 'environ']);
const ident = (m) => m.replace(/[^A-Za-z0-9_$]/g, '_');
export const moduleName = (file) => path.basename(file).replace(/\.c$/, '');
/** Heap-world TUs (decision D2): the Lua interpreter. */
export const isHeapFile = (file) => /(^|\/)lib\/lua[^/]*\//.test(file);

const addTo = (m, mod, name) => { if (!m.has(mod)) m.set(mod, new Set()); m.get(mod).add(name); };
const importLines = (m) => [...m.keys()].sort().map((mod) => `import { ${[...m.get(mod)].sort().join(', ')} } from './${mod}.js';`);
/** The module of the macro functions of header `file`: rm.h -> rm.macros (rm.macros.js). */
const macroModule = (file) => path.basename(file).replace(/\.h$/, '.macros');
/** The JS function for macro `name` from its chosen site's body (parameters are \u0002i\u0002). */
function macroFunction(name, s, exported) {
    const plain = s.body.replace(/\u0002\d+\u0002/g, ' ');
    const params = s.params.map((p) => { let q = jsName(p); while (new RegExp(`(^|[^\\w$.])${q.replace(/\$/g, '\\$')}(?![\\w$])`).test(plain)) q += '$'; return q; });
    const body = s.body.replace(/\u0002(\d+)\u0002/g, (_, i) => params[Number(i)]);
    const head = `${exported ? 'export ' : ''}${s.isAsync ? 'async ' : ''}function ${jsName(name)}(${params.join(', ')}) {`;
    return s.isVoid ? `${head}\n    ${body};\n}` : `${head}\n    return ${body};\n}`;
}

export class Program {
    /**
     * Two passes, so that no more than one TU's AST is in memory: addFacts(tu)
     * for every TU (definitions), then emitTU(tu) for every TU, then finish().
     * @param opts { crtNames: Set of $c exports, asyncRoots?, asyncCut? }
     * The async set is computed from the facts pass (asyncset.mjs); TUs that are
     * not emitted (Lua, until its backend exists) still add call facts (addCallFacts).
     */
    constructor(opts) {
        this.root = ROOT;
        this.crt = opts.crtNames;
        this.async = new AsyncSet({ roots: opts.asyncRoots, cut: opts.asyncCut });
        this.handwritten = new Set(opts.handwritten || []);
        // readability plan P2c: tables as literals; NH_TABLE_CHECK (a module URL) builds each
        // table both ways and compares them (tools/tablecheck.mjs)
        this.tableLiterals = opts.tableLiterals !== false;
        this.constNamespaces = opts.constNamespaces !== false;   // P2c: PM.ANGEL
        this.nsNames = new Set();
        this.macroUses = new Set();   // macros invoked in object-world function code (namespaces.mjs)
        this.expanded = new Set();    // identifiers object-world TUs expand as macros (namespaces.mjs)
        this.constTUs = new Map();    // header -> first TU naming one of its constants
        this.tableCheck = process.env.NH_TABLE_CHECK || null;
        this.handMod = new Map(Object.entries(opts.handModules || {}));   // name -> module path from js/nh ('../hand/x')
        this.blockingCrt = new Set(['getchar']);   // runtime reads that wait for a key (async roots)   // annotation functions[].handwritten: the runtime defines them
        this.asyncDone = false;
        this.fnDef = new Map();     // name -> { module, file } (external linkage definitions)
        this.varDef = new Map();    // name -> { module, file, t, scope, hasInit } (external linkage definitions)
        this.classNames = new Map();   // record key -> class name
        this.classScope = new Map();   // record key -> scope that defines it
        this.usedNames = new Set();
        this.modules = [];          // link order
        this.heapModules = new Set();
        this.bridgeFns = new Map();   // heap function name -> { decl type, scope } used from the object world
        this.objKeys = new Set();     // record keys object-world code instantiates (classes): copied across the bridge
        this.heapCrt = opts.heapCrtNames || new Set();
        this.tails = new Set(opts.tails || []);   // record keys with a trailing area (annotations types[].tail)
        this.cells = new Set(opts.cells || []);   // union keys kept as union cells (union-pun verdict, D1)
        this.isHeapFile = opts.isHeapFile || null;   // tests: put every TU in the heap world
        this.consts = new ConstTable();   // enum constants by defining file (readability plan P2)
        this.macroFunctions = opts.macroFunctions !== false;   // readability plan P3
        this.macroSites = [];
        this.collectors = [];
        this.importedModules = new Set();
        this.macroConsts = new Map();   // file -> Map(name -> { js, text, offset }): #define constants in use (P2)
    }
    addCallFacts(tu) { this.async.addTU(tu); }
    addFacts(tu) {
        this.async.addTU(tu);
        this.consts.addTU(tu);
        if (!(this.isHeapFile || isHeapFile)(tu.file)) { addExpanded(tu.root, this.macroUses, true); addExpanded(tu.root, this.expanded, false); }
        tu.module = moduleName(tu.file);
        this.modules.push(tu.module);
        const heap = (this.isHeapFile || isHeapFile)(tu.file);
        if (heap) this.heapModules.add(tu.module);
        for (const n of kids(tu.root)) {
            if (!own(n)) continue;
            if (n.kind === 'FunctionDecl' && hasBody(n) && n.storageClass !== 'static' && !this.handwritten.has(n.name)) {
                if (this.fnDef.has(n.name)) throw new EmitError(`function ${n.name} defined in ${this.fnDef.get(n.name).file} and ${tu.file}`);
                this.fnDef.set(n.name, { module: tu.module, file: tu.file, heap, ctype: n.type.qualType, scope: tu.scope, node: { type: n.type } });
            }
            if (n.kind === 'VarDecl' && n.storageClass !== 'extern' && n.storageClass !== 'static') {
                const t = tu.scope.type(n.type.desugaredQualType || n.type.qualType);
                const prev = this.varDef.get(n.name);
                // tentative definitions in several TUs (common symbols) merge into one
                if (!prev || (n.init && !prev.hasInit)) this.varDef.set(n.name, { module: tu.module, file: tu.file, t, scope: tu.scope, hasInit: !!n.init, heap });
            }
        }
    }

    addrTakenIds(root) {
        const s = new Set();
        const walk = (x) => {
            if (!x || typeof x !== 'object') return;
            if (x.kind === 'UnaryOperator' && x.opcode === '&') {
                let d = kids(x)[0];
                while (d && d.kind === 'ParenExpr') d = kids(d)[0];
                if (d && d.kind === 'DeclRefExpr' && d.referencedDecl) s.add(d.referencedDecl.id);
            }
            for (const c of kids(x)) walk(c);
        };
        walk(root);
        return s;
    }

    // ---------- names ----------
    className(key, scope) {
        let n = this.classNames.get(key);
        if (n) return n;
        let base;
        if (!key.startsWith('@')) base = key;
        else {
            // a typedef naming the anonymous record, else its position
            const rec = scope.records.get(key);
            const alias = [...scope.records.entries()].find(([k, r]) => r === rec && !k.startsWith('@'));
            const m = /([^/]+)\.[ch]:(\d+):\d+$/.exec(key);
            base = alias ? alias[0] : `anon_${m ? `${m[1]}_${m[2]}` : 'x'}`;
        }
        base = base.replace(/[^A-Za-z0-9_$]/g, '_');
        n = base;
        if (this.usedNames.has(n)) { let i = 2; while (this.usedNames.has(`${base}$${i}`)) i++; n = `${base}$${i}`; }
        this.usedNames.add(n);
        this.classNames.set(key, n);
        this.classScope.set(key, scope);
        return n;
    }
    staticName(tu, name) { return jsName(name); }

    // ---------- references ----------
    functionRef(tu, name) {
        // a hand-written replacement in js/hand/ that the runtime index does not export: imported directly
        if (this.handMod.has(name) && !this.crt.has(name)) { this.noteImport(tu, this.handMod.get(name), jsName(name)); return jsName(name); }
        if (this.definedIn(tu, name, 'fn')) { const dd = this.fnDef.get(name); this.localRef(tu, name, !(dd && dd.module === tu.tu.module)); return jsName(name); }
        const d = this.fnDef.get(name);
        if (d && d.heap && !tu.heap) {
            // an object-world use of a heap-world function: through the generated bridge
            this.bridgeFns.set(name, d);
            this.noteImport(tu, 'luabridge', jsName(name));
            return jsName(name);
        }
        if (d) { this.noteImport(tu, d.module, jsName(name)); return jsName(name); }
        if (this.crt.has(name)) return `$c.${name}`;
        if (this.missingFn) { this.missingFn.add(name); return `$c.missing(${JSON.stringify(name)})`; }
        if (this.crt.has(name)) return `$c.${name}`;
        throw new EmitError(`undefined function ${name}`);
    }
    /** A function as heap-world code calls it: { kind: local|heap|hl|crt|missing, code, async }. */
    heapFunctionRef(tu, name) {
        if (this.definedIn(tu, name, 'fn')) return { kind: 'local', code: jsName(name) };
        const d = this.fnDef.get(name);
        if (d && d.heap) { this.noteImport(tu, d.module, jsName(name)); return { kind: 'heap', code: jsName(name) }; }
        if (d) throw new EmitError(`heap-world call of object-world function ${name}`);
        if (this.heapCrt.has(name)) return { kind: 'hl', code: `$hl.${name}` };
        if (this.crt.has(name)) return { kind: 'crt', code: `$c.${name}`, async: this.blockingCrt.has(name) };
        if (this.missingFn) { this.missingFn.add(name); return { kind: 'missing', code: `$c.missing(${JSON.stringify(name)})` }; }
        throw new EmitError(`undefined function ${name}`);
    }
    /** The address constant of a file-scope variable in heap-world code. */
    heapGlobalRef(tu, name) {
        tu._defs = tu._defs || this.localDefs(tu);
        const local = tu._defs.var.get(name);
        const d = this.varDef.get(name);
        if (local && (local.storageClass === 'static' || !d || d.module === tu.tu.module)) return jsName(name);
        if (d && d.heap) { this.noteImport(tu, d.module, jsName(name)); return jsName(name); }
        if (d) throw new EmitError(`heap-world use of object-world variable ${name}`);
        if (this.heapCrt.has(name)) return `$hl.${name}`;
        throw new EmitError(`undefined variable ${name} (heap world)`);
    }
    definedIn(tu, name, kind) {
        tu._defs = tu._defs || this.localDefs(tu);
        return tu._defs[kind].has(name);
    }
    localDefs(tu) {
        const fn = new Set(), vars = new Map();
        for (const n of kids(tu.tu.root)) {
            if (!own(n)) continue;
            if (n.kind === 'FunctionDecl' && hasBody(n) && !this.handwritten.has(n.name)) fn.add(n.name);
            if (n.kind === 'VarDecl' && n.storageClass !== 'extern') vars.set(n.name, n);
        }
        return { fn, var: vars };
    }
    globalRef(tu, name, t) {
        tu._defs = tu._defs || this.localDefs(tu);
        const local = tu._defs.var.get(name);
        if (local && local.storageClass === 'static') { this.localRef(tu, name, true); return jsName(name); }
        if (local && this.varDef.has(name) && this.varDef.get(name).module !== tu.tu.module && (t.k === 'rec' || t.k === 'arr')) {
            // a tentative definition another TU owns (a header defines it in every includer)
            this.noteImport(tu, this.varDef.get(name).module, jsName(name));
            return jsName(name);
        }
        if (!(t.k === 'rec' || t.k === 'arr')) {
            if (local || this.varDef.has(name)) return `$G.${field(name)}`;
            if (LIBC_VARS.has(name)) return `$c.$libc.${name}`;
            if (this.crt.has(name)) return `$c.${name}`;
            throw new EmitError(`undefined variable ${name}`);
        }
        if (local) { this.localRef(tu, name, false); return jsName(name); }
        const d = this.varDef.get(name);
        if (d) { this.noteImport(tu, d.module, jsName(name)); return jsName(name); }
        if (this.crt.has(name)) return `$c.${name}`;
        throw new EmitError(`undefined variable ${name}`);
    }
    /** File-scope static scalars whose address is taken are one-element arrays. */
    isBoxedGlobal(tu, name) {
        tu._defs = tu._defs || this.localDefs(tu);
        const local = tu._defs.var.get(name);
        if (!local || local.storageClass !== 'static') return false;
        const t = tu.T(local);
        return tu.tu.addr.has(local.id) && t.k !== 'rec' && t.k !== 'arr';
    }
    /** Whether this TU emits the definition of external variable `name`. */
    ownsVar(tu, name) {
        const d = this.varDef.get(name);
        return !d || d.module === tu.tu.module;
    }
    asyncReady() { if (!this.asyncDone) { this.async.finish(); this.asyncDone = true; } return this.async; }
    /** Whether the function `name` as seen from TU em is async (statics are per file). */
    isAsync(em, name) {
        em.tu._staticFns = em.tu._staticFns || new Set(kids(em.tu.root).filter((n) => n.kind === 'FunctionDecl' && n.storageClass === 'static').map((n) => n.name));
        return this.asyncReady().has(AsyncSet.key(em.tu.file, name, em.tu._staticFns.has(name)));
    }
    /** Whether a call through a function pointer of type `t` (pointer to fn, or fn) must be awaited. */
    isAsyncIndirect(em, t) {
        let ft = em.tu.scope.resolve(t);
        if (ft.k === 'ptr') ft = em.tu.scope.resolve(ft.to);
        return ft.k === 'fn' && this.asyncReady().hasSig(sigOf(em.tu.scope, ft));
    }

    noteImport(tu, module, name) {
        if (module === tu.tu.module) return;
        if (this.collectors.length) { const c = this.collectors[this.collectors.length - 1]; addTo(c.imports, module, name); c.refs.push([module, name]); return; }
        tu._imports = tu._imports || new Map();
        if (!tu._imports.has(module)) tu._imports.set(module, new Set());
        this.importedModules.add(module);
        tu._imports.get(module).add(name);
    }
    importsFor(tu) { return importLines(tu._imports || new Map()); }

    // ---------- readability plan P3: macro functions ----------
    /** Start collecting the imports and references of an emission (TUEmitter.macroSite). */
    collect(tu) { const c = { imports: new Map(), refs: [], statics: false, tu }; this.collectors.push(c); return c; }
    endCollect(c) { const i = this.collectors.lastIndexOf(c); if (i >= 0) this.collectors.splice(i, 1); }
    /** A reference to a definition of TU `tu` itself (module-local in the generated code). */
    localRef(tu, name, isStatic) {
        if (!this.collectors.length) return;
        const c = this.collectors[this.collectors.length - 1];
        if (isStatic) c.statics = true; else c.refs.push([tu.tu.module, jsName(name)]);
    }
    addMacroSite(site) { this.macroSites.push(site); return this.macroSites.length - 1; }
    /**
     * After every TU is emitted: choose, per macro, the body text most of its sites
     * share (ties: the first in sort order); those sites call the function, the others
     * keep the expansion. Returns Map(path -> final code) and sets this.macroDefs.
     */
    resolveTUs(results) {
        const byName = new Map();
        this.macroSites.forEach((s, id) => { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(id); });
        const chosen = new Set();
        this.macroDefs = new Map();   // module -> [{ name, text, imports, offset }]
        for (const [name, ids] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const files = new Set(ids.map((i) => this.macroSites[i].file));
            if (files.size !== 1) continue;
            const file = [...files][0];
            const header = /\.h$/.test(file);
            if (!header && ids.some((i) => `${this.macroSites[i].tu}.c` !== path.basename(file))) continue;
            const groups = new Map();
            for (const i of ids) {
                const s = this.macroSites[i];
                const k = JSON.stringify([s.body, s.fnlike, s.params.length, s.isVoid, s.isAsync]);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(i);
            }
            const [, best] = [...groups].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0];
            for (const i of best) chosen.add(i);
            const s0 = this.macroSites[best[0]];
            const mod = header ? macroModule(file) : s0.tu;
            const text = macroFunction(name, s0, header);
            const imports = new Map();
            for (const i of best) for (const [m, js] of this.macroSites[i].refs) if (m !== mod) addTo(imports, m, js);
            if (!this.macroDefs.has(mod)) this.macroDefs.set(mod, []);
            this.macroDefs.get(mod).push({ name, text, imports, offset: s0.defOffset || 0, file });
        }
        const out = new Map();
        for (const r of results) {
            if (!r.code.includes(IMPORTS_MARK)) { out.set(r.path, r.code); continue; }
            const imports = new Map();
            for (const [m, ns] of r.imports) for (const n of ns) addTo(imports, m, n);
            let code = r.code.replace(SITE_RE, (_, id) => {
                const s = this.macroSites[Number(id)];
                if (chosen.has(Number(id))) {
                    for (const [m, ns] of s.callImports) for (const n of ns) addTo(imports, m, n);
                    if (/\.h$/.test(s.file)) addTo(imports, macroModule(s.file), jsName(s.name));
                    const call = `${jsName(s.name)}(${s.args.join(', ')})`;
                    return s.isAsync ? `await ${call}` : call;
                }
                for (const [m, ns] of s.expImports) for (const n of ns) addTo(imports, m, n);
                return s.expP < s.callP || /^[-+]/.test(s.exp) ? `(${s.exp})` : s.exp;
            });
            const own = (this.macroDefs.get(r.module) || []).filter((d) => !/\.h$/.test(d.file));
            for (const d of own) for (const [m, ns] of d.imports) if (m !== r.module) for (const n of ns) addTo(imports, m, n);
            imports.delete(r.module);
            const il = importLines(imports);
            code = code.replace(IMPORTS_MARK + '\n', il.length ? il.join('\n') + '\n' : '');
            code = code.replace(LOCAL_MACROS_MARK + '\n', own.length ? own.sort((a, b) => a.offset - b.offset || (a.name < b.name ? -1 : 1)).map((d) => d.text).join('\n') + '\n' : '');
            if (/\u0001|\u0002/.test(code)) throw new EmitError(`${r.path}: unresolved placeholder`);
            out.set(r.path, code);
        }
        return out;
    }
    /** The header modules of macro functions (after resolveTUs): Map(path -> text). */
    macroModules() {
        const out = new Map();
        for (const [mod, defs] of [...(this.macroDefs || new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            if (!defs.length || !/\.h$/.test(defs[0].file)) continue;
            const imports = new Map();
            for (const d of defs) for (const [m, ns] of d.imports) for (const n of ns) if (m !== mod) addTo(imports, m, n);
            const rel = path.relative(path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder'), path.resolve(ROOT, defs[0].file));
            const lines = [`// ${mod}.js: the expression macros of ${rel} as functions (generated by transpiler/emit, readability plan P3). Do not edit.`,
                "import * as $c from '../crt/index.js';", "import * as $T from './types.js';", "import { $G } from './globals.js';", ...importLines(imports), ''];
            for (const d of defs.sort((a, b) => a.offset - b.offset || (a.name < b.name ? -1 : 1))) lines.push(d.text);
            out.set(`${mod}.js`, lines.join('\n') + '\n');
        }
        return out;
    }

    // ---------- output ----------
    /** Emit one TU (after addFacts for all): { path, code, errors }. */
    /** Readability plan P2c: the constant namespaces, once every TU's facts are in. */
    namespaces() {
        if (!this.consts.ns && this.constNamespaces !== false) {
            this.consts.ns = new Namespaces(this.consts, (n) => this.fnDef.has(n) || this.varDef.has(n) || this.crt.has(n) || this.handwritten.has(n), this.macroUses, this.expanded);
            this.nsNames = this.consts.ns.names;
        }
        return this.consts.ns;
    }
    emitTU(tu) {
        this.namespaces();
        tu.module = moduleName(tu.file);
        tu.addr = this.addrTakenIds(tu.root);
        const em = this.heapModules.has(tu.module) ? new HeapEmitter(tu, this) : new TUEmitter(tu, this);
        em.heap = this.heapModules.has(tu.module);
        const code = em.run();   // imports are collected while emitting
        return { path: `${tu.module}.js`, code, errors: em.errors.map((e) => `${tu.file}: ${e}`), imports: em._imports || new Map(), module: tu.module };
    }
    /** objKeys plus the records embedded in them (struct nhregex { regex_t re; }): every record object-world code holds. */
    objRecordKeys() {
        const keys = new Set(this.objKeys);
        const todo = [...keys];
        while (todo.length) {
            const key = todo.pop();
            const scope = this.classScope.get(key);
            if (!scope) continue;
            for (const f of scope.recordLayout(key).fields) {
                let t = scope.resolve(f.type);
                while (t.k === 'arr') t = scope.resolve(t.of);
                if (t.k === 'rec' && !keys.has(t.key)) { keys.add(t.key); todo.push(t.key); }
            }
        }
        return keys;
    }
    /** The shared modules, after every TU was emitted: Map(path -> text). */
    finish() {
        // the bridge first: it names the classes of the records it copies
        const bridge = this.heapModules.size ? bridgeModule(this) : null;
        const m = new Map([['types.js', this.typesModule()], ['globals.js', this.globalsModule()], ['index.js', this.indexModule()]]);
        for (const [f, text] of this.constModules()) m.set(f, text);
        for (const [f, text] of this.macroModules()) m.set(f, text);
        if (bridge) m.set('luabridge.js', bridge);
        return m;
    }
    /** Small programs (tests): all TUs in memory. */
    emitAll(tus) {
        for (const tu of tus) this.addFacts(tu);
        const files = new Map();
        const errors = [];
        const results = [];
        for (const tu of tus) { const r = this.emitTU(tu); results.push(r); errors.push(...r.errors); }
        for (const [k, v] of this.resolveTUs(results)) files.set(k, v);
        for (const [k, v] of this.finish()) files.set(k, v);
        return { files, errors };
    }
    /** Whether a constant or macro named `name` would collide with a C name the generated code uses. */
    macroNameTaken(tu, name) {
        if (this.fnDef.has(name) || this.varDef.has(name) || this.crt.has(name) || this.handwritten.has(name) || this.consts.fileOf.has(name) || this.nsNames.has(name)) return true;
        tu._defs = tu._defs || this.localDefs(tu);
        return tu._defs.fn.has(name) || tu._defs.var.has(name) || tu.S.typedefs.has(name);
    }
    /** The first TU that names a constant of `file` (tests/transpiler/consts.test.mjs compiles the header's constants in it). */
    noteConstFile(file, tuFile) { if (!this.constTUs.has(file)) this.constTUs.set(file, tuFile); }
    /** A #define constant that emitted code names (namedConst). */
    useMacroConst(tu, b) {
        if (!this.macroConsts.has(b.file)) this.macroConsts.set(b.file, new Map());
        const m = this.macroConsts.get(b.file);
        const old = m.get(b.macro.name);
        if (old && old.text !== b.macro.text) throw new EmitError(`#define ${b.macro.name} has the values ${old.text} and ${b.macro.text} in different TUs`);
        if (!old) m.set(b.macro.name, { offset: b.macro.offset, js: b.js, text: b.macro.text });
    }
    /** The definitions of the .c file's own #define constants that its code names. */
    localMacroConsts(tu) {
        const m = this.macroConsts.get(tu.tu.file);
        return m ? [...m.values()].map((x) => ({ offset: x.offset, line: `const ${x.js} = ${x.text};` })) : [];
    }
    /** Readability plan P2: one module of enum constants per header that code imports from. */
    constModules() {
        const out = new Map();
        const byMod = new Map();
        const nsHomes = this.consts.ns ? [...this.consts.ns.spaces.values()].filter((x) => !x.local).map((x) => x.home) : [];
        for (const f of [...new Set([...this.consts.headerFiles(), ...[...this.macroConsts.keys()].filter((x) => /\.h$/.test(x)), ...nsHomes])].sort()) {
            const mod = headerModule(f);
            if (byMod.has(mod)) throw new EmitError(`two headers named ${mod}: ${byMod.get(mod)} and ${f}`);
            byMod.set(mod, f);
        }
        const done = new Set();
        const todo = [...this.importedModules].filter((m) => byMod.has(m));
        while (todo.length) {
            const mod = todo.pop();
            if (done.has(mod)) continue;
            done.add(mod);
            const file = byMod.get(mod);
            const { entries, imports } = this.consts.definitions(file, jsName, false);
            for (const x of (this.macroConsts.get(file) || new Map()).values()) entries.push({ offset: x.offset, line: `export const ${x.js} = ${x.text};` });
            const lines = entries.sort((a, b) => a.offset - b.offset).map((x) => x.line);
            const head = [`// ${mod}.js: the constants (enum and #define) of ${path.relative(path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder'), path.resolve(ROOT, file))} (generated by transpiler/emit). Do not edit.`,
                '// A C enum or #define family whose members share an upper-case prefix is a namespace (PM_ANGEL -> PM.ANGEL); every other constant keeps its C name.'];
            if (lines.some((l) => l.includes('$c.cenum('))) head.push("import * as $c from '../crt/index.js';");
            for (const im of [...imports.keys()].sort()) { head.push(`import { ${[...imports.get(im)].sort().join(', ')} } from './${im}.js';`); todo.push(im); }
            out.set(`${mod}.js`, [...head, '', ...lines, ''].join('\n'));
        }
        return [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    typesModule() {
        const out = ['// types.js: record classes (generated by transpiler/emit). Do not edit.', "import * as $c from '../crt/index.js';", "import * as $T from './types.js';", ''];
        const done = new Set();
        const srcs = [];
        let again = true;
        while (again) {
            again = false;
            for (const [key, name] of [...this.classNames]) {
                if (done.has(key)) continue;
                done.add(key);
                again = true;
                const scope = this.classScope.get(key);
                srcs.push({ name, src: classSource(scope, key, (k) => this.className(k, scope), undefined, this.tails.has(key), this.cells.has(key)) });
            }
        }
        srcs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const s of srcs) out.push(s.src, '');
        return out.join('\n');
    }
    globalsModule() {
        const out = ['// globals.js: external scalar and pointer variables (generated by transpiler/emit). Do not edit.',
            "import * as $T from './types.js';", 'export const $G = {};',
            '/** Zero every variable (before the modules\' $init: a fresh C process per segment). */', 'export function $initG() {'];
        const names = [...this.varDef.keys()].sort();
        for (const n of names) {
            const { t, scope, file, heap } = this.varDef.get(n);
            if (heap) continue;
            if (t.k === 'rec' || t.k === 'arr') continue;
            out.push(`    $G.${field(n)} = ${zeroOf(t, (k) => this.className(k, scope))};   // ${file}`);
        }
        out.push('}', '$initG();', '');
        return out.join('\n');
    }
    indexModule() {
        const out = ['// index.js: module list and static initialization order (generated). Do not edit.'];
        for (const m of this.modules) out.push(`import { $init as ${ident(m)}$init } from './${m}.js';`);
        out.push("import { $initG } from './globals.js';");
        if (this.heapModules.size) out.push("import { reset as $heapReset } from '../crt/heap.js';");
        out.push('', 'export function $initAll() {', '    $initG();');
        if (this.heapModules.size) out.push('    $heapReset();   // the heap world: a fresh stack and malloc heap');
        for (const m of this.modules) out.push(`    ${ident(m)}$init();`);
        out.push('}', '');
        return out.join('\n');
    }
}
