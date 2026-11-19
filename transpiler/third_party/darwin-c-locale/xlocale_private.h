/*
 * xlocale_private.h: the subset of Darwin Libc's private locale header
 * (Libc-1752.120.2 locale/xlocale_private.h) that the vendored TRE regex and
 * locale/FreeBSD files need, for the one locale the NetHack recorder runs in:
 * the "C" locale (NetHack never calls setlocale or uselocale).
 *
 * Type and field names follow the original. Differences, all outside what
 * the C locale can observe: no thread-specific locale (__current_locale()
 * returns &__global_locale, which is what Darwin returns when no thread has
 * called uselocale), no os_unfair_lock, and plain (non-atomic) reference
 * counts. Written for the teleport-contest transpiler (postmortem F2).
 */
#ifndef _XLOCALE_PRIVATE_H_
#define _XLOCALE_PRIVATE_H_

#define __DARWIN_XLOCALE_PRIVATE
#include <sys/cdefs.h>
#include <xlocale.h>
#include <stdlib.h>
#include <string.h>
#include <locale.h>
#include <limits.h>
#include <runetype.h>
#undef __DARWIN_XLOCALE_PRIVATE

#undef MB_CUR_MAX_L
#define MB_CUR_MAX_L(x)	(XLOCALE_CTYPE(x)->__mb_cur_max)
#undef MB_CUR_MAX
#define MB_CUR_MAX	MB_CUR_MAX_L(__current_locale())

typedef void (*__free_extra_t)(void *);

#define XMAGIC		0x786c6f63616c6530LL	/* 'xlocale0' */

enum {
	XLC_COLLATE = 0,
	XLC_CTYPE,
	XLC_MONETARY,
	XLC_NUMERIC,
	XLC_TIME,
	XLC_MESSAGES,
	XLC_LAST
};

struct xlocale_refcounted {
	int retain_count;
	__free_extra_t destructor;
};

#define XLOCALE_DEF_VERSION_LEN 12
#define ENCODING_LEN 31

struct xlocale_component {
	struct xlocale_refcounted header;
	char locale[ENCODING_LEN+1];
	char version[XLOCALE_DEF_VERSION_LEN];
};

/* locale/FreeBSD/collate.h: only the fields the C locale reads */
struct xlocale_collate {
	struct xlocale_component header;
	unsigned char __collate_load_error;
};

struct _xlocale {
	struct xlocale_refcounted header;
	__darwin_mbstate_t __mbs_mblen;
	__darwin_mbstate_t __mbs_mbrlen;
	__darwin_mbstate_t __mbs_mbrtowc;
	__darwin_mbstate_t __mbs_mbsnrtowcs;
	__darwin_mbstate_t __mbs_mbsrtowcs;
	__darwin_mbstate_t __mbs_mbtowc;
	__darwin_mbstate_t __mbs_wcrtomb;
	__darwin_mbstate_t __mbs_wcsnrtombs;
	__darwin_mbstate_t __mbs_wcsrtombs;
	__darwin_mbstate_t __mbs_wctomb;
	int64_t __magic;
	struct xlocale_component *components[XLC_LAST];
};

#define	XLOCALE_COLLATE(l) \
    ((struct xlocale_collate *)(l)->components[XLC_COLLATE])
#define	XLOCALE_CTYPE(l)	\
    ((struct xlocale_ctype *)(l)->components[XLC_CTYPE])

extern struct _xlocale __global_locale;
extern const locale_t _c_locale;

#define NORMALIZE_LOCALE(x)	if ((x) == LC_C_LOCALE) { \
					(x) = _c_locale; \
				} else if ((x) == LC_GLOBAL_LOCALE) { \
					(x) = &__global_locale; \
				}

static __inline void*
xlocale_retain(void *val)
{
	struct xlocale_refcounted *obj = val;

	if (obj == NULL)
		return (NULL);
	obj->retain_count++;
	return (val);
}

static __inline void
xlocale_release(void *val)
{
	struct xlocale_refcounted *obj = val;

	if (obj == NULL)
		return;
	if (--obj->retain_count == 0) {
		if (obj->destructor != NULL)
			(*obj->destructor)(val);
	}
}

extern struct xlocale_ctype _DefaultRuneXLocale;

static __inline locale_t
__current_locale(void)
{
	return &__global_locale;
}

static __inline locale_t
__locale_ptr(locale_t __loc)
{
	NORMALIZE_LOCALE(__loc);
	return __loc;
}

/* Libc's internal include/_ctype.h name for the rune type */
typedef __darwin_ct_rune_t __ct_rune_t;

/* Libc's internal headers make struct xlocale_ctype (locale/FreeBSD/mblocal.h)
 * visible to every locale file; with the public SDK headers it comes from here */
#include "mblocal.h"

#endif /* _XLOCALE_PRIVATE_H_ */
