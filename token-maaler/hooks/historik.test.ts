import { describe, expect, test } from 'claude-code/testing'

import { dagTekst, dageTekst, datoNoegle, kaldUsd, laesLinje, nySamling, opgaveTekst, projekt, projektTekst } from './historik'

const time = (n: number) => ({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n })
const m1 = { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000, cache_creation: time(1_000) }
const m2 = { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 51_010, cache_creation_input_tokens: 10_300, cache_creation: time(10_300) }
const lille = {
  output_tokens: 500,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 2_000,
  cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
}

const assistent = (id: string, tid: string, usage: object, content: unknown[] = [], model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: tid, message: { id, model, usage, content } })
const bruger = (tid: string, content: unknown, ekstra: object = {}) =>
  JSON.stringify({ type: 'user', timestamp: tid, message: { role: 'user', content }, ...ekstra })

// Kald m1 står på to linjer (tekst og værktøjskald), som i et rigtigt transcript.
const hovedLinjer = [
  JSON.stringify({ type: 'custom-title', customTitle: 'Testagent', sessionId: 's1' }),
  bruger('2026-09-26T09:00:00.000Z', 'Byg forsiden'),
  assistent('m1', '2026-09-26T09:01:00.000Z', m1, [{ type: 'text', text: 'Jeg læser filen' }]),
  assistent('m1', '2026-09-26T09:01:00.500Z', m1, [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/stor.ts' } }]),
  bruger('2026-09-26T09:02:00.000Z', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(35_000) }]),
  assistent('m2', '2026-09-26T09:05:00.000Z', m2, [{ type: 'text', text: 'Færdig' }]),
  bruger('2026-09-26T09:30:00.000Z', '<command-name>/tokens</command-name>'),
  bruger('2026-09-26T09:31:00.000Z', 'skjult', { isMeta: true }),
  bruger('2026-09-26T09:32:00.000Z', '/tokens1'),
  bruger('2026-09-26T09:40:00.000Z', [
    { type: 'text', text: '<system-reminder>husk</system-reminder>' },
    { type: 'text', text: 'Ret menuen' },
  ]),
  assistent('m3', '2026-09-26T09:41:00.000Z', lille),
  bruger('2026-09-26T09:45:00.000Z', '<task-notification> <task-id>a1</task-id> færdig'),
  bruger('2026-09-26T09:46:00.000Z', '[Request interrupted by user]'),
  bruger('2026-09-27T10:00:00.000Z', 'Lav kontaktsiden'),
  assistent('m4', '2026-09-27T10:01:00.000Z', m1),
].join('\n')

const subLinjer = assistent('s1', '2026-09-27T10:02:00.000Z', { output_tokens: 1_000, cache_read_input_tokens: 10_000 }, [], 'claude-haiku-4-5')

const testprojekt = () => {
  const hoved = nySamling()
  for (const linje of hovedLinjer.split('\n')) laesLinje(hoved, linje)
  const sub = nySamling({ id: 'a1', beskrivelse: 'Find billeder', type: 'Explore' })
  laesLinje(sub, subLinjer)
  return projekt([hoved, sub])
}

const naer = (faktisk: number | undefined, forventet: number) => expect(Math.abs((faktisk ?? NaN) - forventet)).toBeLessThan(1e-9)

describe('projekt', () => {
  test('linjer for samme kald lægges sammen, og kun brugerens egne beskeder er opgaver', () => {
    const p = testprojekt()

    expect(p.titel).toBe('Testagent')
    expect(p.kald).toBe(5)
    expect(p.opgaver.map(o => [o.nr, o.tekst, o.dagNr])).toEqual([
      [1, 'Byg forsiden', 1],
      [2, 'Ret menuen', 1],
      [3, 'Lav kontaktsiden', 2],
    ])
    const [o1, o2, o3] = p.opgaver
    naer(o1?.usd, 0.120662)
    naer(o2?.usd, 0.03)
    naer(o3?.usd, 0.03004)
    expect(o2?.raa.afbrudt).toBe(true)
    expect(o1?.raa.kald).toEqual([{ loop: '', trin: 0, etiket: 'Read stor.ts', tegn: 35_000 }])
    expect(o1?.raa.trin[0]).toMatchObject({ svarTegn: 'Jeg læser filen'.length, vaerktoejsInput: [{ etiket: 'Read stor.ts' }] })
    expect(o3?.raa.agenter).toEqual({ a1: { beskrivelse: 'Find billeder', type: 'Explore' } })

    expect(p.dage.map(d => d.dato)).toEqual([datoNoegle(Date.parse('2026-09-26T09:00:00Z')), datoNoegle(Date.parse('2026-09-27T10:00:00Z'))])
    expect(p.dage[0]).toMatchObject({ nr: 1, opgaver: 2, kald: 3, aktivMin: 14 })
    expect(p.dage[1]).toMatchObject({ nr: 2, opgaver: 1, kald: 2, aktivMin: 1 })
    naer(p.dage[1]?.subUsd, 0.006)
    naer(p.usd, 0.180702)
  })

  test('prisen følger cachens levetid og hurtig tilstand', () => {
    naer(kaldUsd('claude-opus-5-5', m1), 0.02404)
    naer(kaldUsd('claude-opus-5-5', lille), 0.03)
    naer(kaldUsd('claude-opus-5-5', { cache_creation_input_tokens: 1_000 }), 0.005)
    naer(kaldUsd('claude-opus-5-5', { ...m1, speed: 'fast' }), 0.04808)
  })
})

describe('tekster', () => {
  test('projektet viser de dyreste opgaver først, uden linjer der ligner en nummereret liste', () => {
    const linjer = projektTekst(testprojekt())

    expect(linjer[0]).toBe('Testagent · hele projektet')
    expect(linjer[1]).toContain('3 opgaver · 2 aktive dage')
    const opgavelinjer = linjer.filter(l => /opgave \d+ ·/.test(l))
    expect(opgavelinjer.map(l => /opgave (\d+)/.exec(l)?.[1])).toEqual(['1', '3', '2'])
    expect(opgavelinjer[0]?.startsWith('█')).toBe(true)
    expect(linjer.some(l => /^\s*\d+[.)]\s/.test(l))).toBe(false)
    expect(linjer.some(l => l.includes('den seneste er 3'))).toBe(true)
  })

  test('en opgave forklares ud fra transcriptet', () => {
    const p = testprojekt()
    const linjer = opgaveTekst(p, 1)

    expect(linjer[0]).toMatch(/^Opgave 1 · dag 1 · \S+ 26\. sep: "Byg forsiden"$/)
    expect(linjer).toContain('Hvorfor: Read stor.ts gav 10.0k tokens.')
    expect(opgaveTekst(p, 2)[0]).toContain('(afbrudt)')
    expect(opgaveTekst(p, 3).some(l => l.includes('Subagent: Find billeder'))).toBe(true)
    expect(opgaveTekst(p, 9)[0]).toBe('Opgave 9 findes ikke. Testagent har 3 opgaver.')
  })

  test('dagene vises med bjælker, og værktøjsversionen uden', () => {
    const p = testprojekt()
    const dage = dageTekst(p)

    expect(dage[1]).toContain('2 aktive dage')
    expect(dage.find(l => l.includes('dag 1 ·'))?.startsWith('█')).toBe(true)
    const dag2 = dagTekst(p, 2, false)
    expect(dag2.join('\n')).not.toContain('█')
    expect(dag2.some(l => l.includes('subagenter'))).toBe(true)
    expect(dag2.some(l => l.includes('opgave 3 · "Lav kontaktsiden"'))).toBe(true)
  })
})
