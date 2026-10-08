import { describe, expect, test } from 'claude-code/testing'

import type { Opgave, Post } from '../types'
import type { Kald, Raadata, Trin } from './analyse'
import type { HistOpgave, Projekt } from './historik'
import { overheadFra, raad, raadTekst } from './raad'
import type { Grundlag, Raad } from './raad'

const post = (type: Post['type'], usd: number, tokens = 0, navn: string = type): Post => ({ type, navn, tokens, gange: 0, andel: 0, usd })

const analyse = (felter: Partial<Opgave>): Opgave => ({
  nr: 1,
  start: 0,
  prompt: '',
  afbrudt: false,
  sekunder: 0,
  usd: 0,
  model: 'claude-opus-5-5',
  ind: 0,
  ud: 0,
  cacheLaes: 0,
  cacheSkriv: 0,
  runder: 10,
  startKontekst: 0,
  subagenter: 0,
  poster: [],
  forklaring: '',
  tip: '',
  kontekst: [],
  ...felter,
})

const opgave = (nr: number, fuld: string, usd: number): HistOpgave =>
  ({ nr, t: 0, dato: '2026-10-07', dagNr: 1, tekst: fuld, fuld, usd, tokens: 0, kald: 1, handlinger: [], svar: '', forrigeSvar: '', raa: {} }) as unknown as HistOpgave

const projekt = (usd: number, subUsd = 0, stoppet = { antal: 0, usd: 0 }): Projekt => ({
  id: 's1',
  titel: 'Test',
  dage: [],
  opgaver: [],
  usd,
  tokens: 0,
  kald: 1,
  subUsd,
  graense: stoppet.antal,
  stoppet,
  kvarterer: {},
  planlagt: '',
})

// Et modelkald: 100k tokens læst fra cachen og 1.000 skrevet ud.
const trin = (loop: string, index: number, felter: Partial<Trin> = {}): Trin => ({
  loop,
  index,
  model: 'claude-opus-5-5',
  input: 0,
  output: 1_000,
  cacheLaes: 100_000,
  cacheSkriv: 0,
  svarTegn: 0,
  vaerktoejsInput: [],
  ...felter,
})

const medRaa = (o: HistOpgave, trinListe: Trin[], kald: Kald[] = []): HistOpgave => ({ ...o, raa: { ttl: 1.25, trin: trinListe, kald } as unknown as Raadata })

const naer = (faktisk: number | undefined, forventet: number) => expect(Math.abs((faktisk ?? NaN) - forventet)).toBeLessThan(1e-6)

describe('analytikerens regler', () => {
  test('lang samtale, pauser, store resultater og rutineopgaver giver hver et råd med en besparelse', () => {
    const g: Grundlag = {
      projekt: projekt(20),
      opgaver: [
        {
          o: opgave(7, 'Byg historikken', 8.55),
          a: analyse({ startKontekst: 600_000, runder: 41, poster: [post('start', 4.94), post('vaerktoej', 1, 9_000, 'Read stor.ts')] }),
        },
        { o: opgave(1, 'Kan jeg dele den?', 5.08), a: analyse({ startKontekst: 541_000, poster: [post('cache', 4.33, 541_000)] }) },
        { o: opgave(12, 'Commit og push', 4.71), a: analyse({ startKontekst: 300_000, poster: [post('start', 3)] }) },
      ],
      overhead: null,
    }
    const liste = raad(g)
    const efter = (id: string) => liste.find(r => r.id === id)

    expect(liste.map(r => r.usd)).toEqual([...liste.map(r => r.usd)].sort((a, b) => b - a))
    naer(efter('lang-samtale')?.usd, 4.94 * 0.9 + 3 * 0.8)
    expect(efter('lang-samtale')?.hvorfor).toBe('Samtalen nåede 600k tokens, og hver runde læste den hele igen.')
    expect(efter('pauser')?.hvorfor).toBe('Cachen udløb 1 gang under pauser, og hele samtalen blev gemt igen (28 kr).')
    expect(efter('lang-samtale')?.eksempler[0]).toBe('opgave 7: 600k tokens × 41 runder (ca. 29 kr at spare)')
    naer(efter('pauser')?.usd, 4.33 * (1 - 60_000 / 541_000))
    naer(efter('store-resultater')?.usd, 0.7)
    expect(efter('store-resultater')?.eksempler).toEqual(['opgave 7: Read stor.ts (9.0k, 6,50 kr)'])
    naer(efter('rutine')?.usd, 4.71 * 0.8)
    expect(efter('taenkning')).toBeUndefined()
  })

  test('tænkning og subagenter giver råd, når de fylder meget af prisen', () => {
    const g: Grundlag = {
      projekt: projekt(10, 3),
      opgaver: [{ o: opgave(4, 'Udvikl videre', 10), a: analyse({ poster: [post('taenkning', 2.6), post('subagent', 3, 0, 'Subagent: Find filer')] }) }],
      overhead: null,
    }
    const liste = raad(g)

    naer(liste.find(r => r.id === 'taenkning')?.usd, 2.6 * 0.4)
    expect(liste.find(r => r.id === 'subagenter')?.eksempler).toEqual(['opgave 4: Subagent: Find filer (20 kr)'])
  })

  test('forbindelser og plugins i konteksten giver et råd med de største', () => {
    const overhead = overheadFra(
      [
        { name: 'mcp__80d7a738-5cbf__data_cms_tool', serverName: '80d7a738-5cbf-4e1a', tokens: 8_000, isLoaded: true },
        { name: 'mcp__80d7a738-5cbf__data_pages_tool', serverName: '80d7a738-5cbf-4e1a', tokens: 4_000, isLoaded: true },
        { name: 'mcp__Claude_Browser__navigate', serverName: 'Claude_Browser', tokens: 6_000, isLoaded: true },
        { name: 'mcp__adobe__init', serverName: 'adobe', tokens: 6_000, isLoaded: true },
        { name: 'mcp__ClickUp__search', serverName: 'ClickUp', tokens: 9_000, isLoaded: false },
      ],
      [
        { name: 'unity:ui', pluginName: 'unity', source: 'plugin', tokens: 3_000 },
        { name: 'unity:sprite-editor', pluginName: 'unity', source: 'plugin', tokens: 2_000 },
        { name: 'loop', source: 'built-in', tokens: 2_400 },
        { name: 'min-skill', source: 'userSettings', tokens: 1_000 },
      ],
    )
    expect(overhead.mcp).toEqual([
      { navn: 'forbindelsen med data_cms_tool', tokens: 12_000 },
      { navn: 'adobe', tokens: 6_000 },
    ])
    expect(overhead.skills).toEqual([
      { navn: 'unity', tokens: 5_000 },
      { navn: 'dine egne skills', tokens: 1_000 },
    ])

    const [r] = raad({ projekt: projekt(30), opgaver: [{ o: opgave(1, 'Byg', 30), a: analyse({ runder: 300 }) }], overhead })
    expect(r?.id).toBe('overhead')
    // 24k tokens læst i 300 runder til 0,20 $/M og skrevet én gang til 8 $/M.
    naer(r?.usd, 24_000 * 300 * 0.2e-6 + 24_000 * 8e-6)
    expect(r?.eksempler[0]).toBe('forbindelsen med data_cms_tool (MCP): 12.0k tokens')
    expect(r?.kort).toBe('slå ubrugte fra, fx forbindelsen med data_cms_tool')
    expect(r?.hvorfor).toBe('24.0k tokens følger med i hver runde, mest forbindelsen med data_cms_tool (12.0k).')
  })

  test('skærmbilleder og fejlede værktøjskald koster runder, der kunne have været sparet', () => {
    const hoved = Array.from({ length: 41 }, (_, i) => trin('', i, { output: 10_000 }))
    const billeder: Kald[] = Array.from({ length: 40 }, (_, i) => ({ loop: '', trin: i, etiket: 'Claude_Browser: computer', tegn: 5_000, billeder: 1 }))
    const fejlede: Kald[] = [
      ...Array.from({ length: 4 }, (_, i): Kald => ({ loop: '', trin: i, etiket: 'Bash: Kør testene', tegn: 100, fejl: 'kommando' })),
      { loop: '', trin: 5, etiket: 'Bash: Slet mappen', tegn: 100, fejl: 'tilladelse' },
      { loop: '', trin: 6, etiket: 'Bash: Push', tegn: 100, fejl: 'afvist' },
    ]
    const g: Grundlag = { projekt: projekt(30), opgaver: [{ o: medRaa(opgave(3, 'Test siden', 30), hoved, [...billeder, ...fejlede]), a: analyse({}) }], overhead: null }
    const liste = raad(g)
    const efter = (id: string) => liste.find(r => r.id === id)

    // Billede i: 1.500 tokens skrevet (4 $/M × 1,25) og læst i 40 − i runder (0,20 $/M).
    const billedUsd = Array.from({ length: 40 }, (_, i) => 1_500 * (5e-6 + 0.2e-6 * (40 - i))).reduce((a, b) => a + b, 0)
    naer(efter('skaermbilleder')?.usd, billedUsd * 0.5)
    expect(efter('skaermbilleder')?.hvorfor).toBe('Claude tog 40 skærmbilleder, og hvert blev læst igen i resten af opgaven (3,55 kr).')

    // Hver fejl koster runden efter: 100k × 0,20 $/M + 10k × 20 $/M = $0.22. Den afviste tæller ikke.
    naer(efter('fejl')?.usd, 5 * 0.22 * 0.5)
    expect(efter('fejl')?.hvorfor).toBe('5 værktøjskald fejlede, mest kommandoer, der fejlede (4), og hver fejl kostede en ekstra runde.')
    expect(efter('fejl')?.handling).toBe('Skriv de kommandoer og stier, der virker, i CLAUDE.md, så Claude ikke skal prøve sig frem.')
  })

  test('rådet om fejlede kald nævner den hyppigste slags fejl, også når den ikke har sin egen handling', () => {
    const hoved = Array.from({ length: 41 }, (_, i) => trin('', i, { output: 10_000 }))
    const fejlede: Kald[] = [
      ...Array.from({ length: 6 }, (_, i): Kald => ({ loop: '', trin: i, etiket: 'Read mangler.ts', tegn: 100, fejl: 'findes ikke' })),
      { loop: '', trin: 7, etiket: 'Bash: Kør testene', tegn: 100, fejl: 'kommando' },
    ]
    const liste = raad({ projekt: projekt(30), opgaver: [{ o: medRaa(opgave(3, 'Ret filen', 30), hoved, fejlede), a: analyse({}) }], overhead: null })
    expect(liste.find(r => r.id === 'fejl')?.hvorfor).toBe('7 værktøjskald fejlede, mest filer og stier, der ikke fandtes (6), og hver fejl kostede en ekstra runde.')
  })

  test('subagenter på xhigh, en dyr model i chatten og forbrugsgrænsen giver hver et råd', () => {
    const sub = [
      ...Array.from({ length: 30 }, (_, i) => trin('a1', i, { effort: 'xhigh', output: 10_000 })),
      ...Array.from({ length: 5 }, (_, i) => trin('a2', i, { effort: 'high' })),
    ]
    const hoved = Array.from({ length: 20 }, (_, i) => trin('', i, { model: 'claude-fable-5-1' }))
    const g: Grundlag = {
      projekt: projekt(60, 20, { antal: 3, usd: 4.2 }),
      opgaver: [{ o: medRaa(opgave(2, 'Kør workflowet', 60), [...hoved, ...sub]), a: analyse({}) }],
      overhead: null,
    }
    const liste = raad(g)
    const efter = (id: string) => liste.find(r => r.id === id)

    // For få kald på high til at måle forskellen, så skønnet er 25 %.
    naer(efter('agent-effort')?.usd, 30 * 10_000 * 20e-6 * 0.25)
    expect(efter('agent-effort')?.hvorfor).toBe('Subagenter på xhigh eller max brugte 43 kr, 97% af subagenternes forbrug.')
    expect(efter('agent-effort')?.eksempler).toEqual(['30 af 35 subagent-kald kørte på xhigh eller max'])
    // Rådet om subagenter gælder kun de $20 − $6.60, der ikke kørte på høj effort.
    naer(efter('subagenter')?.usd, Math.max(0, 20 - 30 * (100_000 * 0.2e-6 + 10_000 * 20e-6)) * 0.3)

    // Fable 5.1: 100k × 0,25 $/M + 1.000 × 50 $/M = $0.075 pr. kald; Opus 5.5: $0.04.
    naer(efter('dyr-model')?.usd, 20 * (0.075 - 0.04) * 0.5)
    expect(efter('dyr-model')?.hvorfor).toBe('Fable 5.1 brugte 9,75 kr i chatten. Samme arbejde på Opus 5.5 havde brugt ca. 5,20 kr.')
    expect(efter('dyr-model')?.handling).toBe('Brug Fable 5.1 til de sværeste opgaver og Opus 5.5 til resten. Vælg model, før samtalen starter.')
    expect(efter('dyr-model')?.kort).toBe('Fable 5.1 kun til det sværeste')

    expect(efter('gammel-model')).toBeUndefined()
    naer(efter('forbrugsgraense')?.usd, 4.2)

    // En ældre version af standardmodellen er ikke en dyrere klasse, bare dyrere pr. token.
    const gammel = raad({ projekt: projekt(10), opgaver: [{ o: medRaa(opgave(1, 'Byg', 10), Array.from({ length: 20 }, (_, i) => trin('', i, { model: 'claude-opus-5' }))), a: analyse({}) }], overhead: null })
    expect(gammel.find(r => r.id === 'dyr-model')).toBeUndefined()
    // Opus 5: 100k × 0,50 $/M + 1.000 × 25 $/M = $0.075 pr. kald; Opus 5.5: $0.04.
    naer(gammel.find(r => r.id === 'gammel-model')?.usd, 20 * (0.075 - 0.04))
    expect(gammel.find(r => r.id === 'gammel-model')?.handling).toBe('Skift til Opus 5.5 i modelvælgeren; den er nyere og billigere pr. token.')
    expect(efter('forbrugsgraense')?.hvorfor).toBe('Grænsen stoppede 3 subagenter midt i arbejdet, og det, de nåede, gik tabt.')
  })

  test('hvert råd står på højst tre linjer med luft imellem; eksemplerne kun uden bjælker', () => {
    const g: Grundlag = {
      projekt: projekt(20),
      opgaver: [{ o: opgave(7, 'Byg', 8.55), a: analyse({ startKontekst: 600_000, runder: 41, poster: [post('start', 4.94)] }) }],
      overhead: null,
    }
    const linjer = raadTekst('Test', raad(g))

    expect(linjer).toEqual([
      '**Råd til at bruge færre tokens**',
      'Test · tal = kroner, du cirka kunne have sparet',
      '',
      '██████████ **29 kr · Lang samtale**',
      'Samtalen nåede 600k tokens, og hver runde læste den hele igen.',
      '→ Skriv `/compact`, når en opgave er færdig, så hver runde læser mindre.',
    ])
    expect(raadTekst('Test', raad(g), false).slice(3)).toEqual([
      '**29 kr · Lang samtale**',
      'Samtalen nåede 600k tokens, og hver runde læste den hele igen.',
      '→ Skriv `/compact`, når en opgave er færdig, så hver runde læser mindre.',
      'Fx opgave 7: 600k tokens × 41 runder (ca. 29 kr at spare)',
    ])
    expect(linjer.some(l => /^\s*\d+[.)]\s/.test(l))).toBe(false)
    expect(raadTekst('Test', [])).toEqual(['Ingen råd til Test lige nu.'])

    // Højst fem råd vises; resten står samlet på én linje.
    const mange = Array.from({ length: 7 }, (_, i): Raad => ({ id: `r${i}`, navn: `Råd ${i}`, hvorfor: 'h', handling: 'g', kort: 'k', usd: 7 - i, eksempler: [] }))
    const tekst = raadTekst('Test', mange)
    expect(tekst.filter(l => l.startsWith('→'))).toHaveLength(5)
    expect(tekst.at(-1)).toBe('Plus 2 mindre råd for i alt 20 kr.')
  })
})
