import { describe, expect, test } from 'claude-code/testing'

import { byg, dagTekst, dageTekst, datoNoegle, kaldUsd, laesLinje, nySamling } from './historik'

const time1 = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 }
const stor = { input_tokens: 10, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000, cache_creation: time1 }
const lille = {
  input_tokens: 0,
  output_tokens: 500,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 2_000,
  cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
}

const assistent = (id: string, tid: string, usage: object, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: tid, message: { id, model, usage } })
const bruger = (tid: string, content: unknown, ekstra: object = {}) =>
  JSON.stringify({ type: 'user', timestamp: tid, message: { role: 'user', content }, ...ekstra })

const hovedLinjer = [
  JSON.stringify({ type: 'custom-title', customTitle: 'Testagent', sessionId: 's1' }),
  bruger('2026-09-26T09:00:00.000Z', 'Byg forsiden'),
  assistent('m1', '2026-09-26T09:01:00.000Z', stor),
  assistent('m1', '2026-09-26T09:01:00.500Z', stor),
  bruger('2026-09-26T09:02:00.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  assistent('m2', '2026-09-26T09:05:00.000Z', stor),
  bruger('2026-09-26T09:30:00.000Z', '<command-name>/tokens</command-name>'),
  bruger('2026-09-26T09:31:00.000Z', 'skjult', { isMeta: true }),
  bruger('2026-09-26T09:40:00.000Z', [
    { type: 'text', text: '<system-reminder>husk</system-reminder>' },
    { type: 'text', text: 'Ret menuen' },
  ]),
  assistent('m3', '2026-09-26T09:41:00.000Z', lille),
  bruger('2026-09-26T09:45:00.000Z', '<task-notification> <task-id>a1</task-id> færdig'),
  bruger('2026-09-27T10:00:00.000Z', 'Lav kontaktsiden'),
  assistent('m4', '2026-09-27T10:01:00.000Z', stor),
].join('\n')

const subLinjer = assistent('s1', '2026-09-27T10:02:00.000Z', { output_tokens: 1_000, cache_read_input_tokens: 10_000 }, 'claude-haiku-4-5')

const historik = () => {
  const hoved = nySamling()
  for (const linje of hovedLinjer.split('\n')) laesLinje(hoved, linje, true)
  const sub = nySamling()
  laesLinje(sub, subLinjer, false)
  return byg([hoved, sub])
}

const naer = (faktisk: number | undefined, forventet: number) => expect(Math.abs((faktisk ?? NaN) - forventet)).toBeLessThan(1e-9)

describe('historik', () => {
  test('kald tælles én gang, og kun brugerens egne beskeder er opgaver', () => {
    const h = historik()

    expect(h.titel).toBe('Testagent')
    expect(h.kald).toBe(5)
    expect(h.opgaver).toBe(3)
    expect(h.dage.map(d => d.dato)).toEqual([
      datoNoegle(Date.parse('2026-09-26T09:00:00Z')),
      datoNoegle(Date.parse('2026-09-27T10:00:00Z')),
    ])
    const [dag1, dag2] = h.dage
    expect(dag1).toMatchObject({ nr: 1, opgaver: 2, kald: 3, aktivMin: 14 })
    naer(dag1?.usd, 0.19008)
    expect(dag1?.dyreste.map(o => o.tekst)).toEqual(['Byg forsiden', 'Ret menuen'])
    naer(dag1?.dyreste[0]?.usd, 0.16008)
    expect(dag2).toMatchObject({ nr: 2, opgaver: 1, kald: 2, aktivMin: 1 })
    naer(dag2?.usd, 0.08604)
    naer(dag2?.subUsd, 0.006)
    naer(h.usd, 0.27612)
  })

  test('prisen følger cachens levetid og hurtig tilstand', () => {
    naer(kaldUsd('claude-opus-5-5', stor), 0.08004)
    naer(kaldUsd('claude-opus-5-5', lille), 0.03)
    naer(kaldUsd('claude-opus-5-5', { cache_creation_input_tokens: 1_000 }), 0.005)
    naer(kaldUsd('claude-opus-5-5', { ...stor, speed: 'fast' }), 0.16008)
  })

  test('oversigten viser dagene med bjælker, og værktøjsversionen uden', () => {
    const h = historik()
    const visuel = dageTekst(h)

    expect(visuel[0]).toBe('Testagent')
    expect(visuel[1]).toContain('2 aktive dage · $0.28 i alt')
    expect(visuel.find(l => l.includes('dag 1 ·'))?.startsWith('█')).toBe(true)
    expect(visuel).toContain('Dyreste dag: dag 1 ($0.19). Skriv /tokens dag 1 for detaljer.')

    const dag2 = dagTekst(h, 2, false)
    expect(dag2.join('\n')).not.toContain('█')
    expect(dag2.some(l => l.includes('subagenter'))).toBe(true)
    expect(dag2).toContain('Dyreste opgaver:')
    expect(dag2.some(l => l.includes('"Lav kontaktsiden"'))).toBe(true)
    expect(dagTekst(h, 9)[0]).toBe('Dag 9 findes ikke. Testagent har 2 aktive dage.')
  })
})
