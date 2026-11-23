/* c07: value-range cases the emitter simplifies (readability plan P5): conversions it
 * drops where the value already fits, sums and products of narrow types without
 * wrap-around, constant bit-field stores, and products that must not become -0 */
#include <stdio.h>
struct bits { unsigned a : 1; unsigned b : 3; signed s : 3; int whole; };
static signed char sc(int x) { return x > 3 ? 1 : 0; }           /* bool-ish into signed char */
static short widen(signed char c, unsigned char u) { return c + u; }
int main(void) {
    signed char c1 = 127, c2 = -128;
    unsigned char u1 = 255, u2 = 200;
    short s1 = 32767, s2 = -32768;
    unsigned short us = 65535;
    int i, neg = -3, zero = 0;
    signed char zc = 0;
    struct bits b;
    b.a = 1; b.b = 7; b.s = -4; b.whole = 0;
    printf("narrow %d %d %d %d\n", c1 + c2, u1 + u2, u1 * u2, c2 * c2);
    printf("short %d %d %d %d\n", s1 + s1, s2 - s1, s1 * s1, us * us);   /* fits int; us*us wraps */
    printf("mixed %d %d\n", widen(c2, u1), widen(c1, u1));
    c1 = (signed char) (u1 + 1);                                         /* conversion kept */
    u2 = (unsigned char) (c2 & 0x7f);                                    /* fits: dropped */
    printf("conv %d %d %d %d\n", c1, u2, (signed char) (c2 + c1), (unsigned char) (u1 + u1));
    printf("bits %u %u %d %u\n", b.a, b.b, b.s, b.a + b.b);
    b.b = 9; b.s = 5; b.a = 2;                                           /* constants that do not fit */
    printf("bits2 %u %u %d\n", b.b, b.s < 0, b.a);
    for (i = 0; i < 6; i++) printf("%d", sc(i));
    printf("\n");
    printf("negzero %f %f %f\n", (double) (neg * zero), (double) (zero * neg), (double) (c2 * zero));
    printf("negzero8 %f %f %f\n", (double) (c2 * zc), (double) (zc * c2), 1.0 / (double) (c2 * zc));
    printf("inv %f\n", 1.0 / (double) (neg * zero));
    printf("ops %d %d %d\n", (u1 | u2) + 1, (u1 ^ 0x0f) - 300, (c2 & u1) * 2);
    return 0;
}
