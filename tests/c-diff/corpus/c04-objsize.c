/* c04: __builtin_object_size as clang folds it at -O0 (fortified string calls depend on it) */
#include <stdio.h>
#include <string.h>
struct s { int a; char name[12]; char tail[8]; };
struct t { char buf[16]; int after; };
static char gbuf[40];
static struct s gs;
struct s *gp = &gs;
int main(void) {
    char loc[20], *p = loc;
    struct s ls, *sp = &ls;
    struct t tt, *tp = &tt;
    printf("arr %d %d\n", (int) __builtin_object_size(loc, 0), (int) __builtin_object_size(loc, 1));
    printf("arr+3 %d %d\n", (int) __builtin_object_size(loc + 3, 0), (int) __builtin_object_size(&loc[3], 1));
    printf("ptr %d %d\n", (int) __builtin_object_size(p, 0), (int) __builtin_object_size(p, 1));
    printf("gbuf %d %d\n", (int) __builtin_object_size(gbuf, 0), (int) __builtin_object_size(gbuf, 1));
    printf("ls.name %d %d\n", (int) __builtin_object_size(ls.name, 0), (int) __builtin_object_size(ls.name, 1));
    printf("ls.tail %d %d\n", (int) __builtin_object_size(ls.tail, 0), (int) __builtin_object_size(ls.tail, 1));
    printf("sp->name %d %d\n", (int) __builtin_object_size(sp->name, 0), (int) __builtin_object_size(sp->name, 1));
    printf("sp->tail %d %d\n", (int) __builtin_object_size(sp->tail, 0), (int) __builtin_object_size(sp->tail, 1));
    printf("gs.name %d %d\n", (int) __builtin_object_size(gs.name, 0), (int) __builtin_object_size(gs.name, 1));
    printf("gp->name %d %d\n", (int) __builtin_object_size(gp->name, 0), (int) __builtin_object_size(gp->name, 1));
    printf("tp->buf %d %d\n", (int) __builtin_object_size(tp->buf, 0), (int) __builtin_object_size(tp->buf, 1));
    printf("tt.buf+4 %d %d\n", (int) __builtin_object_size(tt.buf + 4, 0), (int) __builtin_object_size(&tt.buf[4], 1));
    printf("&ls %d %d\n", (int) __builtin_object_size(&ls, 0), (int) __builtin_object_size(&ls, 1));
    printf("sp %d %d\n", (int) __builtin_object_size(sp, 0), (int) __builtin_object_size(sp, 1));
    printf("lit %d %d\n", (int) __builtin_object_size("abc", 0), (int) __builtin_object_size("abc", 1));
    printf("&gs.a %d %d\n", (int) __builtin_object_size(&gs.a, 0), (int) __builtin_object_size(&gs.a, 1));
    { int i = 2; printf("var idx %d %d\n", (int) __builtin_object_size(&loc[i], 0), (int) __builtin_object_size(&loc[i], 1)); }
    printf("nested %d %d\n", (int) __builtin_object_size(&gs.name[5], 0), (int) __builtin_object_size(gp->tail + 2, 1));
    return 0;
}
