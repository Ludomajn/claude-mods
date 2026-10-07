import { afkort, afkortOrd, bjaelke } from './analyse'
import type { HistOpgave } from './historik'
import { maalForklaring } from './enhed'
import { beloeb, MEST } from './raad'

// Dine prompts: hvor en første prompt manglede noget, så brugeren måtte rette bagefter, og hvordan
// prompten kunne have lydt. Tre modeller deler arbejdet: Opus analyserer samtalen, Sonnet skriver
// den bedre prompt, og Haiku skriver det, brugeren læser.
export const MODEL = { analyse: 'opus', arbejde: 'sonnet', kommunikation: 'haiku' } as const
export type Rolle = keyof typeof MODEL

// Én kæde: den første besked om en opgave og de senere beskeder, der rettede den.
export type Kaede = { start: number; rettelser: number[]; oenske: string; manglede: string }

// Et færdigt forslag, som det vises og gemmes.
export type PromptRaad = {
  samtale: string
  navn: string
  manglede: string
  skrev: string
  proev: string
  usd: number
}

// Så mange beskeder fra én samtale ser Opus på (de seneste), og så meget af hver.
export const BESKEDER = 120
const BRUGER_TEGN = 600
const SVAR_TEGN = 300

export const ANALYSE_SYSTEM =
  'Du analyserer samtaler mellem en bruger og en AI-assistent for at finde første beskeder, der manglede noget, så brugeren måtte rette bagefter. Du er præcis og skelner rettelser fra nye opgaver. Svar kun med JSON.'

export const analysePrompt = (titel: string, opgaver: readonly HistOpgave[]): string =>
  [
    `Samtalen "${titel}": brugerens beskeder i rækkefølge, hver med starten af assistentens svar.`,
    '',
    ...opgaver.slice(-BESKEDER).flatMap(o => [
      `[${o.nr}] Bruger: ${afkort(o.fuld, BRUGER_TEGN)}`,
      ...(o.svar ? [`    Assistent: ${afkort(o.svar, SVAR_TEGN)}`] : []),
    ]),
    '',
    'Find op til 3 steder, hvor brugerens første besked om en opgave manglede noget, så brugeren bagefter måtte rette, præcisere eller afvise resultatet for at få det, de ville have.',
    'Tæl ikke nye opgaver, "fortsæt", godkendelser eller naturlige næste skridt, som brugeren ikke kunne have vidst på forhånd.',
    'For hvert sted: "start" (nummeret på den første besked), "rettelser" (numrene på de beskeder, der rettede den), "oenske" (det resultat, brugeren endte med at ville have, i 1-2 sætninger) og "manglede" (hvad den første besked manglede, i få ord).',
    'Svar kun med JSON: {"kaeder": [{"start": 3, "rettelser": [5, 6], "oenske": "…", "manglede": "…"}]}. Er der ingen, så {"kaeder": []}.',
  ].join('\n')

export const ARBEJDE_SYSTEM =
  'Du omskriver en brugers besked til en AI-assistent, så den rammer det, brugeren ville have, første gang. Du skriver som brugeren selv, ikke som en ekspert. Svar kun med den nye besked.'

// Den bedre prompt må højst være halvanden gang så lang som originalen (mindst 150 tegn mere).
export const loft = (original: string): number => Math.min(900, Math.max(Math.round(original.length * 1.5), original.length + 150))

export const arbejdePrompt = (foerste: string, rettelser: readonly string[], k: Pick<Kaede, 'oenske' | 'manglede'>): string =>
  [
    `Brugerens første besked: «${afkort(foerste, 1_200)}»`,
    '',
    'Det, brugeren skrev bagefter for at rette det:',
    ...rettelser.map(r => `- «${afkort(r, 400)}»`),
    '',
    `Det, brugeren endte med at ville have: ${k.oenske}`,
    `Det, den første besked manglede: ${k.manglede}`,
    '',
    'Skriv den første besked om, så assistenten havde ramt det ønskede resultat første gang.',
    `Regler: samme sprog, tone og niveau som brugeren; ingen fagord, brugeren ikke selv brugte; tilføj kun det, der manglede; højst ${loft(foerste)} tegn.`,
  ].join('\n')

export const KOMMUNIKATION_SYSTEM = 'Du skriver korte, klare tekster på dansk til en oversigt. Svar kun med JSON.'

export const kommunikationPrompt = (punkter: readonly { foerste: string; manglede: string }[]): string =>
  [
    'For hvert punkt nedenfor skal du skrive:',
    '- "navn": opgavens emne i 2-4 ord, fx "Banner i nye samtaler"',
    '- "manglede": hvad den første besked manglede, højst 8 ord, med lille forbogstav og uden punktum',
    '',
    ...punkter.map((p, i) => `${i + 1}) Første besked: «${afkort(p.foerste, 300)}» Manglede: ${p.manglede}`),
    '',
    'Svar kun med JSON i samme rækkefølge: {"punkter": [{"navn": "…", "manglede": "…"}]}',
  ].join('\n')

// Det første JSON-objekt i et svar; modeller pakker det nogle gange ind i tekst eller ```json.
export const jsonFra = (tekst: string): Record<string, unknown> | null => {
  const fundet = /\{[\s\S]*\}/.exec(tekst)
  if (!fundet) return null
  try {
    const v: unknown = JSON.parse(fundet[0])
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const tekst = (v: unknown, n: number) => (typeof v === 'string' ? afkort(v, n) : '')

// Opus' kæder, kun med beskeder, der findes, og rettelser, der kom efter den første besked.
export const kaederFra = (svar: string, opgaver: readonly HistOpgave[]): Kaede[] => {
  const findes = new Set(opgaver.map(o => o.nr))
  const liste = jsonFra(svar)?.kaeder
  if (!Array.isArray(liste)) return []
  return liste.flatMap((x): Kaede[] => {
    const k = (x ?? {}) as Record<string, unknown>
    const start = typeof k.start === 'number' ? k.start : NaN
    const rettelser = Array.isArray(k.rettelser) ? k.rettelser.filter((n): n is number => typeof n === 'number' && n > start && findes.has(n)) : []
    if (!findes.has(start) || rettelser.length === 0) return []
    return [{ start, rettelser: [...new Set(rettelser)].sort((a, b) => a - b), oenske: tekst(k.oenske, 300), manglede: tekst(k.manglede, 120) }]
  }).slice(0, 3)
}

// Haikus navne og forklaringer; mangler et, bruges starten af prompten og Opus' forklaring.
export const punkterFra = (svar: string, antal: number): ({ navn: string; manglede: string } | null)[] => {
  const liste = jsonFra(svar)?.punkter
  return Array.from({ length: antal }, (_, i) => {
    const p = (Array.isArray(liste) ? liste[i] : null) as Record<string, unknown> | null
    const navn = tekst(p?.navn, 40)
    const manglede = tekst(p?.manglede, 80).replace(/\.$/, '')
    return navn && manglede ? { navn, manglede } : null
  })
}

// Den bedre prompt på én linje uden anførselstegn og indledning.
export const renPrompt = (svar: string): string =>
  svar
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(ny besked|bedre prompt|prøv)\s*:\s*/i, '')
    .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
    .trim()

export const promptsmartTekst = (liste: readonly PromptRaad[], samtaler: number, visuel = true): string[] => {
  const ud = ['**Dine prompts**', `Prompts, der kunne have ramt første gang · tal = ${maalForklaring()}, rettelserne bagefter brugte`]
  const vist = [...liste].sort((a, b) => b.usd - a.usd).slice(0, MEST)
  const stoerst = vist[0]?.usd ?? 0
  if (vist.length === 0) ud.push('', 'Ingen prompts at forbedre: de første beskeder ramte, eller det, der fulgte, var nye opgaver.')
  for (const r of vist) {
    ud.push(
      '',
      `${visuel ? `${bjaelke(stoerst > 0 ? r.usd / stoerst : 0, 10)} ` : ''}**${beloeb(r.usd)} · ${r.navn}** · ${afkortOrd(r.samtale, 28)}`,
      `Du skrev: «${afkortOrd(r.skrev, 110)}» Det manglede: ${r.manglede}.`,
      `→ Prøv: «${renPrompt(r.proev)}»`,
    )
  }
  ud.push('', `Gennemgik ${samtaler === 1 ? '1 samtale' : `dine ${samtaler} dyreste samtaler`}.`)
  return ud
}
