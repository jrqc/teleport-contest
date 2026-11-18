// Tests for the annotation checker (tool 4.8) and the JSONC reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnnotations, functionHash } from '../../transpiler/annotations/check.mjs';
import { parseJsonc } from '../../transpiler/annotations/jsonc.mjs';

const SRC = { 'src/a.c': ['int f(void)', '{', '    return 1;', '}'] };
function facts(over = {}) {
    return {
        functions: {
            f: { name: 'f', file: 'src/a.c', line: 1, endLine: 4, calls: ['g'] },
            g: { name: 'g', file: 'src/a.c', line: 1, endLine: 1, calls: [] },
            'lib/lua/x.c::h': { name: 'h', file: 'lib/lua/x.c', line: 1, endLine: 1, calls: [] },
        },
        records: { 'struct s': 'src/a.h:1', 'struct t': 'src/a.h:5', 'union u': 'src/a.h:9', 'struct L': 'lib/lua/x.h:1' },
        evidence: {},
        unions: { 'union u': { verdict: 'union-cell', file: 'src/a.h' } },
        macros: new Set(['M_ALLOC', 'M_SPACE']),
        unresolvedIndirect: {},
        icallDescs: new Set(['member:fp|void (void)']),
        asyncSize: 1,
        fileExists: (p) => ['js/hand/f.js', 'js/ext.js'].includes(p),
        countLines: () => 10,
        sourceLines: (file, line, end) => SRC[file].slice(line - 1, end),
        ...over,
    };
}
const ok = (ann, f = facts()) => checkAnnotations(ann, f);
const errs = (ann, f) => ok(ann, f).errors.join('\n');

test('empty annotations pass on clean facts', () => {
    assert.deepEqual(ok({}).errors, []);
});

test('unknown top-level key fails', () => {
    assert.match(errs({ typess: {} }), /unknown top-level key "typess"/);
});

test('every entry needs a why', () => {
    assert.match(errs({ types: { 'struct s': { repr: 'object' } } }), /types\["struct s"\]: missing "why"/);
});

test('stale record, function, pointer and macro names fail', () => {
    const e = errs({
        types: { 'struct gone': { repr: 'object', why: 'x' }, 'struct s': { repr: 'object', why: 'x', tail: { alloc: 'M_ALLOC', space: 'NOPE' } } },
        functions: { gone: { why: 'x' } },
        pointers: { 'member:nope|int (void)': { why: 'x', targets: ['f'] } },
        edges: { cut: [{ from: 'g', to: 'f', why: 'x' }] },
    });
    assert.match(e, /struct gone"\]: stale/);
    assert.match(e, /tail.space: stale, no macro or function "NOPE"/);
    assert.match(e, /functions\["gone"\]: stale/);
    assert.match(e, /pointers\["member:nope\|int \(void\)"\]: stale/);
    assert.match(e, /edges.cut g -> f: stale, no such call/);
});

test('raw-memory evidence needs a decision, except inside a heap group', () => {
    const f = facts({ evidence: { 'struct t': { cast: ['src/a.c:3'] }, 'struct L': { cast: ['lib/lua/x.c:1'] } } });
    const e = errs({}, f);
    assert.match(e, /struct t \(src\/a.h:5\): raw-memory evidence \(cast\) without a decision/);
    const g = { lua: { files: 'lib/lua/', repr: 'heap', why: 'x' } };
    const e2 = errs({ groups: g }, f);
    assert.doesNotMatch(e2, /struct L/);
    assert.match(e2, /struct t/);
    assert.equal(errs({ groups: g, types: { 'struct t': { repr: 'heap', why: 'x' } } }, f), '');
});

test('union evidence and save-io are decided by rules, not annotations', () => {
    const f = facts({ evidence: { 'union u': { union: ['d'] }, 'struct s': { 'save-io': ['x'] } } });
    assert.deepEqual(ok({}, f).errors, []);
});

test('a punning union can only become an object with an approved discriminant', () => {
    const t = (extra) => ({ types: { 'union u': { repr: 'object', why: 'x', ...extra } } });
    assert.match(errs(t({})), /needs "discriminant" and owner "approved": true/);
    assert.match(errs(t({ discriminant: 'kind' })), /needs "discriminant"/);
    assert.equal(errs(t({ discriminant: 'kind', approved: true })), '');
    const proven = facts({ unions: { 'union u': { verdict: 'object', file: 'src/a.h' } } });
    assert.equal(errs(t({}), proven), '');
});

test('unresolved indirect calls need targets', () => {
    const f = facts({ unresolvedIndirect: { 'member:fp|void (void)': 2 } });
    assert.match(errs({}, f), /indirect call member:fp\|void \(void\): unresolved/);
    assert.equal(errs({ pointers: { 'member:fp|void (void)': { why: 'x', targets: ['g'] } } }, f), '');
});

test('hand-written override fails when the C function changes', () => {
    const h = functionHash(SRC['src/a.c']);
    const ann = { functions: { f: { why: 'x', handwritten: 'js/hand/f.js', csha: h } } };
    const r = ok(ann);
    assert.deepEqual(r.errors, []);
    assert.equal(r.summary.handLines, 10);
    const changed = facts({ sourceLines: () => ['int f(void)', '{', '    return 2;', '}'] });
    assert.match(errs(ann, changed), /C source changed/);
    assert.match(errs({ functions: { f: { why: 'x', handwritten: 'js/hand/missing.js', csha: h } } }), /does not exist/);
});

test('extern groups need an existing module and an adapter', () => {
    const e = errs({ groups: { i: { files: 'src/a.c', repr: 'extern', module: 'js/none.js', why: 'x' } } });
    assert.match(e, /extern module "js\/none.js" does not exist/);
    assert.match(e, /needs an "adapter"/);
    const r = ok({ groups: { i: { files: 'src/a.c', repr: 'extern', module: 'js/ext.js', adapter: 'js/crt/g.js', why: 'x' } } });
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join(), /not written yet/);
});

test('jsonc: comments stripped outside strings only', () => {
    const v = parseJsonc('{\n // c\n "a": "x // not a comment", /* b */ "b": "/* nor this */"\n}');
    assert.deepEqual(v, { a: 'x // not a comment', b: '/* nor this */' });
    assert.deepEqual(parseJsonc('{"q": "say \\"hi\\" // x"}'), { q: 'say "hi" // x' });
    assert.throws(() => parseJsonc('{"a": 1, /* open'), /unterminated/);
});
