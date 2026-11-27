// Lacunas do painel, ENTREGA F, parte 2 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md item 14; docs/DESENHO_PAINEL_APROVACAO_E_GOOGLE.md seção 2): REAUTORIZAR O
// GOOGLE PELO PAINEL, só do dono, com YUI_GOOGLE_REAUTORIZAR_PAINEL.
//   POST /v1/admin/google/autorizar/inicio    só com um arquivo de autorização que já existe: devolve SÓ o link de consentimento (PKCE S256, `state`, retorno fixo
//                                             em http://127.0.0.1:47615, só Agenda e Tarefas; nunca o Gmail)
//   POST /v1/admin/google/autorizar/retorno   { endereco } colado: sessão de uso único (apagada na primeira tentativa), confere host/porta/caminho, `state` e
//                                             validade, troca o código com o verificador, confere os escopos e grava o arquivo (atômico, permissão restrita)
// A. O cofre, a política (routeGuard e matriz), fora do PANEL_ACTIONS e o módulo compartilhado com o script.
// B. O fluxo completo contra o Google FALSO (tests/helpers/googleFalso.js, que confere o PKCE de verdade): o link, a troca, o arquivo novo, o auth.js voltando
//    a renovar com ele depois de o Google ter recusado o antigo, a auditoria e a segunda tentativa recusada.
// C. As falhas: state errado, endereço de outra porta/host/protocolo/caminho, sessão vencida, uso único, Google negou, sem refresh, escopos, Gmail nunca pedido
//    nem gravado, sem arquivo, arquivo que mudou, gravação que falhou, rede, chave desligada (404), não dono (403), limite (429), enforce e somente leitura,
//    o bot separado (503) e o cérebro (nada vai ao bot).
// D. Nada de segredo (token, client_secret, código, verificador, `state` fora do link, corpo do Google) nas respostas, na auditoria nem nos logs.
// Num processo só, pasta temporária, sem .env, sem rede de fora. Execução: npm run test:painelgoogle
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarGoogleFalso, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, SEGREDO_PLANTADO } from './helpers/googleFalso.js';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-google-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const ARQ = path.join(tmp, 'secrets', 'google-token.json');
const AUDIT = path.join(tmp, 'audit.jsonl');
const LOGS = path.join(tmp, 'logs');
const VAZIO = path.join(tmp, 'vazio.env');
fs.writeFileSync(VAZIO, '');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error',
  YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_READ_ONLY: 'false', YUI_LOG_DIR: LOGS, YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
  YUI_GOOGLE: 'true', YUI_GOOGLE_TOKEN_ARQUIVO: ARQ, YUI_GOOGLE_REAUTORIZAR_PAINEL: 'true', DOTENV_CONFIG_PATH: VAZIO,
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_API_TOKENS', 'YUI_PAINEL_CONFIG_FILE', 'YUI_IA_PERFIS', 'YUI_IA_PERFIL_PRIVADO', 'YUI_GOOGLE_GMAIL']) delete process.env[k];
fs.mkdirSync(process.env.DATABASE_DIR, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais (os imports abaixo vêm DEPOIS disto)

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const cfg = await imp('src/core/painelConfig.js');
const E = await imp('src/integrations/google/endpoints.js');
const arq = await imp('src/integrations/google/arquivoToken.js');
const { reautorizacaoPeloPainelLigada } = await imp('src/integrations/google/config.js');
const C = await imp('src/integrations/google/consentimento.js');
const R = await imp('src/integrations/google/reautorizar.js');
const { criarAutenticador } = await imp('src/integrations/google/auth.js');
const { reiniciarGoogleParaTeste } = await imp('src/integrations/google/index.js');
const script = await imp('scripts/google-autorizar.mjs');
const { MATRIX } = await imp('src/core/security/permissionMatrix.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { createAdmin } = await imp('src/core/api/admin.js');
// A chave de confirmação pela DM (correção C2) tem a suíte dela, de ponta a ponta (test:painelconfirmacao). Aqui o assunto é o fluxo do Google: um substituto
// aceita a chave, e o resto da regra continua o de verdade.
(await imp('src/core/api/confirmacao.js')).definirConfirmacoesParaTestes({ emitir: () => ({ codigo: '000-000', expiraEmSegundos: 300, revogar() {} }), conferir: () => true, esquecerSessao: () => 0, tamanho: () => 0 });
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
const silencioso = { info() {}, warn() {}, error() {}, debug() {} };
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
const ACOES = ['googleReautorizarInicio', 'googleReautorizarRetorno'];
const auditoria = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eventos = (nome) => auditoria().filter((e) => e.event === nome);

// ── O Google FALSO em 127.0.0.1 (confere o PKCE de verdade) e os endereços trocados por ele (só com NODE_ENV=test) ──
const fake = await criarGoogleFalso();
E.definirHostsParaTeste(E.hostsDeBaseLocal(fake.base));
const pedidosDeToken = () => fake.pedidosDe('/token');
const trocas = () => pedidosDeToken().filter((p) => p.campos.grant_type === 'authorization_code');

// Tudo o que é segredo e aparece no teste (a troca registra o código e o verificador; o link, o `state`): nada disso pode sair numa resposta, na auditoria ou no log.
const segredos = new Set([CLIENT_SECRET, REFRESH_TOKEN, SEGREDO_PLANTADO, 'ya29.']);
const respostas = [];
function semSegredo(texto, rotulo, { permitirNoLink = false } = {}) {
  const t = typeof texto === 'string' ? texto : JSON.stringify(texto);
  for (const p of pedidosDeToken()) for (const v of [p.campos.code, p.campos.code_verifier, p.campos.refresh_token]) if (v) segredos.add(v);
  for (const s of segredos) assert.ok(!t.includes(s), `${rotulo} vazou: ${String(s).slice(0, 24)}`);
  if (!permitirNoLink) assert.ok(!/[?&](code|state)=/.test(t), `${rotulo} tem um código ou um state`);
}

// O arquivo de autorização do teste (o "feito pelo script"): restringir é um dublê que registra (a permissão restrita de verdade é conferida em test:googleautorizar).
const restringidos = [];
const restringir = (f) => { restringidos.push(f); };
function gravarArquivoInicial({ escopos = [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], clientId = CLIENT_ID, refresh = REFRESH_TOKEN } = {}) {
  arq.gravarArquivoDeToken(ARQ, { client_id: clientId, client_secret: CLIENT_SECRET, refresh_token: refresh, escopos, criadoEm: '2026-11-20T10:00:00.000Z' }, { restringir: () => {} });
}
const bytesDoArquivo = () => (fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf8') : null);
function resetaFalso() {
  Object.assign(fake.estado, { modoToken: 'ok', consentimento: 'ok', escoposDoCodigo: null, semRefreshNaTroca: false, refreshNaTroca: null });
}

// ── Os servidores HTTP de verdade ──
const relogio = { t: Date.parse('2026-11-27T15:00:00Z') };
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
    respostas.push({ rota, texto });
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: res.status, texto, json };
  };
}
const novoAdmin = (extra = {}) => createAdmin({ deps: { integrationData: async () => ({}), googleReautorizar: { agora: () => relogio.t, restringir, ...extra } } });

/** O papel do navegador: abre o link no Google falso (sem seguir o redirecionamento) e devolve o endereço para onde ele mandaria (a página 127.0.0.1 que não abre). */
async function navegador(link) {
  const r = await fetch(link, { redirect: 'manual' });
  assert.equal(r.status, 302, `o Google falso recusou o link (${r.status}): ${await r.text()}`);
  return r.headers.get('location');
}
/** Começa (15 min depois do último início: o limite de 5 por hora não atrapalha) e já devolve o endereço que o dono colaria. */
async function comecar(api, opcoes = {}) {
  relogio.t += 15 * 60_000;
  const r = await api('POST', '/v1/admin/google/autorizar/inicio', opcoes);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.ok, true, r.texto);
  return { inicio: r.json, colado: await navegador(r.json.link) };
}
const retorno = (api, endereco, opcoes = {}) => api('POST', '/v1/admin/google/autorizar/retorno', { corpo: { endereco }, ...opcoes });

try {
  gravarArquivoInicial();
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. O cofre, a política e o módulo compartilhado com o script');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('YUI_GOOGLE_REAUTORIZAR_PAINEL está no cofre: grupo Geral, padrão desligado, vale na hora (só a API lê), ligar pede confirmação; só "true" liga', () => {
    const c = cfg.CATALOGO.find((x) => x.chave === 'YUI_GOOGLE_REAUTORIZAR_PAINEL');
    assert.ok(c, 'a chave existe no catálogo');
    assert.deepEqual([c.grupo, c.tipo, c.padrao, c.reinicio, c.confirmar, Boolean(c.soNaSubida), Boolean(c.secreto)], ['Geral', 'bool', 'false', false, ['true'], false, false]);
    assert.match(c.descricao, /Gmail continua só pelo script/);
    assert.equal(cfg.exigeConfirmacao('YUI_GOOGLE_REAUTORIZAR_PAINEL', 'true'), true);
    assert.equal(cfg.exigeConfirmacao('YUI_GOOGLE_REAUTORIZAR_PAINEL', 'false'), false);
    assert.deepEqual(['true', ' TRUE ', 'false', '1', 'sim', '', undefined].map((v) => reautorizacaoPeloPainelLigada({ YUI_GOOGLE_REAUTORIZAR_PAINEL: v })), [true, true, false, false, false, false, false]);
    assert.equal(reautorizacaoPeloPainelLigada({}), false, 'padrão desligado');
  });

  await test('as duas rotas estão no routeGuard como admin.google_reauth (só o dono, no PC e pelo app; ASK e "modifies": grava credencial); a leitura continua fora', () => {
    assert.equal(actionForRoute('POST', '/v1/admin/google/autorizar/inicio'), 'admin.google_reauth');
    assert.equal(actionForRoute('POST', '/v1/admin/google/autorizar/retorno'), 'admin.google_reauth');
    for (const [m, p] of [['GET', '/v1/admin/google'], ['GET', '/v1/admin/google/autorizar/inicio'], ['POST', '/v1/admin/google/autorizar/outra']]) assert.equal(actionForRoute(m, p), null, `${m} ${p}`);
    const linha = MATRIX.get('admin.google_reauth');
    assert.ok(linha);
    assert.equal(linha.modifies, true);
    assert.deepEqual(linha.decisions, { OWNER_LOCAL: 'ASK', OWNER_REMOTE: 'ASK', OWNER_DM: 'DENY', ADMIN_GUILD: 'DENY', MEMBER: 'DENY' });
  });

  await test('o Google vive no processo da API: as ações ficam fora do PANEL_ACTIONS e da lista do bot', () => {
    for (const a of ACOES) {
      assert.ok(!Object.hasOwn(PANEL_ACTIONS, a), `${a} não vai ao bot`);
      assert.ok(![...BOT_PANEL_ACTIONS].includes(a), `${a} não é aceita pelo bot`);
    }
  });

  await test('o link de consentimento e o PKCE são do módulo compartilhado: o script reexporta as MESMAS funções (o comportamento dele não muda)', () => {
    assert.equal(script.montarUrlDeConsentimento, C.montarUrlDeConsentimento);
    assert.equal(script.criarPkce, C.criarPkce);
    const p = C.criarPkce();
    assert.equal(p.desafio, crypto.createHash('sha256').update(p.verificador).digest('base64url'));
    const url = new URL(C.montarUrlDeConsentimento({ hosts: { autorizacao: 'http://127.0.0.1:9/auth' }, clientId: 'c', redirectUri: 'http://127.0.0.1:1', escopos: ['a', 'b'], desafio: 'd', state: 's' }));
    assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: 'c', redirect_uri: 'http://127.0.0.1:1', response_type: 'code', scope: 'a b', code_challenge: 'd', code_challenge_method: 'S256', state: 's', access_type: 'offline', prompt: 'consent' });
    assert.equal(C.iguaisEmTempoConstante('abc', 'abc'), true);
    assert.equal(C.iguaisEmTempoConstante('abc', 'abd'), false);
    assert.equal(C.iguaisEmTempoConstante('abc', 'abcd'), false);
    const fonte = fs.readFileSync(path.join(repoRoot, 'src', 'integrations', 'google', 'consentimento.js'), 'utf8');
    assert.ok(!/^import .* from '\.\.?\//m.test(fonte), 'leve: não importa nada da Yui (o script não carrega o log)');
  });

  await test('o endereço colado: só http://127.0.0.1:47615/ (o "http://" pode faltar), sem usuário, sem parâmetro repetido, sem espaço; o resto é recusado', () => {
    const base = `${R.ENDERECO_DO_RETORNO}/?state=abc&code=4/xyz-0123456789`;
    assert.equal(R.PORTA_DO_RETORNO, 47615);
    assert.deepEqual(R.lerEnderecoColado(base), { state: 'abc', code: '4/xyz-0123456789', error: null });
    assert.deepEqual(R.lerEnderecoColado(`  ${base.replace('http://', '')}  `), { state: 'abc', code: '4/xyz-0123456789', error: null });
    assert.deepEqual(R.lerEnderecoColado(`${R.ENDERECO_DO_RETORNO}?state=abc&error=access_denied`), { state: 'abc', code: null, error: 'access_denied' });
    for (const ruim of [
      base.replace('127.0.0.1', 'localhost'), base.replace('47615', '47616'), base.replace('http:', 'https:'), base.replace('/?', '/outra?'), base.replace('http://', 'http://eu:senha@'),
      `${base}&state=outro`, `${base}&code=outro`, `${base} x`, `${base}\n`.repeat(2), 'x'.repeat(5000), '', null, 42, { endereco: base }, `${R.ENDERECO_DO_RETORNO.replace('127.0.0.1', '127.0.0.1.evil.example')}/?state=a&code=b`,
    ]) assert.equal(R.lerEnderecoColado(ruim), null, String(typeof ruim === 'string' ? ruim.slice(0, 80) : ruim));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. O fluxo completo (Google falso)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const api = await subir(novoAdmin());
  // A integração do processo (a mesma que a conversa usa): o Google recusa a autorização guardada e ela fica "precisa autorizar de novo".
  const autenticador = criarAutenticador({ env: { YUI_GOOGLE: 'true', YUI_GOOGLE_TOKEN_ARQUIVO: ARQ }, restringir: () => {}, alertar: async () => true, log: silencioso });

  await test('antes: o Google recusa a autorização guardada (invalid_grant): a integração para e o GET mostra "recusada" e o botão do painel', async () => {
    resetaFalso();
    fake.estado.modoToken = 'invalid_grant';
    assert.deepEqual(await autenticador.obterToken({ recurso: 'agenda' }), { ok: false, motivo: 'precisa-autorizar' });
    await autenticador.aguardarAviso();
    fake.estado.modoToken = 'ok';
    assert.deepEqual(await autenticador.obterToken({ recurso: 'agenda' }), { ok: false, motivo: 'precisa-autorizar' }, 'continua parada (a marca está no arquivo)');
    reiniciarGoogleParaTeste();
    const g = await api('GET', '/v1/admin/google');
    assert.equal(g.status, 200, g.texto);
    assert.deepEqual([g.json.precisaAutorizar, g.json.motivoDeAutorizar, g.json.reautorizarPeloPainel], [true, 'recusada', true]);
    semSegredo(g.texto, 'GET google');
  });

  let primeiro;
  await test('fluxo completo: o link certo (PKCE, state, só Agenda e Tarefas, retorno fixo), a troca com o verificador, o arquivo novo restrito e atômico, "autorizado" com a nova validade', async () => {
    resetaFalso();
    const NOVO = fake.novoRefresh();
    fake.estado.refreshNaTroca = NOVO;
    segredos.add(NOVO);
    restringidos.length = 0;
    const antesDasTrocas = trocas().length;
    const { inicio, colado } = await comecar(api);
    primeiro = { inicio, colado };
    // o início: SÓ o link, até quando vale e o aviso do Gmail
    assert.deepEqual(Object.keys(inicio).sort(), ['expiraEm', 'gmailFicaNoScript', 'link', 'ok']);
    assert.equal(inicio.expiraEm, new Date(relogio.t + R.VALIDADE_DA_SESSAO_MS).toISOString());
    assert.equal(inicio.gmailFicaNoScript, false);
    const u = new URL(inicio.link);
    assert.equal(`${u.origin}${u.pathname}`, `${fake.base}/o/oauth2/v2/auth`, 'o endereço vem do endpoints.js');
    const q = Object.fromEntries(u.searchParams.entries());
    assert.equal(q.client_id, CLIENT_ID, 'o client_id do arquivo atual');
    assert.equal(q.redirect_uri, 'http://127.0.0.1:47615', 'o retorno fixo');
    assert.deepEqual(q.scope.split(' '), [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], 'só Agenda e Tarefas, somente leitura');
    assert.deepEqual([q.response_type, q.code_challenge_method, q.access_type, q.prompt], ['code', 'S256', 'offline', 'consent']);
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.state, /^[0-9a-f]{48}$/);
    assert.ok(!inicio.link.includes(CLIENT_SECRET), 'o segredo do cliente não vai no link');
    assert.match(colado, /^http:\/\/127\.0\.0\.1:47615\/\?code=/, 'o endereço da página que não abre');
    segredos.add(q.state);
    // o retorno
    const r = await retorno(api, colado);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, codigo: 'autorizado', venceEm: new Date(relogio.t + 7 * 86_400_000).toISOString(), escopos: ['agenda', 'tarefas'], faltam: [], gmailFicaNoScript: false });
    // a troca: uma só, com o verificador que casa com o desafio do link, o cliente do arquivo e o mesmo retorno
    assert.equal(trocas().length, antesDasTrocas + 1);
    const c = trocas().at(-1).campos;
    assert.deepEqual([c.client_id, c.client_secret, c.redirect_uri], [CLIENT_ID, CLIENT_SECRET, 'http://127.0.0.1:47615']);
    assert.equal(crypto.createHash('sha256').update(c.code_verifier).digest('base64url'), q.code_challenge, 'o PKCE confere');
    // o arquivo: o refresh token novo, o mesmo cliente, só Agenda e Tarefas, a data de agora e SEM a marca de "precisa autorizar"
    const lido = arq.lerArquivoDeToken(ARQ);
    assert.equal(lido.ok, true);
    assert.deepEqual([lido.dados.refresh_token, lido.dados.client_id, lido.dados.client_secret, lido.dados.criadoEm, lido.dados.invalido], [NOVO, CLIENT_ID, CLIENT_SECRET, new Date(relogio.t).toISOString(), null]);
    assert.deepEqual(lido.dados.escopos, [E.ESCOPOS.agenda, E.ESCOPOS.tarefas]);
    assert.equal(restringidos.length, 1, 'gravado pelo caminho restrito');
    assert.match(restringidos[0], /google-token\.json\.\d+\.[0-9a-f]{8}\.tmp$/, 'restringe o temporário antes de gravar o conteúdo (atômico)');
    assert.deepEqual(fs.readdirSync(path.dirname(ARQ)).filter((f) => f.endsWith('.tmp')), [], 'nada de temporário sobrando');
    // a auditoria
    assert.equal(eventos('google.reauth.start').length, 1);
    assert.deepEqual(eventos('google.reauth.ok').map((e) => [e.userId, e.faltam, e.gmailFicaNoScript]), [[OWNER, null, false]]);
    semSegredo(r.texto, 'resposta do retorno');
    semSegredo({ ...inicio, link: undefined }, 'resposta do início (fora do link)');
  });

  await test('depois: o auth.js passa a renovar com o arquivo novo (sem reiniciar) e o GET deixa de pedir autorização, com a nova validade', async () => {
    const NOVO = arq.lerArquivoDeToken(ARQ).dados.refresh_token;
    const antes = pedidosDeToken().length;
    const t = await autenticador.obterToken({ recurso: 'agenda' });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.match(t.token, /^ya29\.falso-/);
    const renovacoes = pedidosDeToken().slice(antes).filter((p) => p.campos.grant_type === 'refresh_token');
    assert.equal(renovacoes.length, 1);
    assert.equal(renovacoes[0].campos.refresh_token, NOVO, 'renovou com o refresh token do arquivo novo');
    assert.equal(autenticador.estado().precisaAutorizar, false);
    reiniciarGoogleParaTeste();
    const g = (await api('GET', '/v1/admin/google')).json;
    assert.deepEqual([g.precisaAutorizar, g.motivoDeAutorizar, g.conectado, g.autorizadoEm, g.venceEm], [false, null, true, new Date(relogio.t).toISOString(), new Date(relogio.t + 7 * 86_400_000).toISOString()]);
    assert.deepEqual(g.escopos, ['agenda', 'tarefas']);
  });

  await test('uso único: o MESMO endereço de novo é recusado ("sem-sessao"), sem nova troca e sem mexer no arquivo', async () => {
    const antes = trocas().length;
    const bytes = bytesDoArquivo();
    const r = await retorno(api, primeiro.colado);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, 'sem-sessao']);
    assert.match(r.json.texto, /Reautorizar o Google/);
    assert.equal(trocas().length, antes);
    assert.equal(bytesDoArquivo(), bytes);
    assert.deepEqual(eventos('google.reauth.fail').at(-1).codigo, 'sem-sessao');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. As falhas');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  /** Uma tentativa que tem de falhar com `codigo`, sem troca nenhuma e sem mexer no arquivo. */
  async function falhaSemTroca(endereco, codigo, rotulo) {
    const antes = trocas().length;
    const bytes = bytesDoArquivo();
    const r = await retorno(api, endereco);
    assert.equal(r.status, 200, `${rotulo}: ${r.texto}`);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, codigo], rotulo);
    assert.equal(r.json.texto, R.TEXTOS_DAS_FALHAS[codigo], rotulo);
    assert.equal(trocas().length, antes, `${rotulo}: nenhuma troca`);
    assert.equal(bytesDoArquivo(), bytes, `${rotulo}: o arquivo não mudou`);
    semSegredo(r.texto, rotulo);
  }

  await test('state errado: recusado sem trocar o código; a sessão foi gasta (o endereço certo depois também é recusado)', async () => {
    resetaFalso();
    const { colado } = await comecar(api);
    const u = new URL(colado);
    u.searchParams.set('state', 'f'.repeat(48));
    await falhaSemTroca(u.toString(), 'state-diferente', 'state errado');
    await falhaSemTroca(colado, 'sem-sessao', 'o certo depois do errado');
  });

  await test('endereço de outra porta, outro host, https, outro caminho, com usuário ou fora do formato: "endereco-invalido", sem troca', async () => {
    resetaFalso();
    for (const [rotulo, troca] of [
      ['outra porta', (s) => s.replace(':47615', ':47616')], ['outro host', (s) => s.replace('127.0.0.1', 'evil.example')], ['localhost', (s) => s.replace('127.0.0.1', 'localhost')],
      ['https', (s) => s.replace('http:', 'https:')], ['outro caminho', (s) => s.replace(':47615/', ':47615/outra')], ['usuário', (s) => s.replace('http://', 'http://x:y@')],
      ['texto qualquer', () => 'não é um endereço'], ['vazio', () => ''],
    ]) {
      const { colado } = await comecar(api);
      await falhaSemTroca(troca(colado), 'endereco-invalido', rotulo);
    }
    const { colado } = await comecar(api);
    const antes = trocas().length;
    const r = await api('POST', '/v1/admin/google/autorizar/retorno', { corpo: { outra: colado } });
    assert.deepEqual([r.status, r.json.codigo], [200, 'endereco-invalido'], 'sem o campo endereco');
    assert.equal(trocas().length, antes);
    await falhaSemTroca(colado, 'sem-sessao', 'a sessão foi gasta pelo corpo errado');
  });

  await test('sessão vencida (passou dos 10 minutos): recusada sem trocar; a sessão foi gasta', async () => {
    resetaFalso();
    const { colado } = await comecar(api);
    relogio.t += R.VALIDADE_DA_SESSAO_MS + 1;
    await falhaSemTroca(colado, 'sessao-vencida', 'vencida');
    await falhaSemTroca(colado, 'sem-sessao', 'depois de vencida');
  });

  await test('uma sessão por vez: um novo início descarta o anterior (o endereço do primeiro fica com o state de outra autorização)', async () => {
    resetaFalso();
    const a = await comecar(api);
    const b = await comecar(api);
    await falhaSemTroca(a.colado, 'state-diferente', 'o endereço do início antigo');
    await falhaSemTroca(b.colado, 'sem-sessao', 'e a sessão foi gasta');
  });

  await test('o Google informa que a autorização não foi concluída (error=access_denied): "negado", sem troca', async () => {
    resetaFalso();
    fake.estado.consentimento = 'negar';
    const { colado } = await comecar(api);
    assert.match(colado, /error=access_denied/);
    await falhaSemTroca(colado, 'negado', 'negado');
    resetaFalso();
  });

  await test('sem o código no endereço: "sem-codigo"; o Google não devolve o refresh token: "sem-refresh", e o arquivo antigo fica', async () => {
    resetaFalso();
    let { colado } = await comecar(api);
    const u = new URL(colado);
    u.searchParams.delete('code');
    await falhaSemTroca(u.toString(), 'sem-codigo', 'sem código');
    fake.estado.semRefreshNaTroca = true;
    ({ colado } = await comecar(api));
    const bytes = bytesDoArquivo();
    const r = await retorno(api, colado);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, 'sem-refresh']);
    assert.equal(bytesDoArquivo(), bytes);
    resetaFalso();
  });

  await test('escopos: o Google concede só as Tarefas = grava e avisa o que falta; não concede nenhum dos dois = "sem-escopo" e nada é trocado', async () => {
    resetaFalso();
    fake.estado.escoposDoCodigo = [E.ESCOPOS.tarefas];
    let { colado } = await comecar(api);
    let r = await retorno(api, colado);
    assert.deepEqual([r.json.ok, r.json.escopos, r.json.faltam], [true, ['tarefas'], ['agenda']]);
    assert.deepEqual(arq.lerArquivoDeToken(ARQ).dados.escopos, [E.ESCOPOS.tarefas]);
    assert.deepEqual(eventos('google.reauth.ok').at(-1).faltam, 'agenda');
    fake.estado.escoposDoCodigo = ['https://www.googleapis.com/auth/drive.readonly'];
    ({ colado } = await comecar(api));
    const bytes = bytesDoArquivo();
    r = await retorno(api, colado);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, 'sem-escopo']);
    assert.equal(bytesDoArquivo(), bytes);
    resetaFalso();
    ({ colado } = await comecar(api));
    assert.equal((await retorno(api, colado)).json.ok, true, 'volta ao normal');
  });

  await test('o GMAIL NUNCA entra pelo painel: com o Gmail no arquivo atual o link não o pede e avisa; mesmo que o Google o devolva, ele não é gravado', async () => {
    resetaFalso();
    gravarArquivoInicial({ escopos: [E.ESCOPOS.agenda, E.ESCOPOS.tarefas, E.ESCOPOS.gmail] });
    const g = (await api('GET', '/v1/admin/google')).json;
    assert.deepEqual(g.escopos, ['agenda', 'tarefas', 'gmail']);
    fake.estado.escoposDoCodigo = [E.ESCOPOS.agenda, E.ESCOPOS.tarefas, E.ESCOPOS.gmail]; // uma autorização antiga do mesmo cliente
    const { inicio, colado } = await comecar(api);
    assert.equal(inicio.gmailFicaNoScript, true);
    const escopos = new URL(inicio.link).searchParams.get('scope').split(' ');
    assert.deepEqual(escopos, [E.ESCOPOS.agenda, E.ESCOPOS.tarefas]);
    assert.ok(!inicio.link.includes('gmail'), 'o Gmail não aparece no link');
    assert.ok(!fake.pedidosDe('/o/oauth2/v2/auth').some((p) => String(p.query.scope).includes('gmail')), 'o Google nunca recebeu um pedido do Gmail pelo painel');
    const r = await retorno(api, colado);
    assert.deepEqual([r.json.ok, r.json.escopos, r.json.gmailFicaNoScript], [true, ['agenda', 'tarefas'], true]);
    assert.deepEqual(arq.lerArquivoDeToken(ARQ).dados.escopos, [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], 'o Gmail ficou fora do arquivo');
    assert.equal(eventos('google.reauth.start').at(-1).gmailFicaNoScript, true);
    resetaFalso();
  });

  await test('sem arquivo de autorização (primeira vez): o painel não faz nada e manda usar o script; arquivo que não abre: o mesmo; nada é gravado', async () => {
    const guardado = `${ARQ}.guardado`;
    fs.renameSync(ARQ, guardado);
    try {
      relogio.t += 15 * 60_000;
      const r = await api('POST', '/v1/admin/google/autorizar/inicio');
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.ok, r.json.codigo], [false, 'sem-arquivo']);
      assert.match(r.json.texto, /node scripts\/google-autorizar\.mjs/);
      assert.equal(r.json.link, undefined);
      assert.equal(fs.existsSync(ARQ), false, 'nada foi gravado');
      await falhaSemTroca(`${R.ENDERECO_DO_RETORNO}/?state=a&code=4/abcdefghijk`, 'sem-sessao', 'sem sessão nenhuma');
      fs.writeFileSync(ARQ, '{ isto não é a autorização');
      const ruim = await api('POST', '/v1/admin/google/autorizar/inicio');
      assert.deepEqual([ruim.json.ok, ruim.json.codigo], [false, 'arquivo-invalido']);
      assert.match(ruim.json.texto, /script/);
      assert.deepEqual(eventos('google.reauth.fail').slice(-3).map((e) => [e.etapa, e.codigo]), [['inicio', 'sem-arquivo'], ['retorno', 'sem-sessao'], ['inicio', 'arquivo-invalido']]);
    } finally {
      fs.rmSync(ARQ, { force: true });
      fs.renameSync(guardado, ARQ);
    }
  });

  await test('o arquivo trocou de cliente durante a reautorização: "arquivo-mudou", sem troca', async () => {
    resetaFalso();
    const { colado } = await comecar(api);
    gravarArquivoInicial({ clientId: 'outro-cliente-999.apps.googleusercontent.com' });
    await falhaSemTroca(colado, 'arquivo-mudou', 'cliente trocado');
    gravarArquivoInicial();
  });

  await test('a gravação restrita falhou: "gravacao-falhou", o arquivo antigo fica inteiro e nenhum temporário sobra', async () => {
    resetaFalso();
    const outra = await subir(novoAdmin({ restringir: () => { throw new Error(`não deu ${SEGREDO_PLANTADO}`); } }));
    const { colado } = await comecar(outra);
    const bytes = bytesDoArquivo();
    const r = await retorno(outra, colado);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, 'gravacao-falhou']);
    assert.equal(bytesDoArquivo(), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(ARQ)).filter((f) => f.endsWith('.tmp')), []);
    semSegredo(r.texto, 'gravação');
  });

  await test('a rede caiu na troca: "rede" (o erro de rede não vaza)', async () => {
    resetaFalso();
    const outra = await subir(novoAdmin({ fetchImpl: async () => { throw new Error(`ECONNRESET ${SEGREDO_PLANTADO}`); } }));
    const { colado } = await comecar(outra);
    const r = await retorno(outra, colado);
    assert.deepEqual([r.json.ok, r.json.codigo], [false, 'rede']);
    semSegredo(r.texto, 'rede');
  });

  await test('chave desligada: 404 nas duas rotas, o GET diz que o botão não vale e a sessão que estava aberta é descartada', async () => {
    resetaFalso();
    const { colado } = await comecar(api);
    process.env.YUI_GOOGLE_REAUTORIZAR_PAINEL = 'false';
    try {
      for (const rota of ['/v1/admin/google/autorizar/inicio', '/v1/admin/google/autorizar/retorno']) {
        const r = await api('POST', rota, { corpo: { endereco: colado } });
        assert.equal(r.status, 404, `${rota}: ${r.texto}`);
        assert.match(r.json.error, /Reautorizar o Google pelo painel está desligado/);
      }
      assert.equal((await api('GET', '/v1/admin/google')).json.reautorizarPeloPainel, false);
    } finally { process.env.YUI_GOOGLE_REAUTORIZAR_PAINEL = 'true'; }
    await falhaSemTroca(colado, 'sem-sessao', 'a sessão de antes do desligar foi descartada');
  });

  await test('quem não é o dono: 403 nas duas, sem gastar a sessão do dono; sem token: 401', async () => {
    resetaFalso();
    const { colado } = await comecar(api);
    const antes = trocas().length;
    for (const rota of ['/v1/admin/google/autorizar/inicio', '/v1/admin/google/autorizar/retorno']) {
      const r = await api('POST', rota, { token: T_MEMBER, corpo: { endereco: colado } });
      assert.equal(r.status, 403, `${rota}: ${r.texto}`);
      assert.deepEqual(Object.keys(r.json), ['error'], 'o membro não recebe nada além do erro');
      assert.equal((await api('POST', rota, { token: null, corpo: { endereco: colado } })).status, 401);
    }
    assert.equal(trocas().length, antes);
    await assert.rejects(novoAdmin().googleReautorizarInicio({ role: 'MEMBER', userId: MEMBER, platform: 'api' }), (e) => e.status === 403);
    const r = await retorno(api, colado);
    assert.equal(r.json.ok, true, 'a sessão do dono continuou valendo');
  });

  await test('limite: 5 inícios por hora (o sem-arquivo não conta); o 6º recebe 429 com a frase; depois de uma hora volta', async () => {
    const outra = await subir(novoAdmin());
    const t0 = relogio.t;
    for (let i = 0; i < 5; i += 1) assert.equal((await outra('POST', '/v1/admin/google/autorizar/inicio')).json?.ok, true, `início ${i + 1}`);
    const r = await outra('POST', '/v1/admin/google/autorizar/inicio');
    assert.equal(r.status, 429, r.texto);
    assert.match(r.json.error, /^Muitas tentativas de reautorizar o Google/);
    assert.equal(eventos('google.reauth.fail').at(-1).codigo, 'limite');
    relogio.t = t0 + R.LIMITE_DE_INICIOS.janelaMs;
    assert.equal((await outra('POST', '/v1/admin/google/autorizar/inicio')).json?.ok, true, 'uma hora depois');
    const sem = await subir(novoAdmin());
    const guardado = `${ARQ}.guardado`;
    fs.renameSync(ARQ, guardado);
    try {
      for (let i = 0; i < 7; i += 1) assert.equal((await sem('POST', '/v1/admin/google/autorizar/inicio')).json?.codigo, 'sem-arquivo');
    } finally { fs.renameSync(guardado, ARQ); }
    assert.equal((await sem('POST', '/v1/admin/google/autorizar/inicio')).json?.ok, true, 'os sem-arquivo não contaram');
  });

  await test('em enforce: o membro é barrado pela política (403 com a ação); o dono pelo app passa (ASK); em somente leitura, nem o dono (grava credencial)', async () => {
    try {
      process.env.YUI_POLICY_MODE = 'enforce';
      const membro = await api('POST', '/v1/admin/google/autorizar/inicio', { token: T_MEMBER });
      assert.equal(membro.status, 403);
      assert.equal(membro.json.policy.action, 'admin.google_reauth');
      relogio.t += 15 * 60_000;
      const app = await api('POST', '/v1/admin/google/autorizar/inicio', { headers: { 'x-forwarded-for': '100.64.0.9' } });
      assert.equal(app.status, 200, app.texto);
      process.env.YUI_READ_ONLY = 'true';
      for (const rota of ['/v1/admin/google/autorizar/inicio', '/v1/admin/google/autorizar/retorno']) {
        const r = await api('POST', rota, { corpo: { endereco: 'x' }, headers: { 'x-forwarded-for': '100.64.0.9' } });
        assert.equal(r.status, 403, `${rota}: ${r.texto}`);
        assert.equal(r.json.policy.action, 'admin.google_reauth');
      }
    } finally {
      process.env.YUI_POLICY_MODE = 'observe';
      process.env.YUI_READ_ONLY = 'false';
    }
  });

  await test('cérebro: as duas rodam ali mesmo, sem nenhum pedido ao bot; o bot separado recusa (503) e o canal do bot não aceita as ações', async () => {
    resetaFalso();
    const pedidos = [];
    const canal = { isConnected: () => true, emit() {}, request: async (...a) => { pedidos.push(a); return {}; } };
    const cerebro = createCerebroAdmin({ channel: canal, base: novoAdmin() });
    relogio.t += 15 * 60_000;
    const inicio = await cerebro.googleReautorizarInicio(ctxDono);
    assert.equal(inicio.ok, true);
    const fim = await cerebro.googleReautorizarRetorno(ctxDono, { endereco: await navegador(inicio.link) });
    assert.equal(fim.ok, true, JSON.stringify(fim));
    for (const m of ACOES) await assert.rejects(cerebro[m]({ role: 'MEMBER', userId: MEMBER, platform: 'api' }, {}), (e) => e.status === 403, m);
    assert.deepEqual(pedidos, [], 'nada foi ao bot');
    const doBot = createAdmin({ processo: 'bot', deps: { integrationData: async () => ({}) } });
    for (const m of ACOES) await assert.rejects(doBot[m](ctxDono, {}), (e) => e.status === 503, m);
    const hs = new Map();
    registerBotActions({ handle: (m, fn) => hs.set(m, fn) }, { getClient: () => null, admin: doBot });
    for (const action of ACOES) await assert.rejects(hs.get('panel.admin')({ userId: OWNER, action, args: [] }, { role: 'cerebro' }), (e) => e.code === 'METHOD_NOT_ALLOWED', action);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. Nada de segredo');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('nenhuma resposta (fora do próprio link do início), nenhuma linha da auditoria e nenhum log tem token, client_secret, código, verificador, state ou corpo do Google', () => {
    assert.ok(trocas().length >= 5, 'o teste fez várias trocas de verdade');
    for (const { rota, texto } of respostas) {
      let json = null;
      try { json = JSON.parse(texto); } catch { json = null; }
      const semLink = json && typeof json === 'object' ? { ...json, link: undefined } : texto;
      semSegredo(semLink, `resposta de ${rota}`);
    }
    const textoDaAuditoria = fs.readFileSync(AUDIT, 'utf8');
    semSegredo(textoDaAuditoria, 'auditoria');
    assert.ok(!textoDaAuditoria.includes('127.0.0.1:47615') && !textoDaAuditoria.includes(fake.base), 'a auditoria não leva o link nem o endereço');
    for (const e of auditoria().filter((x) => String(x.event).startsWith('google.reauth.'))) {
      const extras = Object.keys(e).filter((k) => !['ts', 'event', 'userId', 'role', 'platform', 'channelKind', 'seq', 'prev_hash', 'hash', 'etapa', 'codigo', 'faltam', 'gmailFicaNoScript'].includes(k));
      assert.deepEqual(extras, [], `${e.event} só leva a etapa, o código, o que faltou e o aviso do Gmail`);
      if (e.codigo) assert.ok(R.CODIGOS_DE_FALHA.includes(e.codigo), e.codigo);
    }
    const logs = fs.existsSync(LOGS) ? fs.readdirSync(LOGS, { recursive: true }).map((f) => path.join(LOGS, String(f))).filter((f) => fs.statSync(f).isFile()) : [];
    for (const f of logs) semSegredo(fs.readFileSync(f, 'utf8'), `log ${path.basename(f)}`);
  });
} finally {
  for (const s of servidores) { s.close(); s.closeAllConnections?.(); }
  E.definirHostsParaTeste(null);
  await fake.close();
  process.chdir(repoRoot);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows às vezes segura o arquivo */ }
}

say(`\n${passed} testes OK, ${failures.length} falha(s)`);
if (failures.length) {
  for (const f of failures) say(`  - ${f}`);
  process.exit(1);
}
