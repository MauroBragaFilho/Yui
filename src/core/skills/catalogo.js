// Catálogo das skills e a escolha DETERMINÍSTICA de qual usar (etapa 14, item 4a). Funções puras: sem disco, sem rede, sem IA.
//
// A escolha é por pontuação de palavras entre a mensagem do dono e cada skill (nome e descrição), com tudo em minúsculas e sem acento:
//  - a mensagem vira palavras úteis (sem artigos, preposições e verbos genéricos; só com 3 letras ou mais; plural e terminações viram um radical);
//  - cada palavra da mensagem que aparece no NOME da skill vale 3 pontos; a que só aparece na DESCRIÇÃO vale 1 (cada palavra conta uma vez);
//  - uma skill só é escolhida com pelo menos 4 pontos (o limiar), e só vale mensagem curta (até 60 palavras): pedido comprido não é gatilho;
//  - empate: mais palavras no nome primeiro e, se ainda empatar, o nome em ordem alfabética (o resultado nunca depende da ordem da lista).
// Devolve NO MÁXIMO UMA skill ou nenhuma. Nunca chama IA para escolher.

/** Pontos mínimos para uma skill ser escolhida. */
export const LIMIAR_PADRAO = 4;
export const PESO_NOME = 3;
export const PESO_DESCRICAO = 1;
export const MAX_PALAVRAS_DA_MENSAGEM = 60;

const PARADAS = new Set((
  'a ao aos as o os um uma uns umas de do da dos das dum duma em no na nos nas num numa por pelo pela pelos pelas para pra pro com sem sob sobre entre ate ou e que se como quando onde '
  + 'qual quais quem quanto quantos me te lhe mim eu tu ele ela voce voces vc vcs meu minha meus minhas seu sua seus suas teu tua isso isto aquilo esse essa esses essas este esta estes estas '
  + 'aquele aquela ja mais menos muito muita tambem so favor pode podes poderia consegue quero queria preciso gostaria faz faca fazer fez dar ver ter tem ser estao hoje agora yui alice '
  + 'skill skills usa use usar usando ai oi ola ok aqui la tudo todo toda todos todas algo alguma algum'
).split(' '));

/** Minúsculas e sem acento (NFD sem as marcas). */
export function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** O radical de uma palavra já normalizada: tira o "s" do plural e corta para 5 letras as palavras de 6 ou mais (resumo/resumir, tarefa/tarefas). */
function radical(palavra) {
  let r = palavra;
  if (r.length > 3 && r.endsWith('s')) r = r.slice(0, -1);
  if (r.length >= 6) r = r.slice(0, 5);
  return r;
}

const palavrasBrutas = (texto) => normalizar(texto).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const util = (p) => p.length >= 3 && !PARADAS.has(p);

/** As palavras úteis (radicais, sem repetição) de um texto. */
export function palavrasUteis(texto) {
  return [...new Set(palavrasBrutas(String(texto ?? '').slice(0, 4000)).filter(util).map(radical))];
}

/**
 * Pontua cada skill contra a mensagem. Devolve só as que chegam ao limiar, da melhor para a pior:
 * [{ nome, skill, pontos, nomeHits, descHits }].
 */
export function pontuarSkills(texto, skills, { limiar = LIMIAR_PADRAO } = {}) {
  const brutas = palavrasBrutas(String(texto ?? '').slice(0, 4000));
  if (!brutas.length || brutas.length > MAX_PALAVRAS_DA_MENSAGEM) return [];
  const palavras = [...new Set(brutas.filter(util).map(radical))];
  if (!palavras.length) return [];
  const saida = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    const doNome = new Set(palavrasUteis(String(skill.nome ?? '').replace(/-/g, ' ')));
    const daDescricao = new Set(palavrasUteis(skill.descricao));
    let nomeHits = 0;
    let descHits = 0;
    for (const p of palavras) {
      if (doNome.has(p)) nomeHits += 1;
      else if (daDescricao.has(p)) descHits += 1;
    }
    const pontos = PESO_NOME * nomeHits + PESO_DESCRICAO * descHits;
    if (pontos >= limiar) saida.push({ nome: skill.nome, skill, pontos, nomeHits, descHits });
  }
  saida.sort((a, b) => b.pontos - a.pontos || b.nomeHits - a.nomeHits || (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
  return saida;
}

/** A skill escolhida para a mensagem: a de maior pontuação (com o empate resolvido de forma estável) ou null. */
export function escolherSkill(texto, skills, opcoes = {}) {
  return pontuarSkills(texto, skills, opcoes)[0]?.skill ?? null;
}

/** YUI_SKILLS_PERMITIDAS: a lista de nomes (separados por vírgula, espaço, `;` ou `|`). Vazia = todas as válidas (devolve null). */
export function nomesPermitidos(env = process.env) {
  const lista = String(env?.YUI_SKILLS_PERMITIDAS ?? '').split(/[\s,;|]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
  return lista.length ? new Set(lista) : null;
}

/** Só as skills permitidas pela configuração. */
export function filtrarPermitidas(skills, env = process.env) {
  const permitidos = nomesPermitidos(env);
  return permitidos ? skills.filter((s) => permitidos.has(s.nome)) : skills;
}

// ── "quais skills você tem?": reconhecido por código (sem IA) ──────────────────────────────────────────
// "skill" é palavra comum de jogo ("qual skill é melhor pro Jett?", "tem skill nova no patch?"): a mensagem INTEIRA precisa ser só sobre a lista de skills. Todas as
// palavras (menos o cumprimento e o "por favor") têm de ser do vocabulário de pedir a lista, tem de haver a palavra "skill" e uma palavra de pedir ou de ter. Qualquer
// outra palavra ("no Overwatch", "pro Jett", "nova", "patch") faz a mensagem ir para a IA, como qualquer conversa.
const PALAVRAS_DA_LISTA = new Set((
  'quais que qual lista liste listar mostra mostre mostrar exibe exiba diga fale fala diz me tem tens possui existem existe ha instalou instalaste instalei instalada instaladas '
  + 'instalado instalados disponivel disponiveis sao e as os a o suas seus tuas teus minhas meus de da do dos das voce vc tu yui skill skills alguma algumas algum oi ola ei opa por favor pfv pf ai'
).split(' '));
const GATILHOS_DA_LISTA = new Set((
  'quais que qual lista liste listar mostra mostre mostrar exibe exiba diga fale fala diz tem tens possui existem existe ha instalou instalaste instalei instalada instaladas instalado '
  + 'instalados disponivel disponiveis minhas meus suas seus tuas teus'
).split(' '));

/** A mensagem pede a lista das skills? Só a frase inteira, curta (até 9 palavras), feita só do vocabulário de pedir a lista. */
export function ehPedidoDeLista(texto) {
  const t = String(texto ?? '').replace(/<(?:@[!&]?|#)\d+>/g, ' ');
  if (!t.trim() || t.length > 120) return false;
  const palavras = normalizar(t).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (palavras.length < 2 || palavras.length > 9) return false;
  if (!palavras.some((p) => p === 'skill' || p === 'skills')) return false;
  if (!palavras.every((p) => PALAVRAS_DA_LISTA.has(p))) return false;
  return palavras.some((p) => GATILHOS_DA_LISTA.has(p));
}

const ROTULOS = {
  link_simbolico: 'link simbólico', fora_da_pasta: 'fora da pasta', sem_skill_md: 'sem SKILL.md', arquivo_grande: 'arquivo grande',
  ilegivel: 'ilegível', utf8_invalido: 'texto inválido', caractere_invalido: 'caractere inválido', frontmatter_ausente: 'sem cabeçalho',
  frontmatter_grande: 'cabeçalho grande', yaml_invalido: 'cabeçalho inválido', yaml_perigoso: 'cabeçalho perigoso', campo_desconhecido: 'campo desconhecido',
  nome_ausente: 'sem nome', nome_invalido: 'nome inválido', nome_diferente_da_pasta: 'nome diferente da pasta', descricao_ausente: 'sem descrição',
  descricao_invalida: 'descrição inválida', licenca_invalida: 'licença inválida', compatibilidade_invalida: 'compatibilidade inválida',
  metadata_invalido: 'metadata inválido', corpo_vazio: 'corpo vazio', corpo_grande: 'corpo grande', nome_duplicado: 'nome repetido',
  muitas_skills: 'skills demais', muitas_pastas: 'pastas demais',
};
export const rotuloDoMotivo = (motivo) => ROTULOS[motivo] ?? String(motivo);

// A descrição vem de um arquivo: nada nela vira menção no Discord.
const semMencao = (t) => String(t).replace(/@/g, '@\u200b');
const cortar = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** A resposta (sem IA) ao pedido da lista: os nomes e as descrições das skills válidas e, se houver, uma linha com as pastas ignoradas. */
export function textoDaLista(skills, avisos = []) {
  const linhas = [];
  if (!skills.length) linhas.push('Não tenho nenhuma skill instalada agora.');
  else {
    linhas.push(`Tenho ${skills.length} ${skills.length === 1 ? 'skill instalada' : 'skills instaladas'}:`);
    for (const s of skills) linhas.push(`- ${s.nome}: ${semMencao(cortar(s.descricao, 200))}`);
  }
  if (avisos.length) {
    const itens = avisos.slice(0, 5).map((a) => `${a.pasta} (${rotuloDoMotivo(a.motivo)})`).join(', ');
    linhas.push('', `Ignorei ${avisos.length} ${avisos.length === 1 ? 'pasta' : 'pastas'} com problema: ${itens}${avisos.length > 5 ? ', ...' : ''}.`);
  }
  return linhas.join('\n');
}
