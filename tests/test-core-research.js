// Adaptador de PESQUISA do Core (etapa 3 do cérebro único): src/core/ai/research.js, que o manager usa quando NÃO há a ponte do bot.
// Confere que, sem a ponte, a pesquisa do app funciona dentro do Core (buscadores e leitor de páginas puros, palavras proibidas do Core e a
// síntese pelo backend ativo do manager, sem histórico nem memória); que, com a ponte, tudo continua indo para o bot; e que a pesquisa privada
// continua presa ao YUI_PRIVATE_SEARCH e à guarda de dados sensíveis.
// Rodam SEM rede, SEM Discord e SEM os bancos reais: o diretório de trabalho é uma pasta temporária (o .env do dono não é lido), fetch, axios e
// DNS viram dublês que falham, os buscadores e o leitor de páginas são dublês injetados e o modelo é um backend falso do manager.
// Execução: node tests/test-core-research.js
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'node:dns';
import { pathToFileURL } from 'url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

// ── Ambiente isolado (tudo explícito: nada vem do .env do dono) ─────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-core-research-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  YUI_BANS_FILE: path.join(tmp, 'bans.json'),
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_OWNER_ID: '111',
  YUI_ALERTS: 'false',
  LOG_LEVEL: 'error',
  YUI_RESEARCH_ENABLED: 'true',
  YUI_RESEARCH_GUARD: 'on',
  YUI_RESEARCH_PRE_ROUTE: 'true',
  YUI_PRIVATE_SEARCH: 'owner',
  AI_PRIVATE_LOCAL_ONLY: 'false',
});
for (const k of ['YUI_RESEARCH_MAX_STEPS', 'YUI_RESEARCH_PAGES', 'YUI_RESEARCH_DEADLINE_MS', 'YUI_RESEARCH_CHARGE_ALL', 'YUI_RESEARCH_SOURCES',
  'AI_BACKEND', 'AI_BASE_URL', 'AI_API_KEY', 'AI_SYSTEM_PROMPT', 'OWNER_ID', 'OWNER_IDS', 'YUI_PERSONA_PERSONAL_FILE']) delete process.env[k];
process.chdir(tmp); // logs/ e secrets/ ficam no temporário; o dotenv não acha .env nenhum

// Nada sai da máquina (rede de segurança: os testes injetam os buscadores; se algo escapar, falha aqui).
const { default: axios } = await import('axios');
axios.post = async () => { throw new Error('rede bloqueada no teste'); };
axios.get = async () => { throw new Error('rede bloqueada no teste'); };
const netAttempts = [];
globalThis.fetch = async (url) => { netAttempts.push(String(url)); throw new Error('rede bloqueada no teste'); };
dns.lookup = (host, opts, cb) => { netAttempts.push(`dns:${host}`); const done = typeof opts === 'function' ? opts : cb; process.nextTick(() => done(Object.assign(new Error('DNS bloqueado no teste'), { code: 'ENOTFOUND' }))); };

const ai = await imp('src/core/ai/manager.js');
const research = await imp('src/core/ai/research.js');
const { createUserGuard } = await imp('src/core/ai/researchAgent.js');
const { SEARCH_DISABLED_REPLY, SENSITIVE_SEARCH_REFUSAL } = await imp('src/core/ai/searchIntent.js');
const { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } = await imp('src/core/ai/llmSafety.js');

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  ✖ ${name}\n      ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n      ')}`);
  } finally {
    ai.setLegacyBridge(null);
  }
}

// ── Dublês ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ASK_WEB = 'pesquise na internet o preço da placa de vídeo RTX 5090';
const SECRET_HISTORY = 'SEGREDO-DO-HISTORICO-7731';
const SECRET_MEMORY = 'SEGREDO-DA-MEMORIA-5520';
const ANSWER = 'A placa de vídeo RTX 5090 está saindo por volta de R$ 15 mil nas lojas brasileiras [1].';
const ownerCtx = { userId: '111', role: 'OWNER', memoryScope: 'personal', platform: 'api' };
const memberCtx = { userId: '222', role: 'MEMBER', memoryScope: 'public', platform: 'api' };
const RESULTS = [
  { title: 'Preço da placa de vídeo RTX 5090 no Brasil', url: 'https://loja.exemplo.test/hardware/rtx-5090-preco', snippet: 'A placa de vídeo RTX 5090 custa por volta de R$ 15 mil no Brasil em novembro.' },
  { title: 'RTX 5090: preço da placa de vídeo cai', url: 'https://noticias.exemplo.test/placas/rtx-5090', snippet: 'O preço da placa de vídeo RTX 5090 caiu nas lojas brasileiras nesta semana.' },
];
const PAGE = 'Levantamento de preços da placa de vídeo RTX 5090 nas principais lojas do Brasil: a média ficou em R$ 15 mil, com variação de 5% entre as lojas. '.repeat(3);
const cfgOf = (over = {}) => () => ({ enabled: true, guard: 'on', preRoute: true, privateSearch: 'owner', totalDeadlineMs: 60_000, ...over });

/** Buscador e leitor de páginas dublês (o contrato do agente), com o que receberam. */
function doubles({ results = RESULTS, page = PAGE } = {}) {
  const seen = { searches: [], pages: [] };
  const io = {
    search: async (q, o) => { seen.searches.push({ q, o }); return { provider: 'dublê', results, errors: results.length ? [] : ['dublê: sem resultados'] }; },
    readPage: async (url, o) => { seen.pages.push({ url, o }); return page; },
    userGuard: createUserGuard(),
  };
  return { io, seen };
}
/** Backend falso do manager (ativado). `reply(args, n)` decide a resposta; Error = lança. */
function fakeBackend(name, reply = () => ANSWER) {
  const calls = [];
  ai.registerBackend({ name, local: false, async chat(args) { calls.push(args); const r = reply(args, calls.length); if (r instanceof Error) throw r; return r; } }, { activate: true });
  return calls;
}
const hasSecret = (s) => String(s ?? '').includes(SECRET_HISTORY) || String(s ?? '').includes(SECRET_MEMORY);
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('Sem a ponte do bot (o cérebro sozinho): a pesquisa do app roda dentro do Core');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

await test('pedido explícito no app (pré-rota): o adaptador do Core pesquisa, lê as páginas no modo quieto e sintetiza pelo backend ativo', async () => {
  assert.equal(ai.hasLegacyBridge(), false);
  const { io, seen } = doubles();
  const calls = fakeBackend('cerebro-pre-rota');
  const out = await ai.chatTurn({ prompt: ASK_WEB, ctx: ownerCtx, history: [{ role: 'user', content: SECRET_HISTORY }], memoryBlock: `\n[MEMÓRIA] ${SECRET_MEMORY}` }, { config: cfgOf(), research: io });
  assert.equal(out.handled, true, 'Porta A');
  assert.equal(out.researched, true);
  assert.equal(out.kind, 'answer', out.text);
  assert.equal(out.private, true, 'o app é conversa privada');
  assert.ok(out.text.includes('R$ 15 mil'), out.text);
  assert.ok(out.text.includes('loja.exemplo.test'), 'as fontes são anexadas pelo código');
  assert.equal(out.historyLine, 'Pesquisei na web a pedido do usuário (conversa privada) e respondi.');
  assert.equal(seen.searches.length, 1);
  assert.equal(seen.searches[0].o.private, true);
  assert.equal(seen.searches[0].o.userId, '111', 'o 1º passo gasta a cota de quem pediu');
  assert.ok(/rtx 5090/i.test(seen.searches[0].q), seen.searches[0].q);
  assert.ok(seen.pages.length >= 1, 'leu as páginas');
  assert.ok(seen.pages.every((p) => p.o.private === true), 'leitura no modo privado (o log não leva o host)');
  assert.equal(calls.length, 1, 'na pré-rota a única chamada ao modelo é a síntese');
  assert.deepEqual(netAttempts, [], 'nada foi à rede');
});

await test('a síntese não leva histórico nem memória: o turno tem os dois; a síntese recebe só a pergunta e a evidência cercada (Porta C)', async () => {
  const { io, seen } = doubles();
  const calls = fakeBackend('cerebro-promessa', (_a, n) => (n === 1 ? 'Vou pesquisar isso pra você, um segundo!' : ANSWER));
  const out = await ai.chatTurn({ prompt: ASK_WEB, ctx: ownerCtx, history: [{ role: 'user', content: SECRET_HISTORY }], memoryBlock: `\n[MEMÓRIA] ${SECRET_MEMORY}` }, { config: cfgOf({ preRoute: false }), research: io });
  assert.equal(out.researched, true, JSON.stringify(out));
  assert.equal(out.kind, 'answer');
  assert.ok(out.text.includes('R$ 15 mil'), out.text);
  assert.equal(seen.searches.length, 1);
  assert.equal(calls.length, 2, 'turno + síntese');
  const [turn, synth] = calls;
  // o turno (chat normal) leva o histórico e a memória, como sempre
  assert.ok(turn.history.some((m) => m.content === SECRET_HISTORY));
  assert.ok(turn.memoryBlock.includes(SECRET_MEMORY));
  // a síntese: sem histórico, sem memória, sem persona pessoal, sem canal, com sensitive (nunca provedor anônimo)
  assert.deepEqual(synth.history, []);
  assert.equal(synth.memoryBlock, '');
  assert.equal(synth.isolated, true);
  assert.equal(synth.sensitive, true);
  assert.equal(synth.ctx.memoryScope, 'public', 'o ctx da síntese não é o pessoal');
  assert.ok(!hasSecret(synth.prompt) && !hasSecret(synth.system), 'nada do histórico nem da memória chega à síntese');
  assert.ok(synth.system.includes('Nesta resposta você não tem ferramentas'), 'regra de resposta final sem ferramentas');
  assert.ok(synth.prompt.includes('[PERGUNTA DO USUÁRIO]:') && synth.prompt.includes(ASK_WEB), 'só a pergunta do autor');
  const open = synth.prompt.indexOf(UNTRUSTED_OPEN);
  const close = synth.prompt.indexOf(UNTRUSTED_CLOSE);
  assert.ok(open > 0 && close > open, 'a evidência vai cercada como dado não confiável');
  assert.ok(synth.prompt.slice(open, close).includes('R$ 15 mil'), 'a evidência está dentro da cerca');
  assert.ok(!synth.prompt.includes('Vou pesquisar isso'), 'a promessa do modelo não vai à síntese no modo privado');
});

await test('a síntese que falha (ou o legacy-chain sem a ponte) vira resumo com os links: nunca exceção, nunca texto vazio', async () => {
  const { io } = doubles();
  fakeBackend('cerebro-quebrado', () => new Error('provedor fora do ar'));
  const out = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfgOf(), research: io });
  assert.equal(out.handled, true);
  assert.equal(out.kind, 'summary', out.text);
  assert.ok(out.text.includes('loja.exemplo.test'), out.text);
  ai.setActiveBackend('legacy-chain'); // o padrão sem AI_BACKEND; sem a ponte ele lança
  const again = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfgOf(), research: doubles().io });
  assert.equal(again.kind, 'summary', again.text);
  assert.ok(again.text.trim().length > 20);
});

await test('buscador de verdade do Core (searchForAgent do searchManager movido) com o searchWeb dublê: sensitive:false, cota de quem pediu e teto global', async () => {
  fakeBackend('cerebro-buscador');
  const seen = [];
  const core = research.createCoreResearch({
    config: cfgOf(),
    searchImpl: async (q, o) => { seen.push(o); return { provider: 'dublê-web', results: RESULTS.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })), errors: [] }; },
    budget: { takeUser: () => ({ ok: true }) },
    readPage: async () => PAGE,
    userGuard: createUserGuard(),
  });
  const ok = await core.runResearchFor({ question: ASK_WEB, userId: '111', sensitive: true, isOwner: true });
  assert.equal(ok.kind, 'answer', ok.text);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sensitive, false, 'o agente já aplicou as regras do privado');
  assert.equal(seen[0].userId, '111');
  assert.equal(seen[0].max, 6);
  // teto GLOBAL por hora: o searchWeb só sabe dizer limited:'user'; o searchForAgent corrige o rótulo e o usuário vê o motivo certo
  const limited = research.createCoreResearch({
    config: cfgOf(),
    searchImpl: async (q, o) => { o.budget.takeUser('111'); return { provider: null, results: [], errors: ['limite de buscas por usuário atingido'], limited: 'user' }; },
    budget: { takeUser: () => ({ ok: false, scope: 'global' }) },
    readPage: async () => PAGE,
    userGuard: createUserGuard(),
  });
  const out = await limited.runResearchFor({ question: ASK_WEB, userId: '111', sensitive: true, isOwner: true });
  assert.equal(out.kind, 'failed');
  assert.match(out.text, /limite desta hora \(somando todo mundo\)/);
  assert.deepEqual(netAttempts, []);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('Com a ponte do bot (como o bot roda hoje)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

await test('com a ponte: a pesquisa do app continua indo para o runResearchFor e o isToolDisabled do bot (o adaptador do Core nem é chamado)', async () => {
  const { io, seen } = doubles();
  const calls = fakeBackend('cerebro-com-ponte');
  const bot = [];
  ai.setLegacyBridge(async () => ({
    generateResponse: async () => 'resposta da cadeia legada',
    runResearchFor: async (o) => { bot.push(o); return { kind: 'answer', text: 'achei na web (bot)', private: true, historyLine: 'pesquisa do bot' }; },
    isToolDisabled: (g, t) => { bot.push({ toolCheck: [g, t] }); return false; },
  }));
  assert.equal(ai.hasLegacyBridge(), true);
  const out = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfgOf(), research: io });
  assert.equal(out.handled, true);
  assert.equal(out.text, 'achei na web (bot)');
  assert.deepEqual(bot[0], { toolCheck: [null, 'search_web'] });
  assert.equal(bot[1].question, ASK_WEB);
  assert.equal(bot[1].sensitive, true);
  assert.equal(bot[1].isOwner, true);
  assert.equal(seen.searches.length, 0, 'os buscadores do Core não foram usados');
  assert.equal(calls.length, 0, 'a síntese do Core não foi usada');
  // a Porta C também vai ao bot
  const promise = fakeBackend('cerebro-com-ponte-c', () => 'Vou pesquisar isso pra você, um segundo!');
  const c = await ai.chatTurn({ prompt: ASK_WEB, ctx: ownerCtx }, { config: cfgOf({ preRoute: false }), research: io });
  assert.equal(c.text, 'achei na web (bot)');
  assert.equal(promise.length, 1, 'só o turno; a síntese é do bot');
  assert.equal(seen.searches.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('Pesquisa privada: YUI_PRIVATE_SEARCH e guarda de dados sensíveis');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

await test('YUI_PRIVATE_SEARCH=off: o app recusa sem pesquisar (portão do manager e o próprio adaptador)', async () => {
  const { io, seen } = doubles();
  const calls = fakeBackend('cerebro-off');
  const out = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfgOf({ privateSearch: 'off' }), research: io });
  assert.equal(out.handled, true);
  assert.equal(out.researched, false);
  assert.equal(out.text, SENSITIVE_SEARCH_REFUSAL);
  // o adaptador, chamado direto e lendo o AMBIENTE (sem config injetada), também recusa
  await withEnv({ YUI_PRIVATE_SEARCH: 'off' }, async () => {
    const core = research.createCoreResearch({ search: io.search, readPage: io.readPage, userGuard: createUserGuard() });
    const r = await core.runResearchFor({ question: ASK_WEB, userId: '111', sensitive: true, isOwner: true });
    assert.equal(r.kind, 'refused');
    assert.equal(r.text, SENSITIVE_SEARCH_REFUSAL);
    assert.equal(r.private, false);
  });
  assert.equal(seen.searches.length, 0);
  assert.equal(calls.length, 0);
});

await test('YUI_PRIVATE_SEARCH=owner: só o dono (padrão do isOwner: o dono configurado); =all: qualquer pessoa', async () => {
  fakeBackend('cerebro-owner');
  await withEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
    const { io, seen } = doubles();
    const core = research.createCoreResearch({ search: io.search, readPage: io.readPage, userGuard: createUserGuard() });
    const owner = await core.runResearchFor({ question: ASK_WEB, userId: '111', sensitive: true }); // isOwner ausente => YUI_OWNER_ID
    assert.equal(owner.kind, 'answer', owner.text);
    assert.equal(owner.private, true);
    const member = await core.runResearchFor({ question: ASK_WEB, userId: '222', sensitive: true });
    assert.equal(member.kind, 'refused');
    assert.equal(member.text, SENSITIVE_SEARCH_REFUSAL);
    assert.equal(seen.searches.length, 1, 'só o dono pesquisou');
    // pelo manager: membro no app é recusado pelo portão antes do adaptador
    const viaApp = await ai.appResearchRoute({ ctx: memberCtx, text: ASK_WEB }, { config: cfgOf({ privateSearch: 'owner' }), research: io });
    assert.equal(viaApp.text, SENSITIVE_SEARCH_REFUSAL);
    assert.equal(seen.searches.length, 1);
  });
  await withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
    const { io, seen } = doubles();
    const core = research.createCoreResearch({ search: io.search, readPage: io.readPage, userGuard: createUserGuard() });
    const member = await core.runResearchFor({ question: ASK_WEB, userId: '222', sensitive: true });
    assert.equal(member.kind, 'answer', member.text);
    assert.equal(member.private, true);
    assert.equal(seen.searches[0].o.private, true);
  });
});

await test('guarda de dados sensíveis no privado: CPF, e-mail, token e palavra proibida não saem para o buscador; pedido não explícito também não', async () => {
  const calls = fakeBackend('cerebro-guarda');
  const { io, seen } = doubles();
  const lines = [];
  const core = research.createCoreResearch({ config: cfgOf({ privateSearch: 'all' }), search: io.search, readPage: io.readPage, userGuard: createUserGuard(), log: (lvl, msg) => lines.push(String(msg)) });
  const ask = (question) => core.runResearchFor({ question, userId: '222', sensitive: true });
  const cpf = await ask('pesquise na internet o CPF 123.456.789-09 do meu vizinho');
  assert.equal(cpf.kind, 'refused');
  assert.match(cpf.text, /dado pessoal ou segredo/);
  const mail = await ask('pesquise na internet quem é fulano.de.tal@exemplo.com.br');
  assert.equal(mail.kind, 'refused');
  assert.match(mail.text, /dado pessoal ou segredo/);
  const token = await ask('pesquise na internet se a senha: Hunter2024! é forte');
  assert.equal(token.kind, 'refused');
  const forbidden = await ask('pesquise na internet a história do nazismo');
  assert.equal(forbidden.kind, 'refused');
  assert.match(forbidden.text, /Não consigo pesquisar isso/);
  const vague = await ask('qual o preço da placa de vídeo RTX 5090 hoje?');
  assert.equal(vague.kind, 'refused');
  assert.match(vague.text, /só pesquiso se você pedir de forma explícita/);
  assert.equal(seen.searches.length, 0, 'nenhuma consulta saiu para o buscador');
  assert.equal(calls.length, 0, 'nem para o modelo');
  // o log do adaptador e do agente só tem metadados: nem a pergunta, nem a consulta
  const ok = await ask(ASK_WEB);
  assert.equal(ok.kind, 'answer', ok.text);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !/rtx|vizinho|exemplo\.com|hunter|nazismo|123\.456/i.test(l)), lines.join(' | '));
  assert.equal(ok.query, '', 'a consulta privada não aparece no resultado');
  assert.ok(!ok.historyLine.toLowerCase().includes('rtx'), 'nem no histórico');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('Ferramenta search_web e contrato');
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

await test('isToolDisabled do Core: sem servidor vale o padrão do mcp_tools.json; com servidor, as mesmas regras do bot (só lendo)', async () => {
  const real = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/data/mcp_tools.json'), 'utf8')).find((t) => t.function.name === 'search_web');
  assert.equal(research.isToolDisabled(null, 'search_web'), Boolean(real?.meta?.defaultDisabled), 'o app segue o padrão do arquivo de verdade');
  const toolsFile = path.join(tmp, 'mcp_tools.json');
  const serverToolsFile = path.join(tmp, 'server_tools.json');
  fs.writeFileSync(toolsFile, JSON.stringify([
    { function: { name: 'search_web' }, meta: { defaultDisabled: true } },
    { function: { name: 'show_bot_menu' }, meta: { defaultDisabled: true } },
    { function: { name: 'generate_image' }, meta: {} },
  ]));
  fs.writeFileSync(serverToolsFile, JSON.stringify({ g1: { enabled: ['search_web'], disabled: ['generate_image'] }, g2: ['generate_image'], g3: {} }));
  const off = research.createToolSwitch({ toolsFile, serverToolsFile });
  assert.equal(off(null, 'search_web'), true, 'sem servidor: padrão desligado');
  assert.equal(off(null, 'get_help'), true, 'get_help é o interruptor do show_bot_menu');
  assert.equal(off(null, 'generate_image'), false);
  assert.equal(off('g1', 'search_web'), false, 'ligada no servidor vence o padrão');
  assert.equal(off('g1', 'generate_image'), true);
  assert.equal(off('g2', 'generate_image'), true, 'formato antigo (lista de desligadas)');
  assert.equal(off('g2', 'search_web'), true, 'fora da lista: o padrão');
  assert.equal(off('g3', 'search_web'), true);
  assert.equal(off('outro', 'generate_image'), false);
  assert.equal(off('__proto__', 'generate_image'), false);
  const missing = research.createToolSwitch({ toolsFile: path.join(tmp, 'nao-existe.json'), serverToolsFile: path.join(tmp, 'nao-existe-2.json') });
  assert.equal(missing(null, 'search_web'), false, 'sem o arquivo: como o bot (lista vazia)');
  // o arquivo mudou: vale a versão nova
  fs.writeFileSync(toolsFile, JSON.stringify([{ function: { name: 'search_web' }, meta: { defaultDisabled: false } }]));
  assert.equal(off(null, 'search_web'), false);
  // nada foi gravado nos arquivos de verdade
  assert.equal(fs.readFileSync(path.join(repoRoot, 'src/data/mcp_tools.json'), 'utf8').length > 0, true);
});

await test('search_web desligada (padrão do arquivo): o app recebe a recusa e nada é pesquisado', async () => {
  const { io, seen } = doubles();
  const calls = fakeBackend('cerebro-desligada');
  const toolsFile = path.join(tmp, 'mcp_tools-off.json');
  fs.writeFileSync(toolsFile, JSON.stringify([{ function: { name: 'search_web' }, meta: { defaultDisabled: true } }]));
  const out = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfgOf(), research: { ...io, tools: { toolsFile, serverToolsFile: path.join(tmp, 'vazio.json') } } });
  assert.equal(out.handled, true);
  assert.equal(out.text, SEARCH_DISABLED_REPLY);
  assert.equal(seen.searches.length, 0);
  assert.equal(calls.length, 0);
});

await test('mesma assinatura do runResearchFor do bot (os mesmos parâmetros, na mesma ordem) e o mesmo formato de resultado', async () => {
  const params = (rel) => {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const m = /async function runResearchFor\(\{([^}]*)\}\s*=\s*\{\}\)/.exec(src);
    assert.ok(m, `${rel}: runResearchFor não encontrado`);
    return m[1].split(',').map((p) => p.split('=')[0].trim()).filter(Boolean);
  };
  const bot = params('src/handlers/llmHandler.js');
  assert.deepEqual(params('src/core/ai/research.js'), bot);
  assert.ok(bot.includes('question') && bot.includes('userGuard'));
  assert.equal(typeof research.runResearchFor, 'function');
  assert.equal(typeof research.isToolDisabled, 'function');
  fakeBackend('cerebro-contrato');
  const { io } = doubles();
  const r = await research.createCoreResearch({ config: cfgOf(), ...io }).runResearchFor({ question: ASK_WEB, userId: '111', sensitive: true, isOwner: true });
  for (const k of ['ok', 'kind', 'text', 'sources', 'usedSearch', 'private', 'query', 'historyLine', 'stats', 'trace']) assert.ok(Object.hasOwn(r, k), `faltou ${k}`);
  assert.equal(r.ok, true);
  assert.equal(r.usedSearch, true);
});

await test('palavras proibidas: o banHandler entrega a MESMA lista do Core (o mesmo array, sem cópia) e o adaptador a usa por padrão', async () => {
  const core = await imp('src/core/forbiddenKeywords.js');
  const ban = await imp('src/handlers/banHandler.js'); // YUI_BANS_FILE aponta para o temporário: o bans.json real nem é lido
  assert.equal(ban.forbiddenKeywords, core.forbiddenKeywords);
  assert.equal(ban.default.forbiddenKeywords, core.forbiddenKeywords);
  assert.ok(core.forbiddenKeywords.length >= 80 && core.forbiddenKeywords.includes('hentai'));
  assert.ok(!fs.existsSync(path.join(tmp, 'bans.json')), 'nada foi gravado');
});

console.log(`\n${failed.length ? `COM FALHAS: ${passed} teste(s) ok, ${failed.length} falhou(aram): ${failed.join(' | ')}` : `${passed} testes OK`}`);
try { process.chdir(repoRoot); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows pode segurar o log aberto */ }
process.exit(failed.length ? 1 : 0);
