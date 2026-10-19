import { createMessageAdapter } from './messageAdapter.js';
import { dailyCommand } from './commands/daily.js';
import { weeklyCommand } from './commands/weekly.js';
import { newsCommand } from './commands/news.js';
import { statusCommand } from './commands/status.js';
import { setupCommand } from './commands/setup.js';
import { askCommand } from './commands/ask.js';
import { baixarMusicaCommand } from './commands/baixarMusica.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { checkBan } from '../handlers/banHandler.js';

// Mapeia o subcomando digitado (ex: "+yui diario") para o mesmo objeto
// de comando usado pelos slash commands (/gta-diario). Aceita também
// alguns apelidos mais curtos, por conveniência.
const ROUTES = {
  diario: dailyCommand,
  daily: dailyCommand,
  semanal: weeklyCommand,
  weekly: weeklyCommand,
  noticias: newsCommand,
  notícias: newsCommand,
  news: newsCommand,
  status: statusCommand,
  configurar: setupCommand,
  config: setupCommand,
  perguntar: askCommand,
  ask: askCommand,
  'baixar-musica': baixarMusicaCommand,
  'baixar_musica': baixarMusicaCommand,
  musica: baixarMusicaCommand,
};

function buildHelpMessage() {
  const prefix = config.discord.prefix;
  return [
    `**Comandos disponíveis (prefixo \`${prefix}\`):**`,
    `\`${prefix} diario\` — resumo diário do GTA Online`,
    `\`${prefix} semanal\` — evento/bônus da semana`,
    `\`${prefix} noticias [quantidade]\` — últimas notícias do Newswire`,
    `\`${prefix} status\` — telemetria do bot`,
    `\`${prefix} configurar <noticias|diario|semanal> #canal\` — define os canais (requer permissão de Administrador)`,
    `\`${prefix} perguntar <sua pergunta>\` — conversa com a Yui sobre GTA Online (\`/yui\` no slash)`,
    `\`${prefix} musica <url_ou_nome>\` — baixa música em MP3 (YouTube, Spotify, Instagram ou TikTok) (\`/baixar_musica\` no slash)`,
  ].join('\n');
}

/**
 * Adaptador de mensagem para os comandos (o mesmo `execute()` do comando de barra), com QUEM pediu e ONDE como numa interaction:
 * `user`, `guild` e `channelId`. O /yui decide "conversa sensível" (o dono em DM ou em canal privado: sem provedor anônimo e sem
 * busca na web) e o limite de buscas por pessoa por estes campos, e o "+yui musica" lê interaction.user e interaction.guild (antes
 * lançava TypeError e a pessoa recebia "erro interno"). `authorId` segue valendo para o limite de uma resposta por vez no /yui.
 */
export function buildPrefixAdapter(message, options = {}) {
  const adapter = createMessageAdapter(message, options);
  adapter.user = message?.author ?? null;
  adapter.guild = message?.guild ?? null;
  adapter.channelId = message?.channelId ?? message?.channel?.id ?? null;
  adapter.authorId = message?.author?.id ?? null;
  return adapter;
}

/**
 * A mensagem começa com o prefixo de comando? É a MESMA regra do client.js (que trata a mensagem como comando) e do
 * events/messageCreate.js (que, por isso, não a processa de novo como menção ou chat). Prefixo vazio = modo desligado.
 */
export function startsWithCommandPrefix(content, prefix = config.discord.prefix) {
  const p = String(prefix ?? '');
  if (!p) return false;
  return String(content ?? '').toLowerCase().startsWith(p.toLowerCase());
}

/**
 * Texto livre que vem depois da palavra do subcomando ("perguntar lista:\n1. um" vira "lista:\n1. um").
 * Mantém as quebras de linha e as listas (antes o texto era achatado em uma linha só). Vazio se não houver nada.
 */
export function freeTextAfterSubcommand(rest) {
  return String(rest ?? '').trim().replace(/^\S+/, '').trim();
}

export async function handlePrefixCommand(message) {
  const prefix = config.discord.prefix.toLowerCase();
  const contentLower = message.content.toLowerCase();

  if (!contentLower.startsWith(prefix)) return;

  // Ban de usuário, servidor ou canal vale também no prefixo (antes só valia na menção, no comando de barra e na fila: "+yui perguntar" e
  // "+yui musica" contornavam o ban). Sem resposta, para o banido não gerar uma conversa com o bot a cada mensagem; só o log.
  if (checkBan(message.author?.id ?? null, message.guild?.id ?? message.guildId ?? null, message.channelId ?? null)) {
    logger.info('[PrefixCommands] Comando ignorado: usuário, servidor ou canal banido.');
    return;
  }

  const rest = message.content.slice(prefix.length).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const subcommand = (parts.shift() || '').toLowerCase();

  if (!subcommand || subcommand === 'ajuda' || subcommand === 'help') {
    await message.reply(buildHelpMessage());
    return;
  }

  const command = ROUTES[subcommand];
  if (!command) {
    await message.reply(
      `❓ Comando \`${subcommand}\` não reconhecido. Digite \`${config.discord.prefix} ajuda\` para ver a lista de comandos.`
    );
    return;
  }

  // Monta os argumentos no mesmo formato que a interaction.options espera
  let stringArgs = [];
  let channelArg = null;

  if (command === newsCommand) {
    if (parts[0]) stringArgs.push({ name: 'quantidade', value: parts[0] });
  } else if (command === askCommand) {
    // Texto livre, com as quebras de linha preservadas (listas e código colados); vazio é recusado pelo próprio /yui.
    stringArgs.push({ name: 'mensagem', value: freeTextAfterSubcommand(rest) });
  } else if (command === baixarMusicaCommand) {
    if (!parts[0]) {
      await message.reply(
        `⚠️ Uso correto: \`${config.discord.prefix} musica <url_do_youtube|spotify|instagram|tiktok OU nome/artista>\``
      );
      return;
    }
    const firstArg = parts[0].toLowerCase();
    if (/^https?:\/\//.test(firstArg) || /^www\./.test(firstArg)) {
      stringArgs.push({ name: 'url', value: parts[0] });
    } else {
      stringArgs.push({ name: 'busca', value: parts.join(' ') });
    }
  } else if (command === setupCommand) {
    if (!message.member?.permissions.has('Administrator')) {
      await message.reply('🔒 Apenas administradores do servidor podem usar este comando.');
      return;
    }

    const tipo = (parts.shift() || '').toLowerCase();
    const validTypes = ['noticias', 'diario', 'semanal'];
    const channel = message.mentions.channels.first();

    if (!validTypes.includes(tipo) || !channel) {
      await message.reply(
        `⚠️ Uso correto: \`${config.discord.prefix} configurar <noticias|diario|semanal> #canal\``
      );
      return;
    }
    channelArg = { name: tipo, channel };
  }

  const adapter = buildPrefixAdapter(message, { stringArgs, channelArg });

  try {
    await command.execute(adapter);
  } catch (error) {
    logger.error(`[PrefixCommands] Erro ao executar "${prefix} ${subcommand}": ${error.message}`);
    await message.reply('❌ Ocorreu um erro interno ao processar este comando.').catch(() => null);
  }
}
