import { describe, expect, test } from 'claude-code/testing'

import type { Opgave, Post } from '../types'
import type { HistOpgave, Projekt } from './historik'
import { overheadFra, raad, raadTekst } from './raad'
import type { Grundlag } from './raad'

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

const projekt = (usd: number, subUsd = 0): Projekt => ({ id: 's1', titel: 'Test', dage: [], opgaver: [], usd, tokens: 0, kald: 1, subUsd })

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
    expect(efter('lang-samtale')?.titel).toBe('Lang samtale: hver runde læser op til 600k tokens igen')
    expect(efter('lang-samtale')?.eksempler[0]).toBe('opgave 7: 600k tokens × 41 runder (ca. $4.45 at spare)')
    naer(efter('pauser')?.usd, 4.33 * (1 - 60_000 / 541_000))
    naer(efter('store-resultater')?.usd, 0.7)
    expect(efter('store-resultater')?.eksempler).toEqual(['opgave 7: Read stor.ts (9.0k, $1.00)'])
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
    expect(liste.find(r => r.id === 'subagenter')?.eksempler).toEqual(['opgave 4: Subagent: Find filer ($3.00)'])
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
  })

  test('teksten har bjælker, handlinger og eksempler, men ingen nummererede linjer', () => {
    const g: Grundlag = {
      projekt: projekt(20),
      opgaver: [{ o: opgave(7, 'Byg', 8.55), a: analyse({ startKontekst: 600_000, runder: 41, poster: [post('start', 4.94)] }) }],
      overhead: null,
    }
    const linjer = raadTekst('Test', raad(g))

    expect(linjer[0]).toBe('Råd til at bruge færre tokens · Test')
    expect(linjer.some(l => /^█+░* ca\. \$4\.45 at spare · Lang samtale/.test(l))).toBe(true)
    expect(linjer.some(l => l.startsWith('→ Skriv /compact'))).toBe(true)
    expect(linjer.some(l => l.startsWith('Fx opgave 7:'))).toBe(true)
    expect(linjer.some(l => /^\s*\d+[.)]\s/.test(l))).toBe(false)
    expect(raadTekst('Test', [])).toEqual(['Råd til Test: ingen lige nu. Forbruget ser fornuftigt ud.'])
  })
})
