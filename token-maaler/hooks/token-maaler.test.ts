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
    expect((await baand.find({ type: 'Text', text: /^Sidste opgave: 1,95 kr$/ }))?.type).toBe('Text')
    expect(await baand.find({ key: 'detaljer' })).toBeDefined()
    // Rådene står kun i panelet.
    expect(await baand.find({ key: 'raad' })).toBeUndefined()
    expect(await baand.find({ key: 'projekt' })).toBeUndefined()
    await baand.press({ key: 'indsigt' })
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
const toMapper = (on: On, laaste: Set<string>, ekstra: Record<string, string> = {}, miljoe: Record<string, string> = {}) => {
  mock.env(on, { HOME: '/h', ...miljoe })
  const rod = '/h/.claude/projects'
  const filer: Record<string, string> = {
    [`${rod}/-p-x/s1.jsonl`]: transcript,
    [`${rod}/-p-y/s2.jsonl`]: [JSON.stringify({ type: 'custom-title', customTitle: 'Bæverspil' }), langTranscript].join('\n'),
    ...ekstra,
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
  // Indsigt: målerne og ugedagene, så alle samtaler, ugens dyreste samtaler og gode råd.
  expect(linjer[0]).toBe('**Indsigt**')
  const afsnit = linjer.filter(l => l.startsWith('**') && !l.includes('kr ·')).map(l => l.split(' · ')[0])
  expect(afsnit).toEqual([
    '**Indsigt**',
    '**Dit gennemsnitlige totale forbrug fordelt henover dage på ugen**',
    '**Alle samtaler**',
    '**Ugens dyreste samtaler**',
    '**Gode råd til dig**',
  ])
  const alle = linjer.indexOf('**Alle samtaler**')
  expect(linjer[alle + 1]).toMatch(/^2 samtaler · 3 aktive dage · \d+,\d+ kr i alt$/)
  const raad = linjer.findIndex(l => l.startsWith('**Gode råd til dig**'))
  expect(linjer.slice(raad)).toEqual([
    '**Gode råd til dig** · tal = kroner, du cirka kunne have sparet',
    '',
    '██████████ **4,39 kr · Lang samtale** · 1 samtale',
    'I Bæverspil (4,39 kr).',
    '→ Skriv `/compact`, når en opgave er færdig, så hver runde læser mindre.',
  ])
  // De dyreste samtaler står kun én gang: ugens.
  expect(linjer.filter(l => l.includes('dyreste samtaler'))).toHaveLength(1)
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
  expect((await panel.find({ type: 'Text', text: /^Alle samtaler$/ }))?.props.bold).toBe(true)
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
  await panel.press({ key: 'indsigt' })
  // Forbrug: graferne øverst og ugens dyreste samtaler under dem.
  expect((await panel.find({ type: 'Text', text: /^Dit gennemsnitlige totale forbrug fordelt henover dage på ugen$/ }))?.props.bold).toBe(true)
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

test('rådene står i panelet og /tokens råd, ikke i båndet eller som besked', async ($, on) => {
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

  await $.turn.start({ text: 'Byg det hele', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // tøm strømmen
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await ur.advance(3_000)
  expect(toasts.filter(t => t.startsWith('Råd:'))).toEqual([])
  const baand = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'AbovePrompt', props: baandProps } as never)
  expect(await baand.find({ key: 'raad' })).toBeUndefined()
  await baand.unmount()

  const tekst = (await $.command.run({ command: 'tokens', args: 'råd' } as never)).text ?? ''
  expect(tekst).toContain('**Råd til at bruge færre tokens**')
  expect(tekst).toContain('→ Skriv `/compact`, når en opgave er færdig')
  const panel = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'Pane', requestId: 'token-maaler', props: panelProps } as never)
  await panel.press({ key: 'raad' })
  expect(await panel.find({ type: 'Text', text: /^Råd til at bruge færre tokens$/ })).toBeDefined()
  await panel.unmount()
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
    'Kunne ikke gennemgå dine prompts (opus: authentication_failed). Prøv igen om lidt.',
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
  const alle = linjer.slice(linjer.indexOf('**Alle samtaler**'))
  const raad = linjer.slice(linjer.findIndex(l => l.startsWith('**Gode råd til dig**')))
  expect(raad[0]).toBe('**Gode råd til dig** · tal = andel af ugens grænse, du cirka kunne have sparet')
  // $0.675 sparet ÷ $0.082 pr. procentpoint ≈ 8,2 % af ugen.
  expect(raad[2]).toBe('██████████ **8,2 % af ugen · Lang samtale** · 1 samtale')
  expect(alle[1]).toMatch(/^2 samtaler · 3 aktive dage · \d+ % af ugen \(\d+,\d+ kr\) i alt$/)
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
  // Hver måler: etiketten som tekst og en lille bjælke i fast størrelse med procenten på.
  const bjaelker = await desktop.findAll({ type: 'Svg' })
  expect(bjaelker.map(b => [b.props.width, b.props.height, b.props.isInteractive])).toEqual([[72, 14, undefined], [72, 14, undefined]])
  expect(bjaelker.map(b => b.props.alt)).toEqual(['5 t 23 %', 'Uge 8 %'])
  expect(String(bjaelker[0]?.props.source)).toContain('>23 %</text>')
  expect(await desktop.find({ type: 'Text', text: /^23 %$/ })).toBeUndefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'token-maaler', surface: 'terminal', component: 'AbovePrompt', props: baandProps } as never)
  expect(await terminal.find({ type: 'Text', text: /^\s*5 t ██░+ 23 %/ })).toBeDefined()
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()

  const tekst = (await $.command.run({ command: 'tokens', args: 'forbrug' } as never)).text ?? ''
  expect(tekst.split('\n').slice(0, 4)).toEqual(['**Indsigt**', expect.stringMatching(/^5 t ██░+ 23 %/), '', '**Dit gennemsnitlige totale forbrug fordelt henover dage på ugen**'])
})

test('Forbrug gælder alle samtaler: ugen pr. dag og ugens dyreste samtaler på tværs af projektmapper', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-02T12:00:00.000Z') })
  mock.store(on)
  toMapper(on, new Set())
  const linjer = ((await $.command.run({ command: 'tokens', args: 'forbrug' } as never)).text ?? '').split('\n')
  const start = linjer.indexOf('**Ugens dyreste samtaler** · de seneste 7 dage')
  expect(linjer.slice(start + 1, start + 4)).toEqual([
    expect.stringMatching(/^I alt \d+,\d+ kr · 2 samtaler$/),
    expect.stringMatching(/^██████████ \d+,\d+ kr · Bæverspil$/),
    expect.stringMatching(/^█░+ \d+,\d+ kr · Webshop-agent$/),
  ])
  // Ugedagene er gennemsnit over hele historikken (26. sep. til 2. okt.: hver ugedag én gang):
  // Bæverspillet var torsdag 1. oktober, Webshop-agenten lørdag og søndag.
  const dage = linjer.filter(l => /^[█░]{10} (man|tir|ons|tor|fre|lør|søn) /.test(l))
  expect(dage.map(l => l.slice(11, 14))).toEqual(['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'])
  expect(dage[3]).toMatch(/^██████████ tor  \d+,\d+ kr$/)
  expect(dage[0]).toBe('░░░░░░░░░░ man  ')
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
  const start = linjer.findIndex(l => l.startsWith('**Ugens dyreste samtaler**'))
  expect(linjer[start]).toMatch(/^\*\*Ugens dyreste samtaler\*\* · siden søn kl\. \d\d:00$/)
  // Webshop-agentens første dag (26. september) ligger før ugen, så kun Bæverspillet og søndagen er med.
  expect(linjer[start + 1]).toMatch(/^I alt \d+,\d+ kr · 2 samtaler$/)
})

test('Dine prompts gemmer ikke et svar, der ikke kan læses, og læser ikke uændrede samtaler igen', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const laaste = new Set<string>()
  toMapper(on, laaste)
  on('ui.open', async () => ({ value: { isPlaced: true } as never }))
  let opus = 'Jeg fandt to steder: {"kaeder": [{"start": 1, "rettelser": [2'
  const kaldt: string[] = []
  on('model.complete', async (_, e) => {
    kaldt.push(String(e.model))
    const svar =
      e.model === 'opus'
        ? e.prompt.includes('Byg forsiden')
          ? opus
          : '{"kaeder": []}'
        : e.model === 'sonnet'
          ? 'Ret *.ts filer og byg kontaktsiden'
          : '{"punkter": [{"navn": "Ret *.ts filer", "manglede": "kontaktsiden"}]}'
    return { value: { isAnswered: true, text: svar, usage: {} } as never }
  })
  const koer = async () => (await $.command.run({ command: 'prompts', args: '' } as never)).text ?? ''

  // Opus' svar blev skåret af: Webshop-agenten kunne ikke gennemgås, og intet blev gemt for den.
  expect(await koer()).toContain('1 samtale kunne ikke gennemgås (opus: svaret kunne ikke læses).')
  opus = '{"kaeder": [{"start": 1, "rettelser": [2], "oenske": "En forside med kontaktside", "manglede": "kontaktsiden"}]} Bemærk: {ingen andre}.'
  expect(await koer()).toContain('**0,26 kr · Ret *.ts filer** · Webshop-agent')

  // Uændrede filer: hverken modelkald eller læsning af transcripts.
  const foer = kaldt.length
  laaste.add('/h/.claude/projects/-p-x/s1.jsonl')
  laaste.add('/h/.claude/projects/-p-y/s2.jsonl')
  expect(await koer()).toContain('**0,26 kr · Ret *.ts filer** · Webshop-agent')
  expect(kaldt).toHaveLength(foer)

  // En enkelt * i et navn ødelægger ikke den fede skrift eller samtalens titel i panelet.
  const panel = await $.ui.mount({ plugin: 'token-maaler', surface: 'desktop', component: 'Pane', requestId: 'token-maaler', props: panelProps } as never)
  await panel.press({ key: 'promptsmart' })
  expect((await panel.find({ type: 'Text', text: /^0,26 kr · Ret \*\.ts filer$/ }))?.props.bold).toBe(true)
  expect(await panel.find({ type: 'Text', text: /^ · Webshop-agent$/ })).toBeDefined()
  await panel.unmount()
})

test('grænsernes målinger læses ind, selv når modulet er indlæst igen uden en ny session.start', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T08:00:00.000Z') })
  // $0.04 pr. procentpoint af ugen, målt i en tidligere session.
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  toMapper(on, new Set())
  const linjer = ((await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? '').split('\n')
  expect(linjer.find(l => l.startsWith('**Gode råd til dig**'))).toBe('**Gode råd til dig** · tal = andel af ugens grænse, du cirka kunne have sparet')
  // Uden en kendt uge tæller "de seneste 7 dage" hele 7 døgn: Webshop-agentens kald 26. september kl. 09 er med.
  const start = linjer.indexOf('**Ugens dyreste samtaler** · de seneste 7 dage')
  expect(linjer.slice(start + 2, start + 4)).toEqual([
    expect.stringMatching(/^██████████ \d+ % af ugen \(\d+,\d+ kr\) · Bæverspil$/),
    '█░░░░░░░░░ 3,0 % af ugen (0,78 kr) · Webshop-agent',
  ])
})

test('lidt efter start ryddes nøgler fra ældre versioner op, og de nuværende bliver', async ($, on) => {
  const ur = mock.clock(on)
  toMapper(on, new Set())
  const lager = new Map<string, unknown>(
    Object.entries({
      'indsigt:v3:a': 1,
      'indsigt:v4:a': 1,
      'promptsmart:v1:a': 1,
      'raad-vist:a': 1,
      'beskrivelse:a:1:2': 'gammel',
      'beskrivelse:v2:a:1:2': 'ny',
      'promptsmart:v2:a': { raad: [] },
      'kalibrering:v1': {},
    }),
  )
  on('store.get', async (_, e) => ({ value: lager.get(e.key) }))
  on('store.set', async (_, e) => {
    lager.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async (_, e) => {
    lager.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...lager.keys()] }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/p/x', surface: null, isInteractive: false })
  await ur.advance(20_000)
  for (let i = 0; i < 100 && lager.has('raad-vist:a'); i++) await vent(10)
  const noegler = [...lager.keys()]
  expect(noegler.filter(k => /^(indsigt:v3|indsigt:v4|promptsmart:v1|raad-vist|beskrivelse:a)/.test(k))).toEqual([])
  expect(noegler).toEqual(expect.arrayContaining(['beskrivelse:v2:a:1:2', 'promptsmart:v2:a', 'kalibrering:v1']))
  // Resumeerne for begge samtaler er samlet i den aktuelle version.
  expect(noegler.filter(k => k.startsWith('indsigt:v5:')).sort()).toEqual(['indsigt:v5:s1', 'indsigt:v5:s2'])
})

// Kontoens procent hvert kvarter, som Claude-appen gemmer den i plan-usage-history.json.
const HISTORIK_FIL = '/h/Library/Application Support/Claude/plan-usage-history.json'
const KVARTER_MS = 15 * 60_000
const historik = (perioder: { fra: string; kvarterer: number; sd: (i: number) => number }[]) =>
  JSON.stringify({
    version: 2,
    samples: perioder.flatMap(r => Array.from({ length: r.kvarterer }, (_, i) => ({ t: Date.parse(r.fra) + i * KVARTER_MS, org: 'o', u: { fh: 0, sd: r.sd(i) } }))),
  })

// Uge A (24. september): procenten stiger til 40, men Code forklarer kun 3. Uge B (fra 1. oktober): Bæverspillet
// bruger 20 % kl. 9, og natten til den 3. stiger procenten 12 point på tre timer, mens ingen Code kører.
const kontoHistorik = historik([
  { fra: '2026-09-24T00:00:00Z', kvarterer: 7 * 96, sd: i => Math.min(40, Math.floor(i / 16)) },
  { fra: '2026-10-01T00:00:00Z', kvarterer: 240, sd: i => (i < 37 ? 0 : i < 176 ? 20 : Math.min(32, 20 + (i - 176))) },
])

test('chat, Cowork m.m. vises, når kontoens procent er højere, end Code kan forklare', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T12:00:00.000Z') })
  // $0.04 pr. procentpoint af ugen, målt i en tidligere session.
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  toMapper(on, new Set(), { [HISTORIK_FIL]: kontoHistorik })
  const linjer = ((await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? '').split('\n')

  const alle = linjer.slice(linjer.indexOf('**Alle samtaler**'))
  expect(alle[1]).toMatch(/^2 samtaler · 3 aktive dage · \d+ % af ugen \([\d.,]+ kr\) i alt$/)
  expect(alle[2]).toMatch(/^Chat, Cowork m\.m\. uden for samtalerne: 4\d % af ugen \([\d.,]+ kr\) de seneste \d+ dage$/)

  // Ugens dyreste samtaler: samtalerne, så chat og Cowork på sin egen linje med den største periode under.
  const uge = linjer.slice(linjer.findIndex(l => l.startsWith('**Ugens dyreste samtaler**')))
  const andet = uge.findIndex(l => l.includes('Chat, Cowork m.m. (ikke målt pr. samtale)'))
  expect(andet).toBeGreaterThan(2)
  expect(uge[andet]).toMatch(/^[█░]{10} 1\d % af ugen \([\d.,]+ kr\) · Chat, Cowork m\.m\. \(ikke målt pr\. samtale\)$/)
  expect(uge[andet + 1]).toMatch(/^↳ .* kl\. \d{2}:\d{2}-\d{2}:\d{2} · 12 % af ugen \(3,12 kr\)$/)
  expect(uge[andet + 2]).toBe('')

  // Mere end en fjerdedel af ugens procent er uden for Code: et råd, som gælder hele kontoen.
  const raad = linjer.slice(linjer.findIndex(l => l.startsWith('**Gode råd til dig**')))
  const i = raad.findIndex(l => l.includes('Chat og Cowork'))
  expect(raad[i]).toMatch(/^[█░]{10} \*\*\d+(,\d)? % af ugen · Chat og Cowork\*\* · hele kontoen$/)
  expect(raad[i + 1]).toMatch(/^Ca\. [\d.,]+ % af ugen \([\d.,]+ kr\) gik til chat, Cowork m\.m\. uden for Code\.$/)
  expect(raad[i + 2]).toBe('→ Start en ny chat til nye emner, og vælg en mindre model til lette spørgsmål.')

  // Værktøjet til Claude får de samme tal, uden bjælker.
  const vaerktoej = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  const svar = String((await vaerktoej({ tool: 'mcp__token-maaler__historik', alle: true })).result)
  expect(svar).toContain('Chat, Cowork m.m. uden for samtalerne:')
  expect(svar).toContain('hele kontoen')
})

test('uden en historik fra appen står der intet om chat og Cowork', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T12:00:00.000Z') })
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  toMapper(on, new Set())
  const tekst = (await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? ''
  expect(tekst).not.toContain('Chat, Cowork')
  expect(tekst).not.toContain('Chat og Cowork')
})

test('en historik uden for Code ændrer ikke andelene, når Code forklarer hele ugen', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T12:00:00.000Z') })
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  // Procenten følger Codes forbrug nøjagtigt: Bæverspillet bruger $0.82 = 20,5 % ved 0,04 dollars pr. procentpoint.
  toMapper(on, new Set(), { [HISTORIK_FIL]: historik([{ fra: '2026-10-01T00:00:00Z', kvarterer: 240, sd: i => (i < 37 ? 0 : 20) }]) })
  const tekst = (await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? ''
  expect(tekst).not.toContain('Chat, Cowork')
})

test('kontoens historik hæver enheden, så chat ikke får Codes forbrug til at se dyrere ud', async ($, on) => {
  const ur = mock.clock(on, { now: Date.parse('2026-10-03T12:00:00.000Z') })
  // Sessionerne målte 0,02 dollars pr. procentpoint, fordi chat også brugte af ugen; i uge B, hvor Code
  // brugte det meste, viser historikken 0,041.
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.02 }] } })
  toMapper(on, new Set(), {
    [HISTORIK_FIL]: historik([
      { fra: '2026-09-24T00:00:00Z', kvarterer: 7 * 96, sd: i => Math.min(40, Math.floor(i / 16)) },
      { fra: '2026-10-01T00:00:00Z', kvarterer: 240, sd: i => (i < 37 ? 0 : 20) },
    ]),
  })
  on('session.measure', async (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-08T00:00:00.000Z' }],
    changed: ['rateLimits'],
  } as never)
  await ur.advance(2_000)
  const klar = async () => ((await $.command.run({ command: 'tokens', args: 'råd alle' } as never)).text ?? '').includes('16 % af ugen')
  for (let i = 0; i < 50 && !(await klar()); i++) await vent(10)
  const linjer = ((await $.command.run({ command: 'tokens', args: 'råd alle' } as never)).text ?? '').split('\n')
  const raad = linjer.slice(linjer.findIndex(l => l.startsWith('**Gode råd til dig**')))
  // $0.675 sparet ÷ $0.041 pr. procentpoint = 16 % af ugen (ikke 33 % ved 0,02).
  expect(raad[2]).toBe('██████████ **16 % af ugen · Lang samtale** · 1 samtale')
})

// En planlagt opgave starter sin samtale med opgavens tekst i <scheduled-task>, efter en fast indledning.
const planlagtKoersel = (navn: string, tid: string) =>
  [
    linje('user', tid, {
      origin: { kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: 'scheduled' },
      message: {
        role: 'user',
        content: `<scheduled-task name="${navn}" file="/h/.claude/scheduled-tasks/${navn}/SKILL.md">\nThis is an automated run of a scheduled task. The user is not present to answer questions.\n\nLav ugens rapport.\n</scheduled-task>`,
      },
    }),
    kald(`p-${navn}-${tid}`, tid),
  ].join('\n')

test('samtaler, som planlagte opgaver startede, er mærket, og kørslerne af samme opgave lægges sammen', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-09-28T12:00:00.000Z') })
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  const rod = '/h/.claude/projects/-p-y'
  toMapper(on, new Set(), {
    [`${rod}/s3.jsonl`]: planlagtKoersel('ugens-rapport', '2026-09-27T08:00:00.000Z'),
    [`${rod}/s4.jsonl`]: planlagtKoersel('ugens-rapport', '2026-09-28T08:00:00.000Z'),
    [`${rod}/s5.jsonl`]: planlagtKoersel('oprydning', '2026-09-28T09:00:00.000Z'),
  })
  const kaldt: string[] = []
  on('model.complete', async (_, e) => {
    kaldt.push(e.prompt)
    return { value: { isAnswered: true, text: '{"kaeder": []}', usage: {} } as never }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } as never }))

  const linjer = ((await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? '').split('\n')
  const alle = linjer.slice(linjer.indexOf('**Alle samtaler**'))
  expect(alle[1]).toMatch(/^5 samtaler · /)
  expect(alle[2]).toMatch(/^Heraf planlagte opgaver: 3 kørsler af 2 opgaver · [\d.,]+ % af ugen \([\d.,]+ kr\)$/)
  // Ugens samtaler: de to kørsler af ugens-rapport er én linje, med deres samlede forbrug.
  const uge = linjer.slice(linjer.findIndex(l => l.startsWith('**Ugens dyreste samtaler**')))
  expect(uge.filter(l => l.includes('Planlagt: ugens-rapport'))).toEqual([expect.stringMatching(/^[█░]{10} [\d.,]+ % af ugen \([\d.,]+ kr\) · Planlagt: ugens-rapport · 2 kørsler$/)])
  expect(uge.filter(l => l.includes('Planlagt: oprydning'))).toEqual([expect.stringMatching(/ · Planlagt: oprydning · 1 kørsel$/)])
  // Opgavens tekst er ikke en prompt, brugeren skrev: Dine prompts gennemgår kun de to almindelige samtaler.
  await $.command.run({ command: 'tokens', args: 'prompts' } as never)
  expect(kaldt.filter(p => p.includes('Lav ugens rapport'))).toEqual([])
  expect(kaldt.length).toBeGreaterThan(0)
})

test('en almindelig samtale mærkes ikke som planlagt', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-09-28T12:00:00.000Z') })
  mock.store(on, { 'kalibrering:v1': { seven_day: [{ t: 1, usdPrProcent: 0.04 }] } })
  toMapper(on, new Set())
  const tekst = (await $.command.run({ command: 'tokens', args: 'indsigt' } as never)).text ?? ''
  expect(tekst).not.toContain('planlagt')
  expect(tekst).not.toContain('Planlagt')
})
