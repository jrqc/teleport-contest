/* printf-ref.c: native Darwin libc reference for js/crt/printf.js.
 * Reads lines "TYPE \t FORMAT \t NSTAR \t STAR1 \t STAR2 \t VALUE" from stdin,
 * formats with snprintf, prints "<return value> <hex of output bytes>".
 * TYPE: i int, u unsigned, l long, U unsigned long, d double, c char (int),
 *       s string (VALUE = hex bytes or NULL), p pointer (VALUE = unsigned long).
 * Build: clang -O0 -w printf-ref.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char line[8192], out[4096], sbuf[2048];

static void unhex(const char *h, char *dst) {
    while (h[0] && h[1]) { unsigned v; sscanf(h, "%2x", &v); *dst++ = (char) v; h += 2; }
    *dst = 0;
}

#define CALL(V) do { \
    if (ns == 0) r = snprintf(out, sizeof out, fmt, V); \
    else if (ns == 1) r = snprintf(out, sizeof out, fmt, s1, V); \
    else r = snprintf(out, sizeof out, fmt, s1, s2, V); } while (0)

int main(void) {
    while (fgets(line, sizeof line, stdin)) {
        char *f[6]; int k = 0, r = 0, i;
        char *p = line;
        line[strcspn(line, "\n")] = 0;
        for (k = 0; k < 6; k++) { f[k] = p; p = strchr(p, '\t'); if (!p) { k++; break; } *p++ = 0; }
        char type = f[0][0]; const char *fmt = f[1];
        int ns = atoi(f[2]), s1 = atoi(f[3]), s2 = atoi(f[4]);
        const char *v = f[5];
        switch (type) {
        case 'i': case 'c': { int x = (int) strtol(v, 0, 10); CALL(x); break; }
        case 'u': { unsigned x = (unsigned) strtoul(v, 0, 10); CALL(x); break; }
        case 'l': { long x = strtol(v, 0, 10); CALL(x); break; }
        case 'U': { unsigned long x = strtoul(v, 0, 10); CALL(x); break; }
        case 'd': { double x = strtod(v, 0); CALL(x); break; }
        case 'p': { void *x = (void *) strtoul(v, 0, 10); CALL(x); break; }
        case 's': { const char *x = 0; if (strcmp(v, "NULL")) { unhex(v, sbuf); x = sbuf; } CALL(x); break; }
        }
        printf("%d ", r);
        for (i = 0; i < r && i < (int) sizeof out - 1; i++) printf("%02x", (unsigned char) out[i]);
        printf("\n");
    }
    return 0;
}
