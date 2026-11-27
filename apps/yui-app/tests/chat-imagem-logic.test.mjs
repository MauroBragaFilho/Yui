// Lacunas do painel, item 11: a IMAGEM no Chat do app. A lógica pura das mensagens (src/chat/messages.ts) e o caminho inteiro contra a Yui API REAL
// (servidor de verdade, gerador de imagem FALSO, IA falsa): o pedido por conversa vira imagem, a tela recebe o link curto completo, o link abre os
// bytes e vence; o limite por hora vira aviso. Nada de provedor de imagem de verdade.
// Execução: npm test   (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-app-imagem-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp, YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: '111', YUI_MEMORY_ENABLED: 'false', LOG_LEVEL: 'error',
  YUI_APP_IMAGEM: 'true', YUI_IMAGE_PER_HOUR: '1', YUI_POLICY_MODE: 'observe', YUI_LOG_DIR: path.join(tmp, 'logs'),
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'), YUI_AI_SETTINGS_FILE: path.join(tmp, 'secrets', 'ai-providers.json'),
});
for (const k of ['YUI_IMAGE_PRE_ROUTE', 'POLICY_CHAT_AUTONOMY', 'YUI_APP_COMANDOS', 'YUI_CONTINUIDADE', 'YUI_YOUTUBE_LIVE', 'YUI_BDS_URL', 'AI_BASE_URL', 'AI_BACKEND', 'YUI_CEREBRO_EXTERNO']) delete process.env[k];
const root = path.resolve(import.meta.dirname, '..', '..', '..');
process.chdir(tmp); // sem .env e sem logs reais

const msg = await import('../src/chat/messages.ts');
const { createClient } = await import('../src/api/client.ts');
const ai = await import(`file://${root}/src/core/ai/manager.js`);
const { createApiServer, parseTokens } = await import(`file://${root}/src/core/api/server.js`);
const tools = await import(`file://${root}/src/core/agent/tools.js`);
const img = await import(`file://${root}/src/core/imagemDoApp.js`);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]);
const CODIGO = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const BASE = 'https://yui.exemplo.ts.net';

// ── Lógica pura ─────────────────────────────────────────────────────────────────────────────
test('imageFromReply: só o caminho curto do servidor vira imagem, com o endereço completo, o texto alternativo e o vencimento', () => {
  const i = msg.imageFromReply({ imagem: { url: `/v1/imagem/${CODIGO}`, alt: 'Imagem gerada pela Yui: um gato', expiresInSec: 600 } }, BASE, 1000);
  assert.deepEqual(i, { uri: `${BASE}/v1/imagem/${CODIGO}`, alt: 'Imagem gerada pela Yui: um gato', expiresAt: 1000 + 600_000 });
  assert.equal(msg.imageFromReply({ imagem: { url: `/v1/imagem/${CODIGO}`, alt: '', expiresInSec: null } }, `${BASE}/`, 0).alt, 'Imagem gerada pela Yui', 'alt vazio ganha o padrão');
  assert.equal(msg.imageFromReply({ imagem: { url: `/v1/imagem/${CODIGO}`, alt: 'x', expiresInSec: null } }, BASE, 0).expiresAt, msg.IMAGE_DEFAULT_TTL_SEC * 1000);
  assert.equal(msg.imageFromReply({ imagem: { url: `/v1/imagem/${CODIGO}`, alt: 'a'.repeat(500), expiresInSec: 600 } }, BASE).alt.length, msg.IMAGE_ALT_MAX);
});
test('imageFromReply recusa o que o servidor não emite: outro site, caminho de arquivo, outra rota, código curto, base que não é http(s)', () => {
  for (const url of ['https://outro.site/v1/imagem/' + CODIGO, 'C:\\Yui\\src\\data\\temp_images\\image_1.png', '/v1/bds/get/' + CODIGO, '/v1/imagem/../../secrets', '/v1/imagem/abc', `/v1/imagem/${CODIGO}?x=1`, '//outro.site/x']) {
    assert.equal(msg.imageFromReply({ imagem: { url, alt: 'x', expiresInSec: 600 } }, BASE), null, url);
  }
  for (const base of ['', 'javascript:alert(1)', 'file:///C:/x', 'ftp://x']) assert.equal(msg.imageFromReply({ imagem: { url: `/v1/imagem/${CODIGO}`, alt: 'x', expiresInSec: 600 } }, base), null, base);
  assert.equal(msg.imageFromReply({}, BASE), null);
});
test('fromAgentReply: a imagem entra na mensagem só com o endereço do servidor; o limite por hora vira aviso', () => {
  const reply = { type: 'tool_result', reply: 'Pronto, aqui está a imagem.', tool: 'imagem.gerar', imagem: { url: `/v1/imagem/${CODIGO}`, alt: 'um gato', expiresInSec: 600 } };
  const m = msg.fromAgentReply(reply, 5000, BASE);
  assert.equal(m.kind, 'tool_result');
  assert.equal(m.image.uri, `${BASE}/v1/imagem/${CODIGO}`);
  assert.equal(msg.fromAgentReply(reply, 5000).image, undefined, 'sem o endereço do servidor, só o texto');
  const lim = msg.fromAgentReply({ type: 'reply', reply: 'Calma...', limiteImagem: { minutos: 42 } }, 0, BASE);
  assert.deepEqual(lim.imageLimit, { minutes: 42 });
  assert.equal(msg.imageLimitText(lim.imageLimit), 'Limite de imagens por hora atingido. Tente de novo em 42 min.');
  assert.equal(msg.imageLimitText(undefined), null);
  assert.equal(msg.fromAgentReply({ type: 'reply', reply: 'oi' }, 0, BASE).imageLimit, undefined);
});
test('imageExpired: antes do prazo a imagem aparece; depois, o aviso', () => {
  const i = { uri: `${BASE}/v1/imagem/${CODIGO}`, alt: 'x', expiresAt: 10_000 };
  assert.equal(msg.imageExpired(i, 9_999), false);
  assert.equal(msg.imageExpired(i, 10_000), true);
  assert.equal(msg.imageExpired(null, 0), true);
});
test('o histórico guardado: a imagem válida volta; a adulterada sai (a mensagem e o texto ficam)', () => {
  const boa = { id: 'a', role: 'yui', text: 'aqui', createdAt: 1, image: { uri: `${BASE}/v1/imagem/${CODIGO}`, alt: 'x', expiresAt: 2 } };
  const ruim = { id: 'b', role: 'yui', text: 'ali', createdAt: 1, image: { uri: 'javascript:alert(1)//v1/imagem/' + CODIGO, alt: 'x', expiresAt: 2 } };
  const outra = { id: 'c', role: 'yui', text: 'lá', createdAt: 1, image: { uri: 'https://x.site/arquivo.png', alt: 'x', expiresAt: 2 } };
  const [a, b, c] = msg.parseStoredHistory(JSON.stringify([boa, ruim, outra]));
  assert.deepEqual(a.image, boa.image);
  assert.equal(b.image, undefined);
  assert.equal(b.text, 'ali');
  assert.equal(c.image, undefined);
});

// ── Contra a API real ───────────────────────────────────────────────────────────────────────
ai.registerBackend({ name: 'fake-img', local: false, async chat() { return '{"reply":"conversa"}'; } }, { activate: true });
tools.clearTools();
tools.registerImageTool();
const gerados = [];
img.registrarGeradorDeImagem(async ({ prompt }) => { gerados.push(prompt); return { buffer: PNG, modelo: 'Falso' }; });
const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); img.registrarGeradorDeImagem(null); process.chdir(root); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('pelo app: "gera uma imagem de um gato" mostra a imagem, o link abre os bytes e nunca há caminho de arquivo', async () => {
  const c = createClient({ baseUrl: url, token: OWNER });
  const reply = await c.send('gera uma imagem de um gato de óculos');
  const m = msg.fromAgentReply(reply, Date.now(), c.baseUrl);
  assert.equal(m.kind, 'tool_result');
  assert.ok(m.image, 'a mensagem tem a imagem');
  assert.ok(m.image.uri.startsWith(`${url}/v1/imagem/`));
  assert.match(m.image.alt, /gato de óculos/);
  assert.doesNotMatch(JSON.stringify(reply), /temp_images|[A-Za-z]:\\|localFilePath/);
  const r = await fetch(m.image.uri);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  assert.deepEqual(gerados, ['um gato de óculos']);
});
test('pelo app: o membro com limite 1 por hora recebe o aviso na segunda, sem imagem', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  assert.ok(msg.fromAgentReply(await c.send('desenha um farol'), Date.now(), c.baseUrl).image);
  const segunda = msg.fromAgentReply(await c.send('desenha outro farol'), Date.now(), c.baseUrl);
  assert.equal(segunda.image, undefined);
  assert.ok(segunda.imageLimit);
  assert.match(msg.imageLimitText(segunda.imageLimit), /Limite de imagens por hora/);
});
