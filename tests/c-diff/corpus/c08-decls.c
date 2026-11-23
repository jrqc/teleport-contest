/* c08: locals declared at their first assignment (readability step "Declarations"):
 * scopes, shadowing, declarators that read earlier ones, switch bodies, loop-carried
 * values and uses after the declaring block, which must stay hoisted */
#include <stdio.h>
static int g(int x) { return x * 3 + 1; }
static int shadow(int n) {
    int r = 0;
    { int t = n + 1; r += t; { int t = r * 2; r += t; } }
    { int t; t = n - 1; r += t; }
    return r;
}
static int chain(int a) {
    int b = a + 1, c = b * 2, d = c - a;
    int e;
    e = d + b;
    return e * 10 + c;
}
static int loops(int n) {
    int i, s = 0, last;
    last = -1;
    for (i = 0; i < n; i++) {
        int k;
        k = g(i);
        if (k % 2) continue;
        s += k;
        last = k;   /* used after the loop: stays hoisted */
    }
    int x;
    do { x = g(s) % 7; s += x; } while (x != 0 && s < 1000);   /* x read by the condition */
    return s * 100 + last + x;
}
static const char *sw(int v) {
    const char *p;
    switch (v) {
    case 0: p = "zero"; break;
    case 1: { const char *q; q = "one"; p = q; break; }
    case 2: p = "two";
        /* FALLTHROUGH */
    default: { int z = v * 2; p = z > 10 ? "big" : "small"; }
    }
    return p;
}
static int reassign(int n) {
    int acc;
    acc = n;
    while (n > 0) { int step = n % 3 + 1; acc += step; n -= step; }
    acc *= 2;
    return acc;
}
int main(void) {
    int i;
    printf("shadow %d %d\n", shadow(3), shadow(-4));
    printf("chain %d %d\n", chain(5), chain(-2));
    printf("loops %d %d\n", loops(10), loops(0));
    for (i = 0; i < 5; i++) printf("%s ", sw(i));
    printf("\nreassign %d %d\n", reassign(17), reassign(0));
    return 0;
}
