export function onscary(x, y, mtmp) {   // monmove.c:241
    let ep = null, auditory_scare = 0, magical_scare = 0;
    auditory_scare = $c.i8(x === 0 && y === 0 ? 1 : 0);
    magical_scare = $c.i8(!auditory_scare ? 1 : 0);
    if (mtmp.iswiz | 0 || $c.andu64(mtmp.data.mflags2, M2_MINION) !== 0 && mon_aligntyp(mtmp) === A_LAWFUL || $c.peq(mtmp.data, $c.relem(mons, PM_ANGEL)) || is_rider(mtmp.data)) {
        return FALSE;
    }
    if (magical_scare && (mtmp.data.mlet === S_HUMAN || unique_corpstat(mtmp.data))) {
        return FALSE;
    }
    if (mtmp.isshk | 0 && inhishop(mtmp) || mtmp.ispriest | 0 && inhistemple(mtmp)) {
        return FALSE;
    }
    if (auditory_scare) {
        return TRUE;
    }
    if (svl.level.locations[x][y].typ === ALTAR && (mtmp.data.mlet === S_VAMPIRE || is_vampshifter(mtmp))) {
        return TRUE;
    }
    if (sobj_at(SCR_SCARE_MONSTER, x, y)) {
        return TRUE;
    }
    return $c.i8((ep = sengr_at($c.lit("Elbereth"), x, y, TRUE)) !== null && (u_at(x, y) || Displaced() && mtmp.mux === x && mtmp.muy === y || ep.guardobjects | 0 && vobj_at(x, y)) && !(mtmp.isshk | 0 || mtmp.isgd | 0 || !mtmp.mcansee || mtmp.mpeaceful | 0 || $c.peq(mtmp.data, $c.relem(mons, PM_MINOTAUR)) || Inhell() || In_endgame(u.uz)) ? 1 : 0);
}
