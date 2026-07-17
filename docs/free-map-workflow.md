# Piano gratuito per mappe da screenshot in Jarvis

Questo documento descrive una strada realistica per aggiungere a Jarvis la funzione richiesta:

1. l'utente invia uno screenshot o scrive a Jarvis;
2. Jarvis estrae gli indirizzi con un modello vision;
3. Jarvis calcola il percorso ottimizzato tra tutti i punti;
4. Jarvis pubblica una mappa interattiva con marker numerati, nome della via e link cliccabili verso la navigazione.

L'obiettivo è evitare API Google Maps a pagamento. La soluzione usa servizi e librerie gratuite/open-source, con limiti operativi da rispettare.

## Scelte richieste

- **Punto 1, piano A:** usare un modello vision per leggere screenshot e tabelle.
- **Punto 2, piano B:** ottimizzare il percorso, non limitarsi all'ordine dello screenshot.
- **Punto 3, soluzione 2:** generare una mappa interattiva vera, non solo un'immagine statica.
- **Vincolo:** niente Google Maps Platform a pagamento.

## Architettura gratuita proposta

| Funzione | Soluzione gratuita | Note |
| --- | --- | --- |
| Lettura screenshot | Provider AI vision già configurato, preferibilmente Gemini free tier se disponibile | Non aggiunge costi Google Maps; va gestita quota/free tier del provider AI. |
| Geocoding indirizzi | Nominatim/OpenStreetMap | Gratuito per uso leggero, con cache obbligatoria e rate limit prudente. |
| Distanze e percorso | OSRM open-source | Per uso serio conviene self-host; il demo server non va trattato come produzione. |
| Mappa interattiva | Leaflet | Libreria open-source, adatta a marker, popup e linee percorso. |
| Tile mappa | OpenStreetMap tile server solo per uso leggero | Per evitare blocchi servono attribution, cache lato browser e traffico basso. |
| Link navigazione | URL `https://www.google.com/maps/dir/?api=1...` oppure link OSM | I link Google Maps non richiedono Google Maps Platform API key. |

## Flusso utente ideale

1. L'utente scrive:

   ```text
   Jarvis crea mappa e giro ottimizzato
   ```

   allegando uno screenshot con vie e località.

2. Jarvis scarica temporaneamente l'allegato Discord e lo passa al modello vision.

3. Il modello vision restituisce JSON strutturato:

   ```json
   [
     {
       "label": "1",
       "area": "Borgata Aurelia",
       "address": "Via Aurelia Nord 51"
     },
     {
       "label": "2",
       "area": "Ladispoli Nuova",
       "address": "Via Duca degli Abruzzi 115"
     }
   ]
   ```

4. Jarvis chiede conferma se gli indirizzi sono ambigui o incompleti:

   ```text
   Ho letto questi indirizzi. Confermi che sono corretti?
   1. Via Aurelia Nord 51, Borgata Aurelia
   2. Via Duca degli Abruzzi 115, Ladispoli Nuova
   ```

5. Jarvis geocodifica ogni indirizzo con Nominatim, usando cache locale/Supabase per non ripetere chiamate uguali.

6. Jarvis calcola una matrice distanze con OSRM e sceglie l'ordine più breve:
   - per 2-8 indirizzi: brute force/permutazioni, semplice e gratuito;
   - per più indirizzi: euristica nearest-neighbor + 2-opt.

7. Jarvis genera una pagina HTML interattiva con Leaflet:
   - marker numerati;
   - etichetta con nome via;
   - popup con indirizzo completo;
   - link “Apri in Maps” per ogni punto;
   - linea del percorso ottimizzato;
   - riepilogo distanza totale e ordine consigliato.

8. Jarvis risponde su Discord con:

   ```text
   Giro ottimizzato creato.
   Totale: 18,4 km circa
   Tempo stimato: 31 min circa

   Mappa interattiva: https://...
   Percorso Google Maps: https://www.google.com/maps/dir/?api=1...
   ```

## Limiti della strada gratuita

Questa soluzione è fattibile senza pagare Google Maps Platform, ma non significa “illimitata”:

- Nominatim e i tile server pubblici OpenStreetMap sono risorse condivise: bisogna fare poche richieste, usare cache, identificare l'app con User-Agent e rispettare le policy.
- OSRM demo server è utile per prototipo o uso personale leggero; per produzione affidabile conviene self-hostare OSRM su un piccolo server o usare dati pre-elaborati.
- Il modello vision può avere quota gratuita o costi in base al provider configurato. Per rimanere nel gratuito bisogna usare provider/free tier già disponibile e limitare dimensione immagini e numero richieste.
- Google Maps può essere usato come semplice link di navigazione, senza API key, ma la mappa interattiva della pagina Jarvis deve restare basata su Leaflet/OSM.

## Implementazione consigliata in fasi

### Fase 1: comando testuale gratuito

Aggiungere un comando tipo:

```text
Jarvis mappa:
Via Aurelia Nord 51, Borgata Aurelia
Via Duca degli Abruzzi 115, Ladispoli
Via Antonio Ricci 11, Cerveteri
Via Bernardo Rallo 10, Campo di Mare
```

Output:

- geocoding Nominatim;
- percorso OSRM;
- ordine ottimizzato;
- link Google Maps/OSM;
- pagina Leaflet.

Questa fase evita OCR/vision ed è più facile da testare.

### Fase 2: screenshot con modello vision

Aggiungere download temporaneo allegato Discord e prompt vision JSON-only.

Regola importante: se il modello non è sicuro, Jarvis deve chiedere conferma invece di calcolare una mappa sbagliata.

### Fase 3: cache e protezione anti-abuso

Aggiungere:

- cache geocoding per indirizzo normalizzato;
- rate limit per utente/canale;
- limite massimo indirizzi per richiesta;
- cancellazione immagini temporanee;
- logging senza dati sensibili.

### Fase 4: qualità percorso

Aggiungere:

- scelta “ordine screenshot” o “giro ottimizzato”;
- partenza/fine opzionale;
- modalità auto/piedi/bici se supportata dal motore di routing scelto;
- esportazione riepilogo testuale.

## Output minimo accettabile

Anche senza pagare nulla, il primo MVP dovrebbe produrre almeno:

- lista indirizzi riconosciuti;
- coordinate trovate;
- ordine ottimizzato;
- distanza totale stimata;
- link al percorso completo;
- pagina Leaflet con marker numerati e popup cliccabili.

