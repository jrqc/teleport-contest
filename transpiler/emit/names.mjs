// names.mjs: C identifiers -> JS identifiers (transpiler-design.md 4.5).
// C names are kept; names JS reserves or that would shadow globals the
// generated code relies on get a fixed "_" suffix, from a fixed list (never a
// counter or hash, so a change elsewhere cannot rename anything).
const RESERVED = new Set(`
    await break case catch class const continue debugger default delete do else enum export extends
    false finally for function if implements import in instanceof interface let new null package private
    protected public return static super switch this throw true try typeof var void while with yield
    arguments eval undefined NaN Infinity
    Object Array Number String Boolean Symbol BigInt Math JSON Map Set WeakMap Promise Error Date RegExp
    Function Reflect Proxy globalThis isNaN isFinite parseInt parseFloat Int8Array Uint8Array Int16Array
    Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array ArrayBuffer
    DataView console process
    G
`.split(/\s+/).filter(Boolean));

/** JS identifier for a C identifier (variables, functions, fields are not renamed: see field()). */
export function jsName(c) {
    return RESERVED.has(c) ? c + '_' : c;
}

/** Object property names may be any identifier except the runtime's own ($-prefixed, __arr/__idx). */
export function field(c) {
    return c === '__arr' || c === '__idx' || c === '__proto__' || c === 'constructor' ? c + '_' : c;
}
