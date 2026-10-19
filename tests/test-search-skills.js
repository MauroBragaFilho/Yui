// Testes da busca na web (cadeia de provedores), do system.info, dos comandos cadastrados e das skills.
// Execução: npm run test:search
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-search-'));
process.env.DATABASE_DIR = tmp;
// Auditoria num arquivo temporário (antes de importar os módulos): sem isto os eventos falsos iam para logs/core-audit.jsonl REAL.
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_SEARCH_BUDGET_FILE = path.join(tmp, 'search-budget.json'); // o contador mensal real (secrets/) nunca é tocado
process.env.LOG_LEVEL = 'error'; // os módulos de busca usam o logger real: nada de poluir logs/ com linhas de teste
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
process.env.YUI_READ_ONLY = 'false';
process.env.YUI_TOOLS_PC_ENABLED = 'true';
process.env.YUI_FILE_ROOTS = '';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const { searchWeb, activeProviders, resetCooldowns, keyOf } = await import('../src/search/providers.js');
const { createBudget, monthlyCap, userLimitPerHour, globalLimitPerHour } = await import('../src/search/budget.js');
const { buildIntegrations } = await import('../src/core/api/integrations.js');
const { parseResults: parseDuckDuckGo } = await import('../src/core/dev/web-search.js');
const { buildContext } = await import('../src/core/permissions.js');
const ai = await import('../src/core/ai/manager.js');
const { runAgent, resolvePending } = await import('../src/core/agent/agent.js');
const tools = await import('../src/core/agent/tools.js');
const { loadSkills, getSkill } = await import('../src/core/skills.js');
// por último: o módulo carrega o .env (dotenv) ao ser importado e isso não pode mexer nas variáveis acima
const searchManager = await import('../src/handlers/searchManager.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const quiet = { info() {}, warn() {}, error() {} };
// O teto GLOBAL por hora (padrão 20) é do processo todo: sem desligá-lo aqui, as dezenas de buscas destes testes (que usam o orçamento
// padrão) estourariam o teto. Os testes do teto global usam `createBudget` próprio e o `env` explícito.
const search = (q, o = {}) => searchWeb(q, { logger: quiet, ...o, env: { YUI_SEARCH_GLOBAL_PER_HOUR: '0', ...(o.env ?? process.env) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Busca na web');
await test('sem chaves: DuckDuckGo e Bing (último recurso); com chaves: Brave e Tavily vêm antes', () => {
  assert.deepEqual(activeProviders({}), ['duckduckgo', 'bing']);
  assert.deepEqual(activeProviders({ BRAVE_API_KEY: 'k'.repeat(12), TAVILY_API_KEY: 't'.repeat(12), SEARXNG_URL: 'http://127.0.0.1:8080' }), ['brave', 'tavily', 'searxng', 'duckduckgo', 'bing']);
  assert.deepEqual(activeProviders({ YUI_SEARCH_PROVIDERS: 'searxng,duckduckgo', SEARXNG_URL: 'http://x:1' }), ['searxng', 'duckduckgo']);
  assert.deepEqual(activeProviders({ YUI_SEARCH_PROVIDERS: 'brave', BRAVE_API_KEY: 'curta' }), [], 'chave curta demais não conta');
});

await test('Brave: usa a API, manda a chave no cabeçalho e normaliza o resultado', async () => {
  resetCooldowns();
  const calls = [];
  const fetchImpl = async (url, opt) => { calls.push({ url, opt }); return json({ web: { results: [{ title: 'Yui', url: 'https://a.com/x', description: 'desc' }] } }); };
  const r = await search('gta online', { env: { BRAVE_API_KEY: 'brave-key-123456' }, fetchImpl });
  assert.equal(r.provider, 'brave');
  assert.deepEqual(r.results, [{ title: 'Yui', url: 'https://a.com/x', snippet: 'desc' }]);
  assert.equal(calls[0].opt.headers['X-Subscription-Token'], 'brave-key-123456');
  assert.ok(calls[0].url.includes('q=gta%20online'));
});

await test('cota esgotada (429) passa para o próximo e o provedor descansa', async () => {
  resetCooldowns();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('brave')) return json({}, 429);
    if (url.includes('tavily')) return json({ results: [{ title: 'T', url: 'https://t.com/a', content: 'conteúdo' }] });
    throw new Error('inesperado');
  };
  const env = { BRAVE_API_KEY: 'brave-key-123456', TAVILY_API_KEY: 'tavily-key-123456' };
  const a = await search('x', { env, fetchImpl });
  assert.equal(a.provider, 'tavily');
  assert.ok(a.errors[0].startsWith('brave: HTTP 429'));
  seen.length = 0;
  const b = await search('x', { env, fetchImpl });
  assert.equal(b.provider, 'tavily');
  assert.ok(!seen.some((u) => u.includes('brave')), 'Brave descansa e não é chamado de novo');
});

await test('SearXNG: lê o JSON do servidor próprio', async () => {
  resetCooldowns();
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('http://127.0.0.1:8080/search?q=') && url.includes('format=json'));
    return json({ results: [{ title: 'S', url: 'https://s.com/p', content: 'trecho' }, { title: 'S2', url: 'https://s.com/q', content: 'outro' }] });
  };
  const r = await search('teste', { max: 1, env: { SEARXNG_URL: 'http://127.0.0.1:8080/' }, fetchImpl });
  assert.equal(r.provider, 'searxng');
  assert.equal(r.results.length, 1);
});

await test('DuckDuckGo (HTML) é decodificado e o Bing só entra se nada mais der resultado', async () => {
  resetCooldowns();
  const ddg = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fa">Título</a><a class="result__snippet">Resumo</a></div>';
  let bingCalled = false;
  const r1 = await search('q', { env: {}, fetchImpl: async (u) => { if (u.includes('bing')) bingCalled = true; return json(ddg); } });
  assert.equal(r1.provider, 'duckduckgo');
  assert.equal(r1.results[0].url, 'https://exemplo.com/a');
  assert.equal(bingCalled, false);
  const bing = '<ol><li class="b_algo"><h2>Achei</h2><a href="https://b.com/p">l</a><div class="b_caption"><p>texto</p></div></li></ol>';
  const r2 = await search('q', { env: {}, fetchImpl: async (u) => (u.includes('duckduckgo') ? json('<html></html>') : json(bing)) });
  assert.equal(r2.provider, 'bing');
  assert.equal(r2.results[0].url, 'https://b.com/p');
});

await test('tudo falhando devolve vazio com os motivos (sem lançar erro)', async () => {
  resetCooldowns();
  const r = await search('q', { env: {}, fetchImpl: async () => { throw new Error('rede caiu'); } });
  assert.equal(r.provider, null);
  assert.deepEqual(r.results, []);
  assert.equal(r.errors.length, 2);
  assert.deepEqual((await search('   ', { env: {} })).results, []);
});

console.log('Busca na web: robustez (R3)');
const BING_OK = '<ol><li class="b_algo"><h2>Achei</h2><a href="https://b.com/p">l</a><div class="b_caption"><p>texto</p></div></li></ol>';
const DDG_OK = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fa">Título</a><a class="result__snippet">Resumo</a></div>';
const isDdg = (u) => u.includes('duckduckgo');

await test('chave "opcional" (texto-modelo, 8 caracteres) não ativa a Brave e o painel concorda', () => {
  assert.equal(keyOf({ BRAVE_API_KEY: 'opcional' }, 'BRAVE_API_KEY'), '');
  assert.deepEqual(activeProviders({ BRAVE_API_KEY: 'opcional', TAVILY_API_KEY: 'opcional', SEARXNG_URL: 'opcional' }), ['duckduckgo', 'bing']);
  const items = (env) => Object.fromEntries(buildIntegrations({ env }).groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  const a = items({ BRAVE_API_KEY: 'opcional', TAVILY_API_KEY: 'opcional', SEARXNG_URL: 'opcional' });
  assert.equal(a.brave.status, 'missing');
  assert.equal(a.tavily.status, 'off');
  assert.equal(a.searxng.status, 'off');
  assert.ok(![a.brave, a.tavily, a.searxng].some((i) => /configurad/.test(i.detail)), 'não pode dizer "configurada" para texto-modelo');
  const b = items({ BRAVE_API_KEY: 'brave-key-123456', TAVILY_API_KEY: 'tavily-key-123456', SEARXNG_URL: 'http://127.0.0.1:8080' });
  assert.deepEqual([b.brave.status, b.tavily.status, b.searxng.status], ['ok', 'ok', 'ok']);
  assert.deepEqual(items({}).brave, { key: 'brave', name: 'Busca na web (Brave)', status: 'missing', detail: 'sem chave: usa as outras fontes' });
  const c = items({ BRAVE_API_KEY: 'brave-key-123456', YUI_SEARCH_PROVIDERS: 'tavily,duckduckgo' });
  assert.equal(c.brave.status, 'off');
  assert.ok(c.brave.detail.includes('YUI_SEARCH_PROVIDERS'));
  assert.ok(!JSON.stringify(b).includes('brave-key-123456'), 'o painel nunca mostra o valor da chave');
});

await test('Brave: a consulta usa search_lang=pt-br', async () => {
  resetCooldowns();
  let seen = '';
  await search('gta', { env: { BRAVE_API_KEY: 'brave-key-123456' }, fetchImpl: async (u) => { seen = u; return json({ web: { results: [{ title: 'a', url: 'https://a.com/x' }] } }); } });
  assert.ok(seen.includes('search_lang=pt-br'), seen);
  assert.ok(!/search_lang=pt(&|$)/.test(seen));
});

await test('DuckDuckGo 202 = bloqueio leve: descansa 1, 2, 4 min, cai para o Bing e não é chamado durante o descanso', async () => {
  resetCooldowns();
  let t = 10_000_000;
  const now = () => t;
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(isDdg(u) ? 'ddg' : 'bing');
    return isDdg(u) ? json('', 202) : json(BING_OK);
  };
  const ddgCalls = () => calls.filter((c) => c === 'ddg').length;
  const r1 = await search('q', { env: {}, fetchImpl, now });
  assert.equal(r1.provider, 'bing');
  assert.ok(r1.errors[0].startsWith('duckduckgo: bloqueio leve'), r1.errors[0]);
  assert.equal(ddgCalls(), 1);
  t += 30_000;
  const r2 = await search('q', { env: {}, fetchImpl, now });
  assert.equal(r2.provider, 'bing');
  assert.equal(ddgCalls(), 1, 'durante o descanso o DuckDuckGo não é chamado de novo');
  assert.ok(r2.errors.includes('duckduckgo: descansando'));
  t += 31_000; // 61 s depois da 1ª falha: passou o 1º descanso (1 min)
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls(), 2);
  t += 119_000; // o 2º descanso é de 2 min
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls(), 2);
  t += 2_000;
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls(), 3);
  t += 239_000; // o 3º descanso é de 4 min
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls(), 3);
  t += 2_000;
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls(), 4);
});

await test('DuckDuckGo: sucesso zera o recuo; página "anomaly", resposta sem marcação e 403/429 também são bloqueio', async () => {
  resetCooldowns();
  let t = 20_000_000;
  const now = () => t;
  let ddgBody = '<div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>';
  let ddgStatus = 200;
  let ddgCalls = 0;
  const fetchImpl = async (u) => { if (isDdg(u)) { ddgCalls++; return json(ddgBody, ddgStatus); } return json(BING_OK); };
  const a = await search('q', { env: {}, fetchImpl, now });
  assert.equal(a.provider, 'bing');
  assert.ok(a.errors[0].includes('bloqueio leve'));
  t += 61_000;
  ddgBody = '<html><body>nada</body></html>'; // sem resultados e sem marcação de busca
  const b = await search('q', { env: {}, fetchImpl, now });
  assert.ok(b.errors[0].includes('bloqueio leve'), b.errors[0]);
  assert.equal(ddgCalls, 2);
  t += 121_000;
  ddgBody = DDG_OK;
  const c = await search('q', { env: {}, fetchImpl, now });
  assert.equal(c.provider, 'duckduckgo', 'voltou a responder');
  ddgBody = '<html></html>';
  const d = await search('q', { env: {}, fetchImpl, now });
  assert.ok(d.errors[0].includes('bloqueio leve'));
  t += 61_000; // o recuo recomeçou em 1 min (o sucesso zerou a contagem)
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls, 5);
  for (const status of [403, 429]) {
    resetCooldowns();
    ddgStatus = status;
    ddgBody = '';
    const before = ddgCalls;
    await search('q', { env: {}, fetchImpl, now });
    await search('q', { env: {}, fetchImpl, now });
    assert.equal(ddgCalls, before + 1, `HTTP ${status} no DuckDuckGo descansa`);
  }
});

await test('DuckDuckGo: página de busca legítima sem resultados NÃO é bloqueio (sem descanso)', async () => {
  resetCooldowns();
  let ddgCalls = 0;
  const fetchImpl = async (u) => { if (isDdg(u)) { ddgCalls++; return json('<div class="no-results">Nenhum resultado.</div>'); } return json(BING_OK); };
  const r = await search('q', { env: {}, fetchImpl });
  assert.equal(r.provider, 'bing');
  assert.ok(r.errors.includes('duckduckgo: sem resultados'));
  await search('q', { env: {}, fetchImpl });
  assert.equal(ddgCalls, 2, 'sem resultados não faz o provedor descansar');
});

await test('429 com Retry-After é respeitado (DuckDuckGo) e X-RateLimit-Reset da Brave também', async () => {
  resetCooldowns();
  let t = 30_000_000;
  const now = () => t;
  let ddgCalls = 0;
  const fetchImpl = async (u) => { if (isDdg(u)) { ddgCalls++; return json('', 429, { 'retry-after': '120' }); } return json(BING_OK); };
  await search('q', { env: {}, fetchImpl, now });
  t += 119_000;
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls, 1);
  t += 2_000;
  await search('q', { env: {}, fetchImpl, now });
  assert.equal(ddgCalls, 2);

  resetCooldowns();
  let braveCalls = 0;
  const brave = async (u) => { if (u.includes('brave')) { braveCalls++; return json({ error: { code: 'RATE_LIMITED' } }, 429, { 'x-ratelimit-reset': '1, 2592000' }); } return json(DDG_OK); };
  const env = { BRAVE_API_KEY: 'brave-key-123456' };
  await search('q', { env, fetchImpl: brave, now });
  t += 500;
  await search('q', { env, fetchImpl: brave, now });
  assert.equal(braveCalls, 1, 'dentro de 1 s ainda descansa');
  t += 1_500;
  await search('q', { env, fetchImpl: brave, now });
  assert.equal(braveCalls, 2, 'limite de taxa: descanso curto (usa o menor valor do cabeçalho)');
});

await test('Brave 429 com corpo realista: "rate limit exceeded for plan" descansa ~1 s (não 24 h); QUOTA_LIMITED descansa muito', async () => {
  const env = { BRAVE_API_KEY: 'brave-key-123456' };
  const realisticRate = { type: 'ErrorResponse', error: { id: 'abc', status: 429, code: 'RATE_LIMITED', detail: 'Request rate limit exceeded for plan', meta: { plan: 'Free', rate_limit: 1, rate_current: 1, quota_limit: 2000, quota_current: 10, component: 'rate_limiter' } } };
  const realisticQuota = { type: 'ErrorResponse', error: { id: 'abc', status: 429, code: 'QUOTA_LIMITED', detail: 'Request quota limit exceeded for plan', meta: { plan: 'Free', quota_limit: 2000, quota_current: 2000, component: 'quota_limiter' } } };
  const headers = { 'x-ratelimit-reset': '1, 1419704' };
  for (const [label, body, longRest] of [['RATE_LIMITED', realisticRate, false], ['QUOTA_LIMITED', realisticQuota, true], ['texto sem código (taxa)', 'Request rate limit exceeded for plan', false], ['texto sem código (cota)', 'Request quota limit exceeded for plan', true]]) {
    resetCooldowns();
    let t = 50_000_000;
    const now = () => t;
    let calls = 0;
    const fetchImpl = async (u) => { if (u.includes('brave')) { calls++; return json(body, 429, headers); } return json(DDG_OK); };
    await search('q', { env, fetchImpl, now });
    t += 500;
    await search('q', { env, fetchImpl, now });
    assert.equal(calls, 1, `${label}: dentro de 1 s ainda descansa`);
    t += 2 * 60 * 60_000; // 2 h depois
    await search('q', { env, fetchImpl, now });
    assert.equal(calls, longRest ? 1 : 2, `${label}: depois de 2 h ${longRest ? 'ainda descansa (cota)' : 'volta a ser tentada (taxa)'}`);
  }
});

await test('Tavily 432/433 (limite de plano/PayGo) e 429 de cota descansam por muito mais tempo que um 429 comum', async () => {
  const env = { TAVILY_API_KEY: 'tavily-key-123456' };
  for (const [status, body, longRest] of [[432, {}, true], [433, {}, true], [402, {}, true], [429, {}, false], [429, { error: { code: 'QUOTA_LIMITED' } }, true]]) {
    resetCooldowns();
    let t = 40_000_000;
    const now = () => t;
    let calls = 0;
    const fetchImpl = async (u) => { if (u.includes('tavily')) { calls++; return json(body, status); } return json(DDG_OK); };
    const first = await search('q', { env, fetchImpl, now });
    assert.equal(first.provider, 'duckduckgo');
    assert.ok(first.errors[0].startsWith(`tavily: HTTP ${status}`));
    t += 5 * 60_000;
    await search('q', { env, fetchImpl, now });
    assert.equal(calls, longRest ? 1 : 2, `HTTP ${status} ${JSON.stringify(body)}: depois de 5 min`);
    t += 61 * 60_000;
    await search('q', { env, fetchImpl, now });
    assert.equal(calls, longRest ? 2 : 3, `HTTP ${status}: depois de 66 min o provedor volta a ser tentado`);
  }
});

await test('corpo que goteja (servidor real, fetch real) estoura o prazo do provedor e a cadeia segue para o Bing', async () => {
  resetCooldowns();
  const drip = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const timer = setInterval(() => res.write(' '), 40);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => drip.listen(0, '127.0.0.1', r));
  try {
    const fetchImpl = (u, opt) => (isDdg(u) ? fetch(`http://127.0.0.1:${drip.address().port}/`, opt) : Promise.resolve(json(BING_OK)));
    const started = Date.now();
    const r = await search('q', { env: {}, fetchImpl, providerTimeoutMs: 300 });
    assert.equal(r.provider, 'bing');
    assert.equal(r.errors[0], 'duckduckgo: tempo esgotado');
    assert.ok(Date.now() - started < 3000);
  } finally {
    drip.closeAllConnections();
    drip.close();
  }
});

await test('corpo grande demais (acima de 2 MB) é recusado em vez de lido inteiro', async () => {
  resetCooldowns();
  const fetchImpl = async (u) => (isDdg(u) ? new Response('x'.repeat(2.5 * 1024 * 1024), { status: 200 }) : json(BING_OK));
  const r = await search('q', { env: {}, fetchImpl });
  assert.equal(r.provider, 'bing');
  assert.equal(r.errors[0], 'duckduckgo: resposta grande demais');
});

await test('prazo global da cadeia: provedores lentos não passam do prazo e o sinal é compartilhado', async () => {
  resetCooldowns();
  const calls = [];
  const hang = (u, opt) => new Promise((_, reject) => { calls.push(u); opt.signal.addEventListener('abort', () => reject(opt.signal.reason), { once: true }); });
  const started = Date.now();
  const r = await search('q', { env: {}, fetchImpl: hang, deadlineMs: 500, providerTimeoutMs: 60_000 });
  const ms = Date.now() - started;
  assert.ok(ms >= 450 && ms < 2000, `demorou ${ms} ms`);
  assert.equal(r.provider, null);
  assert.deepEqual(r.results, []);
  assert.equal(calls.length, 1, 'esgotado o prazo, o provedor seguinte nem é chamado');
  assert.ok(r.errors.includes('prazo total esgotado'), r.errors.join('|'));
  assert.ok(r.errors[0].startsWith('duckduckgo: tempo esgotado'));
  // cancelamento externo
  resetCooldowns();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  const c = await search('q', { env: {}, fetchImpl: hang, signal: ctl.signal });
  assert.equal(c.provider, null);
  assert.ok(c.errors.includes('cancelado'), c.errors.join('|'));
});

await test('consulta sensível (sensitive: true) NÃO é pesquisada e não gasta cota', async () => {
  resetCooldowns();
  let calls = 0;
  const budget = createBudget({ filePath: path.join(tmp, 'sens.json') });
  const r = await search('meu cpf e minha senha', { env: { YUI_SEARCH_USER_PER_HOUR: '1' }, fetchImpl: async () => { calls++; return json(DDG_OK); }, sensitive: true, userId: 'u', budget });
  assert.deepEqual(r, { provider: null, results: [], errors: ['sensitive'] });
  assert.equal(calls, 0);
  const ok = await search('clima', { env: { YUI_SEARCH_USER_PER_HOUR: '1' }, fetchImpl: async () => json(DDG_OK), userId: 'u', budget });
  assert.equal(ok.provider, 'duckduckgo', 'a cota do usuário continuava intacta');
});

await test('limite por usuário: 5 por hora por padrão, configurável, 0 = sem limite, por usuário', async () => {
  resetCooldowns();
  let t = 50_000_000;
  const now = () => t;
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(DDG_OK); };
  assert.equal(userLimitPerHour({}), 5);
  assert.equal(userLimitPerHour({ YUI_SEARCH_USER_PER_HOUR: '0' }), 0);
  assert.equal(userLimitPerHour({ YUI_SEARCH_USER_PER_HOUR: 'abc' }), 5);
  const budget = createBudget({ filePath: path.join(tmp, 'users.json'), now });
  const env = { YUI_SEARCH_USER_PER_HOUR: '2' };
  assert.equal((await search('a1', { env, fetchImpl, userId: 'u1', budget, now })).provider, 'duckduckgo');
  t += 1000;
  assert.equal((await search('a2', { env, fetchImpl, userId: 'u1', budget, now })).provider, 'duckduckgo');
  t += 1000;
  const blocked = await search('a3', { env, fetchImpl, userId: 'u1', budget, now });
  assert.equal(blocked.provider, null);
  assert.deepEqual(blocked.results, []);
  assert.equal(blocked.limited, 'user');
  assert.ok(blocked.retryAfterMs > 3_500_000 && blocked.retryAfterMs <= 3_600_000);
  assert.equal(calls, 2, 'o limite vale ANTES de chamar o provedor');
  assert.equal((await search('a4', { env, fetchImpl, userId: 'u2', budget, now })).provider, 'duckduckgo', 'outro usuário não é afetado');
  assert.equal((await search('a5', { env, fetchImpl, budget, now })).provider, 'duckduckgo', 'sem userId não há limite por usuário');
  t += 3_600_000;
  assert.equal((await search('a6', { env, fetchImpl, userId: 'u1', budget, now })).provider, 'duckduckgo', 'passou 1 hora');
  const free = { YUI_SEARCH_USER_PER_HOUR: '0' };
  for (let i = 0; i < 12; i++) assert.equal((await search(`livre${i}`, { env: free, fetchImpl, userId: 'u3', budget, now })).provider, 'duckduckgo');
  // padrão: 5 por hora
  for (let i = 0; i < 5; i++) assert.equal((await search(`pad${i}`, { env: {}, fetchImpl, userId: 'u4', budget, now })).provider, 'duckduckgo');
  assert.equal((await search('pad5', { env: {}, fetchImpl, userId: 'u4', budget, now })).limited, 'user');
});

await test('teto mensal por provedor: o provedor é pulado ao atingir o teto e o contador sobrevive ao reinício', async () => {
  resetCooldowns();
  let t = Date.UTC(2026, 9, 14, 12, 0, 0);
  const now = () => t;
  const file = path.join(tmp, 'cap', 'search-budget.json'); // a pasta não existe: é criada
  const env = { TAVILY_API_KEY: 'tavily-key-123456', YUI_SEARCH_MONTHLY_CAP_TAVILY: '2', YUI_SEARCH_USER_PER_HOUR: '0' };
  const hits = [];
  const fetchImpl = async (u) => { hits.push(u.includes('tavily') ? 'tavily' : 'ddg'); return u.includes('tavily') ? json({ results: [{ title: 'T', url: 'https://t.com/a', content: 'c' }] }) : json(DDG_OK); };
  assert.equal(monthlyCap('tavily', {}), 900);
  assert.equal(monthlyCap('brave', {}), 900);
  assert.equal(monthlyCap('duckduckgo', {}), 0);
  assert.equal(monthlyCap('brave', { YUI_SEARCH_MONTHLY_CAP_BRAVE: '0' }), 0);
  let budget = createBudget({ filePath: file, now });
  assert.equal((await search('c1', { env, fetchImpl, budget, now })).provider, 'tavily');
  assert.equal((await search('c2', { env, fetchImpl, budget, now })).provider, 'tavily');
  const third = await search('c3', { env, fetchImpl, budget, now });
  assert.equal(third.provider, 'duckduckgo');
  assert.ok(third.errors.includes('tavily: cota mensal atingida'));
  assert.deepEqual(hits, ['tavily', 'tavily', 'ddg'], 'o Tavily nem foi chamado na 3ª vez');
  // "reinício": outro objeto lendo o mesmo arquivo
  budget = createBudget({ filePath: file, now });
  assert.equal(budget.used('tavily'), 2);
  assert.equal((await search('c4', { env, fetchImpl, budget, now })).provider, 'duckduckgo');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.months['2026-10'].tavily, 2);
  assert.ok(saved.months['2026-10'].duckduckgo >= 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'escrita atômica não deixa arquivo temporário');
  // outro mês: contador novo
  t = Date.UTC(2026, 10, 2, 12, 0, 0);
  assert.equal((await search('c5', { env, fetchImpl, budget, now })).provider, 'tavily');
  assert.equal(budget.used('tavily'), 1);
  // teto 0 = sem teto
  const free = { ...env, YUI_SEARCH_MONTHLY_CAP_TAVILY: '0' };
  for (let i = 0; i < 4; i++) assert.equal((await search(`livre${i}`, { env: free, fetchImpl, budget, now })).provider, 'tavily');
});

await test('falha de disco ou arquivo corrompido não derruba a busca', async () => {
  resetCooldowns();
  const notDir = path.join(tmp, 'arquivo-comum.txt');
  fs.writeFileSync(notDir, 'x');
  const broken = createBudget({ filePath: path.join(notDir, 'sub', 'b.json') }); // a "pasta" é um arquivo: gravar falha
  const env = { YUI_SEARCH_USER_PER_HOUR: '0' };
  assert.equal((await search('d1', { env, fetchImpl: async () => json(DDG_OK), budget: broken })).provider, 'duckduckgo');
  assert.equal(broken.used('duckduckgo'), 1, 'o contador continua valendo em memória');
  const corrupt = path.join(tmp, 'corrompido.json');
  fs.writeFileSync(corrupt, '{ isso não é json');
  const b = createBudget({ filePath: corrupt });
  assert.equal(b.used('tavily'), 0);
  assert.equal(b.recordProvider('tavily'), 1);
  assert.equal(JSON.parse(fs.readFileSync(corrupt, 'utf8')).version, 1, 'o arquivo foi reescrito');
});

await test('buscas idênticas e simultâneas compartilham uma única chamada; cache é opcional e nunca guarda a Brave', async () => {
  resetCooldowns();
  const budget = createBudget({ filePath: path.join(tmp, 'dedupe.json') });
  let calls = 0;
  const slow = async () => { calls++; await sleep(60); return json(DDG_OK); };
  const [a, b] = await Promise.all([search('mesma consulta', { env: {}, fetchImpl: slow, budget }), search('Mesma  Consulta', { env: {}, fetchImpl: slow, budget })]);
  assert.equal(calls, 1);
  assert.equal(a.provider, 'duckduckgo');
  assert.deepEqual(a.results, b.results);
  assert.notEqual(a.results, b.results, 'cada chamador recebe a sua cópia');
  // sem TTL (padrão): cada busca vai ao provedor
  await search('mesma consulta', { env: {}, fetchImpl: slow, budget });
  assert.equal(calls, 2);
  // com TTL: acerto, expiração e normalização
  resetCooldowns();
  let t = 60_000_000;
  const now = () => t;
  calls = 0;
  const env = { YUI_SEARCH_CACHE_TTL_MIN: '5' };
  const fast = async () => { calls++; return json(DDG_OK); };
  await search('Consulta  X', { env, fetchImpl: fast, budget, now });
  const hit = await search('consulta x', { env, fetchImpl: fast, budget, now });
  assert.equal(calls, 1);
  assert.equal(hit.cached, true);
  assert.equal(hit.results.length, 1);
  t += 6 * 60_000;
  await search('consulta x', { env, fetchImpl: fast, budget, now });
  assert.equal(calls, 2, 'TTL expirado');
  // Brave: nunca em cache (Termos de Uso de 1/set/2026)
  resetCooldowns();
  calls = 0;
  const braveEnv = { YUI_SEARCH_CACHE_TTL_MIN: '5', BRAVE_API_KEY: 'brave-key-123456' };
  const braveFetch = async () => { calls++; return json({ web: { results: [{ title: 'a', url: 'https://a.com/x' }] } }); };
  await search('b1', { env: braveEnv, fetchImpl: braveFetch, budget, now });
  await search('b1', { env: braveEnv, fetchImpl: braveFetch, budget, now });
  assert.equal(calls, 2);
});

await test('anúncios do DuckDuckGo (result--ad e links duckduckgo.com/y.js) são ignorados', async () => {
  const html = `<div class="result results_links result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad_domain=loja.com&u3=https%3A%2F%2Floja.com%2Fx">Anúncio</a><a class="result__snippet">compre já</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Forg.com%2Fa%3Fx%3D%2520">Orgânico</a><a class="result__snippet">ok</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?x=1">Sem classe de anúncio</a><a class="result__snippet">y.js</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1">Anúncio por redirecionamento</a></div>`;
  assert.deepEqual(parseDuckDuckGo(html).map((r) => r.url), ['https://org.com/a?x=%20'], 'o valor de uddg é decodificado uma só vez');
  resetCooldowns();
  const r = await search('q', { env: {}, fetchImpl: async (u) => (isDdg(u) ? json(html) : json(BING_OK)) });
  assert.equal(r.provider, 'duckduckgo');
  assert.deepEqual(r.results.map((x) => x.url), ['https://org.com/a?x=%20']);
  // só anúncios: é uma página de busca de verdade sem resultados orgânicos (cai para o Bing, sem bloqueio)
  resetCooldowns();
  const onlyAds = '<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/y.js?x=1">Anúncio</a></div>';
  const o = await search('q', { env: {}, fetchImpl: async (u) => (isDdg(u) ? json(onlyAds) : json(BING_OK)) });
  assert.equal(o.provider, 'bing');
  assert.equal(o.errors[0], 'duckduckgo: sem resultados');
});

await test('o log de cada busca não leva o texto da consulta nem segredos', async () => {
  resetCooldowns();
  const lines = [];
  const cap = { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  const secret = 'segredo-unico-xyz maçã';
  await searchWeb(secret, { env: {}, fetchImpl: async () => json(DDG_OK), logger: cap });
  assert.ok(lines.some(([lv, m]) => lv === 'info' && /^\[Search\] provider=duckduckgo status=200 ms=\d+ results=1$/.test(m)), JSON.stringify(lines));
  resetCooldowns();
  lines.length = 0;
  const r = await searchWeb(secret, { env: {}, fetchImpl: async (u) => { if (isDdg(u)) throw new Error(`falha em ${u}`); return json('<html></html>'); }, logger: cap });
  assert.deepEqual(r.results, []);
  assert.ok(lines.some(([lv]) => lv === 'warn'));
  const text = JSON.stringify(lines) + JSON.stringify(r.errors);
  assert.ok(!text.includes('segredo-unico-xyz') && !text.includes(encodeURIComponent('segredo-unico-xyz')), text);
  assert.ok(r.errors[0].includes('[consulta]'));
});

console.log('smartSearch (searchManager)');
const { smartSearch, smartSearchDetailed, analyzeSearchIntent, optimizeQuery, classifySearchOutcome, createWebContextMemo, searchForAgent, hasSearchTrigger, rankAndFilterResults, isBlacklisted } = searchManager;
const noWeb = async () => ({ provider: null, results: [], errors: ['x'] });

await test('gate por palavras inteiras: "como vai você?", "qual é seu nome?", "eu como pão" NÃO disparam; "pesquise sobre X" dispara', async () => {
  for (const text of ['como vai você?', 'qual é seu nome?', 'eu como pão', 'a qualidade ficou ótima', 'quem é você', 'quanto custa um carro', 'check this', 'pesquisei ontem', 'a pesquisadora chegou', 'research']) {
    assert.equal(hasSearchTrigger(text), false, text);
    let asked = 0;
    assert.equal(await smartSearch(text, async () => { asked++; return { text: 'SIM: x' }; }, { searchImpl: noWeb }), null);
    assert.equal(asked, 0, `"${text}" não pode gastar a chamada do otimizador`);
  }
  for (const text of ['pesquise sobre X', 'Busque notícias de Y', 'PROCURE o preço do dólar', 'por favor, pesquisa isso', 'me ajuda a buscar um carro', 'google isso', 'consulte a wiki', 'verifique se é verdade', 'faça uma pesquisa: gta', 'search for gta']) {
    assert.equal(hasSearchTrigger(text), true, text);
  }
  let asked = 0;
  await smartSearch('pesquise sobre carros do GTA', async () => { asked++; return { text: 'NAO' }; }, { searchImpl: noWeb });
  assert.equal(asked, 1);
});

await test('o ano do otimizador é o ano corrente, não um 2026 fixo; userId e sensitive chegam à busca', async () => {
  let optimizerPrompt = '';
  const seen = [];
  const providerFunc = async (p) => { optimizerPrompt = p; return { text: 'SIM: gta online carros' }; };
  const searchImpl = async (q, o) => { seen.push({ q, ...o }); return { provider: null, results: [], errors: [] }; };
  await smartSearch('pesquise carros do gta', providerFunc, { userId: 'u9', searchImpl, now: () => Date.UTC(2031, 5, 1) });
  assert.ok(optimizerPrompt.includes('(2031)') && !optimizerPrompt.includes('(2026)'));
  assert.deepEqual(seen, [{ q: 'gta online carros', max: 8, userId: 'u9', sensitive: false }]);
  // sensitive: nem o otimizador nem a busca rodam
  seen.length = 0;
  let asked = 0;
  assert.equal(await smartSearch('pesquise meus exames', async () => { asked++; return { text: 'SIM: x' }; }, { sensitive: true, userId: 'u9', searchImpl }), null);
  assert.equal(asked, 0);
  assert.equal(seen.length, 0);
});

await test('pergunta enorme: o otimizador recebe só os 500 primeiros caracteres (TG-23), mas o gatilho vale para o texto todo', async () => {
  const longa = `pesquise carros do gta ${'blá '.repeat(3000)}`;
  let optimizerPrompt = '';
  await smartSearch(longa, async (p) => { optimizerPrompt = p; return { text: 'NAO' }; }, { searchImpl: noWeb });
  assert.ok(optimizerPrompt.length > 0 && optimizerPrompt.length < 2000, `prompt do otimizador: ${optimizerPrompt.length}`);
  assert.ok(optimizerPrompt.includes(`ENTRADA: "${longa.slice(0, 500)}"`));
  let asked = 0;
  await smartSearch(`${'blá '.repeat(400)}pesquise carros`, async () => { asked++; return { text: 'NAO' }; }, { searchImpl: noWeb });
  assert.equal(asked, 1, 'gatilho depois dos 500 primeiros caracteres ainda conta');
});

await test('lista negra: por domínio (host), no ranking E no fallback bruto', async () => {
  assert.equal(isBlacklisted('https://m.facebook.com/x'), true);
  assert.equal(isBlacklisted('https://facebook.com/x'), true);
  assert.equal(isBlacklisted('https://notfacebook.com/x'), false);
  assert.equal(isBlacklisted('https://exemplo.com/?ref=facebook.com'), false);
  assert.equal(isBlacklisted('#quick-answer'), false);
  assert.deepEqual(rankAndFilterResults([{ title: 'gta online carros', link: 'https://www.facebook.com/gta-online-carros', snippet: 'gta online carros', score: 0 }], 'gta online carros'), []);

  const raw = [
    { url: 'https://www.facebook.com/post/1', title: 'zzz', snippet: 'aaa' },
    { url: 'https://www.instagram.com/p/2', title: 'yyy', snippet: 'bbb' },
    { url: 'https://exemplo.com/a/b/c', title: 'www', snippet: 'ccc' },
  ];
  const read = [];
  const readPage = async (url) => { read.push(url); return `texto da página ${url}`; };
  // o filtro de relevância remove tudo (nenhuma palavra da consulta aparece) => cai no fallback bruto
  const out = await smartSearch('pesquise carros', async () => ({ text: 'SIM: gta online carros' }), { searchImpl: async () => ({ provider: 'x', results: raw, errors: [] }), readPage });
  assert.deepEqual(read, ['https://exemplo.com/a/b/c'], 'facebook e instagram não são lidos nem no fallback');
  assert.ok(out.startsWith('[DADOS EXTERNOS NÃO CONFIÁVEIS'), 'o contexto da web sai marcado como dado não confiável');
  assert.ok(out.includes('https://exemplo.com/a/b/c') && !out.includes('facebook') && !out.includes('instagram'));
  // tudo na lista negra: sem contexto
  const none = await smartSearch('pesquise carros', async () => ({ text: 'SIM: gta online carros' }), { searchImpl: async () => ({ provider: 'x', results: raw.slice(0, 2), errors: [] }), readPage });
  assert.equal(none, null);
  // página que não pôde ser lida cai no resumo do buscador
  const fallbackSummary = await smartSearch('pesquise carros', async () => ({ text: 'SIM: gta online carros' }), { searchImpl: async () => ({ provider: 'x', results: [{ url: 'https://wiki.org/gta-online-carros', title: 'GTA Online carros', snippet: 'lista de carros' }], errors: [] }), readPage: async () => null });
  assert.ok(fallbackSummary.includes('Site bloqueado/erro') && fallbackSummary.includes('lista de carros'));
});

// ---------------------------------------------------------------------------------------------
// Agente de pesquisa, Pacote 3: otimizador de busca limpo e isolado, contexto reaproveitado, motivo da falha, teto global por hora
// ---------------------------------------------------------------------------------------------
console.log('Otimizador de busca: entrada limpa, sem ferramentas nem histórico, saída validada');
const spyLog = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
};
const okFound = () => ({ provider: 'x', results: [{ url: 'https://wiki.org/gta-online-carros', title: 'GTA Online carros', snippet: 'lista de carros' }], errors: [] });
const noPage = async () => null;
const intent = (prompt, text, extra = {}) => analyzeSearchIntent(prompt, typeof text === 'function' ? text : async () => ({ text }), { logger: quiet, ...extra });
const entradaDoOtimizador = (p) => /ENTRADA: "([\s\S]*)"\nREGRAS:/.exec(p)?.[1];

await test('o otimizador roda SEM ferramentas e SEM histórico, só com a pergunta limpa (sem menção, emoji, código nem link)', async () => {
  const calls = [];
  const provider = async (p, sys, o) => { calls.push({ p, sys, o }); return { text: 'SIM: gta online carros' }; };
  const prompt = 'pesquise carros do gta <@123456789012345678> https://exemplo.com/privado?x=1 ```const segredoUnico = 1``` <:emoji:123456789012345678>';
  const d = await analyzeSearchIntent(prompt, provider, { logger: quiet });
  assert.deepEqual(d, { shouldSearch: true, query: 'gta online carros' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].o, { disableTools: true, history: [] });
  assert.equal(calls[0].sys, 'Responda apenas com o comando solicitado.');
  assert.equal(entradaDoOtimizador(calls[0].p), 'pesquise carros do gta');
  for (const bad of ['segredoUnico', 'exemplo.com', '123456789012345678', 'https://']) assert.ok(!calls[0].p.includes(bad), `o otimizador recebeu "${bad}"`);
  // cada chamada ganha o seu próprio objeto de opções (nada compartilhado entre pedidos)
  await analyzeSearchIntent(prompt, provider, { logger: quiet });
  assert.notEqual(calls[0].o, calls[1].o);
  assert.notEqual(calls[0].o.history, calls[1].o.history);
});

await test('"SIM:" vale em qualquer ponto, o raciocínio é ignorado e o JSON de search_web também vale', async () => {
  const wanted = { shouldSearch: true, query: 'gta online carros' };
  const jsonArgs = JSON.stringify({ name: 'search_web', arguments: JSON.stringify({ query: 'gta online carros' }) });
  const replies = [
    'SIM: gta online carros',
    'Claro! SIM: gta online carros',
    'Deixa eu pensar.\nSIM: gta online carros\nObrigado!',
    '<think>SIM: lixo do raciocínio</think>\nSIM: gta online carros',
    '<think>vou decidir com calma\n</think>SIM: gta online carros',
    'raciocínio sem a abertura</think>\nSIM: gta online carros',
    '**SIM:** "gta online carros"',
    'sim : gta online carros',
    '{"tool":"search_web","args":{"query":"gta online carros"}}',
    jsonArgs,
    'Vou chamar: {"tool":"search_web","args":{"query":"gta online carros"}} e depois {isso} não é JSON',
    '{"search_web":{"query":"gta online carros"}}',
    '{"tool":"search_web","args":{"q":["gta online carros"]}}',
    '{"tool_name":"web_search","parameters":{"search":"gta online carros"}}'
  ];
  for (const reply of replies) assert.deepEqual(await intent('pesquise carros do gta', reply), wanted, reply);
  // não é pedido de busca: NAO, vazio, raciocínio nunca fechado, conversa, modelo do formato, outra ferramenta
  const nope = ['NAO', 'NÃO', 'nao.', '', '   ', '<think>SIM: x', 'talvez', 'SIM: termo da busca', 'SIM:', 'assim: gta', '{"tool":"generate_reply","args":{"content":"oi"}}', 'SIM: https://exemplo.com/x'];
  for (const reply of nope) assert.deepEqual(await intent('verifique se o gta saiu', reply), { shouldSearch: false, query: null }, reply);
});

await test('o catch do otimizador é registrado (só o tipo do erro, nunca a mensagem) e o pedido explícito pesquisa mesmo assim', async () => {
  const log = spyLog();
  const info = {};
  const boom = async () => { throw Object.assign(new Error('falhou com sk-abcdefghijklmnop1234 e o pedido do usuário'), { code: 'ECONNRESET' }); };
  const d = await analyzeSearchIntent('Yui, pesquise o preço do ps5 por favor', boom, { logger: log, info });
  assert.equal(d.shouldSearch, true);
  assert.ok(/ps5/.test(d.query) && !/pesquise|yui|favor/i.test(d.query), d.query);
  assert.equal(info.reason, 'explicit_after_error');
  assert.equal(info.source, 'explicit');
  assert.ok(log.lines.some(([lv, m]) => lv === 'warn' && m.includes('otimizador de busca falhou') && m.includes('ECONNRESET')), JSON.stringify(log.lines));
  assert.ok(!JSON.stringify(log.lines).includes('sk-abcdefghij') && !JSON.stringify(log.lines).includes('pedido do usuário'));
  // sem pedido estrito (só "verifique") e o otimizador fora: sem busca, com o motivo anotado
  const info2 = {};
  assert.deepEqual(await analyzeSearchIntent('verifique se o gta saiu', boom, { logger: quiet, info: info2 }), { shouldSearch: false, query: null });
  assert.equal(info2.reason, 'optimizer_error');
});

await test('pedido EXPLÍCITO sempre pesquisa (NAO, lixo ou vazio do otimizador); sem pedido estrito vale a decisão do modelo', async () => {
  for (const reply of ['NAO', 'talvez', '', 'SIM: termo da busca', 'SIM: fulano@exemplo.com preço ps5']) {
    const info = {};
    const d = await intent('pesquise o preço do ps5', reply, { info });
    assert.equal(d.shouldSearch, true, reply);
    assert.ok(/ps5/.test(d.query) && !d.query.includes('@'), d.query);
    assert.equal(info.source, 'explicit');
  }
  const info = {};
  assert.deepEqual(await intent('verifique se o gta saiu', 'NAO', { info }), { shouldSearch: false, query: null });
  assert.equal(info.reason, 'optimizer_no');
  assert.equal((await intent('verifique se o gta saiu', 'lixo', { info })).shouldSearch, false);
  assert.equal(info.reason, 'optimizer_unclear');
  // "dá uma pesquisada" é pedido explícito mesmo sem a palavra-gatilho: o otimizador é consultado
  assert.equal(hasSearchTrigger('dá uma pesquisada no preço do ps5'), false);
  let asked = 0;
  const d = await intent('dá uma pesquisada no preço do ps5', async () => { asked++; return { text: 'SIM: ps5 preço' }; });
  assert.deepEqual(d, { shouldSearch: true, query: 'ps5 preço' });
  assert.equal(asked, 1);
});

await test('negação, "como pesquisar", "vou pesquisar" e pergunta de capacidade nem chegam ao otimizador', async () => {
  for (const text of ['não pesquise nada', 'yui, nunca pesquise isso', 'como pesquisar no google?', 'você consegue pesquisar?', 'vou pesquisar isso depois']) {
    let asked = 0;
    let searched = 0;
    const out = await smartSearchDetailed(text, async () => { asked++; return { text: 'SIM: x' }; }, { searchImpl: async () => { searched++; return okFound(); }, logger: quiet });
    assert.equal(out.context, null, text);
    assert.ok(out.reason.startsWith('blocked_'), `${text} -> ${out.reason}`);
    assert.equal(asked, 0, `"${text}" gastou o otimizador`);
    assert.equal(searched, 0, `"${text}" pesquisou`);
  }
});

console.log('Privacidade da consulta (scrub antes do otimizador e antes do buscador)');
await test('dado pessoal ou segredo no pedido: nem otimizador nem buscador, e a resposta pede para reescrever', async () => {
  const sensitive = [
    'pesquise o preço e mande para fulano@exemplo.com',
    'pesquise o cpf 123.456.789-09',
    'pesquise meu telefone (11) 91234-5678',
    'pesquise isso: sk-abcdefghijklmnop1234',
    'pesquise por que a senha: hunter2 não funciona',
    'pesquise agência 1234 conta 56789-0',
    `pesquise ${'a1b2c3d4'.repeat(5)}`
  ];
  for (const text of sensitive) {
    let asked = 0;
    let searched = 0;
    const out = await smartSearchDetailed(text, async () => { asked++; return { text: 'SIM: algo' }; }, { searchImpl: async () => { searched++; return okFound(); }, readPage: noPage, logger: quiet });
    assert.equal(out.context, null, text);
    assert.equal(out.reason, 'sensitive_data', text);
    assert.match(out.message, /reescreve/, text);
    assert.equal(asked, 0, `"${text}" chegou ao otimizador`);
    assert.equal(searched, 0, `"${text}" chegou ao buscador`);
  }
});

await test('palavra proibida (forbiddenKeywords do banHandler) bloqueia; sem a lista a moderação é pulada', async () => {
  let asked = 0;
  let searched = 0;
  const run = (extra) => smartSearchDetailed('pesquise sobre palavraproibida agora', async () => { asked++; return { text: 'SIM: palavraproibida agora' }; }, { searchImpl: async () => { searched++; return okFound(); }, readPage: noPage, logger: quiet, ...extra });
  const blocked = await run({ forbiddenKeywords: ['outra', 'palavraproibida'] });
  assert.equal(blocked.reason, 'forbidden');
  assert.equal(blocked.context, null);
  assert.match(blocked.message, /outras palavras/);
  assert.equal(asked, 0);
  assert.equal(searched, 0);
  assert.equal((await run({})).reason, 'ok', 'sem a lista injetada a moderação é pulada (modo público)');
  // a consulta que o otimizador devolve também passa pela moderação: a palavra proibida nunca chega ao buscador
  const sent = [];
  const spy = async (q) => { sent.push(q); return okFound(); };
  const strict = await smartSearchDetailed('pesquise sobre carros do gta', async () => ({ text: 'SIM: palavraproibida carros' }), { forbiddenKeywords: ['palavraproibida'], searchImpl: spy, readPage: noPage, logger: quiet });
  assert.equal(strict.reason, 'ok', 'pedido explícito: pesquisa com a consulta tirada do pedido');
  assert.deepEqual(sent, ['carros do gta']);
  sent.length = 0;
  const loose = await smartSearchDetailed('verifique se o gta saiu', async () => ({ text: 'SIM: palavraproibida carros' }), { forbiddenKeywords: ['palavraproibida'], searchImpl: spy, readPage: noPage, logger: quiet });
  assert.equal(loose.context, null);
  assert.deepEqual(sent, [], 'sem pedido estrito e com a consulta barrada, nada vai ao buscador');
});

await test('consulta devolvida pelo otimizador com segredo, e-mail ou "chave" é descartada; sobra a consulta tirada do pedido estrito', async () => {
  for (const reply of ['SIM: preço ps5 fulano@exemplo.com', `SIM: ${'k9'.repeat(20)}`, 'SIM: senha: hunter2 ps5', 'SIM: cpf 123.456.789-09']) {
    const strict = await intent('pesquise o preço do ps5', reply);
    assert.equal(strict.shouldSearch, true, reply);
    assert.ok(/ps5/.test(strict.query) && !/@|hunter2|k9k9|123\.456/.test(strict.query), `${reply} -> ${strict.query}`);
    assert.deepEqual(await intent('verifique se o gta saiu', reply), { shouldSearch: false, query: null }, reply);
  }
});

await test('o log da busca não leva o texto do pedido nem a consulta', async () => {
  const log = spyLog();
  const out = await smartSearchDetailed('pesquise segredo-unico-xyz gta', async () => ({ text: 'SIM: segredo-unico-xyz gta online carros' }), { searchImpl: async () => okFound(), readPage: noPage, logger: log });
  assert.equal(out.reason, 'ok');
  assert.ok(out.query.includes('segredo-unico-xyz'), 'o resultado traz a consulta para quem chama decidir, mas o log não');
  const text = JSON.stringify(log.lines);
  assert.ok(!text.includes('segredo-unico-xyz'), text);
  assert.ok(log.lines.some(([lv, m]) => /^\[Search\] busca aprovada \(consulta com \d+ caracteres\)$/.test(m) && lv === 'info'));
});

await test('optimizeQuery (reescrita da consulta do agente): scrub antes e depois, sem a fala do usuário, sem ferramentas, nunca no privado', async () => {
  const calls = [];
  const provider = async (p, s, o) => { calls.push({ p, s, o }); return { text: 'SIM: gta v online carros 2031' }; };
  const ok = await optimizeQuery('carros gta online', provider, { tried: ['carros gta online', 'gta carros'], logger: quiet, now: () => Date.UTC(2031, 5, 1) });
  assert.deepEqual(ok, { ok: true, query: 'gta v online carros 2031', reason: 'optimizer' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].o, { disableTools: true, history: [] });
  assert.equal(entradaDoOtimizador(calls[0].p), 'carros gta online');
  assert.ok(calls[0].p.includes('(2031)') && calls[0].p.includes('DIFERENTE') && calls[0].p.includes('gta carros'));
  // entrada com segredo/proibida: o modelo nem é chamado
  calls.length = 0;
  assert.equal((await optimizeQuery('meu cpf 123.456.789-09 gta', provider, { logger: quiet })).reason, 'sensitive_data');
  assert.equal((await optimizeQuery('palavraproibida gta', provider, { forbiddenKeywords: ['palavraproibida'], logger: quiet })).reason, 'forbidden');
  assert.equal((await optimizeQuery('carros gta online', provider, { private: true, logger: quiet })).reason, 'private');
  assert.equal(calls.length, 0);
  // saída ruim: repetida, com e-mail, NAO, lixo, erro
  const answers = [['SIM: carros gta online', 'same_query'], ['SIM: Carros  GTA online', 'same_query'], ['SIM: x@exemplo.com carros', 'sensitive_data'], ['NAO', 'optimizer_no'], ['talvez', 'optimizer_unclear']];
  for (const [text, reason] of answers) assert.equal((await optimizeQuery('carros gta online', async () => ({ text }), { logger: quiet })).reason, reason, text);
  const log = spyLog();
  assert.equal((await optimizeQuery('carros gta online', async () => { throw new Error('boom'); }, { logger: log })).reason, 'optimizer_error');
  assert.ok(log.lines.some(([lv, m]) => lv === 'warn' && m.includes('reescrita da consulta falhou')));
});

console.log('Motivo da falha da busca (cota, tempo, bloqueio...)');
await test('classifySearchOutcome: cada tipo de falha tem o seu motivo, a sua causa e a sua mensagem', () => {
  const rows = [
    [{ errors: ['brave: cota mensal atingida', 'tavily: cota mensal atingida'] }, 'providers_rest', 'quota', /limite|descanso/],
    [{ errors: ['tavily: HTTP 432', 'brave: HTTP 429'] }, 'providers_error', 'quota', /erro|bloqueio/],
    [{ errors: ['duckduckgo: descansando', 'bing: descansando'] }, 'providers_rest', 'resting', /limite|descanso/],
    [{ errors: ['duckduckgo: tempo esgotado', 'bing: tempo esgotado'] }, 'deadline', 'timeout', /tempo limite/],
    [{ errors: ['duckduckgo: tempo esgotado', 'prazo total esgotado'] }, 'deadline', 'timeout', /tempo limite/],
    [{ errors: ['duckduckgo: bloqueio leve (HTTP 202)', 'bing: bloqueio leve (página de desafio)'] }, 'providers_error', 'blocked', /erro ou bloqueio/],
    [{ errors: ['tavily: HTTP 403', 'searxng: HTTP 401'] }, 'providers_error', 'blocked', /erro ou bloqueio/],
    [{ errors: ['tavily: HTTP 432', 'duckduckgo: bloqueio leve (HTTP 202)'] }, 'providers_error', 'mixed', /erro ou bloqueio/],
    [{ errors: ['duckduckgo: ECONNRESET', 'bing: HTTP 503'] }, 'providers_error', 'network', /erro ou bloqueio/],
    [{ errors: ['duckduckgo: sem resultados', 'bing: descansando'] }, 'no_results', 'none', /Não achei nada/],
    [{ errors: [] }, 'no_providers', 'none', /sem buscador/],
    [{ limited: 'user', retryAfterMs: 1_800_000, errors: ['limite de buscas por usuário atingido'] }, 'user_limited', 'user', /30 min/],
    [{ limited: 'global', retryAfterMs: 600_000, errors: [] }, 'global_limited', 'global', /limite desta hora/],
    [{ errors: ['sensitive'] }, 'sensitive', 'sensitive', /conversa privada/]
  ];
  for (const [found, reason, cause, message] of rows) {
    const out = classifySearchOutcome({ provider: null, results: [], ...found });
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason, JSON.stringify(found));
    assert.equal(out.cause, cause, JSON.stringify(found));
    assert.match(out.message, message, JSON.stringify(found));
  }
  const ok = classifySearchOutcome({ provider: 'x', results: [{ url: 'https://a.com/x', title: 't' }], errors: ['tavily: HTTP 432'] });
  assert.deepEqual(ok, { ok: true, reason: 'ok', cause: '', causes: [], retryAfterMs: 0, message: '' });
  assert.equal(classifySearchOutcome(null).reason, 'no_providers');
  assert.equal(classifySearchOutcome({ results: [], errors: ['a: HTTP 429'], retryAfterMs: 90_000 }).retryAfterMs, 90_000);
});

await test('smartSearchDetailed devolve o motivo e a mensagem; smartSearch continua devolvendo só o contexto (ou null)', async () => {
  const provider = async () => ({ text: 'SIM: gta online carros' });
  const failing = (found) => async () => ({ provider: null, results: [], errors: [], ...found });
  const cases = [
    [{ errors: ['brave: cota mensal atingida'] }, 'providers_rest', 'quota'],
    [{ errors: ['duckduckgo: tempo esgotado'] }, 'deadline', 'timeout'],
    [{ errors: ['duckduckgo: bloqueio leve (HTTP 202)'] }, 'providers_error', 'blocked'],
    [{ errors: ['duckduckgo: sem resultados'] }, 'no_results', 'none'],
    [{ limited: 'user', retryAfterMs: 60_000, errors: ['x'] }, 'user_limited', 'user'],
    [{ limited: 'global', retryAfterMs: 60_000, errors: ['x'] }, 'global_limited', 'global']
  ];
  for (const [found, reason, cause] of cases) {
    const out = await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: failing(found), logger: quiet });
    assert.equal(out.context, null);
    assert.equal(out.reason, reason);
    assert.equal(out.cause, cause);
    assert.ok(out.message.length > 10, 'sem mensagem para o usuário');
    assert.equal(await smartSearch('pesquise carros do gta', provider, { searchImpl: failing(found), logger: quiet }), null);
  }
  const good = await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: async () => okFound(), readPage: noPage, logger: quiet });
  assert.equal(good.reason, 'ok');
  assert.equal(good.provider, 'x');
  assert.equal(good.count, 1);
  assert.ok(good.context.startsWith('[DADOS EXTERNOS NÃO CONFIÁVEIS') && good.context.includes('lista de carros'));
  assert.equal(await smartSearch('pesquise carros do gta', provider, { searchImpl: async () => okFound(), readPage: noPage, logger: quiet }), good.context);
  // lista negra tirou tudo: motivo próprio, sem contexto
  const filtered = await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: async () => ({ provider: 'x', results: [{ url: 'https://www.facebook.com/p/1', title: 'a', snippet: 'b' }], errors: [] }), readPage: noPage, logger: quiet });
  assert.deepEqual([filtered.context, filtered.reason], [null, 'filtered']);
  // conversa sensível: nada roda
  let asked = 0;
  const sens = await smartSearchDetailed('pesquise carros', async () => { asked++; return { text: 'SIM: x' }; }, { sensitive: true, searchImpl: async () => okFound(), logger: quiet });
  assert.deepEqual([sens.context, sens.reason, asked], [null, 'sensitive', 0]);
});

await test('smartSearchDetailed nunca lança: erro do buscador, da leitura da página e do otimizador viram motivo', async () => {
  const provider = async () => ({ text: 'SIM: gta online carros' });
  const log = spyLog();
  const a = await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: async () => { throw Object.assign(new Error('rede com texto do pedido'), { code: 'ECONNRESET' }); }, logger: log });
  assert.deepEqual([a.context, a.reason, a.cause], [null, 'providers_error', 'network']);
  assert.ok(log.lines.some(([lv, m]) => lv === 'warn' && m.includes('ECONNRESET')));
  assert.ok(!JSON.stringify(log.lines).includes('texto do pedido'));
  const b = await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: async () => okFound(), readPage: async () => { throw new Error('página explodiu'); }, logger: quiet });
  assert.deepEqual([b.context, b.reason], [null, 'error']);
  const c = await smartSearchDetailed('verifique se o gta saiu', async () => { throw new Error('modelo fora'); }, { searchImpl: async () => okFound(), logger: quiet });
  assert.deepEqual([c.context, c.reason], [null, 'optimizer_error']);
  // userId, sensitive e signal chegam ao buscador (signal só quando existe)
  const seen = [];
  const ctl = new AbortController();
  const spy = async (q, o) => { seen.push(o); return { provider: null, results: [], errors: [] }; };
  await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: spy, userId: 'u7', signal: ctl.signal, logger: quiet });
  await smartSearchDetailed('pesquise carros do gta', provider, { searchImpl: spy, userId: 'u7', logger: quiet });
  assert.deepEqual(Object.keys(seen[0]).sort(), ['max', 'sensitive', 'signal', 'userId']);
  assert.equal(seen[0].signal, ctl.signal);
  assert.deepEqual(seen[1], { max: 8, userId: 'u7', sensitive: false });
});

console.log('Contexto da web reaproveitado entre provedores');
await test('a busca de um pedido é feita UMA vez: o provedor seguinte reaproveita o contexto (e o resultado negativo) sem gastar cota', async () => {
  let optimizer = 0;
  let searches = 0;
  const provider = async () => { optimizer++; return { text: 'SIM: gta online carros' }; };
  const searchImpl = async () => { searches++; return okFound(); };
  const memo = createWebContextMemo();
  assert.deepEqual(memo, { done: false, result: null });
  const opts = { searchImpl, readPage: noPage, memo, userId: 'u1', logger: quiet };
  const a = await smartSearchDetailed('pesquise carros do gta', provider, opts);
  const b = await smartSearchDetailed('pesquise carros do gta', provider, opts);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.context, a.context);
  assert.equal(await smartSearch('pesquise carros do gta', provider, opts), a.context, 'o contrato antigo (string) também reaproveita');
  assert.deepEqual([optimizer, searches], [1, 1]);
  // resultado negativo também é guardado: a cota do usuário não é gasta duas vezes
  let negSearches = 0;
  const negative = { searchImpl: async () => { negSearches++; return { provider: null, results: [], errors: [], limited: 'user', retryAfterMs: 600_000 }; }, memo: createWebContextMemo(), logger: quiet };
  const n1 = await smartSearchDetailed('pesquise carros do gta', provider, negative);
  const n2 = await smartSearchDetailed('pesquise carros do gta', provider, negative);
  assert.deepEqual([n1.reason, n2.reason, n2.reused, negSearches], ['user_limited', 'user_limited', true, 1]);
  // memória nova = pedido novo
  assert.equal((await smartSearchDetailed('pesquise carros do gta', provider, { ...opts, memo: createWebContextMemo() })).reused, false);
});

await test('falha do PRÓPRIO otimizador não é guardada (o próximo provedor decide); conversa sensível ignora a memória', async () => {
  const memo = createWebContextMemo();
  let tries = 0;
  const flaky = async () => { tries++; if (tries === 1) throw new Error('fora'); return { text: 'SIM: gta online carros' }; };
  const opts = { searchImpl: async () => okFound(), readPage: noPage, memo, logger: quiet };
  const first = await smartSearchDetailed('verifique se o gta saiu', flaky, opts);
  assert.deepEqual([first.reason, memo.done], ['optimizer_error', false]);
  const second = await smartSearchDetailed('verifique se o gta saiu', flaky, opts);
  assert.deepEqual([second.reason, second.reused, memo.done], ['ok', false, true]);
  const sens = await smartSearchDetailed('verifique se o gta saiu', flaky, { ...opts, sensitive: true });
  assert.deepEqual([sens.context, sens.reason], [null, 'sensitive']);
  // decisão de não pesquisar (sem gatilho) também é guardada: o provedor seguinte não gasta outro otimizador
  const m2 = createWebContextMemo();
  let asked = 0;
  const count = async () => { asked++; return { text: 'NAO' }; };
  await smartSearchDetailed('bom dia', count, { searchImpl: noWeb, memo: m2, logger: quiet });
  await smartSearchDetailed('bom dia', count, { searchImpl: noWeb, memo: m2, logger: quiet });
  assert.equal(asked, 0);
  assert.equal(m2.done, true);
});

console.log('Teto global por hora (budget.js, YUI_SEARCH_GLOBAL_PER_HOUR)');
await test('teto global: padrão 20 por hora, 0 desliga, valor inválido volta ao padrão', () => {
  assert.equal(globalLimitPerHour({}), 20);
  assert.equal(globalLimitPerHour({ YUI_SEARCH_GLOBAL_PER_HOUR: '0' }), 0);
  assert.equal(globalLimitPerHour({ YUI_SEARCH_GLOBAL_PER_HOUR: '7' }), 7);
  assert.equal(globalLimitPerHour({ YUI_SEARCH_GLOBAL_PER_HOUR: 'abc' }), 20);
  assert.equal(globalLimitPerHour({ YUI_SEARCH_GLOBAL_PER_HOUR: '-3' }), 20);
  assert.equal(globalLimitPerHour({ YUI_SEARCH_GLOBAL_PER_HOUR: '' }), 20);
});

await test('teto global: soma todo mundo, recusa sem gastar a cota de ninguém e abre vaga quando a busca mais antiga completa 1 hora', () => {
  let t = 70_000_000;
  const now = () => t;
  const budget = createBudget({ filePath: path.join(tmp, 'g1.json'), now });
  const env = { YUI_SEARCH_GLOBAL_PER_HOUR: '3', YUI_SEARCH_USER_PER_HOUR: '2' };
  const t0 = t;
  assert.equal(budget.takeUser('a', env).ok, true);
  t += 1000;
  assert.equal(budget.takeUser('b', env).ok, true);
  t += 1000;
  const third = budget.takeUser('c', env);
  assert.deepEqual([third.ok, third.scope, third.globalUsed, third.globalLimit], [true, null, 3, 3]);
  t += 1000;
  const denied = budget.takeUser('d', env);
  assert.deepEqual([denied.ok, denied.scope, denied.globalLimit, denied.globalUsed, denied.used], [false, 'global', 3, 3, 0]);
  assert.equal(denied.retryAfterMs, 3_600_000 - (t - t0));
  assert.deepEqual(budget.globalStatus(env), { limit: 3, used: 3, full: true, retryAfterMs: 3_600_000 - (t - t0) });
  // a recusa não gastou nada: nem do global (continua 3) nem do usuário d
  assert.equal(budget.takeUser('d', env).ok, false);
  assert.equal(budget.globalStatus(env).used, 3);
  t = t0 + 3_600_000; // a 1ª busca completou 1 hora
  const ok = budget.takeUser('d', env);
  assert.deepEqual([ok.ok, ok.used, ok.globalUsed], [true, 1, 3]);
  assert.equal(budget.takeUser('e', env).ok, false, 'só abriu UMA vaga');
});

await test('teto global vale também sem userId e com o limite por usuário desligado (P8)', () => {
  const t = 71_000_000;
  const budget = createBudget({ filePath: path.join(tmp, 'g2.json'), now: () => t });
  const env = { YUI_SEARCH_GLOBAL_PER_HOUR: '2', YUI_SEARCH_USER_PER_HOUR: '0' };
  assert.equal(budget.takeUser(null, env).ok, true);
  assert.equal(budget.takeUser(undefined, env).ok, true);
  for (const id of ['', null, undefined, 'u1']) {
    const out = budget.takeUser(id, env);
    assert.deepEqual([out.ok, out.scope], [false, 'global'], String(id));
  }
  // desligado (0): sem teto, sem userId e sem limite por usuário
  const free = { YUI_SEARCH_GLOBAL_PER_HOUR: '0', YUI_SEARCH_USER_PER_HOUR: '0' };
  const other = createBudget({ filePath: path.join(tmp, 'g3.json'), now: () => t });
  for (let i = 0; i < 100; i++) assert.equal(other.takeUser(null, free).ok, true);
  assert.deepEqual(other.globalStatus(free), { limit: 0, used: 0, full: false, retryAfterMs: 0 });
  // reset() zera
  budget.reset();
  assert.equal(budget.takeUser(null, env).ok, true);
});

await test('recusa do usuário não gasta o teto global; recusa global não gasta a cota do usuário; os dois recusando: scope "user"', () => {
  let t = 72_000_000;
  const now = () => t;
  const budget = createBudget({ filePath: path.join(tmp, 'g4.json'), now });
  const env = { YUI_SEARCH_GLOBAL_PER_HOUR: '3', YUI_SEARCH_USER_PER_HOUR: '1' };
  assert.equal(budget.takeUser('a', env).ok, true);
  t += 1000;
  const userDenied = budget.takeUser('a', env);
  assert.deepEqual([userDenied.ok, userDenied.scope], [false, 'user']);
  assert.equal(budget.globalStatus(env).used, 1, 'a recusa do usuário não gastou o global');
  assert.equal(budget.takeUser('b', env).ok, true);
  assert.equal(budget.takeUser('c', env).ok, true);
  const globalDenied = budget.takeUser('d', env);
  assert.deepEqual([globalDenied.ok, globalDenied.scope], [false, 'global']);
  // d continua com a cota inteira: com o teto maior, passa
  const wider = { ...env, YUI_SEARCH_GLOBAL_PER_HOUR: '4' };
  const d = budget.takeUser('d', wider);
  assert.deepEqual([d.ok, d.used], [true, 1]);
  // 'a' (cota do usuário esgotada) com o global cheio: quem aparece é o limite do usuário
  const both = budget.takeUser('a', env);
  assert.deepEqual([both.ok, both.scope], [false, 'user']);
  assert.ok(both.retryAfterMs > 3_590_000 && both.retryAfterMs <= 3_600_000);
});

await test('searchForAgent: o teto global volta como limited "global" (mesmo sem userId), recusa ANTES do provedor e libera depois de 1 hora', async () => {
  resetCooldowns();
  let t = 80_000_000;
  const now = () => t;
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(DDG_OK); };
  const budget = createBudget({ filePath: path.join(tmp, 'g5.json'), now });
  const env = { YUI_SEARCH_GLOBAL_PER_HOUR: '2', YUI_SEARCH_USER_PER_HOUR: '5' };
  const go = (q, userId) => searchForAgent(q, { env, fetchImpl, userId, budget, now, logger: quiet });
  const a = await go('consulta agente 1', 'u1');
  assert.deepEqual([a.provider, a.reason, a.cause, a.message], ['duckduckgo', 'ok', '', '']);
  t += 1000;
  assert.equal((await go('consulta agente 2', 'u2')).provider, 'duckduckgo');
  t += 1000;
  const callsBefore = calls;
  const blocked = await go('consulta agente 3', null); // 2º passo do agente com CHARGE_ALL=false: sem userId
  assert.equal(blocked.limited, 'global');
  assert.equal(blocked.provider, null);
  assert.deepEqual(blocked.results, []);
  assert.ok(blocked.errors.some((e) => /teto global/.test(e)), blocked.errors.join('|'));
  assert.deepEqual([blocked.reason, blocked.cause], ['global_limited', 'global']);
  assert.match(blocked.message, /limite desta hora/);
  assert.ok(blocked.retryAfterMs > 3_590_000 && blocked.retryAfterMs <= 3_600_000, String(blocked.retryAfterMs));
  assert.equal(calls, callsBefore, 'o provedor nem foi chamado');
  const again = await go('consulta agente 4', 'u3');
  assert.equal(again.limited, 'global');
  t += 3_600_000;
  assert.equal((await go('consulta agente 5', 'u3')).provider, 'duckduckgo');
  // o limite do USUÁRIO continua sendo 'user'
  resetCooldowns();
  const userEnv = { YUI_SEARCH_GLOBAL_PER_HOUR: '0', YUI_SEARCH_USER_PER_HOUR: '1' };
  const soloBudget = createBudget({ filePath: path.join(tmp, 'g6.json'), now });
  const goUser = (q) => searchForAgent(q, { env: userEnv, fetchImpl, userId: 'solo', budget: soloBudget, now, logger: quiet });
  assert.equal((await goUser('um')).provider, 'duckduckgo');
  const userBlocked = await goUser('dois');
  assert.deepEqual([userBlocked.limited, userBlocked.reason, userBlocked.cause], ['user', 'user_limited', 'user']);
});

await test('searchForAgent: sensitive é sempre false, repassa max/userId/signal, não lança e devolve o motivo', async () => {
  const seen = [];
  const ctl = new AbortController();
  const spy = async (q, o) => { seen.push({ q, ...o }); return { provider: 'x', results: [{ url: 'https://a.com/x', title: 't', snippet: '' }], errors: [] }; };
  const out = await searchForAgent('consulta', { searchImpl: spy, max: 6, userId: 'u1', signal: ctl.signal, sensitive: true, budget: createBudget({ filePath: path.join(tmp, 'g7.json') }), logger: quiet });
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].q, seen[0].max, seen[0].userId, seen[0].sensitive], ['consulta', 6, 'u1', false]);
  assert.equal(seen[0].signal, ctl.signal);
  assert.equal(typeof seen[0].budget.takeUser, 'function');
  assert.deepEqual([out.provider, out.reason, out.cause], ['x', 'ok', '']);
  const log = spyLog();
  const boom = await searchForAgent('consulta secreta', { searchImpl: async () => { throw Object.assign(new Error('falha com consulta secreta'), { code: 'ETIMEDOUT' }); }, logger: log });
  assert.deepEqual([boom.provider, boom.results, boom.reason], [null, [], 'providers_error']);
  assert.ok(!JSON.stringify(log.lines).includes('consulta secreta') && JSON.stringify(log.lines).includes('ETIMEDOUT'));
  // buscador de teste que ignora o orçamento: o rótulo do retorno é mantido
  const kept = await searchForAgent('consulta', { searchImpl: async () => ({ provider: null, results: [], errors: ['x'], limited: 'user', retryAfterMs: 5000 }), logger: quiet });
  assert.deepEqual([kept.limited, kept.reason], ['user', 'user_limited']);
});

console.log('system.info e comandos');
tools.clearTools();
tools.registerBuiltinTools();

await test('system.info ignora argumento inventado pelo modelo (o erro "argumento desconhecido: cpu")', async () => {
  const tool = tools.getTool('system.info');
  assert.deepEqual(tools.validateArgs(tool, { cpu: true, memory: true }), {});
  assert.deepEqual(tools.validateArgs(tool, { section: 'CPU' }), { section: 'cpu' });
  assert.throws(() => tools.validateArgs(tool, { section: 'gpu' }), /deve ser um de/);
  // ferramentas estritas continuam recusando argumento desconhecido
  assert.throws(() => tools.validateArgs(tools.getTool('apps.open'), { name: 'x', extra: 1 }), /argumento desconhecido/);
});

await test('system.info traz CPU (com uso), RAM, disco e uptime; "section" filtra', async () => {
  const all = await tools.getTool('system.info').run({});
  for (const k of ['SO:', 'CPU:', 'uso agora:', 'RAM:', 'Disco', 'Ligado há:']) assert.ok(all.includes(k), `falta ${k}`);
  const cpu = await tools.getTool('system.info').run({ section: 'cpu' });
  assert.ok(cpu.startsWith('CPU:') && !cpu.includes('RAM:'));
});

await test('splitCommand: aspas agrupam e nada é interpretado por shell', () => {
  assert.deepEqual(tools.splitCommand('git -C "D:/Meus Projetos/Yui" status -s'), ['git', '-C', 'D:/Meus Projetos/Yui', 'status', '-s']);
  assert.deepEqual(tools.splitCommand('echo a;b | c'), ['echo', 'a;b', '|', 'c']);
});

await test('commands.run: só nome cadastrado, sem shell, exige confirmação e some no somente leitura', async () => {
  process.env.YUI_COMMANDS = `ola=node -e "console.log('oi da yui')"|inj=node -e "console.log(process.argv.length)" ; calc`;
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  const list = await tools.getTool('commands.list').run({});
  assert.ok(list.includes('ola:'));
  const run = await tools.getTool('commands.run').run({ name: 'OLA' });
  assert.ok(run.includes('Código de saída 0') && run.includes('oi da yui'));
  await assert.rejects(tools.getTool('commands.run').run({ name: 'nao-existe' }), /não está cadastrado/);
  assert.throws(() => tools.validateArgs(tools.getTool('commands.run'), { name: 'ola', args: '; rm -rf /' }), /argumento desconhecido/);
  // injeção por ponto e vírgula vira argumento literal do node, nunca um segundo comando
  assert.ok((await tools.getTool('commands.run').run({ name: 'inj' })).includes('Código de saída'));
  // confirmação obrigatória
  ai.registerBackend({ name: 'fake', local: false, async chat() { return '{"tool":"commands.run","args":{"name":"ola"}}'; } }, { activate: true });
  const out = await runAgent(owner, 'rode ola');
  assert.equal(out.type, 'needs_confirmation');
  const done = await resolvePending(owner, out.pendingId, true);
  assert.ok(done.reply.includes('oi da yui'));
  // somente leitura: ferramenta bloqueada
  process.env.YUI_READ_ONLY = 'true';
  const blocked = await runAgent(owner, 'rode ola');
  assert.equal(blocked.type, 'denied');
  process.env.YUI_READ_ONLY = 'false';
});

console.log('Skills');
const skillsDir = path.join(tmp, 'skills');
fs.mkdirSync(path.join(skillsDir, 'resumo-do-dia'), { recursive: true });
fs.writeFileSync(path.join(skillsDir, 'resumo-do-dia', 'SKILL.md'), '---\nname: resumo-do-dia\ndescription: Resumo curto do dia\n---\nResponda em 3 tópicos curtos.\n');
fs.writeFileSync(path.join(skillsDir, 'treino.md'), 'Monte um treino simples de 20 minutos.');
fs.writeFileSync(path.join(skillsDir, 'GRANDE.md'), 'x'.repeat(25 * 1024));
fs.writeFileSync(path.join(skillsDir, 'vazia.md'), '---\nname: vazia\n---\n');
fs.writeFileSync(path.join(skillsDir, 'Nome Ruim!.md'), 'texto');
process.env.YUI_SKILLS_DIR = skillsDir;

await test('carrega só skills válidas (nome seguro, tamanho, conteúdo) e relê a pasta a cada uso', () => {
  assert.deepEqual(loadSkills().map((s) => s.name), ['resumo-do-dia', 'treino']);
  assert.equal(getSkill('Resumo-do-Dia').description, 'Resumo curto do dia');
  assert.equal(getSkill('../../etc/passwd'), null);
  fs.writeFileSync(path.join(skillsDir, 'nova.md'), 'Faça algo.');
  assert.ok(getSkill('nova'));
  fs.rmSync(path.join(skillsDir, 'nova.md'));
});

await test('Agent: o dono em DM vê as skills e o modelo pode segui-las; a skill roda SEM ferramentas', async () => {
  tools.clearTools();
  const prompts = [];
  const answers = ['{"skill":"resumo-do-dia"}', '1. a 2. b 3. c'];
  ai.registerBackend({ name: 'fake2', local: false, async chat(a) { prompts.push(a.prompt); return answers.shift(); } }, { activate: true });
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  const out = await runAgent(owner, 'como foi meu dia?');
  assert.equal(out.type, 'reply');
  assert.equal(out.reply, '1. a 2. b 3. c');
  assert.ok(prompts[0].includes('SKILLS DISPONÍVEIS') && prompts[0].includes('resumo-do-dia — Resumo curto do dia'));
  assert.ok(prompts[1].includes('Responda em 3 tópicos curtos.') && prompts[1].includes('como foi meu dia?'));
  assert.ok(!prompts[1].includes('FERRAMENTAS DISPONÍVEIS'), 'a skill não ganha ferramentas');
});

await test('Agent: skill inexistente é recusada; membro e canal público não veem skills', async () => {
  const prompts = [];
  ai.registerBackend({ name: 'fake3', local: false, async chat(a) { prompts.push(a.prompt); return '{"skill":"treino"}'; } }, { activate: true });
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  assert.equal((await runAgent(owner, 'x')).reply.includes('Monte'), false);
  ai.registerBackend({ name: 'fake4', local: false, async chat(a) { prompts.push(a.prompt); return '{"skill":"inexistente"}'; } }, { activate: true });
  assert.equal((await runAgent(owner, 'x')).reply, 'Não encontrei essa skill.');
  prompts.length = 0;
  ai.registerBackend({ name: 'fake5', local: false, async chat(a) { prompts.push(a.prompt); return 'oi'; } }, { activate: true });
  const member = buildContext({ platform: 'api', userId: '222', isDM: true });
  await runAgent(member, 'oi');
  const publicOwner = buildContext({ platform: 'discord', userId: '111', channelId: 'pub', guildId: 'g' });
  await runAgent(publicOwner, 'oi');
  assert.ok(prompts.every((p) => !p.includes('resumo-do-dia')), 'skills não vazam para membros nem canal público');
});

console.log(`\n${passed} testes OK`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
