// CORREÇÃO C2 do parecer da Liz (docs/PLANO_LACUNAS_PAINEL_CORRECOES.md, 27/11/2026): a CHAVE DE CONFIRMAÇÃO pela DM nas ações críticas do painel.
//  A. o módulo (src/core/api/confirmacao.js): 6 dígitos, só o hash guardado, uso único, presa ao dono, à sessão, à ação e ao alvo, validade de 5 min,
//     pedir de novo invalida a anterior, 5 erros travam por 15 min, 10 pedidos em 15 min travam os pedidos, sair do painel leva as chaves da sessão;
//  B. de ponta a ponta pela API de verdade (sessões = tokens diferentes do mesmo dono): pedir a chave (a resposta nunca a traz; ela chega só pela DM),
//     aprovar plano sem chave (428), com a chave de outra sessão, de outro plano ou de outra ação (422), com a certa (passa uma vez); recusar não pede;
//     reautorizar o Google pede a chave dela; a DM que não saiu não deixa chave valendo; a trava avisa o dono; a auditoria nunca leva a chave;
//  C. as fontes: a exigência vem ANTES do serviço, nas duas ações.
// Num processo só, pasta temporária, sem .env, sem rede de fora. Execução: npm run test:painelconfirmacao
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-confirmacao-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_OWNER2 = 'token-do-dono-outra-sessao-0123456789';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const AUDIT = path.join(tmp, 'audit.jsonl');
Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, OWNER_ID: OWNER, OWNER_IDS: '', YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'true',
  LOG_LEVEL: 'error', YUI_POLICY_MODE: 'observe', YUI_PAINEL_CONFIG_FILE: path.join(tmp, 'secrets', 'painel-config.json'), YUI_PAINEL_CONFIG_DPAPI: 'false',
  YUI_LOG_DIR: path.join(tmp, 'logs'), YUI_PLANOS: 'true', YUI_PLANOS_PAINEL: 'true', YUI_GOOGLE_REAUTORIZAR_PAINEL: 'true',
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'YUI_READ_ONLY', 'YUI_API_TOKENS', 'YUI_GOOGLE_TOKEN_FILE']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp); // sem .env, sem secrets/ reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const C = await imp('src/core/api/confirmacao.js');
const { createAdmin, alvoDoPlano } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const { configureAlerts } = await imp('src/core/alerts.js');
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 7).join('\n        ')}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codigoDe = (texto) => (/`(\d{3}-\d{3})`/.exec(String(texto ?? '')) ?? [])[1] ?? null;

try {
  section('A. O módulo da chave (src/core/api/confirmacao.js)');
  const relogio = { t: 1_000_000 };
  const nova = () => C.criarConfirmacoes({ agora: () => relogio.t });
  const base = { userId: OWNER, sessao: 'sessao-a', acao: 'plano.aprovar', alvo: 'abc:1:ffff' };

  await test('a chave: 6 dígitos ("482-913"), aleatória; a conferência aceita com espaço ou hífen; vale UMA vez', () => {
    const vistos = new Set();
    for (let i = 0; i < 40; i++) { const e = nova().emitir({ ...base, alvo: `a:${i}` }); assert.match(e.codigo, /^\d{3}-\d{3}$/); vistos.add(e.codigo); }
    assert.ok(vistos.size >= 35, 'as chaves variam');
    const c = nova();
    const e = c.emitir(base);
    assert.equal(e.expiraEmSegundos, 300);
    assert.equal(c.conferir({ ...base, chave: e.codigo.replace('-', ' ') }), true);
    assert.throws(() => c.conferir({ ...base, chave: e.codigo }), (x) => x.status === 422 && x.message === C.TEXTOS_DA_CONFIRMACAO.invalida, 'uso único');
    assert.equal(C.normalizarChave(' 48-2 9.13 '), '482913');
  });
  await test('presa ao dono, à sessão, à ação e ao alvo: a errada não serve e não gasta a certa; a mensagem não diz o que estava errado', () => {
    const c = nova();
    const e = c.emitir(base);
    // 4 erradas (a 5ª travaria a conferência: ver o teste da trava)
    for (const outro of [{ userId: MEMBER }, { sessao: 'sessao-b' }, { acao: 'google.reautorizar' }, { alvo: 'abc:2:ffff' }]) {
      assert.throws(() => c.conferir({ ...base, ...outro, chave: e.codigo }), (x) => x.status === 422 && x.message === C.TEXTOS_DA_CONFIRMACAO.invalida, JSON.stringify(outro));
    }
    assert.equal(c.conferir({ ...base, chave: e.codigo }), true, 'a certa ainda vale');
    const d = nova();
    const e2 = d.emitir(base);
    assert.throws(() => d.conferir({ ...base, sessao: null, chave: e2.codigo }), (x) => x.status === 422, 'sem sessão');
  });
  await test('sem chave: 428 (pede a chave); ação desconhecida: 400; sem sessão não se pede chave (403)', () => {
    const c = nova();
    for (const vazia of [undefined, null, '', '   ', 'abc']) assert.throws(() => c.conferir({ ...base, chave: vazia }), (x) => x.status === 428 && x.confirmacao === 'necessaria', String(vazia));
    assert.throws(() => c.emitir({ ...base, acao: 'apagar.tudo' }), (x) => x.status === 400);
    assert.throws(() => c.conferir({ ...base, acao: 'apagar.tudo', chave: '123456' }), (x) => x.status === 400);
    assert.throws(() => c.emitir({ ...base, sessao: null }), (x) => x.status === 403);
  });
  await test('vence em 5 minutos; pedir outra para o mesmo alvo invalida a anterior; sair do painel leva as chaves da sessão', () => {
    const c = nova();
    const e = c.emitir(base);
    relogio.t += C.VALIDADE_DA_CHAVE_MS;
    assert.throws(() => c.conferir({ ...base, chave: e.codigo }), (x) => x.status === 422, 'vencida');
    const a = c.emitir(base);
    const b = c.emitir(base);
    if (a.codigo !== b.codigo) assert.throws(() => c.conferir({ ...base, chave: a.codigo }), (x) => x.status === 422, 'a anterior saiu');
    const d = c.emitir({ ...base, alvo: 'outro:1:aaaa' });
    assert.equal(c.esquecerSessao('sessao-a'), 2);
    assert.throws(() => c.conferir({ ...base, chave: b.codigo }), (x) => x.status === 422);
    assert.throws(() => c.conferir({ ...base, alvo: 'outro:1:aaaa', chave: d.codigo }), (x) => x.status === 422);
    assert.equal(c.tamanho(), 0);
  });
  await test('5 chaves erradas em 15 min travam (429, até com a certa); a 5ª avisa que travou; 15 min depois volta', () => {
    const c = nova();
    const e = c.emitir(base);
    for (let i = 1; i <= 5; i++) assert.throws(() => c.conferir({ ...base, chave: '000000' === e.codigo.replace('-', '') ? '111111' : '000000' }), (x) => x.status === 422 && x.travou === (i === 5), `erro ${i}`);
    assert.throws(() => c.conferir({ ...base, chave: e.codigo }), (x) => x.status === 429 && /^Muitas chaves/.test(x.message));
    relogio.t += C.LIMITE_DE_ERROS.janelaMs;
    const f = c.emitir(base);
    assert.equal(c.conferir({ ...base, chave: f.codigo }), true);
  });
  await test('10 pedidos em 15 min travam os pedidos (429, "Muitos pedidos..."); 15 min depois volta', () => {
    const c = nova();
    for (let i = 0; i < 10; i++) c.emitir({ ...base, alvo: `p:${i}` });
    assert.throws(() => c.emitir(base), (x) => x.status === 429 && /^Muitos pedidos/.test(x.message));
    relogio.t += C.LIMITE_DE_PEDIDOS.janelaMs;
    assert.match(c.emitir(base).codigo, /^\d{3}-\d{3}$/);
  });
  await test('a sessão marcada pelo server.js: só um resumo do Bearer, ao lado do contexto congelado', () => {
    const ctx = Object.freeze({ userId: OWNER });
    assert.equal(C.sessaoDe(ctx), null);
    C.marcarSessao(ctx, T_OWNER);
    assert.match(C.sessaoDe(ctx), /^[0-9a-f]{32}$/);
    assert.ok(!C.sessaoDe(ctx).includes(T_OWNER));
    const outro = Object.freeze({ userId: OWNER });
    C.marcarSessao(outro, T_OWNER2);
    assert.notEqual(C.sessaoDe(outro), C.sessaoDe(ctx));
  });

  section('B. De ponta a ponta pela API (o dono em duas sessões; a DM capturada)');
  C.definirConfirmacoesParaTestes(C.criarConfirmacoes());
  const dms = [];
  let dmSai = true;
  const decisoes = [];
  const servicoDosPlanos = { decidir: async (p) => { decisoes.push(p); return { ok: true, final: true, text: p.aprovar ? 'Aprovado. Aviso aqui quando terminar.' : 'Plano recusado. Nada foi feito.' }; } };
  const alertas = [];
  configureAlerts({ ownerId: OWNER, notify: async (_id, t) => { alertas.push(t); } });
  const admin = createAdmin({ client: null, planos: servicoDosPlanos, enviarDmAoDono: async (t) => { dms.push(t); return dmSai; }, deps: { integrationData: async () => ({}) } });
  const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_OWNER2}=${OWNER},${T_MEMBER}=${MEMBER}`), admin });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${srv.address().port}`;
  const api = async (method, rota, { token = T_OWNER, corpo } = {}) => {
    const res = await fetch(base2 + rota, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* */ }
    return { status: res.status, json, texto };
  };
  const PLANO = { id: 'a1b2c3d4e5f6', versao: 1, hash: 'abcdef0123456789' };
  const OUTRO = { id: 'f6e5d4c3b2a1', versao: 1, hash: '0123456789abcdef' };
  const pedir = (plano = PLANO, opcoes = {}) => api('POST', '/v1/admin/confirmacao/pedir', { corpo: { acao: 'plano.aprovar', plano }, ...opcoes });
  const aprovar = (plano, confirmacao, opcoes = {}) => api('POST', `/v1/admin/planos/${plano.id}/decisao`, { corpo: { versao: plano.versao, hash: plano.hash, aprovar: true, ...(confirmacao !== undefined ? { confirmacao } : {}) }, ...opcoes });

  await test('a rota de pedir está no routeGuard (a família da DM de teste); membro 403; a resposta nunca traz a chave, que chega só pela DM', async () => {
    assert.equal(actionForRoute('POST', '/v1/admin/confirmacao/pedir'), 'admin.discord_dm');
    assert.equal((await pedir(PLANO, { token: T_MEMBER })).status, 403);
    const r = await pedir();
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, acao: 'plano.aprovar', expiraEmSegundos: 300 });
    const codigo = codigoDe(dms.at(-1));
    assert.ok(codigo, dms.at(-1));
    assert.ok(!r.texto.includes(codigo) && !r.texto.includes(codigo.replace('-', '')), 'a chave não volta na resposta');
    assert.match(dms.at(-1), /Serve só para: \*\*aprovar o plano a1b2c3d4e5f6\*\*/);
    assert.match(dms.at(-1), /Vale por \*\*5 minutos\*\* e só pode ser usada \*\*uma vez\*\*/);
    for (const ruim of [{ acao: 'apagar.tudo' }, { acao: 'plano.aprovar' }, { acao: 'plano.aprovar', plano: { id: 'x', versao: 1, hash: 'abc' } }]) {
      assert.equal((await api('POST', '/v1/admin/confirmacao/pedir', { corpo: ruim })).status, 400, JSON.stringify(ruim));
    }
  });
  await test('aprovar SEM a chave: 428 e nada chega ao serviço; recusar não pede chave', async () => {
    const antes = decisoes.length;
    const r = await aprovar(PLANO);
    assert.equal(r.status, 428, r.texto);
    assert.match(r.json.error, /peça a chave pela DM/);
    assert.equal(decisoes.length, antes);
    const recusa = await api('POST', `/v1/admin/planos/${PLANO.id}/decisao`, { corpo: { versao: 1, hash: PLANO.hash, aprovar: false } });
    assert.deepEqual([recusa.status, recusa.json.texto], [200, 'Plano recusado. Nada foi feito.']);
    assert.equal(decisoes.length, antes + 1);
  });
  await test('a chave de OUTRA sessão, de OUTRO plano ou de OUTRA ação não serve (422, nada chega ao serviço); a certa passa UMA vez', async () => {
    await pedir();
    const certa = codigoDe(dms.at(-1));
    const antes = decisoes.length;
    assert.equal((await aprovar(PLANO, certa, { token: T_OWNER2 })).status, 422, 'outra sessão do mesmo dono');
    assert.equal((await aprovar(OUTRO, certa)).status, 422, 'outro plano');
    assert.equal((await aprovar({ ...PLANO, versao: 2 }, certa)).status, 422, 'outra versão');
    await api('POST', '/v1/admin/confirmacao/pedir', { corpo: { acao: 'google.reautorizar' } });
    const doGoogle = codigoDe(dms.at(-1));
    assert.equal((await aprovar(PLANO, doGoogle)).status, 422, 'a chave do Google');
    assert.equal(decisoes.length, antes, 'nada chegou ao serviço');
    const r = await aprovar(PLANO, certa);
    assert.deepEqual([r.status, r.json.texto], [200, 'Aprovado. Aviso aqui quando terminar.'], r.texto);
    assert.deepEqual(decisoes.at(-1), { userId: OWNER, id: PLANO.id, versao: 1, hash: PLANO.hash, aprovar: true, origem: 'painel' });
    assert.equal((await aprovar(PLANO, certa)).status, 422, 'a mesma chave de novo');
    assert.equal(decisoes.length, antes + 1);
    assert.equal(alvoDoPlano(PLANO.id, 1, `${PLANO.hash}ffff`), `${PLANO.id}:1:${PLANO.hash}`, 'o alvo usa o prefixo de 16 do hash');
  });
  // Cada cenário abaixo começa com um lugar de chaves novo: os anteriores já gastaram erros e pedidos (5 erros travam; ver o último teste).
  await test('reautorizar o Google pelo painel: sem a chave, 428 antes de tudo; com a chave dela, passa da confirmação (aqui sem arquivo: "sem-arquivo"); de novo, 422', async () => {
    C.definirConfirmacoesParaTestes(C.criarConfirmacoes());
    const sem = await api('POST', '/v1/admin/google/autorizar/inicio', { corpo: {} });
    assert.equal(sem.status, 428, sem.texto);
    await api('POST', '/v1/admin/confirmacao/pedir', { corpo: { acao: 'google.reautorizar' } });
    const chave = codigoDe(dms.at(-1));
    assert.match(dms.at(-1), /Serve só para: \*\*reautorizar o Google pelo painel\*\*/);
    const r = await api('POST', '/v1/admin/google/autorizar/inicio', { corpo: { confirmacao: chave } });
    assert.ok(r.status !== 428 && r.status !== 422, `passou da confirmação: ${r.status} ${r.texto}`);
    assert.equal(r.json?.codigo, 'sem-arquivo', r.texto);
    assert.equal((await api('POST', '/v1/admin/google/autorizar/inicio', { corpo: { confirmacao: chave } })).status, 422, 'uso único');
    assert.equal((await api('POST', '/v1/admin/google/autorizar/inicio', { token: T_MEMBER, corpo: { confirmacao: chave } })).status, 403);
  });
  await test('a DM que não saiu: 502 e a chave dela não vale; sair do painel leva as chaves da sessão', async () => {
    C.definirConfirmacoesParaTestes(C.criarConfirmacoes());
    dmSai = false;
    const r = await pedir();
    assert.equal(r.status, 502, r.texto);
    const naoEntregue = codigoDe(dms.at(-1));
    dmSai = true;
    assert.equal((await aprovar(PLANO, naoEntregue)).status, 422, 'a chave que não chegou ao dono não vale');
    await pedir(OUTRO, { token: T_OWNER2 });
    const daSessao2 = codigoDe(dms.at(-1));
    assert.equal((await api('POST', '/v1/auth/logout', { token: T_OWNER2 })).status, 200);
    assert.equal((await aprovar(OUTRO, daSessao2, { token: T_OWNER2 })).status, 422, 'saiu do painel: a chave foi junto');
  });
  await test('5 chaves erradas travam (429) e avisam o dono; a auditoria registra pedida, usada e recusada, sem a chave', async () => {
    C.definirConfirmacoesParaTestes(C.criarConfirmacoes());
    await pedir();
    const certa = codigoDe(dms.at(-1));
    const errada = certa === '000-000' ? '111-111' : '000-000';
    for (let i = 0; i < 5; i++) assert.equal((await aprovar(PLANO, errada)).status, 422);
    const travada = await aprovar(PLANO, certa);
    assert.equal(travada.status, 429);
    assert.match(travada.json.error, /^Muitas chaves de confirmação erradas/);
    await sleep(50);
    assert.ok(alertas.some((t) => /Chaves de confirmação bloqueadas/.test(t)), alertas.join(' | '));
    const linhas = fs.readFileSync(AUDIT, 'utf8');
    for (const ev of ['admin.confirmacao.pedida', 'admin.confirmacao.usada', 'admin.confirmacao.recusada', 'admin.confirmacao.falhou']) assert.ok(linhas.includes(`"${ev}"`), ev);
    for (const t of dms) {
      const c = codigoDe(t);
      if (c) assert.ok(!linhas.includes(c) && !linhas.includes(c.replace('-', '')), `a chave ${c} foi para a auditoria`);
    }
  });
  srv.close();

  section('C. As fontes: a exigência vem ANTES do serviço, nas duas ações');
  await test('decidirPlano confere a chave antes da decidir(); googleReautorizarInicio, antes de iniciar(); a rota do início passa o corpo', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/api/admin.js'), 'utf8');
    const d = src.indexOf('async decidirPlano(');
    const chaveNaDecisao = src.indexOf("await exigirChave(ctx, 'plano.aprovar'", d);
    assert.ok(chaveNaDecisao > d && chaveNaDecisao < src.indexOf('servico.decidir(', d));
    const g = src.indexOf('async googleReautorizarInicio(');
    const chaveNoGoogle = src.indexOf("await exigirChave(ctx, 'google.reautorizar'", g);
    assert.ok(chaveNoGoogle > g && chaveNoGoogle < src.indexOf('reaut.iniciar(', g));
    const server = fs.readFileSync(path.join(repoRoot, 'src/core/api/server.js'), 'utf8');
    assert.ok(server.includes('admin.googleReautorizarInicio(ctx, await readJson(req))'));
    assert.ok(server.includes('marcarSessao(ctx, bearerOf(req));'));
  });
} finally {
  process.chdir(os.tmpdir());
}

console.log(failures.length ? `\nFALHA: ${passed} ok, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} testes OK, 0 falha(s)`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Windows pode segurar algum arquivo */ }
process.exit(failures.length ? 1 : 0);
