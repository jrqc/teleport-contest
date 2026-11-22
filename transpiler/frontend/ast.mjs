// ast.mjs: load one translation unit's clang AST (JSON) into memory.
//
// Runs `clang -fsyntax-only -Xclang -ast-dump=json` with the recorder's exact
// flags (from compile_commands.json) and parses the result. Nothing is written
// to disk: a full dump of the tree is ~10 GB.
//
// Clang's JSON source locations are delta-encoded: "file" and "line" are only
// printed when they differ from the previously printed location (one shared
// state for loc, range.begin/end, spellingLoc and expansionLoc, in output
// order). resolveLocations() walks the tree in that order and stores the
// effective values on every bare location as `_f` (file) and `_l` (line).
// `_f` is normalized: repo-relative for project files, absolute for system
// headers.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/** clang arguments for one compile_commands.json entry, without the compiler, "-c", the source and "-o x". */
function baseArgs(entry) {
    const dir = path.resolve(ROOT, entry.directory);
    const file = path.relative(dir, path.resolve(ROOT, entry.file));
    const args = [];
    const a = entry.arguments.slice(1);
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '-c') continue;
        if (a[i] === '-o') { i++; continue; }
        if (path.resolve(dir, a[i]) === path.resolve(ROOT, entry.file)) continue;
        args.push(a[i]);
    }
    // annotation-driven defines (annotations.jsonc "defines"), e.g. the Lua VM's dispatch
    args.push(...(entry.extraArgs || []));
    // extra clang arguments for experiments, never for the build: the churn benchmark
    // (tools/churn/bench.mjs) passes a VFS overlay that substitutes edited C files
    if (process.env.NH_CLANG_EXTRA_ARGS) args.push(...JSON.parse(process.env.NH_CLANG_EXTRA_ARGS));
    return { dir, file, args };
}
// __DATE__/__TIME__ must not depend on when we transpile (output determinism, design 2.6):
// pin them to the recorder's fixed "now" (2026-05-02 12:00 UTC)
const clangEnv = () => ({ ...process.env, SOURCE_DATE_EPOCH: '1777723200' });

/** The TU's preprocessed text (clang -E -P), for facts the JSON AST omits (offsetof members). */
export function preprocess(entry) {
    const { dir, file, args } = baseArgs(entry);
    return execFileSync('clang', [...args, '-E', '-P', file], { cwd: dir, env: clangEnv(), maxBuffer: 1 << 28 }).toString('latin1');
}

/** Run clang for one compile_commands.json entry; resolve to the AST root. */
export function loadAst(entry) {
    const { dir, file, args } = baseArgs(entry);
    args.push('-fsyntax-only', '-Xclang', '-ast-dump=json', file);
    return new Promise((resolve, reject) => {
        const env = clangEnv();
        const child = spawn('clang', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let stderr = '';
        child.stdout.on('data', (c) => chunks.push(c));
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`clang failed (${code}) for ${entry.file}:\n${stderr.slice(0, 4000)}`));
                return;
            }
            try {
                const root = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                chunks.length = 0;
                resolveLocations(root, dir);
                resolve({ root, dir, stderr });
            } catch (e) { reject(e); }
        });
    });
}

/** Fill in delta-encoded file/line on every bare location, in output order. */
export function resolveLocations(root, dir) {
    let file = null;
    let line = null;
    const norm = new Map();
    const normalize = (f) => {
        if (f == null) return null;
        let n = norm.get(f);
        if (n === undefined) {
            n = path.isAbsolute(f) && !path.resolve(f).startsWith(ROOT + path.sep)
                ? f : path.relative(ROOT, path.resolve(dir, f));
            norm.set(f, n);
        }
        return n;
    };
    // iterative pre-order walk in key order (JSON.parse preserves it)
    const stack = [root];
    while (stack.length) {
        const o = stack.pop();
        if (typeof o.offset === 'number') {          // a bare source location
            if (o.file !== undefined) file = o.file;
            if (o.line !== undefined) line = o.line;
            o._f = normalize(file);
            o._l = line;
            continue;
        }
        const kids = [];
        for (const k in o) {
            const v = o[k];
            if (v && typeof v === 'object') {
                if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') kids.push(x); }
                else kids.push(v);
            }
        }
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
}

/** Effective position of a location object: the expansion site for macros. */
export function posOf(loc) {
    if (!loc) return null;
    const l = loc.expansionLoc || loc;
    return l._f == null ? null : { file: l._f, line: l._l };
}

/** Position of a node: its loc, else the start of its range. */
export function nodePos(n) {
    return posOf(n.loc) || posOf(n.range && n.range.begin);
}

/** True when the location was produced by a macro expansion. */
export function inMacro(n) {
    const b = (n.loc && n.loc.spellingLoc) || (n.range && n.range.begin && n.range.begin.spellingLoc);
    return !!b;
}

export const isSystemFile = (f) => !!f && path.isAbsolute(f);
