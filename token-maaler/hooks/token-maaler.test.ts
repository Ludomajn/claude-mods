import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const brug = (input: number, output: number, cacheLaes: number, cacheSkriv: number, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheLaes,
  cache_creation_input_tokens: cacheSkriv,
  model,
})

const kategorier = [
  { name: 'Messages', tokens: 40_000, kind: 'used', color: 'x', isDeferred: false },
  { name: 'System tools', tokens: 9_000, kind: 'used', color: 'x', isDeferred: false },
  { name: 'Free space', tokens: 900_000, kind: 'free', color: 'x', isDeferred: false },
]

// Hvad modellen svarer i hver runde af den live-målte opgave, nøglet på loop og index.
const svar: Record<string, unknown> = {
  ':0': {
    answer: '',
    toolUses: [{ name: 'Agent', input: { description: 'Find filer', prompt: 'Find den store fil' } }],
    stopReason: 'tool_use',
    usage: brug(10, 300, 40_000, 1_000),
  },
  'a1:0': { answer: '', toolUses: [], stopReason: 'tool_use', usage: brug(0, 500, 10_000, 4_000, 'claude-haiku-4-5') },
  'a1:1': { answer: 'fundet', toolUses: [], stopReason: 'end_turn', usage: brug(0, 500, 14_000, 600, 'claude-haiku-4-5') },
  ':1': {
    answer: '',
    toolUses: [{ name: 'Read', input: { file_path: '/x/big.ts' } }],
    stopReason: 'tool_use',
    usage: brug(5, 200, 41_010, 600),
  },
  ':2': { answer: 'Færdig. '.repeat(175), toolUses: [], stopReason: 'end_turn', usage: brug(5, 400, 41_615, 10_300) },
}

// Motorens svar under en live-målt opgave.
const motor = (on: On, toasts: string[], aabnet: string[], usd: () => number) => {
  on('session.usage', async (_, e) => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, ...(e.breakdown ? { breakdown: { categories: kategorier } } : {}) },
      rateLimits: [{}],
      cost: { usd: usd() },
    } as never,
  }))
  on('agent.list', async () => ({ value: [{ id: 'a1', description: 'Find filer', type: 'Explore', status: 'completed' }] as never }))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('tool.call', async (_, e) => ({ result: {} as never, text: e.tool === 'Read' ? 'x'.repeat(35_000) : 'rapport' }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_, e) => {
    aabnet.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, ...(svar[`${e.agentId ?? ''}:${e.index}`] as object) } as never
  })
}

const baandProps = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const panelProps = { title: 'Token-forbrug', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('en live-målt opgave vises i båndet og som besked', async ($, on) => {
  const ur = mock.clock(on)
  let usd = 1
  const toasts: string[] = []
  const aabnet: string[] = []
  motor(on, toasts, aabnet, () => usd)

  const vaerktoej = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  const trin = async (e: { turnId: string; index: number; model: string; agentId?: string }) => {
    const stroem = $.turn.step({ ...e, messageCount: 1 })
    for await (const _ of stroem) {
      // tøm strømmen
    }
    return stroem.result
  }

  await $.turn.start({ text: 'Find og læs den store fil', turnId: 't1' })
  await trin({ turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await trin({ turnId: 'ta1', index: 0, model: 'claude-haiku-4-5', agentId: 'a1' })
  await trin({ turnId: 'ta1', index: 1, model: 'claude-haiku-4-5', agentId: 'a1' })
  await $.turn.complete({ answer: 'fundet', durationMs: 1, isAborted: false, turnId: 'ta1', agentId: 'a1', reason: 'answer' } as never)
  await vaerktoej({ tool: 'Agent', description: 'Find filer', prompt: 'Find den store fil' })
  await trin({ turnId: 't1', index: 1, model: 'claude-opus-5-5' })
  await vaerktoej({ tool: 'Read', file_path: '/x/big.ts' })
  await trin({ turnId: 't1', index: 2, model: 'claude-opus-5-5' })
  await ur.advance(12_000)
  usd = 1.3
  await $.turn.complete({ answer: 'Færdig.', durationMs: 12_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  expect(toasts).toEqual([expect.stringMatching(/^Seneste opgave: .*\$0\.30 · 3 runder · mest: Read big\.ts \(\d+%\) · \/tokens$/)])

  for (const surface of ['terminal', 'desktop'] as const) {
    const baand = await $.ui.mount({ plugin: 'token-maaler', surface, component: 'AbovePrompt', props: baandProps } as never)
    expect((await baand.find({ type: 'Text', text: /Sidste opgave: .*mest: Read big\.ts/ }))?.type).toBe('Text')
    expect(await baand.find({ key: 'detaljer' })).toBeDefined()
    await baand.press({ key: 'projekt' })
    await baand.unmount()
  }
  expect(aabnet).toEqual(['token-maaler', 'token-maaler'])
})

test('båndet er skjult, før en opgave er målt', async ($, on) => {
  mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect(await baand.find({ text: /Sidste opgave/ })).toBeUndefined()
})

const linje = (type: string, tid: string, felter: object) => JSON.stringify({ type, timestamp: tid, ...felter })
const kald = (id: string, tid: string, content: unknown[] = [], model = 'claude-opus-5-5') =>
  linje('assistant', tid, { message: { id, model, content, usage: { output_tokens: 1_000, cache_read_input_tokens: 100_000 } } })
const transcript = [
  JSON.stringify({ type: 'custom-title', customTitle: 'Webshop-agent' }),
  linje('user', '2026-09-26T09:00:00.000Z', { message: { role: 'user', content: 'Byg forsiden' } }),
  kald('m1', '2026-09-26T09:01:00.000Z', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/stor.ts' } }]),
  kald('m1', '2026-09-26T09:01:00.300Z'),
  linje('user', '2026-09-26T09:02:00.000Z', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(7_000) }] } }),
  kald('m2', '2026-09-26T09:03:00.000Z'),
  linje('user', '2026-09-27T10:00:00.000Z', { message: { role: 'user', content: 'Lav kontaktsiden' } }),
  kald('m3', '2026-09-27T10:01:00.000Z'),
].join('\n')

test('historikken: /tokens viser projektet, /tokens <nr> en opgave, og panelet og værktøjet følger med', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/h' })
  const mappe = '/h/.claude/projects/-p-x'
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/p/x' }))
  on('fs.exists', async (_, e) => ({ value: [`${mappe}/s1.jsonl`, mappe].includes(e.path) }))
  on('fs.list', async (_, e) => ({
    value: (e.path === `${mappe}/s1/subagents` ? [{ name: 'agent-a1.jsonl', kind: 'file', size: 300, mtimeMs: 1 }] : []) as never,
  }))
  on('fs.stat', async (_, e) => ({ value: { kind: 'file', size: e.path.endsWith('s1.jsonl') ? 5_000_000 : 300, mtimeMs: 1, isLink: false } }))
  on('fs.read', async (_, e) => ({
    value: e.path.endsWith('.meta.json') ? '{"description":"Find billeder","agentType":"Explore"}' : kald('s1', '2026-09-27T10:02:00.000Z', [], 'claude-haiku-4-5'),
  }))
  // Den store fil kommer gennem cat i to stykker, delt midt i en linje.
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: transcript.slice(0, 101) }
    yield { stream: 'stdout', text: transcript.slice(101) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', async () => ({ value: undefined }))

  const kommando = async (args: string) => (await $.command.run({ command: 'tokens', args } as never)).text ?? ''

  const oversigt = await kommando('')
  expect(oversigt).toContain('Webshop-agent · hele projektet')
  expect(oversigt).toContain('2 opgaver · 2 aktive dage')
  expect(oversigt.split('\n').find(l => l.includes('opgave 1 ·'))?.startsWith('█')).toBe(true)
  expect(oversigt.split('\n').some(l => /^\s*\d+[.)]\s/.test(l))).toBe(false)

  const opgave1 = await kommando('1')
  expect(opgave1).toContain('Opgave 1 · dag 1 ·')
  expect(opgave1).toContain('Read stor.ts')
  expect(await kommando('9')).toContain('Opgave 9 findes ikke.')
  expect(await kommando('dage')).toContain('2 aktive dage')
  const dag2 = await kommando('dag 2')
  expect(dag2).toContain('opgave 2 · "Lav kontaktsiden"')
  expect(dag2).toContain('subagenter')

  const vaerktoej = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  const svar1 = String((await vaerktoej({ tool: 'mcp__token-maaler__historik', opgave: 2 })).result)
  expect(svar1).toContain('Opgave 2 · dag 2 ·')
  expect(svar1).toContain('Subagent: Find billeder')
  expect(svar1).not.toContain('█')
  const svarAlt = String((await vaerktoej({ tool: 'mcp__token-maaler__historik' })).result)
  expect(svarAlt).toContain('hele projektet')
  expect(svarAlt).toContain('2 aktive dage')

  const panel = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'Pane', requestId: 'token-maaler', props: panelProps } as never)
  await panel.press({ key: 'projekt' })
  expect(await panel.find({ type: 'Text', text: /hele projektet/ })).toBeDefined()
  expect((await panel.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('cyan')
  await panel.press({ key: 'dage' })
  expect(await panel.find({ type: 'Text', text: /2 aktive dage/ })).toBeDefined()
  await panel.unmount()
})
