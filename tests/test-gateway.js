// Testes do Yui Gateway (servidor de IA próprio): provedores, roteamento, failover,
// chaves, descansos, streaming e servidor HTTP. Nada chama provedores reais.
// Execução: npm run test:gateway
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Isola do .env real: nenhuma chave verdadeira pode influenciar este teste.
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'HF_TOKEN', 'OPENROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID', 'TOGETHER_API_KEY', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_PRIORITY', 'YUI_GATEWAY_CUSTOM', 'YUI_GATEWAY_COMBOS', 'YUI_GATEWAY_IN_CHAIN',
  'YUI_GATEWAY_ENABLED', 'YUI_GATEWAY_KEYS', 'AI_MODEL', 'AI_BACKEND', 'AI_BASE_URL']) process.env[k] = '';

const { loadProviders, loadCombos, loadCustomProviders, splitKeys } = await import('../src/gateway/providers.js');
const { createRouter, GatewayError, classify, makeScrubber } = await import('../src/gateway/router.js');
const { createGatewayServer, parseGatewayKeys, validateChatBody } = await import('../src/gateway/server.js');
const gw = await import('../src/gateway/index.js');
const { isRetiredGeminiModel } = await import('../src/utils/geminiModels.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

// ───────────────────────── infraestrutura de teste ─────────────────────────
const KEY_A1 = 'alfa-key-0001-aaaaaaaa';
const KEY_A2 = 'alfa-key-0002-bbbbbbbb';
const KEY_B = 'beta-key-0001-cccccccc';
const KEY_C = 'gama-key-0001-dddddddd';

const mkProviders = () => [
  { id: 'alfa', label: 'Alfa', priority: 10, endpoint: 'https://alfa.test/v1/chat/completions', keys: [KEY_A1, KEY_A2], headers: {},
    models: [{ id: 'a-big', tier: 'smart' }, { id: 'a-small', tier: 'fast' }] },
  { id: 'beta', label: 'Beta', priority: 20, endpoint: 'https://beta.test/v1/chat/completions', keys: [KEY_B], headers: {},
    models: [{ id: 'b-main', tier: 'smart' }] },
  { id: 'gama', label: 'Gama', priority: 30, endpoint: 'https://gama.test/v1/chat/completions', keys: [KEY_C], headers: {},
    models: [{ id: 'g-main', tier: 'fast' }] },
  { id: 'anon', label: 'Anônimo', priority: 90, endpoint: 'https://anon.test/openai', keys: [], noAuth: true, anonymous: true, headers: {},
    models: [{ id: 'openai', tier: 'fast' }] },
];

const okJson = (text, extra = {}) => ({ status: 200, json: { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...extra } });
const err = (status, message = 'erro', headers = {}) => ({ status, json: { error: { message } }, headers });

/** Provedores falsos: handlers por hostname; registra todas as chamadas. */
function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).hostname.split('.')[0];
    const body = JSON.parse(init.body);
    const auth = init.headers.Authorization || null;
    calls.push({ host, auth, body, url });
    const handler = handlers[host];
    if (!handler) throw new Error(`sem handler para ${host}`);
    const r = await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      Promise.resolve(handler(body, { auth, calls })).then(resolve, reject);
    });
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: r.headers });
    if (r.sse) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (const part of r.sse) {
            if (part === '__ERROR__') { controller.error(new Error('conexão caiu')); return; }
            controller.enqueue(enc.encode(part));
            await new Promise((x) => setTimeout(x, 2));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
  };
  return { fetchImpl, calls };
}

function newRouter(handlers, opts = {}) {
  const f = makeFetch(handlers);
  let t = 10_000_000;
  const clock = { advance: (ms) => { t += ms; }, now: () => t };
  const router = createRouter({ providers: mkProviders(), fetchImpl: f.fetchImpl, now: clock.now, ...opts });
  return { router, calls: f.calls, clock };
}

const REQ = { model: 'auto', messages: [{ role: 'user', content: 'oi' }] };
const hostsOf = (calls) => calls.map((c) => c.host);
const rejects = async (p, check) => {
  try { await p; } catch (e) { check(e); return; }
  assert.fail('deveria ter falhado');
};

// ───────────────────────── provedores a partir do .env ─────────────────────────
console.log('Provedores (.env)');
await test('splitKeys: ignora chaves curtas, repetidas e aspas', () => {
  assert.deepEqual(splitKeys('abcdefghij1, "abcdefghij2" ,curta, abcdefghij1', undefined, null), ['abcdefghij1', 'abcdefghij2']);
});
await test('só provedores com chave válida entram; o anônimo grátis entra sempre', () => {
  const { providers } = loadProviders({ GROQ_API_KEY: 'gsk_abcdefghijklmnop', TOGETHER_API_KEY: 'curta' });
  assert.deepEqual(providers.map((p) => p.id), ['groq', 'pollinations']);
  assert.equal(providers.find((p) => p.id === 'pollinations').anonymous, true);
});
await test('Gemini aceita GEMINI_API_KEY (singular) e GEMINI_API_KEYS (plural), sem repetir', () => {
  const k1 = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const k2 = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2';
  const a = loadProviders({ GEMINI_API_KEY: k1 }).providers.find((p) => p.id === 'gemini');
  assert.deepEqual(a.keys, [k1]);
  const b = loadProviders({ GEMINI_API_KEYS: `${k1},${k2}`, GEMINI_API_KEY: k1 }).providers.find((p) => p.id === 'gemini');
  assert.deepEqual(b.keys, [k1, k2]);
});
await test('Gemini: modelo aposentado no .env é trocado pelo apelido atual, com aviso (padrões também são os atuais)', () => {
  const key = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const old = loadProviders({ GEMINI_API_KEY: key, GEMINI_MODEL: 'gemini-2.5-flash-lite', GEMINI_MODEL_FALLBACK: 'gemini-2.5-flash' });
  const g = old.providers.find((p) => p.id === 'gemini');
  assert.deepEqual(g.models.map((m) => m.id), ['gemini-flash-lite-latest', 'gemini-flash-latest']);
  assert.equal(old.warnings.filter((w) => /aposentado/.test(w)).length, 2);
  const none = loadProviders({ GEMINI_API_KEY: key });
  assert.deepEqual(none.providers.find((p) => p.id === 'gemini').models.map((m) => m.id), ['gemini-flash-lite-latest', 'gemini-flash-latest']);
  assert.equal(none.warnings.length, 0);
  const custom = loadProviders({ GEMINI_API_KEY: key, GEMINI_MODEL: 'gemini-3.5-flash-lite' });
  assert.equal(custom.providers.find((p) => p.id === 'gemini').models[0].id, 'gemini-3.5-flash-lite', 'modelo válido escolhido pelo dono é respeitado');
  assert.equal(isRetiredGeminiModel('gemini-1.5-pro'), true);
  assert.equal(isRetiredGeminiModel('gemini-2.0-flash'), true);
  assert.equal(isRetiredGeminiModel('gemini-3.5-flash'), false);
});
await test('Cloudflare só entra com token E id da conta', () => {
  assert.ok(!loadProviders({ CLOUDFLARE_API_TOKEN: 'cf_abcdefghijkl' }).providers.some((p) => p.id === 'cloudflare'));
  assert.ok(loadProviders({ CLOUDFLARE_API_TOKEN: 'cf_abcdefghijkl', CLOUDFLARE_ACCOUNT_ID: 'acc123' }).providers.some((p) => p.id === 'cloudflare'));
});
await test('YUI_GATEWAY_DISABLE desliga e YUI_GATEWAY_PRIORITY reordena', () => {
  const env = { GROQ_API_KEY: 'gsk_abcdefghijklmnop', HF_TOKEN: 'hf_abcdefghijklmnop', GEMINI_API_KEY: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1' };
  assert.deepEqual(loadProviders({ ...env, YUI_GATEWAY_DISABLE: 'pollinations, huggingface ' }).providers.map((p) => p.id), ['groq', 'gemini']);
  const ordered = loadProviders({ ...env, YUI_GATEWAY_DISABLE: 'pollinations', YUI_GATEWAY_PRIORITY: 'huggingface,gemini' }).providers.map((p) => p.id);
  assert.deepEqual(ordered.slice(0, 2), ['huggingface', 'gemini']);
});
await test('provedor customizado: a chave vem de uma variável, nunca do JSON; entradas inválidas geram aviso', () => {
  const custom = JSON.stringify([
    { id: 'meu', baseUrl: 'https://x.com/v1/', apiKeyEnv: 'MEU_KEY', models: ['m1', 'm2'], priority: 5 },
    { id: 'sem-chave', baseUrl: 'https://y.com/v1', apiKeyEnv: 'NAO_EXISTE', models: ['m'] },
    { id: 'Inválido!', baseUrl: 'https://z.com', models: ['m'] },
    { id: 'sem-modelo', baseUrl: 'https://w.com/v1', apiKeyEnv: 'MEU_KEY', models: [] },
    { id: 'sem-url', apiKeyEnv: 'MEU_KEY', models: ['m'] },
  ]);
  const r = loadCustomProviders({ YUI_GATEWAY_CUSTOM: custom, MEU_KEY: 'chave-do-meu-provedor-123' });
  assert.equal(r.providers.length, 1);
  assert.equal(r.providers[0].endpoint, 'https://x.com/v1/chat/completions');
  assert.deepEqual(r.providers[0].keys, ['chave-do-meu-provedor-123']);
  assert.equal(r.errors.length, 4);
  assert.ok(!JSON.stringify(r.errors).includes('chave-do-meu-provedor-123'));
  assert.match(loadCustomProviders({ YUI_GATEWAY_CUSTOM: '{ruim' }).errors[0], /JSON/);
  assert.deepEqual(loadCustomProviders({}).providers, []);
});
await test('combos: JSON válido vira lista; inválido vira aviso', () => {
  assert.deepEqual(loadCombos({ YUI_GATEWAY_COMBOS: '{"Rapido":["alfa/a-small","beta"]}' }).combos, { rapido: ['alfa/a-small', 'beta'] });
  assert.match(loadCombos({ YUI_GATEWAY_COMBOS: 'x' }).errors[0], /JSON/);
});

// ───────────────────────── roteamento ─────────────────────────
console.log('Roteamento e failover');
await test('"auto" usa a ordem de prioridade e informa quem respondeu', async () => {
  const { router, calls } = newRouter({ alfa: () => okJson('da alfa') });
  const r = await router.chat(REQ);
  assert.equal(r.choices[0].message.content, 'da alfa');
  assert.deepEqual(r.x_gateway, { provider: 'alfa', model: 'a-big', attempts: 1, latency_ms: r.x_gateway.latency_ms });
  assert.deepEqual(hostsOf(calls), ['alfa']);
  assert.equal(calls[0].body.model, 'a-big', 'o nome do modelo é o do provedor, não o virtual');
});
await test('falha 500 → passa para o próximo provedor e o primeiro "descansa" 30 s', async () => {
  const { router, calls, clock } = newRouter({ alfa: () => err(500), beta: () => okJson('da beta') });
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'beta');
  assert.equal(r.x_gateway.attempts, 2);
  assert.deepEqual(hostsOf(calls), ['alfa', 'beta']);
  // enquanto descansa, alfa nem é chamada
  calls.length = 0;
  await router.chat(REQ);
  assert.deepEqual(hostsOf(calls), ['beta']);
  const a = router.status().providers.find((p) => p.id === 'alfa').targets[0];
  assert.equal(a.available, false);
  assert.equal(a.cooldownSeconds, 30);
  // passado o descanso, alfa volta a ser tentada
  clock.advance(31_000);
  calls.length = 0;
  await router.chat(REQ);
  assert.equal(calls[0].host, 'alfa');
});
await test('descanso cresce a cada falha seguida (30 s, 60 s, 120 s...) e é limitado a 15 min; sucesso zera', async () => {
  let fail = true;
  const { router, clock } = newRouter({ alfa: () => (fail ? err(500) : okJson('ok')), beta: () => okJson('b'), gama: () => okJson('g') });
  const cd = () => router.status().providers[0].targets[0].cooldownSeconds;
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await router.chat({ model: 'alfa/a-big', messages: REQ.messages }).catch(() => {});
    seen.push(cd());
    clock.advance(cd() * 1000 + 1);
  }
  assert.deepEqual(seen, [30, 60, 120, 240, 480, 900, 900, 900]);
  fail = false;
  await router.chat({ model: 'alfa/a-big', messages: REQ.messages });
  assert.equal(cd(), 0);
  assert.equal(router.status().providers[0].targets[0].failures, 0, 'um sucesso zera as falhas');
});
await test('timeout vira failover para o próximo provedor', async () => {
  const { router } = newRouter({ alfa: () => new Promise(() => {}), beta: () => okJson('beta') }, { attemptTimeoutMs: 40 });
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'beta');
});
await test('resposta vazia, inválida ou sem choices também troca de provedor; só tool_calls é aceito', async () => {
  const handlers = {
    alfa: () => ({ status: 200, json: { choices: [{ message: { content: '   ' } }] } }),
    beta: () => ({ status: 200, raw: 'isso não é json' }),
    gama: () => ({ status: 200, json: { choices: [{ message: { content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] } }),
  };
  const { router } = newRouter(handlers);
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'gama');
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'f');
});
await test('resposta vazia por falta de tokens NÃO derruba o provedor: só esse modelo descansa 15 s e a mensagem explica', async () => {
  const empty = { status: 200, json: { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] } };
  const { router, clock } = newRouter({ alfa: (body) => (body.model === 'a-big' ? empty : okJson('pequeno ok')), beta: () => okJson('beta') });
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.model, 'a-small', 'outro modelo do mesmo provedor responde');
  const [big, small] = router.status().providers[0].targets;
  assert.equal(big.cooldownSeconds, 15);
  assert.equal(small.available, true);
  assert.equal(router.status().providers[0].targets[0].failures, 0, 'não conta como falha do provedor');
  assert.match(big.lastError, /limite de tokens/);
  clock.advance(16_000);
  assert.equal(router.status().providers[0].targets[0].available, true);
});
await test('limite de tentativas (maxAttempts) e erro final 502 com o histórico das tentativas', async () => {
  const { router, calls } = newRouter({ alfa: () => err(500, 'x'), beta: () => err(500, 'y'), gama: () => err(500, 'z'), anon: () => err(500, 'w') }, { maxAttempts: 2 });
  await rejects(router.chat(REQ), (e) => {
    assert.ok(e instanceof GatewayError);
    assert.equal(e.status, 502);
    assert.equal(e.attempts.length, 2);
  });
  assert.equal(calls.length, 2);
});
await test('todos descansando → 503 com o tempo para tentar de novo', async () => {
  const { router } = newRouter({ alfa: () => err(500), beta: () => err(500), gama: () => err(500), anon: () => err(500) }, { maxAttempts: 10 });
  await rejects(router.chat(REQ), (e) => assert.equal(e.status, 502));
  await rejects(router.chat(REQ), (e) => {
    assert.equal(e.status, 503);
    assert.ok(e.retryAfter >= 1 && e.retryAfter <= 30, `retryAfter=${e.retryAfter}`);
  });
});

console.log('Chaves e tipos de erro');
await test('rodízio: cada requisição começa por uma chave diferente do provedor', async () => {
  const { router, calls } = newRouter({ alfa: () => okJson('ok') });
  for (let i = 0; i < 4; i++) await router.chat(REQ);
  assert.deepEqual(calls.map((c) => c.auth), [KEY_A1, KEY_A2, KEY_A1, KEY_A2].map((k) => `Bearer ${k}`));
});
await test('429 numa chave → tenta a outra chave do MESMO provedor; chave limitada descansa (Retry-After respeitado)', async () => {
  const { router, calls, clock } = newRouter({
    alfa: (body, { auth }) => (auth === `Bearer ${KEY_A1}` ? err(429, 'limite', { 'retry-after': '120' }) : okJson('pela segunda chave')),
  });
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'alfa');
  assert.equal(r.x_gateway.attempts, 2);
  assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${KEY_A1}`, `Bearer ${KEY_A2}`]);
  const st = router.status().providers[0];
  assert.equal(st.keysCoolingDown, 1);
  // a chave 1 não é usada nos próximos 120 s
  calls.length = 0;
  await router.chat(REQ); await router.chat(REQ);
  assert.ok(calls.every((c) => c.auth === `Bearer ${KEY_A2}`));
  clock.advance(121_000);
  calls.length = 0;
  for (let i = 0; i < 2; i++) await router.chat(REQ);
  assert.ok(calls.some((c) => c.auth === `Bearer ${KEY_A1}`), 'a chave voltou depois do descanso');
});
await test('429 em todas as chaves → segue para outro provedor; provedor fica indisponível até as chaves voltarem', async () => {
  const { router, calls } = newRouter({ alfa: () => err(429), beta: () => okJson('beta') });
  const r = await router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'beta');
  assert.equal(router.status().providers[0].keysCoolingDown, 2);
  calls.length = 0;
  await router.chat(REQ);
  assert.deepEqual(hostsOf(calls), ['beta'], 'alfa nem é chamada');
});
await test('401/403 → a chave descansa 10 min; 402 → o provedor inteiro descansa 30 min; 404 → só aquele modelo', async () => {
  let a = router401();
  function router401() { return newRouter({ alfa: () => err(401, 'chave inválida'), beta: () => okJson('beta') }); }
  await a.router.chat(REQ);
  assert.equal(a.router.status().providers[0].keysCoolingDown, 2);

  const b = newRouter({ alfa: () => err(402, 'sem créditos'), beta: () => okJson('beta') });
  await b.router.chat(REQ);
  const pa = b.router.status().providers[0];
  assert.equal(pa.cooldownSeconds, 30 * 60);
  assert.ok(pa.targets.every((t) => !t.available), 'todos os modelos da alfa estão parados');

  const c = newRouter({ alfa: (body) => (body.model === 'a-big' ? err(404, 'modelo não existe') : okJson('a-small ok')) });
  const r = await c.router.chat(REQ);
  assert.equal(r.x_gateway.model, 'a-small', 'cai no outro modelo do MESMO provedor');
  const [big, small] = c.router.status().providers[0].targets;
  assert.equal(big.available, false);
  assert.equal(small.available, true);
});
await test('400/422 (erro do cliente) não pune o provedor; se todos recusarem, o cliente recebe o 400', async () => {
  const { router } = newRouter({ alfa: () => err(400, 'parâmetro inválido'), beta: () => err(422, 'inválido'), gama: () => err(400, 'ruim'), anon: () => err(400, 'ruim') });
  await rejects(router.chat(REQ), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /ruim|inválido/);
  });
  for (const p of router.status().providers) for (const t of p.targets) assert.equal(t.available, true, `${t.id} não deveria ter sido punido`);
  // um 400 de uma chave inválida (Gemini) conta como erro de chave, não do cliente
  assert.equal(classify({ status: 400, message: 'API key not valid. Please pass a valid API key.' }), 'auth');
});
await test('classificação dos erros', () => {
  const k = (status) => classify({ status, message: '' });
  assert.deepEqual([undefined, 408, 500, 502, 503, 429, 401, 403, 402, 404, 400, 413, 422].map(k), [
    'transient', 'transient', 'transient', 'transient', 'transient', 'rate', 'auth', 'auth', 'credit', 'model', 'client', 'client', 'client']);
});

console.log('Escolha do modelo');
await test('provedor/modelo exato, só o provedor, modelo avulso do provedor, smart/fast e combos', async () => {
  const f = makeFetch({ alfa: () => okJson('a'), beta: () => okJson('b'), gama: () => okJson('g'), anon: () => okJson('n') });
  const router = createRouter({ providers: mkProviders(), combos: { rapido: ['gama/g-main', 'alfa/a-small', 'inexistente/x'] }, fetchImpl: f.fetchImpl });
  const via = async (model) => { const r = await router.chat({ model, messages: REQ.messages }); return `${r.x_gateway.provider}/${r.x_gateway.model}`; };
  assert.equal(await via('beta/b-main'), 'beta/b-main');
  assert.equal(await via('beta'), 'beta/b-main');
  assert.equal(await via('alfa/modelo-novo'), 'alfa/modelo-novo', 'modelo fora da lista vai direto ao provedor');
  assert.equal(await via('fast'), 'alfa/a-small', 'o primeiro "fast" por prioridade');
  assert.equal(await via('smart'), 'alfa/a-big');
  assert.equal(await via('rapido'), 'gama/g-main', 'combo respeita a ordem definida');
  assert.equal(await via(undefined), 'alfa/a-big', 'sem modelo = auto');
  assert.equal(await via('AUTO'), 'alfa/a-big');
  await rejects(router.chat({ model: 'nao-existe', messages: REQ.messages }), (e) => { assert.equal(e.status, 404); assert.match(e.message, /desconhecido/); });
  await rejects(router.chat({ model: 'auto', messages: [] }), (e) => assert.equal(e.status, 400));
  await rejects(router.chat({ model: 'auto' }), (e) => assert.equal(e.status, 400));
  assert.ok(router.models().some((m) => m.id === 'rapido' && m.virtual));
  assert.ok(router.models().some((m) => m.id === 'alfa/a-big' && !m.virtual));
});
await test('modelo escolhido explicitamente NÃO cai em outro provedor sem querer', async () => {
  const { router, calls } = newRouter({ alfa: () => err(500), beta: () => okJson('beta') });
  await rejects(router.chat({ model: 'alfa/a-big', messages: REQ.messages }), (e) => assert.equal(e.status, 502));
  assert.ok(!hostsOf(calls).includes('beta'));
});

console.log('Conversa sensível e payload');
await test('conversa SENSÍVEL nunca vai a provedor anônimo; sem sensibilidade o anônimo é o último recurso', async () => {
  const handlers = { alfa: () => err(500), beta: () => err(500), gama: () => err(500), anon: () => okJson('do anônimo') };
  const a = newRouter(handlers, { maxAttempts: 10 });
  const free = await a.router.chat(REQ);
  assert.equal(free.x_gateway.provider, 'anon');
  const b = newRouter(handlers, { maxAttempts: 10 });
  await rejects(b.router.chat(REQ, { sensitive: true }), (e) => assert.equal(e.status, 502));
  assert.ok(!hostsOf(b.calls).includes('anon'), 'o anônimo nem foi chamado');
  const c = newRouter({ anon: () => okJson('x') });
  await rejects(c.router.chat({ model: 'anon', messages: REQ.messages }, { sensitive: true }), (e) => { assert.equal(e.status, 503); assert.match(e.message, /sens/i); });
  assert.equal(c.calls.length, 0);
});
await test('payload: repassa parâmetros úteis, troca o modelo, limita max_tokens e respeita dropParams', async () => {
  const provs = mkProviders();
  provs[0].dropParams = ['seed'];
  const f = makeFetch({ alfa: () => okJson('ok') });
  const router = createRouter({ providers: provs, fetchImpl: f.fetchImpl, maxTokensCap: 2000 });
  await router.chat({
    model: 'auto', messages: REQ.messages, temperature: 0.2, max_tokens: 99999, top_p: 0.9, seed: 7,
    tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto', campo_estranho: 'x', stream: true,
  });
  const body = f.calls[0].body;
  assert.equal(body.model, 'a-big');
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.stream, false, 'chat() sempre pede resposta completa');
  assert.ok(!('seed' in body) && !('campo_estranho' in body));
  await router.chat({ model: 'auto', messages: REQ.messages });
  assert.equal(f.calls[1].body.max_tokens, 1024, 'padrão quando não informado');
});

console.log('Segredos');
await test('o status nunca contém chaves e as mensagens de erro são limpas', async () => {
  const { router } = newRouter({
    alfa: () => err(500, `falha com ${KEY_A1} e Bearer abcdefghijklmnop123456 e sk-abcdefghijklmnopqrstu`),
    beta: () => err(500, `AIzaSyAbcdefghijklmnopqrstuvwxyz123456 ${KEY_B}`),
    gama: () => err(500, 'x'), anon: () => err(500, 'y'),
  }, { maxAttempts: 10 });
  const failure = await router.chat(REQ).then(() => null, (e) => e);
  const dump = JSON.stringify({ status: router.status(), attempts: failure.attempts, message: failure.message });
  for (const secret of [KEY_A1, KEY_A2, KEY_B, KEY_C, 'abcdefghijklmnop123456', 'sk-abcdefghij', 'AIzaSyAbcdefghij']) {
    assert.ok(!dump.includes(secret), `vazou: ${secret}`);
  }
  assert.ok(dump.includes('***'));
  assert.equal(makeScrubber(['segredo-super-longo'])('a segredo-super-longo b'), 'a *** b');
});

// ───────────────────────── servidor HTTP ─────────────────────────
console.log('Servidor HTTP (compatível com OpenAI)');
const GKEY = 'chave-do-gateway-0123456789';
async function startHttp(handlers, routerOpts = {}) {
  const f = makeFetch(handlers);
  const router = createRouter({ providers: mkProviders(), fetchImpl: f.fetchImpl, ...routerOpts });
  const server = createGatewayServer({ router, keys: parseGatewayKeys(GKEY) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { key = GKEY, body, raw, headers = {} } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* sse/texto */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return { server, call, calls: f.calls, router, close: () => server.close() };
}

await test('chaves do gateway: mínimo de 16 caracteres', () => {
  assert.equal(parseGatewayKeys('curta, 1234567890123456 ').length, 1);
  assert.equal(parseGatewayKeys('').length, 0);
});
await test('autenticação obrigatória: sem chave ou chave errada = 401; /health é público', async () => {
  const s = await startHttp({ alfa: () => okJson('ok') });
  assert.equal((await s.call('GET', '/health', { key: null })).status, 200);
  for (const key of [null, 'errada-errada-errada-12345', GKEY + 'x']) {
    const r = await s.call('POST', '/v1/chat/completions', { key, body: REQ });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.type, 'invalid_api_key');
  }
  assert.equal((await s.call('GET', '/v1/models', { key: null })).status, 401);
  assert.equal((await s.call('GET', '/v1/gateway/status', { key: null })).status, 401);
  assert.equal(s.calls.length, 0, 'nada foi enviado aos provedores sem autenticação');
  s.close();
});
await test('sem nenhuma chave configurada o servidor recusa tudo (nunca fica aberto)', async () => {
  const f = makeFetch({ alfa: () => okJson('ok') });
  const server = createGatewayServer({ router: createRouter({ providers: mkProviders(), fetchImpl: f.fetchImpl }), keys: [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(REQ) });
  assert.equal(res.status, 401);
  server.close();
});
await test('/v1/models lista modelos virtuais e reais; /v1/gateway/status traz a saúde sem chaves', async () => {
  const s = await startHttp({});
  const models = (await s.call('GET', '/v1/models')).json;
  assert.equal(models.object, 'list');
  const ids = models.data.map((m) => m.id);
  for (const id of ['auto', 'smart', 'fast', 'alfa/a-big', 'beta/b-main']) assert.ok(ids.includes(id), id);
  const st = await s.call('GET', '/v1/gateway/status');
  assert.equal(st.json.providers.length, 4);
  assert.ok(![KEY_A1, KEY_B, GKEY].some((k) => st.text.includes(k)));
  s.close();
});
await test('chat/completions (sem stream) devolve o formato OpenAI com x_gateway', async () => {
  const s = await startHttp({ alfa: () => okJson('Olá do gateway') });
  const r = await s.call('POST', '/v1/chat/completions', { body: { model: 'auto', messages: [{ role: 'user', content: 'oi' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, 'Olá do gateway');
  assert.equal(r.json.x_gateway.provider, 'alfa');
  s.close();
});
await test('validação: corpo inválido, mensagens ruins, JSON quebrado, rota inexistente e corpo gigante', async () => {
  const s = await startHttp({ alfa: () => okJson('ok') });
  const post = (body, extra) => s.call('POST', '/v1/chat/completions', { body, ...extra });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ messages: [] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'hacker', content: 'x' }] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 123 }] })).status, 400);
  assert.equal((await post({ model: 5, messages: REQ.messages })).status, 400);
  assert.equal((await post({ messages: Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' })) })).status, 400);
  assert.equal((await s.call('POST', '/v1/chat/completions', { raw: '{ruim' })).status, 400);
  assert.equal((await s.call('GET', '/v1/nada')).status, 404);
  const big = await fetch(`http://127.0.0.1:${s.server.address().port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${GKEY}` }, body: 'a'.repeat(3 * 1024 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.equal(validateChatBody(null) !== null, true);
  assert.equal(validateChatBody(REQ), null);
  s.close();
});
await test('erros do roteador chegam no formato OpenAI com o status certo (404 modelo, 503 + Retry-After, 502)', async () => {
  const s = await startHttp({ alfa: () => err(500), beta: () => err(500), gama: () => err(500), anon: () => err(500) }, { maxAttempts: 10 });
  const unknown = await s.call('POST', '/v1/chat/completions', { body: { model: 'xyz', messages: REQ.messages } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error.message, /desconhecido/);
  const first = await s.call('POST', '/v1/chat/completions', { body: REQ });
  assert.equal(first.status, 502);
  assert.ok(Array.isArray(first.json.error.attempts));
  const second = await s.call('POST', '/v1/chat/completions', { body: REQ });
  assert.equal(second.status, 503);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  s.close();
});

const sse = (...texts) => [...texts.map((t) => `data: {"choices":[{"delta":{"content":"${t}"}}]}\n\n`), 'data: [DONE]\n\n'];
await test('streaming: os trechos chegam em SSE, com cabeçalho do provedor', async () => {
  const s = await startHttp({ alfa: () => ({ sse: sse('Ol', 'á', '!') }) });
  const r = await s.call('POST', '/v1/chat/completions', { body: { ...REQ, stream: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.equal(r.headers.get('x-gateway-provider'), 'alfa');
  assert.equal(r.text, sse('Ol', 'á', '!').join(''));
  assert.equal(s.calls[0].body.stream, true);
  s.close();
});
await test('streaming: failover ANTES do primeiro byte (erro ou stream vazio → próximo provedor)', async () => {
  const s = await startHttp({ alfa: () => err(503), beta: () => ({ sse: [] }), gama: () => ({ sse: sse('do gama') }) }, { maxAttempts: 10 });
  const r = await s.call('POST', '/v1/chat/completions', { body: { ...REQ, stream: true } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-gateway-provider'), 'gama');
  assert.match(r.text, /do gama/);
  s.close();
});
await test('streaming: se o provedor cair NO MEIO, o cliente recebe um aviso e a conexão encerra (sem travar)', async () => {
  const s = await startHttp({ alfa: () => ({ sse: [sse('começo')[0], '__ERROR__'] }) });
  const r = await s.call('POST', '/v1/chat/completions', { body: { ...REQ, stream: true } });
  assert.equal(r.status, 200);
  assert.match(r.text, /começo/);
  assert.match(r.text, /interrompido/);
  s.close();
});
await test('limite de requisições por chave (120/min)', async () => {
  const s = await startHttp({});
  let last = 0;
  for (let i = 0; i < 125; i++) last = (await s.call('GET', '/v1/models')).status;
  assert.equal(last, 429);
  s.close();
});

// ───────────────────────── integração com a Yui ─────────────────────────
console.log('Integração com a Yui');
await test('ponta a ponta: provedor customizado do .env → roteador em processo → resposta', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(b), url: req.url });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'resposta do provedor real-fake' } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = upstream.address().port;
  const env = {
    YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'fake-http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'FAKE_HTTP_KEY', models: ['modelo-x'], priority: 1 }]),
    FAKE_HTTP_KEY: 'fake-http-key-0123456789',
    YUI_GATEWAY_DISABLE: 'pollinations',
  };
  gw.resetGateway();
  const router = gw.getGateway(env);
  assert.equal(gw.gatewayInChain(env), true);
  const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'oi' }] }, { sensitive: true });
  assert.equal(r.choices[0].message.content, 'resposta do provedor real-fake');
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer fake-http-key-0123456789');
  assert.equal(seen[0].body.model, 'modelo-x');
  assert.equal(gw.gatewayInChain({ ...env, YUI_GATEWAY_IN_CHAIN: 'false' }), false, 'YUI_GATEWAY_IN_CHAIN=false tira o gateway da cadeia');
  gw.resetGateway();
  assert.equal(gw.gatewayInChain({ YUI_GATEWAY_IN_CHAIN: 'false' }), false);
  gw.resetGateway();
  assert.equal(gw.gatewayInChain({ YUI_GATEWAY_DISABLE: 'pollinations' }), false, 'sem provedores o gateway fica fora da cadeia');
  gw.resetGateway();
  upstream.close();
});
await test('servidor HTTP só sobe com YUI_GATEWAY_ENABLED=true E chave', () => {
  gw.resetGateway();
  assert.equal(gw.startGatewayServer({}), null);
  assert.equal(gw.startGatewayServer({ YUI_GATEWAY_ENABLED: 'true', YUI_GATEWAY_KEYS: 'curta' }), null, 'sem chave válida não abre');
  assert.equal(gw.startGatewayServer({ YUI_GATEWAY_ENABLED: 'true', YUI_GATEWAY_KEYS: GKEY, YUI_GATEWAY_DISABLE: 'pollinations' }), null, 'sem provedores não abre');
  gw.resetGateway();
});
await test('a cadeia da Yui chama o gateway LOGO DEPOIS do LM Studio e informa se a conversa é sensível', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'handlers', 'llmHandler.js'), 'utf8');
  const local = src.indexOf('{ func: tryLocal, supportsSearch: true }');
  const gateway = src.indexOf('{ func: tryGateway, supportsSearch: false }');
  const hf = src.indexOf('{ func: tryHuggingFace, supportsSearch: false }');
  assert.ok(local > 0 && gateway > local && hf > gateway, 'ordem: tryLocal → tryGateway → o resto');
  assert.ok(src.includes("sensitive: coreCtx.memoryScope === 'personal'"), 'conversa pessoal é marcada como sensível');
  assert.ok(src.includes('sensitive: Boolean(options.sensitive)'), 'tryGateway repassa a sensibilidade');
});
await test('AI Manager tem o backend "gateway" e marca contexto pessoal como sensível', async () => {
  const ai = await import('../src/core/ai/manager.js');
  assert.ok(ai.listBackends().some((b) => b.name === 'gateway'));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'core', 'ai', 'manager.js'), 'utf8');
  assert.ok(src.includes("sensitive: ctx?.memoryScope === 'personal'"));
});

console.log(`\n${passed} testes OK`);
process.exit(0);
