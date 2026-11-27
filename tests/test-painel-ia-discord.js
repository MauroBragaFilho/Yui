// LACUNAS DO PAINEL, ITEM 6 (26/11/2026; decisão do dono: "gravar no mesmo cofre"): a configuração da IA do painel do Discord (/yui-criador bot_config e
// /yui-config_ia) e a do painel web passam a ter UMA fonte só, o cofre do painel (src/core/painelConfig.js). Num processo só, SEM rede (axios e fetch
// bloqueados), cofre, banco e auditoria numa pasta temporária (o .env e o secrets/ do projeto nunca são lidos: o teste roda noutra pasta).
//  A. o catálogo e os leitores: os itens novos com grupo, tipo, padrão (o do CÓDIGO), reinício e confirmação; o que fica de fora de propósito (endereços,
//     prompt do sistema, prefixo, nome, top_p, temperatura do Pollinations); "vale na hora" só onde todo leitor lê a cada uso (a lista de leitores é conferida);
//  B. processo único: o botão e o formulário do Discord gravam no cofre e mostram o valor relido; o painel web mostra o mesmo e vice-versa; a cadeia do bot usa
//     o valor na próxima chamada; sobrevive ao reinício; fora da faixa é recusado; não dono é barrado; cofre travado não grava; os valores sensíveis pedem
//     confirmação; o /yui-config_ia grava no mesmo cofre; o src/config/config.json nunca é gravado;
//  C. cérebro separado, pelo canal DE VERDADE (startChannelServer + startBotChannel): o cérebro grava, o bot é avisado e mostra o valor relido; não dono,
//     fora da faixa, cofre travado e confirmação recusados pelo cérebro; cérebro fora = não grava em lugar nenhum.
// Execução: npm run test:painelia   (node tests/test-painel-ia-discord.js)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-ia-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const COFRE = path.join(tmp, 'secrets', 'painel-config.json');
const CONFIG_JSON = path.join(repoRoot, 'src', 'config', 'config.json');
const hashDe = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const configJsonAntes = hashDe(CONFIG_JSON);

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, OWNER_ID: OWNER, OWNER_IDS: '', YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_PAINEL_CONFIG_FILE: COFRE,
  YUI_PAINEL_CONFIG_DPAPI: 'false', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_BANS_FILE: path.join(tmp, 'bans.json'),
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY',
  'AI_BASE_URL', 'AI_MODEL', 'LOCAL_LLM_URL', 'YUI_CEREBRO_EXTERNO', 'YUI_REPLY_MAX_TOKENS', 'YUI_PAINEL_CONFIG_EDIT', 'YUI_READ_ONLY', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY',
  'YUI_GATEWAY_CUSTOM', 'YUI_GATEWAY_DISABLE', 'COMMAND_PREFIX', 'AI_BOT_NAME', 'AI_SYSTEM_PROMPT']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp); // o dotenv do src/config olha a pasta atual: aqui não há .env

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
/** Uma cópia NOVA do módulo (como num processo que acabou de subir). */
const impNovo = (rel, tag) => import(`${pathToFileURL(path.join(repoRoot, rel)).href}?${tag}=${Date.now()}`);
const { default: axios } = await import('axios');
let postHook = null;
axios.post = async (url, body, cfg) => { if (postHook) return postHook(String(url), body, cfg); throw Object.assign(new Error('offline (teste)'), { code: 'ECONNREFUSED' }); };
axios.get = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = async (u) => { throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (!String(file).startsWith(tmp) && /[\\/](data|config)[\\/][^\\/]+\.(json|txt)$/.test(String(file))) throw new Error(`o teste tentou gravar fora da pasta temporária: ${path.basename(String(file))}`);
  return realWrite.call(this, file, ...rest);
};

const cfg = await imp('src/core/painelConfig.js');
const { default: config } = await imp('src/config/index.js');
config.saveHistory = false; // nunca escrever o historico.txt real (a cadeia roda de verdade abaixo)
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const realLog = console.log;
const say = (s) => realLog(s);
console.log = console.warn = console.error = () => {};

const ajustesIa = await imp('src/core/ai/ajustesIa.js');
const pelo = await imp('src/core/ajustesPeloDiscord.js');
const remoto = await imp('src/discord/cofreRemoto.js');
const painel = await imp('src/handlers/configPanelHandler.js');
const llm = await imp('src/handlers/llmHandler.js');
const { LIMITES_PADRAO_CADEIA } = await imp('src/core/ai/limitesTokens.js');
const { buildContext } = await imp('src/core/permissions.js');
const { createAdmin } = await imp('src/core/api/admin.js');
const { buildConversationSystemPrompt } = await imp('src/core/ai/promptConversa.js');
const { loadProviders } = await imp('src/gateway/providers.js');
const criador = await imp('src/handlers/creatorAdminHandler.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 7).join('\n        ')}`); }
};
const section = (t) => say(`\n${t}`);
const item = (chave) => cfg.CATALOGO.find((c) => c.chave === chave);
const json = (e) => (e && typeof e.toJSON === 'function' ? e.toJSON() : e);
const limpar = () => {
  cfg.esquecerParaTeste();
  fs.rmSync(path.join(tmp, 'secrets'), { recursive: true, force: true });
  for (const c of cfg.CATALOGO) delete process.env[c.chave];
  delete process.env.YUI_PAINEL_CONFIG_EDIT;
  delete process.env.YUI_CEREBRO_EXTERNO;
};
const salvoNoCofre = () => (fs.existsSync(COFRE) ? JSON.parse(fs.readFileSync(COFRE, 'utf8')).valores : {});
const ownerCtx = buildContext({ platform: 'api', userId: OWNER, isDM: true });
const admin = createAdmin({ client: null });
const idxDe = (chave) => painel.CONFIG_PAGES.findIndex((p) => p.chave === chave);
const idxDaChave = (key) => painel.CONFIG_PAGES.findIndex((p) => p.key === key);

/** Interação falsa do Discord com o registro de tudo o que o painel respondeu. */
function interacao(customId, { user = OWNER, guildId = null, campo = null, opcoes = null } = {}) {
  const log = [];
  return {
    customId, user: { id: user }, guildId, channelId: '777777777777777777', message: { embeds: [{ footer: { text: 'Página 1/37' } }] },
    fields: { getTextInputValue: (n) => (campo && typeof campo === 'object' ? campo[n] ?? '' : campo) },
    options: { getString: (n) => opcoes?.[n] ?? null, getNumber: (n) => opcoes?.[n] ?? null, getBoolean: (n) => opcoes?.[n] ?? null, getInteger: (n) => opcoes?.[n] ?? null, getSubcommand: () => opcoes?.sub ?? null },
    update: async (p) => { log.push(['update', p]); }, deferUpdate: async () => { log.push(['deferUpdate']); }, editReply: async (p) => { log.push(['editReply', p]); },
    reply: async (p) => { log.push(['reply', p]); }, deferReply: async (p) => { log.push(['deferReply', p]); }, showModal: async (m) => { log.push(['showModal', m]); },
    log,
  };
}
const ultimo = (it) => it.log.at(-1);
const embedDe = (p) => json(p.embeds[0]);
const campoDe = (embed, prefixo) => (embed.fields ?? []).find((f) => f.name.startsWith(prefixo))?.value ?? null;
const idsDe = (p) => (p.components ?? []).flatMap((r) => json(r).components.map((c) => c.custom_id));
async function pagina(n) {
  let capt = null;
  await painel.handleConfigSelect({ customId: 'cfgpanel_goto_select', values: [`cfgpage_${n}`], update: async (p) => { capt = p; } });
  return capt;
}

// Os itens novos do item 6: chave -> [grupo, tipo, padrão (o do código), reinício, confirmação]
const ITEM6 = {
  YUI_IA_MOSTRAR_MODELO: ['Inteligência', 'bool', 'false', false, undefined],
  YUI_IA_MOSTRAR_MODELO_PENSANDO: ['Inteligência', 'bool', 'false', false, undefined],
  YUI_IA_RETENTATIVAS: ['Inteligência', 'int', '0', false, undefined],
  YUI_IA_CONTEXTO_DO_SERVIDOR: ['Inteligência', 'bool', 'true', false, undefined],
  GEMINI_MODEL: ['Inteligência', 'texto', 'gemini-flash-lite-latest', true, undefined],
  GEMINI_MODEL_FALLBACK: ['Inteligência', 'texto', 'gemini-flash-latest', true, undefined],
  GROQ_MODEL: ['Inteligência', 'texto', 'openai/gpt-oss-120b', true, undefined],
  HF_MODEL: ['Inteligência', 'texto', 'Qwen/Qwen2.5-72B-Instruct', true, undefined],
  LOCAL_LLM_MODEL: ['Inteligência', 'texto', 'local-model', true, undefined],
  YUI_IA_LMSTUDIO_TEMPERATURA: ['Inteligência', 'decimal', '0.7', false, undefined],
  YUI_IA_LMSTUDIO_TIMEOUT_MS: ['Inteligência', 'int', '60000', false, undefined],
  YUI_IA_LMSTUDIO_MAX_TOKENS: ['Inteligência', 'int', '1024', false, undefined],
  YUI_IA_GEMINI_TEMPERATURA: ['Inteligência', 'decimal', '0.7', false, undefined],
  YUI_IA_GEMINI_TIMEOUT_MS: ['Inteligência', 'int', '60000', false, undefined],
  YUI_IA_GEMINI_MAX_TOKENS: ['Inteligência', 'int', '2048', false, undefined],
  YUI_IA_POLLINATIONS_TIMEOUT_MS: ['Inteligência', 'int', '60000', false, undefined],
  YUI_IA_POLLINATIONS_MAX_TOKENS: ['Inteligência', 'int', '1024', false, undefined],
  YUI_IA_HF_TEMPERATURA: ['Inteligência', 'decimal', '0.7', false, undefined],
  YUI_IA_HF_TIMEOUT_MS: ['Inteligência', 'int', '60000', false, undefined],
  YUI_IA_HF_MAX_TOKENS: ['Inteligência', 'int', '512', false, undefined],
  YUI_IA_HORDE_TEMPERATURA: ['Inteligência', 'decimal', '0.7', false, undefined],
  YUI_IA_HORDE_TIMEOUT_MS: ['Inteligência', 'int', '60000', false, undefined],
  YUI_IA_HORDE_MAX_TOKENS: ['Inteligência', 'int', '256', false, undefined],
  YUI_AUTOMOD_PADRAO: ['Moderação', 'bool', 'true', false, ['false']],
  YUI_AUTOMOD_MODO_PADRAO: ['Moderação', 'enum', 'both', false, ['off']],
  YUI_CANAL_APELACOES: ['Moderação', 'texto', '', false, undefined],
  YUI_SALVAR_HISTORICO: ['Privacidade', 'bool', 'true', false, ['true']],
  YUI_MUSICA_MANTER_CARTAO: ['Mídia', 'bool', 'true', false, undefined],
};

try {
  section('A. O catálogo e os leitores');
  limpar();
  await test('os 28 itens novos estão no cofre com grupo, tipo, padrão, reinício e confirmação certos; nenhum é segredo', () => {
    assert.equal(Object.keys(ITEM6).length, 28);
    for (const [chave, [grupo, tipo, padrao, reinicio, confirmar]] of Object.entries(ITEM6)) {
      const c = item(chave);
      assert.ok(c, chave);
      assert.deepEqual([c.grupo, c.tipo, c.padrao, c.reinicio, c.confirmar], [grupo, tipo, padrao, reinicio, confirmar], chave);
      assert.ok(!c.secreto && !c.soNaSubida, chave);
      if (c.padrao) assert.equal(cfg.validarValor(c, c.padrao), c.padrao, `${chave}: o padrão passa na validação`);
    }
    for (const c of ['YUI_SALVAR_HISTORICO', 'YUI_AUTOMOD_PADRAO', 'YUI_AUTOMOD_MODO_PADRAO']) assert.match(item(c).descricao, /ATENÇÃO/, c);
  });

  await test('o padrão de cada um é o comportamento de hoje: sem o cofre, a cadeia, a exibição, os modelos e os getters ficam como antes', async () => {
    const t = llm.getProviderSettings();
    for (const [prov, campos] of Object.entries(ajustesIa.VARIAVEIS_DA_CADEIA)) {
      for (const [campo, variavel] of Object.entries(campos)) assert.equal(String(t[prov][campo]), item(variavel).padrao, `${prov}.${campo}`);
      if (campos.max_tokens) assert.equal(Number(item(campos.max_tokens).padrao), LIMITES_PADRAO_CADEIA[prov], `${prov}: a tabela única dos limites`);
    }
    assert.equal(llm.getShowModel(), false);
    assert.equal(llm.getShowModelThinking(), false);
    assert.equal(llm.getErrorRetries(), 0);
    // Os modelos e os getters, numa cópia NOVA do src/config (sem .env nesta pasta e sem nenhuma variável do catálogo).
    const fresco = (await impNovo('src/config/index.js', 'padrao')).default;
    assert.deepEqual([fresco.geminiModel, fresco.geminiModelFallback, fresco.groqModel, fresco.hfModel, fresco.localLlmModel],
      ['GEMINI_MODEL', 'GEMINI_MODEL_FALLBACK', 'GROQ_MODEL', 'HF_MODEL', 'LOCAL_LLM_MODEL'].map((k) => item(k).padrao));
    assert.deepEqual([fresco.saveHistory, fresco.defaultAutoMod, fresco.automodMode, fresco.sendEnvironmentInfo, fresco.keepMusicEmbed, fresco.appealChannelId],
      [true, true, 'both', true, true, '']);
    // O Gateway (bot e cérebro) usa os mesmos modelos por padrão.
    const gw = loadProviders({ GROQ_API_KEY: 'gsk_falsa_0123456789', GEMINI_API_KEY: 'gemini_falsa_0123456789' }).providers;
    assert.ok(JSON.stringify(gw.find((p) => p.id === 'groq').models).includes(item('GROQ_MODEL').padrao));
    assert.ok(JSON.stringify(gw.find((p) => p.id === 'gemini').models).includes(item('GEMINI_MODEL').padrao));
  });

  await test('fica de fora de propósito: endereços, prompt do sistema, prefixo, nome, top_p e a temperatura do Pollinations', () => {
    for (const k of ['LOCAL_LLM_URL', 'GEMINI_URL', 'HF_API_URL', 'GROQ_API_URL', 'HORDE_URL', 'AI_SYSTEM_PROMPT', 'COMMAND_PREFIX', 'AI_BOT_NAME', 'AI_BASE_URL']) {
      assert.ok(!item(k), `${k} não pode entrar no cofre`);
      assert.ok(!pelo.CHAVES_DO_DISCORD.includes(k), k);
    }
    assert.ok(!cfg.CATALOGO.some((c) => /TOP_P|POLLINATIONS_TEMP/.test(c.chave)), 'o top_p e a temperatura do Pollinations nunca chegam ao modelo');
    assert.equal(ajustesIa.VARIAVEIS_DA_CADEIA.pollinations.temperature, undefined);
    for (const p of ['local', 'gemini']) assert.equal(ajustesIa.VARIAVEIS_DA_CADEIA[p].top_p, undefined);
    const paginas = painel.CONFIG_PAGES;
    assert.equal(paginas.length, 37, '40 páginas menos as 3 que não tinham efeito (top_p x2 e temperatura do Pollinations)');
    for (const key of ['prefix', 'botName', 'systemPrompt']) assert.equal(paginas.find((p) => p.key === key).persistence, 'memoria', key);
    for (const key of ['localLlmUrl', 'geminiUrl', 'hfApiUrl', 'groqApiUrl', 'hordeUrl']) assert.equal(paginas.find((p) => p.key === key).persistence, 'env', key);
    assert.ok(!paginas.some((p) => /top_p|pollinations\.temperature/.test(p.key)));
  });

  await test('lista fechada: cada página do cofre é uma chave do Discord, e cada chave do Discord existe no catálogo (nenhum segredo)', () => {
    const doCofre = painel.CONFIG_PAGES.filter((p) => p.persistence === 'cofre').map((p) => p.chave).sort();
    assert.deepEqual(doCofre, [...pelo.CHAVES_DO_DISCORD].sort());
    for (const k of pelo.CHAVES_DO_DISCORD) { assert.ok(item(k), k); assert.ok(!item(k).secreto, k); }
    assert.equal(new Set(pelo.CHAVES_DO_DISCORD).size, pelo.CHAVES_DO_DISCORD.length);
    // o /yui-config_ia só fala com variáveis da cadeia, todas na lista
    for (const campos of Object.values(ajustesIa.VARIAVEIS_DA_CADEIA)) for (const v of Object.values(campos)) assert.ok(pelo.CHAVES_DO_DISCORD.includes(v), v);
    assert.deepEqual([...ajustesIa.TODAS_AS_VARIAVEIS].sort(), pelo.CHAVES_DO_DISCORD.filter((k) => k.startsWith('YUI_IA_') && k !== 'YUI_IA_CONTEXTO_DO_SERVIDOR').sort());
  });

  await test('"vale na hora" só onde TODO leitor lê a cada uso: os da cadeia só pelo bot (ajustesIa), os getters do src/config, e os modelos na subida (a lista de leitores é conferida)', () => {
    const arquivos = [];
    const andar = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) andar(p); else if (/\.(?:m?js)$/.test(e.name)) arquivos.push(p); } };
    andar(path.join(repoRoot, 'src'));
    const rel = (f) => path.relative(repoRoot, f).replace(/\\/g, '/');
    const texto = new Map(arquivos.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]));
    const semComentario = (t) => t.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    // 1. As variáveis da cadeia e da exibição: o nome só aparece no catálogo, no mapa (ajustesIa), na lista do Discord e nas páginas do painel do Discord
    //    (as três da exibição também no /yui-criador modelo, que grava no cofre).
    for (const v of ajustesIa.TODAS_AS_VARIAVEIS) {
      const onde = [...texto].filter(([, t]) => semComentario(t).includes(`'${v}'`)).map(([f]) => f).sort();
      const criadorTambem = Object.values(ajustesIa.VARIAVEIS_GERAIS).includes(v) ? ['src/handlers/creatorAdminHandler.js'] : [];
      assert.deepEqual(onde, ['src/core/ai/ajustesIa.js', 'src/core/ajustesPeloDiscord.js', 'src/core/painelConfig.js', 'src/handlers/configPanelHandler.js', ...criadorTambem].sort(), v);
    }
    // ... e quem LÊ o ambiente por elas é só o ajustesIa, importado só pelo bot (llmHandler e o painel do Discord). O cérebro não importa nem o llmHandler.
    const importamAjustes = [...texto].filter(([, t]) => /from '[^']*ai\/ajustesIa\.js'/.test(t)).map(([f]) => f).sort();
    assert.deepEqual(importamAjustes, ['src/handlers/configPanelHandler.js', 'src/handlers/llmHandler.js']);
    for (const [f, t] of texto) if (f.startsWith('src/cerebro')) assert.ok(!/handlers\/llmHandler\.js|ai\/ajustesIa\.js/.test(t), `${f} não pode ler a cadeia do bot`);
    // 2. Os getters do src/config: o nome só no catálogo, no src/config, na lista e nas páginas do Discord.
    for (const v of ['YUI_SALVAR_HISTORICO', 'YUI_AUTOMOD_PADRAO', 'YUI_AUTOMOD_MODO_PADRAO', 'YUI_IA_CONTEXTO_DO_SERVIDOR', 'YUI_MUSICA_MANTER_CARTAO', 'YUI_CANAL_APELACOES']) {
      const onde = [...texto].filter(([, t]) => semComentario(t).includes(v)).map(([f]) => f).sort();
      assert.deepEqual(onde, ['src/config/index.js', 'src/core/ajustesPeloDiscord.js', 'src/core/painelConfig.js', 'src/handlers/configPanelHandler.js'], v);
    }
    // 3. Os modelos: lidos na SUBIDA (src/config) e pelo Gateway dos dois processos; por isso pedem reinício. Leitor novo obriga a rever.
    const leitores = {
      GEMINI_MODEL: ['src/config/index.js', 'src/gateway/providers.js'],
      GEMINI_MODEL_FALLBACK: ['src/config/index.js', 'src/gateway/providers.js', 'src/services/sttService.js'],
      GROQ_MODEL: ['src/config/index.js', 'src/gateway/providers.js'],
      HF_MODEL: ['src/config/index.js', 'src/gateway/providers.js'],
      LOCAL_LLM_MODEL: ['src/config/index.js'], // (o src/core/dev/llm.js, da aba Código, saiu em 27/11/2026)
    };
    for (const [k, esperado] of Object.entries(leitores)) {
      const re = new RegExp(`\\benv\\??\\.${k}\\b|env\\[['"]${k}['"]\\]`);
      const achados = [...texto].filter(([, t]) => t.split('\n').some((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l) && re.test(l))).map(([f]) => f).sort();
      assert.deepEqual(achados, esperado, k);
      assert.equal(item(k).reinicio, true, k);
    }
    // 4. O bot relê só o que vale na hora: os 23 itens "ao vivo" do item 6 mudam no bot sem reiniciar, os 5 modelos não.
    limpar();
    const valores = { YUI_IA_GEMINI_TEMPERATURA: '1.1', YUI_IA_RETENTATIVAS: '2', YUI_AUTOMOD_MODO_PADRAO: 'mcp', GEMINI_MODEL: 'gemini-flash-latest', GROQ_MODEL: 'openai/gpt-oss-20b' };
    const cerebro = {};
    for (const [k, v] of Object.entries(valores)) cfg.definir(k, v, cerebro);
    const bot = {};
    assert.deepEqual([...cfg.recarregarAoVivo(bot)].sort(), ['YUI_AUTOMOD_MODO_PADRAO', 'YUI_IA_GEMINI_TEMPERATURA', 'YUI_IA_RETENTATIVAS']);
    assert.equal(ajustesIa.lerAjusteIa('YUI_IA_GEMINI_TEMPERATURA', bot), 1.1, 'e o leitor do bot já enxerga');
    limpar();
  });

  await test('o tipo decimal do cofre: vírgula ou ponto, faixa e casas; o erro nunca repete o valor; valor ruim no .env é ignorado pelo leitor', () => {
    const t = item('YUI_IA_GEMINI_TEMPERATURA');
    assert.equal(cfg.validarValor(t, '0,9'), '0.9');
    assert.equal(cfg.validarValor(t, 1.25), '1.25');
    assert.equal(cfg.validarValor(t, '2'), '2');
    for (const ruim of ['2.01', '-0.1', '0.123', 'quente', '1e1', '', ' ']) {
      assert.throws(() => cfg.validarValor(t, ruim), (e) => e instanceof cfg.PainelConfigError && e.status === 400 && !e.message.includes(`${ruim}`.trim() || '\u0000'), String(ruim));
    }
    assert.equal(ajustesIa.lerAjusteIa('YUI_IA_GEMINI_TEMPERATURA', { YUI_IA_GEMINI_TEMPERATURA: '9' }), null, 'fora da faixa no .env vale o padrão');
    assert.equal(ajustesIa.lerAjusteIa('YUI_IA_GEMINI_TEMPERATURA', { YUI_IA_GEMINI_TEMPERATURA: '1.5' }), 1.5);
    assert.equal(ajustesIa.lerAjusteIa('YUI_IA_MOSTRAR_MODELO', { YUI_IA_MOSTRAR_MODELO: 'TRUE' }), true);
    assert.equal(ajustesIa.lerAjusteIa('NAO_EXISTE', { NAO_EXISTE: '1' }), null);
  });

  section('B. Processo único: o painel do Discord grava no cofre');
  await test('o botão "+" grava no cofre e a página mostra o valor RELIDO; o painel web mostra o mesmo; a cadeia usa na PRÓXIMA chamada, sem reiniciar', async () => {
    limpar();
    const idx = idxDe('YUI_IA_LMSTUDIO_TEMPERATURA');
    const it = interacao(`cfgpanel_inc_${idx}`);
    await painel.handleConfigButton(it);
    assert.deepEqual(it.log.map(([k]) => k), ['deferUpdate', 'editReply'], 'responde antes de gravar (o prazo de 3 s do Discord)');
    const e = embedDe(ultimo(it)[1]);
    assert.equal(campoDe(e, '📊'), '`0.8`');
    assert.match(campoDe(e, '✅'), /Gravado no cofre do painel\. Relido do cofre: `0\.8`\. Já vale\./);
    assert.match(campoDe(e, '💽'), /Salvo no cofre: sobrevive ao reinício/);
    assert.ok(idsDe(ultimo(it)[1]).includes(`cfgpanel_reset_${idx}~v1`), 'com o "Voltar ao padrão" (e a versão que a página mostrou, C5)');
    assert.deepEqual(salvoNoCofre(), { YUI_IA_LMSTUDIO_TEMPERATURA: '0.8' });
    const web = (await admin.config(ownerCtx)).itens.find((i) => i.chave === 'YUI_IA_LMSTUDIO_TEMPERATURA');
    assert.deepEqual([web.valor, web.origem, web.reinicio], ['0.8', 'painel', false]);
    // a cadeia do bot (LM Studio é o primeiro): o corpo do pedido já leva 0.8 e o tamanho do cofre
    const modal = interacao(`cfgmodal_${idxDe('YUI_IA_LMSTUDIO_MAX_TOKENS')}`, { campo: '777' });
    await painel.handleConfigModal(modal);
    assert.match(campoDe(embedDe(ultimo(modal)[1]), '✅'), /Relido do cofre: `777`/);
    const corpos = [];
    postHook = async (url, body) => { if (url === config.localLlmUrl) corpos.push(body); throw Object.assign(new Error('offline (teste)'), { code: 'ECONNREFUSED' }); };
    await llm.generateResponse('oi', 'canal-item6-a', { allowSearch: false, disableTools: true });
    postHook = null;
    assert.equal(corpos.length, 1, 'o LM Studio foi tentado uma vez');
    assert.deepEqual([corpos[0].temperature, corpos[0].max_tokens], [0.8, 777]);
  });

  await test('o tamanho do painel vai ao cérebro no fato do canal e o APP não herda (limiteTokens recebe o valor sem o painel)', async () => {
    assert.equal(llm.channelFactsForCerebro({ guildId: null, channelId: null, userId: OWNER }).maxTokens?.local, 777);
    const corpos = [];
    const vistos = [];
    postHook = async (url, body) => { if (url === config.localLlmUrl) corpos.push(body); throw Object.assign(new Error('offline (teste)'), { code: 'ECONNREFUSED' }); };
    await llm.generateResponse('oi', 'canal-item6-app', { allowSearch: false, disableTools: true, limiteTokens: (prov, semPainel) => { vistos.push([prov, semPainel]); return semPainel; } });
    postHook = null;
    assert.deepEqual(vistos.find(([p]) => p === 'local'), ['local', LIMITES_PADRAO_CADEIA.local]);
    assert.equal(corpos[0].max_tokens, LIMITES_PADRAO_CADEIA.local);
  });

  await test('o painel web grava e a página do Discord mostra o MESMO valor (e o /yui-config_ia sem provedor também)', async () => {
    await admin.configSet(ownerCtx, 'YUI_IA_GEMINI_TIMEOUT_MS', '90000');
    await admin.configSet(ownerCtx, 'YUI_IA_MOSTRAR_MODELO', 'true');
    await admin.configSet(ownerCtx, 'GEMINI_MODEL', 'gemini-flash-latest');
    const timeout = embedDe(await pagina(idxDe('YUI_IA_GEMINI_TIMEOUT_MS') + 1));
    assert.equal(campoDe(timeout, '📊'), '`90000` ms (90.0s)');
    assert.match(campoDe(timeout, '💽'), /Salvo no cofre/);
    assert.equal(campoDe(embedDe(await pagina(idxDe('YUI_IA_MOSTRAR_MODELO') + 1)), '📊'), '✅ **Ativado**');
    const modelo = embedDe(await pagina(idxDe('GEMINI_MODEL') + 1));
    assert.equal(campoDe(modelo, '📊'), '`gemini-flash-latest`');
    assert.match(campoDe(modelo, '💽'), /vale depois de reiniciar a Yui/);
    assert.equal(llm.getShowModel(), true, 'e o bot já mostra o modelo (lido a cada uso)');
    assert.equal(llm.getProviderSettings().gemini.timeout, 90000);
    const cmd = interacao(null, { opcoes: {} });
    await painel.handleConfigIaCommand(cmd);
    const lista = embedDe(ultimo(cmd)[1]);
    assert.match(lista.fields.find((f) => f.name === 'Gemini').value, /Timeout \(ms\): `90000`/);
    assert.match(lista.fields.find((f) => f.name === 'Local (LM Studio)').value, /Temperatura: `0\.8`/);
  });

  await test('sobrevive ao reinício: um processo NOVO (módulo do cofre recarregado, ambiente vazio) aplica o cofre e a cadeia lê o mesmo valor', async () => {
    const novoCofre = await impNovo('src/core/painelConfig.js', 'reinicio');
    const ambienteNovo = {};
    novoCofre.aplicarPainelConfig(ambienteNovo);
    assert.deepEqual([ambienteNovo.YUI_IA_LMSTUDIO_TEMPERATURA, ambienteNovo.YUI_IA_LMSTUDIO_MAX_TOKENS, ambienteNovo.YUI_IA_GEMINI_TIMEOUT_MS, ambienteNovo.GEMINI_MODEL], ['0.8', '777', '90000', 'gemini-flash-latest']);
    assert.equal(novoCofre.descreverItem('YUI_IA_LMSTUDIO_TEMPERATURA', ambienteNovo).valor, '0.8');
    // o processo de verdade: o ambiente perde tudo e o boot aplica o cofre de novo
    for (const c of cfg.CATALOGO) delete process.env[c.chave];
    cfg.esquecerParaTeste();
    assert.equal(llm.getProviderSettings().local.temperature, 0.7, 'sem o ambiente, a base');
    cfg.aplicarPainelConfig(process.env);
    assert.equal(llm.getProviderSettings().local.temperature, 0.8);
    assert.equal(embedDe(await pagina(idxDe('YUI_IA_LMSTUDIO_TEMPERATURA') + 1)).fields.find((f) => f.name.startsWith('📊')).value, '`0.8`');
  });

  await test('fora da faixa é RECUSADO (nada é cortado): formulário, botão forjado e /yui-config_ia; o cofre fica como estava', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    for (const [chave, valor] of [['YUI_IA_LMSTUDIO_TEMPERATURA', '5'], ['YUI_IA_HORDE_TIMEOUT_MS', '9999'], ['YUI_IA_RETENTATIVAS', '1.5'], ['YUI_IA_HF_MAX_TOKENS', '99999']]) {
      const it = interacao(`cfgmodal_${idxDe(chave)}`, { campo: valor });
      await painel.handleConfigModal(it);
      const [tipo, p] = ultimo(it);
      assert.equal(tipo, 'editReply', chave);
      assert.match(campoDe(embedDe(p), '❌'), /Não gravei: .*(use um número de|número inteiro)/, chave);
      assert.ok(!campoDe(embedDe(p), '❌').includes(valor), `${chave}: o erro não repete o valor`);
    }
    const letras = interacao(`cfgmodal_${idxDe('YUI_IA_GEMINI_TEMPERATURA')}`, { campo: 'quente' });
    await painel.handleConfigModal(letras);
    assert.match(embedDe(ultimo(letras)[1]).description, /não é um número/);
    const canal = interacao(`cfgmodal_${idxDe('YUI_CANAL_APELACOES')}`, { campo: 'canal-geral' });
    await painel.handleConfigModal(canal);
    assert.match(campoDe(embedDe(ultimo(canal)[1]), '❌'), /formato inválido/);
    const forjado = interacao(`cfgpanel_sel_${idxDe('YUI_AUTOMOD_MODO_PADRAO')}_tudo`);
    await painel.handleConfigButton(forjado);
    assert.equal(ultimo(forjado)[0], 'update', 'opção fora da lista nem chega ao cofre');
    const cmd = interacao(null, { opcoes: { provider: 'horde', setting: 'timeout', value: 999999 } });
    await painel.handleConfigIaCommand(cmd);
    assert.match(embedDe(ultimo(cmd)[1]).description, /Não gravei: .*use um número de 10000 a 300000/);
    const semEfeito = interacao(null, { opcoes: { provider: 'pollinations', setting: 'temperature', value: 0.5 } });
    await painel.handleConfigIaCommand(semEfeito);
    assert.match(embedDe(ultimo(semEfeito)[1]).description, /não recebe temperatura/);
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
  });

  await test('NÃO DONO é barrado mesmo se o botão chegar ao painel (a regra também está no núcleo): o cofre fica como estava', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    const it = interacao(`cfgpanel_toggle_${idxDe('YUI_IA_MOSTRAR_MODELO')}_false`, { user: MEMBER });
    await painel.handleConfigButton(it);
    assert.match(campoDe(embedDe(ultimo(it)[1]), '❌'), /Não gravei: Apenas o dono/);
    const cmd = interacao(null, { user: MEMBER, opcoes: { provider: 'gemini', setting: 'temperature', value: 0.2 } });
    await painel.handleConfigIaCommand(cmd);
    assert.match(embedDe(ultimo(cmd)[1]).description, /Apenas o dono/);
    assert.throws(() => pelo.gravarAjusteDoDiscord({ ctx: buildContext({ platform: 'discord', userId: MEMBER, isDM: true }), chave: 'YUI_IA_RETENTATIVAS', valor: '3' }), (e) => e.status === 403);
    assert.throws(() => pelo.gravarAjusteDoDiscord({ ctx: buildContext({ platform: 'discord', userId: OWNER, isDM: true }), chave: 'AZURE_SPEECH_KEY', valor: 'x'.repeat(20) }), (e) => e.status === 404, 'só a lista fechada do Discord');
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
  });

  await test('cofre TRAVADO (YUI_PAINEL_CONFIG_EDIT=false): a página não oferece edição, o botão forjado não grava e nada vai para outro lugar', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    process.env.YUI_PAINEL_CONFIG_EDIT = 'false';
    try {
      const idx = idxDe('YUI_IA_RETENTATIVAS');
      const p = await pagina(idx + 1);
      assert.match(campoDe(embedDe(p), '🔒'), /desligada/);
      assert.equal(p.components.length, 1, 'só a navegação');
      const it = interacao(`cfgpanel_inc_${idx}`);
      await painel.handleConfigButton(it);
      assert.match(campoDe(embedDe(ultimo(it)[1]), '❌'), /Não gravei: .*desligada/);
      assert.equal(llm.getErrorRetries(), 0, 'nem na memória do bot');
    } finally { delete process.env.YUI_PAINEL_CONFIG_EDIT; }
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
  });

  await test('valores sensíveis pedem CONFIRMAÇÃO (desligar os Termos, AutoMod "off", ligar o histórico) e a remoção deles também; a auditoria só leva o nome', async () => {
    const idx = idxDe('REQUIRE_TOS');
    const pede = interacao(`cfgpanel_toggle_${idx}_false`);
    await painel.handleConfigButton(pede);
    const [tipo, tela] = ultimo(pede);
    assert.equal(tipo, 'update');
    assert.match(embedDe(tela).title, /Confirmar/);
    assert.match(embedDe(tela).description, /ATENÇÃO/);
    assert.deepEqual(idsDe(tela), [`cfgpanel_confirm_${idx}_false`, `cfgpanel_back_${idx + 1}`]);
    assert.equal(salvoNoCofre().REQUIRE_TOS, undefined, 'nada gravado antes de confirmar');
    const conf = interacao(`cfgpanel_confirm_${idx}_false`);
    await painel.handleConfigButton(conf);
    assert.match(campoDe(embedDe(ultimo(conf)[1]), '✅'), /Relido do cofre: ❌ \*\*Desativado\*\*\. Vale depois de reiniciar a Yui\./);
    assert.equal(salvoNoCofre().REQUIRE_TOS, 'false');
    // tirar do cofre também pede confirmação (poderia voltar a um .env mais frouxo)
    const tirar = interacao(`cfgpanel_reset_${idx}`);
    await painel.handleConfigButton(tirar);
    assert.deepEqual(idsDe(ultimo(tirar)[1]), [`cfgpanel_confirmreset_${idx}`, `cfgpanel_back_${idx + 1}`]);
    const tirou = interacao(`cfgpanel_confirmreset_${idx}`);
    await painel.handleConfigButton(tirou);
    assert.match(campoDe(embedDe(ultimo(tirou)[1]), '✅'), /tirado do cofre/);
    assert.equal(salvoNoCofre().REQUIRE_TOS, undefined);
    const off = interacao(`cfgpanel_sel_${idxDe('YUI_AUTOMOD_MODO_PADRAO')}_off`);
    await painel.handleConfigButton(off);
    assert.match(embedDe(ultimo(off)[1]).title, /Confirmar/);
    assert.throws(() => pelo.gravarAjusteDoDiscord({ ctx: buildContext({ platform: 'discord', userId: OWNER, isDM: true }), chave: 'YUI_SALVAR_HISTORICO', valor: 'true' }), (e) => e.status === 428);
    const audit = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => /^admin\.config\./.test(e.event));
    const doDiscord = audit.filter((e) => JSON.stringify(e).includes('"via":"discord"'));
    assert.ok(doDiscord.some((e) => e.event === 'admin.config.set' && JSON.stringify(e).includes('REQUIRE_TOS')));
    assert.ok(doDiscord.some((e) => e.event === 'admin.config.remove'));
    for (const e of doDiscord) assert.ok(!/"valor"|"value"|0\.8|"777"/.test(JSON.stringify(e)), 'a auditoria nunca leva o valor');
  });

  await test('/yui-criador modelo e o formulário "Modelos & Pensamento" do painel master gravam no MESMO cofre e mostram o relido; fora da faixa é recusado sem cortar', async () => {
    const cmd = interacao(null, { opcoes: { sub: 'modelo', mostrar_nome: false, retentativas: 4 } });
    await criador.handleCreatorAdminCommand(cmd, null);
    assert.deepEqual(cmd.log.map(([k]) => k), ['deferReply', 'editReply']);
    const e = embedDe(ultimo(cmd)[1]);
    assert.deepEqual(e.fields.map((f) => f.value), ['❌ Não', 'Não alterado', '✅ 4']);
    assert.equal(salvoNoCofre().YUI_IA_RETENTATIVAS, '4');
    assert.equal(salvoNoCofre().YUI_IA_MOSTRAR_MODELO, 'false');
    assert.equal(llm.getErrorRetries(), 4, 'a cadeia já usa');
    const modal = interacao('crtcfg_modal_modelos', { campo: { mostrar_nome: 'sim', mostrar_pensamento: 'NAO', retentativas: '15' } });
    await criador.handleCreatorAdminInteraction(modal, null);
    const m = embedDe(ultimo(modal)[1]);
    assert.deepEqual(m.fields.slice(0, 2).map((f) => f.value), ['✅ Sim', '❌ Não']);
    assert.match(m.fields[2].value, /Não gravei: .*de 0 a 10/);
    assert.equal(salvoNoCofre().YUI_IA_RETENTATIVAS, '4', 'o 15 foi recusado, não cortado para 10');
    assert.equal(salvoNoCofre().YUI_IA_MOSTRAR_MODELO, 'true');
    const membro = interacao('crtcfg_modal_modelos', { user: MEMBER, campo: { mostrar_nome: 'NAO', mostrar_pensamento: 'NAO', retentativas: '0' } });
    await criador.handleCreatorAdminInteraction(membro, null);
    assert.equal(salvoNoCofre().YUI_IA_MOSTRAR_MODELO, 'true', 'não dono: recusado antes (e o núcleo também recusaria)');
  });

  await test('os getters do src/config (moderação, histórico, cartão da música, contexto do servidor) leem a CADA uso; o prompt dos dois processos segue o cofre', async () => {
    const it = interacao(`cfgpanel_toggle_${idxDe('YUI_IA_CONTEXTO_DO_SERVIDOR')}_false`);
    await painel.handleConfigButton(it);
    assert.equal(config.sendEnvironmentInfo, false);
    assert.ok(!buildConversationSystemPrompt({ guildName: 'Servidor X', channelName: 'geral' }).withMemory.includes('[CONTEXTO DO AMBIENTE]'));
    await painel.handleConfigButton(interacao(`cfgpanel_toggle_${idxDe('YUI_IA_CONTEXTO_DO_SERVIDOR')}_true`));
    assert.ok(buildConversationSystemPrompt({ guildName: 'Servidor X', channelName: 'geral' }).withMemory.includes('[CONTEXTO DO AMBIENTE]'));
    await painel.handleConfigButton(interacao(`cfgpanel_sel_${idxDe('YUI_AUTOMOD_MODO_PADRAO')}_trigger`));
    assert.equal(config.automodMode, 'trigger');
    await painel.handleConfigButton(interacao(`cfgpanel_toggle_${idxDe('YUI_MUSICA_MANTER_CARTAO')}_false`));
    assert.equal(config.keepMusicEmbed, false);
    await painel.handleConfigModal(interacao(`cfgmodal_${idxDe('YUI_CANAL_APELACOES')}`, { campo: '123456789012345678' }));
    assert.equal(config.appealChannelId, '123456789012345678');
    const fresco = (await impNovo('src/config/index.js', 'historico')).default; // o teste fixou o saveHistory deste: a cópia nova lê o ambiente
    process.env.YUI_SALVAR_HISTORICO = 'false';
    assert.equal(fresco.saveHistory, false);
    process.env.YUI_SALVAR_HISTORICO = 'true';
    assert.equal(fresco.saveHistory, true);
    delete process.env.YUI_SALVAR_HISTORICO;
  });

  await test('prefixo, nome e prompt continuam só na memória (fora do cofre); os endereços são só leitura (sem botão, sem formulário)', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    const idx = idxDaChave('prefix');
    const p = embedDe(await pagina(idx + 1));
    assert.match(campoDe(p, '💽'), /Só na memória do bot.*desenho da Liz/);
    await painel.handleConfigModal(interacao(`cfgmodal_${idx}`, { campo: '!yui' }));
    assert.equal(config.prefix, '!yui');
    config.prefix = '+yui';
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes, 'nada no cofre');
    const url = idxDaChave('geminiUrl');
    const pu = await pagina(url + 1);
    assert.match(campoDe(embedDe(pu), '💽'), /Só no \.env \(`GEMINI_URL`\)/);
    assert.equal(pu.components.length, 1);
    const forjado = interacao(`cfgpanel_input_${url}`);
    await painel.handleConfigButton(forjado);
    assert.equal(ultimo(forjado)[0], 'update', 'não abre formulário');
  });

  await test('o src/config/config.json NUNCA é gravado (o arquivo continua no disco, intacto) e o painel não tem mais código para gravá-lo', () => {
    assert.equal(hashDe(CONFIG_JSON), configJsonAntes);
    assert.ok(fs.existsSync(CONFIG_JSON));
    const src = fs.readFileSync(path.join(repoRoot, 'src/handlers/configPanelHandler.js'), 'utf8');
    assert.ok(!/writeFileSync|config\.json'|updateConfigJson/.test(src));
    assert.equal(painel.updateConfigJson, undefined);
  });

  section('D. Versão por ajuste: ninguém sobrescreve sem ver (correção C5 do parecer da Liz)');
  const textoDoArquivo = () => fs.readFileSync(COFRE, 'utf8');
  const versaoNoArquivo = (chave) => JSON.parse(textoDoArquivo()).versoes?.[chave] ?? 0;
  await test('o cofre: cada gravação e cada remoção sobem a versão (a remoção não zera); a tela e a página do Discord mostram a versão; lixo no arquivo é ignorado', async () => {
    limpar();
    assert.equal(cfg.definir('YUI_IA_MOSTRAR_MODELO', 'true').versao, 1);
    assert.equal(cfg.definir('YUI_IA_MOSTRAR_MODELO', 'false').versao, 2);
    assert.equal(cfg.remover('YUI_IA_MOSTRAR_MODELO').versao, 3);
    assert.equal(versaoNoArquivo('YUI_IA_MOSTRAR_MODELO'), 3, 'continua no arquivo depois de remover');
    assert.equal(cfg.definir('YUI_IA_MOSTRAR_MODELO', 'true').versao, 4);
    assert.equal((await admin.config(ownerCtx)).itens.find((i) => i.chave === 'YUI_IA_MOSTRAR_MODELO').versao, 4);
    assert.equal(cfg.descreverItem('YUI_IA_MOSTRAR_MODELO').versao, 4);
    assert.equal((await admin.config(ownerCtx)).itens.find((i) => i.chave === 'YUI_IA_RETENTATIVAS').versao, 0, 'nunca gravado = 0');
    const bruto = JSON.parse(textoDoArquivo());
    bruto.versoes = { ...bruto.versoes, YUI_IA_RETENTATIVAS: -3, YUI_IA_CONTEXTO_DO_SERVIDOR: 'dez', NAO_EXISTE: 9 };
    fs.writeFileSync(COFRE, JSON.stringify(bruto));
    cfg.esquecerParaTeste();
    const itens = (await admin.config(ownerCtx)).itens;
    assert.deepEqual(['YUI_IA_RETENTATIVAS', 'YUI_IA_CONTEXTO_DO_SERVIDOR'].map((k) => itens.find((i) => i.chave === k).versao), [0, 0]);
    assert.equal(itens.find((i) => i.chave === 'YUI_IA_MOSTRAR_MODELO').versao, 4);
  });
  await test('painel web: gravar com a versão velha dá 409 com a frase certa e NADA muda; com a atual grava; versão inválida = 400; sem versão grava (pedido antigo)', async () => {
    limpar();
    await admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '1'); // versão 1
    cfg.definir('YUI_IA_RETENTATIVAS', '2'); // "o Discord" grava no meio: versão 2
    const antes = textoDoArquivo();
    await assert.rejects(admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '5', undefined, 1), (e) => e.status === 409 && e.message.startsWith(cfg.TEXTO_VERSAO_MUDOU));
    await assert.rejects(admin.configRemove(ownerCtx, 'YUI_IA_RETENTATIVAS', undefined, 1), (e) => e.status === 409);
    assert.equal(textoDoArquivo(), antes, 'nada foi sobrescrito');
    for (const ruim of [-1, 1.5, 'abc', '1e3', {}]) await assert.rejects(admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '5', undefined, ruim), (e) => e.status === 400, String(ruim));
    assert.equal(textoDoArquivo(), antes);
    assert.equal((await admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '5', undefined, 2)).versao, 3);
    assert.equal((await admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '6', undefined, '3')).versao, 4, 'a versão em texto de dígitos também vale');
    assert.equal((await admin.configSet(ownerCtx, 'YUI_IA_RETENTATIVAS', '7')).versao, 5, 'sem versão: grava sem conferir');
    assert.equal(salvoNoCofre().YUI_IA_RETENTATIVAS, '7');
  });
  await test('painel do Discord: os botões levam a versão; botão de uma página velha (o painel web gravou no meio) é recusado e a página volta com o valor atual', async () => {
    limpar();
    const chave = 'YUI_IA_MOSTRAR_MODELO_PENSANDO';
    const idx = idxDe(chave);
    cfg.definir(chave, 'false'); // versão 1
    const ids = idsDe(await pagina(idx + 1));
    assert.ok(ids.includes(`cfgpanel_toggle_${idx}_true~v1`) && ids.includes(`cfgpanel_reset_${idx}~v1`), ids.join(' '));
    await admin.configSet(ownerCtx, chave, 'true'); // o painel web grava: versão 2
    const antes = textoDoArquivo();
    const velho = interacao(`cfgpanel_reset_${idx}~v1`);
    await painel.handleConfigButton(velho);
    assert.match(campoDe(embedDe(ultimo(velho)[1]), '❌'), /mudou enquanto você editava/);
    assert.equal(campoDe(embedDe(ultimo(velho)[1]), '📊'), '✅ **Ativado**', 'a página mostra o valor atual');
    assert.equal(textoDoArquivo(), antes);
    const atual = interacao(`cfgpanel_toggle_${idx}_false~v2`);
    await painel.handleConfigButton(atual);
    assert.match(campoDe(embedDe(ultimo(atual)[1]), '✅'), /Gravado no cofre/);
    assert.deepEqual([salvoNoCofre()[chave], versaoNoArquivo(chave)], ['false', 3]);
  });
  await test('painel do Discord: o formulário leva a versão do botão que o abriu; enviado depois de outra gravação, é recusado', async () => {
    limpar();
    const chave = 'YUI_IA_GEMINI_MAX_TOKENS';
    const idx = idxDe(chave);
    cfg.definir(chave, '1000'); // versão 1
    const abrir = interacao(`cfgpanel_input_${idx}~v1`);
    await painel.handleConfigButton(abrir);
    assert.equal(json(ultimo(abrir)[1]).custom_id, `cfgmodal_${idx}~v1`);
    cfg.definir(chave, '1500'); // outra gravação no meio: versão 2
    const enviar = interacao(`cfgmodal_${idx}~v1`, { campo: '3000' });
    await painel.handleConfigModal(enviar);
    assert.match(campoDe(embedDe(ultimo(enviar)[1]), '❌'), /mudou enquanto você editava/);
    assert.equal(salvoNoCofre()[chave], '1500');
    const deNovo = interacao(`cfgmodal_${idx}~v2`, { campo: '3000' });
    await painel.handleConfigModal(deNovo);
    assert.equal(salvoNoCofre()[chave], '3000');
  });
  await test('painel do Discord: a tela de confirmação (valor sensível) carrega a versão até o "Confirmar"', async () => {
    limpar();
    const chave = 'YUI_SALVAR_HISTORICO';
    const idx = idxDe(chave);
    cfg.definir(chave, 'false'); // versão 1
    const pedir = interacao(`cfgpanel_toggle_${idx}_true~v1`);
    await painel.handleConfigButton(pedir);
    assert.ok(idsDe(ultimo(pedir)[1]).includes(`cfgpanel_confirm_${idx}_true~v1`), idsDe(ultimo(pedir)[1]).join(' '));
    cfg.definir(chave, 'false'); // versão 2
    const confirmar = interacao(`cfgpanel_confirm_${idx}_true~v1`);
    await painel.handleConfigButton(confirmar);
    assert.match(campoDe(embedDe(ultimo(confirmar)[1]), '❌'), /mudou enquanto você editava/);
    assert.equal(salvoNoCofre()[chave], 'false');
  });
  await test('painel master ("Modelos & Pensamento"): o formulário leva as 3 versões; a chave que mudou no meio é recusada e as outras gravam; o formulário antigo (sem versões) ainda funciona', async () => {
    limpar();
    cfg.definir('YUI_IA_MOSTRAR_MODELO', 'false'); // v1
    const abrir = interacao('crtcfg_btn_modelos');
    await criador.handleCreatorAdminInteraction(abrir, null);
    const id = json(ultimo(abrir)[1]).custom_id;
    assert.equal(id, 'crtcfg_modal_modelos~v1.0.0');
    assert.ok(criador.MODAL_MODELOS_RE.test(id) && criador.MODAL_MODELOS_RE.test('crtcfg_modal_modelos'));
    cfg.definir('YUI_IA_MOSTRAR_MODELO', 'false'); // v2: mudou no meio
    const enviar = interacao(id, { campo: { mostrar_nome: 'SIM', mostrar_pensamento: 'SIM', retentativas: '3' } });
    await criador.handleCreatorAdminInteraction(enviar, null);
    const campos = embedDe(ultimo(enviar)[1]).fields;
    assert.match(campos[0].value, /Não gravei: .*mudou enquanto você editava/);
    assert.deepEqual([campos[1].value, campos[2].value], ['✅ Sim', '✅ 3']);
    assert.deepEqual([salvoNoCofre().YUI_IA_MOSTRAR_MODELO, salvoNoCofre().YUI_IA_MOSTRAR_MODELO_PENSANDO, salvoNoCofre().YUI_IA_RETENTATIVAS], ['false', 'true', '3']);
    const antigo = interacao('crtcfg_modal_modelos', { campo: { mostrar_nome: 'SIM', mostrar_pensamento: 'NAO', retentativas: '' } });
    await criador.handleCreatorAdminInteraction(antigo, null);
    assert.equal(salvoNoCofre().YUI_IA_MOSTRAR_MODELO, 'true');
  });
  await test('as fontes: o app manda a versão que viu ao gravar e ao desfazer, e recarrega a tela no 409', () => {
    const tela = fs.readFileSync(path.join(repoRoot, 'apps/yui-app/src/screens/AdminConfig.tsx'), 'utf8');
    assert.ok(tela.includes('client.admin.configSet(item.chave, valor, confirm, item.versao)'));
    assert.ok(tela.includes('client.admin.configRemove(item.chave, Boolean(item.confirmar), item.versao)'));
    assert.equal((tela.match(/e\.status === 409\) await reload\(\)/g) ?? []).length, 2);
    const cliente = fs.readFileSync(path.join(repoRoot, 'apps/yui-app/src/api/client.ts'), 'utf8');
    assert.ok(cliente.includes("...(typeof versao === 'number' ? { versao } : {})"));
  });

  section('C. Cérebro separado: o Discord grava pelo canal de verdade');
  const { startChannelServer } = await imp('src/core/channel/server.js');
  const { connectChannel } = await imp('src/core/channel/client.js');
  const { registerCerebroMethods } = await imp('src/cerebro/metodos.js');
  const { startBotChannel } = await imp('src/discord/canalCerebro.js');
  const facade = await imp('src/core/memory/facade.js');
  const quieto = { info() {}, warn() {}, error() {}, debug() {} };
  const secretFile = path.join(tmp, 'canal', 'canal.json');
  // Sob o bloqueio do CI o whoami/icacls de verdade é barrado: a restrição real do arquivo do segredo é coberta em test:channel e test:separacao.
  let server = await startChannelServer({ port: 0, secretFile, logger: quieto, restrictFile: () => {} });
  registerCerebroMethods(server, { research: async () => ({ runResearchFor: async () => ({}) }) });
  let client = null;
  const botChannel = startBotChannel({ getClient: () => null, logger: quieto, idemFile: null, connect: (o) => (client = connectChannel({ ...o, secretFile, minBackoffMs: 50, maxBackoffMs: 200 })) });
  let avisos = 0;
  botChannel.on('painel.settingsChanged', () => { avisos += 1; });
  await botChannel.ready(10_000);
  const esperarAviso = async (n) => { for (let i = 0; i < 50 && avisos < n; i += 1) await new Promise((r) => setTimeout(r, 20)); };

  await test('o botão do Discord grava pelo cérebro: o arquivo muda, o bot é avisado (sem valores) e a página mostra o valor relido; o painel web mostra o mesmo', async () => {
    limpar();
    process.env.YUI_CEREBRO_EXTERNO = 'true';
    const idx = idxDe('YUI_IA_HF_TEMPERATURA');
    const it = interacao(`cfgpanel_inc_${idx}`);
    await painel.handleConfigButton(it);
    assert.match(campoDe(embedDe(ultimo(it)[1]), '✅'), /Relido do cofre: `0\.8`/);
    assert.deepEqual(salvoNoCofre(), { YUI_IA_HF_TEMPERATURA: '0.8' });
    await esperarAviso(1);
    assert.equal(avisos, 1, 'o cérebro avisou o bot');
    assert.equal(cfg.descreverItem('YUI_IA_HF_TEMPERATURA', {}).valor, '0.8', 'um bot com ambiente próprio relê o mesmo do arquivo');
    const web = (await admin.config(ownerCtx)).itens.find((i) => i.chave === 'YUI_IA_HF_TEMPERATURA');
    assert.deepEqual([web.valor, web.origem], ['0.8', 'painel']);
    const cmd = interacao(null, { opcoes: { provider: 'local', setting: 'max_tokens', value: 2048 } });
    await painel.handleConfigIaCommand(cmd);
    assert.match(embedDe(ultimo(cmd)[1]).fields.find((f) => f.name.startsWith('Valor')).value, /2048/);
    assert.equal(salvoNoCofre().YUI_IA_LMSTUDIO_MAX_TOKENS, '2048');
    const modelo = interacao(null, { opcoes: { sub: 'modelo', mostrar_pensamento: true } });
    await criador.handleCreatorAdminCommand(modelo, null);
    assert.equal(embedDe(ultimo(modelo)[1]).fields[1].value, '✅ Sim', 'o /yui-criador modelo também vai pelo cérebro');
    assert.equal(salvoNoCofre().YUI_IA_MOSTRAR_MODELO_PENSANDO, 'true');
  });

  await test('o cérebro barra não dono, valor fora da faixa, chave fora da lista e valor sensível sem confirmação; nada é gravado', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    const casos = [
      [{ userId: MEMBER, chave: 'YUI_IA_RETENTATIVAS', valor: '2' }, 403, /Apenas o dono/],
      [{ userId: OWNER, chave: 'YUI_IA_RETENTATIVAS', valor: '11' }, 400, /de 0 a 10/],
      [{ userId: OWNER, chave: 'YUI_TTS_OMNIROUTE_VOZ', valor: 'Kore' }, 404, /não pode ser mudado pelo Discord/],
      [{ userId: OWNER, chave: 'REQUIRE_TOS', valor: 'false' }, 428, /Confirmação necessária/],
      // C5: a versão que a página mostrou vai pelo canal e o cérebro confere (o botão "+" acima levou a temperatura do HF à versão 1)
      [{ userId: OWNER, chave: 'YUI_IA_HF_TEMPERATURA', valor: '0.5', versao: 0 }, 409, /mudou enquanto você editava/],
    ];
    for (const [pedido, status, re] of casos) {
      await assert.rejects(remoto.gravarPeloDiscord(pedido), (e) => e instanceof cfg.PainelConfigError && e.status === status && re.test(e.message), JSON.stringify(pedido));
    }
    const it = interacao(`cfgpanel_toggle_${idxDe('YUI_IA_MOSTRAR_MODELO_PENSANDO')}_true`, { user: MEMBER });
    await painel.handleConfigButton(it);
    assert.match(campoDe(embedDe(ultimo(it)[1]), '❌'), /Apenas o dono/);
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
  });

  await test('cofre travado no cérebro: o Discord responde que não conseguiu e não grava em lugar nenhum', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    process.env.YUI_PAINEL_CONFIG_EDIT = 'false';
    try {
      await assert.rejects(remoto.gravarPeloDiscord({ userId: OWNER, chave: 'YUI_IA_RETENTATIVAS', valor: '2' }), (e) => e.status === 403 && /desligada/.test(e.message));
    } finally { delete process.env.YUI_PAINEL_CONFIG_EDIT; }
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
    assert.equal(llm.getErrorRetries(), 0);
  });

  await test('CÉREBRO FORA: o Discord diz que não conseguiu; nada no cofre, no ambiente, na memória do bot nem no config.json', async () => {
    const antes = fs.readFileSync(COFRE, 'utf8');
    await server.close();
    for (let i = 0; i < 50 && client.connected; i += 1) await new Promise((r) => setTimeout(r, 20));
    const idx = idxDe('YUI_IA_RETENTATIVAS');
    const it = interacao(`cfgpanel_inc_${idx}`);
    await painel.handleConfigButton(it);
    assert.match(campoDe(embedDe(ultimo(it)[1]), '❌'), /Não gravei: o cérebro da Yui está fora agora/);
    const cmd = interacao(null, { opcoes: { provider: 'hf', setting: 'timeout', value: 90000 } });
    await painel.handleConfigIaCommand(cmd);
    assert.match(embedDe(ultimo(cmd)[1]).description, /cérebro da Yui está fora/);
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
    assert.equal(process.env.YUI_IA_RETENTATIVAS, undefined);
    assert.equal(llm.getErrorRetries(), 0);
    assert.equal(hashDe(CONFIG_JSON), configJsonAntes);
    // sem o pedido ao cérebro instalado (o bot separado ainda subindo): também não grava aqui
    remoto.definirCofreRemoto(null);
    await assert.rejects(remoto.gravarPeloDiscord({ userId: OWNER, chave: 'YUI_IA_RETENTATIVAS', valor: '1' }), (e) => e.status === 503);
    assert.equal(fs.readFileSync(COFRE, 'utf8'), antes);
  });

  try { await client?.close(); } catch { /* */ }
  facade.setMemoryRemote(null);
  remoto.definirCofreRemoto(null);
  limpar();
} finally {
  fs.writeFileSync = realWrite;
}

say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
try { (await import(pathToFileURL(path.join(repoRoot, 'src/database/db.js')).href)).closeAllDatabases(); } catch { /* */ }
process.chdir(os.tmpdir());
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
process.exit(failures.length ? 1 : 0);
