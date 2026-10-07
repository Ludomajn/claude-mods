// Hvordan forbruget vises: som andel af abonnementets grænser (5 timer og en uge), når de er
// målt, og ellers i kroner. Kroner står som ekstra i parentes, hvor der er plads.
//
// Grænserne kendes kun som procent. Mod'en lærer, hvor meget listepris ét procentpoint svarer til,
// ved at sammenholde grænsernes procent med forbruget i alle transcripts i samme vindue (kalibrering).

export type Enhed = {
  // Kroner pr. dollar.
  kurs: number
  // Listepris i dollars pr. procentpoint af ugens grænse og af 5-timersgrænsen; null = ikke målt endnu.
  uge: number | null
  fem: number | null
}

let enhed: Enhed = { kurs: 6.5, uge: null, fem: null }

export const saetEnhed = (e: Partial<Enhed>): void => {
  enhed = { ...enhed, ...e }
}

export const hentEnhed = (): Enhed => enhed

const komma = (n: number, d: number) => n.toFixed(d).replace('.', ',')

const tusind = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

export const kr = (usd: number): string => {
  const v = usd * enhed.kurs
  return v >= 10 ? `${tusind(v)} kr` : `${komma(v, 2)} kr`
}

const pct = (p: number) => (p < 0.1 ? '<0,1 %' : p < 10 ? `${komma(p, 1)} %` : `${Math.round(p)} %`)

// "2,1 % af ugen"; over en hel uge "1,4 ugers grænse". Null, før grænsen er målt.
export const afUgen = (usd: number): string | null => {
  if (!enhed.uge) return null
  const p = usd / enhed.uge
  return p >= 100 ? `${komma(p / 100, 1)} ugers grænse` : `${pct(p)} af ugen`
}

// "12 % af 5 t"; over et helt vindue "1,8 × 5-timersgrænsen". Null, før grænsen er målt.
export const af5t = (usd: number): string | null => {
  if (!enhed.fem) return null
  const p = usd / enhed.fem
  return p >= 100 ? `${komma(p / 100, 1)} × 5-timersgrænsen` : `${pct(p)} af 5 t`
}

// Hovedtallet: andel af ugens grænse, ellers kroner.
export const maal = (usd: number): string => afUgen(usd) ?? kr(usd)

// Hovedtallet med kroner i parentes, når hovedtallet ikke selv er kroner.
export const maalKr = (usd: number): string => {
  const u = afUgen(usd)
  return u ? `${u} (${kr(usd)})` : kr(usd)
}

// Begge grænser og kroner, til én opgave: "12 % af 5 t · 2,1 % af ugen · 14 kr".
export const opgaveMaal = (usd: number): string => [af5t(usd), afUgen(usd), kr(usd)].filter(Boolean).join(' · ')

// Forbruget i en besked: begge grænser, når de er målt, ellers kroner.
export const graenseForbrug = (usd: number): string => [af5t(usd), afUgen(usd)].filter(Boolean).join(' · ') || kr(usd)

// "<1 min", "12 min", "1 t 5 min".
export const minutter = (sekunder: number): string => {
  const m = Math.round(sekunder / 60)
  return sekunder < 60 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} t${m % 60 ? ` ${m % 60} min` : ''}`
}

// Hvad tallene i rådene betyder.
export const maalForklaring = (): string => (enhed.uge ? 'andel af ugens grænse' : 'kroner')

export const FODNOTE_MAAL =
  'Procent af grænserne er skønnet ud fra dit eget forbrug i grænsernes vinduer; kroner er listepris omregnet med kursen i /config. Kald i baggrunden er ikke med.'

// Én måling af en grænse: listepris i vinduet delt med grænsens procent.
export type Maaling = { t: number; usdPrProcent: number }

// Medianen af de seneste målinger, så én skæv måling ikke flytter tallene.
export const median = (liste: readonly Maaling[]): number | null => {
  const v = liste.map(m => m.usdPrProcent).filter(x => x > 0 && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? (v[m] ?? null) : ((v[m - 1] ?? 0) + (v[m] ?? 0)) / 2
}

// Vinduernes længde; procenten skal være mindst så høj, før en måling er præcis nok.
export const VINDUER = {
  five_hour: { ms: 5 * 3_600_000, mindst: 2 },
  seven_day: { ms: 7 * 86_400_000, mindst: 1 },
} as const

export const KVARTER = 15 * 60_000
