import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ForbrugGrafik, Graense, KontekstDel } from '../types'
import { afkort, analyser, etiket, kontekstDele, opsummering } from './analyse'
import type { Agent, Kald, Trin } from './analyse'
import { analyserAndet, kodeForbrug, proeverFra, referencePrProcent, vinduer } from './andet'
import type { Andet, Proeve } from './andet'
import { beskrivelsesPrompt, dagTekst, dageTekst, datoNoegle, datoTekst, laesLinje, nySamling, opgaveTekst, projekt, projektTekst, renBeskrivelse, visteOpgaver } from './historik'
import type { HistOpgave, Kilde, Projekt, Samling } from './historik'
import { alleSamtalerTekst, godeRaadTekst, indsigtTekst, MINDST_ANDET, ugedage, ugensSamtalerTekst } from './indsigt'
import type { Resume } from './indsigt'
import { KVARTER, maalKr, median, minutter, saetEnhed, stoerst, ugeEnhed, VINDUER } from './enhed'
import { bjaelkeSvg, brugt, kortNavn, maalerSvgStor, maalerTekst, procentTekst, soejlerSvg, soejlerTekst, vistGraenser } from './grafik'
import type { Maaling } from './enhed'
import {
  ANALYSE_SYSTEM,
  analysePrompt,
  ARBEJDE_SYSTEM,
  arbejdePrompt,
  kaederFra,
  KOMMUNIKATION_SYSTEM,
  kommunikationPrompt,
  MODEL,
  promptsmartTekst,
  punkterFra,
  renPrompt,
} from './promptsmart'
import type { PromptRaad, Rolle } from './promptsmart'
import { beloeb, kortRaad, overheadFra, raad, raadTekst, REGLER } from './raad'
import type { Grundlag, Overhead, Raad } from './raad'

const opgaver = atom({ plugin: 'token-maaler', key: 'opgaver' } as const, [])
const skjult = atom({ plugin: 'token-maaler', key: 'skjult' } as const, false)
const paneVisning = atom({ plugin: 'token-maaler', key: 'paneVisning' } as const, 'projekt')
const paneNr = atom({ plugin: 'token-maaler', key: 'paneNr' } as const, null)
const paneAntal = atom({ plugin: 'token-maaler', key: 'paneAntal' } as const, 0)
const paneLinjer = atom({ plugin: 'token-maaler', key: 'paneLinjer' } as const, [])
const velkomstSkjult = atom({ plugin: 'token-maaler', key: 'velkomstSkjult' } as const, false)
const graenser = atom({ plugin: 'token-maaler', key: 'graenser' } as const, [])
const forbrugGrafik = atom({ plugin: 'token-maaler', key: 'forbrugGrafik' } as const, null)

const PANE = 'token-maaler'
const HISTORIK_VAERKTOEJ = 'mcp__token-maaler__historik'
const FIRE_MB = 4 * 1024 * 1024
// Hver samtales resume i $.store; hæv versionen, når reglerne eller resumeet ændres.
const INDSIGT = 'indsigt:v5:'
const HENTER = 'Samler indsigt fra alle samtaler …'
// Hver samtales Dine prompts-forslag i $.store; hæv versionen, når prompterne til modellerne ændres.
const PROMPTSMART = 'promptsmart:v2:'
// Dine prompts gennemgår de dyreste samtaler, fordi rettelser dér koster mest.
const PROMPTSMART_SAMTALER = 8

// Indstillingerne fra /config (plugin.json `userConfig`); en ændring dér indlæser modulet igen.
type Indstillinger = { velkomst: boolean; baand: boolean; beskeder: boolean; beskrivelser: boolean; promptsmart: boolean }

// Målingerne af abonnementets grænser: listepris pr. procentpoint, de seneste ti pr. vindue. `ref` er
// forholdet i de perioder af kontoens historik, hvor Code brugte det meste (se andet.ts).
const KALIBRERING = 'kalibrering:v1'
type Vindue = keyof typeof VINDUER
type Kalibrering = Partial<Record<Vindue, Maaling[]>> & { ref?: { seven_day?: number; five_hour?: number; t: number } }
let indstillinger: Indstillinger = { velkomst: true, baand: true, beskeder: true, beskrivelser: true, promptsmart: true }

const HISTORIK_BESKRIVELSE =
  "Token usage and cost of this project (this Claude Code session) across its whole history, read from its transcript files: total tokens and cost, every task (each message the user wrote) with its number, day and cost, the active days, and for one task what its cost went to (re-reading the conversation, tool results, thinking, subagents). Use it to answer questions such as 'what did task 7 cost?', 'what did day 2 cost?', 'which tasks were most expensive?' or 'how many days have we worked on this?'. With `alle` it covers all of the user's sessions in all projects instead, including scheduled tasks (marked 'Planlagt') and, when the Claude app's usage history exists, the part of the weekly limit used outside Claude Code (chat, Cowork etc.). Amounts are shown as a share of the user's weekly subscription limit (estimated from their own usage) with Danish kroner in parentheses, or in kroner at list prices before the limits have been measured. Without arguments it returns the project overview and the days."

type Spand = { trin: Trin[]; kald: Kald[]; agenter: Record<string, Agent> }

type Igang = Spand & {
  nr: number
  prompt: string
  start: number
  usdStart: number | null
  ttl: number
  forrigePrompt: number | null
  kontekst: Promise<KontekstDel[]>
}

type Visning = 'projekt' | 'opgave' | 'dage' | 'raad' | 'promptsmart' | 'indsigt'

// Grænserne, som de sidst blev målt, så båndet kan vise dem fra starten af en ny samtale.
const SIDSTE_GRAENSER = 'graenser:sidst'

const forbrug = async ($: EngineInterface) => {
  try {
    const u = await $.session.usage()
    return { usd: u.cost?.usd ?? null, abonnement: u.rateLimits.length > 0 }
  } catch {
    return { usd: null, abonnement: false }
  }
}

const hentKontekst = async ($: EngineInterface): Promise<KontekstDel[]> => {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    return kontekstDele(u.context.breakdown?.categories ?? [])
  } catch {
    return []
  }
}

const laengde = (vaerdi: unknown) => {
  try {
    return JSON.stringify(vaerdi)?.length ?? 0
  } catch {
    return 0
  }
}

// Projektets historik ligger i transcript-filerne under ~/.claude/projects/<projektmappe>/.
const projekter = async ($: EngineInterface) =>
  `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`}/projects`

// Mappen med sessionens transcript; ellers projektmappen for sessionens arbejdsmappe.
const projektMappe = async ($: EngineInterface, id: string): Promise<string | null> => {
  const rod = await projekter($)
  const egen = `${rod}/${(await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')}`
  if (await $.fs.exists(`${egen}/${id}.jsonl`)) return egen
  for (const m of await $.fs.list(rod).catch(() => [])) {
    if (m.kind === 'dir' && (await $.fs.exists(`${rod}/${m.name}/${id}.jsonl`))) return `${rod}/${m.name}`
  }
  return (await $.fs.exists(egen)) ? egen : null
}

const jsonlFiler = async ($: EngineInterface, mappe: string): Promise<string[]> => {
  const filer: string[] = []
  for (const e of await $.fs.list(mappe).catch(() => [])) {
    if (e.kind === 'dir') filer.push(...(await jsonlFiler($, `${mappe}/${e.name}`)))
    else if (e.kind === 'file' && e.name.endsWith('.jsonl')) filer.push(`${mappe}/${e.name}`)
  }
  return filer
}

// Små filer læses direkte; store (op til 80 MB) strømmes gennem cat, fordi $.fs.read stopper ved 4 MB.
const hverLinje = async ($: EngineInterface, sti: string, stoerrelse: number, hver: (linje: string) => void) => {
  if (stoerrelse < FIRE_MB) {
    const tekst = await $.fs.read(sti)
    if (typeof tekst === 'string') for (const linje of tekst.split('\n')) hver(linje)
    return
  }
  let rest = ''
  for await (const stykke of $.process.spawn({ argv: ['cat', sti] })) {
    if (stykke.stream !== 'stdout') continue
    const dele = (rest + stykke.text).split('\n')
    rest = dele.pop() ?? ''
    for (const linje of dele) hver(linje)
  }
  if (rest) hver(rest)
}

const findAgenter = async ($: EngineInterface, mappe: string, soeg: string) => {
  const fundne: { id: string; titel: string }[] = []
  for (const e of await $.fs.list(mappe).catch(() => [])) {
    if (e.kind !== 'dir') continue
    try {
      const raa = await $.fs.read(`${mappe}/${e.name}/custom-title.json`)
      const titel: unknown = typeof raa === 'string' ? JSON.parse(raa)?.customTitle : undefined
      if (typeof titel === 'string' && titel.toLowerCase().includes(soeg.toLowerCase())) fundne.push({ id: e.name, titel })
    } catch {
      // Sessionen har ingen titel.
    }
  }
  return fundne
}

const cache = new Map<string, { stoerrelse: number; mtimeMs: number; samling: Samling }>()

// `husk` gemmer filen i hukommelsen til næste gang; det gør kun den aktive sessions filer.
const samlingFor = async ($: EngineInterface, sti: string, kilde: Kilde, husk = true, session = ''): Promise<Samling> => {
  const stat = await $.fs.stat(sti)
  const gemt = cache.get(sti)
  if (gemt && gemt.stoerrelse === stat.size && gemt.mtimeMs === stat.mtimeMs) return gemt.samling
  const samling = nySamling(kilde, session)
  await hverLinje($, sti, stat.size, linje => laesLinje(samling, linje))
  if (husk) cache.set(sti, { stoerrelse: stat.size, mtimeMs: stat.mtimeMs, samling })
  return samling
}

// En subagents beskrivelse og type står i en fil ved siden af dens transcript.
const kildeFor = async ($: EngineInterface, fil: string): Promise<Kilde> => {
  const id = (fil.split('/').pop() ?? '').replace(/^agent-/, '').replace(/\.jsonl$/, '')
  try {
    const raa = await $.fs.read(fil.replace(/\.jsonl$/, '.meta.json'))
    const meta = (typeof raa === 'string' ? JSON.parse(raa) : null) as { description?: unknown; agentType?: unknown } | null
    return {
      id,
      beskrivelse: typeof meta?.description === 'string' ? meta.description : '',
      type: typeof meta?.agentType === 'string' ? meta.agentType : '',
    }
  } catch {
    return { id, beskrivelse: '', type: '' }
  }
}

// Én sessions historik: hovedsamtalen og alle dens subagenter.
const laesSession = async ($: EngineInterface, mappe: string, id: string, husk = true): Promise<Projekt | null> => {
  const hovedfil = `${mappe}/${id}.jsonl`
  if (!(await $.fs.exists(hovedfil))) return null
  const samlinger = [await samlingFor($, hovedfil, { id: '', beskrivelse: '', type: '' }, husk, id)]
  for (const fil of await jsonlFiler($, `${mappe}/${id}/subagents`)) samlinger.push(await samlingFor($, fil, await kildeFor($, fil), husk))
  return { ...projekt(samlinger), id }
}

// Projektets historik: denne session, eller den session i projektmappen, hvis titel indeholder `soeg`.
const hentProjekt = async ($: EngineInterface, soeg: string): Promise<Projekt | string> => {
  try {
    const egen = await $.session.id()
    const mappe = await projektMappe($, egen)
    if (!mappe) return 'Fandt ikke projektets transcript.'
    let valgt = { id: egen, titel: '' }
    if (soeg) {
      const fundne = await findAgenter($, mappe, soeg)
      const [fundet] = fundne
      if (!fundet) return `Ingen session i projektmappen har "${soeg}" i titlen.`
      if (fundne.length > 1) {
        return [`${fundne.length} sessioner passer på "${soeg}":`, ...fundne.map(f => `  ${f.titel}`), 'Skriv mere af titlen.'].join('\n')
      }
      valgt = fundet
    }
    const p = await laesSession($, mappe, valgt.id)
    if (!p) return 'Ingen historik endnu: projektets transcript er tomt.'
    return { ...p, titel: p.titel || valgt.titel }
  } catch (fejl) {
    return `Kunne ikke læse historikken: ${fejl instanceof Error ? fejl.message : String(fejl)}`
  }
}

// Konteksten ved start måles kun live; den hentes fra den målte opgave med samme besked og tid.
const kontekstFor = async ($: EngineInterface, p: Projekt, nr: number): Promise<KontekstDel[]> => {
  const o = p.opgaver.find(x => x.nr === nr)
  if (!o) return []
  const live = (await read($, opgaver)).filter(x => typeof x.start === 'number' && x.prompt === o.tekst && Math.abs(x.start - o.t) < 10 * 60_000)
  return live.at(-1)?.kontekst ?? []
}

const BESKRIV_SYSTEM = 'Du skriver korte, konkrete beskrivelser af arbejde, som en AI-assistent har udført. Svar kun med beskrivelsen.'

// Hvad Claude udførte i hver opgave, skrevet af Haiku og gemt mellem sessioner. Nøglen tæller
// opgavens kald med, så en opgave, der stadig vokser, får en ny beskrivelse næste gang.
const beskriv = async ($: EngineInterface, p: Projekt, liste: readonly HistOpgave[]): Promise<Map<number, string>> => {
  if (!indstillinger.beskrivelser) return new Map()
  const par = await Promise.all(
    liste.map(async (o): Promise<[number, string] | null> => {
      const noegle = `beskrivelse:v2:${p.id}:${o.t}:${o.kald}`
      try {
        const gemt = await $.store.get(noegle)
        if (typeof gemt === 'string') return [o.nr, gemt]
        const svar = await $.model.complete({ model: 'haiku', system: BESKRIV_SYSTEM, prompt: beskrivelsesPrompt(o), maxTokens: 100, timeoutMs: 30_000 })
        const tekst = svar.isAnswered ? renBeskrivelse(svar.text) : ''
        if (!tekst) return null
        await $.store.set(noegle, tekst)
        return [o.nr, tekst]
      } catch {
        return null
      }
    }),
  )
  return new Map(par.filter((x): x is [number, string] => x !== null))
}

// Det faste overhead i hver runde: indlæste MCP-værktøjer og plugins' skills (kun for den aktive session).
const hentOverhead = async ($: EngineInterface): Promise<Overhead | null> => {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    return b ? overheadFra(b.mcpTools, b.skills?.skillFrontmatter ?? []) : null
  } catch {
    return null
  }
}

// Analytikerens grundlag: hver opgave med sin analyse, og overhead når projektet er den aktive session.
const raadFor = async ($: EngineInterface, p: Projekt): Promise<Raad[]> => {
  const grundlag: Grundlag = {
    projekt: p,
    opgaver: p.opgaver.map(o => ({ o, a: analyser(o.raa) })),
    overhead: p.id === (await $.session.id()) ? await hentOverhead($) : null,
  }
  return raad(grundlag)
}

// Alle samtaler i alle projektmapper, med det, der skal til for at se, om de har ændret sig.
const alleSessioner = async ($: EngineInterface) => {
  const rod = await projekter($)
  const fundne: { mappe: string; id: string; size: number; mtimeMs: number }[] = []
  for (const m of await $.fs.list(rod).catch(() => [])) {
    if (m.kind !== 'dir') continue
    for (const f of await $.fs.list(`${rod}/${m.name}`).catch(() => [])) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl')) fundne.push({ mappe: `${rod}/${m.name}`, id: f.name.slice(0, -6), size: f.size, mtimeMs: f.mtimeMs })
    }
  }
  return fundne
}

// Størrelse og tid på alle en mappes .jsonl-filer, også i undermapper.
const filSpor = async ($: EngineInterface, mappe: string): Promise<{ size: number; mtimeMs: number }[]> => {
  const spor: { size: number; mtimeMs: number }[] = []
  for (const e of await $.fs.list(mappe).catch(() => [])) {
    if (e.kind === 'dir') spor.push(...(await filSpor($, `${mappe}/${e.name}`)))
    else if (e.kind === 'file' && e.name.endsWith('.jsonl')) spor.push({ size: e.size, mtimeMs: e.mtimeMs })
  }
  return spor
}

const titelFra = async ($: EngineInterface, mappe: string, id: string) => {
  try {
    const raa = await $.fs.read(`${mappe}/${id}/custom-title.json`)
    const titel: unknown = typeof raa === 'string' ? JSON.parse(raa)?.customTitle : undefined
    return typeof titel === 'string' ? titel : ''
  } catch {
    return ''
  }
}

type Session = Awaited<ReturnType<typeof alleSessioner>>[number]

// En samtales filer i én streng: antal, samlet størrelse og seneste ændring af hovedfilen og subagenterne.
const filSignatur = async ($: EngineInterface, s: Session): Promise<string> => {
  const spor = [s, ...(await filSpor($, `${s.mappe}/${s.id}/subagents`))]
  return `${spor.length}:${spor.reduce((n, f) => n + f.size, 0)}:${Math.max(...spor.map(f => f.mtimeMs))}`
}

// En samtales resume: læses kun igen, når en af dens filer har ændret sig.
const resumeFor = async ($: EngineInterface, s: Session, egen: string): Promise<Resume | null> => {
  const signatur = await filSignatur($, s)
  const noegle = `${INDSIGT}${s.id}`
  const gemt = (await $.store.get(noegle)) as { signatur?: unknown; resume?: Resume } | undefined
  if (gemt?.signatur === signatur && gemt.resume) return gemt.resume
  const p = await laesSession($, s.mappe, s.id, s.id === egen)
  if (!p) return null
  const liste = raad({ projekt: p, opgaver: p.opgaver.map(o => ({ o, a: analyser(o.raa) })), overhead: null })
  const resume: Resume = {
    id: s.id,
    titel: p.titel || (await titelFra($, s.mappe, s.id)) || p.opgaver[0]?.tekst || 'Uden titel',
    usd: p.usd,
    dage: p.dage.map(d => d.dato),
    kvarterer: p.kvarterer,
    ...(p.planlagt && { planlagt: p.planlagt }),
    raad: liste.map(r => ({ id: r.id, navn: r.navn, handling: r.handling, kort: r.kort, usd: r.usd })),
  }
  await $.store.set(noegle, { signatur, resume })
  return resume
}

// Alle samtaler med deres resume; en ulæselig samtale springes over.
const alleResumeer = async ($: EngineInterface): Promise<{ s: Session; r: Resume }[]> => {
  const egen = await $.session.id()
  const ud: { s: Session; r: Resume }[] = []
  for (const s of await alleSessioner($)) {
    const r = await resumeFor($, s, egen).catch(() => null)
    if (r) ud.push({ s, r })
  }
  return ud
}

// Resumeerne for de samtaler, der har kostet noget.
const samlResumeer = async ($: EngineInterface): Promise<Resume[]> =>
  (await alleResumeer($)).flatMap(({ r }) => (r.usd > 0 ? [r] : []))

// Nøgler i $.store fra ældre versioner af mod'en, som intet læser længere.
const FORAELDET = (k: string) =>
  (k.startsWith('indsigt:') && !k.startsWith(INDSIGT)) ||
  (k.startsWith('promptsmart:') && !k.startsWith(PROMPTSMART)) ||
  (k.startsWith('beskrivelse:') && !k.startsWith('beskrivelse:v2:')) ||
  k.startsWith('raad-vist:')

const rydOp = async ($: EngineInterface) => {
  for (const k of await $.store.keys()) if (FORAELDET(k)) await $.store.delete(k)
}

// Rådet om forbrug uden for Code: når mindst en fjerdedel af ugens grænse gik til chat, Cowork m.m. De
// lange samtaler dér læser hele historikken igen i hver runde, så det er skønnet til en fjerdedel.
const andetRaad = (andet: Andet | null): Raad[] => {
  if (!andet || andet.ugeP < 20 || andet.uge < MINDST_ANDET || andet.uge / andet.ugeP < 0.25) return []
  const usd = andet.uge * andet.prProcent
  return [
    {
      id: 'andet',
      navn: 'Chat og Cowork',
      hvorfor: `Ca. ${maalKr(usd)} gik til chat, Cowork m.m. uden for Code.`,
      handling: 'Start en ny chat til nye emner, og vælg en mindre model til lette spørgsmål.',
      kort: 'Chat og Cowork',
      usd: usd / 4,
      eksempler: [],
      antal: 'hele kontoen',
    },
  ]
}

// Forbindelser og plugins kendes kun for denne session, men følger med i alle nye samtaler. Forbrug uden
// for Code kendes kun på kontoen.
const ekstraRaad = async ($: EngineInterface, andet: Andet | null): Promise<Raad[]> => {
  const p = await hentProjekt($, '')
  return [
    ...(typeof p === 'string'
      ? []
      : raad(
          { projekt: p, opgaver: p.opgaver.map(o => ({ o, a: analyser(o.raa) })), overhead: await hentOverhead($) },
          REGLER.filter(r => r.id === 'overhead'),
        )),
    ...andetRaad(andet),
  ]
}

const indsigtFor = async ($: EngineInterface, visuel: boolean): Promise<string[]> => {
  try {
    const resumeer = await samlResumeer($)
    const andet = await andetFor($, resumeer)
    return indsigtTekst(resumeer, await ekstraRaad($, andet), visuel, andet)
  } catch (fejl) {
    return [`Kunne ikke samle indsigten: ${fejl instanceof Error ? fejl.message : String(fejl)}`]
  }
}

// Ét modelkald i Dine prompts med den model og effort, rollen har.
const spoerg = async ($: EngineInterface, rolle: Rolle, system: string, prompt: string): Promise<string> => {
  const indstilling = {
    analyse: { effort: 'high', maxTokens: 8_000, timeoutMs: 240_000 },
    arbejde: { effort: 'medium', maxTokens: 2_000, timeoutMs: 120_000 },
    kommunikation: { effort: 'low', maxTokens: 800, timeoutMs: 60_000 },
  } as const
  const svar = await $.model.complete({ model: MODEL[rolle], system, prompt, ...indstilling[rolle] })
  if (svar.isAnswered) return svar.text
  throw new ModelFejl(`${MODEL[rolle]}: ${svar.reason === 'api-error' ? `${svar.error ?? 'API-fejl'}` : svar.reason}`)
}

// Et modelkald uden svar; samtalen gemmes så ikke, og grunden vises under resultatet.
class ModelFejl extends Error {}

type Fremgang = { samtaler: number; analyseret: number; skrevet: number; klargjort: number }

type GemtPromptsmart = { signatur?: unknown; fil?: unknown; raad?: PromptRaad[] }

// Én samtale gennem alle tre modeller. Forslagene gemmes, til samtalen får nye beskeder: er filerne
// uændrede, læses samtalen slet ikke; har den kun fået andet end nye beskeder, genbruges forslagene.
const promptsmartSamtale = async ($: EngineInterface, s: Session, egen: string, fremgang: Fremgang, vis: () => Promise<void>): Promise<PromptRaad[]> => {
  const noegle = `${PROMPTSMART}${s.id}`
  const fil = await filSignatur($, s)
  const gemt = (await $.store.get(noegle)) as GemtPromptsmart | undefined
  const genbrug = async (raad: PromptRaad[]) => {
    fremgang.analyseret += 1
    fremgang.klargjort += 1
    await vis()
    return raad
  }
  if (gemt?.fil === fil && Array.isArray(gemt.raad)) return genbrug(gemt.raad)
  const laest = await laesSession($, s.mappe, s.id, s.id === egen)
  if (!laest) return genbrug([])
  const p = { ...laest, titel: laest.titel || (await titelFra($, s.mappe, s.id)) }
  const signatur = `${p.opgaver.length}:${p.opgaver.at(-1)?.t ?? 0}`
  if (gemt?.signatur === signatur && Array.isArray(gemt.raad)) {
    await $.store.set(noegle, { ...gemt, fil })
    return genbrug(gemt.raad)
  }
  const titel = p.titel || p.opgaver[0]?.tekst || 'Uden titel'
  const kaeder = kaederFra(await spoerg($, 'analyse', ANALYSE_SYSTEM, analysePrompt(titel, p.opgaver)), p.opgaver)
  // Et svar uden en læsbar liste (fx skåret af) er en fejl, ikke "intet at forbedre".
  if (kaeder === null) throw new ModelFejl(`${MODEL.analyse}: svaret kunne ikke læses`)
  fremgang.analyseret += 1
  await vis()
  const fuld = (nr: number) => p.opgaver.find(o => o.nr === nr)?.fuld ?? ''
  const forslag = await Promise.all(
    kaeder.map(async k => {
      const proev = renPrompt(
        await spoerg($, 'arbejde', ARBEJDE_SYSTEM, arbejdePrompt(fuld(k.start), k.rettelser.map(fuld), k)).catch(() => ''),
      )
      fremgang.skrevet += 1
      await vis()
      return { k, proev }
    }),
  )
  const brugbare = forslag.filter(f => f.proev !== '')
  const punkter = brugbare.length
    ? punkterFra(
        await spoerg($, 'kommunikation', KOMMUNIKATION_SYSTEM, kommunikationPrompt(brugbare.map(f => ({ foerste: fuld(f.k.start), manglede: f.k.manglede })))).catch(
          () => '',
        ),
        brugbare.length,
      )
    : []
  const raad = brugbare.map(({ k, proev }, i): PromptRaad => ({
    samtale: titel,
    navn: punkter[i]?.navn ?? afkort(fuld(k.start), 30),
    manglede: punkter[i]?.manglede ?? k.manglede,
    skrev: fuld(k.start),
    proev,
    usd: p.opgaver.filter(o => k.rettelser.includes(o.nr)).reduce((n, o) => n + o.usd, 0),
  }))
  fremgang.klargjort += 1
  await vis()
  // Kun en hel gennemgang gemmes; manglede en prompt eller en forklaring, prøves samtalen igen næste gang.
  if (brugbare.length === kaeder.length && punkter.every(Boolean)) await $.store.set(noegle, { signatur, fil, raad })
  return raad
}

let promptsmartIgang: Promise<string[]> | null = null
// Alle, der venter på den igangværende gennemgang, og den seneste fremgang, så en, der kommer til
// undervejs (fx panelet efter /prompts), også ser fremgangen.
const promptsmartLyttere = new Set<(linjer: string[]) => Promise<void>>()
let promptsmartFremgang: string[] = []

// Dine prompts på tværs af de dyreste samtaler. `vis` får fremgangen, mens modellerne arbejder.
const promptsmartFor = async ($: EngineInterface, visuel: boolean, vis?: (linjer: string[]) => Promise<void>): Promise<string[]> => {
  if (vis) {
    promptsmartLyttere.add(vis)
    if (promptsmartIgang && promptsmartFremgang.length) await vis(promptsmartFremgang)
  }
  promptsmartIgang ??= (async () => {
    try {
      const egen = await $.session.id()
      const valgte = (await alleResumeer($))
        .filter(({ r }) => r.usd > 0 && !r.planlagt)
        .sort((a, b) => b.r.usd - a.r.usd)
        .slice(0, PROMPTSMART_SAMTALER)
      const fremgang: Fremgang = { samtaler: valgte.length, analyseret: 0, skrevet: 0, klargjort: 0 }
      const visFremgang = async () => {
        promptsmartFremgang = [
          '**Dine prompts**',
          `Analyserer: ${fremgang.analyseret} af ${fremgang.samtaler} samtaler`,
          `Forklarer: ${fremgang.skrevet === 1 ? '1 prompt' : `${fremgang.skrevet} prompts`}`,
          `Færdiggør: ${fremgang.klargjort} af ${fremgang.samtaler} samtaler`,
        ]
        for (const lytter of [...promptsmartLyttere]) await lytter(promptsmartFremgang).catch(() => {})
      }
      await visFremgang()
      const fejl: string[] = []
      const alle = await Promise.all(
        valgte.map(async ({ s }) => {
          try {
            return await promptsmartSamtale($, s, egen, fremgang, visFremgang)
          } catch (f) {
            fejl.push(f instanceof Error ? f.message : String(f))
            return []
          }
        }),
      )
      if (fejl.length === valgte.length && fejl.length > 0) return [`Kunne ikke gennemgå dine prompts (${fejl[0]}). Prøv igen om lidt.`]
      const linjer = promptsmartTekst(alle.flat(), valgte.length - fejl.length, visuel)
      return fejl.length ? [...linjer, `${fejl.length === 1 ? '1 samtale' : `${fejl.length} samtaler`} kunne ikke gennemgås (${fejl[0]}).`] : linjer
    } catch (fejl) {
      return [`Kunne ikke gennemgå dine prompts: ${fejl instanceof Error ? fejl.message : String(fejl)}`]
    } finally {
      promptsmartIgang = null
      promptsmartFremgang = []
    }
  })()
  try {
    return await promptsmartIgang
  } finally {
    if (vis) promptsmartLyttere.delete(vis)
  }
}

const tekstFor = async ($: EngineInterface, p: Projekt, visning: Visning | 'dag', nr: number | null, visuel: boolean) => {
  if (visning === 'raad') return raadTekst(p.titel || 'dette projekt', await raadFor($, p), visuel)
  if (visning === 'opgave' && nr !== null) {
    const opgave = p.opgaver.filter(o => o.nr === nr)
    return opgaveTekst(p, nr, visuel, { kontekst: await kontekstFor($, p, nr) }, await beskriv($, p, opgave))
  }
  if (visning === 'dag' && nr !== null) {
    const dyreste = p.dage.find(d => d.nr === nr)?.dyreste ?? []
    return dagTekst(p, nr, visuel, await beskriv($, p, p.opgaver.filter(o => dyreste.some(x => x.nr === o.nr))))
  }
  if (visning === 'dage') return dageTekst(p, visuel)
  const [stoerst] = await raadFor($, p)
  const raadLinje = stoerst ? `Største råd: ${kortRaad(stoerst)} (ca. ${beloeb(stoerst.usd)}) · /tokens råd` : ''
  return projektTekst(p, visuel, await beskriv($, p, visteOpgaver(p)), raadLinje)
}

// Ugens grænse, som den sidst blev målt: i denne session, ellers fra en tidligere.
const ugensGraense = async ($: EngineInterface): Promise<Graense | undefined> => {
  const kendte = await read($, graenser)
  const gemte = kendte.length ? kendte : ((await $.store.get(SIDSTE_GRAENSER)) as Graense[] | undefined) ?? []
  return gemte.find(g => g.kind === 'seven_day')
}

// Claude-appen gemmer kontoens procent af 5-timersgrænsen og ugens grænse hvert kvarter i 30 dage.
// Filen findes kun, hvor appen er installeret, og læses kun igen, når den har ændret sig.
const HISTORIK_FIL = 'plan-usage-history.json'
let proeverHusk: { sti: string; signatur: string; proever: Proeve[] } | null = null

const laesProever = async ($: EngineInterface): Promise<Proeve[]> => {
  const hjem = (await $.env.get('HOME')) ?? ''
  const appdata = await $.env.get('APPDATA')
  const xdg = (await $.env.get('XDG_CONFIG_HOME')) ?? `${hjem}/.config`
  const stier = [`${hjem}/Library/Application Support/Claude/${HISTORIK_FIL}`, ...(appdata ? [`${appdata}/Claude/${HISTORIK_FIL}`] : []), `${xdg}/Claude/${HISTORIK_FIL}`]
  for (const sti of stier) {
    try {
      const stat = await $.fs.stat(sti)
      if (stat.kind !== 'file') continue
      const signatur = `${stat.size}:${stat.mtimeMs}`
      if (proeverHusk?.sti === sti && proeverHusk.signatur === signatur) return proeverHusk.proever
      const raa = await $.fs.read(sti)
      const proever = typeof raa === 'string' ? proeverFra(raa) : []
      proeverHusk = { sti, signatur, proever }
      return proever
    } catch {
      // Prøv næste sted.
    }
  }
  return []
}

// Hvor mange dollars listepris ét procentpoint svarer til, når Code er det eneste, der bruger, målt i de
// perioder af historikken, hvor Code brugte det meste. Chat og Cowork sænker forholdet i andre perioder.
const referenceFor = async ($: EngineInterface, resumeer: readonly Resume[]): Promise<{ seven_day?: number; five_hour?: number } | null> => {
  const proever = await laesProever($)
  if (proever.length === 0) return null
  const kode = kodeForbrug(resumeer.map(r => r.kvarterer))
  const uge = referencePrProcent(vinduer(proever, 'sd'), kode) ?? undefined
  const fem = referencePrProcent(vinduer(proever, 'fh'), kode) ?? undefined
  return uge === undefined && fem === undefined ? null : { ...(uge !== undefined && { seven_day: uge }), ...(fem !== undefined && { five_hour: fem }) }
}

// Forbrug uden for Code (chat, Cowork m.m.): kontoens procent mod det, Code kan forklare.
const andetFor = async ($: EngineInterface, resumeer: readonly Resume[]): Promise<Andet | null> => {
  try {
    const c = ugeEnhed()
    if (!c) return null
    const proever = await laesProever($)
    if (proever.length === 0) return null
    const nu = await $.clock.now()
    const g = await ugensGraense($)
    const nulstilles = Date.parse(g?.resetsAt ?? '')
    const live = g && !Number.isNaN(nulstilles) && nulstilles > nu ? { p: brugt(g, nu), fra: nulstilles - VINDUER.seven_day.ms } : undefined
    return analyserAndet(proever, kodeForbrug(resumeer.map(r => r.kvarterer)), c, nu, live)
  } catch {
    return null
  }
}

// Ugen, som ugens grænse tæller den: fra grænsen sidst blev nulstillet til nu, ellers de seneste
// 7 dage. Forbruget pr. samtale i den uge.
const ugen = async ($: EngineInterface, resumeer: readonly Resume[]): Promise<{ periode: string; samtaler: { titel: string; usd: number }[] }> => {
  const nu = await $.clock.now()
  const nulstilles = Date.parse((await ugensGraense($))?.resetsAt ?? '')
  const start = nulstilles - VINDUER.seven_day.ms
  const iVinduet = !Number.isNaN(nulstilles) && nulstilles > nu && start <= nu
  const fra = iVinduet ? start : nu - VINDUER.seven_day.ms
  const periode = !iVinduet ? 'de seneste 7 dage' : `siden ${datoTekst(datoNoegle(fra)).split(' ')[0] ?? ''} kl. ${klokken(fra)}`
  const fraKvarter = Math.floor(fra / KVARTER)
  const samtaler: { titel: string; usd: number }[] = []
  // Kørsler af den samme planlagte opgave lægges sammen: en opgave, der kører hver dag, er ét forbrug.
  const planlagte = new Map<string, { usd: number; koersler: number }>()
  for (const r of resumeer) {
    const usd = Object.entries(r.kvarterer ?? {}).reduce((n, [k, v]) => (Number(k) >= fraKvarter ? n + v : n), 0)
    if (usd <= 0) continue
    if (r.planlagt) {
      const p = planlagte.get(r.planlagt) ?? { usd: 0, koersler: 0 }
      planlagte.set(r.planlagt, { usd: p.usd + usd, koersler: p.koersler + 1 })
    } else samtaler.push({ titel: r.titel, usd })
  }
  for (const [navn, p] of planlagte) samtaler.push({ titel: `Planlagt: ${navn} · ${p.koersler === 1 ? '1 kørsel' : `${p.koersler} kørsler`}`, usd: p.usd })
  return { periode, samtaler }
}

const klokken = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Indsigt på tværs af alle samtaler: ugedagene som graf, så alle samtaler, ugens dyreste samtaler
// og gode råd.
const indsigtVisning = async ($: EngineInterface, visuel = true): Promise<{ grafik: ForbrugGrafik; linjer: string[] }> => {
  try {
    const resumeer = await samlResumeer($)
    const { periode, samtaler } = await ugen($, resumeer)
    const nu = await $.clock.now()
    const andet = await andetFor($, resumeer)
    return {
      grafik: { dage: ugedage(resumeer, nu) },
      linjer: [
        ...alleSamtalerTekst(resumeer, andet),
        '',
        ...ugensSamtalerTekst(samtaler, periode, visuel, andet, nu),
        '',
        ...godeRaadTekst(resumeer, await ekstraRaad($, andet), visuel),
      ],
    }
  } catch (fejl) {
    return { grafik: { dage: [] }, linjer: [`Kunne ikke samle indsigten: ${fejl instanceof Error ? fejl.message : String(fejl)}`] }
  }
}

const UGEDAGE_OVERSKRIFT = 'Dit gennemsnitlige totale forbrug fordelt henover dage på ugen'

// Indsigt som tekst, til terminalen og /tokens indsigt.
const forbrugTekst = async ($: EngineInterface): Promise<string[]> => {
  const { grafik, linjer } = await indsigtVisning($)
  const g = await read($, graenser)
  const nu = await $.clock.now()
  return [
    '**Indsigt**',
    vistGraenser(g).length ? maalerTekst(g, nu) : 'Grænserne vises, når Claude har svaret første gang.',
    '',
    `**${UGEDAGE_OVERSKRIFT}**`,
    ...soejlerTekst(grafik.dage),
    '',
    ...linjer,
  ]
}

// Skriver linjerne i panelet, men kun hvis det stadig viser `visning`: har brugeren skiftet visning,
// mens en langsom beregning kørte, må resultatet ikke overskrive den nye.
const visHvis = async ($: EngineInterface, visning: Visning, linjer: string[]) => {
  if ((await read($, paneVisning)) === visning) await update($, paneLinjer, () => linjer)
}

// Panelet viser samme tekst som kommandoerne; den beregnes, når en knap trykkes.
const visPanel = async ($: EngineInterface, visning: Visning, nr: number | null) => {
  // Indsigt: målerne og ugedagene øverst, så alle samtaler, ugens dyreste samtaler og gode råd.
  if (visning === 'indsigt') {
    await update($, paneVisning, () => visning)
    // Første gang tager det nogle sekunder at læse alle samtaler; så længe står der, at den henter.
    await update($, paneLinjer, () => [HENTER])
    const { grafik, linjer } = await indsigtVisning($)
    if ((await read($, paneVisning)) !== visning) return
    await update($, forbrugGrafik, () => grafik)
    await update($, paneLinjer, () => linjer)
    return
  }
  if (visning === 'promptsmart') {
    await update($, paneVisning, () => visning)
    const linjer = await promptsmartFor($, true, l => visHvis($, visning, l))
    await visHvis($, visning, linjer)
    return
  }
  const p = await hentProjekt($, '')
  const valgt = typeof p === 'string' ? null : visning === 'opgave' ? (nr ?? p.opgaver.at(-1)?.nr ?? null) : null
  const linjer = typeof p === 'string' ? [p] : await tekstFor($, p, visning, valgt, true)
  await update($, paneLinjer, () => linjer)
  await update($, paneVisning, () => visning)
  await update($, paneNr, () => valgt)
  await update($, paneAntal, () => (typeof p === 'string' ? 0 : p.opgaver.length))
}

const aabnPanel = async ($: EngineInterface, kommando: string) => {
  const aabnet = await $.ui.open({ id: PANE, title: 'Token-forbrug' })
  if (!aabnet.isPlaced) $.ui.toast(`Panelet kan ikke vises her. Skriv ${kommando}.`)
}

// Panelet åbnes med det samme og fyldes, når indsigten er samlet.
const visIndsigt = async ($: EngineInterface) => {
  const klar = visPanel($, 'indsigt', null)
  await aabnPanel($, '/tokens indsigt')
  await klar
}

const visPromptsmart = async ($: EngineInterface) => {
  const klar = visPanel($, 'promptsmart', null)
  await aabnPanel($, '/tokens prompts')
  await klar
}

// Om grænsernes målinger er læst ind i dette indlæste modul; en ny indlæsning (fx efter /config)
// nulstiller dem, og session.start kommer ikke igen.
let enhedIndlaest = false

// Hvor mange dollars listepris ét procentpoint svarer til: det, der blev målt i sessionerne, eller når
// kontoens historik viser et højere tal, det (så chat og Cowork ikke gør Codes forbrug dyrere, end det er).
const indlaesEnhed = async ($: EngineInterface) => {
  const k = ((await $.store.get(KALIBRERING)) ?? {}) as Kalibrering
  saetEnhed({ uge: stoerst(median(k.seven_day ?? []), k.ref?.seven_day), fem: stoerst(median(k.five_hour ?? []), k.ref?.five_hour) })
  enhedIndlaest = true
}

const sikrEnhed = async ($: EngineInterface) => {
  if (!enhedIndlaest) await indlaesEnhed($).catch(() => {})
}

const erVindue = (kind: string): kind is Vindue => kind in VINDUER

let sidstKalibreret = -Infinity

// Grænsernes procent sammenholdt med forbruget i alle transcripts siden vinduets start: så meget
// listepris svarer ét procentpoint til. Højst hvert tiende minut, og kun når procenten er høj nok.
const kalibrer = async ($: EngineInterface, graenser: readonly Graense[]) => {
  try {
    const nu = await $.clock.now()
    const brugbare = graenser.filter(g => erVindue(g.kind) && g.resetsAt !== undefined && g.percentUsed >= VINDUER[g.kind].mindst)
    if (brugbare.length === 0 || nu - sidstKalibreret < 10 * 60_000) return
    sidstKalibreret = nu
    const resumeer = (await alleResumeer($)).map(({ r }) => r)
    const k = ((await $.store.get(KALIBRERING)) ?? {}) as Kalibrering
    for (const g of brugbare) {
      if (!erVindue(g.kind)) continue
      const start = Math.floor((Date.parse(g.resetsAt ?? '') - VINDUER[g.kind].ms) / KVARTER)
      if (Number.isNaN(start)) continue
      let usd = 0
      for (const r of resumeer) for (const [n, v] of Object.entries(r.kvarterer ?? {})) if (Number(n) >= start) usd += v
      if (usd > 0) k[g.kind] = [...(k[g.kind] ?? []), { t: nu, usdPrProcent: usd / g.percentUsed }].slice(-10)
    }
    const ref = await referenceFor($, resumeer)
    if (ref) k.ref = { ...ref, t: nu }
    await $.store.set(KALIBRERING, k)
    await indlaesEnhed($)
  } catch {
    // Uden en måling vises kroner.
  }
}

// Lidt efter sessionens start ryddes gamle nøgler op og samles resumeerne, så Indsigt svarer med
// det samme. Det kører i baggrunden, så ingen fejl må slippe ud.
const forvarm = async ($: EngineInterface) => {
  try {
    await rydOp($)
    await samlResumeer($)
    await kalibrer($, (await $.session.usage()).rateLimits)
  } catch {
    // Indsigt samler resumeerne selv, når den åbnes.
  }
}

export const register: Register = (on, options) => {
  indstillinger = {
    velkomst: options.velkomst !== false,
    baand: options.baand !== false,
    beskeder: options.beskeder !== false,
    beskrivelser: options.beskrivelser !== false,
    promptsmart: options.promptsmart !== false,
  }
  saetEnhed({ kurs: typeof options.kurs === 'number' && options.kurs > 0 ? options.kurs : 6.5, uge: null, fem: null })
  enhedIndlaest = false
  let aktiv: Igang | null = null
  // Subagenter i baggrunden kan blive færdige mellem to opgaver; deres forbrug går til den næste.
  let ventende: Spand = { trin: [], kald: [], agenter: {} }
  let forrigePrompt: number | null = null
  const sidsteTrin = new Map<string, number>()
  const kendteAgenter = new Map<string, Agent>()

  const spand = (): Spand => aktiv ?? ventende

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Projektet: /tokens · én opgave: /tokens <nr> · dage: /tokens dage · råd: /tokens råd · alle samtaler: /tokens råd alle · dine prompts: /tokens prompts',
    })
    if (indstillinger.promptsmart) {
      await $.command.register({ name: 'prompts', description: 'Bedre første prompts ud fra det, du endte med at ville have (Opus analyserer, Sonnet skriver, Haiku forklarer)' })
    }
    try {
      await $.tool.register({
        name: 'historik',
        description: HISTORIK_BESKRIVELSE,
        inputSchema: {
          type: 'object',
          properties: {
            opgave: { type: 'integer', minimum: 1, description: 'A task number, for what that task cost and what the cost went to.' },
            dag: { type: 'integer', minimum: 1, description: 'An active day number (1 = the first active day), for that day in detail.' },
            agent: { type: 'string', description: "Part of another session's title in the same project folder, to look at that session instead." },
            raad: { type: 'boolean', description: 'True for advice on how to use fewer tokens, each with an estimated saving and what to do.' },
            alle: {
              type: 'boolean',
              description: "True for insight across all of the user's sessions in all projects: total cost, the most expensive sessions and advice across them.",
            },
          },
        },
      })
    } catch {
      // Uden plugin-værktøjer virker kommandoen stadig.
    }
    await indlaesEnhed($)
    const gemte = await $.store.get(SIDSTE_GRAENSER)
    if (Array.isArray(gemte)) await update($, graenser, () => gemte as Graense[])
    $.clock.after(20_000, () => void forvarm($))
    return next(e)
  })

  // Når en grænse flytter sig, måles den igen lidt efter.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const nye = e.rateLimits.map(g => ({ ...g }))
      const vist = vistGraenser(nye)
      if (vist.length) {
        await update($, graenser, () => vist)
        await $.store.set(SIDSTE_GRAENSER, vist)
      }
      $.clock.after(2_000, () => void kalibrer($, nye))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const nr = ((await read($, opgaver)).at(-1)?.nr ?? 0) + 1
    const { usd, abonnement } = await forbrug($)
    aktiv = {
      ...ventende,
      nr,
      prompt: afkort(e.text, 60) || '(fortsættelse)',
      start: await $.clock.now(),
      usdStart: usd,
      ttl: abonnement ? 2 : 1.25,
      forrigePrompt,
      kontekst: hentKontekst($),
    }
    ventende = { trin: [], kald: [], agenter: {} }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? ''
    sidsteTrin.set(loop, e.index)
    const svar = yield* next(e)
    try {
      if (svar.usage) {
        spand().trin.push({
          loop,
          index: e.index,
          model: svar.usage.model || e.model,
          input: svar.usage.input_tokens,
          output: svar.usage.output_tokens,
          cacheLaes: svar.usage.cache_read_input_tokens,
          cacheSkriv: svar.usage.cache_creation_input_tokens,
          svarTegn: svar.answer.length,
          vaerktoejsInput: svar.toolUses.map(u => ({ etiket: etiket(u.name, u.input), tegn: laengde(u.input) })),
        })
      }
      if (loop !== '' && !kendteAgenter.has(loop)) {
        const info = (await $.agent.list()).find(a => a.id === loop)
        kendteAgenter.set(loop, { beskrivelse: info?.description ?? '', type: info?.type ?? '' })
      }
      const agent = kendteAgenter.get(loop)
      if (agent) spand().agenter[loop] = agent
    } catch {
      // Målingen må aldrig stoppe et modelkald.
    }
    return svar
  })

  on('tool.call', async ($, e, next) => {
    // Historik-værktøjet, som modellen kan kalde, besvares her.
    if (String(e.tool) === HISTORIK_VAERKTOEJ) {
      await sikrEnhed($)
      const input = e as unknown as Record<string, unknown>
      if (input.alle === true) return { result: (await indsigtFor($, false)).join('\n') }
      const heltal = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
      const opgave = heltal(input.opgave)
      const dag = heltal(input.dag)
      const soeg = typeof input.agent === 'string' ? input.agent.trim() : ''
      const p = await hentProjekt($, soeg)
      if (typeof p === 'string') return { result: p }
      const linjer =
        input.raad === true
          ? await tekstFor($, p, 'raad', null, false)
          : opgave !== null
          ? await tekstFor($, p, 'opgave', opgave, false)
          : dag !== null
            ? await tekstFor($, p, 'dag', dag, false)
            : [...(await tekstFor($, p, 'projekt', null, false)), '', ...dageTekst(p, false)]
      return { result: linjer.join('\n') }
    }
    const loop = e.agentId ?? ''
    const trin = sidsteTrin.get(loop) ?? 0
    const svar = await next(e)
    try {
      const tegn = typeof svar.text === 'string' ? svar.text.length : typeof svar.deny === 'string' ? svar.deny.length : 0
      spand().kald.push({ loop, trin, etiket: etiket(String(e.tool), e), tegn })
    } catch {
      // Målingen må aldrig stoppe et værktøjskald.
    }
    return svar
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || aktiv === null) return next(e)
    const igang = aktiv
    aktiv = null
    // En tur uden modelkald (fx en login-fejl) er ikke en opgave.
    if (igang.trin.length === 0) return next(e)
    try {
      const nu = await $.clock.now()
      const { usd } = await forbrug($)
      const opgave = analyser({
        nr: igang.nr,
        start: igang.start,
        prompt: igang.prompt,
        afbrudt: e.isAborted,
        sekunder: Math.round((nu - igang.start) / 1000),
        usd: igang.usdStart !== null && usd !== null ? Math.max(0, usd - igang.usdStart) : null,
        ttl: igang.ttl,
        forrigePrompt: igang.forrigePrompt,
        trin: igang.trin,
        kald: igang.kald,
        agenter: igang.agenter,
        kontekst: await igang.kontekst,
      })
      const sidste = igang.trin.filter(t => t.loop === '').at(-1)
      if (sidste) forrigePrompt = sidste.input + sidste.cacheLaes + sidste.cacheSkriv
      await update($, opgaver, liste => [...liste, opgave].slice(-50))
      if (indstillinger.beskeder) {
        await sikrEnhed($)
        $.ui.toast(`Opgaven brugte ${opsummering(opgave)} · ${minutter(opgave.sekunder)}`)
      }
    } catch {
      // En fejl i analysen må ikke stoppe turen.
    }
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const ord = e.args.trim().split(/\s+/).filter(Boolean)
    const [foerste = '', ...rest] = ord
    await update($, skjult, () => false)
    await sikrEnhed($)
    if (foerste === 'forbrug' || foerste === 'indsigt' || ((foerste === 'råd' || foerste === 'raad') && rest.join(' ') === 'alle')) {
      return { text: (await forbrugTekst($)).join('\n') }
    }
    if (['prompts', 'promptsmart'].includes(foerste.toLowerCase())) return { text: (await promptsmartFor($, true)).join('\n') }
    if (foerste === 'dag') {
      const nr = Number.parseInt(rest[0] ?? '', 10)
      if (Number.isNaN(nr)) return { text: 'Skriv fx /tokens dag 2.' }
      const p = await hentProjekt($, rest.slice(1).join(' '))
      return { text: typeof p === 'string' ? p : (await tekstFor($, p, 'dag', nr, true)).join('\n') }
    }
    const [visning, nr, soeg]: [Visning, number | null, string] =
      foerste === 'dage'
        ? ['dage', null, rest.join(' ')]
        : foerste === 'råd' || foerste === 'raad'
          ? ['raad', null, rest.join(' ')]
        : /^\d+$/.test(foerste)
          ? ['opgave', Number(foerste), rest.join(' ')]
          : ['projekt', null, ord.join(' ')]
    const p = await hentProjekt($, soeg)
    return { text: typeof p === 'string' ? p : (await tekstFor($, p, visning, nr, true)).join('\n') }
  })

  on('command.run', { command: 'prompts' }, async $ => {
    await sikrEnhed($)
    return { text: (await promptsmartFor($, true)).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await sikrEnhed($)
    const sidste = (await read($, opgaver)).at(-1)
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    const g = await read($, graenser)
    const nu = await $.clock.now()
    // Målerne for 5-timersgrænsen og ugens grænse efter knapperne: etiketten som tekst og en lille
    // bjælke med procenten på. I terminalen er bjælken tegn.
    const vist = vistGraenser(g)
    const maaler =
      vist.length === 0 ? null : 'Svg' in el && e.surface !== 'terminal' ? (
        <Box alignItems="center" gap={2} marginLeft={1}>
          {vist.map(x => {
            const p = brugt(x, nu)
            return (
              <Box key={x.kind} alignItems="center" gap={1}>
                <Text dimColor>{kortNavn(x)}</Text>
                <el.Svg {...bjaelkeSvg(p)} alt={`${kortNavn(x)} ${procentTekst(p)}`} />
              </Box>
            )
          })}
        </Box>
      ) : (
        <Text dimColor> {maalerTekst(g, nu)}</Text>
      )

    // En ny samtale, før den første opgave er målt: en indgang til indsigten i hele forbruget.
    if (!sidste) {
      if (!indstillinger.velkomst || (await read($, velkomstSkjult))) return next(e)
      return (
        <Box alignItems="center" justifyContent="space-between" width="100%">
          <Text dimColor>Bliv klogere på dit forbrug og dine prompts</Text>
          <Box alignItems="center" gap={1}>
            <Button key="indsigt" label="Indsigt" onPress={() => visIndsigt($)} />
            {indstillinger.promptsmart && <Button key="promptsmart" label="Dine prompts" onPress={() => visPromptsmart($)} />}
            <Button key="skjul" label="Skjul" onPress={() => update($, velkomstSkjult, () => true)} />
            {maaler}
          </Box>
        </Box>
      )
    }
    if (!indstillinger.baand || (await read($, skjult))) return next(e)

    return (
      <Box alignItems="center" justifyContent="space-between" width="100%">
        <Text dimColor>Sidste opgave: {opsummering(sidste)}</Text>
        <Box alignItems="center" gap={1}>
          <Button
            key="detaljer"
            label="Detaljer"
            onPress={async () => {
              await visPanel($, 'opgave', null)
              await aabnPanel($, '/tokens <nr>')
            }}
          />
          <Button key="indsigt" label="Indsigt" onPress={() => visIndsigt($)} />
          <Button key="skjul" label="Skjul" onPress={() => update($, skjult, () => true)} />
          {maaler}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await sikrEnhed($)
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    type Stil = { dimColor?: true; color?: string }
    // **fed** vises fed og `kode` i farve; resten i linjens egen stil. split med en fangende gruppe
    // giver de fundne stykker på de ulige pladser, så en enkelt * i en titel ikke forveksles med fed.
    const dele = (tekst: string, stil: Stil) =>
      tekst.split(/(\*\*.+?\*\*|`[^`]+`)/).flatMap((d, i) =>
        d === ''
          ? []
          : i % 2 === 0
            ? [<Text {...stil}>{d}</Text>]
            : d.startsWith('**')
              ? [
                  <Text bold {...stil}>
                    {d.slice(2, -2)}
                  </Text>,
                ]
              : [<Text color="cyan">{d.slice(1, -1)}</Text>],
      )
    // En bjælke står i farve. Under en overskrift er forklaringen dæmpet, og handlingen (→) er grøn.
    const vis = (linje: string, i: number, alle: readonly string[]) => {
      const [, fyldt = '', tom = '', rest = ''] = /^(█*)(░*)(.*)$/.exec(linje.replace(/\s*\n\s*/g, ' ')) ?? []
      const forrige = alle[i - 1] ?? ''
      const underOverskrift = fyldt === '' && tom === '' && /^(█*░*\s?)\*\*/.test(forrige) && !rest.startsWith('**')
      const stil: Stil = rest.startsWith('→') ? { color: 'green' } : underOverskrift ? { dimColor: true } : {}
      return (
        <Box>
          {fyldt !== '' && <Text color="cyan">{fyldt}</Text>}
          {tom !== '' && <Text dimColor>{tom}</Text>}
          {rest === '' ? <Text> </Text> : dele(rest, stil)}
        </Box>
      )
    }
    const visning = await read($, paneVisning)
    const nr = await read($, paneNr)
    const antal = await read($, paneAntal)
    const linjer = await read($, paneLinjer)
    const grafik = await read($, forbrugGrafik)
    const g = await read($, graenser)
    const nu = await $.clock.now()

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {visning === 'indsigt' && grafik && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Indsigt</Text>
            <Text dimColor>Dine grænser lige nu</Text>
            {vistGraenser(g).length === 0 ? (
              <Text dimColor>Grænserne vises, når Claude har svaret første gang.</Text>
            ) : 'Svg' in el && e.surface !== 'terminal' ? (
              <el.Svg {...maalerSvgStor(g, nu)} alt={maalerTekst(g, nu)} />
            ) : (
              <Text>{maalerTekst(g, nu)}</Text>
            )}
            <Box marginTop={1}>
              <Text bold>{UGEDAGE_OVERSKRIFT}</Text>
            </Box>
            {grafik.dage.length === 0 ? null : 'Svg' in el && e.surface !== 'terminal' ? (
              <el.Svg {...soejlerSvg(grafik.dage)} alt={soejlerTekst(grafik.dage).join('\n')} />
            ) : (
              soejlerTekst(grafik.dage).map(l => <Text>{l}</Text>)
            )}
          </Box>
        )}
        {(linjer.length ? linjer : ['Tryk Indsigt for at hente forbruget.']).map(vis)}
        <Box marginTop={1} gap={1}>
          <Button key="indsigt" label="Indsigt" onPress={() => visPanel($, 'indsigt', null)} />
          <Button key="dage" label="Dage" onPress={() => visPanel($, 'dage', null)} />
          <Button key="raad" label="Råd" onPress={() => visPanel($, 'raad', null)} />
          {indstillinger.promptsmart && <Button key="promptsmart" label="Dine prompts" onPress={() => visPanel($, 'promptsmart', null)} />}
          {visning === 'opgave' && nr !== null && nr > 1 && (
            <Button key="forrige" label="‹ Forrige" onPress={() => visPanel($, 'opgave', nr - 1)} />
          )}
          {visning === 'opgave' && nr !== null && nr < antal && (
            <Button key="naeste" label="Næste ›" onPress={() => visPanel($, 'opgave', nr + 1)} />
          )}
        </Box>
      </Box>
    )
  })
}
