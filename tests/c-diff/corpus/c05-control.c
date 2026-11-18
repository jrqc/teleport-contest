/* c05: function pointers, varargs, static locals, goto, evaluation order */
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
static int seed = 1;
static int rn2(int n) { seed = seed * 1103515245 + 12345; return (int) ((unsigned) seed >> 16) % n; }
static int twice(int x) { return 2 * x; }
static int square(int x) { return x * x; }
struct op { const char *name; int (*fn)(int); };
static struct op ops[] = { { "twice", twice }, { "square", square }, { 0, 0 } };
static char msgbuf[80];
static void pline(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msgbuf, sizeof msgbuf, fmt, ap);
    va_end(ap);
    printf("pline: %s\n", msgbuf);
}
static int sumargs(int n, ...) { va_list ap; int s = 0; va_start(ap, n); while (n-- > 0) s += va_arg(ap, int); va_end(ap); return s; }
static int next_id(void) { static int id = 100; return id++; }
static int *counter_addr(void) { static int c; c++; return &c; }
static int find(int *a, int n, int want) {
    int i;
    for (i = 0; i < n; i++) {
        if (a[i] == want) goto found;
        if (a[i] < 0) goto bad;
    }
    return -1;
found:
    return i;
bad:
    return -2;
}
static int retry(void) {
    int tries = 0;
again:
    tries++;
    if (rn2(10) != 7 && tries < 50) goto again;
    return tries;
}
static int nested(int n) {
    int i, j, hits = 0;
    for (i = 0; i < n; i++) {
        for (j = 0; j < n; j++) {
            if (j == 3) continue;
            if (i * j > 20) goto out;
            if (j > i) break;
            hits++;
        }
    }
out:
    return hits * 100 + i;
}
int arr2[10][10];
int main(void) {
    struct op *o;
    int (*f)(int) = square;
    int a[5] = { 3, 9, -1, 4, 7 };
    int i, x, *cp;
    for (o = ops; o->name; o++) printf("%s(7)=%d ", o->name, o->fn(7));
    printf("%d %d\n", f(5), (*f)(6));
    pline("%s has %d hit points (%5.1f%%)", "the newt", 3, 42.25);
    printf("sum %d ids %d %d %d\n", sumargs(4, 1, 2, 3, 4), next_id(), next_id(), next_id());
    cp = counter_addr(); counter_addr(); printf("counter %d\n", *cp);
    printf("find %d %d %d\n", find(a, 5, 9), find(a, 5, 4), find(a, 2, 42));
    printf("retry %d nested %d\n", retry(), nested(8));
    /* assignment evaluates the right side first: the RNG order matters */
    for (i = 0; i < 4; i++) arr2[rn2(10)][rn2(10)] = rn2(100);
    x = 0;
    for (i = 0; i < 10; i++) { int j; for (j = 0; j < 10; j++) x = x * 31 + arr2[i][j]; }
    printf("arr2 hash %d seed %d\n", x, seed);
    x = (rn2(3), rn2(5));
    printf("comma %d %s\n", x, rn2(2) ? "heads" : "tails");
    switch (rn2(4)) { case 0: { int k = 5; printf("k%d\n", k); } case 1: printf("one\n"); break; case 2: case 3: printf("two/three\n"); }
    return 0;
}
