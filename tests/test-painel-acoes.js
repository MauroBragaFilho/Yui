// Lacunas do painel, ENTREGA E, parte 1 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md itens 3 v2 e 4 v2; docs/DESENHO_PAINEL_APROVACAO_E_GOOGLE.md seção 1): as AÇÕES
// do painel sobre o que roda no processo da API, SÓ DO DONO, sem regra nova.
//   POST /v1/admin/planos/:id/decisao   a MESMA decidir() dos botões da DM (src/core/planos/servico.js), com YUI_PLANOS_PAINEL (desligada = 404)
//   POST /v1/admin/live/entrar | /sair   o MESMO comando da conversa ("entra na live <link> por N horas", "sai da live") pelo MESMO rotear() do serviço da live
// A. O cofre e a política: a chave nova (padrão desligada, vale na hora, pede confirmação), as rotas no routeGuard com ações próprias na matriz, fora do PANEL_ACTIONS.
// B. Planos pelo painel, com o serviço do CÉREBRO de verdade (src/cerebro/planos.js sobre um canal falso; a DM é o pedido 'planos.decidir' de sempre): chave
//    desligada 404, membro 403, hash/versão errados e vencido recusam, aprovar executa uma vez e a DM depois responde "já foi respondido", recusar não executa,
//    dois pedidos seguidos só um vale, limite de repetição, auditoria com a origem "painel" e nada de argumentos nem resultados nas respostas.
// C. Live pelo painel contra o YouTube FALSO (tests/helpers/youtubeFalso.js): entrar com a duração (o mesmo texto e o mesmo ritmo da conversa), já numa live,
//    sem a autorização do canal, link fora do formato e de outro site, membro 403, chave desligada 404, serviço fora 503, sair (sem limite), auditoria sem o link.
// D. O processo único (a porta dos planos É o serviço), o cérebro (nada vai ao bot) e o bot separado (nunca usa a porta dele, que é o canal).
// Num processo só, pasta temporária, sem .env, sem rede de fora. Execução: npm run test:painelacoes
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarYoutubeFalso, TOKEN_FALSO } from './helpers/youtubeFalso.js';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-acoes-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const SEGREDO = 'SEGREDO-DO-TESTE-9e2a';
const DB = path.join(tmp, 'db');
const AUDIT = path.join(tmp, 'audit.jsonl');
const ARQ_YT = path.join(tmp, 'secrets', 'youtube-token.json');
const YT_SEGREDO = `yt-client-secret-${SEGREDO}`;
const YT_REFRESH = `1//refresh-yt-${SEGREDO}`;

Object.assign(process.env, {
  DATABASE_DIR: DB, YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error',
  YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_READ_ONLY: 'false', YUI_LOG_DIR: path.join(tmp, 'logs'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
  YUI_PLANOS: 'true', YUI_PLANOS_AUTO: 'false', YUI_PLANOS_PAINEL: 'true', YUI_YOUTUBE_LIVE: 'true', YUI_YOUTUBE_TOKEN_ARQUIVO: ARQ_YT,
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_API_TOKENS', 'YUI_PAINEL_CONFIG_FILE', 'YUI_IA_PERFIS', 'YUI_IA_PERFIL_PRIVADO']) delete process.env[k];
fs.mkdirSync(DB, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const cfg = await imp('src/core/painelConfig.js');
const { planosPeloPainel } = await imp('src/core/planos/pedido.js');
// A chave de confirmação pela DM para APROVAR (correção C2) tem a suíte dela, de ponta a ponta (test:painelconfirmacao). Aqui o assunto é a decisão: um
// substituto aceita a chave, e o resto da regra continua o de verdade.
(await imp('src/core/api/confirmacao.js')).definirConfirmacoesParaTestes({ emitir: () => ({ codigo: '000-000', expiraEmSegundos: 300, revogar() {} }), conferir: () => true, esquecerSessao: () => 0, tamanho: () => 0 });
const { criarFerramentasDePlano } = await imp('src/core/planos/ferramentas.js');
const { VALIDADE_MS } = await imp('src/core/planos/servico.js');
const { arquivoDosPlanos } = await imp('src/core/planos/store.js');
const { definirPortaDePlanos } = await imp('src/core/planos/porta.js');
const { registrarPlanos, METODO_DECIDIR } = await imp('src/cerebro/planos.js');
const { createPolicyEngine } = await imp('src/core/security/policyEngine.js');
const { MATRIX } = await imp('src/core/security/permissionMatrix.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { criarServicoDaLive, ritmoDaLive } = await imp('src/core/live/servico.js');
const { gravarCredencial } = await imp('src/core/live/credencial.js');
const { definirPortaDaLive } = await imp('src/adaptadores/youtube/porta.js');
const { createAdmin, LIMITE_DAS_DECISOES, LIMITE_DAS_ENTRADAS } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await imp('src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await imp('src/discord/canalCerebro.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const silencioso = { info() {}, warn() {}, error() {} };
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
const ACOES = ['decidirPlano', 'entrarNaLive', 'sairDaLive'];
const auditoria = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eventos = (nome) => auditoria().filter((e) => e.event === nome);

// O que nunca pode sair numa resposta das ações nem na auditoria: os argumentos e os resultados de um plano, segredos e o link da live.
const ARG_DO_PLANO = `compras-${SEGREDO}`.slice(0, 40);
const PROIBIDOS = [SEGREDO, ARG_DO_PLANO, 'saida secreta', TOKEN_FALSO, YT_SEGREDO, YT_REFRESH, 'ya29.'];
function semConteudo(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of PROIBIDOS) assert.ok(!texto.includes(p), `${rotulo} vazou: ${p}`);
}

// ── O serviço dos planos do CÉREBRO (registrarPlanos), sobre um canal falso: a DM do plano e o resultado saem como pedidos ao bot ──
const relogio = { t: Date.parse('2026-11-27T15:00:00Z') };
const pedidosAoBot = [];
const handlers = new Map();
const canalDoCerebro = {
  isConnected: () => true,
  emit() { return 1; },
  handle: (metodo, fn) => handlers.set(metodo, fn),
  request: async (papel, metodo, params) => { pedidosAoBot.push({ papel, metodo, params }); return { sent: true }; },
};
const envDosPlanos = { ...process.env, YUI_POLICY_MODE: 'enforce' };
const lidas = [];
// A pesquisa fica disponível aqui (sem buscador de verdade: a leitura é falsa) para o teste da correção C1 (plano com pesquisa só se aprova pela DM).
const ferramentas = new Map([...criarFerramentasDePlano({ env: envDosPlanos })].map(([k, f]) => [k, { ...f, ...(k === 'pesquisa' ? { disponivel: () => true } : {}), run: async () => { lidas.push(k); return `saida secreta de ${k} ${SEGREDO}`; } }]));
const PROPOSTA = { passos: [{ ferramenta: 'lembretes', args: {} }, { ferramenta: 'listas', args: { lista: ARG_DO_PLANO } }] };
const planos = registrarPlanos({
  channel: canalDoCerebro, logger: silencioso, env: envDosPlanos, tickMs: 3_600_000,
  opcoes: {
    ferramentas, ehDono: (id) => id === OWNER, now: () => relogio.t,
    engine: createPolicyEngine({ env: envDosPlanos, auditFn: () => {}, readOnly: () => false }),
    propor: async () => JSON.stringify(PROPOSTA),
  },
});
const pedirPlano = async () => (await handlers.get('planos.pedir')({ userId: OWNER, texto: 'monta um plano: ver meus lembretes e a lista' })).text;
const resultadosNaDm = () => pedidosAoBot.filter((p) => p.metodo === 'discord.dm.send').map((p) => p.params.text);
const botaoDaDm = (p) => handlers.get(METODO_DECIDIR)({ userId: OWNER, id: p.id, versao: p.versao, hash: p.hash, aprovar: true });

// ── A live do YouTube contra o YouTube FALSO (127.0.0.1), com o relógio e a agenda na mão ──
const yt = await criarYoutubeFalso();
const VIDEO = 'abcdefghijk';
const LINK = `https://youtube.com/live/${VIDEO}`;
const TOKEN_URL = 'http://127.0.0.1:9/token';
const fetchDaLive = async (url, init) => (String(url) === TOKEN_URL
  ? new Response(JSON.stringify({ access_token: TOKEN_FALSO, expires_in: 3600, token_type: 'Bearer' }), { status: 200, headers: { 'content-type': 'application/json' } })
  : fetch(url, init));
gravarCredencial(ARQ_YT, { client_id: 'cliente-yt-falso.apps', client_secret: YT_SEGREDO, refresh_token: YT_REFRESH, canalId: 'UCcanaldayui000000000001' }, { restringir: () => {} });
let relogioDaLive = Date.parse('2026-11-28T20:00:00Z');
const filaDaLive = [];
const servicoDaLive = criarServicoDaLive({
  env: { ...process.env }, ai: { isolatedChat: async () => 'oi, chat!' }, ehDono: (id) => id === OWNER, logger: silencioso, agora: () => relogioDaLive,
  avisarDono: async () => true, baseUrl: yt.base, tokenUrl: TOKEN_URL, fetchImpl: fetchDaLive,
  agendar: (fn, ms) => { const t = { fn, ms }; filaDaLive.push(t); return t; },
  cancelar: (t) => { const i = filaDaLive.indexOf(t); if (i >= 0) filaDaLive.splice(i, 1); },
});
definirPortaDaLive(servicoDaLive);
const pedidosAoYoutube = () => yt.requisicoes.length;

// ── Os servidores HTTP de verdade ──
const servidores = [];
async function subir(admin) {
  const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servidores.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (method, rota, { token = T_OWNER, corpo, headers = {} } = {}) => {
    const res = await fetch(base + rota, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(corpo ?? {}),
    });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: res.status, texto, json };
  };
}

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. O cofre e a política');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('YUI_PLANOS_PAINEL está no cofre: grupo Conversa, padrão desligado, vale na hora (só a API lê), ligar pede confirmação; só "true" liga', () => {
    const c = cfg.CATALOGO.find((x) => x.chave === 'YUI_PLANOS_PAINEL');
    assert.ok(c, 'a chave existe no catálogo');
    assert.deepEqual([c.grupo, c.tipo, c.padrao, c.reinicio, c.confirmar, Boolean(c.soNaSubida), Boolean(c.secreto)], ['Conversa', 'bool', 'false', false, ['true'], false, false]);
    assert.equal(cfg.exigeConfirmacao('YUI_PLANOS_PAINEL', 'true'), true);
    assert.equal(cfg.exigeConfirmacao('YUI_PLANOS_PAINEL', 'false'), false);
    assert.deepEqual(['true', ' TRUE ', 'false', '1', 'sim', '', undefined].map((v) => planosPeloPainel({ YUI_PLANOS_PAINEL: v })), [true, true, false, false, false, false, false]);
    assert.equal(planosPeloPainel({}), false, 'padrão desligado');
  });

  await test('as rotas de escrita estão no routeGuard com ações próprias (só o dono, no PC e pelo app; sem "modifies", como na DM); as leituras continuam fora', () => {
    assert.equal(actionForRoute('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao'), 'admin.plan_decide');
    assert.equal(actionForRoute('POST', '/v1/admin/planos/qualquer-coisa/decisao'), 'admin.plan_decide', 'o guarda vale até para o id malformado');
    assert.equal(actionForRoute('POST', '/v1/admin/live/entrar'), 'admin.live_control');
    assert.equal(actionForRoute('POST', '/v1/admin/live/sair'), 'admin.live_control');
    for (const [m, p] of [['GET', '/v1/admin/planos'], ['GET', '/v1/admin/live'], ['GET', '/v1/admin/planos/0a0b0c0d0e0f/decisao'], ['POST', '/v1/admin/live/status']]) assert.equal(actionForRoute(m, p), null, `${m} ${p}`);
    for (const acao of ['admin.plan_decide', 'admin.live_control']) {
      const linha = MATRIX.get(acao);
      assert.ok(linha, acao);
      assert.equal(linha.modifies, false, `${acao}: sair da live tem de funcionar sempre`);
      assert.deepEqual(linha.decisions, { OWNER_LOCAL: 'AUTO', OWNER_REMOTE: 'AUTO', OWNER_DM: 'DENY', ADMIN_GUILD: 'DENY', MEMBER: 'DENY' }, acao);
    }
  });

  await test('as ações rodam no processo da API, sem pedido ao bot: fora do PANEL_ACTIONS e da lista do bot', () => {
    for (const a of ACOES) {
      assert.ok(!Object.hasOwn(PANEL_ACTIONS, a), `${a} não vai ao bot`);
      assert.ok(![...BOT_PANEL_ACTIONS].includes(a), `${a} não é aceita pelo bot`);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. Planos pelo painel (o serviço do cérebro de verdade)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const api = await subir(createCerebroAdmin({ channel: canalDoCerebro, planos }));
  const lerPlanos = async () => { const r = await api('GET', '/v1/admin/planos'); assert.equal(r.status, 200, r.texto); return r.json; };
  const decidir = (p, extra = {}, opcoes = {}) => api('POST', `/v1/admin/planos/${p.id}/decisao`, { corpo: { versao: p.versao, hash: p.hash, aprovar: true, ...extra }, ...opcoes });
  const estadoNoDisco = (id) => JSON.parse(fs.readFileSync(arquivoDosPlanos(process.env), 'utf8')).planos.find((x) => x.id === id)?.estado;

  assert.equal(await pedirPlano(), 'Montei o plano e mandei aqui com os botões. Só começo se você aprovar.');
  let vista = await lerPlanos();
  let plano = vista.planos[0];

  await test('o GET mostra o plano aguardando com o que a decisão pede (id, versão, prefixo do hash) e "painel: true"; nada de argumentos', () => {
    assert.deepEqual([vista.ligado, vista.painel, plano.estado, plano.versao, plano.hash.length], [true, true, 'aguardando', 1, 16]);
    semConteudo(vista, 'GET planos');
  });

  await test('chave desligada: a decisão responde 404, o GET diz "painel: false" e o plano continua aguardando', async () => {
    process.env.YUI_PLANOS_PAINEL = 'false';
    try {
      const r = await decidir(plano);
      assert.equal(r.status, 404, r.texto);
      assert.match(r.json.error, /desligado/);
      assert.equal((await lerPlanos()).painel, false);
      process.env.YUI_PLANOS_PAINEL = 'true';
      process.env.YUI_PLANOS = 'false';
      assert.equal((await lerPlanos()).painel, false, 'sem os planos ligados, os botões também não valem');
    } finally {
      process.env.YUI_PLANOS_PAINEL = 'true';
      process.env.YUI_PLANOS = 'true';
    }
    assert.equal(estadoNoDisco(plano.id), 'aguardando');
  });

  await test('quem não é o dono: 403 sem decidir; sem token: 401', async () => {
    const r = await decidir(plano, {}, { token: T_MEMBER });
    assert.equal(r.status, 403, r.texto);
    assert.deepEqual(Object.keys(r.json), ['error'], 'o membro não recebe nada além do erro');
    assert.equal((await decidir(plano, {}, { token: null })).status, 401);
    await assert.rejects(createCerebroAdmin({ channel: canalDoCerebro, planos }).decidirPlano({ role: 'MEMBER', userId: MEMBER, platform: 'api' }, plano.id, { versao: 1, hash: plano.hash, aprovar: true }), (e) => e.status === 403);
    assert.equal(estadoNoDisco(plano.id), 'aguardando');
    assert.deepEqual(lidas, []);
  });

  await test('hash ou versão errados recusam pela decidir() (o plano segue aguardando); corpo fora do formato: 400 sem chegar nela', async () => {
    const hashErrado = await decidir(plano, { hash: '0'.repeat(16) });
    assert.equal(hashErrado.status, 200, hashErrado.texto);
    assert.deepEqual(hashErrado.json, { ok: false, final: true, texto: 'Esse plano não vale mais.' });
    assert.deepEqual((await decidir(plano, { versao: 2 })).json, { ok: false, final: true, texto: 'Esse plano não vale mais.' });
    for (const [corpo, campo] of [[{ hash: 'curto' }, 'hash'], [{ hash: `${plano.hash}`.toUpperCase() + 'Z' }, 'hash'], [{ versao: 'x' }, 'versão'], [{ versao: 0 }, 'versão'], [{ aprovar: 'sim' }, 'aprovar'], [{ aprovar: undefined }, 'aprovar']]) {
      const r = await decidir(plano, corpo);
      assert.equal(r.status, 400, `${JSON.stringify(corpo)}: ${r.texto}`);
    }
    assert.equal((await api('POST', '/v1/admin/planos/NAO-HEX/decisao', { corpo: { versao: 1, hash: plano.hash, aprovar: true } })).status, 404, 'id fora do formato: a rota não existe');
    assert.equal(estadoNoDisco(plano.id), 'aguardando');
    assert.deepEqual(lidas, []);
  });

  await test('aprovar pelo painel: executa uma vez, o resultado vai só pela DM, a resposta só tem a frase; depois a DM responde "já foi respondido"', async () => {
    const r = await decidir(plano);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, final: true, texto: 'Aprovado. Aviso aqui quando terminar.' });
    await planos.ocioso();
    assert.deepEqual(lidas, ['lembretes', 'listas']);
    assert.equal(resultadosNaDm().length, 1);
    assert.match(resultadosNaDm()[0], /Plano concluído[\s\S]*saida secreta de listas/, 'o resultado saiu pela DM, como sempre');
    semConteudo(r.texto, 'resposta da aprovação');
    const dm = await botaoDaDm(plano);
    assert.deepEqual([dm.ok, dm.text], [false, 'Esse plano já foi respondido ou não vale mais.']);
    assert.equal(estadoNoDisco(plano.id), 'concluido');
    assert.deepEqual(lidas, ['lembretes', 'listas'], 'nada repetido');
    const depois = (await lerPlanos()).planos.find((x) => x.id === plano.id);
    assert.deepEqual([depois.estado, depois.aprovacao], ['concluido', 'dono']);
    // a auditoria: o MESMO evento da DM, com a origem "painel", sem conteúdo
    const aprovados = eventos('plan.approved');
    assert.equal(aprovados.length, 1);
    assert.deepEqual([aprovados[0].planId, aprovados[0].origem, aprovados[0].userId], [plano.id, 'painel', OWNER]);
    semConteudo(auditoria(), 'auditoria');
  });

  await test('recusar pelo painel: nada é executado, plan.rejected com a origem "painel", e a DM depois responde "já foi respondido"', async () => {
    await pedirPlano();
    const p = (await lerPlanos()).planos.find((x) => x.estado === 'aguardando');
    const r = await decidir(p, { aprovar: false });
    assert.deepEqual(r.json, { ok: true, final: true, texto: 'Plano recusado. Nada foi feito.' });
    await planos.ocioso();
    assert.deepEqual(lidas, ['lembretes', 'listas'], 'nada novo foi lido');
    assert.equal(estadoNoDisco(p.id), 'recusado');
    assert.equal((await botaoDaDm(p)).text, 'Esse plano já foi respondido ou não vale mais.');
    assert.deepEqual(eventos('plan.rejected').map((e) => [e.planId, e.origem]), [[p.id, 'painel']]);
  });

  let idDaPesquisaC1 = null; // o plano com pesquisa da correção C1 (aprovado pela DM): os testes seguintes não o contam
  await test('correção C1: o GET traz o resumo seguro de cada passo (o nome da lista só como tamanho, nada de argumento); sem texto para fora, o painel aprova', async () => {
    const v = await lerPlanos();
    const p = v.planos.find((x) => x.id === plano.id);
    assert.deepEqual(p.passos.map((s) => s.resumo.acao), ['Ler os seus lembretes', 'Ler uma das suas listas']);
    assert.deepEqual(p.passos.map((s) => [s.resumo.servico, s.resumo.acesso, s.resumo.saida]), [['Lembretes', 'leitura', 'nao'], ['Listas', 'leitura', 'nao']]);
    assert.deepEqual(p.passos[1].resumo.textoLivre, [{ campo: 'nome da lista', caracteres: ARG_DO_PLANO.length }]);
    assert.equal(p.aprovarSoPelaDm, false, 'foi aprovado pelo painel no teste acima');
    semConteudo(v, 'GET planos com o resumo');
  });

  await test('correção C1: plano com pesquisa na web: aprovar pelo painel = 409 e ele segue aguardando, sem executar; recusar pelo painel vale; a DM ainda aprova', async () => {
    const CONSULTA = `festival de cinema ${SEGREDO}`;
    const original = PROPOSTA.passos;
    const lidasNoComeco = lidas.length; // os testes seguintes conferem a lista exata: o que este teste ler sai no fim
    PROPOSTA.passos = [{ ferramenta: 'lembretes', args: {} }, { ferramenta: 'pesquisa', args: { consulta: CONSULTA } }];
    try {
      assert.equal(await pedirPlano(), 'Montei o plano e mandei aqui com os botões. Só começo se você aprovar.');
      const vistaComPesquisa = await lerPlanos();
      const p = vistaComPesquisa.planos.find((x) => x.estado === 'aguardando');
      idDaPesquisaC1 = p.id;
      assert.equal(p.aprovarSoPelaDm, true);
      assert.deepEqual([p.passos[1].resumo.acao, p.passos[1].resumo.saida, p.passos[1].resumo.soPelaDm], ['Pesquisar na web (as palavras saem para o buscador)', 'internet', true]);
      assert.deepEqual(p.passos[1].resumo.textoLivre, [{ campo: 'texto da pesquisa', caracteres: CONSULTA.length }]);
      semConteudo(vistaComPesquisa, 'GET com a pesquisa');
      const lidasAntes = [...lidas];
      const r = await decidir(p);
      assert.equal(r.status, 409, r.texto);
      assert.match(r.json.error, /aprove pela DM/);
      semConteudo(r.texto, 'resposta do 409');
      await planos.ocioso();
      assert.equal(estadoNoDisco(p.id), 'aguardando', 'o plano segue aguardando');
      assert.deepEqual(lidas, lidasAntes, 'nada foi executado');
      assert.deepEqual(eventos('plan.panel_blocked').map((e) => [e.planId, e.motivo]).at(-1), [p.id, 'so-pela-dm']);
      // a DM aprova (lá o texto aparece)
      const dm = await botaoDaDm(p);
      assert.deepEqual([dm.ok, dm.text], [true, 'Aprovado. Aviso aqui quando terminar.']);
      await planos.ocioso();
      assert.deepEqual(lidas.slice(lidasAntes.length), ['lembretes', 'pesquisa']);
      // outro plano com pesquisa: recusar pelo painel vale
      await pedirPlano();
      const q = (await lerPlanos()).planos.find((x) => x.estado === 'aguardando');
      assert.deepEqual((await decidir(q, { aprovar: false })).json, { ok: true, final: true, texto: 'Plano recusado. Nada foi feito.' });
      assert.equal(estadoNoDisco(q.id), 'recusado');
      semConteudo(auditoria(), 'auditoria');
    } finally {
      PROPOSTA.passos = original;
      lidas.splice(lidasNoComeco);
    }
  });

  await test('vencido (passou dos 30 minutos): recusa, o plano expira e nada é executado', async () => {
    await pedirPlano();
    const p = (await lerPlanos()).planos.find((x) => x.estado === 'aguardando');
    relogio.t += VALIDADE_MS + 1;
    const r = await decidir(p);
    assert.deepEqual(r.json, { ok: false, final: true, texto: 'A aprovação desse plano expirou. Peça de novo.' });
    assert.equal(estadoNoDisco(p.id), 'expirado');
    assert.deepEqual(lidas, ['lembretes', 'listas']);
  });

  await test('dois pedidos seguidos (painel e painel, ou painel e DM): só um vale e o plano roda uma vez', async () => {
    await pedirPlano();
    const p = (await lerPlanos()).planos.find((x) => x.estado === 'aguardando');
    const [a, b] = await Promise.all([decidir(p), decidir(p)]);
    assert.deepEqual([a.json.ok, b.json.ok].sort(), [false, true]);
    assert.equal([a, b].find((x) => !x.json.ok).json.texto, 'Esse plano já foi respondido ou não vale mais.');
    await planos.ocioso();
    assert.deepEqual(lidas, ['lembretes', 'listas', 'lembretes', 'listas'], 'executou uma vez só');
    // a DM decide primeiro e o painel chega depois
    await pedirPlano();
    const q = (await lerPlanos()).planos.find((x) => x.estado === 'aguardando');
    assert.equal((await botaoDaDm(q)).ok, true);
    assert.deepEqual((await decidir(q)).json, { ok: false, final: true, texto: 'Esse plano já foi respondido ou não vale mais.' });
    await planos.ocioso();
    assert.equal(lidas.length, 6);
    // (sem o plano com pesquisa da correção C1, aprovado pela DM no teste dele)
    assert.deepEqual(eventos('plan.approved').filter((e) => e.planId !== idDaPesquisaC1).map((e) => e.origem ?? 'dm'), ['painel', 'painel', 'dm'], 'a DM continua sem origem, como antes');
  });

  await test('limite de repetição: 20 decisões por minuto (só as que chegariam à decidir()); a 21ª recebe 429 sem chegar nela', async () => {
    assert.deepEqual(LIMITE_DAS_DECISOES, { max: 20, janelaMs: 60_000 });
    const outra = await subir(createCerebroAdmin({ channel: canalDoCerebro, planos }));
    const corpo = { versao: 1, hash: 'ab'.repeat(8), aprovar: true };
    for (let i = 0; i < 5; i += 1) assert.equal((await outra('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao', { corpo: { ...corpo, hash: 'x' } })).status, 400, 'fora do formato não conta');
    for (let i = 0; i < 20; i += 1) assert.equal((await outra('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao', { corpo })).json?.texto, 'Esse plano não vale mais.', `pedido ${i + 1}`);
    const r = await outra('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao', { corpo });
    assert.equal(r.status, 429, r.texto);
  });

  await test('em enforce: o membro é barrado pela política (403 com a ação) antes da decidir(); o dono pelo app passa', async () => {
    try {
      process.env.YUI_POLICY_MODE = 'enforce';
      const membro = await api('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao', { token: T_MEMBER, corpo: { versao: 1, hash: 'ab'.repeat(8), aprovar: true } });
      assert.equal(membro.status, 403);
      assert.equal(membro.json.policy.action, 'admin.plan_decide');
      const app = await api('POST', '/v1/admin/planos/0a0b0c0d0e0f/decisao', { corpo: { versao: 1, hash: 'ab'.repeat(8), aprovar: true }, headers: { 'x-forwarded-for': '100.64.0.9' } });
      assert.equal(app.status, 200, app.texto);
    } finally { process.env.YUI_POLICY_MODE = 'observe'; }
  });

  await test('planos desligados ou fora do processo: 409 / 503 claros, nunca um atalho', async () => {
    const semServico = createAdmin({ deps: { integrationData: async () => ({}) } });
    definirPortaDePlanos(null);
    await assert.rejects(semServico.decidirPlano(ctxDono, '0a0b0c0d0e0f', { versao: 1, hash: 'ab'.repeat(8), aprovar: true }), (e) => e.status === 503);
    process.env.YUI_PLANOS = 'false';
    try {
      await assert.rejects(semServico.decidirPlano(ctxDono, '0a0b0c0d0e0f', { versao: 1, hash: 'ab'.repeat(8), aprovar: true }), (e) => e.status === 409 && /desligados/.test(e.message));
    } finally { process.env.YUI_PLANOS = 'true'; }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. Live pelo painel (o mesmo comando da conversa, contra o YouTube falso)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  yt.definirVideo(VIDEO, { titulo: 'Live de teste da Yui', liveChatId: 'CHAT-FALSO' });
  const lerLive = async () => (await api('GET', '/v1/admin/live')).json;

  await test('entrar com a duração: a frase do serviço, o ritmo pela duração (8 h = 30 s), a saudação no chat e a cota contada; auditoria sem o link', async () => {
    const antes = pedidosAoYoutube();
    const r = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK, horas: 8 } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(ritmoDaLive(8).segundos, 30);
    assert.match(r.json.texto, /^Entrei no chat da live "Live de teste da Yui"\. .*Leio o chat a cada 30 s, o que dá para cerca de 9 h\. Para parar: "sai da live"\.$/);
    const novos = yt.requisicoes.slice(antes);
    assert.deepEqual(novos.map((q) => `${q.metodo} ${q.caminho.split('/').pop()}`), ['GET videos', 'POST messages'], 'achou a live e mandou a saudação');
    assert.equal(novos[0].consulta.id, VIDEO);
    assert.ok(novos.every((q) => q.autorizado), 'com a autorização do canal da Yui');
    const v = await lerLive();
    assert.deepEqual([v.ativo, v.estado, v.live.videoId], [true, 'ouvindo', VIDEO]);
    assert.ok(v.cota.usado > 0, 'a cota do dia contou a entrada');
    assert.equal(filaDaLive.length, 1, 'o laço de leitura ficou agendado');
    const ev = eventos('admin.live.enter');
    assert.deepEqual(ev.map((e) => [e.origem, e.horas, e.ok]), [['painel', 8, true]]);
    assert.ok(!JSON.stringify(ev).includes(VIDEO) && !JSON.stringify(ev).includes('youtube.com'), 'a auditoria não leva o link');
    semConteudo(r.texto, 'resposta de entrar');
  });

  await test('já numa live: a mesma recusa do serviço, sem tocar no YouTube', async () => {
    const antes = pedidosAoYoutube();
    const r = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK } });
    assert.deepEqual([r.status, r.json.ok, r.json.texto], [200, false, 'Já estou numa live. Mande "sai da live" antes.']);
    assert.equal(pedidosAoYoutube(), antes);
  });

  await test('sair: a mesma saída da conversa, com confirmação na tela (o servidor não exige), auditoria; sair de novo diz que não está em live', async () => {
    const r = await api('POST', '/v1/admin/live/sair');
    assert.deepEqual([r.status, r.json.ok, r.json.texto], [200, true, 'Saí da live.']);
    assert.equal((await lerLive()).ativo, false);
    assert.equal(filaDaLive.length, 0, 'o laço parou');
    const outra = await api('POST', '/v1/admin/live/sair');
    assert.deepEqual([outra.json.ok, outra.json.texto], [false, 'Não estou em nenhuma live.']);
    assert.deepEqual(eventos('admin.live.leave').map((e) => [e.origem, e.ok]), [['painel', true], ['painel', false]]);
  });

  await test('o mesmo texto que a conversa daria: entrar pela DM com os mesmos dados devolve a mesma frase (sem duração = 15 s)', async () => {
    const painel = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: `youtube.com/live/${VIDEO}` } });
    assert.equal(painel.json.ok, true, painel.texto);
    await api('POST', '/v1/admin/live/sair');
    const conversa = await servicoDaLive.rotear({ userId: OWNER, texto: `entra na live youtube.com/live/${VIDEO}`, canal: 'discord_dm' });
    assert.equal(painel.json.texto, conversa.text);
    assert.match(conversa.text, /a cada 15 s/);
    assert.equal((await servicoDaLive.rotear({ userId: OWNER, texto: 'sai da live', canal: 'discord_dm' })).text, 'Saí da live.');
  });

  await test('sem a autorização do canal da Yui: a mesma recusa do serviço, sem tocar no YouTube', async () => {
    const guardado = `${ARQ_YT}.guardado`;
    fs.renameSync(ARQ_YT, guardado);
    try {
      const antes = pedidosAoYoutube();
      const r = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK } });
      assert.deepEqual([r.json.ok, r.json.texto], [false, 'Falta a autorização do canal. Rode scripts/youtube-autorizar.mjs (veja docs/GUIA_YOUTUBE_LIVE.md).']);
      assert.equal(pedidosAoYoutube(), antes);
    } finally { fs.renameSync(guardado, ARQ_YT); }
  });

  await test('link inválido recusado: fora do formato = 400 sem chegar no serviço; de outro site = a recusa do serviço; nada vai ao YouTube', async () => {
    const antes = pedidosAoYoutube();
    for (const corpo of [{ endereco: '' }, {}, { endereco: 'não é link' }, { endereco: 'https://youtu.be/x y' }, { endereco: 'qualquer-coisa' }, { endereco: `https://youtu.be/${VIDEO}<script>` }, { endereco: 'x'.repeat(301) }, { endereco: 42 }]) {
      const r = await api('POST', '/v1/admin/live/entrar', { corpo });
      assert.equal(r.status, 400, `${JSON.stringify(corpo).slice(0, 60)}: ${r.texto}`);
      assert.equal(r.json.error, 'Esse link não parece de uma live do YouTube.');
    }
    for (const horas of [0, 100, 2.5, 'oito', -1]) {
      const r = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK, horas } });
      assert.equal(r.status, 400, `horas ${horas}: ${r.texto}`);
    }
    const outroSite = await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: `https://example.com/live/${VIDEO}` } });
    assert.deepEqual([outroSite.status, outroSite.json.ok, outroSite.json.texto], [200, false, 'Só aceito link do youtube.com ou youtu.be.']);
    assert.equal(pedidosAoYoutube(), antes);
    assert.equal((await lerLive()).ativo, false);
  });

  await test('quem não é o dono: 403 nas duas, sem tocar no YouTube; sem token: 401', async () => {
    const antes = pedidosAoYoutube();
    assert.equal((await api('POST', '/v1/admin/live/entrar', { token: T_MEMBER, corpo: { endereco: LINK } })).status, 403);
    assert.equal((await api('POST', '/v1/admin/live/sair', { token: T_MEMBER })).status, 403);
    assert.equal((await api('POST', '/v1/admin/live/entrar', { token: null, corpo: { endereco: LINK } })).status, 401);
    assert.equal(pedidosAoYoutube(), antes);
    assert.equal((await lerLive()).ativo, false);
  });

  await test('chave desligada (YUI_YOUTUBE_LIVE): 404 claro nas duas, sem tocar no serviço nem no YouTube', async () => {
    process.env.YUI_YOUTUBE_LIVE = 'false';
    try {
      const antes = pedidosAoYoutube();
      for (const rota of ['/v1/admin/live/entrar', '/v1/admin/live/sair']) {
        const r = await api('POST', rota, { corpo: { endereco: LINK } });
        assert.equal(r.status, 404, `${rota}: ${r.texto}`);
        assert.match(r.json.error, /live do YouTube está desligada/);
      }
      assert.equal(pedidosAoYoutube(), antes);
    } finally { process.env.YUI_YOUTUBE_LIVE = 'true'; }
  });

  await test('serviço fora deste processo (porta vazia): 503; limite de 10 entradas por minuto (429), e sair nunca é barrado pelo limite', async () => {
    definirPortaDaLive(null);
    try {
      assert.equal((await api('POST', '/v1/admin/live/sair')).status, 503);
      assert.equal((await api('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK } })).status, 503);
    } finally { definirPortaDaLive(servicoDaLive); }
    assert.deepEqual(LIMITE_DAS_ENTRADAS, { max: 10, janelaMs: 60_000 });
    const outra = await subir(createAdmin({ deps: { integrationData: async () => ({}) } }));
    const antes = pedidosAoYoutube();
    for (let i = 0; i < 5; i += 1) assert.equal((await outra('POST', '/v1/admin/live/entrar', { corpo: { endereco: '' } })).status, 400, 'fora do formato não conta');
    for (let i = 0; i < 10; i += 1) assert.equal((await outra('POST', '/v1/admin/live/entrar', { corpo: { endereco: `https://example.com/live/${VIDEO}` } })).json?.ok, false, `entrar ${i + 1}`);
    assert.equal((await outra('POST', '/v1/admin/live/entrar', { corpo: { endereco: LINK } })).status, 429);
    assert.equal(pedidosAoYoutube(), antes, 'nada foi ao YouTube');
    for (let i = 0; i < 12; i += 1) assert.equal((await outra('POST', '/v1/admin/live/sair')).status, 200, `sair ${i + 1}`);
  });

  await test('em enforce e somente leitura: o dono ainda sai da live (ação sem "modifies"); o membro é barrado pela política', async () => {
    try {
      process.env.YUI_POLICY_MODE = 'enforce';
      process.env.YUI_READ_ONLY = 'true';
      const dono = await api('POST', '/v1/admin/live/sair', { headers: { 'x-forwarded-for': '100.64.0.9' } });
      assert.equal(dono.status, 200, dono.texto);
      const membro = await api('POST', '/v1/admin/live/sair', { token: T_MEMBER });
      assert.equal(membro.status, 403);
      assert.equal(membro.json.policy.action, 'admin.live_control');
    } finally {
      process.env.YUI_POLICY_MODE = 'observe';
      process.env.YUI_READ_ONLY = 'false';
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. Processo único, cérebro e bot separado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('processo único: sem o serviço passado, o admin usa a porta dos planos (que É o serviço) e a porta da live', async () => {
    definirPortaDePlanos(planos);
    try {
      const unico = await subir(createAdmin({ deps: { integrationData: async () => ({}) } }));
      await pedirPlano();
      const p = (await unico('GET', '/v1/admin/planos')).json.planos.find((x) => x.estado === 'aguardando');
      const r = await unico('POST', `/v1/admin/planos/${p.id}/decisao`, { corpo: { versao: p.versao, hash: p.hash, aprovar: false } });
      assert.deepEqual(r.json, { ok: true, final: true, texto: 'Plano recusado. Nada foi feito.' });
      const live = await unico('POST', '/v1/admin/live/sair');
      assert.deepEqual([live.status, live.json.texto], [200, 'Não estou em nenhuma live.']);
    } finally { definirPortaDePlanos(null); }
  });

  await test('cérebro: decidir, entrar e sair rodam ali mesmo, sem nenhum pedido ao bot; o membro é barrado antes', async () => {
    const pedidos = [];
    const canal = { isConnected: () => true, emit() {}, request: async (...a) => { pedidos.push(a); return {}; } };
    const a = createCerebroAdmin({ channel: canal, planos });
    assert.deepEqual(await a.decidirPlano(ctxDono, '0a0b0c0d0e0f', { versao: 1, hash: 'ab'.repeat(8), aprovar: true }), { ok: false, final: true, texto: 'Esse plano não vale mais.' });
    assert.equal((await a.sairDaLive(ctxDono)).texto, 'Não estou em nenhuma live.');
    assert.equal((await a.entrarNaLive(ctxDono, { endereco: `https://example.com/live/${VIDEO}` })).texto, 'Só aceito link do youtube.com ou youtu.be.');
    for (const m of ACOES) await assert.rejects(a[m]({ role: 'MEMBER', userId: MEMBER, platform: 'api' }, '0a0b0c0d0e0f', {}), (e) => e.status === 403, m);
    assert.deepEqual(pedidos, [], 'nada foi ao bot');
  });

  await test('bot separado: nunca usa a porta dele (o pedido ao cérebro pelo canal), e o canal do bot recusa as ações novas', async () => {
    const pelaPorta = [];
    definirPortaDePlanos({ decidir: async (p) => { pelaPorta.push(p); return { ok: true, final: true, text: 'não devia' }; } });
    try {
      const doBot = createAdmin({ processo: 'bot', deps: { integrationData: async () => ({}) } });
      await assert.rejects(doBot.decidirPlano(ctxDono, '0a0b0c0d0e0f', { versao: 1, hash: 'ab'.repeat(8), aprovar: true }), (e) => e.status === 503);
      await assert.rejects(doBot.sairDaLive(ctxDono), (e) => e.status === 503);
      assert.deepEqual(pelaPorta, []);
      const hs = new Map();
      registerBotActions({ handle: (m, fn) => hs.set(m, fn) }, { getClient: () => null, admin: doBot });
      for (const action of ACOES) await assert.rejects(hs.get('panel.admin')({ userId: OWNER, action, args: [] }, { role: 'cerebro' }), (e) => e.code === 'METHOD_NOT_ALLOWED', action);
    } finally { definirPortaDePlanos(null); }
  });
} finally {
  for (const s of servidores) { s.close(); s.closeAllConnections?.(); }
  planos.parar?.();
  servicoDaLive.parar();
  await yt.close();
  process.chdir(repoRoot);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows às vezes segura o arquivo */ }
}

say(`\n${passed} ok, ${failures.length} falha(s)`);
if (failures.length) {
  for (const f of failures) say(`  - ${f}`);
  process.exit(1);
}
