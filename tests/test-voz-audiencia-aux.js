import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registrarAudiencia } from '../src/core/auditoriaAudiencia.js';
import { criarMedidor, formatarLinha } from '../src/core/latenciaVoz.js';
import { verifyAudit } from '../src/core/audit.js';
import { decidirAudiencia, INTERFACE } from '../src/core/politicaAudiencia.js';

const NOME = 'Fulano de Tal Secreto';
const ID = '123456789012345678';
const TEXTO = 'abra minha agenda de amanha por favor';

function decisaoPrivada() {
  return decidirAudiencia({
    interface: INTERFACE.VOZ, chaveLigada: true, falanteVerificado: true, falanteEhDono: true,
    donoPresente: true, humanosNaCall: 1, dirigida: true,
  });
}
function decisaoPublica() {
  return decidirAudiencia({
    interface: INTERFACE.VOZ, chaveLigada: true, falanteVerificado: true, falanteEhDono: true,
    donoPresente: true, humanosNaCall: 3, dirigida: false,
  });
}

test('auditoria de audiencia: gravação real, sem identidade, cadeia íntegra', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-aud-aux-'));
  const arquivo = path.join(tmp, 'audit.jsonl');
  const anterior = process.env.YUI_AUDIT_FILE;
  process.env.YUI_AUDIT_FILE = arquivo;
  t.after(() => {
    if (anterior === undefined) delete process.env.YUI_AUDIT_FILE; else process.env.YUI_AUDIT_FILE = anterior;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('grava politica.audiencia e politica.audiencia.bloqueio', () => {
    // campos "extras" no objeto de decisão (nome, id, texto) não podem vazar para a linha
    const d1 = { ...decisaoPrivada(), userId: ID, nome: NOME, texto: TEXTO };
    const e1 = registrarAudiencia(d1, { turnId: 'abc123def456' });
    const e2 = registrarAudiencia({ ...decisaoPublica(), userId: ID, nome: NOME, texto: TEXTO }, { turnId: 'abc123def456', bloqueio: 'google' });
    assert.equal(e1.action, 'politica.audiencia');
    assert.equal(e2.action, 'politica.audiencia.bloqueio');

    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(linhas.length, 2);
    assert.equal(linhas[0].event, 'politica.audiencia');
    assert.equal(linhas[1].event, 'politica.audiencia.bloqueio');
    assert.equal(linhas[1].blocked_resource, 'google');
    assert.equal(linhas[0].platform, 'discord');
    assert.equal(linhas[0].channelKind, 'voz');
    assert.equal(linhas[0].userId, null);
    assert.equal(linhas[0].audience_level, 'privado');
    assert.equal(linhas[1].audience_level, 'publico');
    assert.equal(linhas[1].human_count, 3);
  });

  await t.test('a linha serializada não contém id, nome nem texto', () => {
    const bruto = fs.readFileSync(arquivo, 'utf8');
    for (const proibido of [ID, NOME, TEXTO, 'Fulano']) assert.equal(bruto.includes(proibido), false, proibido);
  });

  await t.test('hash encadeado confere', () => {
    const v = verifyAudit(arquivo);
    assert.equal(v.ok, true);
    assert.equal(v.chained, 2);
  });

  await t.test('nunca lança se a gravação falhar (auditFn lançando e caminho inválido)', () => {
    assert.doesNotThrow(() => registrarAudiencia(decisaoPrivada(), { turnId: 'x', auditFn: () => { throw new Error('boom'); } }));
    const bloqueado = path.join(tmp, 'arquivo_no_lugar_de_pasta');
    fs.writeFileSync(bloqueado, 'x');
    process.env.YUI_AUDIT_FILE = path.join(bloqueado, 'sub', 'a.jsonl');
    assert.doesNotThrow(() => registrarAudiencia(decisaoPrivada(), { turnId: 'x', env: { YUI_ALERTS: 'false' } }));
    process.env.YUI_AUDIT_FILE = arquivo;
    assert.doesNotThrow(() => registrarAudiencia(null, { turnId: 'x' }));
    assert.doesNotThrow(() => registrarAudiencia(undefined));
  });

  await t.test('chama o auditFn com o contrato (action, ctx sem userId, resto, env)', () => {
    let chamada = null;
    const env = { A: '1' };
    registrarAudiencia(decisaoPublica(), { turnId: 't1', env, auditFn: (...a) => { chamada = a; } });
    assert.equal(chamada[0], 'politica.audiencia');
    assert.deepEqual(chamada[1], { platform: 'discord', channelKind: 'voz' });
    assert.equal('action' in chamada[2], false);
    assert.equal(chamada[2].turn_id, 't1');
    assert.equal(chamada[3].env, env);
  });
});

test('latência de voz: linha, medidor e robustez', async (t) => {
  await t.test('linha só com rótulos, inteiros e o id; ausentes saem "-"', () => {
    const l = formatarLinha('a1b2c3d4e5f6', { stt: 120, fila: 5, tts: 300.6, total: 900 });
    assert.equal(l, '[VOZ-LAT] turno=a1b2c3d4e5f6 stt=120 fila=5 ctx=- prov=- ferr=- tts=301 entrega=- total=900');
    assert.match(l, /^\[VOZ-LAT\] turno=[0-9a-zA-Z_-]+( (stt|fila|ctx|prov|ferr|tts|entrega|total)=(\d+|-))+$/);
  });

  await t.test('valores inválidos e texto nunca entram na linha', () => {
    const l = formatarLinha('abc def\nsegredo!', { stt: -5, fila: NaN, ctx: 'olá mundo', prov: Infinity, ferr: null, tts: undefined });
    assert.equal(l.includes('\n'), false);
    assert.equal(l.includes('olá'), false);
    assert.match(l, /stt=- fila=- ctx=- prov=- ferr=- tts=- entrega=- total=-$/);
    assert.equal(formatarLinha(null, null), '[VOZ-LAT] turno=- stt=- fila=- ctx=- prov=- ferr=- tts=- entrega=- total=-');
  });

  await t.test('medidor com relógio falso', () => {
    let agora = 1000;
    const m = criarMedidor({ turnoId: 'abcdef012345', relogio: () => agora });
    m.inicio('stt'); agora += 250; m.fim('stt');
    m.inicio('prov'); agora += 40; m.fim('prov');
    m.marcar('total', 700);
    assert.deepEqual(m.valores(), { stt: 250, prov: 40, total: 700 });
    assert.equal(m.linha(), '[VOZ-LAT] turno=abcdef012345 stt=250 fila=- ctx=- prov=40 ferr=- tts=- entrega=- total=700');
  });

  await t.test('fim sem início, etapa desconhecida e fim duplicado não lançam', () => {
    let agora = 5000;
    const m = criarMedidor({ turnoId: 'x', relogio: () => agora });
    assert.doesNotThrow(() => { m.fim('tts'); m.inicio('inexistente'); m.fim('inexistente'); m.marcar('inexistente', 5); });
    m.inicio('tts'); agora += 10; m.fim('tts'); agora += 10; m.fim('tts');
    assert.deepEqual(m.valores(), { tts: 10 });
  });

  await t.test('relógio que anda para trás ou lança nunca gera negativo nem exceção', () => {
    let agora = 9000;
    const m = criarMedidor({ turnoId: 'x', relogio: () => agora });
    m.inicio('ctx'); agora -= 500; m.fim('ctx');
    assert.equal(m.valores().ctx, 0);
    m.marcar('ferr', -30);
    assert.equal('ferr' in m.valores(), false);
    const ruim = criarMedidor({ turnoId: 'x', relogio: () => { throw new Error('relogio'); } });
    assert.doesNotThrow(() => { ruim.inicio('stt'); ruim.fim('stt'); ruim.linha(); });
    const nan = criarMedidor({ turnoId: 'x', relogio: () => NaN });
    assert.doesNotThrow(() => { nan.inicio('stt'); nan.fim('stt'); });
    assert.deepEqual(nan.valores(), {});
  });
});
