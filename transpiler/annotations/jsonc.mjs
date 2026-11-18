// jsonc.mjs: JSON with // and /* */ comments (transpiler/annotations.jsonc, design 9.1).
// Comments outside strings are replaced by spaces (keeping line numbers for
// JSON.parse errors); everything else is strict JSON (no trailing commas).
export function stripComments(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
            out += text.slice(start, i + 1);
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) throw new SyntaxError('unterminated /* comment');
            out += text.slice(i, end + 2).replace(/[^\n]/g, ' ');
            i = end + 1;
        } else out += c;
    }
    return out;
}
export const parseJsonc = (text) => JSON.parse(stripComments(text));
