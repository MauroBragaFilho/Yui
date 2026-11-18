// IDEMPOTÊNCIA PERSISTENTE das ações com efeito pedidas pelo canal (etapa 4, docs/RELATORIO_ETAPA4_OPERACAO.md §3).
//
// O cache de idempotência do canal (protocol.js) vive na memória do processo: se o bot reiniciar no meio de uma DM, o
// cérebro tenta de novo com a MESMA chave (ex.: `lembrete:<id>:<horário>`) e o bot novo, sem o cache, mandaria a DM outra
// vez. Este arquivo guarda as chaves em disco, por processo DONO do arquivo (o bot: <DATABASE_DIR>/idempotencia-bot.json;
// nenhum outro processo grava nele), com:
//  - gravação ATÔMICA e durável: temporário na mesma pasta + fsync + rename (um processo morto no meio nunca deixa o arquivo
//    pela metade: ou fica a versão anterior, ou a nova);
//  - duas fases por efeito: `iniciar` grava "enviando" ANTES do efeito; `concluir` grava "feito" (com a resposta) depois;
//  - uma chave que ficou em "enviando" (o processo caiu entre o efeito e a confirmação, ou o efeito falhou sem saber se saiu)
//    vira INCERTA e NUNCA é repetida às cegas: efeitoUnico não executa de novo, e a DM do bot (canalCerebro.js) RECONCILIA
//    antes (nonce do Discord e histórico da DM); se não der, devolve `incerto` e o dono decide (cerebro/entregaLembretes.js);
//  - prazo de validade (padrão 48 h) e limite de chaves (padrão 5000): o que vence ou sobra sai na próxima gravação.
// Só a chave e a resposta curta são guardadas (nunca o texto da mensagem).
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_IDEM_FILE_TTL_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_IDEM_FILE_MAX = 5000;
const VERSION = 1;
const MAX_KEY = 200;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Grava `data` em `file` de forma atômica e durável (temporário + fsync + rename, com novas tentativas no Windows). */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data));
    try { fs.fsyncSync(fd); } catch { /* fsync é melhor esforço */ }
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Antivírus ou indexador segurando o arquivo por um instante.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 6) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
        throw err;
      }
      sleepSync(25 * attempt);
    }
  }
}

/**
 * @param {{ file: string, ttlMs?: number, max?: number, now?: () => number, logger?: object }} options
 */
export function createPersistentIdemStore({ file, ttlMs = DEFAULT_IDEM_FILE_TTL_MS, max = DEFAULT_IDEM_FILE_MAX, now = Date.now, logger = null } = {}) {
  if (!file) throw new TypeError('createPersistentIdemStore: informe o arquivo.');
  const target = path.resolve(file);
  /** @type {Map<string, {estado: 'enviando'|'feito', em: number, pid: number, resultado?: unknown}>} */
  const entries = new Map();
  const counters = { carregadas: 0, repetidas: 0, incertas: 0, gravacoes: 0, falhasDeGravacao: 0 };

  // Carga: sobras de temporário de um processo morto são recolhidas; arquivo ilegível vai para o lado (fica para análise).
  try {
    for (const f of fs.readdirSync(path.dirname(target))) {
      if (f.startsWith(`${path.basename(target)}.`) && f.endsWith('.tmp')) {
        try { fs.rmSync(path.join(path.dirname(target), f), { force: true }); } catch { /* */ }
      }
    }
  } catch { /* pasta ainda não existe */ }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    const list = parsed && parsed.versao === VERSION && parsed.chaves && typeof parsed.chaves === 'object' ? parsed.chaves : {};
    for (const [key, e] of Object.entries(list)) {
      if (!e || (e.estado !== 'enviando' && e.estado !== 'feito') || !Number.isFinite(e.em)) continue;
      entries.set(key, { estado: e.estado, em: e.em, pid: Number(e.pid) || 0, ...(e.estado === 'feito' ? { resultado: e.resultado ?? null } : {}) });
    }
    counters.carregadas = entries.size;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      const aside = `${target}.corrompido-${now()}`;
      try { fs.renameSync(target, aside); } catch { /* */ }
      logger?.warn?.(`[Idempotência] ${path.basename(target)} ilegível; guardado como ${path.basename(aside)} e recomeçado vazio.`);
    }
  }

  function prune() {
    const limit = now() - ttlMs;
    for (const [key, e] of entries) if (e.em < limit) entries.delete(key);
    if (entries.size > max) {
      const sorted = [...entries].sort((a, b) => a[1].em - b[1].em);
      for (const [key] of sorted.slice(0, entries.size - max)) entries.delete(key);
    }
  }

  function save() {
    prune();
    const chaves = Object.fromEntries(entries);
    try {
      writeJsonAtomic(target, { versao: VERSION, gravadoEm: new Date(now()).toISOString(), chaves });
      counters.gravacoes += 1;
    } catch (err) {
      counters.falhasDeGravacao += 1;
      throw Object.assign(new Error(`Não consegui gravar a idempotência (${err.code || err.message}).`), { code: 'IDEM_GRAVACAO' });
    }
  }

  const check = (key) => {
    if (typeof key !== 'string' || !key || key.length > MAX_KEY) throw new TypeError('Chave de idempotência inválida.');
    return key;
  };

  return {
    file: target,
    /** Situação da chave: 'novo', 'feito' (com a resposta guardada) ou 'incerto' (ficou em "enviando"). */
    consultar(key) {
      const e = entries.get(check(key));
      if (!e || e.em < now() - ttlMs) return { estado: 'novo' };
      if (e.estado === 'feito') { counters.repetidas += 1; return { estado: 'feito', resultado: e.resultado ?? null }; }
      counters.incertas += 1;
      return { estado: 'incerto', desde: new Date(e.em).toISOString() };
    },
    /**
     * Marca "enviando" no disco ANTES do efeito. Lança se não conseguir gravar (aí o efeito não acontece). `emMs` mantém a
     * hora da PRIMEIRA tentativa numa reconciliação (a janela de deduplicação do Discord conta a partir dela).
     */
    iniciar(key, emMs = null) {
      entries.set(check(key), { estado: 'enviando', em: Number.isFinite(emMs) ? emMs : now(), pid: process.pid });
      save();
    },
    /** Marca "feito" com a resposta (curta). */
    concluir(key, resultado) {
      entries.set(check(key), { estado: 'feito', em: now(), pid: process.pid, resultado: resultado ?? null });
      save();
    },
    /** Tira a marca: o efeito com certeza NÃO aconteceu (a próxima tentativa pode executar). */
    desfazer(key) {
      if (entries.delete(check(key))) save();
    },
    get size() { return entries.size; },
    stats: () => ({ ...counters, chaves: entries.size }),
  };
}

/**
 * Executa um efeito no máximo uma vez por chave, sobrevivendo a reinícios.
 *  - chave já feita: devolve a resposta guardada (com `repetido: true`), sem executar;
 *  - chave incerta: NÃO executa; devolve `incerto` (quem pediu trata como entregue);
 *  - chave nova: grava "enviando", executa e grava "feito". Se o efeito falhar e `nadaSaiu(err)` disser que nada saiu, a
 *    marca é desfeita (a próxima tentativa executa); senão a chave fica incerta.
 * Sem `store` ou sem `key`, só executa (o comportamento de antes).
 * @template T
 * @param {ReturnType<typeof createPersistentIdemStore>|null} store
 * @param {string|null} key
 * @param {() => Promise<T>} fn
 * @param {{ nadaSaiu?: (err: unknown) => boolean, incerto?: (info: {desde: string}) => unknown }} [options]
 */
export async function efeitoUnico(store, key, fn, { nadaSaiu = () => false, incerto = (info) => ({ incerto: true, desde: info.desde }) } = {}) {
  if (!store || !key) return fn();
  const prev = store.consultar(key);
  if (prev.estado === 'feito') {
    const r = prev.resultado;
    return r && typeof r === 'object' && !Array.isArray(r) ? { ...r, repetido: true } : r;
  }
  if (prev.estado === 'incerto') return incerto({ desde: prev.desde });
  store.iniciar(key);
  let out;
  try {
    out = await fn();
  } catch (err) {
    let none = false;
    try { none = nadaSaiu(err) === true; } catch { none = false; }
    if (none) { try { store.desfazer(key); } catch { /* a marca fica: no máximo uma vez */ } }
    throw err;
  }
  // O efeito já aconteceu: uma falha ao gravar "feito" não pode virar erro (o pedido seria repetido). Na memória a chave já
  // está como feita; no disco ela fica "enviando" (incerta), que também nunca repete.
  try { store.concluir(key, out); } catch { /* ver acima */ }
  return out;
}
