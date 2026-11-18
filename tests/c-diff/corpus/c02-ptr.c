/* c02: pointers, arrays, strings, buffers */
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#define BUFSZ 64
static char gbuf[BUFSZ];
static const char *names[] = { "newt", "jackal", "grid bug", 0 };
int grid[4][5];
static char *upstart(char *s) { if (s) *s = (char) toupper((unsigned char) *s); return s; }
static int count(const char *s, char c) { int n = 0; for (; *s; s++) if (*s == c) n++; return n; }
static void rev(char *s) { char *e = s + strlen(s) - 1; while (s < e) { char t = *s; *s++ = *e; *e-- = t; } }
static int sum(const int *a, int n) { const int *p, *end = a + n; int s = 0; for (p = a; p < end; p++) s += *p; return s; }
static void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
int main(void) {
    char buf[BUFSZ], *p;
    const char **np;
    int i, j, x = 3, y = 4, arr[6] = { 5, 1, 4 };
    unsigned char ub[4] = { 200, 100, 0, 0 };
    for (np = names; *np; np++) printf("%s %d|", *np, (int) strlen(*np));
    printf("\n");
    strcpy(buf, "hello");
    strcat(buf, ", world");
    printf("%s %d %d\n", upstart(buf), count(buf, 'l'), (int) (strchr(buf, 'w') - buf));
    rev(buf);
    printf("rev: %s\n", buf);
    sprintf(gbuf, "%-8s|%5.2f|%03d|%c", "ab", 3.14159, 7, 'z');
    printf("[%s] len %d\n", gbuf, (int) strlen(gbuf));
    snprintf(buf, 8, "%s", "truncated string");
    printf("[%s]\n", buf);
    for (i = 0; i < 4; i++) for (j = 0; j < 5; j++) grid[i][j] = i * 10 + j;
    printf("grid %d %d sum %d\n", grid[2][3], grid[3][4], sum(grid[1], 5));
    swap(&x, &y);
    printf("swap %d %d sum %d\n", x, y, sum(arr, 6));
    p = buf;
    *p++ = 'A'; *p++ = 'B'; *p = 0;
    printf("%s %d\n", buf, (int) (p - buf));
    buf[0] = (char) 0xe9;
    printf("signed %d unsigned %d %d\n", buf[0], (unsigned char) buf[0], ub[0] + ub[1]);
    printf("cmp %d %d\n", strcmp("abc", "abd") < 0, strncmp("abcdef", "abcxyz", 3));
    {
        char *q = strstr(gbuf, "3.14");
        printf("found at %d: %s\n", (int) (q - gbuf), q);
    }
    for (i = 0; i < 3; i++) { int *ip = &arr[i]; *ip += 10; }
    printf("%d %d %d\n", arr[0], arr[1], arr[2]);
    return 0;
}
