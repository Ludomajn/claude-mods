import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KontekstDel } from '../types'
import { afkort, analyser, detaljer, etiket, kontekstDele, listeLinje, opsummering } from './analyse'
import type { Agent, Kald, Trin } from './analyse'
import { byg, dagTekst, dageTekst, laesLinje, nySamling } from './historik'
import type { Samling } from './historik'

const opgaver = atom({ plugin: 'token-maaler', key: 'opgaver' } as const, [])
const skjult = atom({ plugin: 'token-maaler', key: 'skjult' } as const, false)
const visNr = atom({ plugin: 'token-maaler', key: 'visNr' } as const, null)
const paneVisning = atom({ plugin: 'token-maaler', key: 'paneVisning' } as const, 'opgave')
const dageLinjer = atom({ plugin: 'token-maaler', key: 'dageLinjer' } as const, [])

const PANE = 'token-maaler'
const HISTORIK_VAERKTOEJ = 'mcp__token-maaler__historik'
const FIRE_MB = 4 * 1024 * 1024

const HISTORIK_BESKRIVELSE =
  "Token usage and cost of this agent (this Claude Code session) across its whole history, read from its transcript files: the number of active days, the cost, tokens and tasks of each active day (day 1 is the first active day), and each day's most expensive tasks. Use it to answer questions such as 'what did day 2 cost?', 'how many days have we worked on this?' or 'what has this agent cost in total?'. Amounts are list prices. Leave out `dag` for the overview of all days."

type Spand = { trin: Trin[]; kald: Kald[]; agenter: Record<string, Agent> }

type Igang = Spand & {
  nr: number
  prompt: string
  start: number
  usdStart: number | null
  ttl: number
  forrigePrompt: number | null
  kontekst: Promise<KontekstDel[]>
}

const forbrug = async ($: EngineInterface) => {
  try {
    const u = await $.session.usage()
    return { usd: u.cost?.usd ?? null, abonnement: u.rateLimits.length > 0 }
  } catch {
    return { usd: null, abonnement: false }
  }
}

const hentKontekst = async ($: EngineInterface): Promise<KontekstDel[]> => {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    return kontekstDele(u.context.breakdown?.categories ?? [])
  } catch {
    return []
  }
}

const laengde = (vaerdi: unknown) => {
  try {
    return JSON.stringify(vaerdi)?.length ?? 0
  } catch {
    return 0
  }
}

// Agentens historik ligger i transcript-filerne under ~/.claude/projects/<projekt>/.
const projekter = async ($: EngineInterface) =>
  `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`}/projects`

// Mappen med sessionens transcript; ellers projektmappen for sessionens arbejdsmappe.
const projektMappe = async ($: EngineInterface, id: string): Promise<string | null> => {
  const rod = await projekter($)
  const egen = `${rod}/${(await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')}`
  if (await $.fs.exists(`${egen}/${id}.jsonl`)) return egen
  for (const m of await $.fs.list(rod).catch(() => [])) {
    if (m.kind === 'dir' && (await $.fs.exists(`${rod}/${m.name}/${id}.jsonl`))) return `${rod}/${m.name}`
  }
  return (await $.fs.exists(egen)) ? egen : null
}

const jsonlFiler = async ($: EngineInterface, mappe: string): Promise<string[]> => {
  const filer: string[] = []
  for (const e of await $.fs.list(mappe).catch(() => [])) {
    if (e.kind === 'dir') filer.push(...(await jsonlFiler($, `${mappe}/${e.name}`)))
    else if (e.kind === 'file' && e.name.endsWith('.jsonl')) filer.push(`${mappe}/${e.name}`)
  }
  return filer
}

// Små filer læses direkte; store (op til 80 MB) strømmes gennem cat, fordi $.fs.read stopper ved 4 MB.
const hverLinje = async ($: EngineInterface, sti: string, stoerrelse: number, hver: (linje: string) => void) => {
  if (stoerrelse < FIRE_MB) {
    const tekst = await $.fs.read(sti)
    if (typeof tekst === 'string') for (const linje of tekst.split('\n')) hver(linje)
    return
  }
  let rest = ''
  for await (const stykke of $.process.spawn({ argv: ['cat', sti] })) {
    if (stykke.stream !== 'stdout') continue
    const dele = (rest + stykke.text).split('\n')
    rest = dele.pop() ?? ''
    for (const linje of dele) hver(linje)
  }
  if (rest) hver(rest)
}

const findAgenter = async ($: EngineInterface, mappe: string, soeg: string) => {
  const fundne: { id: string; titel: string }[] = []
  for (const e of await $.fs.list(mappe).catch(() => [])) {
    if (e.kind !== 'dir') continue
    try {
      const raa = await $.fs.read(`${mappe}/${e.name}/custom-title.json`)
      const titel: unknown = typeof raa === 'string' ? JSON.parse(raa)?.customTitle : undefined
      if (typeof titel === 'string' && titel.toLowerCase().includes(soeg.toLowerCase())) fundne.push({ id: e.name, titel })
    } catch {
      // Sessionen har ingen titel.
    }
  }
  return fundne
}

const cache = new Map<string, { stoerrelse: number; mtimeMs: number; samling: Samling }>()

const samlingFor = async ($: EngineInterface, sti: string, hoved: boolean): Promise<Samling> => {
  const stat = await $.fs.stat(sti)
  const gemt = cache.get(sti)
  if (gemt && gemt.stoerrelse === stat.size && gemt.mtimeMs === stat.mtimeMs) return gemt.samling
  const samling = nySamling()
  await hverLinje($, sti, stat.size, linje => laesLinje(samling, linje, hoved))
  cache.set(sti, { stoerrelse: stat.size, mtimeMs: stat.mtimeMs, samling })
  return samling
}

const historik = async ($: EngineInterface, valg: { agent: string; dag: number | null; visuel: boolean }) => {
  try {
    const egen = await $.session.id()
    const mappe = await projektMappe($, egen)
    if (!mappe) return 'Fandt ikke agentens transcript.'
    let maal = { id: egen, titel: '' }
    if (valg.agent) {
      const fundne = await findAgenter($, mappe, valg.agent)
      const [fundet] = fundne
      if (!fundet) return `Ingen agent i dette projekt har "${valg.agent}" i titlen.`
      if (fundne.length > 1) {
        return [`${fundne.length} agenter passer på "${valg.agent}":`, ...fundne.map(f => `  ${f.titel}`), 'Skriv mere af titlen.'].join('\n')
      }
      maal = fundet
    }
    const hovedfil = `${mappe}/${maal.id}.jsonl`
    if (!(await $.fs.exists(hovedfil))) return 'Ingen historik endnu: agentens transcript er tomt.'
    const samlinger = [await samlingFor($, hovedfil, true)]
    for (const fil of await jsonlFiler($, `${mappe}/${maal.id}/subagents`)) samlinger.push(await samlingFor($, fil, false))
    const h = byg(samlinger)
    const medTitel = { ...h, titel: h.titel || maal.titel }
    return (valg.dag === null ? dageTekst(medTitel, valg.visuel) : dagTekst(medTitel, valg.dag, valg.visuel)).join('\n')
  } catch (fejl) {
    return `Kunne ikke læse historikken: ${fejl instanceof Error ? fejl.message : String(fejl)}`
  }
}

const aabnPanel = async ($: EngineInterface, kommando: string) => {
  const aabnet = await $.ui.open({ id: PANE, title: 'Token-forbrug' })
  if (!aabnet.isPlaced) $.ui.toast(`Panelet kan ikke vises her. Skriv ${kommando}.`)
}

const visDage = async ($: EngineInterface) => {
  const tekst = await historik($, { agent: '', dag: null, visuel: true })
  await update($, dageLinjer, () => tekst.split('\n'))
  await update($, paneVisning, () => 'dage')
}

export const register: Register = on => {
  let aktiv: Igang | null = null
  // Subagenter i baggrunden kan blive færdige mellem to opgaver; deres forbrug går til den næste.
  let ventende: Spand = { trin: [], kald: [], agenter: {} }
  let forrigePrompt: number | null = null
  const sidsteTrin = new Map<string, number>()
  const kendteAgenter = new Map<string, Agent>()

  const spand = (): Spand => aktiv ?? ventende

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Hvad tokens gik til: /tokens [nr] · /tokens dage · /tokens dag <nr>' })
    try {
      await $.tool.register({
        name: 'historik',
        description: HISTORIK_BESKRIVELSE,
        inputSchema: {
          type: 'object',
          properties: {
            dag: { type: 'integer', minimum: 1, description: 'An active day number (1 = the first active day), for that day in detail.' },
            agent: { type: 'string', description: "Part of another session's title in the same project, to look at that agent instead." },
          },
        },
      })
    } catch {
      // Uden plugin-værktøjer virker kommandoen stadig.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const nr = ((await read($, opgaver)).at(-1)?.nr ?? 0) + 1
    const { usd, abonnement } = await forbrug($)
    aktiv = {
      ...ventende,
      nr,
      prompt: afkort(e.text, 60) || '(fortsættelse)',
      start: await $.clock.now(),
      usdStart: usd,
      ttl: abonnement ? 2 : 1.25,
      forrigePrompt,
      kontekst: hentKontekst($),
    }
    ventende = { trin: [], kald: [], agenter: {} }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? ''
    sidsteTrin.set(loop, e.index)
    const svar = yield* next(e)
    try {
      if (svar.usage) {
        spand().trin.push({
          loop,
          index: e.index,
          model: svar.usage.model || e.model,
          input: svar.usage.input_tokens,
          output: svar.usage.output_tokens,
          cacheLaes: svar.usage.cache_read_input_tokens,
          cacheSkriv: svar.usage.cache_creation_input_tokens,
          svarTegn: svar.answer.length,
          vaerktoejsInput: svar.toolUses.map(u => ({ etiket: etiket(u.name, u.input), tegn: laengde(u.input) })),
        })
      }
      if (loop !== '' && !kendteAgenter.has(loop)) {
        const info = (await $.agent.list()).find(a => a.id === loop)
        kendteAgenter.set(loop, { beskrivelse: info?.description ?? '', type: info?.type ?? '' })
      }
      const agent = kendteAgenter.get(loop)
      if (agent) spand().agenter[loop] = agent
    } catch {
      // Målingen må aldrig stoppe et modelkald.
    }
    return svar
  })

  on('tool.call', async ($, e, next) => {
    // Historik-værktøjet, som modellen kan kalde, besvares her.
    if (String(e.tool) === HISTORIK_VAERKTOEJ) {
      const input = e as unknown as Record<string, unknown>
      const dag = typeof input.dag === 'number' ? Math.trunc(input.dag) : null
      const agent = typeof input.agent === 'string' ? input.agent.trim() : ''
      return { result: await historik($, { agent, dag, visuel: false }) }
    }
    const loop = e.agentId ?? ''
    const trin = sidsteTrin.get(loop) ?? 0
    const svar = await next(e)
    try {
      const tegn = typeof svar.text === 'string' ? svar.text.length : typeof svar.deny === 'string' ? svar.deny.length : 0
      spand().kald.push({ loop, trin, etiket: etiket(String(e.tool), e), tegn })
    } catch {
      // Målingen må aldrig stoppe et værktøjskald.
    }
    return svar
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || aktiv === null) return next(e)
    const igang = aktiv
    aktiv = null
    // En tur uden modelkald (fx en login-fejl) er ikke en opgave.
    if (igang.trin.length === 0) return next(e)
    try {
      const nu = await $.clock.now()
      const { usd } = await forbrug($)
      const opgave = analyser({
        nr: igang.nr,
        prompt: igang.prompt,
        afbrudt: e.isAborted,
        sekunder: Math.round((nu - igang.start) / 1000),
        usd: igang.usdStart !== null && usd !== null ? Math.max(0, usd - igang.usdStart) : null,
        ttl: igang.ttl,
        forrigePrompt: igang.forrigePrompt,
        trin: igang.trin,
        kald: igang.kald,
        agenter: igang.agenter,
        kontekst: await igang.kontekst,
      })
      const sidste = igang.trin.filter(t => t.loop === '').at(-1)
      if (sidste) forrigePrompt = sidste.input + sidste.cacheLaes + sidste.cacheSkriv
      await update($, opgaver, liste => [...liste, opgave].slice(-50))
      await update($, visNr, () => null)
      const top = opgave.poster[0]
      $.ui.toast(`Opgave ${opgave.nr}: ${opsummering(opgave)}${top ? ' · /tokens for detaljer' : ''}`)
    } catch {
      // En fejl i analysen må ikke stoppe turen.
    }
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const [foerste = '', ...rest] = e.args.trim().split(/\s+/)
    if (foerste === 'dage') return { text: await historik($, { agent: rest.join(' '), dag: null, visuel: true }) }
    if (foerste === 'dag') {
      const nr = Number.parseInt(rest[0] ?? '', 10)
      if (Number.isNaN(nr)) return { text: 'Skriv fx /tokens dag 2.' }
      return { text: await historik($, { agent: rest.slice(1).join(' '), dag: nr, visuel: true }) }
    }
    const liste = await read($, opgaver)
    if (liste.length === 0) return { text: 'Ingen opgaver målt endnu i denne session. Hele agentens forbrug pr. dag: /tokens dage' }
    const tal = Number.parseInt(foerste, 10)
    const valgt = Number.isNaN(tal) ? liste.at(-1) : liste.find(o => o.nr === tal)
    if (!valgt) {
      return { text: `Opgave ${e.args.trim()} findes ikke. Der er opgave ${liste[0]?.nr}–${liste.at(-1)?.nr}.` }
    }
    const linjer = detaljer(valgt)
    const andre = liste.filter(o => o.nr !== valgt.nr).slice(-8).reverse()
    if (andre.length) linjer.push('', 'Andre opgaver:', ...andre.map(listeLinje), 'Skriv /tokens <nr> for detaljer.')
    linjer.push('', 'Hele agentens forbrug pr. dag: /tokens dage')
    await update($, skjult, () => false)
    return { text: linjer.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const sidste = (await read($, opgaver)).at(-1)
    if (e.props.hasSurvey || !sidste || (await read($, skjult))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>Sidste opgave: {opsummering(sidste)} </Text>
        <Button
          key="detaljer"
          label="Detaljer"
          onPress={async () => {
            await update($, visNr, () => sidste.nr)
            await update($, paneVisning, () => 'opgave')
            await aabnPanel($, '/tokens')
          }}
        />
        <Button
          key="dage"
          label="Dage"
          onPress={async () => {
            await visDage($)
            await aabnPanel($, '/tokens dage')
          }}
        />
        <Button key="skjul" label="Skjul" onPress={() => update($, skjult, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // En bjælkelinje får farvet bjælke; alle andre linjer vises som tekst.
    const vis = (linje: string) => {
      const [, fyldt = '', tom = '', rest = ''] = /^(█*)(░*)(.*)$/.exec(linje) ?? []
      if (fyldt === '' && tom === '') return <Text>{linje || ' '}</Text>
      return (
        <Box>
          {fyldt !== '' && <Text color="cyan">{fyldt}</Text>}
          {tom !== '' && <Text dimColor>{tom}</Text>}
          <Text>{rest || ' '}</Text>
        </Box>
      )
    }
    const dageKnap = <Button key="dage" label="Dage" onPress={() => visDage($)} />

    if ((await read($, paneVisning)) === 'dage') {
      return (
        <Box flexDirection="column">
          {(await read($, dageLinjer)).map(vis)}
          <Box>
            <Button key="opgaver" label="‹ Opgaver" onPress={() => update($, paneVisning, () => 'opgave')} />
            <Button key="opdater" label="Opdater" onPress={() => visDage($)} />
          </Box>
        </Box>
      )
    }

    const liste = await read($, opgaver)
    const valgtNr = await read($, visNr)
    const valgt = liste.find(o => o.nr === valgtNr) ?? liste.at(-1)
    if (!valgt) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Ingen opgaver målt endnu i denne session.</Text>
          <Box>{dageKnap}</Box>
        </Box>
      )
    }
    const i = liste.indexOf(valgt)
    const forrige = liste[i - 1]
    const naeste = liste[i + 1]

    return (
      <Box flexDirection="column">
        {detaljer(valgt).map(vis)}
        <Box>
          {forrige !== undefined && <Button key="forrige" label="‹ Forrige" onPress={() => update($, visNr, () => forrige.nr)} />}
          {naeste !== undefined && <Button key="naeste" label="Næste ›" onPress={() => update($, visNr, () => naeste.nr)} />}
          {dageKnap}
        </Box>
      </Box>
    )
  })
}
