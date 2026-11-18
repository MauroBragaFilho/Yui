// Trava de DONO de um banco (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §3).
//
// Só o processo dono abre o banco para escrever. A posse fica registrada no arquivo `<banco>.owner`, ao lado do `.db`:
//  - criação ATÔMICA com `fs.openSync(caminho, 'wx')`: o sistema garante que só um processo cria o arquivo (quem perde
//    recebe EEXIST);
//  - o arquivo guarda, em JSON, o papel (`cerebro`, `bot`...), o PID, o nome da máquina, a hora em que o processo começou,
//    a hora em que pegou a trava e um token aleatório;
//  - BATIMENTO: enquanto o token no arquivo for o nosso, a data de modificação do arquivo é renovada a cada heartbeatMs;
//  - trava com batimento recente: a segunda abertura como dono é RECUSADA (código YUI_DB_OWNER_HELD);
//  - batimento parado há mais de staleMs: só é retomada se o processo registrado não existe mais OU existe com outra hora
//    de início (o Windows reaproveitou o PID). Processo vivo com a mesma hora de início é RECUSADO (YUI_DB_OWNER_HUNG) e
//    vira alerta: este módulo NUNCA encerra processo nenhum (a consulta usa só o sinal 0, que apenas pergunta se existe);
//  - a retomada é atômica: a trava velha é renomeada para `.owner.stale-<hora>` e a nova é criada com 'wx'; se outro
//    processo ganhar a corrida, este recusa. Só um processo por vez retoma (mutex `.owner.takeover`, também com 'wx'),
//    e quem renomeia confere que tirou do lugar exatamente a trava que julgou abandonada;
//  - release() só apaga o arquivo se o token ainda for o nosso.
//
// Ainda NÃO está ligado ao db.js (isso é da integração, atrás da chave YUI_DB_OWNER_ROLE).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const OWNER_LOCK_SUFFIX = '.owner';
export const OWNER_HELD = 'YUI_DB_OWNER_HELD';
export const OWNER_HUNG = 'YUI_DB_OWNER_HUNG';
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_STALE_MS = 60_000;
/** Diferença máxima entre a hora de início registrada e a consultada para considerar que é o MESMO processo. */
export const START_TOLERANCE_MS = 3_000;
const QUERY_TIMEOUT_MS = 5_000;

/** Hora de início deste processo (ms desde 1970), calculada uma vez na carga do módulo. */
export const PROCESS_START_MS = Math.round(Date.now() - process.uptime() * 1000);

const stats = { acquired: 0, refused: 0, takeovers: 0, hung: 0, released: 0, lost: 0, lastConflict: null };

/** Caminho do arquivo de trava de um banco. */
export function ownerLockPath(dbPath) {
  return `${path.resolve(dbPath)}${OWNER_LOCK_SUFFIX}`;
}

/** Cópia do registro sem o token (o token só interessa ao dono; não vai para erro, log nem relatório). */
function publicOwner(record) {
  if (!record || typeof record !== 'object') return null;
  const { token, ...rest } = record;
  return { ...rest, hasToken: typeof token === 'string' && token.length > 0 };
}

/** Lê a trava: { record (null se ilegível), mtimeMs } ou null se o arquivo não existe. */
function readLock(lockPath) {
  let st;
  let raw;
  try {
    st = fs.statSync(lockPath);
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let record = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid) && typeof parsed.token === 'string') record = parsed;
  } catch { /* conteúdo ilegível: tratado como trava sem dono identificável */ }
  return { record, raw, mtimeMs: st.mtimeMs };
}

/** Cria a trava com 'wx'. true se criou; false se já existia (EEXIST). Outros erros sobem. */
function tryCreate(lockPath, content) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o644);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, content);
    try { fs.fsyncSync(fd); } catch { /* fsync é melhor esforço */ }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Caminho do PowerShell do Windows pelo System32 (não pelo PATH). */
function windowsPowerShell() {
  const candidate = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * Hora de início de um processo (ms desde 1970) ou null se não deu para saber.
 * Windows: CreationDate do Win32_Process (CIM), convertida para milissegundos UTC pelo próprio PowerShell (sem depender
 * do formato de data do idioma). Fora dele: `ps -o lstart=` com LC_ALL=C.
 */
export function readProcessStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`;
      const out = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return /^\d+$/.test(out) ? Number(out) : null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Só PERGUNTA ao sistema se o processo existe (sinal 0: nada é entregue ao processo). EPERM = existe, de outro usuário.
 * Usado pelo supervisor para saber se a trava é de um dono que já morreu (src/operacao/supervisor.js); nunca encerra nada.
 */
export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Consulta padrão: o processo existe? e quando começou?
 * A existência vem do sinal 0, que só PERGUNTA ao sistema (não entrega sinal nenhum). EPERM = existe, mas é de outro
 * usuário: conta como vivo.
 * @returns {{alive: boolean, startMs: number|null}}
 */
export function defaultQueryProcess(pid) {
  let alive;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err?.code === 'EPERM';
  }
  if (!alive) return { alive: false, startMs: null };
  return { alive: true, startMs: readProcessStartMs(pid) };
}

function conflict(kind, lockPath, details) {
  stats.lastConflict = { kind, at: new Date().toISOString(), lockPath, ...details };
}

function refuse(code, lockPath, { owner, reason, heartbeatAgeMs }) {
  stats.refused += 1;
  if (code === OWNER_HUNG) stats.hung += 1;
  const pub = publicOwner(owner);
  conflict(code === OWNER_HUNG ? 'hung' : 'refused', lockPath, { code, reason, owner: pub, heartbeatAgeMs });
  const who = pub ? `${pub.role ?? '?'} (PID ${pub.pid}, ${pub.hostname ?? '?'})` : 'dono desconhecido';
  const msg = code === OWNER_HUNG
    ? `O banco ${lockPath.slice(0, -OWNER_LOCK_SUFFIX.length)} tem dono vivo mas sem batimento: ${who}; motivo: ${reason}. Nada foi encerrado; verifique o processo.`
    : `O banco ${lockPath.slice(0, -OWNER_LOCK_SUFFIX.length)} já tem dono: ${who}; motivo: ${reason}.`;
  const err = new Error(msg);
  err.code = code;
  err.owner = pub;
  err.reason = reason;
  err.lockPath = lockPath;
  err.heartbeatAgeMs = heartbeatAgeMs;
  return err;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function staleName(lockPath, nowMs) {
  return `${lockPath}.stale-${nowMs}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Conteúdo bruto + data de modificação, ou null se o arquivo não existe. */
function readRaw(file) {
  try {
    const st = fs.statSync(file);
    return { raw: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Renomeia `file` para `target` e confere que o que saiu do lugar é exatamente `expectedRaw`. Se for outro conteúdo (alguém
 * trocou o arquivo entre a leitura e a renomeação), devolve-o ao lugar com 'wx' e responde 'changed'.
 * @returns {'moved' | 'missing' | 'changed'}
 */
function moveAsideIfSame(file, target, expectedRaw) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(file, target);
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return 'missing';
      // No Windows um antivírus ou indexador pode segurar o arquivo por um instante.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 5) throw err;
      sleepSync(50 * attempt);
    }
  }
  const movedRaw = fs.readFileSync(target, 'utf8');
  if (movedRaw === expectedRaw) return 'moved';
  if (tryCreate(file, movedRaw)) fs.rmSync(target, { force: true });
  return 'changed';
}

/** Idade a partir da qual o mutex de retomada é sobra de um processo que caiu no meio da retomada (que dura milissegundos). */
const TAKEOVER_MUTEX_STALE_MS = 10_000;

/**
 * Roda `fn` segurando o mutex `<trava>.takeover` (criado com 'wx'): só um processo por vez retoma a mesma trava.
 * Sem isso, num empate de três, um processo poderia tirar do lugar a trava NOVA que outro acabou de criar.
 * @returns {{busy: true} | ({busy: false} & ReturnType<typeof fn>)}
 */
function withTakeoverMutex(lockPath, now, fn) {
  const mutex = `${lockPath}.takeover`;
  const body = JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(8).toString('hex'), at: new Date(now()).toISOString() });
  if (!tryCreate(mutex, body)) {
    const existing = readRaw(mutex);
    if (existing && now() - existing.mtimeMs < TAKEOVER_MUTEX_STALE_MS) return { busy: true };
    if (existing) {
      // Sobra de uma retomada que caiu no meio: tira do lugar (conferindo que é a mesma) e apaga; não guarda dado nenhum.
      const aside = staleName(mutex, Math.round(now()));
      const outcome = moveAsideIfSame(mutex, aside, existing.raw);
      if (outcome === 'changed') return { busy: true };
      if (outcome === 'moved') fs.rmSync(aside, { force: true });
    }
    if (!tryCreate(mutex, body)) return { busy: true };
  }
  try {
    return { busy: false, ...fn() };
  } finally {
    try { if (readRaw(mutex)?.raw === body) fs.rmSync(mutex, { force: true }); } catch { /* sobra vira mutex velho e é recolhida depois */ }
  }
}

/** Retomada (já dentro do mutex): confere de novo, tira a velha do lugar e cria a nova com 'wx'. */
function takeOverStale(lockPath, judged, content, { now, staleMs }) {
  const again = readLock(lockPath);
  if (!again) {
    // O dono liberou nesse meio-tempo: é uma posse comum.
    if (tryCreate(lockPath, content)) return { takeover: false, movedTo: null };
    throw refuse(OWNER_HELD, lockPath, { owner: readLock(lockPath)?.record, reason: 'outro processo pegou a trava agora' });
  }
  if (again.raw !== judged.raw) {
    throw refuse(OWNER_HELD, lockPath, { owner: again.record, reason: 'a trava mudou durante a verificação (outro processo retomou antes)' });
  }
  if (now() - again.mtimeMs < staleMs) {
    throw refuse(OWNER_HELD, lockPath, { owner: again.record, heartbeatAgeMs: Math.round(now() - again.mtimeMs), reason: 'o batimento voltou' });
  }
  const target = staleName(lockPath, Math.round(now()));
  const moved = moveAsideIfSame(lockPath, target, judged.raw);
  if (moved === 'changed') {
    throw refuse(OWNER_HELD, lockPath, { owner: readLock(lockPath)?.record, reason: 'outro processo retomou a trava antes' });
  }
  if (!tryCreate(lockPath, content)) {
    throw refuse(OWNER_HELD, lockPath, { owner: readLock(lockPath)?.record, reason: 'outro processo ganhou a retomada' });
  }
  return moved === 'moved' ? { takeover: true, movedTo: target } : { takeover: false, movedTo: null };
}

/**
 * Pega a trava de dono do banco `dbPath`.
 * @param {string} dbPath caminho do .db
 * @param {{role: string, heartbeatMs?: number, staleMs?: number,
 *          queryProcess?: (pid: number) => {alive: boolean, startMs: number|null},
 *          now?: () => number, hostname?: string, releaseOnExit?: boolean,
 *          onLost?: (info: {lockPath: string, reason: string, owner: object|null}) => void}} options
 * @returns {{token: string, path: string, record: object, takeover: boolean, staleFile: string|null,
 *            readonly held: boolean, release: () => boolean}}
 * @throws {Error} code YUI_DB_OWNER_HELD (dono vivo) ou YUI_DB_OWNER_HUNG (dono vivo sem batimento), com err.owner
 */
export function acquireOwnerLock(dbPath, {
  role,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  staleMs = DEFAULT_STALE_MS,
  queryProcess = defaultQueryProcess,
  now = Date.now,
  hostname = os.hostname(),
  releaseOnExit = true,
  onLost = null,
} = {}) {
  if (typeof role !== 'string' || !role.trim()) throw new TypeError('acquireOwnerLock: informe o papel (role) do processo dono.');
  if (!(heartbeatMs > 0) || !(staleMs > heartbeatMs)) throw new RangeError('acquireOwnerLock: staleMs precisa ser maior que heartbeatMs.');
  const lockPath = ownerLockPath(dbPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const record = {
    role: role.trim(),
    pid: process.pid,
    hostname,
    processStartMs: PROCESS_START_MS,
    acquiredAt: new Date(now()).toISOString(),
    token,
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;

  let takeover = false;
  let movedTo = null;
  if (!tryCreate(lockPath, content)) {
    const current = readLock(lockPath);
    if (!current) {
      // Sumiu entre a tentativa e a leitura (o dono acabou de liberar): uma única nova tentativa.
      if (!tryCreate(lockPath, content)) throw refuse(OWNER_HELD, lockPath, { owner: readLock(lockPath)?.record, reason: 'outro processo pegou a trava agora' });
    } else {
      const heartbeatAgeMs = Math.max(0, Math.round(now() - current.mtimeMs));
      const owner = current.record;
      if (heartbeatAgeMs < staleMs) {
        throw refuse(OWNER_HELD, lockPath, { owner, heartbeatAgeMs, reason: current.record ? 'batimento recente' : 'trava recém-criada' });
      }
      // Batimento parado: decide se o dono registrado ainda existe.
      if (owner) {
        if (owner.hostname && owner.hostname !== hostname) {
          // Não dá para consultar processo de outra máquina: nunca retoma sozinho.
          throw refuse(OWNER_HUNG, lockPath, { owner, heartbeatAgeMs, reason: `a trava é da máquina ${owner.hostname}; confira e apague à mão se for sobra` });
        }
        let q;
        try { q = queryProcess(owner.pid) || {}; } catch { q = { alive: true, startMs: null }; }
        if (q.alive) {
          if (!Number.isFinite(q.startMs)) {
            throw refuse(OWNER_HUNG, lockPath, { owner, heartbeatAgeMs, reason: 'processo vivo e hora de início indisponível (sem prova de PID reaproveitado)' });
          }
          if (!Number.isFinite(owner.processStartMs) || Math.abs(q.startMs - owner.processStartMs) <= START_TOLERANCE_MS) {
            throw refuse(OWNER_HUNG, lockPath, { owner, heartbeatAgeMs, reason: 'mesmo PID e mesma hora de início, batimento parado' });
          }
          // Vivo com outra hora de início: o PID foi reaproveitado; o dono antigo morreu.
        }
      }
      // Retomada atômica, um processo por vez (mutex `.owner.takeover` criado com 'wx').
      const result = withTakeoverMutex(lockPath, now, () => takeOverStale(lockPath, current, content, { now, staleMs }));
      if (result.busy) throw refuse(OWNER_HELD, lockPath, { owner, heartbeatAgeMs, reason: 'outro processo está retomando esta trava agora' });
      movedTo = result.movedTo;
      takeover = result.takeover;
      if (takeover) {
        stats.takeovers += 1;
        conflict('takeover', lockPath, {
          reason: !owner ? 'trava ilegível e sem batimento' : 'dono antigo não existe mais (morto ou PID reaproveitado)',
          owner: publicOwner(owner), heartbeatAgeMs, staleFile: movedTo,
        });
      }
    }
  }
  stats.acquired += 1;

  let held = true;
  let misses = 0;
  let timer = null;
  let exitHook = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const markLost = (reason, owner) => {
    if (!held) return;
    held = false;
    stopTimer();
    if (exitHook) process.off('exit', exitHook);
    stats.lost += 1;
    conflict('lost', lockPath, { reason, owner: publicOwner(owner) });
    try { onLost?.({ lockPath, reason, owner: publicOwner(owner) }); } catch { /* o aviso não derruba o batimento */ }
  };
  const beat = () => {
    let current;
    try { current = readLock(lockPath); } catch { current = undefined; }
    if (current?.record?.token === token) {
      misses = 0;
      try { const t = new Date(now()); fs.utimesSync(lockPath, t, t); } catch { /* tenta de novo no próximo batimento */ }
      return;
    }
    if (current?.record) return markLost('a trava passou a ter outro token', current.record);
    // Arquivo sumido ou ilegível: tolera uma vez (pode ser uma retomada alheia sendo desfeita neste instante).
    misses += 1;
    if (misses >= 2) markLost(current ? 'trava ilegível' : 'arquivo da trava sumiu', null);
  };
  timer = setInterval(beat, heartbeatMs);
  timer.unref?.();

  const release = () => {
    if (!held) { stopTimer(); return false; }
    held = false;
    stopTimer();
    if (exitHook) process.off('exit', exitHook);
    let current;
    try { current = readLock(lockPath); } catch { current = null; }
    if (current?.record?.token !== token) return false; // não é mais nossa: não apaga a de ninguém
    try {
      fs.rmSync(lockPath, { force: true });
      stats.released += 1;
      return true;
    } catch {
      return false;
    }
  };
  // Saída normal do processo sem release(): solta a trava (rmSync é síncrono, cabe no 'exit').
  if (releaseOnExit) {
    exitHook = () => { release(); };
    process.on('exit', exitHook);
  }

  return {
    token,
    path: lockPath,
    record: publicOwner(record),
    takeover,
    staleFile: movedTo,
    get held() { return held; },
    release,
  };
}

/**
 * Situação da trava de um banco, sem mexer em nada (diagnóstico e relatório de saúde).
 * @returns {{path: string, exists: boolean, owner: object|null, corrupt: boolean, heartbeatAgeMs: number|null, stale: boolean|null}}
 */
export function inspectOwnerLock(dbPath, { now = Date.now, staleMs = DEFAULT_STALE_MS } = {}) {
  const lockPath = ownerLockPath(dbPath);
  const current = readLock(lockPath);
  if (!current) return { path: lockPath, exists: false, owner: null, corrupt: false, heartbeatAgeMs: null, stale: null };
  const heartbeatAgeMs = Math.max(0, Math.round(now() - current.mtimeMs));
  return {
    path: lockPath,
    exists: true,
    owner: publicOwner(current.record),
    corrupt: !current.record,
    heartbeatAgeMs,
    stale: heartbeatAgeMs >= staleMs,
  };
}

/** Contagens desde que o processo subiu (cópia). */
export function ownerLockStats() {
  return { ...stats, lastConflict: stats.lastConflict ? { ...stats.lastConflict } : null };
}
