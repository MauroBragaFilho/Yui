#!/usr/bin/env node
/**
 * Backup CIFRADO da Yui para um repositório PRIVADO do GitHub (cópia fora do notebook).
 *
 *   node scripts/backup-offsite.mjs             # faz o backup (só se algo mudou) e envia
 *   node scripts/backup-offsite.mjs --force     # envia mesmo sem mudança
 *   node scripts/backup-offsite.mjs --verify    # baixa o último backup, decifra e confere os bancos (teste de restauração)
 *
 * Só vão arquivos CIFRADOS (XChaCha20-Poly1305, ver src/core/memory/backup.js). A chave nunca entra no repositório.
 *
 * Variáveis (todas opcionais, com padrão):
 *   YUI_BACKUP_REPO_URL   git@github.com:MauroBragaFilho/Yui-backup.git (precisa ser PRIVADO)
 *   YUI_BACKUP_SSH_KEY    chave de acesso (deploy key) do repositório; padrão C:\Tools\backup\yui_backup_deploy
 *   YUI_BACKUP_KEY_FILE   arquivo com a chave de cifra (veja backup.js); padrão C:\Tools\backup\backup.key
 *   YUI_BACKUP_WORKDIR    clone local de trabalho; padrão C:\Yui-backup-offsite
 *   YUI_BACKUP_LOG        log de uma linha por execução (lido pelo relatório diário); padrão C:\Tools\backup\backup.log
 *   YUI_BACKUP_KEEP       backups mantidos no repositório (padrão 30)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryBackup, restoreMemoryBackup, MEMORY_DATABASES, EXTRA_DATABASES, DATA_FILES } from '../src/core/memory/backup.js';

const win = process.platform === 'win32';
const env = process.env;
const cfg = {
  repoUrl: env.YUI_BACKUP_REPO_URL || 'git@github.com:MauroBragaFilho/Yui-backup.git',
  sshKey: env.YUI_BACKUP_SSH_KEY || (win ? 'C:\\Tools\\backup\\yui_backup_deploy' : path.resolve('../yui-backup-deploy')),
  keyFile: env.YUI_BACKUP_KEY_FILE || (win ? 'C:\\Tools\\backup\\backup.key' : ''),
  workDir: env.YUI_BACKUP_WORKDIR || (win ? 'C:\\Yui-backup-offsite' : path.resolve('../yui-backup-offsite')),
  logFile: env.YUI_BACKUP_LOG || (win ? 'C:\\Tools\\backup\\backup.log' : ''),
  keep: Math.max(1, Number(env.YUI_BACKUP_KEEP) || 30),
  dbDir: path.resolve('database'),
  dataDir: path.resolve('src', 'data'),
};

// Arquivos de estado (known_hosts e último hash) ficam ao lado da chave de acesso (C:\Tools\backup), nunca na raiz do disco.
const stateDir = path.dirname(cfg.sshKey);
// git: o do PATH; no notebook (sem Git instalado) o MinGit portátil em C:/Tools/git. YUI_GIT_PATH força outro caminho.
const MINGIT = 'C:/Tools/git/cmd/git.exe'; // barras normais: o Windows aceita e o JS não trata como escape
const gitExe = env.YUI_GIT_PATH || (win && fs.existsSync(MINGIT) ? MINGIT : 'git');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function logLine(msg, file = cfg.logFile) {
  const line = `${stamp()} ${msg}`;
  console.log(line);
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch { /* sem log em disco: ficou só no console */ }
  }
}

function git(args, { cwd = cfg.workDir, allowFail = false } = {}) {
  const sshCmd = `ssh -i "${cfg.sshKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${path.join(stateDir, 'known_hosts')}" -o BatchMode=yes`;
  try {
    return execFileSync(gitExe, ['-c', 'safe.directory=*', '-c', 'user.name=Yui Backup', '-c', 'user.email=yui-backup@users.noreply.github.com', ...args], {
      cwd, env: { ...env, GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = String(err.stderr || err.message || '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
    throw new Error(`git ${args[0]} falhou: ${detail}`);
  }
}

function ensureClone() {
  if (!fs.existsSync(path.join(cfg.workDir, '.git'))) {
    const parent = path.dirname(cfg.workDir);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });   // mkdir recursivo em C:\ (que já existe) dá EPERM no Windows
    git(['clone', cfg.repoUrl, cfg.workDir], { cwd: path.dirname(cfg.workDir) });
  }
  // remoto vazio (primeiro uso) não tem ramo para puxar
  const remoteHasMain = git(['ls-remote', '--heads', 'origin', 'main']) !== '';
  if (remoteHasMain) git(['pull', '--rebase', 'origin', 'main']);
  return remoteHasMain;
}

/** Hash dos arquivos de origem: se não mudou desde o último envio, não há o que enviar. */
export function sourcesFingerprint({ dbDir = cfg.dbDir, dataDir = cfg.dataDir } = {}) {
  const h = crypto.createHash('sha256');
  const names = [...MEMORY_DATABASES, ...EXTRA_DATABASES].map((n) => path.join(dbDir, n)).concat(DATA_FILES.map((n) => path.join(dataDir, n)));
  for (const f of names) {
    if (!fs.existsSync(f)) continue;
    h.update(path.basename(f)).update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

async function backup({ force }) {
  if (!cfg.keyFile || !fs.existsSync(cfg.keyFile)) throw new Error(`chave de cifra não encontrada (${cfg.keyFile || 'YUI_BACKUP_KEY_FILE'})`);
  const remoteHadMain = ensureClone();
  const stateFile = path.join(stateDir, 'last-sha');
  const fp = sourcesFingerprint();
  const last = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : '';
  if (!force && fp === last) {
    logLine('OK: sem mudanças desde o último envio; nada a enviar.');
    return;
  }
  const res = await createMemoryBackup({ dbDir: cfg.dbDir, dataDir: cfg.dataDir, backupDir: path.join(cfg.workDir, 'backups'), maxKeep: cfg.keep, keyFile: cfg.keyFile });
  git(['add', '-A']);
  const pending = git(['status', '--porcelain']);
  if (pending) git(['commit', '-m', `backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${res.count} arquivos)`]);
  git(remoteHadMain ? ['push', 'origin', 'HEAD:main'] : ['push', '-u', 'origin', 'HEAD:main']);
  fs.writeFileSync(stateFile, fp, 'utf8');
  logLine(`OK: backup cifrado enviado (${res.count} arquivos, pasta ${path.basename(res.folder)}).`);
}

/** Teste de restauração: baixa o último backup do repositório, decifra tudo numa pasta temporária e confere que cada banco abre. */
export async function verifyLatest() {
  if (!cfg.keyFile || !fs.existsSync(cfg.keyFile)) throw new Error('chave de cifra não encontrada');
  ensureClone();
  const root = path.join(cfg.workDir, 'backups');
  const folders = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('backup-')).sort() : [];
  if (folders.length === 0) throw new Error('nenhum backup no repositório');
  const latest = folders[folders.length - 1];
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-restore-check-'));
  try {
    const r = await restoreMemoryBackup({ backupFolder: path.join(root, latest), targetDir: target, keyFile: cfg.keyFile });
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const report = [];
    for (const f of r.restored) {
      const buf = fs.readFileSync(f.path);
      if (f.name.endsWith('.db')) {
        const db = new SQL.Database(buf);
        const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
        const tables = db.exec("SELECT count(*) FROM sqlite_master WHERE type='table'")[0].values[0][0];
        db.close();
        if (integrity !== 'ok') throw new Error(`${f.name}: integridade ${integrity}`);
        report.push(`${f.name} (${tables} tabelas)`);
      } else {
        JSON.parse(buf.toString('utf8'));
        report.push(f.name);
      }
    }
    logLine(`OK: restauração testada com ${latest}: ${report.length} arquivos abrem e conferem.`);
    return { folder: latest, files: report };
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  try {
    if (args.has('--verify')) await verifyLatest();
    else await backup({ force: args.has('--force') });
  } catch (err) {
    logLine(`ERRO: ${String(err.message).slice(0, 220)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
