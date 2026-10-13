# Studieplan 📚

En web-app der hjælper studerende med at nå deres pensum til tiden, uden at fritiden bliver spist op.
Designet låner fra Instagram og TikTok: mørkt tema, stories-ringe for hver bog, streaks og en startknap midt i bundmenuen.

Design og klikbar mockup: https://claude.ai/artifact/TspZ3FAYPHyMnWPK5SQurT

## Funktioner

- **Pensum med bøger:** hver profil har en liste af bøger og tekster med sidetal (fra side, til side).
- **To slags frister:** en samlet frist for hele pensum, og en egen frist på den enkelte bog eller tekst, hvis der er en.
- **Læsefart:** efter hver læsning skriver man bare, hvilken side man nåede til, og hvor længe man læste (fokus-timeren udfylder tiden). Appen udregner farten i minutter pr. side ud fra de seneste læsninger.
- **Planen retter sig selv:** resten af hver bog fordeles på læsedagene frem til fristen med den studerendes egen fart. Læser den studerende langsommere eller hurtigere end ventet, ændres planen med det samme.
- **Nudges og fredet fritid:** "I dag" viser det næste, der skal læses, og hvornår fritiden starter. Weekenden er fri, medmindre I slår det til.
- **Streaks:** antal dage i træk med læsning, som på de sociale medier.
- **Følg med (forælder):** begge profilers fremgang, læsefart og en advarsel, når en frist er i fare, eller en dag bliver for tung.
- **Virker offline:** alle data ligger i en database på telefonen (IndexedDB) og synkroniseres med Supabase, når der er net.

## Brug på iPhone

Appen er en PWA. Når den ligger på GitHub Pages (https://petergrostoel.github.io/StudyPlanner/):

1. Åbn adressen i **Safari** på iPhone
2. Tryk på **Del** → **Føj til hjemmeskærm**
3. Appen åbner i fuld skærm og virker offline

Log ind med familiens konto på hver enhed. Profilen vælges på forsiden.

## Opsætning af Supabase

1. Opret et projekt på https://supabase.com (region EU).
2. Kør `supabase/migrations/20261013080000_init.sql` i **SQL Editor** (eller `supabase db push` med CLI'en).
3. Indsæt projektets URL og *publishable* nøgle i `config.js` (Project Settings → API).
4. Under **Authentication → URL Configuration** sættes Site URL til GitHub Pages-adressen.

## Test lokalt på pc'en

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Åbn derefter http://localhost:8080/

Test af planlægningen (kræver Node):

```
node --test tests/
```

## Struktur

```
index.html     – sidens opbygning
styles.css     – udseende (mobil-først, mørkt, Instagram/TikTok-inspireret)
app.js         – skærme og brugerflade
planner.js     – planlægning: læsefart, frister og fordeling af sider (testet)
store.js       – offline database (IndexedDB) og synkronisering med Supabase
config.js      – Supabase-adresse og offentlig nøgle
manifest.json  – PWA-oplysninger (navn, ikon, farver)
sw.js          – service worker (offline)
icons/         – app-ikoner
supabase/      – databaseopsætning (tabeller, Row Level Security)
tests/         – tests af planner.js
serve.ps1      – lille lokal testserver
```
