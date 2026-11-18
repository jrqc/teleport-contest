/* c01: integer arithmetic, conversions, control flow */
#include <stdio.h>
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
unsigned int hash(const char *s) { unsigned int h = 5381; while (*s) h = h * 33 + (unsigned char) *s++; return h; }
int counter = 7;
long big = 1L << 40;
int main(void) {
    int i, s = 0;
    unsigned u = 1;
    long l = -5;
    unsigned long ul = 0;
    signed char c = 100;
    short sh = 30000;
    for (i = 0; i < 20; i++) { s += i * i; u *= 3; }
    printf("s=%d u=%u fib=%d\n", s, u, fib(15));
    printf("hash=%u\n", hash("Elbereth"));
    c += 100; sh += sh; l *= 1000000007L; ul -= 1;
    printf("c=%d sh=%d l=%ld ul=%lu\n", c, sh, l, ul);
    printf("div %d %d %d %d\n", -7 / 2, -7 % 2, 7 / -2, 7 % -2);
    printf("shift %d %u %ld\n", -16 >> 2, 0x80000000u >> 31, big >> 3);
    i = 0;
    do { i += 3; if (i == 9) continue; if (i > 20) break; } while (1);
    printf("i=%d counter=%d\n", i, counter++ + ++counter);
    switch (i % 4) { case 0: printf("zero\n"); case 1: printf("one\n"); break; default: printf("other\n"); }
    printf("cmp %d %d %d\n", 3 < 4, -1 < 0u, (unsigned char) 200 > (signed char) -1);
    printf("cond %s\n", i ? "yes" : "no");
    return s & 0xff;
}
