import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { checkBan } from '../../handlers/banHandler.js';
import { contextFromDiscord, isMemoryEnabled } from '../../core/discordAdapter.js';
import { memory } from '../../core/index.js';

const COLOR = 0x8B5CF6;

function scopeLabel(ctx) {
  return ctx.memoryScope === 'personal'
    ? '🔒 memória pessoal (permanente)'
    : `🕒 memória temporária (${memory.retentionDays()} dias sem interação)`;
}

export const memoriaCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-memoria')
      .setDescription('[User] Veja, adicione ou apague o que a Yui lembra sobre você.')
      .addSubcommand((s) => s.setName('ver').setDescription('Mostra o que a Yui lembra sobre você.'))
      .addSubcommand((s) =>
        s.setName('lembrar').setDescription('Pede para a Yui guardar uma informação.')
          .addStringOption((o) => o.setName('texto').setDescription('O que deve ser lembrado').setRequired(true).setMaxLength(300)))
      .addSubcommand((s) =>
        s.setName('esquecer').setDescription('Apaga uma lembrança pelo número (veja em /yui-memoria ver).')
          .addIntegerOption((o) => o.setName('id').setDescription('Número da lembrança').setRequired(true)))
      .addSubcommand((s) => s.setName('apagar-tudo').setDescription('Apaga TODA a sua memória com a Yui.'))
  ),

  async execute(interaction) {
    const reply = (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });

    if (!isMemoryEnabled()) {
      return reply({ content: '🧠 O sistema de memória da Yui está desativado no momento.' });
    }

    const userId = interaction.user.id;
    const isBlocked = Boolean(checkBan(userId, interaction.guildId, interaction.channelId));
    const ctx = contextFromDiscord({
      userId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      isBlocked,
    });
    if (isBlocked) return reply({ content: '🛑 Memória indisponível para este usuário.' });

    const sub = interaction.options.getSubcommand();

    if (sub === 'ver') {
      const rows = memory.listMemories(ctx, { limit: 25 });
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('🧠 O que a Yui lembra sobre você')
        .setFooter({ text: scopeLabel(ctx) });
      embed.setDescription(
        rows.length
          ? rows.map((r) => `**#${r.id}** · \`${r.type}\` — ${r.content}`).join('\n').slice(0, 3900)
          : 'Nada guardado ainda. Diga algo como “lembra que eu gosto de Sultan RS” ou use `/yui-memoria lembrar`.'
      );
      return reply({ embeds: [embed] });
    }

    if (sub === 'lembrar') {
      memory.remember(ctx, { type: 'note', content: interaction.options.getString('texto', true), importance: 3, source: 'discord-command' });
      return reply({ content: `✅ Guardei na ${scopeLabel(ctx)}.` });
    }

    if (sub === 'esquecer') {
      const ok = memory.forget(ctx, interaction.options.getInteger('id', true));
      return reply({ content: ok ? '🗑️ Lembrança apagada.' : 'Não encontrei essa lembrança na sua memória.' });
    }

    if (sub === 'apagar-tudo') {
      const n = memory.forgetAll(ctx);
      return reply({ content: `🗑️ Apaguei ${n} lembrança(s) da sua memória.` });
    }
  },
};
