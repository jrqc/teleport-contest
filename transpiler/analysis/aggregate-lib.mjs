// aggregate-lib.mjs: helpers shared by the Stage 1 analysis scripts.
export const TREE_PREFIX = 'tools/recorder-env/build/nethack-c/recorder/';
/** Path relative to the recorder tree (src/x.c, include/x.h, lib/lua-5.4.8/src/x.c). */
export const short = (f) => (f && f.startsWith(TREE_PREFIX) ? f.slice(TREE_PREFIX.length) : f);
