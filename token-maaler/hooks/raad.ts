import type { Opgave, PostType } from '../types'
import { bjaelke, dollar, fmt, pris, procent } from './analyse'
import type { HistOpgave, Projekt } from './historik'

// Ét råd fra analytikeren: hvad den så, hvad man kan gøre, og hvad det cirka kunne have sparet.
export type Raad = {
  id: string
  titel: string
  tekst: string
  skridt: string
  usd: number
  eksempler: string[]
}

export type Del = { navn: string; tokens: number }

// Det, der følger med i hver runde uden at være en del af samtalen. Kendes kun for den aktive session.
export type Overhead = { mcp: Del[]; skills: Del[] }

// Det, reglerne ser på: projektet, hver opgave med sin analyse, og sessionens faste overhead.
export type Grundlag = {
  projekt: Projekt
  opgaver: { o: HistOpgave; a: Opgave }[]
  overhead: Overhead | null
}

// En regel giver nul eller flere råd. Nye råd tilføjes ved at skrive en regel og sætte den i REGLER.
export type Regel = { id: string; tjek: (g: Grundlag) => Raad[] }

// Omtrent så stor er en samtale efter /compact.
const KOMPAKT = 60_000

// Råd under dette beløb er ikke værd at nævne.
const MINDST = 0.25

const sum = <T>(liste: readonly T[], f: (x: T) => number) => liste.reduce((s, x) => s + f(x), 0)

const postUsd = (a: Opgave, type: PostType) => sum(a.poster.filter(p => p.type === type), p => p.usd ?? 0)

const flest = <T>(liste: readonly T[], f: (x: T) => number, antal = 3) => [...liste].sort((a, b) => f(b) - f(a)).slice(0, antal)

// Andelen af genlæsningen, der var sparet, hvis samtalen var komprimeret til KOMPAKT.
const sparet = (kontekst: number) => (kontekst > KOMPAKT ? 1 - KOMPAKT / kontekst : 0)

const langSamtale: Regel = {
  id: 'lang-samtale',
  tjek: g => {
    const lange = g.opgaver
      .filter(({ a }) => a.startKontekst > 150_000)
      .map(({ o, a }) => ({ o, a, usd: postUsd(a, 'start') * sparet(a.startKontekst) }))
    const usd = sum(lange, x => x.usd)
    if (usd < MINDST) return []
    const stoerst = Math.max(...lange.map(x => x.a.startKontekst))
    return [
      {
        id: 'lang-samtale',
        titel: `Lang samtale: hver runde læser op til ${fmt(stoerst)} tokens igen`,
        tekst: `I ${lange.length === 1 ? '1 opgave' : `${lange.length} opgaver`} var samtalen over 150k tokens lang, og den blev læst igen i hver runde. Komprimeret til ca. 60k havde det kostet ca. ${dollar(usd)} mindre.`,
        skridt: 'Skriv /compact, når en opgave er færdig og samtalen er lang, og start en ny session til et nyt emne.',
        usd,
        eksempler: flest(lange, x => x.usd).map(x => `opgave ${x.o.nr}: ${fmt(x.a.startKontekst)} tokens × ${x.a.runder} runder (ca. ${dollar(x.usd)} at spare)`),
      },
    ]
  },
}

const pauser: Regel = {
  id: 'pauser',
  tjek: g => {
    const ramte = g.opgaver
      .map(({ o, a }) => ({ o, a, posten: a.poster.find(p => p.type === 'cache') }))
      .filter(x => x.posten !== undefined)
      .map(x => ({ ...x, kostede: x.posten?.usd ?? 0, tokens: x.posten?.tokens ?? 0 }))
    const kostede = sum(ramte, x => x.kostede)
    const usd = sum(ramte, x => x.kostede * sparet(x.tokens))
    if (usd < MINDST) return []
    return [
      {
        id: 'pauser',
        titel: `Pauser kostede ${dollar(kostede)} i genopbygning af cachen`,
        tekst: `${ramte.length === 1 ? 'Én gang' : `${ramte.length} gange`} skulle hele samtalen skrives til cachen igen efter en pause (cachen holder ca. en time). Med en komprimeret samtale havde det kostet ca. ${dollar(usd)} mindre.`,
        skridt: 'Skriv /compact, før du holder en lang pause, eller start en ny session, når du vender tilbage.',
        usd,
        eksempler: flest(ramte, x => x.kostede).map(x => `opgave ${x.o.nr}: ${fmt(x.tokens)} tokens skrevet igen (${dollar(x.kostede)})`),
      },
    ]
  },
}

const storeResultater: Regel = {
  id: 'store-resultater',
  tjek: g => {
    const store = g.opgaver.flatMap(({ o, a }) =>
      a.poster.filter(p => p.type === 'vaerktoej' && p.tokens >= 5_000).map(p => ({ o, p, usd: p.usd ?? 0 })),
    )
    const kostede = sum(store, x => x.usd)
    // Et udsnit fylder typisk en tredjedel af hele filen eller outputtet.
    const usd = kostede * 0.7
    if (usd < MINDST) return []
    return [
      {
        id: 'store-resultater',
        titel: `Store værktøjsresultater kostede ${dollar(kostede)}`,
        tekst: `${store.length === 1 ? 'Ét værktøjskald' : `${store.length} værktøjskald`} gav over 5k tokens, som derefter blev læst igen i de følgende runder. Udsnit i stedet for hele filer og lange output kunne have sparet ca. ${dollar(usd)}.`,
        skridt: 'Bed Claude læse bestemte linjer i store filer, søge med Grep og begrænse lange kommando-output.',
        usd,
        eksempler: flest(store, x => x.usd).map(x => `opgave ${x.o.nr}: ${x.p.navn} (${fmt(x.p.tokens)}, ${dollar(x.usd)})`),
      },
    ]
  },
}

const taenkning: Regel = {
  id: 'taenkning',
  tjek: g => {
    const pr = g.opgaver.map(({ o, a }) => ({ o, a, usd: postUsd(a, 'taenkning') }))
    const kostede = sum(pr, x => x.usd)
    if (kostede < 1 || kostede < 0.25 * g.projekt.usd) return []
    // Lavere effort på rutineopgaver halverer ofte tænkningen dér; omkring 40 % af den samlede tænkning.
    const usd = kostede * 0.4
    return [
      {
        id: 'taenkning',
        titel: `Tænkning stod for ${procent(kostede / g.projekt.usd)} af prisen`,
        tekst: `Claude tænkte for ${dollar(kostede)} i projektet. Rutineopgaver (commit, små rettelser, korte spørgsmål) kræver sjældent dyb tænkning; lavere effort på dem kunne spare ca. ${dollar(usd)}.`,
        skridt: 'Sæt effort lavere i modelvælgeren til rutineopgaver, og hæv den igen til svære opgaver.',
        usd,
        eksempler: flest(pr, x => x.usd).map(x => `opgave ${x.o.nr}: tænkning for ${dollar(x.usd)}`),
      },
    ]
  },
}

const subagenter: Regel = {
  id: 'subagenter',
  tjek: g => {
    const kostede = g.projekt.subUsd
    if (kostede < 1 || kostede < 0.2 * g.projekt.usd) return []
    const usd = kostede * 0.3
    const poster = g.opgaver.flatMap(({ o, a }) => a.poster.filter(p => p.type === 'subagent').map(p => ({ o, p })))
    return [
      {
        id: 'subagenter',
        titel: `Subagenter kostede ${dollar(kostede)} (${procent(kostede / g.projekt.usd)})`,
        tekst: `Hver subagent starter med sin egen kontekst og læser ofte meget for at finde det, den skal bruge. Smallere opgaver til dem kunne spare ca. ${dollar(usd)}.`,
        skridt: 'Giv subagenter en præcis opgave (hvilke filer, hvilket spørgsmål), og lad Claude selv søge, når opgaven er lille.',
        usd,
        eksempler: flest(poster, x => x.p.usd ?? 0).map(x => `opgave ${x.o.nr}: ${x.p.navn} (${dollar(x.p.usd ?? 0)})`),
      },
    ]
  },
}

const RUTINE = /\b(commit|push|deploy|merge|pull request|kør (?:testene|tests))\b/i

const rutine: Regel = {
  id: 'rutine',
  tjek: g => {
    const ramte = g.opgaver
      .filter(({ o, a }) => o.fuld.length <= 80 && RUTINE.test(o.fuld) && a.startKontekst > 100_000 && o.usd >= 0.5)
      .map(({ o, a }) => ({ o, usd: o.usd * sparet(a.startKontekst) }))
    const usd = sum(ramte, x => x.usd)
    if (usd < MINDST) return []
    return [
      {
        id: 'rutine',
        titel: 'Små rutineopgaver blev dyre i en lang samtale',
        tekst: `${ramte.length === 1 ? 'En kort opgave' : `${ramte.length} korte opgaver`} som commit og push kostede ${dollar(sum(ramte, x => x.o.usd))}, mest fordi hele samtalen blev læst med. I en ny, kort session havde de kostet ca. ${dollar(usd)} mindre.`,
        skridt: 'Tag commit, push og deploy i en ny session eller efter /compact.',
        usd,
        eksempler: flest(ramte, x => x.o.usd).map(x => `opgave ${x.o.nr}: "${x.o.tekst}" (${dollar(x.o.usd)})`),
      },
    ]
  },
}

const overhead: Regel = {
  id: 'overhead',
  tjek: g => {
    if (!g.overhead) return []
    const dele = [
      ...g.overhead.mcp.map(d => ({ ...d, navn: `${d.navn} (MCP)` })),
      ...g.overhead.skills.map(d => ({ ...d, navn: d.navn.endsWith('skills') ? d.navn : `${d.navn} (skills)` })),
    ]
    const tokens = sum(dele, d => d.tokens)
    if (tokens < 10_000) return []
    const runder = sum(g.opgaver, x => x.a.runder)
    const genopbygninger = 1 + g.opgaver.filter(x => x.a.poster.some(p => p.type === 'cache')).length
    const p = pris(g.opgaver.at(-1)?.a.model ?? '')
    // Hver runde læser det fra cachen; hver ny session og pause skriver det igen (1 times cache koster 2 × input).
    const usd = tokens * runder * p.laes + tokens * genopbygninger * p.ind * 2
    if (usd < MINDST) return []
    return [
      {
        id: 'overhead',
        titel: `${fmt(tokens)} tokens fra forbindelser og plugins følger med i hver runde`,
        tekst: `Værktøjer fra MCP-forbindelser og skills fra plugins lå i konteksten i alle projektets ${runder} runder; det kostede ca. ${dollar(usd)}. Bruger projektet dem ikke, er det penge ud af vinduet.`,
        skridt: 'Slå de forbindelser og plugins fra, som dette projekt ikke bruger. Det virker fra næste session.',
        usd,
        eksempler: flest(dele, d => d.tokens, 5).map(d => `${d.navn}: ${fmt(d.tokens)} tokens`),
      },
    ]
  },
}

export const REGLER: Regel[] = [langSamtale, pauser, storeResultater, taenkning, subagenter, rutine, overhead]

export const raad = (g: Grundlag, regler: readonly Regel[] = REGLER): Raad[] =>
  regler
    .flatMap(r => {
      try {
        return r.tjek(g)
      } catch {
        return []
      }
    })
    .sort((a, b) => b.usd - a.usd)

// Appens egne værktøjer og skills kan ikke slås fra; dem nævner analytikeren ikke.
const INDBYGGET_SERVER = /^(Claude_|ccd_|terminal$|visualize$)/
const INDBYGGET_SKILL = /^(built-?in|bundled)$/

// Det faste overhead ud fra /context-opdelingen: indlæste MCP-værktøjer pr. server og skills pr. plugin.
export const overheadFra = (
  mcpTools: readonly { name: string; serverName: string; tokens: number; isLoaded: boolean }[],
  skills: readonly { name: string; pluginName?: string; source: string; tokens: number }[],
): Overhead => {
  // Grupperer på `noegle` og viser hver gruppe under det navn, `navn` giver dens første element.
  const grupper = <T>(liste: readonly T[], noegle: (x: T) => string, navn: (x: T) => string, tokens: (x: T) => number): Del[] => {
    const pr = new Map<string, Del>()
    for (const x of liste) {
      const d = pr.get(noegle(x)) ?? { navn: navn(x), tokens: 0 }
      d.tokens += tokens(x)
      pr.set(noegle(x), d)
    }
    return [...pr.values()].sort((a, b) => b.tokens - a.tokens)
  }
  // En server med et uuid som navn vises ved sit første værktøj.
  const servernavn = (t: { name: string; serverName: string }) =>
    /^[0-9a-f]{8}-/.test(t.serverName) ? `forbindelsen med ${t.name.split('__').pop() ?? t.name}` : t.serverName
  const KILDER: Record<string, string> = { userSettings: 'dine egne skills', projectSettings: 'projektets skills', policySettings: 'organisationens skills' }
  return {
    mcp: grupper(mcpTools.filter(t => t.isLoaded && !INDBYGGET_SERVER.test(t.serverName)), t => t.serverName, servernavn, t => t.tokens),
    skills: grupper(
      skills.filter(s => s.pluginName !== undefined || !INDBYGGET_SKILL.test(s.source)),
      s => s.pluginName ?? s.source,
      s => s.pluginName ?? KILDER[s.source] ?? s.source,
      s => s.tokens,
    ),
  }
}

export const raadTekst = (titel: string, liste: readonly Raad[], visuel = true): string[] => {
  if (liste.length === 0) return [`Råd til ${titel}: ingen lige nu. Forbruget ser fornuftigt ud.`]
  const stoerst = liste[0]?.usd ?? 0
  const linjer = [`Råd til at bruge færre tokens · ${titel}`, 'Beløbene er skøn over, hvad det kunne have sparet.']
  for (const r of liste) {
    linjer.push('', `${visuel ? `${bjaelke(stoerst > 0 ? r.usd / stoerst : 0)} ` : ''}ca. ${dollar(r.usd)} at spare · ${r.titel}`, r.tekst, `→ ${r.skridt}`)
    for (const e of r.eksempler) linjer.push(`Fx ${e}`)
  }
  return linjer
}
