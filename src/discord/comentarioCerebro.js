// O COMENTÁRIO curto da Yui embaixo do embed (/steam_jogo e /converter_moeda), lado do BOT (etapa 7, docs/RELATORIO_ETAPA7_COMENTARIOS.md).
//
//  - Processo único (sem YUI_CEREBRO_EXTERNO, o padrão de hoje): EXATAMENTE como antes: o generateResponse do bot com o mesmo pedido (o texto
//    sai de core/ai/promptComentario.js, idêntico byte a byte ao que o interactionCreate montava) e as mesmas opções.
//  - Cérebro separado: um pedido chat.comentario ao cérebro com os FATOS da interação (quem, onde, a configuração do canal) e só os DADOS do
//    comentário (o tipo e os valores do embed); o cérebro monta o pedido, chama a IA isolada e devolve o texto. O bot continua com as
//    permissões e guardas (Termos de Uso, banimento e o motor de política do comando já passaram antes de chegar aqui), a entrega (um editReply
//    só, feito pelo interactionCreate) e o acabamento (extractAiComment: corte, sem @everyone, sem resposta de sistema).
// Devolve o texto CRU (o interactionCreate passa pelo extractAiComment, como sempre). Cérebro fora: '' (o embed sai sozinho, como quando a IA
// falha). Nunca lança no modo separado.
import { generateResponse, channelFactsForCerebro } from '../handlers/llmHandler.js';
import { checkBan } from '../handlers/banHandler.js';
import { isChatRemote, pedirComentario } from './turnoCerebro.js';
import { promptDoComentario } from '../core/ai/promptComentario.js';

/** Os fatos de uma interação para o cérebro (só dados do Discord; o cérebro remonta o papel e o escopo). */
export function fatosDoComentario(interaction) {
  const guildId = interaction?.guildId ?? null;
  const userId = interaction?.user?.id ?? null;
  const channelId = interaction?.channelId ?? null;
  let isBlocked = false;
  try { isBlocked = Boolean(checkBan(userId, guildId, null)); } catch (_) { isBlocked = false; }
  return {
    turn: { id: String(interaction?.id ?? ''), at: Number(interaction?.createdTimestamp) || Date.now() },
    ctx: { platform: 'discord', userId: String(userId ?? ''), guildId: guildId ? String(guildId) : null, channelId: channelId ? String(channelId) : null, isDM: !guildId, isBlocked },
    call: { entry: 'comentario', type: 'slash', record: false, mentionsBot: false, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false },
    channel: channelFactsForCerebro({ guildId, channelId, userId }),
  };
}

/**
 * O comentário da Yui para um comando manual. `tipo`: 'steam' | 'cotacao'; `dados`: os do core/ai/promptComentario.js.
 * @returns {Promise<string>} o texto cru da IA ('' quando não houver comentário)
 */
export async function comentarioDaYui(interaction, tipo, dados) {
  if (!isChatRemote()) {
    // Processo único: o caminho de sempre (o mesmo pedido e as mesmas opções de antes).
    return generateResponse(promptDoComentario(tipo, dados), interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
  }
  const out = await pedirComentario(fatosDoComentario(interaction), tipo, dados);
  return out.failed ? '' : String(out.text ?? '');
}
