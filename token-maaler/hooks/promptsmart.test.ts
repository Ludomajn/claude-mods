import { describe, expect, test } from 'claude-code/testing'

import type { HistOpgave } from './historik'
import { analysePrompt, jsonFra, kaederFra, loft, punkterFra, renPrompt } from './promptsmart'

const opgave = (nr: number, fuld: string, svar = ''): HistOpgave => ({ nr, fuld, svar }) as unknown as HistOpgave

describe('Dine prompts', () => {
  test('kæder fra Opus beholder kun beskeder, der findes og kom efter den første', () => {
    const opgaver = [opgave(1, 'Lav et banner'), opgave(2, 'Nej, i bunden'), opgave(3, 'Push')]
    const svar = 'Her er det: {"kaeder": [{"start": 1, "rettelser": [2, 1, 7, 2], "oenske": "Banner i bunden", "manglede": "placering"}, {"start": 3, "rettelser": []}, {"start": 9, "rettelser": [10]}]}'
    expect(kaederFra(svar, opgaver)).toEqual([{ start: 1, rettelser: [2], oenske: 'Banner i bunden', manglede: 'placering' }])
    expect(kaederFra('ikke JSON', opgaver)).toBeNull()
  })

  test('Haikus punkter falder tilbage, når et mangler, og prompten renses', () => {
    expect(punkterFra('{"punkter": [{"navn": "Banner", "manglede": "placering."}]}', 2)).toEqual([{ navn: 'Banner', manglede: 'placering' }, null])
    expect(renPrompt('Bedre prompt: "Lav et banner i bunden"')).toBe('Lav et banner i bunden')
    expect(renPrompt('Lav et banner.\n\nGerne i bunden.')).toBe('Lav et banner. Gerne i bunden.')
    expect(loft('x'.repeat(100))).toBe(250)
    expect(loft('x'.repeat(600))).toBe(900)
  })

  test('Opus får de seneste beskeder med starten af svarene', () => {
    const tekst = analysePrompt('Test', [opgave(1, 'Lav et banner', 'Jeg har lavet banneret øverst')])
    expect(tekst).toContain('[1] Bruger: Lav et banner\n    Assistent: Jeg har lavet banneret øverst')
  })
  test('JSON findes, selv med tekst og klammer efter det, og et afskåret svar er ikke "ingen kæder"', () => {
    const opgaver = [opgave(1, 'Lav et banner'), opgave(2, 'Nej, i bunden')]
    const kaede = '{"kaeder": [{"start": 1, "rettelser": [2], "oenske": "Et banner med {klammer} i teksten", "manglede": "placering"}]}'
    // En bemærkning med klammer efter objektet brød den gamle søgning fra første { til sidste }.
    expect(kaederFra(`${kaede}\n\nBemærk: besked 3 ({fortsæt}) er ikke en rettelse.`, opgaver)).toEqual([
      { start: 1, rettelser: [2], oenske: 'Et banner med {klammer} i teksten', manglede: 'placering' },
    ])
    expect(jsonFra('Svar: ```json\n{"a": "\\"}"}\n```')).toEqual({ a: '"}' })
    // Et svar, der blev skåret af, eller som slet ikke er JSON, giver null, så intet gemmes.
    expect(kaederFra('{"kaeder": [{"start": 1, "rettelser": [2', opgaver)).toBeNull()
    expect(kaederFra('Jeg fandt ingen.', opgaver)).toBeNull()
    expect(kaederFra('{"kaeder": []}', opgaver)).toEqual([])
  })
})
