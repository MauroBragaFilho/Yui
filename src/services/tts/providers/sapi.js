/**
 * Provedor SAPI (voz do Windows) para o TTS da Yui.
 *
 * Por que um processo RESIDENTE: subir o powershell.exe custa ~1 s (medido), mas
 * uma frase leva ~90 ms. Então um único PowerShell fica vivo lendo pedidos pelo
 * stdin e respondendo pelo stdout, e é encerrado após alguns minutos sem uso.
 *
 * Protocolo (uma linha por mensagem, ASCII):
 *   helper -> bot  `READY <nome da voz>`   quando está pronto  (ou `NOVOICE` e sai)
 *   bot -> helper  `<id> <base64 UTF-8 do texto>`
 *   helper -> bot  `<id> OK <base64 do PCM>`   PCM cru s16le estéreo 48 kHz, sem cabeçalho
 *               ou `<id> ERR <mensagem>`
 * O texto vai em base64: nenhum caractere do usuário chega ao interpretador do
 * PowerShell (sem risco de injeção, sem problema de acento no console). A voz e a
 * velocidade vão por variável de ambiente do filho, também como DADO (nunca
 * concatenadas no script, que é uma constante sem aspas duplas).
 *
 * Segurança do processo filho (T1b item 5):
 *  - caminho absoluto do powershell.exe; `spawn` com ARRAY de argumentos e sem shell;
 *  - ambiente MÍNIMO: o filho nunca recebe `process.env` (tem tokens do bot);
 *  - o stderr é drenado e jogado fora: nunca vai para log nem para erro;
 *  - a linha de resposta é limitada a 16 MB;
 *  - quando o stdin fecha (inclusive se o bot morrer à força) o helper sai sozinho.
 *
 * Erros próprios carregam SÓ `code` e uma mensagem fixa: SAPI_TIMEOUT, SAPI_EXIT,
 * SAPI_NOVOICE, SAPI_BAD_RESPONSE, SAPI_ERROR, SAPI_BAD_INPUT, SAPI_UNAVAILABLE e
 * ABORTED. Nunca a mensagem do filho nem o texto falado. Logs: só metadados.
 *
 * Sem efeito colateral ao importar: nenhum processo, timer ou log até alguém chamar
 * probe()/warmup()/synth().
 *
 * Piper e Edge (nuvem) ficaram para depois (T1b §1): este é o único provedor real
 * desta entrega. O contrato de provedor (name, local, probe, warmup, synth, dispose)
 * é o mesmo que eles usarão.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { getTtsConfig } from '../config.js';

export const SAPI_SAMPLE_RATE = 48000;
export const SAPI_CHANNELS = 2;

const MAX_LINE_BYTES = 16 * 1024 * 1024; // uma resposta maior que isso é lixo ou ataque
const MAX_TEXT_CHARS = 2000; // as frases do TTS têm no máx. ~160; isto é só um teto de sanidade
const MAX_PRE_READY_LINES = 10; // linhas estranhas toleradas antes do READY
const STOP_GRACE_MS = 3000; // quanto esperar o helper sair sozinho após fechar o stdin
const KILL_WAIT_MS = 1000; // e quanto esperar depois de matar
const NOVOICE_MEMORY_MS = 5 * 60_000; // sem voz instalada: não subir um PowerShell a cada pedido

const MESSAGES = {
  ABORTED: 'síntese abortada',
  SAPI_TIMEOUT: 'o SAPI não respondeu a tempo',
  SAPI_EXIT: 'o processo do SAPI terminou',
  SAPI_NOVOICE: 'nenhuma voz SAPI adequada está instalada',
  SAPI_BAD_RESPONSE: 'resposta inválida do processo do SAPI',
  SAPI_ERROR: 'o SAPI recusou o texto',
  SAPI_BAD_INPUT: 'texto inválido para o SAPI',
  SAPI_UNAVAILABLE: 'o SAPI só existe no Windows',
  SAPI_BUSY: 'o processo do SAPI já está ocupado',
};

function sapiError(code) {
  const err = new Error(MESSAGES[code] || code);
  err.code = code;
  err.provider = 'sapi';
  return err;
}

function abortedError() {
  const err = sapiError('ABORTED');
  err.name = 'AbortError';
  return err;
}

/**
 * Script do helper. Constante, SEM aspas duplas (o Node as escapa na linha de
 * comando do Windows e o PowerShell as mastiga). Evita `-File` (política de
 * execução) e `-EncodedCommand` (sinal clássico para antivírus).
 * Referência testada: sapi-helper-test.mjs de 2026-10-14.
 */
export const SAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "$want = [Environment]::GetEnvironmentVariable('YUI_SAPI_VOICE')",
  '$all = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })',
  '$v = $null',
  'if ($want) {',
  '  $v = $all | Where-Object { $_.VoiceInfo.Name -eq $want } | Select-Object -First 1',
  '  if ($null -eq $v) { $v = $all | Where-Object { $_.VoiceInfo.Name.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1 }',
  '} else {',
  "  $v = $all | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1",
  '}',
  "if ($null -eq $v) { [Console]::Out.WriteLine('NOVOICE'); [Console]::Out.Flush(); exit 2 }",
  '$s.SelectVoice($v.VoiceInfo.Name)',
  '$r = 0',
  "[void][int]::TryParse([Environment]::GetEnvironmentVariable('YUI_SAPI_RATE'), [ref]$r)",
  '$s.Rate = [Math]::Max(-10, [Math]::Min(10, $r))',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Stereo)',
  "[Console]::Out.WriteLine('READY ' + $v.VoiceInfo.Name)",
  '[Console]::Out.Flush()',
  // Laço: termina sozinho quando o stdin fecha (ReadLine devolve $null).
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  "  $id = '?'",
  '  try {',
  "    $p = $line.Trim().Split(' ')",
  '    $id = $p[0]',
  '    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))',
  '    $ms = New-Object System.IO.MemoryStream',
  '    $s.SetOutputToAudioStream($ms, $fmt)',
  '    $s.Speak($text)',
  '    $s.SetOutputToNull()',
  "    [Console]::Out.WriteLine($id + ' OK ' + [Convert]::ToBase64String($ms.ToArray()))",
  '    $ms.Dispose()',
  '  } catch {',
  '    try { $s.SetOutputToNull() } catch { }',
  "    [Console]::Out.WriteLine($id + ' ERR ' + ($_.Exception.Message -replace '\\s+', ' '))",
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

// ── Ambiente e caminhos do processo filho ─────────────────────────────

/** Lê uma variável sem diferenciar maiúsculas (no Windows `process.env` já não diferencia; um objeto de teste sim). */
function pickEnv(env, name) {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

function systemRootOf(env) {
  return pickEnv(env, 'SystemRoot') || pickEnv(env, 'windir') || 'C:\\Windows';
}

/** Caminho ABSOLUTO do powershell.exe (nada de procurar no PATH). */
export function getPowerShellPath(env = process.env) {
  return path.win32.join(systemRootOf(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Ambiente mínimo do filho. NUNCA repassa o ambiente do bot (tem DISCORD_TOKEN e
 * chaves de API). Só o que o PowerShell precisa para subir, mais a voz e a
 * velocidade como dados.
 */
export function buildHelperEnv(env = process.env, { voice = '', rate = 0 } = {}) {
  const root = systemRootOf(env);
  const tmp = pickEnv(env, 'TEMP') || pickEnv(env, 'TMP') || path.win32.join(root, 'Temp');
  const safeRate = Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)));
  return {
    SystemRoot: root,
    windir: pickEnv(env, 'windir') || root,
    PATH: path.win32.join(root, 'System32'),
    TEMP: tmp,
    TMP: tmp,
    YUI_SAPI_VOICE: String(voice || ''),
    YUI_SAPI_RATE: String(safeRate),
  };
}

// ── Utilidades ────────────────────────────────────────────────────────

const noop = () => {};

/** Logger do projeto carregado só no primeiro uso (importar este módulo não cria pasta de logs). */
function lazyProjectLogger() {
  let loaded = null;
  const make = (level) => (message) => {
    loaded ??= import('../../../utils/logger.js').then((m) => m.logger);
    loaded.then((l) => l[level](message)).catch(noop);
  };
  return { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') };
}

/** Texto seguro para o sintetizador: sem controle, sem marcação, uma linha só. */
function sanitizeText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome da voz vindo do filho: só para o log; limpa e curta. */
function cleanVoiceName(text) {
  return String(text).replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 64);
}

/** Espera a promessa, mas desiste (ABORTED) se o signal disparar. A promessa original continua. */
function untilOrAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

// ── Um processo helper ────────────────────────────────────────────────

/**
 * Encapsula UM processo PowerShell e o protocolo de linhas. Não sabe de fila,
 * reinício nem inatividade (isso é do provedor). Atende um pedido por vez.
 */
function createHelper({ spawnImpl, exe, args, spawnOptions, timers, readyTimeoutMs }) {
  let proc = null;
  let dead = false; // inutilizável (morreu, travou, foi encerrado)
  let gone = false; // o processo realmente saiu (evento exit/error)
  let ready = false;
  let voiceName = '';
  let served = 0;
  let current = null; // { id, resolve, reject, timer, abandoned, cleanup }
  let readyTimer = null;
  let preReadyLines = 0;
  const parts = [];
  let partsLen = 0;
  const idleWaiters = [];
  const exitWaiters = [];

  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  readyPromise.catch(noop); // ninguém é obrigado a esperar o READY; sem isto seria "unhandled rejection"

  const startTimer = (fn, ms) => {
    const t = timers.setTimeout(fn, ms);
    t?.unref?.();
    return t;
  };

  function flushIdle() {
    if (current !== null && !dead) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  /** Rejeita o que estiver pendente. Um pedido já abandonado (abort) não tem a quem avisar. */
  function rejectPending(err) {
    readyReject(err); // no-op se já foi resolvida
    if (current) {
      const c = current;
      current = null;
      if (c.timer !== null) timers.clearTimeout(c.timer);
      c.cleanup?.();
      if (!c.abandoned) c.reject(err);
    }
  }

  function killQuietly() {
    try { proc?.kill(); } catch { /* já morreu */ }
    try { proc?.stdin?.destroy(); } catch { /* idem */ }
  }

  /** Helper inutilizável a partir daqui. Idempotente. */
  function die(err, { kill = true } = {}) {
    if (dead) return;
    dead = true;
    if (readyTimer !== null) timers.clearTimeout(readyTimer);
    readyTimer = null;
    rejectPending(err);
    if (kill) killQuietly();
    flushIdle();
  }

  function onGone() {
    if (gone) return;
    gone = true;
    die(sapiError('SAPI_EXIT'), { kill: false });
    for (const done of exitWaiters.splice(0)) done();
  }

  // ── leitura das linhas ──
  function handleStartLine(view) {
    const head = view.toString('latin1', 0, Math.min(view.length, 200));
    if (head.startsWith('READY')) {
      ready = true;
      voiceName = cleanVoiceName(head.slice(5));
      if (readyTimer !== null) timers.clearTimeout(readyTimer);
      readyTimer = null;
      readyResolve(voiceName);
      return;
    }
    if (head === 'NOVOICE') {
      die(sapiError('SAPI_NOVOICE'));
      return;
    }
    // Linha estranha antes do READY (aviso do PowerShell, por exemplo): tolera algumas.
    if (++preReadyLines > MAX_PRE_READY_LINES) die(sapiError('SAPI_BAD_RESPONSE'));
  }

  function handleReply(view) {
    const sp1 = view.indexOf(0x20);
    if (sp1 < 1 || !current) {
      die(sapiError('SAPI_BAD_RESPONSE')); // linha sem formato, ou resposta sem pedido
      return;
    }
    const id = view.toString('latin1', 0, sp1);
    if (id !== current.id) {
      die(sapiError('SAPI_BAD_RESPONSE')); // protocolo dessincronizado: melhor recomeçar
      return;
    }
    const sp2 = view.indexOf(0x20, sp1 + 1);
    const status = view.toString('latin1', sp1 + 1, sp2 === -1 ? view.length : sp2);

    const c = current;
    current = null;
    if (c.timer !== null) timers.clearTimeout(c.timer);
    c.cleanup?.();
    served++;

    let error = null;
    let pcm = null;
    if (status === 'OK') {
      pcm = sp2 === -1 ? Buffer.alloc(0) : Buffer.from(view.toString('latin1', sp2 + 1), 'base64');
      if (pcm.length % 4 !== 0) error = sapiError('SAPI_BAD_RESPONSE'); // 16 bits x 2 canais
    } else if (status === 'ERR') {
      error = sapiError('SAPI_ERROR'); // a mensagem do filho é descartada de propósito
    } else {
      error = sapiError('SAPI_BAD_RESPONSE');
    }
    if (!c.abandoned) {
      if (error) c.reject(error);
      else c.resolve(pcm);
    }
    flushIdle();
  }

  function onLine(line) {
    if (line.length > MAX_LINE_BYTES) {
      die(sapiError('SAPI_BAD_RESPONSE'));
      return;
    }
    const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length; // CRLF
    const view = line.subarray(0, end);
    if (!ready) handleStartLine(view);
    else handleReply(view);
  }

  function onData(chunk) {
    if (dead) return;
    if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'latin1');
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        // Linha ainda incompleta: guarda os pedaços e confere o teto sem juntar nada.
        parts.push(chunk.subarray(start));
        partsLen += chunk.length - start;
        if (partsLen > MAX_LINE_BYTES) die(sapiError('SAPI_BAD_RESPONSE'));
        return;
      }
      parts.push(chunk.subarray(start, nl));
      partsLen += nl - start;
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLen);
      parts.length = 0;
      partsLen = 0;
      start = nl + 1;
      onLine(line);
      if (dead) return;
    }
  }

  // ── subida do processo ──
  try {
    proc = spawnImpl(exe, args, spawnOptions);
    proc.on('error', onGone); // ENOENT etc.
    proc.on('exit', onGone);
    proc.on('close', onGone);
    proc.stdout.on('data', onData);
    proc.stdout.on('error', noop);
    // stderr: drenado e descartado. Se ninguém ler, o pipe enche e o helper trava;
    // e nada do que ele escreve pode ir para log ou erro (pode conter o texto).
    proc.stderr.on('data', noop);
    proc.stderr.on('error', noop);
    proc.stdin.on('error', () => die(sapiError('SAPI_EXIT')));
    readyTimer = startTimer(() => die(sapiError('SAPI_TIMEOUT')), readyTimeoutMs);
  } catch {
    gone = true;
    die(sapiError('SAPI_EXIT'), { kill: false });
  }

  return {
    ready: readyPromise,
    isAlive: () => !dead,
    get served() { return served; },
    get pid() { return proc?.pid ?? null; },
    get voice() { return voiceName; },

    /** Resolve quando não há pedido em andamento (nem um abandonado esperando a resposta). */
    whenIdle() {
      if (dead || current === null) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    /** Envia um pedido e espera o PCM cru. Um por vez (o provedor serializa). */
    request(id, base64Text, { timeoutMs, signal }) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortedError());
        if (dead || !ready) return reject(sapiError('SAPI_EXIT'));
        if (current) return reject(sapiError('SAPI_BUSY'));

        const c = { id, resolve, reject, timer: null, abandoned: false, cleanup: null };
        current = c;
        // Não dá para cancelar um Speak em curso: helper travado é morto e a próxima chamada sobe outro.
        c.timer = startTimer(() => {
          if (current === c) die(sapiError('SAPI_TIMEOUT'));
        }, timeoutMs);
        if (signal) {
          const onAbort = () => {
            if (c.abandoned || current !== c) return;
            c.abandoned = true; // a resposta ainda chega e é descartada; o helper segue vivo
            reject(abortedError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
          c.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        try {
          proc.stdin.write(`${id} ${base64Text}\n`);
        } catch {
          die(sapiError('SAPI_EXIT'));
        }
      });
    },

    /** Encerra com educação: fecha o stdin (o helper sai no EOF) e só mata se demorar. */
    shutdown(graceMs = STOP_GRACE_MS) {
      die(abortedError(), { kill: false });
      try { proc?.stdin?.end(); } catch { /* já fechado */ }
      return new Promise((resolve) => {
        if (gone || !proc) return resolve();
        let t1 = null;
        let t2 = null;
        const done = () => {
          if (t1 !== null) timers.clearTimeout(t1);
          if (t2 !== null) timers.clearTimeout(t2);
          resolve();
        };
        exitWaiters.push(done);
        t1 = startTimer(() => {
          killQuietly();
          t2 = startTimer(done, KILL_WAIT_MS);
        }, graceMs);
      });
    },
  };
}

// ── Provedor ──────────────────────────────────────────────────────────

/**
 * @param {object} [o]
 * @param {function} [o.spawn]   child_process.spawn (injetável nos testes).
 * @param {object}   [o.config]  getTtsConfig(); campos usados: sapiVoice, sapiRate, sapiTimeoutMs, sapiColdTimeoutMs, idleMinutes.
 * @param {object}   [o.logger]  { info, warn, error, debug }; padrão: o logger do projeto.
 * @param {function} [o.now]     relógio em ms (só para medir duração nos logs).
 * @param {object}   [o.env]     ambiente de onde sai SystemRoot/TEMP (nunca é repassado inteiro ao filho).
 * @param {string}   [o.platform] process.platform (injetável nos testes).
 * @param {object}   [o.timers]  { setTimeout, clearTimeout } (relógio falso nos testes).
 */
export function createSapiProvider({
  spawn = nodeSpawn,
  config,
  logger,
  now = () => Date.now(),
  env = process.env,
  platform = process.platform,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const cfg = config || getTtsConfig(env);
  const log = logger || lazyProjectLogger();
  const exe = getPowerShellPath(env);
  const idleMs = Math.max(1, cfg.idleMinutes) * 60_000;

  let helper = null;
  let disposed = false;
  let disposing = null;
  let idleTimer = null;
  let noVoiceUntil = 0;
  let seq = 0;
  let inflight = 0; // tarefas na fila (em execução ou esperando)
  let queueTail = Promise.resolve();

  // ── ciclo de vida do helper ──
  function clearIdle() {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (disposed || !helper) return;
    idleTimer = timers.setTimeout(onIdle, idleMs);
    idleTimer?.unref?.(); // o relógio de inatividade nunca segura o processo do bot
  }

  function onIdle() {
    idleTimer = null;
    const h = helper;
    if (!h) return;
    if (inflight > 0) {
      armIdle(); // apareceu trabalho: tenta de novo mais tarde
      return;
    }
    helper = null;
    log.info('[TTS][SAPI] helper encerrado por inatividade');
    h.shutdown(STOP_GRACE_MS).catch(noop);
  }

  function startHelper() {
    const t0 = now();
    const h = createHelper({
      spawnImpl: spawn,
      exe,
      args: ['-NoProfile', '-NonInteractive', '-Command', SAPI_SCRIPT],
      spawnOptions: {
        env: buildHelperEnv(env, { voice: cfg.sapiVoice, rate: cfg.sapiRate }),
        cwd: path.win32.join(systemRootOf(env), 'System32'), // não prende nenhuma pasta do projeto
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      timers,
      readyTimeoutMs: cfg.sapiColdTimeoutMs,
    });
    h.ready.then(
      (name) => log.info(`[TTS][SAPI] helper pronto em ${now() - t0} ms (voz: ${name || 'desconhecida'})`),
      (err) => log.warn(`[TTS][SAPI] helper não ficou pronto (${err?.code || 'erro'}) após ${now() - t0} ms`)
    );
    return h;
  }

  /** Devolve um helper pronto e ocioso (sobe um se preciso). */
  async function acquire(signal) {
    if (disposed) throw sapiError('SAPI_EXIT');
    if (platform !== 'win32') throw sapiError('SAPI_UNAVAILABLE');
    if (noVoiceUntil > now()) throw sapiError('SAPI_NOVOICE');
    if (!helper || !helper.isAlive()) helper = startHelper();
    const h = helper;
    try {
      await untilOrAbort(h.ready, signal);
      await untilOrAbort(h.whenIdle(), signal); // uma resposta abandonada ainda pode estar chegando
    } catch (err) {
      if (err?.code === 'SAPI_NOVOICE') noVoiceUntil = now() + NOVOICE_MEMORY_MS;
      throw err;
    }
    if (!h.isAlive()) throw sapiError('SAPI_EXIT');
    clearIdle(); // em uso; o relógio de inatividade rearma quando a fila esvazia
    return h;
  }

  /**
   * Roda `fn(helper)` com UM reinício automático se o helper morrer no meio
   * (antivírus, kill manual, falha ao subir). Timeout, sem voz e abort não repetem.
   */
  async function withHelper(signal, fn) {
    let restarted = false;
    for (;;) {
      throwIfAborted(signal);
      try {
        return await fn(await acquire(signal));
      } catch (err) {
        if (err?.code === 'SAPI_EXIT' && !restarted && !disposed && !signal?.aborted) {
          restarted = true;
          log.warn('[TTS][SAPI] o helper terminou antes de responder; reiniciando uma vez');
          continue;
        }
        throw err;
      }
    }
  }

  /** Serializa as operações: o protocolo atende uma linha por vez. */
  function enqueue(task) {
    inflight++;
    const run = queueTail.then(task);
    queueTail = run.then(noop, noop).then(() => {
      inflight--;
      if (!disposed && helper?.isAlive()) armIdle();
    });
    return run;
  }

  async function requestOn(h, clean, signal) {
    // A 1ª frase depois de subir o helper carrega a voz e é bem mais lenta.
    const timeoutMs = h.served === 0 ? cfg.sapiColdTimeoutMs : cfg.sapiTimeoutMs;
    const t0 = now();
    const id = `r${++seq}`;
    const pcm = await h.request(id, Buffer.from(clean, 'utf8').toString('base64'), { timeoutMs, signal });
    log.debug?.(`[TTS][SAPI] síntese: ${clean.length} caracteres, ${pcm.length} bytes, ${now() - t0} ms`);
    return pcm;
  }

  return {
    name: 'sapi',
    local: true,

    /** Sobe o helper (se preciso) e confere que há voz. Não rejeita: devolve { ok, detail }. */
    async probe() {
      if (platform !== 'win32') return { ok: false, detail: MESSAGES.SAPI_UNAVAILABLE };
      try {
        const voice = await enqueue(() => withHelper(null, async (h) => h.voice));
        return { ok: true, detail: `voz ${voice || 'desconhecida'}` };
      } catch (err) {
        return { ok: false, detail: `${err?.code || 'SAPI_EXIT'}: ${err?.message || ''}`.trim() };
      }
    },

    /** Sobe o helper e faz uma síntese minúscula para carregar a voz. Nunca rejeita. */
    async warmup() {
      try {
        await enqueue(() => withHelper(null, (h) => requestOn(h, 'Olá.', null)));
      } catch (err) {
        log.warn(`[TTS][SAPI] aquecimento falhou (${err?.code || 'erro'})`);
      }
    },

    /**
     * @param {string} text
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ pcm: Buffer, sampleRate: 48000, channels: 2 }>} PCM CRU s16le (sem cabeçalho).
     */
    async synth(text, { signal } = {}) {
      throwIfAborted(signal);
      const clean = sanitizeText(text);
      if (!clean || clean.length > MAX_TEXT_CHARS) throw sapiError('SAPI_BAD_INPUT');
      const pcm = await untilOrAbort(
        enqueue(() => withHelper(signal, (h) => requestOn(h, clean, signal))),
        signal
      );
      return { pcm, sampleRate: SAPI_SAMPLE_RATE, channels: SAPI_CHANNELS };
    },

    /** Fecha o stdin do helper e espera ele sair (mata se passar de 3 s). Idempotente. */
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      clearIdle();
      const h = helper;
      helper = null;
      disposing = h ? h.shutdown(STOP_GRACE_MS).catch(noop) : Promise.resolve();
      return disposing;
    },

    /**
     * Quente = há um helper vivo que já respondeu a algum pedido. Depois de ficar parado o helper
     * é encerrado (idleMinutes) e a próxima fala paga a partida a frio de novo; o motor consulta
     * isto para dar o prazo certo (frio ou quente) a CADA síntese, e não só na primeira da vida.
     */
    isWarm() {
      return Boolean(helper && helper.isAlive() && helper.served > 0);
    },

    /** Diagnóstico (não faz parte do contrato do motor): estado do helper, sem texto. */
    getInfo() {
      return {
        running: Boolean(helper?.isAlive()),
        pid: helper?.pid ?? null,
        voice: helper?.voice || null,
        served: helper?.served ?? 0,
      };
    },
  };
}
