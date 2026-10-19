/**
 * Detectores PUROS (sem rede, sem disco, sem estado) do "agente de pesquisa" da Yui:
 *
 *  1. detectUnfulfilledPromise(texto): a resposta do modelo só ANUNCIA que vai pesquisar/olhar/voltar ("Vou pesquisar isso!",
 *     "Deixa eu dar uma olhada", "Um segundo, já te respondo", "Pesquisando...") e não entrega nada. A Yui não consegue mandar
 *     nada depois, então isso é uma resposta quebrada. Regra de cauda: se vier conteúdo DEPOIS da última frase de promessa
 *     ("Deixa eu ver... acho que é 2026."), a resposta entregou algo e NÃO é promessa.
 *  2. detectSearchRequest(texto): o usuário pediu para pesquisar ("pesquise", "dá uma pesquisada", "procura pra mim",
 *     "vê se já saiu", "qual a notícia de hoje"), pedido explícito ou pergunta de dado atual. Negação, "como pesquisar",
 *     "vou pesquisar" (1ª pessoa) e "você consegue pesquisar?" NÃO são pedido.
 *  3. buildSearchQuery(texto): consulta limpa (sem "pesquisa aí pra mim") a partir da fala do usuário.
 *  4. preRouteDecision(texto): pedido de pesquisa na web INEQUÍVOCO e ESTRITO (Porta A). Música, clipe, letra, jogo, ferramenta própria
 *     (baixar, imagem, steam...) e pedidos que não são web ("ache um sinônimo") ficam de fora.
 *  5. recoveryPlan(...): o que fazer quando há promessa vazia (pesquisar, rotear, recusar, perguntar o assunto, pedir a resposta
 *     final ao modelo ou deixar passar). Porta C.
 *  6. finalGuard(texto): última guarda antes de enviar: resposta que é SÓ promessa nunca vai ao usuário. Porta D.
 *
 * Importar este módulo NÃO tem efeitos colaterais. Texto de usuário e de modelo é DADO: aqui só se casam padrões.
 *
 * SEGURANÇA DE DESEMPENHO: TODA entrada dos detectores é cortada em MAX_DETECT_CHARS (700) caracteres antes de qualquer expressão
 * regular, e as expressões não têm repetições aninhadas sobre os mesmos caracteres (teste de ReDoS em tests/test-search-intent.js).
 */

/** Teto de caracteres que os detectores olham (o resto é ignorado). */
export const MAX_DETECT_CHARS = 700;
/** Pedido maior que isto (ou com mais de MAX_PRE_LINES linhas) não é UMA consulta: pré-rota e recuperação não pesquisam. */
export const MAX_PRE_CHARS = 600;
export const MAX_PRE_LINES = 8;
/** Depois da última frase de promessa, até este número de letras ainda conta como "só promessa" (ex.: "Já volto!"). */
export const MAX_PROMISE_TAIL = 15;

export const SENSITIVE_SEARCH_REFUSAL = 'Não pesquiso na web numa conversa privada.';
export const SEARCH_DISABLED_REPLY = 'A pesquisa na web está desativada neste servidor.';
export const NEED_TOPIC_REPLY = 'Pesquisar o quê? Me diz o assunto que eu procuro.';
export const VOICE_REFUSAL = 'Por voz eu não pesquiso na web. Pede no chat de texto.';
// "Desculpe, tive um erro" é o marcador que o messageCreate.js e o isErrorReply (contextStore) já tratam como "erro da IA":
// assim nem o histórico nem o contexto guardam a promessa.
export const PROMISE_ONLY_FALLBACK = 'Desculpe, tive um erro ao fechar essa resposta. Pode perguntar de novo?';

// ---------------------------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------------------------

/** Entrada dos detectores: texto, cortado em `max` caracteres. */
export function clipInput(text, max = MAX_DETECT_CHARS) {
  return String(text ?? '').slice(0, max);
}

/** Minúsculas e sem acento, MANTENDO o comprimento (um caractere vira um caractere): serve para recortar o texto original. */
export function foldKeepLength(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (ch.length !== 1) { out += ch; continue; }
    const base = ch.normalize('NFD')[0] ?? ch;
    out += base.toLowerCase()[0] ?? base;
  }
  return out;
}

/** Sem acento e em minúsculas (o comprimento pode mudar). */
export const deaccent = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '');
export const norm = (s) => deaccent(s).toLowerCase();
/** Uma linha só: sem caracteres de controle e com espaços colapsados. */
export const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const letterCount = (s) => (String(s ?? '').match(/\p{L}/gu) ?? []).length;

/** Texto da resposta sem rodapé "-# ...", blocos de código, URLs e marcação, em minúsculas e sem acento. */
function foldReply(text) {
  const t = String(text ?? '')
    .replace(/^-#.*$/gm, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[*_`~>|]/g, '');
  // "pesquisaaaaar": letra repetida 3+ vezes é alongamento e vira uma só (só aqui: o comprimento do texto dobrado não é usado para recortar)
  return squeeze(foldKeepLength(t));
}

// ---------------------------------------------------------------------------------------------
// 1. PROMESSA VAZIA
// ---------------------------------------------------------------------------------------------

// Verbos de "ir consultar algo". strong/medium: o próprio modelo diz que vai pesquisar; weak: "ver", "olhar", "ler"...
const STRONG_V = '(?:pesquisar?|pesqisar|pesquizar|procurar?|buscar?|consultar|googlar|investigar|pesquisadinha|pesquisada|buscada|procurada|garimpar|fucar|rastrear|cacar|levantar)';
const MEDIUM_V = '(?:verificar|checar|conferir|confirmar|cheq(?:ar|uei))';
const WEAK_V = '(?:ver|olhar|ler|descobrir|achar|encontrar|analisar|abrir|acessar|puxar|dar? uma (?:olhada|olhadinha|lida|espiada|conferida|checada|verificada|vistoria|garimpada|fucada))';
const DO_SEARCH = '(?:fazer uma (?:rapida |breve )?(?:busca|pesquisa|consulta|checagem|verificacao)|dar? uma (?:pesquisada|pesquisadinha|buscada|procurada|consultada))';
// objetos do dia a dia que NÃO são pesquisa ("vou buscar meu café", "vou procurar um parceiro")
const MUNDANE = '(?!\\s+(?:(?:um|uma|o|a|os|as)\\s+)?(?:meu|minha|meus|minhas|agua|cafe|lanche|comida|pao|carregador|casaco|duo|parceir\\w+|amig\\w+|emprego|galera|gente)\\b)';
// "vou", "vamos", "irei" (e a grafia curta "vo") + advérbios + (te) + verbo
const FUT = '\\b(?:vou|vo|vamos|irei|iremos)\\b(?:\\s+(?:ja|so|logo|agora|rapidinho|tentar|la|aqui|entao|mesmo|de novo))*(?:\\s+(?:te|lhe|me))?';
// "vou ver se consigo / se posso / se rola": disponibilidade pessoal ("vamos jogar hoje?" -> "vou ver se consigo, te falo depois"), não consulta a nada.
const NOT_AVAILABILITY = '(?!\\s+se\\s+(?:eu\\s+)?(?:consigo|posso|rola|tenho|dou conta|vou conseguir)\\b)';

/**
 * kind: future-lookup | deixa-eu | wait | progress | deliver-later | offer
 * strength: strong | medium | weak  (força do verbo de consulta; wait/progress sem verbo = weak)
 */
const PROMISE_PATTERNS = [
  // vou pesquisar / vou dar uma olhada / vou fazer uma busca / vou atrás disso
  { kind: 'future-lookup', strength: 'strong', re: new RegExp(`${FUT}\\s+(?:${DO_SEARCH}|${STRONG_V})\\b${MUNDANE}`) },
  { kind: 'future-lookup', strength: 'medium', re: new RegExp(`${FUT}\\s+${MEDIUM_V}\\b`) },
  { kind: 'future-lookup', strength: 'weak', re: new RegExp(`${FUT}\\s+${WEAK_V}\\b${NOT_AVAILABILITY}`) },
  { kind: 'future-lookup', strength: 'strong', re: /\b(?:vou|vo|vamos)\s+(?:logo\s+|ja\s+)?atras\b/ },
  // vou até a internet buscar / vou na web ver
  { kind: 'future-lookup', strength: 'strong', re: new RegExp(`${FUT}\\s+(?:ate\\s+)?(?:a|na|pela|pra|para)\\s+(?:internet|web|net)\\b`) },
  // deixa eu dar uma olhada / deixa eu pesquisar
  { kind: 'deixa-eu', strength: 'strong', re: new RegExp(`\\bdeix[ae]\\s+(?:eu|me|comigo|que eu)\\b(?:\\s+(?:so|rapidinho|aqui|ai|mesmo|tentar))*\\s+(?:${DO_SEARCH}|${STRONG_V})\\b${MUNDANE}`) },
  { kind: 'deixa-eu', strength: 'medium', re: new RegExp(`\\bdeix[ae]\\s+(?:eu|me|comigo|que eu)\\b(?:\\s+(?:so|rapidinho|aqui|ai|mesmo|tentar))*\\s+${MEDIUM_V}\\b`) },
  { kind: 'deixa-eu', strength: 'weak', re: new RegExp(`\\bdeix[ae]\\s+(?:eu|me|comigo|que eu)\\b(?:\\s+(?:so|rapidinho|aqui|ai|mesmo|tentar))*\\s+${WEAK_V}\\b`) },
  // deixa que eu pesquiso / pode deixar que eu procuro / já pesquiso
  { kind: 'deixa-eu', strength: 'strong', re: /\b(?:deixa|deixe|pode deixar)\s+(?:comigo\s+)?que\s+eu\s+(?:te\s+)?(?:pesquiso|procuro|busco|consulto|investigo|pesquise|procure|busque)\b/ },
  // "Pode deixar, pesquiso isso pra você agora mesmo." (sem o "que eu")
  { kind: 'deixa-eu', strength: 'strong', re: /\b(?:pode deixar|deixa)[\s,!.…]+(?:eu\s+)?(?:te\s+)?(?:pesquiso|procuro|busco|consulto|investigo)\b/ },
  { kind: 'deixa-eu', strength: 'medium', re: /\b(?:deixa|deixe|pode deixar)\s+(?:comigo\s+)?que\s+eu\s+(?:te\s+)?(?:verifico|confiro|checo|verifique|confira|cheque)\b/ },
  { kind: 'deixa-eu', strength: 'weak', re: /\b(?:deixa|deixe|pode deixar)\s+(?:comigo\s+)?que\s+eu\s+(?:te\s+)?(?:olho|vejo|descubro|olhe|veja)\b/ },
  { kind: 'future-lookup', strength: 'strong', re: /\b(?:ja|logo|agora)\s+(?:eu\s+)?(?:te\s+)?(?:pesquiso|procuro|busco|consulto|investigo)\b/ },
  { kind: 'future-lookup', strength: 'medium', re: /\b(?:ja|logo|agora)\s+(?:eu\s+)?(?:te\s+)?(?:verifico|confiro|checo)\b/ },
  // espera aí / aguarde um instante / um momento, / já volto / já te respondo / me dá um minutinho
  // "Peraí que eu vou ver", "Segura aí, vou pesquisar": espera + promessa de agir. "Espera aí, isso não faz sentido" (reação) NÃO conta.
  { kind: 'wait', strength: 'weak', re: /\b(?:pera|espera|aguenta|segura|calma)\s*(?:ai|ae)?\s*(?:um pouco|um tiquinho|so um (?:momento|segundo|instante))?[\s,!.…]*(?:que\s+)?(?:eu\s+)?(?:vou|ja|so)\b/ },
  { kind: 'wait', strength: 'weak', re: /\baguard[ae]\b[^.!?\n]{0,30}\benquanto\s+(?:eu\s+)?(?:te\s+)?(?:pesquiso|procuro|busco|verifico|confiro|consulto|checo|vejo|olho|investigo)\b/ },
  { kind: 'wait', strength: 'weak', re: /\b(?:so\s+)?um\s+(?:momento|momentinho|segundo|segundinho|instante|instantinho|minuto|minutinho)\s+(?:que|enquanto)\s+(?:eu\s+)?(?:vou|ja|pesquiso|procuro|busco|verifico|checo|confiro|consulto)\b/ },
  { kind: 'wait', strength: 'weak', re: /(?:^|[.!?…:;,]\s*)(?:so\s+)?um\s+(?:momento|momentinho|segundo|segundinho|instante|instantinho|minuto|minutinho)\b(?=\s*(?:[,.!…;:]|$)|\s+(?:que|enquanto|ai|ae|pra|para|vou|ja|eu|e|so)\b)/ },
  { kind: 'wait', strength: 'weak', re: /\bja\s+volto\b(?!\s+a\s)|\bvolto\s+ja\b/ },
  { kind: 'wait', strength: 'weak', re: /\bme\s+d[aeo]\s+(?:um|uma|uns|umas)\s+(?:segundos?|minutos?|minutinhos?|momentos?|momentinhos?|instantes?|tempos?|tempinhos?)\b/ },
  { kind: 'wait', strength: 'weak', re: /\bd[aeo]\s+um\s+tempinho\b/ },
  // já te respondo / te trago a resposta / já te passo o resultado  (com dois-pontos é entrega IMEDIATA: não conta)
  { kind: 'deliver-later', strength: 'weak', re: /\b(?:ja|logo|em instantes|daqui a pouco)\s+(?:te\s+)?(?:respondo|falo|conto|digo|trago|passo|mostro|mando|entrego|aviso)\b(?!\s*[:\-—])/ },
  { kind: 'deliver-later', strength: 'weak', re: /\bte\s+(?:respondo|falo|conto|digo|trago|passo|aviso)\s+(?:ja|logo|em instantes|daqui a pouco|assim que)\b/ },
  { kind: 'deliver-later', strength: 'weak', re: /\bvolto\s+com\s+(?:a|o|as|os|uma|um|alguma|algo)\b/ },
  { kind: 'deliver-later', strength: 'weak', re: /\bte\s+(?:trago|passo|dou)\s+(?:o|a|as|os)\s+(?:resultado|resposta|respostas|informacoes|novidades|retorno)\b/ },
  // Pesquisando... / estou procurando / tô dando uma olhada  (narração de progresso)
  { kind: 'progress', strength: 'strong', re: /^\W*(?:pesquisando|buscando|procurando|consultando|investigando)\b[^.!?\n]{0,50}(?:\.{2,}|…|!|$)/m },
  { kind: 'progress', strength: 'medium', re: /^\W*(?:verificando|checando|conferindo)\b[^.!?\n]{0,50}(?:\.{2,}|…|!|$)/m },
  { kind: 'progress', strength: 'strong', re: /\b(?:estou|to|tou|esta)\s+(?:aqui\s+)?(?:so\s+)?(?:pesquisando|buscando|procurando|consultando|investigando)\b/ },
  { kind: 'progress', strength: 'medium', re: /\b(?:estou|to|tou)\s+(?:aqui\s+)?(?:so\s+)?(?:verificando|checando|conferindo)\b/ },
  { kind: 'progress', strength: 'weak', re: /\b(?:estou|to|tou)\s+dando\s+uma\s+(?:olhada|olhadinha|pesquisada|conferida|checada|lida)\b/ },
  { kind: 'progress', strength: 'weak', re: /\b(?:estou|to|tou)\s+(?:vendo|olhando|lendo)\s+(?:isso|essa|esse|aqui|ai|ja)\b/ },
  // oferta no lugar da ação: "Quer que eu pesquise?"  (só é falha quando o usuário JÁ pediu a pesquisa)
  { kind: 'offer', strength: 'strong', re: /\b(?:quer|queres|deseja|gostaria|prefere)\s+que\s+eu\s+(?:te\s+)?(?:pesquise|procure|busque|consulte|investigue|verifique|cheque|confira|de uma olhada|desse uma olhada|olhe|veja|tente\s+(?:pesquisar|procurar|buscar|achar|ver))\b/ },
  { kind: 'offer', strength: 'strong', re: /\bposso\s+(?:te\s+)?(?:pesquisar|procurar|buscar|consultar|verificar|checar|conferir|dar uma olhada)\b/ },
];

// Versão global de cada padrão, montada uma vez só (matchAll clona a expressão: o lastIndex do original não muda).
const PROMISE_RES = PROMISE_PATTERNS.map((p) => ({ ...p, re: new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`) }));

// negação que COLA no verbo ("não vou pesquisar", "nunca mais vou procurar"); "não sei de cabeça — vou pesquisar" continua sendo promessa
const NEGATION_BEFORE_RE = /\b(?:nao|nunca|jamais|sem|nem)\s+(?:(?:eu|vou|vai|te|lhe|me|so|mais|ja|mesmo|ir|de novo)\s+){0,2}$/;
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+|\n+/;

// Cláusulas: fim de frase, dois-pontos, ponto e vírgula, reticências, travessão e quebra de linha (regra de cauda).
const CLAUSE_SPLIT_RE = /(?<=[.!?…:;])\s+|\s+[—–-]\s+|\n+/;

/** Núcleo: acha frases de promessa e aplica a regra do "resto" (maxRemainder). Não olha a cauda. */
function coreDetect(text, { maxRemainder = 140 } = {}) {
  const none = { promise: false, kind: null, strength: null, match: null };
  const source = clipInput(text);
  // Link, lista ou bloco de código na resposta = ela ENTREGOU algo ("Já te mando o link do servidor: https://..."): não é promessa vazia.
  if (/https?:\/\/\S+|```|^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(source.replace(/^-#.*$/gm, ''))) return none;
  const folded = foldReply(source);
  if (!folded.trim()) return none;
  const sentences = folded.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  let best = null;
  const promiseSentences = new Set();
  const leadAt = new Map(); // frase -> onde começa a 1ª promessa dela (o que vem ANTES, na mesma frase, também é conteúdo)
  const rank = { strong: 3, medium: 2, weak: 1 };
  sentences.forEach((sentence, idx) => {
    for (const p of PROMISE_RES) {
      for (const m of sentence.matchAll(p.re)) {
        const before = sentence.slice(Math.max(0, m.index - 24), m.index);
        if (NEGATION_BEFORE_RE.test(before)) continue; // "não vou pesquisar", "sem pesquisar"
        promiseSentences.add(idx);
        if (!leadAt.has(idx) || m.index < leadAt.get(idx)) leadAt.set(idx, m.index);
        if (!best || rank[p.strength] > rank[best.strength]) best = { kind: p.kind, strength: p.strength, match: m[0].trim() };
      }
    }
  });
  if (!best) return none;
  const remainder = sentences.filter((_, i) => !promiseSentences.has(i)).join(' ');
  // conteúdo = as outras frases + o que antecede a promessa dentro da própria frase ("...de cabeça, vou pesquisar o valor atual e já te falo")
  const lead = [...leadAt].reduce((sum, [idx, at]) => sum + letterCount(sentences[idx].slice(0, at)), 0);
  if (letterCount(remainder) + lead > maxRemainder) return none; // tem conteúdo de verdade além da promessa
  return { promise: true, ...best };
}

/** Letras que vêm DEPOIS da última cláusula de promessa (0 se não houver cláusula de promessa isolada). */
function tailLettersAfterPromise(text) {
  const clean = clipInput(text).replace(/^-#.*$/gm, '').trim();
  const clauses = clean.split(CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  let last = -1;
  clauses.forEach((clause, i) => {
    if (coreDetect(clause.replace(/[:;]$/, '.'), { maxRemainder: Infinity }).promise) last = i;
  });
  return last < 0 ? 0 : letterCount(clauses.slice(last + 1).join(' '));
}

/**
 * A resposta é só uma promessa de fazer algo depois (sem entregar nada)?
 *  - `maxRemainder`: se, tirando as frases de promessa, sobrar texto com mais letras que isto, a resposta TEM conteúdo e não é só promessa.
 *  - `maxTail` (regra de cauda): se, DEPOIS da última frase de promessa, vier mais que este número de letras, a resposta entregou algo
 *    ("Deixa eu ver... acho que o Hytale ainda não tem data certa." NÃO é promessa; "Pesquisando... Um segundo!" é).
 * A entrada é cortada em MAX_DETECT_CHARS. Devolve { promise, kind, strength, match }.
 */
export function detectUnfulfilledPromise(text, { maxRemainder = 140, maxTail = MAX_PROMISE_TAIL } = {}) {
  const none = { promise: false, kind: null, strength: null, match: null };
  const base = coreDetect(text, { maxRemainder });
  if (!base.promise) return none;
  if (tailLettersAfterPromise(text) > maxTail) return none; // entregou conteúdo depois da promessa
  return base;
}

// ---------------------------------------------------------------------------------------------
// 2. PEDIDO DE PESQUISA (lado do usuário)
// ---------------------------------------------------------------------------------------------

const PREFIX = '(?:(?:yui|ei|oi|ola|e ai|ai|po|entao|bom|ok|beleza|mano|cara|pf|pfv|por favor|please|vamos|bora)\\b[\\s,!:.]*)*';
// imperativos que só podem ser pedido ("pesquise", "procure", "busque", "verifique"...)
const STRONG_IMPERATIVE = /\b(?:pesquise|pesquisem|procure|procurem|busque|busquem|consulte|consultem|verifique|verifiquem|confira|conferam|cheque|chequem|descubra|descubram|investigue|ache|encontre|googla|googlar|google isso)\b/;
// formas ambíguas (também são substantivo ou 3ª pessoa): só valem no começo da frase/cláusula
const NOUNISH_AFTER = '(?!\\s+(?:de|do|da|dos|das|em|com|publica|eleitoral|medica|escolar|academica|cientifica)\\b)';
const AMBIGUOUS_START = new RegExp(`^${PREFIX}(?:me\\s+|nos\\s+)?(?:(?:pesquisa|busca|consulta|procura|verifica)${NOUNISH_AFTER}|confere|checa|descobre|googla|(?:pesquisar|procurar|buscar|consultar|verificar|conferir|checar|descobrir)(?=\\s+(?:sobre|por|pra|para|na|no|nas|nos|informacoes?|noticias?|dados?|o|a|os|as|quem|qual|quais|quando|onde|como|quanto|que)\\b)${MUNDANE})\\b`);
const DAR_UM_GOOGLE = /\bd(?:a|e|ar)\s+um\s+(?:google|googlada|googlada rapida)\b|\b(?:joga|jogue|bota|manda|coloca)\s+(?:isso\s+|ai\s+)?(?:la\s+)?no\s+google\b/;
const TENTA = /\b(?:tenta|tente)\s+(?:ai\s+)?(?:achar|descobrir|encontrar|pesquisar|procurar|buscar|ver|saber)\b/;
const DAR_UMA = /\bd(?:a|e|ar|aria|ei)\s+uma\s+(?:pesquisad\w*|buscad\w*|procurad\w*|consultad\w*|googlad\w*)/;
const DAR_UMA_OLHADA = /\bd(?:a|e|ar|aria|ei)\s+uma\s+(?:olhad\w*|checad\w*|conferid\w*|verificad\w*|espiad\w*)\s*(?:ai|ae|rapid\w*)?\s*(?:se|no que|nas?|nos|em quanto|quando|quem|qual|quanto|onde|na internet|na web|no google)\b/;
const VE_SE = /(?:^|[,.!?]\s*|\be\s+)(?:ve|veja|olha|confere|checa|confira|cheque)\s+(?:ai\s+|ae\s+)?(?:(?:pra|para)\s+(?:mim|gente|nos)\s+)?(?:se\b|quanto\b|qual\b|quais\b|quando\b|quem\b|onde\b|o que\b|na internet|na web|no google)/;
const VE_NA_INTERNET = /\b(?:ve|veja|olha|acha|ache)\s+(?:ai\s+|la\s+)?(?:na|pela)\s+(?:internet|web|net)\b|(?:^|\s)google\s*:|\b(?:no|pelo)\s+google\b.{0,12}\b(?:ve|veja|procura|busca|pesquisa)\b/;
const FAZ_BUSCA = /\b(?:faz|faca|fazer|fazendo)\s+(?:uma\s+)?(?:rapida\s+|breve\s+)?(?:pesquisa|busca|consulta)\b/;
const POLITE = /\b(?:pode|poderia|consegue|conseguiria|da pra|tem como|quero que|queria que|preciso que|gostaria que)\s+(?:voce\s+|vc\s+|tu\s+|ce\s+)?(?:me\s+|nos\s+)?(?:pesquisar|procurar|buscar|consultar|verificar|checar|conferir|descobrir|achar|googlar)\s+\S/;
const CAPABILITY_Q = /^(?:\W*(?:yui|oi|ola|ei|e ai)\b)*[\s,!]*(?:voce|vc|tu|ce)?\s*(?:consegue|sabe|pode|tem como|da pra|sabe como)\s+(?:pesquisar|procurar|buscar|acessar a internet|usar o google|navegar|ver na internet)(?:\s+(?:(?:na|pela)\s+(?:internet|web|net)|no\s+google|online|algo|coisas?|pra\s+mim|para\s+mim|por\s+favor))*\s*\??\s*$/;
// Dado atual: um ASSUNTO que muda (notícia, lançamento, placar...) basta; só "hoje/agora/ontem" NÃO basta ("que dia é hoje?" não é pesquisa).
const FRESH_TOPIC = /\b(?:(?:preco|valor)\s+(?:atual|de hoje|hoje|agora)|atualmente|ultim[oa]s?|mais recente|recentes?|novidades?|noticias?|lancamento|lancou|lancaram|ja (?:saiu|sairam|lancou|lancaram|chegou|chegaram)|saiu|sai|vai sair|patch notes?|changelog|trailer|placar|resultado d[oa]|cotacao|promocao|black friday|ao vivo|previsao do tempo|data de lancamento|o que (?:rolou|aconteceu|houve|mudou)|20(?:2[5-9]|3\d))\b/;
const FRESH_TIME = /\b(?:hoje|agora|ontem|amanha|essa semana|esta semana|semana passada|esse mes|este mes|atual)\b/;
const FRESH_PRICE = /\b(?:quanto\s+(?:esta|ta|custa|vale|fica)|qual\s+(?:e\s+)?o\s+(?:preco|valor|horario|placar|resultado)|quem\s+ganhou|que\s+horas\s+(?:e|sera)\s+o\s+jogo)\b/;
const FRESH_MARK = { test: (n) => FRESH_TOPIC.test(n) || (FRESH_TIME.test(n) && FRESH_PRICE.test(n)) };
const QUESTIONISH_START = /^(?:qual|quais|quem|quando|onde|quanto|tem\b|ja\b|o que|oque|me diz|me fala|me conta|me da|me arruma|me traz|me mostra|me passa|ve se|confere se|checa se|tem alguma)/;
const QUESTIONISH = { test: (n) => /\?/.test(n) || QUESTIONISH_START.test(n.replace(new RegExp(`^${PREFIX}`), '')) || /\b(?:quero|queria|preciso|gostaria de|to querendo)\s+saber\b/.test(n) };
// "pesquisaaa", "kkkk": letra repetida 3+ vezes é alongamento (não existe em português) e vira uma só
const squeeze = (s) => String(s ?? '').replace(/(\p{L})\1{2,}/gu, '$1');
// pedido que tem ferramenta própria melhor que a pesquisa na web
const CURRENCY = /\b(dolar|dolares|euro|euros|libra|libras|bitcoin|btc|ethereum|eth)\b/;
const CURRENCY_ASK = /\b(?:cotacao|preco|valor|quanto|vale|custa|esta|ta|ta valendo|hoje|agora)\b/;
const CURRENCY_CODE = { dolar: 'USD', dolares: 'USD', euro: 'EUR', euros: 'EUR', libra: 'GBP', libras: 'GBP', bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', eth: 'ETH' };

const MENTION_RE = /<@[!&]?\d+>/g;

// Frases em que o verbo de pesquisa NÃO é um pedido à Yui (texto já dobrado: minúsculas e sem acento).
// "não pesquise", "nem precisa pesquisar", "sem pesquisar": até 3 palavras curtas entre a negação e o verbo (vírgula quebra: "não, pesquisa X" é pedido).
// "não esquece/deixa de pesquisar" é pedido; "sem" só nega COLADO ao verbo ("sem enrolar pesquisa o preço" é pedido).
const NEGATED = new RegExp('\\b(?:(?:nao|nunca|jamais|nem|evite|dispense|dispensa|pare de|para de)(?!\\s+(?:se\\s+)?(?:esquec|deix|falt)\\w*)(?:\\s+[a-z]{1,9}){0,3}'
  + '|sem(?:\\s+(?:ficar|precisar|usar|utilizar|o|a))*)\\s+(?:pesquis\\w*|procur\\w*|busc\\w*|googl\\w*)\\b');
// "como pesquisar no google?", "onde eu busco legendas?", "como faço uma pesquisa": pergunta SOBRE o ato de pesquisar. Até 4 palavras entre
// a interrogativa e o verbo, sem pontuação: "qual o preço do ps5 pesquisa aí" e "quando puder, pesquise X" são pedidos.
const HOWTO = new RegExp('\\b(?:como|onde|qual|quais|porque|por que|o que e)(?:\\s+[a-z0-9]{1,10}){0,4}\\s+'
  + '(?:(?:pesquisar|procurar|buscar|googlar|pesquiso|procuro|busco|pesquisam|procuram)|(?:uma|a|essa|esta|nessa)\\s+(?:pesquisa|busca))\\b');
// Quem FALA que vai/está pesquisando ("vou pesquisar isso depois", "tô procurando um jogo") não pede nada à Yui.
const STATEMENT = /\b(?:eu\s+)?(?:vou|vamos|irei|ja\s+vou|tenho\s+que|preciso|to|estou|acabei\s+de|ja)\s+(?:\w+\s+)?(?:pesquisar|procurar|buscar|googlar|pesquisando|procurando|buscando)\b/;

/**
 * O usuário pediu para pesquisar?
 *  - explicit: verbo de pesquisa ("pesquise", "procura pra mim", "dá uma pesquisada", "vê se já saiu", "faz uma busca"...)
 *  - fresh: pergunta de dado atual sem verbo ("qual a notícia de hoje?", "quando sai o patch?")
 *  - capability: pergunta SOBRE a capacidade ("você consegue pesquisar?"): não é um pedido
 *  - blocked: 'capability' | 'negated' | 'howto' | 'statement' quando o texto tem o verbo mas NÃO é pedido (explicit e wanted ficam false)
 *  - route: 'convert_currency' quando a ferramenta de cotação serve melhor que a web
 * A entrada é cortada em MAX_DETECT_CHARS.
 */
export function detectSearchRequest(text, { now = new Date() } = {}) {
  const raw = clipInput(text).replace(MENTION_RE, ' ');
  const n = collapse(foldKeepLength(squeeze(raw.replace(/https?:\/\/\S+/g, ' '))));
  const out = { wanted: false, explicit: false, fresh: false, capability: false, blocked: '', route: null, args: null, query: '', needsTopic: false };
  if (!n) return out;
  if (CAPABILITY_Q.test(n)) return { ...out, capability: true, blocked: 'capability' };
  if (NEGATED.test(n)) return { ...out, blocked: 'negated' };
  if (HOWTO.test(n)) return { ...out, blocked: 'howto' };
  if (STATEMENT.test(n)) return { ...out, blocked: 'statement' };

  const faz = FAZ_BUSCA.exec(n);
  const fazOk = faz && !/\b(?:vou|vai|vamos|van|quero|queria|pretendo|preciso|estou|to|tou|ja)\s+(?:\S+\s+){0,2}$/.test(n.slice(0, faz.index)) ;
  const explicit = STRONG_IMPERATIVE.test(n) || AMBIGUOUS_START.test(n) || DAR_UMA.test(n) || DAR_UMA_OLHADA.test(n) || DAR_UM_GOOGLE.test(n) || TENTA.test(n)
    || VE_SE.test(n) || VE_NA_INTERNET.test(n) || Boolean(fazOk) || POLITE.test(n);
  const fresh = !explicit && (FRESH_MARK.test(n) || (CURRENCY.test(n) && CURRENCY_ASK.test(n))) && QUESTIONISH.test(n);
  out.explicit = explicit;
  out.fresh = fresh;
  out.wanted = explicit || fresh;
  if (!out.wanted) return out;

  if (CURRENCY.test(n) && CURRENCY_ASK.test(n)) {
    const code = CURRENCY_CODE[n.match(CURRENCY)[1]];
    const amount = Number((n.match(/(\d+(?:[.,]\d+)?)\s*(?:dolar|dolares|euro|euros|libra|libras|bitcoin|btc|eth)/) ?? [])[1]?.replace(',', '.')) || 1;
    out.route = 'convert_currency';
    out.args = { amount, from: code, to: 'BRL' };
  }
  const query = buildSearchQuery(raw, { now });
  out.query = query;
  out.needsTopic = query === '';
  return out;
}

// ---------------------------------------------------------------------------------------------
// 3. CONSULTA
// ---------------------------------------------------------------------------------------------

// Trechos a remover da fala (aplicados sobre o texto dobrado; o recorte vale para o original porque o comprimento é igual).
const QUERY_STRIP = [
  new RegExp(`^${PREFIX}`),
  /\bd(?:a|e|ar|aria|ei)\s+uma\s+(?:pesquisad\w*|buscad\w*|procurad\w*|consultad\w*|olhad\w*|checad\w*|conferid\w*|verificad\w*|espiad\w*)\s*(?:ai|ae|rapid\w*)?/g,
  /\b(?:faz|faca|fazer)\s+(?:uma\s+)?(?:rapida\s+|breve\s+)?(?:pesquisa|busca|consulta)(?:\s+(?:rapida|breve|rapidinha))?\b/g,
  /\bme\s+ajuda\s+a\b/g,
  /\b(?:rapidinho|rapidinha|rapido|rapida|rapidamente)\b/g,
  /\b(?:quero|queria|preciso|gostaria)\s+que\s+(?:voce\s+|vc\s+|tu\s+)?/g,
  /\b(?:voce|vc|tu|ce)?\s*(?:pode|poderia|consegue|conseguiria|da pra|tem como)\s+(?:voce\s+|vc\s+)?(?:me\s+|nos\s+)?(?=(?:pesquisar|procurar|buscar|consultar|verificar|checar|conferir|descobrir|achar|googlar))/g,
  /\b(?:tenta|tente)\s+(?:ai\s+)?/,
  /\bd(?:a|e|ar)\s+um\s+(?:google|googlada)\b|\b(?:joga|jogue|bota|manda|coloca)\s+(?:isso\s+|ai\s+)?(?:la\s+)?no\s+google\b/,
  /\bme\s+(?:diz|fala|conta|mostra|passa|arruma|traz)\b/,
  /\b(?:quero|queria|preciso|gostaria de|to querendo)\s+saber\b/,
  /\bgoogle\s*:/,
  /\b(?:ve|veja|olha)\s+la\s+(?=na\b)/,
  // o verbo de pedido sai UMA vez (não apaga "busca"/"pesquisa" que façam parte do assunto)
  /\b(?:pesquise|pesquisem|pesquisar|pesquisa|procure|procurem|procurar|procura|busque|busquem|buscar|busca|consulte|consultar|consulta|verifique|verificar|verifica|confira|conferir|confere|cheque|checar|checa|descubra|descobrir|descobre|googla|googlar|investigue|ache|achar|acha|encontre|encontrar)\b/,
  /\b(?:ve|veja|olha)\s+(?:ai\s+)?(?:(?:pra|para)\s+(?:mim|gente|nos)\s+)?(?=se\b|na\b)/g,
  /\b(?:pra|para)\s+(?:mim|gente|nos)\b/g,
  /\b(?:por favor|pfv|pf|please)\b/g,
  /\b(?:ai|ae)\b/g,
  /\b(?:na|pela)\s+(?:internet|web|net)\b|\bno\s+google\b/g,
  /^\s*(?:me|nos)\b/,
];
const QUERY_LEADING_JUNK = /^[\s,.:;!?\-—]*(?:(?:sobre|a respeito de|acerca de|saber|de|do|da|dos|das|por|se|que|no|na|nos|nas|em|isso|essa|esse|ela|ele)\b[\s,.:;!?\-—]*)*/;

/** Consulta limpa para o buscador. Devolve '' quando só sobrou "isso/aí" (o assunto está na conversa, não na frase). */
export function buildSearchQuery(text, { now = new Date(), max = 200, withYear = true } = {}) {
  let orig = squeeze(clipInput(text).replace(MENTION_RE, ' ').replace(/https?:\/\/\S+/g, ' '));
  let folded = foldKeepLength(orig);
  const erase = (re) => {
    folded = folded.replace(re, (m, ...rest) => {
      const offset = rest.find((x) => typeof x === 'number');
      orig = orig.slice(0, offset) + ' '.repeat(m.length) + orig.slice(offset + m.length);
      return ' '.repeat(m.length);
    });
  };
  for (const re of QUERY_STRIP) erase(re);
  let q = collapse(orig);
  const f = collapse(foldKeepLength(q));
  const lead = QUERY_LEADING_JUNK.exec(f);
  if (lead && lead[0]) q = q.slice(lead[0].length);
  q = collapse(q.replace(/[\s,.:;!?\-—]+$/g, ''));
  if (!q || /^(?:isso|essa|esse|ela|ele|ai|ae|tambem|de novo)$/i.test(foldKeepLength(q))) return '';
  // dado que muda com o tempo: acrescenta o ano corrente (se a pessoa não escreveu um)
  const year = (now instanceof Date ? now : new Date(now)).getFullYear();
  if (withYear && /\b(?:hoje|agora|atual|atualmente|ultim\w+|recente\w*|noticia\w*|novidade\w*|lancamento|saiu|sai|vai sair|patch notes?|promocao|este ano|esse ano)\b/.test(foldKeepLength(q)) && !/\b20\d\d\b/.test(q)) {
    q = `${q} ${year}`;
  }
  if (q.length > max) q = q.slice(0, max).replace(/\s+\S*$/, '');
  return q;
}

// ---------------------------------------------------------------------------------------------
// 4. PALAVRAS-CHAVE E CONSULTA TIRADA DA PRÓPRIA PROMESSA
// ---------------------------------------------------------------------------------------------

const STOP = new Set(('para pra por com sem sob sobre entre ate uma uns umas dos das nos nas num numa que qual quais como quando onde quem quanto ' +
  'quantos quantas isso isto esse essa esses essas aquele aquela mais menos muito muita tambem ainda nao sim ser estar ter haver fazer fez foi sao ' +
  'era eram seu sua seus suas meu minha meus minhas voce voces yui pesquisa pesquise pesquisar procure procurar busque buscar google internet web net ' +
  'sabe sabia consegue capaz funciona vale bora vamos ' +
  'favor tipo coisa algo alguma algum pode poder quero queria preciso gostaria saber acerca respeito dele dela deles delas ele ela eles elas').split(' '));

const wordsOf = (s) => norm(s).match(/[a-z0-9]+/g) ?? [];

/** Palavras que carregam o assunto (sem acento, sem palavras vazias), na ordem em que aparecem. */
export function keywordsOf(text) {
  const seen = new Set();
  const out = [];
  for (const w of wordsOf(clipInput(text, 2000))) {
    if ((w.length <= 2 && !/^\d+$/.test(w)) || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Consulta aceitável para um buscador (rejeita vazio, URL, JSON, texto enorme). '' se não serve. */
export function saneQuery(query, max = 160) {
  const t = oneLine(String(query ?? '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/[{}<>]/g, ' '));
  if (t.length < 3 || /^https?:/i.test(t) || !/[\p{L}\p{N}]{2,}/u.test(t)) return '';
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') : t;
}

const PROMISE_VERB = '(?:pesquisar|buscar|procurar|consultar|verificar|checar|conferir|levantar|dar uma (?:pesquisada|procurada|olhada|buscada))';
const PROMISE_OBJ_RE = new RegExp(`\\b(?:ja\\s+)?(?:vou|irei|vamos)\\s+(?:ja\\s+|so\\s+|logo\\s+|te\\s+)*${PROMISE_VERB}\\s+(?:(?:sobre|por|a respeito de|acerca de|dados (?:sobre|de)|informacoes (?:sobre|de)|noticias (?:sobre|de))\\s+)?([^.!?\\n]{4,160})`);
const PROMISE_OBJ_TAIL = /\s+(?:pra|para)\s+(?:te|voce|vc|dar|ti|mim)\b.*$|\s+e\s+(?:ja\s+)?(?:te|volto|aviso|conto|respondo|falo)\b.*$|\s+(?:agora|ja|rapidinho|aqui)\b.*$/;
const DEICTIC = /^(?:isso|isto|aquilo|aqui|ai|la|tudo|cada um\b|eles?|elas?|esse|essa)\b/;

/**
 * Consulta tirada da PROMESSA do modelo ("Vou buscar dados de preços de financiamento no Rio de Janeiro pra te dar opções" ->
 * "preços de financiamento e manutenção no Rio de Janeiro"). '' quando o objeto é vago ("vou pesquisar isso") ou curto (menos de 3
 * palavras-chave). Só serve de consulta se tiver sobreposição com a fala do usuário (quem decide é recoveryPlan).
 */
export function queryFromPromise(promise) {
  const original = clipInput(promise);
  const t = foldKeepLength(original);
  const m = PROMISE_OBJ_RE.exec(t);
  if (!m) return '';
  const obj = m[1].replace(PROMISE_OBJ_TAIL, '').trim();
  if (!obj || DEICTIC.test(obj)) return '';
  const start = m.index + m[0].length - m[1].length;
  const orig = original.slice(start, start + obj.length).trim();
  return keywordsOf(orig).length >= 3 ? saneQuery(orig) : '';
}

// ---------------------------------------------------------------------------------------------
// 5. PRÉ-ROTA (Porta A): pedido de pesquisa na WEB inequívoco
// ---------------------------------------------------------------------------------------------

/** Quantas linhas não vazias. */
export function lineCount(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).length;
}

// Pedidos que têm ferramenta própria (download, imagem, steam, requisitos, tempo de campanha): o modelo e o despachante cuidam deles.
const PRE_OTHER_TOOL = /\b(?:baix\w+|download\w*|torrent\w*|crack\w*|mp3|mp4|imagens?|fotos?|desenh\w+|wallpaper|avatar|banner|steam|requisitos?|hltb|zerar|meu pc)\b/;
// Música, clipe, letra, álbum e jogo: search_and_download_music / check_game_info / check_steam são as ferramentas.
const PRE_MUSIC_GAME = /\b(?:musica|musicas|clipe|clipes|letra|letras|album|albuns|cifra|cifras|playlist)\b|\bnota\s+d[oae]s?\s+(?:jogo|game)\b|\bsobre\s+o\s+jogo\b/;
// Pedidos sobre a própria Yui ou o próprio usuário: não são pesquisa na web.
const PRE_OWN = /\bpesquis\w*\s+de\s+satisfacao\b|\bseus\s+dados\b|\bsobre\s+mim\b/;
// Marcador de web INEQUÍVOCO: pesquis*/googl* ou "na internet/web/net/google".
const PRE_WEB = /\b(?:pesquis\w*|googl\w*)\b|\b(?:na|pela|no)\s+(?:internet|web|net|google)\b/;
// "procura/busca/consulta" só valem com objeto de informação externa.
const PRE_AMBIG_VERB = /\b(?:procur\w+|busc\w+|busqu\w+|consult\w+)\b/;
const PRE_INFO = /\b(?:preco|valor|horario|noticias?|lancamento|data de|resultado|patch|significado|previsao|trailer|receitas?|melhor(?:es)?|quanto custa|quando sai|quem ganhou|o que e|quem e|informacoes|dados sobre|sobre)\b/;
// Objetos criativos/pessoais: "procura um nome legal pro servidor", "busca um tema", "consulta as regras do servidor".
const PRE_CREATIVE = /\b(?:nome|tema|ideia|jeito|forma|solucao|sinonimo|apelido|resposta|dentro de|regras do servidor)\b/;

/**
 * Pedido de pesquisa na web INEQUÍVOCO e ESTRITO? Se sim, o código pesquisa sem depender de o modelo escolher a ferramenta.
 * Não conta: voz, texto grande (mais de 600 caracteres ou 8 linhas), link no texto, negação, "como pesquisar", "vou pesquisar",
 * pergunta de capacidade, ferramenta própria (baixar, imagem, steam...), música/clipe/letra/álbum/jogo, cotação (convert_currency),
 * pedido que não é web ("ache um sinônimo", "confere se meu nome está certo"), "pesquisa isso" sem assunto.
 * Os verbos verifique/confira/cheque/descubra/ache/encontre NUNCA disparam sozinhos.
 *
 * Contexto que o CHAMADOR informa (o padrão é o lado seguro: não pré-rotear):
 *  - `text`: SÓ a fala do próprio autor (options.searchPrompt), nunca `searchPrompt || prompt`;
 *  - `direct`: a mensagem foi dirigida à Yui (menção, o nome dela, resposta a ela, DM, app ou comando). Conversa espontânea nunca;
 *  - `voice`, `radioMode`, `disableTools`, `thirdPartyPrompt` (/chat_resumo): nunca pesquisam.
 * @returns {{ explicit: boolean, reason: string, query?: string }}
 */
export function preRouteDecision(text, { voice = false, direct = false, radioMode = false, disableTools = false, thirdPartyPrompt = false, now = new Date() } = {}) {
  const raw = String(text ?? '');
  if (voice) return { explicit: false, reason: 'voice' };
  if (radioMode === true || disableTools === true || thirdPartyPrompt === true) return { explicit: false, reason: 'context' };
  if (direct !== true) return { explicit: false, reason: 'not_direct' };
  if (!raw.trim() || raw.length > MAX_PRE_CHARS || lineCount(raw) > MAX_PRE_LINES) return { explicit: false, reason: 'size' };
  if (/https?:\/\//i.test(raw)) return { explicit: false, reason: 'url' };
  const t = norm(raw);
  const req = detectSearchRequest(raw, { now });
  if (req.blocked) return { explicit: false, reason: req.blocked }; // capability | negated | howto | statement
  if (PRE_OTHER_TOOL.test(t)) return { explicit: false, reason: 'other_tool' };
  if (PRE_MUSIC_GAME.test(t)) return { explicit: false, reason: 'music_game' };
  if (PRE_OWN.test(t)) return { explicit: false, reason: 'own_object' };
  if (!req.explicit) return { explicit: false, reason: 'no_trigger' };
  if (req.route === 'convert_currency') return { explicit: false, reason: 'currency_tool' }; // tem ferramenta própria
  const web = PRE_WEB.test(t) || (PRE_AMBIG_VERB.test(t) && PRE_INFO.test(t) && !PRE_CREATIVE.test(t));
  if (!web) return { explicit: false, reason: 'not_web' };
  const query = req.query;
  if (!query || keywordsOf(query).length < 1) return { explicit: false, reason: 'no_subject' }; // "pesquisa isso": o contexto decide
  return { explicit: true, reason: 'trigger', query };
}

// ---------------------------------------------------------------------------------------------
// 6. O QUE FAZER COM UMA PROMESSA VAZIA (Porta C)
// ---------------------------------------------------------------------------------------------

/** O usuário espera uma resposta (pergunta, pedido de explicação ou de pesquisa)? Usar SÓ a fala do próprio autor (searchPrompt). */
export function userNeedsAnswer(userText) {
  const t = norm(clipInput(userText)).trim();
  return /\?/.test(t)
    || /^(?:yui[\s,]+)?(?:qual|quais|quem|quando|onde|quanto|como|o que|oque|por que|porque|me (?:diz|fala|conta|explica|ensina)|explica|explique|ensina)/.test(t)
    || detectSearchRequest(userText).wanted;
}

/**
 * Plano para uma resposta do modelo que só PROMETE pesquisar/voltar (Porta C).
 *
 * Contexto que o CHAMADOR precisa informar (o padrão é o lado seguro: não pesquisar):
 *  - `userText`: SÓ a fala do próprio autor (options.searchPrompt). Nunca `searchPrompt || prompt` (o prompt traz o bloco CONTEXTO
 *    com falas de outras pessoas);
 *  - `direct`: a mensagem foi dirigida à Yui (menção, o nome dela, resposta a ela, DM, app ou comando). Conversa espontânea
 *    (chatter) nunca pesquisa e nunca gasta a cota de quem só falou no canal: o melhor que se faz é pedir a resposta final;
 *  - `radioMode`, `disableTools`, `thirdPartyPrompt` (/chat_resumo): fluxos que nunca pesquisam (o plano é "none");
 *  - `voice`: por voz a Yui recusa com honestidade;
 *  - `sensitive`: conversa privada (DM, canal privado do dono, app). Com `privateSearch: true` (YUI_PRIVATE_SEARCH liberou este
 *    usuário) a pesquisa só acontece em pedido EXPLÍCITO e ESTRITO, com a consulta tirada SÓ do texto literal da mensagem
 *    (nunca da promessa do modelo, que pode ter lido histórico e memória); sem ele, recusa.
 *
 * @returns {{ action: 'none'|'search'|'route'|'refuse'|'ask'|'regenerate', query?, intent?, private?, tool?, args?, message?, reason }}
 */
export function recoveryPlan({
  reply, userText, sensitive = false, privateSearch = false, searchAvailable = true, voice = false, direct = false,
  radioMode = false, disableTools = false, thirdPartyPrompt = false, now = new Date(),
} = {}) {
  const p = detectUnfulfilledPromise(reply);
  if (!p.promise) return { action: 'none', reason: 'sem promessa' };
  if (radioMode === true || disableTools === true || thirdPartyPrompt === true) return { action: 'none', reason: 'contexto sem pesquisa' };
  const text = typeof userText === 'string' ? userText : '';
  const req = detectSearchRequest(text, { now });
  if (voice) {
    // Por voz a Yui não pesquisa. Só vale a recusa quando a pessoa pediu pesquisa ou a promessa é de pesquisar ("vou pesquisar..."); "um segundo, já
    // te respondo" a uma pergunta qualquer não é pedido de pesquisa e não pode virar "por voz eu não pesquiso" (pede-se a resposta final).
    const promisesSearch = (p.strength === 'strong' || p.strength === 'medium') && p.kind !== 'wait' && p.kind !== 'offer';
    if (req.wanted || promisesSearch) return { action: 'refuse', message: VOICE_REFUSAL, reason: 'voz' };
    return { action: 'regenerate', reason: 'voz: promessa sem pedido de pesquisa' };
  }
  if (p.kind === 'offer' && !req.explicit) return { action: 'none', reason: 'oferta sem pedido explícito' };
  // texto grande ou lista: não é UMA consulta ("pega o link de cada um destes 45 mods"); pesquisar só geraria lixo
  if (text.length > MAX_PRE_CHARS || lineCount(text) > MAX_PRE_LINES) return { action: 'regenerate', reason: 'pedido grande demais para uma consulta' };
  const modelSaysSearch = (p.strength === 'strong' || p.strength === 'medium') && p.kind !== 'wait' && p.kind !== 'offer';
  const promiseQuery = modelSaysSearch ? queryFromPromise(reply) : '';
  const userKw = new Set(keywordsOf(text));
  const overlap = promiseQuery ? keywordsOf(promiseQuery).filter((k) => userKw.has(k)).length : 0;
  const wants = req.wanted || (promiseQuery !== '' && overlap >= 1);
  if (!wants) {
    // "já volto kkk" solto, sem pedido nem pergunta do usuário: deixa passar; qualquer outra promessa pede a resposta final
    if (p.kind === 'wait' && p.strength === 'weak' && !userNeedsAnswer(text)) return { action: 'none', reason: 'espera solta sem pedido' };
    return { action: 'regenerate', reason: 'promessa sem pedido de pesquisa' };
  }
  if (direct !== true) return { action: 'regenerate', reason: 'sem chamada direta à Yui (conversa espontânea não pesquisa)' };
  if (sensitive === true && privateSearch !== true) return { action: 'refuse', message: SENSITIVE_SEARCH_REFUSAL, reason: 'conversa sensível' };
  if (!searchAvailable) return { action: 'refuse', message: SEARCH_DISABLED_REPLY, reason: 'ferramenta desligada' };
  if (req.route === 'convert_currency') return { action: 'route', tool: 'convert_currency', args: req.args, query: req.query, reason: 'cotação' };
  if (sensitive === true) {
    // pesquisa privada liberada: só pedido explícito e estrito, com a consulta tirada do texto literal desta mensagem
    const pre = preRouteDecision(text, { direct: true, now });
    if (!pre.explicit) return { action: 'regenerate', reason: 'privado: só pesquisa em pedido explícito' };
    return { action: 'search', query: pre.query, private: true, reason: 'pedido explícito (privado)' };
  }
  const query = (req.wanted && req.query) || promiseQuery || '';
  if (!query) return req.needsTopic ? { action: 'ask', message: NEED_TOPIC_REPLY, reason: 'sem assunto' } : { action: 'regenerate', reason: 'sem consulta aproveitável' };
  const fromPromise = !(req.wanted && req.query);
  return {
    action: 'search',
    query,
    private: false,
    ...(fromPromise ? { intent: clipInput(reply, 300) } : {}),
    reason: req.explicit ? 'pedido explícito' : req.wanted ? 'dado atual' : 'consulta tirada da promessa',
  };
}

/** Instrução para pedir uma resposta final ao modelo quando ele só prometeu (sem ferramentas). */
export function buildNoPromiseRetryPrompt(userText) {
  return `A mensagem do usuário foi: "${String(userText ?? '').replace(/"/g, "'").slice(0, 400)}"\nResponda AGORA, com o que você sabe, em poucas frases. Não diga que vai pesquisar, verificar ou voltar depois: você não consegue mandar nada depois. Se não souber, diga que não sabe.`;
}

// ---------------------------------------------------------------------------------------------
// 7. GUARDA FINAL (Porta D)
// ---------------------------------------------------------------------------------------------

/**
 * A guarda final trocaria esta resposta? Devolve { replace, reason, kind?, strength? } (só metadados: serve também ao modo "observe").
 *  - `hadAction`: alguma ferramenta além de generate_reply rodou de verdade nesta troca (search_web não faz `return`) ou o agente de
 *    pesquisa respondeu (researchHandled): o texto não é promessa vazia;
 *  - `userNeedsAnswer`: o autor fez pergunta ou pediu pesquisa (calcule com userNeedsAnswer(searchPrompt) só em chamada direta;
 *    em conversa espontânea passe false). Sem isso, "já volto kkk" solto passa.
 */
export function inspectFinalGuard(text, { hadAction = false, userNeedsAnswer: needs = false } = {}) {
  if (hadAction === true) return { replace: false, reason: 'houve ação' };
  const p = detectUnfulfilledPromise(text);
  if (!p.promise) {
    // A resposta TEM conteúdo, mas fecha com uma promessa de pesquisa ("...mas o preço muda. Vou pesquisar o valor atual e já te falo!"): o conteúdo
    // fica e só a frase que não vai se cumprir sai (trim). Não troca a resposta inteira. Só quando o autor perguntou ou pediu pesquisa (`userNeedsAnswer`):
    // num bate-papo solto "...agora vou procurar um servidor pra jogar kkk" é fala da personagem, não promessa de resposta.
    if (needs === true) {
      const tail = findTrailingPromise(text);
      if (tail.found) return { replace: false, trim: true, reason: 'promessa no fim da resposta', kind: tail.kind, strength: tail.strength };
    }
    return { replace: false, reason: 'sem promessa' };
  }
  if (p.kind === 'offer') return { replace: false, reason: 'oferta', kind: p.kind, strength: p.strength };
  if (p.kind === 'wait' && p.strength === 'weak' && needs !== true) return { replace: false, reason: 'espera solta', kind: p.kind, strength: p.strength };
  return { replace: true, reason: 'promessa vazia', kind: p.kind, strength: p.strength };
}

/**
 * Última guarda antes de enviar, com o que ela fez: { text, action: 'none' | 'replace' | 'trim', reason, kind?, strength? }.
 *  - replace: a resposta era SÓ promessa e virou PROMISE_ONLY_FALLBACK (rodapé "-# ..." mantido);
 *  - trim: a resposta tinha conteúdo e fechava com uma promessa de pesquisa: só essa frase saiu.
 */
export function finalGuardDetailed(text, opts = {}) {
  const original = String(text ?? '');
  const seen = inspectFinalGuard(original, opts);
  if (seen.replace) {
    const footer = original.slice(-400).match(/((?:\n-# [^\n]*)+)\s*$/)?.[1] ?? '';
    return { text: `${PROMISE_ONLY_FALLBACK}${footer}`, action: 'replace', reason: seen.reason, kind: seen.kind, strength: seen.strength };
  }
  if (seen.trim) {
    const trimmed = stripTrailingPromise(original);
    if (trimmed !== original && trimmed.trim()) return { text: trimmed, action: 'trim', reason: seen.reason, kind: seen.kind, strength: seen.strength };
  }
  return { text: original, action: 'none', reason: seen.reason };
}

/**
 * Última guarda antes de enviar: uma resposta que é SÓ promessa nunca vai ao usuário. Troca por PROMISE_ONLY_FALLBACK (que contém
 * "Desculpe, tive um erro", marcador de erro da IA para o histórico e o contexto), mantendo o rodapé "-# ...". Ofertas passam,
 * "já volto kkk" solto (sem pergunta do usuário) passa. Resposta com conteúdo que FECHA com promessa de pesquisa perde só essa frase.
 * Ver inspectFinalGuard e finalGuardDetailed.
 */
export function finalGuard(text, opts = {}) {
  return finalGuardDetailed(text, opts).text;
}

// ---------------------------------------------------------------------------------------------
// 8. PROMESSA QUE FECHA UMA RESPOSTA COM CONTEÚDO
// ---------------------------------------------------------------------------------------------

// Só promessa de PESQUISAR/consultar (não "espera aí" nem oferta). Verbo forte ("vou pesquisar") vale com ou sem pergunta depois; médio ("vou verificar") e
// fraco ("deixa eu dar uma olhada") só quando a promessa é a ÚLTIMA coisa da resposta: "Deixa eu verificar se entendi: você quer X?" é conversa.
const TRAILING_KINDS = new Set(['future-lookup', 'deixa-eu', 'progress']);
/** Depois da promessa, uma única pergunta de até este número de letras ainda conta ("Vou pesquisar isso. Qual é o seu orçamento?"). */
export const MAX_TRAILING_QUESTION = 90;
/** Promessa fraca no fim: a cláusula inteira tem de ser curta (até esta quantidade de palavras). */
const TRAILING_WEAK_WORDS = 12;
/** Antes da promessa, até este número de letras na mesma cláusula ainda é enchimento ("Um segundo que eu vou procurar"): sai junto. */
const TRAILING_LEAD_LETTERS = 25;
const CLAUSE_SPLIT_G = new RegExp(CLAUSE_SPLIT_RE.source, 'g');
const FOOTER_RE = /((?:\n-# [^\n]*)+)\s*$/;
const STRENGTH_RANK = { strong: 3, medium: 2, weak: 1 };

/**
 * Onde começa o 1º padrão de promessa de pesquisa não negado da cláusula, e com que força. `index` é no texto dobrado, que tem o MESMO
 * comprimento do original. null quando não há.
 */
function trailingPromiseSpan(clause) {
  const folded = foldKeepLength(clause);
  let found = null;
  for (const p of PROMISE_RES) {
    if (!TRAILING_KINDS.has(p.kind)) continue;
    for (const m of folded.matchAll(p.re)) {
      if (NEGATION_BEFORE_RE.test(folded.slice(Math.max(0, m.index - 24), m.index))) continue;
      if (!found || m.index < found.index || (m.index === found.index && STRENGTH_RANK[p.strength] > STRENGTH_RANK[found.strength])) found = { index: m.index, strength: p.strength };
    }
  }
  return found;
}

/**
 * A resposta termina com uma promessa de pesquisa (a última cláusula, ou uma cláusula seguida só de uma pergunta curta)? Olha o FIM da resposta
 * (os últimos MAX_DETECT_CHARS caracteres antes do rodapé "-# ..."), porque o conteúdo vem antes. A parte promessa-de-fato é a que será cortada.
 * @returns {{ found: false } | { found: true, from: number, to: number, kind: string, strength: string, bodyEnd: number }}
 *   `from`/`to`: trecho a remover no texto original; `bodyEnd`: fim do corpo (sem o rodapé).
 */
export function findTrailingPromise(text, { maxTail = MAX_PROMISE_TAIL, maxQuestion = MAX_TRAILING_QUESTION } = {}) {
  const none = { found: false };
  const full = String(text ?? '');
  const footer = full.slice(-400).match(FOOTER_RE)?.[0] ?? '';
  const body = footer ? full.slice(0, full.length - footer.length) : full;
  if (!body.trim()) return none;
  const base = Math.max(0, body.length - MAX_DETECT_CHARS);
  const region = body.slice(base);
  const clauses = [];
  let pos = 0;
  for (const m of region.matchAll(CLAUSE_SPLIT_G)) {
    if (m.index > pos) clauses.push({ start: pos, end: m.index });
    pos = m.index + m[0].length;
  }
  if (pos < region.length) clauses.push({ start: pos, end: region.length });
  for (let k = clauses.length - 1; k >= Math.max(0, clauses.length - 4); k--) {
    const c = clauses[k];
    const clause = region.slice(c.start, c.end);
    const span = trailingPromiseSpan(clause);
    if (!span) continue;
    const core = coreDetect(clause.replace(/[:;]$/, '.'), { maxRemainder: Infinity });
    if (!core.promise) return none; // a cláusula entrega algo (link, lista, bloco de código)
    const rest = region.slice(c.end);
    const restLetters = letterCount(rest);
    const endsWithQuestion = /\?\s*$/.test(rest.trim());
    // enchimento antes da promessa na mesma cláusula ("Um segundo que eu vou procurar") sai junto; conteúdo de verdade antes dela fica
    const lead = clause.slice(0, span.index);
    const from = base + c.start + (letterCount(lead) <= TRAILING_LEAD_LETTERS ? 0 : span.index);
    const result = (to) => ({ found: true, from, to, kind: core.kind, strength: core.strength, bodyEnd: body.length });
    if (restLetters <= maxTail) {
      // fraca só se a cláusula for curta (promessa isolada, sem conteúdo)
      if (span.strength === 'weak' && clause.trim().split(/\s+/).length > TRAILING_WEAK_WORDS) return none;
      return result(body.length);
    }
    if (endsWithQuestion && restLetters <= maxQuestion && span.strength === 'strong') return result(base + c.end);
    return none; // depois da promessa veio conteúdo de verdade
  }
  return none;
}

/** Tira da resposta a promessa de pesquisa que a fecha (ver findTrailingPromise); o conteúdo, a pergunta que vem depois e o rodapé ficam. */
export function stripTrailingPromise(text) {
  const full = String(text ?? '');
  const found = findTrailingPromise(full);
  if (!found.found) return full;
  const footer = full.slice(-400).match(FOOTER_RE)?.[0] ?? '';
  const body = full.slice(0, found.bodyEnd);
  let before = body.slice(0, found.from).replace(/[\s,;:–—-]+$/u, '').replace(/\s+(?:e|mas|porem|porém|entao|então|ai|aí|so que|só que)$/iu, '');
  const after = body.slice(found.to);
  if (/[\p{L}\p{N}]$/u.test(before)) before += '.'; // o corte foi no meio da frase ("...R$ 3.800, vou pesquisar..."): fecha a anterior
  const glue = before && after.trim() ? (/^\s*\n/.test(after) ? '\n\n' : ' ') : '';
  const out = `${before}${glue}${after.trim()}`.trim();
  if (!out) return full; // nada sobraria: quem decide é a guarda de "só promessa"
  return `${out}${footer}`;
}

// ---------------------------------------------------------------------------------------------
// 9. JSON DE FERRAMENTA CRU
// ---------------------------------------------------------------------------------------------

/** Acima disto a resposta nem é analisada por inteiro (só o começo): uma chamada de ferramenta escrita como texto é curta. */
export const MAX_TOOL_LEAK_SCAN = 12000;
const TOOL_LEAK_KEYS_RE = /"(?:tool|thought|args|arguments|reply|content|name|response|text|action|answer|resposta|mensagem|generate_reply)"\s*:/;
// As chaves que o despachante da fila reconhece num JSON de ferramenta/resposta. Um JSON de exemplo que o modelo escreveu de propósito ({"nome": "x", "idade": 3}) não é isto.
const TOOL_ENVELOPE_KEYS = new Set(['tool', 'thought', 'args', 'arguments', 'reply', 'content', 'name', 'response', 'text', 'action', 'action_input', 'answer', 'resposta', 'mensagem', 'generate_reply']);

/**
 * A resposta ainda é um JSON de ferramenta cru, vazio ou só a cerca de código (```)? Casos reais: {"tool":"search_game"} sem argumentos, {"reply":""}, {},
 * JSON de search_web cortado, "```" sozinho. Nunca vão ao usuário. Texto normal que só CITA "tool": ou "{" no meio NÃO conta: só vale se a resposta COMEÇA
 * assim. O rodapé "-# ..." não conta.
 */
export function isRawToolLeak(text) {
  const body = String(text ?? '').replace(/(?:^|\n)-# [^\n]*/g, '').trim();
  if (!body) return false;
  if (/^`{3,}[a-z_]{0,12}\s*`{0,3}$/i.test(body)) return true; // só a cerca ```json / ```tool_code
  if (/^tool_code\b/i.test(body)) return true;
  if (!body.startsWith('{')) return false;
  if (body.length > MAX_TOOL_LEAK_SCAN) return TOOL_LEAK_KEYS_RE.test(body.slice(0, 600));
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      return keys.length === 0 || keys.some((k) => TOOL_ENVELOPE_KEYS.has(k.toLowerCase())); // {} e {"reply":""} sim; {"nome":"x"} não
    }
    return false;
  } catch (_) { /* JSON cortado: olha as chaves */ }
  return TOOL_LEAK_KEYS_RE.test(body);
}
