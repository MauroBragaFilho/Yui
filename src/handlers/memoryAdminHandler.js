import { MessageFlags } from 'discord.js';
import { isMemoryEnabled, contextFromDiscord } from '../core/discordAdapter.js';
import { memory } from '../core/index.js';
import { makeEmbed, chunkLines, clampText } from '../discord/embedLimits.js';

const COLOR = 0x8B5CF6;
const ID_RE = /^\d{15,25}$/;

// A descrição do embed aceita 4096 caracteres. A lista é montada linha a linha (nunca corta uma linha no meio, o que deixava
// crase aberta e escondia o id usado em acao:Apagar) e o que não coube vira um aviso com a contagem.
const LINE_MAX = 500;
function fitLines(lines, budget) {
  const oneLine = lines.map((l) => clampText(String(l).replace(/\s+/g, ' ').trim(), LINE_MAX));
  const [first = ''] = chunkLines(oneLine, budget);
  const shown = first ? first.split('\n').length : 0;
  return { text: first, shown, hidden: lines.length - shown };
}

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
      let description = 'Nenhum usuário com memória no momento.';
      if (users.length) {
        const { text, shown } = fitLines(users.map((u) => `<@${u.userId}> (\`${u.userId}\`) — **${u.count}** lembrança(s) · última interação ${ts(u.lastSeen)} · expira ${ts(u.expiresAt)}`), 3800);
        // `total` conta todos os usuários com memória; a lista traz no máximo 25 (e pode ter perdido linhas por tamanho).
        const hidden = Math.max(users.length, Number(total) || 0) - shown;
        description = hidden > 0 ? `${text}\n(+${hidden} usuário(s) não exibido(s))` : text;
      }
      const embed = makeEmbed({
        color: COLOR,
        title: '🧠 Usuários com memória temporária',
        description,
        footer: `${total} usuário(s) • retenção de ${memory.retentionDays()} dias • conteúdo oculto por privacidade`
      });
      return reply({ embeds: [embed] });
    }

    if (!userId || !ID_RE.test(userId)) return reply({ content: '❌ Informe um `usuario_id` válido (somente números).' });

    if (acao === 'ver') {
      const rows = memory.adminListMetadata(ctx, userId, { limit: 25 });
      let body = 'Nenhuma memória ativa.';
      if (rows.length) {
        const { text, hidden } = fitLines(rows.map((r) => `**#${r.id}** · \`${r.type}\` · ${r.chars} caracteres · origem \`${r.source || '—'}\` · criada ${ts(r.createdAt)} · expira ${ts(r.expiresAt)}`), 3600);
        body = hidden > 0 ? `${text}\n(+${hidden} lembrança(s) não exibida(s))` : text;
      }
      const embed = makeEmbed({
        color: COLOR,
        title: '🔎 Memórias do usuário (metadados)',
        description: `<@${userId}> (\`${userId}\`)\n\n${body}`,
        footer: 'O conteúdo não é exibido. Use /yui-criador memorias acao:Apagar para remover.'
      });
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
