// Etapa 9: a ROTA dos perfis de IA do Motor 0 contra o OMNIROUTE FALSO (um servidor em loopback aberto por este teste; nada do OmniRoute de verdade é tocado), num processo só.
// Cobre as condições da Liz que dependem de uma chamada de verdade:
//  A. a seleção de perfil (o perfil certo vai com o modelo e a chave certos) e o padrão sem configuração (nenhuma chamada ao OmniRoute);
//  B. o perfil PRIVADO com falha fechada: sem sonda válida não sai; a sonda (sem conteúdo privado) é lida pelo leitor ESTRITO; em cada chamada real, cabeçalho ausente,
//     inválido, em formato desconhecido ou nomeando provedor fora da lista = a resposta não é entregue, a rota fica BLOQUEADA, o dono é avisado e a auditoria registra;
//     o fallback nunca muda a privacidade (nunca para outra rota nem para a anônima);
//  C. o perfil GERAL com o leitor tolerante (cabeçalho ausente ou estranho não derruba nada; o diagnóstico mostra "não confirmado") e o fallback para o fluxo de hoje;
//  D. o limite de tokens (nunca passa de 4096), a lentidão, as quedas e os erros 429/500;
//  E. o SEGREDO plantado no cabeçalho (e a chave de API) nunca aparece no diagnóstico, no log, na auditoria, no alerta nem em erro;
//  F. a CONCORRÊNCIA (sem chamadas nem gravações em duplicidade), o REINÍCIO e o ISOLAMENTO entre pessoas (Braga em DM e um membro no servidor ao mesmo tempo, cada um com o
//     próprio perfil, privacidade e chave, também pelo cérebro de verdade).
// SEM rede (axios bloqueado; o fetch só alcança o servidor falso deste teste), SEM bancos reais (pasta temporária), SEM chamar IA, buscador ou serviço de verdade.
// Execução: npm run test:perfisiarota   (node tests/test-perfis-ia-rota.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarOmniRouteFalso, CHAVE_GERAL, CHAVE_PRIVADA, SEGREDO_PLANTADO as SEGREDO } from './helpers/omnirouteFalso.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-perfis-rota-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_IA_SONDA_INTERVALO_S: '0', YUI_IA_PERFIL_TIMEOUT_MS: '3000',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'secrets', 'channel-secret.json'),
});
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'AI_BACKEND', 'AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_ESCALADA',
  'YUI_IA_ESCALADA_CONTEXTO_CHARS', 'YUI_MOTOR_AGENTE', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'AI_PRIVATE_LOCAL_ONLY', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_MAX_TOKENS']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const omni = await criarOmniRouteFalso();
// Os provedores da Yui apontam para o OmniRoute falso: o geral (anônimo, como o template do aiSettings), o privado (NÃO anônimo, com a chave dele), e um com capacidade declarada.
process.env.OMNI_CHAVE_GERAL = CHAVE_GERAL;
process.env.OMNI_CHAVE_PRIVADA = CHAVE_PRIVADA;
const cadastro = () => [
  { id: 'omniroute', label: 'OmniRoute (falso)', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_GERAL', models: ['auto'], anonymous: true },
  { id: 'omniroute-privado', label: 'OmniRoute privado (falso)', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_PRIVADA', models: ['combo-privado'], anonymous: false },
  { id: 'omni-limitado', label: 'OmniRoute com capacidade declarada', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_GERAL', models: ['auto'], anonymous: true, maxTokens: 512 },
];
process.env.YUI_GATEWAY_CUSTOM = JSON.stringify(cadastro());

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
// axios bloqueado; o fetch só alcança o servidor falso deste teste (qualquer outra coisa falha na hora e fica registrada)
const { default: axios } = await import('axios');
let foraDoFalso = 0;
axios.post = axios.get = async () => { foraDoFalso += 1; throw new Error('offline (teste)'); };
const fetchReal = globalThis.fetch;
globalThis.fetch = (url, opcoes) => {
  let u;
  try { u = new URL(String(url)); } catch { foraDoFalso += 1; throw new Error('fetch bloqueado no teste'); }
  if (u.hostname === '127.0.0.1' && Number(u.port) === omni.port) return fetchReal(url, opcoes);
  foraDoFalso += 1;
  throw new Error('fetch bloqueado no teste');
};
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (/[\\/]data[\\/][^\\/]+\.json$/.test(String(file)) && !String(file).startsWith(tmp)) return undefined; // nada nos arquivos de dados reais
  return realWrite.call(this, file, ...rest);
};

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
// Tudo que o processo escreve no log fica guardado (para conferir que nenhum segredo vazou); nada vai ao console.
const { logger } = await imp('src/utils/logger.js');
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (m) => { logs.push(`[${level}] ${String(m)}`); };
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const manager = await imp('src/core/ai/manager.js');
const perfis = await imp('src/core/ai/perfis.js');
const rota = await imp('src/core/ai/rotaPerfil.js');
const seletor = await imp('src/cerebro/seletorPerfil.js');
const conversa = await imp('src/cerebro/conversa.js');
const comentarioMod = await imp('src/cerebro/comentario.js');
const diag = await imp('src/core/diagnostico.js');
const { createAlerter } = await imp('src/core/alerts.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 10).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(20); }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${what}`);
}

// ── O que o teste captura: o alerta ao dono, a auditoria e o log da rota ──
const alertas = [];
const auditorias = [];
const logsDaRota = [];
const logRota = { info: (m) => logsDaRota.push(String(m)), warn: (m) => logsDaRota.push(String(m)), error: (m) => logsDaRota.push(String(m)) };
function ligarCaptura(extra = {}) {
  rota.configurarRotaPerfilParaTeste({ alertar: (...a) => alertas.push(a), auditar: (...a) => auditorias.push(a), log: logRota, ...extra });
}

/** A configuração de exemplo (o mapeamento PROPOSTO): os provedores da Yui são os do OmniRoute falso. */
const EXEMPLO = () => ({
  conversa: { modelo: 'auto', maxTokens: 1024, privacidade: 'geral', provedor: 'omniroute' },
  rapido: { modelo: 'auto/fast', maxTokens: 256, privacidade: 'geral', provedor: 'omniroute' },
  pesquisa: { modelo: 'auto/smart', maxTokens: 2048, privacidade: 'geral', provedor: 'omniroute' },
  raciocinio: { modelo: 'auto/reason', maxTokens: 4096, privacidade: 'geral', provedor: 'omniroute' },
  privado: { modelo: 'combo-privado', maxTokens: 1024, privacidade: 'privada', provedor: 'omniroute-privado', chaveVinculada: true, provedoresPermitidos: ['groq', 'gemini-pago'], decisao: { formato: 'pares', campoProvedor: 'provider' } },
  visao: { modelo: 'combo-visao', maxTokens: 1024, privacidade: 'geral', provedor: 'omniroute' },
});
const hoje = [];
function usarPerfis(obj) {
  if (obj === null) delete process.env.YUI_IA_PERFIS; else process.env.YUI_IA_PERFIS = JSON.stringify(obj);
  perfis.esquecerConfigDePerfisParaTeste();
}
function zerar({ config: cfg = EXEMPLO() } = {}) {
  omni.limpar();
  hoje.length = 0;
  rota.zerarEstadoParaTeste();
  usarPerfis(cfg);
  alertas.length = 0;
  auditorias.length = 0;
  logsDaRota.length = 0;
  logs.length = 0;
}

// ── A IA "de hoje" (o backend ativo: o fluxo que existia antes dos perfis) ──
// (declarada antes do zerar(), que a esvazia)
manager.registerBackend({ name: 'hoje', local: false, chat: async (a) => { hoje.push(a); return 'HOJE-OK'; } }, { activate: true });
const ctxDe = (userId, extra = {}) => ({ userId, platform: 'discord', ...extra });
const BRAGA = ctxDe(OWNER, { memoryScope: 'personal' });
const MEMBRO = ctxDe(MEMBER, { memoryScope: 'public' });
const pedir = (perfil, { ctx = MEMBRO, sensitive = false, prompt = 'oi', ponto = 'conversa' } = {}) => manager.chat({ prompt, system: 'SISTEMA', history: [], ctx, memoryBlock: '', sensitive, perfil: perfil ? { nome: perfil, ponto } : null });
const falhaFechada = async (promessa) => {
  try { await promessa; } catch (err) { assert.equal(err.code, 'PERFIL_FECHADO', `esperava a falha fechada, veio: ${String(err?.stack ?? err).slice(0, 200)}`); return err; }
  throw new Error('esperava a falha fechada (ErroDePerfil), mas a chamada respondeu');
};
/** Deixa a rota privada VALIDADA (a sonda, com o cabeçalho certo). */
async function validarPrivada() {
  omni.definir('combo-privado', { decisao: 'permitido' });
  const r = await manager.verificarRotaPrivada();
  assert.equal(r.estado, 'validada', JSON.stringify(r));
  omni.requisicoes.length = 0; // só as chamadas de verdade daqui em diante
}
const privadaRespondeu = (texto) => /^OMNI-FALSO modelo=combo-privado chave=privada /.test(texto);
const tudo = () => JSON.stringify({ logs, logsDaRota, alertas, auditorias });
const semSegredoNenhum = (onde, texto) => {
  for (const s of [SEGREDO, 'SEGREDO', CHAVE_GERAL, CHAVE_PRIVADA, 'omni-geral', 'omni-privada']) assert.ok(!String(texto).includes(s), `"${s}" vazou em ${onde}: ${String(texto).slice(0, 200)}`);
};

try {
  ligarCaptura();

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. A seleção de perfil com o provedor falso e o padrão sem configuração');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('cada perfil geral vai ao OmniRoute com o SEU modelo, a chave geral e o limite do perfil (e o backend de hoje não é chamado)', async () => {
    zerar();
    const esperado = { conversa: ['auto', 1024], rapido: ['auto/fast', 256], pesquisa: ['auto/smart', 2048], raciocinio: ['auto/reason', 4096], visao: ['combo-visao', 1024] };
    for (const [perfil, [modelo, max]] of Object.entries(esperado)) {
      const antes = omni.requisicoes.length;
      const texto = await pedir(perfil);
      assert.equal(omni.requisicoes.length, antes + 1, `${perfil}: uma chamada só (nada de revezar provedores aqui)`);
      const r = omni.requisicoes.at(-1);
      assert.equal(r.modelo, modelo, perfil);
      assert.equal(r.papel, 'geral', `${perfil}: a chave geral`);
      assert.equal(r.maxTokens, max, `${perfil}: o limite`);
      assert.equal(r.stream, false);
      assert.deepEqual(r.papeis, ['system', 'user'], 'a conversa vai como sempre (sistema e usuário)');
      assert.match(texto, new RegExp(`^OMNI-FALSO modelo=${modelo.replace('/', '\\/')} chave=geral `), perfil);
    }
    assert.equal(hoje.length, 0, 'o fluxo de hoje não foi usado');
    assert.equal(foraDoFalso, 0);
  });

  await test('o seletor do cérebro + o AI Manager: cada ponto de chamada chega ao combo certo (conversa, síntese, comentário, otimizador, escalada, imagem)', async () => {
    zerar();
    const casos = [
      [{ ponto: 'conversa', texto: 'oi, tudo bem?' }, 'auto'],
      [{ ponto: 'sintese-pesquisa' }, 'auto/smart'],
      [{ ponto: 'comentario' }, 'auto/fast'],
      [{ ponto: 'otimizador-busca' }, 'auto/fast'],
      [{ ponto: 'conversa', texto: 'olha o erro:\n```\nTypeError: x\n```' }, 'auto/reason'],
      [{ ponto: 'conversa', texto: 'e agora?', historicoChars: 20_000 }, 'auto/reason'],
      [{ ponto: 'conversa', texto: 'olha', imagem: true }, 'combo-visao'],
    ];
    for (const [entrada, modelo] of casos) {
      const escolha = seletor.selecionarPerfil({ privada: false, ...entrada });
      assert.ok(escolha, JSON.stringify(entrada));
      const texto = await manager.chat({ prompt: 'p', system: 'S', history: [], ctx: MEMBRO, perfil: escolha });
      assert.equal(omni.requisicoes.at(-1).modelo, modelo, `${JSON.stringify(entrada)} -> ${escolha.nome}`);
      assert.match(texto, /^OMNI-FALSO /);
    }
  });

  await test('PADRÃO sem configuração: o perfil pedido é ignorado, NENHUMA chamada vai ao OmniRoute e o backend recebe o de sempre', async () => {
    zerar({ config: null });
    hoje.length = 0;
    assert.equal(seletor.selecionarPerfil({ ponto: 'conversa', texto: 'oi' }), null);
    const texto = await pedir('conversa');
    assert.equal(texto, 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0, 'o OmniRoute nem foi chamado');
    assert.equal(hoje.length, 1);
    assert.ok(!Object.hasOwn(hoje[0], 'perfil'), 'o backend nunca recebe o campo `perfil`');
    assert.equal(rota.estadoDosPerfis().configurado, false);
    assert.equal(rota.estadoDosPerfis().totais.chamadas, 0);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'desligada');
  });

  await test('perfil que não está configurado (ou o `local`, reservado) cai no fluxo de hoje sem erro e sem chamada ao OmniRoute', async () => {
    zerar({ config: { conversa: EXEMPLO().conversa, local: { modelo: 'local-x', maxTokens: 256, privacidade: 'geral' } } });
    hoje.length = 0;
    assert.equal(await pedir('raciocinio'), 'HOJE-OK');
    assert.equal(await pedir('local'), 'HOJE-OK', 'o `local` nunca é ativo');
    assert.equal(await pedir('perfil-que-nao-existe'), 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0);
    assert.equal(hoje.length, 3);
  });

  await test('auto/chaos nunca chega ao OmniRoute: a configuração com ele é recusada e o perfil não vale', async () => {
    zerar({ config: { conversa: { modelo: 'auto/chaos', maxTokens: 512, privacidade: 'geral', provedor: 'omniroute' } } });
    hoje.length = 0;
    assert.equal(await pedir('conversa'), 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0, 'nem uma chamada com o combo do caos');
    assert.deepEqual(rota.estadoDosPerfis().errosDeConfiguracao, [{ perfil: 'conversa', codigo: 'modelo-chaos' }]);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. O perfil PRIVADO: falha fechada, a sonda, o leitor estrito, o bloqueio e o fallback que nunca muda a privacidade');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('SEM a sonda a conversa privada NÃO sai pelo perfil: responde a falha fechada (mensagem curta e clara) e nada é enviado a nenhum provedor', async () => {
    zerar();
    hoje.length = 0;
    const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'segredo do Braga tok-PRIV1' }));
    assert.equal(err.mensagemCurta, rota.TEXTO_ROTA_PRIVADA_FECHADA);
    assert.match(err.mensagemCurta, /rota privada da IA não está liberada.*não mandei nada a nenhum provedor/);
    assert.ok(err.mensagemCurta.length < 260, 'curta');
    assert.match(err.mensagemCurta, /erro ao processar seu pedido/, 'as marcas de "resposta de sistema" do bot a reconhecem (não entra no contexto)');
    assert.equal(omni.requisicoes.length, 0, 'NADA foi enviado (nem à rota privada, nem à geral)');
    assert.equal(hoje.length, 0, 'e o fluxo de hoje não foi usado');
    assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-verificada');
    assert.equal(err.motivo, 'rota-nao-verificada');
  });

  await test('a SONDA VÁLIDA habilita: uma chamada sem conteúdo privado, pela mesma rota e chave, com o cabeçalho lido pelo leitor ESTRITO e um provedor da lista', async () => {
    zerar();
    // uma conversa privada anterior com conteúdo (que falhou fechada) não pode vazar para a sonda
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'conteudo privado tok-NAOVAZA' }));
    omni.definir('combo-privado', { decisao: 'permitido', provedorPermitido: 'gemini-pago' });
    const r = await manager.verificarRotaPrivada();
    assert.deepEqual(r, { estado: 'validada', motivo: null });
    assert.equal(omni.requisicoes.length, 1);
    const s = omni.requisicoes[0];
    assert.equal(s.sonda, true, 'a sonda é a frase fixa');
    assert.deepEqual([s.modelo, s.papel, s.mensagens, s.papeis], ['combo-privado', 'privada', 1, ['user']], 'o combo e a chave do PRIVADO, uma mensagem só');
    assert.deepEqual(s.marcas, [], 'nenhum conteúdo privado na sonda');
    assert.ok(s.maxTokens <= 16);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
    assert.equal(rota.estadoDosPerfis().rotaPrivada.sondasOk, 1);
    // e agora a conversa privada sai, pelo combo privado e a chave privada
    const texto = await pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'oi tok-PRIV2' });
    assert.ok(privadaRespondeu(texto), texto);
    assert.match(texto, /marcas=\[tok-PRIV2\]/);
    assert.equal(omni.requisicoes.at(-1).maxTokens, 1024);
    assert.equal(hoje.length, 0);
  });

  await test('a SONDA INVÁLIDA não habilita (ausente, estranho, fora da lista, campo repetido, JSON no lugar de pares, queda, 500, resposta vazia): a conversa privada continua fechada', async () => {
    const casos = [
      [{ decisao: 'ausente' }, 'cabecalho-ausente'],
      [{ decisao: 'estranho' }, 'formato-desconhecido'],
      [{ decisao: 'fora' }, 'provedor-fora-da-lista'],
      [{ decisao: 'duplicado' }, 'formato-desconhecido'],
      [{ decisao: 'json' }, 'formato-desconhecido'],
      [{ decisao: 'texto' }, 'formato-desconhecido'],
      [{ decisao: 'segredo-no-provedor' }, 'provedor-invalido'],
      [{ cair: true }, 'rede'],
      [{ status: 500 }, 'servidor'],
      [{ status: 429 }, 'cota'],
      [{ vazio: true }, 'resposta-vazia'],
      [{ corpoInvalido: true }, 'resposta-invalida'],
    ];
    for (const [comportamento, motivo] of casos) {
      zerar();
      omni.definir('combo-privado', comportamento);
      const r = await manager.verificarRotaPrivada();
      assert.deepEqual(r, { estado: 'nao-validada', motivo }, JSON.stringify(comportamento));
      const antes = omni.requisicoes.length;
      const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'privado tok-NAOSAI' }));
      assert.equal(err.motivo, 'rota-nao-validada');
      assert.equal(omni.requisicoes.length, antes, `${JSON.stringify(comportamento)}: a conversa privada não saiu`);
      assert.ok(omni.requisicoes.every((x) => x.sonda), 'só a sonda foi enviada');
    }
    assert.equal(hoje.length, 0);
  });

  await test('sonda lenta (acima do tempo do perfil) = não validada, "tempo esgotado"', async () => {
    zerar();
    process.env.YUI_IA_PERFIL_TIMEOUT_MS = '600';
    try {
      omni.definir('combo-privado', { atrasoMs: 1500 });
      const r = await manager.verificarRotaPrivada();
      assert.deepEqual(r, { estado: 'nao-validada', motivo: 'tempo-esgotado' });
    } finally { process.env.YUI_IA_PERFIL_TIMEOUT_MS = '3000'; }
  });

  await test('CABEÇALHO ausente numa chamada real = a resposta NÃO é entregue, a rota fica BLOQUEADA, o dono é avisado (limite de repetição), a auditoria registra', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'ausente' });
    const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'privado tok-ABS1' }));
    assert.equal(err.motivo, 'rota-bloqueada-cabecalho-ausente');
    assert.equal(omni.requisicoes.length, 1, 'a chamada saiu (não dá para desfazer), mas a resposta foi descartada');
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    assert.equal(rota.estadoDaRotaPrivada().motivo, 'cabecalho-ausente');
    assert.equal(alertas.length, 1, 'um aviso ao dono');
    assert.equal(alertas[0][0], 'ia-rota-privada-bloqueada');
    assert.equal(alertas[0][3].cooldownMinutes, 60, 'com limite de repetição');
    assert.equal(auditorias.length, 1);
    assert.deepEqual([auditorias[0][0], auditorias[0][2].motivo, auditorias[0][2].perfil], ['ia.rota_privada_bloqueada', 'cabecalho-ausente', 'privado']);
    assert.ok(logs.some((l) => /BLOQUEADA \(cabecalho-ausente\)/.test(l)) || logsDaRota.some((l) => /BLOQUEADA \(cabecalho-ausente\)/.test(l)));
    // fica bloqueada: a próxima chamada privada nem sai
    const antes = omni.requisicoes.length;
    const err2 = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'de novo tok-ABS2' }));
    assert.equal(err2.motivo, 'rota-bloqueada');
    assert.equal(omni.requisicoes.length, antes, 'nada saiu com a rota bloqueada');
    assert.equal(alertas.length, 1, 'o aviso não se repete a cada pedido');
    assert.equal(auditorias.length, 1);
  });

  await test('cabeçalho INVÁLIDO, em formato DESCONHECIDO, com campo repetido, com segredo no campo, ou com provedor FORA da lista = bloqueio (cada um com o seu motivo)', async () => {
    const casos = [
      [{ decisao: 'estranho' }, 'formato-desconhecido', null],
      [{ decisao: 'duplicado' }, 'formato-desconhecido', null],
      [{ decisao: 'json' }, 'formato-desconhecido', null],
      [{ decisao: 'texto' }, 'formato-desconhecido', null],
      [{ decisao: 'segredo-no-provedor' }, 'provedor-invalido', null],
      [{ decisao: 'bruto', valorBruto: 'x'.repeat(3000) }, 'cabecalho-invalido', null],
      [{ decisao: 'bruto', valorBruto: 'strategy=priority;latency=3' }, 'campo-ausente', null],
      [{ decisao: 'fora' }, 'provedor-fora-da-lista', 'anonimo-x'],
      [{ decisao: 'fora', provedorFora: 'pollinations' }, 'provedor-fora-da-lista', 'pollinations'],
      [{ decisao: 'bruto', valorBruto: 'provider=GROQ-IMPOSTOR;strategy=priority' }, 'provedor-fora-da-lista', 'groq-impostor'],
    ];
    for (const [comportamento, motivo, citado] of casos) {
      zerar();
      await validarPrivada();
      omni.definir('combo-privado', comportamento);
      const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'privado tok-VIOL' }));
      assert.equal(err.motivo, `rota-bloqueada-${motivo}`, JSON.stringify(comportamento));
      assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada', JSON.stringify(comportamento));
      assert.equal(auditorias[0][2].motivo, motivo);
      assert.equal(auditorias[0][2].provedorCitado, citado, 'só o provedor citado, filtrado (nunca o cabeçalho)');
      assert.equal(alertas.length, 1);
      assert.ok(!/tok-VIOL/.test(tudo()), 'nada do conteúdo privado no log, no alerta nem na auditoria');
    }
  });

  await test('provedor PERMITIDO (e o JSON permitido só vale no formato declarado): a chamada privada é entregue e fica registrada como "verificada"', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'permitido', provedorPermitido: 'Gemini-Pago' });
    const texto = await pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'ok tok-OK1' });
    assert.ok(privadaRespondeu(texto));
    const u = rota.estadoDosPerfis().ultimas.at(-1);
    assert.deepEqual([u.perfil, u.provedor, u.estrategia, u.resultado, u.decisao, u.combo, u.limiteTokens], ['privado', 'gemini-pago', 'priority', 'ok', 'verificada', 'combo-privado', 1024]);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
    assert.equal(alertas.length, 0);
  });

  await test('uma chamada privada que FALHA (500, 429, queda, lentidão, resposta vazia) NÃO migra para a rota geral, nem para o fluxo de hoje: falha fechada, sem bloquear a rota', async () => {
    for (const comportamento of [{ status: 500 }, { status: 429 }, { cair: true }, { vazio: true }, { corpoInvalido: true }, { atrasoMs: 4000 }]) {
      zerar();
      await validarPrivada();
      hoje.length = 0;
      process.env.YUI_IA_PERFIL_TIMEOUT_MS = '700';
      try {
        omni.definir('combo-privado', comportamento);
        const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'privado tok-FALHA' }));
        assert.match(err.motivo, /^chamada-/, JSON.stringify(comportamento));
      } finally { process.env.YUI_IA_PERFIL_TIMEOUT_MS = '3000'; }
      assert.deepEqual(omni.requisicoes.map((x) => x.modelo), ['combo-privado'], 'nenhuma chamada a outro combo (nem ao geral)');
      assert.ok(omni.requisicoes.every((x) => x.papel === 'privada'), 'a chave geral nunca foi usada');
      assert.equal(hoje.length, 0, 'e o fluxo de hoje (que pode ter provedor anônimo) não foi usado');
      assert.equal(rota.estadoDaRotaPrivada().estado, 'validada', 'uma falha de rede não prova vazamento: não bloqueia');
      assert.equal(alertas.length, 0);
    }
  });

  await test('um perfil GERAL nunca atende uma chamada PRIVADA (o fallback nunca muda a privacidade): ela segue pelo fluxo de hoje, que já nunca usa provedor anônimo', async () => {
    zerar();
    hoje.length = 0;
    // o chamador pediu o perfil "conversa" para uma chamada sensível (um erro dele): o gerente recusa a rota geral
    const texto = await pedir('conversa', { ctx: BRAGA, sensitive: true });
    assert.equal(texto, 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0, 'a rota geral (anônima) não recebeu a conversa privada');
    assert.equal(hoje.length, 1);
    assert.equal(hoje[0].sensitive, true, 'o backend de hoje recebe o `sensitive`, como sempre');
    // e quando é o contexto (memória pessoal) que torna a chamada privada
    await pedir('conversa', { ctx: BRAGA, sensitive: false });
    assert.equal(omni.requisicoes.length, 0);
    assert.equal(rota.estadoDosPerfis().perfis.find((p) => p.nome === 'conversa').recusadasPorPrivacidade, 2);
  });

  await test('o perfil privado com a configuração INCOMPLETA (sem o formato, sem a chave vinculada, provedor anônimo, provedor ausente) falha fechada: nenhuma chamada sai', async () => {
    const p = EXEMPLO().privado;
    const { decisao, ...semFormato } = p;
    const { chaveVinculada, ...semChave } = p;
    const casos = [
      [semFormato, 'config-formato-nao-definido'],
      [semChave, 'config-chave-vinculada-ausente'],
      [{ ...p, provedor: 'omniroute' }, 'config-provedor-anonimo'],
      [{ ...p, provedor: 'provedor-que-nao-existe' }, 'config-provedor-nao-cadastrado'],
      [{ ...p, modelo: 'auto' }, 'config-modelo-virtual-no-privado'],
    ];
    for (const [privado, motivo] of casos) {
      zerar({ config: { ...EXEMPLO(), privado } });
      omni.limpar();
      const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      assert.equal(err.motivo, motivo);
      assert.equal(omni.requisicoes.length, 0, motivo);
      assert.equal((await manager.verificarRotaPrivada()).estado, 'incompleta', 'nem a sonda sai com a configuração incompleta');
      assert.equal(omni.requisicoes.length, 0);
    }
    assert.equal(hoje.length, 0);
  });

  await test('BLOQUEADA só volta por nova verificação pedida de propósito: a sonda sozinha não desbloqueia; com a rota corrigida e o pedido explícito, volta', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'fora' });
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    omni.requisicoes.length = 0;
    omni.definir('combo-privado', { decisao: 'permitido' });
    assert.deepEqual(await manager.verificarRotaPrivada(), { estado: 'bloqueada', motivo: 'provedor-fora-da-lista' }, 'sem o pedido explícito continua bloqueada');
    assert.equal(omni.requisicoes.length, 0, 'e nem sonda foi enviada');
    assert.deepEqual(await manager.verificarRotaPrivada({ desbloquear: true }), { estado: 'validada', motivo: null });
    assert.equal(omni.requisicoes.length, 1);
    assert.ok(privadaRespondeu(await pedir('privado', { ctx: BRAGA, sensitive: true })));
    // regra da Liz: o pedido de nova verificação NUNCA desbloqueia direto; só uma sonda VÁLIDA tira a rota do bloqueio. Uma que continua errada a mantém BLOQUEADA
    omni.definir('combo-privado', { decisao: 'fora' });
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    assert.deepEqual(await manager.verificarRotaPrivada({ desbloquear: true }), { estado: 'bloqueada', motivo: 'provedor-fora-da-lista' });
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada', 'continua bloqueada');
    omni.requisicoes.length = 0;
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    assert.equal(omni.requisicoes.length, 0, 'e a conversa privada continua fechada: nada saiu');
    assert.equal(rota.estadoDosPerfis().rotaPrivada.falhasSeguidas, 1, 'a falha da verificação ficou registrada');
  });

  await test('uma rota BLOQUEADA nunca é sondada sozinha (nem passado o intervalo): só o pedido explícito a verifica de novo', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'fora' });
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    // a hora passa (o intervalo das sondas sozinhas, de 1 s, já venceu muito) e o OmniRoute "melhorou"
    const futuro = Date.now() + 3_600_000;
    ligarCaptura({ agora: () => futuro });
    process.env.YUI_IA_SONDA_INTERVALO_S = '1';
    try {
      omni.definir('combo-privado', { decisao: 'permitido' });
      omni.requisicoes.length = 0;
      const sondasAntes = rota.estadoDosPerfis().rotaPrivada.sondas;
      const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      assert.equal(err.motivo, 'rota-bloqueada');
      assert.equal(rota.estadoDosPerfis().rotaPrivada.sondas, sondasAntes, 'nenhuma sonda foi disparada sozinha (a contagem sobe na hora em que a sonda começa)');
      await sleep(150);
      assert.equal(omni.requisicoes.length, 0, 'e nada chegou ao OmniRoute');
      assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    } finally {
      process.env.YUI_IA_SONDA_INTERVALO_S = '0';
      ligarCaptura({ agora: () => Date.now() });
    }
  });

  await test('o intervalo PADRÃO das sondas sozinhas é de 5 minutos (decisão da Liz): antes disso nada é sondado de novo; passados os 5 minutos, a sonda sai', async () => {
    zerar();
    delete process.env.YUI_IA_SONDA_INTERVALO_S; // o padrão
    let agora = 1_800_000_000_000;
    ligarCaptura({ agora: () => agora });
    try {
      omni.definir('combo-privado', { status: 500 });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await waitUntil(() => rota.estadoDosPerfis().rotaPrivada.falhasSeguidas === 1, 5000, 'a 1ª sonda sozinha falhar');
      assert.equal(omni.requisicoes.filter((x) => x.sonda).length, 1);
      agora += 299_000; // 4 min 59 s depois: ainda não
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await sleep(150);
      assert.equal(omni.requisicoes.filter((x) => x.sonda).length, 1, 'antes dos 5 minutos nenhuma sonda nova');
      agora += 2_000; // 5 min 1 s depois
      omni.definir('combo-privado', { status: 200, decisao: 'permitido' });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await waitUntil(() => rota.estadoDaRotaPrivada().estado === 'validada', 5000, 'a sonda dos 5 minutos validar a rota');
      assert.equal(omni.requisicoes.filter((x) => x.sonda).length, 2, 'passados os 5 minutos a sonda saiu');
      assert.equal(rota.estadoDosPerfis().rotaPrivada.falhasSeguidas, 0, 'uma sonda boa zera a conta das falhas');
    } finally { process.env.YUI_IA_SONDA_INTERVALO_S = '0'; ligarCaptura({ agora: () => Date.now() }); }
  });

  await test('LIMITE de tentativas: depois de N sondas seguidas com falha as sozinhas PAUSAM (falhas registradas e avisadas no log); só o pedido de propósito retoma; uma sonda boa zera a conta', async () => {
    zerar();
    process.env.YUI_IA_SONDA_INTERVALO_S = '300';
    process.env.YUI_IA_SONDA_MAX_TENTATIVAS = '3';
    let agora = 1_800_000_000_000;
    ligarCaptura({ agora: () => agora });
    try {
      omni.definir('combo-privado', { status: 500 });
      for (let i = 1; i <= 3; i += 1) {
        await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
        await waitUntil(() => rota.estadoDosPerfis().rotaPrivada.falhasSeguidas === i, 5000, `a falha seguida ${i}`);
        agora += 301_000;
      }
      let r = rota.estadoDosPerfis().rotaPrivada;
      assert.equal(r.sondaSozinhaPausada, true, 'na 3ª falha seguida as sondas sozinhas pausam');
      assert.equal(r.falhasRecentes.length, 3);
      assert.ok(r.falhasRecentes.every((f) => typeof f.motivo === 'string' && f.motivo.length > 0 && Number.isInteger(f.haSegundos)), 'cada falha com o motivo e há quanto tempo');
      assert.ok(logsDaRota.some((l) => /falhas seguidas: 3 de 3/.test(l)), 'a falha ficou no log');
      assert.ok(logsDaRota.some((l) => /PAUSADAS/.test(l)), 'a pausa também');
      // pausadas: nem passado o intervalo (e com o OmniRoute "melhorado") sai sonda sozinha
      omni.definir('combo-privado', { status: 200, decisao: 'permitido' });
      const sondasAntes = omni.requisicoes.filter((x) => x.sonda).length;
      agora += 3_600_000;
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await sleep(150);
      assert.equal(omni.requisicoes.filter((x) => x.sonda).length, sondasAntes, 'pausada: nenhuma sonda sozinha');
      assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-validada');
      // o pedido de propósito retoma, e uma sonda boa zera a conta
      assert.deepEqual(await manager.verificarRotaPrivada(), { estado: 'validada', motivo: null });
      r = rota.estadoDosPerfis().rotaPrivada;
      assert.equal(r.falhasSeguidas, 0);
      assert.equal(r.sondaSozinhaPausada, false);
      assert.deepEqual(r.falhasRecentes, []);
      assert.ok(privadaRespondeu(await pedir('privado', { ctx: BRAGA, sensitive: true })));
    } finally {
      process.env.YUI_IA_SONDA_INTERVALO_S = '0';
      delete process.env.YUI_IA_SONDA_MAX_TENTATIVAS;
      ligarCaptura({ agora: () => Date.now() });
    }
  });

  await test('uma configuração NOVA retoma as sondas sozinhas pausadas e zera a conta das falhas', async () => {
    zerar();
    process.env.YUI_IA_SONDA_INTERVALO_S = '300';
    process.env.YUI_IA_SONDA_MAX_TENTATIVAS = '1';
    let agora = 1_800_000_000_000;
    ligarCaptura({ agora: () => agora });
    try {
      omni.definir('combo-privado', { status: 500 });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await waitUntil(() => rota.estadoDosPerfis().rotaPrivada.sondaSozinhaPausada === true, 5000, 'a pausa na 1ª falha');
      const outra = EXEMPLO();
      outra.privado.maxTokens = 512; // muda a assinatura da configuração
      usarPerfis(outra);
      agora += 301_000;
      omni.definir('combo-privado', { status: 200, decisao: 'permitido' });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true })); // a 1ª chamada com a configuração nova volta a "não verificada" e sonda
      await waitUntil(() => rota.estadoDaRotaPrivada().estado === 'validada', 5000, 'a sonda da configuração nova validar a rota');
      const r = rota.estadoDosPerfis().rotaPrivada;
      assert.equal(r.sondaSozinhaPausada, false);
      assert.equal(r.falhasSeguidas, 0);
    } finally {
      process.env.YUI_IA_SONDA_INTERVALO_S = '0';
      delete process.env.YUI_IA_SONDA_MAX_TENTATIVAS;
      ligarCaptura({ agora: () => Date.now() });
    }
  });

  await test('a sonda sozinha, em segundo plano, quando a rota ainda não foi verificada (com intervalo): a 1ª chamada privada falha fechada e a seguinte já passa', async () => {
    zerar();
    process.env.YUI_IA_SONDA_INTERVALO_S = '1';
    try {
      omni.definir('combo-privado', { decisao: 'permitido' });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'primeiro tok-BG1' }));
      await waitUntil(() => rota.estadoDaRotaPrivada().estado === 'validada', 5000, 'a sonda em segundo plano validar a rota');
      assert.equal(omni.requisicoes.filter((x) => x.sonda).length, 1, 'uma sonda só');
      assert.equal(omni.requisicoes.filter((x) => !x.sonda).length, 0, 'a 1ª chamada privada NÃO saiu');
      assert.ok(privadaRespondeu(await pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'segundo tok-BG2' })));
    } finally { process.env.YUI_IA_SONDA_INTERVALO_S = '0'; }
  });

  await test('AI_PRIVATE_LOCAL_ONLY com memória pessoal: a rota do perfil (nuvem) não vale; o backend local atende', async () => {
    zerar();
    await validarPrivada();
    hoje.length = 0;
    process.env.AI_PRIVATE_LOCAL_ONLY = 'true';
    try {
      manager.registerBackend({ name: 'local-falso', local: true, chat: async () => 'LOCAL-OK' }, { activate: true });
      assert.equal(await pedir('privado', { ctx: BRAGA, sensitive: true }), 'LOCAL-OK');
      assert.equal(omni.requisicoes.length, 0, 'nada foi à nuvem');
    } finally {
      delete process.env.AI_PRIVATE_LOCAL_ONLY;
      manager.registerBackend({ name: 'hoje', local: false, chat: async (a) => { hoje.push(a); return 'HOJE-OK'; } }, { activate: true });
    }
  });

  await test('sem o perfil `privado` declarado a conversa privada continua como hoje (o backend atende; nada vai ao OmniRoute pelo perfil)', async () => {
    const { privado, ...semPrivado } = EXEMPLO();
    zerar({ config: semPrivado });
    hoje.length = 0;
    assert.equal(seletor.selecionarPerfil({ ponto: 'conversa', privada: true, texto: 'oi' }), null);
    assert.equal(await pedir('privado', { ctx: BRAGA, sensitive: true }), 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'desligada');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. O perfil geral: o leitor tolerante só para diagnóstico, o fallback e as falhas (429, 500, lentidão, queda)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('perfis NÃO privados seguem funcionando mesmo sem o cabeçalho, ou com ele estranho: o diagnóstico mostra "não confirmado"', async () => {
    zerar();
    const variantes = [
      [{ decisao: 'ausente' }, null, 'nao-confirmada'],
      [{ decisao: 'estranho' }, null, 'nao-confirmada'],
      [{ decisao: 'permitido' }, 'groq', 'confirmada'],
      [{ decisao: 'json' }, 'groq', 'confirmada'],
      [{ decisao: 'texto' }, 'groq', 'confirmada'],
      [{ decisao: 'fora' }, 'anonimo-x', 'confirmada'], // um provedor qualquer: no geral nada se bloqueia
    ];
    for (const [comportamento, provedor, decisao] of variantes) {
      omni.definir('auto', comportamento);
      const texto = await pedir('conversa');
      assert.match(texto, /^OMNI-FALSO modelo=auto chave=geral /, JSON.stringify(comportamento));
      const u = rota.estadoDosPerfis().ultimas.at(-1);
      assert.deepEqual([u.perfil, u.resultado, u.provedor, u.decisao, u.fallback], ['conversa', 'ok', provedor, decisao, false], JSON.stringify(comportamento));
    }
    const d = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } });
    assert.equal(d.perfisDeIa.ultimas[0].provedorQueRespondeu, null, 'não confirmado = nenhum provedor inventado');
    assert.equal(d.perfisDeIa.ultimas[0].decisao, 'nao-confirmada');
    assert.equal(d.perfisDeIa.ultimas[2].estrategia, 'priority');
    assert.equal(d.perfisDeIa.ultimas[2].latenciaMs, 42, 'a latência que o OmniRoute disse');
    assert.equal(hoje.length, 0, 'nenhum fallback');
  });

  await test('FALHA TOTAL da rota do perfil geral (429, 500, queda, lentidão, resposta vazia ou inválida): cai no fluxo de hoje, registrando o fallback (contador e último evento)', async () => {
    zerar();
    process.env.YUI_IA_PERFIL_TIMEOUT_MS = '700';
    try {
      const casos = [[{ status: 429 }, 'cota'], [{ status: 500 }, 'servidor'], [{ cair: true }, 'rede'], [{ atrasoMs: 4000 }, 'tempo-esgotado'], [{ vazio: true }, 'resposta-vazia'], [{ corpoInvalido: true }, 'resposta-invalida'], [{ status: 401 }, 'autenticacao']];
      let n = 0;
      for (const [comportamento, motivo] of casos) {
        hoje.length = 0;
        omni.definir('auto/fast', comportamento);
        const texto = await pedir('rapido');
        assert.equal(texto, 'HOJE-OK', JSON.stringify(comportamento));
        assert.equal(hoje.length, 1, 'o fluxo de hoje atendeu UMA vez');
        n += 1;
        const u = rota.estadoDosPerfis().ultimas.at(-1);
        assert.deepEqual([u.perfil, u.resultado, u.fallback, u.motivo], ['rapido', 'fallback', true, motivo], JSON.stringify(comportamento));
        assert.equal(rota.estadoDosPerfis().perfis.find((p) => p.nome === 'rapido').fallbacks, n);
      }
    } finally { process.env.YUI_IA_PERFIL_TIMEOUT_MS = '3000'; }
    assert.ok(logsDaRota.some((l) => /perfil rapido.*seguindo pelo fluxo de hoje/.test(l)), 'o fallback fica no log');
    assert.equal(omni.requisicoes.filter((x) => x.modelo === 'auto/fast').length, 7, 'uma chamada por tentativa (sem repetir nem revezar)');
  });

  await test('provedor do perfil NÃO cadastrado na Yui (ou desligado) = fallback; e com o fluxo de hoje também fora, o erro é controlado (a chamada rejeita, nada trava)', async () => {
    zerar({ config: { conversa: { modelo: 'auto', maxTokens: 512, privacidade: 'geral', provedor: 'provedor-que-nao-existe' } } });
    hoje.length = 0;
    assert.equal(await pedir('conversa'), 'HOJE-OK');
    assert.equal(omni.requisicoes.length, 0);
    assert.equal(rota.estadoDosPerfis().ultimas.at(-1).motivo, 'provedor-nao-cadastrado');
    // o fluxo de hoje também fora: o erro dele chega a quem chamou (controlado)
    manager.registerBackend({ name: 'hoje', local: false, chat: async () => { throw Object.assign(new Error('IA de hoje fora (teste)'), { code: 'IA_FORA' }); } }, { activate: true });
    try { await assert.rejects(() => pedir('conversa'), /IA de hoje fora/); } finally {
      manager.registerBackend({ name: 'hoje', local: false, chat: async (a) => { hoje.push(a); return 'HOJE-OK'; } }, { activate: true });
    }
  });

  await test('LIMITE DE TOKENS: o que o servidor recebeu nunca passa de 4096 (o teto), e a capacidade declarada do provedor corta; capacidade desconhecida não se inventa', async () => {
    zerar({ config: {
      conversa: { modelo: 'auto', maxTokens: 8192, privacidade: 'geral', provedor: 'omniroute' },
      rapido: { modelo: 'auto/fast', maxTokens: 100, privacidade: 'geral', provedor: 'omniroute' },
      pesquisa: { modelo: 'auto/smart', maxTokens: 4096, privacidade: 'geral', provedor: 'omni-limitado' },
      raciocinio: { modelo: 'auto/reason', maxTokens: 700, privacidade: 'geral', provedor: 'omni-limitado' },
    } });
    await pedir('conversa');
    await pedir('rapido');
    await pedir('pesquisa');
    await pedir('raciocinio');
    assert.deepEqual(omni.requisicoes.map((r) => [r.modelo, r.maxTokens]), [['auto', 4096], ['auto/fast', 100], ['auto/smart', 512], ['auto/reason', 512]]);
    process.env.YUI_MAX_TOKENS_TETO = '8192';
    try {
      omni.requisicoes.length = 0;
      await pedir('conversa');
      assert.equal(omni.requisicoes[0].maxTokens, 4096, 'o teto global em 8192 não libera mais que 4096 para um perfil');
    } finally { delete process.env.YUI_MAX_TOKENS_TETO; }
    process.env.YUI_MAX_TOKENS_TETO = '512';
    try {
      omni.requisicoes.length = 0;
      await pedir('conversa');
      assert.equal(omni.requisicoes[0].maxTokens, 512, 'o teto global menor vale');
    } finally { delete process.env.YUI_MAX_TOKENS_TETO; }
    const d = rota.estadoDosPerfis();
    assert.deepEqual([d.perfis.find((p) => p.nome === 'conversa').limiteEfetivo, d.perfis.find((p) => p.nome === 'conversa').capacidadeConhecida], [4096, null]);
    assert.deepEqual([d.perfis.find((p) => p.nome === 'pesquisa').limiteEfetivo, d.perfis.find((p) => p.nome === 'pesquisa').capacidadeConhecida], [512, 512]);
  });

  await test('o isolatedChat (síntese, otimizador e comentário) também vai pelo perfil, sem histórico e sem memória', async () => {
    zerar();
    const texto = await manager.isolatedChat({ prompt: 'sintetiza', system: 'S', ctx: MEMBRO, perfil: { nome: 'pesquisa', ponto: 'sintese-pesquisa' } });
    assert.match(texto, /^OMNI-FALSO modelo=auto\/smart chave=geral /);
    assert.deepEqual(omni.requisicoes.at(-1).papeis, ['system', 'user']);
    assert.equal(omni.requisicoes.at(-1).mensagens, 2);
    assert.equal(rota.estadoDosPerfis().ultimas.at(-1).ponto, 'sintese-pesquisa');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O SEGREDO plantado no cabeçalho (e a chave de API) nunca aparece no diagnóstico, no log, na auditoria, no alerta nem em erro');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('perfil GERAL com o segredo no cabeçalho: a conversa segue; o segredo não vai ao diagnóstico nem ao log; o provedor é o do campo filtrado', async () => {
    zerar();
    omni.definir('auto', { decisao: 'segredo' });
    const texto = await pedir('conversa');
    assert.match(texto, /^OMNI-FALSO /);
    omni.definir('auto', { decisao: 'segredo-no-provedor' });
    await pedir('conversa');
    const d = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } });
    const u = d.perfisDeIa.ultimas;
    assert.deepEqual([u[0].provedorQueRespondeu, u[0].estrategia, u[0].latenciaMs], ['groq', 'priority', 7]);
    assert.deepEqual([u[1].provedorQueRespondeu, u[1].decisao], [null, 'nao-confirmada'], 'o segredo no lugar do provedor: não confirmado');
    semSegredoNenhum('o diagnóstico', JSON.stringify(d));
    semSegredoNenhum('os logs', tudo());
  });

  await test('perfil PRIVADO com o segredo no cabeçalho (na sonda e na chamada real): o bloqueio, o alerta, a auditoria, o log, o erro e o diagnóstico não levam o segredo', async () => {
    for (const decisao of ['segredo', 'segredo-no-provedor']) {
      zerar();
      // na sonda
      omni.definir('combo-privado', { decisao });
      const r = await manager.verificarRotaPrivada();
      assert.equal(r.estado, 'nao-validada');
      // numa chamada real (a rota foi validada antes com um cabeçalho bom)
      omni.definir('combo-privado', { decisao: 'permitido' });
      assert.equal((await manager.verificarRotaPrivada()).estado, 'validada');
      omni.definir('combo-privado', { decisao });
      const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'privado' }));
      assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada', decisao);
      semSegredoNenhum('o erro (message)', err.message);
      semSegredoNenhum('o erro (mensagemCurta)', err.mensagemCurta);
      semSegredoNenhum('o erro (pilha)', err.stack);
      semSegredoNenhum('o log, o alerta e a auditoria', tudo());
      const d = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } });
      semSegredoNenhum('o diagnóstico', JSON.stringify(d));
    }
  });

  await test('a chave de API do perfil nunca vai ao log, ao alerta, à auditoria, ao diagnóstico nem a um erro (mesmo com falhas de rede e HTTP)', async () => {
    zerar();
    await validarPrivada();
    process.env.YUI_IA_PERFIL_TIMEOUT_MS = '700';
    try {
      for (const comportamento of [{ status: 401 }, { status: 500 }, { cair: true }, { atrasoMs: 3000 }]) {
        omni.definir('auto', comportamento);
        omni.definir('combo-privado', comportamento);
        await pedir('conversa');
        const err = await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
        semSegredoNenhum('o erro', `${err.message} ${err.mensagemCurta} ${err.stack}`);
      }
    } finally { process.env.YUI_IA_PERFIL_TIMEOUT_MS = '3000'; }
    semSegredoNenhum('os logs', tudo());
    semSegredoNenhum('o diagnóstico', JSON.stringify(diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } })));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. Concorrência, reinício e o limite de repetição do alerta');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('CONCORRÊNCIA: 12 conversas ao mesmo tempo = 12 chamadas (nenhuma duplicada, nenhuma perdida), cada resposta com a marca da própria conversa, e nenhuma gravação em disco', async () => {
    zerar();
    omni.definir('*', { atrasoMs: 30 });
    const perfisDaVez = ['conversa', 'rapido', 'pesquisa', 'raciocinio'];
    const respostas = await Promise.all(Array.from({ length: 12 }, (_, i) => pedir(perfisDaVez[i % 4], { ctx: ctxDe(`3000000000000000${String(i).padStart(2, '0')}`), prompt: `pergunta tok-C${i}x` })));
    assert.equal(omni.requisicoes.length, 12, 'exatamente uma chamada por conversa');
    respostas.forEach((t, i) => assert.match(t, new RegExp(`marcas=\\[tok-C${i}x\\]`), `a resposta ${i} é da conversa ${i}`));
    const marcas = omni.requisicoes.map((r) => r.marcas[0]);
    assert.equal(new Set(marcas).size, 12, 'nenhuma marca repetida');
    const d = rota.estadoDosPerfis();
    assert.equal(d.totais.chamadas, 12);
    assert.equal(d.totais.ok, 12);
    assert.equal(d.ultimas.length, 12);
    assert.equal(auditorias.length, 0, 'chamadas normais não gravam nada na auditoria');
    assert.equal(alertas.length, 0);
    assert.equal(hoje.length, 0);
  });

  await test('CONCORRÊNCIA da rota privada: duas violações ao mesmo tempo = UM bloqueio, UM alerta e UMA linha de auditoria (as duas respostas são descartadas); cinco sondas ao mesmo tempo = uma só', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'fora', atrasoMs: 60 });
    const resultados = await Promise.allSettled([
      pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'a tok-V1' }),
      pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'b tok-V2' }),
    ]);
    assert.ok(resultados.every((r) => r.status === 'rejected' && r.reason.code === 'PERFIL_FECHADO'), 'as duas descartadas');
    assert.equal(omni.requisicoes.length, 2);
    assert.equal(alertas.length, 1, 'um aviso só');
    assert.equal(auditorias.length, 1, 'uma linha de auditoria só');
    assert.equal(rota.estadoDosPerfis().rotaPrivada.violacoes, 2, 'as duas violações contadas');
    // sondas simultâneas dividem uma só
    zerar();
    omni.definir('combo-privado', { decisao: 'permitido', atrasoMs: 60 });
    const sondas = await Promise.all(Array.from({ length: 5 }, () => manager.verificarRotaPrivada()));
    assert.ok(sondas.every((s) => s.estado === 'validada'));
    assert.equal(omni.requisicoes.length, 1, 'uma sonda só para as cinco');
    assert.equal(rota.estadoDosPerfis().rotaPrivada.sondas, 1);
  });

  await test('REINÍCIO: a configuração dos perfis é recuperada igual; a rota privada volta a exigir verificação (a validação e o bloqueio não sobrevivem ao processo)', async () => {
    const arq = path.join(tmp, 'perfis-reinicio.json');
    zerar({ config: null });
    fs.writeFileSync(arq, JSON.stringify(EXEMPLO(), null, 2));
    process.env.YUI_IA_PERFIS_ARQUIVO = arq;
    perfis.esquecerConfigDePerfisParaTeste();
    try {
      const antes = perfis.carregarPerfis(process.env);
      await validarPrivada();
      assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
      // "o processo reiniciou": nada em memória
      rota.zerarEstadoParaTeste();
      perfis.esquecerConfigDePerfisParaTeste();
      const depois = perfis.carregarPerfis(process.env);
      assert.deepEqual(depois.perfis, antes.perfis);
      assert.equal(depois.assinatura, antes.assinatura);
      assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-verificada', 'precisa de uma nova sonda');
      omni.requisicoes.length = 0;
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      assert.equal(omni.requisicoes.length, 0);
      // um bloqueio também não sobrevive: depois do reinício, é a NOVA sonda que decide (e continua exigindo o cabeçalho certo)
      omni.definir('combo-privado', { decisao: 'fora' });
      assert.equal((await manager.verificarRotaPrivada()).estado, 'nao-validada');
      omni.definir('combo-privado', { decisao: 'permitido' });
      assert.equal((await manager.verificarRotaPrivada()).estado, 'validada');
      // a conversa geral também volta igual
      assert.match(await pedir('conversa'), /^OMNI-FALSO modelo=auto chave=geral /);
    } finally { delete process.env.YUI_IA_PERFIS_ARQUIVO; perfis.esquecerConfigDePerfisParaTeste(); fs.rmSync(arq, { force: true }); }
  });

  await test('a configuração MUDOU (outro combo ou outra lista de provedores): a rota privada volta a "não verificada" e exige uma nova sonda', async () => {
    zerar();
    await validarPrivada();
    assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
    usarPerfis({ ...EXEMPLO(), privado: { ...EXEMPLO().privado, provedoresPermitidos: ['groq'] } });
    const e = rota.estadoDaRotaPrivada();
    assert.deepEqual([e.estado, e.motivo], ['nao-verificada', 'configuracao-mudou']);
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    assert.equal(omni.requisicoes.length, 0);
  });

  await test('a ROTA mudou (a chave do provedor do perfil privado trocada): a verificação não vale mais; a conversa privada fecha até uma nova sonda', async () => {
    zerar();
    await validarPrivada();
    const antes = process.env.OMNI_CHAVE_PRIVADA;
    process.env.OMNI_CHAVE_PRIVADA = 'sk-omni-privada-NOVA-0123456789abcdef';
    try {
      omni.requisicoes.length = 0;
      const e = rota.estadoDaRotaPrivada();
      assert.deepEqual([e.estado, e.motivo], ['nao-verificada', 'rota-mudou']);
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      assert.equal(omni.requisicoes.length, 0, 'nada saiu pela rota nova sem verificar');
    } finally { process.env.OMNI_CHAVE_PRIVADA = antes; }
    // a chave de volta é OUTRA impressão em relação à da verificação nova? Aqui a verificação era da chave antiga: com a antiga de volta, vale de novo
    assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-verificada', 'uma vez invalidada, só uma nova sonda liga');
    assert.equal((await manager.verificarRotaPrivada()).estado, 'validada');
  });

  await test('o LIMITE DE REPETIÇÃO do alerta ao dono (o alerter de verdade): duas violações na mesma hora = uma DM; passada a hora, a próxima vai', async () => {
    zerar();
    const dms = [];
    let agora = Date.parse('2026-11-18T12:00:00Z');
    const alerter = createAlerter({ notify: async (_id, texto) => { dms.push(texto); }, ownerId: OWNER, env: { YUI_ALERTS: 'true' }, now: () => agora });
    ligarCaptura({ alertar: (k, t, d, o) => alerter.alert(k, t, d, o) });
    try {
      await validarPrivada();
      omni.definir('combo-privado', { decisao: 'fora' });
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await sleep(20);
      assert.equal(dms.length, 1, 'a primeira violação avisa');
      assert.match(dms[0], /rota privada da IA foi bloqueada/);
      assert.match(dms[0], /anonimo-x/, 'diz o provedor citado');
      semSegredoNenhum('a DM', dms[0]);
      // reconfigura e valida de novo, e um segundo bloqueio dentro de 1 hora
      omni.definir('combo-privado', { decisao: 'permitido' });
      await manager.verificarRotaPrivada({ desbloquear: true });
      omni.definir('combo-privado', { decisao: 'fora' });
      agora += 30 * 60_000;
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await sleep(20);
      assert.equal(dms.length, 1, 'dentro da hora o aviso não se repete');
      // passada a hora
      omni.definir('combo-privado', { decisao: 'permitido' });
      await manager.verificarRotaPrivada({ desbloquear: true });
      omni.definir('combo-privado', { decisao: 'fora' });
      agora += 40 * 60_000;
      await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
      await sleep(20);
      assert.equal(dms.length, 2, 'passada a hora, avisa de novo');
    } finally { ligarCaptura({ alertar: (...a) => alertas.push(a) }); }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('F. ISOLAMENTO entre pessoas: o pedido de uma pessoa nunca herda o perfil, a privacidade ou a chave de outra');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('Braga em DM (privado) e um membro no servidor (geral) AO MESMO TEMPO, repetidas vezes e com tempos diferentes: cada um com o seu combo, a sua chave e a sua marca', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { atrasoMs: 80 });
    omni.definir('auto', { atrasoMs: 10 });
    const rodadas = [];
    for (let i = 0; i < 6; i += 1) {
      rodadas.push(pedir('privado', { ctx: BRAGA, sensitive: true, prompt: `segredo do Braga tok-BRAGA${i}` }));
      rodadas.push(pedir('conversa', { ctx: MEMBRO, sensitive: false, prompt: `pergunta do membro tok-MEMBRO${i}` }));
    }
    const textos = await Promise.all(rodadas);
    for (let i = 0; i < 6; i += 1) {
      assert.match(textos[i * 2], new RegExp(`^OMNI-FALSO modelo=combo-privado chave=privada .*marcas=\\[tok-BRAGA${i}\\]`), `Braga ${i}`);
      assert.match(textos[i * 2 + 1], new RegExp(`^OMNI-FALSO modelo=auto chave=geral .*marcas=\\[tok-MEMBRO${i}\\]`), `membro ${i}`);
    }
    for (const r of omni.requisicoes) {
      const doBraga = r.marcas.some((m) => m.startsWith('tok-BRAGA'));
      const doMembro = r.marcas.some((m) => m.startsWith('tok-MEMBRO'));
      assert.notEqual(doBraga, doMembro, 'uma requisição nunca mistura as duas pessoas');
      if (doBraga) assert.deepEqual([r.modelo, r.papel], ['combo-privado', 'privada'], 'o Braga: só o combo e a chave privados');
      if (doMembro) assert.deepEqual([r.modelo, r.papel], ['auto', 'geral'], 'o membro: só o combo e a chave gerais (nunca a privada)');
    }
    assert.equal(omni.requisicoes.length, 12);
    assert.equal(hoje.length, 0);
  });

  await test('uma chamada do membro NUNCA herda o perfil privado do Braga: sem o privado válido a do Braga fecha, e a do membro segue normal; depois do bloqueio, o membro continua', async () => {
    zerar();
    await validarPrivada();
    omni.definir('combo-privado', { decisao: 'fora' });
    const [braga, membro] = await Promise.allSettled([pedir('privado', { ctx: BRAGA, sensitive: true, prompt: 'tok-B' }), pedir('conversa', { ctx: MEMBRO, prompt: 'tok-M' })]);
    assert.equal(braga.status, 'rejected');
    assert.equal(braga.reason.code, 'PERFIL_FECHADO');
    assert.equal(membro.status, 'fulfilled');
    assert.match(membro.value, /^OMNI-FALSO modelo=auto chave=geral /);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    assert.match(await pedir('conversa', { ctx: MEMBRO, prompt: 'tok-M2' }), /^OMNI-FALSO modelo=auto chave=geral /, 'o bloqueio da rota privada não derruba a conversa geral');
    // a privacidade é da CHAMADA: uma sensível pedindo o perfil geral não é atendida por ele
    const antes = omni.requisicoes.length;
    assert.equal(await pedir('conversa', { ctx: BRAGA, sensitive: true, prompt: 'tok-B2' }), 'HOJE-OK');
    assert.equal(omni.requisicoes.length, antes);
  });

  await test('PELO CÉREBRO de verdade (chat.turn + o seletor + o AI Manager): o Braga em DM e o membro no servidor ao mesmo tempo, cada um com o seu perfil, privacidade e chave', async () => {
    zerar();
    await validarPrivada();
    omni.definir('*', { atrasoMs: 40 });
    const cerebro = conversa.createChatBrain({ ai: manager, context: { enabled: () => false }, memoryBlock: async () => '', persona: () => 'PERSONA', tools: () => [] });
    const turno = ({ id, userId, guildId, channelId, texto }) => ({
      turn: { id, at: Date.now() - 100 }, ctx: { platform: 'discord', userId, guildId, channelId, isDM: !guildId }, call: { entry: 'fila', type: 'mention', mentionsBot: true },
      prompt: texto, ownText: texto, channel: {}, options: { main: true, persona: true },
    });
    const [rb, rm] = await Promise.all([
      cerebro.turn(turno({ id: 'turno-braga-1', userId: OWNER, guildId: null, channelId: DMCH, texto: 'meu segredo tok-CB1' }), { role: 'bot' }),
      cerebro.turn(turno({ id: 'turno-membro-1', userId: MEMBER, guildId: GUILD, channelId: CHAN, texto: 'minha pergunta tok-CM1' }), { role: 'bot' }),
    ]);
    assert.ok(rb.text.startsWith('OMNI-FALSO modelo=combo-privado chave=privada'), `o Braga (DM): ${rb.text}`);
    assert.ok(rm.text.startsWith('OMNI-FALSO modelo=auto chave=geral'), `o membro (servidor): ${rm.text}`);
    assert.equal(rb.failed, false);
    assert.equal(rm.failed, false);
    assert.match(rb.text, /marcas=\[tok-CB1\]/);
    assert.match(rm.text, /marcas=\[tok-CM1\]/);
    // com a rota privada fechada, o Braga recebe a mensagem curta e o membro segue
    omni.definir('combo-privado', { decisao: 'ausente' });
    const [fb, fm] = await Promise.all([
      cerebro.turn(turno({ id: 'turno-braga-2', userId: OWNER, guildId: null, channelId: DMCH, texto: 'outro segredo tok-CB2' }), { role: 'bot' }),
      cerebro.turn(turno({ id: 'turno-membro-2', userId: MEMBER, guildId: GUILD, channelId: CHAN, texto: 'outra pergunta tok-CM2' }), { role: 'bot' }),
    ]);
    assert.equal(fb.failed, true);
    assert.equal(fb.text, rota.TEXTO_ROTA_PRIVADA_FECHADA, 'a mensagem curta e clara da falha fechada');
    assert.equal(fm.failed, false);
    assert.ok(fm.text.startsWith('OMNI-FALSO modelo=auto chave=geral'));
    assert.equal(hoje.length, 0, 'o Braga não caiu no fluxo de hoje');
    // o cérebro não pede o aviso de "IA fora" ao dono por causa da rota privada (ela avisa sozinha)
  });

  await test('o comentário do cérebro: público vai pelo perfil rápido; privado (DM) vai pelo privado, sem histórico nem memória', async () => {
    zerar();
    await validarPrivada();
    const comentario = comentarioMod.createCommentBrain({ ai: manager });
    const fatos = (userId, guildId) => ({
      turn: { id: `coment-${userId}-${Math.random().toString(16).slice(2, 8)}`, at: Date.now() - 100 },
      ctx: { platform: 'discord', userId, guildId, channelId: guildId ? CHAN : DMCH, isDM: !guildId, isBlocked: false },
      call: { entry: 'comentario', type: 'slash', record: false }, channel: {}, tipo: 'steam', dados: { nome: 'Hollow Knight', preco: 'R$ 46,99' },
    });
    const pub = await comentario.comentario(fatos(MEMBER, GUILD), { role: 'bot' });
    assert.match(pub.text, /^OMNI-FALSO modelo=auto\/fast chave=geral /);
    const priv = await comentario.comentario(fatos(OWNER, null), { role: 'bot' });
    assert.match(priv.text, /^OMNI-FALSO modelo=combo-privado chave=privada /);
    assert.deepEqual(omni.requisicoes.slice(-2).map((r) => r.mensagens), [2, 2], 'só o sistema e o pedido: sem histórico');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('G. O diagnóstico pelos perfis de verdade');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('o diagnóstico mostra motor, perfil, combo, provedor, estratégia, fallback (sim/não e contagem), limite efetivo, latência, resultado, contadores por perfil e a rota privada', async () => {
    zerar();
    await validarPrivada();
    await pedir('conversa');
    omni.definir('auto/fast', { status: 500 });
    await pedir('rapido');
    await pedir('privado', { ctx: BRAGA, sensitive: true });
    const d = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } });
    const p = d.perfisDeIa;
    assert.equal(p.configurado, true);
    assert.equal(p.origem, 'ambiente');
    const por = Object.fromEntries(p.perfis.map((x) => [x.nome, x]));
    assert.deepEqual([por.conversa.chamadas, por.conversa.ok, por.conversa.fallbacks, por.conversa.combo, por.conversa.limiteEfetivo, por.conversa.privacidade], [1, 1, 0, 'auto', 1024, 'geral']);
    assert.deepEqual([por.rapido.chamadas, por.rapido.erros, por.rapido.fallbacks], [1, 1, 1]);
    assert.deepEqual([por.privado.chamadas, por.privado.ok, por.privado.combo, por.privado.privacidade, por.privado.provedorDaYui], [1, 1, 'combo-privado', 'privada', 'omniroute-privado']);
    assert.deepEqual([p.totais.chamadas, p.totais.ok, p.totais.fallbacks], [3, 2, 1]);
    const ult = p.ultimas;
    assert.equal(ult.length, 3);
    assert.deepEqual([ult[0].perfil, ult[0].combo, ult[0].provedorQueRespondeu, ult[0].estrategia, ult[0].fallbackUsado, ult[0].limiteDeTokens, ult[0].latenciaMs, ult[0].resultado], ['conversa', 'auto', 'groq', 'priority', false, 1024, 42, 'ok']);
    assert.deepEqual([ult[1].perfil, ult[1].fallbackUsado, ult[1].resultado, ult[1].motivo], ['rapido', true, 'fallback', 'servidor']);
    assert.deepEqual([ult[2].perfil, ult[2].resultado, ult[2].decisao], ['privado', 'ok', 'verificada']);
    assert.equal(p.rotaPrivada.estado, 'validada');
    assert.equal(p.rotaPrivada.formatoDefinido, true);
    assert.equal(d.estado, 'ok', JSON.stringify(d.motivos));
    assert.equal(d.motorAgente.ativo, 'nativo');
    semSegredoNenhum('o diagnóstico', JSON.stringify(d));
    // bloqueada = problema no estado geral
    omni.definir('combo-privado', { decisao: 'fora' });
    await falhaFechada(pedir('privado', { ctx: BRAGA, sensitive: true }));
    const d2 = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => rota.estadoDosPerfis() } });
    assert.equal(d2.perfisDeIa.rotaPrivada.estado, 'bloqueada');
    assert.equal(d2.estado, 'problema');
    assert.equal(d2.perfisDeIa.rotaPrivada.violacoes, 1);
  });

  await test('uma falha na COLETA do diagnóstico nunca afeta o cérebro: a fonte que lança vira seção vazia, e o estado dos perfis nunca lança', () => {
    const d = diag.montarDiagnostico({ fontes: { bancos: () => [], erros: () => ({ errors: 0 }), perfisIa: () => { throw new Error('quebrou a coleta'); }, motor: () => { throw new Error('quebrou o motor'); } } });
    assert.equal(d.perfisDeIa.configurado, false);
    assert.equal(d.perfisDeIa.rotaPrivada.estado, 'desligada');
    assert.equal(d.motorAgente.pedido, 'nativo');
    assert.doesNotThrow(() => rota.estadoDosPerfis({ YUI_IA_PERFIS: '{{{' }));
    assert.doesNotThrow(() => rota.estadoDosPerfis(null));
  });

  await test('nenhum acesso fora do OmniRoute falso em todo o teste (axios e fetch bloqueados)', () => assert.equal(foraDoFalso, 0));

  console.log = realConsole.log;
  say(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
} finally {
  rota.restaurarRotaPerfilParaTeste();
  try { await omni.close(); } catch { /* */ }
  try { process.chdir(repoRoot); } catch { /* */ }
  try { (await imp('src/database/db.js')).closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
