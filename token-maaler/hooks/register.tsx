import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KontekstDel } from '../types'
import { afkort, analyser, dollar, etiket, kontekstDele, opsummering } from './analyse'
import type { Agent, Kald, Trin } from './analyse'
import { beskrivelsesPrompt, dagTekst, dageTekst, laesLinje, nySamling, opgaveTekst, projekt, projektTekst, renBeskrivelse, visteOpgaver } from './historik'
import type { HistOpgave, Kilde, Projekt, Samling } from './historik'
import { overheadFra, raad, raadTekst } from './raad'
import type { Grundlag, Overhead, Raad } from './raad'

const opgaver = atom({ plugin: 'token-maaler', key: 'opgaver' } as const, [])
const skjult = atom({ plugin: 'token-maaler', key: 'skjult' } as const, false)
const paneVisning = atom({ plugin: 'token-maaler', key: 'paneVisning' } as const, 'projekt')
const paneNr = atom({ plugin: 'token-maaler', key: 'paneNr' } as const, null)
const paneAntal = atom({ plugin: 'token-maaler', key: 'paneAntal' } as const, 0)
const paneLinjer = atom({ plugin: 'token-maaler', key: 'paneLinjer' } as const, [])
const raadListe = atom({ plugin: 'token-maaler', key: 'raad' } as const, [])

const PANE = 'token-maaler'
const HISTORIK_VAERKTOEJ = 'mcp__token-maaler__historik'
const FIRE_MB = 4 * 1024 * 1024

const HISTORIK_BESKRIVELSE =
  "Token usage and cost of this project (this Claude Code session) across its whole history, read from its transcript files: total tokens and cost, every task (each message the user wrote) with its number, day and cost, the active days, and for one task what its cost went to (re-reading the conversation, tool results, thinking, subagents). Use it to answer questions such as 'what did task 7 cost?', 'what did day 2 cost?', 'which tasks were most expensive?' or 'how many days have we worked on this?'. Amounts are list prices. Without arguments it returns the project overview and the days."

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

type Visning = 'projekt' | 'opgave' | 'dage' | 'raad'

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

// Projektets historik ligger i transcript-filerne under ~/.claude/projects/<projektmappe>/.
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

const samlingFor = async ($: EngineInterface, sti: string, kilde: Kilde): Promise<Samling> => {
  const stat = await $.fs.stat(sti)
  const gemt = cache.get(sti)
  if (gemt && gemt.stoerrelse === stat.size && gemt.mtimeMs === stat.mtimeMs) return gemt.samling
  const samling = nySamling(kilde)
  await hverLinje($, sti, stat.size, linje => laesLinje(samling, linje))
  cache.set(sti, { stoerrelse: stat.size, mtimeMs: stat.mtimeMs, samling })
  return samling
}

// En subagents beskrivelse og type står i en fil ved siden af dens transcript.
const kildeFor = async ($: EngineInterface, fil: string): Promise<Kilde> => {
  const id = (fil.split('/').pop() ?? '').replace(/^agent-/, '').replace(/\.jsonl$/, '')
  try {
    const raa = await $.fs.read(fil.replace(/\.jsonl$/, '.meta.json'))
    const meta = (typeof raa === 'string' ? JSON.parse(raa) : null) as { description?: unknown; agentType?: unknown } | null
    return {
      id,
      beskrivelse: typeof meta?.description === 'string' ? meta.description : '',
      type: typeof meta?.agentType === 'string' ? meta.agentType : '',
    }
  } catch {
    return { id, beskrivelse: '', type: '' }
  }
}

// Projektets historik: denne session, eller den session i projektmappen, hvis titel indeholder `soeg`.
const hentProjekt = async ($: EngineInterface, soeg: string): Promise<Projekt | string> => {
  try {
    const egen = await $.session.id()
    const mappe = await projektMappe($, egen)
    if (!mappe) return 'Fandt ikke projektets transcript.'
    let maal = { id: egen, titel: '' }
    if (soeg) {
      const fundne = await findAgenter($, mappe, soeg)
      const [fundet] = fundne
      if (!fundet) return `Ingen session i projektmappen har "${soeg}" i titlen.`
      if (fundne.length > 1) {
        return [`${fundne.length} sessioner passer på "${soeg}":`, ...fundne.map(f => `  ${f.titel}`), 'Skriv mere af titlen.'].join('\n')
      }
      maal = fundet
    }
    const hovedfil = `${mappe}/${maal.id}.jsonl`
    if (!(await $.fs.exists(hovedfil))) return 'Ingen historik endnu: projektets transcript er tomt.'
    const samlinger = [await samlingFor($, hovedfil, { id: '', beskrivelse: '', type: '' })]
    for (const fil of await jsonlFiler($, `${mappe}/${maal.id}/subagents`)) samlinger.push(await samlingFor($, fil, await kildeFor($, fil)))
    const p = projekt(samlinger)
    return { ...p, id: maal.id, titel: p.titel || maal.titel }
  } catch (fejl) {
    return `Kunne ikke læse historikken: ${fejl instanceof Error ? fejl.message : String(fejl)}`
  }
}

// Konteksten ved start måles kun live; den hentes fra den målte opgave med samme besked og tid.
const kontekstFor = async ($: EngineInterface, p: Projekt, nr: number): Promise<KontekstDel[]> => {
  const o = p.opgaver.find(x => x.nr === nr)
  if (!o) return []
  const live = (await read($, opgaver)).filter(x => typeof x.start === 'number' && x.prompt === o.tekst && Math.abs(x.start - o.t) < 10 * 60_000)
  return live.at(-1)?.kontekst ?? []
}

const BESKRIV_SYSTEM = 'Du skriver korte, konkrete beskrivelser af arbejde, som en AI-assistent har udført. Svar kun med beskrivelsen.'

// Hvad Claude udførte i hver opgave, skrevet af Haiku og gemt mellem sessioner. Nøglen tæller
// opgavens kald med, så en opgave, der stadig vokser, får en ny beskrivelse næste gang.
const beskriv = async ($: EngineInterface, p: Projekt, liste: readonly HistOpgave[]): Promise<Map<number, string>> => {
  const par = await Promise.all(
    liste.map(async (o): Promise<[number, string] | null> => {
      const noegle = `beskrivelse:v2:${p.id}:${o.t}:${o.kald}`
      try {
        const gemt = await $.store.get(noegle)
        if (typeof gemt === 'string') return [o.nr, gemt]
        const svar = await $.model.complete({ model: 'haiku', system: BESKRIV_SYSTEM, prompt: beskrivelsesPrompt(o), maxTokens: 100, timeoutMs: 30_000 })
        const tekst = svar.isAnswered ? renBeskrivelse(svar.text) : ''
        if (!tekst) return null
        await $.store.set(noegle, tekst)
        return [o.nr, tekst]
      } catch {
        return null
      }
    }),
  )
  return new Map(par.filter((x): x is [number, string] => x !== null))
}

// Det faste overhead i hver runde: indlæste MCP-værktøjer og plugins' skills (kun for den aktive session).
const hentOverhead = async ($: EngineInterface): Promise<Overhead | null> => {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    return b ? overheadFra(b.mcpTools, b.skills?.skillFrontmatter ?? []) : null
  } catch {
    return null
  }
}

// Analytikerens grundlag: hver opgave med sin analyse, og overhead når projektet er den aktive session.
const raadFor = async ($: EngineInterface, p: Projekt): Promise<Raad[]> => {
  const grundlag: Grundlag = {
    projekt: p,
    opgaver: p.opgaver.map(o => ({ o, a: analyser(o.raa) })),
    overhead: p.id === (await $.session.id()) ? await hentOverhead($) : null,
  }
  return raad(grundlag)
}

// Efter hver opgave: er der et nyt råd (eller er et gammelt blevet dobbelt så stort), vises det én gang.
const tjekRaad = async ($: EngineInterface) => {
  try {
    const p = await hentProjekt($, '')
    if (typeof p === 'string') return
    const liste = await raadFor($, p)
    await update($, raadListe, () => liste.map(r => ({ id: r.id, titel: r.titel, usd: r.usd })))
    const noegle = `raad-vist:${p.id}`
    const gemt = await $.store.get(noegle)
    const vist = (gemt !== null && typeof gemt === 'object' ? gemt : {}) as Record<string, number>
    const nyt = liste.find(r => r.usd >= 0.5 && r.usd >= 2 * (vist[r.id] ?? 0))
    if (!nyt) return
    await $.store.set(noegle, { ...vist, [nyt.id]: nyt.usd })
    $.ui.toast(`Råd: ${nyt.titel} · ca. ${dollar(nyt.usd)} at spare · /tokens råd`, { timeoutMs: 10_000 })
  } catch {
    // Et råd må aldrig forstyrre arbejdet.
  }
}

const tekstFor = async ($: EngineInterface, p: Projekt, visning: Visning | 'dag', nr: number | null, visuel: boolean) => {
  if (visning === 'raad') return raadTekst(p.titel || 'dette projekt', await raadFor($, p), visuel)
  if (visning === 'opgave' && nr !== null) {
    const opgave = p.opgaver.filter(o => o.nr === nr)
    return opgaveTekst(p, nr, visuel, { kontekst: await kontekstFor($, p, nr) }, await beskriv($, p, opgave))
  }
  if (visning === 'dag' && nr !== null) {
    const dyreste = p.dage.find(d => d.nr === nr)?.dyreste ?? []
    return dagTekst(p, nr, visuel, await beskriv($, p, p.opgaver.filter(o => dyreste.some(x => x.nr === o.nr))))
  }
  if (visning === 'dage') return dageTekst(p, visuel)
  const [stoerst] = await raadFor($, p)
  const raadLinje = stoerst ? `Største råd: ${stoerst.titel} (ca. ${dollar(stoerst.usd)} at spare). Skriv /tokens råd for alle råd.` : ''
  return projektTekst(p, visuel, await beskriv($, p, visteOpgaver(p)), raadLinje)
}

// Panelet viser samme tekst som kommandoerne; den beregnes, når en knap trykkes.
const visPanel = async ($: EngineInterface, visning: Visning, nr: number | null) => {
  const p = await hentProjekt($, '')
  const valgt = typeof p === 'string' ? null : visning === 'opgave' ? (nr ?? p.opgaver.at(-1)?.nr ?? null) : null
  const linjer = typeof p === 'string' ? [p] : await tekstFor($, p, visning, valgt, true)
  await update($, paneLinjer, () => linjer)
  await update($, paneVisning, () => visning)
  await update($, paneNr, () => valgt)
  await update($, paneAntal, () => (typeof p === 'string' ? 0 : p.opgaver.length))
}

const aabnPanel = async ($: EngineInterface, kommando: string) => {
  const aabnet = await $.ui.open({ id: PANE, title: 'Token-forbrug' })
  if (!aabnet.isPlaced) $.ui.toast(`Panelet kan ikke vises her. Skriv ${kommando}.`)
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
    await $.command.register({ name: 'tokens', description: 'Hele projektets forbrug: /tokens · én opgave: /tokens <nr> · dagene: /tokens dage' })
    try {
      await $.tool.register({
        name: 'historik',
        description: HISTORIK_BESKRIVELSE,
        inputSchema: {
          type: 'object',
          properties: {
            opgave: { type: 'integer', minimum: 1, description: 'A task number, for what that task cost and what the cost went to.' },
            dag: { type: 'integer', minimum: 1, description: 'An active day number (1 = the first active day), for that day in detail.' },
            agent: { type: 'string', description: "Part of another session's title in the same project folder, to look at that session instead." },
            raad: { type: 'boolean', description: 'True for advice on how to use fewer tokens, each with an estimated saving and what to do.' },
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
      const heltal = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
      const opgave = heltal(input.opgave)
      const dag = heltal(input.dag)
      const soeg = typeof input.agent === 'string' ? input.agent.trim() : ''
      const p = await hentProjekt($, soeg)
      if (typeof p === 'string') return { result: p }
      const linjer =
        input.raad === true
          ? await tekstFor($, p, 'raad', null, false)
          : opgave !== null
          ? await tekstFor($, p, 'opgave', opgave, false)
          : dag !== null
            ? await tekstFor($, p, 'dag', dag, false)
            : [...(await tekstFor($, p, 'projekt', null, false)), '', ...dageTekst(p, false)]
      return { result: linjer.join('\n') }
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
        start: igang.start,
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
      $.ui.toast(`Seneste opgave: ${opsummering(opgave)} · /tokens`)
      // Analytikeren kigger på hele projektet lidt efter, når transcriptet er skrevet færdigt.
      $.clock.after(3_000, () => void tjekRaad($))
    } catch {
      // En fejl i analysen må ikke stoppe turen.
    }
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const ord = e.args.trim().split(/\s+/).filter(Boolean)
    const [foerste = '', ...rest] = ord
    await update($, skjult, () => false)
    if (foerste === 'dag') {
      const nr = Number.parseInt(rest[0] ?? '', 10)
      if (Number.isNaN(nr)) return { text: 'Skriv fx /tokens dag 2.' }
      const p = await hentProjekt($, rest.slice(1).join(' '))
      return { text: typeof p === 'string' ? p : (await tekstFor($, p, 'dag', nr, true)).join('\n') }
    }
    const [visning, nr, soeg]: [Visning, number | null, string] =
      foerste === 'dage'
        ? ['dage', null, rest.join(' ')]
        : foerste === 'råd' || foerste === 'raad'
          ? ['raad', null, rest.join(' ')]
        : /^\d+$/.test(foerste)
          ? ['opgave', Number(foerste), rest.join(' ')]
          : ['projekt', null, ord.join(' ')]
    const p = await hentProjekt($, soeg)
    return { text: typeof p === 'string' ? p : (await tekstFor($, p, visning, nr, true)).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const sidste = (await read($, opgaver)).at(-1)
    if (e.props.hasSurvey || !sidste || (await read($, skjult))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const raadAntal = (await read($, raadListe)).length

    return (
      <Box>
        <Text dimColor>Sidste opgave: {opsummering(sidste)} </Text>
        <Button
          key="detaljer"
          label="Detaljer"
          onPress={async () => {
            await visPanel($, 'opgave', null)
            await aabnPanel($, '/tokens <nr>')
          }}
        />
        <Button
          key="projekt"
          label="Projekt"
          onPress={async () => {
            await visPanel($, 'projekt', null)
            await aabnPanel($, '/tokens')
          }}
        />
        <Button
          key="raad"
          label={raadAntal > 0 ? `Råd (${raadAntal})` : 'Råd'}
          onPress={async () => {
            await visPanel($, 'raad', null)
            await aabnPanel($, '/tokens råd')
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
    const visning = await read($, paneVisning)
    const nr = await read($, paneNr)
    const antal = await read($, paneAntal)
    const linjer = await read($, paneLinjer)

    return (
      <Box flexDirection="column">
        {(linjer.length ? linjer : ['Tryk Projekt for at hente forbruget.']).map(vis)}
        <Box>
          <Button key="projekt" label="Projekt" onPress={() => visPanel($, 'projekt', null)} />
          <Button key="dage" label="Dage" onPress={() => visPanel($, 'dage', null)} />
          <Button key="raad" label="Råd" onPress={() => visPanel($, 'raad', null)} />
          {visning === 'opgave' && nr !== null && nr > 1 && (
            <Button key="forrige" label="‹ Forrige" onPress={() => visPanel($, 'opgave', nr - 1)} />
          )}
          {visning === 'opgave' && nr !== null && nr < antal && (
            <Button key="naeste" label="Næste ›" onPress={() => visPanel($, 'opgave', nr + 1)} />
          )}
        </Box>
      </Box>
    )
  })
}
