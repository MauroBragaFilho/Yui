// TESTE DE RESISTÊNCIA dos DOIS processos da Yui (supervisor + cérebro + bot) com Discord, IA e busca FALSOS (etapa 9, pedido da Liz na revisão da etapa 8).
//
// É o teste `test:soak2h` do package.json: MANUAL, de 2 horas, FORA da CI (README_TESTES.md); `npm run test:soak2h` roda o padrão (120 minutos).
// Uso (na pasta do código, com o node_modules ao lado):
//   node scripts/soak-dois-processos.mjs --minutos=120 [--pasta=C:\medicao-yui] [--dados=<pasta dos dados>] [--porta-api=39551] [--producao-saude=http://127.0.0.1:3939/v1/health | --sem-producao]
//
// O que faz (tudo em pastas ISOLADAS dentro de <pasta>\soak-dados; nada toca na Yui de verdade nem nos bancos reais):
//  - sobe o supervisor de verdade (src/supervisor.js, modo dois processos) e o deixa por `--minutos`;
//  - gera carga SEQUENCIAL em intervalos variados: conversas do Braga em DM e de dois membros no servidor (cada uma com marcas "tok-X-n" para conferir
//    que nenhum contexto vaza entre pessoas) e pesquisas simuladas (a IA falsa pede search_web; a busca é falsa);
//  - eventos controlados em frações do tempo: 8% o bot cai no meio do envio de um lembrete; 17% o cérebro cai com uma mensagem em andamento; 25% os
//    dois caem; 70% REINÍCIO CONTROLADO DO SUPERVISOR (com um lembrete vencendo enquanto ele está fora). Entre 25% e 70% não há evento nenhum: é o
//    trecho onde o crescimento de memória é medido. Depois de cada evento, uma bateria de mensagens confere que tudo voltou;
//  - mede RAM e CPU (pelo IPC de saúde do supervisor e, no Windows, a RAM privada pelo SO só dos PIDs que o supervisor informou) a cada 30 s, e o
//    CRESCIMENTO de memória de cada processo (inclinação em MB/h, por processo vivo);
//  - confere: uma resposta final por mensagem (nenhuma duplicada nem perdida), cada lembrete entregue UMA vez, as cotas de busca por hora depois dos
//    reinícios (nada perdido, nada em dobro), nenhum vazamento de contexto, nenhuma tentativa externa (bloqueio de integração externa em todos os
//    processos) e, se `--producao-saude` for dado, que a Yui de produção continua saudável (só leitura do /v1/health);
//  - PROTEGE o computador: se a RAM livre ficar abaixo de 300 MB por 3 leituras seguidas, ou a saúde da produção falhar 2 vezes seguidas, para tudo
//    (de forma limpa, só os processos que ele mesmo abriu) e marca a rodada como abortada.
// Nunca encerra processo por PID achado em varredura: só pede ao supervisor (IPC) ou ao handle que o próprio script abriu.
// A saída: <pasta>\soak-dados\resumo.json e resumo.txt (e uma linha de progresso a cada 5 min no stdout).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { criarBloqueio, EXCECOES_DO_CANAL, lerBloqueios } from '../tests/helpers/bloqueioExternoTeste.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const MINUTOS = Math.max(2, Number(args.minutos ?? 120));
const RAIZ = path.resolve(args.pasta ?? process.cwd());
const DADOS = path.resolve(args.dados ?? path.join(RAIZ, 'soak-dados'));
const PORTA_API = Number(args['porta-api'] ?? 39551);
const SAUDE_PROD = args['sem-producao'] === 'true' ? null : String(args['producao-saude'] ?? 'http://127.0.0.1:3939/v1/health');
const INTERVALO_AMOSTRA_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agora = () => Date.now();
const hhmmss = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8);
const log = (m) => console.log(`[${hhmmss()}] ${m}`);

// ── Pastas e ambiente ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
fs.rmSync(DADOS, { recursive: true, force: true });
for (const d of ['db', 'secrets', 'tmp']) fs.mkdirSync(path.join(DADOS, d), { recursive: true });
fs.rmSync(path.join(RAIZ, 'logs', 'supervisor.parar'), { force: true });
const ARQ = {
  inbox: path.join(DADOS, 'inbox.jsonl'), canal: path.join(DADOS, 'canal.jsonl'), dms: path.join(DADOS, 'dms.jsonl'),
  iaCtl: path.join(DADOS, 'ia-controle.json'), buscaCtl: path.join(DADOS, 'busca-controle.json'), buscaReg: path.join(DADOS, 'busca-registro.jsonl'),
  orcamento: path.join(DADOS, 'search-budget.json'), hora: path.join(DADOS, 'search-budget-hora.json'),
  amostras: path.join(DADOS, 'amostras.jsonl'), resumoJson: path.join(DADOS, 'resumo.json'), resumoTxt: path.join(DADOS, 'resumo.txt'),
};
fs.writeFileSync(ARQ.inbox, '');
fs.writeFileSync(ARQ.iaCtl, '{}');
fs.writeFileSync(ARQ.buscaCtl, '{}');

const A = { chave: 'A', user: '111111111111111111', guild: null, channel: '777777777777777777' }; // o Braga em DM
const B = { chave: 'B', user: '222222222222222222', guild: '444444444444444444', channel: '555555555555555555' }; // um membro no servidor
const C = { chave: 'C', user: '333333333333333333', guild: '444444444444444444', channel: '666666666666666666' }; // outro membro
const ID_BOT = '900000000000000001';
const TOKEN = `token-do-soak-${crypto.randomBytes(8).toString('hex')}`;

const bloqueio = criarBloqueio(path.join(DADOS, 'bloqueio'), {
  // O registro único dos testes (tests/externos.json) só aceita exceções de testes que existem no package.json, e cada teste tem o PRÓPRIO identificador (revisão da
  // Liz, §14 do relatório da etapa 8: não vale registrar este teste como o test:operacao só porque esse nome existe). Este é o `test:soak2h` (npm run test:soak2h).
  teste: 'test:soak2h',
  herdar: true,
  liberar: {
    ...EXCECOES_DO_CANAL,
    'node:com-bloqueio': 'o supervisor de verdade (src/supervisor.js) abre o cérebro e o bot; os dois continuam com o bloqueio',
    'programa:powershell': 'a trava de dono lê a hora de início do processo dono (src/database/ownerLock.js: só leitura local, sem rede)',
  },
});

const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramFiles', 'ProgramData', 'SystemDrive', 'LANG'];
function ambiente() {
  const env = {};
  for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env, TEMP: path.join(DADOS, 'tmp'), TMP: path.join(DADOS, 'tmp'), NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', LOG_LEVEL: 'info',
    DATABASE_DIR: path.join(DADOS, 'db'), YUI_CHANNEL_SECRET_FILE: path.join(DADOS, 'secrets', 'channel-secret.json'), YUI_CHANNEL_PORT: '0',
    YUI_OWNER_ID: A.user, YUI_MEMORY_ENABLED: 'true', YUI_ALERTS: 'false', YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false',
    GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0', YUI_GATEWAY_ENABLED: 'false',
    YUI_TESTE_IA_FALSA: 'true', YUI_TESTE_IA_FALSA_CONTROLE: ARQ.iaCtl, DISCORD_TOKEN: 'token-falso-de-teste',
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20', YUI_POLICY_MODE: 'observe', YUI_IMAGE_PRE_ROUTE: 'false',
    YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'owner',
    YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '', YUI_SEARCH_BUDGET_FILE: ARQ.orcamento,
    YUI_TESTE_BUSCA_FALSA: 'true', YUI_TESTE_BUSCA_FALSA_CONTROLE: ARQ.buscaCtl, YUI_TESTE_BUSCA_FALSA_REGISTRO: ARQ.buscaReg, YUI_TESTE_BUSCA_FALSA_COTA: 'true',
    YUI_SEARCH_USER_PER_HOUR: '60', YUI_SEARCH_GLOBAL_PER_HOUR: '300',
    YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(PORTA_API), YUI_API_TOKENS: `${TOKEN}=${A.user}`,
    YUI_CEREBRO_EXTERNO: 'true', YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: ARQ.dms, YUI_TESTE_DISCORD_FALSO_ENTRADA: ARQ.inbox,
    YUI_TESTE_DISCORD_FALSO_CANAL: ARQ.canal, YUI_SUPERVISOR_SAIDA: 'arquivo', YUI_CHAT_ESPERA_CEREBRO_MS: '15000',
    YUI_CEREBRO_LEMBRETES_MS: '1000', // o cérebro olha os lembretes a cada 1 s: o evento "o bot cai no meio do envio" acerta a janela do envio
    ...(process.env.YUI_DB_NATIVE ? { YUI_DB_NATIVE: process.env.YUI_DB_NATIVE } : {}),
  };
}

// ── Leitura de arquivos e da API ───────────────────────────────────────────────────────────────────────────────────────────────────
const lerLinhas = (arq) => { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const lerJson = (arq) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; } };
async function api(method, rota, corpo) {
  const res = await fetch(`http://127.0.0.1:${PORTA_API}${rota}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const apiOk = async (m, r, c) => { try { return await api(m, r, c); } catch (err) { return { status: 0, json: null, erro: String(err?.code ?? err?.message ?? err) }; } };

// ── O supervisor ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let sup = null;
let supN = 0;
function iniciarSupervisor() {
  supN += 1;
  const rotulo = `supervisor#${supN}`;
  const child = spawn(process.execPath, [...bloqueio.argv, 'src/supervisor.js'], {
    cwd: RAIZ, env: { ...ambiente(), ...bloqueio.env('supervisor') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const s = { rotulo, child, out: '', saiu: false, codigo: null, esperas: new Map(), seq: 0 };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const guarda = (d) => { s.out = (s.out + d).slice(-20_000); };
  child.stdout.on('data', guarda); child.stderr.on('data', guarda);
  child.on('message', (m) => { const w = s.esperas.get(m?.id); if (w && m.tipo === w.tipo) { s.esperas.delete(m.id); w.resolve(m); } });
  s.fim = new Promise((resolve) => child.on('exit', (code) => { s.saiu = true; s.codigo = code; resolve(code); }));
  sup = s;
  log(`${rotulo} aberto`);
  return s;
}
function pedirIpc(s, tipo, extra = {}, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    if (s.saiu || !s.child.connected) { resolve(null); return; }
    const id = `${tipo}-${++s.seq}`;
    const t = setTimeout(() => { s.esperas.delete(id); resolve(null); }, timeoutMs);
    s.esperas.set(id, { tipo, resolve: (m) => { clearTimeout(t); resolve(m); } });
    try { s.child.send({ tipo, id, ...extra }); } catch { clearTimeout(t); s.esperas.delete(id); resolve(null); }
  });
}
const estadoSup = async () => (await pedirIpc(sup, 'estado'))?.estado ?? null;
let ultimoEstado = null;
const prontos = (e) => e?.processos?.cerebro?.estado === 'pronto' && e?.processos?.bot?.estado === 'pronto';
async function esperarProntos(rotulo, timeoutMs = 300_000, antes = null) {
  const limite = agora() + timeoutMs;
  while (agora() < limite) {
    const e = await estadoSup();
    if (e) ultimoEstado = e;
    if (prontos(e) && (!antes || ((antes.cerebro == null || e.processos.cerebro.pid !== antes.cerebro) && (antes.bot == null || e.processos.bot.pid !== antes.bot)))) return e;
    if (sup.saiu) throw new Error(`${rotulo}: o supervisor saiu (código ${sup.codigo}) antes de os processos ficarem prontos\n${sup.out.slice(-1500)}`);
    await sleep(2000);
  }
  throw new Error(`${rotulo}: tempo esgotado esperando os processos ficarem prontos\n${JSON.stringify(ultimoEstado?.processos ?? null).slice(0, 800)}`);
}
async function pararSupervisor(motivo) {
  if (!sup || sup.saiu) return sup?.codigo ?? null;
  try { sup.child.send({ tipo: 'desligar', motivo }); } catch { /* */ }
  const r = await Promise.race([sup.fim, sleep(90_000).then(() => 'tempo')]);
  if (r === 'tempo') { try { fs.writeFileSync(path.join(RAIZ, 'logs', 'supervisor.parar'), 'parar'); } catch { /* */ } await Promise.race([sup.fim, sleep(60_000)]); }
  if (!sup.saiu) { log('o supervisor não saiu a tempo; encerro só o processo que EU abri (handle)'); try { sup.child.kill(); } catch { /* */ } await Promise.race([sup.fim, sleep(10_000)]); }
  return sup.codigo;
}

// ── Mensagens ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let idSeq = 700_000;
let tokenSeq = 0;
const mensagens = new Map(); // id -> { quem, tipo, tokens, enviadoEm, finalEm, classe }
const PROGRESSO = /Processando|Sua solicitação está na fila/;
const finaisDe = (id, linhas = lerLinhas(ARQ.canal)) => linhas.filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !PROGRESSO.test(e.content)).map((e) => e.content);
function enviar(quem, texto, tipo = 'chat') {
  const id = String(++idSeq);
  const conteudo = quem.guild ? `<@${ID_BOT}> ${texto}` : texto;
  fs.appendFileSync(ARQ.inbox, `${JSON.stringify({ id, userId: quem.user, username: `pessoa${quem.user.slice(-3)}`, guildId: quem.guild, channelId: quem.channel, content: conteudo, at: Date.now() })}\n`);
  mensagens.set(id, { quem: quem.chave, tipo, texto, enviadoEm: agora(), finalEm: null, classe: null });
  return id;
}
async function aguardarFinal(id, timeoutMs = 150_000) {
  const limite = agora() + timeoutMs;
  while (agora() < limite) {
    const f = finaisDe(id);
    if (f.length) { const m = mensagens.get(id); m.finalEm = agora(); return f.at(-1); }
    await sleep(500);
  }
  return null;
}
const vistos = (texto) => { const m = /vistos=\[([^\]]*)\]/.exec(String(texto)); return m && m[1] ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []; };
const prontoParaMensagens = () => prontos(ultimoEstado);
// As marcas só têm letras e números ("tok-B12"): é o que a IA falsa reconhece no histórico (vistos=[...]); a letra depois de "tok-" diz de quem é.
const marcaDe = (quem) => `tok-${quem.chave}${++tokenSeq}`;
const vazouDe = (quem, texto) => vistos(texto).filter((t) => !t.startsWith(`tok-${quem.chave}`));
async function conversar(quem) {
  const marca = marcaDe(quem);
  const id = enviar(quem, `${marca} oi yui, tudo bem?`);
  const texto = await aguardarFinal(id);
  const m = mensagens.get(id);
  m.marca = marca;
  m.classe = texto === null ? 'sem_resposta' : /A Yui está indisponível agora/.test(texto) ? 'indisponivel' : 'resposta';
  if (texto !== null) m.vazou = vazouDe(quem, texto);
  return m;
}
async function pesquisar(quem) {
  const consulta = `consulta do soak ${marcaDe(quem)}`;
  fs.writeFileSync(ARQ.iaCtl, JSON.stringify({ ferramentaJson: JSON.stringify({ thought: 'pesquisar', tool: 'search_web', args: { query: consulta } }) }));
  let texto = null;
  let id = null;
  try {
    id = enviar(quem, `pesquise ${consulta}`, 'pesquisa');
    texto = await aguardarFinal(id, 180_000);
  } finally {
    fs.writeFileSync(ARQ.iaCtl, '{}');
  }
  const m = mensagens.get(id);
  m.classe = texto === null ? 'sem_resposta' : /A Yui está indisponível agora|temporariamente indisponível/.test(texto) ? 'indisponivel' : 'resposta';
  return m;
}

// ── Lembretes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const lembretes = []; // { marca, criadoEm, venceEm }
async function criarLembrete(marca, daquiMs) {
  const venceEm = agora() + daquiMs;
  const r = await apiOk('POST', '/v1/admin/reminders', { text: marca, at: new Date(venceEm).toISOString() });
  if (r.status !== 200) throw new Error(`não consegui criar o lembrete ${marca}: ${r.status} ${JSON.stringify(r.json ?? r.erro).slice(0, 200)}`);
  const l = { marca, id: r.json?.reminder?.id ?? null, criadoEm: agora(), venceEm, entregue: null };
  lembretes.push(l);
  return l;
}
const dmsDe = (marca) => lerLinhas(ARQ.dms).filter((d) => String(d.text ?? '').includes(marca));
async function lembreteSaiuDaLista(l, timeoutMs = 120_000) {
  const limite = agora() + timeoutMs;
  while (agora() < limite) {
    const r = await apiOk('GET', '/v1/admin/reminders');
    if (r.status === 200 && !(r.json?.reminders ?? []).some((x) => x.id === l.id)) return true;
    await sleep(2000);
  }
  return false;
}

// ── Cotas de busca por hora ────────────────────────────────────────────────────────────────────────────────────────────────────────
// O arquivo da cota SÓ poda as entradas com mais de 1 hora quando grava (no 1º teste de 2 h no ASUS, 2 entradas vencidas ainda estavam lá na conferência
// final e a conta "15 contra 13" foi um falso problema). `desde` (ms) conta só as entradas que ainda valem; sem ele, conta o arquivo como está (as conferências
// "antes e depois" de uma queda comparam o mesmo arquivo, sem que uma entrada vencida no meio mude a conta).
function cotaNoDisco({ desde = null } = {}) {
  const j = lerJson(ARQ.hora);
  const valem = (t) => desde === null || !Number.isFinite(Number(t)) || Number(t) >= desde;
  return { existe: j !== null, global: Array.isArray(j?.global) ? j.global.filter(valem).length : null, gravadoEm: j?.gravadoEm ?? null };
}
// o registro da busca falsa tem uma linha por busca ("agente" ou "busca") e uma por página lida ("pagina"): só as buscas contam na cota
const buscasRegistradas = () => lerLinhas(ARQ.buscaReg).filter((b) => b.tipo === 'agente' || b.tipo === 'busca');

// ── Amostras de RAM e CPU ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const amostras = []; // { t, papel, pid, estado, rssMB, heapMB, cpuMs, uptimeS, privadaMB? }
const livres = [];
function privadoDoSO(pids) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pids.length) { resolve(new Map()); return; }
    const cmd = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0};{1};{2}' -f $_.Id,[int]($_.WorkingSet64/1MB),[int]($_.PrivateMemorySize64/1MB) }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 30_000 }, (err, stdout) => {
      const m = new Map();
      if (!err) for (const l of String(stdout).split(/\r?\n/)) { const [id, ws, pv] = l.trim().split(';').map(Number); if (id) m.set(id, { ws, pv }); }
      resolve(m);
    });
  });
}
let amostrando = false;
let amostraN = 0;
let ultimoPrivado = 0;
const pidsVistos = new Set();
async function amostrar() {
  if (amostrando || !sup || sup.saiu) return;
  amostrando = true;
  try {
    const e = await estadoSup();
    if (!e) return;
    ultimoEstado = e;
    const t = agora();
    const linhas = [];
    const uso = e.supervisor?.uso;
    // `emMs`: o instante em que o PRÓPRIO processo mediu (a saúde que o supervisor guarda é de até 15 s atrás); o CPU% usa este instante
    if (uso) linhas.push({ papel: 'supervisor', pid: e.supervisor.pid, estado: 'pronto', rssMB: uso.rssMB, heapMB: uso.heapMB, cpuMs: (uso.cpuUserMs ?? 0) + (uso.cpuSystemMs ?? 0), uptimeS: uso.uptimeSeconds, emMs: t });
    for (const papel of ['cerebro', 'bot']) {
      const p = e.processos?.[papel];
      const u = p?.ultimaSaude?.uso;
      if (p?.pid && u) linhas.push({ papel, pid: p.pid, estado: p.estado, rssMB: u.rssMB, heapMB: u.heapMB, cpuMs: (u.cpuUserMs ?? 0) + (u.cpuSystemMs ?? 0), uptimeS: u.uptimeSeconds, emMs: Date.parse(p.ultimaSaude.em) || t });
    }
    amostraN += 1;
    // a RAM privada pelo SO, só dos PIDs que o supervisor informou: quando aparece um processo novo e, no mais, a cada 5 min
    const novos = linhas.some((l) => !pidsVistos.has(l.pid));
    if (novos || t - ultimoPrivado >= 300_000) {
      ultimoPrivado = t;
      const so = await privadoDoSO(linhas.map((l) => l.pid));
      for (const l of linhas) { const x = so.get(l.pid); if (x) { l.privadaMB = x.pv; l.wsMB = x.ws; } }
    }
    for (const l of linhas) pidsVistos.add(l.pid);
    for (const l of linhas) { const a = { t, ...l }; amostras.push(a); fs.appendFileSync(ARQ.amostras, `${JSON.stringify(a)}\n`); }
    livres.push({ t, mb: Math.round(os.freemem() / 1048576) });
  } finally { amostrando = false; }
}

// ── Saúde da produção (só leitura) e proteção do computador ────────────────────────────────────────────────────────────────────────
const saudeProducao = { leituras: 0, falhas: 0, seguidas: 0 };
async function conferirProducao() {
  if (!SAUDE_PROD) return true;
  saudeProducao.leituras += 1;
  let ok = false;
  try { const r = await fetch(SAUDE_PROD, { signal: AbortSignal.timeout(10_000) }); const j = await r.json(); ok = j?.ok === true && j?.discord?.online !== false; } catch { ok = false; }
  if (ok) saudeProducao.seguidas = 0; else { saudeProducao.falhas += 1; saudeProducao.seguidas += 1; }
  return ok;
}
let ramBaixaSeguidas = 0;
let abortada = null;
function verificarProtecao() {
  const mb = Math.round(os.freemem() / 1048576);
  ramBaixaSeguidas = mb < 300 ? ramBaixaSeguidas + 1 : 0;
  if (ramBaixaSeguidas >= 3) abortada ??= `RAM livre abaixo de 300 MB por 3 leituras seguidas (${mb} MB)`;
  if (saudeProducao.seguidas >= 2) abortada ??= 'a saúde da produção falhou 2 vezes seguidas';
}

// ── Eventos controlados ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const eventos = [];
const registrar = (nome, dados) => { const e = { nome, em: hhmmss(), ...dados }; eventos.push(e); log(`EVENTO ${nome}: ${JSON.stringify(dados)}`); return e; }
async function bateria(rotulo) {
  const r = [];
  for (const q of [A, B, C]) r.push(await conversar(q));
  const ok = r.every((m) => m.classe === 'resposta' && !(m.vazou?.length));
  registrar(`bateria depois de ${rotulo}`, { ok, classes: r.map((m) => m.classe) });
  return ok;
}
async function eventoBotCai() {
  const t0 = agora();
  const antes = ultimoEstado.processos;
  const l = await criarLembrete(`lembrete-bot-cai-${tokenSeq}`, 400);
  const saiu = await (async () => { const lim = agora() + 30_000; while (agora() < lim) { if (dmsDe(l.marca).length) return true; await sleep(300); } return false; })();
  sup.child.send({ tipo: 'simular-queda', papel: 'bot' });
  const e = await esperarProntos('bot caiu', 300_000, { bot: antes.bot.pid });
  const lista = await lembreteSaiuDaLista(l);
  await sleep(1500);
  const dms = dmsDe(l.marca).length;
  l.entregue = dms;
  registrar('o bot cai no meio do envio de um lembrete', { dmAntesDaQueda: saiu, dmsDoLembrete: dms, saiuDaLista: lista, cerebroIntocado: e.processos.cerebro.pid === antes.cerebro.pid, segundosParaVoltar: Math.round((agora() - t0) / 1000) });
  await bateria('a queda do bot');
}
// as conferências da cota só valem se já houve buscas: garante pelo menos uma antes dos eventos que olham o arquivo da cota
async function garantirBuscas() { if (!(cotaNoDisco().global > 0)) await pesquisar(B); }
async function eventoCerebroCai() {
  await garantirBuscas();
  const t0 = agora();
  const antes = ultimoEstado.processos;
  const cotaAntes = cotaNoDisco();
  const emVoo = enviar(A, `${marcaDe(A)} pergunta com a queda do cérebro`);
  await sleep(300);
  sup.child.send({ tipo: 'simular-queda', papel: 'cerebro' });
  const e = await esperarProntos('cérebro caiu', 300_000, { cerebro: antes.cerebro.pid });
  const texto = await aguardarFinal(emVoo, 240_000);
  const m = mensagens.get(emVoo);
  const finais = finaisDe(emVoo).length;
  m.classe = texto === null ? 'sem_resposta' : /A Yui está indisponível agora/.test(texto) ? 'indisponivel' : 'resposta';
  if (texto !== null) m.vazou = vazouDe(A, texto);
  const ligou = await (async () => { const lim = agora() + 60_000; while (agora() < lim) { const r = await apiOk('GET', '/v1/health'); if (r.json?.cerebro?.bot === true) return true; await sleep(1500); } return false; })();
  const cotaDepois = cotaNoDisco();
  registrar('o cérebro cai com uma mensagem em andamento', { respostasFinaisDaMensagem: finais, classeDaMensagem: m.classe, botNaoReligado: e.processos.bot.pid === antes.bot.pid, botReconectou: ligou, cotaGlobalAntes: cotaAntes.global, cotaGlobalDepois: cotaDepois.global, segundosParaVoltar: Math.round((agora() - t0) / 1000) });
  await bateria('a queda do cérebro');
}
async function eventoSupervisorReinicia() {
  await garantirBuscas();
  const t0 = agora();
  const cotaAntes = cotaNoDisco();
  const buscasAntes = buscasRegistradas().length;
  const antes = ultimoEstado.processos;
  const l = await criarLembrete(`lembrete-supervisor-${tokenSeq}`, 50_000); // vence enquanto o supervisor está fora
  const codigoDeSaida = await pararSupervisor('reinício controlado (soak)');
  const paradoEm = agora();
  await sleep(Math.max(0, 55_000 - (agora() - paradoEm))); // o lembrete vence com tudo parado
  const cotaParado = cotaNoDisco();
  iniciarSupervisor();
  const e = await esperarProntos('supervisor reiniciado', 400_000);
  const lista = await lembreteSaiuDaLista(l, 180_000);
  await sleep(1500);
  const dms = dmsDe(l.marca).length;
  l.entregue = dms;
  const cotaDepois = cotaNoDisco();
  registrar('reinício controlado do supervisor', {
    codigoDeSaidaDoSupervisorAnterior: codigoDeSaida, dmsDoLembrete: dms, saiuDaLista: lista, pidsNovos: e.processos.cerebro.pid !== antes.cerebro.pid && e.processos.bot.pid !== antes.bot.pid,
    cotaGlobalAntes: cotaAntes.global, cotaGlobalComTudoParado: cotaParado.global, cotaGlobalDepois: cotaDepois.global, buscasRegistradasAntes: buscasAntes, segundosFora: Math.round((agora() - paradoEm) / 1000), segundosTotal: Math.round((agora() - t0) / 1000),
  });
  await bateria('o reinício do supervisor');
}
async function eventoAmbosCaem() {
  const t0 = agora();
  const antes = ultimoEstado.processos;
  sup.child.send({ tipo: 'simular-queda', papel: 'bot' });
  sup.child.send({ tipo: 'simular-queda', papel: 'cerebro' });
  const e = await esperarProntos('os dois caíram', 400_000, { cerebro: antes.cerebro.pid, bot: antes.bot.pid });
  registrar('os dois caem de uma vez', { pidsNovos: e.processos.cerebro.pid !== antes.cerebro.pid && e.processos.bot.pid !== antes.bot.pid, segundosParaVoltar: Math.round((agora() - t0) / 1000) });
  await bateria('a queda dos dois');
}

// ── A rodada ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const inicio = agora();
const fim = inicio + MINUTOS * 60_000;
// As quedas vêm CEDO e o reinício do supervisor tarde, para sobrar um trecho LONGO sem nenhum evento (de ~25% a 70% da duração: ~54 min numa
// rodada de 2 h), onde o crescimento de memória dos três processos pode ser medido sem religamentos no meio.
const marcos = [
  { em: 0.08, nome: 'bot', fn: eventoBotCai }, { em: 0.17, nome: 'cerebro', fn: eventoCerebroCai },
  { em: 0.25, nome: 'ambos', fn: eventoAmbosCaem }, { em: 0.70, nome: 'supervisor', fn: eventoSupervisorReinicia },
].map((m) => ({ ...m, quando: inicio + m.em * MINUTOS * 60_000, feito: false }));
const rnd = (a, b) => a + Math.random() * (b - a);
const contadores = { chat: 0, pesquisa: 0, ignoradasPorProcessoForaDoAr: 0 };
let ultimoProgresso = agora();
let erroFatal = null;

async function rodada() {
  iniciarSupervisor();
  const e0 = await esperarProntos('subida', 300_000);
  registrar('subida', { cerebroPronto: e0.processos.cerebro.prontoEm, botPronto: e0.processos.bot.prontoEm, segundosAteProntos: Math.round((agora() - inicio) / 1000) });
  await amostrar();
  // a RAM livre é conferida a cada amostra (30 s: 3 leituras baixas seguidas = 90 s); a saúde da produção a cada 5 min
  const amostrador = setInterval(() => { amostrar().catch(() => {}); verificarProtecao(); }, INTERVALO_AMOSTRA_MS);
  const guarda = setInterval(() => { conferirProducao().then(() => verificarProtecao()).catch(() => {}); }, 300_000);
  await conferirProducao();
  try {
    await bateria('a subida');
    while (agora() < fim && !abortada) {
      const marco = marcos.find((m) => !m.feito && agora() >= m.quando);
      if (marco) { marco.feito = true; await marco.fn(); continue; }
      if (!prontoParaMensagens()) { contadores.ignoradasPorProcessoForaDoAr += 1; await sleep(3000); continue; }
      const quem = [A, B, C][Math.floor(Math.random() * 3)];
      if (Math.random() < 0.12) { await pesquisar(quem); contadores.pesquisa += 1; } else { await conversar(quem); contadores.chat += 1; }
      if (agora() - ultimoProgresso >= 300_000) {
        ultimoProgresso = agora();
        const usoAtual = ultimoEstado?.processos ? Object.entries(ultimoEstado.processos).map(([p, x]) => `${p}=${x.ultimaSaude?.uso?.rssMB ?? '?'}MB`).join(' ') : '';
        log(`progresso: ${Math.round((agora() - inicio) / 60000)}/${MINUTOS} min | chat=${contadores.chat} pesquisa=${contadores.pesquisa} | ${usoAtual} | RAM livre ${Math.round(os.freemem() / 1048576)} MB | produção: ${saudeProducao.falhas} falha(s)`);
      }
      await sleep(rnd(4_000, 45_000));
    }
    for (const m of marcos.filter((x) => !x.feito && !abortada)) { m.feito = true; await m.fn(); } // se a duração for curta, os eventos que faltam rodam no fim
  } finally {
    clearInterval(amostrador);
    clearInterval(guarda);
  }
  await amostrar();
  await conferirProducao();
}

// ── Análise final ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function inclinacao(pontos) { // MB por hora (mínimos quadrados); pontos: [{ h, y }]
  const n = pontos.length;
  if (n < 4) return null;
  const mx = pontos.reduce((s, p) => s + p.h, 0) / n;
  const my = pontos.reduce((s, p) => s + p.y, 0) / n;
  let num = 0; let den = 0;
  for (const p of pontos) { num += (p.h - mx) * (p.y - my); den += (p.h - mx) ** 2; }
  return den > 0 ? num / den : null;
}
function analisar() {
  const canal = lerLinhas(ARQ.canal);
  const porClasse = {};
  const duplicadas = [];
  const semResposta = [];
  const vazamentos = [];
  for (const [id, m] of mensagens) {
    const f = finaisDe(id, canal).length;
    if (f > 1) duplicadas.push({ id, finais: f, tipo: m.tipo });
    if (f === 0) semResposta.push({ id, tipo: m.tipo, aposSegundos: Math.round((agora() - m.enviadoEm) / 1000) });
    porClasse[m.classe ?? 'sem_classe'] = (porClasse[m.classe ?? 'sem_classe'] ?? 0) + 1;
    if (m.vazou?.length) vazamentos.push({ id, quem: m.quem, viu: m.vazou });
  }
  const entregues = lembretes.map((l) => ({ marca: l.marca, dms: dmsDe(l.marca).length }));
  const buscas = buscasRegistradas();
  const janela = agora() - 3_600_000;
  const cotaFinal = cotaNoDisco({ desde: janela }); // só as entradas ainda dentro da janela de 1 h (o arquivo só poda quando grava)
  const buscasNaJanela = buscas.filter((b) => !b.at || Date.parse(b.at) >= janela || Number(b.at) >= janela).length;
  // crescimento de memória por processo vivo (pid): ignora os primeiros 10 min do processo e exige 20 min de dados
  const porPid = new Map();
  for (const a of amostras) { const k = `${a.papel}:${a.pid}`; (porPid.get(k) ?? porPid.set(k, []).get(k)).push(a); }
  const memoria = [];
  for (const [k, xs] of porPid) {
    const t0 = xs[0].t;
    const uteis = xs.filter((x) => x.t - t0 >= 600_000);
    const minutos = Math.round((xs.at(-1).t - t0) / 60000);
    const rss = xs.map((x) => x.rssMB).filter(Number.isFinite);
    const slope = minutos >= 30 ? inclinacao(uteis.map((x) => ({ h: (x.t - t0) / 3_600_000, y: x.rssMB }))) : null;
    const privadas = xs.map((x) => x.privadaMB).filter(Number.isFinite);
    memoria.push({
      processo: k, minutosVivo: minutos, leituras: xs.length, rssInicio: rss[0], rssFim: rss.at(-1), rssMin: Math.min(...rss), rssMax: Math.max(...rss),
      heapFim: xs.at(-1).heapMB, privadaInicioMB: privadas[0] ?? null, privadaFimMB: privadas.at(-1) ?? null,
      crescimentoMBporHora: slope === null ? null : Math.round(slope * 10) / 10,
      cpuMedia: xs.length > 1 && xs.at(-1).emMs > xs[0].emMs ? Math.max(0, Math.round(((xs.at(-1).cpuMs - xs[0].cpuMs) / (xs.at(-1).emMs - xs[0].emMs)) * 1000) / 10) : null,
      atencao: slope !== null && slope > 10,
    });
  }
  const bloqueios = lerBloqueios(path.join(DADOS, 'bloqueio', 'bloqueio-externo.jsonl'));
  const emp = eventos.find((e) => e.nome === 'reinício controlado do supervisor');
  const problemas = [];
  if (abortada) problemas.push(`rodada abortada: ${abortada}`);
  if (erroFatal) problemas.push(`erro: ${erroFatal}`);
  if (duplicadas.length) problemas.push(`${duplicadas.length} mensagem(ns) com mais de uma resposta final`);
  if (semResposta.length) problemas.push(`${semResposta.length} mensagem(ns) sem resposta final`);
  if (vazamentos.length) problemas.push(`${vazamentos.length} vazamento(s) de contexto entre pessoas`);
  if (entregues.some((x) => x.dms !== 1)) problemas.push('algum lembrete não foi entregue exatamente uma vez');
  if (bloqueios.length) problemas.push(`${bloqueios.length} tentativa(s) de integração externa bloqueada(s)`);
  if (emp && emp.cotaGlobalDepois !== emp.cotaGlobalAntes) problemas.push(`a cota por hora mudou entre antes (${emp.cotaGlobalAntes}) e depois (${emp.cotaGlobalDepois}) do reinício do supervisor`);
  if (emp && !(emp.cotaGlobalAntes > 0)) problemas.push('a conferência da cota no reinício do supervisor não teve buscas para conferir');
  // nada perdido e nada em dobro: a cota no disco bate com as buscas que a busca falsa registrou na última hora
  if (cotaFinal.global !== null && cotaFinal.global !== buscasNaJanela) problemas.push(`a cota por hora no disco (${cotaFinal.global}) não bate com as buscas despachadas na última hora (${buscasNaJanela})`);
  if (saudeProducao.falhas > 0) problemas.push(`a saúde da produção falhou ${saudeProducao.falhas} vez(es) em ${saudeProducao.leituras}`);
  if (memoria.some((m) => m.atencao)) problemas.push('algum processo cresce mais de 10 MB/h de RAM (veja a memória)');
  const menorLivre = livres.length ? Math.min(...livres.map((l) => l.mb)) : null;
  return {
    resultado: problemas.length ? 'COM PROBLEMAS' : 'ESTÁVEL', problemas,
    minutosPedidos: MINUTOS, minutosRodados: Math.round((agora() - inicio) / 60000), abortada,
    mensagens: { total: mensagens.size, porClasse, duplicadas, semResposta, vazamentos }, cargas: contadores,
    lembretes: entregues, buscas: { despachadasRegistradas: buscas.length, naUltimaHora: buscasNaJanela, cotaGlobalNoDisco: cotaFinal.global },
    eventos, memoria, ramLivreMinimaMB: menorLivre, producao: { ...saudeProducao, conferida: SAUDE_PROD !== null }, bloqueiosExternos: bloqueios.length,
    supervisorLogUltimasLinhas: (() => { try { return fs.readFileSync(path.join(RAIZ, 'logs', 'supervisor.log'), 'utf8').split(/\r?\n/).slice(-15); } catch { return []; } })(),
  };
}
function texto(r) {
  const l = [];
  l.push(`RESULTADO: ${r.resultado} | ${r.minutosRodados}/${r.minutosPedidos} min${r.abortada ? ` | ABORTADA: ${r.abortada}` : ''}`);
  for (const p of r.problemas) l.push(`  PROBLEMA: ${p}`);
  l.push(`Mensagens: ${r.mensagens.total} | ${JSON.stringify(r.mensagens.porClasse)} | duplicadas ${r.mensagens.duplicadas.length} | sem resposta ${r.mensagens.semResposta.length} | vazamentos ${r.mensagens.vazamentos.length}`);
  l.push(`Cargas: ${JSON.stringify(r.cargas)} | Lembretes: ${r.lembretes.map((x) => `${x.marca}=${x.dms}`).join(', ') || 'nenhum'}`);
  l.push(`Buscas: despachadas ${r.buscas.despachadasRegistradas} (na última hora ${r.buscas.naUltimaHora}) | cota global no disco ${r.buscas.cotaGlobalNoDisco}`);
  l.push(`RAM livre mínima: ${r.ramLivreMinimaMB} MB | produção: ${r.producao.conferida ? `${r.producao.falhas} falha(s) em ${r.producao.leituras} leituras` : 'não conferida'} | bloqueios externos: ${r.bloqueiosExternos}`);
  l.push('Eventos:'); for (const e of r.eventos) l.push(`  ${e.em} ${e.nome}: ${JSON.stringify({ ...e, nome: undefined, em: undefined })}`);
  l.push('Memória (por processo vivo):');
  for (const m of r.memoria) l.push(`  ${m.processo.padEnd(18)} ${String(m.minutosVivo).padStart(4)} min | rss ${m.rssInicio}->${m.rssFim} MB (mín ${m.rssMin}, máx ${m.rssMax}) | privada ${m.privadaInicioMB ?? '-'}->${m.privadaFimMB ?? '-'} MB | heap ${m.heapFim} MB | crescimento ${m.crescimentoMBporHora ?? 'n/d'} MB/h | CPU ${m.cpuMedia ?? 'n/d'}%${m.atencao ? ' | ATENÇÃO' : ''}`);
  return l.join('\n');
}

try {
  await rodada();
} catch (err) {
  erroFatal = String(err?.stack ?? err).slice(0, 2000);
  log(`ERRO: ${erroFatal}`);
} finally {
  let codigoFinal = null;
  try { codigoFinal = await pararSupervisor('fim do soak'); } catch { /* */ }
  const r = analisar();
  r.codigoDeSaidaFinalDoSupervisor = codigoFinal;
  fs.writeFileSync(ARQ.resumoJson, JSON.stringify(r, null, 2));
  fs.writeFileSync(ARQ.resumoTxt, texto(r));
  console.log(`\n${texto(r)}\n`);
  process.exit(r.problemas.length ? 1 : 0);
}
