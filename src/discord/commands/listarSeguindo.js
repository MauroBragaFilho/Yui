import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { twitchRepository } from '../../database/repositories/twitchRepo.js';
import { makeEmbed, clampText } from '../embedLimits.js';
import { logger } from '../../utils/logger.js';

// Limites do Discord (TG-03): campo de 1024 caracteres, 25 campos e 6000 caracteres SOMADOS por mensagem.
// Não há teto de inscrições por servidor, então a lista é dividida em campos (cada item inteiro, nunca cortado no meio)
// e, se não couber numa mensagem, em até MAX_PAGES mensagens (a 1ª é a resposta; as outras vão como mensagens efêmeras seguintes).
const FIELD_MAX = 1000;
const PAGE_BUDGET = 5400; // título + campos + rodapé de uma mensagem (o teto da API é 6000)
const MAX_FIELDS_PER_PAGE = 24;
const MAX_PAGES = 3;
const TITLE = '📡 Monitoramento Social deste servidor';

/** Junta os itens em blocos de até `max` caracteres, sem partir um item. Devolve [{ text, count }]. */
function packItems(items, max) {
  const out = [];
  let cur = null;
  for (const raw of items) {
    const item = clampText(raw, max);
    if (cur && cur.text.length + 1 + item.length <= max) {
      cur.text += `\n${item}`;
      cur.count += 1;
    } else {
      cur = { text: item, count: 1 };
      out.push(cur);
    }
  }
  return out;
}

/** Monta as páginas: [{ fields: [{ name, value }], items }] e quantos itens ficaram de fora. */
function buildPages(youtubeLines, twitchLines) {
  const blocks = [];
  for (const [label, lines] of [['📺 YouTube', youtubeLines], ['🎮 Twitch', twitchLines]]) {
    packItems(lines, FIELD_MAX).forEach((chunk, i) => {
      blocks.push({ name: i === 0 ? `${label} (${lines.length})` : `${label} (cont.)`, value: chunk.text, count: chunk.count });
    });
  }
  const pages = [];
  let cur = null;
  for (const block of blocks) {
    const size = block.name.length + block.value.length;
    if (!cur || cur.fields.length >= MAX_FIELDS_PER_PAGE || cur.size + size > PAGE_BUDGET) {
      cur = { fields: [], size: 0, items: 0 };
      pages.push(cur);
    }
    cur.fields.push({ name: block.name, value: block.value, inline: false });
    cur.size += size;
    cur.items += block.count;
  }
  const kept = pages.slice(0, MAX_PAGES);
  const hidden = pages.slice(MAX_PAGES).reduce((n, p) => n + p.items, 0);
  return { pages: kept, hidden };
}

export const listarSeguindoCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-listar-seguindo')
      .setDescription('[Admin] Lista todos os canais do YouTube e streamers da Twitch que este servidor está monitorando.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ Este comando só pode ser usado em um servidor.',
        ephemeral: true,
      });
    }

    const youtubeSubs = youtubeRepository.getSubscriptionsByGuild(interaction.guildId);
    const twitchSubs = twitchRepository.getSubscriptionsByGuild(interaction.guildId);

    const youtubeLines = youtubeSubs.map((sub, i) => {
      const prefs = [
        sub.notify_videos === 1 ? '📹' : null,
        sub.notify_shorts === 1 ? '📱' : null,
        sub.notify_lives === 1 ? '🔴' : null,
      ].filter(Boolean).join(' ');
      const roleMention = sub.mention_role_id ? ` · <@&${sub.mention_role_id}>` : '';
      return `${i + 1}. **${sub.channel_name || sub.youtube_channel_id}**\n   └ <#${sub.discord_channel_id}> ${prefs}${roleMention}`;
    });

    const twitchLines = twitchSubs.map((sub, i) => {
      const roleMention = sub.mention_role_id ? ` · <@&${sub.mention_role_id}>` : '';
      return `${i + 1}. **${sub.twitch_login}**\n   └ <#${sub.discord_channel_id}> 🔴${roleMention}`;
    });

    if (youtubeLines.length === 0 && twitchLines.length === 0) {
      const empty = makeEmbed({
        color: 0x2ECC71,
        title: TITLE,
        description:
          'Nenhum canal monitorado neste servidor ainda.\n\n' +
          'Use **/yui-seguir-youtube** para acompanhar um canal do YouTube ou **/yui-seguir-twitch** para acompanhar um streamer.',
      });
      return interaction.reply({ embeds: [empty], ephemeral: true });
    }

    const { pages, hidden } = buildPages(youtubeLines, twitchLines);
    const embeds = pages.map((page, i) => {
      const footer = [];
      if (pages.length > 1) footer.push(`Página ${i + 1}/${pages.length}`);
      if (hidden > 0 && i === pages.length - 1) footer.push(`${hidden} item(ns) não exibido(s): a lista passou do limite do Discord`);
      return makeEmbed({
        color: 0x2ECC71,
        title: pages.length > 1 ? `${TITLE} (${i + 1}/${pages.length})` : TITLE,
        fields: page.fields,
        footer: footer.length ? footer.join(' • ') : undefined,
      });
    });

    const reply = await interaction.reply({ embeds: [embeds[0]], ephemeral: true });
    for (const embed of embeds.slice(1)) {
      try {
        await interaction.followUp({ embeds: [embed], ephemeral: true });
      } catch (err) {
        logger.warn(`[ListarSeguindo] Não consegui enviar uma página extra da lista: ${clampText(err?.message, 120)}`);
        break;
      }
    }
    return reply;
  },
};