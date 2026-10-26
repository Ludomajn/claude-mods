import type { Graense, Soejle } from '../types'
import { bjaelke } from './analyse'

export type { Graense, Soejle }

// Grafer til panelet og båndet som SVG (desktop, mobil og VS Code) og som tekst (terminalen).
// Farverne er valgt, så de kan læses på både lys og mørk baggrund.

const TEKST = '#8b8b8b'
const SPOR = 'rgba(128,128,128,0.25)'
const CYAN = '#22a6c8'
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

// En færdig tegning med sin størrelse, så den tegnes i præcis den størrelse og ikke skaleres op.
export type Tegning = { source: string; width: number; height: number }

const svg = (w: number, h: number, indhold: string): Tegning => ({
  source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="background:transparent">${indhold}</svg>`,
  width: w,
  height: h,
})

const fyld = (p: number) => (p >= 80 ? '#f85149' : p >= 50 ? '#d29922' : CYAN)

const pct = (p: number) => `${Math.round(p)} %`

// Én bjælke i båndet: titel, procent og den sidste opgaves andel af samme grænse (kun 5-timersgrænsen).
export type Bjaelke = { navn: string; p: number; sidste: number }

export const kortNavn = (g: Graense): string => NAVN[g.kind]?.kort ?? g.kind

// Titlens plads i pixel i skriftstørrelse 12, med lidt luft til bjælken.
const titelBredde = (navn: string) => Math.ceil(navn.length * 5 + 8)

const MELLEM = 24

// Hele båndet som én tegning, lige så bred som `bredde` pixel: bjælker med titler, lige lange, med procenten
// skrevet på hver. Den sidste opgave er et mørkere stykke yderst på den udfyldte del med en streg, hvor
// opgaven begyndte (mørkt, så den hvide procent kan læses). Stykket klippes til bjælkens runde ende.
export const baandSvg = (bjaelker: readonly Bjaelke[], bredde: number): Tegning => {
  const bw = Math.max(40, (bredde - (bjaelker.length - 1) * MELLEM - bjaelker.reduce((n, b) => n + titelBredde(b.navn), 0)) / Math.max(1, bjaelker.length))
  let x = 0
  const dele = bjaelker.map((b, i) => {
    const bx = x + titelBredde(b.navn)
    const tx = x
    x = bx + bw + MELLEM
    const w = Math.max(b.p > 0 ? 4 : 0, (Math.min(100, b.p) / 100) * bw)
    const m = b.sidste > 0 && w > 0 ? Math.min(w, Math.max(3, (Math.min(100, b.sidste) / 100) * bw)) : 0
    const id = `m${i}`
    return [
      `<text x="${tx.toFixed(1)}" y="8" fill="${TEKST}" font-size="9" ${SKRIFT}>${xml(b.navn)}</text>`,
      // Et mørkere spor end i panelet, så den hvide procent kan læses på lys og mørk baggrund.
      `<rect x="${bx.toFixed(1)}" y="2.5" width="${bw.toFixed(1)}" height="5" rx="2.5" fill="rgba(110,110,110,0.55)"/>`,
      `<rect x="${bx.toFixed(1)}" y="2.5" width="${w.toFixed(1)}" height="5" rx="2.5" fill="${fyld(b.p)}"/>`,
      m > 0
        ? `<clipPath id="${id}"><rect x="${bx.toFixed(1)}" y="2.5" width="${w.toFixed(1)}" height="5" rx="2.5"/></clipPath><g clip-path="url(#${id})"><rect x="${(bx + w - m).toFixed(1)}" y="2.5" width="${m.toFixed(1)}" height="5" fill="#000000" fill-opacity="0.25"/><rect x="${(bx + w - m - 0.5).toFixed(1)}" y="2.5" width="1" height="5" fill="#000000" fill-opacity="0.55"/></g>`
        : '',
    ].join('')
  })
  return svg(Math.ceil(x - MELLEM), 10, dele.join(''))
}

// Hvad båndet siger til en læser, der ikke kan se det.
export const baandAlt = (bjaelker: readonly Bjaelke[]): string =>
  bjaelker.map(b => `${b.navn} ${pct(b.p)}${b.sidste > 0 ? `, sidste opgave ${pct(b.sidste)}` : ''}`).join('; ')

// Båndet som tegn, til terminalen: bjælkerne lige lange over `kolonner` tegn. Den sidste opgave er ▓.
export const baandTekst = (bjaelker: readonly Bjaelke[], kolonner: number): string => {
  const mellem = 3
  const fast = bjaelker.reduce((n, b) => n + b.navn.length + 2 + 5, 0) + (bjaelker.length - 1) * mellem
  const celler = Math.max(4, Math.min(60, Math.floor((kolonner - fast) / Math.max(1, bjaelker.length))))
  return bjaelker
    .map(b => {
      const fyldt = b.p > 0 ? Math.min(celler, Math.max(1, Math.round((Math.min(100, b.p) / 100) * celler))) : 0
      const m = b.sidste > 0 ? Math.min(fyldt, Math.max(1, Math.round((Math.min(100, b.sidste) / 100) * celler))) : 0
      return `${b.navn} ${'█'.repeat(fyldt - m)}${'▓'.repeat(m)}${'░'.repeat(celler - fyldt)} ${pct(b.p).padStart(5)}`
    })
    .join(' '.repeat(mellem))
}

// Målerne til panelet: én række pr. grænse med hvornår den nulstilles.
export const maalerSvgStor = (graenser: readonly Graense[], nu: number): Tegning => {
  const vist = vistGraenser(graenser)
  const rader = vist.map((g, i) => {
    const y = i * 30
    const p = brugt(g, nu)
    const w = Math.max(p > 0 ? 3 : 0, Math.min(100, p) * 2.6)
    const n = nulstilles(g, nu)
    return [
      `<text x="0" y="${y + 16}" fill="${TEKST}" font-size="13" ${SKRIFT}>${xml(NAVN[g.kind]?.lang ?? g.kind)}</text>`,
      `<rect x="130" y="${y + 5}" width="260" height="14" rx="7" fill="${SPOR}"/>`,
      `<rect x="130" y="${y + 5}" width="${w.toFixed(1)}" height="14" rx="7" fill="${fyld(p)}"/>`,
      `<text x="402" y="${y + 16}" fill="${TEKST}" font-size="13" ${SKRIFT}>${xml(`${pct(p)}${n ? ` · nulstilles ${n}` : ''}`)}</text>`,
    ].join('')
  })
  const h = Math.max(1, vist.length) * 30
  return svg(700, h, rader.join(''))
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
export const soejlerSvg = (soejler: readonly Soejle[]): Tegning => {
  const hoej = Math.max(...soejler.map(s => s.vaerdi), 0)
  const bred = 70
  const top = 20
  const max = 100
  const dele = soejler.map((s, i) => {
    const x = i * bred
    const h = hoej > 0 ? Math.max(s.vaerdi > 0 ? 2 : 0, (s.vaerdi / hoej) * max) : 0
    const y = top + max - h
    return [
      `<rect x="${x + 10}" y="${y.toFixed(1)}" width="${bred - 20}" height="${h.toFixed(1)}" rx="3" fill="${CYAN}"/>`,
      s.vaerdi > 0 ? `<text x="${x + bred / 2}" y="${(y - 5).toFixed(1)}" text-anchor="middle" fill="${TEKST}" font-size="11" ${SKRIFT}>${xml(s.tal)}</text>` : '',
      `<text x="${x + bred / 2}" y="${top + max + 16}" text-anchor="middle" fill="${TEKST}" font-size="12" ${SKRIFT}>${xml(s.etiket)}</text>`,
    ].join('')
  })
  const w = soejler.length * bred
  const h = top + max + 24
  return svg(w, h, dele.join(''))
}

export const soejlerTekst = (soejler: readonly Soejle[]): string[] => {
  const hoej = Math.max(...soejler.map(s => s.vaerdi), 0)
  return soejler.map(s => `${bjaelke(hoej > 0 ? s.vaerdi / hoej : 0, 10)} ${s.etiket.padEnd(4)} ${s.tal}`)
}
