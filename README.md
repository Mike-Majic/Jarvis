# Jarvis

Jarvis è un bot Discord scritto in Node.js che funziona come una chat AI dentro un canale Discord.

Non usa comandi slash: gli utenti possono scrivere normalmente nel canale, ad esempio:

- `Jarvis cerca il numero 347...`
- `Jarvis che procedura devo seguire per guasto FTTH?`
- `Jarvis riassumi questa procedura`
- Oppure possono menzionare direttamente il bot: `@Jarvis aiutami con questa richiesta`

## Funzionalità attuali

- Legge i messaggi normali nei canali Discord.
- Risponde solo se viene menzionato oppure se il messaggio contiene la parola `Jarvis`.
- Ignora i messaggi inviati da altri bot.
- Usa OpenAI API per generare risposte.
- Risponde sempre in italiano.
- Mantiene una piccola memoria conversazionale per canale, salvata solo in RAM.
- Divide automaticamente le risposte troppo lunghe in più messaggi compatibili con Discord.
- Gestisce gli errori senza far crashare il processo.

## Cosa non fa ancora

Questa è una base funzionante. Per ora Jarvis **non**:

- indicizza due anni di messaggi Discord;
- usa un database;
- si collega a Supabase;
- usa comandi slash.

## Requisiti

- Node.js 18 o superiore.
- Un bot Discord creato nel [Discord Developer Portal](https://discord.com/developers/applications).
- Una chiave API OpenAI.

## Installazione

### 1. Installa le dipendenze

```bash
npm install
```

### 2. Crea il file `.env`

Copia il file di esempio:

```bash
cp .env.example .env
```

Poi apri `.env` e inserisci i valori reali:

```env
DISCORD_TOKEN=il_token_del_tuo_bot_discord
OPENAI_API_KEY=la_tua_chiave_openai
OPENAI_MODEL=gpt-4.1-mini
INDEX_MAX_MESSAGES=5000
```

> Non committare mai il file `.env`: contiene segreti ed è già escluso da Git.

### 3. Abilita gli intenti Discord necessari

Nel Discord Developer Portal:

1. Apri la tua applicazione.
2. Vai su **Bot**.
3. Abilita **Message Content Intent**.
4. Salva le modifiche.

Senza questo intento, il bot non può leggere il contenuto dei messaggi normali del canale.

### 4. Invita il bot nel server

Nel Discord Developer Portal:

1. Vai su **OAuth2** → **URL Generator**.
2. Seleziona lo scope `bot`.
3. Seleziona permessi come:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
4. Apri l'URL generato e invita il bot nel server.

## Avvio

Avvia Jarvis con:

```bash
npm start
```

Se tutto è configurato correttamente, vedrai un messaggio simile:

```text
Jarvis è online come Jarvis#1234
```

## Uso in Discord

Scrivi in un canale in cui il bot ha accesso:

```text
Jarvis spiegami questa procedura in modo semplice
```

Oppure menziona il bot:

```text
@Jarvis cosa devo fare in caso di guasto FTTH?
```

Jarvis risponderà nel canale usando OpenAI.

## Struttura del progetto

```text
.
├── .env.example     # Esempio delle variabili d'ambiente richieste
├── .gitignore       # File e cartelle da non committare
├── index.js         # File principale del bot
├── package.json     # Configurazione Node.js e script npm
└── README.md        # Istruzioni del progetto
```

## Note sulla memoria conversazionale

La memoria è volutamente semplice:

- è separata per ogni canale Discord;
- conserva solo gli ultimi messaggi della conversazione;
- vive in RAM;
- viene cancellata quando il bot viene riavviato.

In futuro potrà essere sostituita o estesa con un database.

## Indicizzazione locale dei canali

Jarvis include una prima struttura per indicizzare lo storico del canale corrente in un archivio locale. Questa funzione serve a preparare una base dati JSON che in futuro potrà essere usata per ricerca, riassunti o ulteriori elaborazioni.

### Comando temporaneo per amministratori

Un amministratore del server può scrivere nel canale:

```text
Jarvis indicizza questo canale
```

Jarvis recupererà i messaggi storici del canale a blocchi da 100 messaggi tramite l'API Discord e salverà un file JSON nella cartella `data/`.

Il comando funziona solo se l'utente ha permessi amministratore. Al termine Jarvis risponderà indicando:

- quanti messaggi sono stati salvati;
- quanti allegati sono stati trovati;
- il percorso del file JSON creato.

### Dati salvati

Per ogni canale viene creato un file:

```text
data/channel_<channelId>.json
```

Per ogni messaggio vengono salvati solo testo e metadati:

- `messageId`
- `channelId`
- `channelName`
- `guildId`
- `authorId`
- `authorTag`
- `createdAt`
- `content`
- `attachments`, con:
  - ID;
  - nome file;
  - URL;
  - content type;
  - dimensione.


### Limite massimo di sicurezza

Per evitare scansioni troppo grandi o loop indesiderati, Jarvis usa un limite massimo di messaggi indicizzabili per singolo comando.

Nel file `.env` puoi configurarlo così:

```env
INDEX_MAX_MESSAGES=5000
```

Se la variabile non è presente o non è valida, Jarvis usa `5000` come valore predefinito.

### Limiti attuali dell'indicizzazione

Per ora Jarvis:

- non scarica gli allegati;
- non legge PDF, Excel o Word;
- non usa database;
- non invia i dati indicizzati a OpenAI;
- salva solo un archivio JSON locale per canale.

La scansione usa pause tra i blocchi e tentativi automatici in caso di errori temporanei o rate limit.
