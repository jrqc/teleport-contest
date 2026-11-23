import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ROOT } from '../frontend/ast.mjs';

// comments.mjs: C comments carried into the generated JS (readability plan P4).
//
// clang's AST has no comments, so they come from the source text: a small C lexer finds
// every comment outside string and character literals. The emitter places each one by
// source offset (tu.mjs stmt, stmtList, run):
//   - the leading comments of a file (before its first token) are its notice, at the top
//     of the generated module (Lua files add the copyright notice of lua.h they refer to);
//   - a comment in the gap before a function or global goes before it;
//   - in a function, a comment goes before the first statement that starts after it;
//     comments inside a statement without sub-statements go before that statement;
//   - a one-line comment after a statement, on the line where the statement ends, stays at
//     the end of that statement's last JS line;
//   - comments left at the end of a block go before its closing brace.
// Comments inside other constructs (initializers of globals, parameter lists of prototypes,
// declarations that emit nothing at module level) are not carried. Comments cost nothing in
// the Phase 2 diff (comment-only changes are normalized out).

/** All comments of C source `s`: { start, end, line, endLine, col, text } in source order. */
export function lexComments(s) {
    const out = [];
    const n = s.length;
    let i = 0, line = 1, ls = 0;   // ls: offset of the current line's start
    const nl = (j) => { for (let k = i; k < j; k++) if (s.charCodeAt(k) === 10) { line++; ls = k + 1; } };
    while (i < n) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '*') {
            const j = s.indexOf('*/', i + 2);
            const e = j < 0 ? n : j + 2;
            const start = i, l0 = line, col = i - ls;
            nl(e); i = e;
            out.push({ start, end: e, line: l0, endLine: line, col, text: s.slice(start, e) });
            continue;
        }
        if (c === '/' && d === '/') {
            let j = i + 2;
            // a backslash-newline continues a // comment (C translation phase 2)
            while (j < n && s[j] !== '\n') { if (s[j] === '\\' && s[j + 1] === '\n') j++; j++; }
            const start = i, l0 = line, col = i - ls;
            nl(j); i = j;
            out.push({ start, end: j, line: l0, endLine: line, col, text: s.slice(start, j) });
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; }
            nl(j + 1); i = j + 1;
            continue;
        }
        if (c === '#' && /^#\s*include\s*</.test(s.slice(i, i + 40))) {   // <sys/*.h> is no comment
            const j = s.indexOf('>', i);
            const e = j < 0 ? n : j + 1;
            nl(e); i = e;
            continue;
        }
        if (c === '\n') { line++; ls = i + 1; }
        i++;
    }
    return out;
}

const expandTabs = (ws) => { let o = 0; for (const ch of ws) o = ch === '\t' ? (o + 8) - (o % 8) : o + 1; return o; };

/** The JS lines of comment `c` at indentation `ind`: its text, continuation lines re-indented. */
export function commentLines(c, ind) {
    let text = c.text;
    if (text.startsWith('//')) {
        // a continued // comment: every physical line becomes its own // line
        return text.split('\n').map((l, k) => `${ind}${k ? '// ' : ''}${(k ? l.trim() : l).replace(/\\$/, '').trimEnd()}`);
    }
    const ls = text.split('\n');
    return ls.map((l, k) => {
        if (k === 0) return `${ind}${l.trimEnd()}`;
        const m = /^[ \t]*/.exec(l)[0];
        const w = expandTabs(m);
        const keep = Math.max(0, w - c.col);   // indentation relative to the comment's column
        const rest = l.slice(m.length).trimEnd();
        return rest ? `${ind}${' '.repeat(keep)}${rest}` : '';
    }).map((l, k, a) => (l === '' && k < a.length - 1 ? ind.trimEnd() : l));
}

/** The comments of one source file, each emitted at most once. */
export class CommentIndex {
    constructor(text) {
        this.text = text;
        this.list = lexComments(text);
        this.used = new Uint8Array(this.list.length);
        // the file's notice: the comments before its first token
        this.head = [];
        let p = 0;
        for (let k = 0; k < this.list.length; k++) {
            const c = this.list[k];
            if (/\S/.test(text.slice(p, c.start))) break;
            this.head.push(c);
            this.used[k] = 1;
            p = c.end;
        }
        this.headEnd = p;
    }
    /** The 1-based line of offset `off`. */
    lineOf(off) {
        if (!this.lineStarts) { this.lineStarts = [0]; for (let k = 0; k < this.text.length; k++) if (this.text.charCodeAt(k) === 10) this.lineStarts.push(k + 1); }
        let a = 0, b = this.lineStarts.length - 1;
        while (a < b) { const m = (a + b + 1) >> 1; if (this.lineStarts[m] <= off) a = m; else b = m - 1; }
        return a + 1;
    }
    first(lo) {
        let a = 0, b = this.list.length;
        while (a < b) { const m = (a + b) >> 1; if (this.list[m].start < lo) a = m + 1; else b = m; }
        return a;
    }
    /** The unused comments that start in [lo, hi), marked used. */
    take(lo, hi) {
        const out = [];
        for (let k = this.first(lo); k < this.list.length && this.list[k].start < hi; k++) {
            if (this.used[k]) continue;
            this.used[k] = 1;
            out.push(this.list[k]);
        }
        return out;
    }
    /** An unused one-line comment that starts at or after `from` on line `line` (nothing else but blanks before it), marked used. */
    trailing(from, line) {
        const k = this.first(from);
        const c = this.list[k];
        if (!c || this.used[k] || c.line !== line || c.endLine !== line || c.text.includes('\n')) return null;
        // between the statement's last token (at `from`) and the comment: that token, then at
        // most a ';' (a later statement on the same line keeps the comment for itself)
        const between = this.text.slice(from, c.start);
        const semi = between.indexOf(';');
        if (semi >= 0 ? /\S/.test(between.slice(semi + 1)) : !/^\S+\s*$/.test(between)) return null;
        this.used[k] = 1;
        return c;
    }
    /** Counts for the report: comments carried, and all comments. */
    stats() { let u = 0; for (const x of this.used) u += x; return { carried: u, total: this.list.length }; }
}

/**
 * The notice lines at the top of a module generated from C file `file` (repo-relative):
 * the file's leading comments, plus the text they refer to: the copyright notice of lua.h
 * ("See Copyright Notice in lua.h", or "... at the end of this file" in lua.h itself), a
 * LICENSE file of the source tree ("See the file LICENSE": TRE).
 */
export function noticeLines(cm, file, readText) {
    const read = readText || ((f) => readFileSync(path.resolve(ROOT, f), 'latin1'));
    const out = cm.head.flatMap((c) => commentLines(c, ''));
    const said = cm.head.map((c) => c.text).join('\n');
    if (/See Copyright Notice (in lua\.h|at the end of this file)/.test(said)) {
        const lua = path.join(path.dirname(file), 'lua.h');
        const c = lexComments(read(lua)).find((x) => /Copyright \(C\)/.test(x.text) && /Permission is hereby granted/.test(x.text));
        if (c) out.push(...commentLines({ ...c, col: 0 }, ''));
    }
    if (/See the file LICENSE/.test(said)) {
        for (let d = path.dirname(file), k = 0; k < 4; d = path.dirname(d), k++) {
            const f = path.join(d, 'LICENSE');
            if (!existsSync(path.resolve(ROOT, f))) continue;
            out.push(`// ${f.replace(/^transpiler\/third_party\//, '')}:`, ...read(f).replace(/\s+$/, '').split('\n').map((l) => `// ${l}`.trimEnd()));
            break;
        }
    }
    return out;
}

/** The notice of a header module (`<header>.h.js`, `<header>.macros.js`): the header's notice. */
export function headerNotice(file, readText) {
    return noticeLines(new CommentIndex(readText(file)), file, readText);
}

/** The notice of a module generated from many sources (types.js, globals.js, index.js, luabridge.js, data/). */
export const AGGREGATE_NOTICE = [
    '/* Generated from the NetHack 5.0 sources (NetHack General Public License: "NetHack may be',
    ' * freely redistributed.  See license for details.") and the Lua 5.4.8, TRE and Darwin Libc',
    ' * sources NetHack is built with (MIT, BSD and Apple Public Source licenses: see the notices',
    ' * at the top of the modules generated from them). */',
];
