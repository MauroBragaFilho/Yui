// Lacunas do painel, ENTREGA D, item 12 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md): o que a Yui guarda, visto pelo dono. SÓ DO DONO.
//   GET /v1/admin/listas          as listas pessoais DO DONO DA SESSÃO (src/handlers/listStore.js: lerListasDoUsuario), sem gravar nem renomear nada
//   GET /v1/admin/skills          o catálogo das skills instaladas e quais estão permitidas (YUI_SKILLS_PERMITIDAS), só leitura
//   GET /v1/admin/continuidade    os projetos e as decisões registrados na memória pessoal do dono (src/core/continuidade.js)
//   DELETE /v1/admin/continuidade/:id   apaga UM projeto ou decisão, com confirm: true; no routeGuard (memory.forget_item); auditoria sem o texto
// A. As vistas (src/core/api/leiturasDoPainel.js) com fontes envenenadas: só a lista fechada de campos sai.
// B. As fontes de verdade numa pasta temporária: o arquivo das listas (o do outro usuário nunca é lido; o estragado não é renomeado), o catálogo das skills
//    (o corpo, o caminho e os metadados nunca saem) e a memória pessoal de verdade (só project e decision do PRÓPRIO dono; apagar recusa o resto).
// C. As rotas HTTP de verdade: o dono vê e apaga, o membro leva 403 (e nada é apagado), sem token 401, sem confirmação 400, item de outro tipo ou de outro
//    dono 404; as leituras fora do routeGuard, o apagar dentro; memória desligada não lê nem apaga.
// D. O cérebro separado: listas, skills e continuidade são lidas e apagadas NO CÉREBRO (a memória é dele), sem nenhum pedido ao bot.
// Num processo só, pasta temporária, sem .env, sem rede de fora. Execução: npm run test:paineltransparencia
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-transparencia-'));
const OWNER = '111111111111111111';
const OWNER2 = '333333333333333333';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_OWNER2 = 'token-do-dono2-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const SEGREDO = 'SEGREDO-DA-TRANSPARENCIA-91ac';
const DO_OUTRO = 'CONTEUDO-DE-OUTRA-PESSOA-77f0';
const DB = path.join(tmp, 'db');
const AUDIT = path.join(tmp, 'audit.jsonl');

Object.assign(process.env, {
  DATABASE_DIR: DB, YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, OWNER_IDS: OWNER2, YUI_MEMORY_ENABLED: 'true', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_LOG_DIR: path.join(tmp, 'logs'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
  YUI_SKILLS: 'true', YUI_SKILLS_PERMITIDAS: 'skill-boa, Nao-Instalada ;skill-dono', YUI_CONTINUIDADE: 'true', YUI_LISTS_ENABLED: 'true', MEMORY_RETENTION_DAYS: '30',
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'YUI_READ_ONLY', 'YUI_API_TOKENS', 'YUI_DB_OWNER_ROLE', 'YUI_DB_NATIVE', 'YUI_SKILLS_PASTAS']) delete process.env[k];
fs.mkdirSync(DB, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const L = await imp('src/core/api/leiturasDoPainel.js');
const { lerListasDoUsuario, createListStore, defaultListDir } = await imp('src/handlers/listStore.js');
const { carregarCatalogo } = await imp('src/core/skills/carregador.js');
const memory = await imp('src/core/memory/store.js');
const { listarContinuidade, apagarDaContinuidade } = await imp('src/core/continuidade.js');
const { buildContext } = await imp('src/core/permissions.js');
const { createAdmin } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await imp('src/cerebro/painel.js');
const { actionForRoute, guardRoute } = await imp('src/core/security/routeGuard.js');
const { closeAllDatabases } = await imp('src/database/db.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const semTexto = (valor, proibidos, rotulo = '') => {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of proibidos) assert.ok(!texto.includes(p), `${rotulo} vazou: ${p}`);
};
const ctxDe = (userId) => buildContext({ platform: 'api', userId, isDM: true });
const ctxDono = ctxDe(OWNER);

// ── As skills de teste (duas pastas temporárias; nunca as pastas de verdade do repositório nem secrets/) ──
const RAIZ_YUI = path.join(tmp, 'skills-yui');
const RAIZ_DONO = path.join(tmp, 'skills-dono');
const skillMd = (linhas, corpo) => `---\n${linhas.join('\n')}\n---\n${corpo}\n`;
const escrever = (raiz, pasta, texto) => { fs.mkdirSync(path.join(raiz, pasta), { recursive: true }); if (texto !== null) fs.writeFileSync(path.join(raiz, pasta, 'SKILL.md'), texto); };
escrever(RAIZ_YUI, 'skill-boa', skillMd(['name: skill-boa', 'description: Resume o dia\u200b do dono em tópicos curtos.', 'license: MIT', 'metadata:', `  segredo: ${SEGREDO}`], `Corpo da skill com ${SEGREDO}.`));
escrever(RAIZ_YUI, 'outra-skill', skillMd(['name: outra-skill', `description: ${'Explica um assunto passo a passo. '.repeat(20)}`, 'allowed-tools: Bash Read'], 'Corpo.'));
fs.mkdirSync(path.join(RAIZ_YUI, 'outra-skill', 'scripts'), { recursive: true });
escrever(RAIZ_YUI, 'quebrada', skillMd(['name: outro-nome', 'description: x'], `Corpo ${SEGREDO}.`));
escrever(RAIZ_YUI, `pasta ${SEGREDO.slice(0, 4)} ruim`, null);
escrever(RAIZ_DONO, 'skill-dono', skillMd(['name: skill-dono', 'description: Uma skill que o dono instalou.'], 'Corpo.'));
const RAIZES = [{ dir: RAIZ_YUI, origem: 'yui' }, { dir: RAIZ_DONO, origem: 'dono' }];

let server = null;
try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. As vistas: só a lista fechada de campos sai');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('listas: nome (60), itens (500, sem controle) e feito; em ordem alfabética; o resto da fonte não passa', () => {
    const v = L.vistaDasListas({
      situacao: 'ok', userId: OWNER, caminho: SEGREDO,
      listas: [
        { nome: 'mercado', atualizadaEm: Date.parse('2026-11-26T10:00:00Z'), itens: [{ texto: 'leite', feito: true, id: 9, addedAt: 1 }, { texto: `pão\u0007\n${'p'.repeat(600)}`, feito: 'sim' }, { texto: '' }], arquivo: SEGREDO },
        { nome: `Afazeres ${'a'.repeat(80)}`, itens: [] },
        { nome: '', itens: [{ texto: SEGREDO }] },
      ],
    });
    assert.deepEqual(Object.keys(v).sort(), ['ligado', 'listas', 'situacao', 'total']);
    assert.deepEqual(v.listas.map((l) => l.nome.slice(0, 8)), ['Afazeres', 'mercado']);
    assert.ok(v.listas[0].nome.length <= 60);
    const m = v.listas[1];
    assert.deepEqual(Object.keys(m).sort(), ['atualizadaEm', 'feitos', 'itens', 'nome', 'total']);
    assert.deepEqual([m.total, m.feitos, m.atualizadaEm], [2, 1, '2026-11-26T10:00:00.000Z']);
    assert.deepEqual(m.itens[0], { texto: 'leite', feito: true });
    assert.ok(m.itens[1].texto.startsWith('pão') && m.itens[1].texto.length <= 500 && !/[\u0000-\u001f]/.test(m.itens[1].texto) && m.itens[1].feito === false);
    semTexto(v, [SEGREDO, OWNER], 'listas');
    assert.equal(L.vistaDasListas({ situacao: 'qualquer' }).situacao, 'ausente');
    assert.equal(L.vistaDasListas(null, { ligado: false }).ligado, false);
  });

  await test('skills: nome válido, descrição curta (300), origem, licença, permitida e o que foi ignorado; nunca caminho, corpo nem metadados', () => {
    const v = L.vistaDasSkills({
      ligado: true, permitidas: ['skill-boa', 'Nao-Instalada', '../x', 'skill-boa'],
      catalogo: {
        skills: [
          { nome: 'skill-boa', descricao: `Resume ${'d'.repeat(400)}`, origem: 'yui', licenca: 'MIT', metadata: { segredo: SEGREDO }, dir: `C:\\${SEGREDO}`, raiz: SEGREDO, corpo: SEGREDO, ignorados: ['scripts', SEGREDO] },
          { nome: 'Outra Skill', descricao: 'nome inválido: não sai' },
          { nome: 'skill-extra', descricao: 'fora da lista', origem: 'qualquer' },
        ],
        avisos: [{ pasta: `pasta ${SEGREDO}/../..`, origem: 'dono', motivo: 'nome_diferente_da_pasta', texto: SEGREDO }, { pasta: 'x', origem: 'yui', motivo: `motivo ${SEGREDO}` }],
      },
    });
    assert.deepEqual(Object.keys(v).sort(), ['ativas', 'avisos', 'filtro', 'ligado', 'naoInstaladas', 'permitidas', 'skills', 'total']);
    assert.deepEqual([v.ligado, v.filtro, v.total, v.ativas], [true, 'lista', 2, 1]);
    assert.deepEqual(v.permitidas, ['skill-boa', 'nao-instalada']);
    assert.deepEqual(v.naoInstaladas, ['nao-instalada']);
    assert.deepEqual(Object.keys(v.skills[0]).sort(), ['descricao', 'ignorados', 'licenca', 'nome', 'origem', 'permitida']);
    assert.ok(v.skills[0].descricao.length <= 300);
    assert.deepEqual(v.skills[0].ignorados, ['scripts']);
    assert.deepEqual([v.skills[1].nome, v.skills[1].origem, v.skills[1].permitida], ['skill-extra', 'extra', false]);
    assert.equal(v.avisos[0].motivo, 'nome_diferente_da_pasta');
    assert.equal(v.avisos[1].motivo, 'ilegivel', 'motivo que não é palavra fixa vira "ilegivel"');
    assert.ok(!v.avisos[0].pasta.includes('/') && v.avisos[0].pasta.length <= 64);
    semTexto(v, ['C:\\', 'metadata', 'corpo', 'raiz'], 'skills');
    const todas = L.vistaDasSkills({ ligado: false, permitidas: null, catalogo: { skills: [{ nome: 'a-b', descricao: 'x', origem: 'dono' }] } });
    assert.deepEqual([todas.filtro, todas.permitidas, todas.ativas, todas.skills[0].permitida], ['todas', null, 1, true]);
  });

  await test('continuidade: só número, tipo (projeto ou decisão), texto (500) e datas; outro tipo de lembrança não passa', () => {
    const v = L.vistaDaContinuidade({
      ligado: true, memoria: true,
      itens: [
        { id: 3, tipo: 'project', texto: `Projeto Yui ${'y'.repeat(700)}`, criadoEm: Date.parse('2026-11-01T00:00:00Z'), atualizadoEm: Date.parse('2026-11-02T00:00:00Z'), user_id: OWNER, tags: SEGREDO },
        { id: 4, tipo: 'decision', texto: 'Usar o OmniRoute.' },
        { id: 5, tipo: 'fact', texto: SEGREDO },
        { id: 'x', tipo: 'project', texto: SEGREDO },
        { id: 6, tipo: 'decision', texto: '' },
      ],
    });
    assert.deepEqual(Object.keys(v).sort(), ['decisoes', 'itens', 'ligado', 'memoria', 'projetos', 'total']);
    assert.deepEqual([v.total, v.projetos, v.decisoes], [2, 1, 1]);
    assert.deepEqual(Object.keys(v.itens[0]).sort(), ['atualizadoEm', 'criadoEm', 'id', 'texto', 'tipo']);
    assert.deepEqual([v.itens[0].id, v.itens[0].tipo, v.itens[0].criadoEm, v.itens[1].tipo], [3, 'projeto', '2026-11-01T00:00:00.000Z', 'decisao']);
    assert.ok(v.itens[0].texto.length <= 500);
    semTexto(v, [SEGREDO, OWNER], 'continuidade');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. As fontes de verdade (pasta temporária)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const store = createListStore({ dir: defaultListDir() });
  await store.addItems(OWNER, 'Mercado', ['leite', 'pão']);
  await store.setDone(OWNER, 'Mercado', 1, true);
  await store.addItems(OWNER, 'Filmes', ['Duna']);
  await store.addItems(OWNER2, 'Segredos', [DO_OUTRO]);
  await store.addItems(MEMBER, 'Do membro', [DO_OUTRO]);

  await test('listas: lê só o arquivo do usuário pedido, sem gravar; ausente e estragado têm situação própria; o estragado NÃO é renomeado', () => {
    const r = lerListasDoUsuario(OWNER, { dir: defaultListDir() });
    assert.equal(r.situacao, 'ok');
    assert.deepEqual(r.listas.map((l) => [l.nome, l.itens.map((i) => `${i.texto}:${i.feito}`).join(',')]), [['Mercado', 'leite:true,pão:false'], ['Filmes', 'Duna:false']]);
    semTexto(r, [DO_OUTRO], 'listas do dono');
    assert.deepEqual(lerListasDoUsuario('444444444444444444', { dir: defaultListDir() }), { situacao: 'ausente', listas: [] });
    const estragado = path.join(defaultListDir(), '555555555555555555.json');
    fs.writeFileSync(estragado, '{ isto não é json');
    assert.deepEqual(lerListasDoUsuario('555555555555555555', { dir: defaultListDir() }), { situacao: 'ilegivel', listas: [] });
    assert.ok(fs.existsSync(estragado), 'o arquivo estragado continua lá (quem conserta é o store, na próxima gravação)');
    assert.deepEqual(fs.readdirSync(defaultListDir()).filter((f) => f.includes('corrompido')), []);
    fs.writeFileSync(estragado, JSON.stringify({ lists: 'x' }));
    assert.equal(lerListasDoUsuario('555555555555555555', { dir: defaultListDir() }).situacao, 'ilegivel');
    fs.writeFileSync(estragado, 'x'.repeat(600 * 1024));
    assert.equal(lerListasDoUsuario('555555555555555555', { dir: defaultListDir() }).situacao, 'ilegivel', 'grande demais nem é lido');
    for (const ruim of ['../111111111111111111', 'abc', '', null]) assert.throws(() => lerListasDoUsuario(ruim, { dir: defaultListDir() }), (e) => e.code === 'USER', String(ruim));
  });

  await test('skills: o catálogo de verdade (duas pastas temporárias) pela vista: válidas, ignorados (scripts e allowed-tools), avisos e a lista de permitidas', () => {
    const cat = carregarCatalogo({ env: process.env, raizes: RAIZES });
    const v = L.vistaDasSkills({ ligado: true, permitidas: ['skill-boa', 'nao-instalada', 'skill-dono'], catalogo: cat });
    assert.deepEqual(v.skills.map((s) => [s.nome, s.origem, s.permitida]), [['outra-skill', 'yui', false], ['skill-boa', 'yui', true], ['skill-dono', 'dono', true]]);
    assert.deepEqual(v.skills[0].ignorados.sort(), ['allowed-tools', 'scripts']);
    assert.equal(v.skills[1].descricao, 'Resume o dia do dono em tópicos curtos.', 'o invisível sai');
    assert.equal(v.skills[1].licenca, 'MIT');
    assert.deepEqual(v.avisos.map((a) => a.motivo).sort(), ['nome_diferente_da_pasta', 'sem_skill_md']);
    assert.deepEqual(v.naoInstaladas, ['nao-instalada']);
    semTexto(v, [SEGREDO, tmp, 'Corpo'], 'skills de verdade');
  });

  await memory.initMemory();
  const ids = {};
  const lembrar = async (ctx, type, content) => {
    memory.remember(ctx, { type, content, source: 'teste' });
    return memory.listMemories(ctx, { limit: 50 }).find((r) => r.content === content).id;
  };
  ids.projeto = await lembrar(ctxDono, 'project', 'Projeto Yui: painel web');
  ids.decisao = await lembrar(ctxDono, 'decision', 'Decidimos usar o OmniRoute no notebook.');
  ids.fato = await lembrar(ctxDono, 'fact', `Fato pessoal ${SEGREDO}`);
  ids.doOutroDono = await lembrar(ctxDe(OWNER2), 'project', `Projeto do outro dono ${DO_OUTRO}`);
  ids.doMembro = await lembrar(buildContext({ platform: 'discord', userId: MEMBER, isDM: true }), 'project', `Projeto do membro ${DO_OUTRO}`);

  await test('continuidade: só os projetos e decisões do PRÓPRIO dono, na memória pessoal; quem não é dono (ou fora da conversa privada) não lê nada', async () => {
    const r = await listarContinuidade(ctxDono, memory);
    assert.deepEqual(r.map((x) => [x.tipo, x.texto]).sort(), [['decision', 'Decidimos usar o OmniRoute no notebook.'], ['project', 'Projeto Yui: painel web']]);
    semTexto(r, [SEGREDO, DO_OUTRO], 'continuidade do dono');
    assert.deepEqual(await listarContinuidade(buildContext({ platform: 'discord', userId: MEMBER, isDM: true }), memory), []);
    assert.deepEqual(await listarContinuidade(buildContext({ platform: 'discord', userId: OWNER, channelId: '999999999999999999' }), memory), [], 'dono em canal público: nada');
  });

  await test('apagar: só projeto ou decisão do próprio dono; fato, item de outro dono, número inválido ou contexto errado: nada sai', async () => {
    assert.deepEqual(await apagarDaContinuidade(ctxDono, memory, ids.fato), { apagado: false });
    assert.deepEqual(await apagarDaContinuidade(ctxDono, memory, ids.doOutroDono), { apagado: false });
    for (const ruim of [0, -1, 'x', 1.5, null]) assert.deepEqual(await apagarDaContinuidade(ctxDono, memory, ruim), { apagado: false }, String(ruim));
    assert.deepEqual(await apagarDaContinuidade(buildContext({ platform: 'discord', userId: MEMBER, isDM: true }), memory, ids.doMembro), { apagado: false }, 'membro não usa');
    const todas = memory.listMemories(ctxDono, { limit: 50 }).map((r) => r.id);
    assert.ok(todas.includes(ids.fato) && todas.includes(ids.projeto) && todas.includes(ids.decisao), 'nada foi apagado');
    assert.ok(memory.listMemories(ctxDe(OWNER2), { limit: 50 }).some((r) => r.id === ids.doOutroDono));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. As rotas HTTP de verdade');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const leituras = L.criarLeiturasPadrao({ env: process.env, raizesDasSkills: RAIZES });
  server = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_OWNER2}=${OWNER2},${T_MEMBER}=${MEMBER}`), admin: createAdmin({ leituras, deps: { integrationData: async () => ({}) } }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (method, rota, token, corpo) => {
    const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(corpo ?? {}) });
    return { status: res.status, headers: res.headers, texto: await res.text() };
  };
  const LEITURAS = ['/v1/admin/listas', '/v1/admin/skills', '/v1/admin/continuidade'];

  await test('o dono lê as três (200, JSON, sem cache): as listas DELE, as skills e os projetos e decisões dele; nada de outra pessoa, do corpo das skills nem caminho', async () => {
    const d = {};
    for (const rota of LEITURAS) {
      const r = await chamar('GET', rota, T_OWNER);
      assert.equal(r.status, 200, `${rota}: ${r.texto}`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      semTexto(r.texto, [DO_OUTRO, SEGREDO, tmp.replace(/\\/g, '\\\\'), OWNER, 'Corpo da skill'], rota);
      d[rota] = JSON.parse(r.texto);
    }
    const listas = d['/v1/admin/listas'];
    assert.deepEqual([listas.ligado, listas.situacao, listas.listas.map((l) => `${l.nome}:${l.total}:${l.feitos}`)], [true, 'ok', ['Filmes:1:0', 'Mercado:2:1']]);
    const skills = d['/v1/admin/skills'];
    assert.deepEqual([skills.ligado, skills.filtro, skills.total, skills.ativas, skills.naoInstaladas], [true, 'lista', 3, 2, ['nao-instalada']]);
    const cont = d['/v1/admin/continuidade'];
    assert.deepEqual([cont.ligado, cont.memoria, cont.projetos, cont.decisoes], [true, true, 1, 1]);
    assert.deepEqual(cont.itens.map((i) => i.id).sort((a, b) => a - b), [ids.projeto, ids.decisao].sort((a, b) => a - b));
    // o segundo dono vê só as dele
    const doOutro = JSON.parse((await chamar('GET', '/v1/admin/listas', T_OWNER2)).texto);
    assert.deepEqual(doOutro.listas.map((l) => l.nome), ['Segredos']);
    assert.deepEqual(JSON.parse((await chamar('GET', '/v1/admin/continuidade', T_OWNER2)).texto).itens.map((i) => i.id), [ids.doOutroDono]);
  });

  await test('quem não é o dono: 403 sem nenhum dado e sem apagar; sem token ou token errado: 401; métodos que não existem: 404', async () => {
    for (const rota of LEITURAS) {
      const membro = await chamar('GET', rota, T_MEMBER);
      assert.equal(membro.status, 403, rota);
      assert.ok(!/listas|skills|itens|Mercado|skill-boa|Projeto/.test(membro.texto), `${rota}: ${membro.texto}`);
      assert.equal((await chamar('GET', rota, null)).status, 401, rota);
      assert.equal((await chamar('GET', rota, 'token-errado-0123456789abcdef')).status, 401, rota);
      for (const metodo of ['POST', 'PUT']) assert.equal((await chamar(metodo, rota, T_OWNER, { confirm: true })).status, 404, `${metodo} ${rota}`);
    }
    for (const rota of ['/v1/admin/listas', '/v1/admin/skills', '/v1/admin/continuidade']) assert.equal((await chamar('DELETE', rota, T_OWNER, { confirm: true })).status, 404, `DELETE ${rota}`);
    const r = await chamar('DELETE', `/v1/admin/continuidade/${ids.projeto}`, T_MEMBER, { confirm: true });
    assert.equal(r.status, 403);
    assert.equal((await chamar('DELETE', `/v1/admin/continuidade/${ids.projeto}`, null, { confirm: true })).status, 401);
    assert.ok(memory.listMemories(ctxDono, { limit: 50 }).some((x) => x.id === ids.projeto), 'o membro não apagou nada');
  });

  await test('apagar: sem confirm 400; fato, item de outro dono ou que não existe 404; com confirm apaga SÓ aquele; a auditoria guarda só o tipo', async () => {
    const semConfirm = await chamar('DELETE', `/v1/admin/continuidade/${ids.decisao}`, T_OWNER, {});
    assert.equal(semConfirm.status, 400);
    assert.match(JSON.parse(semConfirm.texto).error, /confirm/);
    for (const id of [ids.fato, ids.doOutroDono, 999999]) assert.equal((await chamar('DELETE', `/v1/admin/continuidade/${id}`, T_OWNER, { confirm: true })).status, 404, String(id));
    assert.equal((await chamar('DELETE', '/v1/admin/continuidade/abc', T_OWNER, { confirm: true })).status, 404, 'número inválido nem casa a rota');
    const antes = memory.listMemories(ctxDono, { limit: 50 }).length;
    const ok = await chamar('DELETE', `/v1/admin/continuidade/${ids.decisao}`, T_OWNER, { confirm: true });
    assert.equal(ok.status, 200, ok.texto);
    assert.deepEqual(JSON.parse(ok.texto), { ok: true });
    const depois = memory.listMemories(ctxDono, { limit: 50 });
    assert.equal(depois.length, antes - 1);
    assert.ok(!depois.some((x) => x.id === ids.decisao) && depois.some((x) => x.id === ids.projeto) && depois.some((x) => x.id === ids.fato));
    assert.ok(memory.listMemories(ctxDe(OWNER2), { limit: 50 }).some((x) => x.id === ids.doOutroDono), 'o do outro dono continua');
    assert.equal((await chamar('DELETE', `/v1/admin/continuidade/${ids.decisao}`, T_OWNER, { confirm: true })).status, 404, 'já apagado');
    const linhas = fs.readFileSync(AUDIT, 'utf8').split('\n').filter((l) => l.includes('admin.continuidade.remove'));
    assert.equal(linhas.length, 1);
    const ev = JSON.parse(linhas[0]);
    assert.equal(ev.tipo, 'decisao');
    semTexto(linhas[0], ['OmniRoute', 'Decidimos'], 'auditoria');
  });

  await test('routeGuard: as leituras ficam fora (como as outras leituras do painel); o apagar entra como memory.forget_item e o enforce deixa o dono', () => {
    for (const rota of LEITURAS) assert.equal(actionForRoute('GET', rota), null, rota);
    assert.equal(actionForRoute('DELETE', '/v1/admin/continuidade/12'), 'memory.forget_item');
    assert.equal(actionForRoute('DELETE', '/v1/admin/continuidade/abc'), null);
    const antes = process.env.YUI_POLICY_MODE;
    process.env.YUI_POLICY_MODE = 'enforce';
    try {
      assert.equal(guardRoute({ ctx: ctxDono, method: 'DELETE', pathname: '/v1/admin/continuidade/12', local: false, auditFn: () => {} }), null, 'o dono pelo app passa');
      process.env.YUI_READ_ONLY = 'true';
      const bloqueio = guardRoute({ ctx: ctxDono, method: 'DELETE', pathname: '/v1/admin/continuidade/12', local: false, auditFn: () => {} });
      assert.equal(bloqueio, null, 'memory.forget_item não "modifica" o computador: apagar a própria memória vale como no DELETE /v1/memory/:id');
    } finally {
      process.env.YUI_POLICY_MODE = antes;
      delete process.env.YUI_READ_ONLY;
    }
  });

  await test('memória desligada: a continuidade não lê nem apaga (memoria: false; DELETE 503) e nada some', async () => {
    process.env.YUI_MEMORY_ENABLED = 'false';
    try {
      const v = JSON.parse((await chamar('GET', '/v1/admin/continuidade', T_OWNER)).texto);
      assert.deepEqual([v.memoria, v.itens], [false, []]);
      assert.equal((await chamar('DELETE', `/v1/admin/continuidade/${ids.projeto}`, T_OWNER, { confirm: true })).status, 503);
    } finally { process.env.YUI_MEMORY_ENABLED = 'true'; }
    assert.ok(memory.listMemories(ctxDono, { limit: 50 }).some((x) => x.id === ids.projeto));
  });

  await test('listas desligadas (YUI_LISTS_ENABLED=false): mostra o que existe, com ligado: false; continuidade desligada idem', async () => {
    process.env.YUI_LISTS_ENABLED = 'false';
    process.env.YUI_CONTINUIDADE = 'false';
    try {
      const l = JSON.parse((await chamar('GET', '/v1/admin/listas', T_OWNER)).texto);
      assert.deepEqual([l.ligado, l.total], [false, 2]);
      const c = JSON.parse((await chamar('GET', '/v1/admin/continuidade', T_OWNER)).texto);
      assert.deepEqual([c.ligado, c.total], [false, 1]);
    } finally { process.env.YUI_LISTS_ENABLED = 'true'; process.env.YUI_CONTINUIDADE = 'true'; }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O cérebro separado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('no cérebro, listas, skills e continuidade (ler e apagar) rodam NO CÉREBRO, sem nenhum pedido ao bot; o membro é barrado', async () => {
    const pedidos = [];
    const canal = { isConnected: () => true, emit() {}, request: async (...a) => { pedidos.push(a); return {}; } };
    const a = createCerebroAdmin({ channel: canal, leituras });
    assert.equal((await a.listas(ctxDono)).total, 2);
    assert.equal((await a.skills(ctxDono)).total, 3);
    const c = await a.continuidade(ctxDono);
    assert.deepEqual(c.itens.map((i) => i.id), [ids.projeto]);
    assert.deepEqual(await a.removerContinuidade(ctxDono, ids.projeto, { confirm: true }), { ok: true });
    assert.equal((await a.continuidade(ctxDono)).total, 0);
    for (const metodo of ['listas', 'skills', 'continuidade']) await assert.rejects(a[metodo](ctxDe(MEMBER)), (e) => e.status === 403, metodo);
    await assert.rejects(a.removerContinuidade(ctxDe(MEMBER), ids.fato, { confirm: true }), (e) => e.status === 403);
    assert.deepEqual(pedidos, [], 'nada disso vai ao bot');
    for (const k of ['listas', 'skills', 'continuidade', 'removerContinuidade']) assert.ok(!Object.hasOwn(PANEL_ACTIONS, k), `${k} fora do PANEL_ACTIONS`);
  });

  await test('registrado no package.json, no CI (SUITES) e no README_TESTES.md', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts['test:paineltransparencia'], 'node tests/test-painel-transparencia.js');
    assert.match(fs.readFileSync(path.join(repoRoot, 'scripts', 'run-ci.mjs'), 'utf8'), /'test:paineltransparencia'/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'README_TESTES.md'), 'utf8'), /\| `test:paineltransparencia` \|/);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 300)); // deixa os soquetes fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
