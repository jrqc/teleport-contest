/* int-vectors.c: native reference for js/crt/int.js (tool 4.5/4.6).
 * Prints "<op> <a> <b> <result>" lines (decimal; doubles as %.17g).
 * Build: clang -O0 -fwrapv int-vectors.c   (-fwrapv: signed overflow wraps, the
 * semantics the JS helpers implement; the recorder's -O0 code wraps the same way).
 * Undefined cases are skipped: division by zero, MIN / -1, shift counts outside
 * [0, width), out-of-range float->int. Usage: int-vectors [cases-per-op] */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <limits.h>

static uint64_t s = 0x9E3779B97F4A7C15ULL;
static uint64_t rnd64(void) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return s; }

/* values biased to edges: small numbers, powers of two +-1, extremes, random */
static uint64_t val(int bits) {
    uint64_t r = rnd64(), mask = bits == 64 ? ~0ULL : ((1ULL << bits) - 1);
    switch (r % 8) {
    case 0: return (uint64_t) ((int64_t) (rnd64() % 21) - 10) & mask;
    case 1: { int k = (int) (rnd64() % (unsigned) bits); return ((1ULL << k) + (rnd64() % 3) - 1) & mask; }
    case 2: { int k = (int) (rnd64() % (unsigned) bits); return (~(1ULL << k) + 1) & mask; }
    case 3: { uint64_t e[] = { 0, 1, mask, mask >> 1, (mask >> 1) + 1, 0x1FFFFFFFFFFFFFULL, 0x20000000000000ULL, 0x20000000000001ULL };
              return e[rnd64() % 8] & mask; }
    case 4: return (rnd64() % 100000) & mask;
    default: return r & mask;
    }
}

int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 3000, i;
    for (i = 0; i < n; i++) {
        int32_t a = (int32_t) val(32), b = (int32_t) val(32);
        uint32_t ua = (uint32_t) val(32), ub = (uint32_t) val(32);
        int64_t A = (int64_t) val(64), B = (int64_t) val(64);
        uint64_t UA = val(64), UB = val(64);
        int sh32 = (int) (rnd64() % 32), sh64 = (int) (rnd64() % 64);

        printf("add32 %d %d %d\n", a, b, a + b);
        printf("sub32 %d %d %d\n", a, b, a - b);
        printf("mul32 %d %d %d\n", a, b, a * b);
        if (b != 0 && !(a == INT_MIN && b == -1)) {
            printf("div32 %d %d %d\n", a, b, a / b);
            printf("rem32 %d %d %d\n", a, b, a % b);
        }
        printf("neg32 %d 0 %d\n", a, -a);
        printf("not32 %d 0 %d\n", a, ~a);
        printf("and32 %d %d %d\n", a, b, a & b);
        printf("or32 %d %d %d\n", a, b, a | b);
        printf("xor32 %d %d %d\n", a, b, a ^ b);
        printf("shl32 %d %d %d\n", a, sh32, (int32_t) ((uint32_t) a << sh32));
        printf("shr32 %d %d %d\n", a, sh32, a >> sh32);

        printf("addu32 %u %u %u\n", ua, ub, ua + ub);
        printf("subu32 %u %u %u\n", ua, ub, ua - ub);
        printf("mulu32 %u %u %u\n", ua, ub, ua * ub);
        if (ub != 0) {
            printf("divu32 %u %u %u\n", ua, ub, ua / ub);
            printf("remu32 %u %u %u\n", ua, ub, ua % ub);
        }
        printf("negu32 %u 0 %u\n", ua, -ua);
        printf("notu32 %u 0 %u\n", ua, ~ua);
        printf("andu32 %u %u %u\n", ua, ub, ua & ub);
        printf("oru32 %u %u %u\n", ua, ub, ua | ub);
        printf("xoru32 %u %u %u\n", ua, ub, ua ^ ub);
        printf("shlu32 %u %d %u\n", ua, sh32, ua << sh32);
        printf("shru32 %u %d %u\n", ua, sh32, ua >> sh32);

        printf("add64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A + B));
        printf("sub64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A - B));
        printf("mul64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A * B));
        if (B != 0 && !(A == LLONG_MIN && B == -1)) {
            printf("div64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A / B));
            printf("rem64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A % B));
        }
        printf("neg64 %lld 0 %lld\n", (long long) A, (long long) -A);
        printf("not64 %lld 0 %lld\n", (long long) A, (long long) ~A);
        printf("and64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A & B));
        printf("or64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A | B));
        printf("xor64 %lld %lld %lld\n", (long long) A, (long long) B, (long long) (A ^ B));
        printf("shl64 %lld %d %lld\n", (long long) A, sh64, (long long) (int64_t) ((uint64_t) A << sh64));
        printf("shr64 %lld %d %lld\n", (long long) A, sh64, (long long) (A >> sh64));

        printf("addu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA + UB));
        printf("subu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA - UB));
        printf("mulu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA * UB));
        if (UB != 0) {
            printf("divu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA / UB));
            printf("remu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA % UB));
        }
        printf("negu64 %llu 0 %llu\n", (unsigned long long) UA, (unsigned long long) -UA);
        printf("notu64 %llu 0 %llu\n", (unsigned long long) UA, (unsigned long long) ~UA);
        printf("andu64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA & UB));
        printf("oru64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA | UB));
        printf("xoru64 %llu %llu %llu\n", (unsigned long long) UA, (unsigned long long) UB, (unsigned long long) (UA ^ UB));
        printf("shlu64 %llu %d %llu\n", (unsigned long long) UA, sh64, (unsigned long long) (UA << sh64));
        printf("shru64 %llu %d %llu\n", (unsigned long long) UA, sh64, (unsigned long long) (UA >> sh64));

        /* conversions from a 64-bit pattern, seen as signed and as unsigned */
        printf("i8 %lld 0 %d\n", (long long) A, (int) (int8_t) A);
        printf("u8 %lld 0 %d\n", (long long) A, (int) (uint8_t) A);
        printf("i16 %lld 0 %d\n", (long long) A, (int) (int16_t) A);
        printf("u16 %lld 0 %d\n", (long long) A, (int) (uint16_t) A);
        printf("i32 %lld 0 %d\n", (long long) A, (int32_t) A);
        printf("u32 %lld 0 %u\n", (long long) A, (uint32_t) A);
        printf("u64 %lld 0 %llu\n", (long long) A, (unsigned long long) (uint64_t) A);
        printf("i64 %llu 0 %lld\n", (unsigned long long) UA, (long long) (int64_t) UA);
        printf("i8 %llu 0 %d\n", (unsigned long long) UA, (int) (int8_t) UA);
        printf("u32 %llu 0 %u\n", (unsigned long long) UA, (uint32_t) UA);
        printf("i32 %d 0 %d\n", (int) (signed char) a, (int) (signed char) a); /* char is signed */

        /* integer <-> double */
        printf("itod %lld 0 %.17g\n", (long long) A, (double) A);
        printf("itod %llu 0 %.17g\n", (unsigned long long) UA, (double) UA);
        {
            double d = (double) (int64_t) val(64) / (double) (1 + rnd64() % 1000);
            if (d > -2147483648.0 && d < 2147483648.0) printf("dtoi32 %.17g 0 %d\n", d, (int) d);
            if (d > -9223372036854775808.0 && d < 9223372036854775808.0) printf("dtoi64 %.17g 0 %lld\n", d, (long long) d);
            if (d > -1.0 && d < 4294967296.0) printf("dtou32 %.17g 0 %u\n", d, (unsigned) d);
        }
    }
    printf("char_is_signed 0 0 %d\n", (char) -1 < 0);
    return 0;
}
