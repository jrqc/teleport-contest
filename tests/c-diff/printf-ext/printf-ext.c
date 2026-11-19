/* Native reference for js/crt/printf.js: %a/%A (with the _hdtoa.c rounding rule), %n, %lc/%ls, L.
   tests/crt/printf-ext.test.mjs compiles and runs it and compares with cformat. */
#include <stdio.h>
#include <float.h>
#include <wchar.h>
int main(void) {
  double v[] = {0.0, -0.0, 1.0, 1.5, 0.1, -3.75, 1e300, 4.9e-324, 2.2250738585072014e-308, 1.0000000000000002, 0.9999999999999999, 255.5, 1.0/3, 6.103515625e-05, 1.96875};
  const char *f[] = {"%a", "%A", "%.0a", "%.1a", "%.2a", "%.3a", "%#.0a", "%20a", "%-20a|", "%020a", "%+a", "% a", "%.13a", "%.15a", "%La"};
  for (unsigned i = 0; i < sizeof v / sizeof *v; i++) for (unsigned j = 0; j < sizeof f / sizeof *f; j++) {
    if (j == 14) printf("%La\n", (long double) v[i]); else { printf(f[j], v[i]); printf("\n"); }
  }
  int n = 0; short h = 0; printf("abc%n%hndef\n", &n, &h); printf("%d %d\n", n, h);
  printf("%lc|%5lc|%ls|%.2ls\n", (wint_t) 'x', (wint_t) 0xe9, L"hey", L"hey");
  printf("%Lf %Le %10.3Lf\n", (long double) 2.5, (long double) 1e10, (long double) 3.14159);
  double t[] = {0x1.08p0, 0x1.18p0, 0x1.28p0, 0x1.38p0, 0x1.f8p0, 0x1.e8p0, 0x1.8p0, 0x1.081p0, 0x1.181p0, 0x1.0800000000001p0, 0x1.8000000000001p0, 0x1.ffffffffffff8p0, 0x1.fffffffffff8p0, 0x1.0000000000008p0, 0x1.0000000000018p0};
  for (int i = 0; i < 15; i++) printf("%.1a %.0a %.12a %.11a\n", t[i], t[i], t[i], t[i]);
  return 0;
}
