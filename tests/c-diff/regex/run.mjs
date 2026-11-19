#!/usr/bin/env node
// run.mjs: the full regex differential (postmortem F2): the system's regcomp/regexec/
// regerror vs the vendored TRE built natively vs the transpiled JS (js/nh, heap world).
// Needs clang (macOS). Usage:
//   node tests/c-diff/regex/run.mjs [count=20000] [seed=7] [datafile-dir]   full run
//   node tests/c-diff/regex/run.mjs --golden                                 rewrite golden.*
// datafile-dir: Apple Libc's tests/regex/datafiles (Libc-1752.120.2), not vendored.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCases } from './regex-js.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const golden = process.argv[2] === '--golden';
const [n = golden ? 4000 : 20000, seed = 7, dataDir] = golden ? [] : process.argv.slice(2);
const T = mkdtempSync(path.join(tmpdir(), 'regex-diff-'));
const sh = (cmd, args, input) => execFileSync(cmd, args, { cwd: ROOT, input, maxBuffer: 1 << 30 });
sh('bash', ['transpiler/third_party/build-native.sh', T]);
sh('clang', ['-arch', 'arm64', '-O0', '-g', '-DOURS', 'tests/c-diff/regex/regex-native.c', path.join(T, 'libtre-native.a'), '-o', path.join(T, 'regex-native')]);
const cases = sh('node', ['tests/c-diff/regex/gen-cases.mjs', String(n), String(seed), ...(dataDir ? [dataDir] : [])]);
const nat = sh(path.join(T, 'regex-native'), [], cases).toString('latin1').trim().split('\n');
const sys = nat.filter((l) => l.startsWith('sys:')), ours = nat.filter((l) => l.startsWith('our:'));
const js = runCases(cases.toString('latin1'));
const body = (l) => l.slice(4);
let dNative = 0, dJs = 0;
for (let i = 0; i < sys.length; i++) {
    if (body(sys[i]) !== body(ours[i] || '')) { if (dNative++ < 5) console.log(`native #${i}\n  sys ${sys[i]}\n  our ${ours[i]}`); }
    if (body(sys[i]) !== body(js[i] || '')) { if (dJs++ < 5) console.log(`js #${i}\n  sys ${sys[i]}\n  js  ${js[i]}`); }
}
console.log(`${sys.length} cases: vendored native differs on ${dNative}, transpiled JS differs on ${dJs}`);
if (golden && dNative === 0 && dJs === 0) {
    writeFileSync(path.join(HERE, 'golden.tsv'), cases);
    writeFileSync(path.join(HERE, 'golden.out'), Buffer.from(sys.join('\n') + '\n', 'latin1'));
    console.log('wrote golden.tsv, golden.out (the system regex\'s results)');
}
process.exit(dNative || dJs || sys.length !== js.length ? 1 : 0);
