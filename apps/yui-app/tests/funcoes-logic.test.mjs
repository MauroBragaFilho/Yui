// Testes da aba "Funções" do servidor (item 8 do plano das lacunas do painel, 27/11/2026): a lógica pura (src/funcoesLogic.ts), a cobertura de TODAS as
// ferramentas alternáveis do mcp_tools.json (nenhuma fica sem interruptor depois que a aba antiga saiu) e a ligação na tela. Sem React e sem rede.
// Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FUNCOES, OUTRAS_FUNCOES, TEXTO_DO_ESTADO, estadoDoGtaAgendado, montarFuncoes, mudancaDaFuncao, perguntaDaFuncao, resultadoDaFuncao,
} from '../src/funcoesLogic.ts';

const raizRepo = path.resolve(import.meta.dirname, '..', '..', '..');
const telas = path.resolve(import.meta.dirname, '..', 'src', 'screens');

// A lista que o servidor manda (src/discord/painelServidor.js: as ferramentas com meta.disableable, menos o leave_voice_call, que acompanha o join).
function ferramentasDoServidor(ligadas = null) {
  const todas = JSON.parse(fs.readFileSync(path.join(raizRepo, 'src', 'data', 'mcp_tools.json'), 'utf8'));
  return todas.filter((t) => t.meta && t.meta.disableable && t.function.name !== 'leave_voice_call').map((t) => ({
    nome: t.function.name, rotulo: t.meta.label, descricao: t.meta.description || '', padraoLigada: !t.meta.defaultDisabled,
    ligada: ligadas ? ligadas.includes(t.function.name) : !t.meta.defaultDisabled,
  }));
}
const T = (nome, ligada = true, padraoLigada = true, rotulo = nome) => ({ nome, rotulo, descricao: `descrição de ${nome}`, ligada, padraoLigada });

test('as funções do pedido estão na lista principal, nesta ordem, com nome simples; os dois downloads e os dois lembretes viram uma função só', () => {
  const { principais } = montarFuncoes(ferramentasDoServidor());
  assert.deepEqual(principais.map((f) => f.chave), ['imagem', 'pesquisa', 'gta', 'downloads', 'jogo', 'steam', 'moeda', 'lembretes', 'voz', 'falar']);
  const por = Object.fromEntries(principais.map((f) => [f.chave, f]));
  assert.deepEqual(por.downloads.ferramentas, ['download_audio', 'download_video']);
  assert.deepEqual(por.lembretes.ferramentas, ['listar_lembretes', 'criar_lembrete']);
  assert.deepEqual(por.imagem.ferramentas, ['generate_image']);
  assert.deepEqual(por.gta.ferramentas, ['gta_online']);
  assert.deepEqual(por.voz.ferramentas, ['join_voice_call']);
  for (const f of principais) assert.doesNotMatch(f.nome, /[\p{Extended_Pictographic}_]/u, `${f.chave}: nome sem emoji nem nome técnico`);
});

test('TODA ferramenta alternável do mcp_tools.json tem uma função (principal ou outra) definida aqui: nada cai no "sem nome" e nada fica sem interruptor', () => {
  const lista = ferramentasDoServidor();
  assert.ok(lista.length >= 15, `poucas ferramentas lidas (${lista.length})`);
  const { principais, outras } = montarFuncoes(lista);
  const cobertas = [...principais, ...outras].flatMap((f) => f.ferramentas).sort();
  assert.deepEqual(cobertas, lista.map((f) => f.nome).sort());
  assert.deepEqual(outras.filter((f) => f.chave.startsWith('ferramenta-')).map((f) => f.chave), [], 'ferramenta nova no mcp_tools.json: dê a ela uma função em src/funcoesLogic.ts');
  const definidas = [...FUNCOES, ...OUTRAS_FUNCOES].flatMap((d) => d.ferramentas);
  assert.equal(new Set(definidas).size, definidas.length, 'nenhuma ferramenta em duas funções');
});

test('estado: ligada, desligada ou em parte; o padrão segue o padrão de cada ferramenta; função sem ferramenta no servidor some', () => {
  const r = montarFuncoes([T('download_audio', true), T('download_video', false), T('generate_image', false, true), T('voice_tts', true, false), T('search_web', true)]);
  const por = Object.fromEntries([...r.principais, ...r.outras].map((f) => [f.chave, f]));
  assert.deepEqual([por.downloads.estado, por.imagem.estado, por.falar.estado, por.pesquisa.estado], ['em-parte', 'desligada', 'ligada', 'ligada']);
  assert.deepEqual([por.downloads.padrao, por.falar.padrao], ['ligada', 'desligada']);
  assert.ok(!por.steam && !por.lembretes, 'sem a ferramenta no servidor, a função não aparece');
  assert.deepEqual(r.principais.map((f) => f.chave), ['imagem', 'pesquisa', 'downloads', 'falar']);
  assert.deepEqual([TEXTO_DO_ESTADO.ligada, TEXTO_DO_ESTADO.desligada, TEXTO_DO_ESTADO['em-parte']], ['Ligada', 'Desligada', 'Em parte']);
});

test('ferramenta desconhecida vira uma "outra função" com o rótulo do servidor sem emoji; a lista recebida não muda', () => {
  const lista = [T('generate_image'), T('nova_ferramenta', false, true, '🧪 Ferramenta Nova')];
  const copia = JSON.stringify(lista);
  const { outras } = montarFuncoes(lista);
  assert.deepEqual(outras.map((f) => [f.chave, f.nome, f.estado, f.ferramentas]), [['ferramenta-nova_ferramenta', 'Ferramenta Nova', 'desligada', ['nova_ferramenta']]]);
  assert.equal(JSON.stringify(lista), copia);
  assert.deepEqual(montarFuncoes(null), { principais: [], outras: [] });
});

test('o interruptor: ligada desliga todas; desligada liga todas; em parte liga só as que faltam', () => {
  const atuais = [T('download_audio', true), T('download_video', false), T('listar_lembretes', false), T('criar_lembrete', false), T('generate_image', true)];
  const por = Object.fromEntries(montarFuncoes(atuais).principais.map((f) => [f.chave, f]));
  assert.deepEqual(mudancaDaFuncao(por.downloads, atuais), { ligar: true, ferramentas: ['download_video'] });
  assert.deepEqual(mudancaDaFuncao(por.lembretes, atuais), { ligar: true, ferramentas: ['listar_lembretes', 'criar_lembrete'] });
  assert.deepEqual(mudancaDaFuncao(por.imagem, atuais), { ligar: false, ferramentas: ['generate_image'] });
});

test('a confirmação: ao LIGAR mostra o aviso (downloads, voz, falar, rádio); ao desligar diz que a DM não muda; o botão diz o que faz', () => {
  const { principais, outras } = montarFuncoes(ferramentasDoServidor());
  const por = Object.fromEntries([...principais, ...outras].map((f) => [f.chave, f]));
  for (const chave of ['downloads', 'jogo', 'voz', 'falar', 'radio-voz', 'musica']) {
    const p = perguntaDaFuncao(por[chave], true);
    assert.match(p.texto, /Atenção: /, chave);
    assert.equal(p.sim, 'Ligar');
  }
  assert.match(perguntaDaFuncao(por.falar, true).texto, /todos que estiverem na call/);
  const desligar = perguntaDaFuncao(por.downloads, false);
  assert.equal(desligar.titulo, 'Desligar função?');
  assert.doesNotMatch(desligar.texto, /Atenção/);
  assert.match(desligar.texto, /Na DM nada muda/);
  assert.equal(desligar.sim, 'Desligar');
  assert.equal(perguntaDaFuncao(por.steam, true).texto, '"Steam" neste servidor.');
});

test('o resultado: tudo certo, parte (quantas de quantas e o erro) ou nada', () => {
  assert.equal(resultadoDaFuncao('Lembretes', true, 2, 2), 'Lembretes: ligada.');
  assert.equal(resultadoDaFuncao('Lembretes', false, 2, 2), 'Lembretes: desligada.');
  assert.equal(resultadoDaFuncao('Lembretes', true, 1, 2, 'Erro do servidor (HTTP 500).'), 'Lembretes: só 1 de 2 partes mudaram (Erro do servidor (HTTP 500).). Confira o estado abaixo e tente de novo.');
  assert.match(resultadoDaFuncao('Steam', true, 0, 1, 'x'), /nada mudou/);
});

test('GTA agendado: por canal; mostra se cada tipo tem canal (e qual), com o resumo', () => {
  const canais = { diario: { id: '1', name: 'gta-diario' }, semanal: null, noticias: { id: '3', name: null }, atualizacoes: null };
  const g = estadoDoGtaAgendado(canais);
  assert.deepEqual(g.linhas.map((l) => [l.tipo, l.configurado, l.texto]), [
    ['diario', true, 'Publica em #gta-diario'], ['semanal', false, 'Sem canal: não publica neste servidor'], ['noticias', true, 'Publica em canal 3'],
  ]);
  assert.equal(g.resumo, '2 de 3 com canal');
  assert.equal(estadoDoGtaAgendado({ diario: null, semanal: null, noticias: null, atualizacoes: null }).resumo, 'Nenhum canal configurado');
  assert.equal(estadoDoGtaAgendado(null).resumo, 'Nenhum canal configurado');
  assert.equal(estadoDoGtaAgendado({ diario: { id: '1', name: 'a' }, semanal: { id: '2', name: 'b' }, noticias: { id: '3', name: 'c' }, atualizacoes: null }).resumo, 'Os três com canal');
});

test('a tela: a aba "Funções" substitui a antiga "Ferramentas" do servidor; confirma antes de mudar, uma rota por ferramenta, e o atalho abre os canais', () => {
  const guild = fs.readFileSync(path.join(telas, 'AdminGuild.tsx'), 'utf8');
  assert.match(guild, /\{ key: 'funcoes', label: 'Funções' \}/);
  assert.doesNotMatch(guild, /key: 'ferramentas'/, 'a aba antiga saiu');
  assert.match(guild, /irParaCanais=\{\(\) => abrir\('publicacoes'\)\}/);
  const extras = fs.readFileSync(path.join(telas, 'AdminGuildExtras.tsx'), 'utf8');
  assert.match(extras, /export type Secao = 'funcoes' \| 'termos' \| 'canal';/);
  assert.doesNotMatch(extras, /function Ferramentas\(/, 'o componente antigo saiu');
  const funcoes = extras.slice(extras.indexOf('function Funcoes('), extras.indexOf('function Termos('));
  assert.ok(funcoes.includes('montarFuncoes(data)') && funcoes.includes('mudancaDaFuncao(') && funcoes.includes('estadoDoGtaAgendado(guild.channels)'), 'a tela usa a lógica pura');
  assert.ok(funcoes.indexOf('confirmAction(') < funcoes.indexOf('client.admin.setGuildTool('), 'mudar só depois da confirmação');
  assert.match(funcoes, /for \(const nome of m\.ferramentas\)/);
  assert.match(funcoes, /client\.admin\.resetGuildTools\(guildId\)/);
  assert.match(funcoes, /testID="guild-gta-canais"/);
});
