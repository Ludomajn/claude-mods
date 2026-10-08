import type { Opgave, PostType } from '../types'
import { afkortOrd, bjaelke, fmt, pris, procent } from './analyse'
import { maal, maalForklaring } from './enhed'
import type { Trin } from './analyse'
import type { HistOpgave, Projekt } from './historik'

// Ét råd fra analytikeren, vist på højst tre linjer: navn og beløb, hvad den så, og hvad man gør.
export type Raad = {
  id: string
  // Kort navn uden tal, fx "Lang samtale".
  navn: string
  // Hvad analytikeren så, med tal fra projektet.
  hvorfor: string
  // Hvad man gør, og hvorfor det hjælper. Må indeholde `kode`.
  handling: string
  // Handlingen i få ord, til /tokens-oversigten.
  kort: string
  usd: number
  // Konkrete steder, det skete; kun til Claude via værktøjet.
  eksempler: string[]
  // Hvem rådet gælder, når det ikke er denne samtale, fx "hele kontoen".
  antal?: string
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
        navn: 'Lang samtale',
        hvorfor: `Samtalen nåede ${fmt(stoerst)} tokens, og hver runde læste den hele igen.`,
        handling: 'Skriv `/compact`, når en opgave er færdig, så hver runde læser mindre.',
        kort: '/compact efter hver færdig opgave',
        usd,
        eksempler: flest(lange, x => x.usd).map(x => `opgave ${x.o.nr}: ${fmt(x.a.startKontekst)} tokens × ${x.a.runder} runder (ca. ${maal(x.usd)} at spare)`),
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
        navn: 'Pauser',
        hvorfor: `Cachen udløb ${ramte.length === 1 ? '1 gang' : `${ramte.length} gange`} under pauser, og hele samtalen blev gemt igen (${maal(kostede)}).`,
        handling: 'Skriv `/compact` før en lang pause, så der er mindre at gemme igen.',
        kort: '/compact før en pause',
        usd,
        eksempler: flest(ramte, x => x.kostede).map(x => `opgave ${x.o.nr}: ${fmt(x.tokens)} tokens skrevet igen (${maal(x.kostede)})`),
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
        navn: 'Store værktøjsresultater',
        hvorfor: `${store.length === 1 ? '1 værktøjskald' : `${store.length} værktøjskald`} gav over 5k tokens, størst ${flest(store, x => x.p.tokens, 1).map(x => `${afkortOrd(x.p.navn, 36)} (${fmt(x.p.tokens)})`).join('')}.`,
        handling: 'Bed om bestemte linjer eller en søgning frem for hele filer og lange output.',
        kort: 'bed om udsnit, ikke hele filer',
        usd,
        eksempler: flest(store, x => x.usd).map(x => `opgave ${x.o.nr}: ${x.p.navn} (${fmt(x.p.tokens)}, ${maal(x.usd)})`),
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
        navn: 'Tænkning',
        hvorfor: `Claude tænkte for ${maal(kostede)}, ${procent(kostede / g.projekt.usd)} af forbruget.`,
        handling: 'Sæt effort lavere til rutineopgaver, og hæv den igen til svære opgaver.',
        kort: 'lavere effort til rutineopgaver',
        usd,
        eksempler: flest(pr, x => x.usd).map(x => `opgave ${x.o.nr}: tænkning for ${maal(x.usd)}`),
      },
    ]
  },
}

const subagenter: Regel = {
  id: 'subagenter',
  tjek: g => {
    const kostede = g.projekt.subUsd
    if (kostede < 1 || kostede < 0.2 * g.projekt.usd) return []
    // Subagenter på xhigh og max har deres eget råd (agent-effort); det her gælder resten.
    const usd = Math.max(0, kostede - hoejEffort(g)) * 0.3
    if (usd < MINDST) return []
    const poster = g.opgaver.flatMap(({ o, a }) => a.poster.filter(p => p.type === 'subagent').map(p => ({ o, p })))
    return [
      {
        id: 'subagenter',
        navn: 'Subagenter',
        hvorfor: `Subagenter brugte ${maal(kostede)}, ${procent(kostede / g.projekt.usd)} af forbruget.`,
        handling: 'Giv hver subagent en præcis opgave: hvilke filer og hvilket spørgsmål.',
        kort: 'giv subagenter smallere opgaver',
        usd,
        eksempler: flest(poster, x => x.p.usd ?? 0).map(x => `opgave ${x.o.nr}: ${x.p.navn} (${maal(x.p.usd ?? 0)})`),
      },
    ]
  },
}

const RUTINE = /\b(commit|push|deploy|merge|pull request|run (?:the )?tests|kør (?:testene|tests))\b/i

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
        navn: 'Commit og push i lang samtale',
        hvorfor: `${ramte.length === 1 ? '1 kort opgave' : `${ramte.length} korte opgaver`} brugte ${maal(sum(ramte, x => x.o.usd))}, fordi hele samtalen blev læst med.`,
        handling: 'Tag commit og push efter `/compact` eller i en ny samtale.',
        kort: 'commit og push efter /compact',
        usd,
        eksempler: flest(ramte, x => x.o.usd).map(x => `opgave ${x.o.nr}: "${x.o.tekst}" (${maal(x.o.usd)})`),
      },
    ]
  },
}

const overhead: Regel = {
  id: 'overhead',
  tjek: g => {
    if (!g.overhead) return []
    const dele = [
      ...g.overhead.mcp.map(d => ({ ...d, slags: ' (MCP)' })),
      ...g.overhead.skills.map(d => ({ ...d, slags: d.navn.endsWith('skills') ? '' : ' (skills)' })),
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
        navn: 'Plugins og forbindelser',
        hvorfor: `${fmt(tokens)} tokens følger med i hver runde, mest ${flest(dele, d => d.tokens, 1).map(d => `${d.navn} (${fmt(d.tokens)})`).join('')}.`,
        handling: 'Slå de plugins og forbindelser fra, som du ikke bruger. Det virker fra næste samtale.',
        kort: `slå ubrugte fra, fx ${flest(dele, d => d.tokens, 1).map(d => d.navn).join('')}`,
        usd,
        eksempler: flest(dele, d => d.tokens, 5).map(d => `${d.navn}${d.slags}: ${fmt(d.tokens)} tokens`),
      },
    ]
  },
}

// Hjælpere til reglerne, der ser på de enkelte modelkald og værktøjskald.
const alleTrin = (g: Grundlag): Trin[] => g.opgaver.flatMap(({ o }) => o.raa?.trin ?? [])

const hovedTrin = (o: HistOpgave): Trin[] => (o.raa?.trin ?? []).filter(t => t.loop === '').sort((a, b) => a.index - b.index)

const trinUsd = (t: Trin, ttl: number, p = pris(t.model)) => t.input * p.ind + t.cacheSkriv * p.ind * ttl + t.cacheLaes * p.laes + t.output * p.ud

const HOEJ = /^(xhigh|max)$/

// Den model, dyrere modeller sammenlignes med: standardmodellen i Claude Code.
const STANDARDMODEL = 'claude-opus-5-5'

// "claude-fable-5" → "Fable 5".
const modelNavn = (model: string) =>
  model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .map((d, i) => (i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d))
    .join(' ')
    .replace(/(\d) (\d)/, '$1.$2')

// Et billede i et værktøjsresultat fylder omtrent 1.500 tokens.
const BILLEDE = 1_500

const skaermbilleder: Regel = {
  id: 'skaermbilleder',
  tjek: g => {
    // Hvert billede skrives til cachen og læses igen i resten af opgavens runder.
    const ramte = g.opgaver.flatMap(({ o }) => {
      const h = hovedTrin(o)
      return (o.raa?.kald ?? [])
        .filter(k => (k.billeder ?? 0) > 0 && !k.etiket.startsWith('Read '))
        .map(k => {
          const p = pris(h[k.trin]?.model ?? '')
          const tokens = (k.billeder ?? 0) * BILLEDE
          return { o, antal: k.billeder ?? 0, usd: tokens * (p.ind * o.raa.ttl + p.laes * Math.max(0, h.length - k.trin - 1)) }
        })
    })
    const antal = sum(ramte, x => x.antal)
    const kostede = sum(ramte, x => x.usd)
    // Siden læst som tekst fylder typisk under halvdelen af et skærmbillede og kan søges i.
    const usd = kostede * 0.5
    if (antal < 10 || usd < MINDST) return []
    const pr = new Map<number, { o: HistOpgave; antal: number; usd: number }>()
    for (const x of ramte) {
      const y = pr.get(x.o.nr) ?? { o: x.o, antal: 0, usd: 0 }
      y.antal += x.antal
      y.usd += x.usd
      pr.set(x.o.nr, y)
    }
    return [
      {
        id: 'skaermbilleder',
        navn: 'Skærmbilleder',
        hvorfor: `Claude tog ${antal} skærmbilleder, og hvert blev læst igen i resten af opgaven (${maal(kostede)}).`,
        handling: 'Bed Claude læse siden som tekst og kun tage skærmbilleder, når udseendet skal tjekkes.',
        kort: 'læs siden som tekst, ikke som billede',
        usd,
        eksempler: flest([...pr.values()], x => x.usd).map(x => `opgave ${x.o.nr}: ${x.antal} billeder (${maal(x.usd)})`),
      },
    ]
  },
}

// Hvad hver slags fejl hedder i rådet; slagsen uden egen handling får handlingen for kommandoer.
const FEJLNAVN: Record<string, string> = {
  tilladelse: 'manglende tilladelser',
  timeout: 'timeouts',
  kommando: 'kommandoer, der fejlede',
  'findes ikke': 'filer og stier, der ikke fandtes',
  andet: 'andre fejl',
}

const FEJLHANDLING: Record<string, Pick<Raad, 'handling' | 'kort'>> = {
  tilladelse: {
    handling: 'Giv faste tilladelser til de kommandoer, Claude bruger tit, så de ikke afvises og prøves igen.',
    kort: 'faste tilladelser til faste kommandoer',
  },
  timeout: {
    handling: 'Bed Claude køre lange kommandoer i baggrunden i stedet for at vente, til de fejler.',
    kort: 'lange kommandoer i baggrunden',
  },
  kommando: {
    handling: 'Skriv de kommandoer og stier, der virker, i CLAUDE.md, så Claude ikke skal prøve sig frem.',
    kort: 'faste kommandoer i CLAUDE.md',
  },
}

const fejl: Regel = {
  id: 'fejl',
  tjek: g => {
    // Hvert fejlet kald koster mindst én ekstra runde: Claude læser fejlen og prøver igen.
    // Kald, du selv afviste, tæller ikke.
    const ramte = g.opgaver.flatMap(({ o }) => {
      const h = hovedTrin(o)
      return (o.raa?.kald ?? [])
        .filter(k => k.fejl !== undefined && k.fejl !== 'afvist')
        .map(k => {
          const naeste = h[k.trin + 1]
          return { o, slags: k.fejl ?? 'andet', etiket: k.etiket, usd: naeste ? trinUsd(naeste, o.raa.ttl) : 0 }
        })
    })
    const kostede = sum(ramte, x => x.usd)
    // Omtrent halvdelen kan undgås med faste kommandoer og tilladelser.
    const usd = kostede * 0.5
    if (ramte.length < 5 || usd < MINDST) return []
    // Den hyppigste slags blandt alle fejlene, også dem uden egen handling.
    const slags = new Map<string, number>()
    for (const x of ramte) slags.set(x.slags, (slags.get(x.slags) ?? 0) + 1)
    const [top = 'andet', n = 0] = [...slags.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    const h = Object.hasOwn(FEJLHANDLING, top) ? FEJLHANDLING[top] : FEJLHANDLING.kommando
    return [
      {
        id: 'fejl',
        navn: 'Fejlede værktøjskald',
        hvorfor: `${ramte.length} værktøjskald fejlede, mest ${Object.hasOwn(FEJLNAVN, top) ? FEJLNAVN[top] : top} (${n}), og hver fejl kostede en ekstra runde.`,
        handling: h?.handling ?? '',
        kort: h?.kort ?? '',
        usd,
        eksempler: flest(ramte, x => x.usd).map(x => `opgave ${x.o.nr}: ${x.etiket} (${x.slags}, ${maal(x.usd)})`),
      },
    ]
  },
}

// Subagenternes kald på xhigh og max, når de er mindst $1 og halvdelen af subagenternes pris; ellers 0.
const hoejEffort = (g: Grundlag): number => {
  const sub = alleTrin(g).filter(t => t.loop !== '')
  const kostede = sum(sub.filter(t => HOEJ.test(t.effort ?? '')), t => trinUsd(t, 1.25))
  return kostede >= 1 && kostede >= 0.5 * sum(sub, t => trinUsd(t, 1.25)) ? kostede : 0
}

const agentEffort: Regel = {
  id: 'agent-effort',
  tjek: g => {
    const sub = alleTrin(g).filter(t => t.loop !== '')
    const hoeje = sub.filter(t => HOEJ.test(t.effort ?? ''))
    const kostede = hoejEffort(g)
    if (kostede === 0) return []
    // Hvor meget mindre output et kald på high giver: målt i brugerens egne subagenter, når der er nok
    // af begge slags, ellers et forsigtigt skøn på 25 %.
    const high = sub.filter(t => t.effort === 'high')
    const snit = (l: readonly Trin[]) => sum(l, t => t.output) / l.length
    const maalt = high.length >= 20 && hoeje.length >= 20 ? 1 - snit(high) / snit(hoeje) : null
    const faktor = Math.min(0.4, Math.max(0, maalt ?? 0.25))
    const usd = sum(hoeje, t => t.output * pris(t.model).ud) * faktor
    if (usd < MINDST) return []
    return [
      {
        id: 'agent-effort',
        navn: 'Subagenter på høj effort',
        hvorfor: `Subagenter på xhigh eller max brugte ${maal(kostede)}, ${procent(kostede / sum(sub, t => trinUsd(t, 1.25)))} af subagenternes forbrug.`,
        handling: 'Kør subagenter på high, og spar xhigh til den sværeste del, fx den sidste vurdering. Skriv det i CLAUDE.md.',
        kort: 'subagenter på high',
        usd,
        eksempler: [`${hoeje.length} af ${sub.length} subagent-kald kørte på xhigh eller max`],
      },
    ]
  },
}

// Modellens familie uden version, fx "opus" eller "fable".
const familie = (model: string) => model.replace(/^claude-/, '').split('-')[0] ?? ''

// Kald i chatten på en model, der er dyrere end standardmodellen; `samme` vælger en ældre version
// af standardmodellens familie (fx Opus 5 over for Opus 5.5) eller en anden, dyrere familie (fx Fable).
const dyreKald = (g: Grundlag, samme: boolean) => {
  const STANDARD = pris(STANDARDMODEL)
  const dyre = g.opgaver.flatMap(({ o }) =>
    hovedTrin(o)
      .filter(t => pris(t.model).ud > STANDARD.ud && (familie(t.model) === familie(STANDARDMODEL)) === samme)
      .map(t => ({ o, t, usd: trinUsd(t, o.raa.ttl) })),
  )
  const pr = new Map<number, { o: HistOpgave; usd: number }>()
  for (const x of dyre) pr.set(x.o.nr, { o: x.o, usd: (pr.get(x.o.nr)?.usd ?? 0) + x.usd })
  return {
    kostede: sum(dyre, x => x.usd),
    alternativ: sum(dyre, x => trinUsd(x.t, x.o.raa.ttl, STANDARD)),
    model: modelNavn(flest(dyre, x => x.usd, 1)[0]?.t.model ?? ''),
    eksempler: flest([...pr.values()], x => x.usd).map(x => `opgave ${x.o.nr}: "${x.o.tekst}" (${maal(x.usd)})`),
  }
}

const dyrModel: Regel = {
  id: 'dyr-model',
  tjek: g => {
    const { kostede, alternativ, model, eksempler } = dyreKald(g, false)
    // Antag, at halvdelen af arbejdet var rutine, som standardmodellen klarer lige så godt.
    const usd = (kostede - alternativ) * 0.5
    if (usd < MINDST) return []
    const standard = modelNavn(STANDARDMODEL)
    return [
      {
        id: 'dyr-model',
        navn: 'Dyr model til rutine',
        hvorfor: `${model} brugte ${maal(kostede)} i chatten. Samme arbejde på ${standard} havde brugt ca. ${maal(alternativ)}.`,
        handling: `Brug ${model} til de sværeste opgaver og ${standard} til resten. Vælg model, før samtalen starter.`,
        kort: `${model} kun til det sværeste`,
        usd,
        eksempler,
      },
    ]
  },
}

const gammelModel: Regel = {
  id: 'gammel-model',
  tjek: g => {
    const { kostede, alternativ, model, eksempler } = dyreKald(g, true)
    const usd = kostede - alternativ
    if (usd < MINDST) return []
    const standard = modelNavn(STANDARDMODEL)
    return [
      {
        id: 'gammel-model',
        navn: 'Ældre model',
        hvorfor: `${model} brugte ${maal(kostede)} i chatten. ${standard} er nyere og havde brugt ca. ${maal(alternativ)}.`,
        handling: `Skift til ${standard} i modelvælgeren; den er nyere og billigere pr. token.`,
        kort: `skift til ${standard}`,
        usd,
        eksempler,
      },
    ]
  },
}

const forbrugsgraense: Regel = {
  id: 'forbrugsgraense',
  tjek: g => {
    const { antal, usd } = g.projekt.stoppet ?? { antal: 0, usd: 0 }
    if (antal === 0 || usd < MINDST) return []
    return [
      {
        id: 'forbrugsgraense',
        navn: 'Forbrugsgrænse',
        hvorfor: `Grænsen stoppede ${antal === 1 ? '1 subagent' : `${antal} subagenter`} midt i arbejdet, og det, de nåede, gik tabt.`,
        handling: 'Tjek `/usage` før store workflows, og start dem først, når der er plads til hele kørslen.',
        kort: 'tjek /usage før store kørsler',
        usd,
        eksempler: [`forbrugsgrænsen afviste ${g.projekt.graense} kald`],
      },
    ]
  },
}

export const REGLER: Regel[] = [
  langSamtale,
  pauser,
  storeResultater,
  taenkning,
  subagenter,
  agentEffort,
  rutine,
  dyrModel,
  gammelModel,
  skaermbilleder,
  fejl,
  forbrugsgraense,
  overhead,
]

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

// Tallet i rådene: andel af ugens grænse, når den er målt, ellers kroner. Altid et skøn.
export const beloeb = (usd: number): string => maal(usd)

// Så mange råd vises; resten samles på én linje.
export const MEST = 5

// Rådet på én linje, til /tokens-oversigten: "Lang samtale → /compact efter hver færdig opgave".
export const kortRaad = (r: Pick<Raad, 'navn' | 'kort'>): string => `${r.navn} → ${r.kort}`

// Ét råd på tre linjer: bjælke, beløb og navn; hvad der skete; hvad man gør.
export const raadBlok = (
  r: Pick<Raad, 'navn' | 'handling' | 'usd'>,
  hvorfor: string,
  andel: number,
  visuel: boolean,
  tillaeg = '',
): string[] => [`${visuel ? `${bjaelke(andel, 10)} ` : ''}**${beloeb(r.usd)} · ${r.navn}**${tillaeg}`, hvorfor, `→ ${r.handling}`]

export const restLinje = (rest: readonly { usd: number }[]): string[] =>
  rest.length === 0 ? [] : ['', `Plus ${rest.length === 1 ? '1 mindre råd' : `${rest.length} mindre råd`} for i alt ${beloeb(sum(rest, r => r.usd))}.`]

// Rådene som blokke med en tom linje imellem. Uden bjælker (til Claude) følger eksemplerne med.
export const raadTekst = (titel: string, liste: readonly Raad[], visuel = true): string[] => {
  if (liste.length === 0) return [`Ingen råd til ${titel} lige nu.`]
  const stoerst = liste[0]?.usd ?? 0
  const ud = ['**Råd til at bruge færre tokens**', `${titel} · tal = ${maalForklaring()}, du cirka kunne have sparet`]
  for (const r of liste.slice(0, MEST)) {
    ud.push('', ...raadBlok(r, r.hvorfor, stoerst > 0 ? r.usd / stoerst : 0, visuel))
    if (!visuel && r.eksempler.length > 0) ud.push(`Fx ${r.eksempler.join('; ')}`)
  }
  return [...ud, ...restLinje(liste.slice(MEST))]
}
