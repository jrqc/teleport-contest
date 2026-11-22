export function onscary(x, y, mtmp) {   // monmove.c:241
    let ep = null, auditory_scare = 0, magical_scare = 0;
    auditory_scare = $c.i8(x === 0 && y === 0 ? 1 : 0);
    magical_scare = $c.i8(!auditory_scare ? 1 : 0);
    if (mtmp.iswiz | 0 || $c.andu64(mtmp.data.mflags2, 4096) !== 0 && mon_aligntyp(mtmp) === 1 || $c.peq(mtmp.data, $c.relem(mons, 123 /* PM_ANGEL */)) || ($c.peq(mtmp.data, $c.relem(mons, 311 /* PM_DEATH */)) || $c.peq(mtmp.data, $c.relem(mons, 313 /* PM_FAMINE */)) || $c.peq(mtmp.data, $c.relem(mons, 312 /* PM_PESTILENCE */)))) {
        return 0;
    }
    if (magical_scare && (mtmp.data.mlet === 53 /* S_HUMAN */ || (mtmp.data.geno & 4096) !== 0)) {
        return 0;
    }
    if (mtmp.isshk | 0 && inhishop(mtmp) || mtmp.ispriest | 0 && inhistemple(mtmp)) {
        return 0;
    }
    if (auditory_scare) {
        return 1;
    }
    if (svl.level.locations[x][y].typ === 32 /* ALTAR */ && (mtmp.data.mlet === 48 /* S_VAMPIRE */ || (mtmp.cham === 226 /* PM_VAMPIRE */ || mtmp.cham === 227 /* PM_VAMPIRE_LEADER */ || mtmp.cham === 228 /* PM_VLAD_THE_IMPALER */))) {
        return 1;
    }
    if (sobj_at(326 /* SCR_SCARE_MONSTER */, x, y)) {
        return 1;
    }
    return $c.i8((ep = sengr_at($c.lit("Elbereth"), x, y, 1)) !== null && (x === u.ux && y === u.uy || (u.uprops[41 /* DISPLACED */].intrinsic || u.uprops[41 /* DISPLACED */].extrinsic) && mtmp.mux === x && mtmp.muy === y || ep.guardobjects | 0 && svl.level.objects[x][y]) && !(mtmp.isshk | 0 || mtmp.isgd | 0 || !mtmp.mcansee || mtmp.mpeaceful | 0 || $c.peq(mtmp.data, $c.relem(mons, 177 /* PM_MINOTAUR */)) || In_hell(u.uz) || u.uz.dnum === svd.dungeon_topology.d_astral_level.dnum) ? 1 : 0);
}
