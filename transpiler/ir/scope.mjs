// scope.mjs: build a ctypes Scope for one TU, with path normalization for
// anonymous record keys (clang spells them relative to the TU directory in
// type strings; declarations carry repo-relative paths after resolveLocations).
import path from 'node:path';
import { ROOT } from '../frontend/ast.mjs';
import { Scope } from './ctypes.mjs';

export function tuScope(root, tuDir) {
    const dir = path.resolve(ROOT, tuDir);
    const rel = new Map();
    const normAnon = (loc, fromDecl) => {
        if (fromDecl) return loc;   // already repo-relative (or absolute for system headers)
        let r = rel.get(loc);
        if (r === undefined) {
            const m = /^(.*):(\d+):(\d+)$/.exec(loc);
            if (!m) return loc;
            const f = path.isAbsolute(m[1]) && !path.resolve(m[1]).startsWith(ROOT + path.sep)
                ? m[1] : path.relative(ROOT, path.resolve(dir, m[1]));
            r = `${f}:${m[2]}:${m[3]}`;
            rel.set(loc, r);
        }
        return r;
    };
    const s = Scope.fromTU(root, normAnon);
    // where each named record is defined (for filtering in tests and reports)
    s.recordPos = new Map();
    const walk = (n) => {
        if (n.kind === 'RecordDecl' && n.name && n.completeDefinition && !s.recordPos.has(n.name)) {
            const l = n.loc && (n.loc.spellingLoc || n.loc);
            s.recordPos.set(n.name, l && l._f);
        }
        for (const c of n.inner || []) if (c.kind === 'RecordDecl' || c.kind === 'TypedefDecl' || c.kind === 'TranslationUnitDecl') walk(c);
    };
    walk(root);
    return s;
}
