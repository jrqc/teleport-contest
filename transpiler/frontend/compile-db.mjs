#!/usr/bin/env node
// compile-db.mjs: write transpiler/out/compile_commands.json for every C file
// linked into the reference recorder (tools/recorder-env/build-reference.sh).
// Source of truth: the recorder's `make -n` link line (nethack objects) and
// Lua's Makefile (CORE_O + LIB_O, i.e. `make a`). Flags are the recorder's.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const TREE = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder');
const SRC = path.join(TREE, 'src');
const LUA = path.join(TREE, 'lib/lua-5.4.8/src');

export const NH_FLAGS = ['-g', '-I../include', '-DNOTPARMDECL', '-DNO_TIMED_DELAY'];
export const LUA_FLAGS = ['-O2', '-Wall', '-Wextra', '-DLUA_COMPAT_5_3', '-DLUA_USE_MACOSX'];

function nethackObjects() {
    const out = execFileSync('make', ['-n', '-B', 'nethack', 'SYSCFLAGS=-DLUA_USE_MACOSX'],
        { cwd: SRC, encoding: 'utf8', maxBuffer: 64 << 20 });
    const lines = out.split('\n');
    const i = lines.findIndex((l) => /^\S+\s+-o nethack\b/.test(l));
    if (i < 0) throw new Error('nethack link line not found');
    let link = '';
    for (let j = i; j < lines.length; j++) {
        link += lines[j].replace(/\\$/, ' ');
        if (!lines[j].endsWith('\\')) break;
    }
    const objs = link.split(/\s+/).filter((t) => t.endsWith('.o') || t === 'hacklib.a');
    // map object -> source from the `-c` compile lines
    const srcOf = new Map();
    for (const l of lines) {
        const m = l.match(/\s-c\s/) && l.match(/(\S+\.c)\b/);
        const o = l.match(/-o\s+(\S+\.o)/);
        if (m && o) srcOf.set(path.basename(o[1]), m[1]);
    }
    srcOf.set('hacklib.a', 'hacklib.c');
    return objs.map((o) => {
        const s = srcOf.get(path.basename(o));
        if (!s) throw new Error(`no source for ${o}`);
        return path.resolve(SRC, s);
    });
}

function luaObjects() {
    const mk = readFileSync(path.join(LUA, 'Makefile'), 'utf8');
    const get = (v) => (mk.match(new RegExp(`^${v}=\\s*(.*)$`, 'm')) || [])[1].trim().split(/\s+/);
    return [...get('CORE_O'), ...get('LIB_O')].map((o) => path.join(LUA, o.replace(/\.o$/, '.c')));
}

export function compileDb() {
    const db = [];
    for (const file of nethackObjects()) {
        db.push({ directory: SRC, file, arguments: ['clang', ...NH_FLAGS, '-c', file], group: 'nethack' });
    }
    for (const file of luaObjects()) {
        db.push({ directory: LUA, file, arguments: ['clang', ...LUA_FLAGS, '-c', file], group: 'lua' });
    }
    for (const e of db) if (!existsSync(e.file)) throw new Error(`missing ${e.file}`);
    return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const db = compileDb();
    const outPath = path.join(ROOT, 'transpiler/out/compile_commands.json');
    // paths relative to repo root keep the file machine-independent
    const rel = db.map((e) => ({ ...e,
        directory: path.relative(ROOT, e.directory), file: path.relative(ROOT, e.file) }));
    writeFileSync(outPath, JSON.stringify(rel, null, 1) + '\n');
    const n = (g) => db.filter((e) => e.group === g).length;
    console.log(`[ok] ${db.length} translation units (nethack ${n('nethack')}, lua ${n('lua')}) -> ${path.relative(ROOT, outPath)}`);
}
