// Unit test: js/crt/ucell.js union cells (method/design.md 3.4.2) and the
// pointer handles behind them (js/crt/mem.js ptrToInt). Layouts mirror the
// generated classes of union customization_content and union any (arm64).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellInit, cellCopy } from '../../js/crt/ucell.js';
import { Ptr, ptrToInt, ptrConst } from '../../js/crt/mem.js';
import { serialize, deserialize } from '../../js/crt/serial.js';

class custom_nhcolor {
    static $size = 8;
    static $fields() { return [['glyphidx', 0, 'i32'], ['nhcolor', 4, 'u32']]; }
    constructor() { this.glyphidx = 0; this.nhcolor = 0; }
    $copyFrom(s) { this.glyphidx = s.glyphidx; this.nhcolor = s.nhcolor; return this; }
    $clone() { return new custom_nhcolor().$copyFrom(this); }
}
class custom_urep {
    static $size = 16;
    static $fields() { return [['glyphidx', 0, 'i32'], ['utf8str', 8, 'ptr']]; }
    constructor() { this.glyphidx = 0; this.utf8str = null; }
    $copyFrom(s) { this.glyphidx = s.glyphidx; this.utf8str = s.utf8str; return this; }
    $clone() { return new custom_urep().$copyFrom(this); }
}
class content {
    static $size = 16;
    static $union = true;
    static $cell = true;
    static $fields() { return [['urep', 0, { rec: custom_urep }], ['ccolor', 0, { rec: custom_nhcolor }]]; }
    constructor() { cellInit(this); }
    $copyFrom(s) { return cellCopy(this, s); }
    $clone() { return new content().$copyFrom(this); }
}
class any {
    static $size = 8;
    static $union = true;
    static $cell = true;
    static $fields() { return [['a_void', 0, 'ptr'], ['a_obj', 0, 'ptr'], ['a_int', 0, 'i32'], ['a_uint', 0, 'u32'], ['a_char', 0, 'i8'], ['a_long', 0, 'i64'], ['a_ulong', 0, 'u64']]; }
    constructor() { cellInit(this); }
    $copyFrom(s) { return cellCopy(this, s); }
    $clone() { return new any().$copyFrom(this); }
}

test('a field written through one record member reads back through another (glyphs.c:508)', () => {
    const c = new content();
    c.urep.glyphidx = 3976;
    c.ccolor.nhcolor = 0x1000004;
    assert.equal(c.ccolor.glyphidx, 3976);
    assert.equal(c.ccolor.nhcolor, 0x1000004);
    assert.ok(c.ccolor instanceof custom_nhcolor);
    const copy = c.ccolor.$clone();
    assert.deepEqual([copy.glyphidx, copy.nhcolor], [3976, 0x1000004]);
});

test('scalar puns behave as little-endian bytes', () => {
    const a = new any();
    a.a_int = -1;
    assert.equal(a.a_uint, 0xffffffff);
    assert.equal(a.a_char, -1);
    assert.equal(a.a_long, 0xffffffff);   // upper bytes were zero
    a.a_long = 0x123456789;
    assert.equal(a.a_int, 0x23456789);
});

test('pointers: identity through another pointer member, NULL, ints read as pointers (light.c:104)', () => {
    const obj = { o_id: 7 };
    const a = new any();
    a.a_obj = obj;
    assert.equal(a.a_void, obj);
    assert.equal(a.a_ulong, ptrToInt(obj));
    a.a_void = null;
    assert.equal(a.a_obj, null);
    a.a_uint = 42;
    assert.equal(a.a_obj, ptrConst(42));
    const b = new any();
    b.a_uint = 42;
    assert.equal(a.a_obj, b.a_obj);   // interned: equal ids compare equal
});

test('equal Ptrs get one handle; copies keep the bytes and the objects', () => {
    const buf = new Int8Array(4);
    assert.equal(ptrToInt(new Ptr(buf, 1)), ptrToInt(new Ptr(buf, 1)));
    assert.notEqual(ptrToInt(new Ptr(buf, 1)), ptrToInt(new Ptr(buf, 2)));
    const obj = {};
    const a = new any();
    a.a_obj = obj;
    const b = new any().$copyFrom(a);
    assert.equal(b.a_obj, obj);
    a.a_int = 5;
    assert.equal(b.a_obj, obj);       // a copy, not an alias
});

test('save files carry the cell bytes; restored pointers are not dereferenceable', () => {
    const a = new any();
    a.a_int = 1234;
    const r = new any();
    deserialize(r, serialize(a, 8));
    assert.equal(r.a_int, 1234);
    const p = new any();
    p.a_obj = { x: 1 };
    const q = new any();
    deserialize(q, serialize(p, 8));
    assert.ok(q.a_obj && q.a_obj.$const !== undefined);
});
