import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { makeEmbed, chunkLines, clampText } from '../embedLimits.js';
import { checkBan } from '../../handlers/banHandler.js';
import { contextFromDiscord, isMemoryEnabled } from '../../core/discordAdapter.js';
import { memory, audit } from '../../core/index.js';
import { forgetUserContext } from '../../core/context/contextStore.js';
import { logger } from '../../utils/logger.js';

const COLOR = 0x8B5CF6;

// A descrição do embed aceita 4096 caracteres e o conteúdo de cada lembrança vem de fora (pode ser longo). A lista é montada
// linha a linha: uma lembrança nunca é cortada no meio (cortar deixava crase aberta e escondia o número que o /yui-memoria
// esquecer usa) e o que não coube vira o aviso "(+N lembrança(s) não exibida(s))".
const LIST_BUDGET = 3800;
const LINE_MAX = 500;
function fitLines(lines, budget = LIST_BUDGET) {
  const oneLine = lines.map((l) => clampText(String(l).replace(/\s+/g, ' ').trim(), LINE_MAX));
  const [first = ''] = chunkLines(oneLine, budget);
  const shown = first ? first.split('\n').length : 0;
  return { text: first, shown, hidden: lines.length - shown };
}

// O `apagar-tudo` NÃO toca no registro de uso do bot (src/data/historico.txt): o comando avisa isso, em vez de prometer o que não faz.
const HISTORY_NOTE = '\n-# O registro de uso do bot (historico.txt) não é apagado por este comando.';

// Direito de exclusão do contexto por horas (falas recentes guardadas por src/core/context/contextStore.js): apaga todos os fios
// da pessoa (DM e canais). Nunca lança, para a exclusão da memória não depender dele. Devolve quantas falas saíram.
async function wipeConversationContext(userId) {
  try {
    const removed = await forgetUserContext(userId);
    if (removed.turns > 0) {
      // Auditoria só com contagens, nunca o conteúdo.
      audit('context.forgetAll', { userId, platform: 'discord' }, { scopes: removed.scopes, turns: removed.turns });
    }
    return removed.turns;
  } catch (err) {
    logger.warn(`[Memoria] não consegui apagar o contexto das conversas recentes: ${String(err?.message ?? err).slice(0, 120)}`);
    return 0;
  }
}

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

    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // O contexto por horas é apagável mesmo com a memória desligada ou para quem está bloqueado.
    const removedContext = sub === 'apagar-tudo' ? await wipeConversationContext(userId) : 0;
    const contextOnlyReply = () => reply({ content: `🗑️ Apaguei ${removedContext} fala(s) do contexto das suas conversas recentes com a Yui.${HISTORY_NOTE}` });

    if (!isMemoryEnabled()) {
      if (removedContext > 0) return contextOnlyReply();
      return reply({ content: '🧠 O sistema de memória da Yui está desativado no momento.' });
    }

    const isBlocked = Boolean(checkBan(userId, interaction.guildId, interaction.channelId));
    const ctx = contextFromDiscord({
      userId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      isBlocked,
    });
    if (isBlocked) {
      if (removedContext > 0) return contextOnlyReply();
      return reply({ content: '🛑 Memória indisponível para este usuário.' });
    }

    if (sub === 'ver') {
      const rows = memory.listMemories(ctx, { limit: 25 });
      let description = 'Nada guardado ainda. Diga algo como “lembra que eu gosto de Sultan RS” ou use `/yui-memoria lembrar`.';
      if (rows.length) {
        const { text, hidden } = fitLines(rows.map((r) => `**#${r.id}** · \`${r.type}\` — ${r.content}`));
        description = hidden > 0 ? `${text}\n(+${hidden} lembrança(s) não exibida(s))` : text;
      }
      const embed = makeEmbed({ color: COLOR, title: '🧠 O que a Yui lembra sobre você', description, footer: scopeLabel(ctx) });
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
      const extra = removedContext > 0 ? ` e ${removedContext} fala(s) do contexto das conversas recentes` : '';
      return reply({ content: `🗑️ Apaguei ${n} lembrança(s) da sua memória${extra}.${HISTORY_NOTE}` });
    }
  },
};
