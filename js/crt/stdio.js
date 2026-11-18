// js/crt/stdio.js: <stdio.h> (transpiler-design.md 5). Hand-written runtime.
// Streams are FILE objects; stdout/stderr write their bytes to a sink that the
// host (tests, the game glue) sets. Files on the VFS (js/storage.js) and
// embedded data files are added with the game glue (M3).
import { VaList } from './va.js';
import { cformat } from './printf.js';
import { cstrlen } from './mem.js';

export class FILE {
    constructor(name) { this.name = name; this.sink = null; this.err = 0; this.eof = 0; }
    write(bytes) { if (this.sink) this.sink(bytes); return bytes.length; }
}
export const stdout = new FILE('stdout');
export const stderr = new FILE('stderr');
export const stdin = new FILE('stdin');
export const __stdoutp = stdout, __stderrp = stderr, __stdinp = stdin;   // Darwin's names behind the macros
export const EOF = -1;

/** Route a stream's output: fn(Uint8Array) or null (discard). */
export function setSink(f, fn) { f.sink = fn; }

const bytesOf = (p) => p.buf.subarray(p.off, p.off + cstrlen(p));

export function vfprintf(f, fmt, va) { const b = cformat(fmt, va); f.write(b); return b.length; }
export const fprintf = (f, fmt, ...args) => vfprintf(f, fmt, new VaList(args));
export const printf = (fmt, ...args) => vfprintf(stdout, fmt, new VaList(args));
export const vprintf = (fmt, va) => vfprintf(stdout, fmt, va);
export function fputs(s, f) { f.write(bytesOf(s)); return 0; }
export function puts(s) { stdout.write(bytesOf(s)); stdout.write(Uint8Array.of(10)); return 0; }
export function fputc(c, f) { f.write(Uint8Array.of(c & 0xff)); return c & 0xff; }
export const putc = fputc;
export const putchar = (c) => fputc(c, stdout);
export const fflush = (_f) => 0;
export const ferror = (f) => f.err;
export const feof = (f) => f.eof;
export function clearerr(f) { f.err = 0; f.eof = 0; }
