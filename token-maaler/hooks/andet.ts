// Forbrug uden for Code: chat, Cowork og andet, som abonnementets grænser tæller med, men som ikke
// står i nogen transcript. Det kan ikke ses pr. samtale, men Claude-appen gemmer kontoens procent af
// 5-timersgrænsen og ugens grænse hvert kvarter (plan-usage-history.json). Vokser procenten mere,
// end Codes eget forbrug forklarer, eller mens ingen Code-session bruger noget, er resten forbrug
// uden for Code.

import { KVARTER } from './enhed'

// Kontoens procent af 5-timersgrænsen (fh) og af ugens grænse (sd) på et tidspunkt.
export type Proeve = { t: number; fh: number | null; sd: number | null }
export type Maal = 'fh' | 'sd'

// Én nulstillingsperiode af en grænse: fra første prøve efter nulstillingen til den sidste, med den
// højeste procent, den nåede.
export type Vindue = { fra: number; til: number; p: number }

// En periode uden Code-aktivitet, hvor ugens procent alligevel voksede.
export type Periode = { fra: number; til: number; procent: number }

// Codes forbrug (listepris i dollars) i tidsrummet [fra, til).
export type KodeForbrug = (fra: number, til: number) => number

export type Andet = {
  // Dollars listepris pr. procentpoint af ugens grænse, som regnestykket bruger.
  prProcent: number
  // Procent af ugens grænse uden for Code i den aktuelle uge, og hvad ugens procent i alt var.
  uge: number
  ugeP: number
  // Summen over alle uger i historikken (kan være over 100) og hvor mange dage historikken dækker.
  alt: number
  dage: number
  // De største perioder i den aktuelle uge, hvor procenten voksede uden Code-aktivitet.
  perioder: Periode[]
}

const TIME = 3_600_000

const tal = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

// Prøverne i appens historikfil (version 2 med `u: { fh, sd }`, version 1 med `fh` og `sd`) for den
// konto, der sidst blev målt, i tidsrækkefølge. Alt andet end en gyldig fil giver ingen prøver.
export const proeverFra = (raa: unknown): Proeve[] => {
  let data: unknown = raa
  if (typeof raa === 'string') {
    try {
      data = JSON.parse(raa)
    } catch {
      return []
    }
  }
  const liste = (data as { samples?: unknown } | null)?.samples
  if (!Array.isArray(liste)) return []
  const alle = liste.flatMap((x: unknown) => {
    const o = (x ?? {}) as { t?: unknown; org?: unknown; u?: { fh?: unknown; sd?: unknown }; fh?: unknown; sd?: unknown }
    const t = tal(o.t)
    if (t === null) return []
    const u = o.u ?? o
    return [{ t, org: typeof o.org === 'string' ? o.org : null, fh: tal(u.fh), sd: tal(u.sd) }]
  })
  alle.sort((a, b) => a.t - b.t)
  const org = alle.at(-1)?.org ?? null
  return alle.filter(x => org === null || x.org === null || x.org === org).map(({ t, fh, sd }) => ({ t, fh, sd }))
}

// En grænses nulstillingsperioder: en ny begynder, når procenten falder mere end tre point, og for
// 5-timersgrænsen også efter fem timer uden målinger.
export const vinduer = (proever: readonly Proeve[], maal: Maal): Vindue[] => {
  const ud: Vindue[] = []
  let v: Vindue | null = null
  let sidst = 0
  for (const x of proever) {
    const p = x[maal]
    if (p === null) continue
    if (v === null || p < sidst - 3 || (maal === 'fh' && x.t - v.til > 5 * TIME)) {
      if (v) ud.push(v)
      v = { fra: x.t, til: x.t, p }
    } else {
      v.til = x.t
      v.p = Math.max(v.p, p)
    }
    sidst = p
  }
  if (v) ud.push(v)
  return ud
}

// Codes forbrug i et tidsrum, af forbruget pr. kvarter i alle samtaler. Et kvarter, der delvist ligger
// i tidsrummet, tæller helt med.
export const kodeForbrug = (kilder: Iterable<Record<string, number> | undefined>): KodeForbrug => {
  const pr = new Map<number, number>()
  for (const k of kilder) for (const [n, v] of Object.entries(k ?? {})) pr.set(Number(n), (pr.get(Number(n)) ?? 0) + v)
  const noegler = [...pr.keys()].sort((a, b) => a - b)
  const sum = [0]
  for (const n of noegler) sum.push((sum.at(-1) ?? 0) + (pr.get(n) ?? 0))
  // Antal kvartersnøgler under n.
  const under = (n: number) => {
    let lo = 0
    let hi = noegler.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if ((noegler[m] ?? Infinity) < n) lo = m + 1
      else hi = m
    }
    return lo
  }
  return (fra, til) => (til <= fra ? 0 : (sum[under(Math.ceil(til / KVARTER))] ?? 0) - (sum[under(Math.floor(fra / KVARTER))] ?? 0))
}

// Hvor mange dollars listepris ét procentpoint af grænsen svarer til, når kun Code bruger: i de
// perioder, hvor Code brugte det meste, er forholdet højest, mens chat og Cowork sænker det. Derfor
// tages en høj værdi af de perioder, der nåede en vis procent (ikke den højeste, så én skæv periode
// ikke bestemmer det).
export const referencePrProcent = (v: readonly Vindue[], kode: KodeForbrug, mindst = 20): number | null => {
  const r = v
    .filter(w => w.p >= mindst)
    .map(w => kode(w.fra, w.til) / w.p)
    .filter(x => x > 0 && Number.isFinite(x))
    .sort((a, b) => b - a)
  return r[Math.floor(r.length / 4)] ?? null
}

// Hvor meget procenten voksede mellem to prøver; et fald er en nulstilling, og så er alt, der er målt
// siden, nyt.
const vaekst = (a: number | null, b: number | null): number => (a === null || b === null ? 0 : b >= a - 3 ? Math.max(0, b - a) : b)

// Perioder, hvor ugens procent voksede, mens ingen Code-session brugte noget: ét kvarter før og
// under intervallet er uden Code-forbrug (højst en halv promille af ugen). Perioder tæt på hinanden
// lægges sammen. Kun målinger med højst tre timer imellem kan placeres i tid.
export const perioderUdenCode = (proever: readonly Proeve[], kode: KodeForbrug, prProcent: number, fra: number, mindst = 2): Periode[] => {
  const stille = 0.005 * prProcent
  const ud: Periode[] = []
  let nu: Periode | null = null
  const maalinger = proever.filter(x => x.sd !== null)
  for (let i = 1; i < maalinger.length; i++) {
    const a = maalinger[i - 1]
    const b = maalinger[i]
    if (!a || !b || b.t < fra) continue
    const tid = b.t - a.t
    const ingenCode = tid <= 3 * TIME && kode(a.t - KVARTER, b.t) <= stille
    if (!ingenCode) {
      if (nu) ud.push(nu)
      nu = null
      continue
    }
    const d = vaekst(a.sd, b.sd)
    if (d <= 0) continue
    if (nu && a.t - nu.til <= 45 * 60_000) {
      nu.til = b.t
      nu.procent += d
    } else {
      if (nu) ud.push(nu)
      nu = { fra: a.t, til: b.t, procent: d }
    }
  }
  if (nu) ud.push(nu)
  return ud.filter(p => p.procent >= mindst).sort((x, y) => y.procent - x.procent)
}

// Procent uden for Code i en periode: grænsens procent minus det, Codes forbrug svarer til.
export const udenForCode = (p: number, usd: number, prProcent: number): number => Math.max(0, p - usd / prProcent)

// Forbrug uden for Code i den aktuelle uge, i alle ugerne i historikken og de største perioder i den
// aktuelle uge. `live` er grænsens procent lige nu og hvornår ugen begyndte; den gør den aktuelle uge
// nyere end den sidste prøve, også når appen har været lukket, siden ugen blev nulstillet. Null uden
// prøver eller uden et kendt forhold mellem dollars og procent.
export const analyserAndet = (
  proever: readonly Proeve[],
  kode: KodeForbrug,
  prProcent: number | null,
  nu: number,
  live?: { p: number; fra: number },
): Andet | null => {
  if (!prProcent || !(prProcent > 0)) return null
  const foerst = proever[0]?.t
  const uger = vinduer(proever, 'sd')
  if (uger.length === 0 || foerst === undefined) return null
  // Den sidste periode i historikken er den aktuelle uge, medmindre grænsen er nulstillet siden.
  const sidste = uger.at(-1)
  if (live && sidste && sidste.til < live.fra) uger.push({ fra: live.fra, til: nu, p: live.p })
  let alt = 0
  let uge = 0
  let ugeP = 0
  let ugeFra = nu
  uger.forEach((w, i) => {
    const aktuel = i === uger.length - 1
    const fra = aktuel && live ? Math.min(live.fra, nu) : w.fra
    const til = aktuel ? Math.max(nu, w.til) : w.til
    const p = aktuel ? Math.max(w.p, live?.p ?? 0) : w.p
    const a = udenForCode(p, kode(fra, til), prProcent)
    alt += a
    if (aktuel) {
      uge = a
      ugeP = p
      ugeFra = fra
    }
  })
  return { prProcent, uge, ugeP, alt, dage: Math.max(1, Math.round((nu - foerst) / (24 * TIME))), perioder: perioderUdenCode(proever, kode, prProcent, ugeFra) }
}
