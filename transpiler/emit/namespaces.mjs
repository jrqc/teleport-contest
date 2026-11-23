// namespaces.mjs: constant namespaces (readability plan P2c, method/readability-plan.md).
//
// A family is one C enum declaration, or one run of consecutive numeric object-like
// #defines of one header. Its prefix is the longest prefix ending in '_' that at least two
// and at least 80% of its members share. A family whose prefix starts with an upper-case
// letter becomes a namespace named after the prefix without its '_' (PM_ANGEL -> PM.ANGEL);
// families with the same prefix share one namespace (A_STR and A_LAWFUL -> A.STR, A.LAWFUL).
// Everything else keeps its C name: enums without a shared prefix, members outside the
// prefix, standalone constants, lower-case prefixes, a namespace name that is already a
// global C name, a short name that is not an identifier. A .c file's families are local to
// its module and never merge with header ones.
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { ROOT } from '../frontend/ast.mjs';
import { defines, sourceText, identAt } from './macros.mjs';
import { macroConstText } from './consts.mjs';

const REC = 'tools/recorder-env/build/nethack-c/recorder';
// JS globals a namespace must not shadow
const JS_GLOBALS = new Set(['Object', 'Array', 'Math', 'Number', 'String', 'Map', 'Set', 'Date', 'JSON', 'Error', 'Symbol',
    'Promise', 'Reflect', 'Proxy', 'BigInt', 'Infinity', 'NaN', 'Boolean', 'Function', 'RegExp', 'Intl', 'Atomics', 'WeakMap', 'WeakSet']);

/** The longest prefix ending in '_' that >= 2 and >= 80% of `names` share, or ''. */
export function familyPrefix(names) {
    const c = new Map();
    for (const n of names) for (let i = n.indexOf('_'); i > 0 && i < n.length - 1; i = n.indexOf('_', i + 1)) { const p = n.slice(0, i + 1); c.set(p, (c.get(p) || 0) + 1); }
    let best = '';
    for (const [p, k] of c) if (k >= 2 && k >= 0.8 * names.length && (p.length > best.length || (p.length === best.length && p < best))) best = p;
    return best;
}
const seg = (n) => { const i = n.indexOf('_'); return i > 0 && i < n.length - 1 ? n.slice(0, i + 1) : ''; };

/** The headers whose #define runs can form families (repo-relative). */
function headerFiles(extra) {
    const out = new Set(extra);
    for (const dir of ['include', 'lib/lua-5.4.8/src']) {
        let fs = [];
        try { fs = readdirSync(path.join(ROOT, REC, dir)); } catch { fs = []; }
        for (const f of fs) if (f.endsWith('.h')) out.add(`${REC}/${dir}/${f}`);
    }
    return [...out].sort();
}

/** The #define of `file` whose body covers offset `off`, by name (null outside every body). */
const bodyCache = new Map();
function bodyOf(file, off) {
    let sp = bodyCache.get(file);
    if (!sp) { sp = defines(file).filter((d) => d.bodyStart >= 0).map((d) => [d.bodyStart, d.lastTok, d.name]).sort((a, b) => a[0] - b[0]); bodyCache.set(file, sp); }
    let lo = 0, hi = sp.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (sp[m][1] < off) lo = m + 1; else if (sp[m][0] > off) hi = m - 1; else return sp[m][2]; }
    return null;
}
/**
 * The macros one TU expands (facts pass): the name at each expansion location, and the
 * #define whose body a token is spelled in (a macro inside another macro, or the literal a
 * constant expands to). With `fnOnly`, only inside function bodies: P3 makes functions there
 * only, so only those block a namespace of their name (A(...) and S build tables, ONAME() is
 * code). Without it, every use: a #define is in an active #if branch only if a TU expands
 * it, so only those join a namespace (an inactive one may hold another value: winami.h's
 * NHW_BASE 6, wintty.h's 7).
 */
export function addExpanded(root, out, fnOnly) {
    const seen = new Set();
    const visit = (x) => {
        if (!x || typeof x !== 'object') return;
        const b = x.range && x.range.begin;
        if (b && b.expansionLoc && b.spellingLoc) {
            const e = b.expansionLoc, sl = b.spellingLoc;
            if (e._f && !path.isAbsolute(e._f)) { const k = `${e._f}:${e.offset}`; if (!seen.has(k)) { seen.add(k); const nm = identAt(sourceText(e._f), e.offset); if (nm) out.add(nm); } }
            if (sl._f && !path.isAbsolute(sl._f)) { const nm = bodyOf(sl._f, sl.offset); if (nm) out.add(nm); }
        }
        for (const c of x.inner || []) visit(c);
    };
    if (!fnOnly) visit(root);
    else for (const d of root.inner || []) if (d.kind === 'FunctionDecl') for (const c of d.inner || []) if (c.kind === 'CompoundStmt') visit(c);
}

export class Namespaces {
    /**
     * consts: the ConstTable (enums, after every TU's facts); isGlobal(name): whether a C
     * name the generated code uses (function, variable, runtime, macro) is `name`.
     */
    constructor(consts, isGlobal, macroUses, expanded) {
        this.member = new Map();   // `${file}\0${C name}` -> { ns, short, key }
        this.spaces = new Map();   // key (ns, or `${file}\0${ns}` for a .c file) -> { ns, home, local, families: [...] }
        this.names = new Set();    // namespace names (locals with these names are renamed)
        const fams = [];
        // enum families
        for (const e of consts.enums) {
            const recs = e.names.map((n) => consts.byFile.get(e.file).get(n)).filter(Boolean);
            fams.push({ kind: 'enum', file: e.file, offset: e.offset, members: recs.map((r) => ({ name: r.name, offset: r.offset, rec: r })) });
        }
        // #define families: runs of consecutive numeric object-like #defines with one first segment
        // a macro blocks a namespace of its name only if function code invokes it (only
        // there can P3 emit it under its name): A(...) and S build tables, ONAME() is code
        const blocking = macroUses || new Set();
        // a member is a #define that object-world code expands and that no other header defines
        const hdrs = headerFiles(consts.headerFiles());
        const count = new Map();
        for (const f of hdrs) for (const d of defines(f)) count.set(d.name, (count.get(d.name) || 0) + 1);
        for (const f of hdrs) {
            const ds = defines(f);
            let run = null;
            for (const d of ds) {
                const t = !d.fnlike && count.get(d.name) === 1 && (!expanded || expanded.has(d.name)) && !consts.fileOf.has(d.name) ? macroConstText(d.body) : null;
                if (!t) continue;   // other #defines do not break a run
                const p = seg(d.name);
                if (run && p && p === run.seg) run.members.push({ name: d.name, offset: d.bodyStart, text: t.text, v: t.v });
                else { run = { kind: 'define', file: f, offset: d.bodyStart, seg: p, members: [{ name: d.name, offset: d.bodyStart, text: t.text, v: t.v }] }; fams.push(run); }
            }
        }
        const taken = (ns) => JS_GLOBALS.has(ns) || isGlobal(ns) || consts.fileOf.has(ns) || blocking.has(ns);
        const dbg = process.env.NH_NS_DEBUG ? new Set(process.env.NH_NS_DEBUG.split(',')) : null;
        for (const fam of fams) {
            const prefix = familyPrefix(fam.members.map((m) => m.name));
            if (dbg && fam.members.some((m) => dbg.has(m.name))) process.stderr.write(`\nns-debug ${fam.kind} ${fam.file} [${fam.members.map((m) => m.name).join(',')}] prefix=${prefix} taken=${prefix && taken(prefix.slice(0, -1))} glob=${prefix && isGlobal(prefix.slice(0, -1))} enum=${prefix && consts.fileOf.has(prefix.slice(0, -1))} macro=${prefix && blocking.has(prefix.slice(0, -1))}\n`);
            if (!prefix) continue;
            const ns = prefix.slice(0, -1);
            if (!/^[A-Z]/.test(ns) || taken(ns)) continue;
            const local = !/\.h$/.test(fam.file);
            const key = local ? `${fam.file}\0${ns}` : ns;
            fam.prefix = prefix;
            fam.ns = ns;
            if (!this.spaces.has(key)) this.spaces.set(key, { ns, key, local, families: [] });
            this.spaces.get(key).families.push(fam);
        }
        // a .c namespace with a header namespace's name would shadow it: flat
        for (const [key, sp] of [...this.spaces]) if (sp.local && this.spaces.has(sp.ns)) this.spaces.delete(key);
        for (const [key, sp] of [...this.spaces]) {
            sp.families.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.offset - b.offset));
            const shorts = new Map();
            let clash = false;
            for (const fam of sp.families) for (const m of fam.members) {
                if (!m.name.startsWith(fam.prefix)) continue;
                if (m.rec && (consts.bad.has(m.name) || consts.fileOf.get(m.name) !== fam.file || !Number.isSafeInteger(Number(m.rec.value)))) continue;
                const short = m.name.slice(fam.prefix.length);
                if (!/^[A-Za-z_$][\w$]*$/.test(short)) continue;
                if (shorts.has(short)) clash = true;
                shorts.set(short, m);
                m.short = short;
            }
            if (clash || !shorts.size) { this.spaces.delete(key); continue; }
            // home: the header with most members (ties: path order)
            const per = new Map();
            for (const fam of sp.families) per.set(fam.file, (per.get(fam.file) || 0) + fam.members.filter((m) => m.short).length);
            sp.home = [...per].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
            // the object's place in its module: the first member it holds from the home file
            sp.offset = Math.min(...sp.families.filter((f) => f.file === sp.home).flatMap((f) => f.members.filter((m) => m.short).map((m) => m.offset)));
            for (const fam of sp.families) for (const m of fam.members) if (m.short) this.member.set(`${fam.file}\0${m.name}`, { ns: sp.ns, short: m.short, key, home: sp.home, local: sp.local });
            this.names.add(sp.ns);
        }
    }
    /** The namespace member for C constant `name` defined in `file`: { ns, short, home, local, key } or null. */
    of(file, name) { return this.member.get(`${file}\0${name}`) || null; }
    /** The namespaces defined in module file `file` (home), in source order. */
    homedIn(file) { return [...this.spaces.values()].filter((s) => s.home === file).sort((a, b) => a.offset - b.offset || (a.ns < b.ns ? -1 : 1)); }
}
