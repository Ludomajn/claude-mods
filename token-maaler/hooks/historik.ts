import type { Opgave } from '../types'
import { afkort, analyser, bjaelke, bjaelkeLinje, detaljer, dollar, etiket, fmt, pris, procent } from './analyse'
import type { Agent, Raadata, Trin } from './analyse'

// Tokens som transcriptet gemmer dem for ét modelkald.
export type Brug = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

// Ét modelkald. Transcriptet skriver det på én linje pr. indholdsblok; linjerne lægges sammen her.
export type Svar = {
  id: string
  t: number
  model: string
  brug: Brug
  effort: string
  tekstTegn: number
  tekst: string
  vaerktoejer: { id: string; etiket: string; tegn: number }[]
}

export type Besked = { t: number; tekst: string; fuld: string }

// Hvem en transcript-fil tilhører: hovedsamtalen (id '') eller en subagent.
export type Kilde = Agent & { id: string }

export type Samling = {
  kilde: Kilde
  // Sessionens eget id; linjer fra en anden session (en kopi, fx en forgrening) tælles ikke med igen.
  session: string
  svar: Map<string, Svar>
  resultater: Map<string, number>
  // Værktøjskald, der fejlede, med fejlens slags.
  fejl: Map<string, Fejlslags>
  // Antal billeder i et værktøjsresultat, fx skærmbilleder.
  billeder: Map<string, number>
  beskeder: Besked[]
  afbrud: number[]
  titel: string
  // Gange forbrugsgrænsen afviste et kald, og om filen sluttede med en afvisning.
  graense: number
  stoppet: boolean
}

export type Fejlslags = 'afvist' | 'tilladelse' | 'kommando' | 'timeout' | 'findes ikke' | 'andet'

export type Dagsopgave = { nr: number; tekst: string; usd: number }

export type Dag = {
  nr: number
  dato: string
  usd: number
  tokens: number
  kald: number
  opgaver: number
  subUsd: number
  aktivMin: number
  dyreste: Dagsopgave[]
}

// En opgave fra transcriptet: det, brugeren skrev, og det, der skal til for at beskrive arbejdet.
export type HistOpgave = {
  nr: number
  t: number
  dato: string
  dagNr: number
  tekst: string
  fuld: string
  usd: number
  tokens: number
  kald: number
  handlinger: string[]
  svar: string
  forrigeSvar: string
  raa: Raadata
}

export type Projekt = {
  id: string
  titel: string
  dage: Dag[]
  opgaver: HistOpgave[]
  usd: number
  tokens: number
  kald: number
  subUsd: number
  // Gange forbrugsgrænsen blev ramt, og de subagenter, der stoppede midt i arbejdet af den grund.
  graense: number
  stoppet: { antal: number; usd: number }
}

const HOVED: Kilde = { id: '', beskrivelse: '', type: '' }

export const nySamling = (kilde: Kilde = HOVED, session = ''): Samling => ({
  kilde,
  session,
  svar: new Map(),
  resultater: new Map(),
  fejl: new Map(),
  billeder: new Map(),
  beskeder: [],
  afbrud: [],
  titel: '',
  graense: 0,
  stoppet: false,
})

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

const laengde = (vaerdi: unknown) => {
  try {
    return JSON.stringify(vaerdi)?.length ?? 0
  } catch {
    return 0
  }
}

type Blok = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown }

const blokke = (indhold: unknown): Blok[] =>
  Array.isArray(indhold) ? indhold.filter((b): b is Blok => b !== null && typeof b === 'object') : []

// Teksten i en brugerbesked uden systemets påmindelser.
const brugerTekst = (indhold: unknown): string =>
  (typeof indhold === 'string' ? [indhold] : blokke(indhold).flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])))
    .map(d => d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean)
    .join(' ')

const IKKE_OPGAVE = ['<command-', '<local-command', 'Caveat:']

// Systemets egne beskeder (fx <task-notification>) starter med et mærke, og en ukendt kommando (fx /tokens1)
// står alene; ingen af dem er en opgave.
const erOpgave = (tekst: string) =>
  tekst !== '' && !IKKE_OPGAVE.some(s => tekst.startsWith(s)) && !/^<[a-z][\w-]*>/.test(tekst) && !/^\/[a-z][\w:-]*$/i.test(tekst)

// Så meget tekst gemmes fra hver besked og hvert svar til at beskrive opgaven med.
const TEKST = 1_500

// Et billede i et værktøjsresultat fylder omtrent som 1.400 tokens tekst.
const BILLEDE = 5_000

const billederI = (indhold: unknown): number => blokke(indhold).filter(b => b.type === 'image').length

const tekstAf = (indhold: unknown): string =>
  typeof indhold === 'string' ? indhold : blokke(indhold).flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join(' ')

// Hvorfor et værktøjskald fejlede, ud fra fejlteksten.
export const fejlslags = (tekst: string): Fejlslags =>
  /user (doesn't want|rejected|denied)|the user (doesn't|did not|declined)/i.test(tekst)
    ? 'afvist'
    : /permission|not permitted|sandbox|denied/i.test(tekst)
      ? 'tilladelse'
      : /timed? ?out/i.test(tekst)
        ? 'timeout'
        : /exit code/i.test(tekst)
          ? 'kommando'
          : /does not exist|no such file|not found/i.test(tekst)
            ? 'findes ikke'
            : 'andet'

const tegnAf = (indhold: unknown): number =>
  typeof indhold === 'string'
    ? indhold.length
    : blokke(indhold).reduce((sum, b) => sum + (b.type === 'text' && typeof b.text === 'string' ? b.text.length : b.type === 'image' ? BILLEDE : 0), 0)

// En linje kopieret fra en anden session, fx da samtalen blev forgrenet; den er talt med dér.
const fremmed = (s: Samling, m: Record<string, unknown>) =>
  s.session !== '' && s.kilde.id === '' && typeof m.sessionId === 'string' && m.sessionId !== s.session

export const laesLinje = (s: Samling, linje: string): void => {
  if (linje.includes('"type":"assistant"')) {
    const m = tolk(linje)
    if (m?.type !== 'assistant' || fremmed(s, m)) return
    s.stoppet = m.error === 'rate_limit'
    if (s.stoppet) s.graense += 1
    const besked = m.message as { id?: unknown; model?: unknown; usage?: Brug; content?: unknown } | undefined
    const t = Date.parse(String(m.timestamp))
    if (!besked?.usage || Number.isNaN(t)) return
    const id = typeof besked.id === 'string' ? besked.id : `uden-id-${t}-${s.svar.size}`
    let svar = s.svar.get(id)
    if (!svar) {
      const effort = typeof m.effort === 'string' ? m.effort : ''
      svar = { id, t, model: typeof besked.model === 'string' ? besked.model : '', brug: besked.usage, effort, tekstTegn: 0, tekst: '', vaerktoejer: [] }
      s.svar.set(id, svar)
    } else if ((besked.usage.output_tokens ?? 0) > (svar.brug.output_tokens ?? 0)) {
      // Et kald skrives på flere linjer, mens det strømmer; den sidste har det endelige output.
      svar.brug = besked.usage
    }
    for (const b of blokke(besked.content)) {
      if (b.type === 'text' && typeof b.text === 'string') {
        svar.tekstTegn += b.text.length
        if (svar.tekst.length < TEKST) svar.tekst = `${svar.tekst}${svar.tekst ? '\n' : ''}${b.text}`.slice(0, TEKST)
      }
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
      const vid = typeof b.id === 'string' ? b.id : ''
      if (vid === '' || !svar.vaerktoejer.some(v => v.id === vid)) {
        svar.vaerktoejer.push({ id: vid, etiket: etiket(b.name, b.input), tegn: laengde(b.input) })
      }
    }
    return
  }
  if (s.kilde.id !== '') return
  if (linje.includes('"type":"user"')) {
    const m = tolk(linje)
    const t = Date.parse(String(m?.timestamp))
    if (m?.type !== 'user' || Number.isNaN(t) || m.isCompactSummary || fremmed(s, m)) return
    const indhold = (m.message as { content?: unknown } | undefined)?.content
    const resultater = blokke(indhold).filter(b => b.type === 'tool_result')
    for (const b of resultater) {
      if (typeof b.tool_use_id !== 'string') continue
      s.resultater.set(b.tool_use_id, tegnAf(b.content))
      const billeder = billederI(b.content)
      if (billeder > 0) s.billeder.set(b.tool_use_id, billeder)
      if ((b as { is_error?: unknown }).is_error === true) s.fejl.set(b.tool_use_id, fejlslags(tekstAf(b.content)))
    }
    if (resultater.length || m.isMeta) return
    const tekst = brugerTekst(indhold)
    if (tekst.startsWith('[Request interrupted')) s.afbrud.push(t)
    else if (erOpgave(tekst)) s.beskeder.push({ t, tekst: afkort(tekst, 60), fuld: tekst.slice(0, TEKST) })
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

const promptAf = (b: Brug) => (b.input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0)

type Kaldpost = { svar: Svar; kilde: Kilde; usd: number; tokens: number }

const tilTrin = (svar: Svar, loop: string, index: number): Trin => ({
  loop,
  index,
  model: svar.model,
  effort: svar.effort,
  input: svar.brug.input_tokens ?? 0,
  output: svar.brug.output_tokens ?? 0,
  cacheLaes: svar.brug.cache_read_input_tokens ?? 0,
  cacheSkriv: svar.brug.cache_creation_input_tokens ?? 0,
  svarTegn: svar.tekstTegn,
  vaerktoejsInput: svar.vaerktoejer.map(v => ({ etiket: v.etiket, tegn: v.tegn })),
})

// Prisen på en cache-skrivning i forhold til input, vægtet efter levetiden på det, der blev skrevet.
const ttlAf = (kald: readonly Kaldpost[]): number => {
  let kort = 0
  let lang = 0
  for (const k of kald) {
    kort += k.svar.brug.cache_creation?.ephemeral_5m_input_tokens ?? 0
    lang += k.svar.brug.cache_creation?.ephemeral_1h_input_tokens ?? 0
  }
  return kort + lang > 0 ? (kort * 1.25 + lang * 2) / (kort + lang) : 1.25
}

// Subagenternes kald, nummereret pr. subagent i den rækkefølge, de kom.
const subTrin = (kald: readonly Kaldpost[]): Trin[] => {
  const taeller = new Map<string, number>()
  return kald
    .filter(k => k.kilde.id !== '')
    .map(k => {
      const i = taeller.get(k.kilde.id) ?? 0
      taeller.set(k.kilde.id, i + 1)
      return tilTrin(k.svar, k.kilde.id, i)
    })
}

const PAUSE = 10 * 60_000

export const projekt = (samlinger: readonly Samling[]): Projekt => {
  const set = new Set<string>()
  const kald: Kaldpost[] = []
  for (const s of samlinger) {
    for (const svar of s.svar.values()) {
      if (set.has(svar.id)) continue
      set.add(svar.id)
      kald.push({ svar, kilde: s.kilde, usd: kaldUsd(svar.model, svar.brug), tokens: promptAf(svar.brug) + (svar.brug.output_tokens ?? 0) })
    }
  }
  kald.sort((a, b) => a.svar.t - b.svar.t)
  const beskeder = samlinger.flatMap(s => s.beskeder).sort((a, b) => a.t - b.t)
  const afbrud = samlinger.flatMap(s => s.afbrud)
  const resultater = new Map(samlinger.flatMap(s => [...s.resultater]))
  const fejl = new Map(samlinger.flatMap(s => [...s.fejl]))
  const billeder = new Map(samlinger.flatMap(s => [...s.billeder]))

  // Hver besked er en opgave; et kald hører til den seneste besked før det.
  const prOpgave: Kaldpost[][] = beskeder.map(() => [])
  let aktuel = -1
  for (const k of kald) {
    while ((beskeder[aktuel + 1]?.t ?? Infinity) <= k.svar.t) aktuel++
    prOpgave[aktuel]?.push(k)
  }

  const opgaver: HistOpgave[] = []
  let forrigePrompt: number | null = null
  let forrigeSvar = ''
  beskeder.forEach((b, i) => {
    const egne = prOpgave[i] ?? []
    const hoved = egne.filter(k => k.kilde.id === '')
    const naeste = beskeder[i + 1]?.t ?? Infinity
    const usd = egne.reduce((sum, k) => sum + k.usd, 0)
    const raa: Raadata = {
      nr: i + 1,
      start: b.t,
      prompt: b.tekst,
      afbrudt: afbrud.some(t => t >= b.t && t < naeste),
      sekunder: Math.round(((egne.at(-1)?.svar.t ?? b.t) - b.t) / 1000),
      usd,
      ttl: ttlAf(hoved),
      forrigePrompt,
      trin: [...hoved.map((k, j) => tilTrin(k.svar, '', j)), ...subTrin(egne)],
      kald: hoved.flatMap((k, j) =>
        k.svar.vaerktoejer.map(v => ({
          loop: '',
          trin: j,
          etiket: v.etiket,
          tegn: resultater.get(v.id) ?? 0,
          ...(fejl.has(v.id) ? { fejl: fejl.get(v.id) } : {}),
          ...(billeder.has(v.id) ? { billeder: billeder.get(v.id) } : {}),
        })),
      ),
      agenter: Object.fromEntries(egne.filter(k => k.kilde.id !== '').map(k => [k.kilde.id, { beskrivelse: k.kilde.beskrivelse, type: k.kilde.type }])),
      kontekst: [],
    }
    const sidste = hoved.at(-1)
    if (sidste) forrigePrompt = promptAf(sidste.svar.brug)
    const svar = [...hoved].reverse().find(k => k.svar.tekst !== '')?.svar.tekst ?? ''
    // Det, der ændrede noget (filer, der blev skrevet), står først; så resten i den rækkefølge, det skete.
    const alle = [...new Set([...hoved.flatMap(k => k.svar.vaerktoejer.map(v => v.etiket)), ...Object.values(raa.agenter).map(a => `Subagent: ${a.beskrivelse || a.type}`)])]
    const skriver = (e: string) => /^(Write|Edit|MultiEdit|NotebookEdit) /.test(e)
    const handlinger = [...alle.filter(skriver), ...alle.filter(e => !skriver(e))].slice(0, 15)
    opgaver.push({
      nr: i + 1,
      t: b.t,
      dato: datoNoegle(b.t),
      dagNr: 0,
      tekst: b.tekst,
      fuld: b.fuld,
      usd,
      tokens: egne.reduce((sum, k) => sum + k.tokens, 0),
      kald: egne.length,
      handlinger,
      svar,
      forrigeSvar,
      raa,
    })
    if (svar) forrigeSvar = svar
  })

  type Samlet = Omit<Dag, 'nr' | 'aktivMin' | 'dyreste'> & { tider: number[]; alle: Dagsopgave[] }
  const pr = new Map<string, Samlet>()
  const dagFor = (t: number): Samlet => {
    const dato = datoNoegle(t)
    const fundet = pr.get(dato)
    if (fundet) return fundet
    const ny: Samlet = { dato, usd: 0, tokens: 0, kald: 0, opgaver: 0, subUsd: 0, tider: [], alle: [] }
    pr.set(dato, ny)
    return ny
  }
  for (const k of kald) {
    const d = dagFor(k.svar.t)
    d.usd += k.usd
    d.tokens += k.tokens
    d.kald += 1
    if (k.kilde.id !== '') d.subUsd += k.usd
    d.tider.push(k.svar.t)
  }
  for (const o of opgaver) {
    const d = dagFor(o.t)
    d.opgaver += 1
    d.alle.push({ nr: o.nr, tekst: o.tekst, usd: o.usd })
  }
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
  const dagNr = new Map(dage.map(d => [d.dato, d.nr]))
  for (const o of opgaver) o.dagNr = dagNr.get(o.dato) ?? 0

  const samlet = (f: (d: Dag) => number) => dage.reduce((s, d) => s + f(d), 0)
  const stoppede = new Set(samlinger.filter(s => s.kilde.id !== '' && s.stoppet).map(s => s.kilde.id))
  return {
    id: '',
    titel: samlinger.find(s => s.titel)?.titel ?? '',
    dage,
    opgaver,
    usd: samlet(d => d.usd),
    tokens: samlet(d => d.tokens),
    kald: kald.length,
    subUsd: samlet(d => d.subUsd),
    graense: samlinger.reduce((n, s) => n + s.graense, 0),
    stoppet: { antal: stoppede.size, usd: kald.filter(k => stoppede.has(k.kilde.id)).reduce((n, k) => n + k.usd, 0) },
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

const opgaverTekst = (n: number) => (n === 1 ? '1 opgave' : `${n} opgaver`)

const dageTal = (n: number) => (n === 1 ? '1 aktiv dag' : `${n} aktive dage`)

const linje = (visuel: boolean, andel: number, usd: number, tekst: string) =>
  visuel ? bjaelkeLinje(andel, usd, tekst) : `${procent(andel)} · ${dollar(usd)} · ${tekst}`

const navn = (p: Projekt) => p.titel || 'Dette projekt'

// Beskrivelser af, hvad Claude udførte, nøglet på opgavenummer; uden en beskrivelse vises brugerens besked.
export type Beskrivelser = ReadonlyMap<number, string>

const opgaveNavn = (o: { nr: number; tekst: string }, b: Beskrivelser) => b.get(o.nr) ?? `"${o.tekst}"`

// Som "16% ($13.39) - Dag 1 - Udførte fase 1 (…) - opgave 5", med bjælken først.
const opgaveLinje = (visuel: boolean, andel: number, usd: number, dag: number | null, navn: string, nr: number) =>
  `${visuel ? `${bjaelke(andel)} ` : ''}${procent(andel)} (${dollar(usd)}) - ${dag !== null ? `Dag ${dag} - ` : ''}${navn} - opgave ${nr}`

const plus = (antal: number, usd: number, andel: number, hvad: string) => `Plus ${antal} mindre ${hvad}: ${dollar(usd)} (${procent(andel)}).`

// De opgaver, projektoversigten viser: de 10 dyreste, der kostede noget.
export const visteOpgaver = (p: Projekt): HistOpgave[] => p.opgaver.filter(o => o.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 10)

// Modellens svar gjort til én linje uden anførselstegn.
export const renBeskrivelse = (tekst: string): string =>
  afkort((tekst.trim().split('\n')[0] ?? '').replace(/^["'«»]+|["'«»]+$/g, '').trim(), 110)

// Det, en sprogmodel får at vide for at beskrive én opgave med én sætning.
export const beskrivelsesPrompt = (o: HistOpgave): string =>
  [
    'Beskriv i én kort sætning på dansk (højst 10 ord og 80 tegn), hvad assistenten fik lavet i opgaven nedenfor.',
    'Start med et verbum i datid, fx "Byggede", "Rettede", "Udførte" eller "Undersøgte". En kort detalje må stå i parentes.',
    'Eksempel: Udførte fase 1 (opbygning af CMS og implementering af system)',
    'Beskriv resultatet, ikke brugerens besked; læn dig mest op ad assistentens svar til sidst. Svar kun med sætningen.',
    '',
    'Brugerens besked:',
    o.fuld,
    ...(o.forrigeSvar ? ['', 'Assistentens forrige svar, som beskeden kan henvise til:', o.forrigeSvar.slice(0, 800)] : []),
    ...(o.handlinger.length ? ['', 'Det, assistenten gjorde:', ...o.handlinger.map(h => `- ${h}`)] : []),
    ...(o.svar ? ['', 'Assistentens svar til sidst:', o.svar] : []),
  ].join('\n')

const FODNOTE = 'Beløbene er listepris for samtalens og subagenternes modelkald. Kald i baggrunden, fx titler og forslag, er ikke med.'

export const projektTekst = (p: Projekt, visuel = true, b: Beskrivelser = new Map(), raadLinje = ''): string[] => {
  if (p.kald === 0) return [`${navn(p)}: ingen modelkald i historikken endnu.`]
  const sorteret = p.opgaver.filter(o => o.usd > 0).sort((a, b) => b.usd - a.usd)
  const resten = sorteret.slice(10)
  const linjer = [
    `${navn(p)} · hele projektet`,
    `${fmt(p.tokens)} tokens · ${dollar(p.usd)} · ${opgaverTekst(p.opgaver.length)} · ${dageTal(p.dage.length)}`,
  ]
  if (sorteret.length) linjer.push('', 'Dyreste opgaver:')
  for (const o of sorteret.slice(0, 10)) {
    linjer.push(opgaveLinje(visuel, p.usd > 0 ? o.usd / p.usd : 0, o.usd, o.dagNr, opgaveNavn(o, b), o.nr))
  }
  if (resten.length) {
    const usd = resten.reduce((s, o) => s + o.usd, 0)
    linjer.push(plus(resten.length, usd, p.usd > 0 ? usd / p.usd : 0, 'opgaver'))
  }
  if (raadLinje) linjer.push('', raadLinje)
  const seneste = p.opgaver.at(-1)
  if (visuel) {
    linjer.push('', `Skriv /tokens <nr> for en opgave${seneste ? ` (den seneste er ${seneste.nr})` : ''} og /tokens dage for dagene.`)
  }
  linjer.push(FODNOTE)
  return linjer
}

export const opgaveTekst = (
  p: Projekt,
  nr: number,
  visuel = true,
  ekstra: Partial<Pick<Opgave, 'kontekst'>> = {},
  b: Beskrivelser = new Map(),
): string[] => {
  const o = p.opgaver.find(x => x.nr === nr)
  if (!o) return [`Opgave ${nr} findes ikke. ${navn(p)} har ${opgaverTekst(p.opgaver.length)}.`]
  const linjer = detaljer({ ...analyser(o.raa), ...ekstra }, `dag ${o.dagNr} · ${datoTekst(o.dato)}`, visuel, b.get(o.nr))
  if (visuel) linjer.push('', 'Skriv /tokens for hele projektet.')
  return linjer
}

export const dageTekst = (p: Projekt, visuel = true): string[] => {
  const n = p.dage.length
  if (n === 0) return [`${navn(p)}: ingen modelkald i historikken endnu.`]
  const vist = p.dage.slice(-31)
  const linjer = [
    navn(p),
    `${dageTal(n)} · ${dollar(p.usd)} i alt · ca. ${dollar(p.usd / n)} pr. dag · ${opgaverTekst(p.opgaver.length)} · ${fmt(p.tokens)} tokens`,
    '',
  ]
  if (n > vist.length) linjer.push(`De seneste ${vist.length} af ${n} dage:`)
  for (const d of vist) {
    linjer.push(
      linje(visuel, p.usd > 0 ? d.usd / p.usd : 0, d.usd, `dag ${d.nr} · ${datoTekst(d.dato)} · ${opgaverTekst(d.opgaver)} · aktiv ca. ${varighed(d.aktivMin)}`),
    )
  }
  const dyreste = [...p.dage].sort((a, b) => b.usd - a.usd)[0]
  if (dyreste) {
    linjer.push('', `Dyreste dag: dag ${dyreste.nr} (${dollar(dyreste.usd)}).${visuel ? ` Skriv /tokens dag ${dyreste.nr} for detaljer.` : ''}`)
  }
  linjer.push(FODNOTE)
  return linjer
}

export const dagTekst = (p: Projekt, nr: number, visuel = true, b: Beskrivelser = new Map()): string[] => {
  const d = p.dage.find(x => x.nr === nr)
  if (!d) return [`Dag ${nr} findes ikke. ${navn(p)} har ${dageTal(p.dage.length)}.`]
  const linjer = [
    `Dag ${d.nr} · ${datoTekst(d.dato)} · ${navn(p)}`,
    `${dollar(d.usd)} · ${fmt(d.tokens)} tokens · ${opgaverTekst(d.opgaver)} · ${d.kald} modelkald · aktiv ca. ${varighed(d.aktivMin)}`,
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
  for (const o of d.dyreste) linjer.push(opgaveLinje(visuel, d.usd > 0 ? Math.min(1, o.usd / d.usd) : 0, o.usd, null, opgaveNavn(o, b), o.nr))
  if (visuel) linjer.push('', 'Skriv /tokens <nr> for en opgave.')
  return linjer
}
