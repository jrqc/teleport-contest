// classes.mjs: record types -> JS classes (transpiler-design.md 3.2).
// Each struct becomes a class whose constructor zero-initializes every field
// (C static zero-init and calloc/memset 0 both map to `new T()`), with
// $copyFrom (C struct assignment: deep for embedded records and arrays,
// shallow for pointers) and $clone. A union (object union, D1) keeps one
// value slot `$v`, with a getter/setter per member name.
import { field } from './names.mjs';

/** JS expression for the zero value of type t. */
export function zeroOf(t, cls) {
    switch (t.k) {
    case 'int': case 'float': return '0';
    case 'ptr': case 'fn': case 'builtinfn': return 'null';
    case 'rec': return `new $T.${cls(t.key)}()`;
    case 'arr': return arrayInit(t, cls);
    case 'opaque': return '0';
    default: throw new Error(`zeroOf: ${t.k}`);
    }
}

/** Typed array constructor name for a scalar element type, or null. */
export function typedArrayOf(t) {
    if (t.k === 'int') {
        if (t.size === 1) return t.signed ? 'Int8Array' : 'Uint8Array';
        if (t.size === 2) return t.signed ? 'Int16Array' : 'Uint16Array';
        if (t.size === 4) return t.signed ? 'Int32Array' : 'Uint32Array';
        return null;   // 64-bit: Number|BigInt values, plain Array
    }
    if (t.k === 'float') return t.size === 4 ? 'Float32Array' : 'Float64Array';
    return null;
}

export function arrayInit(t, cls) {
    const n = t.n || 0;
    const e = t.of;
    const ta = typedArrayOf(e);
    if (ta) return `new ${ta}(${n})`;
    switch (e.k) {
    case 'int': return `$c.zeros(${n})`;
    case 'ptr': case 'fn': return `$c.nulls(${n})`;
    case 'rec': return `$c.recArray($T.${cls(e.key)}, ${n})`;
    case 'arr': return `$c.arrayOf(${n}, () => ${arrayInit(e, cls)})`;
    default: throw new Error(`arrayInit: ${e.k}`);
    }
}

/** Statements copying value `s` into `d` for type t (d and s are JS expressions). */
function copyStmts(d, s, t, cls, ind, depth = 0) {
    switch (t.k) {
    case 'rec': return [`${ind}${d}.$copyFrom(${s});`];
    case 'arr': {
        if (typedArrayOf(t.of)) return [`${ind}${d}.set(${s});`];
        const i = `i${depth}`;
        if (t.of.k === 'rec' || t.of.k === 'arr') {
            return [`${ind}for (let ${i} = 0; ${i} < ${t.n || 0}; ${i}++) {`,
                ...copyStmts(`${d}[${i}]`, `${s}[${i}]`, t.of, cls, ind + '    ', depth + 1), `${ind}}`];
        }
        return [`${ind}for (let ${i} = 0; ${i} < ${t.n || 0}; ${i}++) ${d}[${i}] = ${s}[${i}];`];
    }
    default: return [`${ind}${d} = ${s};`];
    }
}

/**
 * Source of the class for record `key`.
 * @param scope ctypes Scope; @param cls key -> class name
 */
export function classSource(scope, key, cls, origin) {
    const r = scope.record(key);
    const L = scope.recordLayout(key);
    const name = cls(key);
    const out = [];
    out.push(`// ${r.union ? 'union' : 'struct'} ${key.startsWith('@') ? '(anonymous)' : key}${origin ? ` (${origin})` : ''}`);
    out.push(`export class ${name} {`);
    out.push(`    static $size = ${L.size};   // sizeof: lets the runtime turn byte counts into element counts`);
    if (r.union) {
        // one value slot $v; $k is the member last stored or used as an embedded aggregate.
        // Copying copies an embedded record/array member deeply and anything else (scalars,
        // pointers) as the value it is.
        const first = L.fields.find((f) => f.js);
        out.push(`    constructor() { this.$v = ${first ? zeroOf(first.type, cls) : '0'}; this.$k = ${first ? `'${field(first.js)}'` : 'null'}; }`);
        const agg = [];
        for (const f of L.fields) {
            if (!f.js) continue;
            const fn = field(f.js);
            if (f.type.k === 'rec' || f.type.k === 'arr') {
                agg.push(fn);
                out.push(`    get ${fn}() { if (this.$k !== '${fn}') { this.$v = ${zeroOf(f.type, cls)}; this.$k = '${fn}'; } return this.$v; }`);
                out.push(`    set ${fn}(x) { this.$v = x; this.$k = '${fn}'; }`);
            } else {
                out.push(`    get ${fn}() { return this.$v; }`);
                out.push(`    set ${fn}(x) { this.$v = x; this.$k = '${fn}'; }`);
            }
        }
        out.push('    $copyFrom(s) {');
        out.push('        const v = s.$v;');
        if (agg.length) {
            out.push(`        if (${agg.map((a) => `s.$k === '${a}'`).join(' || ')}) this.$v = v.$clone ? v.$clone() : v.slice();`);
            out.push('        else this.$v = v;');
        } else out.push('        this.$v = v;');
        out.push('        this.$k = s.$k;');
        out.push('        return this;');
        out.push('    }');
    } else {
        out.push('    constructor() {');
        for (const f of L.fields) {
            if (!f.js) continue;
            out.push(`        this.${field(f.js)} = ${zeroOf(f.type, cls)};`);
        }
        out.push('    }');
        out.push('    $copyFrom(s) {');
        for (const f of L.fields) {
            if (!f.js) continue;
            const fn = field(f.js);
            out.push(...copyStmts(`this.${fn}`, `s.${fn}`, f.type, cls, '        '));
        }
        out.push('        return this;');
        out.push('    }');
    }
    out.push(`    $clone() { return new ${name}().$copyFrom(this); }`);
    out.push('}');
    return out.join('\n');
}
