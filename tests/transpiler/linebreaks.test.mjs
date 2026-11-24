// Readability (c): C line breaks as markers (tu.mjs BRK), expanded by program.mjs withBreaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withBreaks } from '../../transpiler/emit/program.mjs';
import { BRK } from '../../transpiler/emit/tu.mjs';

test('a marker becomes a newline one level deeper than its line, eating the spaces around it', () => {
    assert.equal(withBreaks(`    if (a ${BRK}|| b) {`), '    if (a\n        || b) {');
    assert.equal(withBreaks(`f(x, ${BRK}y, ${BRK}z);`), 'f(x,\n    y,\n    z);');
    assert.equal(withBreaks('no markers\n  here'), 'no markers\n  here');
});
test('the marker character is not used by other placeholders', () => {
    assert.notEqual(BRK, '\u0002');   // macro-argument placeholders (P3)
    assert.notEqual(BRK, '\u0003');   // JSDoc type placeholders
});
