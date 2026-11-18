// ENTRADA do supervisor dos dois processos da Yui (etapa 4, docs/RELATORIO_ETAPA4_OPERACAO.md §2). A lógica está em
// src/operacao/supervisor.js.
//
//   node src/supervisor.js        (na pasta da Yui; a tarefa YuiBot passa a rodar isto no lugar de `node src/index.js`)
//
// - Lê o .env da pasta da Yui. Com YUI_CEREBRO_EXTERNO=true: modo DOIS (sobe o cérebro, espera ele ficar pronto, sobe o bot,
//   cuida da saúde de cada um e religa com espera crescente). Sem a chave: modo ÚNICO, exatamente o laço de hoje
//   (`node src/index.js`, religado 15 s depois de qualquer saída).
// - Um supervisor por pasta: trava `logs/supervisor.owner` (src/database/ownerLock.js, batimento curto). Um segundo
//   supervisor é recusado e sai, sem tocar em nada.
// - Para de forma limpa (o bot primeiro, depois o cérebro) com: Ctrl+C / SIGINT, SIGTERM, SIGBREAK; o arquivo de pedido de
//   parada `logs/supervisor.parar` (é o que o atualizador e o watchdog criam: funciona na sessão 0, sem console); ou, quando
//   aberto com IPC (testes), {tipo:'desligar'} ou a saída do pai.
// - Estado em `logs/supervisor-estado.json` (lido pelo watchdog e pelo roteiro de medição) e log em `logs/supervisor.log`.
// - Só encerra processos que ELE abriu, pelo handle guardado na abertura. Nunca procura nem encerra processo por PID.
// Este arquivo é leve de propósito (não carrega o Discord, a IA nem os bancos): no notebook de 4 GB cada MB conta.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createSupervisor, especificacoes, temposDoAmbiente } from './operacao/supervisor.js';
import { databasesOf, ownerLockTiming } from './database/owners.js';
import os from 'node:os';
import { acquireOwnerLock, inspectOwnerLock, processExists } from './database/ownerLock.js';
import { writeJsonAtomic } from './core/channel/idemPersistente.js';
import { processUsage } from './operacao/filho.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(RAIZ, '.env'), quiet: true });

const env = process.env;
const LOGS = path.join(RAIZ, 'logs');
const LOG_FILE = path.join(LOGS, 'supervisor.log');
const ESTADO_FILE = path.join(LOGS, 'supervisor-estado.json');
const PARAR_FILE = path.join(LOGS, 'supervisor.parar');
const MAX_LOG_BYTES = 512 * 1024;
fs.mkdirSync(LOGS, { recursive: true });

function log(nivel, msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${nivel}] ${msg}`;
  try { (nivel === 'erro' ? console.error : console.log)(line); } catch { /* sem console */ }
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      const keep = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(LOG_FILE, keep, 'utf8');
    }
  } catch { /* log em disco é melhor esforço */ }
}

const modo = String(env.YUI_CEREBRO_EXTERNO ?? '').trim().toLowerCase() === 'true' ? 'dois' : 'unico';
const teste = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test';

// Um supervisor por pasta.
let trava;
try {
  trava = acquireOwnerLock(path.join(LOGS, 'supervisor'), { role: 'supervisor', heartbeatMs: 5_000, staleMs: 20_000 });
} catch (err) {
  log('erro', `Já existe um supervisor nesta pasta (${err.code || 'trava'}): ${String(err.message).slice(0, 200)}. Nada foi iniciado.`);
  process.exit(1);
}

// Saída dos filhos: 'ignorar' (padrão: o log de cada processo já vai para logs/app-*.log; o fim do stderr de um processo que
// cai vai para o log do supervisor), 'herdar' (no console do supervisor, para rodar à mão) ou 'arquivo' (logs/<papel>-saida.log).
const saida = ['herdar', 'arquivo'].includes(String(env.YUI_SUPERVISOR_SAIDA ?? '').trim().toLowerCase()) ? String(env.YUI_SUPERVISOR_SAIDA).trim().toLowerCase() : 'ignorar';

function spawnFilho(spec) {
  let stdio;
  let fds = [];
  if (!spec.ipc) stdio = 'inherit'; // modo único: igual ao laço da tarefa (console oculto da tarefa)
  else if (saida === 'herdar') stdio = ['ignore', 'inherit', 'inherit', 'ipc'];
  else if (saida === 'arquivo') {
    const fd = fs.openSync(path.join(LOGS, `${spec.papel}-saida.log`), 'a');
    fds = [fd];
    stdio = ['ignore', fd, fd, 'ipc'];
  } else stdio = ['ignore', 'ignore', 'pipe', 'ipc'];
  const child = spawn(process.execPath, [spec.script], { cwd: RAIZ, env: spec.env, stdio, windowsHide: true });
  for (const fd of fds) { try { fs.closeSync(fd); } catch { /* o filho tem a cópia dele */ } }
  if (child.stderr) {
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    child.on('exit', (code) => {
      if (code !== 0 && tail.trim()) log('aviso', `${spec.papel}: fim da saída de erro: ${tail.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 900)}`);
    });
  }
  return child;
}

const { heartbeatMs, staleMs } = ownerLockTiming(env);
const dbDir = path.resolve(RAIZ, env.DATABASE_DIR || 'database');
const supervisor = createSupervisor({
  modo,
  specs: especificacoes(modo, { env, bancos: { cerebro: databasesOf('cerebro'), bot: databasesOf('bot') } }),
  spawnFilho,
  tempos: temposDoAmbiente(env),
  travas: { dir: dbDir, heartbeatMs, staleMs, hostname: os.hostname(), inspecionar: inspectOwnerLock, processoExiste: processExists },
  log,
  gravarEstado: (estado) => writeJsonAtomic(ESTADO_FILE, { ...estado, supervisor: { pid: process.pid, uso: processUsage() } }),
});

let saindo = false;
async function sair(motivo, code = 0) {
  if (saindo) return;
  saindo = true;
  clearInterval(pararTimer);
  try { await supervisor.parar(motivo); } catch (err) { log('erro', `falha ao parar: ${err?.message}`); code = 1; }
  try { trava.release(); } catch { /* sai junto com o processo */ }
  log('info', `Supervisor saindo (${motivo}).`);
  process.exit(code);
}

// Pedido de parada por arquivo: o de uma execução anterior (mais velho que esta subida) é descartado.
const inicio = Date.now();
try {
  const st = fs.statSync(PARAR_FILE);
  if (st.mtimeMs < inicio) { fs.rmSync(PARAR_FILE, { force: true }); log('info', 'Pedido de parada antigo descartado (era para o supervisor anterior).'); }
} catch { /* não existe */ }
const pararTimer = setInterval(() => {
  try {
    fs.statSync(PARAR_FILE);
  } catch { return; }
  try { fs.rmSync(PARAR_FILE, { force: true }); } catch { /* */ }
  sair('pedido de parada (logs/supervisor.parar)');
}, 1_000);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try { process.on(signal, () => { sair(signal); }); } catch { /* sinal inexistente nesta plataforma */ }
}
if (typeof process.send === 'function') {
  process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.tipo === 'desligar') sair('pedido do processo pai');
    else if (m.tipo === 'estado') { try { process.send({ tipo: 'estado', id: m.id ?? null, estado: { ...supervisor.estado(), supervisor: { pid: process.pid, uso: processUsage() } } }); } catch { /* */ } }
    else if (m.tipo === 'verificar') supervisor.verificarAgora().then(() => { try { process.send({ tipo: 'verificado', id: m.id ?? null }); } catch { /* */ } });
    else if (m.tipo === 'simular-queda') {
      // Só nos testes: derruba à força, pelo handle, um processo que ESTE supervisor abriu.
      if (!teste) { log('aviso', 'simular-queda recusado: só vale com NODE_ENV=test.'); return; }
      const n = supervisor.simularQueda(String(m.papel ?? ''));
      log('aviso', `TESTE: queda simulada de ${m.papel} (${n} processo(s), pelo handle).`);
    }
  });
  process.on('disconnect', () => sair('o processo pai saiu'));
}
process.on('uncaughtException', (err) => {
  log('erro', `Erro inesperado no supervisor: ${err?.stack || err}`);
  sair('erro inesperado no supervisor', 1);
});
process.on('unhandledRejection', (reason) => {
  log('erro', `Promessa rejeitada no supervisor: ${reason?.stack || reason}`);
});

log('info', `==== Supervisor da Yui (pid ${process.pid}, pasta ${RAIZ}) ====`);
supervisor.iniciar();
