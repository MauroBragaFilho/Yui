import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    const testCmd = IS_WIN ? `where ${cmd}` : `command -v ${cmd}`;
    exec(testCmd, (error, stdout) => {
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

/**
 * Atualiza o yt-dlp se disponível
 */
export async function updateYtdlp() {
  const binary = getYtdlpPath();
  return new Promise((resolve) => {
    logger.info(`[MediaTools] Verificando atualizações do yt-dlp (${binary})...`);
    exec(`"${binary}" -U`, (error, stdout, stderr) => {
      if (error) {
        logger.warn(`[MediaTools] Atualização de yt-dlp: ${stderr.trim() || error.message}`);
        resolve(false);
      } else {
        logger.info(`[MediaTools] yt-dlp atualizado/verificado: ${stdout.trim().split('\n')[0]}`);
        resolve(true);
      }
    });
  });
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

  return { ytdlpOk, ffmpegOk, ffprobeOk };
}

export default {
  getYtdlpPath,
  getFfmpegPath,
  getFfprobePath,
  ensureYtdlp,
  ensureFfmpeg,
  updateYtdlp,
  validateMediaTools,
};
