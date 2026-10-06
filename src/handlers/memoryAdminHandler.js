import { EmbedBuilder, MessageFlags } from 'discord.js';
import { isMemoryEnabled, contextFromDiscord } from '../core/discordAdapter.js';
import { memory } from '../core/index.js';

const COLOR = 0x8B5CF6;
const ID_RE = /^\d{15,25}$/;

const ts = (ms, style = 'R') => (ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : '—');

/**
 * Subcomando `/yui-criador memorias` (somente o dono; a checagem de dono já é
 * feita no creatorAdminHandler e REPETIDA no backend do Core).
 *
 * Mostra apenas METADADOS das memórias temporárias dos usuários. O conteúdo
 * não é exibido: cada usuário vê o próprio em /yui-memoria ver.
 */
export async function handleMemoriasAdmin(interaction) {
  const reply = (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });

  if (!isMemoryEnabled()) return reply({ content: '🧠 O sistema de memória está desativado (YUI_MEMORY_ENABLED).' });

  // O papel OWNER é resolvido pelo backend; o Core recusa qualquer outro papel.
  const ctx = contextFromDiscord({ userId: interaction.user.id, guildId: null });
  const acao = interaction.options.getString('acao', true);
  const userId = interaction.options.getString('usuario_id');
  const memoriaId = interaction.options.getInteger('memoria_id');

  try {
    if (acao === 'listar') {
      const { users, total } = memory.adminListUsers(ctx, { limit: 25 });
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('🧠 Usuários com memória temporária')
        .setFooter({ text: `${total} usuário(s) • retenção de ${memory.retentionDays()} dias • conteúdo oculto por privacidade` });
      embed.setDescription(
        users.length
          ? users.map((u) => `<@${u.userId}> (\`${u.userId}\`) — **${u.count}** lembrança(s) · última interação ${ts(u.lastSeen)} · expira ${ts(u.expiresAt)}`).join('\n').slice(0, 3900)
          : 'Nenhum usuário com memória no momento.'
      );
      return reply({ embeds: [embed] });
    }

    if (!userId || !ID_RE.test(userId)) return reply({ content: '❌ Informe um `usuario_id` válido (somente números).' });

    if (acao === 'ver') {
      const rows = memory.adminListMetadata(ctx, userId, { limit: 25 });
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('🔎 Memórias do usuário (metadados)')
        .setFooter({ text: 'O conteúdo não é exibido. Use /yui-criador memorias acao:Apagar para remover.' });
      embed.setDescription(
        `<@${userId}> (\`${userId}\`)\n\n` +
        (rows.length
          ? rows.map((r) => `**#${r.id}** · \`${r.type}\` · ${r.chars} caracteres · origem \`${r.source || '—'}\` · criada ${ts(r.createdAt)} · expira ${ts(r.expiresAt)}`).join('\n').slice(0, 3600)
          : 'Nenhuma memória ativa.')
      );
      return reply({ embeds: [embed] });
    }

    if (acao === 'apagar') {
      if (!memoriaId) return reply({ content: '❌ Informe o `memoria_id` da lembrança.' });
      const ok = memory.adminForget(ctx, userId, memoriaId);
      return reply({ content: ok ? `🗑️ Lembrança #${memoriaId} de <@${userId}> apagada.` : 'Não encontrei essa lembrança para esse usuário.' });
    }

    if (acao === 'apagar_usuario') {
      const n = memory.adminForgetUser(ctx, userId);
      return reply({ content: `🗑️ ${n} lembrança(s) de <@${userId}> apagada(s).` });
    }
  } catch (err) {
    return reply({ content: `❌ ${err.message}` });
  }
}
