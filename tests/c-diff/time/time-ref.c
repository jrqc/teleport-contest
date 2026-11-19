/* time-ref.c: native Darwin localtime/mktime reference for js/crt/time.js.
 * Run with TZ=America/New_York. Prints
 *   L <t> <sec> <min> <hour> <mday> <mon> <year> <wday> <yday> <isdst> <gmtoff> <zone>
 *   M <in: sec min hour mday mon year isdst> -> <t> <normalized fields as above>
 * Build: clang -O0 time-ref.c */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static unsigned long long s = 0x123456789ABCDEFULL;
static long long r(long long n) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return (long long) (s % (unsigned long long) n); }
static void pr(const struct tm *t) {
    printf("%d %d %d %d %d %d %d %d %d %ld %s\n", t->tm_sec, t->tm_min, t->tm_hour, t->tm_mday, t->tm_mon,
           t->tm_year, t->tm_wday, t->tm_yday, t->tm_isdst, t->tm_gmtoff, t->tm_zone);
}
static void L(time_t t) { printf("L %ld ", (long) t); pr(localtime(&t)); }
static void M(int sec, int min, int hour, int mday, int mon, int year, int isdst) {
    struct tm t = { 0 };
    t.tm_sec = sec; t.tm_min = min; t.tm_hour = hour; t.tm_mday = mday; t.tm_mon = mon; t.tm_year = year; t.tm_isdst = isdst;
    printf("M %d %d %d %d %d %d %d -> ", sec, min, hour, mday, mon, year, isdst);
    time_t x = mktime(&t);
    printf("%ld ", (long) x);
    pr(&t);
}

int main(void) {
    int i, y, h;
    const long long T0 = -473277600LL /* 1955-01-02 */, T1 = 4133980800LL /* 2101-01-01 */;
    const long long E0 = -5364662400LL /* 1800-01-01 */;
    for (i = 0; i < 20000; i++) L((time_t) (T0 + r(T1 - T0)));
    for (i = 0; i < 10000; i++) L((time_t) (E0 + r(T0 - E0)));   /* before 1955: tz database table */
    /* early hours of days in transition months, plus random days, 1880..2100 */
    for (y = 1880; y <= 2100; y++) {
        int mon, d;
        for (mon = 0; mon < 12; mon++) for (d = 1; d <= 28; d += 1) {
            if (y >= 1955 && !(mon == 0 || mon == 1 || mon == 2 || mon == 3 || mon == 9 || mon == 10)) continue;
            if (r(6) && !(y == 1974 || y == 1975 || y == 1883 || (y >= 1942 && y <= 1945))) continue;
            for (h = 0; h < 5; h++) {
                struct tm t = { 0 };
                t.tm_year = y - 1900; t.tm_mon = mon; t.tm_mday = d; t.tm_hour = h; t.tm_min = 30; t.tm_isdst = -1;
                time_t x = mktime(&t);
                L(x); L(x - 1800); L(x + 1800);
                M(0, 30, h, d, mon, y - 1900, -1);
                M(0, 30, h, d, mon, y - 1900, 0);
                M(0, 30, h, d, mon, y - 1900, 1);
            }
        }
    }
    /* random and denormalized fields */
    for (i = 0; i < 20000; i++) {
        int isd = (int) r(3) - 1;
        if (r(2)) M((int) r(60), (int) r(60), (int) r(24), 1 + (int) r(28), (int) r(12), (int) r(4) ? 56 + (int) r(144) : -30 + (int) r(90), isd);
        else M((int) r(200) - 100, (int) r(200) - 100, (int) r(60) - 30, (int) r(80) - 20, (int) r(40) - 14, 70 + (int) r(120), isd);
    }
    /* the session datetimes, as patch 001 builds them (fields from the string, isdst 1 and 0) */
    M(0, 0, 9, 10, 0, 100, 1); M(0, 0, 9, 13, 9, 100, 1); M(0, 0, 12, 1, 0, 126, 1); M(0, 0, 12, 1, 0, 126, 0);
    return 0;
}
