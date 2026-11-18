import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseType, show, Scope, INTS } from '../../transpiler/ir/ctypes.mjs';

test('declarator syntax', () => {
    const cases = {
        'int': 'int',
        'const char *const *': 'char**',
        'unsigned long long': 'unsigned long long',
        'long unsigned int': 'unsigned long',
        'struct rm (*)[21]': 'struct rm[21]*',
        'struct rm[80][21]': 'struct rm[21][80]'.replace('[21][80]', '[21][80]'),
        'int (*)(const char *, const char *, int)': 'int(char*,char*,int)*',
        'char *(*)(char *, const char *, unsigned long)': 'char*(char*,char*,unsigned long)*',
        'void (*)(const char *, ...) __attribute__((noreturn))': 'void(char*,...)*',
        'void (void)': 'void()',
        'void (*(*)(int))(void)': 'void()*(int)*',
        'const struct (unnamed struct at sp_lev.c:4320:14)[25]': 'struct @sp_lev.c:4320:14[25]',
        'struct lev_region::(unnamed at ../include/hack.h:880:5)': 'struct @../include/hack.h:880:5',
        'char[]': 'char[]',
        'int (^)(const void *, const void *)': 'int(void*,void*)*',
        'long double': 'long double',
        'signed char': 'signed char',
    };
    for (const [s, want] of Object.entries(cases)) assert.equal(show(parseType(s)), want, s);
    // arrays of arrays nest outermost-first: struct rm[80][21] is an array of 80 arrays of 21
    const t = parseType('struct rm[80][21]');
    assert.equal(t.n, 80);
    assert.equal(t.of.n, 21);
});

test('typedefs, enums and layout', () => {
    const s = new Scope();
    s.typedefs.set('coordxy', 'short');
    s.typedefs.set('xchar', 'coordxy');
    s.enums.set('e1', { key: 'e1', values: [['A', 0n], ['B', 5n]], fixed: null });
    s.enums.set('e2', { key: 'e2', values: [['C', -1n]], fixed: null });
    s.records.set('p', { key: 'p', union: false, fields: [
        { name: 'c', typeStr: 'char', bits: null }, { name: 'x', typeStr: 'xchar *', bits: null },
        { name: 'b1', typeStr: 'unsigned int', bits: 3 }, { name: 'b2', typeStr: 'unsigned int', bits: 30 },
        { name: 'e', typeStr: 'enum e2', bits: null }] });
    assert.equal(show(s.type('xchar *')), 'short*');
    assert.equal(s.type('enum e1'), INTS['unsigned int']);
    assert.equal(s.type('enum e2'), INTS.int);
    const L = s.recordLayout('p');
    assert.deepEqual(L.fields.map((f) => [f.name, f.offset, f.bitOffset]), [['c', 0, 0], ['x', 8, 0], ['b1', 16, 0], ['b2', 20, 0], ['e', 24, 0]]);
    assert.equal(L.size, 32);
    assert.equal(L.align, 8);
});
