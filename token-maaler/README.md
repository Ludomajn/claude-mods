# Token-måler til Claude Code

Viser, hvad projektet, hver opgave og hver dag kostede i tokens og dollars, og hvad der kostede mest.

- `/tokens` viser hele projektets forbrug: tokens og pris i alt, og opgaverne sorteret efter de dyreste, hver med en kort beskrivelse af, hvad Claude udførte.
- `/tokens 3` udvider opgave 3: hvad prisen gik til, og hvorfor den blev dyr.
- `/tokens dage` viser de aktive dage, og `/tokens dag 2` viser dag 2 med dagens dyreste opgaver.
- `/tokens Kundekrigen` viser en anden session i samme projektmappe (en del af titlen er nok).
- Efter hver opgave vises et bånd over prompten med knapperne **Detaljer** og **Projekt**.
- Du kan også spørge Claude, fx "hvad kostede opgave 4?" eller "hvor mange dage har vi arbejdet på det her?".
- `/tokens råd` viser analytikerens råd til at bruge færre tokens, hver med et skøn over, hvad det kunne have sparet. Efter en opgave får du en besked, når der er et nyt råd, og båndet får knappen **Råd**.
- `/tokens råd alle` (eller knappen **Indsigt**) samler alle dine samtaler i alle projekter: forbruget i alt, rådene på tværs og de dyreste samtaler. I en ny samtale står "Bliv klogere på dit Claude forbrug" over prompten med knappen **Indsigt**.
- **PromptSMART** (knappen ved siden af Indsigt, `/tokens promptsmart` eller `/promptsmart`) finder steder, hvor din første prompt manglede noget, så du måtte rette bagefter, og foreslår, hvordan prompten kunne have lydt. Tre modeller deler arbejdet: Claude Opus analyserer dine 8 dyreste samtaler, Claude Sonnet skriver den bedre prompt på dit eget niveau (samme sprog og tone, højst halvanden gang så lang), og Claude Haiku skriver forklaringerne. Beløbet er, hvad rettelserne bagefter kostede. Forslagene gemmes, så en samtale kun gennemgås igen, når den har fået nye beskeder.
- Hvert råd står på højst tre linjer: hvad det kunne have sparet, hvad analytikeren så, og hvad du kan gøre.

Mod'en læser sessionens egne tal og transcript-filer på din egen maskine. For at beskrive opgaverne sender den korte uddrag (din besked, Claudes svar og hvilke filer der blev rørt) til Claude Haiku over samme forbindelse som samtalen; hver beskrivelse gemmes, så det sker én gang pr. opgave og koster under en øre. Ellers sender den intet ud.

## Installation

Kræver en ny version af Claude Code (testet på 2.1.289) på macOS eller Linux.

**Som plugin (anbefalet).** Mappen `claude-mods` er et plugin-katalog. Har du adgang til GitHub-repoet, så kør:

```bash
claude plugin marketplace add Ludomajn/claude-mods
```

Har du fået mappen som zip, så pak den ud og giv stien i stedet, fx `claude plugin marketplace add ~/claude-mods`. Installér derefter:

```bash
claude plugin install token-maaler@claude-mods
```

I Claude-appen kan du også installere den under **+** ved prompten → **Plugins** → **Add plugin**, når kataloget er tilføjet. Genstart appen, og skriv `/tokens`.

**Uden katalog.** Læg mappen `token-maaler` et fast sted, og tilføj stien i `~/.claude/settings.json` under `"env"`: `"CLAUDE_CODE_PLUGIN_DIRS": "/Users/DIT-BRUGERNAVN/claude-mods/token-maaler"`. Har du allerede stier dér, så sæt dem efter hinanden med `:` imellem.

## Indstillinger

Under `/config` står mod'ens indstillinger; alle er slået til fra start:

- **Velkomst i nye samtaler**: "Bliv klogere på dit Claude forbrug" med knappen Indsigt.
- **Bånd efter hver opgave**: prisen på den seneste opgave over prompten.
- **Beskeder**: en kort besked efter hver opgave og ved nye råd.
- **PromptSMART**: knappen PromptSMART ved siden af Indsigt. Gennemgangen sender uddrag af dine samtaler til Opus, Sonnet og Haiku og koster typisk under $1.
- **Beskrivelser af opgaver**: Claude Haiku skriver en kort beskrivelse af hver opgave. Slå den fra, hvis intet fra samtalen må sendes til en beskrivelse.

## Sådan regnes det

Hvert modelkald melder sine egne tokens. Et værktøjsresultat (fx en fil, der læses) bliver i samtalen og læses igen i alle senere runder, så mod'en tæller det med dér.

Historikken pr. dag kommer fra sessionens transcript-filer i `~/.claude/projects`. En dag er en kalenderdag i din egen tidszone, og dag 1 er den første dag med aktivitet. Priserne er Anthropics listepriser; kald i baggrunden (titler, forslag) står ikke i transcriptet og er ikke med.

## Analytikerens råd

Efter hver opgave gennemgår analytikeren hele projektet. Et nyt råd (eller et, der er blevet dobbelt så stort) vises én gang som besked. Reglerne i dag:

- Lang samtale: hver runde læser hele samtalen igen; `/compact` eller en ny session gør det billigere.
- Pauser: efter cirka en time skal hele samtalen skrives til cachen igen.
- Store værktøjsresultater: hele filer og lange output, der læses igen i de følgende runder.
- Tænkning og subagenter, når de fylder meget af prisen.
- Rutineopgaver som commit og push i en lang samtale.
- Subagenter på xhigh eller max effort, når de udgør mindst halvdelen af subagenternes pris. Forskellen til high måles i dine egne data, når der er nok af begge.
- En dyrere model end standardmodellen (Opus 5.5) i chatten: hvad samme arbejde havde kostet på standardmodellen. En dyrere klasse (fx Fable) får rådet at bruge den til det sværeste; en ældre version (fx Opus 5) får rådet at skifte.
- Skærmbilleder: hvert billede (ca. 1.500 tokens) læses igen i resten af opgaven; at læse siden som tekst er billigere.
- Fejlede værktøjskald: hver fejl koster en ekstra runde. Rådet afhænger af den hyppigste slags (kommandoer, tilladelser eller timeouts); kald, du selv afviste, tæller ikke.
- Forbrugsgrænsen: subagenter, der stoppede midt i arbejdet, fordi grænsen blev nået.
- Forbindelser og plugins, der følger med i hver runde (kun for den aktive session).

Alle skøn er regnet ud fra den enkelte brugers egne transcripts, ikke ud fra faste antagelser om, hvordan man arbejder. Et kald tæller med sit endelige output, og en forgrenet samtale tæller ikke den kopierede historik med igen.

### Sådan tilføjer du et råd

Reglerne står i `hooks/raad.ts`. En regel er en funktion, der får projektet og hver opgaves analyse og giver nul eller flere råd tilbage: `navn` (få ord), `hvorfor` (hvad der skete, med tal), `handling` (hvad man gør, og hvorfor det hjælper), `kort` (handlingen i få ord til beskeder), `eksempler` og et skøn i dollars. Skriv funktionen, og sæt den i listen `REGLER`. Beskeder, `/tokens råd`, Indsigt på tværs af samtaler, panelet og Claudes værktøj bruger den så automatisk. Hæv `INDSIGT`-versionen i `hooks/register.tsx`, så gemte resumeer regnes igen.
