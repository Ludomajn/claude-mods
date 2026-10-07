import { expect, mock, test } from 'claude-code/testing'

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

// Hvad modellen svarer i hver runde, nøglet på loop og index.
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

test('måler en opgave og viser den i /tokens, båndet og panelet', async ($, on) => {
  const ur = mock.clock(on)
  let usd = 1
  const aabnet: string[] = []
  on('session.usage', async (_, e) => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, ...(e.breakdown ? { breakdown: { categories: kategorier } } : {}) },
      rateLimits: [{}],
      cost: { usd },
    } as never,
  }))
  on('agent.list', async () => ({ value: [{ id: 'a1', description: 'Find filer', type: 'Explore', status: 'completed' }] as never }))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('tool.call', async (_, e) => ({ result: {} as never, text: e.tool === 'Read' ? 'x'.repeat(35_000) : 'rapport' }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async (_, e) => {
    aabnet.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, ...(svar[`${e.agentId ?? ''}:${e.index}`] as object) } as never
  })

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

  const { text } = await $.command.run({ command: 'tokens', args: '' } as never)
  expect(text).toContain('Opgave 1: "Find og læs den store fil"')
  expect(text).toContain('$0.30 · 3 runder (modelkald) · 1 subagent · 12s')
  expect(text).toContain('Hvorfor: Read big.ts gav 10.1k tokens')
  expect(text).toContain('Subagent: Find filer')
  expect(text).toContain('Samtalen ved start: Beskeder 40.0k · Værktøjer 9.0k')

  const ukendt = await $.command.run({ command: 'tokens', args: '5' } as never)
  expect(ukendt.text).toBe('Opgave 5 findes ikke. Der er opgave 1–1.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const baand = await $.ui.mount({
      plugin: 'token-maaler',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    } as never)
    expect((await baand.find({ type: 'Text', text: /Sidste opgave: .*mest: Read big\.ts/ }))?.type).toBe('Text')
    await baand.press({ key: 'detaljer' })
    await baand.unmount()

    const panel = await $.ui.mount({
      plugin: 'token-maaler',
      surface,
      component: 'Pane',
      requestId: 'token-maaler',
      props: { title: 'Token-forbrug', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    expect(await panel.find({ text: 'Hvad prisen gik til (ca.):' })).toBeDefined()
    expect(await panel.find({ key: 'forrige' })).toBeUndefined()
    await panel.unmount()
  }
  expect(aabnet).toEqual(['token-maaler', 'token-maaler'])
})

test('båndet er skjult, før en opgave er målt', async ($, on) => {
  mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const baand = await $.ui.mount({
    plugin: 'token-maaler',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  expect(await baand.find({ text: /Sidste opgave/ })).toBeUndefined()
  const { text } = await $.command.run({ command: 'tokens', args: '' } as never)
  expect(text).toContain('Ingen opgaver målt endnu i denne session.')
})

const linje = (type: string, tid: string, felter: object) => JSON.stringify({ type, timestamp: tid, ...felter })
const kald = (id: string, tid: string, model = 'claude-opus-5-5') =>
  linje('assistant', tid, { message: { id, model, usage: { output_tokens: 1_000, cache_read_input_tokens: 100_000 } } })
const transcript = [
  JSON.stringify({ type: 'custom-title', customTitle: 'Webshop-agent' }),
  linje('user', '2026-09-26T09:00:00.000Z', { message: { role: 'user', content: 'Byg forsiden' } }),
  kald('m1', '2026-09-26T09:01:00.000Z'),
  kald('m1', '2026-09-26T09:01:00.300Z'),
  linje('user', '2026-09-27T10:00:00.000Z', { message: { role: 'user', content: 'Lav kontaktsiden' } }),
  kald('m2', '2026-09-27T10:01:00.000Z'),
].join('\n')

test('historikken læser agentens transcripts: /tokens dage, /tokens dag, værktøjet og panelet', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/h' })
  const mappe = '/h/.claude/projects/-p-x'
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/p/x' }))
  on('fs.exists', async (_, e) => ({ value: [`${mappe}/s1.jsonl`, mappe].includes(e.path) }))
  on('fs.list', async (_, e) => ({
    value: (e.path === `${mappe}/s1/subagents` ? [{ name: 'agent-a.jsonl', kind: 'file', size: 300, mtimeMs: 1 }] : []) as never,
  }))
  on('fs.stat', async (_, e) => ({ value: { kind: 'file', size: e.path.endsWith('s1.jsonl') ? 5_000_000 : 300, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: kald('s1', '2026-09-27T10:02:00.000Z', 'claude-haiku-4-5') }))
  // Den store fil kommer gennem cat i to stykker, delt midt i en linje.
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: transcript.slice(0, 101) }
    yield { stream: 'stdout', text: transcript.slice(101) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', async () => ({ value: undefined }))

  const oversigt = (await $.command.run({ command: 'tokens', args: 'dage' } as never)).text ?? ''
  expect(oversigt).toContain('Webshop-agent')
  expect(oversigt).toContain('2 aktive dage · $0.095 i alt')
  expect(oversigt).toContain('█')

  const dag2 = (await $.command.run({ command: 'tokens', args: 'dag 2' } as never)).text ?? ''
  expect(dag2).toContain('Dag 2 ·')
  expect(dag2).toContain('"Lav kontaktsiden"')
  expect(dag2).toContain('subagenter')

  const vaerktoej = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  const svar = await vaerktoej({ tool: 'mcp__token-maaler__historik', dag: 1 })
  expect(String(svar.result)).toContain('Dag 1 ·')
  expect(String(svar.result)).not.toContain('█')

  const panel = await $.ui.mount({
    plugin: 'token-maaler',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'token-maaler',
    props: { title: 'Token-forbrug', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await panel.find({ type: 'Text', text: /Ingen opgaver målt/ })).toBeDefined()
  await panel.press({ key: 'dage' })
  expect(await panel.find({ type: 'Text', text: /2 aktive dage/ })).toBeDefined()
  expect((await panel.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('cyan')
  await panel.press({ key: 'opgaver' })
  expect(await panel.find({ key: 'dage' })).toBeDefined()
  await panel.unmount()
})
