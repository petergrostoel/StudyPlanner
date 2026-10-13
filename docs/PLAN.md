# Studieplan – vision og plan

## Vision

En app til to børn, der laver deres læseplan ud fra pensum, puffer venligt, så alt bliver nået til tiden,
og som beskytter fritiden. Det skal være **ekstremt nemt** for børnene: de skal kun trykke Start, læse,
og bagefter sige, hvilken side de nåede til.

## Kerneregler

### 1. Pensum = bøger med sidetal
Hvert barn har et pensum med en **samlet frist**. Pensum består af bøger og tekster med *fra side* og *til side*.
En bog kan have sin **egen frist**. Ellers gælder pensummets samlede frist.

### 2. Læsefart
Efter hver læsning gemmes: første side, siden man nåede til, og minutter.
Læsefarten er **samlet tid / samlede sider** over de seneste 8 læsninger, så én dårlig dag ikke vælter planen.
Har barnet læst mindst 3 gange i en bestemt bog, bruges bogens egen fart (en roman læses hurtigere end en fagbog).
Indtil der er målt, gættes der på 2 minutter pr. side.

### 3. Planen
For hver bog: resterende sider fordeles jævnt på læsedagene fra i dag til fristen
(man-fre som standard). Har barnet allerede læst i bogen i dag, starter planen i morgen.
Planen udregnes forfra hver gang, så den altid passer til den seneste læsefart.

### 4. Advarsler
- En dag er **for tung**, hvis den samlede læsning overstiger barnets maks. minutter pr. dag (standard 45).
- En bog er **for sent**, hvis fristen er nået, og der stadig mangler sider.
Begge dele vises for barnet som en venlig besked og for forælderen i overblikket.

## Teknik

```
iPhone / pc (PWA)
  ├─ IndexedDB (offline database: kids, curricula, books, sessions + udbakke)
  └──►  Supabase database (EU), login og Row Level Security
```

- **App:** PWA på GitHub Pages, ren HTML/CSS/JS uden byggetrin (samme opbygning som Wine Cellar).
- **Offline:** alle ændringer gemmes først lokalt og lægges i en udbakke. Når der er net, sendes udbakken op,
  og ændringer fra andre enheder hentes ned (kun rækker med nyere `updated_at`). Sletning er blød (`deleted`).
- **Data:** én familiekonto ejer alle rækker. Børnene vælges i appen.

## Næste skridt

- Andre lektier end læsning (opgaver med anslået tid og frist).
- Påmindelser som push-beskeder på telefonen.
- Tag et billede af ugeplanen og lad AI foreslå bøger og frister.

## Opdatering 13. oktober 2026

- Pensum er nu fag og projekter (tabellen `curricula`) med en frist, hvor alt skal være læst.
  En tekst kan have sin egen, tidligere frist. Den kan aldrig ligge efter fagets.
- En tekst kan have flere sideintervaller (`books.ranges`). Titel og forfatter kan hentes ud fra ISBN.
- Læsetid: hver dag er fuld, halv eller fri (`day_rules` + profilens normale uge). En fuld dag tæller 1
  i fordelingen, en halv 0,5. Profilen sætter selv timer for fuld og halv dag (standard 4 og 2).
  En dag er for tung, hvis der er planlagt mere, end dagstypen giver tid til.
- Ingen forælder-visning: hver bruger har sin egen konto og ser kun sin egen plan.
