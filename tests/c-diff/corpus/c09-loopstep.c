/* c09: loop steps the emitter writes without wrap-around (readability step d): i++ under
 * i < E and i-- under i > E, near the ends of int, with the bound and the counter in
 * several forms; and steps it must keep wrapping (the counter written in the body, a
 * <= bound that can be INT_MAX, a goto into the body) */
#include <stdio.h>
#include <limits.h>
static int lim(int x) { return x; }
int main(void) {
    int i, n = 0, hi = INT_MAX, lo = INT_MIN;
    long sum = 0;
    for (i = INT_MAX - 3; i < hi; i++) sum += i - (INT_MAX - 3);
    printf("up %d %ld\n", i, sum);
    for (i = INT_MIN + 3; i > lo; i--) n++;
    printf("down %d %d\n", i, n);
    for (i = INT_MAX - 2; lim(INT_MAX) > i && n < 100; ++i) n++;
    printf("rev %d %d\n", i, n);
    for (i = 0; i <= 5; i++) n += i;
    printf("le %d %d\n", i, n);
    for (i = INT_MAX - 2; i < INT_MAX; i++) { if (i == INT_MAX - 1) i = INT_MAX - 1; n++; }
    printf("written %d %d\n", i, n);
    n = 0;
    for (i = INT_MAX - 1; i <= hi && n < 3; i++) n++;     /* i++ at INT_MAX: wraps (kept) */
    printf("le-max %d %d\n", i, n);
    i = INT_MAX;
    goto inside;
    for (i = 0; i < 10; i++) {
inside:
        n++;
        if (n > 5) break;
    }
    printf("goto %d %d\n", i, n);
    return 0;
}
