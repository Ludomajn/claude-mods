import { describe, expect, test } from 'claude-code/testing'

import { af5t, kr, maal, maalKr, median, opgaveMaal, saetEnhed } from './enhed'

describe('enhed', () => {
  test('uden målte grænser vises kroner; med dem andel af ugen og 5 timer', () => {
    saetEnhed({ kurs: 6.5, uge: null, fem: null })
    expect(kr(0.04)).toBe('0,26 kr')
    expect(kr(1_000)).toBe('6.500 kr')
    expect(maal(2)).toBe('13 kr')
    expect(af5t(2)).toBeNull()

    saetEnhed({ uge: 0.04, fem: 0.005 })
    expect(maal(2)).toBe('50 % af ugen')
    expect(maal(0.2)).toBe('5,0 % af ugen')
    expect(maal(6)).toBe('1,5 ugers grænse')
    expect(maalKr(2)).toBe('50 % af ugen (13 kr)')
    expect(opgaveMaal(0.1)).toBe('20 % af 5 t · 2,5 % af ugen · 0,65 kr')
    expect(opgaveMaal(0.001)).toBe('0,2 % af 5 t · <0,1 % af ugen · 0,01 kr')
    saetEnhed({ uge: null, fem: null })
  })

  test('grænsen er medianen af målingerne', () => {
    expect(median([])).toBeNull()
    expect(median([{ t: 1, usdPrProcent: 3 }, { t: 2, usdPrProcent: 100 }, { t: 3, usdPrProcent: 2 }])).toBe(3)
    expect(median([{ t: 1, usdPrProcent: 2 }, { t: 2, usdPrProcent: 4 }])).toBe(3)
  })
})
