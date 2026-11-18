// ctypes.mjs: C types for the IR (transpiler-design.md 2, 3.1, 3.2).
//
// Clang's JSON AST gives expression types only as C declarator strings, and
// only desugars a typedef at the top level ("coordxy *" stays sugared). This
// module parses those strings into type objects and resolves typedef, record
// and enum names through a per-TU Scope built from the TU's declarations.
// Layout (size, align, field offsets, bit-fields) follows the reference ABI:
// Darwin arm64, LP64, signed char (checked against native probes in
// tests/transpiler/layout.test.mjs).
//
// Type objects (plain, immutable once built; qualifiers are dropped except
// `konst` on the outermost level, which the emitter does not need for
// semantics):
//   { k: 'void' }
//   { k: 'int', name, size, signed }        _Bool, char, short, int, long, long long, enums
//   { k: 'float', name, size }              float (4), double / long double (8)
//   { k: 'ptr', to }
//   { k: 'arr', of, n }                     n === null: incomplete ([])
//   { k: 'fn', ret, params: [type], variadic }   params null: unprototyped / unknown
//   { k: 'rec', key, union }                key: tag name or "@file:line:col" for anonymous
//   { k: 'enum', key }                      resolved to its integer type by Scope.resolve
//   { k: 'builtinfn' }                      clang's <builtin fn type>
//   { k: 'named', name }                    an unresolved typedef name (Scope.resolve)

export const VOID = Object.freeze({ k: 'void' });
const I = (name, size, signed) => Object.freeze({ k: 'int', name, size, signed });
export const INTS = {
    _Bool: I('_Bool', 1, false),
    char: I('char', 1, true),            // Darwin arm64: char is signed
    'signed char': I('signed char', 1, true),
    'unsigned char': I('unsigned char', 1, false),
    short: I('short', 2, true),
    'unsigned short': I('unsigned short', 2, false),
    int: I('int', 4, true),
    'unsigned int': I('unsigned int', 4, false),
    long: I('long', 8, true),
    'unsigned long': I('unsigned long', 8, false),
    'long long': I('long long', 8, true),
    'unsigned long long': I('unsigned long long', 8, false),
    __int128: I('__int128', 16, true),
    'unsigned __int128': I('unsigned __int128', 16, false),
};
export const FLOATS = {
    float: Object.freeze({ k: 'float', name: 'float', size: 4 }),
    double: Object.freeze({ k: 'float', name: 'double', size: 8 }),
    'long double': Object.freeze({ k: 'float', name: 'long double', size: 8 }),   // = double on Darwin arm64
};
export const ptr = (to) => ({ k: 'ptr', to });
/** A builtin type NetHack never computes with (_Float16, SVE vectors): layout only. */
export const OPAQUE = (name, size) => ({ k: 'opaque', name, size });
export const BUILTIN_VA_LIST = ptr(INTS.char);   // Darwin arm64: __builtin_va_list is char *

// ---------- tokenizer ----------
// Anonymous record names are one token: "(unnamed struct at F:L:C)" etc.
const ANON_RE = /^\((?:unnamed|anonymous)(?: (?:struct|union|enum))? at ([^)]*)\)/;
function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        if (c === '(') {
            const m = ANON_RE.exec(s.slice(i));
            if (m) { toks.push({ anon: m[1] }); i += m[0].length; continue; }
        }
        if (s.startsWith('__attribute__((', i)) {   // skip a balanced attribute
            let depth = 0, j = i + '__attribute__'.length;
            for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) { j++; break; } }
            i = j;
            continue;
        }
        if (s.startsWith('...', i)) { toks.push('...'); i += 3; continue; }
        if (s.startsWith('::', i)) { toks.push('::'); i += 2; continue; }
        if ('()[]*,<>'.includes(c)) { toks.push(c); i++; continue; }
        if (c === '^' || c === '&') { toks.push('*'); i++; continue; }   // block pointer, builtin reference: pointer-like
        const m = /^[A-Za-z_][A-Za-z_0-9]*|^[0-9]+/.exec(s.slice(i));
        if (!m) throw new Error(`ctypes: cannot tokenize ${JSON.stringify(s)} at ${i}`);
        toks.push(m[0]);
        i += m[0].length;
    }
    return toks;
}

const QUALS = new Set(['const', 'volatile', 'restrict', '__restrict', '_Nonnull', '_Nullable', '_Null_unspecified',
    '__unsafe_unretained', '_Atomic']);
const BASIC = new Set(['void', 'char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', '_Bool', '__int128']);

/** Parse a clang type string. Anonymous record keys are normalized by `normAnon(loc)`. */
export function parseType(str, normAnon = (l) => l) {
    if (str === '<builtin fn type>') return { k: 'builtinfn' };
    const t = tokenize(str);
    let p = 0;
    const peek = () => t[p];
    const eat = (x) => { if (t[p] !== x) throw new Error(`ctypes: expected ${x} in ${JSON.stringify(str)}, got ${t[p]}`); p++; };

    function specifiers() {
        const words = [];
        let base = null;
        for (;;) {
            const x = peek();
            if (x === undefined) break;
            if (typeof x === 'string' && QUALS.has(x)) { p++; continue; }
            if (x === 'struct' || x === 'union' || x === 'enum') {
                p++;
                let key;
                let nx = peek();
                if (nx && typeof nx === 'object') { key = '@' + normAnon(nx.anon); p++; }
                else { key = nx; p++; }
                // "struct outer::(unnamed at ...)": the nested part names the record
                while (peek() === '::') {
                    p++;
                    nx = peek();
                    key = typeof nx === 'object' ? '@' + normAnon(nx.anon) : nx;
                    p++;
                }
                base = x === 'enum' ? { k: 'enum', key } : { k: 'rec', key, union: x === 'union' };
                continue;
            }
            if (x && typeof x === 'object') { base = { k: 'rec', key: '@' + normAnon(x.anon), union: false }; p++; continue; }
            if (typeof x === 'string' && BASIC.has(x)) { words.push(x); p++; continue; }
            if (typeof x === 'string' && /^[A-Za-z_]/.test(x) && !base && words.length === 0) {
                // attribute macros left in system prototypes ("__sort_noescape int (^)(...)")
                if (/^__\w+_noescape$/.test(x)) { p++; continue; }
                if (x === 'bool') { words.push('_Bool'); p++; continue; }
                if (x === '_Float16') { base = OPAQUE(x, 2); p++; continue; }
                base = x === '__builtin_va_list' ? BUILTIN_VA_LIST : { k: 'named', name: x };
                p++;
                continue;
            }
            break;
        }
        if (base) return base;
        if (!words.length) throw new Error(`ctypes: no type specifier in ${JSON.stringify(str)}`);
        return basic(words, str);
    }
    // declarator: returns a function wrapping the base type
    function declarator() {
        let nptr = 0;
        while (peek() === '*' || QUALS.has(peek())) { if (peek() === '*') nptr++; p++; }
        let inner = (b) => b;
        if (peek() === '(' && (t[p + 1] === '*' || t[p + 1] === '(' || t[p + 1] === '^')) {
            p++;
            inner = declarator();
            eat(')');
        }
        const suffixes = [];
        for (;;) {
            if (peek() === '[') {
                p++;
                let n = null;
                if (/^[0-9]+$/.test(peek())) { n = Number(peek()); p++; }
                eat(']');
                suffixes.push({ arr: n });
            } else if (peek() === '(') {
                p++;
                const params = [];
                let variadic = false;
                while (peek() !== ')') {
                    if (peek() === '...') { variadic = true; p++; }
                    else params.push(typeName());
                    if (peek() === ',') p++;
                }
                eat(')');
                suffixes.push({ fn: params, variadic });
            } else break;
        }
        return (b) => {
            for (let i = 0; i < nptr; i++) b = ptr(b);
            for (let i = suffixes.length - 1; i >= 0; i--) {
                const s = suffixes[i];
                if ('arr' in s) b = { k: 'arr', of: b, n: s.arr };
                else {
                    const ps = s.fn.length === 1 && s.fn[0].k === 'void' ? [] : s.fn;
                    b = { k: 'fn', ret: b, params: ps, variadic: s.variadic };
                }
            }
            return inner(b);
        };
    }
    function typeName() {
        const b = specifiers();
        return declarator()(b);
    }
    const ty = typeName();
    if (p !== t.length) throw new Error(`ctypes: trailing tokens in ${JSON.stringify(str)}: ${t.slice(p).join(' ')}`);
    return ty;
}

function basic(words, str) {
    const n = { signed: 0, unsigned: 0, long: 0 };
    let b = null;
    for (const w of words) {
        if (w === 'signed' || w === 'unsigned' || w === 'long') n[w]++;
        else if (w === 'int' && b === null) b = 'int';
        else if (b === null || (b === 'int' && w !== 'int')) b = w;
        else throw new Error(`ctypes: bad specifiers ${JSON.stringify(str)}`);
    }
    if (b === 'void') return VOID;
    if (b === 'float') return FLOATS.float;
    if (b === 'double') return n.long ? FLOATS['long double'] : FLOATS.double;
    if (b === '_Bool') return INTS._Bool;
    if (b === '__int128') return n.unsigned ? INTS['unsigned __int128'] : INTS.__int128;
    if (b === 'char') return n.unsigned ? INTS['unsigned char'] : n.signed ? INTS['signed char'] : INTS.char;
    let name = b === 'short' ? 'short' : n.long >= 2 ? 'long long' : n.long === 1 ? 'long' : 'int';
    return INTS[n.unsigned ? `unsigned ${name}` : name];
}

// ---------- scope: typedefs, records, enums of a TU ----------
/**
 * Scope holds what a TU declares. Built from the resolved AST root (see
 * transpiler/frontend/ast.mjs) by Scope.fromTU. Record definitions are keyed by
 * tag (named) or "@file:line:col" (anonymous; file repo-relative).
 */
export class Scope {
    constructor() {
        this.typedefs = new Map();   // name -> type string (underlying)
        this.records = new Map();    // key -> { key, union, fields: [{ name, typeStr, bits }], pos }
        this.enums = new Map();      // key -> { key, values: [[name, BigInt]], fixed }
        this.enumConsts = new Map(); // constant name -> BigInt value
        this.cache = new Map();
        this.layouts = new Map();
        this.normAnon = (l) => l;
    }

    static fromTU(root, normAnon) {
        const s = new Scope();
        if (normAnon) s.normAnon = normAnon;
        const anonKey = (n) => {
            const l = (n.loc && (n.loc.spellingLoc || n.loc)) || {};
            return '@' + s.normAnon(`${l._f}:${l._l}:${l.col}`, true);
        };
        const byId = new Map();   // decl id -> { kind, key } for anonymous records/enums
        // A typedef of an anonymous record or enum names it in type strings
        // ("typedef struct { ... } lev_region;" prints as "struct lev_region").
        const aliasTypedef = (n) => {
            const find = (x) => {
                for (const c of x.inner || []) {
                    const id = (c.ownedTagDecl && c.ownedTagDecl.id) || (c.decl && c.decl.id);
                    if (id && byId.has(id)) return byId.get(id);
                    const r = find(c);
                    if (r) return r;
                }
                return null;
            };
            const a = find(n);
            if (!a) return;
            if (a.kind === 'rec' && !s.records.has(n.name) && s.records.has(a.key)) s.records.set(n.name, s.records.get(a.key));
            if (a.kind === 'enum' && !s.enums.has(n.name) && s.enums.has(a.key)) s.enums.set(n.name, s.enums.get(a.key));
        };
        const visitRecord = (n) => {
            const key = n.name ? n.name : anonKey(n);
            if (!n.name) byId.set(n.id, { kind: 'rec', key });
            for (const c of n.inner || []) if (c.kind === 'RecordDecl' || c.kind === 'EnumDecl') visit(c);
            if (!n.completeDefinition) return;
            const fields = [];
            for (const c of n.inner || []) {
                if (c.kind !== 'FieldDecl') continue;
                let bits = null;
                if (c.isBitfield) {
                    const ce = (c.inner || [])[0];
                    bits = Number(ce && ce.value !== undefined ? ce.value : NaN);
                    if (!Number.isInteger(bits)) throw new Error(`ctypes: bit-field width of ${key}.${c.name} not constant`);
                }
                fields.push({ name: c.name || '', typeStr: c.type.desugaredQualType || c.type.qualType, sugared: c.type.qualType, bits });
            }
            const prev = s.records.get(key);
            if (!prev) s.records.set(key, { key, union: n.tagUsed === 'union', fields });
        };
        const visit = (n) => {
            switch (n.kind) {
            case 'TypedefDecl':
                if (!s.typedefs.has(n.name)) s.typedefs.set(n.name, n.type.qualType);
                for (const c of n.inner || []) if (c.kind === 'RecordDecl' || c.kind === 'EnumDecl') visit(c);
                aliasTypedef(n);
                break;
            case 'RecordDecl': visitRecord(n); break;
            case 'EnumDecl': {
                const key = n.name ? n.name : anonKey(n);
                if (!n.name) byId.set(n.id, { kind: 'enum', key });
                const values = [];
                let next = 0n;
                for (const c of n.inner || []) {
                    if (c.kind !== 'EnumConstantDecl') continue;
                    const ce = (c.inner || []).find((x) => x.value !== undefined) || (c.inner || [])[0];
                    let v = next;
                    if (ce && ce.value !== undefined) v = BigInt(ce.value);
                    values.push([c.name, v]);
                    s.enumConsts.set(c.name, v);
                    next = v + 1n;
                }
                if (values.length || !s.enums.has(key)) s.enums.set(key, { key, values, fixed: n.fixedUnderlyingType ? n.fixedUnderlyingType.qualType : null });
                break;
            }
            case 'VarDecl': case 'FunctionDecl': case 'DeclStmt': case 'CompoundStmt': case 'TranslationUnitDecl':
                for (const c of n.inner || []) visit(c);
                break;
            default:
                // statements inside functions may declare local records/typedefs
                if (n.inner && n.kind && /Stmt$/.test(n.kind)) for (const c of n.inner) visit(c);
            }
        };
        visit(root);
        return s;
    }

    /** Parse and fully resolve a type string (typedefs and enums expanded; records stay by key). */
    type(str) {
        let t = this.cache.get(str);
        if (!t) { t = this.resolve(parseType(str, (l) => this.normAnon(l, false))); this.cache.set(str, t); }
        return t;
    }

    resolve(t) {
        switch (t.k) {
        case 'named': {
            const u = this.typedefs.get(t.name);
            if (u === undefined) throw new Error(`ctypes: unknown typedef ${t.name}`);
            if (u === t.name) return OPAQUE(t.name, 16);   // self-named builtin (ARM SVE __SVInt8_t ...)
            return this.type(u);
        }
        case 'enum': return this.enumInt(t.key);
        case 'ptr': return ptr(this.resolve(t.to));
        case 'arr': return { k: 'arr', of: this.resolve(t.of), n: t.n };
        case 'fn': return { k: 'fn', ret: this.resolve(t.ret), params: t.params && t.params.map((x) => this.resolve(x)), variadic: t.variadic };
        default: return t;
        }
    }

    /** The integer type clang uses for an enum: fixed type, else unsigned int if no negative values, else int. */
    enumInt(key) {
        const e = this.enums.get(key);
        if (!e) throw new Error(`ctypes: unknown enum ${key}`);
        if (e.fixed) return this.type(e.fixed);
        const neg = e.values.some(([, v]) => v < 0n);
        const max = e.values.reduce((m, [, v]) => (v > m ? v : m), 0n);
        const min = e.values.reduce((m, [, v]) => (v < m ? v : m), 0n);
        if (!neg) return max <= 0xffffffffn ? INTS['unsigned int'] : INTS['unsigned long'];
        return min >= -0x80000000n && max <= 0x7fffffffn ? INTS.int : INTS.long;
    }

    record(key) {
        const r = this.records.get(key);
        if (!r) throw new Error(`ctypes: incomplete or unknown record ${key}`);
        return r;
    }

    // ---------- layout (Darwin arm64) ----------
    sizeof(t) { return this.layoutOf(t).size; }
    alignof(t) { return this.layoutOf(t).align; }

    layoutOf(t) {
        switch (t.k) {
        case 'int': case 'float': case 'opaque': return { size: t.size, align: t.size };
        case 'ptr': return { size: 8, align: 8 };
        case 'void': return { size: 1, align: 1 };   // GNU: sizeof(void) == 1
        case 'fn': case 'builtinfn': return { size: 1, align: 1 };
        case 'arr': {
            const e = this.layoutOf(t.of);
            return { size: e.size * (t.n || 0), align: e.align };
        }
        case 'rec': return this.recordLayout(t.key);
        default: throw new Error(`ctypes: no layout for ${t.k}`);
        }
    }

    /**
     * Record layout with clang's rules for Darwin arm64 (generic Itanium ABI):
     * a bit-field goes at the current bit offset unless it would cross a
     * boundary of its declared type's size; a zero-width bit-field aligns to
     * its type; named bit-fields contribute their type's alignment, unnamed ones
     * do not (verified by the native probe).
     * Returns { size, align, fields: [{ name, type, offset, bitOffset, bits }] }.
     */
    recordLayout(key) {
        let L = this.layouts.get(key);
        if (L) return L;
        const r = this.record(key);
        const fields = [];
        let bit = 0, align = 1, size = 0;
        for (const f of r.fields) {
            const type = this.type(f.typeStr);
            const fl = this.layoutOf(type);
            if (r.union) {
                if (f.bits !== null) {
                    if (f.name) align = Math.max(align, fl.align);
                    size = Math.max(size, Math.ceil(f.bits / 8));
                    fields.push({ name: f.name, type, offset: 0, bitOffset: 0, bits: f.bits });
                } else {
                    align = Math.max(align, fl.align);
                    size = Math.max(size, fl.size);
                    fields.push({ name: f.name, type, offset: 0, bitOffset: 0, bits: null });
                }
                continue;
            }
            if (f.bits !== null) {
                const unit = fl.size * 8;
                if (f.bits === 0) { bit = Math.ceil(bit / (fl.align * 8)) * fl.align * 8; continue; }
                if (Math.floor(bit / unit) !== Math.floor((bit + f.bits - 1) / unit)) bit = Math.ceil(bit / unit) * unit;
                const offset = Math.floor(bit / unit) * fl.size;
                fields.push({ name: f.name, type, offset, bitOffset: bit - offset * 8, bits: f.bits });
                bit += f.bits;
                if (f.name) align = Math.max(align, fl.align);
            } else {
                const a = fl.align * 8;
                bit = Math.ceil(bit / a) * a;
                fields.push({ name: f.name, type, offset: bit / 8, bitOffset: 0, bits: null });
                bit += fl.size * 8;
                align = Math.max(align, fl.align);
            }
        }
        if (!r.union) size = Math.ceil(bit / 8);
        size = Math.ceil(size / align) * align;
        L = { size, align, fields };
        this.layouts.set(key, L);
        return L;
    }
}

/** A short printable form of a type (diagnostics, tests). */
export function show(t) {
    switch (t.k) {
    case 'void': return 'void';
    case 'int': case 'float': return t.name;
    case 'ptr': return show(t.to) + '*';
    case 'arr': return `${show(t.of)}[${t.n === null ? '' : t.n}]`;
    case 'fn': return `${show(t.ret)}(${t.params ? t.params.map(show).join(',') : '?'}${t.variadic ? ',...' : ''})`;
    case 'rec': return (t.union ? 'union ' : 'struct ') + t.key;
    case 'enum': return 'enum ' + t.key;
    case 'named': return t.name;
    default: return t.k;
    }
}
