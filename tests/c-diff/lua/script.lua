print("hello", 1, 2.5, -0.0, 1e100, 2^53, math.maxinteger, math.mininteger, 7 // 2, 7 % -3, -7 // 2, 7.5 // 2)
print(string.format("%5d|%-5s|%05.2f|%x|%g|%q", 42, "ab", 3.14159, 255, 1/3, "a\nb\0c"))
print(10 / 3, 1/0, -1/0, math.huge, 0x7fffffffffffffff + 1, 3 | 5, 3 ~ 5, ~0, 1 << 63, 1 << 64)
local t = {}
for i = 1, 100 do t[i] = i * i end
local s = 0
for i, v in ipairs(t) do s = s + v end
print("sum", s, #t, table.concat({1, 2, "x", 4.5}, ","))
table.sort(t, function(a, b) return a > b end)
print(t[1], t[50], t[100])
local words = {}
for w in string.gmatch("the quick brown fox jumps over the lazy dog", "%a+") do words[#words + 1] = w:upper() end
print(table.concat(words, " "), ("abc"):rep(3, "-"), ("hello world"):gsub("o", "0"))
print(string.find("hello", "l+"), string.match("key = value", "(%w+)%s*=%s*(%w+)"), ("%d"):format(3.0))
print(select("#", 1, nil, 3), select(2, "a", "b", "c"), type(nil), type(print), tostring(nil), tonumber("0x1F"), tonumber("  12  "), tonumber("1e2"), tonumber("z", 36))
-- @@chunk
local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end
print("fib", fib(20))
local co = coroutine.create(function(a, b)
  local c = coroutine.yield(a + b)
  local d, e = coroutine.yield(c * 2)
  return d + e
end)
print(coroutine.resume(co, 1, 2)); print(coroutine.resume(co, 10)); print(coroutine.resume(co, 3, 4)); print(coroutine.resume(co))
print(pcall(error, "boom")); print(select("#", pcall(error, {code = 1}))); print(select(2, pcall(function() local x = nil; return x.y end)))
print(pcall(C.fail, 1, 2, 3))
print(C.add(2, 3), C.concat("ab", "cde"))
local mt = {__add = function(a, b) return a.v + b.v end, __tostring = function(a) return "V(" .. a.v .. ")" end, __index = function(t, k) return k .. "!" end}
local a, b = setmetatable({v = 1}, mt), setmetatable({v = 2}, mt)
print(a + b, tostring(a), a.zzz, rawget(a, "zzz"))
-- @@chunk
local c = C.newcounter()
for i = 1, 10 do c:add(i / 2) end
print(c:add(0))
for i = 1, 200 do C.newcounter() end
collectgarbage(); collectgarbage()
local big = {}
for i = 1, 20000 do big[i] = {i, tostring(i), {}} end
big = nil
collectgarbage()
print("gc ok", collectgarbage("count") > 0)
local parts = {}
for i = 1, 300 do parts[#parts + 1] = string.char(65 + i % 26) end
local str = table.concat(parts)
print(#str, str:sub(1, 30), str:byte(1, 5), utf8.char(72, 228, 8364), utf8.len("häö"))
print(string.pack and #string.pack("i4i8", 1, 2), math.floor(-3.5), math.ceil(-3.5), math.fmod(7, -3), math.abs(math.mininteger), math.tointeger(3.0), math.ult(1, -1))
print(load("return 1 + ")); print(load("syntax error here")); print(load("return ...", "x", "t")(5, 6))
goto skip
print("not printed")
::skip::
print(string.rep("ab", 3), ("x"):len(), #"\u{10FFFF}", string.format("%10.3s|", "abcdef"), string.format("%.14g", 0.1 + 0.2), 0.1 + 0.2, 100 // 1e308)
-- @@chunk
error("final chunk error")
