// CORREÇÃO C6 do parecer da Liz (docs/PLANO_LACUNAS_PAINEL_CORRECOES.md, 27/11/2026): TODA rota do painel que muda algo, conferida de uma vez.
//  A. o inventário: cada rota de escrita do painel (src/core/api/server.js) está na tabela abaixo, com a classe dela, e no routeGuard (uma ação da matriz).
//     Rota nova que não entrar na tabela faz este teste falhar: alguém precisa decidir se ela é idempotente, se tem limite próprio ou se leva o freio;
//  B. o dono é conferido no PRÓPRIO serviço (o createAdmin), não só na rota nem no PANEL_ACTIONS: membro chamando o método direto recebe 403;
//  C. cada ação concluída é auditada (no método ou no serviço que ela chama);
//  D. a tentativa NEGADA também é auditada (`admin.negado`, só a ação e o código HTTP: nunca a mensagem, o corpo nem os argumentos);
//  E. o freio de pedido repetido nas ações que não são idempotentes: o mesmo pedido em 5 s é recusado (429) e nada é feito de novo; outro pedido passa;
//     sair da live fica sem freio (a parada funciona sempre e é idempotente: sair de novo só diz que não está em live).
// Num processo só, pasta temporária, sem .env, sem rede. Execução: npm run test:painelescritas
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-escritas-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const AUDIT = path.join(tmp, 'audit.jsonl');
Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, OWNER_ID: OWNER, OWNER_IDS: '', YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  LOG_LEVEL: 'error', YUI_POLICY_MODE: 'observe', YUI_PAINEL_CONFIG_FILE: path.join(tmp, 'secrets', 'painel-config.json'), YUI_PAINEL_CONFIG_DPAPI: 'false',
  YUI_BANS_FILE: path.join(tmp, 'bans.json'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_LOG_DIR: path.join(tmp, 'logs'),
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'YUI_READ_ONLY', 'YUI_API_TOKENS', 'YUI_PAINEL_CONFIG_EDIT', 'YUI_PANEL_AI_EDIT', 'YUI_PLANOS', 'YUI_PLANOS_PAINEL', 'YUI_YOUTUBE_LIVE',
  'YUI_GOOGLE_REAUTORIZAR_PAINEL', 'YUI_MONITORES']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp); // sem .env e sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
globalThis.fetch = async (u) => { throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };
const { createAdmin, ACOES_COM_FREIO, FREIO_DE_REPETICAO_MS, TEXTO_PEDIDO_REPETIDO } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { buildContext } = await imp('src/core/permissions.js');
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 7).join('\n        ')}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const dono = buildContext({ platform: 'api', userId: OWNER, isDM: true });
const membro = buildContext({ platform: 'api', userId: MEMBER, isDM: true });
const linhasDaAuditoria = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── A tabela: cada rota de escrita do painel, um caminho de exemplo, argumentos de exemplo e a classe ──
//   idempotente: repetir não faz nada a mais (grava o mesmo valor; tira algo que já saiu: a segunda vez dá 404 ou "nada a fazer")
//   limite: já tem limite próprio de repetição (planos, live, GTA, Google, rota privada, DM de teste)
//   duplicata: repetir é recusado pela própria ação (seguir canal: "já segue"; chave ou provedor de IA: 409 "já está cadastrada"; o mesmo banimento de novo)
//   freio: não é idempotente e leva o freio de pedido repetido (ACOES_COM_FREIO, src/core/api/admin.js; o rádio só no tocar e no iniciar)
//   sempre: sair da live (sem freio de propósito; idempotente)
const G = '700000000000000001';
const C = '700000000000000009';
const TABELA = {
  resetGuildTools: ['POST', `/v1/admin/guilds/${G}/mcp-tools/reset`, [G, { confirm: true }], 'idempotente'],
  setGuildTool: ['PUT', `/v1/admin/guilds/${G}/mcp-tools/search_web`, [G, 'search_web', { ligada: false }], 'idempotente'],
  acceptGuildTos: ['POST', `/v1/admin/guilds/${G}/tos`, [G, { confirm: true }], 'idempotente'],
  revokeGuildTos: ['DELETE', `/v1/admin/guilds/${G}/tos`, [G, { confirm: true }], 'idempotente'],
  setPersona: ['PUT', `/v1/admin/guilds/${G}/channels/${C}/persona`, [G, C, { instruction: 'x' }], 'idempotente'],
  resetPersona: ['DELETE', `/v1/admin/guilds/${G}/channels/${C}/persona`, [G, C, {}], 'idempotente'],
  setChatter: ['PUT', `/v1/admin/guilds/${G}/channels/${C}/espontaneo`, [G, C, { ativo: false }], 'idempotente'],
  setMentions: ['PUT', `/v1/admin/guilds/${G}/mentions`, [G, { ligado: false }], 'idempotente'],
  radioAction: ['POST', `/v1/admin/radio/${G}`, [G, 'skip', {}], 'freio'],
  setGuildChannel: ['PUT', `/v1/admin/guilds/${G}/channels`, [G, 'noticias', C, true], 'idempotente'],
  addYoutubeFollow: ['POST', `/v1/admin/guilds/${G}/youtube`, [G, { canal: 'x' }], 'duplicata'],
  setYoutubeLiveMode: ['PUT', `/v1/admin/guilds/${G}/youtube/UCabc/${C}`, [G, 'UCabc', C, {}], 'idempotente'],
  removeYoutubeFollow: ['DELETE', `/v1/admin/guilds/${G}/youtube/UCabc/${C}`, [G, 'UCabc', C], 'idempotente'],
  addTwitchFollow: ['POST', `/v1/admin/guilds/${G}/twitch`, [G, { canal: 'x' }], 'duplicata'],
  removeTwitchFollow: ['DELETE', `/v1/admin/guilds/${G}/twitch/abc/${C}`, [G, 'abc', C], 'idempotente'],
  addReminder: ['POST', '/v1/admin/reminders', [{ text: 'x', when: 'amanhã 9h' }], 'freio'],
  removeReminder: ['DELETE', '/v1/admin/reminders/1', ['1'], 'idempotente'],
  snoozeReminder: ['POST', '/v1/admin/reminders/1/snooze', ['1', { minutes: 10 }], 'freio'],
  removeMonitor: ['DELETE', '/v1/admin/monitores/1', ['1'], 'idempotente'],
  decidirPlano: ['POST', '/v1/admin/planos/abcdef12/decisao', ['abcdef12', { versao: 1, hash: 'a'.repeat(16), aprovar: false }], 'limite'],
  pedirConfirmacao: ['POST', '/v1/admin/confirmacao/pedir', [{ acao: 'google.reautorizar' }], 'limite'], // correção C2: 10 pedidos em 15 min
  entrarNaLive: ['POST', '/v1/admin/live/entrar', [{ endereco: 'https://youtube.com/live/x' }], 'limite'],
  sairDaLive: ['POST', '/v1/admin/live/sair', [], 'sempre'],
  googleReautorizarInicio: ['POST', '/v1/admin/google/autorizar/inicio', [], 'limite'],
  googleReautorizarRetorno: ['POST', '/v1/admin/google/autorizar/retorno', [{ endereco: 'http://127.0.0.1:47615/' }], 'limite'],
  republicarGta: ['POST', '/v1/admin/gta/republicar', [{ tipo: 'diario', guildId: G, confirm: true }], 'limite'],
  removerContinuidade: ['DELETE', '/v1/admin/continuidade/1', ['1', { confirm: true }], 'idempotente'],
  morningSend: ['POST', '/v1/admin/morning/send', [], 'freio'],
  configSet: ['PUT', '/v1/admin/config/YUI_ALERTS', ['YUI_ALERTS', 'false', true], 'idempotente'],
  configRemove: ['DELETE', '/v1/admin/config/YUI_ALERTS', ['YUI_ALERTS', true], 'idempotente'],
  aiAddKey: ['POST', '/v1/admin/ai/keys', ['gemini', 'chave-falsa'], 'duplicata'],
  aiRemoveKey: ['DELETE', '/v1/admin/ai/keys/gemini/0', ['gemini', 0], 'idempotente'],
  aiCloudflare: ['PUT', '/v1/admin/ai/cloudflare', ['conta'], 'idempotente'],
  aiSetEnabled: ['POST', '/v1/admin/ai/providers/gemini', ['gemini', true], 'idempotente'],
  aiAddCustom: ['POST', '/v1/admin/ai/custom', [{ id: 'x' }], 'duplicata'],
  aiAddCustomKey: ['POST', '/v1/admin/ai/custom/x/keys', ['x', 'chave-falsa'], 'duplicata'],
  aiCustomOptions: ['POST', '/v1/admin/ai/custom/x/options', ['x', {}], 'idempotente'],
  aiRemoveCustom: ['DELETE', '/v1/admin/ai/custom/x', ['x'], 'idempotente'],
  aiTest: ['POST', '/v1/admin/ai/test/gemini', ['gemini'], 'freio'],
  gatewayReset: ['POST', '/v1/admin/gateway/reset', [], 'idempotente'],
  setAutomod: ['POST', `/v1/admin/guilds/${G}/automod`, [G, 'off', true], 'idempotente'],
  addBan: ['POST', '/v1/admin/bans', ['user', MEMBER, 'motivo', true], 'duplicata'],
  removeBan: ['DELETE', `/v1/admin/bans/user/${MEMBER}`, ['user', MEMBER], 'idempotente'],
  memoryForgetUser: ['DELETE', `/v1/admin/memory/users/${MEMBER}`, [MEMBER], 'idempotente'],
  memoryForget: ['DELETE', `/v1/admin/memory/users/${MEMBER}/1`, [MEMBER, 1], 'idempotente'],
  restart: ['POST', '/v1/admin/restart', [true], 'freio'],
  verificarRotaPrivada: ['POST', '/v1/admin/ia/rota-privada/verificar', [true], 'limite'],
};
// A DM de teste é a única rota de escrita do painel feita ali mesmo no server.js (sem método do createAdmin): dono, limite próprio e auditoria lá.
const DM_DE_TESTE = ['POST', '/v1/admin/discord/dm'];

/** As rotas de escrita do painel no server.js: o método do createAdmin que cada uma chama. */
function rotasDeEscritaDoServidor() {
  const linhas = fs.readFileSync(path.join(repoRoot, 'src/core/api/server.js'), 'utf8').split(/\r?\n/);
  const metodos = new Set();
  let dm = false;
  for (let i = 0; i < linhas.length; i++) {
    if (!/m === '(POST|PUT|DELETE)'/.test(linhas[i])) continue;
    const contexto = `${linhas[i - 3] ?? ''}\n${linhas[i - 2] ?? ''}\n${linhas[i - 1] ?? ''}\n${linhas[i]}`;
    if (!/v1\\?\/admin/.test(contexto) || /admin\\?\/bds|sub === /.test(linhas[i])) continue; // os arquivos do BDS têm a suíte deles (test:bds*)
    if (linhas[i].includes("'/v1/admin/discord/dm'")) { dm = true; continue; }
    const chamada = /admin\.(\w+)\(/.exec(linhas.slice(i, i + 5).join('\n'));
    if (chamada) metodos.add(chamada[1]);
  }
  return { metodos, dm };
}

/** O corpo de um método do createAdmin (do "async nome(...) {" até a chave que fecha). */
function corpoDoMetodo(nome) {
  const src = fs.readFileSync(path.join(repoRoot, 'src/core/api/admin.js'), 'utf8');
  const m = new RegExp(`\\n\\s+async ${nome}\\(`).exec(src);
  if (!m) return null;
  const fim = /\)\s*\{/g;
  fim.lastIndex = m.index + m[0].length;
  let i = fim.exec(src).index;
  i = src.indexOf('{', i);
  let prof = 0;
  const ini = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') prof++;
    else if (src[i] === '}' && --prof === 0) break;
  }
  return src.slice(ini, i + 1);
}

try {
  section('A. O inventário: toda rota de escrita do painel está na tabela, com a classe, e no routeGuard');
  await test('as rotas de escrita do server.js são exatamente as da tabela (rota nova sem classe faz o teste falhar)', () => {
    const { metodos, dm } = rotasDeEscritaDoServidor();
    const naTabela = new Set(Object.keys(TABELA));
    assert.deepEqual([...metodos].filter((m) => !naTabela.has(m)), [], 'rota de escrita nova sem classe na tabela');
    assert.deepEqual([...naTabela].filter((m) => !metodos.has(m)), [], 'a tabela tem rota que não existe mais');
    assert.ok(dm, 'a DM de teste continua no server.js');
  });
  await test('cada rota da tabela (e a DM de teste) é uma ação da matriz no routeGuard', () => {
    for (const [nome, [metodo, caminho]] of Object.entries(TABELA)) assert.ok(actionForRoute(metodo, caminho), `${nome}: ${metodo} ${caminho} fora do routeGuard`);
    assert.ok(actionForRoute(...DM_DE_TESTE));
  });
  await test('o freio vale exatamente para as ações "freio" da tabela; nenhuma idempotente, com limite próprio ou o sair da live leva o freio', () => {
    const freio = Object.entries(TABELA).filter(([, v]) => v[3] === 'freio').map(([k]) => k).sort();
    assert.deepEqual([...ACOES_COM_FREIO].sort(), freio);
    assert.ok(!ACOES_COM_FREIO.includes('sairDaLive'));
    assert.equal(FREIO_DE_REPETICAO_MS, 5000);
    assert.match(TEXTO_PEDIDO_REPETIDO, /^Muit/, 'o app só mostra a frase do servidor no 429 quando ela começa com "Muit"');
  });

  section('B. O dono é conferido no próprio serviço (o createAdmin), não só na rota');
  await test('membro chamando cada método de escrita DIRETO recebe 403, antes de qualquer efeito', async () => {
    const admin = createAdmin({ client: null, reminders: { store: null, compose: () => 'x', send: async () => { throw new Error('não podia enviar'); } } });
    for (const [nome, [, , args]] of Object.entries(TABELA)) {
      assert.equal(typeof admin[nome], 'function', nome);
      await assert.rejects(admin[nome](membro, ...args), (e) => e?.status === 403, `${nome} não recusou o membro com 403`);
    }
  });
  section('C. Cada ação concluída é auditada (no método ou no serviço que ela chama)');
  await test('o corpo de cada método de escrita audita, ou chama o serviço que audita (aiChange, a memória, a decidir() dos planos, o radio)', () => {
    const delega = /\baudit\(|aiChange\(|memory\.admin(Forget|ForgetUser)\(|servico\.decidir\(|iniciarRadio\(|exigirReautorizacaoLigada\(/;
    for (const nome of Object.keys(TABELA)) {
      const corpo = corpoDoMetodo(nome);
      assert.ok(corpo, `${nome}: método não encontrado no admin.js`);
      assert.match(corpo, delega, `${nome}: nem audita nem chama quem audita`);
    }
  });

  section('D. A tentativa NEGADA também vai para a auditoria (só a ação e o código HTTP)');
  // O fetch de verdade, só para 127.0.0.1 (o resto continua bloqueado).
  const { request } = await import('node:http');
  const chamar = (porta, metodo, caminho, token, corpo) => new Promise((ok, falha) => {
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo));
    const req = request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: { Authorization: `Bearer ${token}`, ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}) } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* */ } ok({ status: res.statusCode, json }); });
    });
    req.on('error', falha);
    if (dados) req.write(dados);
    req.end();
  });
  const servidor = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`) });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  await test('membro numa rota de escrita: 403 e a linha admin.negado com a ação da matriz e o status; nada da mensagem nem do corpo', async () => {
    const antes = linhasDaAuditoria().length;
    const r = await chamar(porta, 'PUT', '/v1/admin/config/YUI_ALERTS', T_MEMBER, { valor: 'VALOR-SECRETO-DO-TESTE' });
    assert.equal(r.status, 403);
    const novas = linhasDaAuditoria().slice(antes).filter((l) => l.event === 'admin.negado');
    assert.equal(novas.length, 1, JSON.stringify(linhasDaAuditoria().slice(antes)));
    assert.equal(novas[0].acao, 'admin.ai_configure');
    assert.equal(novas[0].status, 403);
    assert.ok(!fs.readFileSync(AUDIT, 'utf8').includes('VALOR-SECRETO-DO-TESTE'), 'o corpo nunca vai para a auditoria');
  });
  await test('dono com pedido inválido (400) e a DM de teste negada ao membro (403, resposta feita no server.js): as duas auditadas', async () => {
    const antes = linhasDaAuditoria().length;
    assert.equal((await chamar(porta, 'POST', '/v1/admin/gta/republicar', T_OWNER, { tipo: 'nada' })).status, 400);
    assert.equal((await chamar(porta, 'POST', '/v1/admin/discord/dm', T_MEMBER, { message: 'TEXTO-DA-DM-DO-TESTE' })).status, 403);
    const negadas = linhasDaAuditoria().slice(antes).filter((l) => l.event === 'admin.negado').map((l) => [l.acao, l.status]);
    assert.deepEqual(negadas, [['admin.gta_republish', 400], ['admin.discord_dm', 403]]);
    assert.ok(!fs.readFileSync(AUDIT, 'utf8').includes('TEXTO-DA-DM-DO-TESTE'));
  });
  await test('freio de volume das negadas (achado na revisão da Liz): no máximo UMA linha por pessoa, ação e código por minuto; as outras são contadas e saem na próxima linha', async () => {
    const relogio = { t: 5_000_000 };
    const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), agora: () => relogio.t });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const p = srv.address().port;
      const negadas = () => linhasDaAuditoria().filter((l) => l.event === 'admin.negado');
      const antes = negadas().length;
      for (let i = 0; i < 10; i++) assert.equal((await chamar(p, 'PUT', '/v1/admin/config/YUI_ALERTS', T_MEMBER, { valor: 'x' })).status, 403);
      assert.equal(negadas().length - antes, 1, '10 negadas iguais no mesmo minuto: uma linha');
      assert.equal((await chamar(p, 'POST', '/v1/admin/restart', T_MEMBER, { confirm: true })).status, 403);
      assert.equal(negadas().length - antes, 2, 'outra ação: outra linha');
      relogio.t += 60_000;
      assert.equal((await chamar(p, 'PUT', '/v1/admin/config/YUI_ALERTS', T_MEMBER, { valor: 'x' })).status, 403);
      const ultima = negadas().at(-1);
      assert.deepEqual([ultima.acao, ultima.status, ultima.repetidas], ['admin.ai_configure', 403, 9], 'passou o minuto: a linha nova traz quantas foram só contadas');
      assert.equal(negadas().length - antes, 3);
    } finally {
      srv.close();
    }
  });
  await test('leitura negada e rota que não muda nada NÃO viram admin.negado (só as de escrita)', async () => {
    const antes = linhasDaAuditoria().length;
    assert.equal((await chamar(porta, 'GET', '/v1/admin/config', T_MEMBER)).status, 403);
    assert.equal(linhasDaAuditoria().slice(antes).filter((l) => l.event === 'admin.negado').length, 0);
  });

  section('E. O freio de pedido repetido (as ações que não são idempotentes)');
  await test('o mesmo pedido em 5 s: o segundo é recusado com 429 e NADA é feito de novo; auditado como repetido, sem os argumentos', async () => {
    let agora = 1_000_000;
    let enviados = 0;
    const admin = createAdmin({ client: null, relogio: () => agora, reminders: { store: null, compose: async () => 'resumo', send: async () => { enviados += 1; return true; } } });
    assert.deepEqual(await admin.morningSend(dono), { ok: true });
    const antes = linhasDaAuditoria().length;
    await assert.rejects(admin.morningSend(dono), (e) => e.status === 429 && e.message === TEXTO_PEDIDO_REPETIDO);
    assert.equal(enviados, 1, 'a DM não saiu de novo');
    const negada = linhasDaAuditoria().slice(antes).find((l) => l.event === 'admin.negado');
    assert.deepEqual([negada.acao, negada.status, negada.motivo], ['morningSend', 429, 'repetido']);
    agora += FREIO_DE_REPETICAO_MS;
    assert.deepEqual(await admin.morningSend(dono), { ok: true }, 'depois da janela, passa');
    assert.equal(enviados, 2);
  });
  await test('pedido diferente passa na hora; o mesmo pedido de OUTRA pessoa é outro pedido; o que FALHOU não segura o próximo; o clique duplo simultâneo é barrado', async () => {
    let agora = 2_000_000;
    let enviados = 0;
    let discordOk = false;
    const admin = createAdmin({ client: null, relogio: () => agora, reminders: { store: null, compose: async () => 'resumo', send: async () => { enviados += 1; return discordOk; } } });
    await assert.rejects(admin.morningSend(dono), (e) => e.status === 503, 'o Discord falhou');
    discordOk = true;
    assert.deepEqual(await admin.morningSend(dono), { ok: true }, 'nada foi feito na falha: tentar de novo funciona na hora');
    assert.equal(enviados, 2);
    // dois cliques ao mesmo tempo: o segundo chega enquanto o primeiro ainda roda
    agora += FREIO_DE_REPETICAO_MS;
    let soltar;
    const lento = createAdmin({ client: null, relogio: () => agora, reminders: { store: null, compose: () => new Promise((ok) => { soltar = () => ok('resumo'); }), send: async () => true } });
    const primeiro = lento.morningSend(dono);
    await assert.rejects(lento.morningSend(dono), (e) => e.status === 429, 'o segundo clique, com o primeiro ainda rodando');
    soltar();
    assert.deepEqual(await primeiro, { ok: true });
    // aiTest: argumentos diferentes = pedidos diferentes (o provedor falso não existe; o que importa é se o freio barrou ou não)
    const desfecho = (p) => p.then(() => 'passou', (e) => (e?.status === 429 ? 'freado' : 'passou'));
    assert.equal(await desfecho(admin.aiTest(dono, 'provedor-a')), 'passou');
    assert.equal(await desfecho(admin.aiTest(dono, 'provedor-b')), 'passou', 'outro provedor é outro pedido');
    assert.equal(await desfecho(admin.aiTest(dono, 'provedor-a')), 'freado');
    agora += 1;
    await assert.rejects(admin.aiTest(membro, 'provedor-a'), (e) => e.status === 403, 'o membro é outro pedido: chega ao 403 do dono');
  });
  await test('rádio: tocar a mesma busca duas vezes seguidas é freado; pular duas faixas seguidas e iniciar de novo não (o rádio já recusa o segundo início)', async () => {
    // O rádio falso: tocar e pular sempre "dão certo" (o rádio de verdade tem a suíte dele, test:painelradio)
    const radio = {
      sessao: () => ({ guildId: G }),
      play: async () => ({ success: true, track: { title: 'Faixa', artist: 'Artista' } }),
      skip: async () => ({ success: true }),
    };
    const admin = createAdmin({ client: null, relogio: () => 4_000_000, deps: { radio, integrationData: async () => ({}) } });
    const desfecho = (p) => p.then(() => 'passou', (e) => (e?.status === 429 ? 'freado' : `erro ${e?.status ?? e?.message}`));
    const pular1 = await desfecho(admin.radioAction(dono, G, 'skip', {}));
    const pular2 = await desfecho(admin.radioAction(dono, G, 'skip', {}));
    assert.notEqual(pular2, 'freado', `pular de novo nunca é freado (${pular1} / ${pular2})`);
    const iniciar = await desfecho(admin.radioAction(dono, G, 'start', { voiceChannelId: C, textChannelId: C }));
    assert.notEqual(await desfecho(admin.radioAction(dono, G, 'start', { voiceChannelId: C, textChannelId: C })), 'freado', `iniciar de novo não é freado (${iniciar})`);
    // o freio do tocar: o seletor e a marca, direto na função (o caminho do tocar até o rádio é coberto em test:painelradio)
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/api/admin.js'), 'utf8');
    assert.match(src, /FREIO_SO_QUANDO = Object\.freeze\(\{ radioAction: \(_guildId, acao\) => acao === 'play' \}\)/);
  });
  await test('ação idempotente não tem freio: gravar o mesmo ajuste duas vezes seguidas funciona; sair da live duas vezes também', async () => {
    const admin = createAdmin({ client: null, relogio: () => 3_000_000 });
    await admin.configSet(dono, 'YUI_ALERTS', 'false', true);
    await admin.configSet(dono, 'YUI_ALERTS', 'false', true);
    const live = { rotear: async () => ({ text: 'Não estou em nenhuma live.' }), ligado: () => true };
    const comLive = createAdmin({ client: null, relogio: () => 3_000_000, live });
    for (let n = 0; n < 3; n++) await comLive.sairDaLive(dono).catch((e) => assert.notEqual(e?.status, 429, 'sair da live nunca é freado'));
  });
  servidor.close();
} finally {
  process.chdir(os.tmpdir());
}

console.log(failures.length ? `\nFALHA: ${passed} ok, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} testes OK, 0 falha(s)`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows pode segurar algum arquivo */ }
process.exit(failures.length ? 1 : 0);
