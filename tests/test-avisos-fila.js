// Avisos na hora certa LIGADOS (Fase 3, parte 3A): fila em disco e descarga. Dublês, pasta temporária, sem rede.
// Execução: npm run test:avisosfila
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-avisos-fila-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');

const F = await import('../src/core/avisos/fila.js');
const { createAlerter } = await import('../src/core/alerts.js');
const { entregarAviso } = await import('../src/cerebro/monitores/entrega.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const FUSO = 'America/Cuiaba';
const em = (iso) => Date.parse(`${iso}-04:00`);
const mudo = { info() {}, warn() {} };
let n = 0;
function montar(extra = {}) {
  const env = { YUI_AVISOS_FILTRO: 'ligar', YUI_FUSO: FUSO, ...extra };
  const relogio = { t: em('2026-11-26T23:30:00') };
  const file = path.join(tmp, `fila-${++n}.json`);
  const novo = () => F.criarFiltroDeAvisos({ env, file, now: () => relogio.t, logger: mudo });
  const dms = [];
  const enviar = async (texto, o) => { dms.push({ texto, ...o }); return true; };
  return { env, relogio, file, novo, f: novo(), dms, enviar };
}
const alerter = (m, notify) => createAlerter({ ownerId: '111111111111111111', env: m.env, now: () => m.relogio.t, filtro: m.f, notify });

await test('desligado ou observando: nada é guardado nem criado e tudo sai na hora', async () => {
  for (const modo of ['off', 'observar']) {
    const m = montar({ YUI_AVISOS_FILTRO: modo });
    const sairam = [];
    assert.equal(await alerter(m, async (_i, t) => { sairam.push(t); }).alert('youtube', 'T', 'D'), true);
    await m.f.passada({ enviar: m.enviar });
    assert.equal(sairam.length, 1);
    assert.equal(m.f.agendarResumo(), false);
    assert.equal(fs.existsSync(m.file), false);
  }
});

await test('silêncio que cruza a meia-noite: guarda, sobrevive a reinício, agrupa e só sai depois', async () => {
  const m = montar();
  const diretos = [];
  const a = alerter(m, async (_i, t) => { diretos.push(t); });
  assert.equal(await a.alert('youtube', 'Um'), 'adiado');
  assert.equal(await a.alert('twitch', 'Dois'), 'adiado');
  assert.equal(await a.alert('lock-login', 'Critico'), true);
  assert.equal(await a.alert('chave-nova', 'Desconhecida'), true);
  assert.equal(diretos.length, 2);
  m.relogio.t = em('2026-11-27T06:59:00');
  await m.f.passada({ enviar: m.enviar });
  assert.equal(m.dms.length, 0);
  m.relogio.t = em('2026-11-27T07:00:00');
  const depois = m.novo(); // reinício
  await depois.passada({ enviar: m.enviar });
  assert.equal(m.dms.length, 1);
  assert.match(m.dms[0].texto, /Um[\s\S]*Dois/);
  assert.equal(depois.status().guardados, 0);
});

await test('só sai da fila com envio confirmado; incerto repete com chave nova; fica "enviando" antes de pedir', async () => {
  const m = montar();
  m.f.filtrar({ chave: 'evento:disco', texto: 'disco' });
  m.relogio.t = em('2026-11-27T08:00:00');
  const chaves = [];
  for (const r of [false, { incerto: true }, true]) {
    await m.f.passada({ enviar: async (_t, o) => { chaves.push(o.idem); assert.match(fs.readFileSync(m.file, 'utf8'), /"estado":"enviando"/); return r; } });
  }
  assert.equal(chaves[0], chaves[1]);
  assert.notEqual(chaves[1], chaves[2]);
  assert.equal(m.f.status().guardados, 0);
});

await test('voltar para off envia o que estava guardado; a mesma chave e texto não entram duas vezes', async () => {
  const m = montar();
  assert.equal(m.f.filtrar({ chave: 'boot', texto: 'a' }).acao, 'adiado');
  assert.equal(m.f.filtrar({ chave: 'boot', texto: 'a' }).acao, 'adiado');
  assert.equal(m.f.status().guardados, 1);
  m.env.YUI_AVISOS_FILTRO = 'off';
  await m.f.passada({ enviar: m.enviar });
  assert.equal(m.dms.length, 1);
});

await test('envio direto que falha vira fila; quem pede confirmação só recebe true depois de sair', async () => {
  const m = montar();
  m.relogio.t = em('2026-11-26T12:00:00');
  const a = alerter(m, async () => { throw new Error('DM fora'); });
  const pedir = () => a.alert('google-reautorizar', 'G', '', { confirmado: true, cooldownMinutes: 1 });
  assert.equal(await pedir(), 'adiado');
  m.relogio.t += 6 * 60_000;
  await m.f.passada({ enviar: m.enviar });
  assert.equal(m.dms.length, 1);
  assert.equal(await pedir(), true);
});

await test('teto: nada é descartado; os guardados vão no resumo, que repete até sair', async () => {
  const m = montar({ YUI_AVISOS_POR_DIA: '0' });
  m.relogio.t = em('2026-11-26T12:00:00');
  assert.equal(m.f.filtrar({ chave: 'youtube', texto: 'info' }).acao, 'adiado');
  assert.equal(m.f.filtrar({ chave: 'ai-down', texto: 'um' }).acao, 'enviar');
  assert.equal(m.f.filtrar({ chave: 'ai-down', texto: 'dois' }).acao, 'adiado');
  const secoes = [];
  let ok = false;
  m.f.definirResumo(async (s) => { secoes.push(s); return { ok, secaoConfirmada: ok }; });
  m.relogio.t = em('2026-11-27T05:00:00');
  assert.equal(m.f.agendarResumo(), true);
  await m.f.passada({ enviar: m.enviar });
  assert.equal(secoes.length, 0, 'no silêncio não sai');
  m.relogio.t = em('2026-11-27T08:00:00');
  await m.f.passada({ enviar: m.enviar });
  assert.equal(m.f.status().resumoPendente, true);
  ok = true;
  m.relogio.t += 6 * 60_000;
  await m.f.passada({ enviar: m.enviar });
  assert.match(secoes[1], /Avisos de ontem[\s\S]*info[\s\S]*dois/);
  assert.deepEqual(m.f.status(), { guardados: 0, resumoPendente: false });
  assert.equal(m.dms.length, 0);
});

await test('fila ilegível: envia e não toca no arquivo', async () => {
  const m = montar();
  fs.writeFileSync(m.file, '{quebrado');
  assert.equal(m.f.filtrar({ chave: 'boot', texto: 'a' }).acao, 'enviar');
  assert.equal(m.f.podeSair('monitor:novidade'), true);
  assert.equal(m.f.agendarResumo(), false);
  await m.f.passada({ enviar: m.enviar });
  assert.equal(fs.readFileSync(m.file, 'utf8'), '{quebrado');
});

await test('bot separado: sem confirmação do cérebro envia direto; o método do canal guarda', async () => {
  const m = montar();
  const handlers = {};
  F.registrarMetodoDosAvisos({ handle: (nome, fn, o) => { handlers[nome] = fn; assert.deepEqual(o, { roles: ['bot'] }); } }, m.f);
  const fora = F.criarFiltroRemoto({ request: async () => { throw new Error('cérebro fora'); } }, { env: m.env });
  assert.equal((await fora.filtrar({ chave: 'boot', texto: 'a' })).acao, 'enviar');
  const dentro = F.criarFiltroRemoto({ request: (nome, p) => handlers[nome](p) }, { env: m.env });
  assert.equal((await dentro.filtrar({ chave: 'boot', texto: 'a' })).acao, 'adiado');
  assert.equal(m.f.status().guardados, 1);
});

await test('monitor: adiado antes de "enviando", sem contar tentativa nem mexer no estado', async () => {
  const m = montar();
  const aviso = { tipo: 'novidade', estado: 'pendente', chave: 'monitor:1:fim', tentativas: 0 };
  const store = { obter: () => ({ id: 1, avisos: 0, aviso }), atualizar: () => assert.fail('não grava nada') };
  const r = await entregarAviso({ store, id: 1, texto: () => 'x', enviar: () => assert.fail('não envia'), avisos: m.f });
  assert.equal(r.resultado, 'adiado');
});

await test('mesmo texto adiado em outro dia ganha chave de envio nova (o bot não responde "repetido")', async () => {
  const m = montar();
  for (const dia of ['27', '28']) {
    m.relogio.t = em(`2026-11-${dia}T02:00:00`);
    assert.equal(m.f.filtrar({ chave: 'boot', texto: 'Estou no ar' }).acao, 'adiado');
    m.relogio.t = em(`2026-11-${dia}T08:00:00`);
    await m.f.passada({ enviar: m.enviar });
  }
  assert.equal(m.dms.length, 2);
  assert.notEqual(m.dms[0].idem, m.dms[1].idem);
});

await test('outra ocorrência com o mesmo texto não conta como já entregue', async () => {
  const m = montar();
  m.relogio.t = em('2026-11-27T02:00:00');
  const sairam = [];
  const a = alerter(m, async (_i, t) => { sairam.push(t); });
  const pedir = (ocorrencia) => a.alert('google-reautorizar', 'G', '', { confirmado: true, cooldownMinutes: 1, ocorrencia });
  assert.equal(await pedir('um'), 'adiado');
  m.relogio.t = em('2026-11-27T08:00:00');
  await m.f.passada({ enviar: m.enviar });
  m.relogio.t = em('2026-11-27T15:00:00');
  assert.equal(await pedir('um'), true);
  assert.equal(sairam.length, 0);
  m.relogio.t += 2 * 60_000;
  assert.equal(await pedir('dois'), true);
  assert.equal(sairam.length, 1);
});

await test('disco que recusa a gravação depois do envio não repete a DM a cada passada', async () => {
  const m = montar();
  m.f.filtrar({ chave: 'boot', texto: 'a' });
  m.relogio.t = em('2026-11-27T08:00:00');
  const original = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('cheio'), { code: 'ENOSPC' }); };
  try {
    await m.f.passada({ enviar: m.enviar });
    await m.f.passada({ enviar: m.enviar });
  } finally { fs.renameSync = original; }
  assert.equal(m.dms.length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
