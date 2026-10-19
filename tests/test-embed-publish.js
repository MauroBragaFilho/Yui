// Testes das publicações, banimentos e consultas (pacote 6b): TG-18, TG-19, TG-33 e o campo `os` duplicado
// do steamHandler. Sem rede, sem Discord, sem bancos reais e sem a Yui em execução.
// Execução: npm run test:embedpublish   (ou: node tests/test-embed-publish.js)
//
// Como funciona: ganchos de módulo (module.register) trocam logger, config, repositórios, motor GTAO, IA, axios
// e os módulos pesados do painel por dublês; os módulos reais do pacote são importados de verdade. O arquivo de
// bans, o cache do semanal, o banco e a auditoria vão para uma pasta temporária (nada em src/data nem em database/).
// YUI_P6B_ROOT (opcional) aponta para outra árvore com a mesma estrutura, para conferir que os testes FALHAM no
// código antigo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.YUI_P6B_ROOT ? path.resolve(process.env.YUI_P6B_ROOT) : path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-embed-publish-'));
process.env.DATABASE_DIR = path.join(tmp, 'db');
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_BANS_FILE = path.join(tmp, 'bans.json');
process.env.YUI_ALERTS = 'false';
fs.mkdirSync(process.env.DATABASE_DIR, { recursive: true });

// ---- estado compartilhado com os dublês --------------------------------------------------------------
const S = (globalThis.__p6b = {
  logs: [],
  config: { ownerId: 'owner', isOwner: (id) => id === 'owner', defaultAutoMod: true, automodMode: 'both', appealChannelId: '' },
  apiConfig: { youtube: { apiKey: 'chave-falsa-youtube' }, twitch: { clientId: 'id-falso', clientSecret: 'segredo-falso' } },
  guilds: [],
  published: new Set(),
  recorded: [],
  latestWeekly: null,
  latestDaily: null,
  collected: null,
  collectCalls: 0,
  fetchImpl: async () => { throw new Error('fetch sem dublê'); },
  axiosGet: async () => { throw new Error('axios.get sem dublê'); },
  subs: { youtube: { changes: 1 }, twitch: { changes: 1 }, removeYoutube: { changes: 0 }, removeTwitch: { changes: 0 } },
  llm: { calls: [], disabled: [], tools: [] },
});
S.logger = {
  info: (m) => S.logs.push(['info', String(m)]),
  warn: (m) => S.logs.push(['warn', String(m)]),
  error: (m) => S.logs.push(['error', String(m)]),
  debug: (m) => S.logs.push(['debug', String(m)]),
};
S.repos = {
  guild: { getAll: () => S.guilds },
  publication: {
    isPublished: (kind, id, guild) => S.published.has(`${kind}|${id}|${guild}`),
    recordPublication: (kind, id, guild, channel, msg) => { S.published.add(`${kind}|${id}|${guild}`); S.recorded.push({ kind, id, guild, channel, msg }); },
  },
  gtao: { getLatestWeekly: () => S.latestWeekly, getLatestDaily: () => (S.latestDaily ? { data: S.latestDaily } : null) },
  youtube: { addSubscription: () => S.subs.youtube, removeByGuildAndChannel: () => S.subs.removeYoutube, getSubscriptionsByChannel: () => [] },
  twitch: { addSubscription: () => S.subs.twitch, removeByGuildAndLogin: () => S.subs.removeTwitch, getSubscriptionsByLogin: () => [] },
};

// ---- dublês de módulo ---------------------------------------------------------------------------------
const LOGGER = 'export const logger = globalThis.__p6b.logger; export default logger;';
const stubSources = {
  '../utils/logger.js': LOGGER,
  '../../utils/logger.js': LOGGER,
  '../../../../utils/logger.js': LOGGER,
  '../config.js': 'export default globalThis.__p6b.config;',
  '../config/index.js': 'export const config = globalThis.__p6b.apiConfig; export default config;',
  '../database/repositories/guildRepo.js': 'export const guildRepository = globalThis.__p6b.repos.guild;',
  '../database/repositories/publicationRepo.js': 'export const publicationRepository = globalThis.__p6b.repos.publication;',
  '../database/repositories/gtaoRepo.js': 'export const gtaoRepository = globalThis.__p6b.repos.gtao;',
  '../database/repositories/youtubeRepo.js': 'export const youtubeRepository = globalThis.__p6b.repos.youtube;',
  '../database/repositories/twitchRepo.js': 'export const twitchRepository = globalThis.__p6b.repos.twitch;',
  '../../database/repositories/youtubeRepo.js': 'export const youtubeRepository = globalThis.__p6b.repos.youtube;',
  '../../database/repositories/twitchRepo.js': 'export const twitchRepository = globalThis.__p6b.repos.twitch;',
  '../engines/gtao/index.js': 'export const gtaoEngine = { collectWeekly: async () => { globalThis.__p6b.collectCalls++; return globalThis.__p6b.collected; } };',
  '../engines/gtao/systems/weekly/aiTranslate.js': 'export const translateWeeklyForEmbed = async (w) => w;',
  '../../handlers/llmHandler.js': 'export const generateResponse = async () => null;',
  './llmHandler.js': `const s = globalThis.__p6b.llm;
export const updateShowModel = (v) => s.calls.push(['showModel', v]);
export const getShowModel = () => true;
export const updateShowModelThinking = (v) => s.calls.push(['thinking', v]);
export const getShowModelThinking = () => false;
export const updateErrorRetries = (v) => s.calls.push(['retries', v]);
export const getErrorRetries = () => 3;
export const getDisabledTools = () => s.disabled;
export const getAllMcpTools = () => s.tools;
export const setServerToolEnabled = () => {};
export const resetServerTools = () => {};`,
  './configPanelHandler.js': 'export const handleConfigCommand = async () => null;',
  './mcpToolPanelHandler.js': 'export const sendMcpToolsManager = async () => null;',
  './memoryAdminHandler.js': 'export const handleMemoriasAdmin = async () => null;',
  './reddit.js': 'export const getLatestWeekly = async () => null; export const searchWeeklyPosts = async () => [];',
  './parser.js': 'export const parseWeekly = () => ({ periodo: {}, bonus: [], desafios: [], recompensas: [], descontos: [], veiculos: {}, gunVan: [], gtaPlus: {}, atualizadoEm: null });',
  './validator.js': 'export const isValidWeekly = () => true;',
  axios: 'export default { get: (...a) => globalThis.__p6b.axiosGet(...a) };',
};
const stubUrls = Object.fromEntries(Object.entries(stubSources).map(([k, v]) => [k, `data:text/javascript,${encodeURIComponent(v)}`]));
const hooks = `
let stubs = {};
let srcUrl = '';
export function initialize(data) { stubs = data.stubs; srcUrl = data.srcUrl; }
export function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier) && String(context.parentURL || '').startsWith(srcUrl)) {
    return { url: stubs[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, {
  parentURL: import.meta.url,
  data: { stubs: stubUrls, srcUrl: pathToFileURL(path.join(root, 'src') + path.sep).href },
});

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { createNewswireEmbed } = await load('src/discord/embeds/newswireEmbed.js');
const daily = await load('src/discord/embeds/dailyEmbed.js');
const analysis = await load('src/engines/gtao/weeklyAnalysis.js');
const { discordPublisher } = await load('src/discord/publisher.js');
const { weeklyService, readCache } = await load('src/engines/gtao/systems/weekly/service.js');
const ban = await load('src/handlers/banHandler.js');
const { buildBanListPayload, buildBanDetailPayload } = await load('src/handlers/banListHandler.js');
const creator = await load('src/handlers/creatorAdminHandler.js');
const game = await load('src/handlers/gameHandler.js');
const { seguirYoutubeCommand } = await load('src/discord/commands/seguirYoutube.js');
const { seguirTwitchCommand } = await load('src/discord/commands/seguirTwitch.js');
const { pararSeguirCommand } = await load('src/discord/commands/pararSeguir.js');
const ytApi = await load('src/handlers/youtubeApiHandler.js');
const twApi = await load('src/handlers/twitchApiHandler.js');
const { getSteamGameInfo } = await load('src/handlers/steamHandler.js');

// ---- mini framework ----------------------------------------------------------------------------------
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✘ FALHA: ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

// ---- verificadores dos limites do Discord (a API recusa o que passar disto) ---------------------------
const isUrl = (u) => /^https?:\/\/\S+$/i.test(u) || /^attachment:\/\/\S+$/i.test(u);
function embedJson(e) { return typeof e?.toJSON === 'function' ? e.toJSON() : e; }
function embedSize(j) {
  let n = (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text?.length ?? 0) + (j.author?.name?.length ?? 0);
  for (const f of j.fields ?? []) n += f.name.length + f.value.length;
  return n;
}
function checkEmbed(e, label = 'embed') {
  const j = embedJson(e);
  assert.ok((j.title?.length ?? 0) <= 256, `${label}: título com ${j.title?.length}`);
  assert.ok((j.description?.length ?? 0) <= 4096, `${label}: descrição com ${j.description?.length}`);
  assert.ok((j.fields?.length ?? 0) <= 25, `${label}: ${j.fields?.length} campos`);
  for (const f of j.fields ?? []) {
    assert.ok(f.name.length >= 1 && f.name.length <= 256, `${label}: nome de campo com ${f.name.length}`);
    assert.ok(f.value.length >= 1 && f.value.length <= 1024, `${label}: valor de campo "${f.name}" com ${f.value.length}`);
  }
  assert.ok((j.footer?.text?.length ?? 0) <= 2048, `${label}: rodapé grande`);
  assert.ok((j.author?.name?.length ?? 0) <= 256, `${label}: autor com ${j.author?.name?.length}`);
  for (const u of [j.url, j.image?.url, j.thumbnail?.url, j.author?.url, j.author?.icon_url, j.footer?.icon_url]) {
    if (u !== undefined) assert.ok(isUrl(u), `${label}: URL inválida ${String(u).slice(0, 60)}`);
  }
  assert.ok(embedSize(j) <= 6000, `${label}: soma ${embedSize(j)} passa de 6000`);
  return j;
}
function checkComponents(rows, label = 'componentes') {
  assert.ok((rows?.length ?? 0) <= 5, `${label}: linhas demais`);
  for (const row of rows ?? []) {
    const rj = typeof row.toJSON === 'function' ? row.toJSON() : row;
    for (const c of rj.components ?? []) {
      if (c.type === 3) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25, `${label}: ${c.options.length} opções`);
        for (const o of c.options) {
          assert.ok(o.label.length >= 1 && o.label.length <= 100, `${label}: rótulo com ${o.label.length}`);
          assert.ok(o.value.length >= 1 && o.value.length <= 100, `${label}: valor com ${o.value.length}`);
          if (o.description !== undefined) assert.ok(o.description.length >= 1 && o.description.length <= 100, `${label}: descrição com ${o.description.length}`);
        }
      }
      if (c.type === 2 && c.label !== undefined) assert.ok(c.label.length <= 80, `${label}: botão com ${c.label.length}`);
    }
  }
}
function checkPayload(p, label = 'mensagem') {
  if (typeof p === 'string') { assert.ok(p.length <= 2000, `${label}: texto com ${p.length}`); return; }
  if (p.content !== undefined && p.content !== null) assert.ok(String(p.content).length <= 2000, `${label}: content com ${String(p.content).length}`);
  assert.ok((p.embeds?.length ?? 0) <= 10, `${label}: embeds demais`);
  let total = 0;
  for (const e of p.embeds ?? []) { const j = checkEmbed(e, label); total += embedSize(j); }
  assert.ok(total <= 6000, `${label}: soma dos embeds ${total}`);
  checkComponents(p.components, label);
}

// ---- construtores de dublês ----------------------------------------------------------------------------
function makeClient(sent) {
  const channels = new Map();
  const fetchChannel = async (id) => {
    if (!channels.has(id)) {
      channels.set(id, {
        id,
        isTextBased: () => true,
        send: async (payload) => {
          sent.push({ channel: id, payload });
          return { id: `msg-${sent.length}`, createMessageComponentCollector: () => ({ on() {} }), edit: async () => ({}) };
        },
      });
    }
    return channels.get(id);
  };
  return { channels: { fetch: fetchChannel } };
}
function resetPublisherState(guilds) {
  S.guilds = guilds;
  S.published = new Set();
  S.recorded = [];
  S.logs = [];
  S.latestWeekly = null;
  S.latestDaily = null;
  S.collected = null;
  S.collectCalls = 0;
}
const TWO_GUILDS = [
  { guild_id: 'g1', news_channel_id: 'c1', daily_channel_id: 'c1', weekly_channel_id: 'c1' },
  { guild_id: 'g2', news_channel_id: 'c2', daily_channel_id: 'c2', weekly_channel_id: 'c2' },
];
const logsOf = (level) => S.logs.filter(([l]) => l === level).map(([, m]) => m);
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
const big = (n, c = 'x') => c.repeat(n);
/** Espera uma promessa por até 3 s (sem prender o processo se o código antigo nunca chamar editReply). */
const waitFor = (promise, ms = 3000) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tempo esgotado esperando o editReply')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

// ========================================================================================================
console.log('newswireEmbed (TG-18)');
await test('artigo normal: mesmo resultado de antes (título, link, autor, rodapé, data e imagem)', () => {
  const j = embedJson(createNewswireEmbed({
    title: 'Novo carro', url: 'https://www.rockstargames.com/newswire/article/abc', category: 'Eventos',
    publishedAt: '2026-10-08T14:00:00.000Z', thumbnailUrl: 'https://cdn.example.com/a.png',
  }));
  assert.equal(j.title, '📰 Novo carro');
  assert.equal(j.url, 'https://www.rockstargames.com/newswire/article/abc');
  assert.equal(j.author.name, 'Rockstar Games Newswire');
  assert.equal(j.author.url, 'https://www.rockstargames.com/newswire');
  assert.ok(isUrl(j.author.icon_url));
  assert.equal(j.footer.text, 'Categoria: Eventos');
  assert.equal(j.timestamp, '2026-10-08T14:00:00.000Z');
  assert.equal(j.image.url, 'https://cdn.example.com/a.png');
  assert.equal(j.color, 0xFCAF17);
});
await test('título de 400 caracteres, link relativo, imagem inválida, data inválida e categoria enorme: monta sem lançar', () => {
  const j = checkEmbed(createNewswireEmbed({
    title: big(400, 'T'), url: '/pt/newswire/x', category: big(5000), publishedAt: 'isto não é data', thumbnailUrl: 'javascript:alert(1)',
  }));
  assert.ok(j.title.length <= 256 && j.title.startsWith('📰 '));
  assert.equal(j.url, undefined, 'link relativo é descartado');
  assert.equal(j.image, undefined, 'imagem inválida é descartada');
  assert.ok(Number.isFinite(Date.parse(j.timestamp)), 'data inválida vira o momento atual');
  assert.ok(j.footer.text.length <= 120);
});
await test('artigo nulo ou vazio não lança', () => {
  checkEmbed(createNewswireEmbed(null));
  checkEmbed(createNewswireEmbed({}));
});

console.log('dailyEmbed (TG-18)');
const dailySample = {
  date: '2026-10-15',
  gunVan: { locationName: 'Paleto Bay', weapons: [{ name: 'Micro SMG', discountPercent: 30 }, { name: 'Pistol' }] },
  streetDealers: { dealers: [{ locationName: 'Vinewood', premiumProduct: 'Cocaína' }] },
  collectibles: { shipwreck: { locationName: 'Costa' }, treasureChests: [{ locationName: 'Baú 1' }] },
  timeTrials: { rcBandito: { locationName: 'Pista A' }, junkEnergyBike: { locationName: 'Pista B' } },
};
await test('dados normais: campos, ordem e valores iguais aos de antes', () => {
  const j = checkEmbed(daily.createDailyEmbed(dailySample));
  assert.equal(j.title, '📅 GTA Online — Reset Diário (2026-10-15)');
  assert.equal(j.description, 'Confira as localizações e inventários atualizados para o dia de hoje no GTA Online:');
  assert.deepEqual(j.fields.map((f) => f.name), ['**🚐 Van de Armas**', '**🏪 Comerciantes**', '**🚢 Naufrágio Diário**', '**💰 Baús do Tesouro**', '**🏎️ Desafios Contra o Relógio**']);
  assert.deepEqual(j.fields.map((f) => f.inline), [false, false, true, true, false]);
  assert.ok(j.fields[0].value.startsWith('📍 Localização: Paleto Bay\n🔫 Destaques:\n- '));
  assert.ok(j.fields[0].value.includes('(-30%)'));
  assert.equal(j.fields[1].value, '• Vinewood (⭐ Cocaína)');
  assert.equal(j.fields[2].value, '📍 Localização: Costa');
  assert.equal(j.fields[3].value, '📍 Baú 1');
  assert.equal(j.fields[4].value, '• RC Bandito: Pista A\n• Junk Energy Bike: Pista B');
  assert.equal(j.footer.text, 'Reset diário ocorre pontualmente às 06:00 UTC');
  assert.ok(isUrl(j.thumbnail.url));
});
await test('listas enormes viram campos "cont." dentro dos limites (nada de estourar 1024)', () => {
  const j = checkEmbed(daily.createDailyEmbed({
    ...dailySample,
    streetDealers: { dealers: Array.from({ length: 80 }, (_, i) => ({ locationName: `Local ${i} ${big(40, 'l')}`, premiumProduct: 'Produto' })) },
    collectibles: { treasureChests: Array.from({ length: 80 }, (_, i) => ({ locationName: `Baú ${i} ${big(40, 'b')}` })) },
  }));
  assert.ok(j.fields.some((f) => f.name.includes('(cont.)')));
});
await test('uma seção com dado estranho é ignorada e as outras seguem (antes lançava e derrubava o diário)', () => {
  S.logs = [];
  const j = checkEmbed(daily.createDailyEmbed({ ...dailySample, gunVan: { weapons: 'não é lista' }, timeTrials: { rcBandito: null, junkEnergyBike: { locationName: 'B' } } }));
  assert.ok(!j.fields.some((f) => f.name.includes('Van de Armas')));
  assert.ok(j.fields.some((f) => f.name.includes('Comerciantes')));
  assert.ok(logsOf('warn').some((m) => m.includes('Van de Armas')));
});
await test('dados nulos, data enorme e versão mínima não lançam', () => {
  checkEmbed(daily.createDailyEmbed(null));
  const j = checkEmbed(daily.createDailyEmbed({ date: big(500, '9') }));
  assert.ok(j.title.length <= 256);
  const m = checkEmbed(daily.createMinimalDailyEmbed({ date: '2026-10-15' }));
  assert.ok(m.title.includes('2026-10-15') && m.description.includes('/gta-diario'));
  checkEmbed(daily.createMinimalDailyEmbed(null));
});

// ========================================================================================================
console.log('publisher: um item ruim não aborta o lote (TG-18)');
const article = (n, extra = {}) => ({ id: `a${n}`, title: `Notícia ${n}`, url: `https://www.rockstargames.com/newswire/${n}`, category: 'Geral', publishedAt: '2026-10-08T14:00:00.000Z', ...extra });
await test('3 artigos, o do meio com título de 400 caracteres e link inválido: as 3 notícias saem em cada servidor', async () => {
  resetPublisherState(TWO_GUILDS);
  const sent = [];
  await discordPublisher.publishNews(makeClient(sent), [article(1), article(2, { title: big(400, 'M'), url: '/relativo', thumbnailUrl: 'x' }), article(3)]);
  assert.equal(sent.length, 6, `enviadas ${sent.length}`);
  assert.equal(S.recorded.length, 6);
  for (const s of sent) checkPayload(s.payload, 'notícia');
  assert.deepEqual(S.recorded.filter((r) => r.guild === 'g1').map((r) => r.id), ['a1', 'a2', 'a3']);
});
await test('artigo cujo embed lança (getter que explode) e artigo nulo: os demais saem e o erro vai para o log', async () => {
  resetPublisherState(TWO_GUILDS);
  const sent = [];
  const bomb = article(2);
  Object.defineProperty(bomb, 'title', { get() { throw new Error('boom'); }, enumerable: true });
  await discordPublisher.publishNews(makeClient(sent), [article(1), bomb, null, article(3)]);
  assert.equal(sent.length, 4, `enviadas ${sent.length}`);
  assert.deepEqual([...new Set(S.recorded.map((r) => r.id))].sort(), ['a1', 'a3']);
  assert.ok(logsOf('error').some((m) => m.includes('a2') && m.includes('ignorado')));
});
await test('falha ao ler o último semanal não impede a publicação das notícias', async () => {
  resetPublisherState(TWO_GUILDS);
  const original = S.repos.gtao.getLatestWeekly;
  S.repos.gtao.getLatestWeekly = () => { throw new Error('banco travado'); };
  try {
    const sent = [];
    await discordPublisher.publishNews(makeClient(sent), [article(1)]);
    assert.equal(sent.length, 2);
  } finally { S.repos.gtao.getLatestWeekly = original; }
});
await test('artigo igual ao semanal mais recente continua sendo pulado', async () => {
  resetPublisherState(TWO_GUILDS);
  S.latestWeekly = { data: { url: 'https://www.rockstargames.com/newswire/1' } };
  const sent = [];
  await discordPublisher.publishNews(makeClient(sent), [article(1), article(2)]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.payload.embeds[0].toJSON().title === '📰 Notícia 2'));
});

console.log('publisher: diário');
await test('diário normal é publicado em todos os servidores', async () => {
  resetPublisherState(TWO_GUILDS);
  const sent = [];
  await discordPublisher.publishDaily(makeClient(sent), dailySample);
  assert.equal(sent.length, 2);
  for (const s of sent) checkPayload(s.payload, 'diário');
});
await test('diário com seção quebrada ainda é publicado (as outras seções saem)', async () => {
  resetPublisherState(TWO_GUILDS);
  const sent = [];
  await discordPublisher.publishDaily(makeClient(sent), { ...dailySample, streetDealers: { dealers: 7 } });
  assert.equal(sent.length, 2);
  assert.ok(sent[0].payload.embeds[0].toJSON().fields.length >= 3);
});
await test('se a montagem completa lança, publica a versão mínima; se nada monta, não lança', async () => {
  resetPublisherState(TWO_GUILDS);
  let reads = 0;
  const flaky = { ...dailySample };
  Object.defineProperty(flaky, 'date', { get() { if (reads++ === 0) throw new Error('boom'); return '2026-10-15'; }, enumerable: true });
  const sent = [];
  await discordPublisher.publishDaily(makeClient(sent), flaky);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].payload.embeds[0].toJSON().description.includes('/gta-diario'));

  resetPublisherState(TWO_GUILDS);
  const broken = {};
  Object.defineProperty(broken, 'date', { get() { throw new Error('sempre'); }, enumerable: true });
  const sent2 = [];
  await discordPublisher.publishDaily(makeClient(sent2), broken);
  assert.equal(sent2.length, 0);
  assert.ok(logsOf('error').length >= 1);
});

console.log('publisher: semanal (Newswire e Reddit)');
const hostileWeekly = () => ({
  id: 'abc123',
  url: 'isto não é uma url',
  title: 'Weekly Bonuses and Discounts for GTA Online '.repeat(14),
  periodo: { inicio: '2026-10-08', fim: '2026-10-15' },
  bonus: [{ multiplicador: '2', atividades: ['Export Mixed Goods Missions', 'Madrazo Hits'] }],
  descontos: [], discounts: [], gunVan: [], veiculos: {}, desafios: [], gtaPlus: {},
  analysis: { titulo: big(600, 'T'), destaques: big(5000, 'D'), itensGratuitos: 'Roupa grátis', avaliacao: 'Semana Boa 🟢' },
});
await test('semanal (Reddit) com título de 600 caracteres, link inválido e análise gigante: publica e respeita os limites', async () => {
  resetPublisherState(TWO_GUILDS);
  S.collected = hostileWeekly();
  const sent = [];
  const n = await discordPublisher.publishWeeklyReddit(makeClient(sent), hostileWeekly());
  assert.equal(n, 2, `publicados ${n}`);
  assert.equal(sent.length, 2);
  for (const s of sent) checkPayload(s.payload, 'semanal');
  assert.equal(S.recorded.length, 2);
});
await test('semanal (Reddit) na versão mínima: não coleta, não traduz e publica só título e link', async () => {
  resetPublisherState(TWO_GUILDS);
  S.collected = hostileWeekly();
  const sent = [];
  const weekly = { ...hostileWeekly(), url: 'https://www.reddit.com/r/gtaonline/comments/abc123/', minimal: true };
  const n = await discordPublisher.publishWeeklyReddit(makeClient(sent), weekly);
  assert.equal(n, 2);
  assert.equal(S.collectCalls, 0, 'a versão mínima não refaz a coleta');
  const j = checkEmbed(sent[0].payload.embeds[0]);
  assert.equal(j.url, 'https://www.reddit.com/r/gtaonline/comments/abc123/');
  assert.ok(j.description.includes('Não consegui montar o resumo completo'));
  assert.equal(sent[0].payload.components.length, 1);
});
await test('semanal (Newswire) com dado hostil também publica', async () => {
  resetPublisherState(TWO_GUILDS);
  const sent = [];
  await discordPublisher.publishWeekly(makeClient(sent), hostileWeekly(), '2026-W42');
  assert.equal(sent.length, 2);
  for (const s of sent) checkPayload(s.payload, 'semanal');
});
await test('leitura do diário falhando não impede o semanal', async () => {
  resetPublisherState(TWO_GUILDS);
  S.collected = hostileWeekly();
  const original = S.repos.gtao.getLatestDaily;
  S.repos.gtao.getLatestDaily = () => { throw new Error('banco travado'); };
  try {
    const sent = [];
    await discordPublisher.publishWeeklyReddit(makeClient(sent), hostileWeekly());
    assert.equal(sent.length, 2);
  } finally { S.repos.gtao.getLatestDaily = original; }
});

console.log('publisher: eventos do YouTube e da Twitch');
await test('evento do YouTube e da Twitch com embed que lança: devolve 0 sem lançar', async () => {
  resetPublisherState(TWO_GUILDS);
  S.repos.youtube.getSubscriptionsByChannel = () => [{ guild_id: 'g1', discord_channel_id: 'c1', notify_videos: 1 }];
  S.repos.twitch.getSubscriptionsByLogin = () => [{ guild_id: 'g1', discord_channel_id: 'c1' }];
  const sent = [];
  const client = makeClient(sent);
  const ytBad = { videoId: 'vid1', channelId: 'UC1', type: 'video', url: 'https://youtu.be/vid1', channelName: 'Canal' };
  Object.defineProperty(ytBad, 'title', { get() { throw new Error('boom'); }, enumerable: true });
  assert.equal(await discordPublisher.publishYoutubeEvent(client, ytBad), 0);
  const twBad = { login: 'streamer', streamId: 's1' };
  Object.defineProperty(twBad, 'title', { get() { throw new Error('boom'); }, enumerable: true });
  assert.equal(await discordPublisher.publishTwitchEvent(client, twBad), 0);
  assert.equal(sent.length, 0);
  assert.ok(logsOf('error').length >= 2);
});

// ========================================================================================================
console.log('weeklyAnalysis: páginas do semanal (TG-18)');
await test('autor e títulos longos viram no máximo 256 e todas as páginas respeitam os limites', () => {
  const pages = analysis.buildWeeklyCombinedEmbeds(hostileWeekly());
  assert.ok(pages.length >= 2, `páginas ${pages.length}`);
  for (const p of pages) checkEmbed(p, 'página do semanal');
  assert.ok(pages.every((p) => embedJson(p).title.length <= 256));
});
await test('as páginas normais não mudaram: cabeçalho de autor, miniatura e numeração', () => {
  const pages = analysis.buildWeeklyCombinedEmbeds({
    id: 'x', url: 'https://www.reddit.com/r/gtaonline/comments/x/', title: 'Weekly Bonuses', analysis: { titulo: 'Bônus da Semana', destaques: 'a', itensGratuitos: 'b', avaliacao: 'c' },
  });
  const j = embedJson(pages[0]);
  assert.equal(j.title, '📰 Página 1/2 — Destaques & Itens Gratuitos');
  assert.equal(j.author.name, '🚨 GTA Online — Bônus da Semana');
  assert.equal(j.author.url, 'https://www.reddit.com/r/gtaonline/comments/x/');
  assert.ok(isUrl(j.thumbnail.url));
  assert.ok(j.timestamp);
});
await test('página de resumo que lança é ignorada e as páginas da análise saem', () => {
  S.logs = [];
  const pages = analysis.buildWeeklyCombinedEmbeds({ id: 'x', title: 'Weekly', bonus: [null], analysis: { destaques: 'Eventos', itensGratuitos: 'Roupa' } });
  assert.ok(pages.length >= 1);
  assert.ok(embedJson(pages[0]).title.includes('Destaques'));
  assert.ok(logsOf('warn').some((m) => m.includes('ignorada')));
});
await test('tudo falhando e sem análise: devolve a versão mínima em vez de "sem dados"', () => {
  const pages = analysis.buildWeeklyCombinedEmbeds({ id: 'x', title: 'Weekly Bonuses', url: 'https://www.reddit.com/r/gtaonline/comments/x/', bonus: [null] });
  assert.equal(pages.length, 1);
  const j = checkEmbed(pages[0]);
  assert.ok(j.description.includes('Não consegui montar o resumo completo'));
  assert.equal(j.url, 'https://www.reddit.com/r/gtaonline/comments/x/');
});
await test('sem dados nenhum continua dando o aviso de "sem dados" e a versão mínima nunca lança', () => {
  const pages = analysis.buildWeeklyCombinedEmbeds({});
  assert.equal(pages.length, 1);
  assert.ok(embedJson(pages[0]).title.includes('Sem dados disponíveis'));
  const bomb = {};
  Object.defineProperty(bomb, 'analysis', { get() { throw new Error('boom'); }, enumerable: true });
  const safe = analysis.buildWeeklyCombinedEmbeds(bomb);
  assert.equal(safe.length, 1);
  checkEmbed(analysis.buildMinimalWeeklyEmbed(null));
  checkEmbed(analysis.buildMinimalWeeklyEmbed({ title: big(900), url: 'xx' }));
});

// ========================================================================================================
console.log('weekly/service: falhas seguidas do mesmo post (TG-18)');
const cachePath = (n) => path.join(tmp, `weekly-cache-${n}.json`);
function serviceHarness(n, { failUnlessMinimal = false, alwaysFail = true } = {}) {
  const calls = [];
  const alerts = [];
  const file = cachePath(n);
  const opts = (postId) => ({
    cacheFile: file,
    fetchLatest: async () => ({ id: postId, url: `https://www.reddit.com/r/gtaonline/comments/${postId}/`, title: 'Weekly', selftext: 'texto', createdUtc: 1 }),
    alert: (...a) => alerts.push(a),
    onNew: async (weekly) => {
      calls.push({ id: weekly.id, minimal: weekly.minimal === true });
      if (failUnlessMinimal && weekly.minimal === true) return;
      if (alwaysFail) throw new Error('RangeError: Invalid string length');
    },
  });
  return { calls, alerts, file, opts };
}
await test('a 3ª falha seguida alerta o dono, publica a versão mínima e grava o cache (para de repetir)', async () => {
  const h = serviceHarness(1, { failUnlessMinimal: true });
  const r1 = await weeklyService.checkForUpdates(h.opts('P1'));
  assert.deepEqual([r1.status, r1.failures], ['publish-error', 1]);
  assert.equal(readCache(h.file).postId, null, 'não grava o cache enquanto ainda vai repetir');
  const r2 = await weeklyService.checkForUpdates(h.opts('P1'));
  assert.deepEqual([r2.status, r2.failures], ['publish-error', 2]);
  assert.equal(h.alerts.length, 0);
  const r3 = await weeklyService.checkForUpdates(h.opts('P1'));
  assert.equal(r3.status, 'published-minimal');
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0][0], 'weekly-publish');
  assert.ok(String(h.alerts[0][2]).includes('P1'));
  assert.ok(String(h.alerts[0][2]).includes('só o título e o link'));
  assert.equal(readCache(h.file).postId, 'P1');
  assert.deepEqual(h.calls.map((c) => c.minimal), [false, false, false, true]);
  const r4 = await weeklyService.checkForUpdates(h.opts('P1'));
  assert.equal(r4.status, 'already-processed');
  assert.equal(h.calls.length, 4, 'depois de desistir não chama mais a publicação');
});
await test('se a versão mínima também falha: desiste da semana, grava o cache e avisa', async () => {
  const h = serviceHarness(2, { alwaysFail: true });
  await weeklyService.checkForUpdates(h.opts('P2'));
  await weeklyService.checkForUpdates(h.opts('P2'));
  const r3 = await weeklyService.checkForUpdates(h.opts('P2'));
  assert.equal(r3.status, 'publish-abandoned');
  assert.equal(h.alerts.length, 1);
  assert.ok(String(h.alerts[0][2]).includes('Desisti'));
  assert.equal(readCache(h.file).postId, 'P2');
  assert.equal((await weeklyService.checkForUpdates(h.opts('P2'))).status, 'already-processed');
});
await test('um sucesso zera a conta; falhas de posts diferentes não se somam', async () => {
  const h = serviceHarness(3, { alwaysFail: true });
  assert.equal((await weeklyService.checkForUpdates(h.opts('A'))).failures, 1);
  assert.equal((await weeklyService.checkForUpdates(h.opts('A'))).failures, 2);
  assert.equal((await weeklyService.checkForUpdates(h.opts('B'))).failures, 1, 'post diferente recomeça a conta');
  const ok = { ...h.opts('B'), onNew: async () => {} };
  assert.equal((await weeklyService.checkForUpdates(ok)).status, 'published');
  assert.equal(readCache(h.file).postId, 'B');
  // depois do sucesso, uma falha de outro post volta a contar de 1
  assert.equal((await weeklyService.checkForUpdates(h.opts('C'))).failures, 1);
  const ok2 = { ...h.opts('C'), onNew: async () => {} };
  await weeklyService.checkForUpdates(ok2);
});
await test('sem falhas o ciclo continua igual: publica e grava o cache', async () => {
  const h = serviceHarness(4);
  const seen = [];
  const r = await weeklyService.checkForUpdates({ ...h.opts('Z'), onNew: async (w) => { seen.push(w.id); } });
  assert.equal(r.status, 'published');
  assert.deepEqual(seen, ['Z']);
  assert.equal(readCache(h.file).postId, 'Z');
});

// ========================================================================================================
console.log('banHandler e banListHandler (TG-19)');
await test('addBan grava o motivo cortado em 300 e o arquivo de bans é o temporário', () => {
  ban.addBan('user', '111111111111111111', big(5000, 'm'));
  const reason = ban.getBans().users['111111111111111111'].reason;
  assert.ok(reason.length <= 300 && reason.length > 200, `motivo gravado com ${reason.length}`);
  const onDisk = JSON.parse(fs.readFileSync(process.env.YUI_BANS_FILE, 'utf8'));
  assert.equal(onDisk.users['111111111111111111'].reason, reason);
  assert.ok(ban.getBans().users['111111111111111111'].timestamp);
});
await test('motivo curto, padrão e vazio continuam iguais', () => {
  ban.addBan('user', '222222222222222222', 'Spam de links');
  assert.equal(ban.getBans().users['222222222222222222'].reason, 'Spam de links');
  ban.addBan('guild', '333333333333333333');
  assert.equal(ban.getBans().guilds['333333333333333333'].reason, 'Violação dos Termos de Uso.');
  ban.addBan('channel', '444444444444444444', '');
  assert.equal(ban.getBans().channels['444444444444444444'].reason, '');
});
await test('checkBan devolve o motivo cortado (registro antigo com motivo gigante) e mantém a regra do termo proibido', () => {
  ban.getBans().users['555555555555555555'] = { reason: big(4000, 'r'), timestamp: 'x' };
  const info = ban.checkBan('555555555555555555', null, null);
  assert.equal(info.type, 'user');
  assert.ok(info.reason.length <= 300);
  ban.getBans().users['666666666666666666'] = { reason: 'Identificado termo proibido no prompt: palavrão' };
  assert.equal(ban.checkBan('666666666666666666', null, null).reason, 'Identificado termo proibido no prompt.');
  assert.equal(ban.checkBan('777777777777777777', null, null), null);
});
await test('clampBanReason: tipos estranhos não lançam', () => {
  assert.equal(ban.clampBanReason(null), '');
  assert.equal(ban.clampBanReason(undefined), '');
  assert.equal(ban.clampBanReason(12345), '12345');
  assert.ok(ban.clampBanReason({ a: big(1000) }).length <= 300);
});
function emptyClient() {
  const none = () => ({ cache: new Map(), fetch: async () => { throw new Error('desconhecido'); } });
  return { users: none(), guilds: none(), channels: none() };
}
await test('lista de bans com motivos de 5000 caracteres e ID gigante: página dentro dos limites e menu válido', async () => {
  const bans = ban.getBans();
  bans.users = {};
  for (let i = 0; i < 7; i++) bans.users[`10000000000000000${i}`] = { reason: big(5000, 'q'), timestamp: '2026-10-01T10:00:00.000Z' };
  bans.users[big(300, '9')] = { reason: big(5000, 'z'), timestamp: '2026-10-01T10:00:00.000Z' };
  for (const page of [0, 1]) {
    const payload = await buildBanListPayload(emptyClient(), 'users', page);
    checkPayload(payload, `lista de bans página ${page}`);
  }
  const first = await buildBanListPayload(emptyClient(), 'users', 0);
  assert.equal(embedJson(first.embeds[0]).fields.length, 5);
});
await test('página só com ID inválido para menu: sem menu, mas a lista aparece', async () => {
  const bans = ban.getBans();
  bans.channels = { [big(250, '8')]: { reason: big(900, 'k'), timestamp: 'x' } };
  const payload = await buildBanListPayload(emptyClient(), 'channels', 0);
  checkPayload(payload, 'lista de canais');
  assert.equal(payload.components.length, 1, 'só a linha de botões');
});
await test('detalhe do bloqueio de canal com tópico de 1024 caracteres e motivo gigante respeita 1024 por campo', async () => {
  const bans = ban.getBans();
  bans.channels = { 12345: { reason: big(5000, 'd'), timestamp: '2026-10-01T10:00:00.000Z' } };
  const client = emptyClient();
  client.channels.fetch = async (id) => ({ id, name: 'geral', type: 0, createdTimestamp: 1, topic: big(1024, 't'), guild: { name: 'G'.repeat(100), id: '99' } });
  const payload = await buildBanDetailPayload(client, 'channels', '12345');
  checkPayload(payload, 'detalhe do bloqueio');
});

// ========================================================================================================
console.log('creatorAdminHandler (TG-19)');
function ownerInteraction({ sub, strings = {}, fields = {}, customId = null }) {
  const calls = { replies: [], updates: [], modals: [] };
  const i = {
    user: { id: 'owner' },
    guildId: 'g1',
    customId,
    options: { getSubcommand: () => sub, getString: (n) => strings[n] ?? null, getBoolean: () => null, getInteger: () => null },
    fields: { getTextInputValue: (n) => fields[n] ?? '' },
    reply: async (p) => { calls.replies.push(p); return {}; },
    update: async (p) => { calls.updates.push(p); return {}; },
    showModal: async (m) => { calls.modals.push(m); return {}; },
  };
  return { i, calls };
}
await test('/banir com motivo, ID e tipo de 6000 caracteres: responde dentro dos limites e o eco é o que foi gravado', async () => {
  const { i, calls } = ownerInteraction({ sub: 'banir', strings: { tipo: big(6000, 't'), id: big(6000, '1'), motivo: big(6000, 'm') } });
  await creator.handleCreatorAdminCommand(i, emptyClient());
  assert.equal(calls.replies.length, 1);
  checkPayload(calls.replies[0], 'banir');
  const fields = embedJson(calls.replies[0].embeds[0]).fields;
  const motivo = fields.find((f) => f.name === 'Motivo').value;
  assert.ok(motivo.length <= 300);
});
await test('/banir normal: motivo e eco iguais aos de antes', async () => {
  const { i, calls } = ownerInteraction({ sub: 'banir', strings: { tipo: 'user', id: '888888888888888888', motivo: 'Flood' } });
  await creator.handleCreatorAdminCommand(i, emptyClient());
  const fields = embedJson(calls.replies[0].embeds[0]).fields;
  assert.deepEqual(fields.map((f) => [f.name, f.value]), [['Tipo', 'user'], ['ID', '`888888888888888888`'], ['Motivo', 'Flood']]);
  assert.equal(ban.getBans().users['888888888888888888'].reason, 'Flood');
});
await test('/desbanir, /automod e /ferramenta com entradas gigantes respondem dentro dos limites', async () => {
  for (const [sub, strings] of [
    ['desbanir', { tipo: big(6000), id: big(6000, '2') }],
    ['automod', { servidor_id: big(6000, '3'), modo: big(6000, 'o') }],
    ['ferramenta', { acao: 'toggle', ferramenta: big(6000, 'f'), estado: 'on' }],
    ['ferramenta', { acao: 'list', servidor_id: big(6000, '4') }],
    ['ferramenta', { acao: 'reset', servidor_id: big(6000, '5') }],
  ]) {
    const { i, calls } = ownerInteraction({ sub, strings });
    await creator.handleCreatorAdminCommand(i, emptyClient());
    assert.equal(calls.replies.length, 1, `${sub} respondeu`);
    checkPayload(calls.replies[0], `/${sub}`);
  }
});
await test('modal de ban: motivo de 4000 caracteres é gravado cortado e a resposta cabe; modal tem maxLength 300', async () => {
  const { i, calls } = ownerInteraction({ customId: 'crtcfg_modal_ban', fields: { acao: 'banir', tipo: big(4000, 'u'), id: big(4000, '6'), motivo: big(4000, 'm') } });
  await creator.handleCreatorAdminInteraction(i, emptyClient());
  checkPayload(calls.replies[0], 'modal de ban');
  const { i: i2, calls: c2 } = ownerInteraction({ customId: 'crtcfg_btn_ban' });
  await creator.handleCreatorAdminInteraction(i2, emptyClient());
  const modal = c2.modals[0].toJSON();
  const motivoInput = modal.components.map((r) => r.components[0]).find((c) => c.custom_id === 'motivo');
  assert.equal(motivoInput.max_length, 300);
});
await test('modais de desban, automod e MCP com entradas gigantes respondem dentro dos limites', async () => {
  for (const [customId, fields] of [
    ['crtcfg_modal_ban', { acao: 'desbanir', tipo: big(4000, 'u'), id: big(4000, '7') }],
    ['crtcfg_modal_automod', { servidor_id: big(4000, '8'), modo: 'off' }],
    ['crtcfg_modal_mcp', { servidor_id: big(4000, '9'), ferramenta: big(4000, 'g'), estado: 'on' }],
    ['crtcfg_modal_mcp', { servidor_id: big(4000, '9'), ferramenta: 'LIST' }],
    ['crtcfg_modal_mcp', { servidor_id: big(4000, '9'), ferramenta: 'RESET' }],
  ]) {
    const { i, calls } = ownerInteraction({ customId, fields });
    await creator.handleCreatorAdminInteraction(i, emptyClient());
    assert.equal(calls.replies.length, 1, `${customId} respondeu`);
    checkPayload(calls.replies[0], customId);
  }
});

// ========================================================================================================
console.log('gameHandler (TG-19, TG-33)');
function gameInteraction(name, collector) {
  const sent = [];
  const response = { createMessageComponentCollector: () => collector };
  const i = {
    user: { id: 'u1', tag: 'user#0001' },
    options: { getString: (n) => (n === 'nome' ? name : null) },
    deferReply: async () => response,
    editReply: async (p) => { sent.push(p); return {}; },
    deleteReply: async () => {},
  };
  return { i, sent };
}
function fakeCollector() {
  const c = new EventEmitter();
  c.stopped = false;
  c.stop = () => { c.stopped = true; };
  return c;
}
const games = (n) => Array.from({ length: n }, (_, k) => ({
  provider: k % 2 ? 'DODI' : 'FitGirl', emoji: '💃', title: `${k}: ${big(250, 'J')}`, fileSize: `${k}.5 GB`, uploadDate: '2026-01-01', magnet: `magnet:?xt=urn:btih:${k}`, hash: `${k}`,
}));
await test('nada encontrado com nome de 6000 caracteres: a resposta sai (antes passava de 2000 e ficava em "pensando")', async () => {
  const { i, sent } = gameInteraction(big(6000, 'n'), fakeCollector());
  await game.executeGameCommand(i, { searchGames: async () => [] });
  assert.equal(sent.length, 1);
  checkPayload(sent[0], 'nada encontrado');
  assert.ok(sent[0].content.includes('Nada encontrado'));
  assert.deepEqual(sent[0].allowedMentions, { parse: [] }, 'o nome digitado é eco: nenhuma menção (@everyone, @here, cargo, usuário) pode sair daqui');
});
await test('resultados: título do embed e opções do menu dentro dos limites com nome de 6000 e títulos de 255 caracteres', async () => {
  const { i, sent } = gameInteraction(big(6000, 'n'), fakeCollector());
  await game.executeGameCommand(i, { searchGames: async () => games(12) });
  assert.equal(sent.length, 1);
  checkPayload(sent[0], 'resultados');
  assert.ok(embedJson(sent[0].embeds[0]).title.length <= 256);
});
await test('seleção do jogo: "Download Pronto" com título de 255 e magnet gigante respeita 256/1024', async () => {
  const collector = fakeCollector();
  const { i, sent } = gameInteraction('jogo', collector);
  const list = games(3);
  list[0].magnet = `magnet:?${big(5000, 'm')}`;
  await game.executeGameCommand(i, {
    searchGames: async () => list,
    getTorrentOrMagnet: async (g) => ({ type: 'magnet', buffer: Buffer.from(g.magnet), fileName: 'link_magnetico.txt', message: 'ok', color: '#F59E0B' }),
  });
  let payload = null;
  let done;
  const finished = new Promise((r) => { done = r; });
  const sel = {
    user: { id: 'u1', tag: 'user#0001' }, customId: 'select_game', values: ['0'],
    update: async () => {}, reply: async () => {},
    editReply: async (p) => { payload = p; done(); return {}; },
  };
  collector.emit('collect', sel);
  await waitFor(finished);
  await new Promise((r) => setImmediate(r)); // deixa o ouvinte terminar (collector.stop vem depois do editReply)
  assert.ok(payload.embeds?.length === 1, 'enviou o embed de download');
  checkPayload({ embeds: payload.embeds }, 'download pronto');
  assert.ok(collector.stopped);
  assert.ok(sent.length >= 1);
});
await test('seleção com falha ao preparar o arquivo: avisa o usuário, não deixa rejeição sem tratamento e para o coletor', async () => {
  const collector = fakeCollector();
  const { i } = gameInteraction('jogo', collector);
  await game.executeGameCommand(i, { searchGames: async () => games(2), getTorrentOrMagnet: async () => { throw new Error('torrent quebrado'); } });
  let payload = null;
  let done;
  const finished = new Promise((r) => { done = r; });
  const sel = {
    user: { id: 'u1', tag: 'user#0001' }, customId: 'select_game', values: ['1'],
    update: async () => {}, reply: async () => {},
    editReply: async (p) => { payload = p; done(); return {}; },
  };
  collector.emit('collect', sel);
  await waitFor(finished);
  await new Promise((r) => setImmediate(r)); // deixa o ouvinte terminar (collector.stop vem depois do editReply)
  assert.ok(String(payload.content).includes('Não consegui preparar esse download'));
  assert.deepEqual(payload.embeds, []);
  assert.ok(collector.stopped);
  assert.ok(logsOf('warn').some((m) => m.includes('GameHandler')));
});
await test('searchGames limita a 12 palavras (busca de milhares de palavras não trava)', async () => {
  const t0 = performance.now();
  const r = await game.searchGames('a '.repeat(3000), 'any');
  assert.ok(Array.isArray(r));
  assert.ok(performance.now() - t0 < 15000);
});

// ========================================================================================================
console.log('seguir YouTube/Twitch e parar de seguir (TG-33)');
function slash({ strings = {}, guildId = 'g1' }) {
  const sent = [];
  const i = {
    guildId,
    options: {
      getString: (n) => strings[n] ?? null,
      getChannel: () => ({ id: 'chan1', toString: () => '<#chan1>' }),
      getRole: () => null,
      getBoolean: () => null,
    },
    deferReply: async () => {},
    editReply: async (p) => { sent.push(p); return {}; },
    reply: async (p) => { sent.push(p); return {}; },
  };
  return { i, sent };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => S.fetchImpl(String(url), init);
await test('/yui-seguir-youtube: canal não encontrado com entrada de 6000 caracteres ecoa só 100', async () => {
  S.fetchImpl = async () => response(200, { items: [] });
  const { i, sent } = slash({ strings: { canal: big(6000, 'c') } });
  await seguirYoutubeCommand.execute(i);
  checkPayload(sent[0], 'seguir youtube');
  assert.ok(sent[0].content.length < 400, `resposta com ${sent[0].content.length}`);
  assert.ok(sent[0].content.includes('Não encontrei o canal'));
});
await test('/yui-seguir-youtube: erro da API com corpo gigante vira mensagem curta (corpo cortado em 200)', async () => {
  S.fetchImpl = async () => response(500, `{\n  "error": "${big(6000, 'e')}"\n}`);
  const { i, sent } = slash({ strings: { canal: '@Canal' } });
  await seguirYoutubeCommand.execute(i);
  checkPayload(sent[0], 'seguir youtube erro');
  assert.ok(sent[0].content.includes('YouTube API channels error 500'));
  assert.ok(sent[0].content.length < 400, `resposta com ${sent[0].content.length}`);
  assert.ok(!sent[0].content.includes('\n  '), 'corpo em uma linha');
});
await test('/yui-seguir-youtube: canal encontrado continua igual', async () => {
  S.fetchImpl = async () => response(200, { items: [{ id: 'UC1234567890123456789012', snippet: { title: 'Meu Canal' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
  S.subs.youtube = { changes: 1 };
  const { i, sent } = slash({ strings: { canal: '@Canal' } });
  await seguirYoutubeCommand.execute(i);
  assert.ok(sent[0].content.startsWith('✅ **Agora seguindo!**'));
  assert.ok(sent[0].content.includes('📺 **Canal:** Meu Canal'));
});
await test('/yui-seguir-twitch: entrada de 6000 caracteres é recusada sem consultar a API', async () => {
  let calls = 0;
  S.fetchImpl = async () => { calls++; return response(200, { data: [] }); };
  const { i, sent } = slash({ strings: { streamer: big(6000, 's') } });
  await seguirTwitchCommand.execute(i);
  assert.equal(sent[0].content, '❌ Login da Twitch inválido.');
  assert.equal(calls, 0);
});
await test('/yui-seguir-twitch: erro da API com corpo gigante vira mensagem curta; login normal continua funcionando', async () => {
  S.fetchImpl = async (url) => (String(url).includes('oauth2/token') ? response(400, big(5000, 'b')) : response(200, { data: [] }));
  const a = slash({ strings: { streamer: 'alanzoka' } });
  await seguirTwitchCommand.execute(a.i);
  assert.ok(a.sent[0].content.includes('Twitch token error 400'));
  assert.ok(a.sent[0].content.length < 400, `resposta com ${a.sent[0].content.length}`);
  S.fetchImpl = async (url) => (String(url).includes('oauth2/token')
    ? response(200, { access_token: 'tok', expires_in: 3600 })
    : response(200, { data: [{ id: '1', login: 'alanzoka', display_name: 'Alanzoka' }] }));
  S.subs.twitch = { changes: 1 };
  const b = slash({ strings: { streamer: 'https://www.twitch.tv/alanzoka' } });
  await seguirTwitchCommand.execute(b.i);
  assert.ok(b.sent[0].content.includes('🎮 **Streamer:** Alanzoka (alanzoka)'));
});
await test('/yui-parar-seguir: alvo de 6000 caracteres ecoa só 100 (YouTube e Twitch)', async () => {
  for (const plataforma of ['youtube', 'twitch']) {
    const { i, sent } = slash({ strings: { plataforma, alvo: big(6000, 'a') } });
    await pararSeguirCommand.execute(i);
    checkPayload(sent[0], `parar seguir ${plataforma}`);
    assert.ok(sent[0].content.length < 300, `resposta com ${sent[0].content.length}`);
  }
  S.subs.removeYoutube = { changes: 1 };
  const ok = slash({ strings: { plataforma: 'youtube', alvo: 'UC123' } });
  await pararSeguirCommand.execute(ok.i);
  assert.equal(ok.sent[0].content, '✅ Parei de seguir o canal do YouTube **UC123** neste servidor.');
  S.subs.removeYoutube = { changes: 0 };
});
await test('youtubeApiHandler e twitchApiHandler: corpo de erro HTTP cortado em 200 e em uma linha', async () => {
  S.fetchImpl = async () => response(403, `{\n  "error": {\n    "message": "${big(3000, 'q')}"\n  }\n}`);
  const bodies = [];
  for (const run of [
    () => ytApi.getLatestChannelItems('UU1'),
    () => ytApi.getVideoDetails('vid'),
    () => ytApi.resolveChannel('UC1234567890123456789012'),
    () => ytApi.resolveChannel('@Canal'),
    () => twApi.getStreamStatus(['alanzoka']),
  ]) {
    try { await run(); assert.fail('deveria lançar'); }
    catch (err) { bodies.push(err.message); }
  }
  for (const m of bodies) {
    assert.ok(m.length <= 260, `mensagem com ${m.length}`);
    assert.ok(!m.includes('\n'), 'em uma linha');
    assert.match(m, /403/);
  }
});
globalThis.fetch = realFetch;

// ========================================================================================================
console.log('steamHandler (campo os e ecos)');
const steamHtml = (items) => `<strong>Minimum:</strong><br><ul class="bb_ul">${items.map(([k, v]) => `<li><strong>${k}:</strong> ${v}<br></li>`).join('')}</ul>`;
function steamAxios(details, seen = []) {
  return async (url) => {
    seen.push(String(url));
    if (String(url).includes('storesearch')) return { data: { items: [{ id: 10 }] } };
    return { data: { 10: { success: true, data: details } } };
  };
}
await test('os traz só a linha do sistema (antes duplicava o bloco inteiro) e os outros campos continuam extraídos', async () => {
  S.axiosGet = steamAxios({
    name: 'Jogo X', short_description: 'Descrição', developers: ['Dev A'], publishers: ['Pub'], release_date: { date: '1 jan 2026' },
    pc_requirements: {
      minimum: steamHtml([['OS *', 'Windows 10 64-bit'], ['Processor', 'Intel Core i5-2500K'], ['Memory', '8 GB RAM'], ['Graphics', 'NVIDIA GTX 660'], ['Storage', '50 GB available space']]),
      recommended: steamHtml([['OS *', 'Windows 11'], ['Processor', 'Intel Core i7'], ['Memory', '16 GB RAM'], ['Graphics', 'NVIDIA RTX 2060'], ['Storage', '50 GB SSD']]),
    },
  });
  const r = await getSteamGameInfo('jogo x');
  assert.equal(r.success, true);
  const min = r.pcRequirements.minimum;
  assert.equal(min.os, 'OS *: Windows 10 64-bit');
  assert.ok(!/Processor|Memory|Graphics|Storage/.test(min.os), 'os não duplica os outros requisitos');
  assert.equal(min.processor, 'Processor: Intel Core i5-2500K');
  assert.equal(min.memory, 'Memory: 8 GB RAM');
  assert.equal(min.graphics, 'Graphics: NVIDIA GTX 660');
  assert.equal(min.storage, 'Storage: 50 GB available space');
  assert.equal(r.pcRequirements.recommended.os, 'OS *: Windows 11');
});
await test('os em português (SO / Sistema operacional), em blocos com <br> e sem linha de sistema', async () => {
  S.axiosGet = steamAxios({
    name: 'Jogo Y', pc_requirements: {
      minimum: steamHtml([['SO *', 'Windows 10'], ['Processador', 'Intel Core i5'], ['Memória', '8 GB']]),
      recommended: '<strong>Recomendado:</strong><br>Sistema operacional: Windows 11 64-bit<br>Processador: Ryzen 5<br>Memória: 16 GB',
    },
  });
  const r = await getSteamGameInfo('jogo y');
  assert.equal(r.pcRequirements.minimum.os, 'SO *: Windows 10');
  assert.equal(r.pcRequirements.recommended.os, 'Sistema operacional: Windows 11 64-bit');
  S.axiosGet = steamAxios({ name: 'Jogo Z', pc_requirements: { minimum: steamHtml([['Processador', 'Intel Core i5'], ['Os requisitos', 'são estes']]) } });
  const z = await getSteamGameInfo('jogo z');
  assert.equal(z.pcRequirements.minimum.os, null, 'artigo "Os" do português não é rótulo de sistema');
  assert.equal(z.pcRequirements.recommended, null);
});
await test('cada requisito vem com no máximo 160 caracteres (cinco linhas cabem no campo de 1024)', async () => {
  const long = big(3000, 'p');
  S.axiosGet = steamAxios({ name: 'Jogo W', pc_requirements: { minimum: steamHtml([['OS *', long], ['Processor', long], ['Memory', long], ['Graphics', long], ['Storage', long]]) } });
  const r = await getSteamGameInfo('jogo w');
  for (const k of ['os', 'processor', 'memory', 'graphics', 'storage']) assert.ok(r.pcRequirements.minimum[k].length <= 160, `${k} com ${r.pcRequirements.minimum[k].length}`);
  const field = ['os', 'processor', 'memory', 'graphics', 'storage'].map((k) => `**X:** ${r.pcRequirements.minimum[k]}`).join('\n');
  assert.ok(field.length <= 1024, `campo com ${field.length}`);
});
await test('consulta de 6000 caracteres: busca com no máximo 150, eco do erro com 100 e nada de texto do usuário no log', async () => {
  const seen = [];
  S.axiosGet = async (url) => { seen.push(String(url)); return { data: { items: [] } }; };
  S.logs = [];
  const query = `${big(3000, 'a')}SEGREDO${big(3000, 'b')}`;
  const r = await getSteamGameInfo(query);
  const term = new URL(seen[0]).searchParams.get('term');
  assert.ok(term.length <= 150, `termo com ${term.length}`);
  assert.ok(r.error.length < 200, `erro com ${r.error.length}`);
  assert.ok(S.logs.every(([, m]) => !m.includes('SEGREDO') && !m.includes(big(50, 'a'))), 'o texto do usuário não vai para o log');
  assert.ok(S.logs.some(([, m]) => m.includes('6007 caracteres')));
});
await test('erro de rede: mensagem curta (o texto do erro é cortado em 200)', async () => {
  S.axiosGet = async () => { throw new Error(big(5000, 'E')); };
  const r = await getSteamGameInfo('jogo');
  assert.ok(r.error.startsWith('Deu um erro na conexão com a Steam:'));
  assert.ok(r.error.length < 300);
});

// ========================================================================================================
console.log(`\n${passed} ok, ${failed} falhas`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pasta temporária: sobra não atrapalha */ }
process.exit(failed ? 1 : 0);
