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
 */

const ZWSP = '​';
const TOKEN_RE = /(?<![\p{L}\p{N}_<@\/.:-])@([\p{L}\p{N}_.-]{2,32})(?![\p{L}\p{N}_@])/gu;
const MIN_PREFIX = 4;

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
export async function resolveMentions(text, guild) {
  const safe = neutralizeMassMentions(text);
  if (!guild?.members) return safe;

  const segments = splitCode(safe);
  const tokens = new Set();
  for (const { part, code } of segments) {
    if (code) continue;
    for (const m of part.matchAll(TOKEN_RE)) tokens.add(m[1]);
  }
  if (tokens.size === 0) return safe;

  const resolved = new Map(); // token (minúsculo) -> id | null
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (resolved.has(key)) continue;

    let id = null;
    try {
      const cached = [...(guild.members.cache?.values?.() ?? [])];
      id = pickMember(token, cached);

      if (!id && typeof guild.members.search === 'function') {
        const found = await guild.members.search({ query: token, limit: 10 });
        id = pickMember(token, [...(found?.values?.() ?? found ?? [])]);
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
