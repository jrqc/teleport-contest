/* qsort-ref.c: native Darwin libc qsort reference for js/crt/qsort.js.
 * For each case prints
 *   case <n> <mode>            then the initial keys:  k <key> ... (id = position)
 *   c <idA> <idB> <result>     every comparator call, ids of the compared elements
 *   r <id> ...                 final order
 * Modes: random, sorted, reverse, equal, fewdistinct, organpipe, inconsistent
 * (pseudo-random results), always1 (every call returns 1: no swaps in the
 * partition pass, the insertion-sort attempt gives up ("nevermind"), and the
 * depth limit falls back to heapsort), biased (random, mostly positive).  Build: clang -O0 qsort-ref.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct el { int key; int id; };
static int inconsistent;   /* 0 keys, 1 random, 2 always 1, 3 biased */
static unsigned long long rs = 88172645463325252ULL;
static unsigned rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (unsigned) (rs >> 11); }
static unsigned long long cs;
static int cmp(const void *va, const void *vb) {
    const struct el *a = va, *b = vb;
    int r;
    if (inconsistent == 2) r = 1;
    else if (inconsistent) { cs ^= cs << 13; cs ^= cs >> 7; cs ^= cs << 17;
        r = inconsistent == 1 ? (int) (cs % 3) - 1 : ((int) (cs % 5) - 1 > 1 ? 1 : (int) (cs % 5) - 1); }
    else r = (a->key > b->key) - (a->key < b->key);
    printf("c %d %d %d\n", a->id, b->id, r);
    return r;
}

static void run(int n, int mode, size_t es_pad) {
    static const char *names[] = { "random", "sorted", "reverse", "equal", "fewdistinct", "organpipe", "inconsistent", "always1", "biased" };
    struct el *v = malloc((n ? n : 1) * sizeof *v);
    int i;
    for (i = 0; i < n; i++) {
        int k;
        switch (mode) {
        case 0: k = (int) (rnd() % 1000); break;
        case 1: k = i; break;
        case 2: k = n - i; break;
        case 3: k = 5; break;
        case 4: k = (int) (rnd() % 3); break;
        case 5: k = i < n / 2 ? i : n - i; break;
        default: k = (int) (rnd() % 100); break;
        }
        v[i].key = k; v[i].id = i;
    }
    inconsistent = mode == 6 ? 1 : mode == 7 ? 2 : mode == 8 ? 3 : 0;
    cs = 0x2545F4914F6CDD1DULL ^ (unsigned long long) (n * 7 + mode);
    printf("case %d %s\nk", n, names[mode]);
    for (i = 0; i < n; i++) printf(" %d", v[i].key);
    printf("\n");
    (void) es_pad;
    qsort(v, (size_t) n, sizeof *v, cmp);
    printf("r");
    for (i = 0; i < n; i++) printf(" %d", v[i].id);
    printf("\n");
    free(v);
}

int main(void) {
    int n, mode, rep;
    for (n = 0; n <= 120; n++) for (mode = 0; mode < 9; mode++) run(n, mode, 0);
    for (rep = 0; rep < 40; rep++) for (mode = 0; mode < 9; mode++) run(121 + (int) (rnd() % 300), mode, 0);
    for (mode = 0; mode < 9; mode++) run(5000, mode, 0);
    return 0;
}
