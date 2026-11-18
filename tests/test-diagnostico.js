// Etapa 8, item 3: o ENDPOINT do diagnóstico da aba do app (GET /v1/admin/diagnostico; src/core/diagnostico.js) e a prova de que NENHUM conteúdo privado
// aparece nele. Execução: npm run test:diagnostico
//
// A. As sanitizações (soNumeros, classificarErro) e o FORMATO fixo da resposta (as chaves de cada seção): um campo novo só entra de propósito.
// B. PRIVACIDADE: cada fonte é ENVENENADA com um segredo (texto de conversa privada, ids de pessoas e de servidor, chave de provedor, caminho de
//    arquivo, mensagem de erro, etiqueta de log montada com texto de fora) e a resposta inteira é conferida: nenhum deles sai. A armadilha é
//    conferida ANTES (o segredo está mesmo na fonte), com o roteador de IA de verdade falhando com um erro que repete o segredo.
// C. O estado geral (ok, atenção, problema) e os motivos.
// D. A rota HTTP de verdade: só o dono (membro 403, sem token 401), só GET, resposta sem cache, e ler não gasta nada (cota, roteador).
// E. O cérebro separado: o createCerebroAdmin com um canal falso (bot conectado, bot fora, membro barrado antes de falar com o bot).
// SEM rede, SEM bancos reais, SEM .env, SEM logs reais (pasta temporária e cwd temporário). O processo de verdade (cérebro + bot) é conferido no
// test:steamjogo, que também lê esta rota no cérebro depois dos cenários com conteúdo privado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-diagnostico-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const SEGREDO = 'tok-SEGREDO-PRIVADO-9f3a';
const CHAVE = 'gsk_chave_falsa_so_para_o_teste_1234567890';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';

const logDir = path.join(tmp, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const pad = (n) => String(n).padStart(2, '0');
const agoraLocal = new Date(Date.now() - 60_000);
const dia = `${agoraLocal.getFullYear()}-${pad(agoraLocal.getMonth() + 1)}-${pad(agoraLocal.getDate())}`;
const ts = `${dia} ${pad(agoraLocal.getHours())}:${pad(agoraLocal.getMinutes())}:${pad(agoraLocal.getSeconds())}`;
// os logs "reais" deste teste: linhas de erro que repetem o segredo e o id do dono (a resposta só pode ter a ETIQUETA e a contagem)
fs.writeFileSync(path.join(logDir, `error-${dia}.log`), [
  `[${ts}] [error] [IA] Todos os provedores falharam para ${OWNER}: ${SEGREDO}`,
  `[${ts}] [error] [IA] Outra falha: ${SEGREDO}`,
  `[${ts}] [error] [IA] Mais uma: ${SEGREDO}`,
  `[${ts}] [error] [Search] busca falhou: ${SEGREDO}`,
  `[${ts}] [error] [Search] busca falhou de novo: ${SEGREDO}`,
  `[${ts}] [error] [tok-segredo-etiqueta] linha cuja etiqueta é texto de fora ${SEGREDO}`,
].join('\n'));
fs.writeFileSync(path.join(logDir, `app-${dia}.log`), [`[${ts}] [info] Conexão retomada com o Discord ${SEGREDO}`, `[${ts}] [info] Conexão retomada de novo`].join('\n'));

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
  YUI_LOG_DIR: logDir, YUI_POLICY_MODE: 'observe', GROQ_API_KEY: CHAVE, YUI_AI_SETTINGS_FILE: path.join(tmp, 'secrets', 'ai-providers.json'),
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_CEREBRO_EXTERNO', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'AI_MAX_TOKENS', 'AI_BACKEND', 'YUI_GATEWAY_DISABLE', 'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY', 'YUI_GATEWAY_CUSTOM', 'YUI_COTA_HORA_DISCO', 'YUI_READ_ONLY', 'OWNER_ID', 'OWNER_IDS']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const diag = await imp('src/core/diagnostico.js');
const { createRouter } = await imp('src/gateway/router.js');
const { createAdmin } = await imp('src/core/api/admin.js');
const { createCerebroAdmin } = await imp('src/cerebro/painel.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { getDefaultBudget, createBudget } = await imp('src/search/budget.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const chaves = (o) => Object.keys(o).sort();

/** As fontes "limpas": um estado saudável e conhecido (sem depender do ambiente). */
const gwStatus = (extra = {}) => ({
  totals: { requests: 10, ok: 9, failed: 1 }, combos: [],
  providers: [{ id: 'groq', label: 'Groq', anonymous: false, priority: 10, keys: 1, keysCoolingDown: 0, cooldownSeconds: 0, targets: [{ id: 'groq/m', model: 'openai/gpt-oss-120b', tier: 'smart', available: true, cooldownSeconds: 0, failures: 0, ok: 9, fail: 1, lastError: null, lastOkSecondsAgo: 12 }] }],
  ...extra,
});
const fontesLimpas = (extra = {}) => ({
  processo: () => ({ uptimeSegundos: 42, memoriaMB: 120 }),
  backends: () => [{ name: 'gateway', local: false, active: true }, { name: 'legacy-chain', local: false, active: false }],
  gateway: () => ({ status: gwStatus(), algumDisponivel: true }),
  limites: () => ({
    teto: 4096,
    discord: [{ provedor: 'groq', limite: 1024, configurado: 1024, capacidade: 8192, origem: 'padrão da cadeia do bot' }],
    app: [{ provedor: 'groq', limite: 1500, configurado: 1500, capacidade: 8192, origem: 'AI_MAX_TOKENS' }],
    erro: null,
  }),
  cota: () => ({
    global: { usadas: 3, limite: 20, cheia: false, liberaEmSegundos: 0 }, porPessoaLimite: 5,
    hora: { persistente: true, gravacoes: 4, falhas: 0, carregadas: 2, gravacaoComFalha: false, reutilizadas: 2 },
    dono: { papel: 'unico', dono: 'unico', ligada: true, aguardandoTrava: false, perdida: false, codigo: null, pesquisaDisponivel: true },
    mes: [{ provedor: 'duckduckgo', usadas: 7, teto: 0 }],
  }),
  avisos: () => [],
  erros: () => ({ errors: 2, reconnects: 1, byTag: { IA: 2 } }),
  bancos: () => [{ name: 'core', engine: 'sqljs', sizes: { db: 1048576, wal: 0, shm: 0 }, errors: 0, busy: 0, openFailures: 0 }],
  ...extra,
});
const cerebroLimpo = (extra = {}) => ({
  uptimeSegundos: 99, backend: 'gateway', ponteDoBot: false, botConectado: true, discordOnline: true, reservaPercentual: 20,
  canal: { connected: 1, idemEntries: 4 }, conversa: { open: 0, queues: 0 }, pesquisa: { pedidos: 2 }, retomada: { ligada: true, interrompidas: 0, porEstado: { pending: 0, running: 0, completed: 1, uncertain: 0 } },
  comentarios: { pedidos: 3, respondidos: 3 }, lembretes: { tickMs: 60000 }, travasPerdidas: 0,
  ...extra,
});
const montar = (extra = {}, modo = 'unico', cerebro = null) => diag.montarDiagnostico({ modo, fontes: { ...fontesLimpas(extra), ...(cerebro ? { cerebro } : {}) } });

let server = null;
try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. As sanitizações e o formato fixo da resposta');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('soNumeros guarda só número e booleano (strings, listas, ids e hashes como chave somem)', () => {
    assert.deepEqual(diag.soNumeros({
      a: 1, b: true, c: 'texto', d: [1, 2], e: { f: 2, g: 'x', h: { i: 3 } }, [OWNER]: 5, abcdef0123456789abcdef: 4, 'chave com espaço': 1, nulo: null, nan: NaN, dentro: { [MEMBER]: 1 },
    }), { a: 1, b: true, e: { f: 2, h: { i: 3 } } });
    assert.deepEqual(diag.soNumeros(null), {});
    assert.deepEqual(diag.soNumeros('texto'), {});
    assert.deepEqual(diag.soNumeros([1, 2]), {});
  });

  await test('classificarErro troca o texto do erro de um provedor por um TIPO e um código HTTP (nunca o texto)', () => {
    const casos = [
      ['HTTP 429: quota excedida', { tipo: 'cota', status: 429 }],
      ['HTTP 401 unauthorized', { tipo: 'autenticacao', status: 401 }],
      ['HTTP 403: chave inválida', { tipo: 'autenticacao', status: 403 }],
      ['tempo esgotado esperando o provedor', { tipo: 'tempo', status: null }],
      ['fetch failed', { tipo: 'rede', status: null }],
      ['HTTP 503 Service Unavailable', { tipo: 'servidor', status: 503 }],
      ['HTTP 404 não achei', { tipo: 'http', status: 404 }],
      [`algo estranho com ${SEGREDO}`, { tipo: 'outro', status: null }],
      [null, null],
      ['', null],
    ];
    for (const [texto, esperado] of casos) {
      const r = diag.classificarErro(texto);
      assert.deepEqual(r, esperado, String(texto));
      assert.ok(!JSON.stringify(r ?? {}).includes(SEGREDO));
    }
  });

  await test('o FORMATO: as chaves de cada seção são exatamente as documentadas (no processo único e com o cérebro)', () => {
    const u = montar();
    // etapa 9: as seções novas dos perfis de IA e do motor do agente (os detalhes delas estão no test:perfisiaunidade e no test:perfisiarota)
    assert.deepEqual(chaves(u), ['avisosDeConfiguracao', 'bancos', 'cerebro', 'cotasDeBusca', 'erros', 'estado', 'geradoEm', 'ia', 'limitesDeTokens', 'modo', 'motivos', 'motorAgente', 'perfisDeIa', 'processo', 'versao']);
    assert.deepEqual(chaves(u.perfisDeIa), ['configurado', 'errosDeConfiguracao', 'origem', 'perfis', 'rotaPrivada', 'totais', 'ultimas']);
    assert.equal(u.perfisDeIa.rotaPrivada.estado, 'desligada', 'sem perfis configurados a rota privada está desligada');
    assert.deepEqual(chaves(u.motorAgente), ['ativo', 'implementados', 'motivo', 'pedido', 'recusado']);
    assert.equal(u.versao, 1);
    assert.equal(u.modo, 'unico');
    assert.equal(u.cerebro, null, 'no processo único não há seção do cérebro');
    assert.deepEqual(chaves(u.processo), ['memoriaMB', 'uptimeSegundos']);
    assert.deepEqual(chaves(u.ia), ['algumDisponivel', 'backendAtivo', 'backends', 'gatewayConfigurado', 'provedorAtual', 'provedores', 'totais']);
    assert.deepEqual(chaves(u.ia.backends[0]), ['ativo', 'local', 'nome']);
    assert.deepEqual(chaves(u.ia.provedores[0]), ['alvos', 'anonimo', 'chaves', 'chavesEmDescanso', 'descansoSegundos', 'id', 'prioridade', 'rotulo']);
    assert.deepEqual(chaves(u.ia.provedores[0].alvos[0]), ['acertos', 'descansoSegundos', 'disponivel', 'falhas', 'falhasSeguidas', 'modelo', 'ultimoErro', 'ultimoOkHaSegundos']);
    assert.deepEqual(chaves(u.limitesDeTokens), ['app', 'discord', 'erroDeConfiguracao', 'teto']);
    assert.deepEqual(chaves(u.limitesDeTokens.app.provedores[0]), ['capacidade', 'configurado', 'limite', 'origem', 'provedor']);
    assert.deepEqual(chaves(u.cotasDeBusca), ['hora', 'mes', 'reservaPercentual']);
    assert.deepEqual(chaves(u.cotasDeBusca.hora), ['global', 'persistencia', 'porPessoaLimite', 'reutilizadas']);
    assert.equal(u.cotasDeBusca.hora.reutilizadas, 2, 'as reutilizações (só um número)');
    assert.deepEqual(chaves(u.cotasDeBusca.hora.global), ['cheia', 'liberaEmSegundos', 'limite', 'usadas']);
    assert.deepEqual(chaves(u.cotasDeBusca.hora.persistencia), ['aguardandoTrava', 'buscasQueVoltaram', 'dono', 'falhasDeGravacao', 'gravacaoComFalha', 'gravacoes', 'gravando', 'motivo', 'papel', 'perdeuATrava', 'pesquisaDisponivel']);
    assert.equal(u.cotasDeBusca.hora.persistencia.pesquisaDisponivel, true);
    assert.deepEqual(chaves(u.cotasDeBusca.mes[0]), ['provedor', 'teto', 'usadas']);
    assert.deepEqual(chaves(u.erros), ['porEtiqueta', 'reconexoesDoDiscord24h', 'ultimas24h']);
    assert.deepEqual(chaves(u.bancos), ['comAlerta', 'motores', 'tamanhoTotalMB', 'total']);
    const c = montar({}, 'cerebro-separado', cerebroLimpo());
    assert.equal(c.modo, 'cerebro-separado');
    assert.deepEqual(chaves(c.cerebro), ['backend', 'botConectado', 'canal', 'comentarios', 'conversa', 'discordOnline', 'lembretes', 'pesquisa', 'ponteDoBot', 'retomadaDaPesquisa', 'travasPerdidas', 'uptimeSegundos']);
    assert.equal(c.cotasDeBusca.reservaPercentual, 20, 'a reserva da cota vem do cérebro');
    assert.equal(c.limitesDeTokens.discord.aplica, true);
    assert.equal(u.limitesDeTokens.discord.aplica, false, 'no processo único o Discord não usa esta tabela');
    // o que o app precisa mostrar está lá, com os números certos
    assert.equal(c.ia.provedorAtual, 'groq');
    assert.equal(c.ia.backendAtivo, 'gateway');
    assert.equal(c.cotasDeBusca.hora.global.usadas, 3);
    assert.equal(c.cotasDeBusca.hora.persistencia.gravando, true);
    assert.equal(c.limitesDeTokens.app.provedores[0].limite, 1500);
    assert.equal(c.estado, 'ok');
    assert.deepEqual(c.motivos, []);
  });

  await test('as fontes de verdade do Core (sem nenhuma injeção) compõem a resposta sem lançar e sem expor a chave do provedor', () => {
    const d = diag.montarDiagnostico({});
    assert.equal(d.versao, 1);
    assert.ok(d.ia.provedores.some((p) => p.id === 'groq'), 'o provedor configurado no ambiente aparece');
    assert.equal(d.ia.provedores.find((p) => p.id === 'groq').chaves, 1, 'só QUANTAS chaves, nunca a chave');
    assert.ok(!JSON.stringify(d).includes(CHAVE));
    assert.ok(d.limitesDeTokens.app.provedores.length >= 1);
    assert.equal(typeof d.cotasDeBusca.hora.global.limite, 'number');
    // uma fonte que lança vira uma seção vazia, não um erro
    const quebrada = diag.montarDiagnostico({ fontes: { gateway: () => { throw new Error(`erro com ${SEGREDO}`); }, erros: () => { throw new Error('x'); }, bancos: () => { throw new Error('x'); } } });
    assert.equal(quebrada.ia.provedores.length, 0);
    assert.equal(quebrada.erros.ultimas24h, 0);
    assert.ok(!JSON.stringify(quebrada).includes(SEGREDO));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. PRIVACIDADE: nada de conversa, pesquisa privada, ids de pessoas, segredos, caminhos nem texto de erro');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('com TODAS as fontes envenenadas, a resposta inteira não tem nenhum dos segredos (a armadilha é conferida antes)', async () => {
    // O roteador de IA de VERDADE falhando com um erro que repete o segredo (o texto fica no `lastError` dele)
    const roteador = createRouter({
      providers: [{ id: 'alfa', label: `Alfa\u0000\n${' '.repeat(3)}com\tquebra`, priority: 10, endpoint: 'https://alfa.test/v1/chat/completions', keys: ['alfa-key-0001-aaaaaaaa'], headers: {}, models: [{ id: 'a-big', tier: 'smart' }] }],
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: `erro do provedor para ${OWNER}: ${SEGREDO}` } }), { status: 500, headers: { 'content-type': 'application/json' } }),
      maxAttempts: 1,
    });
    await roteador.chat({ model: 'auto', messages: [{ role: 'user', content: `pergunta privada ${SEGREDO}` }] }).catch(() => {});
    const status = roteador.status();
    assert.ok(JSON.stringify(status).includes(SEGREDO), 'a armadilha está armada: o lastError do roteador TEM o segredo');
    assert.equal(status.providers[0].targets[0].fail >= 1, true);

    const envenenadas = fontesLimpas({
      gateway: () => ({ status, algumDisponivel: roteador.anyAvailable() }),
      avisos: () => [{ variavel: 'AI_MAX_TOKENS', problema: 'inválido (precisa ser um número inteiro a partir de 64)', usando: 1500 }, { variavel: SEGREDO, problema: 'x', usando: 'y' }, { variavel: OWNER, problema: 'x', usando: 'y' }],
      limites: () => ({ teto: 4096, discord: [{ provedor: OWNER, limite: 1, configurado: 1, capacidade: 1, origem: 'x' }, { provedor: 'groq', limite: 512, configurado: 512, capacidade: 8192, origem: 'padrão' }], app: [], erro: SEGREDO }),
      backends: () => [{ name: 'gateway', active: true, local: false }, { name: OWNER, active: false, local: false }, { name: 'fora do padrão com espaço', active: false }],
      cota: () => ({
        global: { usadas: 1, limite: 20, cheia: false, liberaEmSegundos: 0 }, porPessoaLimite: 5,
        hora: { persistente: true, gravacoes: 1, falhas: 0, carregadas: 0, ultimoErro: SEGREDO, arquivo: path.join(tmp, 'secrets', 'search-budget-hora.json') },
        dono: { papel: 'cerebro', dono: 'cerebro', ligada: true, aguardandoTrava: false, perdida: false, codigo: null, arquivo: path.join(tmp, 'secrets'), motivo: `trava de ${SEGREDO} PID 1234` },
        mes: [{ provedor: 'duckduckgo', usadas: 1, teto: 0 }, { provedor: `consulta ${SEGREDO}`, usadas: 1, teto: 0 }],
      }),
      erros: () => diag.fontesPadrao(process.env).erros(), // o log DE VERDADE deste teste (lido da pasta temporária)
      bancos: () => [{ name: 'core', engine: 'sqljs', sizes: { db: 10, wal: 0, shm: 0 }, errors: 2, lastError: { code: 'X', message: `SQL com '${SEGREDO}'` }, busy: 0, openFailures: 0 }],
    });
    const cerebro = {
      uptimeSegundos: 5, backend: 'gateway', ponteDoBot: false, botConectado: true, discordOnline: true, reservaPercentual: 20, travasPerdidas: 0,
      canal: { connected: 1, open: 2, lockedUntil: SEGREDO, conexoes: [{ role: 'bot', connectionId: SEGREDO }], ultimoErro: SEGREDO, porPessoa: { [OWNER]: 3, [MEMBER]: 1, a1b2c3d4e5f6a7b8c9d0e1f2: 2, pessoas: 4 } },
      conversa: { open: 1, [GUILD]: 7, ultimaPergunta: `quanto custa ${SEGREDO}?`, filas: { [OTHER]: 2, total: 2 } },
      pesquisa: { pedidos: 3, consulta: `pesquisa privada ${SEGREDO}`, privadas: 1 },
      retomada: { ligada: true, interrompidas: 1, chave: SEGREDO, porEstado: { pending: 0, running: 0, completed: 2, uncertain: 1 } },
      comentarios: { pedidos: 4, nomeDoJogo: SEGREDO, porTipo: { steam: 2, cotacao: 2 } },
      lembretes: { tickMs: 60000, entrega: { incertos: [1, 2], texto: SEGREDO, quantos: 2 } },
    };
    const d = diag.montarDiagnostico({ modo: 'cerebro-separado', fontes: { ...envenenadas, cerebro } });
    const texto = JSON.stringify(d);
    for (const [nome, proibido] of [['o segredo', SEGREDO], ['o id do dono', OWNER], ['o id do membro', MEMBER], ['o id de outra pessoa', OTHER], ['o id do servidor', GUILD],
      ['a chave do provedor', CHAVE], ['a chave do roteador', 'alfa-key-0001'], ['um hash de pessoa', 'a1b2c3d4e5f6a7b8c9d0e1f2'], ['o caminho temporário', tmp], ['a pasta do usuário', os.homedir()],
      ['o nome do arquivo da cota', 'search-budget'], ['o texto do erro do provedor', 'erro do provedor'], ['a pergunta', 'quanto custa'], ['a pesquisa', 'pesquisa privada']]) {
      assert.ok(!texto.includes(proibido), `vazou ${nome}: ${proibido}`);
    }
    assert.doesNotMatch(texto, /\d{12,}/, 'nenhuma sequência de 12 ou mais dígitos (id do Discord)');
    assert.doesNotMatch(texto, /[A-Za-z]:\\\\|\/home\/|\/Users\//, 'nenhum caminho de arquivo');
    // o que PODE aparecer, e como: o erro vira tipo + código; a etiqueta do log é só a palavra do módulo; o rótulo é uma linha
    const erro = d.ia.provedores[0].alvos[0].ultimoErro;
    assert.deepEqual(erro, { tipo: 'servidor', status: 500 }, JSON.stringify(erro));
    assert.equal(d.ia.provedores[0].rotulo, 'Alfa com quebra');
    assert.deepEqual(d.avisosDeConfiguracao.map((a) => a.variavel), ['AI_MAX_TOKENS'], 'só nome de variável do .env');
    assert.deepEqual(d.limitesDeTokens.discord.provedores.map((p) => p.provedor), ['groq'], 'um id de pessoa nunca vira nome de provedor');
    assert.deepEqual(d.ia.backends.map((b) => b.nome), ['gateway'], 'nem de backend');
    assert.deepEqual(d.cotasDeBusca.mes.map((m) => m.provedor), ['duckduckgo']);
    assert.equal(d.cotasDeBusca.hora.persistencia.motivo, null);
    assert.equal(d.erros.ultimas24h, 6, 'os erros do log de verdade foram contados');
    assert.deepEqual(d.erros.porEtiqueta, [{ etiqueta: 'IA', quantidade: 3 }, { etiqueta: 'Search', quantidade: 2 }, { etiqueta: 'outras', quantidade: 1 }], 'só a etiqueta do módulo; a de texto de fora vira "outras"');
    assert.equal(d.erros.reconexoesDoDiscord24h, 2);
    assert.deepEqual(d.cerebro.canal, { connected: 1, open: 2, porPessoa: { pessoas: 4 } }, 'só números; nenhum mapa por pessoa com id');
    assert.deepEqual(d.cerebro.conversa, { open: 1, filas: { total: 2 } });
    assert.deepEqual(d.cerebro.pesquisa, { pedidos: 3, privadas: 1 });
    assert.deepEqual(d.cerebro.retomadaDaPesquisa, { ligada: true, interrompidas: 1, porEstado: { pending: 0, running: 0, completed: 2, uncertain: 1 } });
    assert.deepEqual(d.cerebro.comentarios, { pedidos: 4, porTipo: { steam: 2, cotacao: 2 } });
    // o roteador de verdade falhou na única tentativa: nenhum modelo disponível agora (problema), além dos avisos
    assert.equal(d.estado, 'problema');
    assert.deepEqual(d.motivos.map((m) => m.codigo), ['sem-provedor-de-ia', 'config-invalida', 'pesquisas-incertas', 'banco-com-alerta']);
  });

  await test('nenhum log de erro ou aviso do código monta a ETIQUETA com texto de fora (a etiqueta que o diagnóstico mostra é sempre a do módulo)', () => {
    const achados = [];
    const varre = (dir) => {
      for (const d of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = path.join(dir, d.name);
        if (d.isDirectory()) { varre(rel); continue; }
        if (!/\.(js|mjs)$/.test(d.name)) continue;
        const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        // logger.error(`[${algo}] ...`) / logger.warn('[' + x ...): a etiqueta (o 1º colchete) vinda de uma variável
        // Única exceção conferida: o `label` do src/utils/voiceSafety.js, que os chamadores passam como texto fixo ('VOICE', 'Radio', 'RadioPlayer', 'RadioVoice').
        for (const m of src.matchAll(/\b(?:logger|log|emit|defaultLogger)\.(?:error|warn)\??\.?\(\s*(?:`\[\$\{(?!label\})|['"]\['\s*\+)/g)) achados.push(`${rel}: ${m[0]}`);
      }
    };
    varre('src');
    assert.deepEqual(achados, []);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. O estado geral e os motivos');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('ok, atenção e problema: cada situação com o seu motivo (palavra fixa e frase)', () => {
    assert.equal(montar().estado, 'ok');
    const sem = (extra, cerebro = null, modo = 'unico') => montar(extra, modo, cerebro);
    const motivos = (d) => d.motivos.map((m) => m.codigo);
    // problema: nenhum provedor de IA disponível
    const indisponivel = sem({ gateway: () => ({ status: gwStatus({ providers: [{ ...gwStatus().providers[0], targets: [{ ...gwStatus().providers[0].targets[0], available: false, cooldownSeconds: 60 }] }] }), algumDisponivel: false }) });
    assert.equal(indisponivel.estado, 'problema');
    assert.deepEqual(motivos(indisponivel), ['sem-provedor-de-ia']);
    assert.equal(indisponivel.ia.provedorAtual, null);
    assert.equal(indisponivel.ia.provedores[0].alvos[0].descansoSegundos, 60);
    // problema: trava perdida (cota por hora)
    const perdida = sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: false }, dono: { papel: 'unico', dono: 'unico', ligada: false, perdida: true, codigo: 'perdida' }, mes: [] }) });
    assert.equal(perdida.estado, 'problema');
    assert.deepEqual(motivos(perdida), ['trava-perdida']);
    assert.equal(perdida.cotasDeBusca.hora.persistencia.motivo, 'perdida');
    // atenção: bot fora, Discord fora, aguardando a trava da cota, cota cheia, erros, configuração
    const bot = sem({}, cerebroLimpo({ botConectado: false, discordOnline: null }), 'cerebro-separado');
    assert.equal(bot.estado, 'atencao');
    assert.deepEqual(motivos(bot), ['bot-desconectado']);
    assert.deepEqual(motivos(sem({}, cerebroLimpo({ discordOnline: false }), 'cerebro-separado')), ['discord-fora']);
    const aguardando = sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: false }, dono: { papel: 'cerebro', dono: 'cerebro', ligada: false, aguardandoTrava: true, codigo: 'trava-de-outro-processo' }, mes: [] }) });
    assert.deepEqual(motivos(aguardando), ['cota-sem-disco']);
    assert.deepEqual(motivos(sem({ cota: () => ({ global: { usadas: 20, limite: 20, cheia: true, liberaEmSegundos: 600 }, hora: { persistente: true }, dono: {}, mes: [] }) })), ['cota-cheia']);
    assert.deepEqual(motivos(sem({ erros: () => ({ errors: 25, reconnects: 0, byTag: {} }) })), ['erros-no-log']);
    assert.deepEqual(motivos(sem({ avisos: () => [{ variavel: 'AI_MAX_TOKENS', problema: 'inválido', usando: 1500 }] })), ['config-invalida']);
    // ETAPA 8 (revisão da Liz): sem a trava, a pesquisa fica INDISPONÍVEL: um motivo fixo (sem texto livre), além do "cota-sem-disco"
    const semTrava = (codigo, extra2 = {}, papel = 'cerebro') => sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: false, ...(extra2.hora ?? {}) }, dono: { papel, dono: 'cerebro', ligada: false, aguardandoTrava: extra2.aguardandoTrava ?? true, pesquisaDisponivel: extra2.pesquisaDisponivel ?? false, codigo }, mes: [] }) });
    for (const codigo of ['trava-de-outro-processo', 'dono-morto', 'aguardando-trava', 'erro-na-trava']) {
      const d = semTrava(codigo);
      assert.deepEqual(motivos(d), ['cota-sem-disco', 'pesquisa-indisponivel'], codigo);
      assert.equal(d.estado, 'atencao');
      assert.equal(d.cotasDeBusca.hora.persistencia.pesquisaDisponivel, false);
      assert.equal(d.cotasDeBusca.hora.persistencia.motivo, codigo, 'o motivo é uma palavra fixa');
      assert.match(d.motivos.find((m) => m.codigo === 'pesquisa-indisponivel').texto, /temporariamente indisponível/);
    }
    // trava perdida: o problema de sempre (trava-perdida) + a pesquisa indisponível
    assert.deepEqual(motivos(sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: false }, dono: { papel: 'unico', dono: 'unico', ligada: false, perdida: true, pesquisaDisponivel: false, codigo: 'perdida' }, mes: [] }) })), ['trava-perdida', 'pesquisa-indisponivel']);
    // o bot separado (a pesquisa dele vai ao cérebro) NÃO é motivo; a cota desligada de propósito também não (a pesquisa segue saindo)
    assert.deepEqual(motivos(semTrava('bot-separado', { aguardandoTrava: false }, 'bot-separado')), []);
    assert.deepEqual(motivos(semTrava('desligada', { aguardandoTrava: false, pesquisaDisponivel: true }, 'unico')), []);
    // o registro que NÃO grava (a cota por hora ou o diário da retomada): a busca não sai, mesmo com a trava na mão
    assert.deepEqual(motivos(sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: true, gravacaoComFalha: true }, dono: { papel: 'cerebro', dono: 'cerebro', ligada: true, pesquisaDisponivel: true, codigo: null }, mes: [] }) })), ['pesquisa-indisponivel']);
    assert.deepEqual(motivos(sem({}, cerebroLimpo({ retomada: { ligada: true, gravacaoComFalha: true, interrompidas: 0, porEstado: { pending: 0, running: 0, completed: 0, uncertain: 0 } } }), 'cerebro-separado')), ['pesquisa-indisponivel']);
    // a reutilização é só um número: texto estranho some
    assert.equal(sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: true, reutilizadas: 'consulta privada do Braga' }, dono: {}, mes: [] }) }).cotasDeBusca.hora.reutilizadas, 0);
    // a cota em disco desligada de propósito (e o bot separado) não é motivo de atenção
    assert.equal(sem({ cota: () => ({ global: { usadas: 0, limite: 20, cheia: false }, hora: { persistente: false }, dono: { papel: 'unico', dono: 'unico', ligada: false, aguardandoTrava: false, codigo: 'desligada' }, mes: [] }) }).estado, 'ok');
    // vários motivos juntos, os problemas primeiro
    const varios = sem({ avisos: () => [{ variavel: 'AI_MAX_TOKENS', problema: 'x', usando: 1 }], gateway: () => ({ status: gwStatus({ providers: [{ ...gwStatus().providers[0], targets: [{ ...gwStatus().providers[0].targets[0], available: false }] }] }), algumDisponivel: false }) });
    assert.deepEqual(motivos(varios), ['sem-provedor-de-ia', 'config-invalida']);
    assert.ok(varios.motivos.every((m) => typeof m.texto === 'string' && m.texto.length > 10));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. A rota HTTP de verdade: só o dono, só GET, sem cache, e ler não gasta nada');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const budget = getDefaultBudget();
  const admin = createAdmin({ deps: { diagnostico: fontesLimpas({ cota: () => { const g = budget.globalStatus(); return { global: { usadas: g.used, limite: g.limit, cheia: g.full }, hora: budget.hourlyStats(), dono: {}, mes: [] }; } }), logDir } });
  server = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (method, rota, token) => {
    const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    return { status: res.status, headers: res.headers, texto: await res.text() };
  };
  await test('o dono recebe o diagnóstico (200, JSON, sem cache); o membro leva 403; sem token ou com token errado, 401; POST não existe', async () => {
    const ok = await chamar('GET', '/v1/admin/diagnostico', T_OWNER);
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('content-type'), /json/);
    const d = JSON.parse(ok.texto);
    assert.equal(d.versao, 1);
    assert.equal(d.modo, 'unico');
    assert.ok(!ok.texto.includes(OWNER) && !ok.texto.includes(MEMBER) && !ok.texto.includes(SEGREDO));
    const membro = await chamar('GET', '/v1/admin/diagnostico', T_MEMBER);
    assert.equal(membro.status, 403);
    assert.ok(!membro.texto.includes('"ia"') && !membro.texto.includes('versao'), 'o membro não recebe nenhum dado');
    assert.equal((await chamar('GET', '/v1/admin/diagnostico', null)).status, 401);
    assert.equal((await chamar('GET', '/v1/admin/diagnostico', 'token-errado-0123456789abcdef')).status, 401);
    for (const metodo of ['POST', 'PUT', 'DELETE']) {
      const r = await chamar(metodo, '/v1/admin/diagnostico', T_OWNER);
      assert.ok(r.status >= 400 && !r.texto.includes('versao'), `${metodo} não devolve o diagnóstico (${r.status})`);
    }
  });

  await test('é SÓ LEITURA: chamar várias vezes não gasta cota de busca, não mexe no roteador nem grava o arquivo da cota', async () => {
    const antes = { global: budget.globalStatus().used, hora: budget.hourlyStats() };
    const arquivos = fs.existsSync(path.join(tmp, 'secrets')) ? fs.readdirSync(path.join(tmp, 'secrets')) : [];
    for (let i = 0; i < 4; i += 1) assert.equal((await chamar('GET', '/v1/admin/diagnostico', T_OWNER)).status, 200);
    assert.equal(budget.globalStatus().used, antes.global);
    assert.deepEqual(budget.hourlyStats(), antes.hora);
    assert.deepEqual(fs.existsSync(path.join(tmp, 'secrets')) ? fs.readdirSync(path.join(tmp, 'secrets')) : [], arquivos, 'nenhum arquivo criado');
    // a cota de busca de VERDADE: ler o diagnóstico depois de gastar 2 buscas mostra 2, e continua 2
    const b = createBudget({ filePath: path.join(tmp, 'b2', 'search-budget.json') });
    b.takeUser('u1'); b.takeUser('u2');
    const lido = diag.montarDiagnostico({ fontes: { ...fontesLimpas(), cota: () => ({ global: { usadas: b.globalStatus().used, limite: 20, cheia: false }, hora: b.hourlyStats(), dono: {}, mes: [] }) } });
    assert.equal(lido.cotasDeBusca.hora.global.usadas, 2);
    assert.equal(b.globalStatus().used, 2);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. O cérebro separado: o createCerebroAdmin com o canal (bot conectado, bot fora, membro barrado antes de falar com o bot)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const canalFalso = ({ conectado = true, status = { online: true, tag: 'Yui#0001', guilds: 3, bans: { users: 1 } }, falha = false } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      isConnected: () => conectado,
      request: async (papel, metodo, params) => { pedidos.push({ papel, metodo }); if (falha) throw Object.assign(new Error('caiu'), { code: 'CONNECTION_LOST' }); return status; },
      emit() {},
    };
  };
  const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
  await test('bot conectado: o diagnóstico traz o estado do cérebro e o Discord visto pelo bot (só online ou não; nada da tag nem dos servidores)', async () => {
    const canal = canalFalso();
    const a = createCerebroAdmin({ channel: canal, diagnostico: () => cerebroLimpo({ canal: { connected: 1, lockedUntil: SEGREDO } }), fontes: fontesLimpas() });
    const d = await a.diagnostico(ctxDono);
    assert.equal(d.modo, 'cerebro-separado');
    assert.equal(d.cerebro.botConectado, true);
    assert.equal(d.cerebro.discordOnline, true);
    assert.deepEqual(d.cerebro.canal, { connected: 1 });
    const texto = JSON.stringify(d);
    assert.ok(!texto.includes('Yui#0001') && !texto.includes(SEGREDO) && !texto.includes('"guilds"'));
    assert.deepEqual(canal.pedidos, [{ papel: 'bot', metodo: 'discord.status' }], 'um único pedido de LEITURA ao bot');
    assert.equal(d.estado, 'ok');
  });

  await test('bot fora do ar: o Discord fica desconhecido (null), o motivo aparece e o resto do diagnóstico sai igual', async () => {
    const canal = canalFalso({ conectado: false });
    const a = createCerebroAdmin({ channel: canal, diagnostico: () => cerebroLimpo({ botConectado: true, discordOnline: true }), fontes: fontesLimpas() });
    const d = await a.diagnostico(ctxDono);
    assert.equal(d.cerebro.botConectado, false, 'vale a conexão de verdade, não o que a fonte disse');
    assert.equal(d.cerebro.discordOnline, null);
    assert.deepEqual(d.motivos.map((m) => m.codigo), ['bot-desconectado']);
    assert.equal(d.ia.provedorAtual, 'groq');
    assert.deepEqual(canal.pedidos, [], 'sem o bot, nenhum pedido');
    // o bot conectado mas o pedido falha no meio: também desconhecido
    const caiu = createCerebroAdmin({ channel: canalFalso({ falha: true }), diagnostico: () => cerebroLimpo(), fontes: fontesLimpas() });
    assert.equal((await caiu.diagnostico(ctxDono)).cerebro.discordOnline, null);
  });

  await test('quem não é o dono é barrado ANTES de qualquer pedido ao bot; uma fonte do cérebro que lança não derruba o diagnóstico', async () => {
    const canal = canalFalso();
    const a = createCerebroAdmin({ channel: canal, diagnostico: () => { throw new Error(`falha com ${SEGREDO}`); }, fontes: fontesLimpas() });
    for (const role of ['MEMBER', 'TRUSTED', 'GUEST', 'BLOCKED', undefined]) {
      await assert.rejects(a.diagnostico({ role, userId: MEMBER, platform: 'api' }), (e) => e.status === 403, String(role));
    }
    assert.deepEqual(canal.pedidos, [], 'nenhum pedido ao bot para quem não é o dono');
    const d = await a.diagnostico(ctxDono);
    assert.equal(d.cerebro.uptimeSegundos, 0, 'a fonte do cérebro falhou: seção vazia, sem erro');
    assert.ok(!JSON.stringify(d).includes(SEGREDO));
  });

  await test('pela rota HTTP com o admin do cérebro: o dono recebe (200), o membro leva 403 e o bot não é consultado', async () => {
    const canal = canalFalso();
    const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: createCerebroAdmin({ channel: canal, diagnostico: () => cerebroLimpo(), fontes: fontesLimpas() }) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/v1/admin/diagnostico`;
    try {
      const membro = await fetch(url, { headers: { Authorization: `Bearer ${T_MEMBER}` } });
      assert.equal(membro.status, 403);
      assert.deepEqual(canal.pedidos, []);
      const dono = await fetch(url, { headers: { Authorization: `Bearer ${T_OWNER}` } });
      assert.equal(dono.status, 200);
      const d = await dono.json();
      assert.equal(d.modo, 'cerebro-separado');
      assert.equal(d.cerebro.discordOnline, true);
    } finally { srv.close(); srv.closeAllConnections?.(); }
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 400)); // deixa os soquetes do fetch e do servidor fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
