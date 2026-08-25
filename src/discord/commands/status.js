import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getSystemMetrics } from '../../utils/systemMetrics.js';
import { CONSTANTS } from '../../config/constants.js';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('yui-status')
    .setDescription('Exibe a telemetria, consumo de memória e saúde operacional do bot.'),

  async execute(interaction) {
    const metrics = getSystemMetrics();

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
        }
      )
      .setFooter({ text: 'Otimizado para Oracle Cloud Ubuntu 24.04' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
