// consts.mjs: named constants (readability plan P2, method/readability-plan.md).
//
// Enum constants are emitted by name instead of clang's folded value: each header's
// enum constants become exports of a generated module named after the header
// (`monsters.h` -> js/nh/monsters.h.js), defined the way the C defines them
// (`PM_KILLER_BEE = PM_GIANT_ANT + 1` for an implicit value), so inserting a constant
// changes two lines instead of renumbering every later one. Enums of a .c file are
// module-level constants of that file's module.
//
// Exactness: a constant expression is printed only from literals, enum constants,
// casts and the operators below, and the printed text is evaluated with JS
// semantics (Numbers; bitwise operators on int32) and compared with clang's value
// for the node's type. Anything else, or any mismatch, keeps the number.
import path from 'node:path';
import { E, par, PREC } from './tu.mjs';

const kids = (n) => n.inner || [];
// operator precedences (a function: tu.mjs and this module import each other)
const BIN = () => ({ '+': PREC.add, '-': PREC.add, '*': PREC.mul, '<<': PREC.shift, '>>': PREC.shift, '|': PREC.bor, '&': PREC.band, '^': PREC.bxor });
const UN = new Set(['-', '+', '~']);

/** The module (without .js) that holds the constants of header `file` (repo-relative). */
export const headerModule = (file) => path.basename(file);   // monsters.h -> './monsters.h.js'
const declFile = (d) => { const l = d.loc && (d.loc.expansionLoc || d.loc); return l && l._f; };

/**
 * A constant expression as JS text: { c, p, v (Number), names: [[jsName, ref]] } or null.
 * `ref(name, declId)` returns the binding for an enum constant ({ js, v (Number) }) or null.
 */
export function constExpr(n, ref) {
    const r = pr(n, ref);
    return r && r.names.length ? r : null;
}
function pr(n, ref) {
    if (!n) return null;
    // the whole expansion of a constant object-like #define (TUEmitter.macroConst)
    const m = ref.macro && ref.macro(n);
    if (m) return { c: m.js, p: PREC.prim, v: m.v, names: [[m.js, m]] };
    switch (n.kind) {
    case 'ParenExpr': return pr(kids(n)[0], ref);
    case 'ConstantExpr': return kids(n)[0] ? pr(kids(n)[0], ref) : lit(Number(n.value));
    case 'IntegerLiteral': case 'CharacterLiteral': return lit(Number(n.value));
    case 'ImplicitCastExpr': case 'CStyleCastExpr': {
        if (n.castKind !== 'IntegralCast' && n.castKind !== 'NoOp') return null;
        return pr(kids(n)[0], ref);   // value changes are caught by the comparison with clang's value
    }
    case 'DeclRefExpr': {
        const d = n.referencedDecl;
        if (!d || d.kind !== 'EnumConstantDecl') return null;
        const b = ref(d.name, d.id);
        return b ? { c: b.js, p: PREC.prim, v: b.v, names: [[b.js, b]] } : null;
    }
    case 'UnaryOperator': {
        if (!UN.has(n.opcode)) return null;
        const a = pr(kids(n)[0], ref);
        if (!a) return null;
        const v = n.opcode === '-' ? -a.v : n.opcode === '~' ? ~a.v : +a.v;
        const c = n.opcode === '-' && a.c.startsWith('-') ? `-(${a.c})` : `${n.opcode}${par(a, PREC.unary)}`;
        return { c, p: PREC.unary, v, names: a.names };
    }
    case 'BinaryOperator': {
        const p = BIN()[n.opcode];
        if (!p) return null;
        const [x, y] = kids(n);
        const a = pr(x, ref), b = pr(y, ref);
        if (!a || !b) return null;
        let v;
        switch (n.opcode) {
        case '+': v = a.v + b.v; break;
        case '-': v = a.v - b.v; break;
        case '*': v = a.v * b.v; break;
        case '<<': v = a.v << b.v; break;
        case '>>': v = a.v >> b.v; break;
        case '|': v = a.v | b.v; break;
        case '&': v = a.v & b.v; break;
        case '^': v = a.v ^ b.v; break;
        }
        // left-associative: the right operand needs parentheses at equal precedence
        return { c: `${par(a, p)} ${n.opcode} ${par(b, p + 1)}`, p, v, names: [...a.names, ...b.names] };
    }
    default: return null;
    }
}
const lit = (v) => (Number.isSafeInteger(v) ? { c: String(v), p: v < 0 ? PREC.unary : PREC.prim, v, names: [] } : null);

/** Whether printed expression r has exactly clang's value `value` (BigInt) of the node. */
export const exact = (r, value) => {
    const want = Number(value);
    return Number.isSafeInteger(want) && r.v === want && Number.isFinite(r.v);
};

/**
 * Whole-program table of enum constants (facts pass), keyed by defining file and name.
 * Constants a header defines differently in different TUs (or that two headers both
 * define) are left unnamed.
 */
export class ConstTable {
    constructor() {
        this.byFile = new Map();   // file -> Map(name -> { name, file, value, offset, init, prev, enumKey })
        this.fileOf = new Map();   // name -> file, or null when ambiguous
        this.bad = new Set();      // names that keep their number
        this.enums = [];           // enum declarations in first-seen order: { file, offset, names }
        this.enumSeen = new Set();
        this.ns = null;            // Namespaces (namespaces.mjs), set once every TU's facts are in
    }
    /** Collect the file-scope enums of one TU (headers and the .c file). */
    addTU(tu) {
        const visit = (n) => {
            if (n.kind === 'EnumDecl') this.addEnum(n, tu);
            if (n.kind === 'TranslationUnitDecl' || n.kind === 'TypedefDecl' || n.kind === 'RecordDecl') for (const c of kids(n)) visit(c);
        };
        visit(tu.root);
    }
    addEnum(e, tu) {
        const ms = kids(e).filter((c) => c.kind === 'EnumConstantDecl');
        if (ms.length) {
            const f0 = declFile(ms[0]);
            const k = `${f0}\0${ms[0].name}`;
            if (f0 && !path.isAbsolute(f0) && !this.enumSeen.has(k)) {
                this.enumSeen.add(k);
                this.enums.push({ file: f0, offset: (ms[0].loc && (ms[0].loc.expansionLoc || ms[0].loc).offset) ?? 0, names: ms.map((c) => c.name) });
            }
        }
        let prev = null, next = 0n;
        for (const c of kids(e)) {
            if (c.kind !== 'EnumConstantDecl') continue;
            const file = declFile(c);
            const ce = kids(c).find((x) => x.value !== undefined) || kids(c)[0];
            const value = ce && ce.value !== undefined ? BigInt(ce.value) : next;
            next = value + 1n;
            const rec = { name: c.name, file, value, offset: (c.loc && (c.loc.expansionLoc || c.loc).offset) ?? 0, init: ce || null, prev, tu: tu.file };
            prev = c.name;
            if (!file || path.isAbsolute(file)) { this.bad.add(c.name); continue; }   // system headers keep numbers
            if (!this.byFile.has(file)) this.byFile.set(file, new Map());
            const m = this.byFile.get(file);
            const old = m.get(c.name);
            if (old && old.value !== value) this.bad.add(c.name);
            if (!old) m.set(c.name, rec);
            const f0 = this.fileOf.get(c.name);
            if (f0 === undefined) this.fileOf.set(c.name, file);
            else if (f0 !== file) { this.fileOf.set(c.name, null); this.bad.add(c.name); }
        }
    }
    /** The binding for constant `name` defined in `file`: { js, module (null = local), v } or null. */
    binding(name, file, jsName) {
        if (this.bad.has(name) || !file || this.fileOf.get(name) !== file) return null;
        const r = this.byFile.get(file) && this.byFile.get(file).get(name);
        if (!r || !Number.isSafeInteger(Number(r.value))) return null;
        const m = this.ns && this.ns.of(file, name);
        if (m) return { js: `${m.ns}.${m.short}`, file, v: Number(r.value), header: /\.h$/.test(file), nsm: m };
        return { js: jsName(name), file, v: Number(r.value), header: /\.h$/.test(file) };
    }
    /**
     * The definition lines of the constants of `file`: [lines, imports Map(module -> Set(js))].
     * `local` (a .c file): plain `const`, else `export const`.
     */
    definitions(file, jsName, local) {
        const m = this.byFile.get(file) || new Map();
        if (!m.size && !(this.ns && this.ns.homedIn(file).length)) return { lines: [], entries: [], imports: new Map() };
        const imports = new Map();
        const lines = [], entries = [];
        const kw = local ? 'const' : 'export const';
        const ref = (atOffset) => (nm) => {
            const b = this.binding(nm, this.fileOf.get(nm), jsName);
            if (!b) return null;
            if (b.nsm) {
                // a namespace member: its object must be defined in this module before the use
                // (a .c file may import a header's namespace)
                const sp = this.ns.spaces.get(b.nsm.key);
                if (sp.home === file) return sp.offset < atOffset ? b : null;
                return local && !sp.local ? b : null;
            }
            // a constant defined later in the same file is not initialized yet (TDZ)
            if (b.file === file && m.get(nm).offset >= atOffset) return null;
            // header modules import nothing, so they cannot form an import cycle (an
            // enum continued in another header, optlist.h in global.h, keeps the number)
            if (!local && b.file !== file) return null;
            return b;
        };
        const imp = (b) => {
            if (b.nsm) { const sp = this.ns.spaces.get(b.nsm.key); if (sp.home !== file) addImp(imports, headerModule(sp.home), sp.ns); }
            else if (b.file !== file) addImp(imports, headerModule(b.file), b.js);
        };
        for (const r of [...m.values()].sort((a, b) => a.offset - b.offset || (a.name < b.name ? -1 : 1))) {
            if (this.bad.has(r.name) || this.fileOf.get(r.name) !== file || !Number.isSafeInteger(Number(r.value))) continue;
            if (this.ns && this.ns.of(file, r.name)) continue;   // defined in its namespace object
            let text = null;
            const rf = ref(r.offset);
            if (r.init) {
                const x = constExpr(r.init, rf);
                if (x && exact(x, r.value)) { text = x.c; for (const [, b] of x.names) imp(b); }
            } else if (r.prev && rf(r.prev)) {
                const b = rf(r.prev);
                if (b.v + 1 === Number(r.value)) { text = `${b.js} + 1`; imp(b); }
            } else if (r.value === 0n) text = '0';
            if (text === null) text = String(r.value);
            lines.push(`${kw} ${jsName(r.name)} = ${text};`);
            entries.push({ offset: r.offset, line: lines[lines.length - 1] });
        }
        if (this.ns) for (const sp of this.ns.homedIn(file)) entries.push({ offset: sp.offset, line: this.namespaceText(sp, kw, jsName, ref, imp) });
        return { lines, entries, imports };
    }
    /**
     * One namespace object (P2c). Enums: $c.cenum([...]) with C's implicit numbering (a name
     * alone is the previous entry + 1, the first 0; [name, value] where C writes a value or
     * the list leaves C's order; a value using earlier members of the same namespace is a
     * function of the object). #define-only namespaces: a frozen object literal of the C values.
     */
    namespaceText(sp, kw, jsName, ref, imp) {
        const out = [];
        const enumy = sp.families.some((f) => f.kind === 'enum');
        let prevRec = null, prevV = null;
        for (const fam of sp.families) {
            for (const mb of fam.members) {
                if (!mb.short) { prevRec = null; continue; }
                if (!enumy) { out.push(`    ${mb.short}: ${mb.text},`); continue; }
                if (fam.kind === 'define') { out.push(`    ['${mb.short}', ${mb.text}],`); prevRec = null; prevV = mb.v; continue; }
                const r = mb.rec;
                const v = Number(r.value);
                if (!r.init && prevRec && prevRec.name === r.prev && prevV + 1 === v) out.push(`    '${mb.short}',`);
                else if (!r.init && prevRec === null && out.length === 0 && v === 0) out.push(`    '${mb.short}',`);
                else {
                    let text = String(r.value), usesE = false;
                    if (r.init) {
                        const base = ref(r.offset);
                        const x = constExpr(r.init, (nm) => {
                            const b = this.binding(nm, this.fileOf.get(nm), jsName);
                            if (b && b.nsm && b.nsm.key === sp.key) {
                                const o = this.byFile.get(b.file).get(nm);
                                if (o && o.offset < r.offset && this.ns.of(b.file, nm)) { usesE = true; return { ...b, js: `e.${b.nsm.short}`, self: true }; }
                                return null;
                            }
                            // a value outside the namespace: defined before the namespace object
                            return base(nm) && (!b.nsm) && (b.file !== sp.home || this.byFile.get(b.file).get(nm).offset < sp.offset) ? b : null;
                        });
                        if (x && exact(x, r.value)) { text = x.c; for (const [, b] of x.names) if (!b.self) imp(b); } else usesE = false;
                    }
                    out.push(`    ['${mb.short}', ${usesE ? `(e) => ${text}` : text}],`);
                }
                prevRec = r; prevV = v;
            }
        }
        if (out.length) out[out.length - 1] = out[out.length - 1].replace(/,$/, '');
        return enumy ? `${kw} ${sp.ns} = $c.cenum([\n${out.join('\n')}\n]);` : `${kw} ${sp.ns} = Object.freeze({\n${out.join('\n')}\n});`;
    }
    headerFiles() { return [...this.byFile.keys()].filter((f) => /\.h$/.test(f)).sort(); }
}
const addImp = (m, mod, js) => { if (!m.has(mod)) m.set(mod, new Set()); m.get(mod).add(js); };

/**
 * A constant object-like #define as JS: the body with C's integer suffixes removed and
 * octal written 0o, when every token is a number or an operator (no identifiers, so the
 * value is the same in every TU). Returns { text, v } or null.
 */
export function macroConstText(body) {
    if (/[A-Za-z_][A-Za-z0-9_]*/.test(body.replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]*\b/g, '0'))) return null;
    if (/['".]/.test(body)) return null;
    const text = body.replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b/g, '$1').replace(/\b0([0-7]+)\b/g, '0o$1');
    if (/\b0[0-9]/.test(text.replace(/0o[0-7]+/g, ''))) return null;
    let v;
    try { v = Function(`"use strict"; return (${text});`)(); } catch { return null; }
    return typeof v === 'number' && Number.isSafeInteger(v) ? { text, v } : null;
}
