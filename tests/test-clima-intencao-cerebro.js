// O CLIMA e a PESQUISA POR INTENÇÃO no cérebro, de ponta a ponta num processo só (etapa 11, docs/RELATORIO_ETAPA11_CLIMA_E_INTENCAO.md):
//  A. o clima no chat.turn (src/cerebro/conversa.js): o Open-Meteo FALSO num servidor em 127.0.0.1 (tests/helpers/climaFalso.js) e a IA falsa. O dado do clima chega ao
//     prompt CERCADO como dado externo não confiável, as ferramentas saem da chamada, a resposta sai UMA vez; vale na DM do dono, na DM de um membro e no servidor, sem
//     precisar de YUI_PRIVATE_SEARCH nem da chave da pesquisa por intenção; o servidor falso só viu o NOME DO LOCAL e as coordenadas (nunca o texto da conversa); falha,
//     cota, local não achado e "sem cidade" viram UMA frase fixa da Yui, sem chamar a IA; a resposta curta a "De qual cidade?" é o local;
//  B. a pesquisa por intenção no chat.turn: a mesma busca automática de sempre (só a fala do autor vai ao buscador), a conversa privada só do dono e só com
//     YUI_PRIVATE_SEARCH (privado: true, sem otimizador, sem cache), as combinações dono/membro x DM/servidor x a chave, a reserva da cota, o diário da retomada, a
//     falha (nota ao modelo, e o texto único quando a pesquisa está indisponível) e tudo que NÃO pode pesquisar;
//  C. a FILA de verdade do llmHandler (bot) ligada ao cérebro: a frase exata "Olá, poderia ver o clima de Cuiabá-MT para essa semana?" na DM do dono recebe UMA resposta com
//     o clima (e não a recusa da pesquisa privada), e a pergunta de dado atual na DM do dono pesquisa em vez de recusar;
//  D. o /yui (chat.yui): o clima e a busca por intenção na conversa privada.
// SEM rede de verdade (o clima fala só com o servidor local do teste; buscadores, IA e Discord são falsos), SEM bancos reais (pasta temporária).
// Execução: npm run test:climaintencao   (node tests/test-clima-intencao-cerebro.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { abrirClimaFalso } from './helpers/climaFalso.js';

const fetchReal = globalThis.fetch; // o clima fala SÓ com o servidor local do teste (a fetch global é trocada por uma que falha, abaixo)
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-clima-intencao-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const REGISTRO = path.join(tmp, 'buscas.jsonl');
const BUSCA_CTRL = path.join(tmp, 'busca-controle.json');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'off',
  YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '8000', NODE_ENV: 'test',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890', YUI_POLICY_MODE: 'observe',
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_CHAT_TURN_TIMEOUT_MS', 'YUI_HISTORY_MAX_CHANNELS', 'YUI_REPLY_MAX_TOKENS',
  'YUI_CEREBRO_BUSCA_AUTOMATICA', 'YUI_READ_ONLY', 'YUI_PESQUISA_POR_INTENCAO', 'YUI_CLIMA', 'YUI_CLIMA_CIDADE_PADRAO', 'YUI_CLIMA_POR_HORA', 'YUI_SEARCH_USER_PER_HOUR',
  'YUI_SEARCH_GLOBAL_PER_HOUR', 'YUI_CEREBRO_BUSCA_RESERVA']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
axios.post = async () => { throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = async (u) => { throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (/[\\/]data[\\/][^\\/]+\.json$/.test(String(file)) && !String(file).startsWith(tmp)) return undefined; // nada nos arquivos de dados reais
  return realWrite.call(this, file, ...rest);
};
const realAppendFile = fs.appendFile;
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) { if (typeof cb === 'function') cb(null); return undefined; }
  return realAppendFile.call(this, file, data, cb);
};

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const llm = await imp('src/handlers/llmHandler.js');
const conversa = await imp('src/cerebro/conversa.js');
const pesquisa = await imp('src/cerebro/pesquisa.js');
const turno = await imp('src/discord/turnoCerebro.js');
const { createFakeSearch } = await imp('src/cerebro/buscaFalsa.js');
const { createIdemCache } = await imp('src/core/channel/protocol.js');
const { createClimaService, TEXTO_CLIMA_FALHA, TEXTO_CLIMA_SEM_CIDADE, TEXTO_CLIMA_LOCAL_NAO_ACHADO, TEXTO_CLIMA_LIMITE } = await imp('src/core/tools/clima.js');
const { createBudget } = await imp('src/search/budget.js');
const { avaliarPesquisaPorIntencao } = await imp('src/cerebro/intencaoBusca.js');
const { createRetomadaDePesquisa } = await imp('src/cerebro/pesquisaRetomada.js');
const { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, PRIVATE_SEARCH_NEEDS_EXPLICIT } = await imp('src/core/ai/llmSafety.js');
const { TEXTO_PESQUISA_INDISPONIVEL, resultadoIndisponivel } = await imp('src/search/indisponivel.js');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const META = { role: 'bot' };
let idSeq = 960000000000000000n;
const nextId = () => String(++idSeq);
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const registro = () => { try { return fs.readFileSync(REGISTRO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const limparRegistro = () => { try { fs.rmSync(REGISTRO, { force: true }); } catch { /* */ } };
const buscaControle = (c) => realWrite(BUSCA_CTRL, JSON.stringify(c));
buscaControle({});
const busca = createFakeSearch({ env: { YUI_TESTE_BUSCA_FALSA_REGISTRO: REGISTRO, YUI_TESTE_BUSCA_FALSA_CONTROLE: BUSCA_CTRL } });
const srv = await abrirClimaFalso({ hoje: '2026-11-18' });

/** IA falsa: guarda cada chamada (com `tipo`) e responde com as marcas do que recebeu e se o prompt trazia o clima ou a web. */
function fakeAi({ reply = null } = {}) {
  const calls = [];
  const answer = async (a, isolated) => {
    const sys = String(a.system ?? '');
    const prompt = String(a.prompt ?? '');
    let tipo = 'conversa';
    if (sys === 'Responda apenas com o comando solicitado.') tipo = 'otimizador';
    else if (prompt.includes('[PERGUNTA DO USUÁRIO]:')) tipo = 'sintese';
    calls.push({ ...a, tipo, isolated });
    if (tipo === 'otimizador') { const m = /ENTRADA: "([^"]*)"/.exec(prompt); return `SIM: ${m ? m[1] : 'consulta'}`; }
    if (tipo === 'sintese') return `Segundo as fontes [1], está tudo certo. marcas=[${tokensOf(prompt).join(',')}]`;
    if (typeof reply === 'function') return reply(a, calls.length);
    const clima = prompt.includes('[DADOS DO CLIMA');
    const web = prompt.includes('[CONTEXTO OBTIDO NA WEB]');
    return `resposta da conversa clima=${clima ? 'sim' : 'nao'} web=${web ? 'sim' : 'nao'} ferramentas=${sys.includes('--- FERRAMENTAS DISPONÍVEIS ---') ? 'sim' : 'nao'} marcas=[${tokensOf(prompt).join(',')}]`;
  };
  return { calls, listBackends: () => [{ name: 'falsa', active: true }], chat: (a) => answer(a, false), isolatedChat: (a) => answer(a, true) };
}
const channelFacts = (guild, channel, user) => llm.channelFactsForCerebro({ guildId: guild, channelId: channel, userId: user });
function facts({ id = nextId(), user, guild = null, channel, text, call = {}, entry = 'fila', channelExtra = {} } = {}) {
  return {
    turn: { id, at: Date.now() - 500 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry, type: entry === 'yui' ? 'slash' : 'mention', record: true, mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false, ...call },
    ownText: text, memoryQuery: text, channel: { ...channelFacts(guild, channel, user), ...channelExtra },
  };
}
const climaServico = (env = {}, extra = {}) => createClimaService({ env: { NODE_ENV: 'test', ...env }, urls: srv.urls, fetchImpl: fetchReal, timeoutMs: 2000, ...extra });
function brains({ ai = fakeAi(), clima = climaServico(), budget = null, retomada = null, context = null, env = process.env, avaliarIntencao = null, extra = {}, log = quiet } = {}) {
  const chat = conversa.createChatBrain({ ai, logger: log, busca, env, memoryBlock: () => '', persona: () => '', clima, ...(budget ? { budget } : {}), ...(retomada ? { retomada } : {}), ...(context ? { context } : {}), ...(avaliarIntencao ? { avaliarIntencao } : {}), ...extra });
  const research = pesquisa.createResearchBrain({ chat, ai, logger: quiet, busca, env, emit: () => 0, ...(budget ? { budget } : {}), ...(retomada ? { retomada } : {}) });
  return { chat, research, ai };
}
/** O passo principal da fila: o prompt que o bot monta (o CONTEXTO com a fala de OUTRA pessoa + a mensagem atual) e as opções da chamada principal. */
async function principal(chat, { user, guild = null, channel, text, call = {}, options = {}, idem = null, channelExtra = {} }) {
  const f = facts({ user, guild, channel, text, call, channelExtra });
  const prompt = `--- CONTEXTO ---\nOutra pessoa: "tok-OUTRO bom dia"\n--- MENSAGEM ATUAL ---\nusuário: "${text}"`;
  const out = await chat.turn({ ...f, step: 1, prompt, options: { main: true, persona: true, memory: true, ...options } }, { ...META, idem: idem ?? `chat.turn:${f.turn.id}:1` });
  return { out, f };
}
async function conEnv(vars, fn) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const conversaAi = (ai) => ai.calls.filter((c) => c.tipo === 'conversa');
const DM = { guild: null, channel: DMCH };
const SRV = { guild: GUILD, channel: CHAN };
const FRASE_DO_DONO = 'Olá, poderia ver o clima de Cuiabá-MT para essa semana?';

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. O clima no chat.turn');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('servidor, um membro: o dado do clima chega ao prompt CERCADO como dado externo; as ferramentas saem; UMA chamada à IA; só o nome do local e as coordenadas saem para o clima', async () => {
    srv.limpar();
    const { chat, ai } = brains();
    const { out, f } = await principal(chat, { user: MEMBER, ...SRV, text: `${FRASE_DO_DONO} tok-W1` });
    assert.equal(out.failed, false);
    assert.equal(out.usedClima, true);
    assert.equal(out.usedSearch, false, 'o clima não é pesquisa na web');
    assert.match(out.text, /clima=sim web=nao ferramentas=nao/);
    assert.equal(conversaAi(ai).length, 1, 'a IA responde UMA vez');
    const c = conversaAi(ai)[0];
    assert.ok(c.prompt.includes('[DADOS DO CLIMA (fonte: Open-Meteo.com)]:'));
    assert.equal(c.prompt.split(UNTRUSTED_OPEN).length - 1, 1, 'uma abertura do cercado');
    assert.equal(c.prompt.split(UNTRUSTED_CLOSE).length - 1, 1, 'um fechamento do cercado');
    const dentro = c.prompt.slice(c.prompt.indexOf(UNTRUSTED_OPEN), c.prompt.indexOf(UNTRUSTED_CLOSE));
    assert.match(dentro, /Local: Cuiabá \(Mato Grosso, Brasil\)/);
    assert.match(dentro, /Pedido: os próximos 7 dias/);
    assert.equal(dentro.split('\n- ').length - 1, 7, 'a semana: um item por dia');
    assert.ok(c.prompt.includes('tok-W1'), 'a pergunta do usuário continua no prompt (fora do cercado)');
    assert.ok(c.prompt.indexOf('tok-W1') > c.prompt.indexOf(UNTRUSTED_CLOSE));
    assert.ok(!String(c.system).includes('--- FERRAMENTAS DISPONÍVEIS ---'), 'sem ferramentas: o modelo não pode chamar search_web');
    assert.equal(c.sensitive, false);
    // o servidor falso só viu o NOME DO LOCAL e as coordenadas
    assert.equal(srv.pedidos.length, 2);
    assert.deepEqual(srv.pedidos[0].params, { name: 'Cuiabá', count: '10', language: 'pt', countryCode: 'BR', format: 'json' });
    assert.deepEqual(Object.keys(srv.pedidos[1].params).sort(), ['current', 'daily', 'forecast_days', 'latitude', 'longitude', 'timezone']);
    const tudo = JSON.stringify(srv.pedidos);
    for (const proibido of ['tok-W1', 'tok-OUTRO', 'poderia', 'semana', MEMBER, GUILD, CHAN, f.turn.id]) assert.ok(!tudo.includes(proibido), `o servidor do clima NÃO pode ver "${proibido}"`);
    assert.equal(chat.stats().climaRespondidos, 1);
  });

  await test('a DM do DONO: o clima responde sem YUI_PRIVATE_SEARCH e sem a chave da pesquisa por intenção; a chamada à IA é sensível (nenhum provedor anônimo)', async () => {
    srv.limpar();
    await conEnv({ YUI_PRIVATE_SEARCH: 'off', YUI_PESQUISA_POR_INTENCAO: 'off' }, async () => {
      const { chat, ai } = brains();
      const { out } = await principal(chat, { user: OWNER, ...DM, text: `${FRASE_DO_DONO} tok-W2` });
      assert.equal(out.usedClima, true);
      assert.match(out.text, /clima=sim web=nao ferramentas=nao/);
      assert.equal(conversaAi(ai).length, 1);
      assert.equal(conversaAi(ai)[0].sensitive, true, 'conversa pessoal do dono: sem provedor anônimo');
      assert.equal(registro().length, 0, 'nenhuma busca na web');
      assert.ok(!JSON.stringify(srv.pedidos).includes('tok-W2'));
      assert.equal(srv.pedidos[0].params.name, 'Cuiabá');
    });
  });

  await test('a DM de um MEMBRO (conversa privada de outra pessoa): o clima também responde, e a mesma cidade usa o cache (nenhuma chamada nova)', async () => {
    srv.limpar();
    const clima = climaServico();
    const { chat, ai } = brains({ clima });
    const a = await principal(chat, { user: MEMBER, ...DM, text: 'como está o clima em Manaus? tok-W3' });
    assert.equal(a.out.usedClima, true);
    assert.equal(srv.pedidos.length, 2);
    const b = await principal(chat, { user: OTHER, ...SRV, text: 'vai chover hoje em Manaus? tok-W4' });
    assert.equal(b.out.usedClima, true);
    assert.equal(srv.pedidos.length, 2, 'cache de 10 min por (cidade, dia)');
    assert.equal(conversaAi(ai).length, 2);
    assert.ok(conversaAi(ai)[0].prompt.includes('Local: Manaus (Amazonas, Brasil)'));
  });

  await test('local não achado, o serviço fora do ar, 429 e prazo: UMA frase fixa da Yui e a IA NÃO é chamada (o modelo nunca inventa o tempo)', async () => {
    const casos = [
      ['clima em Zzyzx hoje', {}, TEXTO_CLIMA_LOCAL_NAO_ACHADO],
      ['como está o clima em Manaus?', { status: 500 }, TEXTO_CLIMA_FALHA],
      ['como está o clima em Manaus?', { status: 429 }, TEXTO_CLIMA_FALHA],
      ['como está o clima em Manaus?', { status: 400 }, TEXTO_CLIMA_FALHA],
      ['como está o clima em Manaus?', { lixo: true }, TEXTO_CLIMA_FALHA],
      ['como está o clima em Manaus?', { atrasoMs: 3000 }, TEXTO_CLIMA_FALHA],
    ];
    for (const [text, ctl, esperado] of casos) {
      srv.limpar();
      srv.controle(ctl);
      const { chat, ai } = brains({ clima: climaServico({}, { timeoutMs: ctl.atrasoMs ? 150 : 2000 }) });
      const { out } = await principal(chat, { user: OWNER, ...DM, text });
      srv.controle({});
      assert.equal(out.text, esperado, JSON.stringify(ctl));
      assert.equal(out.failed, false);
      assert.equal(ai.calls.length, 0, `a IA não foi chamada (${JSON.stringify(ctl)})`);
      assert.doesNotMatch(out.text, /erro|http|429|timeout|exception/i);
    }
    assert.equal(TEXTO_CLIMA_FALHA, 'Não consegui ver o clima agora. Tenta de novo daqui a pouco?');
  });

  await test('a cota do clima por pessoa e global por hora: passou do limite, a frase fixa e nenhuma chamada à rede nem à IA', async () => {
    srv.limpar();
    const { chat, ai } = brains({ clima: climaServico({ YUI_CLIMA_POR_HORA: '1,100' }) });
    const a = await principal(chat, { user: MEMBER, ...SRV, text: 'como está o clima em Manaus?' });
    assert.equal(a.out.usedClima, true);
    const antes = srv.pedidos.length;
    const b = await principal(chat, { user: MEMBER, ...SRV, text: 'como está o clima em Recife?' });
    assert.equal(b.out.text, TEXTO_CLIMA_LIMITE);
    assert.equal(srv.pedidos.length, antes);
    assert.equal(conversaAi(ai).length, 1);
    const c = await principal(chat, { user: OTHER, ...SRV, text: 'como está o clima em Recife?' });
    assert.equal(c.out.usedClima, true, 'outra pessoa não é afetada pelo limite de quem passou');
  });

  await test('sem cidade: a padrão (YUI_CLIMA_CIDADE_PADRAO) ou "De qual cidade?"; a resposta curta seguinte ("Recife") é o local', async () => {
    srv.limpar();
    const { chat, ai } = brains({ clima: climaServico(), context: { enabled: () => false } });
    const pergunta = await principal(chat, { user: MEMBER, ...SRV, text: 'vai chover hoje? tok-W5' });
    assert.equal(pergunta.out.text, TEXTO_CLIMA_SEM_CIDADE);
    assert.equal(ai.calls.length, 0);
    assert.equal(srv.pedidos.length, 0, 'sem cidade nada sai');
    assert.equal(chat.stats().climaPerguntouCidade, 1);
    // a Yui acabou de perguntar a cidade (o estado fica em RAM, por pessoa e conversa): a pessoa responde só com a cidade
    const resposta = await principal(chat, { user: MEMBER, ...SRV, text: 'Recife' });
    assert.equal(resposta.out.usedClima, true, resposta.out.text);
    assert.ok(conversaAi(ai)[0].prompt.includes('Local: Recife (Pernambuco, Brasil)'));
    assert.equal(srv.pedidos[0].params.name, 'Recife');
    // sem a pergunta de cidade pendente, "Recife" sozinho é conversa comum
    const { chat: outro, ai: ai2 } = brains({ context: { enabled: () => false } });
    const sozinho = await principal(outro, { user: MEMBER, ...SRV, text: 'Recife' });
    assert.equal(sozinho.out.usedClima, undefined);
    assert.equal(conversaAi(ai2).length, 1);
    assert.match(sozinho.out.text, /clima=nao/);
    // com a cidade padrão
    srv.limpar();
    const padrao = brains({ clima: climaServico({ YUI_CLIMA_CIDADE_PADRAO: 'Manaus' }) });
    const p = await principal(padrao.chat, { user: MEMBER, ...SRV, text: 'vai chover hoje?' });
    assert.equal(p.out.usedClima, true);
    assert.equal(srv.pedidos[0].params.name, 'Manaus');
  });

  // A1 (revisão independente): antes, depois de "De qual cidade?" QUALQUER fala curta, até horas depois e de qualquer assunto, virava "cidade" e ia ao servidor do clima.
  await test('A1: a resposta a "De qual cidade?" vale SÓ para a próxima fala da MESMA pessoa na MESMA conversa, em até 10 min, e só se PARECER um lugar; o resto é conversa e nada sai para o clima', async () => {
    let t = Date.now();
    const novo = () => brains({ extra: { now: () => t }, context: { enabled: () => false } });
    const perguntar = async (b, user = MEMBER, onde = SRV) => (await principal(b.chat, { user, ...onde, text: 'vai chover hoje?' })).out;
    const comum = async (b, text, user = MEMBER, onde = SRV) => (await principal(b.chat, { user, ...onde, text })).out;
    srv.limpar();
    // (1) a resposta certa, logo depois: é o local, e a pergunta é gasta (a 2ª fala não é mais resposta)
    let b = novo();
    assert.equal((await perguntar(b)).text, TEXTO_CLIMA_SEM_CIDADE);
    t += 9 * 60_000; // 9 min: ainda vale
    let r = await comum(b, 'Recife');
    assert.equal(r.usedClima, true, r.text);
    assert.equal(srv.pedidos[0].params.name, 'Recife');
    srv.limpar();
    r = await comum(b, 'Manaus');
    assert.equal(r.usedClima, undefined, 'a pergunta foi gasta: "Manaus" agora é conversa comum');
    assert.match(r.text, /clima=nao/);
    assert.equal(srv.pedidos.length, 0);
    // (2) passou de 10 min: "Recife" é conversa comum
    b = novo();
    await perguntar(b);
    t += 10 * 60_000 + 1000;
    r = await comum(b, 'Recife');
    assert.equal(r.usedClima, undefined);
    assert.match(r.text, /clima=nao/);
    assert.equal(srv.pedidos.length, 0, 'passou de 10 min: nada sai para o clima');
    // (3) uma fala sem relação logo depois gasta a pergunta: "Recife" depois dela não é resposta
    b = novo();
    await perguntar(b);
    r = await comum(b, 'Boa noite, tudo bem?');
    assert.match(r.text, /clima=nao/);
    r = await comum(b, 'Recife');
    assert.equal(r.usedClima, undefined);
    assert.equal(srv.pedidos.length, 0);
    // (4) outra pessoa, e a mesma pessoa em OUTRA conversa, não respondem a pergunta; a pessoa certa ainda pode
    b = novo();
    await perguntar(b);
    assert.equal((await comum(b, 'Recife', OTHER)).usedClima, undefined, 'outra pessoa');
    assert.equal((await comum(b, 'Recife', MEMBER, { guild: GUILD, channel: '888888888888888888' })).usedClima, undefined, 'a mesma pessoa em outro canal');
    assert.equal((await comum(b, 'Recife', MEMBER, DM)).usedClima, undefined, 'a mesma pessoa na DM');
    assert.equal(srv.pedidos.length, 0);
    assert.equal((await comum(b, 'Recife')).usedClima, true, 'a pessoa certa, na conversa certa');
    // (5) a fala que não PARECE um lugar nunca vira cidade, mesmo logo depois da pergunta
    srv.limpar();
    for (const texto of ['meu exame de HIV deu positivo e estou com medo', 'bom dia Yui, tudo bem?', 'quero cancelar minha conta', 'não sei', 'obrigado', 'vou dormir agora', 'oi', 'manda meu cartão 4111 1111 1111 1111']) {
      b = novo();
      await perguntar(b);
      r = await comum(b, texto);
      assert.equal(r.usedClima, undefined, texto);
      assert.match(r.text, /clima=nao/, texto);
    }
    assert.equal(srv.pedidos.length, 0, 'nenhuma dessas falas chegou ao servidor do clima');
    // (6) as formas naturais de responder a cidade
    for (const [texto, nome] of [['em Recife', 'Recife'], ['na cidade de Curitiba', 'Curitiba'], ['Foz do Iguaçu', 'Foz do Iguaçu'], ['Manaus!', 'Manaus']]) {
      srv.limpar();
      b = novo();
      await perguntar(b);
      r = await comum(b, texto);
      assert.equal(r.usedClima, true, `${texto}: ${r.text}`);
      assert.equal(srv.pedidos[0].params.name, nome, texto);
    }
    // (7) "Não achei essa cidade. Me diz o nome de novo" também é uma pergunta de cidade: o nome certo logo depois resolve
    srv.limpar();
    b = novo();
    r = await comum(b, 'vai chover em Zzyzx?');
    assert.equal(r.text, TEXTO_CLIMA_LOCAL_NAO_ACHADO);
    assert.equal(srv.pedidos.length, 1, 'só a busca do nome do lugar saiu');
    r = await comum(b, 'Recife');
    assert.equal(r.usedClima, true, r.text);
    assert.ok(conversaAi(b.ai)[0].prompt.includes('Local: Recife (Pernambuco, Brasil)'));
  });

  // A2/A3/B (revisão independente) no chat.turn: o que SAI para o servidor do clima e o que o clima não pode sequestrar.
  await test('A2: o texto da conversa NUNCA vira o local nem sai para o clima ("vai chover? meu exame de HIV deu positivo..."): a Yui pergunta a cidade ou usa a padrão', async () => {
    const conversa = ['vai chover? meu exame de HIV deu positivo e estou assustado', 'como está o clima? meu pai tem câncer de próstata', 'qual a previsão do tempo? estou em casa sozinho em cima da cama',
      'vai chover amanhã? o Rafael me disse que a Maria foi para a UTI', 'previsão do tempo, depois eu falo do exame de HIV'];
    srv.limpar();
    const semPadrao = brains().chat;
    for (const texto of conversa) {
      const { out } = await principal(semPadrao, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.text, TEXTO_CLIMA_SEM_CIDADE, `sem cidade padrão: a Yui pergunta, e nada sai (${texto})`);
    }
    assert.equal(srv.pedidos.length, 0, 'sem cidade, nada saiu para o servidor do clima');
    for (const texto of conversa) {
      const { chat, ai } = brains({ clima: climaServico({ YUI_CLIMA_CIDADE_PADRAO: 'Manaus' }) });
      const { out } = await principal(chat, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.usedClima, true, texto);
      assert.ok(conversaAi(ai)[0].prompt.includes('Local: Manaus (Amazonas, Brasil)'), texto);
    }
    const tudo = JSON.stringify(srv.pedidos);
    for (const proibido of ['HIV', 'exame', 'positivo', 'pai ', 'próstata', 'câncer', 'cama', 'Rafael', 'Maria', 'UTI', 'assustado']) assert.ok(!tudo.includes(proibido), `o servidor do clima NÃO pode ver "${proibido}"`);
    assert.ok(srv.pedidos.filter((p) => p.params.name).every((p) => p.params.name === 'Manaus'), 'só a cidade padrão foi procurada');
  });

  await test('A3: o local é só o nome (sem a preposição e sem o resto da frase) e o clima já cobre as frases que antes escapavam ("tempo em Cuiabá?", "tá calor em Cuiabá?", "qual o clima?")', async () => {
    const casos = [
      ['clima em Cuiabá na sexta', 'Cuiabá'], ['clima em Cuiabá-MT na próxima semana', 'Cuiabá'], ['preciso de guarda-chuva amanhã em SP?', 'São Paulo'], ['umidade do ar em Cuiabá', 'Cuiabá'],
      ['vai chover em Sao Paulo capital hoje', 'Sao Paulo'], ['qual a previsão para a semana em Cuiabá-MT?', 'Cuiabá'], ['previsão pra sexta em Cuiabá', 'Cuiabá'], ['clima Cuiabá', 'Cuiabá'],
      ['tempo em Cuiabá?', 'Cuiabá'], ['tá calor em Cuiabá?', 'Cuiabá'], ['Yui, qual o clima?', 'Manaus'], [FRASE_DO_DONO, 'Cuiabá'],
    ];
    for (const [texto, nome] of casos) {
      srv.limpar();
      const { chat } = brains({ clima: climaServico({ YUI_CLIMA_CIDADE_PADRAO: 'Manaus' }) });
      const { out } = await principal(chat, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.usedClima, true, `${texto}: ${out.text}`);
      const geo = srv.pedidos.find((p) => p.params.name);
      assert.equal(geo.params.name, nome, `${texto}: o servidor deve ver só o nome "${nome}", viu ${JSON.stringify(geo.params)}`);
    }
  });

  await test('B: sinal fraco sem "?" nem local, assunto figurado e mensagem MISTA (outro pedido de ferramenta) não são sequestrados pelo clima: seguem com as ferramentas', async () => {
    srv.limpar();
    const { chat } = brains({ clima: climaServico({ YUI_CLIMA_CIDADE_PADRAO: 'Manaus' }) });
    for (const texto of ['o jogo vai esquentar na final hoje', 'vai esfriar a discussão', 'o servidor tá quente agora', 'tá quente', 'hoje faz calor', 'o preço vai esfriar hoje?', 'o notebook tá quente hoje?', 'o mercado vai esquentar amanhã?',
      'baixa a música X e me diz se vai chover amanhã', 'me lembra de ver o clima amanhã', 'toca uma música e me diz se vai chover', 'mostra a imagem do gato e depois o clima em Manaus', 'me avisa se vai chover amanhã em Cuiabá']) {
      const { out } = await principal(chat, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.usedClima, undefined, texto);
      assert.match(out.text, /clima=nao web=nao ferramentas=sim/, texto);
    }
    assert.equal(srv.pedidos.length, 0, 'nada disso foi ao servidor do clima');
    for (const texto of ['tá quente aí?', 'tá calor em Cuiabá?', 'hoje faz calor em Manaus']) {
      const { out } = await principal(brains({ clima: climaServico({ YUI_CLIMA_CIDADE_PADRAO: 'Manaus' }) }).chat, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.usedClima, true, texto);
    }
  });

  await test('o que NÃO pede clima segue o caminho de sempre (com as ferramentas); espontânea, voz, log de terceiros e YUI_CLIMA=false nunca consultam', async () => {
    srv.limpar();
    const { chat, ai } = brains();
    for (const texto of ['o tempo de jogo foi de 40 minutos', 'clima da reunião estava tenso', 'tempo de download muito longo', 'temperatura da CPU alta', 'oi tudo bem?']) {
      const { out } = await principal(chat, { user: MEMBER, ...SRV, text: texto });
      assert.equal(out.usedClima, undefined, texto);
      assert.match(out.text, /clima=nao web=nao ferramentas=sim/, texto);
    }
    const clima = 'como está o clima em Manaus?';
    const espontanea = await principal(chat, { user: MEMBER, ...SRV, text: clima, call: { chatter: true, mentionsBot: false } });
    const espontaneaComMencao = await principal(chat, { user: MEMBER, ...SRV, text: clima, call: { chatter: true } }); // a marca de conversa espontânea vale mesmo se a mensagem menciona a Yui
    const naoMencionou = await principal(chat, { user: MEMBER, ...SRV, text: clima, call: { mentionsBot: false, hasBotName: false, repliesToBot: false } });
    const voz = await principal(chat, { user: MEMBER, ...SRV, text: clima, call: { voice: true, voiceInteraction: true } });
    const terceiros = await principal(chat, { user: MEMBER, ...SRV, text: clima, call: { thirdParty: true }, options: { thirdParty: true } });
    const semFerramentas = await principal(chat, { user: MEMBER, ...SRV, text: clima, options: { noTools: true } });
    const passoSecundario = await principal(chat, { user: MEMBER, ...SRV, text: clima, options: { main: false } });
    for (const [nome, r] of Object.entries({ espontanea, espontaneaComMencao, naoMencionou, voz, terceiros, semFerramentas, passoSecundario })) assert.equal(r.out.usedClima, undefined, `${nome} não consulta o clima`);
    await conEnv({ YUI_CLIMA: 'false' }, async () => {
      const off = await principal(chat, { user: MEMBER, ...SRV, text: clima });
      assert.equal(off.out.usedClima, undefined);
    });
    assert.equal(srv.pedidos.length, 0, 'nenhuma chamada ao clima em nenhum desses casos');
    assert.ok(ai.calls.length >= 10);
  });

  await test('a resposta que se repete (o mesmo clima pedido de novo) NÃO pede "outra resposta" sem os dados: a IA é chamada uma vez por turno', async () => {
    srv.limpar();
    const ai = fakeAi({ reply: () => 'Hoje em Manaus faz trinta e três graus, céu limpo e sem chuva.' });
    const { chat } = brains({ ai, context: { enabled: () => false } });
    const a = await principal(chat, { user: MEMBER, ...SRV, text: 'como está o clima em Manaus?' });
    await chat.commit({ ...a.f, history: [{ role: 'user', content: 'como está o clima em Manaus?' }, { role: 'assistant', content: a.out.text }], contextLine: null }, META);
    const b = await principal(chat, { user: MEMBER, ...SRV, text: 'como está o clima em Manaus?' });
    assert.equal(b.out.text, a.out.text);
    assert.equal(conversaAi(ai).length, 2, 'uma chamada por turno, nenhuma de "responda de forma diferente"');
    assert.equal(chat.stats().regenerated, 0);
  });


  // ── Várias cidades na mesma mensagem e a continuação "e de São Paulo?" (a conversa real do Discord de 19/11/2026) ──
  const NL = String.fromCharCode(10);
  const locaisDoPrompt = (prompt) => String(prompt).split(NL).filter((l) => l.startsWith('Local: ')).map((l) => l.slice(7).split(' (')[0]);
  const nomesGeocodificados = () => srv.pedidos.filter((p) => p.params && p.params.name).map((p) => p.params.name);

  await test('VÁRIAS CIDADES: "o clima em cuiabá e o de curitiba para hoje" consulta as DUAS e a IA responde UMA vez com os dois locais cercados; só os nomes saem para o clima', async () => {
    srv.limpar();
    const { chat, ai } = brains();
    const texto = 'Tudo tranquilo como esquilo, poderia me informar o clima em cuiabá e o de curitiba para hoje? tok-V1';
    const { out } = await principal(chat, { user: OWNER, ...DM, text: texto });
    assert.equal(out.usedClima, true);
    assert.equal(conversaAi(ai).length, 1, 'a IA responde UMA vez');
    const c = conversaAi(ai)[0];
    assert.deepEqual(locaisDoPrompt(c.prompt), ['Cuiabá', 'Curitiba']);
    assert.equal(c.prompt.split(UNTRUSTED_OPEN).length - 1, 1, 'um só cercado para os dois locais');
    assert.match(c.prompt, /Há mais de um local: responda um por um/);
    assert.deepEqual(nomesGeocodificados().map((n) => n.toLowerCase()), ['cuiabá', 'curitiba']);
    const tudo = JSON.stringify(srv.pedidos);
    for (const proibido of ['tok-V1', 'esquilo', 'tranquilo', 'poderia', OWNER]) assert.ok(!tudo.includes(proibido), `o servidor do clima NÃO pode ver "${proibido}"`);
    assert.equal(chat.stats().climaVariosLocais, 1);
  });

  await test('VÁRIAS CIDADES: um local sem dados não derruba os outros (a IA recebe "Sem dados" para ele e responde uma vez); todos sem dados = a frase fixa, sem IA', async () => {
    srv.limpar();
    const { chat, ai } = brains();
    const { out } = await principal(chat, { user: OWNER, ...DM, text: 'qual o clima em Curitiba e em Zzzville?' });
    assert.equal(out.usedClima, true);
    const c = conversaAi(ai)[0];
    assert.deepEqual(locaisDoPrompt(c.prompt), ['Curitiba']);
    assert.match(c.prompt, /Sem dados [^:]*: Zzzville\./);
    assert.equal(conversaAi(ai).length, 1);
    srv.limpar();
    const b2 = brains();
    const r2 = await principal(b2.chat, { user: OWNER, ...DM, text: 'qual o clima em Zzzville e em Yyyville?' });
    assert.equal(conversaAi(b2.ai).length, 0, 'sem dado nenhum: a IA nem é chamada');
    assert.equal(r2.out.text, TEXTO_CLIMA_LOCAL_NAO_ACHADO);
  });

  await test('CONTINUAÇÃO: "e de São Paulo?" logo depois de um pedido de clima atendido (mesma pessoa, mesma conversa) é o MESMO pedido para outro lugar; "e o João?" não vira cidade', async () => {
    srv.limpar();
    const { chat, ai } = brains();
    await principal(chat, { user: OWNER, ...DM, text: 'qual o clima em Cuiabá amanhã?' });
    srv.limpar();
    const r = await principal(chat, { user: OWNER, ...DM, text: 'e de São Paulo?' });
    assert.equal(r.out.usedClima, true, 'a continuação responde com o clima');
    assert.equal(conversaAi(ai).length, 2);
    const c = conversaAi(ai)[1];
    assert.deepEqual(locaisDoPrompt(c.prompt), ['São Paulo']);
    assert.match(c.prompt, /Pedido: amanhã/, 'o mesmo "quando" do pedido anterior');
    assert.deepEqual(nomesGeocodificados(), ['São Paulo'], 'só o nome do lugar saiu');
    assert.equal(chat.stats().climaContinuacoes, 1);
    srv.limpar();
    const joao = await principal(chat, { user: OWNER, ...DM, text: 'e o João?' });
    assert.notEqual(joao.out.usedClima, true, 'nome de pessoa não vira cidade');
    assert.deepEqual(nomesGeocodificados(), []);
  });

  await test('CONTINUAÇÃO: só vale para a MESMA pessoa na MESMA conversa, só depois de um clima atendido e só por 10 minutos', async () => {
    srv.limpar();
    let agora = 1_800_000_000_000;
    const { chat } = brains({ extra: { now: () => agora } });
    // sem pedido anterior: "e de São Paulo?" sozinho não é clima
    const sozinho = await principal(chat, { user: OWNER, ...DM, text: 'e de São Paulo?' });
    assert.notEqual(sozinho.out.usedClima, true);
    await principal(chat, { user: OWNER, ...DM, text: 'clima em Manaus hoje' });
    // outra pessoa, ou a mesma em outro canal: não
    const outra = await principal(chat, { user: MEMBER, ...DM, text: 'e de São Paulo?' });
    assert.notEqual(outra.out.usedClima, true, 'outra pessoa');
    const outroCanal = await principal(chat, { user: OWNER, guild: null, channel: '777777777777777778', text: 'e de São Paulo?' });
    assert.notEqual(outroCanal.out.usedClima, true, 'outra conversa');
    // passados 11 minutos: não
    agora += 11 * 60_000;
    const tarde = await principal(chat, { user: OWNER, ...DM, text: 'e de São Paulo?' });
    assert.notEqual(tarde.out.usedClima, true, 'depois de 10 minutos');
    // dentro do prazo: sim
    await principal(chat, { user: OWNER, ...DM, text: 'clima em Manaus hoje' });
    agora += 9 * 60_000;
    const dentro = await principal(chat, { user: OWNER, ...DM, text: 'e de São Paulo?' });
    assert.equal(dentro.out.usedClima, true, 'dentro de 10 minutos');
  });


  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. A pesquisa por intenção no chat.turn');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const PERGUNTA = 'quem ganhou o jogo do Flamengo ontem?';

  await test('servidor: pergunta de dado atual pesquisa SEM a palavra "pesquise": só a fala do autor vai ao buscador (nunca o CONTEXTO), a web chega cercada, as ferramentas saem', async () => {
    limparRegistro();
    const { chat, ai } = brains();
    const { out, f } = await principal(chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-S1` });
    assert.equal(out.usedSearch, true);
    assert.equal(out.failed, false);
    assert.match(out.text, /web=sim ferramentas=nao/);
    const buscas = registro().filter((r) => r.tipo === 'rapida');
    assert.equal(buscas.length, 1, 'uma busca');
    assert.ok(buscas[0].consulta.includes('tok-S1'));
    assert.ok(!buscas[0].consulta.includes('tok-OUTRO'), 'a fala de OUTRA pessoa (o CONTEXTO) nunca vai ao buscador');
    assert.equal(buscas[0].userId, MEMBER);
    assert.equal(buscas[0].privado, false, 'no servidor a busca é pública');
    const c = conversaAi(ai)[0];
    assert.ok(c.prompt.includes('[CONTEXTO OBTIDO NA WEB]:') && c.prompt.includes(UNTRUSTED_OPEN) && c.prompt.includes(UNTRUSTED_CLOSE), 'a web vem cercada como dado externo');
    assert.ok(!String(c.system).includes('--- FERRAMENTAS DISPONÍVEIS ---'));
    assert.equal(ai.calls.filter((x) => x.tipo === 'otimizador').length, 1, 'na pública o otimizador roda (isolado e sensível)');
    assert.equal(ai.calls.find((x) => x.tipo === 'otimizador').isolated, true);
    assert.equal(chat.foiPesquisado(f.turn.id), true, 'o turno com pesquisa nunca entra no contexto por horas');
    assert.equal(chat.stats().intencaoBusca, 1);
  });

  await test('a DM do DONO com YUI_PRIVATE_SEARCH=owner: pesquisa por intenção com privado: true, SEM otimizador (nenhuma chamada à IA com o texto privado), IA sensível, nada no contexto', async () => {
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      const { chat, ai } = brains();
      const { out, f } = await principal(chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo tok-S2 ontem?' }); // a consulta privada é só a 1ª frase do pedido
      assert.equal(out.usedSearch, true, out.text);
      assert.match(out.text, /web=sim ferramentas=nao/);
      const buscas = registro().filter((r) => r.tipo === 'rapida');
      assert.equal(buscas.length, 1);
      assert.equal(buscas[0].privado, true, 'a busca privada nunca é cacheada nem compartilhada');
      assert.ok(buscas[0].consulta.includes('tok-S2') && !buscas[0].consulta.includes('tok-OUTRO'));
      assert.ok(registro().filter((r) => r.tipo === 'pagina').every((r) => r.privado === true), 'a leitura das páginas sem log do host (quiet)');
      assert.equal(ai.calls.filter((x) => x.tipo === 'otimizador').length, 0, 'na privada o otimizador NÃO roda');
      assert.equal(conversaAi(ai)[0].sensitive, true);
      assert.equal(chat.foiPesquisado(f.turn.id), true);
      const c = await chat.commit({ ...f, history: [], contextLine: 'texto vindo da web' }, META);
      assert.equal(c.context, false, 'a conversa privada pesquisada não entra no contexto por horas');
    });
  });

  // A TABELA da política no chat.turn (a escrita à mão): chave x quem x onde x YUI_PRIVATE_SEARCH. 1 = pesquisa.
  const COMBOS = [
    // chave, quem, onde, [off, owner, all]
    ['off', 'dono', 'srv', [0, 0, 0]], ['off', 'membro', 'srv', [0, 0, 0]], ['off', 'dono', 'dm', [0, 0, 0]], ['off', 'membro', 'dm', [0, 0, 0]],
    ['servidor', 'dono', 'srv', [1, 1, 1]], ['servidor', 'membro', 'srv', [1, 1, 1]], ['servidor', 'dono', 'dm', [0, 0, 0]], ['servidor', 'membro', 'dm', [0, 0, 0]],
    ['dono', 'dono', 'srv', [1, 1, 1]], ['dono', 'membro', 'srv', [1, 1, 1]], ['dono', 'dono', 'dm', [0, 1, 1]], ['dono', 'membro', 'dm', [0, 0, 0]],
    ['todos', 'dono', 'srv', [1, 1, 1]], ['todos', 'membro', 'srv', [1, 1, 1]], ['todos', 'dono', 'dm', [0, 1, 1]], ['todos', 'membro', 'dm', [0, 0, 0]], // revisão da Liz: a DM de outra pessoa fica como antes em TODAS as chaves (`todos` é reservado e vale o mesmo que `dono`)
  ];
  for (const [chave, quem, onde, trio] of COMBOS) {
    await test(`combinação: chave ${chave} x ${quem} x ${onde === 'srv' ? 'servidor' : 'DM'} -> YUI_PRIVATE_SEARCH off/owner/all = ${trio.join('/')}`, async () => {
      for (const [i, ps] of ['off', 'owner', 'all'].entries()) {
        limparRegistro();
        await conEnv({ YUI_PESQUISA_POR_INTENCAO: chave, YUI_PRIVATE_SEARCH: ps }, async () => {
          const { chat } = brains();
          const user = quem === 'dono' ? OWNER : MEMBER;
          const lugar = onde === 'srv' ? SRV : DM;
          const { out } = await principal(chat, { user, ...lugar, text: `${PERGUNTA} tok-M${i}` });
          const buscas = registro().filter((r) => r.tipo === 'rapida');
          assert.equal(buscas.length, trio[i], `${chave}/${quem}/${onde}/private=${ps}: buscas=${buscas.length} (${out.text.slice(0, 60)})`);
          assert.equal(out.usedSearch, trio[i] === 1);
          if (trio[i] === 1) assert.equal(buscas[0].privado, onde === 'dm');
        });
      }
    });
  }

  await test('sem a chave no ambiente o padrão é "dono": o membro em DM continua como antes (o modelo recebe as ferramentas e a recusa de sempre vale)', async () => {
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_PESQUISA_POR_INTENCAO: null }, async () => {
      const { chat } = brains();
      const membro = await principal(chat, { user: MEMBER, ...DM, text: `${PERGUNTA} tok-D1` });
      assert.equal(membro.out.usedSearch, false);
      assert.match(membro.out.text, /web=nao ferramentas=sim/, 'DM de outra pessoa: o comportamento de hoje, inalterado');
      const dono = await principal(chat, { user: OWNER, ...DM, text: `${PERGUNTA} tok-D2` });
      assert.equal(dono.out.usedSearch, true, 'o dono em DM pesquisa por padrão (com YUI_PRIVATE_SEARCH liberando)');
    });
    assert.equal(registro().filter((r) => r.tipo === 'rapida').length, 1);
  });

  await test('o que NÃO pesquisa: pedido explícito (vai ao agente), câmbio, clima, ferramenta própria, conversa, espontânea, voz, log de terceiros, search_web desligada e a busca automática desligada', async () => {
    limparRegistro();
    const { chat, ai } = brains();
    const nao = async (text, extra = {}) => {
      const r = await principal(chat, { user: MEMBER, ...SRV, text, ...extra });
      assert.equal(r.out.usedSearch, false, `${text} ${JSON.stringify(extra.call ?? {})}`);
      return r;
    };
    await nao('pesquise quem ganhou o jogo do Flamengo ontem');
    await nao('quanto está o dólar hoje?');
    await nao('baixa a música Ninguém Explica');
    await nao('oi, tudo bem? o que você acha do Flamengo?');
    await nao(PERGUNTA, { call: { chatter: true, mentionsBot: false } });
    await nao(PERGUNTA, { call: { chatter: true } }); // espontânea que menciona a Yui: a marca vale
    await nao(PERGUNTA, { options: { chatter: true } });
    await nao(PERGUNTA, { call: { mentionsBot: false } });
    await nao(PERGUNTA, { call: { voice: true, voiceInteraction: true } });
    await nao(PERGUNTA, { call: { thirdParty: true }, options: { thirdParty: true } });
    await nao(PERGUNTA, { options: { noTools: true } });
    await nao(PERGUNTA, { options: { main: false } });
    await nao(PERGUNTA, { channelExtra: { toolsDisabled: ['search_web'] } });
    await conEnv({ YUI_CEREBRO_BUSCA_AUTOMATICA: 'false' }, async () => { await nao(PERGUNTA); });
    const clima = await nao('como está o clima em Manaus?');
    assert.equal(clima.out.usedClima, true);
    assert.equal(registro().length, 0, 'nenhuma busca em nenhum desses casos');
    assert.ok(ai.calls.filter((c) => c.tipo === 'otimizador').length === 0);
  });

  await test('o dono em DM com dado pessoal NO pedido: a consulta é barrada (scrubQuery), não pesquisa e o modelo responde como antes; a justificativa pessoal nunca vai ao buscador', async () => {
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      const { chat } = brains();
      const barrado = await principal(chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do time 123.456.789-09 ontem?' });
      assert.equal(barrado.out.usedSearch, false);
      assert.equal(registro().length, 0);
      const ok = await principal(chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo ontem? é pra decidir uma aposta cara' });
      assert.equal(ok.out.usedSearch, true);
      const consulta = registro().find((r) => r.tipo === 'rapida')?.consulta ?? '';
      assert.ok(/flamengo/i.test(consulta) && !/aposta|cara/i.test(consulta), consulta);
    });
  });

  await test('FALHA FECHADA (revisão da Liz, 5): a limpeza que LANÇA, a política que lança e a que mente (busca privada fora da DM do dono) NÃO pesquisam; a Yui responde sem a web e sem erro cru', async () => {
    limparRegistro();
    const lancaLimpeza = (p) => avaliarPesquisaPorIntencao({ ...p, scrub: () => { throw new Error('a limpeza quebrou'); } });
    const lancaTudo = () => { throw new Error('a política quebrou'); };
    const mente = (privado, consultaPrivada = 'flamengo') => () => ({ buscar: true, privado, motivo: 'intencao_de_busca', categoria: 'resultado_esportivo', consultaPrivada });
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      for (const [nome, avaliarIntencao, user, lugar] of [
        ['limpeza que lança, DM do dono', lancaLimpeza, OWNER, DM],
        ['política que lança, DM do dono', lancaTudo, OWNER, DM],
        ['política que lança, servidor', lancaTudo, MEMBER, SRV],
        ['mente: busca privada no servidor', mente(true), MEMBER, SRV],
        ['mente: busca privada na DM de um MEMBRO', mente(true), MEMBER, DM],
        ['mente: DM do dono sem busca privada', mente(false), OWNER, DM],
        ['mente: consulta privada vazia', mente(true, '  '), OWNER, DM],
      ]) {
        limparRegistro();
        const { chat, ai } = brains({ avaliarIntencao });
        const { out } = await principal(chat, { user, ...lugar, text: 'quem ganhou o jogo do Flamengo ontem?' });
        assert.equal(out.usedSearch, false, nome);
        assert.equal(out.failed, false, nome);
        assert.equal(registro().length, 0, `${nome}: nenhuma busca saiu`);
        assert.match(out.text, /web=nao ferramentas=sim/, `${nome}: a Yui responde como sempre, sem a web`);
        assert.doesNotMatch(out.text, /Error|erro|exception|quebrou|undefined/i, `${nome}: nenhum erro cru`);
        assert.equal(ai.calls.filter((c) => c.tipo === 'otimizador').length, 0);
      }
      // a limpeza que lança só derruba a DM do proprietário: no servidor a mesma política pesquisa (a porta da busca limpa a consulta depois)
      limparRegistro();
      const srvOk = brains({ avaliarIntencao: lancaLimpeza });
      assert.equal((await principal(srvOk.chat, { user: MEMBER, ...SRV, text: 'quem ganhou o jogo do Flamengo ontem?' })).out.usedSearch, true);
      const { chat } = brains({ avaliarIntencao: lancaTudo });
      await principal(chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo ontem?' });
      assert.equal(chat.stats().intencaoErro, 1, 'o erro conta como número (nunca o texto)');
    });
  });

  await test('o aprovado não amplia o escopo: o canal PRIVADO do dono, a DM de outra pessoa e o servidor com a chave `servidor` ficam como antes', async () => {
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_PRIVATE_CHANNEL_IDS: CHAN, YUI_PESQUISA_POR_INTENCAO: 'todos' }, async () => {
      const { chat } = brains();
      const canalPrivado = await principal(chat, { user: OWNER, ...SRV, text: 'quem ganhou o jogo do Flamengo ontem? tok-P1' });
      assert.equal(canalPrivado.out.usedSearch, false, 'canal privado do dono: como antes (só a DM do proprietário conta)');
      assert.match(canalPrivado.out.text, /web=nao ferramentas=sim/);
      assert.equal(canalPrivado.f.ctx.guildId, GUILD);
      const dmOutro = await principal(chat, { user: MEMBER, ...DM, text: 'quem ganhou o jogo do Flamengo ontem? tok-P2' });
      assert.equal(dmOutro.out.usedSearch, false, 'DM de outra pessoa: como antes');
      assert.equal(registro().length, 0);
      const dono = await principal(chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo ontem tok-P3?' });
      assert.equal(dono.out.usedSearch, true, 'a DM do proprietário pesquisa');
      assert.equal(registro().filter((r) => r.tipo === 'rapida').length, 1);
    });
  });

  await test('a reserva da cota: a busca que ninguém pediu não gasta o fim da cota (a pessoa perto do limite recebe a resposta do modelo, sem busca); o pedido explícito ainda pesquisa', async () => {
    limparRegistro();
    const budget = createBudget({ filePath: path.join(tmp, 'b-reserva.json') });
    for (let i = 0; i < 4; i += 1) budget.takeUser(MEMBER); // 4 de 5 por hora: sobra 1 (a reserva de 20%)
    const { chat, ai } = brains({ budget });
    const r = await principal(chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-R1` });
    assert.equal(r.out.usedSearch, false);
    assert.equal(registro().length, 0);
    assert.equal(chat.stats().intencaoSemCota, 1);
    assert.match(r.out.text, /ferramentas=sim/, 'o modelo responde como antes (com as ferramentas)');
    const outra = await principal(chat, { user: OTHER, ...SRV, text: `${PERGUNTA} tok-R2` });
    assert.equal(outra.out.usedSearch, true, 'a cota de OUTRA pessoa é dela');
    assert.ok(ai.calls.length >= 2);
  });

  await test('o diário da retomada: o passo com a pesquisa por intenção grava nele (como a busca automática de sempre); o passo sem pesquisa não abre nada', async () => {
    limparRegistro();
    const retomada = createRetomadaDePesquisa({ dir: path.join(tmp, 'diario'), env: process.env, logger: quiet });
    const { chat } = brains({ retomada });
    await principal(chat, { user: MEMBER, ...SRV, text: 'oi, tudo bem?' });
    assert.equal(retomada.stats().abertas, 0, 'sem pesquisa, sem diário');
    const idem = 'chat.turn:970000000000000001:1';
    const r = await principal(chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-J1`, idem });
    assert.equal(r.out.usedSearch, true);
    assert.equal(retomada.stats().abertas, 1, 'o diário foi aberto pela chave do passo');
    assert.ok(retomada.stats().gravacoes >= 1, 'a marca de envio foi gravada no disco ANTES da busca sair');
  });

  await test('falha FECHADA e falhas da busca: sem resultados, o modelo recebe a nota e responde sem as ferramentas; pesquisa indisponível = o texto ÚNICO, uma vez, sem detalhe interno', async () => {
    buscaControle({ semResultados: true });
    limparRegistro();
    const a = brains();
    const sem = await principal(a.chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-F1` });
    buscaControle({});
    assert.equal(sem.out.usedSearch, false);
    assert.equal(sem.out.searchFailure, 'no_results');
    const c = conversaAi(a.ai)[0];
    assert.ok(c.prompt.includes('[AVISO DO SISTEMA: a pesquisa na web foi tentada agora e NÃO deu certo'), 'a nota ao modelo');
    assert.ok(!String(c.system).includes('--- FERRAMENTAS DISPONÍVEIS ---'), 'sem ferramentas: o modelo não chama search_web depois');
    assert.ok(!sem.out.text.includes(TEXTO_PESQUISA_INDISPONIVEL));
    // a porta de saída fechada (sem o dono da cota): nada sai ao buscador e a resposta leva o texto único
    const budget = createBudget({ filePath: path.join(tmp, 'b-porta.json') });
    budget.definirDespacho(false, 'trava-de-outro-processo');
    const buscaFechada = createFakeSearch({ env: { YUI_TESTE_BUSCA_FALSA_REGISTRO: REGISTRO, YUI_TESTE_BUSCA_FALSA_CONTROLE: BUSCA_CTRL }, budget });
    limparRegistro();
    const ai = fakeAi();
    const chat = conversa.createChatBrain({ ai, logger: quiet, busca: buscaFechada, env: process.env, memoryBlock: () => '', persona: () => '', clima: climaServico(), budget });
    const f = await principal(chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-F2` });
    assert.equal(f.out.searchFailure, 'unavailable');
    assert.equal(registro().filter((r) => r.tipo === 'rapida').length, 0, 'nenhuma busca saiu');
    assert.equal(f.out.text.split(TEXTO_PESQUISA_INDISPONIVEL).length - 1, 1, 'o texto único, uma vez só');
    assert.match(f.out.text, /-# ⚠️ Não consegui realizar a pesquisa agora\. Posso continuar ajudando com o que já sei\./);
    assert.doesNotMatch(f.out.text, /trava|cota|dono|processo|diário/i, 'sem detalhe interno');
    assert.equal(resultadoIndisponivel('registro-da-cota').indisponivel, true);
  });

  // C (revisão independente): a pesquisa por intenção é decidida DEPOIS do Google e da skill; quando um deles assume o passo, ela não roda por cima.
  await test('C: com o Google (a AGENDA do dono) no passo, a pesquisa por intenção NÃO roda por cima: o prompt leva a agenda e não a web, e nenhuma busca sai', async () => {
    limparRegistro();
    const google = async () => ({ prompt: 'DADOS-DA-AGENDA tok-AG compromissos de hoje', opcoes: { noTools: true, attachment: true, allowSearch: false, main: false }, revisar: (t) => t, tipo: 'agenda' });
    for (const [user, onde, privada] of [[OWNER, DM, 'owner'], [OWNER, SRV, 'off']]) {
      await conEnv({ YUI_PRIVATE_SEARCH: privada }, async () => {
        const { chat, ai } = brains({ extra: { google } });
        const { out } = await principal(chat, { user, ...onde, text: `${PERGUNTA} tok-G1` });
        assert.equal(out.usedSearch, false, 'o Google assumiu: nenhuma pesquisa por cima');
        assert.equal(registro().length, 0, 'o buscador não foi chamado');
        const c = conversaAi(ai)[0];
        assert.ok(c.prompt.includes('DADOS-DA-AGENDA'), 'a agenda chegou ao prompt');
        assert.ok(!c.prompt.includes('[CONTEXTO OBTIDO NA WEB]'), 'a web NÃO chegou ao prompt junto com a agenda');
        assert.equal(chat.stats().intencaoBusca, 0, 'a decisão que o Google assumiu não conta como pesquisa por intenção');
      });
    }
  });

  await test('C: o clima continua valendo com o Google e com a skill no passo (a fala do autor decide), e a skill do dono não vira pesquisa na web', async () => {
    limparRegistro();
    srv.limpar();
    const google = async () => ({ prompt: 'DADOS-DA-AGENDA tok-AG2', opcoes: { noTools: true, attachment: true, allowSearch: false, main: false }, revisar: (t) => t, tipo: 'agenda' });
    const comGoogle = brains({ extra: { google } });
    const g = await principal(comGoogle.chat, { user: OWNER, ...DM, text: FRASE_DO_DONO });
    assert.equal(g.out.usedClima, true, `o clima vale com o Google: ${g.out.text}`);
    // a skill do dono (pasta de teste): casa com a mensagem, entra no prompt de sistema, sem ferramentas e sem web
    const pasta = path.join(tmp, 'skills-do-dono');
    fs.mkdirSync(path.join(pasta, 'placar-de-jogos'), { recursive: true });
    fs.mkdirSync(path.join(pasta, 'clima-semana'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'placar-de-jogos', 'SKILL.md'), '---\nname: placar-de-jogos\ndescription: Resume resultado de jogos do Flamengo e de futebol.\n---\nCORPO-DA-SKILL-PLACAR: responda em tópicos.\n');
    fs.writeFileSync(path.join(pasta, 'clima-semana', 'SKILL.md'), '---\nname: clima-semana\ndescription: Formata o clima da semana em uma tabela curta.\n---\nCORPO-DA-SKILL-CLIMA: responda em tabela.\n');
    await conEnv({ YUI_SKILLS: 'true', YUI_SKILLS_PASTAS: pasta, YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      limparRegistro();
      const placar = brains();
      const p = await principal(placar.chat, { user: OWNER, ...DM, text: `${PERGUNTA} tok-SK1` });
      assert.ok(String(conversaAi(placar.ai)[0].system).includes('CORPO-DA-SKILL-PLACAR'), 'a skill do dono entrou no prompt de sistema');
      assert.equal(p.out.usedSearch, false, 'a skill assumiu o passo: a pesquisa por intenção não roda por cima');
      assert.equal(registro().length, 0);
      assert.ok(!conversaAi(placar.ai)[0].prompt.includes('[CONTEXTO OBTIDO NA WEB]'));
      srv.limpar();
      const clima = brains();
      const c = await principal(clima.chat, { user: OWNER, ...DM, text: FRASE_DO_DONO });
      assert.equal(c.out.usedClima, true, `o clima vale com a skill: ${c.out.text}`);
      assert.ok(conversaAi(clima.ai)[0].prompt.includes('[DADOS DO CLIMA'), 'os dados do clima chegaram ao prompt');
      assert.ok(String(conversaAi(clima.ai)[0].system).includes('CORPO-DA-SKILL-CLIMA'), 'a skill continua no prompt de sistema');
    });
  });

  await test('D: a busca PRIVADA por intenção (DM do dono) usa o log MUDO: nem a consulta nem o host das fontes vão ao log; a busca de servidor continua logando como sempre', async () => {
    // O destino real do log da busca é o logger global (src/utils/logger.js, calado nos testes); aqui ele grava as linhas só durante cada busca.
    const capturar = async (fn) => {
      const linhas = [];
      const gravar = (l) => { linhas.push(String(l)); };
      const antes = {};
      for (const nivel of ['debug', 'info', 'warn', 'error']) { antes[nivel] = logger[nivel]; logger[nivel] = gravar; }
      try { await fn(); } finally { for (const nivel of Object.keys(antes)) logger[nivel] = antes[nivel]; }
      return linhas;
    };
    limparRegistro();
    const privadas = await capturar(() => conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      const { out } = await principal(brains().chat, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo tok-LOG1 ontem?' });
      assert.equal(out.usedSearch, true, out.text);
    }));
    assert.ok(!privadas.some((l) => /tok-LOG1|flamengo|exemplo-teste|\[Search\]/i.test(l)), `a busca privada não pode deixar consulta nem fonte no log: ${JSON.stringify(privadas).slice(0, 300)}`);
    // (a prova de que o teste enxerga o log: a busca de servidor deixa o host das fontes lá)
    limparRegistro();
    const doServidor = await capturar(async () => {
      const sv = await principal(brains().chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-LOG2` });
      assert.equal(sv.out.usedSearch, true);
    });
    assert.ok(doServidor.some((l) => /exemplo-teste/.test(l)), `a busca de servidor continua logando as fontes como sempre: ${JSON.stringify(doServidor).slice(0, 300)}`);
  });

  await test('D: quando os MONITORES tratam o pedido, o diário da retomada que a pesquisa por intenção abriu é DESCARTADO (nada fica em disco)', async () => {
    limparRegistro();
    const retomada = createRetomadaDePesquisa({ dir: path.join(tmp, 'diario-monitor'), env: process.env, logger: quiet });
    const monitores = { rotear: async () => ({ handled: true, text: 'monitor criado (teste)' }) };
    const { chat, ai } = brains({ retomada, extra: { monitores } });
    const r = await principal(chat, { user: MEMBER, ...SRV, text: `${PERGUNTA} tok-MON1`, idem: 'chat.turn:970000000000000042:1' });
    assert.equal(r.out.text, 'monitor criado (teste)');
    const st = retomada.stats();
    assert.equal(st.abertas, 1, 'a pesquisa por intenção chegou a abrir o diário');
    assert.equal(st.descartadas, 1, 'o diário aberto para a pesquisa foi descartado quando o monitor tratou o pedido');
    assert.equal(st.porEstado.pending + st.porEstado.running, 0, 'nada ficou pendente no diário');
    assert.equal(registro().length, 0, 'nenhuma busca saiu');
    assert.equal(ai.calls.length, 0, 'a IA não foi chamada');
  });

  await test('D: na DM do DONO só as categorias SEGURAS pesquisam sozinhas (placar, serviço fora do ar, lançamento de produto); notícia, preço e horário ficam para o pedido explícito; no servidor valem todas', async () => {
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      for (const texto of ['quem ganhou o jogo do Flamengo ontem?', 'o Discord está fora do ar?', 'quando sai o GTA 6?']) {
        limparRegistro();
        const r = await principal(brains().chat, { user: OWNER, ...DM, text: texto });
        assert.equal(r.out.usedSearch, true, `${texto}: ${r.out.text}`);
      }
      for (const texto of ['tem novidade do GTA 6?', 'qual o preço do PS5 hoje?', 'que horas é o jogo do Flamengo hoje?', 'como foi o show do Coldplay ontem?']) {
        limparRegistro();
        const dm = await principal(brains().chat, { user: OWNER, ...DM, text: texto });
        assert.equal(dm.out.usedSearch, false, `na DM do dono não pesquisa: ${texto}`);
        assert.equal(registro().length, 0, texto);
        limparRegistro();
        const sv = await principal(brains().chat, { user: MEMBER, ...SRV, text: texto });
        assert.equal(sv.out.usedSearch, true, `no servidor pesquisa: ${texto}: ${sv.out.text}`);
      }
    });
  });

  await test('a pergunta de dado atual com clima junto não vira pesquisa: o clima é ferramenta própria e vence', async () => {
    limparRegistro();
    srv.limpar();
    const { chat } = brains();
    const r = await principal(chat, { user: MEMBER, ...SRV, text: 'vai chover hoje em Manaus? e quem ganhou o jogo do Flamengo ontem?' });
    assert.equal(r.out.usedClima, true);
    assert.equal(r.out.usedSearch, false);
    assert.equal(registro().length, 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. A fila de verdade do llmHandler (o bot) ligada ao cérebro');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  let seq = 0;
  function fakeMention({ userId, channelId, guildId, text }) {
    const edits = [];
    const msg = {
      id: nextId(), createdTimestamp: Date.now() - 50, content: `<@900000000000000001> ${text}`, channelId, guildId, isVoice: false,
      guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
      author: { id: userId, tag: `u${userId.slice(-4)}#0001`, username: `u${userId.slice(-4)}`, bot: false }, client: { user: { id: '900000000000000001' } },
      mentions: { has: () => true, everyone: false, repliedUser: null, users: new Map() },
      channel: { id: channelId, name: 'geral', send: async (p) => { edits.push(p); return { id: `${++seq}`, channelId, async edit(q) { edits.push(q); }, async delete() {} }; } },
      edits, replies: [],
      async reply(opts) { this.replies.push(opts); return replyMsg; },
      get outputs() { return [...this.replies, ...this.edits]; },
    };
    const replyMsg = { id: `9${String(++seq).padStart(17, '0')}`, channelId, channel: msg.channel, async edit(p) { edits.push(p); return replyMsg; }, async delete() { return undefined; } };
    msg.replyMsg = replyMsg;
    return msg;
  }
  const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
  const textOf = (p) => (typeof p === 'string' ? p : p?.content ?? '');
  const finals = (m) => m.outputs.map(textOf).filter((c) => c && !isProgress(c));
  async function perguntar(m, text) {
    await llm.addToQueue(`--- CONTEXTO ---\n--- MENSAGEM ATUAL ---\n${m.author.username}: "${text}"`, m, 'mention', { allowSearch: true, searchPrompt: text, guildId: m.guildId ?? undefined });
  }
  async function esperar(m, ms = 15_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = finals(m); if (f.length) return f; await sleep(25); }
    throw new Error('sem resposta final');
  }
  const toolJson = (tool, args) => JSON.stringify({ thought: 'acao', tool, args });
  async function comCerebro(reply, fn) {
    const ai = fakeAi({ reply });
    const { chat, research } = brains({ ai });
    const listeners = new Map();
    const idem = createIdemCache();
    const ch = {
      connected: true, calls: [],
      on(ev, fn2) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn2); return () => listeners.get(ev)?.delete(fn2); },
      onState() { return () => {}; },
      ready: async () => ({}),
      async request(method, params, { idem: key } = {}) {
        ch.calls.push({ method, idem: key });
        const meta = { ...META, idem: key ?? null };
        const exec = async () => {
          try {
            let payload;
            if (method === 'chat.turn') payload = await chat.turn(params, meta);
            else if (method === 'chat.commit') payload = await chat.commit(params, meta);
            else if (method === 'research.turn') payload = await research.turn(params, meta);
            else if (method === 'chat.yui') payload = await research.yui(params, meta);
            else if (method === 'chat.forgetVoice') payload = chat.forgetVoice(params);
            else return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: '?' } };
            return { ok: true, payload };
          } catch (err) { return { ok: false, error: { code: err.code ?? 'ERRO', message: err.message } }; }
        };
        const out = key ? await idem.run(`bot\u0000${method}\u0000${key}`, exec).promise : await exec();
        if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
        return out.payload;
      },
      emit(ev, payload) { for (const fn2 of listeners.get(ev) ?? []) fn2(payload); },
    };
    turno.setChatRemote(ch, { logger: quiet });
    try { await fn({ ai, ch }); } finally { await sleep(1300); turno.setChatRemote(null); }
  }

  await test('a FRASE EXATA do dono na DM ("Olá, poderia ver o clima de Cuiabá-MT para essa semana?"): UMA resposta, com o clima, e NÃO a recusa da pesquisa privada', async () => {
    srv.limpar();
    // o modelo (se fosse consultado com as ferramentas) tentaria o search_web, como aconteceu no Discord de verdade
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      await comCerebro((a) => (String(a.system).includes('--- FERRAMENTAS DISPONÍVEIS ---') ? toolJson('search_web', { query: 'clima Cuiabá semana' }) : `Cuiabá vai ficar quente a semana toda; clima=${String(a.prompt).includes('[DADOS DO CLIMA') ? 'sim' : 'nao'}.`), async ({ ai }) => {
        const m = fakeMention({ userId: OWNER, channelId: DMCH, guildId: null, text: FRASE_DO_DONO });
        await perguntar(m, FRASE_DO_DONO);
        const f = await esperar(m);
        await sleep(300);
        const todas = finals(m);
        assert.equal(todas.length, 1, `UMA resposta só: ${JSON.stringify(todas)}`);
        assert.match(todas[0], /Cuiabá vai ficar quente a semana toda; clima=sim\./);
        assert.ok(!todas.join('\n').includes(PRIVATE_SEARCH_NEEDS_EXPLICIT), 'nada da recusa "a pesquisa na web só funciona quando o pedido é explícito"');
        assert.equal(conversaAi(ai).length, 1, 'a IA respondeu uma vez');
        assert.equal(srv.pedidos[0].params.name, 'Cuiabá');
        assert.equal(srv.pedidos.length, 2);
        assert.ok(f.length === 1);
      });
    });
  });

  await test('a DM do dono com "quem ganhou o jogo do Flamengo ontem?": pesquisa e responde em vez de recusar; sem a chave (off) a recusa de sempre continua valendo', async () => {
    limparRegistro();
    const modelo = (a) => (String(a.system).includes('--- FERRAMENTAS DISPONÍVEIS ---') ? toolJson('search_web', { query: 'jogo do Flamengo ontem' }) : `O Flamengo ganhou. web=${String(a.prompt).includes('[CONTEXTO OBTIDO NA WEB]') ? 'sim' : 'nao'}`);
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner', YUI_PESQUISA_POR_INTENCAO: 'dono' }, async () => {
      await comCerebro(modelo, async () => {
        const m = fakeMention({ userId: OWNER, channelId: DMCH, guildId: null, text: PERGUNTA });
        await perguntar(m, PERGUNTA);
        await esperar(m);
        await sleep(300);
        const todas = finals(m);
        assert.equal(todas.length, 1, JSON.stringify(todas));
        assert.match(todas[0], /O Flamengo ganhou\. web=sim/);
        assert.ok(!todas[0].includes(PRIVATE_SEARCH_NEEDS_EXPLICIT));
        assert.equal(registro().filter((r) => r.tipo === 'rapida' && r.privado === true).length, 1);
      });
    });
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner', YUI_PESQUISA_POR_INTENCAO: 'off' }, async () => {
      await comCerebro(modelo, async () => {
        const m = fakeMention({ userId: OWNER, channelId: DMCH, guildId: null, text: PERGUNTA });
        await perguntar(m, PERGUNTA);
        const f = await esperar(m);
        assert.ok(f.join('\n').includes(PRIVATE_SEARCH_NEEDS_EXPLICIT), `a recusa de sempre continua para o que NÃO foi liberado: ${JSON.stringify(f)}`);
        assert.equal(registro().length, 0);
      });
    });
  });

  await test('o servidor pela fila: o clima e a pesquisa por intenção de um membro respondem UMA vez cada, sem a palavra "pesquise"', async () => {
    limparRegistro();
    srv.limpar();
    await comCerebro(null, async ({ ai }) => {
      const a = fakeMention({ userId: MEMBER, channelId: CHAN, guildId: GUILD, text: 'vai chover hoje em São Paulo?' });
      await perguntar(a, 'vai chover hoje em São Paulo?');
      await esperar(a);
      const b = fakeMention({ userId: MEMBER, channelId: CHAN, guildId: GUILD, text: `${PERGUNTA} tok-Q1` });
      await perguntar(b, `${PERGUNTA} tok-Q1`);
      await esperar(b);
      await sleep(300);
      assert.equal(finals(a).length, 1);
      assert.match(finals(a)[0], /clima=sim web=nao/);
      assert.equal(finals(b).length, 1);
      assert.match(finals(b)[0], /clima=nao web=sim/);
      assert.equal(conversaAi(ai).length, 2);
      assert.equal(srv.pedidos[0].params.name, 'São Paulo');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O /yui (chat.yui)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const yui = async (b, { user, guild, channel, text }) => {
    const f = facts({ user, guild, channel, text, entry: 'yui' });
    return b.research.yui({ ...f, pergunta: text, contexto: '' }, { ...META, idem: `chat.yui:${f.turn.id}` });
  };

  await test('/yui com pedido de clima: o clima é a ferramenta (decisão "clima"), sem pesquisa na web e sem promessa de pesquisa; vale no servidor e na DM', async () => {
    limparRegistro();
    srv.limpar();
    const b = brains();
    const a = await yui(b, { user: MEMBER, ...SRV, text: 'como está o clima em Manaus? tok-Y1' });
    assert.equal(a.decisao.modo, 'clima');
    assert.match(a.text, /clima=sim web=nao/);
    assert.equal(a.researched, false);
    assert.equal(registro().length, 0);
    const dm = await yui(b, { user: OWNER, ...DM, text: 'vai chover amanhã em Recife?' });
    assert.equal(dm.decisao.modo, 'clima');
    assert.match(dm.text, /clima=sim/);
    assert.equal(b.research.stats().yuiDecisoes.clima, 2);
    const falha = await yui({ ...brains({ clima: climaServico() }) }, { user: MEMBER, ...SRV, text: 'clima em Zzyzx' });
    assert.equal(falha.text, TEXTO_CLIMA_LOCAL_NAO_ACHADO);
  });

  await test('/yui privado do DONO com YUI_PRIVATE_SEARCH=owner: pesquisa por intenção (privado: true); com a chave off, as regras de antes; o membro em DM continua como antes', async () => {
    limparRegistro();
    await conEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
      const b = brains();
      const r = await yui(b, { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo tok-Y2 ontem?' });
      assert.equal(r.decisao.modo, 'pesquisar');
      assert.equal(r.decisao.motivo, 'intencao-privada');
      assert.equal(r.usedSearch, true, r.text);
      const buscas = registro().filter((x) => x.tipo === 'rapida');
      assert.equal(buscas.length, 1);
      assert.equal(buscas[0].privado, true);
      assert.ok(buscas[0].consulta.includes('tok-Y2'));
      assert.equal(b.ai.calls.filter((x) => x.tipo === 'otimizador').length, 0, 'sem otimizador na privada');
      limparRegistro();
      await conEnv({ YUI_PESQUISA_POR_INTENCAO: 'off' }, async () => {
        const off = await yui(brains(), { user: OWNER, ...DM, text: `${PERGUNTA} tok-Y3` });
        assert.equal(off.decisao.modo, 'privada');
        assert.equal(off.usedSearch, false);
        assert.equal(registro().length, 0);
      });
      const quebrada = await yui(brains({ avaliarIntencao: () => { throw new Error('a política quebrou'); } }), { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo tok-Y6 ontem?' });
      assert.equal(quebrada.decisao.modo, 'privada', 'política que lança: FALHA FECHADA, como antes');
      assert.equal(quebrada.usedSearch, false);
      assert.equal(registro().length, 0);
      const semLimpeza = await yui(brains({ avaliarIntencao: (p) => avaliarPesquisaPorIntencao({ ...p, scrub: () => { throw new Error('x'); } }) }), { user: OWNER, ...DM, text: 'quem ganhou o jogo do Flamengo tok-Y7 ontem?' });
      assert.equal(semLimpeza.decisao.modo, 'privada', 'limpeza que lança: não pesquisa');
      assert.equal(registro().length, 0);
      const membro = await yui(brains(), { user: MEMBER, ...DM, text: `${PERGUNTA} tok-Y4` });
      assert.equal(membro.decisao.modo, 'privada', 'DM de outra pessoa: como antes');
      assert.equal(registro().length, 0);
    });
    await conEnv({ YUI_PRIVATE_SEARCH: 'off' }, async () => {
      const r = await yui(brains(), { user: OWNER, ...DM, text: `${PERGUNTA} tok-Y5` });
      assert.equal(r.decisao.modo, 'privada', 'sem YUI_PRIVATE_SEARCH a privada não pesquisa');
    });
  });
} finally {
  await srv.fechar();
  turno.setChatRemote(null);
}

say(failures.length ? `\nFALHA: ${passed} passaram, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
// Limpeza da pasta temporária (no Windows não dá para apagar a pasta em que o processo está nem com arquivo aberto): sai da pasta, fecha os bancos e o log, e apaga.
try { process.chdir(repoRoot); } catch { /* */ }
try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
try { logger.close?.(); } catch { /* */ }
fs.writeFileSync = realWrite;
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* sobra em %TEMP%: inofensiva */ }
process.exit(failures.length ? 1 : 0);
