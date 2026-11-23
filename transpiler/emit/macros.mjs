// macros.mjs: source-text facts about C macros, for readability plan P3
// (method/readability-plan.md): which macro an expression node is the whole
// expansion of, and where its arguments are.
//
// clang's JSON AST keeps macro information only in source locations: every token
// of an expansion has an expansionLoc at the invocation (the macro name), and its
// spellingLoc is where the token is written: in the #define body, or for a token of
// an argument (isMacroArgExpansion) in the invocation's argument text. This module
// reads the source files to turn those offsets into macro definitions and
// argument spans.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';

const texts = new Map();
// A clang VFS overlay given through NH_CLANG_EXTRA_ARGS (tools/churn/bench.mjs) replaces
// files for clang; the source text must be read the same way, or offsets would not match.
let overlay = null;
function overlaid(abs) {
    if (overlay === null) {
        overlay = new Map();
        const args = process.env.NH_CLANG_EXTRA_ARGS ? JSON.parse(process.env.NH_CLANG_EXTRA_ARGS) : [];
        for (let i = 0; i < args.length - 1; i++) {
            if (args[i] !== '-ivfsoverlay') continue;
            const o = JSON.parse(readFileSync(args[i + 1], 'utf8'));
            for (const r of o.roots || []) if (r.type === 'file') overlay.set(path.resolve(r.name), r['external-contents']);
        }
    }
    return overlay.get(path.resolve(abs)) || abs;
}
/** Source text (latin1) of repo-relative or absolute `file`. */
export function sourceText(file) {
    let t = texts.get(file);
    if (t === undefined) {
        try { t = readFileSync(overlaid(path.isAbsolute(file) ? file : path.join(ROOT, file)), 'latin1'); } catch { t = null; }
        texts.set(file, t);
    }
    return t;
}

const isId = (c) => /[A-Za-z0-9_$]/.test(c || '');
/** The identifier that starts at `off` in `text`, or null. */
export function identAt(text, off) {
    if (!text || !/[A-Za-z_]/.test(text[off] || '') || isId(text[off - 1])) return null;
    let e = off;
    while (isId(text[e])) e++;
    return text.slice(off, e);
}

/**
 * Every #define of `file`: { name, fnlike, params, bodyStart, lastTok, body }, where
 * bodyStart is the offset of the body's first token and lastTok the offset of its last
 * token's first character (clang's range end), or -1 for an empty body.
 */
const defsCache = new Map();
export function defines(file) {
    let d = defsCache.get(file);
    if (d) return d;
    d = [];
    const t = sourceText(file);
    if (t) {
        const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
        let m;
        while ((m = re.exec(t))) {
            const name = m[1];
            let i = m.index + m[0].length;
            // the logical line (backslash continuations)
            let end = i;
            for (;;) {
                const nl = t.indexOf('\n', end);
                const e = nl < 0 ? t.length : nl;
                if (t[e - 1] === '\\' || (t[e - 1] === '\r' && t[e - 2] === '\\')) { end = e + 1; continue; }
                end = e;
                break;
            }
            let fnlike = false, params = [];
            if (t[i] === '(') {
                fnlike = true;
                const close = t.indexOf(')', i);
                params = t.slice(i + 1, close).split(',').map((s) => s.replace(/\\\n/g, '').trim()).filter((s) => s !== '');
                i = close + 1;
            }
            // body tokens: skip blanks, continuations and comments; strings and chars are tokens
            const toks = [];
            let j = i;
            while (j < end) {
                const c = t[j];
                if (c === '\\' && (t[j + 1] === '\n' || t[j + 1] === '\r')) { j += 2; continue; }
                if (/\s/.test(c)) { j++; continue; }
                if (c === '/' && t[j + 1] === '*') { const k = t.indexOf('*/', j + 2); j = k < 0 ? end : k + 2; continue; }
                if (c === '/' && t[j + 1] === '/') break;
                if (c === '"' || c === "'") {
                    let k = j + 1;
                    while (k < end && t[k] !== c) { if (t[k] === '\\') k++; k++; }
                    toks.push(j); j = k + 1; continue;
                }
                if (isId(c)) { toks.push(j); while (j < end && isId(t[j])) j++; continue; }
                // punctuators: multi-char operators start at their first character either way
                const two = t.slice(j, j + 2), three = t.slice(j, j + 3);
                toks.push(j);
                j += ['<<=', '>>=', '...'].includes(three) ? 3 : ['->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##'].includes(two) ? 2 : 1;
            }
            d.push({ name, fnlike, params, bodyStart: toks.length ? toks[0] : -1, lastTok: toks.length ? toks[toks.length - 1] : -1, toks, body: t.slice(i, end).replace(/\\\r?\n/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/, '').trim() });
        }
    }
    defsCache.set(file, d);
    return d;
}

/**
 * The #define of `name` in `file` whose body is exactly the tokens from `begin` to `last`,
 * or, when the body is one parenthesized expression, the tokens inside those parentheses
 * (callers that skip parentheses reach that node); with its `file`. Otherwise null.
 */
export function macroCovering(file, name, begin, last) {
    const t = sourceText(file);
    for (const d of defines(file)) {
        if (d.name !== name || !d.toks.length) continue;
        if (d.bodyStart === begin && d.lastTok === last) return { ...d, file };
        const k = d.toks;
        if (k.length >= 3 && t[k[0]] === '(' && t[k[k.length - 1]] === ')' && k[1] === begin && k[k.length - 2] === last && outerPair(t, k)) return { ...d, file };
    }
    return null;
}
/** Whether the body's first '(' closes at its last token. */
function outerPair(t, toks) {
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
        const c = t[toks[i]];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0 && i !== toks.length - 1) return false; }
    }
    return depth === 0;
}

/**
 * The argument spans of a function-like invocation at `off` (the macro name) in
 * `text`: [[start, end), ...] (end exclusive), or null if there is no argument list.
 */
export function argSpans(text, off) {
    let i = off;
    while (isId(text[i])) i++;
    while (/\s/.test(text[i] || '')) i++;
    if (text[i] !== '(') return null;
    const spans = [];
    let depth = 0, start = i + 1;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (c === '"' || c === "'") { j++; while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; j++; } continue; }
        if (c === '/' && text[j + 1] === '*') { j = text.indexOf('*/', j + 2) + 1; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { spans.push([start, j]); return spans; }
        } else if (c === ',' && depth === 1) { spans.push([start, j]); start = j + 1; }
    }
    return null;
}
