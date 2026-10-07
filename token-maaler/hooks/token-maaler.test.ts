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

  expect(toasts).toEqual([expect.stringMatching(/^Opgaven brugte 1,95 kr · (<1|\d+) min$/)])

  for (const surface of ['terminal', 'desktop'] as const) {
    const baand = await $.ui.mount({ plugin: 'token-maaler', surface, component: 'AbovePrompt', props: baandProps } as never)
    expect((await baand.find({ type: 'Text', text: /Sidste opgave: .*mest: Read big\.ts/ }))?.type).toBe('Text')
    expect(await baand.find({ key: 'detaljer' })).toBeDefined()
    expect((await baand.find({ key: 'raad' }))?.props.label).toBe('Råd')
    expect(await baand.find({ key: 'projekt' })).toBeUndefined()
    await baand.press({ key: 'forbrug' })
    await baand.unmount()
  }
  expect(aabnet).toEqual(['token-maaler', 'token-maaler'])
})

test('en ny samtale viser velkomsten med Indsigt, til Skjul trykkes', async ($, on) => {
  mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect(await baand.find({ text: /Sidste opgave/ })).toBeUndefined()
  expect(await baand.find({ type: 'Text', text: /^Bliv klogere på dit forbrug og dine prompts/ })).toBeDefined()
  expect((await baand.find({ key: 'indsigt' }))?.props.label).toBe('Indsigt')
  await baand.press({ key: 'skjul' })
  expect(await baand.find({ type: 'Text', text: /Bliv klogere/ })).toBeUndefined()
  await baand.unmount()
})

test('indstillingerne i /config kan slå velkomsten fra', { options: { velkomst: false } }, async ($, on) => {
  mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect(await baand.find({ type: 'Text', text: /Bliv klogere/ })).toBeUndefined()
  await baand.unmount()
})

// To projektmapper med hver sin samtale; den lange samtale giver et råd om /compact.
// En sti i `laaste` kan ikke læses, så det kan ses, at et resume kommer fra $.store.
const toMapper = (on: On, laaste: Set<string>) => {
  mock.env(on, { HOME: '/h' })
  const rod = '/h/.claude/projects'
  const filer: Record<string, string> = {
    [`${rod}/-p-x/s1.jsonl`]: transcript,
    [`${rod}/-p-y/s2.jsonl`]: [JSON.stringify({ type: 'custom-title', customTitle: 'Bæverspil' }), langTranscript].join('\n'),
  }
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/p/x' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } as never }))
  on('fs.exists', async (_, e) => ({ value: e.path in filer || [`${rod}/-p-x`, `${rod}/-p-y`].includes(e.path) }))
  on('fs.list', async (_, e) => ({
    value: (e.path === rod
      ? [{ name: '-p-x', kind: 'dir', size: 0, mtimeMs: 0 }, { name: '-p-y', kind: 'dir', size: 0, mtimeMs: 0 }]
      : Object.keys(filer).filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.split('/').pop(), kind: 'file', size: (filer[f] ?? '').length, mtimeMs: 1 }))) as never,
  }))
  on('fs.stat', async (_, e) => ({ value: { kind: 'file', size: (filer[e.path] ?? '').length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async (_, e) => {
    const tekst = filer[e.path]
    if (tekst === undefined || laaste.has(e.path)) throw new Error('kan ikke læses')
    return { value: tekst }
  })
}

test('/tokens råd alle samler alle samtaler i alle projektmapper og husker resumeerne', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const laaste = new Set<string>()
  toMapper(on, laaste)
  const aabnet: string[] = []
  on('ui.open', async (_, e) => {
    aabnet.push(e.id)
    return { value: { isPlaced: true } as never }
  })

  const tekst = (await $.command.run({ command: 'tokens', args: 'råd alle' } as never)).text ?? ''
  const linjer = tekst.split('\n')
  expect(linjer.slice(0, 8)).toEqual([
    '**Indsigt i dit Claude-forbrug**',
    expect.stringMatching(/^2 samtaler · 3 aktive dage · \d+,\d+ kr i alt$/),
    '',
    '**Råd på tværs** · tal = kroner, du cirka kunne have sparet',
    '',
    '██████████ **4,39 kr · Lang samtale** · 1 samtale',
    'I Bæverspil (4,39 kr).',
    '→ Skriv `/compact`, når en opgave er færdig, så hver runde læser mindre.',
  ])
  expect(linjer.slice(-3)).toEqual([
    '**Dyreste samtaler**',
    expect.stringMatching(/^██████████ \d+,\d+ kr · Bæverspil$/),
    expect.stringMatching(/^█░+ \d+,\d+ kr · Webshop-agent$/),
  ])
  // Bæverspil er uændret, så dens resume hentes fra $.store i stedet for at læse filen igen.
  laaste.add('/h/.claude/projects/-p-y/s2.jsonl')
  expect((await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text).toBe(tekst)

  const vaerktoej = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  const svar = String((await vaerktoej({ tool: 'mcp__token-maaler__historik', alle: true })).result)
  expect(svar).toContain('**4,39 kr · Lang samtale** · 1 samtale\nI Bæverspil (4,39 kr).')
  expect(svar).not.toContain('█')

  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  await baand.press({ key: 'indsigt' })
  await baand.unmount()
  expect(aabnet).toEqual(['token-maaler'])
  const panel = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'Pane', requestId: 'token-maaler', props: panelProps } as never)
  // Overskriften er fed, forklaringen under et råd dæmpet, handlingen grøn og kommandoen i farve.
  expect((await panel.find({ type: 'Text', text: /^Indsigt i dit Claude-forbrug$/ }))?.props.bold).toBe(true)
  expect((await panel.find({ type: 'Text', text: /^I Bæverspil/ }))?.props.dimColor).toBe(true)
  expect((await panel.find({ type: 'Text', text: /^→ Skriv / }))?.props.color).toBe('green')
  expect((await panel.find({ type: 'Text', text: /^\/compact$/ }))?.props.color).toBe('cyan')
  await panel.unmount()
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
  mock.store(on)
  // Haiku beskriver opgaverne; hvert kald tælles, så det kan ses, at beskrivelserne gemmes.
  const beskrevet: string[] = []
  on('model.complete', async (_, e) => {
    const opgave = e.prompt.includes('Lav kontaktsiden') ? 'kontaktsiden' : 'forsiden'
    beskrevet.push(opgave)
    return { value: { isAnswered: true, text: `"Byggede ${opgave}."`, usage: {} } as never }
  })

  const kommando = async (args: string) => (await $.command.run({ command: 'tokens', args } as never)).text ?? ''

  const oversigt = await kommando('')
  expect(oversigt).toContain('Webshop-agent · hele projektet')
  expect(oversigt).toContain('2 opgaver · 2 aktive dage')
  expect(oversigt.split('\n').find(l => l.endsWith('- opgave 1'))).toMatch(/^█+░* 0,52 kr - Dag 1 - Byggede forsiden\. - opgave 1$/)
  expect(beskrevet.sort()).toEqual(['forsiden', 'kontaktsiden'])
  await kommando('')
  expect(beskrevet).toHaveLength(2)
  expect(oversigt.split('\n').some(l => /^\s*\d+[.)]\s/.test(l))).toBe(false)

  const opgave1 = await kommando('1')
  expect(opgave1).toContain('Opgave 1 · dag 1 ·')
  expect(opgave1).toContain(': Byggede forsiden.\nDin besked: "Byg forsiden"')
  expect(opgave1).toContain('Read stor.ts')
  expect(await kommando('9')).toContain('Opgave 9 findes ikke.')
  expect(await kommando('dage')).toContain('2 aktive dage')
  const dag2 = await kommando('dag 2')
  expect(dag2).toContain('- Byggede kontaktsiden. - opgave 2')
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
  expect(await panel.find({ key: 'projekt' })).toBeUndefined()
  await panel.press({ key: 'forbrug' })
  // Forbrug: graferne øverst og ugens dyreste samtaler under dem.
  expect((await panel.find({ type: 'Text', text: /^Ugen pr\. dag$/ }))?.props.bold).toBe(true)
  // Uden målte grænser er der kun søjlerne for ugen; den seneste opgave vises ikke her.
  expect(await panel.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(await panel.find({ type: 'Text', text: /Seneste opgave/ })).toBeUndefined()
  // Forbrug gælder alle samtaler; her er der ingen i de seneste 7 dage.
  expect(await panel.find({ type: 'Text', text: /^Intet forbrug de seneste 7 dage\.$/ })).toBeDefined()
  await panel.press({ key: 'dage' })
  expect(await panel.find({ type: 'Text', text: /2 aktive dage/ })).toBeDefined()
  expect((await panel.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('cyan')
  await panel.unmount()
})

// Testmotoren kender setTimeout, men motorens typer gør ikke.
const vent = (ms: number) =>
  new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, ms))

// En samtale på 400k tokens, der læses igen i 10 runder: nok til et råd om /compact.
const langTranscript = [
  linje('user', '2026-10-01T09:00:00.000Z', { message: { role: 'user', content: 'Byg det hele' } }),
  ...Array.from({ length: 10 }, (_, i) =>
    linje('assistant', `2026-10-01T09:${String(i + 1).padStart(2, '0')}:00.000Z`, {
      message: { id: `L${i}`, model: 'claude-opus-5-5', content: [], usage: { output_tokens: 100, cache_read_input_tokens: 400_000 } },
    }),
  ),
].join('\n')

test('analytikeren finder et råd efter en opgave i en lang samtale og viser det i båndet, ikke som besked', async ($, on) => {
  const ur = mock.clock(on)
  mock.env(on, { HOME: '/h' })
  mock.store(on)
  const toasts: string[] = []
  motor(on, toasts, [], () => 1)
  const mappe = '/h/.claude/projects/-p-x'
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/p/x' }))
  on('fs.exists', async (_, e) => ({ value: [`${mappe}/s1.jsonl`, mappe].includes(e.path) }))
  on('fs.list', async () => ({ value: [] as never }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: 3_000, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: langTranscript }))

  const raadToasts = () => toasts.filter(t => t.startsWith('Råd:'))
  const enOpgave = async (turnId: string) => {
    await $.turn.start({ text: 'Byg det hele', turnId })
    const stroem = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for await (const _ of stroem) {
      // tøm strømmen
    }
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
    await ur.advance(3_000)
  }
  const raadKnap = async () => {
    const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
    const label = (await baand.find({ key: 'raad' }))?.props.label
    await baand.unmount()
    return label
  }

  await enOpgave('t1')
  // Analytikeren kører i en timer; giv den lidt tid til at blive færdig.
  for (let i = 0; i < 50 && (await raadKnap()) !== 'Råd (1)'; i++) await vent(10)
  expect(await raadKnap()).toBe('Råd (1)')
  expect(raadToasts()).toEqual([])

  const tekst = (await $.command.run({ command: 'tokens', args: 'råd' } as never)).text ?? ''
  expect(tekst).toContain('**Råd til at bruge færre tokens**')
  expect(tekst).toContain('→ Skriv `/compact`, når en opgave er færdig')
})

test('Dine prompts: Opus finder rettelserne, Sonnet skriver prompten, Haiku forklarer, og forslagene huskes', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  toMapper(on, new Set())
  on('ui.open', async () => ({ value: { isPlaced: true } as never }))
  const kaldt: string[] = []
  on('model.complete', async (_, e) => {
    kaldt.push(`${e.model}:${e.effort ?? ''}`)
    const usage = { input_tokens: 10_000, output_tokens: 1_000 }
    // Webshop-agenten: besked 2 rettede besked 1; Bæverspillet har ingen rettelser.
    const svar =
      e.model === 'opus'
        ? e.prompt.includes('Byg forsiden')
          ? '```json\n{"kaeder": [{"start": 1, "rettelser": [2, 9], "oenske": "En forside med kontaktside", "manglede": "kontaktsiden"}]}\n```'
          : '{"kaeder": []}'
        : e.model === 'sonnet'
          ? '«Byg forsiden og en kontaktside\n\nmed formular»'
          : '{"punkter": [{"navn": "Forside med kontakt", "manglede": "at kontaktsiden hørte med."}]}'
    return { value: { isAnswered: true, text: svar, usage } as never }
  })

  const tekst = (await $.command.run({ command: 'tokens', args: 'promptsmart' } as never)).text ?? ''
  expect(tekst.split('\n')).toEqual([
    '**Dine prompts**',
    'Prompts, der kunne have ramt første gang · tal = kroner, rettelserne bagefter brugte',
    '',
    '██████████ **0,26 kr · Forside med kontakt** · Webshop-agent',
    'Du skrev: «Byg forsiden» Det manglede: at kontaktsiden hørte med.',
    '→ Prøv: «Byg forsiden og en kontaktside med formular»',
    '',
    'Gennemgik dine 2 dyreste samtaler.',
  ])
  expect(kaldt.sort()).toEqual(['haiku:low', 'opus:high', 'opus:high', 'sonnet:medium'])

  // Uændrede samtaler analyseres ikke igen.
  await $.command.run({ command: 'prompts', args: '' } as never)
  expect(kaldt).toHaveLength(4)

  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect((await baand.find({ key: 'promptsmart' }))?.props.label).toBe('Dine prompts')
  await baand.press({ key: 'promptsmart' })
  await baand.unmount()
  const panel = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'Pane', requestId: 'token-maaler', props: panelProps } as never)
  expect((await panel.find({ type: 'Text', text: /^Dine prompts$/ }))?.props.bold).toBe(true)
  expect((await panel.find({ type: 'Text', text: /^Du skrev: «Byg forsiden»/ }))?.props.dimColor).toBe(true)
  expect((await panel.find({ type: 'Text', text: /^→ Prøv: / }))?.props.color).toBe('green')
  expect(await panel.find({ key: 'promptsmart' })).toBeDefined()
  await panel.unmount()
})

test('Dine prompts kan slås fra i /config', { options: { promptsmart: false } }, async ($, on) => {
  mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect(await baand.find({ key: 'indsigt' })).toBeDefined()
  expect(await baand.find({ key: 'promptsmart' })).toBeUndefined()
  await baand.unmount()
})

test('Dine prompts gemmer intet og siger det, når modellerne ikke svarer', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  toMapper(on, new Set())
  let svar = false
  on('model.complete', async () =>
    ({ value: svar ? { isAnswered: true, text: '{"kaeder": []}', usage: {} } : { isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: {} } }) as never,
  )
  expect((await $.command.run({ command: 'prompts', args: '' } as never)).text).toBe(
    'Kunne ikke gennemgå dine prompts: modellerne svarede ikke (opus: authentication_failed). Prøv igen om lidt.',
  )
  svar = true
  expect((await $.command.run({ command: 'prompts', args: '' } as never)).text).toContain('Ingen prompts at forbedre')
})

test('grænserne måles ud fra forbruget i deres vinduer, og så står tallene som andel af ugen med kroner som ekstra', async ($, on) => {
  const ur = mock.clock(on)
  mock.store(on)
  toMapper(on, new Set())
  on('session.measure', async (_, e) => ({ changed: e.changed }))
  // Bæverspillets 10 kald på 2026-10-01 kl. 09 kostede $0.82; Webshop-agentens kald ligger før ugens vindue.
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 10, resetsAt: '2026-10-05T00:00:00.000Z' },
      { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-01T12:00:00.000Z' },
    ],
    changed: ['rateLimits'],
  } as never)
  await ur.advance(2_000)
  const kalibreret = async () => ((await $.command.run({ command: 'tokens', args: 'råd alle' } as never)).text ?? '').includes('af ugen')
  for (let i = 0; i < 50 && !(await kalibreret()); i++) await vent(10)

  const linjer = ((await $.command.run({ command: 'tokens', args: 'råd alle' } as never)).text ?? '').split('\n')
  expect(linjer[3]).toBe('**Råd på tværs** · tal = andel af ugens grænse, du cirka kunne have sparet')
  // $0.675 sparet ÷ $0.082 pr. procentpoint ≈ 8,2 % af ugen.
  expect(linjer[5]).toBe('██████████ **8,2 % af ugen · Lang samtale** · 1 samtale')
  expect(linjer[1]).toMatch(/^2 samtaler · 3 aktive dage · \d+ % af ugen \(\d+,\d+ kr\) i alt$/)
})

test('båndet viser 5-timersgrænsen og ugens grænse som målere: en graf på desktop, tekst i terminalen', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  toMapper(on, new Set())
  on('session.measure', async (_, e) => ({ changed: e.changed }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2099-01-01T15:40:00.000Z' },
      { kind: 'seven_day', percentUsed: 8, resetsAt: '2099-01-03T09:00:00.000Z' },
    ],
    changed: ['rateLimits'],
  } as never)

  const desktop = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  const svg = await desktop.find({ type: 'Svg' })
  expect(String(svg?.props.source)).toContain('<svg')
  // Tegnet i sin egen størrelse, så den ikke skaleres op, og uden en hvid ramme.
  expect([svg?.props.height, svg?.props.isInteractive]).toEqual([16, undefined])
  expect(String(svg?.props.alt)).toMatch(/^5 t ██░+ 23 % \(nulstilles .+\)  ·  Uge █░+ 8 % \(nulstilles .+\)$/)
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'token-maaler', surface: 'terminal', component: 'AbovePrompt', props: baandProps } as never)
  expect(await terminal.find({ type: 'Text', text: /^\s*5 t ██░+ 23 %/ })).toBeDefined()
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()

  const tekst = (await $.command.run({ command: 'tokens', args: 'forbrug' } as never)).text ?? ''
  expect(tekst.split('\n').slice(0, 4)).toEqual(['**Forbrug**', expect.stringMatching(/^5 t ██░+ 23 %/), '', '**Ugen pr. dag** · de seneste 7 dage · alle samtaler'])
})

test('Forbrug gælder alle samtaler: ugen pr. dag og ugens dyreste samtaler på tværs af projektmapper', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-02T12:00:00.000Z') })
  mock.store(on)
  toMapper(on, new Set())
  const linjer = ((await $.command.run({ command: 'tokens', args: 'forbrug' } as never)).text ?? '').split('\n')
  const start = linjer.indexOf('**Ugens dyreste samtaler**')
  expect(linjer[start - 2]).toMatch(/^I alt de seneste 7 dage: \d+,\d+ kr · 2 samtaler$/)
  expect(linjer.slice(start + 1, start + 3)).toEqual([
    expect.stringMatching(/^██████████ \d+,\d+ kr · Bæverspil$/),
    expect.stringMatching(/^█░+ \d+,\d+ kr · Webshop-agent$/),
  ])
  // Søjlerne dækker de 7 dage frem til i dag; Bæverspillets dag (onsdag 1. oktober) har forbrug.
  expect(linjer.filter(l => /^[█░]{10} /.test(l) && /(ons|tor|i dag)/.test(l)).length).toBeGreaterThan(0)
})

test('Forbrug følger ugens grænse: dagene siden den sidst blev nulstillet', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-02T12:00:00.000Z') })
  mock.store(on)
  toMapper(on, new Set())
  on('session.measure', async (_, e) => ({ changed: e.changed }))
  // Ugen nulstilles 4. oktober kl. 10, så den startede søndag 27. september kl. 10 UTC: Webshop-agentens første dag er ude.
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 8, resetsAt: '2026-10-04T10:00:00.000Z' }],
    changed: ['rateLimits'],
  } as never)
  const linjer = ((await $.command.run({ command: 'tokens', args: 'forbrug' } as never)).text ?? '').split('\n')
  expect(linjer[3]).toMatch(/^\*\*Ugen pr\. dag\*\* · siden søn kl\. \d\d:00 · alle samtaler$/)
  expect(linjer.find(l => l.startsWith('I alt'))).toMatch(/^I alt siden søn kl\. \d\d:00: /)
  expect(linjer.filter(l => /^[█░]{10} /.test(l))).toHaveLength(6 + 2)
})
