import { describe, expect, test } from 'claude-code/testing'

import { analyser, detaljer, etiket, pris } from './analyse'
import type { Raadata, Trin } from './analyse'

const trin = (index: number, felter: Partial<Trin>): Trin => ({
  loop: '',
  index,
  model: 'claude-opus-5-5',
  input: 0,
  output: 0,
  cacheLaes: 0,
  cacheSkriv: 0,
  svarTegn: 0,
  vaerktoejsInput: [],
  ...felter,
})

const raa = (felter: Partial<Raadata>): Raadata => ({
  nr: 1,
  prompt: 'Opgave',
  afbrudt: false,
  sekunder: 30,
  usd: null,
  ttl: 2,
  forrigePrompt: null,
  trin: [],
  kald: [],
  agenter: {},
  kontekst: [],
  ...felter,
})

describe('analyser', () => {
  test('et stort værktøjsresultat, der læses igen, er den største post', () => {
    const o = analyser(
      raa({
        forrigePrompt: 50_000,
        trin: [
          trin(0, { input: 10, output: 500, cacheLaes: 50_000, cacheSkriv: 1_000, vaerktoejsInput: [{ etiket: 'Read big.ts', tegn: 60 }] }),
          trin(1, {
            input: 5,
            output: 3_000,
            cacheLaes: 51_010,
            cacheSkriv: 10_600,
            svarTegn: 700,
            vaerktoejsInput: [{ etiket: 'Write foo.ts', tegn: 7_000 }],
          }),
          trin(2, { input: 5, output: 400, cacheLaes: 61_615, cacheSkriv: 3_050, svarTegn: 1_400 }),
        ],
        kald: [
          { loop: '', trin: 0, etiket: 'Read big.ts', tegn: 35_000 },
          { loop: '', trin: 1, etiket: 'Write foo.ts', tegn: 100 },
        ],
      }),
    )

    expect(o.runder).toBe(3)
    expect(o.poster.map(p => p.navn).slice(0, 4)).toEqual(['Read big.ts', 'Skrev: Write foo.ts', 'Tænkning', 'Samtalen fra før opgaven'])
    const read = o.poster[0]
    expect(read).toMatchObject({ type: 'vaerktoej', tokens: 10_105, gange: 1 })
    expect(read?.andel).toBeGreaterThan(0.34)
    expect(read?.andel).toBeLessThan(0.39)
    expect(o.poster.find(p => p.type === 'start')).toMatchObject({ tokens: 50_000, gange: 3 })
    expect(o.poster.find(p => p.type === 'cache')).toBeUndefined()
    expect(Math.abs(o.poster.reduce((s, p) => s + p.andel, 0) - 1)).toBeLessThan(0.005)
    expect(Math.abs((o.usd ?? 0) - 0.2278)).toBeLessThan(0.0005)
    expect(o.forklaring).toBe('Read big.ts gav 10.1k tokens, som blev læst igen i 1 runde.')
  })

  test('udløbet cache efter en pause bliver forklaringen', () => {
    const o = analyser(
      raa({
        prompt: 'Hej',
        forrigePrompt: 120_000,
        trin: [trin(0, { input: 3, output: 200, cacheLaes: 2_000, cacheSkriv: 119_500, svarTegn: 700 })],
      }),
    )

    expect(o.poster[0]).toMatchObject({ type: 'cache', tokens: 118_000 })
    expect(o.forklaring).toContain('Cachen var udløbet')
    expect(o.tip).toContain('ny session')
  })

  test('subagenter prises efter deres egen model', () => {
    const agent = (index: number) =>
      trin(index, { loop: 'a1', model: 'claude-haiku-4-5', output: 1_000, cacheLaes: 20_000, cacheSkriv: 5_000 })
    const o = analyser(
      raa({
        forrigePrompt: 30_000,
        trin: [
          trin(0, { input: 5, output: 100, cacheLaes: 30_000, cacheSkriv: 500, vaerktoejsInput: [{ etiket: 'Agent: Find filer', tegn: 200 }] }),
          agent(0),
          agent(1),
          agent(2),
          trin(1, { input: 5, output: 300, cacheLaes: 30_505, cacheSkriv: 700, svarTegn: 1_000 }),
        ],
        kald: [{ loop: '', trin: 0, etiket: 'Agent: Find filer', tegn: 2_000 }],
        agenter: { a1: { beskrivelse: 'Find filer', type: 'Explore' } },
      }),
    )

    expect(o.subagenter).toBe(1)
    expect(o.poster[0]).toMatchObject({ type: 'subagent', navn: 'Subagent: Find filer', tokens: 78_000, gange: 3 })
    expect(o.forklaring).toBe('Subagent: Find filer brugte 78.0k tokens over 3 runder.')
  })

  test('detaljerne viser hvorfor, de største poster og konteksten', () => {
    const o = analyser(
      raa({
        trin: [trin(0, { input: 5, output: 2_000, cacheLaes: 80_000, cacheSkriv: 400, svarTegn: 700 })],
        kontekst: [
          { navn: 'Beskeder', tokens: 60_000 },
          { navn: 'Værktøjer', tokens: 12_000 },
        ],
      }),
    )
    const linjer = detaljer(o)

    expect(linjer[0]).toBe('Opgave 1: "Opgave"')
    expect(linjer).toContain('Hvad prisen gik til (ca.):')
    expect(linjer.some(l => l.startsWith('Hvorfor: '))).toBe(true)
    expect(linjer).toContain('Samtalen ved start: Beskeder 60.0k · Værktøjer 12.0k')
  })
})

describe('etiket og pris', () => {
  test('værktøjskald får korte navne', () => {
    expect(etiket('Read', { file_path: '/a/b/c.ts', offset: 100, limit: 50 })).toBe('Read c.ts (linje 100–150)')
    expect(etiket('Bash', { command: 'ls -la', description: 'List files' })).toBe('Bash: List files')
    expect(etiket('mcp__plugin_pdf-viewer_pdf__display_pdf', {})).toBe('pdf: display_pdf')
    expect(etiket('mcp__80d7a738-5cbf-4e1a-880d-2f346823b6dd__data_cms_tool', {})).toBe('data_cms_tool')
    expect(etiket('mcp__Claude_Browser__navigate', {})).toBe('Claude_Browser: navigate')
  })

  test('priser følger modellen, ukendte modeller prises som Opus 5.5', () => {
    expect(Math.abs(pris('claude-opus-5-5').ind - 4e-6)).toBeLessThan(5e-13)
    expect(Math.abs(pris('claude-opus-5').ind - 5e-6)).toBeLessThan(5e-13)
    expect(Math.abs(pris('claude-haiku-4-5-20251001').ud - 5e-6)).toBeLessThan(5e-13)
    expect(Math.abs(pris('claude-sonnet-5-5').laes - 0.2e-6)).toBeLessThan(5e-13)
    expect(Math.abs(pris('claude-fable-5-1').laes - 0.25e-6)).toBeLessThan(5e-13)
    expect(pris('noget-andet')).toEqual(pris('claude-opus-5-5'))
  })
})
