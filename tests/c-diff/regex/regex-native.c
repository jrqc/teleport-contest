/* regex-native.c: run regex cases through the system's regcomp/regexec and, when
 * built with -DOURS, through the vendored TRE (x_* entry points) too; one output
 * line per case. Input lines: <cflags>\t<eflags>\t<pattern>\t<subject>, with \xNN
 * escapes. Output: <side>:<compile rc>:<regerror text>:<exec rc>:<so,eo ...> */
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef OURS
int x_regcomp(regex_t *, const char *, int);
int x_regexec(const regex_t *, const char *, size_t, regmatch_t *, int);
void x_regfree(regex_t *);
size_t x_regerror(int, const regex_t *, char *, size_t);
#endif
static void unesc(char *s) {
    char *d = s;
    while (*s) {
        if (s[0] == '\\' && s[1] == 'x' && s[2] && s[3]) { char h[3] = { s[2], s[3], 0 }; *d++ = (char)strtol(h, 0, 16); s += 4; }
        else *d++ = *s++;
    }
    *d = 0;
}
typedef int (*comp_f)(regex_t *, const char *, int);
typedef int (*exec_f)(const regex_t *, const char *, size_t, regmatch_t *, int);
typedef void (*free_f)(regex_t *);
typedef size_t (*err_f)(int, const regex_t *, char *, size_t);
static void run(const char *side, comp_f c, exec_f e, free_f f, err_f er, int cf, int ef, const char *pat, const char *sub) {
    regex_t re; char eb[128]; regmatch_t m[10];
    int rc = c(&re, pat, cf);
    er(rc, &re, eb, sizeof eb);
    printf("%s:%d:%s:", side, rc, eb);
    if (rc == 0) {
        int x = e(&re, sub, (cf & REG_NOSUB) ? 0 : 10, (cf & REG_NOSUB) ? NULL : m, ef);
        printf("%d:", x);
        if (x == 0 && !(cf & REG_NOSUB)) for (int i = 0; i < 10 && i <= (int)re.re_nsub; i++) printf("%lld,%lld ", (long long)m[i].rm_so, (long long)m[i].rm_eo);
        f(&re);
    }
    printf("\n");
}
int main(void) {
    static char line[1 << 16];
    setvbuf(stdout, NULL, _IOLBF, 0);
    while (fgets(line, sizeof line, stdin)) {
        line[strcspn(line, "\n")] = 0;
        char *a = strtok(line, "\t"), *b = strtok(NULL, "\t"), *p = strtok(NULL, "\t"), *s = strtok(NULL, "\t");
        if (!a || !b || !p) continue;
        static char empty[1];
        if (!s) { empty[0] = 0; s = empty; }
        unesc(p); unesc(s);
        run("sys", regcomp, regexec, regfree, regerror, atoi(a), atoi(b), p, s);
#ifdef OURS
        run("our", x_regcomp, x_regexec, x_regfree, x_regerror, atoi(a), atoi(b), p, s);
#endif
    }
    return 0;
}
