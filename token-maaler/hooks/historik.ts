import { afkort, bjaelkeLinje, dollar, fmt, pris, procent } from './analyse'

// Tokens som transcriptet gemmer dem for ét modelkald.
export type Brug = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

export type Modelkald = { id: string; t: number; usd: number; tokens: number; hoved: boolean }

export type Besked = { t: number; tekst: string }

// Det, én transcript-fil indeholder af modelkald, beskeder og titel.
export type Samling = { kald: Modelkald[]; beskeder: Besked[]; titel: string }

export type Opgavepost = { tekst: string; usd: number }

export type Dag = {
  nr: number
  dato: string
  usd: number
  tokens: number
  kald: number
  opgaver: number
  subUsd: number
  aktivMin: number
  dyreste: Opgavepost[]
}

export type Historik = {
  titel: string
  dage: Dag[]
  usd: number
  tokens: number
  kald: number
  opgaver: number
  subUsd: number
}

export const nySamling = (): Samling => ({ kald: [], beskeder: [], titel: '' })

// Listepris for ét kald; cache-skrivninger koster 1,25 × input (5 minutter) eller 2 × (1 time).
export const kaldUsd = (model: string, u: Brug): number => {
  const p = pris(model)
  const kort = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const lang = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const skriv = kort + lang > 0 ? kort * 1.25 + lang * 2 : (u.cache_creation_input_tokens ?? 0) * 1.25
  const usd =
    (u.input_tokens ?? 0) * p.ind + skriv * p.ind + (u.cache_read_input_tokens ?? 0) * p.laes + (u.output_tokens ?? 0) * p.ud
  return u.speed === 'fast' ? usd * 2 : usd
}

const tolk = (linje: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(linje)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const IKKE_OPGAVE = ['<command-', '<local-command', 'Caveat:', '[Request interrupted']

// Teksten i en brugerbesked, eller null når linjen ikke er noget, brugeren skrev.
const beskedTekst = (indhold: unknown): string | null => {
  if (Array.isArray(indhold) && indhold.some(b => (b as { type?: unknown } | null)?.type === 'tool_result')) return null
  const dele =
    typeof indhold === 'string'
      ? [indhold]
      : Array.isArray(indhold)
        ? indhold.flatMap(b => {
            const blok = b as { type?: unknown; text?: unknown } | null
            return blok?.type === 'text' && typeof blok.text === 'string' ? [blok.text] : []
          })
        : []
  const tekst = dele
    .map(d => d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean)
    .join(' ')
  // Systemets egne beskeder (fx <task-notification>) starter med et mærke; dem skrev brugeren ikke.
  if (!tekst || IKKE_OPGAVE.some(s => tekst.startsWith(s)) || /^<[a-z][\w-]*>/.test(tekst)) return null
  return tekst
}

export const laesLinje = (s: Samling, linje: string, hoved: boolean): void => {
  if (linje.includes('"type":"assistant"')) {
    const m = tolk(linje)
    const besked = m?.message as { id?: unknown; model?: unknown; usage?: Brug } | undefined
    const t = Date.parse(String(m?.timestamp))
    if (m?.type !== 'assistant' || !besked?.usage || Number.isNaN(t)) return
    const u = besked.usage
    s.kald.push({
      id: typeof besked.id === 'string' ? besked.id : '',
      t,
      usd: kaldUsd(typeof besked.model === 'string' ? besked.model : '', u),
      tokens:
        (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      hoved,
    })
    return
  }
  if (!hoved) return
  if (linje.includes('"type":"user"')) {
    const m = tolk(linje)
    if (m?.type !== 'user' || m.isMeta || m.isCompactSummary) return
    const tekst = beskedTekst((m.message as { content?: unknown } | undefined)?.content)
    const t = Date.parse(String(m.timestamp))
    if (tekst && !Number.isNaN(t)) s.beskeder.push({ t, tekst: afkort(tekst, 60) })
  } else if (linje.includes('"type":"custom-title"')) {
    const m = tolk(linje)
    if (typeof m?.customTitle === 'string') s.titel = m.customTitle
  }
}

const to = (n: number) => String(n).padStart(2, '0')

// Den lokale kalenderdag, så et døgn skifter ved midnat i brugerens egen tidszone.
export const datoNoegle = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${to(d.getMonth() + 1)}-${to(d.getDate())}`
}

const PAUSE = 10 * 60_000

export const byg = (samlinger: readonly Samling[]): Historik => {
  // Hvert kald står på flere linjer i transcriptet (én pr. indholdsblok); tæl det én gang.
  const set = new Set<string>()
  const kald = samlinger
    .flatMap(s => s.kald)
    .filter(k => {
      if (k.id === '') return true
      if (set.has(k.id)) return false
      set.add(k.id)
      return true
    })
    .sort((a, b) => a.t - b.t)
  const beskeder = samlinger.flatMap(s => s.beskeder).sort((a, b) => a.t - b.t)

  // Hver besked er en opgave; et modelkald hører til den seneste besked før det.
  const opgaveUsd = beskeder.map(() => 0)
  let aktuel = -1
  for (const k of kald) {
    while ((beskeder[aktuel + 1]?.t ?? Infinity) <= k.t) aktuel++
    if (aktuel >= 0) opgaveUsd[aktuel] = (opgaveUsd[aktuel] ?? 0) + k.usd
  }

  type Samlet = Dag & { tider: number[]; alle: Opgavepost[] }
  const pr = new Map<string, Samlet>()
  const dagFor = (t: number): Samlet => {
    const dato = datoNoegle(t)
    const fundet = pr.get(dato)
    if (fundet) return fundet
    const ny: Samlet = { nr: 0, dato, usd: 0, tokens: 0, kald: 0, opgaver: 0, subUsd: 0, aktivMin: 0, dyreste: [], tider: [], alle: [] }
    pr.set(dato, ny)
    return ny
  }
  for (const k of kald) {
    const d = dagFor(k.t)
    d.usd += k.usd
    d.tokens += k.tokens
    d.kald += 1
    if (!k.hoved) d.subUsd += k.usd
    d.tider.push(k.t)
  }
  beskeder.forEach((b, i) => {
    const d = dagFor(b.t)
    d.opgaver += 1
    d.alle.push({ tekst: b.tekst, usd: opgaveUsd[i] ?? 0 })
  })

  const dage = [...pr.values()]
    .sort((a, b) => a.dato.localeCompare(b.dato))
    .map((d, i): Dag => {
      // Aktiv tid: tiden mellem kald, hvor pauser over 10 minutter tæller som 10 minutter.
      let aktiv = 0
      d.tider.forEach((t, j) => {
        const forrige = d.tider[j - 1]
        if (forrige !== undefined) aktiv += Math.min(t - forrige, PAUSE)
      })
      const { tider, alle, ...dag } = d
      return { ...dag, nr: i + 1, aktivMin: Math.round(aktiv / 60_000), dyreste: [...alle].sort((a, b) => b.usd - a.usd).slice(0, 5) }
    })

  const samlet = (f: (d: Dag) => number) => dage.reduce((s, d) => s + f(d), 0)
  const titel = samlinger.find(s => s.titel)?.titel ?? ''
  return {
    titel,
    dage,
    usd: samlet(d => d.usd),
    tokens: samlet(d => d.tokens),
    kald: kald.length,
    opgaver: beskeder.length,
    subUsd: samlet(d => d.subUsd),
  }
}

const UGEDAG = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
const MAANED = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

export const datoTekst = (dato: string): string => {
  const [aar = 1970, maaned = 1, dag = 1] = dato.split('-').map(Number)
  const d = new Date(aar, maaned - 1, dag)
  return `${UGEDAG[d.getDay()] ?? ''} ${d.getDate()}. ${MAANED[d.getMonth()] ?? ''}`
}

export const varighed = (min: number): string =>
  min < 1 ? '<1m' : min < 60 ? `${min}m` : min % 60 === 0 ? `${min / 60}t` : `${Math.floor(min / 60)}t ${min % 60}m`

const opgaver = (n: number) => (n === 1 ? '1 opgave' : `${n} opgaver`)

const linje = (visuel: boolean, andel: number, usd: number, tekst: string) =>
  visuel ? bjaelkeLinje(andel, usd, tekst) : `${procent(andel)} · ${dollar(usd)} · ${tekst}`

export const dageTekst = (h: Historik, visuel = true): string[] => {
  const n = h.dage.length
  if (n === 0) return [`${h.titel || 'Denne agent'}: ingen modelkald i historikken endnu.`]
  const vist = h.dage.slice(-31)
  const linjer = [
    h.titel || 'Denne agent',
    `${n === 1 ? '1 aktiv dag' : `${n} aktive dage`} · ${dollar(h.usd)} i alt · ca. ${dollar(h.usd / n)} pr. dag · ${opgaver(h.opgaver)} · ${fmt(h.tokens)} tokens`,
    '',
  ]
  if (n > vist.length) linjer.push(`De seneste ${vist.length} af ${n} dage:`)
  for (const d of vist) {
    linjer.push(
      linje(visuel, h.usd > 0 ? d.usd / h.usd : 0, d.usd, `dag ${d.nr} · ${datoTekst(d.dato)} · ${opgaver(d.opgaver)} · aktiv ca. ${varighed(d.aktivMin)}`),
    )
  }
  const dyreste = [...h.dage].sort((a, b) => b.usd - a.usd)[0]
  if (dyreste) {
    linjer.push('', `Dyreste dag: dag ${dyreste.nr} (${dollar(dyreste.usd)}).${visuel ? ` Skriv /tokens dag ${dyreste.nr} for detaljer.` : ''}`)
  }
  linjer.push('Beløbene er listepris for samtalens og subagenternes modelkald. Kald i baggrunden, fx titler og forslag, er ikke med.')
  return linjer
}

export const dagTekst = (h: Historik, nr: number, visuel = true): string[] => {
  const d = h.dage.find(x => x.nr === nr)
  if (!d) return [`Dag ${nr} findes ikke. ${h.titel || 'Agenten'} har ${h.dage.length} aktive dage.`]
  const linjer = [
    `Dag ${d.nr} · ${datoTekst(d.dato)}${h.titel ? ` · ${h.titel}` : ''}`,
    `${dollar(d.usd)} · ${fmt(d.tokens)} tokens · ${opgaver(d.opgaver)} · ${d.kald} modelkald · aktiv ca. ${varighed(d.aktivMin)}`,
  ]
  if (d.subUsd > 0) {
    const hoved = d.usd - d.subUsd
    linjer.push('', linje(visuel, hoved / d.usd, hoved, 'hovedsamtalen'), linje(visuel, d.subUsd / d.usd, d.subUsd, 'subagenter'))
  }
  linjer.push('')
  if (d.dyreste.length === 0) {
    linjer.push('Ingen nye opgaver denne dag; arbejdet fortsatte fra dagen før.')
    return linjer
  }
  linjer.push('Dyreste opgaver:')
  for (const o of d.dyreste) linjer.push(linje(visuel, d.usd > 0 ? Math.min(1, o.usd / d.usd) : 0, o.usd, `"${o.tekst}"`))
  return linjer
}
