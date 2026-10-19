/**
 * Transforma uma Message comum (comando por prefixo, ex: "+yui diario")
 * em um objeto compatível com a interface mínima que os comandos slash
 * já esperam (interaction.deferReply, interaction.editReply, etc).
 *
 * Isso evita duplicar a lógica de cada comando em dois lugares —
 * tanto "/gta-diario" quanto "+yui diario" chamam exatamente a mesma
 * função `execute()`.
 */
export function createMessageAdapter(message, { stringArgs = [], channelArg = null } = {}) {
  let workingMessage = null;
  const author = message.author ?? null;
  const channel = message.channel ?? null;

  return {
    guildId: message.guild?.id ?? null,
    // QUEM pediu e ONDE, como numa interaction: o /yui (ask.js) decide a conversa sensível (o dono em DM ou em canal privado),
    // a trava de "uma pesquisa por pessoa" e o limite de buscas por usuário por estes campos. `authorId` segue valendo para o
    // limite de uma resposta por vez. `channel` serve ao plano B da entrega (mensagem nova no canal).
    user: author,
    authorId: author?.id ?? null,
    guild: message.guild ?? null,
    channelId: message.channelId ?? channel?.id ?? null,
    channel,
    replied: false,
    deferred: false,

    async deferReply() {
      workingMessage = await message.channel.send('⏳ Processando...');
      this.deferred = true;
    },

    async editReply(payload) {
      const normalized = typeof payload === 'string' ? { content: payload } : payload;
      if (workingMessage) {
        return workingMessage.edit(normalized);
      }
      return message.reply(normalized);
    },

    async reply(payload) {
      const normalized = typeof payload === 'string' ? { content: payload } : payload;
      this.replied = true;
      return message.reply(normalized);
    },

    async followUp(payload) {
      const normalized = typeof payload === 'string' ? { content: payload } : payload;
      return message.channel.send(normalized);
    },

    options: {
      // Usado por /gta-noticias (quantidade) e /yui (mensagem)
      getString(name) {
        const found = stringArgs.find((a) => a.name === name);
        return found ? found.value : null;
      },
      getInteger(name) {
        const found = stringArgs.find((a) => a.name === name);
        if (!found) return null;
        const parsed = parseInt(found.value, 10);
        return Number.isNaN(parsed) ? null : parsed;
      },
      // Usado por /yui-configurar — no modo prefixo, um canal por vez
      getChannel(name) {
        return channelArg?.name === name ? channelArg.channel : null;
      },
    },
  };
}
