/* c03: structs, unions, bit-fields, malloc, linked lists */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { short x, y; } coord;
struct obj { struct obj *nobj; int otyp; long quan; char name[12]; unsigned known : 1, cursed : 1, spe : 4; coord pos; };
union any { int a_int; long a_long; void *a_void; };
struct light { int range; union any id; struct { int on, flags; }; };
struct obj *olist;
static coord dirs[4] = { { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 } };
static struct obj *mkobj(int typ, const char *nm) {
    struct obj *o = (struct obj *) malloc(sizeof (struct obj));
    memset(o, 0, sizeof (struct obj));
    o->otyp = typ; o->quan = 1L; strncpy(o->name, nm, sizeof o->name - 1);
    o->nobj = olist; olist = o;
    return o;
}
static coord addc(coord a, coord b) { coord r; r.x = a.x + b.x; r.y = a.y + b.y; a.x = 99; return r; }
static int cnt(void) { int n = 0; struct obj *o; for (o = olist; o; o = o->nobj) n++; return n; }
int main(void) {
    struct obj *o, *p;
    coord c = { 3, 4 }, d;
    struct light ls;
    int i;
    struct obj arr[3], *ap;
    mkobj(1, "dagger"); o = mkobj(2, "long sword of great length"); mkobj(3, "apple");
    o->spe = 13; o->cursed = 1; o->known = 3;
    printf("%d objs; %s spe=%d cursed=%d known=%d\n", cnt(), o->name, o->spe, o->cursed, o->known);
    o->spe++; o->spe += 5;
    printf("spe now %d\n", o->spe);
    d = addc(c, dirs[1]);
    printf("d=(%d,%d) c=(%d,%d) sizes %d %d %d\n", d.x, d.y, c.x, c.y, (int) sizeof (struct obj), (int) sizeof (union any), (int) sizeof ls);
    d = c; d.x = 7;
    printf("copy %d %d\n", c.x, d.x);
    ls.id.a_int = 42; ls.on = 1; ls.range = 2;
    printf("light %d %d %d\n", ls.id.a_int, ls.on, ls.range);
    ls.id.a_void = (void *) o;
    p = (struct obj *) ls.id.a_void;
    printf("same %d %s\n", p == o, p->name);
    memset(arr, 0, sizeof arr);
    for (i = 0; i < 3; i++) { arr[i].otyp = i * 7; arr[i].pos = dirs[i]; }
    for (ap = arr; ap < &arr[3]; ap++) printf("[%d %d,%d]", ap->otyp, ap->pos.x, ap->pos.y);
    printf(" %d\n", (int) (&arr[2] - arr));
    o->pos = dirs[2];
    o->pos.y = -5;
    printf("pos %d %d; dirs[2] %d %d\n", o->pos.x, o->pos.y, dirs[2].x, dirs[2].y);
    for (o = olist; o; o = p) { p = o->nobj; free(o); }
    return 0;
}
