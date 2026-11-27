// Lacunas do painel, ENTREGA B (26/11/2026; docs/PLANO_LACUNAS_PAINEL.md itens 3 v1, 4 v1 e 5): as leituras SÓ DO DONO e SÓ DE LEITURA
//   GET /v1/admin/live, /v1/admin/google, /v1/admin/planos e /v1/admin/avisos, e o grupo "Contas da Yui" das Integrações.
// A. As vistas (src/core/api/leiturasDoPainel.js) com fontes ENVENENADAS: só a lista fechada de campos sai.
// B. As fontes de verdade, sem rede de fora: o serviço da live contra o YouTube FALSO (tests/helpers/youtubeFalso.js), o autenticador do Google contra o
//    Google FALSO (tests/helpers/googleFalso.js) com o arquivo de token numa pasta temporária, o arquivo dos planos, a fila de avisos e o modo observar.
// C. As rotas HTTP de verdade: o dono vê (200), o membro leva 403, sem token 401, só GET; a resposta inteira sem token, segredo, código, texto do chat,
//    nome de quem escreveu, argumentos ou resultados de plano e texto de aviso. Ficam fora do routeGuard, como as outras leituras do painel.
// D. O cérebro separado: as Integrações do bot ganham o grupo do cérebro, os avisos juntam o que o bot registrou (limpo de novo), o bot fora não derruba
//    a tela e o membro é barrado antes de falar com o bot; o bot aceita a leitura nova pelo canal e não monta as contas.
// Num processo só, pasta temporária, sem .env. Execução: npm run test:painelleituras
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarGoogleFalso, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, SEGREDO_PLANTADO } from './helpers/googleFalso.js';
import { criarYoutubeFalso, mensagemDoChat, TOKEN_FALSO } from './helpers/youtubeFalso.js';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-leituras-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const SEGREDO = 'SEGREDO-DO-TESTE-7c1d';
const DB = path.join(tmp, 'db');
const ARQ_GOOGLE = path.join(tmp, 'secrets', 'google-token.json');
const ARQ_YT = path.join(tmp, 'secrets', 'youtube-token.json');
const YT_SEGREDO = `yt-client-secret-${SEGREDO}`;
const YT_REFRESH = `1//refresh-yt-${SEGREDO}`;

Object.assign(process.env, {
  DATABASE_DIR: DB, YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'), YUI_LOG_DIR: path.join(tmp, 'logs'),
  YUI_GOOGLE: 'true', YUI_GOOGLE_TOKEN_ARQUIVO: ARQ_GOOGLE, YUI_YOUTUBE_LIVE: 'true', YUI_YOUTUBE_TOKEN_ARQUIVO: ARQ_YT, YUI_PLANOS: 'true', YUI_PLANOS_AUTO: 'true',
  YUI_AVISOS_FILTRO: 'observar', YUI_FUSO: 'America/Sao_Paulo', YUI_SILENCIO: '23-07',
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'YUI_GOOGLE_GMAIL', 'YUI_GOOGLE_SEM_ROTA_PRIVADA', 'OWNER_ID', 'OWNER_IDS', 'YUI_READ_ONLY', 'YUI_AVISOS_POR_DIA', 'YUI_API_TOKENS']) delete process.env[k];
fs.mkdirSync(DB, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const L = await imp('src/core/api/leiturasDoPainel.js');
const E = await imp('src/integrations/google/endpoints.js');
const arq = await imp('src/integrations/google/arquivoToken.js');
const indexGoogle = await imp('src/integrations/google/index.js');
const { criarServicoDaLive, CODIGOS_DE_ERRO_DA_LIVE } = await imp('src/core/live/servico.js');
const { gravarCredencial } = await imp('src/core/live/credencial.js');
const { definirPortaDaLive } = await imp('src/adaptadores/youtube/porta.js');
const { observarAviso, registrosDoObservar, reiniciarUsoDosAvisos } = await imp('src/core/avisos/observar.js');
const { lerFilaParaPainel, arquivoDaFila } = await imp('src/core/avisos/fila.js');
const { assuntoDaChave } = await imp('src/core/avisos/regras.js');
const { arquivoDosPlanos } = await imp('src/core/planos/store.js');
const { createAdmin } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await imp('src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await imp('src/discord/canalCerebro.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const silencioso = { info() {}, warn() {}, error() {} };
const DIA = 86_400_000;
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };

/** Nada do que é segredo ou conteúdo pode estar no texto (a resposta inteira, em JSON). */
const PROIBIDOS = [SEGREDO, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, SEGREDO_PLANTADO, TOKEN_FALSO, YT_SEGREDO, YT_REFRESH, 'ya29.', 'UCfulano', 'Fulano', 'meu cpf', 'googleapis.com', 'oi yui me ajuda'];
function semSegredos(valor, rotulo = '', { palavras = true } = {}) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of PROIBIDOS) assert.ok(!texto.includes(p), `${rotulo} vazou: ${p}`);
  // As Integrações têm itens que falam de "token" de propósito ("Tokens fixos da API", "sem token"): lá só a lista acima vale.
  if (palavras) assert.ok(!/token|secret|client_id|refresh|access_|bearer/i.test(texto), `${rotulo} tem palavra de credencial: ${texto.slice(0, 300)}`);
}

// ── O YouTube e o Google falsos (127.0.0.1) ──
const yt = await criarYoutubeFalso();
const fake = await criarGoogleFalso();
E.definirHostsParaTeste(E.hostsDeBaseLocal(fake.base));
const VIDEO = 'abcdefghijk';
const LINK = `https://youtube.com/live/${VIDEO}`;
// O token do canal da live: o servidor de token é um dublê do fetch (nenhum pacote sai); o resto vai ao YouTube falso.
const TOKEN_URL = 'http://127.0.0.1:9/token';
const fetchDaLive = async (url, init) => (String(url) === TOKEN_URL
  ? new Response(JSON.stringify({ access_token: TOKEN_FALSO, expires_in: 3600, token_type: 'Bearer' }), { status: 200, headers: { 'content-type': 'application/json' } })
  : fetch(url, init));
gravarCredencial(ARQ_YT, { client_id: 'cliente-yt-falso.apps', client_secret: YT_SEGREDO, refresh_token: YT_REFRESH, canalId: 'UCcanaldayui000000000001' }, { restringir: () => {} });

let relogioDaLive = Date.parse('2026-11-28T20:00:00Z');
const filaDaLive = [];
const avisosDaLive = [];
const servicoDaLive = criarServicoDaLive({
  env: { ...process.env }, ai: { isolatedChat: async () => 'oi, chat!' }, ehDono: (id) => id === OWNER, logger: silencioso, agora: () => relogioDaLive,
  avisarDono: async (t) => { avisosDaLive.push(t); return true; }, baseUrl: yt.base, tokenUrl: TOKEN_URL, fetchImpl: fetchDaLive,
  agendar: (fn, ms) => { const t = { fn, ms }; filaDaLive.push(t); return t; },
  cancelar: (t) => { const i = filaDaLive.indexOf(t); if (i >= 0) filaDaLive.splice(i, 1); },
});
const rodarLive = async () => { const t = filaDaLive.shift(); assert.ok(t, 'nada agendado na live'); relogioDaLive += t.ms; await t.fn(); };

let server = null;
try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. As vistas: só a lista fechada de campos sai, mesmo com a fonte envenenada');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('live: id, título curto (80, sem controle), datas, contadores, cota e código do erro; o resto da fonte não passa', () => {
    const v = L.vistaDaLive({
      estado: 'ouvindo', ativo: true, videoId: VIDEO, titulo: `Live\u0007 do dono\n${'x'.repeat(200)}`, desde: '2026-11-28T20:00:00.000Z',
      mensagens: { lidas: 7, respondidas: 2, espontaneas: -3, texto: SEGREDO }, cota: { dia: '2026-11-28', usado: 300, limiteDiario: 10000, reserva: 1000, restante: 8700, nivel: 'ok', porOperacao: { x: SEGREDO } },
      ultimoErro: { codigo: 'cota_esgotada', em: '2026-11-28T21:00:00.000Z', texto: SEGREDO }, autor: `Fulano ${SEGREDO}`, ultimaMensagem: SEGREDO, token: TOKEN_FALSO,
    }, { ligado: true });
    assert.deepEqual(Object.keys(v).sort(), ['ativo', 'cota', 'desde', 'disponivel', 'estado', 'ligado', 'live', 'mensagens', 'ultimoErro']);
    assert.equal(v.live.videoId, VIDEO);
    assert.ok(v.live.titulo.length <= 80 && !/[\u0000-\u001f]/.test(v.live.titulo) && v.live.titulo.startsWith('Live do dono'));
    assert.deepEqual(v.mensagens, { lidas: 7, respondidas: 2, espontaneas: 0 });
    assert.deepEqual(v.cota, { dia: '2026-11-28', usado: 300, limiteDiario: 10000, reserva: 1000, restante: 8700, nivel: 'ok' });
    assert.deepEqual(v.ultimoErro, { codigo: 'cota_esgotada', em: '2026-11-28T21:00:00.000Z' });
    semSegredos(v, 'live');
    // fora de live: nada de id nem título; erro com texto livre não passa; estado desconhecido não passa
    const fora = L.vistaDaLive({ estado: 'encerrada', ativo: false, videoId: VIDEO, titulo: 'x', ultimoErro: { codigo: `Erro: ${SEGREDO}` } }, { ligado: true });
    assert.equal(fora.live, null);
    assert.equal(fora.desde, null);
    assert.equal(fora.ultimoErro, null);
    assert.equal(L.vistaDaLive({ estado: 'hackeado', ativo: true }, { ligado: true }).ativo, false);
    // sem serviço neste processo: ligada mas indisponível; desligada
    assert.deepEqual([L.vistaDaLive(null, { ligado: true }).disponivel, L.vistaDaLive(null, { ligado: true }).estado], [false, 'ociosa']);
    assert.deepEqual([L.vistaDaLive(null).ligado, L.vistaDaLive(null).estado], [false, 'desligado']);
  });

  await test('Google: escopos só em nome curto, vencimento de 7 dias a partir da autorização, falha como código; nunca token nem cliente', () => {
    const bruto = {
      ligado: true, arquivo: 'ok', escopos: [E.ESCOPOS.agenda, E.ESCOPOS.tarefas, 'https://www.googleapis.com/auth/drive.readonly'], criadoEm: '2026-11-20T10:00:00.000Z',
      ultimaRenovacaoEm: '2026-11-26T10:00:00.000Z', ultimaFalha: { motivo: 'rede', em: '2026-11-26T11:00:00.000Z', corpo: SEGREDO_PLANTADO },
      precisaAutorizar: false, avisoPendente: false, renovacoes: 3, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, token: 'ya29.x',
    };
    const v = L.vistaDoGoogle(bruto);
    assert.deepEqual(v.escopos, ['agenda', 'tarefas', 'outro']);
    assert.equal(v.autorizadoEm, '2026-11-20T10:00:00.000Z');
    assert.equal(v.venceEm, '2026-11-27T10:00:00.000Z');
    assert.equal(v.validade, 'testando-7-dias');
    assert.deepEqual(v.ultimoErro, { codigo: 'rede', em: '2026-11-26T11:00:00.000Z' });
    assert.equal(v.renovacaoFalhou, true, 'a falha veio depois da última renovação');
    assert.equal(L.vistaDoGoogle({ ...bruto, ultimaRenovacaoEm: '2026-11-26T12:00:00.000Z' }).renovacaoFalhou, false, 'renovou depois da falha');
    assert.equal(v.precisaAutorizar, false);
    semSegredos(v, 'google');
    // sem a data no arquivo: "não informado"; Google recusou: precisa autorizar de novo; sem arquivo: falta autorizar; desligado: nada
    const semData = L.vistaDoGoogle({ ...bruto, criadoEm: null });
    assert.deepEqual([semData.venceEm, semData.validade], [null, 'nao-informado']);
    assert.deepEqual([L.vistaDoGoogle({ ...bruto, precisaAutorizar: true }).motivoDeAutorizar, L.vistaDoGoogle({ ...bruto, precisaAutorizar: true }).renovacaoFalhou], ['recusada', false]);
    assert.equal(L.vistaDoGoogle({ ligado: true, arquivo: 'ausente' }).motivoDeAutorizar, 'sem-arquivo');
    assert.equal(L.vistaDoGoogle({ ligado: true, arquivo: 'invalido' }).motivoDeAutorizar, 'arquivo-invalido');
    assert.deepEqual([L.vistaDoGoogle({ ligado: false, client_secret: CLIENT_SECRET }).ligado, L.vistaDoGoogle(null).precisaAutorizar], [false, false]);
    assert.equal(L.vistaDoGoogle({ ...bruto, escopos: null }).escopos, null, 'arquivo antigo sem escopos: não informado');
  });

  await test('planos: os 20 mais novos, prefixo de 16 do hash e, dos passos, só a ferramenta e o estado (nunca args nem resultados)', () => {
    const plano = (i, extra = {}) => ({
      id: `a1b2c3d4e5${String(i).padStart(2, '0')}`, versao: 1, userId: OWNER, estado: 'concluido', criadoEm: Date.parse('2026-11-26T10:00:00Z') + i * 60_000,
      hash: 'f'.repeat(64), entregueEm: 1, validade: Date.parse('2026-11-26T10:30:00Z'), encerradoEm: Date.parse('2026-11-26T10:05:00Z') + i * 60_000,
      aprovacao: { plano: 'x', versao: 1, hash: 'f'.repeat(64), validade: 1, em: Date.parse('2026-11-26T10:01:00Z'), automatica: true },
      passos: [{ ferramenta: 'agenda', args: { periodo: SEGREDO }, estado: 'feito', resultado: SEGREDO }, { ferramenta: `pesquisa ${SEGREDO}`, args: {}, estado: 'hackeado' }],
      pedido: SEGREDO, resultado: SEGREDO, ...extra,
    });
    const lista = Array.from({ length: 22 }, (_, i) => plano(i));
    lista.push({ id: 'nao-hex', passos: [] }, { id: 'abcdef123456', passos: 'x' });
    const v = L.vistaDosPlanos(lista, { ligado: true, auto: true });
    assert.equal(v.total, 22);
    assert.equal(v.planos.length, 20);
    assert.equal(v.planos[0].id, 'a1b2c3d4e521', 'o mais novo primeiro');
    const p = v.planos[0];
    assert.deepEqual(Object.keys(p).sort(), ['aprovacao', 'aprovadoEm', 'aprovarSoPelaDm', 'criadoEm', 'encerradoEm', 'estado', 'hash', 'id', 'motivo', 'passos', 'validade', 'versao']);
    assert.equal(p.hash, 'f'.repeat(16));
    // sem quem resuma (correção C1), cada passo fica "desconhecido" e o plano só se aprova pela DM
    const desconhecido = { acao: 'Ferramenta que este painel não conhece', servico: 'Desconhecido', acesso: 'desconhecido', saida: 'desconhecida', textoLivre: [], soPelaDm: true };
    assert.deepEqual(p.passos, [{ ferramenta: 'agenda', estado: 'feito', resumo: desconhecido }, { ferramenta: 'desconhecida', estado: 'desconhecido', resumo: desconhecido }]);
    assert.equal(p.aprovarSoPelaDm, true);
    assert.deepEqual([p.motivo, p.aprovacao], ['concluido', 'automatica']);
    semSegredos(v, 'planos');
    const aberto = L.vistaDosPlanos([plano(1, { estado: 'aguardando', encerradoEm: undefined, aprovacao: undefined })]).planos[0];
    assert.deepEqual([aberto.motivo, aberto.encerradoEm, aberto.aprovacao], [null, null, null]);
    assert.equal(L.vistaDosPlanos(null, { ilegivel: true }).ilegivel, true);
  });

  await test('planos, correção C1: o resumo seguro de cada passo (montado pelas ferramentas de plano): valores fechados aparecem; texto livre só como tamanho; pesquisa só pela DM', async () => {
    const { criarFerramentasDePlano, resumoSeguroDoPasso, parametrosLivres } = await import(pathToFileURL(path.join(repoRoot, 'src/core/planos/ferramentas.js')).href);
    const ferramentas = criarFerramentasDePlano({ env: {} });
    const resumir = (s) => resumoSeguroDoPasso(ferramentas.get(s.ferramenta), s.args);
    // cada ferramenta da lista fechada tem serviço, saída conhecida e, se tem texto livre, a frase segura
    for (const [nome, f] of ferramentas) {
      assert.ok(f.servico && ['internet', 'google', 'rede-local', 'nao'].includes(f.saida), nome);
      if (parametrosLivres(f).length) assert.equal(typeof f.fraseSegura, 'function', `${nome} tem texto livre e precisa da frase segura`);
    }
    const BUSCA = `Filme ${SEGREDO}`;
    const CONSULTA = `consulta ${SEGREDO}`;
    const LISTA = `lista ${SEGREDO}`;
    const plano = (passos) => ({ id: 'abcdef012345', versao: 1, userId: OWNER, estado: 'aguardando', criadoEm: 1, hash: 'e'.repeat(64), validade: 2, passos: passos.map((s) => ({ estado: 'pendente', ...s })) });
    const leitura = L.vistaDosPlanos([plano([
      { ferramenta: 'agenda', args: { periodo: 'semana' } },
      { ferramenta: 'biblioteca_listar', args: { pasta: 'filmes' } },
      { ferramenta: 'biblioteca_buscar', args: { nome: BUSCA } },
      { ferramenta: 'listas', args: { lista: LISTA } },
      { ferramenta: 'listas', args: {} },
      { ferramenta: 'computador', args: { parte: 'disk' } },
    ])], { ligado: true, painel: true, resumir }).planos[0];
    const r = leitura.passos.map((s) => s.resumo);
    assert.deepEqual(r[0], { acao: 'Ler a sua agenda do Google (os próximos 7 dias)', servico: 'Google Agenda', acesso: 'leitura', saida: 'google', textoLivre: [], soPelaDm: false });
    assert.equal(r[1].acao, 'Listar a pasta "filmes" da biblioteca', 'valor de lista fechada aparece');
    assert.deepEqual([r[2].acao, r[2].textoLivre, r[2].soPelaDm, r[2].saida], ['Procurar um nome na biblioteca', [{ campo: 'nome buscado', caracteres: BUSCA.length }], false, 'rede-local']);
    assert.deepEqual([r[3].acao, r[3].textoLivre], ['Ler uma das suas listas', [{ campo: 'nome da lista', caracteres: LISTA.length }]]);
    assert.equal(r[4].acao, 'Ver os nomes das suas listas');
    assert.equal(r[5].acao, 'Ver o estado do computador (disk)');
    assert.equal(leitura.aprovarSoPelaDm, false, 'só leituras sem texto para fora: o painel aprova');
    semSegredos(leitura, 'resumo seguro');
    // a pesquisa manda o texto da pessoa para fora: o plano inteiro só se aprova pela DM
    const comPesquisa = L.vistaDosPlanos([plano([{ ferramenta: 'agenda', args: { periodo: 'hoje' } }, { ferramenta: 'pesquisa', args: { consulta: CONSULTA } }])], { resumir }).planos[0];
    assert.deepEqual([comPesquisa.passos[1].resumo.acao, comPesquisa.passos[1].resumo.saida, comPesquisa.passos[1].resumo.soPelaDm], ['Pesquisar na web (as palavras saem para o buscador)', 'internet', true]);
    assert.equal(comPesquisa.aprovarSoPelaDm, true);
    semSegredos(comPesquisa, 'pesquisa');
    // o "só pela DM" olha TODOS os passos, inclusive os que não cabem na vista
    const longo = L.vistaDosPlanos([plano([...Array.from({ length: 12 }, () => ({ ferramenta: 'lembretes', args: {} })), { ferramenta: 'pesquisa', args: { consulta: CONSULTA } }])], { resumir }).planos[0];
    assert.equal(longo.aprovarSoPelaDm, true);
    // ferramenta desconhecida, resumir que lança e resumir que tenta vazar o argumento: nada passa além da lista fechada
    assert.equal(L.vistaDosPlanos([plano([{ ferramenta: 'apagar_tudo', args: {} }])], { resumir }).planos[0].aprovarSoPelaDm, true);
    assert.equal(L.vistaDosPlanos([plano([{ ferramenta: 'agenda', args: {} }])], { resumir: () => { throw new Error(SEGREDO); } }).planos[0].aprovarSoPelaDm, true);
    const vazador = L.vistaDosPlanos([plano([{ ferramenta: 'agenda', args: { periodo: 'hoje' } }])], {
      resumir: (s) => ({ acao: 'ok', servico: 'x', acesso: 'leitura', saida: 'google', soPelaDm: false, args: s.args, textoLivre: [{ campo: SEGREDO, caracteres: 'muitos', texto: SEGREDO }], extra: SEGREDO }),
    }).planos[0];
    assert.deepEqual(vazador.passos[0].resumo.textoLivre, [{ campo: 'texto', caracteres: 0 }]);
    assert.ok(!('args' in vazador.passos[0].resumo) && !('extra' in vazador.passos[0].resumo));
    semSegredos(vazador, 'resumir que tenta vazar');
  });

  await test('avisos: só chave fixa ou nome da família como assunto (o resto vira só a classe), motivo e até quando; nunca o texto', () => {
    assert.equal(assuntoDaChave('google-reautorizar'), 'google-reautorizar');
    assert.equal(assuntoDaChave(`provider:${SEGREDO}`), 'provider', 'família: só o nome');
    assert.equal(assuntoDaChave(`chave-inventada-${SEGREDO}`), null);
    const v = L.vistaDosAvisos({
      modo: 'observar',
      fila: { existe: true, total: 2, itens: [
        { assunto: 'google-reautorizar', classe: 'importante', motivo: 'silencio', ate: '2026-11-27T10:00:00.000Z', estado: 'pendente', criadoEm: 1, texto: SEGREDO, chave: `x:${SEGREDO}` },
        { assunto: `provider:${SEGREDO}`, classe: 'hackeada', motivo: SEGREDO, ate: SEGREDO, estado: SEGREDO },
      ] },
      observados: [{ origem: 'cerebro', desde: '2026-11-26T00:00:00.000Z', contagem: { enviar: 2, adiar: 1, descartar: 'x' }, registros: [{ em: '2026-11-26T03:00:00.000Z', assunto: 'youtube', classe: 'informativo', acao: 'adiar', motivo: 'silencio', ate: '2026-11-26T10:00:00.000Z', texto: SEGREDO }] }],
    });
    assert.deepEqual(v.fila.itens[0], { assunto: 'google-reautorizar', classe: 'importante', motivo: 'silencio', ate: '2026-11-27T10:00:00.000Z', estado: 'pendente', criadoEm: '1970-01-01T00:00:00.001Z' });
    assert.deepEqual(v.fila.itens[1], { assunto: null, classe: 'critico', motivo: 'falha', ate: null, estado: 'pendente', criadoEm: null });
    assert.deepEqual(v.observados[0].contagem, { enviar: 2, adiar: 1, descartar: 0 });
    assert.deepEqual(v.observados[0].registros[0], { em: '2026-11-26T03:00:00.000Z', assunto: 'youtube', classe: 'informativo', acao: 'adiar', motivo: 'silencio', ate: '2026-11-26T10:00:00.000Z' });
    semSegredos(v, 'avisos');
    assert.deepEqual(L.vistaDosAvisos({ modo: 'qualquer' }).modo, 'off');
    assert.deepEqual(L.vistaDosAvisos(L.vistaDosAvisos(v)), L.vistaDosAvisos(v), 'passar duas vezes pela vista dá o mesmo resultado');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. As fontes de verdade (live, Google, planos, fila e modo observar), sem rede de fora');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('live de verdade contra o YouTube falso: estado, desde quando, lidas e respondidas DESTA live, cota; nenhum texto do chat nem quem escreveu', async () => {
    yt.definirVideo(VIDEO, { titulo: 'Live de teste da Yui', liveChatId: 'CHAT-FALSO' });
    const r = await servicoDaLive.rotear({ userId: OWNER, texto: `entra na live ${LINK}`, canal: 'discord_dm' });
    assert.match(r.text, /Entrei no chat da live/);
    await rodarLive(); // o histórico é ignorado
    yt.enfileirarPagina({ itens: [
      mensagemDoChat({ id: 'm1', autor: 'UCfulano000000000000000001', nome: `Fulano ${SEGREDO}`, texto: `oi yui me ajuda, meu cpf é ${SEGREDO}` }),
      mensagemDoChat({ id: 'm2', autor: 'UCfulano000000000000000002', nome: 'Fulano Dois', texto: `conversa entre outros ${SEGREDO}` }),
    ] });
    await rodarLive();
    const v = L.vistaDaLive(servicoDaLive.painel(), { ligado: true });
    assert.equal(v.estado, 'ouvindo');
    assert.equal(v.ativo, true);
    assert.deepEqual(v.live, { videoId: VIDEO, titulo: 'Live de teste da Yui' });
    assert.equal(v.desde, '2026-11-28T20:00:00.000Z');
    assert.deepEqual(v.mensagens, { lidas: 2, respondidas: 1, espontaneas: 0 });
    assert.ok(v.cota.usado > 0 && v.cota.limiteDiario === 10000 && v.cota.nivel === 'ok', JSON.stringify(v.cota));
    assert.equal(v.ultimoErro, null);
    semSegredos(v, 'live real');
    semSegredos(servicoDaLive.painel(), 'o retrato cru do serviço');
  });

  await test('Google de verdade (autenticador contra o Google falso, arquivo de token temporário): renovação, data da autorização e falhas como código', async () => {
    const criadoEm = new Date(Date.now() - 6 * DIA + 3_600_000).toISOString(); // vence em ~1 dia (modo Testando)
    arq.gravarArquivoDeToken(ARQ_GOOGLE, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, escopos: [E.ESCOPOS.agenda, E.ESCOPOS.tarefas], criadoEm }, { restringir: () => {} });
    const g = indexGoogle.googleDoProcesso(process.env, { restringir: () => {}, alertar: async () => true, log: silencioso });
    assert.equal((await g.autenticador.obterToken()).ok, true);
    let v = L.vistaDoGoogle(g.estado());
    assert.deepEqual([v.ligado, v.conectado, v.precisaAutorizar, v.renovacaoFalhou], [true, true, false, false]);
    assert.deepEqual(v.escopos, ['agenda', 'tarefas']);
    assert.equal(v.autorizadoEm, criadoEm);
    assert.equal(Date.parse(v.venceEm) - Date.parse(criadoEm), 7 * DIA);
    assert.ok(v.ultimaRenovacaoEm);
    semSegredos(v, 'google real');
    semSegredos({ ...g.estado(), escopos: null }, 'o estado cru (menos os escopos, que são identificadores públicos)');
    // a renovação falha (500 com o corpo plantado): código "rede", sem o corpo
    fake.estado.modoToken = 'http500';
    g.autenticador.descartarToken();
    assert.equal((await g.autenticador.obterToken()).ok, false);
    v = L.vistaDoGoogle(g.estado());
    assert.deepEqual([v.renovacaoFalhou, v.ultimoErro.codigo], [true, 'rede']);
    semSegredos(v, 'google com falha');
    // outra autorização que o Google recusa (invalid_grant, com o segredo plantado na resposta): precisa autorizar de novo
    const arq2 = path.join(tmp, 'secrets', 'google-token-2.json');
    arq.gravarArquivoDeToken(arq2, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, escopos: [E.ESCOPOS.agenda] }, { restringir: () => {} });
    fake.estado.modoToken = 'invalid_grant';
    const g2 = indexGoogle.googleDoProcesso({ ...process.env, YUI_GOOGLE_TOKEN_ARQUIVO: arq2 }, { restringir: () => {}, alertar: async () => true, log: silencioso });
    assert.equal((await g2.autenticador.obterToken()).motivo, 'precisa-autorizar');
    const v2 = L.vistaDoGoogle(g2.estado());
    assert.deepEqual([v2.precisaAutorizar, v2.motivoDeAutorizar, v2.validade, v2.ultimoErro.codigo], [true, 'recusada', 'nao-informado', 'precisa-autorizar']);
    semSegredos(v2, 'google recusado');
    fake.estado.modoToken = 'http500'; // a rota HTTP abaixo vê a renovação falhando
  });

  await test('fila de verdade: lida do disco sem cache, sem o texto; sem arquivo não cria nada; com arquivo não regrava', () => {
    assert.deepEqual(lerFilaParaPainel({ env: process.env }), { existe: false, ilegivel: false, resumoPendente: false, total: 0, itens: [] });
    assert.equal(fs.existsSync(arquivoDaFila(process.env)), false, 'ler não cria o arquivo');
    const agora = Date.parse('2026-11-26T15:00:00Z'); // 12:00 em São Paulo: fora do silêncio
    fs.writeFileSync(arquivoDaFila(process.env), JSON.stringify({ versao: 1, itens: [
      { idem: 'a', chave: 'weekly', classe: 'informativo', texto: `O semanal saiu ${SEGREDO}`, motivo: 'teto', criadoEm: agora - 60_000, liberaEm: agora + 3_600_000, estado: 'pendente' },
      { idem: 'b', chave: `provider:${SEGREDO}`, classe: 'importante', texto: SEGREDO, motivo: 'falha', criadoEm: agora, liberaEm: agora + 300_000, estado: 'enviando' },
      { idem: 'c', chave: 'google-reautorizar', classe: 'importante', texto: SEGREDO, motivo: 'silencio', criadoEm: agora, liberaEm: 0, estado: 'pendente' },
      { sem: 'idem' },
    ], uso: { dia: '', total: 0, assuntos: [] }, entregues: [], resumo: { dia: '2026-11-26', liberaEm: 0 } }));
    const antes = fs.readFileSync(arquivoDaFila(process.env), 'utf8');
    const f = lerFilaParaPainel({ env: process.env, now: agora });
    assert.equal(f.total, 3);
    assert.equal(f.resumoPendente, true);
    assert.deepEqual(f.itens.map((i) => [i.assunto, i.classe, i.motivo, i.estado]), [['weekly', 'informativo', 'teto', 'pendente'], ['provider', 'importante', 'falha', 'enviando'], ['google-reautorizar', 'importante', 'silencio', 'pendente']]);
    assert.equal(f.itens[0].ate, new Date(agora + 3_600_000).toISOString());
    assert.equal(f.itens[2].ate, null, 'fora do silêncio, o adiado pelo silêncio sai na próxima passada');
    assert.equal(lerFilaParaPainel({ env: process.env, now: Date.parse('2026-11-26T03:00:00Z') }).itens[2].ate, '2026-11-26T10:00:00.000Z', 'no silêncio: até as 07:00 de São Paulo');
    semSegredos(f, 'fila');
    assert.equal(fs.readFileSync(arquivoDaFila(process.env), 'utf8'), antes, 'a leitura não regrava');
    fs.writeFileSync(path.join(tmp, 'fila-quebrada.json'), '{ quebrado');
    assert.deepEqual(lerFilaParaPainel({ env: process.env, file: path.join(tmp, 'fila-quebrada.json') }).ilegivel, true);
  });

  await test('modo observar de verdade: guarda só o que adiaria ou descartaria do dono, com o assunto já limpo; terceiro e "enviar" só contam', () => {
    reiniciarUsoDosAvisos();
    const env = { ...process.env };
    const noSilencio = Date.parse('2026-11-26T03:00:00Z'); // 00:00 em São Paulo
    observarAviso({ chave: 'youtube', env, agora: noSilencio, log: silencioso });
    observarAviso({ chave: `provider:${SEGREDO}`, env, agora: noSilencio, log: silencioso });
    observarAviso({ chave: `crash:${SEGREDO}`, env, agora: noSilencio, log: silencioso }); // crítico: sai sempre
    observarAviso({ chave: 'lembrete', destinatario: 'terceiro', env, agora: noSilencio, log: silencioso });
    const r = registrosDoObservar();
    assert.deepEqual(r.contagem, { enviar: 1, adiar: 2, descartar: 0 });
    assert.deepEqual(r.registros.map((x) => [x.assunto, x.classe, x.acao, x.motivo, x.ate]), [
      ['youtube', 'informativo', 'adiar', 'silencio', '2026-11-26T10:00:00.000Z'],
      ['provider', 'importante', 'adiar', 'silencio', '2026-11-26T10:00:00.000Z'],
    ]);
    semSegredos(r, 'observar');
    // desligado (off ou ligar): nada é registrado
    observarAviso({ chave: 'youtube', env: { ...env, YUI_AVISOS_FILTRO: 'off' }, agora: noSilencio, log: silencioso });
    assert.equal(registrosDoObservar().registros.length, 2);
  });

  await test('os códigos de erro da live são fixos: o serviço só anota códigos da lista, e a lista só tem palavras curtas', () => {
    assert.ok(CODIGOS_DE_ERRO_DA_LIVE.length > 10);
    for (const c of CODIGOS_DE_ERRO_DA_LIVE) assert.match(c, /^[a-z][a-z0-9_-]{0,39}$/, c);
    for (const c of ['cota_esgotada', 'removida', 'erro_permanente', 'sem-credencial', 'leituras-falharam', 'nao-escreve', 'outro']) assert.ok(CODIGOS_DE_ERRO_DA_LIVE.includes(c), c);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. As rotas HTTP de verdade: só o dono, só GET, sem segredo nem conteúdo');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // os planos de verdade no disco (o arquivo do store), com argumentos e resultados envenenados
  fs.writeFileSync(arquivosDosPlanosDe(), JSON.stringify({ versao: 1, planos: [
    { id: '0a0b0c0d0e0f', versao: 1, userId: OWNER, estado: 'aguardando', criadoEm: Date.now() - 60_000, hash: 'ab'.repeat(32), entregueEm: Date.now() - 50_000, validade: Date.now() + 1_700_000, auto: false,
      passos: [{ ferramenta: 'biblioteca_buscar', args: { termo: SEGREDO }, estado: 'pendente' }, { ferramenta: 'pesquisa', args: { consulta: `meu cpf ${SEGREDO}` }, estado: 'pendente' }] },
    { id: '1a1b1c1d1e1f', versao: 1, userId: OWNER, estado: 'interrompido', criadoEm: Date.now() - 3_600_000, hash: 'cd'.repeat(32), encerradoEm: Date.now() - 3_000_000,
      aprovacao: { plano: '1a1b1c1d1e1f', versao: 1, hash: 'cd'.repeat(32), validade: 1, em: Date.now() - 3_500_000 }, resultado: SEGREDO,
      passos: [{ ferramenta: 'agenda', args: { periodo: 'hoje' }, estado: 'feito', saida: SEGREDO }, { ferramenta: 'tarefas', args: {}, estado: 'incerto' }] },
  ] }));
  definirPortaDaLive(servicoDaLive);
  server = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: createAdmin({ deps: { integrationData: async () => ({}) } }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (method, rota, token) => {
    const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    return { status: res.status, headers: res.headers, texto: await res.text() };
  };
  const ROTAS = ['/v1/admin/live', '/v1/admin/google', '/v1/admin/planos', '/v1/admin/avisos'];

  await test('o dono lê as quatro (200, JSON, sem cache) e nenhuma resposta tem token, segredo, código de autorização, texto do chat, autor, args ou texto de aviso', async () => {
    const d = {};
    for (const rota of ROTAS) {
      const r = await chamar('GET', rota, T_OWNER);
      assert.equal(r.status, 200, `${rota}: ${r.texto}`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-type'), /json/);
      semSegredos(r.texto, rota);
      assert.ok(!r.texto.includes(OWNER), `${rota} não leva o id do dono`);
      d[rota] = JSON.parse(r.texto);
    }
    const live = d['/v1/admin/live'];
    assert.deepEqual([live.ligado, live.disponivel, live.estado, live.live.videoId, live.mensagens.lidas, live.mensagens.respondidas], [true, true, 'ouvindo', VIDEO, 2, 1]);
    const google = d['/v1/admin/google'];
    assert.deepEqual([google.ligado, google.conectado, google.renovacaoFalhou, google.ultimoErro.codigo], [true, true, true, 'rede']);
    assert.deepEqual(google.escopos, ['agenda', 'tarefas']);
    const planos = d['/v1/admin/planos'];
    assert.deepEqual([planos.ligado, planos.auto, planos.total], [true, true, 2]);
    assert.deepEqual(planos.planos.map((p) => [p.id, p.estado, p.motivo, p.passos.map((s) => `${s.ferramenta}:${s.estado}`).join(',')]), [
      ['0a0b0c0d0e0f', 'aguardando', null, 'biblioteca_buscar:pendente,pesquisa:pendente'],
      ['1a1b1c1d1e1f', 'interrompido', 'interrompido', 'agenda:feito,tarefas:incerto'],
    ]);
    assert.equal(planos.planos[0].hash, 'ab'.repeat(8));
    assert.equal(planos.planos[1].aprovacao, 'dono');
    const avisos = d['/v1/admin/avisos'];
    assert.equal(avisos.modo, 'observar');
    assert.equal(avisos.fila.total, 3);
    assert.deepEqual(avisos.observados.map((o) => [o.origem, o.registros.length]), [['unico', 2]]);
  });

  await test('quem não é o dono: 403 sem nenhum dado; sem token ou token errado: 401; POST, PUT e DELETE não existem', async () => {
    for (const rota of ROTAS) {
      const membro = await chamar('GET', rota, T_MEMBER);
      assert.equal(membro.status, 403, rota);
      assert.ok(!/ligado|planos|fila|escopos|videoId/.test(membro.texto), `${rota}: o membro não recebe nada (${membro.texto})`);
      assert.equal((await chamar('GET', rota, null)).status, 401, rota);
      assert.equal((await chamar('GET', rota, 'token-errado-0123456789abcdef')).status, 401, rota);
      for (const metodo of ['POST', 'PUT', 'DELETE']) {
        const r = await chamar(metodo, rota, T_OWNER);
        assert.ok(r.status === 404, `${metodo} ${rota} (${r.status})`);
        semSegredos(r.texto, `${metodo} ${rota}`);
      }
    }
  });

  await test('fora do routeGuard, como as outras leituras do painel (GET /v1/admin/overview, /monitores): só as rotas de escrita estão na tabela', () => {
    for (const rota of ROTAS) assert.equal(actionForRoute('GET', rota), null, rota);
    assert.equal(actionForRoute('GET', '/v1/admin/monitores'), null);
    assert.equal(actionForRoute('GET', '/v1/admin/overview'), null);
  });

  await test('Integrações: o grupo "Contas da Yui" traz o Google e a live (status e detalhe curtos), sem segredo', async () => {
    const r = await chamar('GET', '/v1/admin/integrations', T_OWNER);
    assert.equal(r.status, 200, r.texto);
    semSegredos(r.texto, 'integrações', { palavras: false });
    const grupos = JSON.parse(r.texto).groups;
    const contas = grupos.find((g) => g.title === 'Contas da Yui');
    assert.ok(contas, 'o grupo existe');
    assert.deepEqual(contas.items.map((i) => [i.key, i.status]), [['google', 'missing'], ['youtube-live', 'ok']]);
    assert.match(contas.items[0].detail, /renovação falhou \(rede\)/);
    assert.match(contas.items[1].detail, /na live "Live de teste da Yui"/);
    assert.equal(grupos.filter((g) => g.items.some((i) => i.key === 'google')).length, 1, 'um item do Google só');
    assert.equal((await chamar('GET', '/v1/admin/integrations', T_MEMBER)).status, 403);
  });

  await test('a live para sozinha (cota esgotada): a rota mostra o estado e o código, sem live nem "desde"', async () => {
    yt.falharLeituras(403, 'quotaExceeded');
    await rodarLive();
    const r = await chamar('GET', '/v1/admin/live', T_OWNER);
    const v = JSON.parse(r.texto);
    assert.deepEqual([v.estado, v.ativo, v.live, v.desde, v.ultimoErro.codigo], ['interrompida', false, null, null, 'cota_esgotada']);
    semSegredos(r.texto, 'live parada');
    assert.equal(avisosDaLive.length, 1, 'o dono foi avisado pela DM, como sempre');
    const integ = JSON.parse((await chamar('GET', '/v1/admin/integrations', T_OWNER)).texto).groups.find((g) => g.title === 'Contas da Yui');
    assert.deepEqual([integ.items[1].status, integ.items[1].detail.startsWith('parou: a cota do dia acabou')], ['missing', true]);
  });

  await test('desligados (YUI_YOUTUBE_LIVE, YUI_GOOGLE e YUI_PLANOS) e sem serviço: as rotas respondem "desligado", sem erro e sem tocar no Google', async () => {
    const antes = { live: process.env.YUI_YOUTUBE_LIVE, google: process.env.YUI_GOOGLE, planos: process.env.YUI_PLANOS };
    definirPortaDaLive(null);
    Object.assign(process.env, { YUI_YOUTUBE_LIVE: 'false', YUI_GOOGLE: 'false', YUI_PLANOS: 'false' });
    fake.limpar();
    try {
      const live = JSON.parse((await chamar('GET', '/v1/admin/live', T_OWNER)).texto);
      assert.deepEqual([live.ligado, live.disponivel, live.estado], [false, false, 'desligado']);
      const google = JSON.parse((await chamar('GET', '/v1/admin/google', T_OWNER)).texto);
      assert.deepEqual([google.ligado, google.conectado, google.precisaAutorizar], [false, false, false]);
      assert.equal(fake.pedidos.length, 0, 'nenhum pedido ao Google');
      assert.equal(JSON.parse((await chamar('GET', '/v1/admin/planos', T_OWNER)).texto).ligado, false);
      process.env.YUI_YOUTUBE_LIVE = 'true';
      const semServico = JSON.parse((await chamar('GET', '/v1/admin/live', T_OWNER)).texto);
      assert.deepEqual([semServico.ligado, semServico.disponivel], [true, false], 'ligada, mas o serviço não subiu neste processo');
    } finally {
      Object.assign(process.env, { YUI_YOUTUBE_LIVE: antes.live, YUI_GOOGLE: antes.google, YUI_PLANOS: antes.planos });
      definirPortaDaLive(servicoDaLive);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O cérebro separado e o bot');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const canalFalso = ({ conectado = true, falha = false } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      isConnected: () => conectado,
      emit() {},
      request: async (papel, metodo, params) => {
        pedidos.push({ papel, metodo, action: params?.action });
        if (falha) throw Object.assign(new Error('caiu'), { code: 'CONNECTION_LOST' });
        if (params?.action === 'avisosObservados') {
          return { desde: '2026-11-26T00:00:00.000Z', contagem: { enviar: 4, adiar: 1, descartar: 'x' }, registros: [
            { em: '2026-11-26T03:00:00.000Z', assunto: `boot ${SEGREDO}`, classe: 'informativo', acao: 'adiar', motivo: `motivo ${SEGREDO}`, ate: '2026-11-26T10:00:00.000Z', texto: SEGREDO },
            { em: '2026-11-26T03:01:00.000Z', assunto: 'media:opus', classe: 'importante', acao: 'adiar', motivo: 'silencio', ate: '2026-11-26T10:00:00.000Z' },
          ] };
        }
        if (params?.action === 'integrations') {
          return { groups: [{ title: 'Núcleo', items: [{ key: 'discord', name: 'Discord', status: 'ok', detail: '1 servidor(es)' }] }, { title: 'Contas da Yui', items: [{ key: 'google', name: 'Google', status: 'ok', detail: SEGREDO }] }] };
        }
        return {};
      },
    };
  };

  await test('avisos no cérebro: junta o que o modo observar registrou no bot, limpo de novo pela vista (assunto e motivo estranhos não passam)', async () => {
    const canal = canalFalso();
    const a = createCerebroAdmin({ channel: canal });
    const v = await a.avisos(ctxDono);
    assert.deepEqual(v.observados.map((o) => o.origem), ['cerebro', 'bot']);
    const bot = v.observados[1];
    assert.deepEqual(bot.contagem, { enviar: 4, adiar: 1, descartar: 0 });
    assert.deepEqual(bot.registros.map((r) => [r.assunto, r.motivo]), [[null, null], ['media:opus', 'silencio']]);
    assert.equal(v.fila.total, 3);
    semSegredos(v, 'avisos do cérebro');
    assert.deepEqual(canal.pedidos, [{ papel: 'bot', metodo: 'panel.admin', action: 'avisosObservados' }], 'um único pedido de LEITURA ao bot');
  });

  await test('bot fora ou falhando: a parte dele aparece como indisponível e o resto sai; membro barrado antes de qualquer pedido ao bot', async () => {
    for (const canal of [canalFalso({ conectado: false }), canalFalso({ falha: true })]) {
      const v = await createCerebroAdmin({ channel: canal }).avisos(ctxDono);
      assert.deepEqual(v.observados.map((o) => [o.origem, o.indisponivel === true]), [['cerebro', false], ['bot', true]]);
      assert.equal(v.fila.total, 3);
    }
    const canal = canalFalso();
    const a = createCerebroAdmin({ channel: canal });
    for (const role of ['MEMBER', 'TRUSTED', 'GUEST', undefined]) {
      for (const metodo of ['avisos', 'live', 'google', 'planos', 'integrations']) await assert.rejects(a[metodo]({ role, userId: MEMBER, platform: 'api' }), (e) => e.status === 403, `${metodo} ${role}`);
    }
    assert.deepEqual(canal.pedidos, [], 'nenhum pedido ao bot para quem não é o dono');
  });

  await test('Integrações no cérebro: o que o bot montou ganha o grupo "Contas da Yui" do cérebro (o item que veio do bot é trocado)', async () => {
    const v = await createCerebroAdmin({ channel: canalFalso() }).integrations(ctxDono);
    assert.deepEqual(v.groups.map((g) => g.title), ['Núcleo', 'Contas da Yui']);
    assert.deepEqual(v.groups[1].items.map((i) => i.key), ['google', 'youtube-live']);
    semSegredos(v, 'integrações do cérebro', { palavras: false });
    // pela rota HTTP com o admin do cérebro: a live, o Google e os planos são lidos no cérebro (o bot não é consultado)
    const canal = canalFalso();
    const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: createCerebroAdmin({ channel: canal }) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      for (const rota of ['/v1/admin/live', '/v1/admin/google', '/v1/admin/planos']) {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}${rota}`, { headers: { Authorization: `Bearer ${T_OWNER}` } });
        assert.equal(r.status, 200, rota);
        semSegredos(await r.text(), rota);
        assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}${rota}`, { headers: { Authorization: `Bearer ${T_MEMBER}` } })).status, 403, rota);
      }
      assert.deepEqual(canal.pedidos, []);
    } finally { srv.close(); srv.closeAllConnections?.(); }
  });

  await test('o bot: aceita a leitura "avisosObservados" pelo canal (a mesma lista dos dois lados), só do dono, e as Integrações dele não montam as contas', async () => {
    assert.deepEqual([...BOT_PANEL_ACTIONS].sort(), Object.keys(PANEL_ACTIONS).sort());
    assert.equal(PANEL_ACTIONS.avisosObservados, false, 'leitura: sem chave de idempotência');
    const handlers = new Map();
    const lidas = [];
    const adminDoBot = createAdmin({
      processo: 'bot', deps: { integrationData: async () => ({}) },
      leituras: { observados: () => registrosDoObservar(), live: () => { lidas.push('live'); return null; }, google: () => { lidas.push('google'); return null; } },
    });
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => null, admin: adminDoBot });
    const r = await handlers.get('panel.admin')({ userId: OWNER, action: 'avisosObservados', args: [] }, { role: 'cerebro' });
    assert.equal(r.origem, 'bot');
    assert.equal(r.registros.length, 2);
    semSegredos(r, 'observados do bot');
    await assert.rejects(handlers.get('panel.admin')({ userId: MEMBER, action: 'avisosObservados', args: [] }, {}), (e) => e.code === 'FORBIDDEN');
    const integ = await handlers.get('panel.admin')({ userId: OWNER, action: 'integrations', args: [] }, { role: 'cerebro' });
    assert.ok(!integ.groups.some((g) => g.title === 'Contas da Yui'), 'o bot não monta o Google nem a live');
    assert.deepEqual(lidas, [], 'nem chega a ler');
  });

  await test('registrado no package.json, no CI (SUITES) e no README_TESTES.md', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts['test:painelleituras'], 'node tests/test-painel-leituras.js');
    assert.match(fs.readFileSync(path.join(repoRoot, 'scripts', 'run-ci.mjs'), 'utf8'), /'test:painelleituras'/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'README_TESTES.md'), 'utf8'), /\| `test:painelleituras` \|/);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { servicoDaLive.parar(); } catch { /* */ }
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* */ }
  try { await yt.close(); } catch { /* */ }
  try { await fake.close(); } catch { /* */ }
  try { E.definirHostsParaTeste(null); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 400)); // deixa os soquetes fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);

function arquivosDosPlanosDe() { return arquivoDosPlanos(process.env); }
