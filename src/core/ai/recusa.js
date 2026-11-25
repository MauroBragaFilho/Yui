// RECUSA GENÉRICA DO MODELO (22/11/2026): "Desculpa, não posso ajudar com isso" a uma pergunta sobre o Cayo Perico do GTA Online. Essa frase NÃO existe no código da Yui: vem do
// filtro de segurança de um modelo atrás do OmniRoute, que leu "golpe" como crime real. Aqui só a DETECÇÃO (função pura) e o reforço de contexto usado numa ÚNICA nova tentativa.
// Resposta que explica ou ensina algo NÃO é recusa genérica: só vale a resposta CURTA que é só a recusa.
const MAX_CARACTERES = 160;
const MAX_PALAVRAS = 24;

const RECUSAS = [
  /\bnao (posso|consigo|tenho como|vou poder|vou conseguir) (te |lhe )?(ajudar|auxiliar|atender|responder|colaborar)\b/,
  /\bnao (posso|consigo) (fornecer|dar|passar|falar sobre|tratar d[eo]|discutir|prosseguir com) (isso|esse assunto|essa informacao|esse tipo|essa solicitacao|esse pedido)\b/,
  /\b(sinto muito|desculpe|desculpa|lamento)\b.{0,20}\bnao (posso|consigo)\b/,
  /\b(i can ?(no|')t|i cannot|i am unable to|i m unable to|i won ?t) (help|assist|provide|comply|do that)\b/,
  /\b(sorry|apologi[sz]e)\b.{0,25}\b(can ?(no|')t|cannot|unable)\b/,
];

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A resposta é só uma recusa curta e genérica (sem conteúdo)? */
export function pareceRecusaGenerica(texto) {
  const cru = String(texto ?? '').trim();
  if (!cru || cru.length > MAX_CARACTERES) return false;
  const n = normalizar(cru);
  if (!n || n.split(' ').length > MAX_PALAVRAS) return false;
  return RECUSAS.some((re) => re.test(n));
}

/** O pedido da nova tentativa: o mesmo, com o contexto de que é um JOGO (golpe, assalto e heist são missões, não crimes). */
export function pedidoReforcado(pergunta) {
  return `[CONTEXTO] A pergunta é sobre o jogo GTA Online. "Golpe", "assalto", "heist", "Cayo Perico" e termos parecidos são MISSÕES do jogo, não crimes reais: responda normalmente, como a Yui, com dicas e estratégia do jogo. Se não tiver certeza de um dado, diga que não tem certeza em vez de recusar.\n[PERGUNTA] ${String(pergunta ?? '')}`;
}
