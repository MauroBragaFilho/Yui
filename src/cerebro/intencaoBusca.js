// PESQUISA POR INTENÇÃO no chat (etapa 11, docs/RELATORIO_ETAPA11_CLIMA_E_INTENCAO.md). Determinístico: nenhuma IA, nenhuma rede, nenhum disco.
//
// O problema: no chat (menção, DM) só "pesquise ..." disparava pesquisa. "Quem ganhou o jogo do Flamengo ontem?", "já saiu o trailer do GTA 6?" ou "o
// Discord está fora do ar?" ficavam para o modelo, que prometia pesquisar e não pesquisava (ou, numa conversa privada, recebia a recusa de "só com pedido
// explícito"). Aqui o CÓDIGO decide: a pergunta pede um dado externo ATUAL e foi dirigida à Yui? Então o cérebro pesquisa antes de responder, pela mesma
// busca automática de sempre (`autoSearch` em conversa.js: cota, porta de saída, dono da cota, diário da retomada e falha fechada, sem nenhuma mudança).
//
// Duas peças:
//  - `detectarIntencaoDeBusca(texto)`: o detector. CONSERVADOR: conversa comum, opinião, código, pergunta sobre o próprio grupo, pedido de ferramenta
//    própria (baixar, imagem, música, Steam, câmbio, clima) e o pedido EXPLÍCITO e estrito ("pesquise ...", que já vai ao agente de pesquisa) NÃO disparam;
//  - `avaliarPesquisaPorIntencao(...)`: a política. Junta o detector com a chave YUI_PESQUISA_POR_INTENCAO (off | servidor | dono | todos; padrão dono), com a
//    chamada direta à Yui e, na conversa PRIVADA, com as travas de sempre. A ÚNICA conversa privada que ela alcança é a DM do PROPRIETÁRIO (revisão da Liz): só liga se
//    YUI_PRIVATE_SEARCH libera o dono e a consulta, tirada da própria mensagem, passa pela limpeza de dados pessoais (scrubQuery). A busca privada sai com `privado: true`
//    (nunca em cache, compartilhada nem reaproveitada). A DM de outras pessoas, os canais privados e as conversas sensíveis de terceiros ficam como antes. FALHA FECHADA:
//    conversa de classificação incerta, limpeza que lança ou que não prova que a consulta está limpa, qualquer erro = não pesquisa (o turno segue sem a web).
import { detectSearchRequest, preRouteDecision, buildSearchQuery, keywordsOf, foldKeepLength, clipInput } from '../core/ai/searchIntent.js';
import { scrubQuery, trimLiteralQuery, readResearchConfig } from '../core/ai/researchAgent.js';
import { privateSearchAllowed } from '../core/ai/llmSafety.js';
import { detectarPedidoDeClima } from '../core/tools/clima.js';

/** Os valores de YUI_PESQUISA_POR_INTENCAO. */
export const MODOS_DA_INTENCAO = Object.freeze(['off', 'servidor', 'dono', 'todos']);

/**
 * YUI_PESQUISA_POR_INTENCAO: `off` (nunca), `servidor` (só nos servidores), `dono` (servidores e a DM do proprietário; o PADRÃO) e `todos` (reservado: hoje vale o mesmo
 * que `dono`, a DM de outras pessoas não entra). Vazio = `dono`; valor desconhecido = `off` (na dúvida, não pesquisa).
 */
export function modoPesquisaPorIntencao(env = process.env) {
  const s = String(env?.YUI_PESQUISA_POR_INTENCAO ?? '').trim().toLowerCase();
  if (!s) return 'dono';
  return MODOS_DA_INTENCAO.includes(s) ? s : 'off';
}

const MAX_CHARS = 400;
const MENCAO_RE = /<(?:@[!&]?|#|a?:\w+:)\d+>/g;

// ── O que NUNCA dispara ──
const CAMBIO = /\b(?:dolar|dolares|euro|euros|libra|libras|bitcoin|btc|ethereum|eth|cambio|converte|converter|conversao)\b/;
const OUTRA_FERRAMENTA = /\b(?:baix\w+|download\w*|torrent\w*|crack\w*|mp3|mp4|imagens?|fotos?|desenh\w+|wallpaper|avatar|banner|steam|requisitos?|hltb|zerar|meu\s+pc|playlist|radio|letra|letras|cifra|cifras)\b/;
const TOCAR_MUSICA = /\b(?:toca|toque|tocar|bota|coloca|poe|ouvir|escutar)\b.*\b(?:musica|musicas|som|cancao|faixa|clipe)\b|\b(?:musica|musicas|som|cancao|faixa)\b.*\b(?:toca|toque|tocar)\b/;
const INFO_DE_JOGO = /\bnota\s+d[oae]s?\s+(?:jogo|game)\b|\bsobre\s+o\s+jogo\b/;
const PESSOAL = /\b(?:meu|minha|meus|minhas)\b/;
const DO_GRUPO = /\b(?:a\s+gente|nossa|nosso|nossas|nossos|na\s+call|na\s+sala|no\s+grupo|no\s+chat|no\s+canal|nesse\s+servidor|neste\s+servidor|aqui\s+no\s+(?:servidor|grupo|chat|canal))\b/;
const SEGUNDA_PESSOA = /\b(?:voce|voces|vc|vcs|tu|ce|seu|sua|seus|suas)\b/;
const CONTEXTO_DE_CONVERSA = /\b(?:servidor|canal|chat|grupo|call|discord|bot)\b/;

// ── Forma de pergunta ──
const PREFIXO = /^(?:(?:yui|ei|oi|ola|e\s+ai|ai|po|entao|bom|ok|beleza|mano|cara|pf|pfv|por\s+favor|please)\b[\s,!:.]*)*/;
const INTERROGATIVA = /^(?:qual|quais|quem|quando|onde|quanto|quantos|quantas|como|o\s+que|oque|que\s+horas|a\s+que\s+horas|tem|ja|sera|vai|me\s+(?:diz|fala|conta|da|passa|mostra)|saiu|foi|esta|ta|deu|houve|aconteceu|rolou|alguem\s+sabe|voce\s+sabe|vc\s+sabe|sabe\s+(?:me\s+)?(?:dizer|se|quem|quando|qual))\b/;
const QUERO_SABER = /\b(?:quero|queria|preciso|gostaria\s+de|to\s+querendo)\s+saber\b/;

// ── Entidades e assunto ──
const IGNORAR_MAIUSCULA = new Set(['yui', 'oi', 'ola', 'ei', 'hey', 'bom', 'boa', 'quem', 'qual', 'quais', 'quando', 'onde', 'quanto', 'quantos', 'como', 'o', 'a', 'me', 'sera', 'e', 'ah', 'po',
  'cara', 'mano', 'tipo', 'ok', 'sim', 'nao', 'ja', 'tem', 'vai', 'por', 'pf', 'pfv', 'que', 'se', 'eu', 'voce', 'vc']);
const PRODUTO = /\b(?:jogo|jogos|game|games|filme|filmes|serie|series|temporada|episodio|episodios|capitulo|album|single|musica|trailer|teaser|patch|update|atualizacao|dlc|expansao|versao|console|celular|iphone|galaxy|pixel|placa\s+de\s+video|gpu|cpu|processador|windows|linux|android|ios|aplicativo|app|livro|anime|manga|season|volume|edicao|enem|sisu|prouni|fies|vestibular|concurso|campeonato|copa|libertadores|brasileirao|champions|olimpiadas|eleicao|eleicoes)\b/;
const TOPICO = /\b(?:jogo|partida|campeonato|eleicao|eleicoes|governo|presidente|bolsa|ibovespa|selic|inflacao|petroleo|gasolina|diesel|ouro|noticia|noticias|serie|filme|show|banda|time|clube|selecao|guerra|ataque|acidente|greve|protesto|votacao|stf|congresso|camara|senado)\b/;
const SEQUEL = /\b[a-z]{2,}\s+\d{1,2}\b(?!\s*(?:minutos?|min|horas?|h|dias?|reais|real|anos?|vezes|%|por\s+cento|pessoas|jogadores|gols?|pontos?|km|metros|mil))/;
const SERVICO = /\b(?:discord|steam|youtube|twitch|instagram|whatsapp|telegram|twitter|facebook|google|gmail|netflix|spotify|playstation|psn|xbox|epic|riot|battle\s*\.?\s*net|github|openai|chatgpt|claude|pix|nubank|itau|bradesco|aws|cloudflare|reddit|tiktok|roblox|fortnite)\b/;
const GENERICAS = new Set(['noticia', 'noticias', 'novidade', 'novidades', 'manchete', 'manchetes', 'aconteceu', 'rolou', 'houve', 'mudou', 'hoje', 'ontem', 'agora', 'semana', 'ultimas', 'ultimo',
  'ultima', 'ultimos', 'recente', 'recentes', 'alguma', 'algum', 'sobre', 'quais', 'preco', 'valor', 'atual', 'atualmente', 'momento', 'saiu', 'sairam', 'lancamento', 'lancou', 'patch', 'update',
  'atualizacao', 'versao', 'jogo', 'jogos', 'game', 'filme', 'serie', 'episodio', 'temporada', 'album', 'musica', 'tem', 'estoque', 'disponivel', 'promocao', 'oferta', 'desconto', 'horario',
  'horas', 'proximo', 'proxima', 'transmissao', 'ganhou', 'venceu', 'perdeu', 'placar', 'resultado', 'ar', 'fora', 'caiu', 'online', 'offline', 'sai', 'saira', 'vai', 'dia']);

function temEntidade(raw, n) {
  const tokens = raw.split(/[\s,;:!?()"“”]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const f = foldKeepLength(t).replace(/[^a-z0-9]/g, '');
    if (IGNORAR_MAIUSCULA.has(f)) continue;
    const todasMaiusculas = /^[\p{Lu}\p{N}-]{2,}$/u.test(t) && /\p{Lu}{2,}/u.test(t);
    if (todasMaiusculas) return true;
    if (i > 0 && /^\p{Lu}[\p{L}\p{N}-]{1,}$/u.test(t)) return true;
    if (/\p{L}/u.test(t) && /\d/.test(t)) return true; // ps5, rtx4090, ios17
  }
  return SEQUEL.test(n);
}

const assuntoDe = (consulta) => keywordsOf(consulta).filter((w) => !GENERICAS.has(w) && !PRODUTO.test(w));

// ── Categorias (sobre o texto sem acento e em minúsculas) ──
const CATEGORIAS = [
  { nome: 'resultado_esportivo', res: [
    /\b(?:quem|qual\s+time|qual\s+selecao)\s+(?:ganhou|venceu|perdeu|levou|foi\s+o\s+campeao|e\s+o\s+campeao|foi\s+campeao|marcou|fez\s+o\s+gol)\b/,
    /\b(?:qual|quanto)\s+(?:foi|ficou|e|esta)\s+o\s+(?:placar|resultado)\b/,
    /\b(?:placar|resultado)\s+d[oae]s?\s+(?:jogo|partida|rodada|classico|final|campeonato|corrida|luta|etapa|gp|grande\s+premio|ontem|hoje)\b/,
    /\bcomo\s+(?:foi|ficou|terminou|acabou)\s+(?:o\s+|a\s+)?(?:jogo|partida|classico|final|luta|corrida|rodada)\b/,
    /\bquanto\s+(?:foi|ficou|terminou|acabou)\s+(?:o\s+)?(?:jogo|a\s+partida)\b/,
    /\b(?:ganhou|venceu|perdeu|empatou)\s+(?:o\s+|a\s+)?(?:jogo|partida|classico|final)\b/,
    /\b(?:classificacao|tabela)\s+d[oa]\s+(?:brasileirao|campeonato|libertadores|copa|serie\s+[ab]|premier\s+league|la\s+liga|champions)\b/,
  ], exigeAssunto: true }, // "quem ganhou?" sozinho não diz do quê: precisa de um nome (time, prêmio...)
  { nome: 'noticia', res: [/\b(?:noticias?|novidades?|manchetes?)\b/, /\bo\s+que\s+(?:rolou|aconteceu|houve|mudou)\s+(?:com|no|na|nos|nas|em)\b/], exigeAssunto: true },
  { nome: 'lancamento', res: [
    /\bja\s+(?:saiu|sairam|lancou|lancaram|chegou|chegaram|estreou|foi\s+lancad[oa])\b/,
    /\b(?:quando|que\s+dia)\s+(?:sai|saira|vai\s+sair|lanca|vai\s+lancar|lancam|chega|chegara|vai\s+chegar|estreia|vai\s+estrear|volta|vai\s+voltar|libera|liberam|vai\s+ser\s+lancad[oa])\b/,
    /\bdata\s+de\s+(?:lancamento|estreia|saida|chegada)\b/,
    /\b(?:foi|sera|vai\s+ser)\s+lancad[oa]\b/,
  ], exigeProduto: true },
  { nome: 'ultimo_recente', res: [
    /\b(?:ultim[oa]s?|mais\s+recentes?)\s+(?:\S+\s+){0,2}?(?:episodio|capitulo|temporada|filme|serie|jogo|game|album|musica|single|clipe|lancamento|versao|patch|atualizacao|update|video|noticia|post|live|campeonato|rodada|trailer|teaser|season|volume|anime|manga|edicao|resultado|ganhador|campeao)\b/,
    /\b(?:episodio|capitulo|temporada|filme|serie|jogo|album|single|clipe|versao|patch|atualizacao|update|video|trailer)\s+mais\s+(?:recente|novo|nova)\b/,
    /\bversao\s+(?:mais\s+)?(?:recente|nova|atual)\b|\bultima\s+versao\b/,
  ], exigeAssunto: true },
  { nome: 'preco_ou_estoque', res: [
    /\b(?:quanto\s+(?:esta|ta|custa|vale|fica|sai)|qual\s+(?:e\s+)?o\s+(?:preco|valor))\b[^?]*\b(?:hoje|agora|atualmente|no\s+momento|neste\s+momento|atual)\b/,
    /\b(?:preco|valor)\s+(?:atual|de\s+hoje|hoje|agora)\b/,
    /\b(?:esta|ta|estao|tao)\s+(?:disponivel|disponiveis|em\s+estoque|esgotad[oa]s?|a\s+venda|em\s+promocao|em\s+oferta|em\s+pre\s*-?venda)\b/,
    /\b(?:tem|ha)\s+\S+(?:\s+\S+){0,5}\s+(?:em\s+estoque|disponivel|a\s+venda)\b/,
    /\b(?:tem|ta\s+tendo|esta\s+tendo|rolando)\s+(?:alguma\s+)?(?:promocao|oferta|desconto)\b/,
  ], exigeAssunto: true },
  { nome: 'servico_no_ar', res: [
    /\b(?:esta|ta|estao|tao|ficou|continua|voltou)\s+(?:\S+\s+){0,3}?(?:fora\s+do\s+ar|no\s+ar|offline|caid[oa]s?|instavel|instaveis|com\s+(?:instabilidade|problemas?|erro))\b/,
    /\b(?:caiu|cairam|caindo)\b/,
    /\bfora\s+do\s+ar\b/,
  ], exigeServico: true },
  { nome: 'horario_de_evento', res: [
    /\b(?:que\s+horas|a\s+que\s+horas|qual\s+(?:e\s+)?o\s+horario|quando)\s+(?:\S+\s+){0,4}?(?:jogo|partida|final|semifinal|show|live|evento|lancamento|corrida|luta|transmissao|estreia|episodio|rodada|classico|gp|grande\s+premio|campeonato|copa|torneio|keynote|apresentacao|conferencia|direct|showcase)\b/,
    /\bhorario\s+d[oae]s?\s+(?:jogo|partida|final|show|live|evento|corrida|luta|transmissao|estreia|rodada)\b/,
    /\bproxim[oa]\s+(?:jogo|show|evento|lancamento|episodio|capitulo|gp|campeonato)\s+d[oae]\b/,
    /\bquando\s+(?:joga|jogam|vai\s+jogar)\b/,
    /\bonde\s+(?:vai\s+)?(?:passa|passar|assistir|transmite|transmitir)\s+(?:o\s+|a\s+)?(?:jogo|partida|final|luta|corrida|show|live|evento)\b/,
  ], exigeEvento: true },
  { nome: 'patch_ou_atualizacao', res: [/\b(?:patch|update|atualizacao|hotfix|manutencao|changelog)\s+(?:\S+\s+){0,2}?(?:d[oae]s?|n[oa]s?|para|pro|pra)\s+\S/, /\b(?:novo|nova)\s+(?:patch|update|atualizacao)\b/], exigeAssunto: true },
];
const TEMPO_DO_DADO = /\b(?:hoje|agora|ontem|essa\s+semana|esta\s+semana|semana\s+passada|neste\s+momento|no\s+momento|atualmente|recentemente|ultimamente|este\s+mes|esse\s+mes|este\s+ano|esse\s+ano)\b/;

/**
 * A fala pede um dado externo ATUAL (e NÃO é pedido explícito nem de outra ferramenta)? Só pelo conteúdo, só com a fala do próprio autor.
 * @returns {{ busca: boolean, motivo: string, categoria: string|null, consulta: string }}
 */
export function detectarIntencaoDeBusca(texto, { now = new Date() } = {}) {
  const nao = (motivo) => ({ busca: false, motivo, categoria: null, consulta: '' });
  const original = String(texto ?? '');
  if (!original.trim()) return nao('vazio');
  if (original.length > MAX_CHARS) return nao('longo');
  if (original.split(/\r?\n/).filter((l) => l.trim()).length > 3) return nao('multilinha');
  const raw = clipInput(original.normalize('NFC').replace(MENCAO_RE, ' ').replace(/\s+/g, ' ').trim());
  if (!raw) return nao('vazio');
  if (/^[/!$]\S/.test(raw)) return nao('comando');
  if (/```|`[^`]+`|=>|\bconsole\.|[{};].*[{};]/.test(raw)) return nao('codigo');
  if (/https?:\/\//i.test(raw)) return nao('link');
  const n = foldKeepLength(raw);
  const req = detectSearchRequest(raw, { now });
  if (req.blocked) return nao(`bloqueado_${req.blocked}`);
  if (req.route === 'convert_currency' || CAMBIO.test(n)) return nao('cotacao');
  if (detectarPedidoDeClima(raw).clima) return nao('clima');
  if (preRouteDecision(raw, { direct: true, now }).explicit) return nao('pedido_explicito'); // o agente de pesquisa já cuida
  if (OUTRA_FERRAMENTA.test(n) || TOCAR_MUSICA.test(n) || INFO_DE_JOGO.test(n)) return nao('ferramenta_propria');
  if (PESSOAL.test(n)) return nao('pessoal');
  if (DO_GRUPO.test(n)) return nao('do_grupo');
  const semPrefixo = n.replace(PREFIXO, '').trim();
  const pergunta = /\?/.test(raw) || INTERROGATIVA.test(semPrefixo) || QUERO_SABER.test(n) || /\bme\s+(?:diz|fala|conta|passa|mostra)\b/.test(n) || req.explicit;
  if (!pergunta) return nao('sem_pergunta');
  const consulta = buildSearchQuery(raw, { now });
  if (!consulta || keywordsOf(consulta).length < 1) return nao('sem_assunto');
  const entidade = temEntidade(raw, n);
  const assunto = assuntoDe(consulta);
  const segundaPessoa = SEGUNDA_PESSOA.test(n);
  const achou = (nome, ok = true) => (ok ? { busca: true, motivo: 'intencao_de_busca', categoria: nome, consulta } : null);

  for (const c of CATEGORIAS) {
    if (!c.res.some((re) => re.test(n))) continue;
    if (c.exigeServico && (segundaPessoa || !(SERVICO.test(n) || entidade))) continue;
    if (c.exigeProduto && !(entidade || (PRODUTO.test(n) && assunto.length >= 2))) continue;
    if (c.exigeEvento && !(entidade || /\b(?:jogo|partida|final|rodada|corrida|luta|gp|classico)\s+d[oae]s?\s+[a-z]{3,}/.test(n))) continue;
    if (c.exigeAssunto && !(entidade || assunto.length >= 1)) continue;
    if (c.nome === 'ultimo_recente' && segundaPessoa) continue;
    const r = achou(c.nome);
    if (r) return r;
  }
  // hoje/agora/ontem + pergunta de fato sobre algo do mundo (com um nome próprio ou um tópico), nunca sobre a Yui nem sobre o grupo
  if (TEMPO_DO_DADO.test(n) && INTERROGATIVA.test(semPrefixo) && !segundaPessoa && !CONTEXTO_DE_CONVERSA.test(n)
    && !/\bque\s+(?:dia|horas?|data)\b|\bquantos\s+dias\b|\bqual\s+(?:a\s+)?data\b/.test(n) && (entidade || (TOPICO.test(n) && assunto.length >= 1))) {
    return achou('tempo_e_fato');
  }
  return nao('sem_intencao');
}

/**
 * Onde está a conversa? Decidido SÓ pelos fatos que o cérebro remontou (papel, tipo de canal, escopo da memória e servidor), nunca pelo texto:
 *  - `servidor`: canal público de um servidor;
 *  - `dm_dono`: a DM do PROPRIETÁRIO (papel de dono, escopo pessoal, sem servidor): a ÚNICA conversa privada que a pesquisa por intenção alcança;
 *  - `dm_outro`: a DM de qualquer outra pessoa (fica exatamente como antes);
 *  - `canal_privado`: um canal privado de um servidor (inclusive o do dono; fica como antes);
 *  - `incerta`: faltou um fato, ou os fatos se contradizem (DM com servidor, dono em DM sem escopo pessoal, papel ou tipo desconhecido...). FALHA FECHADA.
 */
export function classificarConversa(contexto) {
  const c = contexto && typeof contexto === 'object' ? contexto : null;
  if (!c) return 'incerta';
  const { channelKind, role, memoryScope } = c;
  const guildId = c.guildId ?? null;
  if (!['OWNER', 'TRUSTED', 'MEMBER', 'GUEST', 'BLOCKED'].includes(role) || !['public', 'private', 'dm'].includes(channelKind) || !['personal', 'public'].includes(memoryScope)) return 'incerta';
  if (guildId !== null && !/^\d{5,25}$/.test(String(guildId))) return 'incerta';
  if (channelKind === 'public') return guildId ? 'servidor' : 'incerta';
  if (channelKind === 'dm') {
    if (guildId) return 'incerta';
    if (role === 'OWNER') return memoryScope === 'personal' ? 'dm_dono' : 'incerta';
    return memoryScope === 'public' ? 'dm_outro' : 'incerta';
  }
  return guildId ? 'canal_privado' : 'incerta';
}

/**
 * A política da pesquisa por intenção: decide se ESTE turno pesquisa antes de responder.
 *  - YUI_PESQUISA_POR_INTENCAO (off | servidor | dono | todos; padrão dono): servidor = só os servidores; dono = os servidores e a DM do proprietário. `todos` é
 *    reservado e hoje vale o mesmo que `dono`: a DM de outras pessoas e as conversas sensíveis de terceiros NÃO entram (ficam exatamente como antes);
 *  - só em chamada DIRIGIDA à Yui (nunca espontânea, voz nem log de terceiros);
 *  - a DM do PROPRIETÁRIO (a única conversa privada): além da chave, exige o agente de pesquisa ligado e YUI_PRIVATE_SEARCH liberando o dono, e a consulta (tirada da
 *    própria mensagem, só o pedido) passando pelo scrubQuery ANTES de sair. A busca vai com `privado: true`: sem cache, sem compartilhamento, sem reaproveitamento;
 *  - FALHA FECHADA: classificação incerta da conversa, limpeza que lança ou que não prova que a consulta está limpa, qualquer erro: NÃO pesquisa (o turno segue sem a web).
 * @param {{ texto?: string, chamadaDireta?: boolean, contexto?: { channelKind?: string, guildId?: string|null, role?: string, memoryScope?: string }|null, env?: object,
 *           forbiddenKeywords?: string[]|null, now?: Date, scrub?: Function }} p  `scrub`: a limpeza (padrão: o scrubQuery); injetável só para teste
 * @returns {{ buscar: boolean, privado: boolean, motivo: string, categoria: string|null, consultaPrivada: string|null }}
 */
export function avaliarPesquisaPorIntencao({ texto, chamadaDireta = false, contexto = null, env = process.env, forbiddenKeywords = null, now = new Date(), scrub = scrubQuery } = {}) {
  const nao = (motivo, categoria = null) => ({ buscar: false, privado: false, motivo, categoria, consultaPrivada: null });
  try {
    if (!String(texto ?? '').trim()) return nao('vazio');
    if (chamadaDireta !== true) return nao('nao_direta');
    const modo = modoPesquisaPorIntencao(env);
    if (modo === 'off') return nao('chave_off');
    const onde = classificarConversa(contexto);
    if (onde === 'incerta') return nao('classificacao_incerta');
    if (onde === 'canal_privado') return nao('canal_privado_como_antes');
    if (onde === 'dm_outro') return nao('dm_de_outra_pessoa_como_antes');
    if (onde === 'dm_dono') {
      if (modo === 'servidor') return nao('chave_so_servidor');
      const cfg = readResearchConfig(env);
      if (!cfg.enabled) return nao('pesquisa_desligada');
      if (!privateSearchAllowed(cfg.privateSearch, { isOwner: true })) return nao('privada_nao_liberada');
    }
    const d = detectarIntencaoDeBusca(texto, { now });
    if (!d.busca) return nao(d.motivo);
    if (onde === 'servidor') return { buscar: true, privado: false, motivo: d.motivo, categoria: d.categoria, consultaPrivada: null };
    // DM do proprietário: só o pedido (sem a justificativa pessoal) e só se a limpeza PROVAR que a consulta está limpa
    let limpa;
    try { limpa = scrub(trimLiteralQuery(d.consulta), { forbiddenKeywords, max: 200 }); } catch { return nao('limpeza_falhou', d.categoria); }
    if (!limpa || limpa.ok !== true || typeof limpa.query !== 'string' || !limpa.query.trim()) return nao('consulta_barrada', d.categoria);
    return { buscar: true, privado: true, motivo: d.motivo, categoria: d.categoria, consultaPrivada: limpa.query };
  } catch {
    return nao('erro_fechado');
  }
}
