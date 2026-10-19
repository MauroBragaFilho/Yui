/**
 * Listas por conversa natural: interpreta o pedido (pt-BR) e executa no listStore.
 *
 *   parseListRequest(texto)  -> null | { action, listName?, items?, position?, which?, done?, all? }
 *   runListRequest({ text, userId, store }) -> null | string   (resposta pronta; null = não é pedido de lista)
 *
 * Regras: só age quando a frase fala de "lista(s)" com um verbo de lista (anota, mostra, tira, apaga...);
 * conversa comum nunca é capturada. Só mexe nas listas do PRÓPRIO usuário. Entrada limitada (4000
 * caracteres; a 1ª linha, 300) e regex sem aninhamento (sem backtracking caro).
 */
import { ListError, LIST_LIMITS, cleanText, formatList } from './listStore.js';

const MAX_TEXT = 4000;
const MAX_HEAD = 300;

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const NAME = '(?:de |do |da |dos |das )?';
const MINHA = '(?:minha |nossa )?';

const RE = {
  lists: /^(?:me )?(?:mostra|mostre|ve|ver|quais?|liste|lista|exibe|exiba)?\s*(?:sao |tenho )?(?:as |todas as )?minhas listas\b/,
  exportAll: /\b(?:todas as )?minhas listas\b.*\bjson\b|\bjson\b.*\b(?:todas as )?minhas listas\b/,
  exportOne: new RegExp(`\\blista ${NAME}(.+?)(?: (?:em|como|no formato|em formato)(?: de)? json\\b.*|\\s*)$`),
  show: new RegExp(`^(?:me )?(?:mostra|mostre|ve|ver|exibe|exiba|le|leia|manda|mande|envia|envie|abre|abra)\\s+(?:a |o conteudo da |os itens da )?${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  show2: new RegExp(`^(?:o que|que itens?) (?:tem|ha|tenho) (?:na|em) ${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  delList: new RegExp(`^(?:apaga|apague|exclui|exclua|deleta|delete|remove|remova)\\s+(?:completamente |de vez )?(?:a )?${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  clear: new RegExp(`^(?:limpa|limpe|esvazia|esvazie)\\s+(?:a )?${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  removeNum: new RegExp(`^(?:tira|tire|remove|remova|apaga|apague|exclui|exclua)\\s+(?:o )?(?:item )?(?:n[uo]mero |n[o.]? ?)?(\\d{1,3})\\s+d[aeo]s? ${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  removeText: new RegExp(`^(?:tira|tire|remove|remova|apaga|apague|exclui|exclua)\\s+(?:o |a |os |as )?(.+?)\\s+d[aeo]s? ${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  done: new RegExp(`^(?:marca|marque|risca|risque|conclui|conclua)\\s+(?:o )?(?:item )?(\\d{1,3})\\s+(?:d[aeo]s? ${MINHA}lista ${NAME}(.+?)\\s+)?(?:como )?(feito|pronto|comprado|concluido|ok)\\b`),
  undone: new RegExp(`^(?:desmarca|desmarque|reabre|reabra)\\s+(?:o )?(?:item )?(\\d{1,3})\\s+d[aeo]s? ${MINHA}lista ${NAME}(.+?)\\s*[?!.]*$`),
  addB: new RegExp(`^(?:anota|anote|adiciona|adicione|coloca|coloque|poe|ponha|bota|salva|salve|guarda|guarde|inclui|inclua)\\s+(?:isso |ai |aqui )?(?:n[ao]|em|a|as?|para a|pra|no|para o|pro)\\s+${MINHA}lista ${NAME}([^:]{1,60}?)\\s*:\\s*(.*)$`),
  addA: new RegExp(`^(?:anota|anote|adiciona|adicione|coloca|coloque|poe|ponha|bota|salva|salve|guarda|guarde|inclui|inclua)\\s+(.+?)\\s+(?:n[ao]|em|a|as?|para a|pra|no|para o|pro)\\s+${MINHA}lista ${NAME}([^:]{1,60}?)\\s*[?!.]*$`),
};

function listName(raw) {
  const n = cleanText(String(raw ?? '').replace(/^["“'«]+|["”'»]+$/g, ''), LIST_LIMITS.maxNameChars);
  return n.replace(/\s+(?:por favor|pf|pfv|ai|ae)$/i, '').trim();
}

/** Itens: quebra de linha, vírgula ou ponto e vírgula; remove marcadores (-, *, •, "1.", "1)"). */
export function splitItems(blob) {
  return String(blob ?? '')
    .split(/[\n;,]+/)
    .map((s) => s.replace(/^\s*(?:[-*•–]|\d{1,3}[.)])\s*/, '').trim())
    .filter(Boolean);
}

export function parseListRequest(raw) {
  const original = String(raw ?? '').normalize('NFC').slice(0, MAX_TEXT);
  const lines = original.split(/\r?\n/);
  const headOriginal = lines[0].slice(0, MAX_HEAD).replace(/^\s*(?:@?yui)[\s,:;!-]+/i, '').trim();
  const rest = lines.slice(1).join('\n');
  const head = norm(headOriginal);
  if (!/\blistas?\b/.test(head)) return null;

  // nome/itens com a grafia original (acento e maiúscula) a partir do texto normalizado (mesmo tamanho)
  const at = (s) => { const i = head.indexOf(s); return i >= 0 && head.length === headOriginal.length ? headOriginal.slice(i, i + s.length) : s; };
  let m;
  if (/\bjson\b/.test(head)) {
    if (RE.exportAll.test(head)) return { action: 'export', all: true };
    m = head.match(RE.exportOne);
    if (m && /^(?:me )?(?:manda|mande|envia|envie|exporta|exporte|gera|gere|da|de|quero|mostra|mostre)\b/.test(head)) return { action: 'export', listName: listName(m[1]) };
  }
  if (RE.lists.test(head)) return { action: 'lists' };

  // adicionar (preserva o texto original dos itens, com acento e maiúsculas)
  if (/^(?:anota|anote|adiciona|adicione|coloca|coloque|salva|salve|guarda|guarde)\s+(?:n[ao]|em)\s+(?:minha )?lista\s*:?\s*$/.test(head)) {
    return { action: 'add', listName: '', items: splitItems(rest) };
  }
  m = head.match(RE.addB);
  if (m) {
    const colon = headOriginal.indexOf(':');
    const items = splitItems(`${colon >= 0 ? headOriginal.slice(colon + 1) : ''}\n${rest}`);
    return { action: 'add', listName: listName(at(m[1])), items };
  }
  m = head.match(RE.addA);
  if (m) {
    const nameIdx = head.lastIndexOf(m[2]);
    const nameText = nameIdx >= 0 && head.length === headOriginal.length ? headOriginal.slice(nameIdx, nameIdx + m[2].length) : m[2];
    return { action: 'add', listName: listName(nameText), items: splitItems(`${at(m[1])}\n${rest}`) };
  }

  m = head.match(RE.done);
  if (m) return { action: 'done', position: Number(m[1]), listName: listName(m[2] ?? ''), done: true };
  m = head.match(RE.undone);
  if (m) return { action: 'done', position: Number(m[1]), listName: listName(m[2]), done: false };
  m = head.match(RE.removeNum);
  if (m) return { action: 'remove', position: Number(m[1]), listName: listName(m[2]) };
  m = head.match(RE.clear);
  if (m) return { action: 'clear', listName: listName(m[1]) };
  m = head.match(RE.delList);
  if (m && !/\bitem\b/.test(head)) return { action: 'delete', listName: listName(m[1]) };
  m = head.match(RE.removeText);
  if (m) return { action: 'remove', which: cleanText(m[1], LIST_LIMITS.maxItemChars), listName: listName(m[2]) };
  m = head.match(RE.show) || head.match(RE.show2);
  if (m) return { action: 'show', listName: listName(m[1]) };
  return null;
}

const MSG = {
  noName: 'Qual é o nome da lista? Ex.: "anota na lista de compras: leite, pão".',
  noItems: 'O que eu anoto? Mande os itens separados por vírgula ou um por linha.',
};

function failMessage(err) {
  if (err instanceof ListError) return err.message;
  return 'Não consegui mexer na lista agora. Tente de novo daqui a pouco.';
}

/** Executa o pedido; devolve o texto da resposta ou null se a mensagem não é um pedido de lista. */
export async function runListRequest({ text, userId, store }) {
  const req = parseListRequest(text);
  if (!req) return null;
  try {
    switch (req.action) {
      case 'lists': {
        const all = await store.listLists(userId);
        if (!all.length) return 'Você ainda não tem listas. Diga, por exemplo: "anota na lista de compras: leite, pão".';
        return `Suas listas:\n${all.map((l) => `- **${String(l.name).replace(/@/g, '@​').replace(/[<>]/g, '')}** (${l.count} ${l.count === 1 ? 'item' : 'itens'})`).join('\n')}`;
      }
      case 'add': {
        if (!req.listName) return MSG.noName;
        if (!req.items.length) return MSG.noItems;
        const r = await store.addItems(userId, req.listName, req.items);
        if (!r.added && r.duplicated) return `Esses itens já estavam na lista **${r.name}**.`;
        const dup = r.duplicated ? ` (${r.duplicated} já existia${r.duplicated > 1 ? 'm' : ''})` : '';
        return `Anotei ${r.added} ${r.added === 1 ? 'item' : 'itens'} na lista **${r.name}**${dup}. Agora ela tem ${r.total}.`;
      }
      case 'show': {
        if (!req.listName) return MSG.noName;
        const list = await store.getList(userId, req.listName);
        return list ? formatList(list) : 'Não achei essa lista. Diga "minhas listas" para ver as que você tem.';
      }
      case 'remove': {
        if (!req.listName) return MSG.noName;
        const r = await store.removeItem(userId, req.listName, req.position ?? req.which);
        return `Tirei "${r.removed}" da lista **${r.name}** (sobraram ${r.total}).`;
      }
      case 'done': {
        if (!req.listName) return MSG.noName;
        const r = await store.setDone(userId, req.listName, req.position, req.done);
        return r.done ? `Marquei "${r.item}" como feito na lista **${r.name}**.` : `Desmarquei "${r.item}" na lista **${r.name}**.`;
      }
      case 'clear': {
        const r = await store.clearList(userId, req.listName);
        return `Esvaziei a lista **${r.name}** (${r.count} ${r.count === 1 ? 'item' : 'itens'}).`;
      }
      case 'delete': {
        const r = await store.deleteList(userId, req.listName);
        return `Apaguei a lista **${r.name}** (${r.count} ${r.count === 1 ? 'item' : 'itens'}).`;
      }
      case 'export': {
        const json = await store.exportJson(userId, req.all ? undefined : req.listName);
        return `Aqui está em JSON:\n\`\`\`json\n${json.replace(/```/g, "'''")}\n\`\`\``;
      }
      default:
        return null;
    }
  } catch (err) {
    return failMessage(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Porta L (listas): ponto de entrada único para /yui, +yui e menção/DM.
// ---------------------------------------------------------------------------------------------
import { createListStore } from './listStore.js';

let sharedStore = null;
function store() {
  if (!sharedStore) sharedStore = createListStore(); // preguiçoso: nada acontece ao importar
  return sharedStore;
}

/**
 * Se a mensagem é um pedido de lista, executa e devolve { handled: true, text, researched: true }
 * (researched: true = a troca NÃO vai ao contexto/histórico: o conteúdo da lista é dado pessoal).
 * Caso contrário { handled: false }. YUI_LISTS_ENABLED=false desliga. Exige userId (lista é por pessoa).
 */
export async function routeLists({ text, userId } = {}, { store: injected = null, env = process.env } = {}) {
  if (String(env?.YUI_LISTS_ENABLED ?? 'true').trim().toLowerCase() === 'false') return { handled: false };
  if (!userId || !/^\d{5,25}$/.test(String(userId))) return { handled: false };
  const reply = await runListRequest({ text, userId: String(userId), store: injected || store() });
  return reply === null ? { handled: false } : { handled: true, text: reply, researched: true };
}
