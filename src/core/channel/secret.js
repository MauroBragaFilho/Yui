// Arquivo do SEGREDO do canal local cérebro ↔ adaptadores (mesmo padrão do canal de aprovação, security/localChannel.js).
//
// O cérebro gera um segredo novo a cada subida e o grava num arquivo de permissão restrita; o adaptador (YuiBot) lê o
// segredo DESSE arquivo. Quem consegue ler o arquivo está fisicamente no computador e roda como o mesmo usuário (ou é
// Administrador/SYSTEM). No Windows a restrição é por SID (o nome dos grupos muda com o idioma): sem herança e controle
// total só para o usuário atual, SYSTEM e Administradores, CONFERIDA lendo a ACL de volta. Fora dele: chmod 600 conferido.
// A ordem é: cria VAZIO, restringe, confere e só então grava o segredo (não existe janela com o segredo legível).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid, readWindowsAcl, SID_SYSTEM, SID_ADMINISTRATORS } from '../../database/snapshot.js';
import { ChannelError } from './protocol.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SECRET_RE = /^[0-9a-f]{64}$/;

/** Caminho do arquivo do segredo: YUI_CHANNEL_SECRET_FILE ou secrets/channel-secret.json (pasta ignorada pelo git). */
export function channelSecretFilePath(env = process.env) {
  const configured = String(env.YUI_CHANNEL_SECRET_FILE ?? '').trim();
  return configured ? path.resolve(configured) : path.join(ROOT, 'secrets', 'channel-secret.json');
}

/** Porta do canal: YUI_CHANNEL_PORT ou 3941. */
export function channelPortFromEnv(env = process.env, fallback = 3941) {
  const raw = String(env.YUI_CHANNEL_PORT ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError(`YUI_CHANNEL_PORT inválida: ${raw}`);
  return n;
}

function icaclsPath() {
  const candidate = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'icacls.exe');
  return fs.existsSync(candidate) ? candidate : 'icacls.exe';
}

/** SIDs que podem ler o arquivo do segredo no Windows. */
export function allowedSecretSids() {
  return [...new Set([currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS])];
}

/**
 * Restringe um ARQUIVO ao dono do processo e confere. Lança erro se não conseguir.
 * Windows: `icacls /inheritance:r /grant:r *SID:F` só para usuário atual, SYSTEM e Administradores; conferido pelo
 * `icacls /save` (SDDL): protegida (sem herança), só concessões, só esses SIDs. Fora dele: chmod 600 conferido.
 */
export function restrictFileToOwner(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) throw new Error(`o arquivo ficou com permissão ${mode.toString(8)} em vez de 600`);
    return;
  }
  const allowed = allowedSecretSids();
  try {
    execFileSync(icaclsPath(), [file, '/inheritance:r', '/grant:r', ...allowed.map((sid) => `*${sid}:F`), '/q'], {
      windowsHide: true, timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    throw new Error(`icacls falhou (${String(err?.stderr || err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 160)})`);
  }
  const acl = readWindowsAcl(file);
  const sids = new Set(acl.aces.map((a) => a.sid));
  const wrong = acl.aces.filter((a) => a.type !== 'A' || a.flags.includes('ID') || !allowed.includes(a.sid));
  if (!acl.protected || wrong.length || sids.size !== allowed.length) {
    throw new Error(`a ACL do arquivo do segredo não ficou restrita (${acl.sddl || 'vazia'})`);
  }
}

/**
 * Grava o arquivo do segredo: apaga o que houver no caminho, cria VAZIO com 'wx', restringe e confere a permissão, e só
 * então grava o conteúdo. Se a restrição falhar, apaga o arquivo vazio e lança erro (o canal não sobe).
 * @param {string} file
 * @param {{port: number, secret: string, pid: number, startedAt: string, protocol: number}} data
 * @param {{restrict?: (file: string) => void}} [options]
 */
export function writeChannelSecretFile(file, data, { restrict = restrictFileToOwner } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true }); // nunca reaproveita um arquivo que já estava lá (poderia ter ACL aberta)
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  try {
    restrict(file);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new Error(`Não consegui restringir a permissão do arquivo do segredo do canal; o canal NÃO subiu. ${err.message}`);
  }
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

/**
 * Lê o arquivo do segredo (do lado do adaptador). Lança ChannelError('SECRET_UNAVAILABLE') sem repetir o conteúdo.
 * @returns {{port: number, secret: string, pid?: number, startedAt?: string, protocol?: number}}
 */
export function readChannelSecretFile(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ChannelError('SECRET_UNAVAILABLE', `Arquivo do segredo do canal indisponível (${err?.code || 'ilegível'}): ${file}`);
  }
  if (!data || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535 || typeof data.secret !== 'string' || !SECRET_RE.test(data.secret)) {
    throw new ChannelError('SECRET_UNAVAILABLE', `Arquivo do segredo do canal com formato inválido: ${file}`);
  }
  return data;
}

/** Apaga o arquivo do segredo só se ele ainda guardar ESTE segredo (outra instância pode ter gravado o dela). */
export function removeChannelSecretFile(file, secret) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.secret !== secret) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
