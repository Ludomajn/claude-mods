# Token-måler til Claude Code

Viser, hvad hver opgave og hver dag kostede i tokens og dollars, og hvad der kostede mest.

- Et bånd over prompten efter hver opgave, med knapperne **Detaljer** og **Dage**.
- `/tokens` viser den seneste opgave med bjælker og en liste over de andre. `/tokens 3` viser opgave 3.
- `/tokens dage` viser agentens (sessionens) hele historik: antal aktive dage og prisen for hver dag.
- `/tokens dag 2` viser dag 2: pris, opgaver, subagenter og dagens dyreste opgaver.
- `/tokens dage Kundekrigen` viser en anden agent i samme projekt (en del af titlen er nok).
- Du kan også bare spørge Claude, fx "hvad kostede dag 1?" eller "hvor mange dage har vi arbejdet på det her?".

Mod'en sender ingen data ud. Den læser kun sessionens egne tal og transcript-filer på din egen maskine.

## Installation

Kræver en ny version af Claude Code (testet på 2.1.289) på macOS eller Linux.

1. Læg mappen `token-maaler` et fast sted, fx `~/claude-mods/token-maaler` (pak zip-filen ud, eller klon repoet).
2. Åbn `~/.claude/settings.json` og tilføj stien under `"env"`:

   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "/Users/DIT-BRUGERNAVN/claude-mods/token-maaler"
   }
   ```

   Findes filen ikke, så opret den med de linjer inde i `{ }`. Har du allerede `CLAUDE_CODE_PLUGIN_DIRS`, så sæt stierne efter hinanden med `:` imellem.
3. Genstart Claude-appen. Skriv `/tokens dage` for at se, at den kører.

Kun én terminal-session: `claude --plugin-dir token-maaler-0.3.0.zip`

## Sådan regnes det

Hvert modelkald melder sine egne tokens. Et værktøjsresultat (fx en fil, der læses) bliver i samtalen og læses igen i alle senere runder, så mod'en tæller det med dér.

Historikken pr. dag kommer fra sessionens transcript-filer i `~/.claude/projects`. En dag er en kalenderdag i din egen tidszone, og dag 1 er den første dag med aktivitet. Priserne er Anthropics listepriser; kald i baggrunden (titler, forslag) står ikke i transcriptet og er ikke med.
