export type PostType =
  | 'start'
  | 'cache'
  | 'besked'
  | 'vaerktoej'
  | 'taenkning'
  | 'tekst'
  | 'kode'
  | 'subagent'
  | 'andet'

// En ting, opgaven brugte tokens på, med sin andel af opgavens pris.
export type Post = {
  type: PostType
  navn: string
  tokens: number
  gange: number
  andel: number
  usd: number | null
}

export type KontekstDel = { navn: string; tokens: number }

export type Opgave = {
  nr: number
  start: number
  prompt: string
  afbrudt: boolean
  sekunder: number
  usd: number | null
  model: string
  ind: number
  ud: number
  cacheLaes: number
  cacheSkriv: number
  runder: number
  startKontekst: number
  subagenter: number
  poster: Post[]
  forklaring: string
  tip: string
  kontekst: KontekstDel[]
}

declare module 'claude-code' {
  interface PluginState {
    'token-maaler': {
      opgaver: Opgave[]
      skjult: boolean
      paneVisning: 'projekt' | 'opgave' | 'dage' | 'raad'
      paneNr: number | null
      paneAntal: number
      paneLinjer: string[]
      raad: { id: string; titel: string; usd: number }[]
    }
  }
}
