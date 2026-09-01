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
    `\`${prefix} musica <url_ou_nome>\` — baixa música em MP3 (YouTube, Spotify, Deezer, Instagram ou TikTok) (\`/baixar_musica\` no slash)`,
  ].join('\n');
}

export async function handlePrefixCommand(message) {
  const prefix = config.discord.prefix.toLowerCase();
  const contentLower = message.content.toLowerCase();

  if (!contentLower.startsWith(prefix)) return;

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
    stringArgs.push({ name: 'mensagem', value: parts.join(' ') });
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

  const adapter = createMessageAdapter(message, { stringArgs, channelArg });

  try {
    await command.execute(adapter);
  } catch (error) {
    logger.error(`[PrefixCommands] Erro ao executar "${prefix} ${subcommand}": ${error.message}`);
    await message.reply('❌ Ocorreu um erro interno ao processar este comando.').catch(() => null);
  }
}
