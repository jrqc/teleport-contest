// program.mjs: whole-program facts for the emitter, and module assembly.
//
// A Program is built from the TUs of one program (the 172 recorder TUs, or a
// test program of a few files). It knows which TU defines each external
// function and variable, gives every record a class name, and writes the
// shared modules: types.js (record classes), globals.js ($G: external
// scalars and pointers, with their zero values) and index.js (the $init
// order: TU link order, like C's static initialization, which has no order).
import path from 'node:path';
import { TUEmitter, EmitError } from './tu.mjs';
import { classSource, zeroOf } from './classes.mjs';
import { jsName, field } from './names.mjs';
import { ROOT } from '../frontend/ast.mjs';
import { AsyncSet, sigOf } from './asyncset.mjs';

const kids = (n) => n.inner || [];
const hasBody = (n) => kids(n).some((c) => c.kind === 'CompoundStmt');
// A definition belongs to the TU being compiled when it comes from any non-system file (the
// .c file, or a header or macro expansion it includes: artilist.h, sfprocs.h).
const own = (n) => { const l = n.loc && (n.loc.expansionLoc || n.loc); return !!(l && l._f && !path.isAbsolute(l._f)); };
const LIBC_VARS = new Set(['errno', 'ospeed', 'environ']);
const ident = (m) => m.replace(/[^A-Za-z0-9_$]/g, '_');
export const moduleName = (file) => path.basename(file).replace(/\.c$/, '');

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
        this.blockingCrt = new Set(['getchar']);   // runtime reads that wait for a key (async roots)   // annotation functions[].handwritten: the runtime defines them
        this.asyncDone = false;
        this.fnDef = new Map();     // name -> { module, file } (external linkage definitions)
        this.varDef = new Map();    // name -> { module, file, t, scope, hasInit } (external linkage definitions)
        this.classNames = new Map();   // record key -> class name
        this.classScope = new Map();   // record key -> scope that defines it
        this.usedNames = new Set();
        this.modules = [];          // link order
    }
    addCallFacts(tu) { this.async.addTU(tu); }
    addFacts(tu) {
        this.async.addTU(tu);
        tu.module = moduleName(tu.file);
        this.modules.push(tu.module);
        for (const n of kids(tu.root)) {
            if (!own(n)) continue;
            if (n.kind === 'FunctionDecl' && hasBody(n) && n.storageClass !== 'static' && !this.handwritten.has(n.name)) {
                if (this.fnDef.has(n.name)) throw new EmitError(`function ${n.name} defined in ${this.fnDef.get(n.name).file} and ${tu.file}`);
                this.fnDef.set(n.name, { module: tu.module, file: tu.file });
            }
            if (n.kind === 'VarDecl' && n.storageClass !== 'extern' && n.storageClass !== 'static') {
                const t = tu.scope.type(n.type.desugaredQualType || n.type.qualType);
                const prev = this.varDef.get(n.name);
                // tentative definitions in several TUs (common symbols) merge into one
                if (!prev || (n.init && !prev.hasInit)) this.varDef.set(n.name, { module: tu.module, file: tu.file, t, scope: tu.scope, hasInit: !!n.init });
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
        if (this.definedIn(tu, name, 'fn')) return jsName(name);
        const d = this.fnDef.get(name);
        if (d) { this.noteImport(tu, d.module, jsName(name)); return jsName(name); }
        if (this.crt.has(name)) return `$c.${name}`;
        if (this.missingFn) { this.missingFn.add(name); return `$c.missing(${JSON.stringify(name)})`; }
        if (this.crt.has(name)) return `$c.${name}`;
        throw new EmitError(`undefined function ${name}`);
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
        if (local && local.storageClass === 'static') return jsName(name);
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
        if (local) return jsName(name);
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
        tu._imports = tu._imports || new Map();
        if (!tu._imports.has(module)) tu._imports.set(module, new Set());
        tu._imports.get(module).add(name);
    }
    importsFor(tu) {
        const out = [];
        const m = tu._imports || new Map();
        for (const mod of [...m.keys()].sort()) out.push(`import { ${[...m.get(mod)].sort().join(', ')} } from './${mod}.js';`);
        return out;
    }

    // ---------- output ----------
    /** Emit one TU (after addFacts for all): { path, code, errors }. */
    emitTU(tu) {
        tu.module = moduleName(tu.file);
        tu.addr = this.addrTakenIds(tu.root);
        const em = new TUEmitter(tu, this);
        const code = em.run();   // imports are collected while emitting
        return { path: `${tu.module}.js`, code, errors: em.errors.map((e) => `${tu.file}: ${e}`) };
    }
    /** The shared modules, after every TU was emitted: Map(path -> text). */
    finish() {
        return new Map([['types.js', this.typesModule()], ['globals.js', this.globalsModule()], ['index.js', this.indexModule()]]);
    }
    /** Small programs (tests): all TUs in memory. */
    emitAll(tus) {
        for (const tu of tus) this.addFacts(tu);
        const files = new Map();
        const errors = [];
        for (const tu of tus) { const r = this.emitTU(tu); files.set(r.path, r.code); errors.push(...r.errors); }
        for (const [k, v] of this.finish()) files.set(k, v);
        return { files, errors };
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
                srcs.push({ name, src: classSource(scope, key, (k) => this.className(k, scope)) });
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
            const { t, scope, file } = this.varDef.get(n);
            if (t.k === 'rec' || t.k === 'arr') continue;
            out.push(`    $G.${field(n)} = ${zeroOf(t, (k) => this.className(k, scope))};   // ${file}`);
        }
        out.push('}', '$initG();', '');
        return out.join('\n');
    }
    indexModule() {
        const out = ['// index.js: module list and static initialization order (generated). Do not edit.'];
        for (const m of this.modules) out.push(`import { $init as ${ident(m)}$init } from './${m}.js';`);
        out.push("import { $initG } from './globals.js';", '', 'export function $initAll() {', '    $initG();');
        for (const m of this.modules) out.push(`    ${ident(m)}$init();`);
        out.push('}', '');
        return out.join('\n');
    }
}
