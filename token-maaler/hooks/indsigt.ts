import { afkortOrd, bjaelke } from './analyse'
import type { Soejle } from '../types'
import type { Andet, Periode } from './andet'
import { KVARTER, maal, maalForklaring, maalKr } from './enhed'
import { datoNoegle, datoTekst } from './historik'
import { beloeb, MEST, raadBlok, restLinje } from './raad'
import type { Raad } from './raad'

// Det, Indsigt husker om hver samtale: nok til totalen, de dyreste samtaler og rådene på tværs.
export type Resume = {
  id: string
  titel: string
  usd: number
  dage: string[]
  // Forbruget pr. kvarter, til at måle abonnementets grænser.
  kvarterer?: Record<string, number>
  // Navnet på den planlagte opgave, der startede samtalen; fraværende for en almindelig samtale.
  planlagt?: string
  raad: Pick<Raad, 'id' | 'navn' | 'handling' | 'kort' | 'usd'>[]
}

// Et råd lagt sammen på tværs af samtalerne, med de samtaler, det kom fra.
export type TvaersRaad = Pick<Raad, 'id' | 'navn' | 'handling' | 'usd'> & { hvorfor: string; antal: string; fra: { titel: string; usd: number }[] }

const samtaler = (n: number) => (n === 1 ? '1 samtale' : `${n} samtaler`)

const sum = <T>(liste: readonly T[], f: (x: T) => number) => liste.reduce((s, x) => s + f(x), 0)

// Hvor rådet kom fra: de to samtaler, det kunne have sparet mest i.
const hvorFra = (fra: readonly { titel: string; usd: number }[]) => {
  const top = [...fra].sort((a, b) => b.usd - a.usd).slice(0, 2).map(f => `${afkortOrd(f.titel, 32)} (${beloeb(f.usd)})`)
  return fra.length === 1 ? `I ${top[0]}.` : `Mest i ${top.join(' og ')}.`
}

// Ét råd pr. slags med den samlede besparelse. `ekstra` er råd, der kun kendes for denne session
// (forbindelser og plugins); de beholder deres egen forklaring.
export const tvaersRaad = (liste: readonly Resume[], ekstra: readonly Raad[] = []): TvaersRaad[] => {
  const pr = new Map<string, Pick<Raad, 'navn' | 'handling'> & { usd: number; fra: { titel: string; usd: number }[] }>()
  for (const s of liste) {
    for (const r of s.raad) {
      const t = pr.get(r.id) ?? { navn: r.navn, handling: r.handling, usd: 0, fra: [] }
      t.usd += r.usd
      t.fra.push({ titel: s.titel, usd: r.usd })
      pr.set(r.id, t)
    }
  }
  return [
    ...[...pr.entries()].map(([id, t]) => ({ id, ...t, hvorfor: hvorFra(t.fra), antal: samtaler(t.fra.length) })),
    ...ekstra.filter(r => !pr.has(r.id)).map(r => ({ id: r.id, navn: r.navn, handling: r.handling, usd: r.usd, hvorfor: r.hvorfor, antal: r.antal ?? 'denne samtale', fra: [] })),
  ].sort((a, b) => b.usd - a.usd)
}

// Hvad chat, Cowork m.m. uden for Code mindst skal fylde, før det vises: to procent af ugen.
export const MINDST_ANDET = 2

// Forbrug uden for Code, omregnet til dollars, så det vises i samme enhed som samtalerne.
const andetUsd = (andet: Andet, procent: number) => procent * andet.prProcent

// Alle samtaler: hvor mange, hvor mange aktive dage og forbruget i alt. Planlagte opgaver og forbrug
// uden for Code (chat, Cowork m.m.), som ingen samtale rummer, står på hver sin linje.
export const alleSamtalerTekst = (liste: readonly Resume[], andet: Andet | null = null): string[] => {
  const planlagte = liste.filter(s => s.planlagt)
  const opgaver = new Set(planlagte.map(s => s.planlagt)).size
  const ekstra = [
    ...(planlagte.length
      ? [`Heraf planlagte opgaver: ${planlagte.length === 1 ? '1 kørsel' : `${planlagte.length} kørsler`} af ${opgaver === 1 ? '1 opgave' : `${opgaver} opgaver`} · ${maalKr(sum(planlagte, s => s.usd))}`]
      : []),
    ...(andet && andet.alt >= 5 ? [`Chat, Cowork m.m. uden for samtalerne: ${maalKr(andetUsd(andet, andet.alt))} de seneste ${andet.dage} dage`] : []),
  ]
  if (liste.length === 0) return ['**Alle samtaler**', 'Ingen samtaler med forbrug endnu.', ...ekstra]
  const dage = new Set(liste.flatMap(s => s.dage)).size
  return [
    '**Alle samtaler**',
    `${samtaler(liste.length)} · ${dage === 1 ? '1 aktiv dag' : `${dage} aktive dage`} · ${maalKr(sum(liste, s => s.usd))} i alt`,
    ...ekstra,
  ]
}

// Rådene på tværs af alle samtaler, højst fem, hver på højst tre linjer.
export const godeRaadTekst = (liste: readonly Resume[], ekstra: readonly Raad[] = [], visuel = true): string[] => {
  const ud = [`**Gode råd til dig** · tal = ${maalForklaring()}, du cirka kunne have sparet`]
  const raad = tvaersRaad(liste, ekstra)
  const stoerst = raad[0]?.usd ?? 0
  if (raad.length === 0) ud.push('', 'Ingen råd lige nu.')
  for (const r of raad.slice(0, MEST)) ud.push('', ...raadBlok(r, r.hvorfor, stoerst > 0 ? r.usd / stoerst : 0, visuel, ` · ${r.antal}`))
  return [...ud, ...restLinje(raad.slice(MEST))]
}

// Indsigt som tekst til Claudes værktøj: alle samtaler, rådene og de dyreste samtaler nogensinde.
export const indsigtTekst = (liste: readonly Resume[], ekstra: readonly Raad[] = [], visuel = true, andet: Andet | null = null): string[] => {
  if (liste.length === 0) return ['Ingen samtaler med forbrug endnu.']
  const dyreste = [...liste].sort((a, b) => b.usd - a.usd).slice(0, 3)
  const top = dyreste[0]?.usd ?? 0
  return [
    ...alleSamtalerTekst(liste, andet),
    '',
    ...godeRaadTekst(liste, ekstra, visuel),
    '',
    '**Dyreste samtaler**',
    ...dyreste.map(s => `${visuel ? `${bjaelke(top > 0 ? s.usd / top : 0, 10)} ` : ''}${beloeb(s.usd)} · ${afkortOrd(s.titel, 50)}`),
  ]
}

const KLOKKEN = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// "i dag kl. 13:00-15:30" eller "tir 7. okt kl. 13:00-15:30".
const periodeTekst = (p: Periode, nu: number): string => {
  const dag = datoNoegle(p.fra)
  const igaar = new Date(nu)
  igaar.setDate(igaar.getDate() - 1)
  const naar = dag === datoNoegle(nu) ? 'i dag' : dag === datoNoegle(igaar.getTime()) ? 'i går' : datoTekst(dag)
  return `${naar} kl. ${KLOKKEN(p.fra)}-${KLOKKEN(p.til)}`
}

// Ugens dyreste samtaler i ugegrænsens vindue, med bjælker i det godkendte format. Forbrug uden for
// Code (chat, Cowork m.m.) står på sin egen linje efter samtalerne, med de største perioder under.
export const ugensSamtalerTekst = (
  samtaler: readonly { titel: string; usd: number }[],
  periode: string,
  visuel = true,
  andet: Andet | null = null,
  nu = 0,
): string[] => {
  const overskrift = `**Ugens dyreste samtaler** · ${periode}`
  const uden = andet && andet.uge >= MINDST_ANDET ? andet : null
  if (samtaler.length === 0 && !uden) return [overskrift, `Intet forbrug ${periode}.`]
  const sorteret = [...samtaler].sort((a, b) => b.usd - a.usd)
  const udenUsd = uden ? andetUsd(uden, uden.uge) : 0
  const top = Math.max(sorteret[0]?.usd ?? 0, udenUsd)
  const vist = sorteret.slice(0, MEST)
  const rest = sorteret.slice(MEST)
  const bjaelken = (usd: number) => (visuel ? `${bjaelke(top > 0 ? usd / top : 0, 10)} ` : '')
  return [
    overskrift,
    ...(samtaler.length ? [`I alt ${maalKr(sum(sorteret, s => s.usd))} · ${samtaler.length === 1 ? '1 samtale' : `${samtaler.length} samtaler`}`] : []),
    ...vist.map(s => `${bjaelken(s.usd)}${maalKr(s.usd)} · ${afkortOrd(s.titel, 50)}`),
    ...(rest.length ? [`Plus ${rest.length === 1 ? '1 mindre samtale' : `${rest.length} mindre samtaler`}: ${maal(sum(rest, s => s.usd))}.`] : []),
    ...(uden
      ? [
          `${bjaelken(udenUsd)}${maalKr(udenUsd)} · Chat, Cowork m.m. (ikke målt pr. samtale)`,
          ...uden.perioder.slice(0, 2).map(p => `↳ ${periodeTekst(p, nu)} · ${maalKr(andetUsd(uden, p.procent))}`),
        ]
      : []),
  ]
}

const UGEDAGE = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag']

// Det gennemsnitlige forbrug pr. ugedag over hele historikken: forbruget på alle mandage delt med
// antallet af mandage fra den første aktive dag til i dag, og så videre.
export const ugedage = (resumeer: readonly Pick<Resume, 'kvarterer'>[], nu: number): Soejle[] => {
  const total = [0, 0, 0, 0, 0, 0, 0]
  let foerst = Infinity
  for (const r of resumeer) {
    for (const [n, v] of Object.entries(r.kvarterer ?? {})) {
      const t = Number(n) * KVARTER
      foerst = Math.min(foerst, t)
      const d = (new Date(t).getDay() + 6) % 7
      total[d] = (total[d] ?? 0) + v
    }
  }
  const antal = [0, 0, 0, 0, 0, 0, 0]
  if (Number.isFinite(foerst)) {
    // Én gang pr. kalenderdag fra den første aktive dag til i dag. Dagene tælles i kalenderen, ikke
    // i døgn à 24 timer, så skiftet til og fra sommertid hverken springer en dag over eller tæller
    // den to gange.
    const slut = datoNoegle(nu)
    const f = new Date(foerst)
    for (let i = 0, d = new Date(f.getFullYear(), f.getMonth(), f.getDate()); datoNoegle(d.getTime()) <= slut && i < 20_000; i++) {
      const u = (d.getDay() + 6) % 7
      antal[u] = (antal[u] ?? 0) + 1
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    }
  }
  return UGEDAGE.map((navn, d) => {
    const n = antal[d] ?? 0
    const gns = n > 0 ? (total[d] ?? 0) / n : 0
    return { etiket: navn.slice(0, 3), vaerdi: gns, tal: gns > 0 ? maal(gns) : '' }
  })
}
