import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(__dirname, '../../');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const IS_WIN = process.platform === 'win32';
const PLATFORM_DIR = path.join(BIN_DIR, IS_WIN ? 'windows' : 'linux');

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Faz download de uma URL seguindo redirecionamentos (HTTP 301/302)
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    ensureDirExists(path.dirname(destPath));
    const tempPath = `${destPath}.tmp_${Date.now()}`;
    const file = fs.createWriteStream(tempPath);

    const makeRequest = (targetUrl) => {
      const client = targetUrl.startsWith('https') ? https : http;
      client.get(targetUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return makeRequest(response.headers.location);
        }

        if (response.statusCode !== 200) {
          file.close();
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
          return reject(new Error(`Download falhou com status code: ${response.statusCode}`));
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            try {
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
              fs.renameSync(tempPath, destPath);
              if (!IS_WIN) {
                try { fs.chmodSync(destPath, 0o755); } catch (_) {}
              }
              resolve(destPath);
            } catch (err) {
              reject(err);
            }
          });
        });
      }).on('error', (err) => {
        file.close();
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        reject(err);
      });
    };

    makeRequest(url);
  });
}

function checkExecutable(cmd) {
  return new Promise((resolve) => {
    // Sem shell: o nome do binário (pode vir de variável de ambiente) vai como argumento, nunca concatenado.
    const [file, args] = IS_WIN
      ? ['where', [cmd]]
      : ['sh', ['-c', 'command -v "$1"', 'sh', cmd]];
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (!error && stdout && stdout.trim()) {
        resolve(stdout.trim().split(/\r?\n/)[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Obtém o caminho resolvido para yt-dlp
 */
export function getYtdlpPath() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return process.env.YTDLP_PATH;
  }

  const binaryName = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
  const localPlatformPath = path.join(PLATFORM_DIR, binaryName);
  if (fs.existsSync(localPlatformPath)) return localPlatformPath;

  const dataPath = path.join(ROOT_DIR, 'src/data', binaryName);
  if (fs.existsSync(dataPath)) return dataPath;

  return binaryName;
}

/**
 * Obtém o caminho resolvido para ffmpeg
 */
export function getFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  const binaryName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const localPlatformPath = path.join(PLATFORM_DIR, binaryName);
  if (fs.existsSync(localPlatformPath)) return localPlatformPath;

  const dataPath = path.join(ROOT_DIR, 'src/data', binaryName);
  if (fs.existsSync(dataPath)) return dataPath;

  return binaryName;
}

/**
 * Obtém o caminho resolvido para ffprobe
 */
export function getFfprobePath() {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return process.env.FFPROBE_PATH;
  }

  const binaryName = IS_WIN ? 'ffprobe.exe' : 'ffprobe';
  const localPlatformPath = path.join(PLATFORM_DIR, binaryName);
  if (fs.existsSync(localPlatformPath)) return localPlatformPath;

  const dataPath = path.join(ROOT_DIR, 'src/data', binaryName);
  if (fs.existsSync(dataPath)) return dataPath;

  return binaryName;
}

/**
 * Garante que o yt-dlp está presente, baixando se necessário
 */
export async function ensureYtdlp() {
  const currentPath = getYtdlpPath();
  if (fs.existsSync(currentPath)) {
    if (!IS_WIN) {
      try { fs.chmodSync(currentPath, 0o755); } catch (_) {}
    }
    return currentPath;
  }

  const globalPath = await checkExecutable('yt-dlp');
  if (globalPath) return globalPath;

  logger.info('[MediaTools] 📥 yt-dlp não encontrado. Iniciando download automático da release oficial...');
  ensureDirExists(PLATFORM_DIR);

  const binaryName = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
  const destPath = path.join(PLATFORM_DIR, binaryName);
  const downloadUrl = IS_WIN
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  try {
    await downloadFile(downloadUrl, destPath);
    logger.info(`[MediaTools] ✅ yt-dlp instalado com sucesso em: ${destPath}`);
    return destPath;
  } catch (err) {
    logger.error(`[MediaTools] ❌ Falha ao baixar yt-dlp automaticamente: ${err.message}`);
    return null;
  }
}

/**
 * Garante que FFmpeg e FFprobe estão presentes, baixando builds estáticas se necessário
 */
export async function ensureFfmpeg() {
  const currentFfmpeg = getFfmpegPath();
  if (fs.existsSync(currentFfmpeg) || (await checkExecutable(currentFfmpeg))) {
    if (!IS_WIN && fs.existsSync(currentFfmpeg)) {
      try { fs.chmodSync(currentFfmpeg, 0o755); } catch (_) {}
    }
    return currentFfmpeg;
  }

  ensureDirExists(PLATFORM_DIR);

  if (!IS_WIN) {
    logger.info('[MediaTools] 📥 FFmpeg não encontrado no Linux. Baixando build estática John Van Sickle...');
    const tarGzPath = path.join(PLATFORM_DIR, 'ffmpeg-release-amd64-static.tar.xz');
    const downloadUrl = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

    try {
      await downloadFile(downloadUrl, tarGzPath);
      logger.info('[MediaTools] 📦 Extraindo binários do FFmpeg/FFprobe...');

      // Extrai os binários ffmpeg e ffprobe do tar.xz usando tar nativo do Linux
      await new Promise((resolve, reject) => {
        exec(`tar -xJf "${tarGzPath}" --wildcards --strip-components=1 -C "${PLATFORM_DIR}" "*/ffmpeg" "*/ffprobe"`, (err) => {
          try { if (fs.existsSync(tarGzPath)) fs.unlinkSync(tarGzPath); } catch (_) {}
          if (err) return reject(err);
          resolve();
        });
      });

      const ffmpegBin = path.join(PLATFORM_DIR, 'ffmpeg');
      const ffprobeBin = path.join(PLATFORM_DIR, 'ffprobe');
      if (fs.existsSync(ffmpegBin)) fs.chmodSync(ffmpegBin, 0o755);
      if (fs.existsSync(ffprobeBin)) fs.chmodSync(ffprobeBin, 0o755);

      logger.info(`[MediaTools] ✅ FFmpeg e FFprobe instalados com sucesso em: ${PLATFORM_DIR}`);
      return ffmpegBin;
    } catch (err) {
      logger.error(`[MediaTools] ❌ Falha ao baixar build estática do FFmpeg para Linux: ${err.message}`);
      return null;
    }
  }

  return null;
}

const YTDLP_UPDATE_TIMEOUT_MS = 120_000;

/**
 * Atualiza o yt-dlp se disponível (`yt-dlp -U`). Nunca lança: falha só vira aviso no log.
 * Usa execFile (sem shell), com timeout.
 * @param {object} [o]
 * @param {function} [o.execFileImpl] injetável para teste
 * @param {number}   [o.timeoutMs]
 * @param {string}   [o.binary]
 * @returns {Promise<boolean>} true se o comando terminou sem erro
 */
export async function updateYtdlp({ execFileImpl = execFile, timeoutMs = YTDLP_UPDATE_TIMEOUT_MS, binary = getYtdlpPath() } = {}) {
  return new Promise((resolve) => {
    logger.info(`[MediaTools] Verificando atualizações do yt-dlp (${binary})...`);
    try {
      execFileImpl(
        binary,
        ['-U'],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || '').trim().split(/\r?\n/)[0] || error.message;
            logger.warn(`[MediaTools] Atualização de yt-dlp: ${detail}`);
            resolve(false);
          } else {
            logger.info(`[MediaTools] yt-dlp atualizado/verificado: ${String(stdout || '').trim().split(/\r?\n/)[0]}`);
            resolve(true);
          }
        }
      );
    } catch (err) {
      logger.warn(`[MediaTools] Atualização de yt-dlp: ${err.message}`);
      resolve(false);
    }
  });
}

let ytdlpAutoUpdate = null;

/**
 * Atualiza o yt-dlp em segundo plano: uma vez logo depois da inicialização (sem
 * bloquear o boot) e, depois, uma vez por dia no primeiro momento a partir de
 * YTDLP_UPDATE_HOUR (padrão 04h, horário de pouco uso). Os temporizadores usam
 * `unref()` e qualquer falha vira só `logger.warn`.
 *
 * Env: YTDLP_AUTO_UPDATE=false desliga; YTDLP_UPDATE_HOUR=0-23.
 * @returns {{ stop: function }}
 */
export function startYtdlpAutoUpdate({
  env = process.env,
  updater = updateYtdlp,
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
  startupDelayMs = 30_000,
  checkEveryMs = 30 * 60 * 1000,
} = {}) {
  if (ytdlpAutoUpdate) return ytdlpAutoUpdate;
  if (String(env.YTDLP_AUTO_UPDATE ?? 'true').toLowerCase() === 'false') {
    logger.info('[MediaTools] Atualização automática do yt-dlp desligada (YTDLP_AUTO_UPDATE=false).');
    return { stop() {} };
  }

  const parsedHour = Number.parseInt(env.YTDLP_UPDATE_HOUR ?? '', 10);
  const hour = Number.isInteger(parsedHour) && parsedHour >= 0 && parsedHour <= 23 ? parsedHour : 4;
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let lastDay = null;
  let running = false;

  const run = async (motivo) => {
    if (running) return;
    running = true;
    try {
      logger.info(`[MediaTools] Atualização do yt-dlp em segundo plano (${motivo}).`);
      await updater();
    } catch (err) {
      logger.warn(`[MediaTools] Atualização do yt-dlp falhou (${motivo}): ${err.message}`);
    } finally {
      running = false;
    }
  };

  const startupTimer = setTimeoutImpl(() => {
    lastDay = dayKey(now());
    run('inicialização');
  }, startupDelayMs);
  startupTimer?.unref?.();

  const dailyTimer = setIntervalImpl(() => {
    const d = now();
    if (d.getHours() >= hour && lastDay !== dayKey(d)) {
      lastDay = dayKey(d);
      run('diária');
    }
  }, checkEveryMs);
  dailyTimer?.unref?.();

  ytdlpAutoUpdate = {
    stop() {
      clearTimeoutImpl(startupTimer);
      clearIntervalImpl(dailyTimer);
      ytdlpAutoUpdate = null;
    },
  };
  return ytdlpAutoUpdate;
}

// ── Voz: Opus e criptografia ──────────────────────────────────────────

let opusVerified = false; // só guarda o resultado POSITIVO (quem instalar o Opus depois é notado na próxima checagem)

/**
 * Tenta criar um Encoder e um Decoder do prism-media (é isso que o @discordjs/voice
 * faz na primeira fala/música). Nunca lança.
 * @param {object} [o]
 * @param {object} [o.prismImpl] módulo prism-media (injetável para teste)
 * @returns {{ ok: boolean, backend: string|null, error: string|null }}
 */
export function checkOpus({ prismImpl = null } = {}) {
  let encoder = null;
  let decoder = null;
  try {
    const prism = prismImpl || require('prism-media');
    const opts = { rate: 48000, channels: 2, frameSize: 960 };
    encoder = new prism.opus.Encoder(opts);
    decoder = new prism.opus.Decoder(opts);
    const backend = prism.opus.Encoder.type || 'desconhecido';
    if (!prismImpl) opusVerified = true;
    return { ok: true, backend: String(backend), error: null };
  } catch (err) {
    const line = String(err?.message ?? err).split(/\r?\n/).find((l) => l.trim()) || 'erro desconhecido';
    return { ok: false, backend: null, error: line.trim().slice(0, 200) };
  } finally {
    for (const s of [encoder, decoder]) {
      try { s?.destroy?.(); } catch (_) {}
    }
  }
}

/** true se o codificador/decodificador Opus está utilizável (voz e rádio dependem disso). */
export function isOpusAvailable(options = {}) {
  if (!options.prismImpl && opusVerified) return true;
  return checkOpus(options).ok;
}

/**
 * Lê o texto de generateDependencyReport() do @discordjs/voice e resume o que importa.
 * @returns {{ aesGcm: boolean, cryptoLibs: string[], opusLibs: string[], dave: string|null, cryptoOk: boolean }}
 */
export function parseDependencyReport(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-{5,}$/.test(line)) continue;
    if (!line.startsWith('- ')) {
      current = line;
      sections[current] = {};
      continue;
    }
    const m = /^-\s+(.+?):\s*(.*)$/.exec(line);
    if (m && current) sections[current][m[1]] = m[2];
  }
  const found = (v) => v !== undefined && !/^(not found|no)$/i.test(String(v).trim());
  const enc = sections['Encryption Libraries'] || {};
  const opus = sections['Opus Libraries'] || {};
  const dave = sections['DAVE Libraries'] || {};
  const aesGcm = /^yes$/i.test(String(enc['native crypto support for aes-256-gcm'] ?? '').trim());
  const cryptoLibs = Object.keys(enc).filter((k) => !k.startsWith('native crypto') && found(enc[k]));
  const opusLibs = Object.keys(opus).filter((k) => found(opus[k]));
  const daveName = Object.keys(dave).find((k) => found(dave[k]));
  return {
    aesGcm,
    cryptoLibs,
    opusLibs,
    dave: daveName ? `${daveName} ${dave[daveName]}` : null,
    cryptoOk: aesGcm || cryptoLibs.length > 0,
  };
}

/** Diagnóstico das dependências de voz (criptografia e DAVE). Nunca lança. */
export async function checkVoiceDependencies({ importVoice = () => import('@discordjs/voice') } = {}) {
  try {
    const voice = await importVoice();
    return { ok: true, ...parseDependencyReport(voice.generateDependencyReport()) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).split(/\r?\n/)[0].slice(0, 200) };
  }
}

// ── Ferramentas opcionais em Python (deemix e spotdl) ──

/**
 * PONTO DE EXTENSÃO: cada item é { key, label, hint, check }. Para acrescentar outra ferramenta basta incluir mais um item
 * aqui (o log "[MediaTools] <label>: OK|FALTANDO" e o campo de retorno de validateMediaTools saem sozinhos).
 * `check(options)` roda SEM rede e SEM login e devolve { ok, code?, message? }; se lançar, vira "FALTANDO".
 */
export const OPTIONAL_PYTHON_TOOLS = [
  {
    key: 'deemix',
    label: 'Deemix',
    hint: 'Instale com: pip install -r requirements-deemix.txt e defina PYTHON_PATH. Sem ele, os downloads do Deezer usam o plano B (YouTube).',
    // Import dinâmico: o serviço do Deezer carrega o .env (dotenv) ao ser importado e este módulo não deve ganhar esse efeito.
    // `log: false` porque quem registra a linha "[MediaTools] Deemix: ..." é checkOptionalPythonTools; o timeout limita o atraso no boot.
    check: async (options = {}) => {
      const { getDeemixStatus } = await import('../services/deezerMusicService.js');
      return getDeemixStatus({ timeoutMs: 30_000, ...options, log: false }); // 30 s: o 1º import do Python depois de um boot do Windows passa de 12 s
    },
  },
  {
    key: 'spotdl',
    label: 'Spotdl',
    hint: 'Instale o spotdl no ambiente .venv-spotdl da raiz do projeto, aponte SPOTDL_PATH para o spotdl.exe ou deixe-o no PATH. Sem ele, os links de faixa do Spotify caem no yt-dlp, que não baixa áudio do Spotify: o pedido falha com aviso.',
    // Síncrono, sem rede e sem rodar o spotdl: só confere se o ARQUIVO existe (.venv-spotdl, SPOTDL_PATH ou PATH).
    // Import dinâmico, como o do deemix: o boot só carrega o módulo do spotdl aqui.
    // `options` (env, exists, rootDir, isWin) só existe para teste: no boot chega vazio e vale o ambiente real.
    check: async (options = {}) => {
      const { checkSpotdl } = await import('./spotdlTools.js');
      return checkSpotdl(options);
    },
  },
];

/**
 * Verifica as ferramentas Python opcionais e registra uma linha por ferramenta. Nunca lança e nunca derruba o boot.
 * @param {object} [o]
 * @param {Array}  [o.tools]   padrão: OPTIONAL_PYTHON_TOOLS
 * @param {object} [o.options] opções repassadas a cada check, por chave (ex.: { deemix: { execFileImpl } }); para teste
 * @param {object} [o.log]     { info, warn }; para teste
 * @returns {Promise<Record<string, { ok: boolean, code: string|null, message: string }>>}
 */
export async function checkOptionalPythonTools({ tools = OPTIONAL_PYTHON_TOOLS, options = {}, log = logger } = {}) {
  const results = {};
  for (const tool of tools) {
    let status;
    try {
      status = await tool.check(options[tool.key] || {});
    } catch (err) {
      status = { ok: false, code: 'CHECK_ERROR', message: String(err?.message ?? err).split(/\r?\n/)[0].slice(0, 200) };
    }
    const ok = Boolean(status && status.ok);
    results[tool.key] = { ok, code: ok ? null : (status?.code ?? 'UNKNOWN'), message: String(status?.message ?? '') };
    if (ok) {
      log.info(`[MediaTools] ${tool.label}: OK${results[tool.key].message ? ` (${results[tool.key].message})` : ''}`);
    } else {
      log.warn(`[MediaTools] ${tool.label}: FALTANDO (${results[tool.key].code}). ${tool.hint}`);
    }
  }
  return results;
}

/**
 * Validação e auto-instalação não-bloqueante de ferramentas de mídia durante o startup
 */
export async function validateMediaTools() {
  logger.info('[MediaTools] Verificando e garantindo ferramentas de áudio/vídeo...');

  let ytdlpOk = false;
  let ffmpegOk = false;
  let ffprobeOk = false;

  // 1. Validar e auto-instalar yt-dlp
  try {
    const ytdlp = await ensureYtdlp();
    if (ytdlp) {
      ytdlpOk = true;
      logger.info(`[MediaTools] yt-dlp: OK (${ytdlp})`);
    } else {
      logger.warn('[MediaTools] ⚠️ yt-dlp: Não disponível.');
    }
  } catch (err) {
    logger.warn(`[MediaTools] ⚠️ Erro ao verificar yt-dlp: ${err.message}`);
  }

  // 2. Validar e auto-instalar ffmpeg
  try {
    const ffmpeg = await ensureFfmpeg();
    if (ffmpeg) {
      ffmpegOk = true;
      logger.info(`[MediaTools] ffmpeg: OK (${ffmpeg})`);
    } else {
      const ffmpegCmd = getFfmpegPath();
      if (fs.existsSync(ffmpegCmd) || (await checkExecutable(ffmpegCmd))) {
        ffmpegOk = true;
        logger.info(`[MediaTools] ffmpeg: OK (${ffmpegCmd})`);
      } else {
        logger.warn('[MediaTools] ⚠️ ffmpeg: Não encontrado no sistema nem em bin/ (funções de conversão/rádio podem falhar).');
      }
    }
  } catch (err) {
    logger.warn(`[MediaTools] ⚠️ Erro ao verificar ffmpeg: ${err.message}`);
  }

  // 3. Validar ffprobe
  const ffprobeCmd = getFfprobePath();
  if (fs.existsSync(ffprobeCmd) || (await checkExecutable(ffprobeCmd))) {
    ffprobeOk = true;
    if (!IS_WIN && fs.existsSync(ffprobeCmd)) {
      try { fs.chmodSync(ffprobeCmd, 0o755); } catch (_) {}
    }
    logger.info(`[MediaTools] ffprobe: OK (${ffprobeCmd})`);
  } else {
    logger.warn('[MediaTools] ⚠️ ffprobe: Não encontrado (opcional).');
  }

  // 4. Voz: codificador Opus (sem ele, voz e rádio quebram na primeira fala/música)
  let opusOk = false;
  try {
    const opus = checkOpus();
    opusOk = opus.ok;
    if (opus.ok) {
      logger.info(`[MediaTools] Opus: OK (${opus.backend})`);
    } else {
      logger.warn(
        `[MediaTools] ⚠️ Opus: AUSENTE. Voz/rádio sem codificador Opus: os recursos de voz serão recusados com aviso. ` +
        `Instale opusscript@0.0.8 (ou @discordjs/opus) e reinicie. Detalhe: ${opus.error}`
      );
    }
  } catch (err) {
    logger.warn(`[MediaTools] ⚠️ Erro ao verificar o Opus: ${err.message}`);
  }

  // 5. Voz: criptografia e DAVE exigidos pelo @discordjs/voice (só diagnóstico; não derruba o boot)
  let cryptoOk = false;
  let daveOk = false;
  try {
    const deps = await checkVoiceDependencies();
    if (!deps.ok) {
      logger.warn(`[MediaTools] ⚠️ Não foi possível diagnosticar as dependências de voz: ${deps.error}`);
    } else {
      cryptoOk = deps.cryptoOk;
      daveOk = Boolean(deps.dave);
      if (deps.cryptoOk) {
        const via = [deps.aesGcm ? 'aes-256-gcm nativo' : null, ...deps.cryptoLibs].filter(Boolean).join(', ');
        logger.info(`[MediaTools] Criptografia de voz: OK (${via})`);
        if (!deps.cryptoLibs.length) {
          logger.info('[MediaTools] Criptografia de voz: sem biblioteca XChaCha (@noble/ciphers); só o AES-256-GCM nativo está disponível. Instale @noble/ciphers para cobrir o caso de o Discord negociar o modo XChaCha.');
        }
      } else {
        logger.warn('[MediaTools] ⚠️ Criptografia de voz: nenhum modo disponível (instale @noble/ciphers). A voz não funcionará.');
      }
      if (deps.dave) {
        logger.info(`[MediaTools] DAVE (E2EE de voz): OK (${deps.dave})`);
      } else {
        logger.warn('[MediaTools] ⚠️ DAVE (@snazzah/davey) ausente: o Discord exige DAVE nas calls; a voz pode falhar.');
      }
    }
  } catch (err) {
    logger.warn(`[MediaTools] ⚠️ Erro ao verificar as dependências de voz: ${err.message}`);
  }

  // 6. Ferramentas opcionais em Python: deemix (Deezer) e spotdl (Spotify). Sem rede; ausente => o boot segue
  //    (deemix: plano B pelo YouTube; spotdl: o pedido de faixa do Spotify falha com aviso). A linha de log sai por ferramenta.
  let optionalTools = {};
  try {
    optionalTools = await checkOptionalPythonTools();
  } catch (err) {
    logger.warn(`[MediaTools] ⚠️ Erro ao verificar as ferramentas Python opcionais: ${err.message}`);
  }
  const deemixOk = Boolean(optionalTools.deemix?.ok);
  const spotdlOk = Boolean(optionalTools.spotdl?.ok);

  return { ytdlpOk, ffmpegOk, ffprobeOk, opusOk, cryptoOk, daveOk, deemixOk, spotdlOk, optionalTools };
}

export default {
  getYtdlpPath,
  getFfmpegPath,
  getFfprobePath,
  ensureYtdlp,
  ensureFfmpeg,
  updateYtdlp,
  startYtdlpAutoUpdate,
  isOpusAvailable,
  checkOpus,
  checkOptionalPythonTools,
  validateMediaTools,
};
