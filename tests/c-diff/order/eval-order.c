/* Evaluation order as the recorder's clang resolves it. Expected output: eval-order.expected
 * Build: clang -g -DNOTPARMDECL -DNO_TIMED_DELAY eval-order.c (same result at -O2). */
#include <stdio.h>
static int seq = 0; static char log_[64]; static int n = 0;
static int f(char c, int v) { log_[n++] = c; return v; }
int a[4][4]; int b[4];
static int g(int x, int y) { return x + y; }
int main(void) {
    n = 0; a[f('i',1)][f('j',2)] = f('r',3); log_[n] = 0; printf("assign: %s\n", log_);
    n = 0; a[f('i',1)][f('j',2)] += f('r',3); log_[n] = 0; printf("compound: %s\n", log_);
    n = 0; (void) g(f('x',1), f('y',2)); log_[n] = 0; printf("args: %s\n", log_);
    n = 0; (void) (f('l',1) + f('r',2)); log_[n] = 0; printf("binop: %s\n", log_);
    n = 0; b[f('i',1)]++; log_[n] = 0; printf("postinc: %s\n", log_);
    return 0;
}
