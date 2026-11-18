// js/crt/index.js: the C runtime as one namespace ($c in generated code).
export * from './int.js';
export * from './mem.js';
export * from './va.js';
export * from './printf.js';
export * from './stdio.js';
export * from './string.js';
export * from './ctype.js';
export * from './time.js';
export * from './qsort.js';
export * from './alloc.js';
export * from './proc.js';
export * from './fs.js';
export * from './scanf.js';
export * from './termcap.js';
import * as fsModule from './fs.js';
import { setFs } from './stdio.js';
setFs(fsModule);
export * from './isaac64-glue.js';
