import { afkortOrd, bjaelke } from './analyse'
import type { Soejle } from '../types'
import { KVARTER, maal, maalForklaring, maalKr } from './enhed'
import { datoNoegle } from './historik'
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
    ...ekstra.filter(r => !pr.has(r.id)).map(r => ({ id: r.id, navn: r.navn, handling: r.handling, usd: r.usd, hvorfor: r.hvorfor, antal: 'denne samtale', fra: [] })),
  ].sort((a, b) => b.usd - a.usd)
}

// Alle samtaler: hvor mange, hvor mange aktive dage og forbruget i alt.
export const alleSamtalerTekst = (liste: readonly Resume[]): string[] => {
  if (liste.length === 0) return ['**Alle samtaler**', 'Ingen samtaler med forbrug endnu.']
  const dage = new Set(liste.flatMap(s => s.dage)).size
  return [
    '**Alle samtaler**',
    `${samtaler(liste.length)} · ${dage === 1 ? '1 aktiv dag' : `${dage} aktive dage`} · ${maalKr(sum(liste, s => s.usd))} i alt`,
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
export const indsigtTekst = (liste: readonly Resume[], ekstra: readonly Raad[] = [], visuel = true): string[] => {
  if (liste.length === 0) return ['Ingen samtaler med forbrug endnu.']
  const dyreste = [...liste].sort((a, b) => b.usd - a.usd).slice(0, 3)
  const top = dyreste[0]?.usd ?? 0
  return [
    ...alleSamtalerTekst(liste),
    '',
    ...godeRaadTekst(liste, ekstra, visuel),
    '',
    '**Dyreste samtaler**',
    ...dyreste.map(s => `${visuel ? `${bjaelke(top > 0 ? s.usd / top : 0, 10)} ` : ''}${beloeb(s.usd)} · ${afkortOrd(s.titel, 50)}`),
  ]
}

// Ugens dyreste samtaler i ugegrænsens vindue, med bjælker i det godkendte format.
export const ugensSamtalerTekst = (samtaler: readonly { titel: string; usd: number }[], periode: string, visuel = true): string[] => {
  const overskrift = `**Ugens dyreste samtaler** · ${periode}`
  if (samtaler.length === 0) return [overskrift, `Intet forbrug ${periode}.`]
  const sorteret = [...samtaler].sort((a, b) => b.usd - a.usd)
  const top = sorteret[0]?.usd ?? 0
  const vist = sorteret.slice(0, MEST)
  const rest = sorteret.slice(MEST)
  return [
    overskrift,
    `I alt ${maalKr(sum(sorteret, s => s.usd))} · ${samtaler.length === 1 ? '1 samtale' : `${samtaler.length} samtaler`}`,
    ...vist.map(s => `${visuel ? `${bjaelke(top > 0 ? s.usd / top : 0, 10)} ` : ''}${maalKr(s.usd)} · ${afkortOrd(s.titel, 50)}`),
    ...(rest.length ? [`Plus ${rest.length === 1 ? '1 mindre samtale' : `${rest.length} mindre samtaler`}: ${maal(sum(rest, s => s.usd))}.`] : []),
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
