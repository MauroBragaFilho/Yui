import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { getSystemMetrics } from '../../utils/systemMetrics.js';
import { CONSTANTS } from '../../config/constants.js';
import { getProviderSettings } from '../../handlers/llmHandler.js';
import { getAllSessions } from '../../music/radioDatabase.js';
import { getAutoBlockMode } from '../../handlers/banHandler.js';

// Mapa de nomes amigáveis para os provedores de IA.
const PROVIDER_NAMES = {
  local: '🐧 LM Studio / Ollama',
  gemini: '🔮 Google Gemini',
  cloudflare: '☁️ Cloudflare',
  pollinations: '🎨 Pollinations',
  hf: '🤗 HuggingFace',
  horde: '🌐 AI Horde',
};

function getRadioActiveSessions() {
  try {
    const sessions = getAllSessions();
    if (Array.isArray(sessions)) return sessions.length;
    if (sessions && typeof sessions.size === 'number') return sessions.size;
    return 0;
  } catch {
    return 0;
  }
}

export const statusCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-status')
      .setDescription('Exibe a telemetria, consumo de memória e saúde operacional do bot.')
  ),

  async execute(interaction) {
    const metrics = getSystemMetrics();
    const serverCount = interaction.client?.guilds?.cache?.size ?? 0;
    const radioSessions = getRadioActiveSessions();
    const automodMode = getAutoBlockMode(interaction.guildId);

    const providerSettings = getProviderSettings();
    const providers = Object.keys(providerSettings || {});
    const providerList =
      providers.length > 0
        ? providers.map((p) => `• ${PROVIDER_NAMES[p] || p}`).join('\n')
        : '• Nenhum provedor configurado';

    const automodLabel =
      automodMode === 'off'
        ? '⛔ Desativado'
        : automodMode === 'both'
          ? '🛡️ Ativado (Both)'
          : automodMode === 'mcp'
            ? '🛡️ Ativado (MCP)'
            : automodMode === 'trigger'
              ? '🛡️ Ativado (Monitor)'
              : '⛔ Desativado';

    const embed = new EmbedBuilder()
      .setColor(CONSTANTS.COLORS.SUCCESS)
      .setTitle('🤖 Yui — Status do Sistema')
      .setDescription('Telemetria em tempo real e monitoramento de recursos:')
      .addFields(
        {
          name: '⚙️ Motores & Serviços',
          value: '🟢 **Discord Client:** Online\n🟢 **Newswire Engine:** Standby\n🟢 **GTAO Engine:** Pronto\n🟢 **Database:** SQLite (WAL)',
          inline: false,
        },
        {
          name: '📊 Consumo de Recursos',
          value: `💾 **RAM do Bot:** ${metrics.rssMB} MB (Heap: ${metrics.heapUsedMB} MB)\n🖥️ **RAM do Sistema:** ${metrics.freeSystemMemMB} MB livres de ${metrics.totalSystemMemGB} GB\n⚡ **Uptime:** ${metrics.uptimeStr}`,
          inline: true,
        },
        {
          name: '☁️ Ambiente',
          value: `🐧 **SO:** ${metrics.platform}\n🧠 **CPUs:** ${metrics.cpuCount} vCPUs\n📦 **Modo:** ${process.env.NODE_ENV || 'production'}`,
          inline: true,
        },
        {
          name: '🏢 Rede & Comunidade',
          value: `👥 **Servidores:** ${serverCount}\n📻 **Sessões de Rádio Ativas:** ${radioSessions}\n🛡️ **AutoMod:** ${automodLabel}`,
          inline: true,
        },
        {
          name: '🤖 Provedores de IA',
          value: providerList,
          inline: true,
        }
      )
      .setFooter({ text: 'Otimizado para Oracle Cloud Ubuntu 24.04' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
