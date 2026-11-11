import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import initSqlJs from 'sql.js';

// Backup cifrado -> repositório git (aqui um repositório local "bare" no lugar do GitHub) -> restauração conferida.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-offsite-'));
const work = path.join(root, 'cwd');
fs.mkdirSync(path.join(work, 'database'), { recursive: true });
fs.mkdirSync(path.join(work, 'src', 'data'), { recursive: true });
const bare = path.join(root, 'remoto.git');
execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });

const SQL = await initSqlJs();
const SEGREDO = 'SEGREDO_DA_MEMORIA_12345';
function makeDb(name, value) {
  const db = new SQL.Database();
  db.run('CREATE TABLE memoria (texto TEXT)');
  db.run('INSERT INTO memoria VALUES (?)', [value]);
  fs.writeFileSync(path.join(work, 'database', name), Buffer.from(db.export()));
  db.close();
}
makeDb('memory-personal.db', SEGREDO);
makeDb('social-youtube.db', 'canal X');
fs.writeFileSync(path.join(work, 'src', 'data', 'bans.json'), JSON.stringify({ users: {}, guilds: {}, channels: {} }));

const keyFile = path.join(root, 'backup.key');
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'));
const log = path.join(root, 'backup.log');
const script = path.resolve('scripts/backup-offsite.mjs');
const baseEnv = {
  ...process.env, YUI_BACKUP_REPO_URL: bare, YUI_BACKUP_SSH_KEY: path.join(root, 'sem-chave'), YUI_BACKUP_KEY_FILE: keyFile,
  YUI_BACKUP_WORKDIR: path.join(root, 'trabalho', 'repo'), YUI_BACKUP_LOG: log, YUI_BACKUP_KEEP: '30',
};
const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: work, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 120_000 });
const lastLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').pop();
const commits = () => Number(execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim());
const filesInRemote = () => execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n');
let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok += 1; };

// 1) primeiro envio: o remoto estava vazio
let r = run();
check(r.status === 0, `1º envio saiu com erro: ${r.stdout}${r.stderr}`);
check(/^\S+ \S+ OK: backup cifrado enviado \(\d+ arquivos/.test(lastLog()), lastLog());
check(commits() === 1, 'um commit no remoto');
const files = filesInRemote();
check(files.some((f) => f.endsWith('memory-personal.db.enc')) && files.some((f) => f.endsWith('bans.json.enc')) && files.some((f) => f.endsWith('social-youtube.db.enc')), 'bancos, bans e seguidos do YouTube foram para o remoto');
check(files.every((f) => f.startsWith('backups/') || f === 'README.md'), 'só a pasta de backups cifrados (nada em claro)');

// o que está no remoto NÃO contém o texto em claro
let achou = false;
try { execFileSync('git', ['--git-dir', bare, 'grep', '-q', SEGREDO, 'main'], { stdio: 'ignore' }); achou = true; } catch { achou = false; }
check(achou === false, 'o texto secreto NÃO aparece em claro no repositório');

// 2) sem mudança: não envia de novo
r = run();
check(r.status === 0 && /sem mudanças/.test(lastLog()), lastLog());
check(commits() === 1, 'nenhum commit novo');

// 3) mudou um banco: novo envio
makeDb('memory-personal.db', SEGREDO + '_novo');
r = run();
check(r.status === 0 && /backup cifrado enviado/.test(lastLog()), lastLog());
check(commits() === 2, 'segundo commit');
check(new Set(filesInRemote().filter((f) => f.startsWith('backups/')).map((f) => f.split('/')[1])).size === 2, 'duas pastas de backup');

// 4) teste de restauração: baixa, decifra e abre os bancos
r = run(['--verify']);
check(r.status === 0 && /restauração testada .*: 3 arquivos/.test(lastLog()), `${lastLog()} ${r.stderr}`);

// 5) chave errada: a restauração FALHA (não finge que deu certo)
const wrong = path.join(root, 'errada.key');
fs.writeFileSync(wrong, crypto.randomBytes(32).toString('hex'));
r = run(['--verify'], { YUI_BACKUP_KEY_FILE: wrong });
check(r.status === 1 && /ERRO:/.test(lastLog()), lastLog());

// 6) sem chave de cifra: erro claro e nada enviado
const antes = commits();
r = run([], { YUI_BACKUP_KEY_FILE: path.join(root, 'nao-existe.key') });
check(r.status === 1 && /chave de cifra não encontrada/.test(lastLog()), lastLog());
check(commits() === antes, 'não enviou nada sem chave');

fs.rmSync(root, { recursive: true, force: true });
console.log(`OK: backup-offsite (${ok} verificações)`);
process.exit(0);
