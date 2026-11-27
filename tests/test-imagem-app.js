// Lacunas do painel, ENTREGA F, parte 1, item 11 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md): a IMAGEM no Chat do app (princípio 9: toda função também por conversa).
//   src/core/imagemDoApp.js      a regra: chave YUI_APP_IMAGEM (padrão desligada), política, filtro de conteúdo, limite por hora e o link curto (bytes na memória)
//   src/core/agent/tools.js      a ferramenta imagem.gerar (papel MEMBER, acesso "read", só aparece quando disponível)
//   src/core/api/preRotas.js     a pré-rota (a Porta I do Discord): "gera uma imagem de...", "desenha..."
//   src/core/api/server.js       os campos `imagem` e `limiteImagem` na resposta do /v1/agent e do /v1/chat, e o GET /v1/imagem/:codigo (o link curto)
//   src/handlers/imagemParaApp.js a geração no processo do BOT; com o cérebro separado, a entrega volta pela pasta temporária (src/discord/canalCerebro.js)
// A. A chave e a política (desligada, sem gerador, desligada no padrão global, papel, motor em enforce, somente leitura).
// B. A pré-rota dos dois lados: frases que VIRAM imagem e frases que NÃO viram (pergunta, negação, edição, link, conversa).
// C. O link curto: só os bytes, tipo pelo conteúdo, sem caminho de arquivo na resposta, prazo curto, teto de imagens guardadas.
// D. O filtro de conteúdo impróprio (a mesma lista do Discord) e o limite por pessoa por hora (o dono sem limite).
// E. A ferramenta pelo agente (o modelo escolhe imagem.gerar), prazo, falha do gerador e arquivo que não é imagem.
// F. A auditoria: nunca o texto do pedido.
// G. O cérebro separado: o pedido ao bot pelo canal de verdade (prazo próprio do método), a entrega pela pasta e o que o cérebro recusa.
// SEM rede (o gerador é falso; nada de Stability, Pollinations nem Discord), pasta temporária, sem .env. Execução: npm run test:imagemapp
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-imagem-app-'));
const AUDIT = path.join(tmp, 'audit.jsonl');
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', LOG_LEVEL: 'error',
  YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_READ_ONLY: 'true', YUI_LOG_DIR: path.join(tmp, 'logs'), YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'), YUI_IMAGE_PER_HOUR: '2',
});
for (const k of ['YUI_APP_IMAGEM', 'YUI_IMAGE_PRE_ROUTE', 'POLICY_CHAT_AUTONOMY', 'YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_API_TOKENS', 'YUI_PAINEL_CONFIG_FILE',
  'YUI_APP_COMANDOS', 'YUI_CONTINUIDADE', 'YUI_YOUTUBE_LIVE', 'YUI_BDS_URL', 'YUI_TOOLS_PC_ENABLED', 'AI_BASE_URL', 'AI_BACKEND', 'YUI_IA_PERFIS', 'YUI_HISTORICO_COMPARTILHADO']) delete process.env[k];
fs.mkdirSync(process.env.DATABASE_DIR, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const ai = await import('../src/core/ai/manager.js');
const { buildContext, ROLES, listAllowedTools } = await import('../src/core/permissions.js');
const tools = await import('../src/core/agent/tools.js');
const { runAgent } = await import('../src/core/agent/agent.js');
const { canonicalAction } = await import('../src/core/security/permissionMatrix.js');
const img = await import('../src/core/imagemDoApp.js');
const { preRotaDeImagem } = await import('../src/core/api/preRotas.js');
const intent = await import('../src/handlers/imageIntent.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const bot = await import('../src/handlers/imagemParaApp.js');
const cfg = await import('../src/core/painelConfig.js');

let passed = 0;
const failures = [];
const section = (t) => console.log(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// ── O gerador falso e o modelo falso ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const pedidos = [];
let respostaDoGerador = async () => ({ buffer: PNG, modelo: 'Gerador Falso' });
const geradorFalso = async ({ prompt }) => { pedidos.push(prompt); return respostaDoGerador(); };
const prompts = [];
let proximaDoModelo = null;
ai.registerBackend({ name: 'fake', local: false, async chat({ prompt }) { prompts.push(prompt); const r = proximaDoModelo ?? '{"reply":"conversa normal"}'; proximaDoModelo = null; return r; } }, { activate: true });

let relogio = 1_000_000;
const novoServico = (extra = {}) => img.criarImagensDoApp({ now: () => relogio, ...extra });
img.definirImagensDoAppParaTestes(novoServico());
tools.clearTools();
tools.registerImageTool();

const dono = buildContext({ platform: 'api', userId: OWNER, isDM: true });
const membro = buildContext({ platform: 'api', userId: MEMBER, isDM: true });
const convidado = buildContext({ platform: 'api', userId: null, isDM: true });
const bloqueado = buildContext({ platform: 'api', userId: '333333333333333333', isDM: true, isBlocked: true });
const ligar = () => { process.env.YUI_APP_IMAGEM = 'true'; img.registrarGeradorDeImagem(geradorFalso); };
const reset = () => { pedidos.length = 0; prompts.length = 0; intent.__resetImageQuotaForTests(); respostaDoGerador = async () => ({ buffer: PNG, modelo: 'Gerador Falso' }); };

const server = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, rota, { token, body } = {}) {
  const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* binário */ }
  return { status: res.status, json, texto, headers: res.headers };
}
const agente = (token, message) => call('POST', '/v1/agent', { token, body: { message } });
const SEM_CAMINHO = /[A-Za-z]:\\|\\\\|temp_images|localFilePath|yui-imagens-app|\.png"|\.webp"|\/tmp\//;

section('A. A chave e a política');
await test('desligada por padrão (YUI_APP_IMAGEM ausente): a ferramenta não aparece, a pré-rota não dispara e o pedido segue como conversa', async () => {
  reset();
  img.registrarGeradorDeImagem(geradorFalso);
  assert.equal(img.imagemDoAppLigada({}), false);
  assert.equal(img.imagensDoApp().disponivel(dono), false);
  assert.equal(await preRotaDeImagem({ ctx: dono, message: 'gera uma imagem de um gato' }), null);
  const r = await agente(T_OWNER, 'gera uma imagem de um gato');
  assert.equal(r.status, 200);
  assert.equal(r.json.imagem, undefined);
  assert.equal(r.json.limiteImagem, undefined);
  assert.deepEqual(pedidos, [], 'o gerador nunca foi chamado');
  assert.ok(prompts.every((p) => !p.includes('imagem.gerar')), 'o modelo não vê a ferramenta');
  const item = cfg.CATALOGO.find((c) => c.chave === 'YUI_APP_IMAGEM');
  assert.deepEqual([item.grupo, item.tipo, item.padrao, item.reinicio], ['Mídia', 'bool', 'false', false], 'no cofre do painel, desligada e valendo na hora');
});
await test('ligada, mas sem gerador registrado (quem subiu a API não registrou, ex.: dev:api): não aparece', () => {
  process.env.YUI_APP_IMAGEM = 'true';
  img.registrarGeradorDeImagem(null);
  assert.equal(img.imagensDoApp().disponivel(dono), false);
  ligar();
  assert.equal(img.imagensDoApp().disponivel(dono), true);
});
await test('generate_image desligada no padrão global (o mesmo da DM; no app não há servidor): não aparece', () => {
  ligar();
  assert.equal(novoServico({ desligadaNoPadrao: () => true }).disponivel(dono), false);
  const arq = path.join(tmp, 'mcp_tools.json');
  fs.writeFileSync(arq, JSON.stringify([{ function: { name: 'generate_image' }, meta: { defaultDisabled: true } }]));
  assert.equal(img.imagemDesligadaNoPadrao(arq), true);
  fs.writeFileSync(arq, JSON.stringify([{ function: { name: 'generate_image' }, meta: { disableable: true } }]));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(arq, t, t);
  assert.equal(img.imagemDesligadaNoPadrao(arq), false);
  assert.equal(img.imagemDesligadaNoPadrao(path.join(repoRoot, 'src/data/mcp_tools.json')), false, 'o arquivo do repositório deixa a ferramenta ligada');
});
await test('papel: membro e dono veem; convidado e bloqueado não; a ferramenta é a ação chat.generate_image da matriz', () => {
  ligar();
  assert.equal(img.imagensDoApp().disponivel(membro), true);
  assert.equal(img.imagensDoApp().disponivel(convidado), false);
  assert.equal(img.imagensDoApp().disponivel(bloqueado), false);
  assert.equal(canonicalAction('imagem.gerar'), 'chat.generate_image');
  assert.ok(listAllowedTools(membro).includes('imagem.gerar'));
  assert.ok(!listAllowedTools(convidado).includes('imagem.gerar'));
});
await test('modo somente leitura (YUI_READ_ONLY=true, o padrão): a imagem continua valendo (não mexe no computador), como no Discord', async () => {
  reset(); ligar();
  assert.equal(process.env.YUI_READ_ONLY, 'true');
  const r = await preRotaDeImagem({ ctx: dono, message: 'gera uma imagem de um farol' });
  assert.equal(r.kind, 'imagem');
});
await test('motor em enforce: POLICY_CHAT_AUTONOMY=DENY recusa sem gerar; ASK tira a pré-rota e o agente pede confirmação', async () => {
  reset(); ligar();
  process.env.YUI_POLICY_MODE = 'enforce';
  try {
    process.env.POLICY_CHAT_AUTONOMY = 'DENY';
    const negada = await preRotaDeImagem({ ctx: dono, message: 'gera uma imagem de um gato', origin: 'REMOTE' });
    assert.equal(negada.kind, 'imagem.negada');
    assert.match(negada.reply, /^Não posso fazer isso aqui/);
    assert.equal(negada.imagem, undefined);
    assert.deepEqual(pedidos, []);
    process.env.POLICY_CHAT_AUTONOMY = 'ASK';
    assert.equal(await preRotaDeImagem({ ctx: dono, message: 'gera uma imagem de um gato', origin: 'REMOTE' }), null, 'ASK: a pré-rota sai');
    proximaDoModelo = '{"tool":"imagem.gerar","args":{"prompt":"um gato"}}';
    const pedido = await runAgent(dono, 'quero ver um gato', { origin: 'REMOTE' });
    assert.equal(pedido.type, 'needs_confirmation');
    assert.deepEqual(pedidos, [], 'nada gerado antes da confirmação');
  } finally {
    process.env.YUI_POLICY_MODE = 'observe';
    delete process.env.POLICY_CHAT_AUTONOMY;
  }
});

section('B. A pré-rota dos dois lados');
const DEVEM = [
  ['gera uma imagem de um gato astronauta', /gato astronauta/],
  ['yui, desenha um dragão no topo da montanha', /dragão no topo da montanha/],
  ['faz um desenho de uma casa na praia, por favor', /casa na praia/],
  ['cria uma ilustração de um robô jardineiro', /robô jardineiro/],
];
const NAO_DEVEM = [
  'você consegue gerar imagem?',
  'não gera imagem agora',
  'como desenhar um gato?',
  'edita essa foto pra mim',
  'gera uma imagem a partir de https://exemplo.invalid/a.png',
  'me conta uma piada',
  'qual a melhor foto do GTA?',
];
for (const [frase, assunto] of DEVEM) {
  await test(`VIRA imagem: "${frase}" (POST /v1/agent devolve o link curto, nunca um caminho)`, async () => {
    reset(); ligar();
    const r = await agente(T_OWNER, frase);
    assert.equal(r.status, 200);
    assert.equal(r.json.type, 'tool_result');
    assert.equal(r.json.tool, 'imagem.gerar');
    assert.match(r.json.imagem.url, img.URL_DA_IMAGEM_RE);
    assert.match(r.json.imagem.alt, /^Imagem gerada pela Yui: /);
    assert.equal(r.json.imagem.expiresInSec, 600);
    assert.equal(pedidos.length, 1);
    assert.match(pedidos[0], assunto);
    assert.doesNotMatch(r.texto, SEM_CAMINHO);
    assert.deepEqual(prompts, [], 'a pré-rota responde sem o modelo');
  });
}
await test('VIRA imagem: "gera uma imagem" (vago) usa um assunto criativo, como no Discord', async () => {
  reset(); ligar();
  const r = await preRotaDeImagem({ ctx: membro, message: 'gera uma imagem', }, { rnd: () => 0 });
  assert.equal(r.kind, 'imagem');
  assert.equal(pedidos[0], intent.CREATIVE_PROMPTS[0]);
});
for (const frase of NAO_DEVEM) {
  await test(`NÃO vira imagem: "${frase}"`, async () => {
    reset(); ligar();
    assert.equal(await preRotaDeImagem({ ctx: dono, message: frase }), null);
    const r = await agente(T_OWNER, frase);
    assert.equal(r.json.imagem, undefined);
    assert.deepEqual(pedidos, []);
  });
}
await test('YUI_IMAGE_PRE_ROUTE=false desliga a pré-rota (a ferramenta continua aparecendo para o modelo)', async () => {
  reset(); ligar();
  process.env.YUI_IMAGE_PRE_ROUTE = 'false';
  try {
    assert.equal(await preRotaDeImagem({ ctx: dono, message: 'gera uma imagem de um gato' }), null);
    assert.equal(img.imagensDoApp().disponivel(dono), true);
  } finally { delete process.env.YUI_IMAGE_PRE_ROUTE; }
});
await test('o /v1/chat também devolve a imagem pela pré-rota', async () => {
  reset(); ligar();
  const r = await call('POST', '/v1/chat', { token: T_MEMBER, body: { message: 'desenha uma coruja de óculos' } });
  assert.equal(r.status, 200);
  assert.match(r.json.imagem.url, img.URL_DA_IMAGEM_RE);
  assert.doesNotMatch(r.texto, SEM_CAMINHO);
});

section('C. O link curto');
await test('GET do link: os bytes certos, o tipo pelo conteúdo, sem login e sem cache; código errado ou malformado = 404', async () => {
  reset(); ligar();
  const r = await agente(T_MEMBER, 'gera uma imagem de um pinguim surfista');
  const g = await fetch(base + r.json.imagem.url);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/png');
  assert.match(g.headers.get('cache-control'), /no-store/);
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/v1/imagem/${'A'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/v1/imagem/..%2F..%2Fsecrets`)).status, 404);
  assert.equal((await fetch(`${base}/v1/imagem/curto`)).status, 404);
});
await test('o link vence no prazo curto (o mesmo dos links dos arquivos: 10 min)', async () => {
  reset(); ligar();
  const r = await agente(T_OWNER, 'gera uma imagem de uma baleia voadora');
  assert.equal((await fetch(base + r.json.imagem.url)).status, 200);
  relogio += img.LINK_DA_IMAGEM_MS + 1;
  assert.equal((await fetch(base + r.json.imagem.url)).status, 404);
});
await test('no máximo 20 imagens guardadas na memória: a mais antiga sai primeiro', async () => {
  reset(); ligar();
  const s = novoServico();
  const urls = [];
  for (let i = 0; i < img.MAX_IMAGENS_GUARDADAS + 2; i++) urls.push((await s.gerar({ ctx: dono, prompt: `teste ${i}`, conferirPolitica: false })).imagem.url.split('/').pop());
  assert.equal(s._links.size, img.MAX_IMAGENS_GUARDADAS);
  assert.equal(s.resolver(urls[0]), null);
  assert.ok(s.resolver(urls.at(-1)));
});
await test('o tipo é decidido pelos bytes: PNG, JPEG, WEBP e GIF passam; o resto (ex.: HTML, SVG) não', () => {
  assert.equal(img.tipoDaImagem(PNG), 'image/png');
  assert.equal(img.tipoDaImagem(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'image/jpeg');
  assert.equal(img.tipoDaImagem(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
  assert.equal(img.tipoDaImagem(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])), 'image/gif');
  assert.equal(img.tipoDaImagem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(img.tipoDaImagem(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

section('D. Filtro de conteúdo e limite por hora');
await test('pedido impróprio: recusado sem chamar o gerador e sem gastar o limite', async () => {
  reset(); ligar();
  const r = await agente(T_MEMBER, 'gera uma imagem de uma mulher nua');
  assert.equal(r.json.reply, img.TEXTOS_DA_IMAGEM.improprio);
  assert.equal(r.json.imagem, undefined);
  assert.deepEqual(pedidos, []);
  assert.equal(intent.takeImageQuota(MEMBER, { limit: 2 }).remaining, 1, 'o limite não foi gasto');
});
await test('a lista do filtro é a MESMA do despachante do Discord (llmHandler): uma não muda sem a outra', () => {
  const fonte = fs.readFileSync(path.join(repoRoot, 'src/handlers/llmHandler.js'), 'utf8');
  const m = /const NSFW_POSITIVE_KEYWORDS = \[([\s\S]*?)\];/.exec(fonte);
  assert.ok(m, 'a lista do llmHandler sumiu');
  const doDiscord = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual([...intent.IMAGE_NSFW_KEYWORDS], doDiscord);
  assert.equal(intent.pedidoDeImagemImproprio('um GORE sangrento'), true);
  assert.equal(intent.pedidoDeImagemImproprio('um gato fofo'), false);
});
await test('membro: limite por hora (YUI_IMAGE_PER_HOUR=2); a terceira volta com limiteImagem e o texto do limite, sem gerar', async () => {
  reset(); ligar();
  for (const n of [1, 2]) assert.ok((await agente(T_MEMBER, `gera uma imagem de um gato número ${n}`)).json.imagem);
  const r = await agente(T_MEMBER, 'gera uma imagem de um gato número 3');
  assert.equal(r.json.imagem, undefined);
  assert.equal(r.json.limiteImagem.minutos, 60);
  assert.match(r.json.reply, /já gerei várias imagens para você nesta hora/);
  assert.equal(pedidos.length, 2);
});
await test('o dono não tem limite (como no Discord)', async () => {
  reset(); ligar();
  for (let n = 1; n <= 4; n++) assert.ok((await agente(T_OWNER, `gera uma imagem de um cachorro número ${n}`)).json.imagem, `pedido ${n}`);
  assert.equal(pedidos.length, 4);
});

section('E. A ferramenta pelo agente');
await test('o modelo escolhe imagem.gerar (com argumentos do Discord a mais, ignorados): tool_result com a imagem; o modelo só vê a ferramenta quando disponível', async () => {
  reset(); ligar();
  proximaDoModelo = '{"tool":"imagem.gerar","args":{"prompt":"um gato de chapéu","negative_prompt":"feio","width":512}}';
  const r = await agente(T_MEMBER, 'quero ver um gato de chapéu');
  assert.equal(r.json.type, 'tool_result');
  assert.equal(r.json.tool, 'imagem.gerar');
  assert.match(r.json.imagem.url, img.URL_DA_IMAGEM_RE);
  assert.deepEqual(pedidos, ['um gato de chapéu']);
  assert.ok(prompts[0].includes('imagem.gerar('), 'a ferramenta aparece no prompt do agente');
  assert.doesNotMatch(r.texto, SEM_CAMINHO);
});
await test('desligar a chave com a conversa andando: o modelo que ainda pede imagem.gerar é recusado ("indisponível agora") e nada é gerado', async () => {
  reset(); ligar();
  tools.registerTool({ name: 'teste.eco', description: 'Ecoa.', minRole: ROLES.MEMBER, access: 'read', privateOnly: false, async run() { return 'eco'; } });
  process.env.YUI_APP_IMAGEM = 'false';
  try {
    proximaDoModelo = '{"tool":"imagem.gerar","args":{"prompt":"um gato"}}';
    const r = await runAgent(dono, 'quero um gato');
    assert.equal(r.type, 'denied');
    assert.match(r.reply, /indisponível agora/);
    assert.ok(!prompts[0].includes('imagem.gerar'), 'desligada, o modelo nem vê a ferramenta');
    assert.deepEqual(pedidos, []);
  } finally {
    process.env.YUI_APP_IMAGEM = 'true';
    tools.clearTools();
    tools.registerImageTool();
  }
});
await test('prazo: o gerador que não responde vira "demorou" (sem imagem); o gerador que falha ou devolve algo que não é imagem vira "não consegui"', async () => {
  reset(); ligar();
  const lento = novoServico({ prazoMs: 50, gerador: () => () => new Promise(() => {}) });
  const r1 = await lento.gerar({ ctx: dono, prompt: 'um gato', conferirPolitica: false });
  assert.deepEqual([r1.kind, r1.texto, r1.imagem], ['imagem.falhou', img.TEXTOS_DA_IMAGEM.demorou, undefined]);
  const quebrado = novoServico({ gerador: () => async () => { throw new Error('C:\\segredo\\caminho.png'); } });
  const r2 = await quebrado.gerar({ ctx: dono, prompt: 'um gato', conferirPolitica: false });
  assert.deepEqual([r2.kind, r2.texto], ['imagem.falhou', img.TEXTOS_DA_IMAGEM.falhou]);
  const html = novoServico({ gerador: () => async () => ({ buffer: Buffer.from('<html>oi</html>') }) });
  assert.equal((await html.gerar({ ctx: dono, prompt: 'um gato', conferirPolitica: false })).kind, 'imagem.falhou');
  const vazio = novoServico({ gerador: () => async () => null });
  assert.equal((await vazio.gerar({ ctx: dono, prompt: 'um gato', conferirPolitica: false })).kind, 'imagem.falhou');
});

section('F. Auditoria');
await test('a auditoria registra via, resultado e tamanho, e NUNCA o texto do pedido', () => {
  const linhas = fs.readFileSync(AUDIT, 'utf8');
  assert.match(linhas, /"api\.imagem"/);
  assert.match(linhas, /"resultado":"ok"/);
  assert.match(linhas, /"resultado":"limite"/);
  assert.match(linhas, /"resultado":"improprio"/);
  for (const palavra of ['astronauta', 'dragão', 'pinguim', 'baleia', 'nua', 'coruja', 'chapéu', 'robô jardineiro']) assert.ok(!linhas.includes(palavra), `a auditoria tem "${palavra}"`);
});

section('G. O cérebro separado (canal de verdade) e a entrega pela pasta');
const { startChannelServer } = await import('../src/core/channel/server.js');
const { connectChannel } = await import('../src/core/channel/client.js');
const pasta = path.join(tmp, 'entrega');
const secretFile = path.join(tmp, 'canal', 'channel-secret.json');
// Sob o bloqueio do CI o whoami/icacls de verdade é barrado: a restrição real do arquivo do segredo é coberta em test:channel e test:separacao.
const canal = await startChannelServer({ port: 0, secretFile, logger: quiet, connectTimeoutMs: 2000, restrictFile: () => {} });
const clienteBot = connectChannel({ role: 'bot', secretFile, logger: quiet, requestTimeoutMs: 150, minBackoffMs: 50, maxBackoffMs: 400 });
await clienteBot.ready(5000);
const arquivoDoGerador = (nome) => path.join(tmp, nome);
let gerou = [];
const gerarComoOImageHandler = async (prompt) => {
  gerou.push(prompt);
  const f = arquivoDoGerador(`image_${Date.now()}_${gerou.length}.png`);
  fs.writeFileSync(f, PNG);
  return { imageUrl: null, localFilePath: f, actualSeed: 1, modelName: 'Falso (teste)' };
};
await test('o método do bot tem prazo próprio (handle com timeoutMs): sem ele valeria o prazo curto do canal', async () => {
  clienteBot.handle('teste.lento.comprazo', async () => { await sleep(300); return { ok: 1 }; }, { timeoutMs: 2000 });
  clienteBot.handle('teste.lento.semprazo', async () => { await sleep(300); return { ok: 1 }; });
  assert.deepEqual(await canal.request('bot', 'teste.lento.comprazo', {}, { timeoutMs: 3000 }), { ok: 1 });
  await assert.rejects(canal.request('bot', 'teste.lento.semprazo', {}, { timeoutMs: 3000 }), (e) => e.code === 'TIMEOUT');
});
await test('ponta a ponta: o cérebro pede ao bot, o bot gera e grava a entrega com nome aleatório, o cérebro lê, apaga e devolve o link curto', async () => {
  reset(); gerou = [];
  clienteBot.handle('imagem.gerar', async (p) => (await bot.entregarImagemAoCerebro({ prompt: p.prompt }, { gerar: gerarComoOImageHandler, pasta })) ?? { falhou: true }, { timeoutMs: 2000 });
  process.env.YUI_APP_IMAGEM = 'true';
  const cerebro = novoServico({ gerador: () => img.geradorPeloBot({ channel: canal, pasta, timeoutMs: 3000 }) });
  const r = await cerebro.gerar({ ctx: dono, prompt: 'um farol na tempestade', conferirPolitica: false });
  assert.equal(r.kind, 'imagem');
  assert.deepEqual(cerebro.resolver(r.imagem.url.split('/').pop()).buffer, PNG);
  assert.deepEqual(gerou, ['um farol na tempestade']);
  assert.deepEqual(fs.existsSync(pasta) ? fs.readdirSync(pasta) : [], [], 'a entrega foi apagada depois de lida');
  assert.ok(!fs.readdirSync(tmp).some((n) => /^image_\d+_\d+\.png$/.test(n)), 'o arquivo do gerador foi apagado');
});
await test('bot fora do canal: "indisponível agora", nada gerado', async () => {
  const fora = novoServico({ gerador: () => img.geradorPeloBot({ channel: { isConnected: () => false }, pasta }) });
  const r = await fora.gerar({ ctx: dono, prompt: 'um gato', conferirPolitica: false });
  assert.deepEqual([r.kind, r.texto], ['imagem.indisponivel', img.TEXTOS_DA_IMAGEM.indisponivel]);
});
await test('o cérebro só lê entrega com nome hexadecimal de 32 caracteres, até 8 MB e que seja imagem; e apaga mesmo quando recusa', () => {
  fs.mkdirSync(pasta, { recursive: true });
  const fora = path.join(tmp, 'fora.img');
  fs.writeFileSync(fora, PNG);
  for (const id of ['../fora', '..\\fora', 'abc', 'A'.repeat(32), `${'a'.repeat(31)}/`]) assert.equal(img.lerEntregaDoBot({ id, pasta }), null, id);
  assert.ok(fs.existsSync(fora), 'nada fora da pasta é tocado');
  const id = 'b'.repeat(32);
  fs.writeFileSync(path.join(pasta, `${id}.img`), Buffer.from('<html>não é imagem</html>'));
  assert.equal(img.lerEntregaDoBot({ id, pasta }), null);
  assert.equal(fs.existsSync(path.join(pasta, `${id}.img`)), false, 'apagada mesmo recusada');
  fs.writeFileSync(path.join(pasta, `${id}.img`), Buffer.alloc(img.MAX_BYTES_DA_IMAGEM + 1));
  assert.equal(img.lerEntregaDoBot({ id, pasta }), null);
  assert.equal(fs.existsSync(path.join(pasta, `${id}.img`)), false);
  fs.writeFileSync(path.join(pasta, `${id}.img`), PNG);
  assert.equal(img.lerEntregaDoBot({ id, pasta, modelo: 'X' }).tipo, 'image/png');
});
await test('o bot: prazo vencido devolve null e apaga o arquivo atrasado quando ele chega; entregas esquecidas saem depois de 15 min', async () => {
  let soltar;
  const atrasado = arquivoDoGerador(`image_${Date.now()}_99.png`);
  const r = await bot.gerarImagemParaApp({ prompt: 'um gato' }, { prazoMs: 30, gerar: () => new Promise((ok) => { soltar = ok; }) });
  assert.equal(r, null);
  fs.writeFileSync(atrasado, PNG);
  soltar({ localFilePath: atrasado, modelName: 'X' });
  await sleep(30);
  assert.equal(fs.existsSync(atrasado), false, 'o arquivo atrasado foi apagado');
  fs.mkdirSync(pasta, { recursive: true });
  const velho = path.join(pasta, `${'c'.repeat(32)}.img`);
  const novo = path.join(pasta, `${'d'.repeat(32)}.img`);
  const estranho = path.join(pasta, 'nao-mexer.txt');
  for (const f of [velho, novo, estranho]) fs.writeFileSync(f, PNG);
  const antigo = new Date(Date.now() - img.IDADE_MAX_DA_ENTREGA_MS - 60_000);
  fs.utimesSync(velho, antigo, antigo);
  fs.utimesSync(estranho, antigo, antigo);
  assert.equal(img.limparEntregasAntigas({ pasta }), 1);
  assert.deepEqual([fs.existsSync(velho), fs.existsSync(novo), fs.existsSync(estranho)], [false, true, true]);
});
await test('o bot (canalCerebro): o método imagem.gerar existe, com prazo de 100 s, e recusa pedido vazio ou grande demais', async () => {
  const handlers = new Map();
  const { registerBotActions } = await import('../src/discord/canalCerebro.js');
  registerBotActions({ handle: (m, fn, opts) => handlers.set(m, { fn, opts }) }, { getClient: () => null, logger: quiet });
  const h = handlers.get('imagem.gerar');
  assert.ok(h);
  assert.equal(h.opts?.timeoutMs, 100_000);
  await assert.rejects(h.fn({ prompt: '' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(h.fn({ prompt: 'x'.repeat(401) }), (e) => e.code === 'BAD_PARAMS');
});

section('H. Um limite só, somando Discord e app (correção C4 do parecer da Liz)');
const metodosDoBot = new Map();
{
  const { registerBotActions } = await import('../src/discord/canalCerebro.js');
  registerBotActions({ handle: (m, fn, opts) => metodosDoBot.set(m, { fn, opts }) }, { getClient: () => null, logger: quiet });
}
clienteBot.handle('imagem.cota', metodosDoBot.get('imagem.cota').fn);
clienteBot.handle('imagem.gerar', async (p) => (await bot.entregarImagemAoCerebro({ prompt: p.prompt }, { gerar: gerarComoOImageHandler, pasta })) ?? { falhou: true }, { timeoutMs: 2000 });
const cerebroSeparado = () => novoServico({ gerador: () => img.geradorPeloBot({ channel: canal, pasta, timeoutMs: 3000 }), cota: img.cotaPeloBot({ channel: canal, timeoutMs: 3000 }) });
await test('cérebro separado: as imagens pelo Discord contam no limite do app (YUI_IMAGE_PER_HOUR=2); a do app volta "limite", sem gerar', async () => {
  reset(); gerou = [];
  process.env.YUI_APP_IMAGEM = 'true';
  // Duas imagens pelo Discord: o despachante do Discord conta com a takeImageQuota, na memória do bot (aqui, a deste processo).
  for (let n = 0; n < 2; n++) assert.equal(intent.takeImageQuota(MEMBER, { limit: intent.imageLimitPerHour() }).ok, true);
  const r = await cerebroSeparado().gerar({ ctx: membro, prompt: 'um gato no telhado', conferirPolitica: false });
  assert.equal(r.kind, 'imagem.limite');
  assert.match(r.texto, /já gerei várias imagens para você nesta hora/);
  assert.ok(r.limite.minutos >= 1 && r.limite.minutos <= 60, String(r.limite.minutos));
  assert.deepEqual(gerou, [], 'nada foi gerado');
});
await test('cérebro separado: a imagem pelo app gasta o limite do Discord (1 pelo app + 1 pelo Discord = a terceira, no Discord, é recusada)', async () => {
  reset(); gerou = [];
  const r = await cerebroSeparado().gerar({ ctx: membro, prompt: 'um farol', conferirPolitica: false });
  assert.equal(r.kind, 'imagem');
  assert.equal(intent.takeImageQuota(MEMBER, { limit: intent.imageLimitPerHour() }).ok, true, 'a segunda (Discord) ainda cabe');
  assert.equal(intent.takeImageQuota(MEMBER, { limit: intent.imageLimitPerHour() }).ok, false, 'a terceira (Discord) já não cabe');
});
await test('cérebro separado: o dono não tem limite; quem é o dono é decidido pelo bot (do cérebro só vai o ID)', async () => {
  reset(); gerou = [];
  for (let n = 1; n <= 4; n++) assert.equal((await cerebroSeparado().gerar({ ctx: dono, prompt: `um cachorro ${n}`, conferirPolitica: false })).kind, 'imagem', `pedido ${n}`);
  const pedidosDaCota = [];
  const espiao = { isConnected: () => true, request: async (alvo, metodo, payload) => { pedidosDaCota.push({ alvo, metodo, payload }); return { ok: true }; } };
  assert.deepEqual(await img.cotaPeloBot({ channel: espiao })(MEMBER, { isOwner: true, limit: 999 }), { ok: true });
  assert.deepEqual(pedidosDaCota, [{ alvo: 'bot', metodo: 'imagem.cota', payload: { userId: MEMBER } }], 'nem o "é o dono" nem o limite vão no pedido');
});
await test('o bot (imagem.cota): recusa pedido sem ID válido; o dono passa sempre; o membro para no limite com o tempo de espera', async () => {
  reset();
  const h = metodosDoBot.get('imagem.cota');
  for (const userId of [undefined, '', 'abc', '12', `${'1'.repeat(26)}`, 123]) await assert.rejects(h.fn({ userId }), (e) => e.code === 'BAD_PARAMS', String(userId));
  for (let n = 0; n < 5; n++) assert.deepEqual(await h.fn({ userId: OWNER }), { ok: true });
  assert.deepEqual(await h.fn({ userId: MEMBER }), { ok: true });
  assert.deepEqual(await h.fn({ userId: MEMBER }), { ok: true });
  const r = await h.fn({ userId: MEMBER });
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 60 * 60 * 1000);
});
await test('bot fora do canal ou resposta estranha da cota: "indisponível agora", nada gerado e nada contado', async () => {
  reset(); gerou = [];
  const fora = novoServico({ gerador: () => img.geradorPeloBot({ channel: canal, pasta, timeoutMs: 3000 }), cota: img.cotaPeloBot({ channel: { isConnected: () => false } }) });
  const r1 = await fora.gerar({ ctx: membro, prompt: 'um gato', conferirPolitica: false });
  assert.deepEqual([r1.kind, r1.texto], ['imagem.indisponivel', img.TEXTOS_DA_IMAGEM.indisponivel]);
  const estranho = novoServico({ gerador: () => img.geradorPeloBot({ channel: canal, pasta, timeoutMs: 3000 }), cota: img.cotaPeloBot({ channel: { isConnected: () => true, request: async () => ({ talvez: 1 }) } }) });
  assert.equal((await estranho.gerar({ ctx: membro, prompt: 'um gato', conferirPolitica: false })).kind, 'imagem.indisponivel');
  assert.deepEqual(gerou, []);
  assert.equal(intent.takeImageQuota(MEMBER, { limit: 2 }).remaining, 1, 'o limite do membro não foi gasto');
});
await test('as fontes: o cérebro registra a cota pelo bot junto com o gerador; o processo único conta na memória do Discord (sem cota registrada)', () => {
  const cerebro = fs.readFileSync(path.join(repoRoot, 'src/cerebro.js'), 'utf8');
  assert.ok(cerebro.includes('registrarGeradorDeImagem(geradorPeloBot({ channel }), { cota: cotaPeloBot({ channel }) });'));
  const index = fs.readFileSync(path.join(repoRoot, 'src/index.js'), 'utf8');
  assert.ok(index.includes('registrarGeradorDeImagem(gerarImagemParaApp);'), 'o processo único não registra cota: vale a takeImageQuota (a mesma memória do Discord)');
  img.registrarGeradorDeImagem(geradorFalso);
  assert.equal(img.cotaDaImagemRegistrada(), intent.takeImageQuota);
  const cota = async () => ({ ok: true });
  img.registrarGeradorDeImagem(geradorFalso, { cota });
  assert.equal(img.cotaDaImagemRegistrada(), cota);
  img.registrarGeradorDeImagem(null, { cota });
  assert.equal(img.cotaDaImagemRegistrada(), intent.takeImageQuota, 'sem gerador, nenhuma cota fica registrada');
});

await clienteBot.close();
await canal.close();
server.close();
img.registrarGeradorDeImagem(null);
process.chdir(repoRoot);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows pode segurar algum arquivo */ }
console.log(failures.length ? `\nFALHA: ${passed} ok, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failures.length ? 1 : 0);
