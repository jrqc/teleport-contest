/* homemap.c: DYLD interposer that lets the recorder run with the recording
 * machine's HOME (docs/recording-environment.md) on any machine.
 *
 * Why: NetHack shows the config file's path on screen ("1 error in
 * $HOME/.nethackrc", the `?g` options help), and the official sessions show
 * /Users/davidbau/...; a recording made with another HOME differs on those
 * screens (and in their line wrapping). With HOME set to that string, the
 * file calls below rewrite a path that starts with it to start with
 * $TELEPORT_HOMEMAP_REAL instead, a real directory holding .nethackrc.
 *
 * TELEPORT_HOMEMAP_FROM (the canonical HOME) and TELEPORT_HOMEMAP_REAL must
 * both be set; otherwise every call passes through unchanged.
 */
#include <dirent.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *map(const char *p, char *buf, size_t n) {
    const char *from = getenv("TELEPORT_HOMEMAP_FROM"), *real = getenv("TELEPORT_HOMEMAP_REAL");
    if (!p || !from || !real || !*from) return p;
    size_t k = strlen(from);
    if (strncmp(p, from, k) != 0 || (p[k] != '/' && p[k] != '\0')) return p;
    snprintf(buf, n, "%s%s", real, p + k);
    return buf;
}
#define B char buf[2048]

static int hm_access(const char *p, int m) { B; return access(map(p, buf, sizeof buf), m); }
static FILE *hm_fopen(const char *p, const char *m) { B; return fopen(map(p, buf, sizeof buf), m); }
static FILE *hm_freopen(const char *p, const char *m, FILE *f) { B; return freopen(map(p, buf, sizeof buf), m, f); }
static int hm_open(const char *p, int fl, ...) {
    B; int mode = 0;
    if (fl & O_CREAT) { va_list ap; va_start(ap, fl); mode = va_arg(ap, int); va_end(ap); }
    return open(map(p, buf, sizeof buf), fl, mode);
}
static int hm_creat(const char *p, mode_t m) { B; return creat(map(p, buf, sizeof buf), m); }
static int hm_stat(const char *p, struct stat *s) { B; return stat(map(p, buf, sizeof buf), s); }
static DIR *hm_opendir(const char *p) { B; return opendir(map(p, buf, sizeof buf)); }
static int hm_unlink(const char *p) { B; return unlink(map(p, buf, sizeof buf)); }
static int hm_chdir(const char *p) { B; return chdir(map(p, buf, sizeof buf)); }
static int hm_rename(const char *a, const char *b) { char x[2048], y[2048]; return rename(map(a, x, sizeof x), map(b, y, sizeof y)); }

#define DYLD_INTERPOSE(_repl, _orig) \
    __attribute__((used)) static struct { const void *r; const void *o; } \
    _interpose_##_orig __attribute__((section("__DATA,__interpose"))) = \
        { (const void *) (unsigned long) &_repl, (const void *) (unsigned long) &_orig };

DYLD_INTERPOSE(hm_access, access)
DYLD_INTERPOSE(hm_fopen, fopen)
DYLD_INTERPOSE(hm_freopen, freopen)
DYLD_INTERPOSE(hm_open, open)
DYLD_INTERPOSE(hm_creat, creat)
DYLD_INTERPOSE(hm_stat, stat)
DYLD_INTERPOSE(hm_opendir, opendir)
DYLD_INTERPOSE(hm_unlink, unlink)
DYLD_INTERPOSE(hm_chdir, chdir)
DYLD_INTERPOSE(hm_rename, rename)
