/**
 * Lembretes por conversa natural (só o dono): "me lembra amanhã às 9h de pagar a conta", "meus lembretes",
 * "cancela o lembrete 3", "adia o lembrete 2 por 30 minutos", "resumo do dia".
 *
 *   parseReminderRequest(texto, agora) -> null | { action, ... }        (null = não é pedido de lembrete)
 *   runReminderRequest({ text, store, now, report }) -> null | string     (resposta pronta)
 *   routeReminders({ text, userId }, deps) -> { handled, text?, researched? }   (ponto de entrada igual ao das listas)
 *
 * Regras: só age quando a frase COMEÇA com um verbo de lembrete ("me lembra", "me avisa", "cria um lembrete", "lembrete:").
 * Conversa comum ("você lembra do Gabriel?") nunca é capturada. Sem horário, só pergunta "quando?" se o pedido é claro
 * ("me lembra de pagar a conta"). O horário vem do interpretador por regras (when.js), sem IA.
 */
import { createReminderStore, ReminderError, cleanReminderText } from './store.js';
import { parseWhen, normChars, describeWhen, describeRepeat } from './when.js';

const MAX_HEAD = 400;

// Jeitos educados de pedir, antes do verbo: "poderia me lembrar...", "você pode me lembrar...", "dá pra me lembrar...", "queria que você me lembrasse..."
const POLITE = '(?:(?:voce\\s+)?(?:poderia|podia|pode|consegue|conseguiria|daria)\\s+|da\\s+(?:pra|para)\\s+(?:voce\\s+)?|(?:queria|quero|gostaria|preciso)\\s+que\\s+(?:voce\\s+)?|por favor[, ]*)?';

const RE = {
  add: new RegExp(`^${POLITE}(?:me )?(?:lembra|lembre|lembrar|lembrasse|lembrares|avisa|avise|avisar|avisasse)(?:-me)?\\b(.*)$`),
  addNoun: new RegExp(`^${POLITE}(?:cria|crie|criar|agenda|agende|adiciona|adicione|programa|programe|coloca|coloque|poe|ponha|faz|faca|salva|salve|anota|anote)\\s+(?:um |uma |o |a )?(?:novo |nova )?lembrete\\b[:,]?(.*)$`),
  noun: /^lembrete\b[:,]?(.*)$/,
  list: /^(?:me )?(?:mostra|mostre|ve|ver|lista|liste|quais?(?: sao)?|manda|mande|envia|envie|cade|exibe|exiba)?\s*(?:os |todos os |meus )*lembretes?(?: (?:de |para |pra )?(hoje|amanha|pendentes|ativos|cadastrados|marcados))?\s*[?!.]*$/,
  hasAny: /^(?:eu )?(?:tenho|tem) (?:algum |algum outro )?lembrete(?:s)?(?: (?:de |para |pra )?(hoje|amanha))?\s*[?!.]*$/,
  agenda: /^(?:me )?(?:da|manda|mande|mostra|mostre|faz|faca|gera|gere|envia|envie)?\s*(?:o |um |a )?(?:resumo do dia|resumo da manha|relatorio (?:da manha|matinal|do dia)|agenda de hoje|agenda do dia|meu dia)\s*[?!.]*$/,
  agenda2: /^(?:o que|que)(?: eu)? tenho (?:pra|para) hoje\s*[?!.]*$/,
  cancelAll: /^(?:cancela|cancele|apaga|apague|remove|remova|exclui|exclua|deleta|delete|limpa|limpe|tira|tire)\s+(?:todos os |todos |tudo dos |tudo de |os )?(?:meus )?lembretes\s*[?!.]*$/,
  cancelNum: /^(?:cancela|cancele|apaga|apague|remove|remova|exclui|exclua|deleta|delete|tira|tire)\s+(?:o |a )?(?:meu )?lembrete\s*(?:numero |n[o.]? ?|#)?(\d{1,4})\s*[?!.]*$/,
  cancelText: /^(?:cancela|cancele|apaga|apague|remove|remova|exclui|exclua|deleta|delete|tira|tire)\s+(?:o |a )?(?:meu )?lembrete\s+(?:de |da |do |sobre |que )?(.+?)\s*[?!.]*$/,
  snooze: /^(?:adia|adie|empurra|empurre|posterga|postergue|remarca|remarque)\s+(?:o |a )?(?:meu )?lembrete\s*(?:numero |n[o.]? ?|#)?(\d{1,4})\s+(?:por |mais |em |para |pra |ate )?(.+?)\s*[?!.]*$/,
};

/** Tira a ligação do começo ("de pagar", "que tenho dentista", "para ligar") e a pontuação do fim. */
function cleanBody(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^[,:;\-–—\s]+/, '').replace(/^(?:por favor[, ]*)/i, '');
  t = t.replace(/^(?:de|do|da|dos|das|que|para|pra|a|ao|pro)\s+/i, '');
  t = t.replace(/\s+(?:por favor|pf|pfv)\s*[.!?]*$/i, '').replace(/[\s,;:.!?-]+$/, '');
  return cleanReminderText(t);
}

export function parseReminderRequest(raw, now = new Date()) {
  const original = String(raw ?? '').normalize('NFC').slice(0, MAX_HEAD * 4);
  const headOriginal = original.split(/\r?\n/)[0].slice(0, MAX_HEAD).replace(/^\s*@?yui[\s,:;!-]+/i, '').trim();
  const head = normChars(headOriginal).trim();
  if (!head) return null;
  let m;

  if (RE.agenda.test(head) || RE.agenda2.test(head)) return { action: 'agenda' };
  if (RE.cancelAll.test(head)) return { action: 'cancel', all: true };
  if ((m = RE.cancelNum.exec(head))) return { action: 'cancel', id: Number(m[1]) };
  if ((m = RE.snooze.exec(head))) {
    const idx = head.indexOf(m[2], m.index);
    let when = headOriginal.slice(idx, idx + m[2].length);
    if (/^\d|^(?:um|uma|meia|meio|dois|duas|tres)\b/i.test(normChars(when))) when = `em ${when}`; // "por 30 minutos" / "mais 1 hora"
    return { action: 'snooze', id: Number(m[1]), when };
  }
  if (RE.list.test(head) || RE.hasAny.test(head)) {
    const scope = (RE.list.exec(head) || RE.hasAny.exec(head))[1] || null;
    return { action: 'list', scope };
  }
  if ((m = RE.cancelText.exec(head)) && !/^\d+$/.test(m[1])) {
    const idx = head.indexOf(m[1], m.index);
    return { action: 'cancel', text: headOriginal.slice(idx, idx + m[1].length) };
  }

  // criar
  let trigger = null; let bodyHead = null;
  if ((m = RE.addNoun.exec(head))) { trigger = 'noun'; bodyHead = m[1]; }
  else if ((m = RE.noun.exec(head))) { trigger = 'noun'; bodyHead = m[1]; }
  else if ((m = RE.add.exec(head))) { trigger = 'verb'; bodyHead = m[1]; }
  if (trigger === null) return null;
  // Pergunta ("poderia me lembrar daqui 15 minutos de ir para casa?") só vira lembrete se achou um horário válido; sem isso
  // ("me lembra o que falamos ontem?") é conversa e segue para a IA.
  const isQuestion = /\?\s*$/.test(headOriginal);
  const start = head.length - bodyHead.length;
  const body = headOriginal.slice(start).trim();
  if (!body) return trigger === 'noun' ? { action: 'ask-text' } : null;

  const w = parseWhen(body, now);
  if (w.ok) {
    const text = cleanBody(w.text);
    if (!text) return { action: 'ask-text', at: w.at.toISOString(), repeat: w.repeat };
    return { action: 'add', text, at: w.at, repeat: w.repeat };
  }
  if (w.reason === 'sem-horario') {
    const nb = normChars(body);
    // sem horário: só pergunta "quando?" se o pedido é claro (começa com "de/para + verbo no infinitivo" ou é um "lembrete" de verdade)
    if (trigger === 'noun' || /^(?:de|para|pra)\s+\p{L}+r\b/u.test(nb)) return { action: 'ask-when', text: cleanBody(body) };
    return null;
  }
  if (isQuestion) return null; // pergunta sem horário utilizável ("o que falamos ontem?"): é conversa
  return { action: 'error', message: w.message };
}

function line(r, now) {
  const when = r.repeat ? `${describeRepeat(r.repeat)} (próximo: ${describeWhen(r.at, now)})` : describeWhen(r.at, now);
  return `**#${r.id}** · ${when} — ${r.text}`;
}

export function formatReminderList(items, now = new Date(), scope = null) {
  let list = items;
  if (scope === 'hoje' || scope === 'amanha') {
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    const from = scope === 'hoje' ? base : new Date(base.getTime() + 86400000);
    const to = new Date(from.getTime() + 86400000);
    list = items.filter((r) => { const t = Date.parse(r.at); return t >= (scope === 'hoje' ? 0 : from.getTime()) && t < to.getTime(); });
  }
  if (list.length === 0) return scope === 'hoje' ? 'Você não tem lembretes para hoje.' : scope === 'amanha' ? 'Você não tem lembretes para amanhã.' : 'Você não tem lembretes marcados.';
  const head = scope === 'hoje' ? 'Seus lembretes de hoje' : scope === 'amanha' ? 'Seus lembretes de amanhã' : 'Seus lembretes';
  return [`**${head}** (${list.length})`, ...list.slice(0, 30).map((r) => line(r, now)), ...(list.length > 30 ? [`… e mais ${list.length - 30}.`] : [])].join('\n');
}

export async function runReminderRequest({ text, store, now = new Date(), report = null }) {
  const req = parseReminderRequest(text, now);
  if (!req) return null;
  try {
    if (req.action === 'agenda') return report ? await report() : 'O resumo do dia não está disponível agora.';
    if (req.action === 'list') return formatReminderList(store.list(), now, req.scope);
    if (req.action === 'ask-when') return `Quando devo te lembrar${req.text ? ` de “${req.text}”` : ''}? Diga o horário, por exemplo: “me lembra amanhã às 9h ${req.text ? `de ${req.text}` : 'de pagar a conta'}” ou “daqui a 2 horas”.`;
    if (req.action === 'ask-text') return 'Do que devo te lembrar? Por exemplo: “me lembra amanhã às 9h de pagar a conta”.';
    if (req.action === 'error') return `Não consegui marcar: ${req.message}`;
    if (req.action === 'add') {
      const r = store.add({ text: req.text, at: req.at, repeat: req.repeat });
      const quando = r.repeat ? `${describeRepeat(r.repeat)} (a primeira, ${describeWhen(r.at, now)})` : describeWhen(r.at, now);
      return `Anotado! Vou te lembrar **${quando}**: ${r.text}\n-# Lembrete #${r.id}. Aviso por mensagem privada aqui no Discord. Para ver: “meus lembretes”.`;
    }
    if (req.action === 'cancel') {
      if (req.all) { const n = store.removeAll(); return n ? `Pronto, apaguei ${n} lembrete(s).` : 'Você não tem lembretes para apagar.'; }
      if (req.id !== undefined) {
        const r = store.get(req.id);
        if (!r) return `Não achei o lembrete #${req.id}. Diga “meus lembretes” para ver os números.`;
        store.remove(req.id);
        return `Cancelei o lembrete #${r.id}: ${r.text}`;
      }
      const found = store.findByText(req.text);
      if (found.length === 0) return `Não achei nenhum lembrete com “${req.text}”. Diga “meus lembretes” para ver a lista.`;
      if (found.length > 1) return [`Achei ${found.length} lembretes parecidos; diga o número do que quer cancelar:`, ...found.slice(0, 10).map((r) => line(r, now))].join('\n');
      store.remove(found[0].id);
      return `Cancelei o lembrete #${found[0].id}: ${found[0].text}`;
    }
    if (req.action === 'snooze') {
      const r = store.get(req.id);
      if (!r) return `Não achei o lembrete #${req.id}. Diga “meus lembretes” para ver os números.`;
      const w = parseWhen(req.when, now);
      if (!w.ok) return `Não entendi para quando adiar (${w.message}). Exemplos: “adia o lembrete ${r.id} por 30 minutos”, “adia o lembrete ${r.id} para amanhã às 9h”.`;
      const upd = store.reschedule(r.id, w.at);
      return `Adiado! O lembrete #${upd.id} (${upd.text}) vai avisar **${describeWhen(upd.at, now)}**.`;
    }
  } catch (err) {
    if (err instanceof ReminderError) return err.message;
    throw err;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ponto de entrada único para /yui, +yui e menção/DM (igual ao das listas).
// ---------------------------------------------------------------------------------------------
let sharedStore = null;
function defaultStore() {
  if (!sharedStore) sharedStore = createReminderStore(); // preguiçoso: nada acontece ao importar
  return sharedStore;
}

/** Instância única do armazenamento (a mesma do agendador e do painel). */
export function getReminderStore() { return defaultStore(); }

/**
 * Se a mensagem é um pedido de lembrete do DONO, executa e devolve { handled: true, text, researched: true }
 * (researched: true = a troca NÃO vai ao contexto/histórico). Senão { handled: false }. YUI_REMINDERS_ENABLED=false desliga.
 */
export async function routeReminders({ text, userId } = {}, { store = null, env = process.env, now = new Date(), report = null, isOwner = null } = {}) {
  if (String(env?.YUI_REMINDERS_ENABLED ?? 'true').trim().toLowerCase() === 'false') return { handled: false };
  if (!userId || !/^\d{5,25}$/.test(String(userId))) return { handled: false };
  const owner = isOwner ?? (await import('../core/permissions.js')).isOwnerId;
  if (!owner(String(userId))) return { handled: false };
  const reply = await runReminderRequest({ text, store: store || defaultStore(), now, report });
  return reply === null ? { handled: false } : { handled: true, text: reply, researched: true };
}

