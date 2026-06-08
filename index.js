import 'dotenv/config';
import OpenAI from 'openai';
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { ChannelNotFetchableError, indexChannelById } from './src/discordIndexer.js';

const { DISCORD_TOKEN, OPENAI_API_KEY, OPENAI_MODEL = 'gpt-4.1-mini' } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Errore: DISCORD_TOKEN non è configurato nel file .env');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('Errore: OPENAI_API_KEY non è configurato nel file .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Memoria conversazionale semplice in RAM, separata per canale.
// Nota: viene azzerata a ogni riavvio del bot.
const channelMemory = new Map();
const MAX_MEMORY_MESSAGES = 10;
const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_MESSAGE_LIMIT = 1900;
const INDEX_CHANNEL_COMMAND = 'jarvis indicizza questo canale';
const DEFAULT_INDEX_MAX_MESSAGES = 5000;
const INDEX_MAX_MESSAGES = Number.parseInt(process.env.INDEX_MAX_MESSAGES ?? `${DEFAULT_INDEX_MAX_MESSAGES}`, 10);
const SAFE_INDEX_MAX_MESSAGES = Number.isFinite(INDEX_MAX_MESSAGES) && INDEX_MAX_MESSAGES > 0
  ? INDEX_MAX_MESSAGES
  : DEFAULT_INDEX_MAX_MESSAGES;

function isIndexChannelCommand(message) {
  return (message.content ?? '').trim().toLowerCase() === INDEX_CHANNEL_COMMAND;
}

function isAdministrator(message) {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.Administrator));
}

async function handleIndexChannelCommand(message) {
  if (!isAdministrator(message)) {
    await message.reply({
      content: "Solo un amministratore può avviare l'indicizzazione di questo canale.",
      allowedMentions: { repliedUser: false }
    });
    return;
  }

  try {
    await message.reply({
      content: 'Indicizzazione del canale avviata. Potrebbe richiedere qualche minuto...',
      allowedMentions: { repliedUser: false }
    });

    const result = await indexChannelById(client, message.channel.id, {
      maxMessages: SAFE_INDEX_MAX_MESSAGES
    });

    await message.reply({
      content: `Indicizzazione completata: ho salvato ${result.totalMessages} messaggi e trovato ${result.totalAttachments} allegati. File creato: ${result.filePath}`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error("Errore durante l'indicizzazione del canale:", error);

    const errorMessage = error instanceof ChannelNotFetchableError
      ? 'Questo canale non supporta il recupero dei messaggi storici.'
      : 'Mi dispiace, non sono riuscito a indicizzare questo canale. Controlla che il bot abbia i permessi per vedere il canale e leggere la cronologia messaggi.';

    try {
      await message.reply({
        content: errorMessage,
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      console.error("Errore durante l'invio del messaggio di errore dell'indicizzazione:", replyError);
    }
  }
}

function shouldReply(message) {
  const content = message.content ?? '';
  const mentionsBot = client.user ? message.mentions.has(client.user.id) : false;
  const containsJarvis = /\bjarvis\b/i.test(content);

  return mentionsBot || containsJarvis;
}

function cleanUserPrompt(message) {
  let prompt = message.content ?? '';

  if (client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '');
  }

  // Rimuove il nome del bot quando viene usato come parola di attivazione.
  prompt = prompt.replace(/\bjarvis\b/gi, '').trim();

  return prompt || 'Rispondi come assistente AI in italiano.';
}

function getChannelHistory(channelId) {
  if (!channelMemory.has(channelId)) {
    channelMemory.set(channelId, []);
  }

  return channelMemory.get(channelId);
}

function rememberMessage(channelId, role, content) {
  const history = getChannelHistory(channelId);
  history.push({ role, content });

  if (history.length > MAX_MEMORY_MESSAGES) {
    history.splice(0, history.length - MAX_MEMORY_MESSAGES);
  }
}

function splitDiscordMessage(text) {
  const chunks = [];
  let remaining = text || 'Non ho ricevuto una risposta valida.';

  while (remaining.length > SAFE_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n', SAFE_MESSAGE_LIMIT);

    if (splitAt < SAFE_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf(' ', SAFE_MESSAGE_LIMIT);
    }

    if (splitAt < SAFE_MESSAGE_LIMIT * 0.5) {
      splitAt = SAFE_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  // Ultima protezione: nessun chunk deve superare il limite reale di Discord.
  return chunks.map((chunk) => chunk.slice(0, DISCORD_MESSAGE_LIMIT));
}

async function askOpenAI(channelId, prompt) {
  const history = getChannelHistory(channelId);

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Sei Jarvis, un assistente AI dentro Discord. Rispondi sempre in italiano, in modo chiaro, pratico e utile. Se non sai qualcosa, dillo chiaramente e chiedi dettagli.'
      },
      ...history,
      { role: 'user', content: prompt }
    ],
    temperature: 0.4
  });

  return completion.choices?.[0]?.message?.content?.trim() || 'Mi dispiace, non sono riuscito a generare una risposta.';
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Jarvis è online come ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignora messaggi di altri bot per evitare loop o risposte indesiderate.
  if (message.author.bot) return;

  if (isIndexChannelCommand(message)) {
    await handleIndexChannelCommand(message);
    return;
  }

  if (!shouldReply(message)) return;

  const prompt = cleanUserPrompt(message);

  try {
    await message.channel.sendTyping();

    const reply = await askOpenAI(message.channel.id, prompt);

    rememberMessage(message.channel.id, 'user', prompt);
    rememberMessage(message.channel.id, 'assistant', reply);

    for (const chunk of splitDiscordMessage(reply)) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (error) {
    console.error('Errore durante la gestione del messaggio:', error);

    try {
      await message.reply({
        content: 'Mi dispiace, si è verificato un errore mentre elaboravo la richiesta. Riprova tra poco.',
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      console.error('Errore durante l\'invio del messaggio di errore:', replyError);
    }
  }
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Errore durante il login del bot Discord:', error);
  process.exit(1);
});
