// Ferramenta DESLIGADA no servidor (painel web, aba Funções do servidor, ou /yui-ferramentas): a MESMA recusa em todos os caminhos.
// Antes só o despachante das ferramentas da IA (llmHandler) recusava; o /yui-imagem, os outros comandos de barra, o "+yui musica", a escolha da
// faixa do Deezer e as pré-rotas feitas por código (Porta G do GTA, Porta T dos lembretes, atalho da música do status) ignoravam o interruptor:
// o painel dizia "desligada" e a função continuava funcionando.
//
// Regras:
//  - só vale em SERVIDOR (guildId presente). Na DM nada muda: estes caminhos nunca consultam o interruptor por aqui;
//  - a frase é a do despachante (textoFerramentaDesligada), para a pessoa ver a mesma recusa venha o pedido por onde vier;
//  - puro: quem chama passa o isToolDisabled (o do llmHandler, que lê o server_tools.json do bot) e, nos lembretes, o interpretador da frase.
//
// O que fica de fora de propósito: "/sair-call" (tirar a Yui da call nunca é barrado) e a publicação agendada do GTA nos canais (é por canal,
// no /yui-configurar). Desde 27/11/2026 (decisão do Braga) os /gta-diario, /gta-semanal e /gta-noticias, e o "+yui diario|semanal|noticias",
// obedecem ao interruptor gta_online, como o GTA pela conversa.

/** A frase da recusa: a mesma do despachante das ferramentas da IA (src/handlers/llmHandler.js). */
export function textoFerramentaDesligada(tool) {
  return `⚠️ A ferramenta \`${tool}\` está desativada neste servidor.`;
}

/**
 * A recusa (texto) quando `tool` está desligada NESTE servidor; null quando está ligada, quando é DM (sem guildId) ou quando não há o que conferir.
 * Falha aberta só no que já era aberto: se o isToolDisabled lançar, segue como antes (null) e quem chama não muda de comportamento.
 */
export function recusaSeDesligada(guildId, tool, isToolDisabled) {
  if (!guildId || !tool || typeof isToolDisabled !== 'function') return null;
  let desligada = false;
  try { desligada = isToolDisabled(String(guildId), String(tool)) === true; } catch { desligada = false; }
  return desligada ? textoFerramentaDesligada(tool) : null;
}

/** Comando de barra -> a ferramenta do mcp_tools.json que o interruptor do servidor controla. */
const POR_COMANDO = Object.freeze({
  'yui-imagem': 'generate_image',
  baixar_video: 'download_video',
  buscar_jogo: 'search_game',
  steam_jogo: 'check_steam',
  converter_moeda: 'convert_currency',
  baixar_musica_atual: 'get_current_music',
  'gta-diario': 'gta_online',
  'gta-semanal': 'gta_online',
  'gta-noticias': 'gta_online',
});

/**
 * A ferramenta que um comando de barra (ou o "+yui musica", que usa o mesmo comando) aciona; null quando o comando não depende de interruptor.
 * /baixar_musica: com `busca` é a música por nome (Deezer, search_and_download_music); só com `url`, o áudio por link (download_audio).
 * Sem nenhum dos dois o próprio comando recusa, então não há ferramenta a conferir.
 */
export function ferramentaDoComando(commandName, options = null) {
  const nome = String(commandName ?? '');
  if (nome === 'baixar_musica') {
    const ler = (campo) => { try { return options?.getString?.(campo) ?? null; } catch { return null; } };
    if (ler('busca')) return 'search_and_download_music';
    if (ler('url')) return 'download_audio';
    return null;
  }
  return Object.hasOwn(POR_COMANDO, nome) ? POR_COMANDO[nome] : null;
}

/**
 * Pedido de lembrete por conversa num servidor com a ferramenta desligada: a recusa (texto) ou null.
 * "meus lembretes" e "resumo do dia" contam como listar_lembretes; criar, adiar, cancelar e o resto, como criar_lembrete.
 * `interpretar` é o parseReminderRequest (src/reminders/assistant.js); frase que não é pedido de lembrete nunca é recusada.
 * Com YUI_REMINDERS_ENABLED=false os lembretes por conversa já estão desligados e a mensagem segue como antes (nada a recusar aqui).
 */
export function recusaDeLembrete({ guildId, text, isToolDisabled, interpretar, env = process.env } = {}) {
  if (!guildId || typeof interpretar !== 'function') return null;
  if (String(env?.YUI_REMINDERS_ENABLED ?? 'true').trim().toLowerCase() === 'false') return null;
  let pedido = null;
  try { pedido = interpretar(String(text ?? '')); } catch { pedido = null; }
  if (!pedido || typeof pedido !== 'object') return null;
  const tool = pedido.action === 'list' || pedido.action === 'agenda' ? 'listar_lembretes' : 'criar_lembrete';
  return recusaSeDesligada(guildId, tool, isToolDisabled);
}
