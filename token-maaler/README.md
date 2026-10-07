# Token-måler til Claude Code

Viser, hvad projektet, hver opgave og hver dag kostede i tokens og dollars, og hvad der kostede mest.

- `/tokens` viser hele projektets forbrug: tokens og pris i alt, og opgaverne sorteret efter de dyreste, hver med en kort beskrivelse af, hvad Claude udførte.
- `/tokens 3` udvider opgave 3: hvad prisen gik til, og hvorfor den blev dyr.
- `/tokens dage` viser de aktive dage, og `/tokens dag 2` viser dag 2 med dagens dyreste opgaver.
- `/tokens Kundekrigen` viser en anden session i samme projektmappe (en del af titlen er nok).
- Efter hver opgave vises et bånd over prompten med knapperne **Detaljer** og **Projekt**.
- Du kan også spørge Claude, fx "hvad kostede opgave 4?" eller "hvor mange dage har vi arbejdet på det her?".

Mod'en læser sessionens egne tal og transcript-filer på din egen maskine. For at beskrive opgaverne sender den korte uddrag (din besked, Claudes svar og hvilke filer der blev rørt) til Claude Haiku over samme forbindelse som samtalen; hver beskrivelse gemmes, så det sker én gang pr. opgave og koster under en øre. Ellers sender den intet ud.

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
3. Genstart Claude-appen. Skriv `/tokens` for at se, at den kører.

Kun én terminal-session: `claude --plugin-dir token-maaler-0.4.0.zip`

## Sådan regnes det

Hvert modelkald melder sine egne tokens. Et værktøjsresultat (fx en fil, der læses) bliver i samtalen og læses igen i alle senere runder, så mod'en tæller det med dér.

Historikken pr. dag kommer fra sessionens transcript-filer i `~/.claude/projects`. En dag er en kalenderdag i din egen tidszone, og dag 1 er den første dag med aktivitet. Priserne er Anthropics listepriser; kald i baggrunden (titler, forslag) står ikke i transcriptet og er ikke med.
