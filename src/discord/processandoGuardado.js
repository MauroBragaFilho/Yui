// O "PROCESSANDO..." GUARDADO (etapa 6, pedido da Liz no relatório da etapa 5, §9). Só com o cérebro separado (YUI_CEREBRO_EXTERNO=true).
//
// Problema: o bot que cai no meio de um turno deixa a mensagem "🧠 Processando..." parada para sempre (o Discord não entrega de novo a
// mensagem a um bot que reiniciou). Solução: enquanto um turno da fila estiver aberto, o bot guarda, num arquivo dele dentro do DATABASE_DIR
// (<DATABASE_DIR>/processando-bot.json; dono: o bot):
//  - o id da mensagem ORIGINAL (a da pessoa) e o da mensagem "Processando...";
//  - o canal e a conversa (dm:<pessoa> ou ch:<canal>:u:<pessoa>, a mesma chave do contexto por horas);
//  - o estado do turno (processando, pesquisando, entregando) e a hora da última atualização.
// Gravação ATÔMICA e durável (o writeJsonAtomic da idempotência: temporário + fsync + rename) e prazo de validade (YUI_PROCESSANDO_VALIDADE_MIN,
// padrão 24 h). O registro sai quando o turno termina (entregue ou com erro). Depois de um reinício, ANTES de atender pedidos novos, o bot
// percorre os registros que sobraram:
//  - vencido: descartado SEM editar nada;
//  - válido: edita a mensagem "Processando..." com um aviso curto ("fui reiniciada no meio, pede de novo") e apaga o registro. Antes de editar,
//    confere TUDO: a mensagem é do próprio bot, está no canal guardado, responde à mensagem original guardada (quando era resposta) e AINDA
//    diz "Processando..." (se já virou resposta, ou se é de outra conversa ou de outro turno, NÃO edita e só apaga o registro);
//  - erro passageiro do Discord: o registro fica para a próxima subida (até vencer); mensagem apagada ou canal inacessível: o registro sai.
// Nada do texto da conversa é guardado: só ids, estado e horas.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../core/channel/idemPersistente.js';
import { logger as defaultLogger } from '../utils/logger.js';

export const PROCESSANDO_PREFIXO = '🧠 **Processando...**';
export const AVISO_REINICIO = '⚠️ Fui reiniciada no meio deste pedido e a resposta se perdeu. Pede de novo, por favor.';
export const ESTADOS = Object.freeze(['processando', 'pesquisando', 'entregando']);
const VERSAO = 1;
const MAX_REGISTROS = 500;
const ID_RE = /^\d{5,25}$/;
const CONVERSA_RE = /^(?:dm:\d{5,25}|ch:\d{5,25}:u:\d{5,25})$/;

/** Prazo de validade de um registro (YUI_PROCESSANDO_VALIDADE_MIN; padrão 24 h; de 1 min a 7 dias). */
export function validadeMs(env = process.env) {
  const n = Number(String(env.YUI_PROCESSANDO_VALIDADE_MIN ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(7 * 24 * 60, Math.max(1, n)) * 60_000) : 24 * 60 * 60_000;
}

/** O arquivo do bot (dono: o bot; fica com os dados dele em DATABASE_DIR). */
export function processandoFile(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'processando-bot.json');
}

/** A chave da conversa (a mesma do contexto por horas): dm:<pessoa> ou ch:<canal>:u:<pessoa>. */
export function conversaDe({ guildId = null, channelId = null, userId = null } = {}) {
  if (!ID_RE.test(String(userId ?? ''))) return null;
  if (!guildId) return `dm:${userId}`;
  return ID_RE.test(String(channelId ?? '')) ? `ch:${channelId}:u:${userId}` : null;
}

/**
 * O registro em disco. Tudo síncrono e pequeno (no máximo MAX_REGISTROS; a fila é serial, então quase sempre há 0 ou 1).
 * @param {{ file: string, ttlMs?: number, now?: () => number, logger?: object }} o
 */
export function createProcessandoStore({ file, ttlMs = validadeMs(), now = Date.now, logger = null } = {}) {
  if (!file) throw new TypeError('createProcessandoStore: informe o arquivo.');
  const target = path.resolve(file);
  /** @type {Map<string, object>} chave: o id da mensagem "Processando..." */
  const entries = new Map();
  const counters = { gravacoes: 0, falhasDeGravacao: 0, carregados: 0 };

  // Carga: temporário de um processo morto sai; arquivo ilegível vai para o lado (fica para análise) e recomeça vazio.
  try {
    for (const f of fs.readdirSync(path.dirname(target))) {
      if (f.startsWith(`${path.basename(target)}.`) && f.endsWith('.tmp')) { try { fs.rmSync(path.join(path.dirname(target), f), { force: true }); } catch { /* */ } }
    }
  } catch { /* pasta ainda não existe */ }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    const list = parsed && parsed.versao === VERSAO && parsed.registros && typeof parsed.registros === 'object' ? parsed.registros : {};
    for (const [k, r] of Object.entries(list)) {
      if (!r || !ID_RE.test(k) || r.mensagemProcessando !== k || !ID_RE.test(String(r.canal ?? '')) || !Number.isFinite(r.atualizadoEm)) continue;
      entries.set(k, { ...r });
    }
    counters.carregados = entries.size;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      const aside = `${target}.corrompido-${now()}`;
      try { fs.renameSync(target, aside); } catch { /* */ }
      logger?.warn?.(`[Processando] ${path.basename(target)} ilegível; guardado como ${path.basename(aside)} e recomeçado vazio.`);
    }
  }

  function save() {
    if (entries.size > MAX_REGISTROS) {
      const sorted = [...entries].sort((a, b) => a[1].atualizadoEm - b[1].atualizadoEm);
      for (const [k] of sorted.slice(0, entries.size - MAX_REGISTROS)) entries.delete(k);
    }
    try {
      writeJsonAtomic(target, { versao: VERSAO, gravadoEm: new Date(now()).toISOString(), registros: Object.fromEntries(entries) });
      counters.gravacoes += 1;
      return true;
    } catch (err) {
      counters.falhasDeGravacao += 1;
      logger?.warn?.(`[Processando] não consegui gravar ${path.basename(target)} (${err?.code ?? 'erro'}).`);
      return false;
    }
  }

  return {
    file: target,
    /** Guarda o "Processando..." de um turno. Ids inválidos = não guarda (devolve false). */
    guardar({ mensagemOriginal, mensagemProcessando, canal, conversa, turno, resposta = true, estado = 'processando' } = {}) {
      const k = String(mensagemProcessando ?? '');
      if (!ID_RE.test(k) || !ID_RE.test(String(canal ?? ''))) return false;
      const reg = {
        mensagemOriginal: ID_RE.test(String(mensagemOriginal ?? '')) ? String(mensagemOriginal) : null,
        mensagemProcessando: k,
        canal: String(canal),
        conversa: CONVERSA_RE.test(String(conversa ?? '')) ? String(conversa) : null,
        turno: typeof turno === 'string' ? turno.slice(0, 80) : null,
        resposta: resposta === true,
        estado: ESTADOS.includes(estado) ? estado : 'processando',
        criadoEm: now(),
        atualizadoEm: now(),
      };
      entries.set(k, reg);
      return save();
    },
    /** Novo estado do turno (e a hora). Sem registro: nada. */
    atualizar(mensagemProcessando, estado) {
      const r = entries.get(String(mensagemProcessando ?? ''));
      if (!r || !ESTADOS.includes(estado)) return false;
      if (r.estado === estado) return true;
      r.estado = estado;
      r.atualizadoEm = now();
      return save();
    },
    /** O turno terminou (entregue, com erro ou com o aviso): o registro sai. */
    remover(mensagemProcessando) {
      if (!entries.delete(String(mensagemProcessando ?? ''))) return false;
      return save();
    },
    listar: () => [...entries.values()].map((r) => ({ ...r })),
    vencido: (r) => now() - Number(r?.atualizadoEm ?? 0) > ttlMs,
    get size() { return entries.size; },
    stats: () => ({ ...counters, registros: entries.size }),
  };
}

const passageiro = (err) => {
  const status = Number(err?.status ?? err?.httpStatus);
  return !Number.isFinite(status) || status >= 500 || status === 429 || status === 408;
};

/**
 * Depois de um reinício: atualiza as mensagens "Processando..." que ficaram paradas e apaga os registros. Nunca lança.
 * @param {{ store: ReturnType<typeof createProcessandoStore>, client: object, logger?: object, texto?: string }} o
 * @returns {Promise<{ editadas: number, vencidas: number, recusadas: number, falhas: number, mantidas: number }>}
 */
export async function recuperarProcessando({ store, client, logger = defaultLogger, texto = AVISO_REINICIO } = {}) {
  const out = { editadas: 0, vencidas: 0, recusadas: 0, falhas: 0, mantidas: 0 };
  if (!store || !client) return out;
  const eu = client.user?.id ?? null;
  for (const r of store.listar()) {
    if (store.vencido(r)) { store.remover(r.mensagemProcessando); out.vencidas += 1; continue; }
    let msg = null;
    try {
      const canal = await client.channels.fetch(r.canal);
      if (!canal?.messages?.fetch) throw Object.assign(new Error('canal sem mensagens'), { status: 404 });
      msg = await canal.messages.fetch(r.mensagemProcessando);
    } catch (err) {
      if (passageiro(err)) { out.mantidas += 1; continue; } // o Discord fora agora: tenta na próxima subida (até vencer)
      store.remover(r.mensagemProcessando); out.falhas += 1; continue; // apagada, sem acesso: nada a fazer
    }
    // Nunca edita a mensagem de outra conversa ou de outro turno: tudo tem de bater com o registro.
    const canalDaMsg = String(msg?.channelId ?? msg?.channel?.id ?? '');
    const confere = Boolean(msg)
      && String(msg.id) === r.mensagemProcessando
      && eu && String(msg.author?.id ?? '') === String(eu)
      && canalDaMsg === r.canal
      && (!r.resposta || !r.mensagemOriginal || String(msg.reference?.messageId ?? '') === r.mensagemOriginal)
      && String(msg.content ?? '').startsWith(PROCESSANDO_PREFIXO);
    if (!confere) {
      store.remover(r.mensagemProcessando);
      out.recusadas += 1;
      continue;
    }
    try {
      await msg.edit({ content: texto, embeds: [], components: [], allowedMentions: { parse: [] } });
      store.remover(r.mensagemProcessando);
      out.editadas += 1;
    } catch (err) {
      if (passageiro(err)) { out.mantidas += 1; continue; }
      store.remover(r.mensagemProcessando);
      out.falhas += 1;
    }
  }
  if (out.editadas || out.vencidas || out.recusadas || out.falhas) {
    logger.info?.(`[Processando] depois do reinício: ${out.editadas} mensagem(ns) "Processando..." avisada(s), ${out.vencidas} vencida(s) descartada(s), ${out.recusadas} que não conferiam (não editadas), ${out.falhas} inacessível(is), ${out.mantidas} para a próxima.`);
  }
  return out;
}

// ── O registro deste processo (o bot com o cérebro separado). Sem `ligarProcessando`, nada é guardado. ──
let shared = null;
/** Liga o registro (só o bot separado chama). Devolve o store. */
export function ligarProcessando({ file = processandoFile(), logger = defaultLogger, ttlMs = validadeMs() } = {}) {
  shared = createProcessandoStore({ file, ttlMs, logger });
  return shared;
}
/** Desliga (testes). */
export function desligarProcessando() { shared = null; }
/** O store ligado, ou null (processo único: nada é guardado). */
export function processandoStore() { return shared; }
