// compile-commands.mjs: write compile_commands.json for the vendored Darwin regex
// (README.md here), in the format of transpiler/out/compile_commands.json, group
// "darwin-regex". The flags are build-native.sh's, without its x_* renames.
import { writeFileSync } from 'node:fs';
const FILES = [
    'darwin-libc/regex/TRE/lib/regcomp.c', 'darwin-libc/regex/TRE/lib/regexec.c', 'darwin-libc/regex/TRE/lib/tre-ast.c',
    'darwin-libc/regex/TRE/lib/tre-compile.c', 'darwin-libc/regex/TRE/lib/tre-match-backtrack.c',
    'darwin-libc/regex/TRE/lib/tre-match-parallel.c', 'darwin-libc/regex/TRE/lib/tre-mem.c', 'darwin-libc/regex/TRE/lib/tre-parse.c',
    'darwin-libc/regex/TRE/lib/tre-stack.c', 'darwin-libc/regex/FreeBSD/regerror.c', 'darwin-libc/locale/FreeBSD/runetype.c',
    'darwin-libc/locale/FreeBSD/tolower.c', 'darwin-libc/locale/FreeBSD/toupper.c', 'darwin-libc/locale/FreeBSD/table.c',
    'darwin-libc/locale/FreeBSD/none.c', 'darwin-libc/locale/FreeBSD/mbrtowc.c', 'darwin-libc/locale/FreeBSD/wctype.c',
    'darwin-libc/locale/FreeBSD/wcsrtombs.c', 'darwin-libc/string/FreeBSD/wcslen.c',
    'darwin-libc/string/FreeBSD/wcsncmp.c', 'darwin-libc/string/FreeBSD/wcsncpy.c', 'darwin-libc/string/FreeBSD/wmemcmp.c', 'darwin-c-locale/c_locale.c',
];
const FLAGS = ['-arch', 'arm64', '-O0', '-D__LIBC__', '-D_DONT_USE_CTYPE_INLINE_', '-DREG_BADMAX=18', '-DHAVE_CONFIG_H',
    '-Idarwin-c-locale', '-Idarwin-libc/regex/TRE', '-Idarwin-libc/regex/TRE/lib',
    '-Idarwin-libc/regex/FreeBSD', '-Idarwin-libc/locale/FreeBSD'];
const db = FILES.map((f) => ({ directory: 'transpiler/third_party', file: `transpiler/third_party/${f}`,
    arguments: ['clang', ...FLAGS, '-c', f], group: 'darwin-regex' }));
writeFileSync(new URL('./compile_commands.json', import.meta.url), JSON.stringify(db, null, 1) + '\n');
console.log(`${db.length} entries`);
