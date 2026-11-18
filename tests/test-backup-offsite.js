import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import initSqlJs from 'sql.js';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';

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
// TEMP isolado: a verificação decifra em yui-snap-* e varre sobras; nada disso pode tocar no TEMP real.
const isolatedTemp = path.join(root, 'temp');
fs.mkdirSync(isolatedTemp, { recursive: true });
// Etapa 8 (revisão da Liz): os processos auxiliares deste teste rodam sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers
// falham e ficam registrados; o git e o icacls/whoami; o remoto é um repositório "bare" LOCAL, nunca o GitHub). O registro guarda qual teste abriu cada exceção.
const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:backupoffsite', liberar: {
  'programa:git': 'o backup externo empurra para um repositório "bare" LOCAL na pasta temporária, no lugar do GitHub (scripts/backup-offsite.mjs; sem rede)',
  'programa:icacls': 'o backup restringe a permissão da cópia em claro (src/database/snapshot.js; sem rede)',
  'programa:whoami': 'o backup descobre o usuário atual para a permissão da cópia em claro (sem rede)',
} });
const baseEnv = {
  ...process.env, YUI_BACKUP_REPO_URL: bare, YUI_BACKUP_SSH_KEY: path.join(root, 'sem-chave'), YUI_BACKUP_KEY_FILE: keyFile,
  YUI_BACKUP_WORKDIR: path.join(root, 'trabalho', 'repo'), YUI_BACKUP_LOG: log, YUI_BACKUP_KEEP: '30',
  TEMP: isolatedTemp, TMP: isolatedTemp, TMPDIR: isolatedTemp,
};
const run = (args = [], env = {}) => spawnSync(process.execPath, [...BLOQUEIO.argv, script, ...args], { cwd: work, env: { ...baseEnv, NODE_ENV: 'test', ...env, ...BLOQUEIO.env('backup-externo') }, encoding: 'utf8', timeout: 120_000 });
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

// 7) banco no motor nativo (node:sqlite com WAL) com a "Yui" aberta: escrita que muda SÓ o -wal também é enviada,
//    e o que vai para o remoto é a cópia consistente (formato clássico, que o sql.js da verificação lê).
const { DatabaseSync } = await import('node:sqlite');
const walDb = path.join(work, 'database', 'memory-context.db');
const yui = new DatabaseSync(walDb);
try {
  yui.exec("PRAGMA journal_mode=WAL; CREATE TABLE contexto (texto TEXT); INSERT INTO contexto VALUES ('a');");
  yui.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;');
  yui.exec("INSERT INTO contexto VALUES ('b');"); // só no -wal
  const antesWal = commits();
  r = run();
  check(r.status === 0 && /backup cifrado enviado \(4 arquivos/.test(lastLog()), `banco WAL entrou no backup: ${lastLog()} ${r.stderr}`);
  check(commits() === antesWal + 1, 'commit novo com o banco WAL');
  r = run();
  check(r.status === 0 && /sem mudanças/.test(lastLog()), `WAL sem escrita nova: nada a enviar (${lastLog()})`);
  const dbHash = crypto.createHash('sha256').update(fs.readFileSync(walDb)).digest('hex');
  yui.exec("INSERT INTO contexto VALUES ('c');"); // de novo só no -wal: o .db não muda
  check(crypto.createHash('sha256').update(fs.readFileSync(walDb)).digest('hex') === dbHash, 'a escrita nova não tocou no .db (só no -wal)');
  r = run();
  check(r.status === 0 && /backup cifrado enviado/.test(lastLog()), `mudança só no -wal gerou envio: ${lastLog()}`);
  check(commits() === antesWal + 2, 'commit novo pela mudança só no -wal');
  r = run(['--verify']);
  check(r.status === 0 && /restauração testada .*: 4 arquivos/.test(lastLog()), `verificação com o banco WAL: ${lastLog()} ${r.stderr}`);
} finally {
  yui.close();
}

// 9) backup interrompido no meio (processo morto pelo handle antes do manifesto) + lotes incompletos no clone:
//    nada incompleto vai para o repositório, o incompleto que já estava lá sai, o abandonado velho é apagado e a
//    verificação pula o incompleto mais novo.
const workClone = path.join(root, 'trabalho', 'repo');
const workBackups = path.join(workClone, 'backups');
const MANIFEST = 'manifest.json.enc';
const isBatch = (n) => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(n);
const incompleteLocal = () => fs.readdirSync(workBackups).filter((n) => isBatch(n) && !fs.existsSync(path.join(workBackups, n, MANIFEST)));
check(incompleteLocal().length === 0, 'antes: nenhum lote incompleto no clone');
const killScript = path.join(root, 'backup-interrompido.mjs');
fs.writeFileSync(killScript, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [moduleFile, dbDir, backupDir, marker] = process.argv.slice(2);
const { createMemoryBackup } = await import(pathToFileURL(moduleFile).href);
await createMemoryBackup({ dbDir, backupDir, snapshotOptions: { afterSnapshot() {
  fs.writeFileSync(marker + '.tmp', 'parado');
  fs.renameSync(marker + '.tmp', marker);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // parado no meio do backup, antes do manifesto
} } });
fs.writeFileSync(marker + '.fim', 'terminou');
`);
const marker = path.join(root, 'parado.txt');
// memory-personal.db (sql.js) vira .enc primeiro; memory-context.db está no formato WAL (passo 7) e tem o ponto de parada.
const killed = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', killScript, path.resolve('src/core/memory/backup.js'), path.join(work, 'database'), workBackups, marker], {
  cwd: work, env: { ...baseEnv, NODE_ENV: 'test', YUI_ALERTS: 'false', ...BLOQUEIO.env('backup-morto-no-meio') }, stdio: ['ignore', 'ignore', 'pipe'],
});
let killedErr = '';
killed.stderr.on('data', (d) => { killedErr += d; });
const killedExit = new Promise((resolve) => killed.on('exit', (code, signal) => resolve({ code, signal })));
try {
  for (let waited = 0; !fs.existsSync(marker); waited += 20) {
    if (killed.exitCode !== null) throw new Error(`o backup saiu antes do ponto de parada: ${killedErr}`);
    if (waited > 30_000) throw new Error('o backup não chegou ao ponto de parada em 30 s');
    await new Promise((r) => setTimeout(r, 20));
  }
} finally {
  killed.kill('SIGKILL'); // só o processo que este teste abriu, pelo handle
}
const killedInfo = await killedExit;
check(killedInfo.signal === 'SIGKILL' || killedInfo.code !== 0, `backup morto à força (${JSON.stringify(killedInfo)})`);
const [killedName] = incompleteLocal();
check(killedName && fs.existsSync(path.join(workBackups, killedName, 'memory-personal.db.enc')), `o lote interrompido ficou no clone sem manifesto (${killedName})`);
// a cópia em claro do banco WAL também ficou no TEMP (o processo morreu): envelhece para a varredura do próximo backup
const snapLeft = fs.readdirSync(isolatedTemp).filter((n) => n.startsWith('yui-snap-'));
check(snapLeft.length === 1, `cópia em claro abandonada no TEMP: ${snapLeft.join(', ')}`);
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
const ageDir = (dir) => { for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), twoHoursAgo, twoHoursAgo); fs.utimesSync(dir, twoHoursAgo, twoHoursAgo); };
ageDir(path.join(isolatedTemp, snapLeft[0]));
// incompleto antigo, abandonado há 2 h: o próximo backup apaga
const oldIncomplete = path.join(workBackups, 'backup-2020-01-01T00-00-00-000Z');
fs.mkdirSync(oldIncomplete);
fs.writeFileSync(path.join(oldIncomplete, 'memory-personal.db.enc'), crypto.randomBytes(64));
ageDir(oldIncomplete);
// incompleto com nome mais novo que tudo, que uma versão antiga já tinha enviado ao repositório
const futureName = 'backup-2099-01-01T00-00-00-000Z';
fs.mkdirSync(path.join(workBackups, futureName));
fs.writeFileSync(path.join(workBackups, futureName, 'memory-personal.db.enc'), crypto.randomBytes(64));
const gitClone = (...args) => execFileSync('git', ['-C', workClone, '-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
gitClone('add', '--', `backups/${futureName}`);
gitClone('commit', '-q', '-m', 'versão antiga enviou um lote incompleto');
gitClone('push', '-q', 'origin', 'HEAD:main');
check(filesInRemote().some((f) => f.includes(futureName)), 'o incompleto antigo estava no repositório');
const antesIncompleto = commits();

makeDb('memory-personal.db', `${SEGREDO}_v3`);
r = run();
check(r.status === 0 && /backup cifrado enviado .*2 pasta\(s\) incompleta\(s\) fora do envio/.test(lastLog()), `envio com incompletos fora: ${lastLog()} ${r.stderr}`);
check(commits() === antesIncompleto + 1, 'um commit novo');
const remoteNow = filesInRemote();
check(!remoteNow.some((f) => f.includes(killedName) || f.includes(futureName) || f.includes('backup-2020-')), 'nenhum lote incompleto no repositório (nem o interrompido, nem o que já estava lá, nem o abandonado)');
const remoteBatches = [...new Set(remoteNow.filter((f) => f.startsWith('backups/')).map((f) => f.split('/')[1]))];
check(remoteBatches.length > 0 && remoteBatches.every((b) => remoteNow.includes(`backups/${b}/${MANIFEST}`)), `todo lote no repositório tem manifesto (${remoteBatches.length} lotes)`);
check(!fs.existsSync(oldIncomplete), 'o incompleto abandonado há 2 h foi apagado do clone');
check(fs.existsSync(path.join(workBackups, killedName)) && fs.existsSync(path.join(workBackups, futureName)), 'os incompletos recentes ficaram só no clone (fora do envio)');
check(!fs.readdirSync(isolatedTemp).some((n) => n.startsWith('yui-snap-')), 'a cópia em claro abandonada foi recolhida pelo backup seguinte');

r = run(['--verify']);
check(r.status === 0 && /restauração testada com backup-20[0-8]\d.*: 4 arquivos .*1 incompleto\(s\) mais novo\(s\) ignorado\(s\): backup-2099/.test(lastLog()), `verificação pulou o incompleto mais novo: ${lastLog()} ${r.stderr}`);

// 8) nenhuma cópia em claro sobrou no TEMP (as verificações decifram os bancos em pastas yui-snap-*)
const leftovers = fs.readdirSync(isolatedTemp, { recursive: true }).filter((n) => /yui-snap-|\.db$/.test(String(n)));
check(leftovers.length === 0, `sobrou no TEMP: ${leftovers.join(', ')}`);

BLOQUEIO.fechar('test:backupoffsite'); // falha alto se algum processo tentou rede, DNS, UDP, programa fora da lista ou worker
fs.rmSync(root, { recursive: true, force: true });
console.log(`OK: backup-offsite (${ok} verificações)`);
process.exit(0);
