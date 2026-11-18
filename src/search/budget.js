import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../core/channel/idemPersistente.js';

/**
 * Limites da busca na web.
 *
 * - Por usuário (em memória): N buscas por hora (YUI_SEARCH_USER_PER_HOUR, padrão 5; 0 = sem limite).
 * - GLOBAL (em memória): N buscas por hora SOMANDO todo mundo (YUI_SEARCH_GLOBAL_PER_HOUR, padrão 20; 0 = sem teto). É o freio
 *   anti-abuso (várias contas, vários pedidos) e vale SEMPRE: também sem userId (ex.: 2º passo do agente de pesquisa com
 *   YUI_RESEARCH_CHARGE_ALL=false) e mesmo com o limite por usuário desligado. Recusa antes de gastar o provedor.
 * - Por provedor, por mês (em arquivo, sobrevive a reinício): YUI_SEARCH_MONTHLY_CAP_<PROVEDOR>
 *   (padrão 900 para Brave e Tavily, que têm cota gratuita; 0 = sem teto; demais provedores: sem teto).
 *
 * O arquivo fica em secrets/search-budget.json (a pasta secrets/ é ignorada pelo git) e é gravado de
 * forma atômica (arquivo temporário + rename). Qualquer falha de disco é engolida: a busca não cai por
 * causa do contador (ele continua valendo em memória até o processo terminar).
 *
 * Tudo é injetável (relógio e caminho do arquivo) para teste.
 *
 * Contadores POR HORA em disco (segunda revisão da Liz na etapa 6, §12 e §13 do relatório): o processo DONO da cota (o cérebro, com o
 * cérebro separado) chama `persistirHora(arquivo)` na subida. A partir daí os contadores por hora (por usuário e o global) ficam também em
 * disco, num arquivo próprio ao lado do mensal (search-budget-hora.json), gravado de forma ATÔMICA e durável (temporário + fsync + rename)
 * a cada busca aceita, ANTES de a busca sair para o provedor. Num reinício, o processo novo relê o arquivo: as buscas da última hora continuam
 * contando, cada uma no instante em que aconteceu (a janela de 1 h continua certa: a busca de 50 min atrás sai da conta daqui a 10 min). O
 * arquivo guarda só instantes e um hash do id de cada pessoa (nunca o id, nunca a consulta). Sem `persistHora`, tudo continua só em memória.
 *
 * ETAPA 8 (revisão da Liz, §9 do relatório da etapa 7): o MESMO comportamento nas duas configurações. Quem liga e quem é o dono do arquivo está em
 * src/search/cotaHora.js: no processo único, o próprio processo; com o cérebro separado, SÓ o cérebro (o bot nunca grava), com uma trava de dono
 * no arquivo (dois processos nunca gravam o mesmo). Aqui ficam as regras de contagem:
 *  - cada busca REALMENTE despachada conta UMA vez, e a marca vai para o disco ANTES de ela sair; nada conta em dobro por causa de uma
 *    recuperação ou de um reinício (a janela de 1 h anda pelo instante de cada busca);
 *  - SEM DESPACHO, SEM COBRANÇA: a vaga é reservada (e gravada) antes da busca sair, para dois pedidos ao mesmo tempo não furarem o limite; se a
 *    busca terminar sem ter chegado a nenhum provedor (nenhum ativo, todos descansando, cota mensal cheia, cancelada antes), ou se ela só
 *    aproveitou uma busca idêntica que já estava em andamento, `refund(turn)` devolve a vaga e regrava o arquivo.
 *
 * ETAPA 8, rodada depois da revisão da Liz (§12 do relatório): a cota por hora tem UM dono e nenhuma cota independente em memória.
 *  - PORTA DE SAÍDA (`definirDespacho` / `despacho`): quem liga a cota (src/search/cotaHora.js) diz se este processo PODE despachar uma busca externa.
 *    Sem a trava do arquivo (esperando, de outro processo vivo, perdida, com erro) e no bot separado, a porta fecha: o `searchWeb` nem começa a busca
 *    e a Yui avisa que a pesquisa está temporariamente indisponível (src/search/indisponivel.js). Só `YUI_COTA_HORA_DISCO=false` (escolha explícita
 *    do dono) mantém a porta aberta só com a memória. Os pontos de entrada (index.js e cerebro.js) chamam o
 *    `ligarCotaHora` ANTES de qualquer coisa que possa buscar (o login do Discord, o agendador, a API, os métodos de pesquisa do canal): um teste confere a
 *    ordem. O `ligarCotaHora` começa fechando a porta ("aguardando-trava") e só a abre com a trava na mão. Um `createBudget()` avulso (os testes de unidade,
 *    que injetam o orçamento) nasce aberto.
 *  - FALHAR FECHADO: se o registro em disco da busca não grava (a cota por hora: `takeUser` desfaz a reserva e recusa com `scope: 'registro'`; a cota mensal
 *    do provedor: `registrarProvedor`), a busca não sai. Nunca se contorna com a cota só em memória.
 *  - REUTILIZAÇÃO sem cobrança: a pessoa que só aproveita o resultado de uma busca idêntica que já aconteceu NÃO gasta cota (`peekUser` só confere os
 *    limites, sem reservar nem gravar); `registrarReuso` conta a reutilização (só um número, `reutilizadas`), sem contá-la como busca nova.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_USER_PER_HOUR = 5;
const DEFAULT_GLOBAL_PER_HOUR = 20;
const DEFAULT_CAPS = { brave: 900, tavily: 900 };
const KEEP_MONTHS = 3;
const MAX_TRACKED_USERS = 2000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(HERE, '..', '..', 'secrets', 'search-budget.json');

function intEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Buscas por hora permitidas a cada usuário (0 = sem limite). */
export function userLimitPerHour(env = process.env) {
  return intEnv(env.YUI_SEARCH_USER_PER_HOUR, DEFAULT_USER_PER_HOUR);
}

/** Teto GLOBAL de buscas por hora, somando todos os usuários (0 = sem teto). */
export function globalLimitPerHour(env = process.env) {
  return intEnv(env.YUI_SEARCH_GLOBAL_PER_HOUR, DEFAULT_GLOBAL_PER_HOUR);
}

/** Teto mensal de buscas de um provedor (0 = sem teto). */
export function monthlyCap(provider, env = process.env) {
  const name = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return intEnv(env[`YUI_SEARCH_MONTHLY_CAP_${name}`], DEFAULT_CAPS[String(provider).toLowerCase()] ?? 0);
}

/** Chave do mês em UTC ("2026-10"). */
export function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** O arquivo dos contadores POR HORA, ao lado do mensal: <pasta do search-budget.json>/search-budget-hora.json. */
export function hourlyFileFor(filePath = process.env.YUI_SEARCH_BUDGET_FILE || DEFAULT_FILE) {
  return path.join(path.dirname(String(filePath)), `${path.basename(String(filePath)).replace(/\.json$/i, '')}-hora.json`);
}

/** Os contadores por hora vão para o disco no processo dono (o cérebro)? YUI_COTA_HORA_DISCO (padrão true; "false" volta a só memória). */
export function hourlyPersistEnabled(env = process.env) {
  return !['false', '0', 'off', 'nao', 'não', 'no'].includes(String(env.YUI_COTA_HORA_DISCO ?? '').trim().toLowerCase());
}

const HOURLY_VERSION = 1;
const HOURLY_KEY_RE = /^[0-9a-f]{24}$/;
const MAX_STAMPS_PER_USER = 200;
const MAX_GLOBAL_STAMPS = 5000;
/** O id da pessoa como ele fica no arquivo da cota por hora: um hash (o id nunca vai para o disco). */
const hashUser = (id) => crypto.createHash('sha256').update(`yui-cota-hora:${id}`).digest('hex').slice(0, 24);

export function createBudget({ filePath = process.env.YUI_SEARCH_BUDGET_FILE || DEFAULT_FILE, now = () => Date.now() } = {}) {
  const users = new Map(); // userId (ou o hash dele, com os contadores em disco) -> timestamps (ms) das buscas na última hora
  let globalStamps = []; // timestamps (ms) das buscas aceitas na última hora, de TODO mundo (no máximo o teto global)
  let months = null; // { "2026-10": { tavily: 12, brave: 3 } }, carregado sob demanda
  // Contadores por hora em disco (null = só memória). { arquivo, gravacoes, falhas, carregadas, ultimoErro, ativa }. `ativa`: ainda grava
  // (cai para false se este processo perder o dono do arquivo: dois processos nunca gravam o mesmo). Depois de ligada, a chave do usuário
  // continua sendo o hash do id, mesmo parada (os contadores que já estão em memória não mudam de chave).
  let hora = null;
  const keyOf = (id) => (hora ? hashUser(id) : id);
  // A PORTA DE SAÍDA da busca externa (veja o comentário do topo): `permitido: false` = este processo não pode despachar nenhuma busca. Padrão: aberta.
  let despacho = { permitido: true, codigo: null };
  // Quantas vezes a pessoa só aproveitou o resultado de uma busca que já aconteceu (sem nova chamada externa e sem cobrança). Só um número.
  let reutilizadas = 0;

  /**
   * Grava os contadores por hora (só com `persistirHora` e enquanto ativa). Atômico e durável. Devolve false se NÃO gravou: quem reserva a vaga
   * (`takeUser`) desfaz a reserva e a busca não sai (falhar fechado, §12 da Liz); a falha também fica na saúde.
   */
  function saveHourly(at = now()) {
    if (!hora?.ativa) return true;
    try {
      const usuarios = {};
      for (const [k, stamps] of users) {
        const alive = stamps.filter((t) => at - t < HOUR_MS).slice(-MAX_STAMPS_PER_USER);
        if (alive.length) usuarios[k] = alive;
      }
      writeJsonAtomic(hora.arquivo, { versao: HOURLY_VERSION, gravadoEm: new Date(at).toISOString(), usuarios, global: recentGlobal(at).slice(-MAX_GLOBAL_STAMPS) });
      hora.gravacoes += 1;
      hora.ultimaFalhou = false;
      return true;
    } catch (err) {
      hora.falhas += 1;
      hora.ultimaFalhou = true;
      hora.ultimaFalhaEm = at;
      hora.ultimoErro = String(err?.code ?? 'erro').slice(0, 30);
      return false;
    }
  }

  /** Buscas aceitas na última hora (poda as velhas). */
  function recentGlobal(at) {
    if (globalStamps.length) globalStamps = globalStamps.filter((t) => at - t < HOUR_MS);
    return globalStamps;
  }

  function load() {
    if (months) return months;
    months = {};
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const source = raw && typeof raw === 'object' ? raw.months : null;
      if (source && typeof source === 'object') {
        for (const [key, counters] of Object.entries(source)) {
          if (!/^\d{4}-\d{2}$/.test(key) || !counters || typeof counters !== 'object') continue;
          months[key] = {};
          for (const [provider, n] of Object.entries(counters)) {
            if (Number.isFinite(n) && n >= 0) months[key][provider] = Math.floor(n);
          }
        }
      }
    } catch {
      // arquivo ausente ou corrompido: começa do zero
    }
    return months;
  }

  /**
   * Grava os contadores do mês (atômico e durável: temporário + fsync + rename, com novas tentativas no Windows). Devolve false se NÃO gravou: o
   * `registrarProvedor` desfaz a conta e a busca não sai (falhar fechado, §12 da Liz). Nunca lança.
   */
  function save() {
    try {
      const keep = Object.keys(months).sort().slice(-KEEP_MONTHS);
      const pruned = {};
      for (const key of keep) pruned[key] = months[key];
      months = pruned;
      writeJsonAtomic(filePath, { version: 1, months });
      return true;
    } catch {
      return false;
    }
  }

  function sweepUsers(at) {
    for (const [id, stamps] of users) {
      const alive = stamps.filter((t) => at - t < HOUR_MS);
      if (alive.length) users.set(id, alive);
      else users.delete(id);
    }
  }

  /**
   * O coração do `takeUser` e do `peekUser`. `cobrar: false` só CONFERE os limites (nada é reservado nem gravado). Com `cobrar: true` reserva a vaga e,
   * com os contadores em disco, grava ANTES de a busca sair; se a gravação falhar, a reserva é DESFEITA e a recusa vem com `scope: 'registro'`.
   */
  function avaliar(userId, env, at, cobrar) {
    const limit = userLimitPerHour(env);
    const globalLimit = globalLimitPerHour(env);
    // O teto global vem ANTES de qualquer retorno antecipado: sem userId ou com o limite por usuário desligado ele continua valendo.
    const recent = recentGlobal(at);
    const globalFull = globalLimit > 0 && recent.length >= globalLimit;
    const globalRetry = globalFull ? Math.max(0, recent[0] + HOUR_MS - at) : 0;
    const id = userId === undefined || userId === null || userId === '' ? null : keyOf(String(userId));
    const tracked = limit > 0 && id !== null;
    const stamps = tracked ? (users.get(id) ?? []).filter((t) => at - t < HOUR_MS) : null;
    if (tracked && stamps.length >= limit) {
      users.set(id, stamps);
      return { ok: false, scope: 'user', limit, used: stamps.length, retryAfterMs: Math.max(0, stamps[0] + HOUR_MS - at, globalRetry), globalLimit, globalUsed: recent.length };
    }
    if (globalFull) {
      if (tracked) users.set(id, stamps); // grava a poda, sem gastar a cota do usuário
      return { ok: false, scope: 'global', limit, used: stamps ? stamps.length : 0, retryAfterMs: globalRetry, globalLimit, globalUsed: recent.length };
    }
    if (!cobrar) return { ok: true, scope: null, limit, used: stamps ? stamps.length : 0, retryAfterMs: 0, globalLimit, globalUsed: globalLimit > 0 ? recent.length : 0 };
    if (tracked) {
      stamps.push(at);
      users.set(id, stamps);
      if (users.size > MAX_TRACKED_USERS) sweepUsers(at);
    }
    if (globalLimit > 0) recent.push(at);
    // Com os contadores em disco: grava ANTES de a busca sair (um reinício logo depois ainda conta esta busca). Não gravou = a busca NÃO sai: a reserva
    // é desfeita (o arquivo seguia sem esta marca) e quem chamou recebe `scope: 'registro'`. Nunca se segue com a cota só em memória.
    if ((tracked || globalLimit > 0) && !saveHourly(at)) {
      if (tracked) {
        const i = stamps.lastIndexOf(at);
        if (i >= 0) stamps.splice(i, 1);
        if (stamps.length) users.set(id, stamps); else users.delete(id);
      }
      if (globalLimit > 0) {
        // (o saveHourly poda e REATRIBUI a lista global: desfaz na lista de agora, não na que `recent` guardava)
        const j = globalStamps.lastIndexOf(at);
        if (j >= 0) globalStamps.splice(j, 1);
      }
      return { ok: false, scope: 'registro', limit, used: stamps ? stamps.length : 0, retryAfterMs: 0, globalLimit, globalUsed: globalLimit > 0 ? globalStamps.length : 0 };
    }
    const turn = { ok: true, scope: null, limit, used: stamps ? stamps.length : 0, retryAfterMs: 0, globalLimit, globalUsed: globalLimit > 0 ? recent.length : 0 };
    // A "cobrança" desta vaga (para o refund): não enumerável, então o objeto continua igual para quem o compara ou o copia.
    Object.defineProperty(turn, 'charge', { value: { at, userKey: tracked ? id : null, global: globalLimit > 0, refunded: false }, enumerable: false });
    return turn;
  }

  return {
    filePath,

    /**
     * Conta uma busca se ainda houver cota na última hora: primeiro o teto GLOBAL (todo mundo, inclusive sem userId), depois o limite
     * do usuário. Quem recusa não gasta cota de nenhum dos dois.
     * `limit`/`used` são sempre os do USUÁRIO; `globalLimit`/`globalUsed` os do teto global (0 = desligado).
     * `scope` diz quem recusou: 'user' | 'global' | 'registro' (null quando ok). Os dois limites recusando: 'user', com o maior tempo de espera.
     * 'registro': o registro em disco não gravou (a reserva foi desfeita e a busca não pode sair: a pesquisa fica indisponível).
     * @returns {{ ok: boolean, scope: 'user'|'global'|'registro'|null, limit: number, used: number, retryAfterMs: number, globalLimit: number, globalUsed: number }}
     */
    takeUser(userId, env = process.env, at = now()) {
      return avaliar(userId, env, at, true);
    },

    /**
     * Só CONFERE os limites (o mesmo resultado do `takeUser`, sem reservar a vaga nem gravar nada). Para quem vai só aproveitar o resultado de uma busca
     * idêntica que já aconteceu: não gasta cota (§12 da Liz), mas uma pessoa que já estourou o limite continua recusada.
     */
    peekUser(userId, env = process.env, at = now()) {
      return avaliar(userId, env, at, false);
    },

    /**
     * SEM DESPACHO, SEM COBRANÇA (Liz, §9 da etapa 7): devolve a vaga de um `takeUser` cuja busca NÃO chegou a sair para nenhum provedor (ou só
     * aproveitou uma busca idêntica em andamento). Tira exatamente aquela marca (do usuário e do global), regrava o arquivo (com os contadores em
     * disco) e devolve true; uma vaga só é devolvida uma vez, e uma recusa (ok: false) nunca tem o que devolver.
     */
    refund(turn) {
      const c = turn?.charge;
      if (!c || c.refunded) return false;
      c.refunded = true;
      let changed = false;
      if (c.userKey !== null) {
        const stamps = users.get(c.userKey);
        const i = stamps ? stamps.indexOf(c.at) : -1;
        if (i >= 0) {
          stamps.splice(i, 1);
          if (stamps.length) users.set(c.userKey, stamps); else users.delete(c.userKey);
          changed = true;
        }
      }
      if (c.global) {
        const i = globalStamps.indexOf(c.at);
        if (i >= 0) { globalStamps.splice(i, 1); changed = true; }
      }
      if (changed) saveHourly();
      return changed;
    },

    /** Situação do teto global agora (não gasta nada): quantas buscas na última hora e quando abre vaga. */
    globalStatus(env = process.env, at = now()) {
      const limit = globalLimitPerHour(env);
      const recent = recentGlobal(at);
      const full = limit > 0 && recent.length >= limit;
      return { limit, used: recent.length, full, retryAfterMs: full ? Math.max(0, recent[0] + HOUR_MS - at) : 0 };
    },

    /**
     * Situação da cota POR USUÁRIO agora (não gasta nada): o cérebro olha isto antes de decidir se o /yui começa uma busca que
     * não foi pedida (etapa 6, ajustes da Liz). Sem userId ou com o limite desligado: nunca cheia.
     */
    userStatus(userId, env = process.env, at = now()) {
      const limit = userLimitPerHour(env);
      const id = userId === undefined || userId === null || userId === '' ? null : keyOf(String(userId));
      if (limit <= 0 || id === null) return { limit, used: 0, full: false, retryAfterMs: 0 };
      const stamps = (users.get(id) ?? []).filter((t) => at - t < HOUR_MS);
      const full = stamps.length >= limit;
      return { limit, used: stamps.length, full, retryAfterMs: full ? Math.max(0, stamps[0] + HOUR_MS - at) : 0 };
    },

    /**
     * Devolve à cota POR HORA (usuário e global) uma busca que JÁ aconteceu e foi contada por um processo que caiu (os contadores
     * por hora vivem na memória e zeram num reinício). Usado só pela retomada da pesquisa no cérebro (src/cerebro/pesquisaRetomada.js):
     * a busca concluída e guardada não roda de novo, mas continua contando. Não confere limite (a busca já foi feita) e não toca
     * na cota mensal dos provedores (essa é gravada em disco antes de cada chamada e já está certa). Busca de mais de uma hora: nada.
     * Com os contadores por hora em DISCO (persistirHora), a busca do processo anterior já voltou com o arquivo: nada a devolver (false),
     * para não contar duas vezes.
     */
    restoreUse(userId, at, env = process.env) {
      if (hora?.ativa) return false;
      // Com a porta fechada (sem a trava do arquivo, perdida, bot separado) a busca daquele processo já está, ou estará, no arquivo da cota (que este processo
      // relê ao pegar a trava): devolver à memória contaria em dobro. Só a memória por escolha explícita (YUI_COTA_HORA_DISCO=false) precisa da devolução.
      if (!despacho.permitido) return false;
      const when = Number(at);
      const t = now();
      if (!Number.isFinite(when) || when > t || t - when >= HOUR_MS) return false;
      const id = userId === undefined || userId === null || userId === '' ? null : keyOf(String(userId));
      if (userLimitPerHour(env) > 0 && id !== null) {
        const stamps = (users.get(id) ?? []).filter((s) => t - s < HOUR_MS);
        stamps.push(when);
        stamps.sort((a, b) => a - b);
        users.set(id, stamps);
      }
      if (globalLimitPerHour(env) > 0) {
        recentGlobal(t).push(when);
        globalStamps.sort((a, b) => a - b);
      }
      return true;
    },

    /** Uso do mês corrente de um provedor. */
    used(provider, at = now()) {
      return load()[monthKey(at)]?.[provider] ?? 0;
    },

    /** O provedor ainda pode ser chamado neste mês? */
    canUseProvider(provider, env = process.env, at = now()) {
      const cap = monthlyCap(provider, env);
      const used = this.used(provider, at);
      return { ok: !cap || used < cap, used, cap };
    },

    /** Registra uma chamada ao provedor (grava em disco, sem nunca lançar erro). Se o disco falhar a conta fica só em memória: quem despacha usa `registrarProvedor`. */
    recordProvider(provider, at = now()) {
      const key = monthKey(at);
      const all = load();
      all[key] ??= {};
      all[key][provider] = (all[key][provider] ?? 0) + 1;
      save();
      return all[key][provider];
    },

    /**
     * Registra, ANTES de despachar, a chamada ao provedor na cota mensal em disco. Falhar fechado (§12 da Liz): se o registro NÃO gravou, a conta é desfeita
     * e devolve `{ ok: false }`: a chamada não sai (nunca a cota só em memória). Nunca lança.
     * @returns {{ ok: boolean, count: number }}
     */
    registrarProvedor(provider, at = now()) {
      const key = monthKey(at);
      const all = load();
      all[key] ??= {};
      const antes = all[key][provider] ?? 0;
      all[key][provider] = antes + 1;
      if (save()) return { ok: true, count: antes + 1 };
      if (antes > 0) all[key][provider] = antes; else delete all[key][provider];
      return { ok: false, count: antes };
    },

    /**
     * A PORTA DE SAÍDA da busca externa deste processo (quem liga a cota, src/search/cotaHora.js, decide). `permitido: false` = nenhuma busca pode ser
     * despachada (o `searchWeb` devolve `resultadoIndisponivel` sem chamar ninguém). `codigo`: uma palavra fixa (MOTIVOS_INDISPONIVEL), só para o diagnóstico.
     */
    definirDespacho(permitido, codigo = null) {
      despacho = { permitido: permitido !== false, codigo: permitido === false ? String(codigo ?? 'aguardando-trava').slice(0, 40) : null };
      return { ...despacho };
    },
    despacho() {
      return { ...despacho };
    },

    /** Registra uma REUTILIZAÇÃO: a pessoa recebeu o resultado de uma busca que já aconteceu (sem nova chamada externa e sem cobrança). Só um número. */
    registrarReuso() {
      reutilizadas += 1;
      return reutilizadas;
    },
    reutilizadas() {
      return reutilizadas;
    },

    /**
     * Liga os contadores por hora em DISCO (só o processo dono da cota chama: o cérebro). Relê o arquivo (as buscas da última hora de um
     * processo anterior voltam a contar, cada uma no instante dela) e passa a gravar a cada busca aceita. Arquivo ilegível ou de outra versão:
     * recomeça vazio (e é regravado na próxima busca). Devolve quantas marcas voltaram. Nunca lança.
     */
    persistirHora(arquivo = hourlyFileFor(filePath), at = now()) {
      const novo = { arquivo: path.resolve(String(arquivo)), gravacoes: 0, falhas: 0, carregadas: 0, ultimoErro: null, ilegivel: false, ativa: true, ligadaEm: at, ultimaFalhou: false, ultimaFalhaEm: 0 };
      // o que já estava em memória (com o id em texto) passa para a chave com hash
      const antes = [...users.entries()];
      const tinhaEmMemoria = antes.length > 0 || globalStamps.length > 0;
      users.clear();
      hora = novo;
      for (const [id, stamps] of antes) users.set(HOURLY_KEY_RE.test(id) ? id : hashUser(id), stamps);
      const vivo = (t) => Number.isFinite(t) && t <= at + 60_000 && at - t < HOUR_MS; // a última hora (com folga de 1 min para o relógio)
      try {
        const raw = JSON.parse(fs.readFileSync(novo.arquivo, 'utf8'));
        if (raw?.versao !== HOURLY_VERSION) throw new Error('versão');
        for (const [k, list] of Object.entries(raw.usuarios ?? {})) {
          if (!HOURLY_KEY_RE.test(k) || !Array.isArray(list)) continue;
          const stamps = list.map(Number).filter(vivo).slice(-MAX_STAMPS_PER_USER);
          if (!stamps.length) continue;
          users.set(k, [...(users.get(k) ?? []), ...stamps].sort((a, b) => a - b));
          novo.carregadas += stamps.length;
        }
        const g = (Array.isArray(raw.global) ? raw.global : []).map(Number).filter(vivo).slice(-MAX_GLOBAL_STAMPS);
        if (g.length) { globalStamps = [...globalStamps, ...g].sort((a, b) => a - b); novo.carregadas += g.length; }
      } catch (err) {
        if (err?.code !== 'ENOENT') novo.ilegivel = true; // recomeça vazio; a próxima busca regrava
      }
      // As buscas que este processo já tinha contado SÓ na memória (antes de ele pegar o arquivo) vão para o disco agora, junto com as do arquivo.
      if (tinhaEmMemoria) saveHourly(at);
      return novo.carregadas;
    },

    /**
     * Para de GRAVAR os contadores por hora (o processo perdeu o dono do arquivo, ou está encerrando): dois processos nunca gravam o mesmo
     * arquivo. Os contadores seguem valendo na memória. Devolve true se estava gravando.
     */
    desligarHora(motivo = 'parada') {
      if (!hora?.ativa) return false;
      hora.ativa = false;
      hora.motivoParada = String(motivo ?? '').slice(0, 80);
      return true;
    },

    /**
     * Situação dos contadores por hora em disco (só números e booleanos, para a saúde). `gravacaoComFalha`: a última gravação falhou há menos de 5 minutos
     * (a pesquisa fica indisponível enquanto o registro não grava); `reutilizadas`: quantas vezes só se aproveitou uma busca que já aconteceu.
     */
    hourlyStats() {
      const reuso = { reutilizadas };
      return hora
        ? {
          persistente: hora.ativa, gravacoes: hora.gravacoes, falhas: hora.falhas, carregadas: hora.carregadas, ilegivel: hora.ilegivel, ultimoErro: hora.ultimoErro,
          gravacaoComFalha: hora.ultimaFalhou === true && now() - hora.ultimaFalhaEm < 5 * 60_000, ...reuso, ...(hora.ativa ? {} : { parada: hora.motivoParada ?? 'parada' }),
        }
        : { persistente: false, gravacaoComFalha: false, ...reuso };
    },

    /** Zera tudo (só para testes). */
    reset() {
      users.clear();
      globalStamps = [];
      months = {};
      reutilizadas = 0;
      if (hora) saveHourly();
    },
  };
}

let defaultBudget = null;

/**
 * Instância compartilhada do processo (arquivo YUI_SEARCH_BUDGET_FILE ou secrets/search-budget.json). Quem liga a cota (src/search/cotaHora.js: o processo
 * único, o cérebro ou o bot separado) fecha a porta de saída dela e só a abre com a trava na mão, conforme o papel. Os pontos de entrada fazem isso antes de
 * qualquer coisa que possa buscar (tests/test-cota-hora-disco.js F confere a ordem).
 */
export function getDefaultBudget() {
  defaultBudget ??= createBudget();
  return defaultBudget;
}
