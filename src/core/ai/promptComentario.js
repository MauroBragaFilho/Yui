// O COMENTÁRIO curto da Yui fora da fila (etapa 7, docs/RELATORIO_ETAPA7_COMENTARIOS.md): o texto que a Yui escreve embaixo do embed dos comandos
// manuais /steam_jogo e /converter_moeda (src/events/interactionCreate.js). UMA fonte só para o texto do pedido à IA, nos dois modos:
//  - processo único (sem YUI_CEREBRO_EXTERNO): o interactionCreate monta o pedido aqui e chama o generateResponse do bot, como sempre (o texto
//    é o MESMO de antes, byte a byte: conferido pelo retrato do que vai ao provedor);
//  - cérebro separado: o bot manda só os DADOS (o tipo e os valores do embed), e o cérebro monta o pedido aqui (chat.comentario). O bot não
//    manda texto livre para a IA por este método: só os tipos conhecidos, com os dados conferidos.
// Nada aqui lê rede, Discord ou banco; tudo é puro e testável.

/** Os tipos de comentário que existem (o cérebro recusa qualquer outro). */
export const TIPOS_DE_COMENTARIO = Object.freeze(['steam', 'cotacao']);

/**
 * O pedido à IA do comentário (o texto de sempre do interactionCreate). `dados`: steam { nome, preco }; cotacao { valor, de, para, resultado }.
 * Os valores entram como vieram (no processo único, o mesmo texto de antes); quem recebe do bot confere antes (dadosDoComentarioFromWire).
 */
export function promptDoComentario(tipo, dados = {}) {
  if (tipo === 'steam') {
    return `Eu acabei de consultar o jogo "${dados.nome}" na Steam via comando manual. O preço atual é ${dados.preco}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
  }
  if (tipo === 'cotacao') {
    return `Eu acabei de converter ${dados.valor} ${dados.de} para ${dados.para} via comando manual. O resultado foi ${dados.resultado}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
  }
  throw Object.assign(new Error(`Tipo de comentário desconhecido: ${String(tipo).slice(0, 30)}`), { code: 'COMENTARIO_TIPO' });
}

/** As opções de sempre do comentário no generateResponse do bot (processo único): sem busca, sem ferramentas, marcado como comentário interno. */
export const OPCOES_DO_COMENTARIO = Object.freeze({ allowSearch: false, disableTools: true, isInternalComment: true });

const texto = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const MOEDA_RE = /^[A-Z0-9]{2,10}$/;

/**
 * Os dados de um comentário que chegaram do bot (chat.comentario), conferidos: só os campos do tipo, texto de uma linha e com tamanho limitado
 * (o nome de um jogo vem da Steam: é dado de terceiros, nunca instrução). Lança { code: 'BAD_PARAMS' } se o tipo ou os dados não servem.
 */
export function dadosDoComentarioFromWire(tipo, raw) {
  const x = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const ruim = (m) => Object.assign(new Error(m), { code: 'BAD_PARAMS' });
  if (!TIPOS_DE_COMENTARIO.includes(tipo)) throw ruim('Tipo de comentário desconhecido.');
  if (!x) throw ruim('Dados do comentário ausentes.');
  if (tipo === 'steam') {
    const nome = texto(x.nome, 200);
    const preco = texto(x.preco, 60);
    if (!nome || !preco) throw ruim('Dados do comentário da Steam incompletos.');
    return { nome, preco };
  }
  const valor = typeof x.valor === 'number' && Number.isFinite(x.valor) ? x.valor : texto(x.valor, 30);
  const de = texto(x.de, 10).toUpperCase();
  const para = texto(x.para, 10).toUpperCase();
  const resultado = texto(x.resultado, 40);
  if (valor === '' || !MOEDA_RE.test(de) || !MOEDA_RE.test(para) || !resultado) throw ruim('Dados do comentário da cotação incompletos.');
  return { valor, de, para, resultado };
}
