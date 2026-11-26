// Checagem rápida de vida do Gateway: provedor próprio fora desta máquina que não responde é pulado sem segurar o pedido.
// Sem rede: fetchImpl e relógio injetados. Execução: node tests/test-gateway-checagem.js
import assert from 'node:assert';

// Isola do .env real: nenhuma chave verdadeira nem ajuste do dono pode influenciar este teste.
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'HF_TOKEN', 'OPENROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID', 'TOGETHER_API_KEY', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_PRIORITY', 'YUI_GATEWAY_CUSTOM', 'YUI_GATEWAY_CHECAGEM_RAPIDA']) process.env[k] = '';

const { loadProviders, loadCustomProviders } = await import('../src/gateway/providers.js');
const { createRouter } = await import('../src/gateway/router.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };

const REQ = { model: 'auto', messages: [{ role: 'user', content: 'oi' }] };
const CHAVE = 'chave-do-omniroute-1234567890';

const remoto = (extra = {}) => ({
  id: 'omniroute', label: 'OmniRoute', priority: 1, endpoint: 'http://192.168.0.9:20128/v1/chat/completions',
  keys: [CHAVE], headers: { 'X-Extra': 'segredo' }, checagemRapida: true,
  models: [{ id: 'm1', tier: 'smart' }, { id: 'm2', tier: 'fast' }], ...extra,
});
const reserva = { id: 'reserva', label: 'Reserva', priority: 2, endpoint: 'https://reserva.test/v1/chat/completions', keys: ['chave-da-reserva-123456'], headers: {}, models: [{ id: 'r1', tier: 'smart' }] };

/** Mundo falso: `estado.remoto` = 'fora' | 'vivo' | um status HTTP do GET; `estado.reserva` = status do POST. */
function mundo({ providers = [remoto(), reserva], estado = {}, ...opts } = {}) {
  const est = { remoto: 'fora', post: 200, reserva: 200, ...estado };
  const calls = [];
  let t = 1_000_000;
  let segurar = null;
  const fetchImpl = async (url, init) => {
    const host = new URL(url).hostname;
    calls.push({ method: init.method, url, host, headers: init.headers, redirect: init.redirect });
    if (init.method === 'GET') {
      if (segurar) await segurar;
      if (est.remoto === 'fora') throw new TypeError('fetch failed');
      return new Response('{}', { status: est.remoto === 'vivo' ? 200 : est.remoto });
    }
    const remotoPost = host !== 'reserva.test';
    if (remotoPost && est.post === 'fora') throw new TypeError('fetch failed');
    const status = remotoPost ? est.post : est.reserva;
    const body = status === 200 ? { choices: [{ message: { role: 'assistant', content: host } }] } : { error: { message: 'erro' } };
    return new Response(JSON.stringify(body), { status });
  };
  const router = createRouter({ providers, fetchImpl, now: () => t, ...opts });
  return {
    router, calls, est,
    gets: () => calls.filter((c) => c.method === 'GET'),
    posts: () => calls.filter((c) => c.method === 'POST').map((c) => c.host),
    advance: (ms) => { t += ms; },
    prender: () => { let soltar; segurar = new Promise((r) => { soltar = r; }); return () => { segurar = null; soltar(); }; },
  };
}

console.log('Checagem rápida de vida');

await test('provedor fora: pulado (todos os modelos), o próximo atende e não conta tentativa', async () => {
  const m = mundo({ maxAttempts: 1 });
  const r = await m.router.chat(REQ);
  assert.equal(r.x_gateway.provider, 'reserva');
  assert.equal(r.x_gateway.attempts, 1);
  assert.deepEqual(m.posts(), ['reserva.test']);
  assert.equal(m.gets().length, 1);
});

await test('o GET vai a {base}/models, sem chave, sem cabeçalhos do provedor e sem seguir redirecionamento', async () => {
  const m = mundo();
  await m.router.chat(REQ);
  const [g] = m.gets();
  assert.equal(g.url, 'http://192.168.0.9:20128/v1/models');
  assert.equal(g.redirect, 'manual');
  assert.ok(!JSON.stringify(g.headers).includes(CHAVE));
  assert.ok(!JSON.stringify(g.headers).includes('segredo'));
});

await test('qualquer resposta HTTP (200, 302, 401, 404, 500) é vivo', async () => {
  for (const status of [200, 302, 401, 404, 500]) {
    const m = mundo({ estado: { remoto: status } });
    assert.equal((await m.router.chat(REQ)).x_gateway.provider, 'omniroute', `status ${status}`);
  }
});

await test('endereço que não responde nem recusa: o prazo curto da checagem corta (não os 25 s da tentativa)', async () => {
  const pendurado = (url, init) => (init.method === 'GET'
    ? new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    : Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))));
  const router = createRouter({ providers: [remoto(), reserva], fetchImpl: pendurado });
  const t0 = Date.now();
  assert.equal((await router.chat(REQ)).x_gateway.provider, 'reserva');
  const ms = Date.now() - t0;
  assert.ok(ms >= 2300 && ms < 5000, `levou ${ms} ms`);
});

await test('cache: "vivo" vale 30 s; "fora" vale 30, 60, 120 e para em 120 s', async () => {
  const v = mundo({ estado: { remoto: 'vivo' } });
  await v.router.chat(REQ);
  v.advance(29_000);
  await v.router.chat(REQ);
  assert.equal(v.gets().length, 1);
  v.advance(2_000);
  await v.router.chat(REQ);
  assert.equal(v.gets().length, 2);

  const f = mundo();
  await f.router.chat(REQ);
  let n = 1;
  for (const ttl of [30_000, 60_000, 120_000, 120_000]) {
    f.advance(ttl - 1);
    await f.router.chat(REQ);
    assert.equal(f.gets().length, n, `ainda dentro de ${ttl}`);
    f.advance(1);
    await f.router.chat(REQ);
    n += 1;
    assert.equal(f.gets().length, n, `venceu ${ttl}`);
  }
});

await test('recuperação: voltou a responder, volta a atender, e o descanso do "fora" recomeça do início', async () => {
  const m = mundo();
  await m.router.chat(REQ);
  m.advance(30_000);
  await m.router.chat(REQ); // segundo "fora": vale 60 s
  m.est.remoto = 'vivo';
  m.advance(60_000);
  assert.equal((await m.router.chat(REQ)).x_gateway.provider, 'omniroute');
  m.est.remoto = 'fora';
  m.advance(30_000);
  await m.router.chat(REQ);
  const n = m.gets().length;
  m.advance(30_000);
  await m.router.chat(REQ);
  assert.equal(m.gets().length, n + 1);
});

await test('concorrência: pedidos simultâneos esperam a mesma checagem', async () => {
  const m = mundo();
  const soltar = m.prender();
  const todos = Promise.all([1, 2, 3, 4, 5].map(() => m.router.chat(REQ)));
  await new Promise((r) => setImmediate(r));
  assert.equal(m.gets().length, 1);
  soltar();
  assert.ok((await todos).every((r) => r.x_gateway.provider === 'reserva'));
  assert.equal(m.gets().length, 1);
});

await test('só há provedor pulado: tenta assim mesmo (falso "fora" não derruba o pedido)', async () => {
  const m = mundo({ providers: [remoto()] });
  assert.equal((await m.router.chat(REQ)).x_gateway.provider, 'omniroute');
  assert.deepEqual(m.posts(), ['192.168.0.9']);
});

await test('só há provedor pulado e ele está mesmo fora: 502 como antes e, no descanso, 503', async () => {
  const m = mundo({ providers: [remoto()], estado: { post: 'fora' } });
  await assert.rejects(m.router.chat(REQ), (e) => e.status === 502 && e.attempts.length === 1);
  await assert.rejects(m.router.chat(REQ), (e) => e.status === 503);
  assert.equal(m.posts().length, 1);
});

await test('os outros falharam: o pulado é tentado por último (um falso "fora" nunca deixa o pedido sem resposta)', async () => {
  const m = mundo({ estado: { reserva: 500 } });
  assert.equal((await m.router.chat(REQ)).x_gateway.provider, 'omniroute');
  assert.deepEqual(m.posts(), ['reserva.test', '192.168.0.9']);
});

await test('caiu depois de checado vivo: a falha da chamada vence o "vivo" guardado (checa de novo antes do prazo de 30 s)', async () => {
  const m = mundo({ estado: { remoto: 'vivo' } });
  await m.router.chat(REQ);
  const antes = m.gets().length;
  m.est.post = 'fora';
  m.est.remoto = 'fora';
  assert.equal((await m.router.chat(REQ)).x_gateway.provider, 'reserva');
  const estado = m.router.status().providers.find((p) => p.id === 'omniroute');
  assert.equal(estado.checagem.validaPorSegundos, 0, 'o "vivo" guardado foi vencido pela falha');
  assert.equal(m.gets().length, antes, 'ainda sem checar de novo (o descanso do provedor vale primeiro)');
});

await test('conversa sensível: o remoto privado fora é último recurso e o anônimo NUNCA recebe', async () => {
  const m = mundo({ providers: [remoto(), { ...reserva, anonymous: true }] });
  assert.equal((await m.router.chat(REQ, { sensitive: true })).x_gateway.provider, 'omniroute');
  assert.deepEqual(m.posts(), ['192.168.0.9']);
});

await test('streaming: o host fora é pulado do mesmo jeito', async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET') throw new TypeError('fetch failed');
    return new Response('data: oi', { status: 200 });
  };
  const router = createRouter({ providers: [remoto(), reserva], fetchImpl });
  assert.equal((await router.chatStream(REQ)).provider, 'reserva');
});

await test('provedor sem o campo (embutidos e loopback) não recebe GET', async () => {
  const m = mundo({ providers: [remoto({ checagemRapida: undefined }), reserva] });
  await m.router.chat(REQ);
  assert.equal(m.gets().length, 0);
});

const cadastro = (lista, env = {}) => loadCustomProviders({ YUI_GATEWAY_CUSTOM: JSON.stringify(lista), ...env }).providers;
const item = (baseUrl, extra = {}) => ({ id: 'omniroute', baseUrl, anonymous: true, models: ['m'], ...extra });

await test('cadastro: ligada só para host fora desta máquina; loopback fica sem o campo', async () => {
  for (const url of ['http://192.168.0.9:20128/v1', 'http://neon.local:20128/v1', 'https://x.com/v1']) {
    assert.equal(cadastro([item(url)])[0].checagemRapida, true, url);
  }
  for (const url of ['http://127.0.0.1:20128/v1', 'http://localhost:20128/v1', 'http://[::1]:20128/v1', 'http://127.0.0.2/v1']) {
    assert.ok(!('checagemRapida' in cadastro([item(url)])[0]), url);
  }
});

await test('cadastro: desligável pela variável e pelo campo do provedor', async () => {
  const url = 'http://192.168.0.9:20128/v1';
  assert.ok(!('checagemRapida' in cadastro([item(url)], { YUI_GATEWAY_CHECAGEM_RAPIDA: 'false' })[0]));
  assert.ok(!('checagemRapida' in cadastro([item(url, { checagemRapida: false })])[0]));
  assert.equal(cadastro([item('http://127.0.0.1:1/v1', { checagemRapida: true })])[0].checagemRapida, true);
});

await test('cadastro: nenhum provedor embutido ganha o campo, mesmo com endereço trocado', async () => {
  const { providers } = loadProviders({ GROQ_API_KEY: 'gsk_abcdefghijklmnop', GROQ_API_URL: 'http://192.168.0.9/v1/chat/completions', HF_TOKEN: 'hf_abcdefghijklmnop' });
  assert.deepEqual(providers.map((p) => p.id), ['groq', 'huggingface', 'pollinations']);
  assert.ok(providers.every((p) => !('checagemRapida' in p)));
});

await test('painel (ai-providers.json): o campo sobrevive até o roteador', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-checagem-'));
  const file = path.join(dir, 'ai.json');
  const base = { baseUrl: 'http://192.168.0.9:20128/v1', models: ['m'], keys: [], anonymous: true };
  fs.writeFileSync(file, JSON.stringify({ version: 1, custom: [{ ...base, id: 'com' }, { ...base, id: 'sem', checagemRapida: false }] }));
  process.env.YUI_AI_SETTINGS_FILE = file;
  try {
    const { applyAiSettings } = await import('../src/core/aiSettings.js');
    applyAiSettings();
    const { providers } = loadProviders(process.env);
    assert.equal(providers.find((p) => p.id === 'com').checagemRapida, true);
    assert.ok(!('checagemRapida' in providers.find((p) => p.id === 'sem')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} teste(s) passaram.`);
