export function onscary(x, y, mtmp) {   // monmove.c:241
    let ep = null, auditory_scare = 0, magical_scare = 0;
    auditory_scare = $c.i8(x === 0 && y === 0 ? 1 : 0);
    magical_scare = $c.i8(!auditory_scare ? 1 : 0);
    if (mtmp.iswiz | 0 || $c.andu64(mtmp.data.mflags2, M2_MINION) !== 0 && mon_aligntyp(mtmp) === A_LAWFUL || $c.peq(mtmp.data, $c.relem(mons, PM_ANGEL)) || ($c.peq(mtmp.data, $c.relem(mons, PM_DEATH)) || $c.peq(mtmp.data, $c.relem(mons, PM_FAMINE)) || $c.peq(mtmp.data, $c.relem(mons, PM_PESTILENCE)))) {
        return 0;
    }
    if (magical_scare && (mtmp.data.mlet === S_HUMAN || (mtmp.data.geno & G_UNIQ) !== 0)) {
        return 0;
    }
    if (mtmp.isshk | 0 && inhishop(mtmp) || mtmp.ispriest | 0 && inhistemple(mtmp)) {
        return 0;
    }
    if (auditory_scare) {
        return 1;
    }
    if (svl.level.locations[x][y].typ === ALTAR && (mtmp.data.mlet === S_VAMPIRE || (mtmp.cham === PM_VAMPIRE || mtmp.cham === PM_VAMPIRE_LEADER || mtmp.cham === PM_VLAD_THE_IMPALER))) {
        return 1;
    }
    if (sobj_at(SCR_SCARE_MONSTER, x, y)) {
        return 1;
    }
    return $c.i8((ep = sengr_at($c.lit("Elbereth"), x, y, 1)) !== null && (x === u.ux && y === u.uy || (u.uprops[DISPLACED].intrinsic || u.uprops[DISPLACED].extrinsic) && mtmp.mux === x && mtmp.muy === y || ep.guardobjects | 0 && svl.level.objects[x][y]) && !(mtmp.isshk | 0 || mtmp.isgd | 0 || !mtmp.mcansee || mtmp.mpeaceful | 0 || $c.peq(mtmp.data, $c.relem(mons, PM_MINOTAUR)) || In_hell(u.uz) || u.uz.dnum === svd.dungeon_topology.d_astral_level.dnum) ? 1 : 0);
}
