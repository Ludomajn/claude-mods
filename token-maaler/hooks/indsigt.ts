import { afkortOrd, bjaelke } from './analyse'
import { beloeb, MEST, raadBlok, restLinje } from './raad'
import type { Raad } from './raad'

// Det, Indsigt husker om hver samtale: nok til totalen, de dyreste samtaler og rådene på tværs.
export type Resume = {
  id: string
  titel: string
  usd: number
  dage: string[]
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

// Indsigt i hele forbruget: totalen, rådene på tværs (højst tre linjer hver) og de dyreste samtaler.
export const indsigtTekst = (liste: readonly Resume[], ekstra: readonly Raad[] = [], visuel = true): string[] => {
  if (liste.length === 0) return ['Ingen samtaler med forbrug endnu.']
  const dage = new Set(liste.flatMap(s => s.dage)).size
  const ud = [
    '**Indsigt i dit Claude-forbrug**',
    `${samtaler(liste.length)} · ${dage === 1 ? '1 aktiv dag' : `${dage} aktive dage`} · ${beloeb(sum(liste, s => s.usd))} i alt`,
    '',
    '**Råd på tværs** · beløb = hvad du cirka kunne have sparet',
  ]
  const raad = tvaersRaad(liste, ekstra)
  const stoerst = raad[0]?.usd ?? 0
  if (raad.length === 0) ud.push('', 'Ingen råd lige nu.')
  for (const r of raad.slice(0, MEST)) ud.push('', ...raadBlok(r, r.hvorfor, stoerst > 0 ? r.usd / stoerst : 0, visuel, ` · ${r.antal}`))
  ud.push(...restLinje(raad.slice(MEST)))
  const dyreste = [...liste].sort((a, b) => b.usd - a.usd).slice(0, 3)
  const top = dyreste[0]?.usd ?? 0
  ud.push('', '**Dyreste samtaler**')
  for (const s of dyreste) ud.push(`${visuel ? `${bjaelke(top > 0 ? s.usd / top : 0, 10)} ` : ''}${beloeb(s.usd)} · ${afkortOrd(s.titel, 50)}`)
  return ud
}
