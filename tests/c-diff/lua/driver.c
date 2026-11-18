/* driver.c: differential test of the heap-world Lua interpreter (tool 4.5).
 * Runs script.lua's chunks (embedded below by the harness as SCRIPT) in a
 * fresh state and prints results and errors; compared byte for byte with the
 * same program built natively against the recorder's Lua sources. */
#include <stdio.h>
#include <string.h>
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

static int c_add(lua_State *L) {
    lua_Integer a = luaL_checkinteger(L, 1), b = luaL_checkinteger(L, 2);
    lua_pushinteger(L, a + b);
    return 1;
}
static int c_concat(lua_State *L) {
    size_t la, lb;
    const char *a = luaL_checklstring(L, 1, &la), *b = luaL_checklstring(L, 2, &lb);
    char buf[256];
    snprintf(buf, sizeof buf, "%s|%s|%zu", a, b, la + lb);
    lua_pushstring(L, buf);
    return 1;
}
static int c_fail(lua_State *L) { return luaL_error(L, "c_fail called with %d args", lua_gettop(L)); }
struct counter { int n; double sum; };
static int c_newcounter(lua_State *L) {
    struct counter *c = lua_newuserdatauv(L, sizeof *c, 0);
    c->n = 0; c->sum = 0;
    luaL_setmetatable(L, "counter");
    return 1;
}
static int c_counter_add(lua_State *L) {
    struct counter *c = luaL_checkudata(L, 1, "counter");
    c->n++; c->sum += luaL_checknumber(L, 2);
    lua_pushinteger(L, c->n);
    lua_pushnumber(L, c->sum);
    return 2;
}
static int gcs = 0;
static int c_counter_gc(lua_State *L) { (void) L; gcs++; return 0; }
static const luaL_Reg funcs[] = { { "add", c_add }, { "concat", c_concat }, { "fail", c_fail }, { "newcounter", c_newcounter }, { NULL, NULL } };

static const char *const chunks[] = {
#include "script.inc"
    NULL
};

int main(void) {
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    luaL_newmetatable(L, "counter");
    lua_pushcfunction(L, c_counter_add); lua_setfield(L, -2, "add");
    lua_pushcfunction(L, c_counter_gc); lua_setfield(L, -2, "__gc");
    lua_pushvalue(L, -1); lua_setfield(L, -2, "__index");
    lua_pop(L, 1);
    luaL_newlib(L, funcs);
    lua_setglobal(L, "C");
    for (int i = 0; chunks[i]; i++) {
        int st = luaL_loadbuffer(L, chunks[i], strlen(chunks[i]), "=chunk");
        if (st == LUA_OK) st = lua_pcall(L, 0, LUA_MULTRET, 0);
        if (st != LUA_OK) { printf("chunk %d: error %d: %s\n", i, st, lua_tostring(L, -1)); lua_pop(L, 1); }
        else { int n = lua_gettop(L); printf("chunk %d: ok, %d results\n", i, n); lua_settop(L, 0); }
    }
    printf("mem %d KB before close\n", lua_gc(L, LUA_GCCOUNT, 0) > 0);
    lua_close(L);
    printf("gcs %d\n", gcs);
    return 0;
}
