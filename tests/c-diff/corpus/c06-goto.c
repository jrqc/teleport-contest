/* c06: unstructured gotos: into branches, crossing regions, mixed directions, into loops and switch arms */
#include <stdio.h>
static int st = 0;
static int rn(int n) { st = st * 1103515245 + 12345; return ((unsigned) st >> 16) % n; }
static int into_else(int a, int b) {
    int r = 0;
    if (a > 5) {
        r = 1;
        if (b) goto attack;
        r = 2;
    } else if (b > 3) {
 attack:
        r += 10;
    } else
        r = 3;
    return r;
}
static int crossing(int x) {
    int r = 0;
    if (x == 1) goto a;
    if (x == 2) goto b;
    r += 1;
 a:
    r += 2;
    if (x == 3) goto c;
 b:
    r += 4;
 c:
    r += 8;
    return r;
}
static int mixed(int n) {
    int r = 0;
 top:
    r++;
    if (r < n) goto top;
    if (r == 3) goto done;
    r *= 10;
 done:
    if (r < 100 && n == 3) { n = 0; goto top; }
    return r;
}
static int into_loop(int start) {
    int i = 0, s = 0;
    if (start) goto mid;
    for (i = 0; i < 5; i++) {
        s += 100;
 mid:
        s += i;
    }
    return s;
}
static int into_case(int k, int j) {
    int s = 0;
    if (j) goto two;
    switch (k) {
    case 1: s = 1; break;
    case 2:
 two:
        s += 2;
    case 3: s += 3; break;
    default: s = -1;
    }
    return s;
}
static int nested_break(int n) {
    int i, j, s = 0;
    for (i = 0; i < n; i++) {
        if (i == 2) goto skip;
        for (j = 0; j < n; j++) { if (j == i) break; s += j; }
        if (i == 4) continue;
        s += 1000;
 skip:
        s += 7;
        if (s > 5000) break;
    }
    return s * 10 + i;
}
/* within one switch: from one arm to a label after the first statement of another arm */
static int in_switch(int k, int force) {
    int s = 0, i;
    for (i = 0; i < 3; i++) {
        switch (k + i) {
        case 1:
            s += 1;
            if (force) goto wriggle;
            break;
        case 2:
            s += 20;
            if (i == 2) continue;
 wriggle:
            s += 300;
            break;
        default:
            s += 4000;
        }
        s *= 2;
    }
    return s;
}
int main2(void) { printf("%d %d %d %d\n", in_switch(1, 0), in_switch(1, 1), in_switch(0, 1), in_switch(2, 0)); return 0; }
int main(void) {
    int a, b;
    for (a = 3; a < 8; a += 2) for (b = 0; b < 6; b += 2) printf("%d ", into_else(a, b));
    printf("\n%d %d %d %d\n", crossing(0), crossing(1), crossing(2), crossing(3));
    printf("%d %d %d\n", mixed(1), mixed(3), mixed(5));
    printf("%d %d\n", into_loop(0), into_loop(1));
    printf("%d %d %d %d %d\n", into_case(1, 0), into_case(2, 0), into_case(3, 0), into_case(9, 0), into_case(1, 1));
    printf("%d %d\n", nested_break(6), nested_break(9));
    printf("%d\n", rn(100));
    main2();
    return 0;
}
