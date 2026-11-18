/* realnow.c: DYLD interposer that pins time() for the recorder process.
 *
 * Why: patch 001's time_from_yyyymmddhhmmss() (src/calendar.c) copies the
 * struct tm of the *real* current time, including tm_isdst, before calling
 * mktime() on the pinned NETHACK_FIXED_DATETIME. So the DST state at the
 * moment of recording leaks into the pinned clock (+/-1 hour). The official
 * sessions were recorded during US daylight time (spring 2026, TZ
 * America/New_York), so we pin "now" to a DST instant to reproduce them.
 *
 * TELEPORT_REALNOW=<epoch seconds> overrides; default 1777723200
 * (2026-05-02 12:00:00 UTC, NetHack 5.0.0 release, EDT in New York).
 */
#include <stdlib.h>
#include <time.h>

static time_t pinned_time(time_t *t) {
    const char *s = getenv("TELEPORT_REALNOW");
    time_t v = (time_t) ((s && *s) ? strtoll(s, NULL, 10) : 1777723200LL);
    if (t) *t = v;
    return v;
}

#define DYLD_INTERPOSE(_repl, _orig) \
    __attribute__((used)) static struct { const void *r; const void *o; } \
    _interpose_##_orig __attribute__((section("__DATA,__interpose"))) = \
        { (const void *) (unsigned long) &_repl, (const void *) (unsigned long) &_orig };

DYLD_INTERPOSE(pinned_time, time)
