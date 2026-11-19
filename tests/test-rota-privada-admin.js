// Etapa 13: a rota de administração que PEDE a nova verificação da rota privada de IA (POST /v1/admin/ia/rota-privada/verificar). Execução: npm run test:rotaprivadaadmin
//
//  A. Quem pode pedir: só o dono, só com `confirm: true` (o booleano); membro 403, sem token 401, sem a confirmação 400; nada é enviado ao OmniRoute nem auditado nesses casos.
//  B. Os estados que a resposta devolve, em PALAVRAS FIXAS (desligada, incompleta, validada, nao-validada com o motivo certo): a sonda vai ao combo privado com a chave privada, SEM conteúdo
//     privado, e só uma sonda válida libera a conversa privada.
//  C. O pedido só PEDE, nunca desbloqueia direto: uma rota BLOQUEADA continua bloqueada enquanto a sonda falhar (cabeçalho fora da lista, ausente, erro 500) e a conversa privada continua fechada, sem
//     chegar ao OmniRoute; só uma sonda VÁLIDA a libera.
//  D. O limite de repetição (3 pedidos a cada 10 minutos; o 4º é 429 sem sonda, e volta depois da janela), a rota desligada ou incompleta não gasta o limite, pedidos ao mesmo tempo dividem UMA sonda.
//  E. Sem nenhum conteúdo: a resposta e a auditoria só levam palavras fixas (nunca a chave, o cabeçalho, o combo, o endereço nem o provedor citado); um estado ou motivo estranho vindo de baixo é contido.
//  F. O cérebro (createCerebroAdmin) e o processo único servem a mesma rota; a política (matriz, routeGuard, enforce, somente leitura) a conhece.
// O OMNIROUTE É FALSO (tests/helpers/omnirouteCabecalhoFalso.js, no formato REAL do cabeçalho: strategy=...; provider=<apelido>; latency_ms=...), aberto por este teste em loopback.
// SEM rede (só o servidor falso), SEM bancos reais (pasta temporária), SEM IA, buscador ou Discord de verdade.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarOmniRouteCabecalhoFalso, CHAVE_DE_TESTE, SEGREDO_NO_CABECALHO } from './helpers/omnirouteCabecalhoFalso.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-rota-privada-admin-'));
const OWNER = '111111111111111111';
const M1 = '222222222222222222';
const TOK = { owner: 'token-do-dono-0123456789abcdef', m1: 'token-membro-1-0123456789abcd' };
const AUDIT = path.join(tmp, 'audit.jsonl');
const VERIFICAR = '/v1/admin/ia/rota-privada/verificar';

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_IA_SONDA_INTERVALO_S: '0', YUI_IA_PERFIL_TIMEOUT_MS: '3000', YUI_RESEARCH_ENABLED: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'secrets', 'channel-secret.json'),
});
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'AI_BACKEND', 'AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_ESCALADA',
  'YUI_IA_ESCALADA_CONTEXTO_CHARS', 'YUI_MOTOR_AGENTE', 'AI_PRIVATE_LOCAL_ONLY', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_READ_ONLY']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const omni = await criarOmniRouteCabecalhoFalso();
process.env.OMNI_CHAVE_PRIVADA = CHAVE_DE_TESTE;
process.env.YUI_GATEWAY_CUSTOM = JSON.stringify([
  { id: 'omniroute-privado', label: 'OmniRoute privado (falso)', baseUrl: `${omni.url}/v1`, apiKeyEnv: 'OMNI_CHAVE_PRIVADA', models: ['combo-privado'], anonymous: false },
]);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { logger } = await imp('src/utils/logger.js');
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (m) => { logs.push(`[${level}] ${String(m)}`); };
const say = (s) => process.stdout.write(`${s}\n`);

const manager = await imp('src/core/ai/manager.js');
const perfis = await imp('src/core/ai/perfis.js');
const rota = await imp('src/core/ai/rotaPerfil.js');
const verificacao = await imp('src/core/ai/verificacaoRotaPrivada.js');
const { createApiServer, parseTokens, parseCorsOrigins } = await imp('src/core/api/server.js');
const { createAdmin, AdminError } = await imp('src/core/api/admin.js');
const { createCerebroAdmin } = await imp('src/cerebro/painel.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { MATRIX } = await imp('src/core/security/permissionMatrix.js');
const { clearTools } = await imp('src/core/agent/tools.js');
clearTools();

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 10).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const auditoria = () => { try { return fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const eventos = (nome) => auditoria().filter((e) => e.event === nome);

// ── a IA "de hoje" (nunca pode atender uma conversa privada) e o que o teste captura ──
const hoje = [];
manager.registerBackend({ name: 'hoje', local: false, chat: async (a) => { hoje.push(a); return 'HOJE-OK'; } }, { activate: true });
const alertas = [];
rota.configurarRotaPerfilParaTeste({ alertar: (...a) => alertas.push(a) });

const CONFIG_OK = () => ({
  privado: { modelo: 'combo-privado', maxTokens: 512, privacidade: 'privada', provedor: 'omniroute-privado', chaveVinculada: true, provedoresPermitidos: ['gemini-cli', 'groq'], decisao: { formato: 'pares', campoProvedor: 'provider' } },
});
function usarPerfis(obj) {
  if (obj === null) delete process.env.YUI_IA_PERFIS; else process.env.YUI_IA_PERFIS = JSON.stringify(obj);
  perfis.esquecerConfigDePerfisParaTeste();
}
function zerar(cfg = CONFIG_OK()) {
  fs.writeFileSync(AUDIT, ''); // a auditoria de cada teste começa vazia
  omni.limpar();
  rota.zerarEstadoParaTeste();
  usarPerfis(cfg);
  alertas.length = 0;
  hoje.length = 0;
}
const BRAGA = { userId: OWNER, platform: 'discord', memoryScope: 'personal' };
const conversaPrivada = (prompt = 'oi') => manager.chat({ prompt, system: 'SISTEMA', history: [], ctx: BRAGA, memoryBlock: '', sensitive: true, perfil: { nome: 'privado', ponto: 'conversa' } });
const fechada = async (promessa) => {
  try { await promessa; } catch (err) { assert.equal(err.code, 'PERFIL_FECHADO', `esperava a falha fechada, veio: ${String(err?.stack ?? err).slice(0, 200)}`); return err; }
  throw new Error('esperava a falha fechada (ErroDePerfil), mas a conversa privada respondeu');
};
const sondas = () => omni.requisicoes.filter((r) => r.mensagens.length === 1 && r.mensagens[0].content === rota.TEXTO_DA_SONDA);
const CHAVES_DA_RESPOSTA = ['estado', 'liberada', 'mensagem', 'motivo', 'ok', 'sondaEnviada'];
const PROIBIDOS = [CHAVE_DE_TESTE, 'sk-omni', SEGREDO_NO_CABECALHO, 'SEGREDO', 'combo-privado', 'omniroute-privado', '127.0.0.1', String(omni.port), 'anonimo-x', 'gemini-cli', 'groq', 'X-OmniRoute', 'strategy', 'latency_ms'];
const SEGREDOS = [CHAVE_DE_TESTE, 'sk-omni', SEGREDO_NO_CABECALHO, 'SEGREDO'];
const semSegredo = (onde, valor) => {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of SEGREDOS) assert.ok(!texto.includes(p), `"${p}" apareceu em ${onde}: ${texto.slice(0, 300)}`);
};
const semConteudo = (onde, valor) => {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of PROIBIDOS) assert.ok(!texto.includes(p), `"${p}" apareceu em ${onde}: ${texto.slice(0, 300)}`);
};

// ── servidores de API (cada um com o seu admin e o seu limite de repetição) ──
const servers = [];
async function subir(opcoes = {}) {
  const server = createApiServer({ tokens: parseTokens(`${TOK.owner}=${OWNER},${TOK.m1}=${M1}`), corsOrigins: parseCorsOrigins(''), ...opcoes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, route, body, extra = {}) => {
    const res = await fetch(`${base}${route}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
  return { server, base, call, verificar: (token = TOK.owner, body = { confirm: true }, extra = {}) => call(token, 'POST', VERIFICAR, body, extra) };
}

// um servidor com o limite de repetição bem alto, para os testes que não são do limite
let apiLivre = null;
const livre = async () => (apiLivre ??= await subir({ admin: createAdmin({ deps: { rotaPrivada: { limite: { max: 100_000, janelaMs: 600_000 } } } }) }));

try {
  // ═════════════════════════════════════════════════════════════════════════════════════
  section('A. Quem pode pedir: só o dono, só com a confirmação');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('sem token 401, membro 403, sem `confirm: true` (só o booleano) 400, outro método 404: nada vai ao OmniRoute e nada é auditado', async () => {
    zerar();
    const api = await subir({ admin: createAdmin() });
    assert.equal((await api.verificar(null)).status, 401);
    const membro = await api.verificar(TOK.m1);
    assert.equal(membro.status, 403, 'membro não pede verificação');
    assert.match(membro.json.error, /dono/i);
    for (const frouxo of [{}, { confirm: false }, { confirm: 'sim' }, { confirm: 1 }, { confirm: 'true' }, { confirm: [true] }, { confirm: {} }]) {
      const r = await api.verificar(TOK.owner, frouxo);
      assert.equal(r.status, 400, JSON.stringify(frouxo));
      assert.match(r.json.error, /Confirmação necessária/);
    }
    assert.equal((await api.call(TOK.owner, 'GET', VERIFICAR)).status, 404);
    assert.equal((await api.call(TOK.owner, 'PUT', VERIFICAR, { confirm: true })).status, 404);
    assert.equal(omni.requisicoes.length, 0, 'nenhuma sonda sem a ordem do dono');
    assert.equal(eventos('admin.ia.rota_privada.verificar').length + eventos('admin.ia.rota_privada.recusado').length, 0, 'sem ordem do dono não há registro');
    assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-verificada', 'o estado da rota não mudou');
  });

  await test('o admin chamado direto também confere o papel e a confirmação (sem depender da rota HTTP)', async () => {
    zerar();
    const admin = createAdmin();
    const dono = { role: 'OWNER', userId: OWNER, platform: 'api', memoryScope: 'personal' };
    await assert.rejects(admin.verificarRotaPrivada({ ...dono, role: 'MEMBER' }, true), (e) => e instanceof AdminError && e.status === 403);
    await assert.rejects(admin.verificarRotaPrivada({ role: 'TRUSTED', userId: M1 }, true), (e) => e.status === 403);
    await assert.rejects(admin.verificarRotaPrivada(undefined, true), (e) => e.status === 403);
    for (const frouxo of [false, 'sim', 1, null, undefined, 'true']) await assert.rejects(admin.verificarRotaPrivada(dono, frouxo), (e) => e.status === 400, `confirm ${String(frouxo)} não vale`);
    assert.equal(omni.requisicoes.length, 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('B. Os estados: palavras fixas, a sonda sem conteúdo e a conversa privada só depois de uma sonda válida');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('sem o perfil privado: "desligada", nada é enviado, e o pedido não gasta o limite de repetição', async () => {
    zerar(null);
    const api = await subir({ admin: createAdmin() });
    for (let i = 0; i < 6; i += 1) {
      const r = await api.verificar();
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(Object.keys(r.json).sort(), CHAVES_DA_RESPOSTA);
      assert.deepEqual([r.json.ok, r.json.estado, r.json.motivo, r.json.liberada, r.json.sondaEnviada], [true, 'desligada', null, false, false]);
      assert.equal(r.json.mensagem, verificacao.MENSAGENS_DA_ROTA.desligada);
    }
    assert.equal(omni.requisicoes.length, 0);
    assert.equal(eventos('admin.ia.rota_privada.verificar').length, 6, 'cada pedido do dono é auditado');
    assert.equal(eventos('admin.ia.rota_privada.verificar').at(-1).estado, 'desligada');
  });

  await test('perfil privado incompleto (sem o formato da decisão, sem a chave vinculada, provedor anônimo): "incompleta" com o motivo em palavra fixa, e nada é enviado', async () => {
    const semFormato = CONFIG_OK(); delete semFormato.privado.decisao;
    const semChave = CONFIG_OK(); delete semChave.privado.chaveVinculada;
    const casos = [[semFormato, 'formato-nao-definido'], [semChave, 'chave-vinculada-ausente']];
    for (const [cfg, motivo] of casos) {
      zerar(cfg);
      const api = await subir({ admin: createAdmin() });
      const r = await api.verificar();
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.estado, r.json.motivo, r.json.liberada, r.json.sondaEnviada], ['incompleta', motivo, false, false]);
      assert.equal(r.json.mensagem, verificacao.MENSAGENS_DA_ROTA.incompleta);
      assert.equal(omni.requisicoes.length, 0, 'configuração incompleta: nenhuma chamada sai');
    }
    // o provedor da Yui cadastrado como ANÔNIMO (o privado nunca usa provedor anônimo)
    zerar();
    const antes = process.env.YUI_GATEWAY_CUSTOM;
    process.env.YUI_GATEWAY_CUSTOM = JSON.stringify([{ id: 'omniroute-privado', label: 'anônimo', baseUrl: `${omni.url}/v1`, apiKeyEnv: 'OMNI_CHAVE_PRIVADA', models: ['combo-privado'], anonymous: true }]);
    try {
      const api = await subir({ admin: createAdmin() });
      const r = await api.verificar();
      assert.deepEqual([r.json.estado, r.json.motivo, r.json.sondaEnviada], ['incompleta', 'provedor-anonimo', false]);
      assert.equal(omni.requisicoes.length, 0);
    } finally { process.env.YUI_GATEWAY_CUSTOM = antes; }
  });

  await test('configuração completa e cabeçalho certo: "validada" (liberada); a sonda vai ao combo privado com a chave privada, SEM conteúdo privado; depois a conversa privada responde', async () => {
    zerar();
    const api = await subir({ admin: createAdmin() });
    assert.equal((await conversaPrivada().then(() => 'respondeu', (e) => e.code)), 'PERFIL_FECHADO', 'antes da sonda válida a conversa privada não sai');
    omni.requisicoes.length = 0;
    const r = await api.verificar();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), CHAVES_DA_RESPOSTA);
    assert.deepEqual([r.json.ok, r.json.estado, r.json.motivo, r.json.liberada, r.json.sondaEnviada], [true, 'validada', null, true, true]);
    assert.equal(r.json.mensagem, verificacao.MENSAGENS_DA_ROTA.validada);
    assert.equal(omni.requisicoes.length, 1, 'UMA sonda');
    const s = omni.requisicoes[0];
    assert.deepEqual([s.modelo, s.papel, s.stream], ['combo-privado', 'chave-certa', false]);
    assert.ok(s.maxTokens <= 16, `a sonda é mínima (max_tokens ${s.maxTokens})`);
    assert.deepEqual(s.mensagens, [{ role: 'user', content: rota.TEXTO_DA_SONDA }], 'só a frase fixa: nenhum conteúdo privado');
    assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
    const ev = eventos('admin.ia.rota_privada.verificar');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].estado, ev[0].motivo, ev[0].sondaEnviada, ev[0].role], ['validada', null, true, 'OWNER']);
    omni.requisicoes.length = 0;
    const texto = await conversaPrivada('segredo-de-conversa-privada');
    assert.equal(texto, 'ok');
    assert.equal(omni.requisicoes.length, 1);
    assert.deepEqual([omni.requisicoes[0].modelo, omni.requisicoes[0].papel], ['combo-privado', 'chave-certa']);
    assert.equal(hoje.length, 0, 'o fluxo de hoje nunca atende a conversa privada');
  });

  await test('a sonda que falha deixa a rota FECHADA, com o motivo em palavra fixa (cabeçalho ausente, sem o provedor, formato estranho, provedor fora da lista, segredo, HTTP, queda, corpo inválido, resposta vazia)', async () => {
    const casos = [
      [{ modo: 'ausente' }, 'cabecalho-ausente'],
      [{ modo: 'sem-provider' }, 'campo-ausente'],
      [{ modo: 'json' }, 'formato-desconhecido'],
      [{ modo: 'duplicado' }, 'formato-desconhecido'],
      [{ modo: 'estranho' }, 'formato-desconhecido'],
      [{ modo: 'segredo' }, 'formato-desconhecido'],
      [{ modo: 'segredo-no-provedor' }, 'provedor-invalido'],
      [{ provedor: 'anonimo-x' }, 'provedor-fora-da-lista'],
      [{ status: 500 }, 'servidor'],
      [{ status: 429 }, 'cota'],
      [{ status: 401 }, 'autenticacao'],
      [{ cair: true }, 'rede'],
      [{ corpoInvalido: true }, 'resposta-invalida'],
      [{ vazio: true }, 'resposta-vazia'],
    ];
    for (const [defs, motivo] of casos) {
      zerar();
      omni.definir(defs);
      const api = await livre();
      const r = await api.verificar();
      assert.equal(r.status, 200, `${JSON.stringify(defs)} -> ${JSON.stringify(r.json)}`);
      assert.deepEqual([r.json.estado, r.json.motivo, r.json.liberada, r.json.sondaEnviada], ['nao-validada', motivo, false, true], JSON.stringify(defs));
      assert.equal(r.json.mensagem, verificacao.MENSAGENS_DA_ROTA['nao-validada']);
      semConteudo(`a resposta (${JSON.stringify(defs)})`, r.json);
      omni.requisicoes.length = 0;
      await fechada(conversaPrivada('x'));
      assert.equal(omni.requisicoes.length, 0, `${JSON.stringify(defs)}: a conversa privada fica fechada e nada vai ao OmniRoute`);
      assert.equal(hoje.length, 0);
    }
  });

  await test('a conversa privada só abre depois de uma sonda VÁLIDA: depois de uma falha, a próxima verificação boa libera', async () => {
    zerar();
    omni.definir({ modo: 'ausente' });
    const api = await subir({ admin: createAdmin() });
    assert.equal((await api.verificar()).json.estado, 'nao-validada');
    await fechada(conversaPrivada());
    omni.definir({});
    const boa = await api.verificar();
    assert.deepEqual([boa.json.estado, boa.json.liberada], ['validada', true]);
    assert.equal(await conversaPrivada(), 'ok');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('C. O pedido só PEDE: a rota bloqueada só volta com uma sonda válida');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('violação real (provedor fora da lista numa conversa privada) bloqueia a rota; o pedido do dono NÃO desbloqueia enquanto a sonda falhar; a conversa continua fechada sem chegar ao OmniRoute', async () => {
    zerar();
    const api = await subir({ admin: createAdmin({ deps: { rotaPrivada: { limite: { max: 50, janelaMs: 600_000 } } } }) });
    assert.equal((await api.verificar()).json.estado, 'validada');
    omni.definir({ provedor: 'anonimo-x' });
    await fechada(conversaPrivada('conversa que vai ser descartada'));
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    assert.equal(rota.estadoDaRotaPrivada().motivo, 'provedor-fora-da-lista');
    assert.equal(alertas.filter((a) => a[0] === 'ia-rota-privada-bloqueada').length, 1, 'o dono foi avisado UMA vez do bloqueio');

    for (const defs of [{ provedor: 'anonimo-x' }, { modo: 'ausente' }, { status: 500 }, { cair: true }, { modo: 'json' }]) {
      omni.definir(defs);
      const antes = omni.requisicoes.length;
      const r = await api.verificar();
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.estado, r.json.motivo, r.json.liberada, r.json.sondaEnviada], ['bloqueada', 'provedor-fora-da-lista', false, true], `${JSON.stringify(defs)}: a verificação que falha MANTÉM o bloqueio (com o motivo do bloqueio)`);
      assert.equal(r.json.mensagem, verificacao.MENSAGENS_DA_ROTA.bloqueada);
      assert.equal(omni.requisicoes.length, antes + 1, 'só a sonda');
      assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
      const depois = omni.requisicoes.length;
      await fechada(conversaPrivada('continua fechada'));
      assert.equal(omni.requisicoes.length, depois, 'bloqueada: a conversa privada nem sai');
    }
    assert.equal(hoje.length, 0);
    assert.equal(alertas.filter((a) => a[0] === 'ia-rota-privada-bloqueada').length, 1, 'o pedido do dono que falhou não gera novo aviso de bloqueio');
    semSegredo('a auditoria', fs.readFileSync(AUDIT, 'utf8'));
  });

  await test('uma sonda VÁLIDA libera a rota bloqueada (e só ela): a conversa privada volta a responder', async () => {
    zerar();
    const api = await subir({ admin: createAdmin() });
    await api.verificar();
    omni.definir({ provedor: 'anonimo-x' });
    await fechada(conversaPrivada());
    assert.equal(rota.estadoDaRotaPrivada().estado, 'bloqueada');
    omni.definir({ provedor: 'groq' });
    const r = await api.verificar();
    assert.deepEqual([r.json.estado, r.json.motivo, r.json.liberada], ['validada', null, true]);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'validada');
    assert.equal(await conversaPrivada(), 'ok');
    assert.equal(hoje.length, 0);
  });

  await test('mudar a lista de provedores permitidos não libera uma rota bloqueada: a rota volta a "nao-verificada" e só uma sonda válida a abre', async () => {
    zerar();
    const api = await subir({ admin: createAdmin() });
    await api.verificar();
    omni.definir({ provedor: 'anonimo-x' });
    await fechada(conversaPrivada());
    // a configuração mudou (a lista passou a aceitar o provedor): a rota volta a "nao-verificada" e ainda precisa de uma sonda válida
    const nova = CONFIG_OK(); nova.privado.provedoresPermitidos = ['anonimo-x'];
    usarPerfis(nova);
    assert.equal(rota.estadoDaRotaPrivada().estado, 'nao-verificada');
    await fechada(conversaPrivada());
    const r = await api.verificar();
    assert.deepEqual([r.json.estado, r.json.liberada], ['validada', true], 'agora a sonda nomeia um provedor da lista nova');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('D. O limite de repetição');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('3 pedidos a cada 10 minutos: o 4º é 429 SEM sonda e fica na auditoria; passada a janela, volta', async () => {
    zerar();
    let agora = 1_000_000;
    const api = await subir({ admin: createAdmin({ deps: { rotaPrivada: { agora: () => agora } } }) });
    for (let i = 0; i < 3; i += 1) {
      const r = await api.verificar();
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.estado, 'validada');
      agora += 1000;
    }
    assert.equal(omni.requisicoes.length, 3);
    const barrado = await api.verificar();
    assert.equal(barrado.status, 429, JSON.stringify(barrado.json));
    assert.match(barrado.json.error, /cedo demais/);
    assert.match(barrado.json.error, /no máximo 3 pedidos a cada 10 minutos/);
    assert.match(barrado.json.error, /em 10 min/);
    assert.equal(omni.requisicoes.length, 3, 'o pedido barrado não faz sonda');
    assert.equal(eventos('admin.ia.rota_privada.recusado').length, 1);
    assert.equal(eventos('admin.ia.rota_privada.recusado')[0].motivo, 'limite');
    assert.equal(eventos('admin.ia.rota_privada.verificar').length, 3, 'o recusado não vira uma verificação');
    semConteudo('a recusa', barrado.json);
    // quase no fim da janela do primeiro pedido: ainda barrado
    agora = 1_000_000 + 599_999;
    assert.equal((await api.verificar()).status, 429);
    // passou a janela do primeiro: um pedido novo vale (e o limite volta a contar)
    agora = 1_000_000 + 600_000;
    const volta = await api.verificar();
    assert.equal(volta.status, 200, JSON.stringify(volta.json));
    assert.equal(omni.requisicoes.length, 4);
    assert.equal((await api.verificar()).status, 429, 'a janela ainda tem 3 pedidos (os de 1 s, 2 s e este)');
    // um membro barrado pelo 403 não gasta o limite do dono, e o limite é do createAdmin (outro admin tem o próprio)
    const outro = await subir({ admin: createAdmin({ deps: { rotaPrivada: { agora: () => agora } } }) });
    assert.equal((await outro.verificar()).status, 200);
  });

  await test('"desligada" e "incompleta" não gastam o limite (o dono pode pedir quantas vezes quiser sem configuração); com o limite pequeno do teste, o resto conta normal', async () => {
    zerar(null);
    const api = await subir({ admin: createAdmin({ deps: { rotaPrivada: { limite: { max: 1, janelaMs: 600_000 } } } }) });
    for (let i = 0; i < 4; i += 1) assert.equal((await api.verificar()).json.estado, 'desligada');
    usarPerfis(CONFIG_OK());
    assert.equal((await api.verificar()).json.estado, 'validada');
    assert.equal((await api.verificar()).status, 429);
    // a rota sem configuração volta a responder "desligada" mesmo com o limite cheio (nenhuma sonda sairia)
    usarPerfis(null);
    assert.equal((await api.verificar()).json.estado, 'desligada');
  });

  await test('pedidos ao mesmo tempo dividem UMA sonda só (todos recebem o mesmo estado), e cada um conta no limite', async () => {
    zerar();
    omni.definir({ atrasoMs: 200 }); // a sonda demora, para os três pedidos se sobreporem de verdade
    const api = await subir({ admin: createAdmin() });
    const respostas = await Promise.all([api.verificar(), api.verificar(), api.verificar()]);
    for (const r of respostas) assert.deepEqual([r.status, r.json.estado, r.json.liberada], [200, 'validada', true], JSON.stringify(r.json));
    assert.equal(sondas().length, 1, 'uma sonda só para os três pedidos');
    assert.equal(eventos('admin.ia.rota_privada.verificar').length, 3);
    omni.definir({});
    assert.equal((await api.verificar()).status, 429, 'os três contaram no limite');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('E. Sem nenhum conteúdo: palavras fixas, e o que vem estranho de baixo é contido');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('um servidor que REPETE a chave (cabeçalho, corpo e erros) e um segredo plantado no cabeçalho: nem a resposta, nem a auditoria, nem o log, nem o alerta os mostram', async () => {
    for (const defs of [{ ecoaChave: true }, { modo: 'segredo' }, { modo: 'segredo-no-provedor' }, { ecoaChave: true, status: 500 }, { ecoaChave: true, modo: 'ausente' }]) {
      zerar();
      omni.definir(defs);
      const api = await livre();
      const r = await api.verificar();
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(Object.keys(r.json).sort(), CHAVES_DA_RESPOSTA);
      for (const v of Object.values(r.json)) assert.ok(['string', 'boolean'].includes(typeof v) || v === null);
      semConteudo(`a resposta (${JSON.stringify(defs)})`, r.json);
      assert.equal(eventos('admin.ia.rota_privada.verificar').length, 1, 'o pedido ficou na auditoria');
      semSegredo(`a auditoria (${JSON.stringify(defs)})`, fs.readFileSync(AUDIT, 'utf8'));
      semSegredo(`o log (${JSON.stringify(defs)})`, logs.join('\n'));
      semSegredo(`os alertas (${JSON.stringify(defs)})`, alertas);
    }
  });

  await test('o que vem estranho de baixo é contido: estado desconhecido vira "nao-validada" (nunca liberada), motivo com cara de segredo vira "outro", um erro vira "erro"', async () => {
    const dono = { role: 'OWNER', userId: OWNER, platform: 'api', memoryScope: 'personal' };
    const com = (verificar, estado = () => ({ estado: 'nao-verificada', motivo: null })) => createAdmin({ deps: { rotaPrivada: { verificar, estado, limite: { max: 100, janelaMs: 60_000 } } } });
    const r1 = await com(async () => ({ estado: 'liberada-sem-sonda', motivo: 'Bearer sk-ABC' })).verificarRotaPrivada(dono, true);
    assert.deepEqual([r1.estado, r1.motivo, r1.liberada], ['nao-validada', 'outro', false]);
    const r2 = await com(async () => ({ estado: 'validada', motivo: 'sk-segredo-plantado' })).verificarRotaPrivada(dono, true);
    assert.deepEqual([r2.estado, r2.motivo, r2.liberada], ['validada', 'outro', true]);
    const r3 = await com(async () => ({ estado: 'bloqueada', motivo: 'Cabecalho Ausente Com Maiusculas e 123' })).verificarRotaPrivada(dono, true);
    assert.deepEqual([r3.estado, r3.motivo], ['bloqueada', 'outro']);
    const r4 = await com(async () => { throw new Error('chave sk-VAZOU no erro'); }).verificarRotaPrivada(dono, true);
    assert.deepEqual([r4.estado, r4.motivo, r4.liberada], ['nao-validada', 'erro', false]);
    semConteudo('a resposta do erro', r4);
    for (const bom of ['cabecalho-ausente', 'provedor-fora-da-lista', 'max-tokens-invalido', 'rede']) assert.equal(verificacao.motivoEmPalavraFixa(bom), bom);
    for (const ruim of ['', 'a', 'CABECALHO', 'com espaço', 'com_sublinhado', 'x'.repeat(60), 'api-key-vazada', 'Bearer', 'meu-secret-1', 'sk-abc', 'gsk-x']) assert.equal(verificacao.motivoEmPalavraFixa(ruim), 'outro', ruim);
    assert.equal(verificacao.motivoEmPalavraFixa(null), null);
    assert.equal(verificacao.motivoEmPalavraFixa(undefined), null);
    // o estado de uma resposta é sempre um dos seis, e só "validada" libera
    for (const e of verificacao.ESTADOS_DA_ROTA) assert.equal(verificacao.respostaDoEstado({ estado: e }).liberada, e === 'validada', e);
    assert.equal(verificacao.respostaDoEstado(null).liberada, false);
    assert.equal(verificacao.respostaDoEstado({ estado: 'validada ' }).estado, 'nao-validada');
    for (const e of verificacao.ESTADOS_DA_ROTA) assert.ok(verificacao.MENSAGENS_DA_ROTA[e] && !/combo|endereço|http|127\.|sk-/i.test(verificacao.MENSAGENS_DA_ROTA[e]), `mensagem de ${e}`);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('F. O cérebro, o processo único e a política');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('o cérebro (createCerebroAdmin) serve a mesma rota: dono 200, membro 403, sem confirmação 400; a verificação acontece no processo do cérebro (o dono das chamadas de IA)', async () => {
    zerar();
    const canal = { isConnected: () => false, request: async () => { throw new Error('sem canal'); } };
    const admin = createCerebroAdmin({ channel: canal, reinicio: async () => ({ aceito: false, motivo: 'sem-supervisor' }) });
    assert.equal(typeof admin.verificarRotaPrivada, 'function', 'o admin do cérebro expõe o pedido');
    const api = await subir({ admin });
    const r = await api.verificar();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.estado, r.json.liberada, r.json.sondaEnviada], ['validada', true, true]);
    assert.equal((await api.verificar(TOK.m1)).status, 403);
    assert.equal((await api.verificar(TOK.owner, {})).status, 400);
    assert.equal((await api.verificar(null)).status, 401);
    assert.equal(sondas().length, 1);
    // sem o perfil privado, o cérebro devolve "desligada"
    zerar(null);
    assert.deepEqual([(await api.verificar()).json.estado, omni.requisicoes.length], ['desligada', 0]);
  });

  await test('processo único (createAdmin de sempre): "desligada" sem perfil, e a verificação normal com o perfil configurado', async () => {
    zerar(null);
    const api = await subir({ admin: createAdmin({ client: null, exit: () => {} }) });
    assert.equal((await api.verificar()).json.estado, 'desligada');
    assert.equal(omni.requisicoes.length, 0);
    usarPerfis(CONFIG_OK());
    const r = await api.verificar();
    assert.deepEqual([r.json.estado, r.json.liberada], ['validada', true]);
    assert.equal((await api.verificar(TOK.m1)).status, 403);
  });

  await test('a política conhece a rota: ação própria na matriz (só o dono, ASK; `modifies`), mapeada no routeGuard', () => {
    assert.equal(actionForRoute('POST', VERIFICAR), 'admin.ia_rota_privada');
    assert.equal(actionForRoute('GET', VERIFICAR), null);
    assert.equal(actionForRoute('POST', `${VERIFICAR}/x`), null);
    const linha = MATRIX.get('admin.ia_rota_privada');
    assert.ok(linha, 'a matriz tem a ação');
    assert.equal(linha.modifies, true, 'com YUI_READ_ONLY=true vira DENY');
    assert.deepEqual(linha.decisions, { OWNER_LOCAL: 'ASK', OWNER_REMOTE: 'ASK', OWNER_DM: 'DENY', ADMIN_GUILD: 'DENY', MEMBER: 'DENY' });
  });

  await test('em enforce: o dono (no PC e pelo app) passa; membro e somente leitura são barrados pela política (403 com a ação); em observe nada muda', async () => {
    zerar();
    const api = await subir({ admin: createAdmin({ deps: { rotaPrivada: { limite: { max: 100, janelaMs: 60_000 } } } }) });
    const barrada = (r) => r.status === 403 && Boolean(r.json?.policy);
    const remoto = { 'x-forwarded-for': '100.64.0.9' };
    try {
      process.env.YUI_POLICY_MODE = 'enforce';
      process.env.YUI_READ_ONLY = 'false'; // (sem a variável o padrão da Yui é somente leitura)
      const local = await api.verificar();
      assert.equal(local.status, 200, JSON.stringify(local.json));
      const app = await api.verificar(TOK.owner, { confirm: true }, remoto);
      assert.equal(app.status, 200, `o app (origem remota) passa: ${JSON.stringify(app.json)}`);
      const membro = await api.verificar(TOK.m1);
      assert.ok(barrada(membro), JSON.stringify(membro));
      assert.equal(membro.json.policy.action, 'admin.ia_rota_privada');
      process.env.YUI_READ_ONLY = 'true';
      const antes = omni.requisicoes.length;
      const somenteLeitura = await api.verificar();
      assert.ok(barrada(somenteLeitura), JSON.stringify(somenteLeitura));
      assert.equal(somenteLeitura.json.policy.decision, 'DENY');
      assert.equal(omni.requisicoes.length, antes, 'a política barra antes de qualquer sonda');
      process.env.YUI_POLICY_MODE = 'observe';
      assert.equal((await api.verificar()).status, 200, 'em observe a política só registra');
    } finally {
      process.env.YUI_POLICY_MODE = 'observe';
      delete process.env.YUI_READ_ONLY;
    }
  });
} finally {
  for (const s of servers) { try { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } catch { /* */ } }
  try { await omni.close(); } catch { /* */ }
  try { rota.restaurarRotaPerfilParaTeste(); } catch { /* */ }
  try { (await imp('src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  try { process.chdir(repoRoot); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
}
if (failures.length) { say(`\n${failures.length} FALHA(S): ${failures.join(' | ')}`); process.exit(1); }
say(`\n${passed} testes OK`);
process.exit(0);
