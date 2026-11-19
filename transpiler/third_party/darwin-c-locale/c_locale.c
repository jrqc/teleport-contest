/*
 * c_locale.c: the Darwin Libc (Libc-1752.120.2) locale objects and entry
 * points the vendored TRE regex needs, for the "C" locale. Each definition is
 * copied from the named Darwin source; where Darwin's function also serves
 * other locales, only its C-locale branch is kept, and the comment says so.
 * Written for the teleport-contest transpiler (postmortem F2).
 */
#include "xlocale_private.h"
#include "mblocal.h"
#include <wchar.h>
#include <wctype.h>
#include <ctype.h>

/* locale/FreeBSD/runetype.c, tolower.c, toupper.c */
unsigned long ___runetype_l(__darwin_ct_rune_t, locale_t);
__darwin_ct_rune_t ___tolower_l(__darwin_ct_rune_t, locale_t);
__darwin_ct_rune_t ___toupper_l(__darwin_ct_rune_t, locale_t);

/* locale/FreeBSD/collate.c:82 __xlocale_C_collate (the C locale: load error
 * set, so collation is by code point) */
struct xlocale_collate __xlocale_C_collate = {
	{ { 1, NULL }, "C", }, 1
};

/* locale/xlocale.c:42 C_LOCALE_INITIALIZER, :59-61 */
#define C_LOCALE_INITIALIZER	{	\
	{ 1, NULL },			\
	{}, {}, {}, {}, {},		\
	{}, {}, {}, {}, {},		\
	XMAGIC,				\
	{				\
		[XLC_COLLATE] = (void *)&__xlocale_C_collate,	\
		[XLC_CTYPE] = (void *)&_DefaultRuneXLocale,	\
	},				\
}
static struct _xlocale __c_locale = C_LOCALE_INITIALIZER;
const locale_t _c_locale = (const locale_t)&__c_locale;
struct _xlocale __global_locale = C_LOCALE_INITIALIZER;

/* locale/xlocale.c:488-501 */
int
___mb_cur_max(void)
{
	return XLOCALE_CTYPE(__current_locale())->__mb_cur_max;
}

int
___mb_cur_max_l(locale_t loc)
{
	return XLOCALE_CTYPE(__locale_ptr(loc))->__mb_cur_max;
}

/* include/xlocale/_ctype.h:49 (the __LIBC__ inline, externalized as Libc does) */
int
__maskrune_l(__darwin_ct_rune_t _c, unsigned long _f, locale_t _l)
{
	return (int)((_c < 0 || _c >= _CACHED_RUNES) ? (__uint32_t)___runetype_l(_c, _l) :
		XLOCALE_CTYPE(__locale_ptr(_l))->_CurrentRuneLocale->__runetype[_c]) & (__uint32_t)_f;
}

/* locale/FreeBSD/collate.c:1789 __collate_equiv_value: the length check and the
 * POSIX-locale branch (XLOCALE_COLLATE(loc)->__collate_load_error is set in
 * the C locale, so the code after it is unreachable here) */
#define COLLATE_STR_LEN 24	/* locale/FreeBSD/collate.h:40 */
int
__collate_equiv_value(locale_t loc, const wchar_t *str, size_t len)
{
	if (len < 1 || len >= COLLATE_STR_LEN)
		return 0;

	/* POSIX locale */
	if (XLOCALE_COLLATE(loc)->__collate_load_error)
		return (len == 1 && *str <= UCHAR_MAX) ? *str : 0;
	return 0;
}

/*
 * The wide-character classification and case entry points TRE calls. In Libc
 * they are the inline functions of include/xlocale/___wctype.h, externalized
 * by locale/iswctype.c, over the inlines of include/xlocale/_ctype.h
 * (__istype_l, __tolower_l, __toupper_l); the vendored files are compiled with
 * _DONT_USE_CTYPE_INLINE_ so that every call reaches these definitions.
 */

/* include/xlocale/_ctype.h __istype_l */
static int
__istype_l(__darwin_ct_rune_t _c, unsigned long _f, locale_t _l)
{
	return !!(isascii(_c) ? (_DefaultRuneLocale.__runetype[_c] & _f)
		: __maskrune_l(_c, _f, _l));
}

/* include/xlocale/___wctype.h */
int iswalnum_l(wint_t _wc, locale_t _l) { return (__istype_l(_wc, _CTYPE_A|_CTYPE_D, _l)); }
int iswctype_l(wint_t _wc, wctype_t _charclass, locale_t _l) { return (__istype_l(_wc, _charclass, _l)); }
int iswdigit_l(wint_t _wc, locale_t _l) { return (__istype_l(_wc, _CTYPE_D, _l)); }
int iswlower_l(wint_t _wc, locale_t _l) { return (__istype_l(_wc, _CTYPE_L, _l)); }
int iswupper_l(wint_t _wc, locale_t _l) { return (__istype_l(_wc, _CTYPE_U, _l)); }
int iswxdigit_l(wint_t _wc, locale_t _l) { return (__istype_l(_wc, _CTYPE_X, _l)); }

/* include/xlocale/_ctype.h __tolower_l / __toupper_l, via ___wctype.h towlower_l / towupper_l */
wint_t
towlower_l(wint_t _wc, locale_t _l)
{
	return isascii(_wc) ? _DefaultRuneLocale.__maplower[_wc]
		: ___tolower_l(_wc, _l);
}

wint_t
towupper_l(wint_t _wc, locale_t _l)
{
	return isascii(_wc) ? _DefaultRuneLocale.__mapupper[_wc]
		: ___toupper_l(_wc, _l);
}

/*
 * locale/FreeBSD/collcmp.c:46 __collate_range_cmp(char c1, char c2). TRE
 * (tre-match-utils.h:520, tre-parse.c) declares and calls it as
 * (wchar_t, wchar_t, locale_t), and Libc links those calls to this two-argument
 * function: the characters arrive truncated to char (the callee stores its
 * char parameters into the strings) and the locale argument is ignored. This
 * definition takes TRE's argument list and does what that call does.
 */
int
__collate_range_cmp(wchar_t wc1, wchar_t wc2, locale_t loc __unused)
{
	char c1 = (char)wc1, c2 = (char)wc2;
	char s1[2], s2[2];

	s1[0] = c1;
	s1[1] = '\0';
	s2[0] = c2;
	s2[1] = '\0';
	return (strcoll(s1, s2));
}

/* locale/FreeBSD/collate.c:1409 __collate_equiv_wchar: the POSIX-locale branch */
int
__collate_equiv_wchar(locale_t loc, wchar_t lch, wchar_t rch,
    int insensitive_cmp)
{
	/* POSIX locale */
	if (XLOCALE_COLLATE(loc)->__collate_load_error) {
		if (lch > UCHAR_MAX || rch > UCHAR_MAX)
			return (-1);
		if (insensitive_cmp) {
			if (!iswlower_l(lch, loc))
				lch = towlower_l(lch, loc);
			if (!iswlower_l(rch, loc))
				rch = towlower_l(rch, loc);
		}
		return (lch == rch);
	}
	return (0);
}
