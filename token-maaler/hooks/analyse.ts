import type { KontekstDel, Opgave, Post, PostType } from '../types'

// Ét modelkald i opgaven, som API'et talte det.
export type Trin = {
  loop: string // '' er hovedsamtalen, ellers subagentens id
  index: number
  model: string
  input: number
  output: number
  cacheLaes: number
  cacheSkriv: number
  svarTegn: number
  vaerktoejsInput: { etiket: string; tegn: number }[]
}

// Ét værktøjskald og længden af det resultat, modellen fik tilbage.
export type Kald = { loop: string; trin: number; etiket: string; tegn: number }

export type Agent = { beskrivelse: string; type: string }

export type Raadata = {
  nr: number
  start: number
  prompt: string
  afbrudt: boolean
  sekunder: number
  usd: number | null
  ttl: number // cache-skrivning: 2 × input ved 1 times cache, 1,25 × ved 5 minutter
  forrigePrompt: number | null
  trin: Trin[]
  kald: Kald[]
  agenter: Record<string, Agent>
  kontekst: KontekstDel[]
}

// Listepris i $ pr. million tokens: input, output, cache-læsning. Mest specifikke navn først.
const PRISER: [string, number, number, number][] = [
  ['fable-5-1', 10, 50, 0.25],
  ['mythos-5-1', 10, 50, 0.25],
  ['fable-5', 10, 50, 1],
  ['mythos-5', 10, 50, 1],
  ['opus-5-5', 4, 20, 0.2],
  ['opus-5', 5, 25, 0.5],
  ['opus-4-8', 5, 25, 0.5],
  ['opus-4-7', 5, 25, 0.5],
  ['opus-4-6', 5, 25, 0.5],
  ['opus-4-5', 5, 25, 0.5],
  ['opus-4', 15, 75, 1.5],
  ['sonnet-5', 2, 10, 0.2],
  ['sonnet', 3, 15, 0.3],
  ['haiku-4-5', 1, 5, 0.1],
  ['haiku', 0.8, 4, 0.08],
]
const STANDARD: [string, number, number, number] = ['opus-5-5', 4, 20, 0.2]

export type Pris = { ind: number; ud: number; laes: number }

export const pris = (model: string): Pris => {
  const m = model.toLowerCase()
  const [, ind, ud, laes] = PRISER.find(([navn]) => m.includes(navn)) ?? STANDARD
  return { ind: ind / 1e6, ud: ud / 1e6, laes: laes / 1e6 }
}

export const anslaa = (tegn: number): number => Math.round(tegn / 3.5)

const promptAf = (t: Trin) => t.input + t.cacheLaes + t.cacheSkriv

const trinUsd = (t: Trin, ttl: number) => {
  const p = pris(t.model)
  return t.input * p.ind + t.cacheSkriv * p.ind * ttl + t.cacheLaes * p.laes + t.output * p.ud
}

export const afkort = (tekst: string, n: number): string => {
  const t = tekst.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const filnavn = (sti: string) => sti.split('/').filter(Boolean).pop() ?? sti

export const etiket = (navn: string, input: unknown): string => {
  const i = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (noegle: string) => (typeof i[noegle] === 'string' ? (i[noegle] as string) : '')
  switch (navn) {
    case 'Read': {
      const fra = typeof i.offset === 'number' ? i.offset : null
      const antal = typeof i.limit === 'number' ? i.limit : null
      const udsnit = fra !== null || antal !== null ? ` (linje ${fra ?? 1}${antal !== null ? `–${(fra ?? 1) + antal}` : '+'})` : ''
      return `Read ${filnavn(s('file_path'))}${udsnit}`
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `${navn} ${filnavn(s('file_path'))}`
    case 'NotebookEdit':
      return `NotebookEdit ${filnavn(s('notebook_path'))}`
    case 'Bash':
      return `Bash: ${afkort(s('description') || s('command'), 48)}`
    case 'Grep':
      return `Grep "${afkort(s('pattern'), 30)}"`
    case 'Glob':
      return `Glob ${afkort(s('pattern'), 30)}`
    case 'WebFetch':
      return `WebFetch ${afkort(s('url'), 40)}`
    case 'WebSearch':
      return `WebSearch "${afkort(s('query'), 36)}"`
    case 'Agent':
    case 'Task':
      return `Agent: ${afkort(s('description') || s('subagent_type'), 40)}`
    case 'Skill':
      return `Skill ${s('skill')}`
    case 'ToolSearch':
      return `ToolSearch ${afkort(s('query'), 36)}`
  }
  if (navn.startsWith('mcp__')) {
    const [, server = '', ...rest] = navn.split('__')
    const vaerktoej = rest.join('__')
    const kortServer = /^[0-9a-f]{8}-/.test(server) ? '' : server.replace(/^plugin_[^_]+_/, '')
    return kortServer ? `${kortServer}: ${vaerktoej}` : vaerktoej
  }
  return navn
}

const KONTEKST: Record<string, string> = {
  'System prompt': 'Systemprompt',
  'System tools': 'Værktøjer',
  'MCP tools': 'MCP-værktøjer',
  'Custom agents': 'Agenter',
  'Memory files': 'Memory',
  Skills: 'Skills',
  Messages: 'Beskeder',
  'Slash commands': 'Kommandoer',
}

export const kontekstDele = (kategorier: readonly { name: string; tokens: number; kind: string }[]): KontekstDel[] =>
  kategorier
    .filter(k => k.kind === 'used' && k.tokens > 0)
    .map(k => ({ navn: KONTEKST[k.name] ?? k.name, tokens: k.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)

export const fmt = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e5
      ? `${Math.round(n / 1e3)}k`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(Math.round(n))

export const dollar = (usd: number): string => `$${usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(3)}`

export const procent = (andel: number): string => (andel < 0.005 ? '<1%' : `${Math.round(andel * 100)}%`)

export const tid = (sekunder: number): string =>
  sekunder < 60 ? `${sekunder}s` : `${Math.floor(sekunder / 60)}m ${sekunder % 60}s`

// En bjælke som i /usage: andelen fyldt ud af `bredde` felter; alt over 0 får mindst ét felt.
export const bjaelke = (andel: number, bredde = 20): string => {
  const fyldt = andel > 0 ? Math.min(bredde, Math.max(1, Math.round(andel * bredde))) : 0
  return '█'.repeat(fyldt) + '░'.repeat(bredde - fyldt)
}

// Bjælke, procent, beløb og tekst på én linje; bjælken først, så den står lige uanset skrifttype.
export const bjaelkeLinje = (andel: number, usd: number | null, tekst: string): string =>
  `${bjaelke(andel)} ${procent(andel).padStart(4)}  ${usd !== null ? `${dollar(usd).padEnd(7)} ` : ''}${tekst}`

const runder = (n: number) => (n === 1 ? '1 runde' : `${n} runder`)

type Del = { type: PostType; navn: string; tokens: number; gange: number; usd: number; antal: number }

const hvorfor = (p: Post | undefined, antalRunder: number): { forklaring: string; tip: string } => {
  if (!p) return { forklaring: 'Ingen modelkald blev registreret.', tip: '' }
  switch (p.type) {
    case 'start':
      return {
        forklaring: `Samtalen var allerede ${fmt(p.tokens)} tokens lang, og opgaven tog ${runder(antalRunder)}. Hver runde læser hele samtalen igen.`,
        tip: 'Tip: /compact eller en ny session gør hver runde billigere.',
      }
    case 'cache':
      return {
        forklaring: `Cachen var udløbet (ny session eller pause), så ${fmt(p.tokens)} tokens samtale skulle skrives igen.`,
        tip: 'Tip: Efter en lang pause er en ny session billigere end at fortsætte en lang samtale.',
      }
    case 'vaerktoej':
      return {
        forklaring:
          p.gange > 0
            ? `${p.navn} gav ${fmt(p.tokens)} tokens, som blev læst igen i ${runder(p.gange)}.`
            : `${p.navn} gav ${fmt(p.tokens)} tokens.`,
        tip: 'Tip: Store værktøjsresultater bliver i samtalen. Bed om et udsnit i stedet for hele filer eller lange output.',
      }
    case 'taenkning':
      return { forklaring: `Claude tænkte ${fmt(p.tokens)} tokens.`, tip: 'Tip: Lavere effort giver mindre tænkning på rutineopgaver.' }
    case 'kode':
      return {
        forklaring: `Claude skrev ${fmt(p.tokens)} tokens kode og filer (${p.navn.replace(/^Skrev: /, '')}).`,
        tip: 'Tip: Små rettelser er billigere end at skrive hele filer om.',
      }
    case 'tekst':
      return { forklaring: `Svaret til dig var ${fmt(p.tokens)} tokens langt.`, tip: '' }
    case 'subagent':
      return { forklaring: `${p.navn} brugte ${fmt(p.tokens)} tokens over ${runder(p.gange)}.`, tip: 'Tip: Giv subagenter en smal opgave.' }
    case 'besked':
      return {
        forklaring: `Din besked fyldte ${fmt(p.tokens)} tokens og blev læst i ${runder(p.gange)}.`,
        tip: 'Tip: Lange indsatte tekster læses igen i hver runde.',
      }
    default:
      return { forklaring: 'Ingen enkelt post dominerede.', tip: '' }
  }
}

export const analyser = (r: Raadata): Opgave => {
  const dele = new Map<string, Del>()
  const tilfoej = (type: PostType, navn: string, tokens: number, gange: number, usd: number) => {
    if (!(usd > 0) && !(tokens > 0)) return
    const d = dele.get(`${type}|${navn}`)
    if (!d) {
      dele.set(`${type}|${navn}`, { type, navn, tokens, gange, usd, antal: 1 })
      return
    }
    d.tokens += tokens
    d.usd += usd
    d.gange = type === 'subagent' ? d.gange + gange : Math.max(d.gange, gange)
    d.antal += 1
  }

  const ttl = r.ttl
  const hoved = r.trin.filter(t => t.loop === '').sort((a, b) => a.index - b.index)
  const n = hoved.length
  const skrivPris = (t: Trin | undefined) => (t ? pris(t.model).ind * ttl : 0)
  const laesFra = (fra: number) => hoved.slice(fra).reduce((sum, t) => sum + pris(t.model).laes, 0)

  // Samtalen fra før opgaven og den nye besked: læses i alle runder.
  const s0 = hoved[0]
  if (s0) {
    const nyt0 = s0.input + s0.cacheSkriv
    const forventet = r.forrigePrompt ?? s0.cacheLaes + Math.max(0, nyt0 - anslaa(r.prompt.length))
    let genskrevet = Math.min(nyt0, Math.max(0, forventet - s0.cacheLaes))
    if (genskrevet < 2000) genskrevet = 0
    const gammel = s0.cacheLaes + genskrevet
    const besked = nyt0 - genskrevet
    tilfoej('start', 'Samtalen fra før opgaven', gammel, n, s0.cacheLaes * pris(s0.model).laes + gammel * laesFra(1))
    if (genskrevet > 0) tilfoej('cache', 'Cache genopbygget', genskrevet, 1, genskrevet * skrivPris(s0))
    tilfoej('besked', 'Din besked og påmindelser', besked, n, besked * skrivPris(s0) + besked * laesFra(1))
  }

  hoved.forEach((s, k) => {
    // Værktøjsresultater fra forrige runde: skrives til cachen nu og læses i alle runder derefter.
    const f = hoved[k - 1]
    if (f) {
      let nyt = s.input + s.cacheSkriv
      const mistet = promptAf(f) - s.cacheLaes
      if (mistet > 5000 && mistet > 0.1 * promptAf(f) && promptAf(s) >= 0.7 * promptAf(f)) {
        const m = Math.min(mistet, nyt)
        tilfoej('cache', 'Cache udløb undervejs', m, 1, m * skrivPris(s))
        nyt -= m
      }
      const kald = r.kald
        .filter(c => c.loop === '' && c.trin === f.index)
        .map(c => ({ etiket: c.etiket, anslaaet: anslaa(c.tegn) }))
      const resultater = Math.max(0, nyt - f.output)
      const sum = kald.reduce((a, c) => a + c.anslaaet, 0)
      const maalt = resultater >= 0.5 * sum
      const videre = skrivPris(s) + laesFra(k + 1)
      for (const c of kald) {
        const tokens = maalt ? (sum > 0 ? (resultater * c.anslaaet) / sum : resultater / kald.length) : c.anslaaet
        tilfoej('vaerktoej', c.etiket, tokens, n - k - 1, tokens * videre)
      }
    }

    // Claudes output: genereres én gang og sendes med i resten af runderne.
    const prToken = pris(s.model).ud + skrivPris(hoved[k + 1]) + laesFra(k + 2)
    const tekst = anslaa(s.svarTegn)
    const input = s.vaerktoejsInput.map(v => ({ etiket: v.etiket, tokens: anslaa(v.tegn) }))
    const synligt = tekst + input.reduce((a, v) => a + v.tokens, 0)
    const skala = synligt > s.output && synligt > 0 ? s.output / synligt : 1
    const taenk = Math.max(0, s.output - synligt)
    tilfoej('taenkning', 'Tænkning', taenk, 1, taenk * prToken)
    tilfoej('tekst', 'Tekst til dig', tekst * skala, 1, tekst * skala * prToken)
    for (const v of input) {
      const tokens = v.tokens * skala
      tilfoej('kode', tokens >= 500 ? `Skrev: ${v.etiket}` : 'Små værktøjskald', tokens, 1, tokens * prToken)
    }
  })

  // Subagenter: alt, hvad deres egne modelkald kostede.
  const agentLoops = [...new Set(r.trin.filter(t => t.loop !== '').map(t => t.loop))]
  for (const a of agentLoops) {
    const ts = r.trin.filter(t => t.loop === a)
    const info = r.agenter[a]
    tilfoej(
      'subagent',
      `Subagent: ${afkort(info?.beskrivelse || info?.type || 'uden navn', 40)}`,
      ts.reduce((sum, t) => sum + promptAf(t) + t.output, 0),
      ts.length,
      ts.reduce((sum, t) => sum + trinUsd(t, ttl), 0),
    )
  }

  const iAlt = r.trin.reduce((sum, t) => sum + trinUsd(t, ttl), 0)
  const fordelt = [...dele.values()].reduce((sum, d) => sum + d.usd, 0)
  if (iAlt - fordelt > 0.02 * iAlt) tilfoej('andet', 'Andet (påmindelser m.m.)', 0, 0, iAlt - fordelt)
  const naevner = Math.max(iAlt, fordelt) || 1
  const prisIAlt = r.usd ?? (r.trin.length ? iAlt : null)

  const sorteret = [...dele.values()].sort((a, b) => b.usd - a.usd)
  const vist = sorteret.slice(0, 11)
  const resten = sorteret.slice(11)
  if (resten.length) {
    vist.push({
      type: 'andet',
      navn: `${resten.length} mindre poster`,
      tokens: resten.reduce((sum, d) => sum + d.tokens, 0),
      gange: 0,
      usd: resten.reduce((sum, d) => sum + d.usd, 0),
      antal: resten.length,
    })
  }
  const poster: Post[] = vist.map(d => ({
    type: d.type,
    navn: d.antal > 1 && (d.type === 'vaerktoej' || d.type === 'subagent') ? `${d.navn} ×${d.antal}` : d.navn,
    tokens: Math.round(d.tokens),
    gange: d.gange,
    andel: d.usd / naevner,
    usd: prisIAlt === null ? null : (d.usd / naevner) * prisIAlt,
  }))

  const samlet = (f: (t: Trin) => number) => r.trin.reduce((s, t) => s + f(t), 0)
  const { forklaring, tip } = hvorfor(poster[0], n)
  return {
    nr: r.nr,
    start: r.start,
    prompt: r.prompt,
    afbrudt: r.afbrudt,
    sekunder: r.sekunder,
    usd: prisIAlt,
    model: hoved.at(-1)?.model ?? r.trin.at(-1)?.model ?? '',
    ind: samlet(promptAf),
    ud: samlet(t => t.output),
    cacheLaes: samlet(t => t.cacheLaes),
    cacheSkriv: samlet(t => t.cacheSkriv),
    runder: n,
    startKontekst: s0 ? promptAf(s0) : 0,
    subagenter: agentLoops.length,
    poster,
    forklaring,
    tip,
    kontekst: r.kontekst,
  }
}

const KORT: Partial<Record<PostType, string>> = {
  start: 'samtalen fra før',
  besked: 'din besked',
  taenkning: 'tænkning',
  tekst: 'tekst til dig',
}

export const kortNavn = (p: Post): string => KORT[p.type] ?? (p.type === 'cache' ? p.navn.toLowerCase() : afkort(p.navn, 34))

export const opsummering = (o: Opgave): string => {
  const top = o.poster[0]
  return [
    `${fmt(o.ind + o.ud)} tokens`,
    o.usd !== null ? dollar(o.usd) : '',
    runder(o.runder),
    top ? `mest: ${kortNavn(top)} (${procent(top.andel)})` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

const beskriv = (p: Post): string => {
  switch (p.type) {
    case 'start':
    case 'besked':
      return `${fmt(p.tokens)}, læst i ${runder(p.gange)}`
    case 'vaerktoej':
      return p.gange > 0 ? `${fmt(p.tokens)}, læst igen i ${runder(p.gange)}` : fmt(p.tokens)
    case 'subagent':
      return `${fmt(p.tokens)}, ${runder(p.gange)}`
    case 'andet':
      return p.tokens > 0 ? fmt(p.tokens) : 'rest'
    default:
      return fmt(p.tokens)
  }
}

// `mere` står efter opgavenummeret (fx dag og dato), `beskrivelse` siger, hvad Claude udførte;
// uden bjælker er teksten til modellen.
export const detaljer = (o: Opgave, mere = '', visuel = true, beskrivelse?: string): string[] => {
  const linje = (andel: number, usd: number | null, tekst: string) =>
    visuel ? bjaelkeLinje(andel, usd, tekst) : `${procent(andel)} · ${usd !== null ? `${dollar(usd)} · ` : ''}${tekst}`
  const linjer = [
    `Opgave ${o.nr}${mere ? ` · ${mere}` : ''}${o.afbrudt ? ' (afbrudt)' : ''}: ${beskrivelse ?? `"${o.prompt}"`}`,
    ...(beskrivelse ? [`Din besked: "${o.prompt}"`] : []),
    [
      `${fmt(o.ind + o.ud)} tokens`,
      o.usd !== null ? dollar(o.usd) : '',
      `${runder(o.runder)} (modelkald)`,
      o.subagenter ? `${o.subagenter} subagent${o.subagenter > 1 ? 'er' : ''}` : '',
      tid(o.sekunder),
    ]
      .filter(Boolean)
      .join(' · '),
    '',
    `Hvorfor: ${o.forklaring}`,
  ]
  if (o.poster.length) linjer.push('', 'Hvad prisen gik til (ca.):')
  for (const p of o.poster.slice(0, 5)) linjer.push(linje(p.andel, p.usd, `${p.navn} (${beskriv(p)})`))
  const resten = o.poster.slice(5)
  // Resten står uden bjælke, så bjælkerne altid står i faldende orden.
  if (resten.length) {
    const andel = resten.reduce((s, p) => s + p.andel, 0)
    const usd = o.usd !== null ? resten.reduce((s, p) => s + (p.usd ?? 0), 0) : null
    linjer.push(`Resten: ${usd !== null ? `${dollar(usd)} ` : ''}(${procent(andel)}).`)
  }
  if (o.kontekst.length) {
    linjer.push('', `Samtalen ved start: ${o.kontekst.map(k => `${k.navn} ${fmt(k.tokens)}`).join(' · ')}`)
  }
  if (o.tip) linjer.push(o.tip)
  return linjer
}
