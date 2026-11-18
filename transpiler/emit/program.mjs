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

const kids = (n) => n.inner || [];
const hasBody = (n) => kids(n).some((c) => c.kind === 'CompoundStmt');
const own = (n, file) => { const l = n.loc && (n.loc.expansionLoc || n.loc); return l && l._f === file; };
const ident = (m) => m.replace(/[^A-Za-z0-9_$]/g, '_');
export const moduleName = (file) => path.basename(file).replace(/\.c$/, '');

export class Program {
    /**
     * @param tus [{ root, scope, file, dir }]
     * @param opts { crtNames: Set of $c exports, asyncSet: Set of function names }
     */
    constructor(tus, opts) {
        this.tus = tus;
        this.root = ROOT;
        this.crt = opts.crtNames;
        this.asyncSet = opts.asyncSet || new Set();
        this.fnDef = new Map();     // name -> tu (external linkage definitions)
        this.varDef = new Map();    // name -> { tu, t, decl } (external linkage definitions)
        this.classNames = new Map();   // record key -> class name
        this.classScope = new Map();   // record key -> scope that defines it
        this.usedNames = new Set();
        for (const tu of tus) {
            tu.module = moduleName(tu.file);
            tu.addr = this.addrTakenIds(tu.root);
            for (const n of kids(tu.root)) {
                if (!own(n, tu.file)) continue;
                if (n.kind === 'FunctionDecl' && hasBody(n) && n.storageClass !== 'static') {
                    if (this.fnDef.has(n.name)) throw new EmitError(`function ${n.name} defined in ${this.fnDef.get(n.name).file} and ${tu.file}`);
                    this.fnDef.set(n.name, tu);
                }
                if (n.kind === 'VarDecl' && n.storageClass !== 'extern' && n.storageClass !== 'static') {
                    const t = tu.scope.type(n.type.desugaredQualType || n.type.qualType);
                    const prev = this.varDef.get(n.name);
                    // tentative definitions in several TUs (common symbols) merge into one
                    if (!prev || (n.init && !prev.decl.init)) this.varDef.set(n.name, { tu, t, decl: n });
                }
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
        throw new EmitError(`undefined function ${name}`);
    }
    definedIn(tu, name, kind) {
        tu._defs = tu._defs || this.localDefs(tu);
        return tu._defs[kind].has(name);
    }
    localDefs(tu) {
        const fn = new Set(), vars = new Map();
        for (const n of kids(tu.tu.root)) {
            if (!own(n, tu.tu.file)) continue;
            if (n.kind === 'FunctionDecl' && hasBody(n)) fn.add(n.name);
            if (n.kind === 'VarDecl' && n.storageClass !== 'extern') vars.set(n.name, n);
        }
        return { fn, var: vars };
    }
    globalRef(tu, name, t) {
        tu._defs = tu._defs || this.localDefs(tu);
        const local = tu._defs.var.get(name);
        if (local && local.storageClass === 'static') return jsName(name);
        if (!(t.k === 'rec' || t.k === 'arr')) {
            if (local || this.varDef.has(name)) return `$G.${field(name)}`;
            if (this.crt.has(name)) return `$c.${name}`;
            throw new EmitError(`undefined variable ${name}`);
        }
        if (local) return jsName(name);
        const d = this.varDef.get(name);
        if (d) { this.noteImport(tu, d.tu.module, jsName(name)); return jsName(name); }
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
    isAsync(name) { return this.asyncSet.has(name); }
    isAsyncIndirect() { return false; }   // function-pointer targets: from the async analysis (M1 step 2)

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
    /** Emit every TU; returns { files: Map(path -> text), errors: [] }. Paths are relative to the output dir. */
    emitAll() {
        const files = new Map();
        const errors = [];
        for (const tu of this.tus) {
            const em = new TUEmitter(tu, this);
            files.set(`${tu.module}.js`, em.run());   // imports are collected while emitting
            for (const e of em.errors) errors.push(`${tu.file}: ${e}`);
        }
        files.set('types.js', this.typesModule());
        files.set('globals.js', this.globalsModule());
        files.set('index.js', this.indexModule());
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
        const out = ['// globals.js: external scalar and pointer variables (generated by transpiler/emit). Do not edit.', 'export const $G = {'];
        const names = [...this.varDef.keys()].sort();
        for (const n of names) {
            const { t, tu } = this.varDef.get(n);
            if (t.k === 'rec' || t.k === 'arr') continue;
            out.push(`    ${field(n)}: ${zeroOf(t, (k) => this.className(k, tu.scope))},   // ${tu.file}`);
        }
        out.push('};', '');
        return out.join('\n');
    }
    indexModule() {
        const out = ['// index.js: module list and static initialization order (generated). Do not edit.'];
        for (const tu of this.tus) out.push(`import { $init as ${tu.module.replace(/[^A-Za-z0-9_$]/g, "_")}$init } from './${tu.module}.js';`);
        out.push('', 'export function $initAll() {');
        for (const tu of this.tus) out.push(`    ${tu.module.replace(/[^A-Za-z0-9_$]/g, "_")}$init();`);
        out.push('}', '');
        return out.join('\n');
    }
}
