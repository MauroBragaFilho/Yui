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
  if (trigger === null) {
    // "Yui, pelamor do mundo tecnológico me lembre de abrir arknights daqui 5 minutos": até 60 caracteres de enrolação antes do
    // "me lembra/me avisa". Só vale se acha um horário (action 'add'); sem horário continua sendo conversa comum.
    const loose = /^(.{1,60}?\s)(me (?:lembra|lembre|lembrar|lembrasse|avisa|avise|avisar)\b.*)$/.exec(head);
    if (loose && !loose[1].includes('?')) {
      const sub = parseReminderRequest(headOriginal.slice(loose[1].length), now);
      if (sub?.action === 'add') return sub;
    }
    return null;
  }
  // Pergunta ("poderia me lembrar daqui 15 minutos de ir para casa?") só vira lembrete se achou um horário válido; sem isso
  // ("me lembra o que falamos ontem?") é conversa e segue para a IA.
  const isQuestion = /\?\s*$/.test(headOriginal);
  const start = head.length - bodyHead.length;
  const rawBody = headOriginal.slice(start).trim();
  // "lembra o <@id> de ir jogar daqui 2 minutos": o lembrete é para OUTRA pessoa (só o dono pode; quem decide é o runReminderRequest).
  const tm = /^(?:o |a )?<@!?(\d{5,25})>[\s,:;-]*([\s\S]*)$/.exec(rawBody);
  const target = tm ? tm[1] : null;
  const body = (tm ? tm[2] : rawBody).trim();
  const T = (o) => (target ? { ...o, target } : o);
  if (!body) return trigger === 'noun' ? { action: 'ask-text' } : (target ? { action: 'ask-text', target } : null);

  const w = parseWhen(body, now);
  if (w.ok) {
    const text = cleanBody(w.text);
    if (!text) return T({ action: 'ask-text', at: w.at.toISOString(), repeat: w.repeat });
    return T({ action: 'add', text, at: w.at, repeat: w.repeat });
  }
  if (w.reason === 'sem-horario') {
    const nb = normChars(body);
    // sem horário: só pergunta "quando?" se o pedido é claro (começa com "de/para + verbo no infinitivo" ou é um "lembrete" de verdade)
    if (trigger === 'noun' || /^(?:de|para|pra)\s+\p{L}+r\b/u.test(nb)) return T({ action: 'ask-when', text: cleanBody(body) });
    return null;
  }
  if (isQuestion) return null; // pergunta sem horário utilizável ("o que falamos ontem?"): é conversa
  return { action: 'error', message: w.message };
}

function line(r, now) {
  const when = r.repeat ? `${describeRepeat(r.repeat)} (próximo: ${describeWhen(r.at, now)})` : describeWhen(r.at, now);
  return `**#${r.id}** · ${when} — ${r.fromOwner && r.userId ? `(para <@${r.userId}>) ` : ''}${r.text}`;
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

export async function runReminderRequest({ text, store, now = new Date(), report = null, isOwner = true, isOwnerId = () => false }) {
  const req = parseReminderRequest(text, now);
  if (!req) return null;
  if (req.action === 'agenda' && !isOwner) return null; // o resumo do dia é do dono
  try {
    if (req.action === 'agenda') return report ? await report() : 'O resumo do dia não está disponível agora.';
    if (req.action === 'list') return formatReminderList(store.list(), now, req.scope);
    if (req.target && req.action !== 'add') {
      if (!isOwner) return 'Eu só crio lembrete para você mesmo. Para você: “me lembra daqui 10 minutos de ...”.';
      return `Para lembrar <@${req.target}> preciso do horário e do assunto. Exemplo: “lembra o <@${req.target}> amanhã às 9h de ...”.`;
    }
    if (req.action === 'ask-when') return `Quando devo te lembrar${req.text ? ` de “${req.text}”` : ''}? Diga o horário, por exemplo: “me lembra amanhã às 9h ${req.text ? `de ${req.text}` : 'de pagar a conta'}” ou “daqui a 2 horas”.`;
    if (req.action === 'ask-text') return 'Do que devo te lembrar? Por exemplo: “me lembra amanhã às 9h de pagar a conta”.';
    if (req.action === 'error') return `Não consegui marcar: ${req.message}`;
    if (req.action === 'add' && req.target && !isOwnerId(req.target)) {
      if (!isOwner) return 'Eu só crio lembrete para você mesmo (quem me pede). Para você: “me lembra daqui 10 minutos de ...”.';
      if (typeof store.addFor !== 'function') return 'Não consegui criar o lembrete para essa pessoa agora.';
      const r = store.addFor(req.target, { text: req.text, at: req.at, repeat: req.repeat });
      const quando = r.repeat ? `${describeRepeat(r.repeat)} (a primeira, ${describeWhen(r.at, now)})` : describeWhen(r.at, now);
      return `Anotado! Vou lembrar <@${req.target}> **${quando}**: ${r.text}\n-# Lembrete #${r.id} (o aviso vai por mensagem privada para ela, dizendo que foi você quem pediu). Para ver tudo: “meus lembretes”. Para cancelar: “cancela o lembrete ${r.id}”.`;
    }
    if (req.action === 'add') {
      const r = store.add({ text: req.text, at: req.at, repeat: req.repeat });
      if (!isOwner) return `Anotado! Vou te lembrar **${r.repeat ? `${describeRepeat(r.repeat)} (a primeira, ${describeWhen(r.at, now)})` : describeWhen(r.at, now)}**: ${r.text}\n-# Lembrete #${r.id}. O aviso vai por mensagem privada: deixe suas DMs abertas para mim. Para ver: “meus lembretes”.`;
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
 * Visão de um usuário sobre o armazenamento: cada pessoa vê e mexe só nos PRÓPRIOS lembretes. O dono (`ownerView`) é a pessoa
 * de `userId: null` (os de antes) e novos lembretes dele continuam com userId null.
 */
export function scopedReminderStore(store, userId, ownerView, authorName = '') {
  const uid = ownerView ? null : String(userId);
  const mine = (r) => r && (ownerView ? (!r.userId || r.fromOwner === true) : r.userId === uid);
  return {
    // só o dono: lembrete para OUTRA pessoa (o aviso vai para ela, com "pedido por <nome>"); o dono continua podendo ver e cancelar
    addFor: ownerView ? (targetId, data) => store.add({ ...data, userId: String(targetId), from: authorName || 'o dono', fromOwner: true }) : null,
    list: () => store.list().filter(mine),
    get: (id) => { const r = store.get(id); return mine(r) ? r : null; },
    add: (data) => store.add({ ...data, userId: uid }),
    remove: (id) => (mine(store.get(id)) ? store.remove(id) : false),
    removeAll: () => { let n = 0; for (const r of store.list().filter(mine)) if (store.remove(r.id)) n++; return n; },
    reschedule: (id, at) => (mine(store.get(id)) ? store.reschedule(id, at) : null),
    findByText: (term) => store.findByText(term).filter(mine),
  };
}

/**
 * Se a mensagem é um pedido de lembrete, executa e devolve { handled: true, text, researched: true }
 * (researched: true = a troca NÃO vai ao contexto/histórico). Senão { handled: false }. YUI_REMINDERS_ENABLED=false desliga tudo;
 * YUI_REMINDERS_ALL_USERS=false volta a só o dono. Qualquer pessoa cria e mexe nos PRÓPRIOS lembretes (aviso por DM para ela);
 * só o dono tem o "resumo do dia".
 */
export async function routeReminders({ text, userId, authorName = '' } = {}, { store = null, env = process.env, now = new Date(), report = null, isOwner = null } = {}) {
  if (String(env?.YUI_REMINDERS_ENABLED ?? 'true').trim().toLowerCase() === 'false') return { handled: false };
  if (!userId || !/^\d{5,25}$/.test(String(userId))) return { handled: false };
  const owner = isOwner ?? (await import('../core/permissions.js')).isOwnerId;
  const ownerView = Boolean(owner(String(userId)));
  if (!ownerView && String(env?.YUI_REMINDERS_ALL_USERS ?? 'true').trim().toLowerCase() === 'false') return { handled: false };
  const reply = await runReminderRequest({ text, store: scopedReminderStore(store || defaultStore(), userId, ownerView, authorName), now, report, isOwner: ownerView, isOwnerId: (id) => Boolean(owner(String(id))) });
  return reply === null ? { handled: false } : { handled: true, text: reply, researched: true };
}

/**
 * Texto de pedido de lembrete a partir dos argumentos que o MODELO mandou na ferramenta criar_lembrete ({ quando, texto }).
 * Só vale para a própria pessoa: menções (<@id>, @nome), canais e quebras de linha somem, e o tamanho é limitado. O horário continua sendo
 * interpretado pelo código (parseWhen), nunca pelo modelo. Devolve null se faltar horário ou assunto.
 */
export function reminderTextFromTool(args = {}) {
  const clean = (v) => String(v ?? '').replace(/<@[!&]?\d+>|<#\d+>|@\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const quando = clean(args?.quando);
  const assunto = clean(args?.texto);
  if (!quando || !assunto) return null;
  return `me lembra ${quando} de ${assunto}`;
}
