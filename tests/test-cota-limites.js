// Segunda revisão da Liz na etapa 6 (docs/RELATORIO_ETAPA6_PESQUISA.md §12 e §13), num processo só:
//  A2. a reserva de 20% da cota de busca é CONFIGURÁVEL sem mexer no código (YUI_CEREBRO_BUSCA_RESERVA);
//  A3. o ajuste do PAINEL do Discord vence só no Discord (painel > configuração do cérebro > padrão, dentro da capacidade e do teto); o APP
//      nunca herda o ajuste do painel (nem pela cadeia do bot no processo único, nem pelo Gateway no cérebro);
//  A4. AI_MAX_TOKENS inválido: a mesma regra no Discord e no app, vale o padrão 1500 SEM esconder o erro: no log UMA vez e no diagnóstico
//      (relatório de saúde e /v1/health);
//  A6. os contadores POR HORA da cota sobrevivem a um reinício (em disco, gravação atômica, no dono certo: o cérebro) e mantêm a janela de
//      tempo certa.
// SEM rede (axios e fetch bloqueados, exceto o /v1/health deste processo no loopback), SEM bancos reais (pasta temporária).
// Execução: npm run test:cotalimites   (node tests/test-cota-limites.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cota-limites-'));
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const OWNER = '111111111111111111';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_POLICY_MODE: 'observe', GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890',
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_CEREBRO_EXTERNO', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'YUI_CEREBRO_BUSCA_RESERVA', 'AI_MAX_TOKENS', 'AI_BACKEND',
  'YUI_GATEWAY_DISABLE', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'YUI_GATEWAY_CUSTOM', 'YUI_SEARCH_USER_PER_HOUR', 'YUI_SEARCH_GLOBAL_PER_HOUR', 'YUI_COTA_HORA_DISCO',
  'YUI_READ_ONLY']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
let axiosHook = null;
axios.post = async (url, body) => { if (axiosHook) return axiosHook(String(url), body); throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };
let fetchHook = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (/^http:\/\/127\.0\.0\.1:\d+\/v1\/health$/.test(url)) return realFetch(u, init); // só o /v1/health deste processo
  if (fetchHook) return fetchHook(url, init);
  throw new Error(`fetch bloqueado no teste: ${url.slice(0, 40)}`);
};
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (/[\\/]data[\\/][^\\/]+\.json$/.test(String(file)) && !String(file).startsWith(tmp)) return undefined; // nada nos arquivos de dados reais
  return realWrite.call(this, file, ...rest);
};

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const llm = await imp('src/handlers/llmHandler.js');
const limites = await imp('src/core/ai/limitesTokens.js');
const manager = await imp('src/core/ai/manager.js');
const gatewayIndex = await imp('src/gateway/index.js');
const budgetMod = await imp('src/search/budget.js');
const pesquisa = await imp('src/cerebro/pesquisa.js');
const conversa = await imp('src/cerebro/conversa.js');
const health = await imp('src/core/healthReport.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const comEnv = async (extra, fn) => {
  const saved = { ...process.env };
  try { Object.assign(process.env, extra); return await fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};
const MIN = 60_000;
const HORA = 60 * MIN;

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A2. A reserva da cota de busca é configurável sem mexer no código');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('YUI_CEREBRO_BUSCA_RESERVA muda o "perto do fim" (20% padrão; 35%; 0 desliga; inválido volta ao padrão)', () => {
    let agora = Date.now();
    const b = budgetMod.createBudget({ filePath: path.join(tmp, 'reserva.json'), now: () => agora });
    const env = (extra = {}) => ({ YUI_SEARCH_USER_PER_HOUR: '10', YUI_SEARCH_GLOBAL_PER_HOUR: '0', YUI_SEARCH_PROVIDERS: 'searxng', ...extra });
    for (let i = 0; i < 7; i += 1) assert.ok(b.takeUser(MEMBER, env()).ok);
    // sobram 3 de 10: com 20% (reserva de 2) ainda não está perto do fim; com 35% (reserva de 4), está
    assert.equal(pesquisa.reservaDaCota(env()), 20);
    assert.equal(pesquisa.cotaDaBusca(MEMBER, { budget: b, env: env() }).perto, false);
    assert.equal(pesquisa.reservaDaCota(env({ YUI_CEREBRO_BUSCA_RESERVA: '35' })), 35);
    assert.deepEqual(pesquisa.cotaDaBusca(MEMBER, { budget: b, env: env({ YUI_CEREBRO_BUSCA_RESERVA: '35' }) }), { perto: true, motivo: 'usuario', restantes: { usuario: 3, global: null, mensal: null } });
    assert.equal(pesquisa.cotaDaBusca(MEMBER, { budget: b, env: env({ YUI_CEREBRO_BUSCA_RESERVA: '0' }) }).perto, false, '0 desliga o aviso');
    assert.equal(pesquisa.reservaDaCota(env({ YUI_CEREBRO_BUSCA_RESERVA: 'muito' })), 20, 'inválido: o padrão');
    assert.equal(pesquisa.reservaDaCota(env({ YUI_CEREBRO_BUSCA_RESERVA: '99' })), 90, 'no máximo 90%');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A3. O painel do Discord vence só no Discord; o app nunca herda o ajuste do painel');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('a ordem no Discord pelo cérebro: painel > YUI_CEREBRO_MAX_TOKENS > padrão, sempre dentro da capacidade do provedor e do teto de 4096', () => {
    const env = { YUI_CEREBRO_MAX_TOKENS: '{"groq":2000,"cloudflare":1800}' };
    const lim = (p, canal = null, e = env) => limites.limiteDoProvedor(p, { env: e, canal }).limite;
    assert.equal(lim('groq', { groq: 3000 }), 3000, 'o painel vence o ajuste do cérebro');
    assert.equal(lim('groq'), 2000, 'sem painel: o ajuste do cérebro');
    assert.equal(lim('groq', null, {}), 1024, 'sem os dois: o padrão da cadeia');
    assert.equal(lim('groq', { groq: 6000 }), 4096, 'o painel acima do teto: o teto');
    assert.equal(lim('cloudflare', { cloudflare: 3000 }), 2048, 'o painel acima da capacidade: a capacidade');
    assert.equal(lim('gemini', { groq: 3000 }), 2048, 'o ajuste de OUTRO provedor não vale para este');
  });

  await test('processo único: o painel muda o Discord; o APP pela cadeia do bot (legacy-chain) continua com a configuração dele, sem o ajuste do painel', async () => {
    const bodies = [];
    axiosHook = async (url, body) => {
      if (String(url) === config.groqApiUrl) { bodies.push(body.max_tokens); return { data: { choices: [{ message: { content: 'resposta do groq' }, finish_reason: 'stop' }] } }; }
      throw new Error('offline (teste)');
    };
    const antes = llm.getProviderSettings().groq.max_tokens;
    try {
      manager.setLegacyBridge(async () => llm);
      manager.initAiManager();
      manager.setActiveBackend('legacy-chain');
      const ctx = { userId: MEMBER, platform: 'api', memoryScope: 'public' };
      llm.updateProviderSetting('groq', 'max_tokens', 3000); // o dono ajusta pelo painel do Discord
      await llm.generateResponse('oi', CHAN, { guildId: GUILD, userId: MEMBER });
      await manager.chat({ prompt: 'oi', ctx });
      assert.deepEqual(bodies, [3000, antes], `o Discord recebe o painel (3000); o app, a configuração dele (${antes})`);
      llm.updateProviderSetting('groq', 'max_tokens', 6000);
      bodies.length = 0;
      await manager.chat({ prompt: 'oi', ctx });
      assert.deepEqual(bodies, [antes], 'o app nunca herda o painel (nem acima do teto)');
    } finally {
      llm.updateProviderSetting('groq', 'max_tokens', antes);
      axiosHook = null;
      manager.setLegacyBridge(null);
      manager.initAiManager();
    }
  });

  await test('cérebro: o Discord (com o fato do painel) recebe o painel; o app (sem o pedido do canal) recebe o AI_MAX_TOKENS, mesmo depois do Discord', async () => {
    const seen = [];
    fetchHook = async (url, init) => { seen.push(JSON.parse(init.body).max_tokens); return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }; };
    await comEnv({ YUI_GATEWAY_DISABLE: 'pollinations', YUI_GATEWAY_PRIORITY: 'groq' }, async () => {
      try {
        gatewayIndex.resetGateway();
        manager.initAiManager();
        manager.setActiveBackend('gateway');
        // o Discord pelo cérebro: o pedido do canal com o ajuste do painel (como o conversa.js manda)
        const pedido = conversa.pedidoDeLimiteDoCanal({ maxTokens: { groq: 3000 } });
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'discord', memoryScope: 'public' }, tokensPorProvedor: pedido });
        // o app no mesmo processo, logo depois: a configuração dele
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'api', memoryScope: 'public' } });
        assert.deepEqual(seen, [3000, 1500], 'Discord 3000 (painel); app 1500 (AI_MAX_TOKENS)');
      } finally {
        fetchHook = null;
        gatewayIndex.resetGateway();
        manager.initAiManager();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A4. AI_MAX_TOKENS inválido: a mesma regra no Discord e no app, no log UMA vez e no diagnóstico');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('a regra única (lerAiMaxTokens): vazio = padrão sem erro; inteiro a partir de 64 vale; o resto é inválido e vale 1500 COM o erro', () => {
    const casos = [
      ['', 1500, true, false], ['1500', 1500, true, true], ['64', 64, true, true], ['9000', 9000, true, true],
      ['abc', 1500, false, true], ['0', 1500, false, true], ['-5', 1500, false, true], ['50', 1500, false, true], ['1500abc', 1500, false, true], ['15.5', 1500, false, true],
    ];
    for (const [v, valor, valido, definido] of casos) {
      const r = limites.lerAiMaxTokens({ AI_MAX_TOKENS: v });
      assert.deepEqual([r.valor, r.valido, r.definido], [valor, valido, definido], `AI_MAX_TOKENS="${v}"`);
      assert.equal(Boolean(r.erro), !valido, `erro só quando inválido ("${v}")`);
    }
  });

  await test('o MESMO comportamento no Discord (openai-compatible do cérebro) e no app, para cada valor', () => {
    for (const v of ['', '1500', '64', '3000', '6000', 'abc', '0', '50']) {
      const env = { AI_MAX_TOKENS: v };
      assert.equal(limites.limiteOpenAiCompativel(env), limites.limiteAppOpenAiCompativel(env), `AI_MAX_TOKENS="${v}"`);
    }
    assert.equal(limites.limiteOpenAiCompativel({ AI_MAX_TOKENS: 'abc' }), 1500);
    assert.equal(limites.limiteOpenAiCompativel({ AI_MAX_TOKENS: '6000' }), 4096, 'acima do teto: o teto (nos dois)');
  });

  await test('no log UMA vez (não repete a cada chamada), tanto pelo Discord quanto pelo app; a subida também avisa uma vez só', async () => {
    const linhas = [];
    const antes = logger.warn;
    logger.warn = (m) => linhas.push(String(m));
    limites.esquecerAvisosParaTeste();
    try {
      await comEnv({ AI_MAX_TOKENS: 'mil' }, async () => {
        for (let i = 0; i < 5; i += 1) { limites.aiMaxTokens(process.env); limites.limiteOpenAiCompativel(process.env); limites.limiteDoApp('groq', { env: process.env }); }
        assert.equal(limites.avisarConfigDosLimites(process.env, logger), 0, 'a subida não repete o que já foi avisado');
        // pelo AI Manager de verdade (openai-compatible com axios falso): Discord (tokensPorProvedor) e app
        const bodies = [];
        axiosHook = async (url, body) => { bodies.push(body.max_tokens); return { data: { choices: [{ message: { content: 'ok' } }] } }; };
        process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
        manager.initAiManager();
        manager.setActiveBackend('openai-compatible');
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'discord', memoryScope: 'public' }, tokensPorProvedor: true });
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'api', memoryScope: 'public' } });
        assert.deepEqual(bodies, [1500, 1500], 'Discord e app: o padrão');
      });
      const doAi = linhas.filter((l) => /AI_MAX_TOKENS/.test(l));
      assert.equal(doAi.length, 1, linhas.join(' | '));
      assert.match(doAi[0], /inválido.*valendo 1500/);
    } finally {
      logger.warn = antes;
      axiosHook = null;
      manager.initAiManager();
    }
  });

  await test('o diagnóstico: o relatório de saúde mostra o erro (nível de atenção) e o /v1/health devolve avisosDeConfiguracao', async () => {
    await comEnv({ AI_MAX_TOKENS: 'abc', YUI_MAX_TOKENS_TETO: '99999' }, async () => {
      const d = limites.diagnosticoDosLimites(process.env);
      assert.deepEqual(d.map((x) => x.variavel), ['AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO']);
      assert.equal(d[0].usando, 1500);
      const dados = health.collectHealth({ uptimeSeconds: 3 * 86400, updateLog: '', backupLog: '', supervisorLog: '', logDir: path.join(tmp, 'sem-logs'), interactions: () => ({ total: 1 }), dbStats: () => [], lembretes: () => [] });
      assert.equal(dados.configuracao.length, 2);
      const r = health.buildHealthReport(dados);
      assert.equal(r.level, 'warn');
      assert.match(r.body, /configuração inválida no \.env \(AI_MAX_TOKENS, YUI_MAX_TOKENS_TETO\)/);
      assert.match(r.body, /Configuração: AI_MAX_TOKENS inválido .*valendo 1500/);
      const server = createApiServer({ tokens: parseTokens('token-de-teste-0123456789=111') });
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      try {
        const h = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/health`)).json();
        assert.deepEqual(h.avisosDeConfiguracao.map((x) => x.variavel), ['AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO']);
        assert.ok(!JSON.stringify(h.avisosDeConfiguracao).includes('abc'), 'o /v1/health (sem login) não repete o valor bruto');
      } finally {
        server.closeAllConnections?.();
        await new Promise((ok) => server.close(ok));
      }
    });
    // com a configuração certa, nada
    assert.deepEqual(limites.diagnosticoDosLimites({ AI_MAX_TOKENS: '2000' }), []);
    assert.equal(health.buildHealthReport(health.collectHealth({ uptimeSeconds: 3 * 86400, updateLog: '', backupLog: '', supervisorLog: '', logDir: path.join(tmp, 'sem-logs'), interactions: () => ({ total: 1 }), dbStats: () => [], lembretes: () => [], configuracao: () => [] })).body.includes('Configuração'), false);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A6. A cota de busca por hora sobrevive a um reinício (em disco, no cérebro) com a janela certa');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const envCota = { YUI_SEARCH_USER_PER_HOUR: '3', YUI_SEARCH_GLOBAL_PER_HOUR: '5' };
  await test('reinício: as buscas da última hora voltam do disco, cada uma no instante dela; o limite continua valendo e a janela anda certo', () => {
    const arquivo = path.join(tmp, 'a6', 'search-budget-hora.json');
    const t0 = Date.parse('2026-11-18T10:00:00Z');
    let agora = t0;
    const A = budgetMod.createBudget({ filePath: path.join(tmp, 'a6', 'search-budget.json'), now: () => agora });
    assert.equal(A.persistirHora(arquivo, agora), 0, 'arquivo novo: nada volta');
    assert.ok(A.takeUser(MEMBER, envCota).ok);           // 10:00
    agora = t0 + 10 * MIN; assert.ok(A.takeUser(MEMBER, envCota).ok); // 10:10
    agora = t0 + 50 * MIN; assert.ok(A.takeUser(MEMBER, envCota).ok); // 10:50 (o limite de 3 por hora)
    agora = t0 + 51 * MIN; assert.ok(A.takeUser(OTHER, envCota).ok);  // outra pessoa, 10:51
    assert.equal(A.takeUser(MEMBER, envCota).ok, false, 'no limite antes do reinício');
    // o arquivo: atômico (JSON válido e inteiro), só instantes e hashes (nunca o id)
    const bruto = fs.readFileSync(arquivo, 'utf8');
    assert.ok(!bruto.includes(MEMBER) && !bruto.includes(OTHER), 'o id da pessoa nunca vai para o disco');
    assert.equal(JSON.parse(bruto).versao, 1);
    assert.equal(JSON.parse(bruto).global.length, 4);
    // "reinício" às 10:55: um processo novo (contadores novos) relê o arquivo
    agora = t0 + 55 * MIN;
    const B = budgetMod.createBudget({ filePath: path.join(tmp, 'a6', 'search-budget.json'), now: () => agora });
    assert.equal(B.persistirHora(arquivo, agora), 8, '4 do membro/outro + 4 globais voltaram');
    assert.equal(B.userStatus(MEMBER, envCota).used, 3, 'as 3 do membro continuam contando');
    assert.equal(B.globalStatus(envCota).used, 4);
    const recusa = B.takeUser(MEMBER, envCota);
    assert.equal(recusa.ok, false, 'o limite sobreviveu ao reinício');
    assert.equal(recusa.retryAfterMs, 5 * MIN, 'a vaga abre às 11:00, uma hora depois da busca das 10:00 (janela certa)');
    // às 11:01 a busca das 10:00 saiu da janela; às 11:11, a das 10:10 também
    agora = t0 + HORA + MIN;
    assert.equal(B.userStatus(MEMBER, envCota).used, 2);
    assert.ok(B.takeUser(MEMBER, envCota).ok, 'abriu uma vaga');
    agora = t0 + HORA + 11 * MIN;
    assert.equal(B.userStatus(MEMBER, envCota).used, 2, 'sobram a das 10:50 e a das 11:01');
    assert.equal(B.hourlyStats().persistente, true);
    assert.ok(B.hourlyStats().gravacoes >= 1);
    // e um terceiro processo bem depois (12:30): nada da janela antiga volta
    agora = t0 + 2.5 * HORA;
    const C = budgetMod.createBudget({ filePath: path.join(tmp, 'a6', 'search-budget.json'), now: () => agora });
    assert.equal(C.persistirHora(arquivo, agora), 0, 'fora da janela de 1 h: nada volta');
    assert.equal(C.userStatus(MEMBER, envCota).used, 0);
  });

  await test('sem conta em dobro: com a cota em disco, a retomada não "devolve" a busca do processo anterior (ela já voltou do arquivo)', () => {
    const arquivo = path.join(tmp, 'a6b', 'search-budget-hora.json');
    let agora = Date.now();
    const A = budgetMod.createBudget({ filePath: path.join(tmp, 'a6b', 'search-budget.json'), now: () => agora });
    A.persistirHora(arquivo, agora);
    assert.ok(A.takeUser(MEMBER, envCota).ok);
    agora += 2 * MIN;
    const B = budgetMod.createBudget({ filePath: path.join(tmp, 'a6b', 'search-budget.json'), now: () => agora });
    B.persistirHora(arquivo, agora);
    assert.equal(B.restoreUse(MEMBER, agora - 2 * MIN, envCota), false, 'nada a devolver');
    assert.equal(B.userStatus(MEMBER, envCota).used, 1, 'conta UMA vez');
    // sem a cota em disco (o processo único de hoje), a devolução da retomada continua como antes
    const M = budgetMod.createBudget({ filePath: path.join(tmp, 'a6b', 'm.json'), now: () => agora });
    assert.equal(M.restoreUse(MEMBER, agora - MIN, envCota), true);
    assert.equal(M.userStatus(MEMBER, envCota).used, 1);
    assert.equal(M.hourlyStats().persistente, false);
  });

  await test('falhas: arquivo ilegível recomeça vazio e é regravado; disco com problema FALHA FECHADO (a reserva é desfeita, a busca não sai) e fica na saúde', () => {
    const dir = path.join(tmp, 'a6c');
    fs.mkdirSync(dir, { recursive: true });
    const arquivo = path.join(dir, 'search-budget-hora.json');
    realWrite(arquivo, '{quebrado');
    const A = budgetMod.createBudget({ filePath: path.join(dir, 'search-budget.json') });
    assert.equal(A.persistirHora(arquivo), 0);
    assert.equal(A.hourlyStats().ilegivel, true);
    assert.ok(A.takeUser(MEMBER, envCota).ok);
    assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).versao, 1, 'regravado inteiro');
    // o "arquivo" é uma pasta: a gravação falha. Revisão da Liz (etapa 8, §12): a busca NÃO sai (falhar fechado), a reserva é DESFEITA (nenhuma cota só em
    // memória) e a falha aparece na saúde; com o disco de volta, a mesma pessoa busca normalmente (nada ficou cobrado)
    const pasta = path.join(dir, 'e-uma-pasta.json');
    fs.mkdirSync(pasta, { recursive: true });
    const B = budgetMod.createBudget({ filePath: path.join(dir, 'x.json') });
    B.persistirHora(pasta);
    const recusa = B.takeUser(MEMBER, envCota);
    assert.equal(recusa.ok, false, 'sem gravar o registro, a busca não sai');
    assert.equal(recusa.scope, 'registro', 'o motivo é o registro que não gravou (não é o limite)');
    assert.equal(B.userStatus(MEMBER, envCota).used, 0, 'a reserva foi desfeita: nada cobrado');
    assert.equal(B.globalStatus(envCota).used, 0);
    assert.ok(B.hourlyStats().falhas >= 1);
    assert.equal(B.hourlyStats().gravacaoComFalha, true, 'a falha aparece na saúde (a pesquisa está indisponível)');
    fs.rmSync(pasta, { recursive: true, force: true }); // o disco volta
    assert.ok(B.takeUser(MEMBER, envCota).ok, 'com o registro gravando, a busca sai');
    assert.equal(B.userStatus(MEMBER, envCota).used, 1);
    assert.equal(B.hourlyStats().gravacaoComFalha, false);
  });

  await test('o dono certo (etapa 8): o cérebro liga a cota em disco com o papel `cerebro` (src/search/cotaHora.js), com YUI_COTA_HORA_DISCO para voltar a só memória; ninguém liga os contadores direto (o processo único, o bot separado e a trava de dono: test:cotahora)', () => {
    const cerebroSrc = fs.readFileSync(path.join(repoRoot, 'src', 'cerebro.js'), 'utf8');
    assert.match(cerebroSrc, /ligarCotaHora\(\{ papel: 'cerebro'/);
    for (const f of ['src/index.js', 'src/cerebro.js', 'src/handlers/llmHandler.js', 'src/core/ai/searchManager.js', 'src/search/providers.js']) {
      assert.ok(!fs.readFileSync(path.join(repoRoot, f), 'utf8').includes('persistirHora'), `${f} não liga os contadores direto (só o ligarCotaHora, com o dono certo)`);
    }
    assert.equal(budgetMod.hourlyPersistEnabled({}), true);
    assert.equal(budgetMod.hourlyPersistEnabled({ YUI_COTA_HORA_DISCO: 'false' }), false);
    assert.equal(budgetMod.hourlyFileFor(path.join('x', 'search-budget.json')), path.join('x', 'search-budget-hora.json'));
    assert.equal(budgetMod.getDefaultBudget().hourlyStats().persistente, false, 'neste processo (que não é o cérebro), só memória');
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  fs.writeFileSync = realWrite;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
