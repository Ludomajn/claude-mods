import { describe, expect, test } from 'claude-code/testing'

import { analyserAndet, kodeForbrug, perioderUdenCode, proeverFra, referencePrProcent, udenForCode, vinduer } from './andet'
import type { Proeve } from './andet'
import { KVARTER } from './enhed'

const T0 = Date.UTC(2026, 8, 1)
const DAG = 86_400_000
const kv = (t: number) => String(Math.floor(t / KVARTER))
const naer = (x: number | null | undefined, y: number, afvigelse = 1e-6) => expect(typeof x === 'number' && Math.abs(x - y) <= afvigelse).toBe(true)

// Prøver hvert kvarter i `dage` døgn; `sd(i)` og `fh(i)` giver procenten ved kvarter i.
const raekke = (start: number, dage: number, sd: (i: number) => number, fh: (i: number) => number | null = () => null): Proeve[] =>
  Array.from({ length: dage * 96 }, (_, i) => ({ t: start + i * KVARTER, sd: sd(i), fh: fh(i) }))

describe('andet', () => {
  test('appens historikfil læses i begge versioner, for den seneste konto og i tidsrækkefølge', () => {
    const v2 = JSON.stringify({
      version: 2,
      samples: [
        { t: 3000, org: 'b', u: { fh: 5, sd: 7, so: 2 } },
        { t: 1000, org: 'a', u: { fh: 1, sd: 1 } },
        { t: 2000, org: 'b', u: { fh: 4, sd: 6 } },
        { t: 'x', org: 'b', u: { fh: 4, sd: 6 } },
      ],
    })
    expect(proeverFra(v2)).toEqual([
      { t: 2000, fh: 4, sd: 6 },
      { t: 3000, fh: 5, sd: 7 },
    ])
    expect(proeverFra({ version: 1, samples: [{ t: 1, fh: 2, sd: null }, { t: 2, fh: null, sd: 3 }] })).toEqual([
      { t: 1, fh: 2, sd: null },
      { t: 2, fh: null, sd: 3 },
    ])
    for (const daarlig of ['', 'ikke json', '{}', '{"samples": 3}', null, 42]) expect(proeverFra(daarlig)).toEqual([])
  })

  test('en ny periode begynder, når procenten falder; 5 timers grænsen også efter fem timer uden målinger', () => {
    const p: Proeve[] = [
      { t: 0, fh: 2, sd: 10 },
      { t: 1, fh: 30, sd: 11 },
      { t: 2, fh: 29, sd: 10 }, // et fald på ét point er ikke en nulstilling
      { t: 3, fh: 1, sd: 2 },
      { t: 4, fh: 5, sd: 4 },
      { t: 4 + 6 * 3_600_000, fh: 6, sd: 5 }, // seks timer senere: ny 5-timersperiode, men samme uge
    ]
    expect(vinduer(p, 'sd')).toEqual([
      { fra: 0, til: 2, p: 11 },
      { fra: 3, til: 4 + 6 * 3_600_000, p: 5 },
    ])
    expect(vinduer(p, 'fh')).toEqual([
      { fra: 0, til: 2, p: 30 },
      { fra: 3, til: 4, p: 5 },
      { fra: 4 + 6 * 3_600_000, til: 4 + 6 * 3_600_000, p: 6 },
    ])
    expect(vinduer([], 'sd')).toEqual([])
  })

  test('Codes forbrug i et tidsrum tælles pr. kvarter', () => {
    const kode = kodeForbrug([{ [kv(T0)]: 2, [kv(T0 + KVARTER)]: 3 }, undefined, { [kv(T0 + KVARTER)]: 1, [kv(T0 + 5 * KVARTER)]: 10 }])
    expect(kode(T0, T0 + 2 * KVARTER)).toBe(6)
    expect(kode(T0, T0 + KVARTER)).toBe(2)
    expect(kode(T0 + KVARTER + 1000, T0 + KVARTER + 2000)).toBe(4)
    expect(kode(T0 - DAG, T0 + DAG)).toBe(16)
    expect(kode(T0 + 2 * KVARTER, T0 + 4 * KVARTER)).toBe(0)
    expect(kode(T0 + KVARTER, T0)).toBe(0)
    expect(kodeForbrug([])(0, 1e15)).toBe(0)
  })

  test('forholdet mellem dollars og procent tages fra de perioder, hvor Code brugte det meste', () => {
    const uge = (fra: number, p: number, usd: number) => ({ vindue: { fra, til: fra + 6 * DAG, p }, usd })
    const ugerne = [uge(T0, 23, 44), uge(T0 + 7 * DAG, 100, 150), uge(T0 + 14 * DAG, 34, 47), uge(T0 + 21 * DAG, 99, 1188), uge(T0 + 28 * DAG, 100, 1099), uge(T0 + 35 * DAG, 100, 994), uge(T0 + 42 * DAG, 44, 538), uge(T0 + 49 * DAG, 5, 500)]
    const kode = kodeForbrug(ugerne.map(u => ({ [kv(u.vindue.fra)]: u.usd })))
    // Otte perioder, men den med 5 % er for lille; af de syv andre tages den næsthøjeste.
    naer(referencePrProcent(ugerne.map(u => u.vindue), kode), 1188 / 99, 5e-06)
    naer(referencePrProcent(ugerne.slice(3, 4).map(u => u.vindue), kode), 1188 / 99, 5e-06)
    expect(referencePrProcent([], kode)).toBeNull()
    expect(referencePrProcent([{ fra: 0, til: 1, p: 10 }], kode)).toBeNull()
  })

  test('forbrug uden for Code er procenten, Code ikke forklarer', () => {
    naer(udenForCode(44, 538, 12.2), 0, 0.5)
    naer(udenForCode(100, 150, 12), 87.5, 5e-06)
    expect(udenForCode(10, 500, 12)).toBe(0)
  })

  test('de gamle uger bruges mest til chat, den nye kun til Code', () => {
    const c = 12
    const nu = T0 + 21 * DAG + 2 * DAG
    // Uge A: ingen Code, procenten stiger til 60. Uge B: 300 dollars Code (25 %), procenten når 50.
    // Uge C: 360 dollars Code (30 %), procenten når 30.
    const a = raekke(T0, 7, i => Math.round((i / (7 * 96)) * 60))
    const b = raekke(T0 + 7 * DAG, 7, i => Math.round((i / (7 * 96)) * 50))
    const cc = raekke(T0 + 14 * DAG, 7, i => Math.round((i / (7 * 96)) * 30))
    const kode = kodeForbrug([{ [kv(T0 + 8 * DAG)]: 300 }, { [kv(T0 + 15 * DAG)]: 360 }])
    const r = analyserAndet([...a, ...b, ...cc], kode, c, nu)
    naer(r?.uge, 0, 0.5)
    expect(r?.ugeP).toBe(30)
    expect(r?.alt).toBeGreaterThan(80)
    naer(r?.alt, 60 - 0 + (50 - 25) + 0, 10)
    expect(r?.dage).toBe(23)
    // Uden et kendt forhold, uden prøver eller med en ukendt uge vises intet.
    expect(analyserAndet([...a, ...b], kode, null, nu)).toBeNull()
    expect(analyserAndet([], kode, c, nu)).toBeNull()
  })

  test('den aktuelle uge følger grænsens egen procent og start, når de kendes', () => {
    const c = 12
    const start = T0 + 3 * DAG
    const nu = start + 2 * DAG
    // Historikken stopper to timer før nu på 20 %; grænsen siger 40 % og at ugen begyndte tre dage inde.
    const p = [...raekke(T0, 3, () => 90), ...raekke(start, 2, i => Math.min(20, Math.floor(i / 20)))].filter(x => x.t < nu - 2 * 3_600_000)
    const kode = kodeForbrug([{ [kv(start + DAG)]: 120 }, { [kv(T0 + DAG)]: 10_000 }])
    const r = analyserAndet(p, kode, c, nu, { p: 40, fra: start })
    // 40 % - 120 / 12 = 30 %; de 10.000 dollars fra før ugen tæller ikke med.
    naer(r?.uge, 30, 5e-06)
    expect(r?.ugeP).toBe(40)
  })

  test('har appen været lukket, siden ugen blev nulstillet, tæller historikkens sidste uge som en afsluttet uge', () => {
    const c = 12
    const nu = T0 + 10 * DAG
    // Historikken stopper på 50 % efter tre dage; ugen blev nulstillet på dag 6 og står nu på 10 %.
    const p = raekke(T0, 3, i => Math.min(50, Math.floor(i / 5)))
    const kode = kodeForbrug([{ [kv(T0 + DAG)]: 240 }, { [kv(T0 + 7 * DAG)]: 60 }])
    const r = analyserAndet(p, kode, c, nu, { p: 10, fra: T0 + 6 * DAG })
    // Den gamle uge: 50 % - 240 / 12 = 30 %. Den nye: 10 % - 60 / 12 = 5 %.
    naer(r?.uge, 5)
    expect(r?.ugeP).toBe(10)
    naer(r?.alt, 35)
  })

  test('perioder uden Code findes, lægges sammen og brydes af Code-aktivitet', () => {
    const c = 12
    // Natten til mandag: fire timer, hvor ugen stiger fra 10 til 16, uden Code. Så en Code-session
    // om morgenen, mens ugen stiger yderligere. Så en kort stigning på ét point, som er for lille.
    const p: Proeve[] = []
    let sd = 10
    for (let i = 0; i < 16; i++) {
      p.push({ t: T0 + i * KVARTER, sd: Math.round(10 + (i / 15) * 6), fh: null })
    }
    sd = 16
    const morgen = T0 + 20 * KVARTER
    for (let i = 0; i < 8; i++) p.push({ t: morgen + i * KVARTER, sd: sd + Math.floor(i / 2), fh: null })
    const sidste = (p.at(-1)?.sd ?? 0) + 1
    p.push({ t: T0 + 40 * KVARTER, sd: sidste, fh: null })
    const kode = kodeForbrug([{ [kv(morgen)]: 20, [kv(morgen + KVARTER)]: 20, [kv(morgen + 2 * KVARTER)]: 20, [kv(morgen + 3 * KVARTER)]: 20, [kv(morgen + 4 * KVARTER)]: 20 }])
    const perioder = perioderUdenCode(p, kode, c, T0 - DAG)
    expect(perioder).toHaveLength(1)
    expect(perioder[0]).toEqual({ fra: T0 + KVARTER, til: T0 + 14 * KVARTER, procent: 6 })
    // Prøver uden for tidsrummet tæller ikke, og ugens procent kan ikke falde til en negativ stigning.
    expect(perioderUdenCode(p, kode, c, T0 + DAG)).toEqual([])
  })

  test('målinger mere end tre timer fra hinanden kan ikke placeres i tid', () => {
    const p: Proeve[] = [
      { t: T0, sd: 10, fh: null },
      { t: T0 + 4 * 3_600_000, sd: 20, fh: null },
    ]
    expect(perioderUdenCode(p, kodeForbrug([]), 12, 0)).toEqual([])
  })

  test('en nulstilling midt i en periode tæller væksten efter nulstillingen', () => {
    const p: Proeve[] = [
      { t: T0, sd: 98, fh: null },
      { t: T0 + KVARTER, sd: 100, fh: null },
      { t: T0 + 2 * KVARTER, sd: 4, fh: null },
      { t: T0 + 3 * KVARTER, sd: 6, fh: null },
    ]
    expect(perioderUdenCode(p, kodeForbrug([]), 12, 0)).toEqual([{ fra: T0, til: T0 + 3 * KVARTER, procent: 8 }])
  })
})
