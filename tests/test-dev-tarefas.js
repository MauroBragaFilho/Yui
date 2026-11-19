// Item 7 (preparo): as TAREFAS DO YUI DEV (src/core/dev/tarefas.js), DESLIGADAS por YUI_DEV_TAREFAS=false e SEM EFEITO: a máquina de estados, as regras da Fase 4 como validações e o
// formato do pacote de revisão. Só funções puras: nenhum comando é executado, nenhum arquivo é lido ou gravado, nenhuma rede, nenhuma branch criada.
//  A. a chave e o executor (interface que hoje devolve "não implementado");
//  B. a máquina de estados (a tabela inteira: cada estado contra cada evento);
//  C. só o dono, só pelos canais privados, só projeto da lista permitida; o pedido não traz branch, pasta nem papel;
//  D. branch e worktree ISOLADOS: nunca a main, nunca a pasta do projeto;
//  E. push só da branch da própria tarefa (sem força, sem apagar, sem outro destino);
//  F. tempo máximo;
//  G. lista de executáveis (a mesma do terminal da aba Código, sem shell) e aprovação para o destrutivo;
//  H. o pacote de revisão (resumo, arquivos, diff LIMITADO e sem segredo, testes, branch, alertas);
//  I. a tarefa de ponta a ponta (preparar, iniciar, entregar, aprovar, rejeitar, cancelar, falhar, tempo esgotado).
// Execução: npm run test:devtarefas   (node tests/test-dev-tarefas.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const T = await import(pathToFileURL(path.join(repoRoot, 'src/core/dev/tarefas.js')).href);
const {
  ESTADOS_DA_TAREFA, ESTADOS_FINAIS, TRANSICOES_DA_TAREFA, EVENTOS_DA_TAREFA, LIMITES_DA_TAREFA, CANAIS_QUE_CRIAM, BRANCHES_PROTEGIDAS,
  tarefasLigadas, validarSolicitante, validarProjeto, validarBranch, nomeDaBranch, validarAmbiente, conferirBranchAtual, validarPush, normalizarTempoMaximo, verificarPrazo,
  decidirComando, mascararSegredos, limitarDiff, alertasDosArquivos, montarPacoteDeRevisao, criarTarefa, aplicarEvento, executarTarefa, EXECUTOR_NAO_IMPLEMENTADO,
} = T;

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 7).join('\n      ')}`); }
};

const LIGADO = { YUI_DEV_TAREFAS: 'true', YUI_DEV_ENABLED: 'true' };
const PROJETO_PASTA = path.join(os.tmpdir(), 'yui-teste-projeto');
const PROJETOS = [{ id: 'yui', name: 'Yui', path: PROJETO_PASTA, exists: true }, { id: 'bds', name: 'BDS', path: path.join(os.tmpdir(), 'bds'), exists: true }, { id: 'velho', name: 'Velho', path: path.join(os.tmpdir(), 'sumiu'), exists: false }];
let relogio = Date.UTC(2026, 10, 19, 15, 0, 0);
const agora = () => relogio;
const avancar = (ms) => { relogio += ms; };
const DONO = { papel: 'dono', canal: 'app', pessoa: 'sessao-dono' };
const novaTarefa = (extra = {}, ctx = {}) => {
  const r = criarTarefa({ projeto: 'yui', titulo: 'Corrigir o teste do canal', descricao: 'O teste test:channel falha às vezes. Ache a causa e corrija.', ...extra }, { ...DONO, projetosPermitidos: PROJETOS, env: LIGADO, agora, gerarId: () => 'tar_0123456789', ...ctx });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.tarefa;
};
const worktreeDe = (t) => path.join(PROJETO_PASTA, '.yui', 'worktrees', t.id);
const arquivos = () => [{ caminho: 'src/core/channel/client.js', situacao: 'modificado', adicoes: 3, remocoes: 1 }, { caminho: 'tests/test-channel.js', situacao: 'modificado', adicoes: 10, remocoes: 0 }];
const testesOk = () => ({ comando: 'npm run test:channel', executados: 40, passaram: 40, falharam: 0, duracaoMs: 12_000, saidaFinal: '40 testes OK' });
const entradaDoPacote = (extra = {}) => ({ resumo: 'Corrigi a corrida na reconexão do canal e acrescentei um teste.', arquivos: arquivos(), diff: 'diff --git a/x b/x\n+linha\n', testes: testesOk(), commit: 'a1b2c3d', base: 'main', ...extra });
/** Leva uma tarefa até a revisão. */
function atéRevisao(extra = {}) {
  let t = novaTarefa();
  t = aplicarEvento(t, 'preparar', {}, { agora }).tarefa;
  t = aplicarEvento(t, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).tarefa;
  const r = aplicarEvento(t, 'entregar', entradaDoPacote(extra), { agora });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.tarefa;
}

console.log('A. A chave e o executor');
await test('DESLIGADO por padrão: só liga com YUI_DEV_TAREFAS=true E o módulo de código (YUI_DEV_ENABLED=true) ligado', () => {
  assert.equal(tarefasLigadas({}).ligado, false);
  assert.equal(tarefasLigadas().ligado, false, 'sem as variáveis no ambiente deste teste');
  for (const v of ['false', '', '0', '1', 'yes', 'sim', undefined, null]) assert.equal(tarefasLigadas({ YUI_DEV_TAREFAS: v, YUI_DEV_ENABLED: 'true' }).ligado, false, String(v));
  assert.match(tarefasLigadas({ YUI_DEV_TAREFAS: 'true' }).motivo, /YUI_DEV_ENABLED/);
  assert.match(tarefasLigadas({ YUI_DEV_ENABLED: 'true' }).motivo, /YUI_DEV_TAREFAS/);
  assert.deepEqual(tarefasLigadas({ YUI_DEV_TAREFAS: ' TRUE ', YUI_DEV_ENABLED: 'True' }), { ligado: true, motivo: null });
});
await test('desligado, criar e executar tarefa não fazem nada: "desligado"', async () => {
  const pedido = { projeto: 'yui', titulo: 't', descricao: 'd' };
  assert.equal(criarTarefa(pedido, { ...DONO, projetosPermitidos: PROJETOS, env: {} }).codigo, 'desligado');
  assert.equal(criarTarefa(pedido, { ...DONO, projetosPermitidos: PROJETOS, env: { YUI_DEV_TAREFAS: 'true' } }).codigo, 'desligado');
  const t = novaTarefa();
  const r = await executarTarefa(t, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'desligado');
});
await test('o executor é uma interface que HOJE devolve "não implementado" (ligado ou não); um executor injetado só roda com tarefa pendente e branch válida, e recebe a decisão de comandos', async () => {
  const t = novaTarefa();
  const r = await executarTarefa(t, { env: LIGADO });
  assert.deepEqual([r.ok, r.codigo], [false, 'nao-implementado']);
  assert.deepEqual(await EXECUTOR_NAO_IMPLEMENTADO.executar(), { ok: false, codigo: 'nao-implementado', texto: 'O executor de tarefas do Yui Dev ainda não foi implementado.' });
  assert.equal((await executarTarefa(t, { env: LIGADO, executor: {} })).codigo, 'nao-implementado');
  let chamado = null;
  const executor = { async executar(tarefa, ferramentas) { chamado = { id: tarefa.id, npm: ferramentas.decidirComando('npm test'), curl: ferramentas.decidirComando('curl https://x.com') }; return { ok: true }; } };
  assert.deepEqual(await executarTarefa(t, { env: LIGADO, executor }), { ok: true });
  assert.deepEqual(chamado, { id: t.id, npm: { decisao: 'allow', motivo: 'consulta ou teste' }, curl: chamado.curl });
  assert.equal(chamado.curl.decisao, 'deny');
  // tarefa que não está pendente, ou com branch protegida, nunca chega ao executor
  chamado = null;
  const rodando = aplicarEvento(aplicarEvento(t, 'preparar', {}, { agora }).tarefa, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).tarefa;
  assert.equal((await executarTarefa(rodando, { env: LIGADO, executor })).codigo, 'tarefa-invalida');
  assert.equal((await executarTarefa({ ...t, branch: 'main' }, { env: LIGADO, executor })).codigo, 'branch-protegida');
  assert.equal((await executarTarefa(null, { env: LIGADO, executor })).codigo, 'tarefa-invalida');
  assert.equal(chamado, null, 'o executor nunca foi chamado');
});
await test('o arquivo das tarefas não executa programa, não abre rede e não lê nem grava arquivo por conta própria (nenhum child_process, net, http, fetch nem fs.*Sync de escrita)', () => {
  const fonte = fs.readFileSync(path.join(repoRoot, 'src/core/dev/tarefas.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const m of fonte.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) assert.ok(!/^(?:node:)?(?:child_process|net|http|https|http2|dgram|dns|tls|worker_threads|fs|fs\/promises)$/.test(m[1]) && !/terminal\.js$/.test(m[1]), `importa ${m[1]}`);
  assert.ok(!/\bfetch\s*\(|\bspawn\w*\s*\(|\b(?:exec|execSync|execFile|execFileSync|fork)\s*\(/.test(fonte), 'usa fetch, spawn ou exec');
  assert.equal((fonte.match(/process\.env/g) ?? []).length, (fonte.match(/env = process\.env/g) ?? []).length, 'process.env só aparece como valor padrão do parâmetro `env`: nada lê o ambiente por conta própria');
  assert.deepEqual([...fonte.matchAll(/env\??\.([A-Z][A-Z0-9_]+)/g)].map((x) => x[1]).sort(), ['YUI_DEV_ENABLED', 'YUI_DEV_TAREFAS']);
});

console.log('B. A máquina de estados');
await test('a tabela inteira: 8 estados contra 8 eventos; os 4 estados finais não aceitam nada', () => {
  assert.deepEqual([...ESTADOS_DA_TAREFA], ['pendente', 'preparando', 'rodando', 'revisao', 'aprovada', 'rejeitada', 'falhou', 'cancelada']);
  assert.deepEqual([...ESTADOS_FINAIS], ['aprovada', 'rejeitada', 'falhou', 'cancelada']);
  assert.deepEqual([...EVENTOS_DA_TAREFA].sort(), ['aprovar', 'cancelar', 'entregar', 'falhar', 'iniciar', 'preparar', 'rejeitar', 'tempo_esgotado']);
  let validas = 0;
  for (const estado of ESTADOS_DA_TAREFA) {
    assert.ok(TRANSICOES_DA_TAREFA[estado], estado);
    for (const evento of EVENTOS_DA_TAREFA) {
      const alvo = TRANSICOES_DA_TAREFA[estado][evento];
      if (alvo) validas += 1;
      if (ESTADOS_FINAIS.includes(estado)) assert.equal(alvo, undefined, `${estado} (final) aceita ${evento}`);
    }
  }
  assert.equal(validas, 2 + 4 + 4 + 3, 'o número de transições da tabela');
  assert.equal(TRANSICOES_DA_TAREFA.pendente.preparar, 'preparando');
  assert.equal(TRANSICOES_DA_TAREFA.preparando.iniciar, 'rodando');
  assert.equal(TRANSICOES_DA_TAREFA.rodando.entregar, 'revisao');
  assert.equal(TRANSICOES_DA_TAREFA.revisao.aprovar, 'aprovada');
  assert.equal(TRANSICOES_DA_TAREFA.revisao.rejeitar, 'rejeitada');
  assert.equal(TRANSICOES_DA_TAREFA.rodando.falhar, 'falhou');
  assert.equal(TRANSICOES_DA_TAREFA.rodando.tempo_esgotado, 'falhou');
  assert.equal(TRANSICOES_DA_TAREFA.pendente.entregar, undefined, 'não dá para entregar sem rodar');
  assert.equal(TRANSICOES_DA_TAREFA.pendente.aprovar, undefined, 'não dá para aprovar sem revisão');
  assert.equal(TRANSICOES_DA_TAREFA.rodando.aprovar, undefined);
  assert.ok(Object.isFrozen(TRANSICOES_DA_TAREFA) && Object.isFrozen(TRANSICOES_DA_TAREFA.pendente));
});
await test('aplicarEvento recusa o que a tabela não permite (código "transicao-invalida"), evento ou tarefa desconhecidos, e tarefa já terminada', () => {
  const t = novaTarefa();
  for (const evento of ['iniciar', 'entregar', 'aprovar', 'rejeitar', 'falhar', 'tempo_esgotado']) {
    const r = aplicarEvento(t, evento, { papel: 'dono', canal: 'app' }, { agora });
    assert.equal(r.ok, false, evento);
    assert.equal(r.codigo, 'transicao-invalida', evento);
  }
  assert.equal(aplicarEvento(t, 'voar', {}, { agora }).codigo, 'evento-desconhecido');
  assert.equal(aplicarEvento(null, 'preparar', {}, { agora }).codigo, 'tarefa-invalida');
  assert.equal(aplicarEvento({ ...t, estado: 'inventado' }, 'preparar', {}, { agora }).codigo, 'tarefa-invalida');
  const cancelada = aplicarEvento(t, 'cancelar', DONO, { agora }).tarefa;
  assert.equal(cancelada.estado, 'cancelada');
  for (const evento of EVENTOS_DA_TAREFA) assert.equal(aplicarEvento(cancelada, evento, DONO, { agora }).codigo, 'tarefa-encerrada', evento);
});

console.log('C. Quem pode e em quê');
await test('SÓ o dono (papel decidido pelo cérebro) e SÓ por um canal privado: app, PC ou DM; o servidor público e o chat da live nunca', () => {
  assert.deepEqual([...CANAIS_QUE_CRIAM], ['app', 'pc', 'discord_dm']);
  for (const canal of CANAIS_QUE_CRIAM) assert.deepEqual(validarSolicitante({ papel: 'dono', canal }), { ok: true });
  for (const papel of ['membro', 'publico', 'admin', 'DONO', '', undefined, null]) assert.equal(validarSolicitante({ papel, canal: 'app' }).codigo, 'nao-e-o-dono', String(papel));
  for (const canal of ['discord_guild', 'youtube_live', 'whatsapp', undefined]) assert.equal(validarSolicitante({ papel: 'dono', canal }).codigo, 'canal-nao-permitido', String(canal));
  assert.equal(validarSolicitante().codigo, 'nao-e-o-dono');
  for (const papel of ['membro', 'publico']) assert.equal(criarTarefa({ projeto: 'yui', titulo: 't', descricao: 'd' }, { papel, canal: 'app', projetosPermitidos: PROJETOS, env: LIGADO }).codigo, 'nao-e-o-dono');
  assert.equal(criarTarefa({ projeto: 'yui', titulo: 't', descricao: 'd' }, { papel: 'dono', canal: 'discord_guild', projetosPermitidos: PROJETOS, env: LIGADO }).codigo, 'canal-nao-permitido');
});
await test('SÓ projeto da lista permitida (por id, nunca por caminho); projeto sem pasta é recusado; a lista pode ser de textos ou de objetos', () => {
  assert.deepEqual(validarProjeto('yui', PROJETOS), { ok: true, projeto: 'yui' });
  assert.deepEqual(validarProjeto(' BDS ', PROJETOS), { ok: true, projeto: 'bds' });
  assert.deepEqual(validarProjeto('yui', ['yui', 'outro']), { ok: true, projeto: 'yui' });
  for (const ruim of ['', 'outro', 'D:/Projetos/Yui', '../yui', 'yui/../bds', 'Windows', null, undefined, 7, {}, ['yui']]) assert.equal(validarProjeto(ruim, PROJETOS).codigo, 'projeto-fora-da-lista', String(ruim));
  assert.equal(validarProjeto('velho', PROJETOS).codigo, 'projeto-sem-pasta');
  assert.equal(validarProjeto('yui', []).codigo, 'projeto-fora-da-lista');
  assert.equal(validarProjeto('yui', null).codigo, 'projeto-fora-da-lista');
  assert.equal(criarTarefa({ projeto: 'D:/Windows/System32', titulo: 't', descricao: 'd' }, { ...DONO, projetosPermitidos: PROJETOS, env: LIGADO }).codigo, 'projeto-fora-da-lista');
});
await test('o pedido da tarefa NÃO traz branch, pasta, worktree nem papel (campos desconhecidos são recusados); título, descrição e tempo têm limites', () => {
  const base = { projeto: 'yui', titulo: 'Título', descricao: 'Descrição' };
  const ctx = { ...DONO, projetosPermitidos: PROJETOS, env: LIGADO };
  for (const campo of ['branch', 'pasta', 'worktree', 'papel', 'dono', 'caminho', 'comando', 'binarios', 'push']) assert.equal(criarTarefa({ ...base, [campo]: 'x' }, ctx).codigo, 'campo-desconhecido', campo);
  for (const ruim of [null, undefined, 'texto', [], 5]) assert.equal(criarTarefa(ruim, ctx).codigo, 'pedido-invalido');
  assert.equal(criarTarefa({ ...base, titulo: '' }, ctx).codigo, 'titulo-invalido');
  assert.equal(criarTarefa({ ...base, titulo: 'x'.repeat(121) }, ctx).codigo, 'titulo-invalido');
  assert.equal(criarTarefa({ ...base, titulo: 'a\u0000b' }, ctx).codigo, 'titulo-invalido');
  assert.equal(criarTarefa({ ...base, descricao: '   ' }, ctx).codigo, 'descricao-invalida');
  assert.equal(criarTarefa({ ...base, descricao: 'x'.repeat(4001) }, ctx).codigo, 'descricao-invalida');
  assert.equal(criarTarefa({ ...base, descricao: 'x'.repeat(4000) }, ctx).ok, true);
  assert.equal(criarTarefa({ ...base, titulo: 'x'.repeat(120) }, ctx).ok, true);
  assert.equal(criarTarefa({ ...base, descricao: 'linha 1\nlinha 2\tfim' }, ctx).ok, true, 'quebra de linha e tabulação são texto normal');
  assert.equal(criarTarefa({ ...base, tempoMaximoMs: 10 }, ctx).codigo, 'tempo-invalido');
});
await test('uma tarefa nova é PENDENTE, congelada, com a branch própria (nunca a main), sem worktree, com prazo padrão de 30 min e o histórico começando', () => {
  const t = novaTarefa();
  assert.equal(t.estado, 'pendente');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.historico) && Object.isFrozen(t.solicitante));
  assert.equal(t.projeto, 'yui');
  assert.equal(t.titulo, 'Corrigir o teste do canal');
  assert.equal(t.branch, 'yui/0123456789-corrigir-o-teste-do-canal');
  assert.equal(validarBranch(t.branch).ok, true);
  assert.equal(t.worktree, null);
  assert.equal(t.tempoMaximoMs, 30 * 60_000);
  assert.deepEqual({ ...t.solicitante }, { canal: 'app', pessoa: 'sessao-dono' });
  assert.deepEqual(t.historico.map((h) => [h.de, h.para]), [[null, 'pendente']]);
  assert.equal(t.criadaEm, agora());
  assert.equal(t.pacote, null);
  assert.equal(t.erro, null);
});

console.log('D. Branch e worktree isolados (nunca a main)');
await test('validarBranch: só yui/<id>-<assunto>; main, master, develop e as outras protegidas são recusadas com o código próprio, em qualquer forma', () => {
  assert.equal(validarBranch('yui/abc123-corrigir-teste').ok, true);
  for (const protegida of ['main', 'MAIN', 'Main', ' main ', 'master', 'develop', 'dev', 'trunk', 'prod', 'production', 'release', 'HEAD', 'refs/heads/main', 'origin/main', 'refs/remotes/origin/main', 'origin/master']) {
    assert.equal(validarBranch(protegida).codigo, 'branch-protegida', protegida);
  }
  assert.deepEqual([...BRANCHES_PROTEGIDAS].includes('main'), true);
  for (const ruim of ['', 'feature/x', 'yui', 'yui/', 'yui/ABC', 'yui/a b', 'yui/a..b', 'yui/x.lock', 'yui/x.', 'yui/a/b', '-yui/x', 'yui/-x', 'yui/' + 'a'.repeat(62), 'refs/heads/yui/x', 'origin/yui/x', 'yui/x;rm', 'yui/$(x)', 'yui/x\n', null, undefined, 7, {}]) {
    assert.equal(validarBranch(ruim).ok, false, String(ruim));
  }
  assert.equal(validarBranch('yui/' + 'a'.repeat(61)).ok, true);
});
await test('nomeDaBranch: sempre um nome válido e NUNCA protegido, qualquer que seja o id e o título (acento, emoji, vazio, gigante, caracteres perigosos)', () => {
  for (const [id, titulo] of [['tar_0123456789', 'Corrigir o teste'], ['tar_abc', 'AÇÃO — correção rápida!'], ['tar_abc', '🚀🚀🚀'], ['tar_abc', ''], ['tar_abc', 'x'.repeat(5000)], ['tar_abc', '../../main'], ['tar_abc', 'main'],
    ['tar_abc', 'a; rm -rf /'], ['', ''], [undefined, undefined], ['main', 'main'], ['tar_' + 'f'.repeat(100), 'ok'], ['TAR_ABC', 'Maiúsculas']]) {
    const nome = nomeDaBranch(id, titulo);
    const v = validarBranch(nome);
    assert.equal(v.ok, true, `${JSON.stringify([id, titulo])} -> ${nome}`);
    assert.ok(nome.startsWith('yui/'));
    assert.ok(!BRANCHES_PROTEGIDAS.includes(nome.toLowerCase()));
  }
  assert.equal(nomeDaBranch('tar_0123456789', 'Corrigir o teste do canal'), 'yui/0123456789-corrigir-o-teste-do-canal');
  assert.equal(nomeDaBranch('tar_abc', 'AÇÃO rápida'), 'yui/abc-acao-rapida');
  assert.equal(nomeDaBranch('tar_abc', ''), 'yui/abc-tarefa');
  assert.notEqual(nomeDaBranch('tar_aaa', 'igual'), nomeDaBranch('tar_bbb', 'igual'), 'tarefas diferentes, branches diferentes');
});
await test('o worktree é ISOLADO: só em <projeto>/.yui/worktrees/<id da tarefa>; a pasta do projeto, uma pasta de fora, a de outra tarefa, o .git e caminhos que escapam são recusados', () => {
  const t = novaTarefa();
  const certo = { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t), branch: t.branch, idDaTarefa: t.id };
  const ok = validarAmbiente(certo);
  assert.equal(ok.ok, true);
  assert.equal(ok.branch, t.branch);
  assert.equal(path.resolve(ok.worktree), path.resolve(worktreeDe(t)));
  const casos = [
    [{ worktree: PROJETO_PASTA }, 'worktree-e-o-projeto'],
    [{ worktree: path.join(PROJETO_PASTA, '.') }, 'worktree-e-o-projeto'],
    [{ worktree: path.join(PROJETO_PASTA, 'src') }, 'worktree-fora-da-area'],
    [{ worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees') }, 'worktree-fora-da-area'],
    [{ worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees', t.id, 'sub') }, 'worktree-fora-da-area'],
    [{ worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees', '..', '..') }, 'worktree-e-o-projeto'],
    [{ worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees', '..', 'x') }, 'worktree-fora-da-area'],
    [{ worktree: path.join(PROJETO_PASTA, '.git', 'worktrees', t.id) }, 'worktree-fora-da-area'],
    [{ worktree: `${PROJETO_PASTA}-evil${path.sep}.yui${path.sep}worktrees${path.sep}${t.id}` }, 'worktree-fora-da-area'],
    [{ worktree: path.join(os.tmpdir(), 'outra-pasta') }, 'worktree-fora-da-area'],
    [{ worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees', 'tar_outra') }, 'worktree-de-outra-tarefa'],
    [{ worktree: 'relativo/x' }, 'ambiente-invalido'], [{ worktree: '' }, 'ambiente-invalido'], [{ worktree: null }, 'ambiente-invalido'], [{ projetoPasta: 'relativo' }, 'ambiente-invalido'],
    [{ branch: 'main' }, 'branch-protegida'], [{ branch: 'refs/heads/main' }, 'branch-protegida'], [{ branch: 'feature/x' }, 'branch-fora-do-padrao'],
  ];
  for (const [troca, codigo] of casos) {
    const r = validarAmbiente({ ...certo, ...troca });
    assert.equal(r.ok, false, JSON.stringify(troca));
    assert.equal(r.codigo, codigo, JSON.stringify(troca));
  }
  assert.equal(validarAmbiente({ ...certo, worktree: `${worktreeDe(t)}\0x` }).ok, false);
  assert.equal(validarAmbiente({}).ok, false);
});
await test('conferirBranchAtual: só continua se o checkout está na branch da tarefa (a decisão de comando não enxerga o HEAD)', () => {
  const t = novaTarefa();
  assert.equal(conferirBranchAtual(t, t.branch).ok, true);
  assert.equal(conferirBranchAtual(t, `refs/heads/${t.branch}`).ok, true);
  for (const errada of ['main', 'master', 'yui/outra-tarefa', '', null, undefined]) assert.equal(conferirBranchAtual(t, errada).codigo, 'na-branch-errada', String(errada));
  assert.equal(conferirBranchAtual({ ...t, branch: 'main' }, 'main').codigo, 'na-branch-errada', 'nem se a própria tarefa estiver (errada) na main');
});
await test('a tarefa NUNCA trabalha na main: forjar a branch de uma tarefa para main é recusado ao iniciar, ao entregar e ao executar', async () => {
  const t = novaTarefa();
  const preparada = aplicarEvento(t, 'preparar', {}, { agora }).tarefa;
  const forjada = { ...preparada, branch: 'main' };
  assert.equal(aplicarEvento(forjada, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).codigo, 'branch-protegida');
  const rodando = aplicarEvento(preparada, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).tarefa;
  const r = aplicarEvento({ ...rodando, branch: 'main' }, 'entregar', entradaDoPacote(), { agora });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'pacote-invalido');
  assert.ok(r.erros.some((e) => e.codigo === 'branch-protegida'));
  assert.equal(montarPacoteDeRevisao({ tarefa: { id: 'x', projeto: 'yui', branch: 'main' }, ...entradaDoPacote() }).ok, false);
  assert.equal((await executarTarefa({ ...t, branch: 'master' }, { env: LIGADO })).codigo, 'branch-protegida');
  for (let i = 0; i < 300; i++) {
    const titulo = i % 3 === 0 ? 'main' : i % 3 === 1 ? 'Master' : `tarefa ${i}`;
    const criada = criarTarefa({ projeto: 'yui', titulo, descricao: 'd' }, { ...DONO, projetosPermitidos: PROJETOS, env: LIGADO, agora });
    assert.equal(criada.ok, true);
    assert.ok(criada.tarefa.branch.startsWith('yui/') && !BRANCHES_PROTEGIDAS.includes(criada.tarefa.branch.toLowerCase()), criada.tarefa.branch);
  }
});

console.log('E. Push só da branch da tarefa');
await test('push PERMITIDO: remoto "origin" e a branch da PRÓPRIA tarefa, explícitos (com -u, com refspec igual, com HEAD:branch ou refs/heads/)', () => {
  const b = 'yui/abc-corrigir';
  for (const argv of [['push', 'origin', b], ['push', '-u', 'origin', b], ['push', '--set-upstream', 'origin', b], ['push', 'origin', `${b}:${b}`], ['push', 'origin', `HEAD:${b}`], ['push', 'origin', `refs/heads/${b}`], ['push', 'origin', `${b}:refs/heads/${b}`], ['push', '-q', 'origin', b]]) {
    assert.deepEqual(validarPush({ branchDaTarefa: b, argv }), { ok: true, remoto: 'origin', branch: b }, argv.join(' '));
  }
});
await test('push NEGADO: força (-f, --force, --force-with-lease, +), apagar, --all, --mirror, --tags, outro remoto ou URL, outra branch (main, HEAD:main, de outra tarefa), sem destino explícito, flags desconhecidas', () => {
  const b = 'yui/abc-corrigir';
  const negados = [
    [['push'], 'push-sem-destino-explicito'], [['push', 'origin'], 'push-sem-destino-explicito'], [['push', b], 'push-sem-destino-explicito'], [['push', '-u'], 'push-sem-destino-explicito'], [['push', 'origin', b, 'extra'], 'push-sem-destino-explicito'],
    [['push', '-f', 'origin', b], 'forca-proibida'], [['push', '--force', 'origin', b], 'forca-proibida'], [['push', '--force-with-lease', 'origin', b], 'forca-proibida'], [['push', '--force-with-lease=x:y', 'origin', b], 'forca-proibida'],
    [['push', '--force-if-includes', 'origin', b], 'forca-proibida'], [['push', 'origin', `+${b}`], 'forca-proibida'], [['push', 'origin', `+${b}:${b}`], 'forca-proibida'],
    [['push', '--delete', 'origin', b], 'delete-proibido'], [['push', '-d', 'origin', b], 'delete-proibido'], [['push', 'origin', `:${b}`], 'delete-proibido'], [['push', 'origin', ':main'], 'delete-proibido'],
    [['push', '--all', 'origin'], 'flag-nao-permitida'], [['push', '--mirror', 'origin'], 'flag-nao-permitida'], [['push', '--tags', 'origin', b], 'flag-nao-permitida'], [['push', '--follow-tags', 'origin', b], 'flag-nao-permitida'],
    [['push', '--no-verify', 'origin', b], 'flag-nao-permitida'], [['push', '--receive-pack=x', 'origin', b], 'flag-nao-permitida'], [['push', '-o', 'x', 'origin', b], 'flag-nao-permitida'], [['push', '--prune', 'origin', b], 'flag-nao-permitida'],
    [['push', 'origin', 'main'], 'branch-de-outra-tarefa'], [['push', 'origin', 'master'], 'branch-de-outra-tarefa'], [['push', 'origin', 'HEAD'], 'branch-de-outra-tarefa'], [['push', 'origin', 'HEAD:main'], 'branch-de-outra-tarefa'],
    [['push', 'origin', `${b}:main`], 'branch-de-outra-tarefa'], [['push', 'origin', `main:${b}`], 'branch-de-outra-tarefa'], [['push', 'origin', 'yui/outra-tarefa'], 'branch-de-outra-tarefa'], [['push', 'origin', `origin/${b}`], 'branch-de-outra-tarefa'],
    [['push', 'origin', `refs/tags/${b}`], 'branch-de-outra-tarefa'], [['push', 'origin', `${b}:refs/tags/v1`], 'branch-de-outra-tarefa'], [['push', 'origin', `${b}:${b}:${b}`], 'refspec-invalida'],
    [['push', 'upstream', b], 'remoto-nao-permitido'], [['push', 'https://evil.example/repo.git', b], 'remoto-nao-permitido'], [['push', 'git@evil.example:x/y.git', b], 'remoto-nao-permitido'],
    [['pull', 'origin', b], 'nao-e-push'], [[], 'nao-e-push'], [['push', 7], 'nao-e-push'],
  ];
  for (const [argv, codigo] of negados) {
    const r = validarPush({ branchDaTarefa: b, argv });
    assert.equal(r.ok, false, argv.join(' '));
    assert.equal(r.codigo, codigo, argv.join(' '));
  }
  // a branch da própria tarefa precisa ser válida: push de uma tarefa na main nunca passa
  for (const ruim of ['main', 'master', 'refs/heads/main', 'feature/x', '', null]) assert.equal(validarPush({ branchDaTarefa: ruim, argv: ['push', 'origin', String(ruim)] }).ok, false, String(ruim));
  assert.equal(validarPush({}).ok, false);
  assert.equal(validarPush().ok, false);
});

console.log('F. Tempo máximo');
await test('o tempo máximo: padrão 30 min, de 1 minuto a 2 horas, só inteiros; o relógio da tarefa começa ao sair de "pendente"', () => {
  assert.deepEqual(normalizarTempoMaximo(undefined), { ok: true, tempoMaximoMs: 1_800_000 });
  assert.deepEqual(normalizarTempoMaximo(null), { ok: true, tempoMaximoMs: 1_800_000 });
  assert.equal(normalizarTempoMaximo(60_000).ok, true);
  assert.equal(normalizarTempoMaximo(7_200_000).ok, true);
  for (const ruim of [0, 59_999, 7_200_001, -1, 1.5, '1800000', NaN, Infinity, {}]) assert.equal(normalizarTempoMaximo(ruim).codigo, 'tempo-invalido', String(ruim));
  const pendente = novaTarefa({ tempoMaximoMs: 120_000 });
  assert.equal(verificarPrazo(pendente, agora()).estourou, false, 'antes de começar não há prazo correndo');
  assert.equal(verificarPrazo(pendente, agora()).restanteMs, null);
  const preparada = aplicarEvento(pendente, 'preparar', {}, { agora }).tarefa;
  assert.equal(preparada.comecouEm, agora());
  assert.deepEqual(verificarPrazo(preparada, agora() + 119_999), { estourou: false, restanteMs: 1 });
  assert.deepEqual(verificarPrazo(preparada, agora() + 120_000), { estourou: false, restanteMs: 0 });
  assert.deepEqual(verificarPrazo(preparada, agora() + 120_001), { estourou: true, restanteMs: 0 });
  assert.deepEqual(verificarPrazo(null), { estourou: false, restanteMs: null });
});
await test('"tempo_esgotado" só vale se o prazo estourou DE VERDADE (e leva a tarefa a "falhou" com o código tempo-esgotado)', () => {
  let t = novaTarefa({ tempoMaximoMs: 60_000 });
  t = aplicarEvento(t, 'preparar', {}, { agora }).tarefa;
  t = aplicarEvento(t, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).tarefa;
  const cedo = aplicarEvento(t, 'tempo_esgotado', {}, { agora: () => agora() + 30_000 });
  assert.equal(cedo.codigo, 'prazo-nao-estourou');
  const tarde = aplicarEvento(t, 'tempo_esgotado', {}, { agora: () => agora() + 61_000 });
  assert.equal(tarde.ok, true);
  assert.equal(tarde.tarefa.estado, 'falhou');
  assert.deepEqual({ ...tarde.tarefa.erro }, { codigo: 'tempo-esgotado', texto: 'A tarefa passou do tempo máximo e foi parada.' });
  assert.equal(tarde.tarefa.terminouEm, agora() + 61_000);
  assert.equal(t.estado, 'rodando', 'a tarefa antiga não muda');
});

console.log('G. Executáveis permitidos e aprovação para o destrutivo');
await test('SEM shell e SÓ a lista de executáveis: curl, wget, cmd, powershell, bash, ssh, rm, del, sh e caminhos são negados; sintaxe de shell (; & | > ` $( ) também', () => {
  const t = novaTarefa();
  for (const c of ['curl https://x.com', 'wget x', 'cmd /c dir', 'powershell -c Get-Process', 'pwsh -c x', 'bash -c "ls"', 'sh -c ls', 'ssh host ls', 'scp a b', 'rm -rf x', 'rm x', 'del x', 'format c:', 'shutdown /s', 'sudo ls', 'ls', 'dir',
    'C:\\Windows\\System32\\cmd.exe', './script.sh', 'script.ps1', 'node.exe -e "1"', 'npm test; curl x', 'npm test && curl x', 'npm test | tee x', 'npm test > saida.txt', 'npm test `id`', 'npm test $(id)', 'npm test\nrm x', '', '   ', 'a'.repeat(2500)]) {
    assert.equal(decidirComando(t, c).decisao, 'deny', c);
  }
  for (const c of ['node -e "process.exit(1)"', 'node --eval x', 'python -c "x"', 'git -c core.sshCommand=x status', 'npm exec x', 'npx cowsay oi', 'npx -y qualquer', 'git config user.name x', 'git remote add x y', 'git commit --no-verify -m x']) {
    assert.equal(decidirComando(t, c).decisao, 'deny', c);
  }
});
await test('a lista de executáveis vem da MESMA configuração do terminal da aba Código (YUI_DEV_ALLOWED_EXECUTABLES) e interpretadores nunca entram, nem por configuração', () => {
  const t = novaTarefa();
  assert.equal(decidirComando(t, 'npm test', { env: { YUI_DEV_ALLOWED_EXECUTABLES: 'git' } }).decisao, 'deny', 'npm fora da lista configurada');
  assert.equal(decidirComando(t, 'git status', { env: { YUI_DEV_ALLOWED_EXECUTABLES: 'git' } }).decisao, 'allow');
  for (const proibido of ['powershell', 'cmd', 'bash', 'curl', 'ssh']) assert.equal(decidirComando(t, `${proibido} x`, { env: { YUI_DEV_ALLOWED_EXECUTABLES: `git,${proibido}` } }).decisao, 'deny', `${proibido} nunca entra`);
});
await test('ALLOW (sem perguntar): consulta e teste dentro da branch da tarefa; ASK (o dono aprova no computador): instalar pacote, push, descartar ou reescrever trabalho, qualquer comando que não é de consulta', () => {
  const t = novaTarefa();
  const d = (c) => decidirComando(t, c).decisao;
  for (const c of ['git status', 'git diff', 'git diff --stat', 'git log --oneline', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files', 'git branch', 'git remote -v', 'git add src/a.js', 'git add .', 'git commit -m "corrige o teste"', `git checkout ${t.branch}`, `git switch ${t.branch}`,
    'npm test', 'npm run test', 'npm run test:channel', 'npm run test:ci', 'npm run build', 'npm run lint', 'npm ls', 'node --test', 'node --version', 'npx tsc --noEmit']) assert.equal(d(c), 'allow', c);
  for (const c of ['npm install', 'npm i', 'npm ci', 'npm uninstall x', 'npm update', 'npm run deploy', 'npm start', `git push -u origin ${t.branch}`, `git push origin ${t.branch}`, 'git restore src/a.js', 'git checkout -- src/a.js', 'git checkout .', 'git stash', 'git merge outra', 'git pull', 'git fetch', 'git cherry-pick abc', 'git revert abc', 'node script.js']) {
    assert.equal(d(c), 'ask', c);
  }
});
await test('DENY no git: outra branch (main), criar branch, apagar branch, tag, init, push fora da regra, força, reset duro, clean', () => {
  const t = novaTarefa();
  const d = (c) => decidirComando(t, c).decisao;
  for (const c of ['git checkout main', 'git switch main', 'git checkout master', 'git checkout yui/outra-tarefa', 'git switch -c nova', 'git checkout -b nova', 'git checkout -B nova', 'git switch --detach', 'git checkout origin/main',
    'git branch nova', 'git branch -D main', 'git branch -d x', 'git branch -m x y', 'git branch --delete x', 'git branch -f main HEAD', 'git tag v1', 'git tag -d v1', 'git init', 'git bisect', 'git gc', 'git rebase main', 'git reset HEAD~1', 'git am x',
    'git push', 'git push origin main', 'git push origin HEAD:main', `git push --force origin ${t.branch}`, `git push -f origin ${t.branch}`, `git push --force-with-lease origin ${t.branch}`, `git push origin +${t.branch}`, `git push --delete origin ${t.branch}`, `git push origin :${t.branch}`, 'git push --all', 'git push --mirror',
    'git reset --hard', 'git reset --hard HEAD~1', 'git clean -fd', 'git clean -f', 'git push --force']) {
    assert.equal(d(c), 'deny', c);
  }
  assert.equal(decidirComando({ ...t, branch: 'main' }, 'git push origin main').decisao, 'deny', 'nem se a tarefa tiver a branch trocada para main');
  assert.equal(decidirComando({ ...t, branch: 'main' }, 'git checkout main').decisao, 'deny');
  assert.equal(decidirComando({ ...t, branch: null }, 'git push origin yui/x').decisao, 'deny');
  assert.equal(decidirComando(null, 'git status').decisao, 'allow', 'consulta não depende da tarefa');
  assert.ok(decidirComando(t, 'git push origin main').motivo.length > 5, 'toda decisão traz o motivo');
});

console.log('H. O pacote de revisão');
await test('um pacote válido: resumo, lista de arquivos, diff, testes, branch e commit; congelado; totais; sem alertas quando tudo está limpo', () => {
  const t = novaTarefa();
  const r = montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote() }, { agora });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = r.pacote;
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.arquivos) && Object.isFrozen(p.diff) && Object.isFrozen(p.testes) && Object.isFrozen(p.totais) && Object.isFrozen(p.alertas));
  assert.deepEqual(Object.keys(p).sort(), ['alertas', 'arquivos', 'base', 'branch', 'commit', 'diff', 'geradoEm', 'projeto', 'resumo', 'tarefa', 'testes', 'totais', 'versao']);
  assert.equal(p.versao, 1);
  assert.equal(p.tarefa, t.id);
  assert.equal(p.projeto, 'yui');
  assert.equal(p.branch, t.branch);
  assert.equal(p.base, 'main');
  assert.equal(p.commit, 'a1b2c3d');
  assert.equal(p.geradoEm, new Date(agora()).toISOString());
  assert.equal(p.resumo, 'Corrigi a corrida na reconexão do canal e acrescentei um teste.');
  assert.deepEqual({ ...p.totais }, { arquivos: 2, adicoes: 13, remocoes: 1 });
  const diffCurto = 'diff --git a/x b/x\n+linha\n';
  assert.deepEqual({ ...p.diff }, { texto: diffCurto, bytes: Buffer.byteLength(diffCurto), bytesOriginais: Buffer.byteLength(diffCurto), cortado: false });
  assert.deepEqual({ ...p.testes }, { comando: 'npm run test:channel', executados: 40, passaram: 40, falharam: 0, duracaoMs: 12_000, ok: true, saidaFinal: '40 testes OK' });
  assert.deepEqual([...p.alertas], []);
});
await test('o DIFF é LIMITADO em tamanho (100 KB): corta numa quebra de linha, nunca parte um caractere UTF-8, avisa quanto ficou de fora, e o total nunca passa do limite', () => {
  assert.equal(LIMITES_DA_TAREFA.diffMaxBytes, 100_000);
  const linha = '+const x = "uma linha de código bem comprida para encher o diff";\n';
  const enorme = linha.repeat(Math.ceil(500_000 / linha.length));
  const r = limitarDiff(enorme);
  assert.equal(r.cortado, true);
  assert.ok(r.bytes <= 100_000, `bytes: ${r.bytes}`);
  assert.equal(r.bytes, Buffer.byteLength(r.texto, 'utf8'));
  assert.equal(r.bytesOriginais, Buffer.byteLength(enorme, 'utf8'));
  assert.match(r.texto, /\[\.\.\. diff cortado: \d+ bytes a mais ficaram de fora \.\.\.\]\n$/);
  assert.ok(r.texto.split('\n').slice(0, -2).every((l) => l === linha.trimEnd()), 'cortou numa quebra de linha: nenhuma linha partida');
  const omitido = Number(/diff cortado: (\d+) bytes/.exec(r.texto)[1]);
  assert.ok(omitido > 390_000 && omitido < 410_000, `omitido: ${omitido}`);
  // UTF-8 de vários bytes na fronteira
  for (const resto of [0, 1, 2, 3]) {
    const ac = `${'a'.repeat(99_880 + resto)}${'ação 😀 '.repeat(100)}\n`.repeat(3);
    const c = limitarDiff(ac);
    assert.ok(c.bytes <= 100_000);
    assert.ok(!c.texto.includes('\uFFFD'), 'partiu um caractere no meio');
  }
  const pequeno = limitarDiff('+a\n-b\n');
  assert.deepEqual(pequeno, { texto: '+a\n-b\n', bytes: 6, bytesOriginais: 6, cortado: false });
  const t = novaTarefa();
  const p = montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ diff: enorme }) }, { agora }).pacote;
  assert.equal(p.diff.cortado, true);
  assert.ok(p.diff.bytes <= 100_000);
  assert.ok(p.alertas.includes('diff-cortado'));
  assert.equal(limitarDiff('x'.repeat(200), 150).bytes <= 150, true, 'o limite é um parâmetro');
});
await test('segredos (chave de IA, Bearer, chave privada, token do GitHub, senha atribuída) NUNCA vão no diff, no resumo nem na saída dos testes do pacote', () => {
  const segredos = [['sk-ABCDEF0123456789abcdef', 'sk-ABCDEF0123456789abcdef'], ['Bearer abcdefghijklmnop0123456789', 'abcdefghijklmnop0123456789'], ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AIzaSyA-1234567890abcdefghijklmnopqrstuv', 'AIzaSyA-1234567890abcdefghijklmnopqrstuv'], ['xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'], ['api_key = "abcdef0123456789xyz"', 'abcdef0123456789xyz'], ['password: hunter2hunter2hunter2', 'hunter2hunter2hunter2'], ['senha=minhaSenhaSecreta123', 'minhaSenhaSecreta123']];
  for (const [texto, segredo] of segredos) {
    const saida = mascararSegredos(`antes ${texto} depois`);
    assert.ok(!saida.includes(segredo), `o segredo sobrou: ${texto}`);
    assert.ok(saida.includes('antes') && saida.includes('depois'), 'o resto do texto fica');
  }
  const chave = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123456789\n-----END RSA PRIVATE KEY-----';
  assert.ok(!mascararSegredos(`x\n${chave}\ny`).includes('MIIEowIBAAKCAQEA'));
  assert.equal(mascararSegredos('texto normal sem segredo'), 'texto normal sem segredo');
  const t = novaTarefa();
  const p = montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ diff: `+KEY=sk-ABCDEF0123456789abcdef\n${chave}\n`, resumo: 'usei o token ghp_abcdefghijklmnopqrstuvwxyz0123456789 no teste', testes: { ...testesOk(), saidaFinal: 'Authorization: Bearer abcdefghijklmnop0123456789' } }) }, { agora }).pacote;
  const json = JSON.stringify(p);
  for (const vazou of ['sk-ABCDEF0123456789abcdef', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'MIIEowIBAAKCAQEA', 'abcdefghijklmnop0123456789']) assert.equal(json.includes(vazou), false, `vazou: ${vazou}`);
  assert.ok(json.includes('[segredo removido]'));
});
await test('arquivos: caminho relativo e dentro do projeto; ".." , absoluto, letra de unidade, .env, secrets/, .git/ e chaves são recusados; situação e contagens são conferidas; de 1 a 200 arquivos', () => {
  const t = novaTarefa();
  const com = (a) => montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: [a] }) }, { agora });
  const bom = { caminho: 'src/a.js', situacao: 'modificado', adicoes: 1, remocoes: 0 };
  assert.equal(com(bom).ok, true);
  assert.equal(com({ ...bom, caminho: 'src\\a.js' }).pacote.arquivos[0].caminho, 'src/a.js', 'barra invertida vira barra');
  for (const caminho of ['../fora.js', 'src/../../fora.js', '/etc/passwd', 'C:/Windows/x', 'C:\\x', '', 'src//a.js', '.env', '.env.local', 'config/.env', 'secrets/ai.json', 'chave.pem', 'a/b/id_rsa', '.git/config', '.npmrc', 'x'.repeat(261), 'a\u0000b', 'a\nb', null, 7]) {
    const r = com({ ...bom, caminho });
    assert.equal(r.ok, false, JSON.stringify(caminho));
    assert.ok(r.erros.some((e) => /caminho|arquivo-sensivel/.test(e.codigo)), `${JSON.stringify(caminho)}: ${JSON.stringify(r.erros)}`);
  }
  for (const [troca, codigo] of [[{ situacao: 'mudou' }, 'situacao-invalida'], [{ adicoes: -1 }, 'adicoes-invalidas'], [{ remocoes: 1.5 }, 'remocoes-invalidas'], [{ adicoes: '3' }, 'adicoes-invalidas'], [{ extra: 1 }, 'campo-desconhecido']]) {
    assert.ok(com({ ...bom, ...troca }).erros.some((e) => e.codigo === codigo), codigo);
  }
  assert.ok(com('texto').erros.some((e) => e.codigo === 'arquivo-invalido'));
  assert.ok(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: [] }) }).erros.some((e) => e.codigo === 'sem-arquivos'));
  assert.ok(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: null }) }).erros.some((e) => e.codigo === 'sem-arquivos'));
  const muitos = Array.from({ length: 201 }, (_, i) => ({ ...bom, caminho: `src/a${i}.js` }));
  assert.ok(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: muitos }) }).erros.some((e) => e.codigo === 'arquivos-demais'));
  assert.equal(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: muitos.slice(0, 200) }) }, { agora }).ok, true);
});
await test('testes: o comando segue a lista de executáveis, as contagens são coerentes, "ok" é DERIVADO (nunca informado) e falha ou ausência de testes vira alerta', () => {
  const t = novaTarefa();
  const com = (testes) => montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ testes }) }, { agora });
  assert.equal(com({ ...testesOk(), comando: 'curl https://x.com' }).erros.some((e) => e.codigo === 'comando-de-teste-invalido'), true);
  assert.equal(com({ ...testesOk(), comando: 'npm test; rm x' }).ok, false);
  assert.equal(com({ ...testesOk(), comando: '' }).ok, false);
  for (const ruim of [{ passaram: 41 }, { executados: -1 }, { passaram: 30, falharam: 11 }, { falharam: 1.5 }, { duracaoMs: -5 }, { executados: '40' }]) assert.ok(com({ ...testesOk(), ...ruim }).erros.some((e) => e.codigo === 'contagem-de-testes-invalida'), JSON.stringify(ruim));
  assert.equal(com('npm test').ok, false);
  assert.equal(com([]).ok, false);
  const falhando = com({ ...testesOk(), passaram: 38, falharam: 2, ok: true }).pacote;
  assert.equal(falhando.testes.ok, false, 'o "ok" informado é ignorado: a conta vale');
  assert.ok(falhando.alertas.includes('testes-falhando'));
  const zero = com({ ...testesOk(), executados: 0, passaram: 0, falharam: 0 }).pacote;
  assert.equal(zero.testes.ok, false, 'rodar zero testes não é passar');
  assert.ok(zero.alertas.includes('testes-falhando'));
  const sem = com(null).pacote;
  assert.deepEqual({ ...sem.testes }, { semTestes: true });
  assert.ok(sem.alertas.includes('sem-testes'));
  assert.deepEqual({ ...com(undefined).pacote.testes }, { semTestes: true });
  const parcial = com({ ...testesOk(), executados: 45, passaram: 40, falharam: 0 }).pacote;
  assert.equal(parcial.testes.ok, true, 'testes ignorados (45 rodados, 40 passaram, 0 falharam) não reprovam');
  assert.equal(com({ ...testesOk(), saidaFinal: 'x'.repeat(10_000) }).pacote.testes.saidaFinal.length, 4000, 'a saída dos testes é cortada no fim (as últimas 4000)');
});
await test('os ALERTAS apontam o que o dono precisa olhar com cuidado (package.json, lockfile, workflow, hooks, scripts do sistema, muitas remoções); resumo, commit e base também são conferidos', () => {
  const a = (...caminhos) => alertasDosArquivos(caminhos.map((caminho) => ({ caminho, situacao: 'modificado', adicoes: 1, remocoes: 0 })));
  assert.deepEqual(a('src/a.js', 'tests/a.js', 'docs/x.md'), []);
  assert.deepEqual(a('package.json'), ['package-json-alterado']);
  assert.deepEqual(a('apps/yui-app/package.json'), ['package-json-alterado']);
  assert.deepEqual(a('package-lock.json'), ['lockfile-alterado']);
  assert.deepEqual(a('.github/workflows/ci.yml'), ['workflow-alterado']);
  assert.deepEqual(a('.husky/pre-commit'), ['hook-ou-config-do-git-alterado']);
  assert.deepEqual(a('scripts/x.ps1', 'run.sh', 'a.BAT'), ['script-do-sistema-alterado']);
  assert.deepEqual(a('package.json', 'package-lock.json', '.github/workflows/a.yml').sort(), ['lockfile-alterado', 'package-json-alterado', 'workflow-alterado']);
  assert.deepEqual(alertasDosArquivos(Array.from({ length: 21 }, (_, i) => ({ caminho: `src/a${i}.js`, situacao: 'removido', adicoes: 0, remocoes: 9 }))), ['muitas-remocoes']);
  const t = novaTarefa();
  const p = montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ arquivos: [{ caminho: 'package.json', situacao: 'modificado', adicoes: 2, remocoes: 0 }] }) }, { agora }).pacote;
  assert.deepEqual([...p.alertas], ['package-json-alterado']);
  for (const [troca, codigo] of [[{ resumo: '' }, 'resumo-invalido'], [{ resumo: 'x'.repeat(2001) }, 'resumo-invalido'], [{ resumo: 7 }, 'resumo-invalido'], [{ commit: 'xyz' }, 'commit-invalido'], [{ commit: 'a'.repeat(41) }, 'commit-invalido'],
    [{ base: 'a b' }, 'base-invalida'], [{ base: '' }, 'base-invalida'], [{ diff: 7 }, 'diff-invalido'], [{ diff: null }, 'diff-invalido']]) {
    assert.ok(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote(troca) }).erros.some((e) => e.codigo === codigo), codigo);
  }
  assert.equal(montarPacoteDeRevisao({ tarefa: t, ...entradaDoPacote({ commit: null }) }, { agora }).pacote.commit, null);
  assert.equal(montarPacoteDeRevisao().ok, false);
});

console.log('I. A tarefa de ponta a ponta');
await test('o caminho feliz: pendente -> preparando -> rodando -> revisao -> aprovada; a tarefa antiga nunca muda; o histórico guarda cada passo; o pacote só aparece na entrega', () => {
  const t0 = novaTarefa();
  const t1 = aplicarEvento(t0, 'preparar', {}, { agora }).tarefa;
  avancar(1000);
  const t2 = aplicarEvento(t1, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t0) }, { agora }).tarefa;
  avancar(60_000);
  const t3 = aplicarEvento(t2, 'entregar', entradaDoPacote(), { agora }).tarefa;
  avancar(5000);
  const r = aplicarEvento(t3, 'aprovar', DONO, { agora });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t4 = r.tarefa;
  assert.deepEqual([t0, t1, t2, t3, t4].map((t) => t.estado), ['pendente', 'preparando', 'rodando', 'revisao', 'aprovada']);
  assert.equal(t0.estado, 'pendente', 'a antiga não muda');
  assert.equal(t0.comecouEm, null);
  assert.equal(t2.worktree, path.resolve(worktreeDe(t0)));
  assert.equal(t2.pacote, null, 'sem pacote até a entrega');
  assert.equal(t3.pacote.branch, t0.branch);
  assert.deepEqual(t4.historico.map((h) => `${h.de}>${h.para}`), ['null>pendente', 'pendente>preparando', 'preparando>rodando', 'rodando>revisao', 'revisao>aprovada']);
  assert.equal(t4.terminouEm, agora());
  assert.ok(Object.isFrozen(t4) && Object.isFrozen(t4.historico));
  assert.equal(t4.atualizadaEm, agora());
});
await test('iniciar exige um ambiente isolado válido (worktree em .yui/worktrees/<id>, nunca o projeto); com ambiente ruim a tarefa continua em "preparando"', () => {
  const t = aplicarEvento(novaTarefa(), 'preparar', {}, { agora }).tarefa;
  for (const dados of [{ projetoPasta: PROJETO_PASTA, worktree: PROJETO_PASTA }, { projetoPasta: PROJETO_PASTA, worktree: path.join(PROJETO_PASTA, 'src') }, { projetoPasta: PROJETO_PASTA, worktree: path.join(os.tmpdir(), 'x') },
    { projetoPasta: PROJETO_PASTA, worktree: path.join(PROJETO_PASTA, '.yui', 'worktrees', 'tar_de_outra') }, {}, undefined]) {
    const r = aplicarEvento(t, 'iniciar', dados, { agora });
    assert.equal(r.ok, false, JSON.stringify(dados));
    assert.ok(/worktree|ambiente/.test(r.codigo), r.codigo);
  }
  assert.equal(t.estado, 'preparando');
});
await test('entregar exige um pacote VÁLIDO (senão a tarefa continua rodando) e aprovar só vale com pacote; o pacote nasce desta tarefa (id, projeto, branch)', () => {
  let t = aplicarEvento(novaTarefa(), 'preparar', {}, { agora }).tarefa;
  t = aplicarEvento(t, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(t) }, { agora }).tarefa;
  const ruim = aplicarEvento(t, 'entregar', entradaDoPacote({ arquivos: [{ caminho: '../fora.js', situacao: 'modificado', adicoes: 1, remocoes: 0 }] }), { agora });
  assert.equal(ruim.ok, false);
  assert.equal(ruim.codigo, 'pacote-invalido');
  assert.ok(ruim.erros.length >= 1);
  assert.equal(t.estado, 'rodando');
  assert.equal(aplicarEvento(t, 'entregar', undefined, { agora }).codigo, 'pacote-invalido');
  const ok = aplicarEvento(t, 'entregar', entradaDoPacote(), { agora }).tarefa;
  assert.deepEqual([ok.pacote.tarefa, ok.pacote.projeto, ok.pacote.branch], [t.id, t.projeto, t.branch]);
  assert.equal(aplicarEvento({ ...ok, pacote: null }, 'aprovar', DONO, { agora }).codigo, 'sem-pacote');
});
await test('aprovar, rejeitar e cancelar são SÓ do dono, por canal privado; membro, público, servidor público e chat da live são recusados e a tarefa não muda', () => {
  const r = atéRevisao();
  for (const evento of ['aprovar', 'rejeitar', 'cancelar']) {
    for (const dados of [{ papel: 'membro', canal: 'app' }, { papel: 'publico', canal: 'discord_dm' }, { papel: 'dono', canal: 'discord_guild' }, { papel: 'dono', canal: 'youtube_live' }, { papel: undefined, canal: 'app' }, {}, undefined]) {
      const x = aplicarEvento(r, evento, dados, { agora });
      assert.equal(x.ok, false, `${evento} ${JSON.stringify(dados)}`);
      assert.ok(['nao-e-o-dono', 'canal-nao-permitido'].includes(x.codigo));
    }
  }
  assert.equal(r.estado, 'revisao');
  for (const canal of ['app', 'pc', 'discord_dm']) assert.equal(aplicarEvento(r, 'aprovar', { papel: 'dono', canal }, { agora }).ok, true, canal);
});
await test('aprovar um pacote com testes falhando (ou sem testes) exige a confirmação explícita "ciente"; com testes limpos não precisa', () => {
  const falhando = atéRevisao({ testes: { ...testesOk(), passaram: 38, falharam: 2 } });
  assert.equal(aplicarEvento(falhando, 'aprovar', DONO, { agora }).codigo, 'ciente-necessario');
  assert.equal(aplicarEvento(falhando, 'aprovar', { ...DONO, ciente: 'sim' }, { agora }).codigo, 'ciente-necessario', 'só o booleano true vale');
  assert.equal(aplicarEvento(falhando, 'aprovar', { ...DONO, ciente: true }, { agora }).ok, true);
  const sem = atéRevisao({ testes: null });
  assert.equal(aplicarEvento(sem, 'aprovar', DONO, { agora }).codigo, 'ciente-necessario');
  assert.equal(aplicarEvento(sem, 'aprovar', { ...DONO, ciente: true }, { agora }).ok, true);
  assert.equal(aplicarEvento(atéRevisao(), 'aprovar', DONO, { agora }).ok, true);
  assert.equal(aplicarEvento(falhando, 'rejeitar', DONO, { agora }).ok, true, 'rejeitar nunca exige ciente');
});
await test('rejeitar (com ou sem motivo), cancelar de qualquer estado não final, falhar com código e tempo esgotado levam ao estado certo', () => {
  const r = atéRevisao();
  assert.equal(aplicarEvento(r, 'rejeitar', { ...DONO, motivo: 'faltou cobrir o caso X' }, { agora }).tarefa.estado, 'rejeitada');
  assert.equal(aplicarEvento(r, 'rejeitar', DONO, { agora }).tarefa.estado, 'rejeitada');
  assert.equal(aplicarEvento(r, 'rejeitar', { ...DONO, motivo: 'x'.repeat(501) }, { agora }).codigo, 'motivo-invalido');
  assert.equal(aplicarEvento(r, 'rejeitar', { ...DONO, motivo: 5 }, { agora }).codigo, 'motivo-invalido');
  const novo = novaTarefa();
  const preparando = aplicarEvento(novo, 'preparar', {}, { agora }).tarefa;
  const rodando = aplicarEvento(preparando, 'iniciar', { projetoPasta: PROJETO_PASTA, worktree: worktreeDe(novo) }, { agora }).tarefa;
  for (const t of [novo, preparando, rodando, r]) {
    const c = aplicarEvento(t, 'cancelar', DONO, { agora });
    assert.equal(c.ok, true, t.estado);
    assert.equal(c.tarefa.estado, 'cancelada');
    assert.notEqual(c.tarefa.terminouEm, null);
  }
  const f = aplicarEvento(rodando, 'falhar', { codigo: 'teste-quebrou', texto: 'Os testes não passaram.\nlinha dois' }, { agora });
  assert.equal(f.tarefa.estado, 'falhou');
  assert.deepEqual({ ...f.tarefa.erro }, { codigo: 'teste-quebrou', texto: 'Os testes não passaram. linha dois' });
  assert.equal(aplicarEvento(preparando, 'falhar', {}, { agora }).tarefa.erro.codigo, 'erro');
  assert.equal(aplicarEvento(rodando, 'falhar', { codigo: 'Código Ruim!', texto: 'x'.repeat(500) }, { agora }).tarefa.erro.texto.length, 200);
  assert.equal(aplicarEvento(rodando, 'falhar', { codigo: 'Código Ruim!' }, { agora }).tarefa.erro.codigo, 'erro', 'código fora do padrão vira "erro"');
});
await test('uma tarefa terminada (aprovada, rejeitada, falhou, cancelada) não aceita mais nenhum evento', () => {
  const r = atéRevisao();
  const finais = [aplicarEvento(r, 'aprovar', DONO, { agora }).tarefa, aplicarEvento(r, 'rejeitar', DONO, { agora }).tarefa, aplicarEvento(r, 'cancelar', DONO, { agora }).tarefa,
    aplicarEvento(aplicarEvento(novaTarefa(), 'preparar', {}, { agora }).tarefa, 'falhar', {}, { agora }).tarefa];
  assert.deepEqual(finais.map((t) => t.estado), ['aprovada', 'rejeitada', 'cancelada', 'falhou']);
  for (const t of finais) for (const evento of EVENTOS_DA_TAREFA) assert.equal(aplicarEvento(t, evento, { ...DONO, ciente: true, ...entradaDoPacote() }, { agora }).codigo, 'tarefa-encerrada', `${t.estado} + ${evento}`);
});
await test('o histórico guarda no máximo 50 passos e a tarefa continua imutável (congelada em cada etapa)', () => {
  let t = novaTarefa();
  t = aplicarEvento(t, 'preparar', {}, { agora }).tarefa;
  assert.throws(() => { 'use strict'; t.estado = 'aprovada'; }, TypeError);
  assert.throws(() => { 'use strict'; t.historico.push({}); }, TypeError);
  const longo = { ...t, historico: Object.freeze(Array.from({ length: 60 }, (_, i) => Object.freeze({ de: null, para: 'pendente', evento: 'x', em: i }))) };
  const depois = aplicarEvento(longo, 'cancelar', DONO, { agora }).tarefa;
  assert.equal(depois.historico.length, 50);
  assert.equal(depois.historico.at(-1).para, 'cancelada');
});

console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
