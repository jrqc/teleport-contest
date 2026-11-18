/* string-ref.c: native Darwin libc reference for js/crt/string.js and ctype.js.
 * Prints the ctype table for -1..255, then for each stdin line
 *   "<op> <hexA> <hexB> <n>"
 * the result of the operation (pointer results as offsets, -1 for NULL;
 * buffer-writing operations as the hex of the whole destination buffer).
 * Build: clang -arch arm64 -O0 -w string-ref.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static char A[4096], B[4096], line[16384];
static void unhex(const char *h, char *d) { while (h[0] && h[1] && h[0] != ' ') { unsigned v; sscanf(h, "%2x", &v); *d++ = (char) v; h += 2; } *d = 0; }
static void hexbuf(const char *b, int n) { int i; for (i = 0; i < n; i++) printf("%02x", (unsigned char) b[i]); }
static int sgn(int x) { return (x > 0) - (x < 0); }

int main(void) {
    int c;
    for (c = -1; c < 256; c++)
        printf("ctype %d %d%d%d%d%d%d%d%d%d%d%d %d %d\n", c, !!isupper(c), !!islower(c), !!isalpha(c), !!isdigit(c),
               !!isxdigit(c), !!isalnum(c), !!isspace(c), !!ispunct(c), !!iscntrl(c), !!isprint(c), !!isgraph(c),
               toupper(c), tolower(c));
    while (fgets(line, sizeof line, stdin)) {
        char op[32], ha[8192] = "", hb[8192] = "";
        int n = 0;
        char *end;
        if (sscanf(line, "%31s %8191s %8191s %d", op, ha, hb, &n) < 1) continue;
        if (!strcmp(ha, "-")) ha[0] = 0;
        if (!strcmp(hb, "-")) hb[0] = 0;
        unhex(ha, A); unhex(hb, B);
        printf("%s ", op);
        if (!strcmp(op, "strtol")) { long v = strtol(A, &end, n); printf("%ld %ld\n", v, (long) (end - A)); }
        else if (!strcmp(op, "strtoul")) { unsigned long v = strtoul(A, &end, n); printf("%lu %ld\n", v, (long) (end - A)); }
        else if (!strcmp(op, "strtod")) { double v = strtod(A, &end); printf("%a %ld\n", v, (long) (end - A)); }
        else if (!strcmp(op, "atoi")) printf("%d\n", atoi(A));
        else if (!strcmp(op, "atol")) printf("%ld\n", atol(A));
        else if (!strcmp(op, "strcmp")) printf("%d\n", sgn(strcmp(A, B)));
        else if (!strcmp(op, "strncmp")) printf("%d\n", sgn(strncmp(A, B, (size_t) n)));
        else if (!strcmp(op, "memcmp")) printf("%d\n", sgn(memcmp(A, B, (size_t) n)));
        else if (!strcmp(op, "strchr")) { char *p = strchr(A, n); printf("%ld\n", p ? (long) (p - A) : -1L); }
        else if (!strcmp(op, "strrchr")) { char *p = strrchr(A, n); printf("%ld\n", p ? (long) (p - A) : -1L); }
        else if (!strcmp(op, "memchr")) { char *p = memchr(A, n & 0xff, strlen(A) + 1); printf("%ld\n", p ? (long) (p - A) : -1L); }
        else if (!strcmp(op, "strstr")) { char *p = strstr(A, B); printf("%ld\n", p ? (long) (p - A) : -1L); }
        else if (!strcmp(op, "strpbrk")) { char *p = strpbrk(A, B); printf("%ld\n", p ? (long) (p - A) : -1L); }
        else if (!strcmp(op, "strspn")) printf("%zu\n", strspn(A, B));
        else if (!strcmp(op, "strcspn")) printf("%zu\n", strcspn(A, B));
        else if (!strcmp(op, "strlen")) printf("%zu\n", strlen(A));
        else if (!strcmp(op, "strncpy") || !strcmp(op, "strncat") || !strcmp(op, "strcat") || !strcmp(op, "strcpy")) {
            char d[96];
            memset(d, 0x55, sizeof d);
            memcpy(d, A, strlen(A) + 1);       /* destination starts with A */
            if (!strcmp(op, "strncpy")) strncpy(d, B, (size_t) n);
            else if (!strcmp(op, "strncat")) strncat(d, B, (size_t) n);
            else if (!strcmp(op, "strcat")) strcat(d, B);
            else strcpy(d, B);
            hexbuf(d, sizeof d); printf("\n");
        }
        else printf("?\n");
    }
    return 0;
}
