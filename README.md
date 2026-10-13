# Studieplan 📚

En web-app der hjælper studerende med at nå deres pensum til tiden, uden at fritiden bliver spist op.
Designet låner fra Instagram og TikTok: mørkt tema, stories-ringe for hvert fag, streaks og en startknap midt i bundmenuen.

Design og klikbar mockup: https://claude.ai/artifact/TspZ3FAYPHyMnWPK5SQurT

## Funktioner

- **Fag og projekter:** hver tekst hører til et fag eller projekt med en frist, hvor alt skal være læst (eksamen eller aflevering).
- **Tekster med sideintervaller:** en tekst kan bestå af flere intervaller (fx s. 112-148 og 211-310). Siderne imellem springes over.
- **ISBN:** tast ISBN, og appen henter titel, forfatter og sidetal (Google Books, ellers Open Library).
- **To slags frister:** fagets frist gælder alle tekster. En tekst kan have sin egen, tidligere frist, men aldrig en senere.
- **Læsetid:** hver dag er en fuld, halv eller fri læsedag. Man sætter en normal uge, faste ugedage i en periode (fx forelæsning hver tirsdag), perioder (fx ferie) og enkelte dage. Hver profil bestemmer selv, hvor mange timer en fuld og en halv dag er.
- **Læsefart:** efter hver læsning skriver man bare, hvilken side man nåede til, og hvor længe man læste (fokus-timeren udfylder tiden). Appen udregner farten i minutter pr. side ud fra de seneste læsninger.
- **Planen retter sig selv:** resten af hver tekst fordeles på læsedagene frem til fristen. En fuld dag tæller 1, en halv dag 0,5 og en fri dag 0. Læser man langsommere eller hurtigere end ventet, ændres planen med det samme.
- **Streaks:** antal dage i træk med læsning, som på de sociale medier.
- **Kun din egen:** hver bruger logger ind med sin egen konto og ser kun sin egen plan.
- **Virker offline:** alle data ligger i en database på telefonen (IndexedDB) og synkroniseres med Supabase, når der er net.

## Brug på iPhone

Appen er en PWA. Når den ligger på GitHub Pages (https://petergrostoel.github.io/StudyPlanner/):

1. Åbn adressen i **Safari** på iPhone
2. Tryk på **Del** → **Føj til hjemmeskærm**
3. Appen åbner i fuld skærm og virker offline

Hver bruger opretter sin egen konto i appen med sin egen e-mail.

## Opsætning af Supabase

1. Opret et projekt på https://supabase.com (region EU).
2. Kør filerne i `supabase/migrations/` i rækkefølge i **SQL Editor** (eller `supabase db push` med CLI'en).
3. Indsæt projektets URL og *publishable* nøgle i `config.js` (Project Settings → API).
4. Under **Authentication → URL Configuration** sættes Site URL til GitHub Pages-adressen.

## Test lokalt på pc'en

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Åbn derefter http://localhost:8080/

Test af planlægningen (kræver Node):

```
node --test tests/*.test.js
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
