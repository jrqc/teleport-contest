// bridge.mjs: the generated boundary between object-world NetHack and the
// heap-world Lua interpreter (transpiler-design.md 7.3). Stub; filled below.
export function bridgeModule(prog) {
    const out = ['// luabridge.js: object-world entry points of heap-world functions (generated). Do not edit.'];
    for (const name of [...prog.bridgeFns.keys()].sort()) out.push(`export function ${name}() { throw new Error('bridge not built: ${name}'); }`);
    return out.join('\n') + '\n';
}
