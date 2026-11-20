// Fase A do plano de 20/11/2026 (A1 a A4), contra o Google FALSO em 127.0.0.1 (tests/helpers/googleFalso.js; nada do Google de verdade é tocado):
//  A1. "E nesta semana?", "e amanhã?", "e as tarefas?" logo depois de uma consulta viram uma nova consulta REAL; sem consulta recente (10 min), ou fora do privado, não;
//  A3. pergunta sobre a própria agenda que a Yui não entende recebe uma ORIENTAÇÃO (nunca o modelo livre inventando "agenda livre" ou "não tenho acesso"); pedido de criar/mudar nada é capturado;
//  A4. aniversários: leitura DIRETA do calendário de aniversários (sem calendarList, sem escopo novo), "consultado e vazio" diferente de "inacessível".
// Execução: npm run test:googlecontinuacao   (node tests/test-google-continuacao.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarGoogleFalso, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } from './helpers/googleFalso.js';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-google-cont-'));
Object.assign(process.env, { DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: '111111111111111111', YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', LOG_LEVEL: 'error' });
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp);
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const say = (s) => process.stdout.write(`${s}\n`);

const fake = await criarGoogleFalso();
const E = await imp('src/integrations/google/endpoints.js');
const arq = await imp('src/integrations/google/arquivoToken.js');
const intencao = await imp('src/integrations/google/intencao.js');
const googleMod = await imp('src/integrations/google/google.js');
const { ROLES, MEMORY_SCOPES } = await imp('src/core/permissions.js');
E.definirHostsParaTeste(E.hostsDeBaseLocal(fake.base));

const AGORA = Date.parse('2026-11-20T15:00:00Z'); // 11:00 de sexta em Cuiabá
const FUSO = 'America/Cuiaba';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const arquivoToken = path.join(tmp, 'secrets', 'google-token.json');
arq.gravarArquivoDeToken(arquivoToken, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, escopos: [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], criadoEm: '2026-11-19T00:00:00.000Z' }, { restringir: () => {} });
const env = { YUI_GOOGLE: 'true', YUI_GOOGLE_TOKEN_ARQUIVO: arquivoToken, YUI_GOOGLE_FUSO: FUSO };
const VALIDADA = () => ({ estado: 'validada' });
const dono = { role: ROLES.OWNER, memoryScope: MEMORY_SCOPES.PERSONAL };
const relogio = { t: AGORA };
const novo = () => googleMod.criarGoogle({ env, agora: () => relogio.t, alertar: () => true, log: quiet, estadoDaRota: VALIDADA, timeoutMs: 1500, restringir: () => {} });
const perguntar = (g, texto, ctx = dono, call = {}) => g.rotear({ ctx, call, texto, prompt: `user: "${texto}"` });
const reset = () => {
  fake.limpar();
  fake.estado.refreshValidos = new Set([REFRESH_TOKEN]);
  Object.assign(fake.estado, { modoToken: 'ok', modoApi: {}, aniversariosModo: 'ok', eventos: [], tarefas: [], aniversarios: [] });
};
const consultasDeEventos = () => fake.pedidos.filter((p) => p.caminho === '/calendar/v3/calendars/primary/events');
const consultasDeAniversarios = () => fake.pedidos.filter((p) => decodeURIComponent(p.caminho).includes('addressbook#contacts'));
const consultasDeTarefas = () => fake.pedidos.filter((p) => p.caminho === '/tasks/v1/lists/@default/tasks');

let passed = 0; const failures = [];
const test = async (nome, fn) => { try { await fn(); passed += 1; say(`  ok  ${nome}`); } catch (e) { failures.push(nome); say(`  FALHOU  ${nome}\n    ${String(e?.stack ?? e).split('\n').slice(0, 4).join('\n    ')}`); } };

try {
  say('A1. continuação');
  await test('classificador: "e nesta semana?", "e amanhã?", "e as tarefas?" só valem com consulta recente', () => {
    const ult = { tipo: 'agenda', periodo: 'hoje', em: AGORA - 60_000 };
    assert.deepEqual(intencao.classificarContinuacao('E nesta semana?', ult, AGORA), { tipo: 'agenda', periodo: 'semana' });
    assert.deepEqual(intencao.classificarContinuacao('e amanhã?', ult, AGORA), { tipo: 'agenda', periodo: 'amanha' });
    assert.deepEqual(intencao.classificarContinuacao('e as tarefas?', ult, AGORA), { tipo: 'tarefas', periodo: null });
    assert.deepEqual(intencao.classificarContinuacao('e a agenda de amanhã?', { tipo: 'tarefas', periodo: null, em: AGORA - 1000 }, AGORA), { tipo: 'agenda', periodo: 'amanha' });
    assert.deepEqual(intencao.classificarContinuacao('e amanhã?', { tipo: 'tarefas', periodo: null, em: AGORA - 1000 }, AGORA), { tipo: 'tarefas', periodo: 'amanha' });
    assert.equal(intencao.classificarContinuacao('e nesta semana?', null, AGORA), null, 'sem consulta anterior');
    assert.equal(intencao.classificarContinuacao('e nesta semana?', { ...ult, em: AGORA - 11 * 60_000 }, AGORA), null, 'consulta velha (mais de 10 min)');
    assert.equal(intencao.classificarContinuacao('e nesta semana?', { tipo: 'email', periodo: null, em: AGORA }, AGORA), null, 'e-mail nunca continua');
    for (const conversa of ['e aí, tudo bem?', 'e o jogo de hoje no GTA, como foi?', 'e se eu comprar um carro amanhã?', 'e', 'e a Maria?', 'nesta semana?', 'e hoje o que a gente faz de jantar']) {
      assert.equal(intencao.classificarContinuacao(conversa, ult, AGORA), null, `conversa comum não é continuação: ${conversa}`);
    }
  });
  await test('rotear: "e nesta semana?" depois de "o que tenho hoje na agenda?" CONSULTA o Google de novo (a janela de 7 dias)', async () => {
    reset();
    const g = novo();
    const r1 = await perguntar(g, 'o que tenho hoje na agenda?');
    assert.equal(r1.tipo, 'agenda');
    const antes = consultasDeEventos().length;
    const r2 = await perguntar(g, 'E nesta semana?');
    assert.equal(r2.tipo, 'agenda', 'virou consulta, não conversa livre');
    assert.equal(consultasDeEventos().length, antes + 1, 'o Google foi consultado de verdade');
    assert.match(r2.prompt, /próximos 7 dias/);
    assert.match(r2.prompt, /nenhum compromisso encontrado/);
  });
  await test('rotear: sem consulta recente, "e nesta semana?" segue como conversa (null) e não toca o Google', async () => {
    reset();
    const g = novo();
    assert.equal(await perguntar(g, 'E nesta semana?'), null);
    assert.equal(fake.pedidos.length, 0);
    await perguntar(g, 'minhas tarefas');
    relogio.t = AGORA + 11 * 60_000;
    assert.equal(await perguntar(g, 'e amanhã?'), null, 'a consulta de 11 minutos atrás já não vale');
    relogio.t = AGORA;
  });
  await test('rotear: a continuação não vale fora do privado, na voz nem para quem não é o dono', async () => {
    reset();
    const g = novo();
    await perguntar(g, 'minhas tarefas');
    const n = fake.pedidos.length;
    assert.equal(await perguntar(g, 'e amanhã?', { role: ROLES.OWNER, memoryScope: MEMORY_SCOPES.GUILD }), null);
    assert.equal(await perguntar(g, 'e amanhã?', dono, { voice: true }), null);
    assert.equal(await perguntar(g, 'e amanhã?', { role: ROLES.MEMBER, memoryScope: MEMORY_SCOPES.PERSONAL }), null);
    assert.equal(fake.pedidos.length, n, 'nenhuma consulta nova');
  });

  say('A3. orientação em vez de inventar');
  await test('classificador: pergunta sobre a própria agenda não reconhecida é detectada; criar/mudar e conversa comum não', () => {
    for (const pergunta of ['qual é o meu compromisso mais importante desse mês?', 'o que eu tenho na minha agenda de sábado que vem?', 'tem alguma coisa marcada no meu calendário no dia 25?', 'quais tarefas minhas estão atrasadas?']) {
      assert.equal(intencao.classificarPedido(pergunta), null, `não é pedido curto: ${pergunta}`);
      assert.equal(intencao.pareceAgendaNaoReconhecida(pergunta), true, pergunta);
    }
    for (const outro of ['colocar na agenda amanhã: 08:00 lavar o carro', 'me lembra de olhar a minha agenda amanhã', 'cria um compromisso na minha agenda sexta', 'a agenda do GTA da semana tem o quê?', 'como está o clima?', 'minha agenda está uma bagunça', 'a minha tarefa de casa de matemática é difícil?\nme ajuda']) {
      assert.equal(intencao.pareceAgendaNaoReconhecida(outro), false, `não deve capturar: ${outro}`);
    }
  });
  await test('rotear: devolve a orientação (resposta fixa, sem IA, sem tocar o Google) só para o dono no privado', async () => {
    reset();
    const g = novo();
    const r = await perguntar(g, 'qual é o meu compromisso mais importante desse mês?');
    assert.equal(r.resposta, googleMod.FRASES.naoEntendi);
    assert.match(r.resposta, /pedidos curtos/);
    assert.ok(!/n[aã]o tenho acesso/i.test(r.resposta));
    assert.equal(fake.pedidos.length, 0, 'nada foi baixado');
    assert.equal(await perguntar(g, 'qual é o meu compromisso mais importante desse mês?', { role: ROLES.MEMBER, memoryScope: MEMORY_SCOPES.PERSONAL }), null, 'membro segue o fluxo de sempre');
    assert.equal(await perguntar(g, 'qual é o meu compromisso mais importante desse mês?', dono, { voice: true }), null, 'na voz não orienta');
    assert.equal(g.estado().naoEntendidos, 1);
  });

  say('A4. aniversários');
  await test('classificador: pedidos de aniversário curtos; nome de pessoa fica de fora', () => {
    assert.deepEqual(intencao.classificarPedido('quando é o próximo aniversário?'), { tipo: 'aniversarios', periodo: 'ano' });
    assert.deepEqual(intencao.classificarPedido('quando é o próximo aniversário do meu calendário?'), { tipo: 'aniversarios', periodo: 'ano' });
    assert.deepEqual(intencao.classificarPedido('tem aniversário hoje?'), { tipo: 'aniversarios', periodo: 'hoje' });
    assert.deepEqual(intencao.classificarPedido('aniversários da semana'), { tipo: 'aniversarios', periodo: 'semana' });
    assert.deepEqual(intencao.classificarPedido('aniversariantes do mês'), { tipo: 'aniversarios', periodo: 'mes' });
    assert.equal(intencao.classificarPedido('quando é o aniversário da Maria?'), null);
    assert.equal(intencao.classificarPedido('me ajuda a planejar a festa de aniversário do meu filho'), null);
    assert.deepEqual(intencao.classificarContinuacao('e amanhã?', { tipo: 'aniversarios', periodo: 'hoje', em: AGORA }, AGORA), { tipo: 'aniversarios', periodo: 'amanha' });
  });
  await test('rotear: lê DIRETO o calendário de aniversários (nunca calendarList), só GET, com o escopo atual', async () => {
    reset();
    fake.estado.aniversarios = [{ summary: 'Aniversário de Fulana de Tal', start: { date: '2026-12-02' }, end: { date: '2026-12-03' } }, { summary: 'Aniversário de Beltrano', start: { date: '2027-03-01' }, end: { date: '2027-03-02' } }];
    const g = novo();
    const r = await perguntar(g, 'quando é o próximo aniversário?');
    assert.equal(r.tipo, 'aniversarios');
    assert.match(r.prompt, /Fulana de Tal/);
    assert.match(r.prompt, /Beltrano/);
    assert.match(r.prompt, /o próximo ano/);
    assert.equal(consultasDeAniversarios().length, 1);
    assert.ok(!fake.pedidos.some((p) => /calendarList/.test(p.caminho)), 'nenhuma enumeração de calendários');
    assert.equal(consultasDeEventos().length, 0, 'o calendário principal não foi consultado');
    assert.ok(consultasDeAniversarios().every((p) => p.metodo === 'GET'));
  });
  await test('rotear: consultado e VAZIO é diferente de inacessível', async () => {
    reset();
    const g = novo();
    const vazio = await perguntar(g, 'tem aniversário hoje?');
    assert.match(vazio.prompt, /foi consultado: nenhum aniversário nesse período/);
    reset();
    fake.estado.aniversariosModo = '404';
    const g2 = novo();
    const fora = await perguntar(g2, 'tem aniversário hoje?');
    assert.equal(fora.resposta, googleMod.FRASES.aniversariosInacessiveis);
    reset();
    fake.estado.modoApi.aniversarios = '403';
    const g3 = novo();
    assert.equal((await perguntar(g3, 'tem aniversário hoje?')).resposta, googleMod.FRASES.aniversariosInacessiveis);
  });
  await test('rotear: o portão da rota privada vale também para os aniversários; só o dono no privado', async () => {
    reset();
    const g = googleMod.criarGoogle({ env, agora: () => AGORA, alertar: () => true, log: quiet, estadoDaRota: () => ({ estado: 'bloqueada' }), timeoutMs: 1500, restringir: () => {} });
    assert.match((await perguntar(g, 'quando é o próximo aniversário?')).resposta, /rota privada/);
    assert.equal(fake.pedidos.length, 0);
    const g2 = novo();
    assert.equal(await perguntar(g2, 'quando é o próximo aniversário?', { role: ROLES.MEMBER, memoryScope: MEMORY_SCOPES.PERSONAL }), null);
    assert.equal((await perguntar(g2, 'quando é o próximo aniversário?', dono, { voice: true })).resposta, googleMod.FRASES.soPrivado);
    assert.equal(fake.pedidos.length, 0);
  });

  say('regressão: os pedidos de sempre continuam iguais');
  await test('agenda e tarefas de sempre', async () => {
    reset();
    const g = novo();
    assert.equal((await perguntar(g, 'minha agenda de amanhã')).tipo, 'agenda');
    assert.equal((await perguntar(g, 'compromissos da semana')).tipo, 'agenda');
    assert.equal((await perguntar(g, 'minhas tarefas')).tipo, 'tarefas');
    assert.equal(consultasDeTarefas().length, 1);
    assert.equal(await perguntar(g, 'me conta do meu dia'), null);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
  E.definirHostsParaTeste(null);
  try { await fake.close(); } catch { /* */ }
  try { process.chdir(repoRoot); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
