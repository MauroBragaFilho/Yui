/**
 * Resolução de menções nas respostas da IA.
 *
 * O modelo escreve "@coelha17" como texto puro. O Discord só marca de verdade
 * quando a mensagem contém `<@ID>`, e o modelo não conhece os IDs. Este módulo
 * converte `@nome` em `<@ID>` consultando os membros do servidor.
 *
 * Regras de segurança (evitam marcar a pessoa errada):
 *  - só casa nomes EXATOS (usuário, nome global, apelido ou nome de exibição),
 *    sem diferenciar maiúsculas; ou um prefixo ÚNICO com 4+ caracteres;
 *  - nome ambíguo ou desconhecido continua como texto;
 *  - ignora `<@ID>` já pronto, e-mails, URLs e trechos de código;
 *  - `@everyone` e `@here` são neutralizados (a IA nunca marca o servidor inteiro).
 *
 * Limites de custo (a resolução roda antes do envio, dentro da fila de respostas): no máximo 25 nomes
 * distintos por mensagem, 10 buscas na API do servidor e 3 s de rede no total; passou disso, o nome
 * continua como texto.
 */

const ZWSP = '​';
const TOKEN_RE = /(?<![\p{L}\p{N}_<@\/.:-])@([\p{L}\p{N}_.-]{2,32})(?![\p{L}\p{N}_@])/gu;
const MIN_PREFIX = 4;
const MAX_TOKENS = 25; // nomes distintos avaliados por mensagem
const MAX_SEARCHES = 10; // buscas de membro na API por mensagem
const SEARCH_BUDGET_MS = 3000; // tempo total (rede) gasto nessas buscas
const TIMED_OUT = Symbol('timed-out');

/** Espera a promessa por no máximo `ms`; passou do prazo devolve TIMED_OUT (a promessa solta não gera erro não tratado). */
function withinMs(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Quebra o texto em trechos de código (ignorados) e texto normal. */
function splitCode(text) {
  return String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => ({ part, code: i % 2 === 1 }));
}

/** Impede que a IA marque @everyone/@here (insere um caractere invisível). */
export function neutralizeMassMentions(text) {
  return String(text).replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`);
}

function namesOf(member) {
  const user = member.user || {};
  return [user.username, user.globalName, member.nickname, member.displayName]
    .filter(Boolean)
    .map((n) => String(n).toLowerCase());
}

/** Escolhe 1 membro para o token: exato; senão prefixo único. Retorna o id ou null. */
function pickMember(token, members) {
  const t = token.toLowerCase();
  const unique = (list) => {
    const ids = new Set(list.map((m) => m.id ?? m.user?.id));
    return ids.size === 1 ? [...ids][0] : null;
  };

  const exact = members.filter((m) => namesOf(m).includes(t));
  if (exact.length) return unique(exact);

  if (t.length >= MIN_PREFIX) {
    const prefix = members.filter((m) => namesOf(m).some((n) => n.startsWith(t)));
    if (prefix.length) return unique(prefix);
  }
  return null;
}

/**
 * Substitui `@nome` por `<@ID>`.
 *
 * @param {string} text   resposta da IA
 * @param {object|null} guild  Guild do discord.js (ou objeto com members.cache / members.search)
 * @returns {Promise<string>}
 */
export async function resolveMentions(text, guild, { maxTokens = MAX_TOKENS, maxSearches = MAX_SEARCHES, searchBudgetMs = SEARCH_BUDGET_MS } = {}) {
  const safe = neutralizeMassMentions(text);
  if (!guild?.members) return safe;

  const segments = splitCode(safe);
  // Nomes distintos (sem diferenciar maiúsculas), na ordem em que aparecem; só os `maxTokens` primeiros
  // são avaliados. Os demais continuam como texto (uma resposta com dezenas de @ não vira dezenas de consultas).
  const tokens = new Map(); // minúsculo -> token como escrito
  for (const { part, code } of segments) {
    if (code) continue;
    for (const m of part.matchAll(TOKEN_RE)) {
      const key = m[1].toLowerCase();
      if (!tokens.has(key)) tokens.set(key, m[1]);
      if (tokens.size >= maxTokens) break;
    }
    if (tokens.size >= maxTokens) break;
  }
  if (tokens.size === 0) return safe;

  let cached = [];
  try {
    cached = [...(guild.members.cache?.values?.() ?? [])]; // uma vez só, fora do laço
  } catch {
    cached = [];
  }

  const resolved = new Map(); // token (minúsculo) -> id | null
  const started = Date.now();
  let searches = 0;
  for (const [key, token] of tokens) {
    let id = null;
    try {
      id = pickMember(token, cached);

      // Busca na API do servidor: no máximo `maxSearches` por mensagem e dentro do tempo total
      // `searchBudgetMs`. Estourado o limite, o nome continua como texto. Cada busca corre contra o
      // tempo que sobrou (o timeout padrão do REST é bem maior e prenderia a fila de respostas).
      const left = searchBudgetMs - (Date.now() - started);
      if (!id && typeof guild.members.search === 'function' && searches < maxSearches && left > 0) {
        searches += 1;
        const found = await withinMs(guild.members.search({ query: token, limit: 10 }), left);
        if (found !== TIMED_OUT) id = pickMember(token, [...(found?.values?.() ?? found ?? [])]);
      }
    } catch {
      id = null; // falha de rede/permissão: mantém o texto
    }
    resolved.set(key, id);
  }

  return segments
    .map(({ part, code }) =>
      code
        ? part
        : part.replace(TOKEN_RE, (full, token) => {
            const id = resolved.get(token.toLowerCase());
            return id ? `<@${id}>` : full;
          })
    )
    .join('');
}

/** Só marcações de usuário podem notificar; cargos e @everyone/@here nunca. */
export const SAFE_ALLOWED_MENTIONS = Object.freeze({ parse: ['users'] });

/**
 * allowedMentions para uma mensagem do tipo "<@id> Tocando **título** - artista": só o PRIMEIRO usuário marcado (o autor do pedido, que o
 * texto sempre cita antes de qualquer dado externo) pode ser notificado. O resto do texto é eco de título, artista ou busca vindos de
 * sites externos e não pode marcar ninguém: nem @everyone, @here, cargo ou outro usuário. Sem marcação no texto, ninguém é notificado.
 */
export function mentionFirstUserOnly(content) {
  const m = /<@!?(\d{15,25})>/.exec(String(content ?? ''));
  return { parse: [], users: m ? [m[1]] : [] };
}
