// Lacunas do painel, ENTREGA E, parte 2, item 9 v2 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md): republicar o GTA pelo painel, SÓ DO DONO.
//   POST /v1/admin/gta/republicar { tipo: 'diario'|'semanal'|'noticia', guildId, confirm: true }
// O diário, o semanal ou a notícia MAIS RECENTES, num servidor, no canal daquele tipo configurado nele (nunca um canal digitado), pelas MESMAS funções de
// publicação do agendador (src/discord/publisher.js), sem montar texto novo, sem coletar de novo e sem chamar a IA.
// A. O publicador com `{ guildId, republicar }`, contra os bancos de verdade numa pasta temporária e um Discord FALSO: só no servidor pedido, mesmo já
//    publicado, registra a publicação nova e devolve quantas saíram; sem as opções, nada muda (todos os servidores, sem repetir).
// B. O lado do bot (src/discord/gtaPainel.js: republicarGtaNoBot) com um publicador FALSO: o que vai para cada função (o dado salvo, a chave do semanal, o
//    artigo no formato do motor), servidor sem canal, nada salvo e falha do Discord. A vista ganha "alvos" (onde dá para republicar), com lista fechada.
// C. A rota HTTP de verdade (processo único, publicador falso): dono 200, tipo inválido, sem confirmação, servidor fora, sem canal (409), nada salvo (404),
//    falha (502), membro 403 sem publicar, sem token 401, limite de 1 a cada 10 min por tipo e servidor (o que falhou não conta), auditoria só com tipo e
//    servidor, routeGuard (admin.gta_republish) e a matriz, enforce barra o membro.
// D. O cérebro separado (vai ao bot por panel.admin COM idempotência, membro barrado antes do canal, bot fora 503) e o bot (só do dono).
// Num processo só, pasta temporária, sem .env, sem rede, sem Discord de verdade. Execução: npm run test:painelrepublicar
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-republicar-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const SEGREDO = 'SEGREDO-DA-REPUBLICACAO-7c1d';
const DB = path.join(tmp, 'db');
const AUDIT = path.join(tmp, 'audit.jsonl');
const G1 = '300000000000000001';
const G2 = '300000000000000002';
const G3 = '300000000000000003';
const G_FORA = '300000000000000009';
const C1 = '400000000000000001';
const C2 = '400000000000000002';
const C3 = '400000000000000003';

Object.assign(process.env, {
  DATABASE_DIR: DB, YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_READ_ONLY: 'false', YUI_LOG_DIR: path.join(tmp, 'logs'),
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_API_TOKENS', 'YUI_DB_OWNER_ROLE', 'YUI_DB_NATIVE', 'REDDIT_FETCH_MODE']) delete process.env[k];
fs.mkdirSync(DB, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const L = await imp('src/core/api/leiturasDoPainel.js');
const { initDatabase, closeAllDatabases } = await imp('src/database/db.js');
const S = await imp('src/database/schemas.js');
const { dailyRepository } = await imp('src/database/repositories/dailyRepo.js');
const { weeklyRepository } = await imp('src/database/repositories/weeklyRepo.js');
const { newsRepository } = await imp('src/database/repositories/newsRepo.js');
const { publicationRepository } = await imp('src/database/repositories/publicationRepo.js');
const { guildRepository } = await imp('src/database/repositories/guildRepo.js');
const { lerGtaDoBot, republicarGtaNoBot, chaveDaRepublicacaoDoSemanal, COLUNA_DO_TIPO } = await imp('src/discord/gtaPainel.js');
const { discordPublisher } = await imp('src/discord/publisher.js');
const { createAdmin, LIMITE_DA_REPUBLICACAO, TIPOS_DA_REPUBLICACAO } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await imp('src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await imp('src/discord/canalCerebro.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { MATRIX } = await imp('src/core/security/permissionMatrix.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
const auditoria = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eventos = (nome) => auditoria().filter((e) => e.event === nome);
const servidores = [];

// ── O Discord FALSO: cada canal guarda o que recebeu; nada sai deste processo ──
function discordFalso() {
  const enviados = [];
  let seq = 0;
  const canal = (id) => ({
    id,
    isTextBased: () => true,
    send: async (payload) => {
      seq += 1;
      enviados.push({ canal: id, payload });
      return { id: `90000000000000${String(seq).padStart(4, '0')}`, createMessageComponentCollector: () => ({ on() {} }), edit: async () => ({}) };
    },
  });
  return { enviados, client: { channels: { fetch: async (id) => canal(id) } } };
}

const DIARIO = {
  date: '2026-11-27', collectedAt: '2026-11-27T06:00:10.000Z',
  gunVan: { locationName: 'Paleto Bay', weapons: [{ name: 'Railgun', discountPercent: 40 }] },
  streetDealers: { dealers: [{ locationName: 'Vespucci Beach', premiumProduct: 'Meth' }] },
  collectibles: { shipwreck: { locationName: 'Chumash' }, treasureChests: [] },
  timeTrials: {},
};
const SEMANAL = {
  id: 'abc123', source: 'reddit', title: 'Weekly Bonuses and Discounts', url: 'https://www.reddit.com/r/gtaonline/comments/abc123/weekly/',
  periodo: { inicio: '2026-11-20', fim: '2026-11-27' }, bonus: [{ multiplicador: 2, atividades: ['Corridas'] }], descontos: ['Turismo R - 30%'],
  veiculos: { podium: 'Pegassi Zentorno' }, analysis: { destaques: 'análise já salva' }, selftext: SEGREDO,
};
const NOTICIA = { id: 'n1', title: 'GTA Online: novidades', url: 'https://www.rockstargames.com/newswire/article/n1/x', category: 'GTA Online', thumbnailUrl: null, publishedAt: '2026-11-26T15:00:00.000Z' };

try {
  await initDatabase('core', S.CORE_SCHEMA);
  await initDatabase('newswire', S.NEWSWIRE_SCHEMA);
  await initDatabase('gta-diario', S.GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', S.GTA_WEEKLY_SCHEMA);
  dailyRepository.saveDaily('2026-11-27', DIARIO);
  weeklyRepository.saveWeekly('2026-W47', SEMANAL);
  newsRepository.insertMany([NOTICIA]);
  guildRepository.setChannel(G1, 'daily_channel_id', C1);
  guildRepository.setChannel(G1, 'weekly_channel_id', C1);
  guildRepository.setChannel(G1, 'news_channel_id', C1);
  guildRepository.setChannel(G2, 'daily_channel_id', C2);
  guildRepository.setChannel(G2, 'weekly_channel_id', C2);
  guildRepository.setChannel(G2, 'news_channel_id', C2);
  guildRepository.setChannel(G3, 'news_channel_id', C3); // o G3 só tem canal de notícias

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. O publicador do agendador com { guildId, republicar } (bancos de verdade, Discord falso)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('sem as opções, como sempre: todos os servidores com canal, uma vez; de novo, nada sai (devolve quantas saíram)', async () => {
    const d = discordFalso();
    assert.equal(await discordPublisher.publishDaily(d.client, DIARIO), 2);
    assert.deepEqual(d.enviados.map((e) => e.canal).sort(), [C1, C2]);
    assert.equal(await discordPublisher.publishDaily(d.client, DIARIO), 0, 'já publicado: o agendador não repete');
    assert.equal(d.enviados.length, 2);
  });

  await test('diário com { guildId, republicar }: sai SÓ no canal de diário daquele servidor, mesmo já publicado, e o registro novo vira o "onde saiu"', async () => {
    const d = discordFalso();
    const antes = publicationRepository.getPublished('daily', '2026-11-27', G2);
    assert.equal(await discordPublisher.publishDaily(d.client, DIARIO, { guildId: G2, republicar: true }), 1);
    assert.deepEqual(d.enviados.map((e) => e.canal), [C2]);
    assert.ok(Array.isArray(d.enviados[0].payload.embeds) && d.enviados[0].payload.embeds.length === 1, 'o mesmo embed do agendador');
    const depois = publicationRepository.getPublished('daily', '2026-11-27', G2);
    assert.notEqual(depois.message_id, antes.message_id, 'a mensagem nova é a registrada');
    assert.equal(depois.channel_id, C2);
    assert.equal(await discordPublisher.publishDaily(d.client, DIARIO, { guildId: G2 }), 0, 'só o guildId, sem republicar: respeita o que já saiu');
  });

  await test('semanal e notícia com { guildId, republicar }: só no servidor pedido; servidor sem o canal do tipo não recebe nada', async () => {
    const d = discordFalso();
    assert.equal(await discordPublisher.publishWeekly(d.client, SEMANAL, 'reddit:abc123', { guildId: G1, republicar: true }), 1);
    assert.equal(await discordPublisher.publishNews(d.client, [NOTICIA], { guildId: G3, republicar: true }), 1);
    assert.deepEqual(d.enviados.map((e) => e.canal), [C1, C3]);
    assert.ok(Array.isArray(d.enviados[0].payload.components), 'o semanal sai com a paginação, como no agendador');
    assert.equal(await discordPublisher.publishWeekly(d.client, SEMANAL, 'reddit:abc123', { guildId: G3, republicar: true }), 0, 'o G3 não tem canal semanal');
    assert.equal(publicationRepository.getPublished('weekly', 'reddit:abc123', G1).channel_id, C1);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. O lado do bot (republicarGtaNoBot) com um publicador falso, e os "alvos" da vista');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const publicadorFalso = (devolve = 1) => {
    const chamadas = [];
    return {
      chamadas,
      publishDaily: async (client, dado, opcoes) => { chamadas.push(['diario', dado, opcoes]); return devolve; },
      publishWeekly: async (client, dado, chave, opcoes) => { chamadas.push(['semanal', dado, chave, opcoes]); return devolve; },
      publishNews: async (client, artigos, opcoes) => { chamadas.push(['noticia', artigos, opcoes]); return devolve; },
    };
  };
  const clienteDoBot = { soPara: 'teste' };

  await test('diário: o reset SALVO mais recente vai para o publishDaily com a data e { guildId, republicar: true }', async () => {
    const p = publicadorFalso();
    const r = await republicarGtaNoBot({ tipo: 'diario', guildId: G1, client: clienteDoBot, publicador: p });
    assert.deepEqual(r, { situacao: 'ok', canalId: C1 });
    assert.equal(p.chamadas.length, 1);
    const [tipo, dado, opcoes] = p.chamadas[0];
    assert.equal(tipo, 'diario');
    assert.equal(dado.date, '2026-11-27');
    assert.equal(dado.gunVan.locationName, 'Paleto Bay');
    assert.deepEqual(opcoes, { guildId: G1, republicar: true });
  });

  await test('semanal: o último VÁLIDO, salvo com a análise (sem coletar de novo), com a chave do publicador (reddit:<id>; o do Newswire pela semana)', async () => {
    const p = publicadorFalso();
    assert.equal((await republicarGtaNoBot({ tipo: 'semanal', guildId: G2, client: clienteDoBot, publicador: p })).situacao, 'ok');
    const [, dado, chave, opcoes] = p.chamadas[0];
    assert.equal(chave, 'reddit:abc123');
    assert.equal(dado.analysis.destaques, 'análise já salva');
    assert.deepEqual(opcoes, { guildId: G2, republicar: true });
    assert.equal(chaveDaRepublicacaoDoSemanal({ event_week: '2026-W48', data: { source: 'gtabase', id: 'p9' } }), 'gtabase:p9');
    assert.equal(chaveDaRepublicacaoDoSemanal({ event_week: '2026-W48', data: { source: 'newswire', id: 'x' } }), '2026-W48');
    assert.equal(chaveDaRepublicacaoDoSemanal(null), null);
  });

  await test('notícia: a última, no MESMO formato que o motor do Newswire entrega ao publicador (camelCase), só no servidor pedido', async () => {
    const p = publicadorFalso();
    assert.deepEqual(await republicarGtaNoBot({ tipo: 'noticia', guildId: G3, client: clienteDoBot, publicador: p }), { situacao: 'ok', canalId: C3 });
    const [, artigos, opcoes] = p.chamadas[0];
    assert.deepEqual(artigos, [{ id: 'n1', title: 'GTA Online: novidades', url: NOTICIA.url, category: 'GTA Online', thumbnailUrl: null, publishedAt: NOTICIA.publishedAt }]);
    assert.deepEqual(opcoes, { guildId: G3, republicar: true });
  });

  await test('servidor sem o canal do tipo: "sem-canal" e o publicador nem é chamado; nada salvo: "sem-conteudo"; nada saiu: "falhou"; tipo inventado lança', async () => {
    const p = publicadorFalso();
    assert.deepEqual(await republicarGtaNoBot({ tipo: 'diario', guildId: G3, client: clienteDoBot, publicador: p }), { situacao: 'sem-canal', canalId: null });
    assert.deepEqual(await republicarGtaNoBot({ tipo: 'semanal', guildId: G_FORA, client: clienteDoBot, publicador: p }), { situacao: 'sem-canal', canalId: null });
    assert.equal(p.chamadas.length, 0);
    const vazio = { ...{ daily: { getLatestDaily: () => null }, weekly: { getLatestValidWeekly: () => null }, news: { getLatest: () => [] } }, guild: guildRepository, publication: publicationRepository };
    for (const tipo of TIPOS_DA_REPUBLICACAO) assert.equal((await republicarGtaNoBot({ tipo, guildId: G1, client: clienteDoBot, publicador: p, repos: vazio })).situacao, 'sem-conteudo', tipo);
    assert.equal(p.chamadas.length, 0);
    assert.deepEqual(await republicarGtaNoBot({ tipo: 'diario', guildId: G1, client: clienteDoBot, publicador: publicadorFalso(0) }), { situacao: 'falhou', canalId: C1 });
    // a notícia que é o próprio evento semanal: o publishNews a pula de propósito; o painel ouve isso, não uma "falha do Discord"
    const semanalDoNewswire = { daily: dailyRepository, weekly: { getLatestWeekly: () => ({ data: { url: NOTICIA.url } }) }, news: newsRepository, guild: guildRepository };
    assert.deepEqual(await republicarGtaNoBot({ tipo: 'noticia', guildId: G1, client: clienteDoBot, publicador: p, repos: semanalDoNewswire }), { situacao: 'e-o-semanal', canalId: C1 });
    assert.equal(p.chamadas.length, 0);
    await assert.rejects(republicarGtaNoBot({ tipo: 'canal-qualquer', guildId: G1, client: clienteDoBot, publicador: p }));
    assert.deepEqual(Object.keys(COLUNA_DO_TIPO).sort(), [...TIPOS_DA_REPUBLICACAO].sort());
  });

  await test('a vista ganha "alvos": por tipo, os servidores com o canal configurado (ids e nomes curtos); o que não é id sai; limpar é idempotente', () => {
    const cru = lerGtaDoBot({ cfg: {}, guarda: { canTry: () => ({ ok: true }), failures: 0 }, salvo: () => null, env: {} });
    assert.deepEqual(cru.alvos.diario.map((a) => [a.guildId, a.channelId]).sort(), [[G1, C1], [G2, C2]]);
    assert.deepEqual(cru.alvos.noticia.map((a) => a.guildId).sort(), [G1, G2, G3]);
    const v = L.montarVistaDoGta({ ...cru, alvos: { ...cru.alvos, semanal: [...cru.alvos.semanal, { guildId: 'nao-e-id', channelId: C1 }, { guildId: G3, channelId: null }] } }, {
      nomeDoServidor: (id) => ({ [G1]: `Servidor Um\u0007 ${'z'.repeat(90)}` })[id] ?? null, nomeDoCanal: (id) => ({ [C1]: 'gta' })[id] ?? null,
    });
    assert.deepEqual(Object.keys(v.alvos).sort(), ['diario', 'noticia', 'semanal']);
    assert.deepEqual(v.alvos.semanal.map((a) => a.servidorId).sort(), [G1, G2], 'id inválido e servidor sem canal saem');
    const um = v.alvos.diario.find((a) => a.servidorId === G1);
    assert.deepEqual(Object.keys(um).sort(), ['canal', 'canalId', 'servidor', 'servidorId']);
    assert.ok(um.servidor.length <= 60 && !um.servidor.includes('\u0007'));
    assert.equal(um.canal, 'gta');
    assert.deepEqual(L.limparVistaDoGta(JSON.parse(JSON.stringify(v))), v);
    assert.deepEqual(L.montarVistaDoGta(null).alvos, { diario: [], semanal: [], noticia: [] });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. A rota HTTP de verdade (processo único, publicador falso)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const cache = (pares) => new Map(pares.map(([id, name]) => [id, { id, name }]));
  const clientFalso = { isReady: () => true, guilds: { cache: cache([[G1, 'Servidor Um'], [G2, 'Servidor Dois'], [G3, 'Servidor Três']]) }, channels: { cache: cache([[C1, 'gta'], [C2, 'gta-2']]) } };
  const relogio = { t: Date.parse('2026-11-27T15:00:00Z') };
  let pubDaRota = publicadorFalso();
  const pedidosAoBot = [];
  const ponte = async () => ({
    gta: () => lerGtaDoBot({ cfg: {}, guarda: { canTry: () => ({ ok: true }), failures: 0 }, salvo: () => null, env: {} }),
    republicarGta: async (tipo, guildId, client) => {
      pedidosAoBot.push({ tipo, guildId, mesmoCliente: client === clientFalso });
      return republicarGtaNoBot({ tipo, guildId, client, publicador: pubDaRota });
    },
  });
  const admin = createAdmin({ client: clientFalso, servidor: ponte, deps: { integrationData: async () => ({}), agora: () => relogio.t } });
  const subir = async (adm) => {
    const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: adm });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servidores.push(srv);
    const base = `http://127.0.0.1:${srv.address().port}`;
    return async (corpo, { token = T_OWNER, headers = {}, method = 'POST', rota = '/v1/admin/gta/republicar' } = {}) => {
      const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(corpo ?? {}) });
      const texto = await res.text();
      let json = null;
      try { json = JSON.parse(texto); } catch { json = null; }
      return { status: res.status, texto, json };
    };
  };
  const api = await subir(admin);

  await test('o dono republica o diário: 200 { ok, tipo, guildId, canalId }, no canal configurado, com o cliente do Discord deste processo; auditoria só tipo e servidor', async () => {
    const r = await api({ tipo: 'diario', guildId: G1, confirm: true });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, tipo: 'diario', guildId: G1, canalId: C1 });
    assert.deepEqual(pedidosAoBot.at(-1), { tipo: 'diario', guildId: G1, mesmoCliente: true });
    assert.equal(pubDaRota.chamadas.length, 1);
    const ev = eventos('admin.gta.republicar');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].d?.tipo ?? ev[0].tipo, ev[0].d?.guild ?? ev[0].guild, ev[0].d?.ok ?? ev[0].ok], ['diario', G1, true]);
    const linha = JSON.stringify(ev[0]);
    for (const p of ['Paleto', 'Railgun', SEGREDO, C1]) assert.ok(!linha.includes(p), `a auditoria levou ${p}`);
  });

  await test('limite: o MESMO tipo no MESMO servidor de novo antes de 10 min dá 429 sem publicar; outro tipo e outro servidor passam; depois de 10 min, passa', async () => {
    const antes = pubDaRota.chamadas.length;
    const r = await api({ tipo: 'diario', guildId: G1, confirm: true });
    assert.equal(r.status, 429, r.texto);
    assert.match(r.json.error, /^Muito cedo para republicar: .*Espere 10 min\.$/, 'começa com "Muito": o app mostra a frase do servidor no 429');
    assert.equal(pubDaRota.chamadas.length, antes, 'nada foi publicado');
    assert.equal((await api({ tipo: 'semanal', guildId: G1, confirm: true })).status, 200, 'outro tipo');
    assert.equal((await api({ tipo: 'diario', guildId: G2, confirm: true })).status, 200, 'outro servidor');
    relogio.t += LIMITE_DA_REPUBLICACAO.janelaMs - 1000;
    assert.equal((await api({ tipo: 'diario', guildId: G1, confirm: true })).status, 429, 'ainda dentro dos 10 min');
    relogio.t += 1000;
    assert.equal((await api({ tipo: 'diario', guildId: G1, confirm: true })).status, 200, 'passados os 10 min');
    assert.equal(LIMITE_DA_REPUBLICACAO.janelaMs, 10 * 60_000);
  });

  await test('servidor sem o canal do tipo: 409 com o caminho para configurar, sem publicar e SEM contar para o limite', async () => {
    const antes = pubDaRota.chamadas.length;
    for (let i = 0; i < 3; i += 1) {
      const r = await api({ tipo: 'semanal', guildId: G3, confirm: true });
      assert.equal(r.status, 409, r.texto);
      assert.match(r.json.error, /não tem canal semanal configurado/);
    }
    assert.equal(pubDaRota.chamadas.length, antes);
    guildRepository.setChannel(G3, 'weekly_channel_id', C3);
    assert.equal((await api({ tipo: 'semanal', guildId: G3, confirm: true })).status, 200, 'configurado o canal, passa na hora');
  });

  await test('nada salvo: 404; falha do Discord: 502 (e não prende o próximo pedido); tipo inválido, sem confirmação ou id ruim: 400; Yui fora do servidor: 404', async () => {
    pubDaRota = publicadorFalso(0);
    const falha = await api({ tipo: 'noticia', guildId: G1, confirm: true });
    assert.equal(falha.status, 502, falha.texto);
    assert.equal(eventos('admin.gta.republicar').at(-1).d?.ok ?? eventos('admin.gta.republicar').at(-1).ok, false);
    pubDaRota = publicadorFalso(1);
    assert.equal((await api({ tipo: 'noticia', guildId: G1, confirm: true })).status, 200, 'a falha não contou para o limite');
    for (const corpo of [{ tipo: 'canal', guildId: G1, confirm: true }, { tipo: 'diario', guildId: G1 }, { tipo: 'diario', guildId: G1, confirm: 'sim' }, { tipo: 'diario', guildId: 'abc', confirm: true }, {}]) {
      assert.equal((await api(corpo)).status, 400, JSON.stringify(corpo));
    }
    assert.equal((await api({ tipo: 'diario', guildId: G_FORA, confirm: true })).status, 404);
    const semNada = createAdmin({
      client: clientFalso, deps: { integrationData: async () => ({}) },
      servidor: async () => ({ republicarGta: (tipo, guildId, client) => republicarGtaNoBot({ tipo, guildId, client, publicador: publicadorFalso(), repos: { daily: { getLatestDaily: () => null }, weekly: { getLatestValidWeekly: () => null }, news: { getLatest: () => [] }, guild: guildRepository } }) }),
    });
    await assert.rejects(semNada.republicarGta(ctxDono, { tipo: 'diario', guildId: G1, confirm: true }), (e) => e.status === 404 && /nada salvo/.test(e.message));
    const eSemanal = createAdmin({ client: clientFalso, deps: { integrationData: async () => ({}) }, servidor: async () => ({ republicarGta: async () => ({ situacao: 'e-o-semanal', canalId: C1 }) }) });
    await assert.rejects(eSemanal.republicarGta(ctxDono, { tipo: 'noticia', guildId: G1, confirm: true }), (e) => e.status === 409 && /republique o semanal/.test(e.message));
  });

  await test('membro: 403 sem chegar ao bot nem publicar; sem token ou token errado: 401; GET não existe', async () => {
    const antes = pedidosAoBot.length;
    const r = await api({ tipo: 'diario', guildId: G2, confirm: true }, { token: T_MEMBER });
    assert.equal(r.status, 403);
    assert.equal(pedidosAoBot.length, antes);
    assert.equal((await api({ tipo: 'diario', guildId: G2, confirm: true }, { token: null })).status, 401);
    assert.equal((await api({ tipo: 'diario', guildId: G2, confirm: true }, { token: 'token-errado-0123456789abcdef' })).status, 401);
    assert.equal((await api(null, { method: 'GET' })).status, 404);
  });

  await test('sem a ponte do bot (um processo sem o Discord): 503, nunca publica por conta própria', async () => {
    const sem = createAdmin({ client: clientFalso, servidor: async () => ({ gta: () => ({}) }), deps: { integrationData: async () => ({}) } });
    await assert.rejects(sem.republicarGta(ctxDono, { tipo: 'diario', guildId: G1, confirm: true }), (e) => e.status === 503 && /bot do Discord/.test(e.message));
  });

  await test('no routeGuard como admin.gta_republish (só o dono, no PC e pelo app, sem "modifies", como a publicação agendada); o GET do GTA continua fora', () => {
    assert.equal(actionForRoute('POST', '/v1/admin/gta/republicar'), 'admin.gta_republish');
    for (const [m, p] of [['GET', '/v1/admin/gta'], ['GET', '/v1/admin/gta/republicar'], ['POST', '/v1/admin/gta/republicar/x']]) assert.equal(actionForRoute(m, p), null, `${m} ${p}`);
    const linha = MATRIX.get('admin.gta_republish');
    assert.ok(linha);
    assert.equal(linha.modifies, false);
    assert.deepEqual(linha.decisions, { OWNER_LOCAL: 'AUTO', OWNER_REMOTE: 'AUTO', OWNER_DM: 'DENY', ADMIN_GUILD: 'DENY', MEMBER: 'DENY' });
  });

  await test('em enforce: o membro é barrado pela política (403 com a ação) antes de qualquer publicação; o dono pelo app passa', async () => {
    try {
      process.env.YUI_POLICY_MODE = 'enforce';
      relogio.t += LIMITE_DA_REPUBLICACAO.janelaMs;
      const antes = pedidosAoBot.length;
      const membro = await api({ tipo: 'diario', guildId: G2, confirm: true }, { token: T_MEMBER });
      assert.equal(membro.status, 403);
      assert.equal(membro.json.policy?.action, 'admin.gta_republish');
      assert.equal(pedidosAoBot.length, antes);
      const app = await api({ tipo: 'diario', guildId: G2, confirm: true }, { headers: { 'x-forwarded-for': '100.64.0.9' } });
      assert.equal(app.status, 200, app.texto);
    } finally { process.env.YUI_POLICY_MODE = 'observe'; }
  });

  await test('o GET do GTA traz os alvos com os nomes do cliente do Discord (onde dá para republicar)', async () => {
    const r = await api(null, { method: 'GET', rota: '/v1/admin/gta' });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.alvos.diario.map((a) => [a.servidor, a.canal]).sort(), [['Servidor Dois', 'gta-2'], ['Servidor Um', 'gta']]);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O cérebro separado e o bot');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const canalFalso = ({ conectado = true, falha = false, resposta = { ok: true } } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      isConnected: () => conectado,
      emit() {},
      request: async (papel, metodo, params, opts) => {
        pedidos.push({ papel, metodo, action: params?.action, args: params?.args, idem: opts?.idem ?? null });
        if (falha) throw Object.assign(new Error('caiu'), { code: 'CONNECTION_LOST' });
        return resposta;
      },
    };
  };

  await test('a mesma lista nos dois lados; "republicarGta" é ESCRITA (vai com chave de idempotência)', () => {
    assert.deepEqual([...BOT_PANEL_ACTIONS].sort(), Object.keys(PANEL_ACTIONS).sort());
    assert.equal(PANEL_ACTIONS.republicarGta, true);
  });

  await test('no cérebro: pede ao bot por panel.admin com o corpo e a idempotência; membro barrado antes do canal; bot fora: 503', async () => {
    const canal = canalFalso({ resposta: { ok: true, tipo: 'diario', guildId: G1, canalId: C1 } });
    const r = await createCerebroAdmin({ channel: canal }).republicarGta(ctxDono, { tipo: 'diario', guildId: G1, confirm: true });
    assert.deepEqual(r, { ok: true, tipo: 'diario', guildId: G1, canalId: C1 });
    assert.equal(canal.pedidos.length, 1);
    assert.deepEqual([canal.pedidos[0].papel, canal.pedidos[0].metodo, canal.pedidos[0].action], ['bot', 'panel.admin', 'republicarGta']);
    assert.deepEqual(canal.pedidos[0].args, [{ tipo: 'diario', guildId: G1, confirm: true }]);
    assert.ok(canal.pedidos[0].idem, 'escrita: com chave de idempotência');
    const outro = canalFalso();
    await assert.rejects(createCerebroAdmin({ channel: outro }).republicarGta({ role: 'MEMBER', userId: MEMBER, platform: 'api' }, { tipo: 'diario', guildId: G1, confirm: true }), (e) => e.status === 403);
    assert.deepEqual(outro.pedidos, []);
    for (const c of [canalFalso({ conectado: false }), canalFalso({ falha: true })]) {
      await assert.rejects(createCerebroAdmin({ channel: c }).republicarGta(ctxDono, { tipo: 'diario', guildId: G1, confirm: true }), (e) => e.status === 503);
    }
  });

  await test('o bot: aceita "republicarGta" pelo canal só do dono e roda o mesmo admin (limite e auditoria do lado dele)', async () => {
    const handlers = new Map();
    const pub = publicadorFalso();
    const adminDoBot = createAdmin({
      client: clientFalso, processo: 'bot', deps: { integrationData: async () => ({}) },
      servidor: async () => ({ republicarGta: (tipo, guildId, client) => republicarGtaNoBot({ tipo, guildId, client, publicador: pub }) }),
    });
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => clientFalso, admin: adminDoBot });
    const r = await handlers.get('panel.admin')({ userId: OWNER, action: 'republicarGta', args: [{ tipo: 'noticia', guildId: G2, confirm: true }] }, { role: 'cerebro' });
    assert.deepEqual(r, { ok: true, tipo: 'noticia', guildId: G2, canalId: C2 });
    assert.equal(pub.chamadas.length, 1);
    await assert.rejects(handlers.get('panel.admin')({ userId: OWNER, action: 'republicarGta', args: [{ tipo: 'noticia', guildId: G2, confirm: true }] }, {}), (e) => e.code === 'ADMIN_429');
    await assert.rejects(handlers.get('panel.admin')({ userId: MEMBER, action: 'republicarGta', args: [{ tipo: 'diario', guildId: G2, confirm: true }] }, {}), (e) => e.code === 'FORBIDDEN');
    assert.equal(pub.chamadas.length, 1);
  });

  await test('a ponte do bot liga o republicar à função do bot (src/discord/painelServidor.js -> gtaPainel.js), sem cópia', () => {
    const ponteFonte = fs.readFileSync(path.join(repoRoot, 'src', 'discord', 'painelServidor.js'), 'utf8');
    assert.match(ponteFonte, /republicarGta: async \(tipo, guildId, client\) => \(await import\('\.\/gtaPainel\.js'\)\)\.republicarGtaNoBot\(\{ tipo, guildId, client \}\)/);
  });

  await test('registrado no package.json, no CI (SUITES) e no README_TESTES.md', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts['test:painelrepublicar'], 'node tests/test-painel-republicar.js');
    assert.match(fs.readFileSync(path.join(repoRoot, 'scripts', 'run-ci.mjs'), 'utf8'), /'test:painelrepublicar'/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'README_TESTES.md'), 'utf8'), /\| `test:painelrepublicar` \|/);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  for (const s of servidores) { try { s.close(); s.closeAllConnections?.(); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 300)); // deixa os soquetes fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
