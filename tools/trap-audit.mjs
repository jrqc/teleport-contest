#!/usr/bin/env node
// tools/trap-audit.mjs: every CTrap the hand-written runtime (js/crt/) can throw, with its
// class. A trap ends the segment (the C program would go on), so each one must be either
// behavior C does not define or a port invariant, never legal C the runtime does not
// support (those were fixed: method/trap-audit.md). Exit 1 on a trap that matches
// no rule, so a new trap needs a decision.
// Classes:
//   UB        undefined behavior in C, or the C program aborts the same way (Darwin's
//             fortify checks, abort, assert): kept
//   INPUT     invalid input data (terminfo strings), or a C failure path NetHack never takes
//   INTERNAL  a port invariant (the emitter, the bridge, the serializer kinds): reachable
//             only through a transpiler gap; the generated code is checked statically
//   REPR      legal C that the object model represents by design only in the heap world
//             (one block used as two types: the one-copy rule); the remedy is an
//             annotation (repr: heap) for that type, not runtime code
//   LIMIT     a resource limit of the heap world
// Usage: node tools/trap-audit.mjs [--md]
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = [
    [/out of bounds|outside its array|past the end|beyond one past|^index .* from field|strlen: no NUL|%s: string not NUL|format string not NUL|va_arg past/, 'UB', 'access outside an object (C11 6.5.6p8)'],
    [/detected buffer overflow|__memcpy_chk|__strcpy_chk/, 'UB', 'Darwin _FORTIFY_SOURCE aborts the process'],
    [/^abort\(\)|^assertion failed/, 'UB', 'the C program aborts'],
    [/__builtin_unreachable/, 'UB', 'reaching unreachable code'],
    [/stale pointer read from a save file/, 'UB', 'dereferencing an address of an earlier process (or freed memory)'],
    [/arithmetic on a pointer to a record that is not an array element/, 'UB', 'p + n beyond one past a lone object (p + 1 is supported)'],
    [/difference of pointers to different (arrays|buffers)/, 'UB', 'p - q of pointers into different objects (6.5.6p9)'],
    [/ordering of a pointer made from an integer/, 'UB', 'relational comparison of pointers into different objects (6.5.8p5)'],
    [/^index .* out of range/, 'UB', 'an index beyond 2^53: outside any object'],
    [/call through an invalid function pointer/, 'UB', 'calling through a pointer that is not a function'],
    [/used as a record of/, 'UB', 'a record in a block smaller than it'],
    [/realloc of a block that is not a plain buffer/, 'UB', 'realloc of a pointer that malloc did not return'],
    [/incomplete conversion at end of format|unsupported (length modifier|conversion)|%s argument is not a byte pointer/, 'UB', 'an invalid conversion specification or argument type (7.21.6.1p9)'],
    [/EILSEQ in the C locale/, 'INPUT', 'printf fails with EILSEQ in C; NetHack never prints wide strings'],
    [/^tparm:/, 'INPUT', 'an invalid terminfo string (TERM is fixed: xterm-256color)'],
    [/^bridge:/, 'INTERNAL', 'the bridge descriptors are generated for every object/heap call (emit/bridge.mjs)'],
    [/^serialize: |^deserialize: |^sizeof of an unknown value|not an aggregate/, 'INTERNAL', 'serializer kinds come from the generated $fields tables'],
    [/^string initializer for a non-char array/, 'INTERNAL', 'the emitter writes a string into $c.init only for a char-array field (tu.mjs litValue); tools/tablecheck.mjs compares every table with the per-element build'],
    [/^union cell:/, 'INTERNAL', 'cell member kinds: tests/crt/legal-c.test.mjs checks every generated union cell'],
    [/^not a handle|runtime returned a pointer outside the heap|struct return too large/, 'INTERNAL', 'heap-world calling convention'],
    [/getchar\(\) outside the async set|read\(\) from a standard stream|^read from /, 'INTERNAL', 'input arrives only through the async getchar (design 6)'],
    [/^call of .*not defined in the transpiled program/, 'INTERNAL', 'a link error: emit-report.md lists undefined functions'],
    [/^qsort of a base that is neither/, 'INTERNAL', 'qsort bases are arrays the emitter produced'],
    [/^dstRange\(/, 'INTERNAL', 'the 1955 rules are only asked about 1955 on'],
    [/block used as (bytes, then as a record|a record, then as an array|pointers and as other data)/, 'REPR', 'one malloc block used as two types'],
    [/static data region full|heap stack overflow|heap exhausted/, 'LIMIT', 'heap world: 16 MiB static data, 4 MiB stack, 1 GiB heap'],
];
const sites = [];
const dir = path.join(ROOT, 'js/crt');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        const m = line.match(/new CTrap\((['`])(.*?)\1/);
        if (!m) return;
        const msg = m[2].replace(/\$\{[^}]*\}/g, '…');
        const rule = RULES.find(([re]) => re.test(msg));
        sites.push({ at: `js/crt/${f}:${i + 1}`, msg, cls: rule ? rule[1] : null, why: rule ? rule[2] : '' });
    });
}
const bad = sites.filter((s) => !s.cls);
if (process.argv.includes('--md')) {
    console.log('| Site | Trap | Class | Why |\n|---|---|---|---|');
    for (const s of sites) console.log(`| \`${s.at}\` | ${s.msg.replace(/\|/g, '/')} | ${s.cls ?? '**none**'} | ${s.why} |`);
} else {
    const by = {};
    for (const s of sites) by[s.cls ?? 'UNCLASSIFIED'] = (by[s.cls ?? 'UNCLASSIFIED'] || 0) + 1;
    console.log(`${sites.length} trap sites: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    for (const s of bad) console.log(`UNCLASSIFIED ${s.at} ${s.msg}`);
}
process.exit(bad.length ? 1 : 0);
