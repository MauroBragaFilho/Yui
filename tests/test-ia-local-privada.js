// A ROTA PRIVADA COM IA LOCAL (src/core/ai/localPrivada.js), DESLIGADA por padrão (YUI_IA_LOCAL_PRIVADA), contra servidores FALSOS compatíveis com a API da OpenAI abertos por este
// teste em 127.0.0.1 (o LM Studio de verdade nunca é tocado). Num processo só, sem Discord, sem bancos reais (pasta temporária).
//  A. a chave e o endereço: padrão desligado, lidas a cada uso; só IP privado, loopback, Tailscale, .ts.net e .local; sem usuário, senha nem parâmetros; o resto é recusado;
//  B. a resposta só vale inteira e válida (vazia, só raciocínio, JSON de ferramenta quebrado); o contexto pequeno nunca estoura (menos histórico, sem memória, ou vai para a cadeia);
//  C. o disjuntor (relógio falso): abre depois de falhas seguidas, descanso crescente de 30 s a 10 min, a sondagem leve o reabilita, sem bloquear a conversa;
//  D. a chamada de verdade contra o servidor falso: ok, computador fora, prazo, HTTP de erro, vazio, só raciocínio, JSON; o pedido (sem ferramentas nativas, dentro do contexto);
//  E. o llmHandler (processo único): privada tenta o local ANTES da cadeia e cai para ela na MESMA chamada; pública nunca usa o local; chave desligada não muda um byte;
//  F. o AI Manager (app e cérebro separado) e a conversa do CÉREBRO (a decisão de "privada" sai dos FATOS, nunca de uma afirmação do bot);
//  G. observabilidade: o log, o diagnóstico e as chamadas de rede levam só metadados (nunca o conteúdo, o endereço nem outro destino);
//  H. o FALLBACK (YUI_IA_LOCAL_PRIVADA_FALLBACK): `fechar` (padrão do código) nunca chama a cadeia e responde uma frase fixa; `nuvem` cai para a cadeia (A a G rodam com `nuvem`).
// Execução: npm run test:ialocalprivada   (node tests/test-ia-local-privada.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ia-local-privada-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const PRIV = '666666666666666666';
const SEGREDO = 'SEGREDO-PRIVADO-QZ7';
const RESPOSTA_LOCAL = 'RESPOSTA-LOCAL-QZ7';
const RESPOSTA_CADEIA = 'RESPOSTA-DA-CADEIA-QZ7';
const say = console.log.bind(console);

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_OWNER_ID: OWNER, YUI_PRIVATE_CHANNEL_IDS: PRIV, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: 'http://searx.invalid/',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_PRIVATE_SEARCH: 'off',
});
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL',
  'LOCAL_LLM_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_EXTERNO', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_LOCAL_PRIVADA', 'YUI_IA_LOCAL_PRIVADA_URL',
  'YUI_IA_LOCAL_PRIVADA_MODELO', 'YUI_IA_LOCAL_PRIVADA_TIMEOUT_S', 'YUI_IA_LOCAL_PRIVADA_MAX_TOKENS', 'GEMINI_MODEL_FALLBACK']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// Todo destino de rede que o módulo abre fica registrado (a prova de que o conteúdo privado nunca vai a outro endereço).
const hostsUsados = [];
const requestOriginal = http.request;
http.request = function requestEspiao(...a) {
  const o = a[0];
  hostsUsados.push(typeof o === 'string' ? new URL(o).hostname : String(o?.hostname ?? o?.host ?? ''));
  return requestOriginal.apply(this, a);
};

// A cadeia de sempre, falsa: o LM Studio "de sempre" (tryLocal) responde pelo axios.post dublê.
const { default: axios } = await import('axios');
const chainCalls = [];
let chainDown = false;
axios.post = async (url, body) => {
  chainCalls.push({ url: String(url), body });
  if (chainDown) throw new Error('offline (teste)');
  const texto = RESPOSTA_CADEIA;
  const chunks = [`data: ${JSON.stringify({ model: 'cadeia-falsa', choices: [{ delta: { content: texto }, finish_reason: null }] })}\n\n`, `data: ${JSON.stringify({ model: 'cadeia-falsa', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n'];
  return { data: Readable.from(chunks) };
};
axios.get = async () => { throw new Error('offline (teste)'); };

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { logger } = await imp('src/utils/logger.js');
const lines = [];
for (const n of ['debug', 'info', 'warn', 'error']) logger[n] = (m) => { lines.push(`${n}: ${String(m)}`); };
const L = await imp('src/core/ai/localPrivada.js');
const ai = await imp('src/core/ai/manager.js');
const llm = await imp('src/handlers/llmHandler.js');
const conversa = await imp('src/cerebro/conversa.js');
const diag = await imp('src/core/diagnostico.js');
const { isSystemReply } = await imp('src/core/ai/limpezaResposta.js');
const { isErrorReply } = await imp('src/core/context/contextStore.js');
const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
console.log = console.warn = console.error = () => {}; // o llmHandler é falante; o resultado sai por say()

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`); }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── O servidor FALSO do modelo local ──────────────────────────────────────────────────────────────────────────────────────────────
async function criarServidorFalso() {
  const estado = { modo: 'ok', texto: RESPOSTA_LOCAL, requisicoes: [], modelosOk: true };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      let json = null;
      try { json = corpo ? JSON.parse(corpo) : null; } catch { json = null; }
      estado.requisicoes.push({ metodo: req.method, caminho: req.url, cabecalhos: { ...req.headers }, corpo: json });
      if (req.url.endsWith('/models')) {
        if (!estado.modelosOk) { res.writeHead(500); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'granite-4.0-micro' }] })); return;
      }
      const responder = (status, obj, bruto = null) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(bruto ?? JSON.stringify(obj)); };
      const msg = (content, extra = {}, finish = 'stop') => ({ choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: finish }] });
      switch (estado.modo) {
        case 'ok': return responder(200, msg(estado.texto));
        case 'http500': return responder(500, { error: 'quebrou' });
        case 'vazio': return responder(200, msg(''));
        case 'espacos': return responder(200, msg('   \n  '));
        case 'raciocinio': return responder(200, msg('<think>vou pensar em como responder isso</think>'));
        case 'reasoning_content': return responder(200, msg('', { reasoning_content: 'pensando, pensando' }));
        case 'json-invalido': return responder(200, null, '{ isto nao e json');
        case 'sem-choices': return responder(200, { choices: [] });
        case 'tool-ok': return responder(200, msg('{"thought":"quer baixar","tool":"download_audio","args":{"url":"https://youtu.be/abc"}}'));
        case 'tool-quebrado': return responder(200, msg('{"thought":"quer baixar","tool":"download_audio","args":{"url":"https://youtu'));
        case 'tool-reply': return responder(200, msg('{"thought":"conversa","tool":"generate_reply","args":{"content":"Oi, tudo bem?"}}'));
        case 'cortada': return responder(200, msg(estado.texto, {}, 'length'));
        case 'redireciona': res.writeHead(302, { location: 'http://127.0.0.1:1/outro' }); res.end(); return;
        case 'trava': return undefined; // nunca responde
        default: return responder(200, msg(estado.texto));
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  return {
    estado, porta, url: `http://127.0.0.1:${porta}/v1`,
    chat: () => estado.requisicoes.filter((r) => r.metodo === 'POST'),
    modelos: () => estado.requisicoes.filter((r) => r.caminho.endsWith('/models')),
    limpar: () => { estado.requisicoes.length = 0; },
    fechar: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
/** Uma porta onde NINGUÉM escuta (o computador desligado): conexão recusada. */
async function portaFechada() {
  const s = await criarServidorFalso();
  const url = s.url;
  await s.fechar();
  return url;
}
// As seções A a G rodam com o fallback `nuvem` (a MESMA chamada cai para a cadeia); a seção H testa o `fechar` (o padrão do código) e os dois valores.
const ligar = (url, extra = {}) => {
  for (const k of ['YUI_IA_LOCAL_PRIVADA', 'YUI_IA_LOCAL_PRIVADA_URL', 'YUI_IA_LOCAL_PRIVADA_MODELO', 'YUI_IA_LOCAL_PRIVADA_TIMEOUT_S', 'YUI_IA_LOCAL_PRIVADA_MAX_TOKENS', 'YUI_IA_LOCAL_PRIVADA_FALLBACK']) delete process.env[k];
  Object.assign(process.env, { YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: url, YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem', ...extra });
};
const desligar = () => { for (const k of Object.keys(process.env)) if (k.startsWith('YUI_IA_LOCAL_PRIVADA')) delete process.env[k]; };
const zerar = () => { L.disjuntorDoProcesso().reiniciar(); L.zerarContadoresLocalPrivada(); chainCalls.length = 0; chainDown = false; lines.length = 0; };

const srv = await criarServidorFalso();

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('A. A chave e o endereço');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
await test('o padrão é DESLIGADO (chave ausente, vazia, off, lixo) e as chaves são lidas a cada uso, não no import', () => {
  for (const v of [undefined, '', 'off', 'false', '0', 'nao', 'talvez', 'onn']) {
    const env = v === undefined ? { YUI_IA_LOCAL_PRIVADA_URL: srv.url } : { YUI_IA_LOCAL_PRIVADA: v, YUI_IA_LOCAL_PRIVADA_URL: srv.url };
    assert.equal(L.chaveLigada(env), false, String(v));
    assert.equal(L.lerConfigLocalPrivada(env).ligada, false, String(v));
    assert.equal(L.lerConfigLocalPrivada(env).base, null, 'desligada: nenhum endereço lido');
  }
  assert.equal(L.localPrivadaLigada({ YUI_IA_LOCAL_PRIVADA: 'on' }), true, 'ligada pelo dono (o endereço é conferido na chamada)');
  assert.equal(L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on' }).ligada, false, 'ligada sem endereço: a rota não recebe nada');
  desligar();
  assert.equal(L.localPrivadaLigada(), false);
  ligar(srv.url);
  assert.equal(L.localPrivadaLigada(), true, 'ligou sem reiniciar');
  process.env.YUI_IA_LOCAL_PRIVADA = 'off';
  assert.equal(L.localPrivadaLigada(), false, 'desligou sem reiniciar');
  for (const v of ['on', 'ON', ' true ', '1', 'sim']) assert.equal(L.chaveLigada({ YUI_IA_LOCAL_PRIVADA: v }), true, v);
  desligar();
});
await test('os padrões: modelo granite-4.0-micro, 20 s para a resposta, 3 s para conectar, 768 tokens; valores fora do intervalo voltam ao padrão', () => {
  const c = L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1234/v1' });
  assert.deepEqual([c.modelo, c.timeoutMs, c.conexaoMs, c.maxTokens, c.base, c.tipoDeHost], ['granite-4.0-micro', 20_000, 3000, 768, 'http://127.0.0.1:1234/v1', 'loopback']);
  const d = L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1234', YUI_IA_LOCAL_PRIVADA_MODELO: 'outro-modelo', YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '5', YUI_IA_LOCAL_PRIVADA_MAX_TOKENS: '256' });
  assert.deepEqual([d.modelo, d.timeoutMs, d.maxTokens, d.base], ['outro-modelo', 5000, 256, 'http://127.0.0.1:1234/v1'], 'sem /v1 no endereço, a Yui acrescenta');
  const e = L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1234/v1', YUI_IA_LOCAL_PRIVADA_MODELO: 'com espaço; rm -rf', YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '9999', YUI_IA_LOCAL_PRIVADA_MAX_TOKENS: '99999' });
  assert.deepEqual([e.modelo, e.timeoutMs, e.maxTokens], ['granite-4.0-micro', 20_000, 768]);
  assert.equal(L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1/v1', YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '1' }).timeoutMs, 20_000, 'abaixo do mínimo: o padrão');
});
await test('aceita só IP privado, loopback, CGNAT do Tailscale, nome .ts.net e .local', () => {
  const bons = [
    ['http://127.0.0.1:1234/v1', 'loopback'], ['http://localhost:1234/v1', 'loopback'], ['http://[::1]:1234/v1', 'loopback'], ['http://127.5.5.5/v1', 'loopback'],
    ['http://10.0.0.7:1234/v1', 'rede-privada'], ['http://172.16.0.1:1234/v1', 'rede-privada'], ['http://172.31.255.1:1234/v1', 'rede-privada'], ['http://192.168.1.50:1234/v1', 'rede-privada'],
    ['http://100.64.0.1:1234/v1', 'tailscale'], ['http://100.126.122.60:1234/v1', 'tailscale'], ['http://100.127.255.255:1234/v1', 'tailscale'],
    ['http://meu-pc.tailnet-1234.ts.net:1234/v1', 'tailscale'], ['http://meu-pc.local:1234/v1', 'nome-local'], ['https://meu-pc.local/v1', 'nome-local'],
  ];
  for (const [url, tipo] of bons) {
    const v = L.validarUrlLocalPrivada(url);
    assert.equal(v.ok, true, url);
    assert.equal(v.tipoDeHost, tipo, url);
    assert.ok(v.base.endsWith('/v1'));
  }
});
await test('recusa qualquer outro endereço: host público, nome comum, credencial na URL, parâmetros, protocolo, faixa vizinha', () => {
  const ruins = [
    'http://8.8.8.8:1234/v1', 'http://1.1.1.1/v1', 'https://api.openai.com/v1', 'http://example.com:1234/v1', 'http://meu-servidor.com/v1',
    'http://user:senha@127.0.0.1:1234/v1', 'http://user@192.168.1.5/v1', 'http://:senha@10.0.0.1/v1',
    'http://127.0.0.1:1234/v1?chave=1', 'http://127.0.0.1:1234/v1#x', 'ftp://127.0.0.1/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://127.0.0.1/v1',
    'http://172.15.0.1/v1', 'http://172.32.0.1/v1', 'http://100.63.255.255/v1', 'http://100.128.0.1/v1', 'http://192.169.0.1/v1', 'http://11.0.0.1/v1',
    'http://ts.net/v1', 'http://local/v1', 'http://127.0.0.1.evil.com/v1', 'http://meu-pc.ts.net.evil.com/v1', 'http://meu-pc.local.evil.com/v1', 'http://[::ffff:8.8.8.8]/v1',
    'http://[2001:db8::1]/v1', '', 'isto não é uma url', undefined, null,
  ];
  for (const url of ruins) {
    const v = L.validarUrlLocalPrivada(url);
    assert.equal(v.ok, false, String(url));
    assert.ok(typeof v.codigo === 'string' && v.codigo.length > 0);
    assert.ok(!JSON.stringify(v).includes('senha') && !JSON.stringify(v).includes('8.8.8.8'), 'o motivo nunca repete o endereço');
    const c = L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: url });
    assert.equal(c.ligada, false, `${url}: ligada com endereço recusado fica FECHADA`);
    assert.equal(c.motivo, 'url-invalida');
    assert.equal(L.localPrivadaLigada({ YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: url }), true, 'o dono ligou: quem chama vai à rota, que recusa o endereço');
  }
});
await test('IP escrito de outro jeito que aponta para fora continua recusado (o analisador normaliza antes)', () => {
  assert.equal(L.validarUrlLocalPrivada('http://0x08080808/v1').ok, false);
  assert.equal(L.validarUrlLocalPrivada('http://134744072/v1').ok, false);
  assert.equal(L.validarUrlLocalPrivada('http://2130706433/v1').ok, true, 'decimal de 127.0.0.1 é a própria máquina');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('B. A resposta só vale inteira e válida; o contexto pequeno nunca estoura');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
await test('resposta vazia, só espaços, só raciocínio e só lixo NÃO servem', () => {
  for (const [texto, motivo] of [['', 'vazia'], ['   \n ', 'vazia'], [undefined, 'vazia'], [null, 'vazia'], ['<think>penso aqui</think>', 'so-raciocinio'], ['<think>penso</think>   ', 'so-raciocinio'], ['<think></think>', 'so-raciocinio'], ['<think><think><think>', 'so-raciocinio'], ['... --- !!!', 'so-raciocinio']]) {
    const r = L.avaliarRespostaLocal(texto);
    assert.equal(r.ok, false, JSON.stringify(texto));
    assert.equal(r.motivo, motivo, JSON.stringify(texto));
  }
});
await test('texto normal, texto depois do raciocínio e chamada de ferramenta escrita como texto servem', () => {
  assert.deepEqual(L.avaliarRespostaLocal('Oi, tudo bem? Posso ajudar.'), { ok: true, texto: 'Oi, tudo bem? Posso ajudar.' });
  assert.equal(L.avaliarRespostaLocal('<think>penso</think>Resposta final.').ok, true);
  assert.equal(L.avaliarRespostaLocal('print(default_api.search_web(query="x"))').ok, true, 'o despachante converte a chamada escrita');
});
await test('JSON de ferramenta: o bem formado passa; o quebrado, o sem chave conhecida e o de ferramenta não oferecida caem', () => {
  const ok = '{"thought":"quer baixar","tool":"download_audio","args":{"url":"https://youtu.be/abc"}}';
  assert.equal(L.avaliarRespostaLocal(ok).ok, true);
  assert.equal(L.avaliarRespostaLocal(ok, { ferramentas: true }).ok, true);
  assert.equal(L.avaliarRespostaLocal(`\`\`\`json\n${ok}\n\`\`\``).ok, true, 'com cerca de código');
  assert.equal(L.avaliarRespostaLocal('{"thought":"x","tool":"download_audio","args":{"url":"https://youtu').motivo, 'json-quebrado');
  assert.equal(L.avaliarRespostaLocal('{ "tool": "download_audio", "args": { "url": ').motivo, 'json-quebrado');
  assert.equal(L.avaliarRespostaLocal('{"coisa":"nada"}').motivo, 'json-desconhecido');
  assert.equal(L.avaliarRespostaLocal(ok, { ferramentas: false }).motivo, 'ferramenta-nao-oferecida');
  assert.equal(L.avaliarRespostaLocal('{"tool":"generate_reply","args":{"content":"Oi"}}', { ferramentas: false }).ok, true, 'a resposta embrulhada em generate_reply vale sem ferramentas');
  assert.equal(L.avaliarRespostaLocal('Use as chaves assim: {nome}').ok, true, 'texto comum com chaves segue como com qualquer provedor');
});
const sistemaGrande = (n) => 'S'.repeat(n);
await test('o contexto: corta o histórico pelo mais antigo, mantém a ordem e começa na fala da pessoa; nunca passa de 4096 tokens', () => {
  const historico = [];
  for (let i = 0; i < 60; i++) historico.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `fala ${i} ${'x'.repeat(300)}` });
  const r = L.montarMensagensLocais({ system: sistemaGrande(3000), history: historico, prompt: 'pergunta final', maxTokens: 768 });
  assert.equal(r.ok, true);
  assert.equal(r.reducao, 'historico');
  assert.equal(r.messages[0].role, 'system');
  assert.deepEqual(r.messages.at(-1), { role: 'user', content: 'pergunta final' });
  const meio = r.messages.slice(1, -1);
  assert.ok(meio.length > 0 && meio.length < 60);
  assert.equal(meio[0].role, 'user', 'começa na fala da pessoa');
  assert.ok(meio.at(-1).content.startsWith('fala 59') || meio.at(-1).content.startsWith('fala 58'), 'ficam as falas MAIS RECENTES');
  const ordenado = meio.map((m) => Number(/fala (\d+)/.exec(m.content)[1]));
  assert.deepEqual(ordenado, [...ordenado].sort((a, b) => a - b));
  const caracteres = r.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(Math.ceil(caracteres / 3) + 8 * r.messages.length + 768 <= L.CONTEXTO_MAX_TOKENS, 'o pedido mais a resposta cabem no contexto');
  assert.equal(L.CONTEXTO_MAX_TOKENS, 4096);
});
await test('sem caber com a memória, usa o prompt SEM a memória; sem caber nem assim, "grande-demais" (vai para a cadeia)', () => {
  const comMemoria = `PERSONA ${'m'.repeat(11_000)}`;
  const semMemoria = 'PERSONA curta';
  const r = L.montarMensagensLocais({ system: comMemoria, sistemaLeve: semMemoria, history: [], prompt: 'oi', maxTokens: 768 });
  assert.equal(r.ok, true);
  assert.equal(r.reducao, 'sem-memoria');
  assert.equal(r.messages[0].content, semMemoria);
  assert.deepEqual(L.montarMensagensLocais({ system: comMemoria, history: [], prompt: 'oi', maxTokens: 768 }), { ok: false, motivo: 'grande-demais' });
  assert.deepEqual(L.montarMensagensLocais({ system: 'curto', history: [], prompt: 'p'.repeat(30_000), maxTokens: 768 }), { ok: false, motivo: 'grande-demais' }, 'o pedido sozinho não cabe');
  assert.equal(L.montarMensagensLocais({ system: 'curto', history: [], prompt: 'oi', maxTokens: 768 }).reducao, null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('C. O disjuntor (relógio falso)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const CFG = { base: 'http://127.0.0.1:9/v1', modelo: 'm', conexaoMs: 3000, timeoutMs: 20_000 };
await test('abre depois de 3 falhas SEGUIDAS (uma boa no meio zera a conta) e não bloqueia: responde "descanso" na hora', () => {
  let t = 1_000_000;
  const d = L.criarDisjuntor({ agora: () => t });
  assert.equal(L.FALHAS_PARA_ABRIR, 3);
  d.falha('timeout'); d.falha('timeout');
  assert.equal(d.permitir({ cfg: CFG }).ok, true, 'duas falhas: ainda tenta');
  d.sucesso();
  d.falha('timeout'); d.falha('timeout');
  assert.equal(d.permitir({ cfg: CFG }).ok, true, 'a boa zerou a conta');
  d.falha('recusada');
  const p = d.permitir({ cfg: CFG });
  assert.deepEqual(p, { ok: false, motivo: 'descanso' });
  assert.equal(d.estado().aberto, true);
  assert.equal(d.estado().descansoSegundos, 30);
});
await test('o descanso cresce: 30 s, 1 min, 2 min, 4 min, 8 min e o teto de 10 min', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 12].map(L.descansoDoNivel), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
});
await test('vencido o descanso, UMA sondagem leve (GET /models) roda em segundo plano; falhou: novo descanso, maior; respondeu: o local volta', async () => {
  let t = 5_000_000;
  const sondas = [];
  let sondaBoa = false;
  const requisitar = async (o) => { sondas.push({ url: o.url, metodo: o.metodo ?? 'GET', corpo: o.corpo ?? null }); if (!sondaBoa) throw Object.assign(new Error('x'), { motivo: 'recusada' }); return { status: 200, texto: '{"data":[{"id":"m"}]}' }; };
  const d = L.criarDisjuntor({ agora: () => t });
  for (let i = 0; i < 3; i++) d.falha('timeout');
  t += 29_000;
  assert.deepEqual(d.permitir({ cfg: CFG, requisitar }), { ok: false, motivo: 'descanso' });
  assert.equal(sondas.length, 0, 'antes do fim do descanso não há sondagem');
  t += 2_000; // 31 s
  const antes = Date.now();
  assert.deepEqual(d.permitir({ cfg: CFG, requisitar }), { ok: false, motivo: 'descanso' }, 'a chamada NÃO espera pela sondagem: vai para a cadeia');
  assert.deepEqual(d.permitir({ cfg: CFG, requisitar }), { ok: false, motivo: 'descanso' }, 'uma sondagem só por vez');
  assert.ok(Date.now() - antes < 500);
  await d.sondagem();
  assert.equal(sondas.length, 1);
  assert.deepEqual(sondas[0], { url: 'http://127.0.0.1:9/v1/models', metodo: 'GET', corpo: null }, 'GET leve, sem conteúdo nenhum');
  assert.equal(d.estado().descansoSegundos, 60, 'a sondagem falhou: descanso maior');
  t += 61_000;
  d.permitir({ cfg: CFG, requisitar });
  await d.sondagem();
  assert.equal(d.estado().descansoSegundos, 120);
  sondaBoa = true;
  t += 121_000;
  d.permitir({ cfg: CFG, requisitar });
  await d.sondagem();
  assert.deepEqual(d.estado(), { falhasSeguidas: 0, aberto: false, descansoSegundos: 0, sondando: false });
  assert.deepEqual(d.permitir({ cfg: CFG, requisitar }), { ok: true });
  for (let i = 0; i < 3; i++) d.falha('timeout');
  assert.equal(d.estado().descansoSegundos, 30, 'o local voltou: o próximo descanso recomeça em 30 s');
});
await test('uma sondagem que responde mas não parece o servidor (HTTP 500, JSON sem "data") não reabilita', async () => {
  let t = 9_000_000;
  const d = L.criarDisjuntor({ agora: () => t });
  for (const resposta of [{ status: 500, texto: '{}' }, { status: 200, texto: 'lixo' }, { status: 200, texto: '{"outra":1}' }]) {
    d.reiniciar();
    for (let i = 0; i < 3; i++) d.falha('timeout');
    t += 31_000;
    d.permitir({ cfg: CFG, requisitar: async () => resposta });
    await d.sondagem();
    assert.equal(d.estado().aberto, true, JSON.stringify(resposta));
  }
});
await test('trocar o endereço ou o modelo esquece o estado do antigo', () => {
  const d = L.criarDisjuntor({ agora: () => 1 });
  d.permitir({ cfg: CFG });
  for (let i = 0; i < 3; i++) d.falha('timeout');
  assert.equal(d.permitir({ cfg: CFG }).ok, false);
  assert.equal(d.permitir({ cfg: { ...CFG, base: 'http://127.0.0.1:10/v1' } }).ok, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('D. A chamada contra o servidor falso');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const chamarCru = (p = {}, deps = {}) => L.chamarLocalPrivada({ system: 'Você é a Yui.', history: [], prompt: `me diga algo ${SEGREDO}`, ...p }, { disjuntor: L.criarDisjuntor(), alertar: () => {}, ...deps });
/** Como o chamarCru, sem o campo `fechar` do fracasso (as seções A a G só olham o motivo; a H olha o `fechar`). */
const chamar = async (p = {}, deps = {}) => { const r = await chamarCru(p, deps); if (r.ok) return r; const { fechar, ...resto } = r; return resto; };
await test('rota ligada e computador no ar: responde pelo local, com o pedido certo (modelo, sem ferramentas nativas, sem stream, sem cabeçalho de autenticação, dentro do contexto)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  const r = await chamar();
  assert.equal(r.ok, true);
  assert.equal(r.texto, RESPOSTA_LOCAL);
  assert.equal(r.modelo, 'granite-4.0-micro');
  assert.equal(srv.chat().length, 1);
  const q = srv.chat()[0];
  assert.equal(q.caminho, '/v1/chat/completions');
  assert.equal(q.corpo.model, 'granite-4.0-micro');
  assert.equal(q.corpo.stream, false);
  assert.equal(q.corpo.max_tokens, 768);
  assert.ok(!('tools' in q.corpo) && !('tool_choice' in q.corpo) && !('functions' in q.corpo), 'o granite não recebe ferramentas nativas');
  assert.equal(q.corpo.messages[0].role, 'system');
  assert.equal(q.corpo.messages.at(-1).content, `me diga algo ${SEGREDO}`);
  assert.equal(q.cabecalhos.authorization, undefined, 'nenhuma chave de API é enviada');
  const chars = q.corpo.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(Math.ceil(chars / 3) + q.corpo.max_tokens <= 4096);
  assert.equal(L.diagnosticoLocalPrivada().respostasLocais, 1);
});
await test('o modelo e o limite de tokens configurados são os que vão no pedido; o prazo da pesquisa encurta o tempo', async () => {
  zerar(); srv.limpar(); ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_MODELO: 'outro-modelo', YUI_IA_LOCAL_PRIVADA_MAX_TOKENS: '300' });
  assert.equal((await chamar()).ok, true);
  assert.equal(srv.chat()[0].corpo.model, 'outro-modelo');
  assert.equal(srv.chat()[0].corpo.max_tokens, 300);
  srv.limpar();
  const sem = await chamar({ deadlineAt: Date.now() + 500 });
  assert.deepEqual(sem, { ok: false, motivo: 'prazo' }, 'prazo quase esgotado: nem tenta');
  assert.equal(srv.chat().length, 0);
});
await test('computador fora (conexão recusada) cai para a cadeia na hora', async () => {
  zerar(); ligar(await portaFechada());
  const t0 = Date.now();
  const r = await chamar();
  assert.deepEqual(r, { ok: false, motivo: 'recusada' });
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(L.diagnosticoLocalPrivada().quedasParaCadeia, 1);
});
await test('computador que não responde: o prazo configurado corta e cai para a cadeia', async () => {
  zerar(); srv.estado.modo = 'trava'; ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '2' });
  const t0 = Date.now();
  const r = await chamar();
  assert.deepEqual(r, { ok: false, motivo: 'timeout' });
  const gasto = Date.now() - t0;
  assert.ok(gasto >= 1800 && gasto < 4500, `gastou ${gasto} ms`);
  srv.estado.modo = 'ok';
});
await test('o prazo para CONECTAR é próprio e curto (um transporte que nunca conecta cai como conexao-timeout)', async () => {
  zerar(); ligar(srv.url);
  const r = await chamar({}, { requisitar: async () => { throw Object.assign(new Error('x'), { motivo: 'conexao-timeout' }); } });
  assert.deepEqual(r, { ok: false, motivo: 'conexao-timeout' });
  assert.equal(L.CONEXAO_MS, 3000);
});
await test('HTTP de erro, JSON inválido, sem escolhas, vazia, só espaços, só raciocínio e raciocínio sem texto: tudo cai para a cadeia, com o motivo certo', async () => {
  const casos = [['http500', 'http-erro'], ['json-invalido', 'json-invalido'], ['sem-choices', 'formato-invalido'], ['vazio', 'vazia'], ['espacos', 'vazia'], ['raciocinio', 'so-raciocinio'], ['reasoning_content', 'so-raciocinio'], ['tool-quebrado', 'json-quebrado'], ['redireciona', 'http-erro']];
  for (const [modo, motivo] of casos) {
    zerar(); srv.limpar(); srv.estado.modo = modo; ligar(srv.url);
    const r = await chamar({ ferramentas: true });
    assert.deepEqual(r, { ok: false, motivo }, modo);
    assert.equal(srv.chat().length, 1, `${modo}: UMA tentativa só`);
  }
  srv.estado.modo = 'ok';
});
await test('JSON de ferramenta bem formado passa pelo mesmo parser (a resposta chega inteira); com ferramentas fechadas ele cai', async () => {
  zerar(); srv.estado.modo = 'tool-ok'; ligar(srv.url);
  const ok = await chamar({ ferramentas: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(ok.texto), { thought: 'quer baixar', tool: 'download_audio', args: { url: 'https://youtu.be/abc' } });
  zerar();
  assert.deepEqual(await chamar({ ferramentas: false }), { ok: false, motivo: 'ferramenta-nao-oferecida' });
  srv.estado.modo = 'ok';
});
await test('a resposta cortada pelo limite de tokens chega com o finish_reason para a continuação', async () => {
  zerar(); srv.estado.modo = 'cortada'; ligar(srv.url);
  const r = await chamar();
  assert.equal(r.ok, true);
  assert.equal(r.finishReason, 'length');
  srv.estado.modo = 'ok';
});
await test('3 falhas seguidas abrem o disjuntor: a 4ª chamada nem toca o servidor', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligar(srv.url);
  const disjuntor = L.criarDisjuntor();
  for (let i = 0; i < 3; i++) assert.equal((await chamar({}, { disjuntor })).motivo, 'http-erro');
  assert.equal(srv.chat().length, 3);
  assert.deepEqual(await chamar({}, { disjuntor }), { ok: false, motivo: 'descanso' });
  assert.equal(srv.chat().length, 3, 'em descanso: nada é enviado');
  srv.estado.modo = 'ok';
});
await test('o "pedido grande demais" não conta como falha do computador e nada é enviado', async () => {
  zerar(); srv.limpar(); ligar(srv.url);
  const disjuntor = L.criarDisjuntor();
  for (let i = 0; i < 5; i++) assert.deepEqual(await chamar({ prompt: 'p'.repeat(40_000) }, { disjuntor }), { ok: false, motivo: 'grande-demais' });
  assert.equal(srv.chat().length, 0);
  assert.equal(disjuntor.estado().aberto, false);
});
await test('chave desligada ou endereço recusado: nada é enviado (nem tentativa de conexão) e nunca lança', async () => {
  zerar(); srv.limpar(); desligar();
  const antes = hostsUsados.length;
  assert.deepEqual(await chamar(), { ok: false, motivo: 'desligada' });
  ligar('http://8.8.8.8:1234/v1');
  assert.deepEqual(await chamar(), { ok: false, motivo: 'url-invalida' });
  ligar('http://user:senha@127.0.0.1:1234/v1');
  assert.deepEqual(await chamar(), { ok: false, motivo: 'url-invalida' });
  assert.equal(hostsUsados.length, antes, 'nenhuma conexão foi aberta');
  assert.equal(srv.chat().length, 0);
  const avisos = lines.filter((l) => l.includes('endereço (YUI_IA_LOCAL_PRIVADA_URL) não é aceito'));
  assert.equal(avisos.length, 1, 'o aviso sai uma vez só');
  assert.ok(!lines.join('\n').includes('8.8.8.8') && !lines.join('\n').includes('senha@') && !lines.join('\n').includes('127.0.0.1'), 'o aviso não repete o endereço');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('E. O llmHandler (processo único): a MESMA chamada tenta o local e cai para a cadeia');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const gerar = (prompt, opcoes = {}, canal = `canal-${Math.random().toString(36).slice(2, 8)}`) => llm.generateResponse(prompt, canal, { allowSearch: false, guildId: GUILD, userId: OWNER, ...opcoes });
await test('PRIVADA + local no ar: responde pelo local e a cadeia nem é chamada', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  const r = await gerar(`oi ${SEGREDO}`, { sensitive: true, disableTools: true });
  assert.ok(r.includes(RESPOSTA_LOCAL), r);
  assert.ok(!r.includes(RESPOSTA_CADEIA));
  assert.equal(srv.chat().length, 1);
  assert.equal(chainCalls.length, 0, 'a cadeia não foi tocada');
});
await test('PRIVADA + computador fora: a MESMA chamada cai para a cadeia, a resposta vem UMA vez, sem erro visível', async () => {
  zerar(); ligar(await portaFechada());
  const r = await gerar(`oi ${SEGREDO}`, { sensitive: true, disableTools: true });
  assert.ok(r.includes(RESPOSTA_CADEIA), r);
  assert.equal(r.split(RESPOSTA_CADEIA).length - 1, 1, 'a resposta aparece uma vez');
  assert.ok(!/Limites de Processamento|erro|⚠️/i.test(r), 'nenhum erro visível');
  assert.equal(chainCalls.length, 1, 'a cadeia foi chamada uma vez');
});
await test('PRIVADA + timeout / HTTP 500 / vazia / só raciocínio / JSON quebrado: cai para a cadeia (uma chamada de cadeia, sem repetir)', async () => {
  for (const modo of ['http500', 'vazio', 'raciocinio', 'reasoning_content', 'tool-quebrado', 'json-invalido']) {
    zerar(); srv.limpar(); srv.estado.modo = modo; ligar(srv.url);
    const r = await gerar(`oi ${SEGREDO}`, { sensitive: true });
    assert.ok(r.includes(RESPOSTA_CADEIA), `${modo}: ${r}`);
    assert.equal(r.split(RESPOSTA_CADEIA).length - 1, 1, modo);
    assert.equal(srv.chat().length, 1, `${modo}: o local foi tentado UMA vez`);
    assert.equal(chainCalls.length, 1, modo);
  }
  zerar(); srv.estado.modo = 'trava'; ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '2' });
  const r = await gerar(`oi ${SEGREDO}`, { sensitive: true });
  assert.ok(r.includes(RESPOSTA_CADEIA), r);
  srv.estado.modo = 'ok';
});
await test('o local e a cadeia fora: o aviso de sempre (a rota local não esconde nem inventa o erro)', async () => {
  zerar(); chainDown = true; ligar(await portaFechada());
  const r = await gerar('oi', { sensitive: true, disableTools: true });
  assert.ok(/Limites de Processamento/.test(r), r);
});
await test('PÚBLICA nunca usa o local: nenhuma requisição ao servidor, a cadeia responde', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  const antes = hostsUsados.length;
  for (const op of [{}, { sensitive: false }, { sensitive: false, disableTools: true }, { guildId: GUILD, userId: MEMBER }, { sensitive: undefined, memoryBlock: undefined }]) {
    const r = await gerar('oi pessoal', op);
    assert.ok(r.includes(RESPOSTA_CADEIA), JSON.stringify(op));
  }
  assert.equal(srv.requisicoes?.length ?? srv.estado.requisicoes.length, 0, 'o servidor local não recebeu NADA (nem a sondagem)');
  assert.equal(hostsUsados.length, antes, 'nenhuma conexão foi aberta');
  assert.equal(L.diagnosticoLocalPrivada().respostasLocais + L.diagnosticoLocalPrivada().quedasParaCadeia, 0, 'a chamada pública nem entra na conta');
});
await test('o texto de ANEXO conta como privado (como o cérebro); o rádio nunca usa o local', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  const anexo = await gerar('resuma isto', { attachmentBlock: `[ANEXO] ${SEGREDO}`, disableTools: true });
  assert.ok(anexo.includes(RESPOSTA_LOCAL), anexo);
  const n = srv.chat().length;
  assert.equal(n, 1);
  const radio = await gerar('toca algo', { sensitive: true, radioMode: true });
  assert.ok(radio.includes(RESPOSTA_CADEIA) || radio.length > 0);
  assert.equal(srv.chat().length, n, 'rádio: o local não foi chamado');
});
await test('com ferramentas ofertadas: o prompt do local leva a lista CURTA no mesmo formato JSON (nunca ferramentas nativas) e cabe no contexto', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  await gerar('oi', { sensitive: true });
  const q = srv.chat()[0];
  const sistema = q.corpo.messages[0].content;
  assert.ok(sistema.includes('--- FERRAMENTAS (versão curta) ---'), 'lista curta');
  assert.ok(!sistema.includes('--- FERRAMENTAS DISPONÍVEIS ---'), 'não a definição completa (15 mil caracteres)');
  assert.ok(sistema.includes('download_audio') && sistema.includes('"tool"'));
  assert.ok(!('tools' in q.corpo));
  const chars = q.corpo.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(Math.ceil(chars / 3) + q.corpo.max_tokens <= 4096, `${chars} caracteres`);
  // sem ferramentas ofertadas: nenhuma lista
  srv.limpar();
  await gerar('oi', { sensitive: true, disableTools: true });
  assert.ok(!srv.chat()[0].corpo.messages[0].content.includes('FERRAMENTAS'));
});
await test('JSON de ferramenta: o bem formado chega ao despachante igual ao de qualquer provedor; o quebrado cai para a cadeia', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'tool-ok'; ligar(srv.url);
  const ok = await gerar('baixa o áudio https://youtu.be/abc', { sensitive: true });
  assert.ok(ok.includes('"tool":"download_audio"'), ok);
  assert.equal(chainCalls.length, 0);
  zerar(); srv.estado.modo = 'tool-quebrado';
  const ruim = await gerar('baixa o áudio https://youtu.be/abc', { sensitive: true });
  assert.ok(ruim.includes(RESPOSTA_CADEIA), ruim);
  zerar(); srv.estado.modo = 'tool-reply';
  const r = await gerar('oi', { sensitive: true });
  assert.ok(r.includes('"tool":"generate_reply"') || r.includes('Oi, tudo bem?'), r);
  srv.estado.modo = 'ok';
});
await test('com as ferramentas FECHADAS na chamada, um JSON de ferramenta do local nunca chega ao usuário: a cadeia responde', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'tool-ok'; ligar(srv.url);
  const r = await gerar('baixa o áudio https://youtu.be/abc', { sensitive: true, disableTools: true });
  assert.ok(r.includes(RESPOSTA_CADEIA), r);
  assert.ok(!r.includes('download_audio'));
  assert.equal(srv.chat().length, 1);
  assert.equal(L.diagnosticoLocalPrivada().motivosDasQuedas['ferramenta-nao-oferecida'], 1);
  srv.estado.modo = 'ok';
});
await test('memória grande demais para 4096 tokens: o local recebe o prompt SEM a memória; pedido gigante vai direto para a cadeia', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  const memoryBlock = `\n[MEMÓRIA]\nMARCA-MEM-QZ7 ${'lembrança '.repeat(1500)}\n`;
  const r = await gerar('oi', { sensitive: true, disableTools: true, memoryBlock });
  assert.ok(r.includes(RESPOSTA_LOCAL), r);
  assert.ok(!srv.chat()[0].corpo.messages[0].content.includes('MARCA-MEM-QZ7'), 'sem a memória');
  assert.equal(chainCalls.length, 0);
  zerar(); srv.limpar();
  const grande = await gerar(`${SEGREDO} ${'texto '.repeat(8000)}`, { sensitive: true, disableTools: true });
  assert.ok(grande.includes(RESPOSTA_CADEIA), grande);
  assert.equal(srv.chat().length, 0, 'não coube: nada foi enviado ao local');
  assert.equal(L.diagnosticoLocalPrivada().motivosDasQuedas['grande-demais'], 1);
});
await test('o disjuntor no llmHandler: 3 falhas seguidas e o local descansa; as chamadas seguintes vão direto à cadeia sem esperar o computador', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligar(srv.url);
  for (let i = 0; i < 3; i++) assert.ok((await gerar(`oi ${i}`, { sensitive: true, disableTools: true })).includes(RESPOSTA_CADEIA));
  assert.equal(srv.chat().length, 3);
  assert.equal(L.diagnosticoLocalPrivada().estado, 'em-descanso');
  const t0 = Date.now();
  assert.ok((await gerar('oi de novo', { sensitive: true, disableTools: true })).includes(RESPOSTA_CADEIA));
  assert.equal(srv.chat().length, 3, 'em descanso: o servidor não foi tocado');
  assert.ok(Date.now() - t0 < 1500);
  srv.estado.modo = 'ok';
});
await test('chave DESLIGADA: nada muda nem um byte (o pedido à cadeia é idêntico com a chave ausente, off e lixo; o servidor local não recebe nada)', async () => {
  const bodies = [];
  for (const v of [undefined, 'off', 'lixo']) {
    zerar(); srv.limpar(); desligar();
    process.env.YUI_IA_LOCAL_PRIVADA_URL = srv.url;
    if (v !== undefined) process.env.YUI_IA_LOCAL_PRIVADA = v;
    for (const op of [{ sensitive: true }, { sensitive: true, disableTools: true }, {}]) await gerar('pergunta fixa do retrato', op, 'canal-retrato');
    bodies.push(JSON.stringify(chainCalls.map((c) => ({ url: c.url, messages: c.body.messages, model: c.body.model, max_tokens: c.body.max_tokens, tools: c.body.tools }))));
    assert.equal(srv.estado.requisicoes.length, 0, `${v}: o local não recebeu nada`);
    assert.equal(chainCalls.length, 3);
  }
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[0], bodies[2]);
  desligar();
});
await test('ligada, a chamada PÚBLICA manda à cadeia exatamente o mesmo pedido que com a chave desligada', async () => {
  const captura = async (ligada) => {
    zerar(); srv.limpar(); desligar();
    if (ligada) ligar(srv.url);
    await gerar('pergunta pública do retrato', {}, 'canal-publico');
    await gerar('pergunta pública sem ferramentas', { disableTools: true }, 'canal-publico2');
    return JSON.stringify(chainCalls.map((c) => ({ messages: c.body.messages, model: c.body.model, max_tokens: c.body.max_tokens })));
  };
  assert.equal(await captura(true), await captura(false));
  desligar();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('F. O AI Manager (app e cérebro separado) e a conversa do cérebro');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const CTX_DONO = { userId: OWNER, platform: 'discord', role: 'OWNER', memoryScope: 'personal', channelKind: 'dm', guildId: null };
const CTX_PUBLICO = { userId: MEMBER, platform: 'discord', role: 'MEMBER', memoryScope: 'public', channelKind: 'public', guildId: GUILD };
let backendChamadas = [];
function registrarBackendFalso(extra = {}) {
  backendChamadas = [];
  ai.registerBackend({ name: 'falso', local: false, async chat(a) { backendChamadas.push(a); return 'RESPOSTA-DO-BACKEND'; }, ...extra }, { activate: true });
}
await test('manager: privada + local no ar responde pelo local e o backend não é chamado; o histórico e a memória vão (cortados), sem ferramentas nativas', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url); registrarBackendFalso();
  const r = await ai.chat({ prompt: `oi ${SEGREDO}`, history: [{ role: 'user', content: 'antes' }, { role: 'assistant', content: 'resposta antes' }], ctx: CTX_DONO, memoryBlock: '\n[MEM] gosta de café\n' });
  assert.equal(r, RESPOSTA_LOCAL);
  assert.equal(backendChamadas.length, 0);
  const m = srv.chat()[0].corpo.messages;
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user']);
  assert.ok(m[0].content.includes('gosta de café'));
  assert.ok(!('tools' in srv.chat()[0].corpo));
});
await test('manager: local fora, vazio ou quebrado: o backend de sempre atende a MESMA chamada, com os mesmos argumentos', async () => {
  for (const modo of ['fora', 'vazio', 'tool-quebrado', 'http500']) {
    zerar(); srv.limpar(); registrarBackendFalso();
    if (modo === 'fora') ligar(await portaFechada()); else { srv.estado.modo = modo; ligar(srv.url); }
    const r = await ai.chat({ prompt: 'oi', ctx: CTX_DONO, memoryBlock: '' });
    assert.equal(r, 'RESPOSTA-DO-BACKEND', modo);
    assert.equal(backendChamadas.length, 1, modo);
    assert.equal(backendChamadas[0].prompt, 'oi');
  }
  srv.estado.modo = 'ok';
});
await test('manager: pública nunca usa o local; sensitive explícito e escopo pessoal usam; `localPrivada.privada` vence (memória pública no prompt não leva ao local)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url); registrarBackendFalso();
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO }), 'RESPOSTA-DO-BACKEND');
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO, sensitive: false }), 'RESPOSTA-DO-BACKEND');
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO, sensitive: true, localPrivada: { privada: false } }), 'RESPOSTA-DO-BACKEND', 'o cérebro disse que não é privada');
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_DONO, sensitive: true, localPrivada: { privada: false } }), 'RESPOSTA-DO-BACKEND', 'a decisão explícita vence');
  assert.equal(srv.estado.requisicoes.length, 0);
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO, sensitive: true }), RESPOSTA_LOCAL, 'sensitive sem decisão explícita');
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO, localPrivada: { privada: true } }), RESPOSTA_LOCAL);
  assert.equal(await ai.isolatedChat({ prompt: 'síntese', ctx: CTX_DONO, sensitive: true }), RESPOSTA_LOCAL);
  assert.equal(await ai.isolatedChat({ prompt: 'síntese', ctx: CTX_PUBLICO, sensitive: false }), 'RESPOSTA-DO-BACKEND');
});
await test('manager: o backend legacy-chain (a cadeia do bot) não repete o local: quem tenta é o llmHandler', async () => {
  zerar(); srv.limpar(); ligar(srv.url); registrarBackendFalso({ cadeiaTemLocalPrivada: true });
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_DONO }), 'RESPOSTA-DO-BACKEND');
  assert.equal(srv.estado.requisicoes.length, 0);
  const lista = ai.listBackends();
  assert.ok(lista.some((b) => b.name === 'legacy-chain'));
  ai.initAiManager();
});
await test('manager: chave desligada, a chamada ao backend é idêntica (nenhum campo novo)', async () => {
  zerar(); srv.limpar(); desligar(); registrarBackendFalso();
  await ai.chat({ prompt: 'oi', ctx: CTX_DONO, sensitive: true });
  assert.deepEqual(Object.keys(backendChamadas[0]).sort(), ['ctx', 'history', 'memoryBlock', 'prompt', 'sensitive', 'system']);
  assert.equal(srv.estado.requisicoes.length, 0);
  ai.initAiManager();
});

// A conversa do CÉREBRO: o `sensitive` vem dos FATOS (memória pessoal, texto de anexo), nunca de uma afirmação do bot.
const FERRAMENTA = { type: 'function', function: { name: 'ferramenta_x', description: 'Faz a coisa X.', textual_triggers: 'Quando pedirem a coisa X.', textual_args: '{}', parameters: { type: 'object', properties: {}, required: [] } } };
const cerebroLogger = { debug() {}, info() {}, warn() {}, error() {} };
function cerebro(env = {}, { memoria = '' } = {}) {
  const calls = [];
  const fake = { calls, listBackends: () => [{ name: 'falsa', active: true }], async chat(a) { calls.push(a); return 'resposta'; } };
  const brain = conversa.createChatBrain({ ai: fake, logger: cerebroLogger, env: { ...env }, persona: () => 'PERSONA-DE-TESTE', memoryBlock: () => memoria, tools: () => [FERRAMENTA], context: { enabled: () => false } });
  return { brain, calls };
}
let idSeq = 800000000000000000n;
function turno({ user = OWNER, guild = null, channel = DMCH, text = 'oi', options = {}, call = {} } = {}) {
  return {
    turn: { id: String(++idSeq), at: Date.now() - 1000 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry: 'fila', type: 'mention', mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false, ...call },
    ownText: text, memoryQuery: text, channel: { toolsActive: ['ferramenta_x'], toolsDisabled: [] }, step: 1, prompt: `user: "${text}"`, options: { main: true, persona: true, memory: true, ...options },
  };
}
const META = { role: 'bot' };
const ON = { YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1234/v1' };
await test('cérebro: chave desligada, a chamada de IA é IDÊNTICA (nenhum campo novo) em todas as situações', async () => {
  const situacoes = [
    { text: 'oi' }, { user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }, { user: MEMBER, text: 'oi' }, { guild: GUILD, channel: PRIV, text: 'oi' },
    { text: 'oi', options: { attachment: true } }, { text: 'oi', options: { noTools: true } }, { user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi', options: { attachment: true } },
  ];
  for (const s of situacoes) {
    const base = cerebro({});
    await base.brain.turn(turno(s), META);
    for (const v of [{ YUI_IA_LOCAL_PRIVADA: 'off' }, { YUI_IA_LOCAL_PRIVADA: 'lixo', YUI_IA_LOCAL_PRIVADA_URL: ON.YUI_IA_LOCAL_PRIVADA_URL }, { YUI_IA_LOCAL_PRIVADA_URL: ON.YUI_IA_LOCAL_PRIVADA_URL }]) {
      const c = cerebro(v);
      await c.brain.turn(turno(s), META);
      assert.equal(JSON.stringify(c.calls[0]), JSON.stringify(base.calls[0]), JSON.stringify(s));
      assert.ok(!('localPrivada' in c.calls[0]));
    }
  }
});
await test('cérebro: ligada, o dono em DM (escopo pessoal, dos FATOS) e o texto de anexo são privados; o membro no servidor, não', async () => {
  const dono = cerebro(ON);
  await dono.brain.turn(turno({ text: 'oi' }), META);
  assert.equal(dono.calls[0].localPrivada.privada, true);
  assert.equal(dono.calls[0].sensitive, true);
  const privadoNoCanal = cerebro(ON);
  await privadoNoCanal.brain.turn(turno({ guild: GUILD, channel: PRIV, text: 'oi' }), META);
  assert.equal(privadoNoCanal.calls[0].localPrivada.privada, true, 'canal privado do dono');
  const membro = cerebro(ON);
  await membro.brain.turn(turno({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
  assert.equal(membro.calls[0].localPrivada.privada, false);
  assert.ok(!('system' in membro.calls[0].localPrivada), 'a chamada pública não monta prompt para o local');
  const donoPublico = cerebro(ON);
  await donoPublico.brain.turn(turno({ guild: GUILD, channel: CHAN, text: 'oi' }), META);
  assert.equal(donoPublico.calls[0].localPrivada.privada, false, 'o dono em canal público: público');
  const anexo = cerebro(ON);
  await anexo.brain.turn(turno({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi', options: { attachment: true } }), META);
  assert.equal(anexo.calls[0].localPrivada.privada, true, 'texto de anexo');
});
await test('cérebro: memória pública no prompt NÃO leva a chamada ao computador do dono (é só "não anônimo")', async () => {
  const c = cerebro(ON, { memoria: '\n[MEMÓRIA PÚBLICA] gosta de gatos\n' });
  await c.brain.turn(turno({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
  assert.equal(c.calls[0].sensitive, true, 'continua sem provedor anônimo, como sempre');
  assert.equal(c.calls[0].localPrivada.privada, false);
});
await test('cérebro: o prompt para o local leva as ferramentas em versão CURTA, uma versão sem a memória e a marca de que há ferramentas; sem ferramentas, nada disso', async () => {
  const c = cerebro(ON, { memoria: '\n[MEMÓRIA] MARCA-MEM-QZ7\n' });
  await c.brain.turn(turno({ text: 'oi' }), META);
  const a = c.calls[0];
  assert.ok(a.system.includes('--- FERRAMENTAS DISPONÍVEIS ---'), 'o prompt normal segue com a definição completa');
  assert.ok(a.localPrivada.system.includes('--- FERRAMENTAS (versão curta) ---') && a.localPrivada.system.includes('ferramenta_x'));
  assert.ok(!a.localPrivada.system.includes('--- FERRAMENTAS DISPONÍVEIS ---'));
  assert.ok(a.localPrivada.system.includes('MARCA-MEM-QZ7') && !a.localPrivada.sistemaLeve.includes('MARCA-MEM-QZ7'));
  assert.equal(a.localPrivada.ferramentas, true);
  const sem = cerebro(ON);
  await sem.brain.turn(turno({ text: 'oi', options: { noTools: true } }), META);
  assert.equal(sem.calls[0].localPrivada.ferramentas, false);
  assert.ok(!sem.calls[0].localPrivada.system.includes('FERRAMENTAS'));
});
await test('cérebro de ponta a ponta com o manager: privada responde pelo local; computador fora cai para o backend', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url); registrarBackendFalso();
  const calls = [];
  const brain = conversa.createChatBrain({ ai, logger: cerebroLogger, env: { ...process.env }, persona: () => 'PERSONA-DE-TESTE', memoryBlock: () => '', tools: () => [FERRAMENTA], context: { enabled: () => false } });
  const r = await brain.turn(turno({ text: `oi ${SEGREDO}` }), META);
  assert.ok(String(r.text).includes(RESPOSTA_LOCAL), JSON.stringify(r).slice(0, 200));
  assert.equal(backendChamadas.length, 0);
  const sistema = srv.chat()[0].corpo.messages[0].content;
  assert.ok(sistema.includes('ferramenta_x') && !sistema.includes('--- FERRAMENTAS DISPONÍVEIS ---'));
  const publico = await brain.turn(turno({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
  assert.ok(String(publico.text).includes('RESPOSTA-DO-BACKEND'));
  assert.equal(srv.chat().length, 1, 'a chamada pública não tocou o local');
  zerar(); ligar(await portaFechada());
  const fora = await brain.turn(turno({ text: 'oi de novo' }), META);
  assert.ok(String(fora.text).includes('RESPOSTA-DO-BACKEND'), 'caiu para o backend');
  assert.equal(calls.length, 0);
  ai.initAiManager();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('G. Observabilidade sem vazamento');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
await test('o log leva só metadados (rota, latência, motivo, TIPO do host): nunca o conteúdo, a resposta, o endereço nem a porta', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligar(srv.url);
  await gerar(`conteúdo ${SEGREDO}`, { sensitive: true, disableTools: true });
  srv.estado.modo = 'http500';
  await gerar(`conteúdo ${SEGREDO}`, { sensitive: true, disableTools: true });
  ligar(await portaFechada());
  await gerar(`conteúdo ${SEGREDO}`, { sensitive: true, disableTools: true });
  srv.estado.modo = 'ok';
  const tudo = lines.join('\n');
  assert.ok(tudo.includes('rota=local-privada'), tudo);
  assert.ok(tudo.includes('rota=cadeia motivo=http-erro'));
  assert.ok(tudo.includes('rota=cadeia motivo=recusada'));
  assert.ok(/host=loopback/.test(tudo));
  assert.ok(/ms=\d+/.test(tudo));
  for (const proibido of [SEGREDO, RESPOSTA_LOCAL, '127.0.0.1', `:${srv.porta}`, 'localhost']) assert.ok(!tudo.includes(proibido), `o log tem "${proibido}"`);
});
await test('o diagnóstico: só estado, números e palavras fixas (o tipo do endereço, nunca o endereço); só aparece com a chave ligada', async () => {
  zerar(); srv.estado.modo = 'ok'; desligar();
  assert.equal(L.diagnosticoLocalPrivada().estado, 'desligada');
  const d0 = diag.montarDiagnostico({ modo: 'unico', fontes: {} });
  assert.ok(!('iaLocalPrivada' in d0), 'desligada: o diagnóstico é idêntico ao de antes');
  ligar(srv.url);
  await gerar('oi', { sensitive: true, disableTools: true });
  const d = diag.montarDiagnostico({ modo: 'unico', fontes: {} });
  assert.ok('iaLocalPrivada' in d);
  assert.deepEqual(Object.keys(d.iaLocalPrivada).sort(), ['descansoSegundos', 'estado', 'falhasSeguidas', 'fallback', 'modelo', 'motivosDasQuedas', 'quedasParaCadeia', 'respostasFechadas', 'respostasLocais', 'tipoDeHost', 'ultimaLatenciaMs', 'ultimoMotivo']);
  assert.equal(d.iaLocalPrivada.estado, 'ativa');
  assert.equal(d.iaLocalPrivada.tipoDeHost, 'loopback');
  assert.equal(d.iaLocalPrivada.respostasLocais, 1);
  const texto = JSON.stringify(d);
  for (const proibido of ['127.0.0.1', String(srv.porta), SEGREDO, RESPOSTA_LOCAL]) assert.ok(!texto.includes(proibido), `o diagnóstico tem "${proibido}"`);
  ligar('http://8.8.8.8:1234/v1');
  const dInvalida = diag.montarDiagnostico({ modo: 'unico', fontes: {} });
  assert.equal(dInvalida.iaLocalPrivada.estado, 'url-invalida');
  assert.equal(dInvalida.iaLocalPrivada.tipoDeHost, null);
  assert.ok(!JSON.stringify(dInvalida).includes('8.8.8.8'));
});
await test('o diagnóstico mostra o descanso do disjuntor e não aceita motivo ou estado inventado', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligar(srv.url);
  for (let i = 0; i < 3; i++) await gerar(`oi ${i}`, { sensitive: true, disableTools: true });
  const d = diag.montarDiagnostico({ modo: 'unico', fontes: {} }).iaLocalPrivada;
  assert.equal(d.estado, 'em-descanso');
  assert.equal(d.falhasSeguidas, 3);
  assert.ok(d.descansoSegundos > 0 && d.descansoSegundos <= 30);
  assert.equal(d.quedasParaCadeia, 3);
  assert.deepEqual(d.motivosDasQuedas, { 'http-erro': 3 });
  const forjado = diag.montarDiagnostico({ modo: 'unico', fontes: { iaLocalPrivada: { estado: 'ativa', tipoDeHost: '8.8.8.8', modelo: 'chave sk-123 secreta', motivosDasQuedas: { 'segredo-aqui': 5, timeout: 2 }, ultimoMotivo: 'conteudo-privado', respostasLocais: 1 } } }).iaLocalPrivada;
  assert.equal(forjado.tipoDeHost, null);
  assert.equal(forjado.modelo, null);
  assert.deepEqual(forjado.motivosDasQuedas, { timeout: 2 });
  assert.equal(forjado.ultimoMotivo, null);
  srv.estado.modo = 'ok';
});
await test('o conteúdo privado só foi para o endereço configurado: toda conexão aberta neste teste foi para 127.0.0.1', () => {
  assert.ok(hostsUsados.length > 20);
  assert.deepEqual([...new Set(hostsUsados)], ['127.0.0.1']);
});
await test('não segue redirecionamento (a resposta 3xx é tratada como erro e nada vai ao destino do redirecionamento)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'redireciona'; ligar(srv.url);
  assert.deepEqual(await chamar(), { ok: false, motivo: 'http-erro' });
  assert.deepEqual([...new Set(hostsUsados)], ['127.0.0.1']);
  srv.estado.modo = 'ok';
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('H. O fallback: `fechar` (padrão do código) e `nuvem`');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const ligarFechar = (url, extra = {}) => { ligar(url, extra); delete process.env.YUI_IA_LOCAL_PRIVADA_FALLBACK; }; // a chave NÃO escrita: o padrão do código
await test('o padrão do código é `fechar` (chave ausente, vazia, lixo); só `nuvem` (qualquer caixa) liga a nuvem; lida a cada uso', () => {
  assert.equal(L.FALLBACK_PADRAO, 'fechar');
  const base = { YUI_IA_LOCAL_PRIVADA: 'on', YUI_IA_LOCAL_PRIVADA_URL: 'http://127.0.0.1:1234/v1' };
  for (const v of [undefined, '', 'fechar', 'FECHAR', 'talvez', 'cloud', 'nuvem2', 'on', '1', 'true']) {
    assert.equal(L.lerConfigLocalPrivada(v === undefined ? base : { ...base, YUI_IA_LOCAL_PRIVADA_FALLBACK: v }).fallback, 'fechar', String(v));
  }
  for (const v of ['nuvem', 'NUVEM', ' Nuvem ']) assert.equal(L.lerConfigLocalPrivada({ ...base, YUI_IA_LOCAL_PRIVADA_FALLBACK: v }).fallback, 'nuvem', v);
  assert.equal(L.lerConfigLocalPrivada({ YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' }).fallback, 'nuvem', 'a escolha do fallback não depende do resto');
  desligar();
  assert.equal(L.fallbackLocalPrivada(), 'fechar');
  process.env.YUI_IA_LOCAL_PRIVADA_FALLBACK = 'nuvem';
  assert.equal(L.fallbackLocalPrivada(), 'nuvem', 'mudou sem reiniciar');
  process.env.YUI_IA_LOCAL_PRIVADA_FALLBACK = 'fechar';
  assert.equal(L.fallbackLocalPrivada(), 'fechar');
  desligar();
});
await test('fechar: toda falha do local volta com `fechar: true`; nuvem volta `fechar: false`; a resposta boa não muda', async () => {
  const casos = [['http500', 'http-erro'], ['vazio', 'vazia'], ['raciocinio', 'so-raciocinio'], ['tool-quebrado', 'json-quebrado'], ['json-invalido', 'json-invalido']];
  for (const [modo, motivo] of casos) {
    zerar(); srv.estado.modo = modo; ligarFechar(srv.url);
    assert.deepEqual(await chamarCru({ ferramentas: true }), { ok: false, motivo, fechar: true }, `fechar/${modo}`);
    zerar(); srv.estado.modo = modo; ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' });
    assert.deepEqual(await chamarCru({ ferramentas: true }), { ok: false, motivo, fechar: false }, `nuvem/${modo}`);
  }
  zerar(); ligarFechar(await portaFechada());
  assert.deepEqual(await chamarCru(), { ok: false, motivo: 'recusada', fechar: true });
  zerar(); srv.estado.modo = 'ok'; ligarFechar(srv.url);
  assert.equal((await chamarCru()).ok, true, 'o local no ar responde igual nos dois fallbacks');
  zerar(); desligar();
  assert.deepEqual(await chamarCru(), { ok: false, motivo: 'desligada', fechar: false }, 'rota desligada: nunca fecha nada');
  srv.estado.modo = 'ok';
});
await test('fechar: pedido grande demais, descanso do disjuntor e prazo também fecham (nada vai à nuvem)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligarFechar(srv.url);
  assert.deepEqual(await chamarCru({ prompt: 'p'.repeat(40_000) }), { ok: false, motivo: 'grande-demais', fechar: true });
  assert.deepEqual(await chamarCru({ deadlineAt: Date.now() + 300 }), { ok: false, motivo: 'prazo', fechar: true });
  const disjuntor = L.criarDisjuntor();
  srv.estado.modo = 'http500';
  for (let i = 0; i < 3; i++) await chamarCru({}, { disjuntor });
  assert.deepEqual(await chamarCru({}, { disjuntor }), { ok: false, motivo: 'descanso', fechar: true });
  srv.estado.modo = 'ok';
});
await test('fechar: o endereço recusado (ligada com URL ruim) FECHA a conversa privada em vez de mandá-la à nuvem; com nuvem, vai à cadeia', async () => {
  zerar(); const antes = hostsUsados.length;
  for (const url of ['http://8.8.8.8:1234/v1', 'http://user:senha@127.0.0.1:1234/v1', '', 'lixo']) {
    ligarFechar(url);
    assert.deepEqual(await chamarCru(), { ok: false, motivo: 'url-invalida', fechar: true }, url);
    ligar(url, { YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' });
    assert.deepEqual(await chamarCru(), { ok: false, motivo: 'url-invalida', fechar: false }, url);
  }
  assert.equal(hostsUsados.length, antes, 'nenhuma conexão aberta');
});
await test('fechar no llmHandler: computador fora, vazio, só raciocínio, JSON quebrado, 500 e prazo: a resposta é a FRASE FIXA e a cadeia NUNCA é chamada', async () => {
  const modos = ['fora', 'http500', 'vazio', 'raciocinio', 'reasoning_content', 'tool-quebrado', 'json-invalido', 'trava'];
  for (const modo of modos) {
    zerar(); srv.limpar(); srv.estado.modo = modo === 'fora' ? 'ok' : modo;
    ligarFechar(modo === 'fora' ? await portaFechada() : srv.url, modo === 'trava' ? { YUI_IA_LOCAL_PRIVADA_TIMEOUT_S: '2' } : {});
    const r = await gerar(`conteúdo ${SEGREDO}`, { sensitive: true });
    assert.equal(r, L.TEXTO_ROTA_PRIVADA_FORA, modo);
    assert.equal(chainCalls.length, 0, `${modo}: a cadeia não foi chamada`);
    assert.ok(!r.includes(SEGREDO) && !r.includes('127.0.0.1'), 'a frase não leva conteúdo nem endereço');
    assert.ok(isSystemReply(r) && isErrorReply(r), 'o bot reconhece como resposta de sistema (não vira fala da Yui no contexto)');
  }
  srv.estado.modo = 'ok';
});
await test('fechar no llmHandler: pedido gigante responde a frase do "grande demais" (sem tocar o local nem a cadeia); anexo privado e ferramentas fechadas também fecham', async () => {
  zerar(); srv.limpar(); ligarFechar(srv.url);
  const grande = await gerar(`${SEGREDO} ${'texto '.repeat(8000)}`, { sensitive: true, disableTools: true });
  assert.equal(grande, L.TEXTO_ROTA_PRIVADA_GRANDE);
  assert.equal(srv.chat().length, 0);
  assert.equal(chainCalls.length, 0);
  assert.ok(isSystemReply(grande) && isErrorReply(grande));
  zerar(); srv.estado.modo = 'tool-ok';
  const ferr = await gerar('baixa o áudio https://youtu.be/abc', { sensitive: true, disableTools: true });
  assert.equal(ferr, L.TEXTO_ROTA_PRIVADA_FORA);
  zerar(); srv.estado.modo = 'http500';
  const anexo = await gerar('resuma', { attachmentBlock: `[ANEXO] ${SEGREDO}`, disableTools: true });
  assert.equal(anexo, L.TEXTO_ROTA_PRIVADA_FORA);
  assert.equal(chainCalls.length, 0);
  srv.estado.modo = 'ok';
});
await test('fechar no llmHandler: com o computador no ar responde pelo local normalmente; a chamada PÚBLICA segue pela cadeia (nunca é fechada nem toca o local)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'ok'; ligarFechar(srv.url);
  const r = await gerar('oi', { sensitive: true, disableTools: true });
  assert.ok(r.includes(RESPOSTA_LOCAL), r);
  assert.equal(chainCalls.length, 0);
  const n = srv.chat().length;
  const pub = await gerar('oi pessoal', {});
  assert.ok(pub.includes(RESPOSTA_CADEIA), pub);
  assert.equal(srv.chat().length, n, 'a pública não tocou o local');
  zerar(); srv.estado.modo = 'http500';
  assert.ok((await gerar('oi pessoal', { disableTools: true })).includes(RESPOSTA_CADEIA), 'com o local quebrado a pública segue normal');
  const radio = await gerar('toca algo', { sensitive: true, radioMode: true });
  assert.ok(!radio.includes('Rota privada de IA'), 'o rádio nunca passa pela rota privada');
  srv.estado.modo = 'ok';
});
await test('fechar no llmHandler: depois de 3 falhas o disjuntor responde a frase na hora, sem esperar o computador e sem tocar o servidor', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligarFechar(srv.url);
  for (let i = 0; i < 3; i++) assert.equal(await gerar(`oi ${i}`, { sensitive: true, disableTools: true }), L.TEXTO_ROTA_PRIVADA_FORA);
  assert.equal(srv.chat().length, 3);
  const t0 = Date.now();
  assert.equal(await gerar('oi de novo', { sensitive: true, disableTools: true }), L.TEXTO_ROTA_PRIVADA_FORA);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(srv.chat().length, 3);
  assert.equal(chainCalls.length, 0);
  srv.estado.modo = 'ok';
});
await test('fechar: o log e o diagnóstico mostram só metadados (rota=fechada, motivo, tipo do host): nunca o conteúdo, a frase do usuário nem o endereço', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligarFechar(srv.url);
  await gerar(`conteúdo ${SEGREDO}`, { sensitive: true });
  ligarFechar(await portaFechada());
  await gerar(`conteúdo ${SEGREDO}`, { sensitive: true });
  const tudo = lines.join('\n');
  assert.ok(tudo.includes('rota=fechada motivo=http-erro') && tudo.includes('rota=fechada motivo=recusada'), tudo);
  assert.ok(!tudo.includes('rota=cadeia'), 'nada de cadeia');
  for (const proibido of [SEGREDO, RESPOSTA_LOCAL, '127.0.0.1', `:${srv.porta}`]) assert.ok(!tudo.includes(proibido), `o log tem "${proibido}"`);
  const d = L.diagnosticoLocalPrivada();
  assert.equal(d.fallback, 'fechar');
  assert.equal(d.respostasFechadas, 2);
  assert.equal(d.quedasParaCadeia, 0);
  assert.ok(!JSON.stringify(diag.montarDiagnostico({ modo: 'unico', fontes: {} })).includes(SEGREDO));
  srv.estado.modo = 'ok';
});
await test('nuvem no llmHandler: o mesmo computador fora cai para a cadeia (a diferença para o `fechar`), com o risco documentado: o conteúdo vai ao provedor da cadeia', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' });
  const r = await gerar(`conteúdo ${SEGREDO}`, { sensitive: true });
  assert.ok(r.includes(RESPOSTA_CADEIA), r);
  assert.equal(chainCalls.length, 1);
  assert.ok(JSON.stringify(chainCalls[0].body).includes(SEGREDO), 'com `nuvem` o conteúdo privado chega ao provedor da cadeia (é o risco que o dono aceita ao escolher esse valor)');
  assert.equal(L.diagnosticoLocalPrivada().quedasParaCadeia, 1);
  assert.equal(L.diagnosticoLocalPrivada().respostasFechadas, 0);
  srv.estado.modo = 'ok';
});
await test('fechar no manager: lança a falha fechada (code PERFIL_FECHADO) e NÃO chama o backend nem o perfil; nuvem chama o backend; pública nunca fecha', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligarFechar(srv.url); registrarBackendFalso();
  for (const chamada of [() => ai.chat({ prompt: `oi ${SEGREDO}`, ctx: CTX_DONO }), () => ai.isolatedChat({ prompt: `oi ${SEGREDO}`, ctx: CTX_DONO, sensitive: true })]) {
    let erro = null;
    try { await chamada(); } catch (e) { erro = e; }
    assert.ok(erro, 'lançou');
    assert.equal(erro.code, 'PERFIL_FECHADO');
    assert.equal(erro.mensagemCurta, L.TEXTO_ROTA_PRIVADA_FORA);
    assert.equal(erro.motivo, 'http-erro');
    assert.ok(!String(erro.message).includes(SEGREDO));
  }
  assert.equal(backendChamadas.length, 0, 'o backend não foi chamado');
  zerar(); srv.estado.modo = 'http500'; ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' });
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_DONO }), 'RESPOSTA-DO-BACKEND');
  zerar(); ligarFechar(srv.url);
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_PUBLICO }), 'RESPOSTA-DO-BACKEND', 'pública: nunca fechada');
  zerar(); ligarFechar(srv.url); registrarBackendFalso({ cadeiaTemLocalPrivada: true });
  assert.equal(await ai.chat({ prompt: 'oi', ctx: CTX_DONO }), 'RESPOSTA-DO-BACKEND', 'a cadeia do bot decide sozinha (llmHandler)');
  srv.estado.modo = 'ok';
  ai.initAiManager();
});
await test('fechar no cérebro: a conversa privada com o computador fora responde a frase fixa (como a rota privada fechada), sem chamar o backend e sem o aviso de "IA fora"; a pública segue', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligarFechar(srv.url); registrarBackendFalso();
  const brain = conversa.createChatBrain({ ai, logger: cerebroLogger, env: { ...process.env }, persona: () => 'PERSONA-DE-TESTE', memoryBlock: () => '', tools: () => [FERRAMENTA], context: { enabled: () => false } });
  const r = await brain.turn(turno({ text: `oi ${SEGREDO}` }), META);
  assert.equal(r.text, L.TEXTO_ROTA_PRIVADA_FORA, JSON.stringify(r).slice(0, 200));
  assert.equal(backendChamadas.length, 0);
  const pub = await brain.turn(turno({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
  assert.ok(String(pub.text).includes('RESPOSTA-DO-BACKEND'));
  srv.estado.modo = 'ok';
  ai.initAiManager();
});
await test('fechar avisa o dono UMA vez por falha (só a palavra do motivo, nunca o conteúdo); nuvem e o pedido grande não avisam', async () => {
  const avisos = [];
  const alertar = (...a) => avisos.push(a);
  zerar(); srv.estado.modo = 'http500'; ligarFechar(srv.url);
  await chamarCru({}, { alertar });
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0][0], 'ia-local-privada-fora');
  assert.ok(!JSON.stringify(avisos).includes(SEGREDO) && !JSON.stringify(avisos).includes('127.0.0.1'));
  assert.match(avisos[0][2], /motivo: http-erro/);
  assert.equal(avisos[0][3].cooldownMinutes, 30);
  await chamarCru({ prompt: 'p'.repeat(40_000) }, { alertar });
  assert.equal(avisos.length, 1, 'pedido grande não avisa');
  ligar(srv.url, { YUI_IA_LOCAL_PRIVADA_FALLBACK: 'nuvem' });
  await chamarCru({}, { alertar });
  assert.equal(avisos.length, 1, 'nuvem não avisa');
  ligarFechar(srv.url);
  assert.deepEqual(await chamarCru({}, { alertar: () => { throw new Error('alerta quebrou'); } }), { ok: false, motivo: 'http-erro', fechar: true }, 'um alerta que quebra nunca derruba a chamada');
  srv.estado.modo = 'ok';
});
await test('o diagnóstico mostra o fallback e a falta do computador (em descanso = atenção; endereço recusado = problema)', async () => {
  zerar(); srv.limpar(); srv.estado.modo = 'http500'; ligarFechar(srv.url);
  for (let i = 0; i < 3; i++) await gerar(`oi ${i}`, { sensitive: true, disableTools: true });
  const d = diag.montarDiagnostico({ modo: 'unico', fontes: {} });
  assert.equal(d.iaLocalPrivada.estado, 'em-descanso');
  assert.equal(d.iaLocalPrivada.fallback, 'fechar');
  assert.equal(d.iaLocalPrivada.respostasFechadas, 3);
  assert.ok(d.motivos.some((m) => m.codigo === 'ia-local-privada-fora'), JSON.stringify(d.motivos));
  zerar(); ligarFechar('http://8.8.8.8:1234/v1');
  const ruim = diag.montarDiagnostico({ modo: 'unico', fontes: {} });
  assert.equal(ruim.estado, 'problema');
  assert.ok(ruim.motivos.some((m) => m.codigo === 'ia-local-privada-url-invalida'));
  assert.equal(diag.montarDiagnostico({ modo: 'unico', fontes: { iaLocalPrivada: { estado: 'ativa', fallback: 'qualquer-coisa' } } }).iaLocalPrivada.fallback, null);
  srv.estado.modo = 'ok';
});

desligar();
await srv.fechar();
process.chdir(os.tmpdir()); // solta a pasta temporária (o logger mantém logs/ nela)
for (let i = 0; i < 50 && fs.existsSync(tmp); i++) { // apaga assim que o sistema soltar os arquivos de log (o sinal real: a remoção funcionar)
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await sleep(100); }
}
say(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
