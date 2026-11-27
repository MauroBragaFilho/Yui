// Ponte do painel para o que é POR SERVIDOR (ferramentas, Termos de Uso, persona e falas espontâneas por canal, menções e canal de updates) e para o
// GTA (o que saiu e onde, e republicar o mais recente; os bancos do GTA também são do bot).
// Mora no lado do bot de propósito: quem grava esses arquivos é o processo do Discord (llmHandler e tosHandler guardam uma cópia em memória),
// então o createAdmin (src/core/api) não importa nada daqui: recebe este carregador pronto (processo único: src/index.js; cérebro separado:
// src/discord/canalCerebro.js). Só chama as MESMAS funções dos comandos /yui-ferramentas, /yui-servidor e dos botões; a validação fica no admin.
// Os handlers são carregados na hora do primeiro uso.

/** As ferramentas que o /yui-ferramentas deixa ligar e desligar (o leave_voice_call acompanha o join_voice_call). */
export const ferramentasAlternaveis = (todas) => todas.filter((t) => t.meta && t.meta.disableable && t.function.name !== 'leave_voice_call');

export async function carregarServidorDoBot() {
  const llm = await import('../handlers/llmHandler.js');
  const tos = await import('../handlers/tosHandler.js');
  const adm = await import('../handlers/serverAdminHandler.js');
  return {
    limites: Object.freeze({ instrucao: adm.PERSONA_INSTRUCTION_MAX, humor: adm.PERSONA_MOOD_MAX }),

    ferramentas(guildId) {
      const desligadas = llm.getDisabledTools(guildId);
      return ferramentasAlternaveis(llm.getAllMcpTools()).map((t) => ({
        nome: t.function.name,
        rotulo: t.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : t.meta.label,
        descricao: t.meta.description || t.function.description || '',
        ligada: !desligadas.includes(t.function.name),
        padraoLigada: !t.meta.defaultDisabled,
      }));
    },
    definirFerramenta: (guildId, nome, ligada) => llm.setServerToolEnabled(guildId, nome, ligada),
    restaurarFerramentas: (guildId) => llm.resetServerTools(guildId),

    paginasDosTermos: () => tos.getTosPages().map((p) => ({ titulo: p.title, texto: p.content })),
    estadoDosTermos(guildId) {
      const registro = tos.getAcceptedServer(guildId);
      return {
        aceito: tos.isServerAccepted(guildId),
        exigido: tos.termosExigidos(),
        aceitoEm: registro?.timestamp ?? null,
        aceitoPor: registro?.authorizedBy ?? null,
        origem: registro ? registro.via ?? 'discord' : null,
      };
    },
    // Os mesmos efeitos do botão "Aceitar Termos": registra, define o canal de updates se faltar e avisa nele.
    async aceitarTermos(guild, userId) {
      const canal = await tos.registrarAceite(guild, userId, { via: 'painel' });
      const avisado = canal ? await tos.anunciarCanalDeUpdates(canal) : false;
      return { canalId: canal?.id ?? null, avisado };
    },
    // Só revoga o registro. O "Recusar e Sair" do Discord também faz o bot sair do servidor: pelo painel, NÃO.
    revogarTermos: (guildId) => tos.removeAcceptedServer(guildId),

    canal: (channelId) => llm.getChannelSettings(channelId),
    definirPersona: (channelId, dados) => llm.setChannelPersona(channelId, dados),
    definirEspontaneo: (channelId, dados) => llm.setChannelChatter(channelId, dados),

    opcoes: (guildId) => llm.getServerSettings(guildId),
    definirMencoes: (guildId, ligado) => llm.setServerEveryoneMention(guildId, ligado),
    definirCanalDeUpdates: (guildId, channelId) => llm.setServerUpdateChannel(guildId, channelId),

    // GTA (lacunas do painel, item 9 v1): o que saiu, onde e o estado das fontes. Os bancos do GTA são do bot; SÓ LEITURA (src/discord/gtaPainel.js).
    gta: async () => (await import('./gtaPainel.js')).lerGtaDoBot(),
    // Item 9 v2: republicar o mais recente de um tipo num servidor, no canal daquele tipo configurado nele (as MESMAS funções do agendador). A validação, o
    // limite de repetição e a auditoria ficam no admin; o cliente do Discord é o do admin (o deste processo).
    republicarGta: async (tipo, guildId, client) => (await import('./gtaPainel.js')).republicarGtaNoBot({ tipo, guildId, client }),
  };
}
