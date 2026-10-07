import type { Del, Graense, Soejle } from '../types'
import { bjaelke, procent } from './analyse'

export type { Del, Graense, Soejle }

// Grafer til panelet og båndet som SVG (desktop, mobil og VS Code) og som tekst (terminalen).
// Farverne er valgt, så de kan læses på både lys og mørk baggrund.

const TEKST = '#8b8b8b'
const SPOR = 'rgba(128,128,128,0.25)'
const CYAN = '#22a6c8'
const FARVER = [CYAN, '#a371f7', '#3fb950', '#d29922', '#f778ba', '#8b8b8b']
const SKRIFT = 'font-family="system-ui, -apple-system, sans-serif"'

// Tekst til SVG: specialtegn og alt uden for ASCII som tegnreferencer, så æ, ø og å vises ens overalt.
const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[^\x20-\x7e]/gu, c => `&#x${(c.codePointAt(0) ?? 63).toString(16)};`)

const to = (n: number) => String(n).padStart(2, '0')
const UGEDAG = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']

const NAVN: Record<string, { kort: string; lang: string }> = {
  five_hour: { kort: '5 t', lang: '5-timersgrænsen' },
  seven_day: { kort: 'Uge', lang: 'Ugens grænse' },
}

// De to grænser, mod'en viser, i fast rækkefølge.
export const vistGraenser = (graenser: readonly Graense[]): Graense[] =>
  ['five_hour', 'seven_day'].flatMap(k => graenser.filter(g => g.kind === k).slice(0, 1))

// Procenten nu: er vinduet nulstillet siden målingen, er intet brugt endnu.
export const brugt = (g: Graense, nu: number): number => {
  const nulstilles = g.resetsAt ? Date.parse(g.resetsAt) : NaN
  return !Number.isNaN(nulstilles) && nulstilles <= nu ? 0 : Math.max(0, g.percentUsed)
}

// "kl. 15:40" i dag, ellers "tor kl. 09:00".
export const nulstilles = (g: Graense, nu: number): string => {
  const t = g.resetsAt ? Date.parse(g.resetsAt) : NaN
  if (Number.isNaN(t) || t <= nu) return ''
  const d = new Date(t)
  const idag = new Date(nu).toDateString() === d.toDateString()
  return `${idag ? '' : `${UGEDAG[d.getDay()] ?? ''} `}kl. ${to(d.getHours())}:${to(d.getMinutes())}`
}

const fyld = (p: number) => (p >= 80 ? '#f85149' : p >= 50 ? '#d29922' : CYAN)

const pct = (p: number) => `${Math.round(p)} %`

const graenseTooltip = (g: Graense, nu: number) => {
  const n = nulstilles(g, nu)
  return `${NAVN[g.kind]?.lang ?? g.kind}: ${pct(brugt(g, nu))} brugt${n ? `, nulstilles ${n}` : ''}`
}

// Målerne til båndet: to små bjælker på én linje.
export const maalerSvgLille = (graenser: readonly Graense[], nu: number): string => {
  const vist = vistGraenser(graenser)
  const bred = 150
  const dele = vist.map((g, i) => {
    const x = i * bred
    const p = brugt(g, nu)
    const w = Math.max(p > 0 ? 2 : 0, Math.min(100, p) * 0.7)
    return [
      `<g><title>${xml(graenseTooltip(g, nu))}</title>`,
      `<text x="${x}" y="15" fill="${TEKST}" font-size="12" ${SKRIFT}>${xml(NAVN[g.kind]?.kort ?? g.kind)}</text>`,
      `<rect x="${x + 30}" y="6" width="70" height="10" rx="5" fill="${SPOR}"/>`,
      `<rect x="${x + 30}" y="6" width="${w.toFixed(1)}" height="10" rx="5" fill="${fyld(p)}"/>`,
      `<text x="${x + 106}" y="15" fill="${TEKST}" font-size="12" ${SKRIFT}>${pct(p)}</text></g>`,
    ].join('')
  })
  const w = vist.length * bred
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" viewBox="0 0 ${w} 22">${dele.join('')}</svg>`
}

// Målerne til panelet: én række pr. grænse med hvornår den nulstilles.
export const maalerSvgStor = (graenser: readonly Graense[], nu: number): string => {
  const vist = vistGraenser(graenser)
  const rader = vist.map((g, i) => {
    const y = i * 30
    const p = brugt(g, nu)
    const w = Math.max(p > 0 ? 3 : 0, Math.min(100, p) * 2.6)
    const n = nulstilles(g, nu)
    return [
      `<g><title>${xml(graenseTooltip(g, nu))}</title>`,
      `<text x="0" y="${y + 16}" fill="${TEKST}" font-size="13" ${SKRIFT}>${xml(NAVN[g.kind]?.lang ?? g.kind)}</text>`,
      `<rect x="130" y="${y + 5}" width="260" height="14" rx="7" fill="${SPOR}"/>`,
      `<rect x="130" y="${y + 5}" width="${w.toFixed(1)}" height="14" rx="7" fill="${fyld(p)}"/>`,
      `<text x="402" y="${y + 16}" fill="${TEKST}" font-size="13" ${SKRIFT}>${xml(`${pct(p)}${n ? ` · nulstilles ${n}` : ''}`)}</text></g>`,
    ].join('')
  })
  const h = Math.max(1, vist.length) * 30
  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="${h}" viewBox="0 0 700 ${h}">${rader.join('')}</svg>`
}

// Målerne som tekst, til terminalen og til beskrivelsen af SVG'en.
export const maalerTekst = (graenser: readonly Graense[], nu: number): string =>
  vistGraenser(graenser)
    .map(g => {
      const p = brugt(g, nu)
      const n = nulstilles(g, nu)
      return `${NAVN[g.kind]?.kort ?? g.kind} ${bjaelke(Math.min(1, p / 100), 10)} ${pct(p)}${n ? ` (nulstilles ${n})` : ''}`
    })
    .join('  ·  ')

// Søjlediagram, fx forbruget pr. dag.
export const soejlerSvg = (soejler: readonly Soejle[]): string => {
  const hoej = Math.max(...soejler.map(s => s.vaerdi), 0)
  const bred = 70
  const top = 20
  const max = 100
  const dele = soejler.map((s, i) => {
    const x = i * bred
    const h = hoej > 0 ? Math.max(s.vaerdi > 0 ? 2 : 0, (s.vaerdi / hoej) * max) : 0
    const y = top + max - h
    return [
      `<g><title>${xml(s.tooltip)}</title>`,
      `<rect x="${x + 10}" y="${top}" width="${bred - 20}" height="${max}" fill="transparent"/>`,
      `<rect x="${x + 10}" y="${y.toFixed(1)}" width="${bred - 20}" height="${h.toFixed(1)}" rx="3" fill="${CYAN}"/>`,
      s.vaerdi > 0 ? `<text x="${x + bred / 2}" y="${(y - 5).toFixed(1)}" text-anchor="middle" fill="${TEKST}" font-size="11" ${SKRIFT}>${xml(s.tal)}</text>` : '',
      `<text x="${x + bred / 2}" y="${top + max + 16}" text-anchor="middle" fill="${TEKST}" font-size="12" ${SKRIFT}>${xml(s.etiket)}</text></g>`,
    ].join('')
  })
  const w = soejler.length * bred
  const h = top + max + 24
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${dele.join('')}</svg>`
}

export const soejlerTekst = (soejler: readonly Soejle[]): string[] => {
  const hoej = Math.max(...soejler.map(s => s.vaerdi), 0)
  return soejler.map(s => `${bjaelke(hoej > 0 ? s.vaerdi / hoej : 0, 10)} ${s.etiket.padEnd(4)} ${s.tal}`)
}

// Stablet bjælke med en forklaring under: hvad en opgave brugte sit forbrug på.
export const fordelingSvg = (dele: readonly Del[]): string => {
  const bred = 600
  let x = 0
  const stykker = dele.map((d, i) => {
    const w = d.andel * bred
    const s = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 1).toFixed(1)}" height="16" fill="${FARVER[i % FARVER.length]}"><title>${xml(`${d.navn}: ${d.tekst}`)}</title></rect>`
    x += w
    return s
  })
  const forklaring = dele.map((d, i) => {
    const y = 34 + i * 20
    return [
      `<rect x="0" y="${y - 10}" width="10" height="10" rx="2" fill="${FARVER[i % FARVER.length]}"/>`,
      `<text x="18" y="${y}" fill="${TEKST}" font-size="12" ${SKRIFT}>${xml(`${d.navn} · ${d.tekst}`)}</text>`,
    ].join('')
  })
  const h = 34 + dele.length * 20
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bred}" height="${h}" viewBox="0 0 ${bred} ${h}">${stykker.join('')}${forklaring.join('')}</svg>`
}

export const fordelingTekst = (dele: readonly Del[]): string[] =>
  dele.map(d => `${bjaelke(d.andel, 10)} ${procent(d.andel).padStart(4)}  ${d.navn} · ${d.tekst}`)
