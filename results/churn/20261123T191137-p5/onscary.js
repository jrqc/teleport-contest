export function onscary(x, y, mtmp) {   // monmove.c:241
    let ep = null, auditory_scare = 0, magical_scare = 0;
    /* <0,0> is used by musical scaring;
     * it doesn't care about scrolls or engravings or dungeon branch */
    auditory_scare = x === 0 && y === 0 ? 1 : 0;
    magical_scare = !auditory_scare ? 1 : 0;
    /* creatures who are directly resistant to any type of scaring:
     * Rodney, lawful minions, Angels, the Riders */
    if (mtmp.iswiz || $c.andu64(mtmp.data.mflags2, M2.MINION) !== 0 && mon_aligntyp(mtmp) === A.LAWFUL || mtmp.data === mons[PM.ANGEL] || is_rider(mtmp.data)) {
        return FALSE;
    }
    /* creatures who are directly resistant to magical scaring
     * based on the mere presence of something at a location:
     * humans etc.
     * uniques have ascended their base monster instincts */
    if (magical_scare && (mtmp.data.mlet === S.HUMAN || unique_corpstat(mtmp.data))) {
        return FALSE;
    }
    /* creatues who resist scaring under particular circumstances:
     * shopkeepers inside their own shop
     * priests inside their own temple */
    if (mtmp.isshk && inhishop(mtmp) || mtmp.ispriest && inhistemple(mtmp)) {
        return FALSE;
    }
    if (auditory_scare) {
        return TRUE;
    }
    /* should this still be true for defiled/molochian altars? */
    if (svl.level.locations[x][y].typ === ALTAR && (mtmp.data.mlet === S.VAMPIRE || is_vampshifter(mtmp))) {
        return TRUE;
    }
    /* the scare monster scroll doesn't have any of the below
     * restrictions, being its own source of power */
    if (sobj_at(SCR_SCARE_MONSTER, x, y)) {
        return TRUE;
    }
    /*
     * Creatures who don't (or can't) fear a written Elbereth:
     * all the above plus shopkeepers (even if poly'd into non-human),
     * vault guards (also even if poly'd), blind or peaceful monsters,
     * humans and elves, and minotaurs.
     *
     * If the player isn't actually on the square OR the player's image
     * isn't displaced to the square, no protection is being granted.
     *
     * Elbereth doesn't work in Gehennom, the Elemental Planes, or the
     * Astral Plane; the influence of the Valar only reaches so far.
     */
    return (ep = sengr_at($c.lit("Elbereth"), x, y, TRUE)) !== null && (u_at(x, y) || Displaced() && mtmp.mux === x && mtmp.muy === y || ep.guardobjects && vobj_at(x, y)) && !(mtmp.isshk || mtmp.isgd || !mtmp.mcansee || mtmp.mpeaceful || mtmp.data === mons[PM.MINOTAUR] || Inhell() || In_endgame(u.uz)) ? 1 : 0;
}
