// Testes das seções "Listas", "Skills" e "Projetos e decisões" do Admin (item 12 do plano das lacunas do painel, 27/11/2026): a lógica pura
// (src/transparenciaLogic.ts), o cliente da API (GET /v1/admin/listas, /skills, /continuidade e DELETE /v1/admin/continuidade/:id) e a ligação na tela.
// Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  TEXTO_CONTINUIDADE_VAZIA, TEXTO_LISTAS_DESLIGADAS, confirmacaoDeApagar, dataCurta, filtrarContinuidade, motivoDaSkill, resumoDaContinuidade, resumoDasListas,
  textoDoFiltro, vistaDaLista, vistaDaSkill, vistaDoItem,
} from '../src/transparenciaLogic.ts';

const local = (ano, mes, d, h = 12) => new Date(ano, mes - 1, d, h, 0).toISOString();
const LISTA = (over = {}) => ({ nome: 'Mercado', total: 3, feitos: 1, atualizadaEm: local(2026, 11, 26), itens: [{ texto: 'leite', feito: true }, { texto: 'pão', feito: false }, { texto: 'café', feito: false }], ...over });
const SKILL = (over = {}) => ({ nome: 'resumo-do-dia', descricao: 'Resume o dia em tópicos.', origem: 'yui', licenca: 'MIT', permitida: true, ignorados: [], ...over });
const ITEM = (over = {}) => ({ id: 3, tipo: 'projeto', texto: 'Projeto Yui: painel web', criadoEm: local(2026, 11, 1), atualizadoEm: local(2026, 11, 1), ...over });

test('listas: resumo (listas, itens e feitos, no singular e no plural) e o cartão (contagem, quando mudou, itens numerados)', () => {
  assert.equal(resumoDasListas({ listas: [] }), 'Nenhuma lista');
  assert.equal(resumoDasListas(null), 'Nenhuma lista');
  assert.equal(resumoDasListas({ listas: [LISTA(), LISTA({ nome: 'Filmes', total: 1, feitos: 0 })] }), '2 listas, 4 itens (1 feito)');
  assert.equal(resumoDasListas({ listas: [LISTA({ total: 1, feitos: 0 })] }), '1 lista, 1 item');
  const v = vistaDaLista(LISTA());
  assert.deepEqual([v.titulo, v.contagem, v.quando], ['Mercado', '3 itens, 1 feito', 'Mudou em 26/11/2026']);
  assert.deepEqual(v.itens.map((i) => `${i.n}:${i.texto}:${i.feito}`), ['1:leite:true', '2:pão:false', '3:café:false']);
  assert.deepEqual([vistaDaLista(LISTA({ total: 0, feitos: 0, itens: [], atualizadaEm: null })).contagem, vistaDaLista(LISTA({ atualizadaEm: null })).quando], ['Vazia', '']);
  assert.match(TEXTO_LISTAS_DESLIGADAS, /Configuração e chaves/);
});

test('skills: a linha do filtro (desligadas, só a lista, todas) e o cartão (origem, licença, selo, o que foi ignorado); motivo em português', () => {
  assert.deepEqual(textoDoFiltro({ ligado: false, filtro: 'todas', total: 3, ativas: 3 }).tom, 'neutro');
  assert.match(textoDoFiltro({ ligado: false, filtro: 'todas', total: 3, ativas: 3 }).texto, /desligadas/);
  assert.deepEqual(textoDoFiltro({ ligado: true, filtro: 'lista', total: 3, ativas: 2 }), { texto: '2 skills permitidas de 3 (só as da lista de permitidas).', tom: 'ok' });
  assert.equal(textoDoFiltro({ ligado: true, filtro: 'lista', total: 3, ativas: 0 }).tom, 'atencao');
  assert.equal(textoDoFiltro({ ligado: true, filtro: 'todas', total: 1, ativas: 1 }).texto, 'A única skill instalada vale (a lista de permitidas está vazia).');
  assert.equal(textoDoFiltro({ ligado: true, filtro: 'todas', total: 4, ativas: 4 }).texto, 'Todas as 4 skills instaladas valem (a lista de permitidas está vazia).');
  assert.deepEqual(textoDoFiltro({ ligado: true, filtro: 'todas', total: 0, ativas: 0 }), { texto: 'Nenhuma skill instalada.', tom: 'neutro' });
  const v = vistaDaSkill(SKILL({ ignorados: ['scripts', 'allowed-tools'] }));
  assert.deepEqual([v.nome, v.origem, v.selo, v.tom], ['resumo-do-dia', 'vem com a Yui • licença MIT', 'Permitida', 'ok']);
  assert.equal(v.nota, 'Ignorado por segurança: a pasta scripts e o allowed-tools (nada de uma skill é executado).');
  assert.deepEqual([vistaDaSkill(SKILL({ permitida: false, origem: 'dono', licenca: null })).selo, vistaDaSkill(SKILL({ origem: 'dono', licenca: null })).origem], ['Fora da lista', 'instalada por você']);
  assert.deepEqual([vistaDaSkill(SKILL(), false).selo, vistaDaSkill(SKILL(), false).tom], ['Desligada', 'neutro']);
  assert.equal(vistaDaSkill(SKILL()).nota, null);
  assert.equal(motivoDaSkill('nome_diferente_da_pasta'), 'nome diferente da pasta');
  assert.equal(motivoDaSkill('novo_motivo'), 'novo_motivo');
});

test('continuidade: resumo, filtro (tudo, projetos, decisões) do mais recente para o mais antigo, o cartão e a lista recebida intacta', () => {
  assert.equal(resumoDaContinuidade({ projetos: 0, decisoes: 0 }), 'Nada registrado');
  assert.equal(resumoDaContinuidade({ projetos: 2, decisoes: 1 }), '2 projetos e 1 decisão');
  const itens = [
    ITEM({ id: 1, atualizadoEm: local(2026, 11, 1) }),
    ITEM({ id: 2, tipo: 'decisao', texto: 'Usar o OmniRoute.', atualizadoEm: local(2026, 11, 20) }),
    ITEM({ id: 5, atualizadoEm: local(2026, 11, 10) }),
  ];
  const copia = JSON.stringify(itens);
  assert.deepEqual(filtrarContinuidade(itens, 'todos').map((i) => i.id), [2, 5, 1]);
  assert.deepEqual(filtrarContinuidade(itens, 'projeto').map((i) => i.id), [5, 1]);
  assert.deepEqual(filtrarContinuidade(itens, 'decisao').map((i) => i.id), [2]);
  assert.equal(JSON.stringify(itens), copia);
  const v = vistaDoItem(ITEM({ atualizadoEm: local(2026, 11, 3) }));
  assert.deepEqual([v.tipo, v.numero, v.quando], ['Projeto', '#3', 'Guardado em 01/11/2026 (renovado em 03/11/2026)']);
  assert.deepEqual([vistaDoItem(ITEM()).quando, vistaDoItem(ITEM({ tipo: 'decisao' })).tipo], ['Guardado em 01/11/2026', 'Decisão']);
  assert.equal(dataCurta('lixo'), '—');
  assert.match(TEXTO_CONTINUIDADE_VAZIA, /novo projeto/);
});

test('apagar pede confirmação explícita, com o tipo, o número e um trecho, e diz que não dá para desfazer', () => {
  const c = confirmacaoDeApagar(ITEM({ texto: 'x'.repeat(300) }));
  assert.equal(c.titulo, 'Apagar este projeto?');
  assert.match(c.mensagem, /^#3 · x{119}…\n\n/);
  assert.match(c.mensagem, /Não dá para desfazer/);
  assert.equal(c.sim, 'Apagar');
  assert.equal(confirmacaoDeApagar(ITEM({ tipo: 'decisao' })).titulo, 'Apagar esta decisão?');
});

test('cliente: as três leituras por GET (sem corpo) e o apagar por DELETE com { confirm: true } e só o número inteiro no caminho', async () => {
  const calls = [];
  let resposta = { status: 200, body: {} };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  await c.admin.listas();
  await c.admin.skills();
  await c.admin.continuidade();
  await c.admin.apagarContinuidade(7.9);
  assert.deepEqual(calls.map((x) => [x.method, x.url.replace('http://yui.local:3939', ''), x.body]), [
    ['GET', '/v1/admin/listas', null], ['GET', '/v1/admin/skills', null], ['GET', '/v1/admin/continuidade', null], ['DELETE', '/v1/admin/continuidade/7', { confirm: true }],
  ]);
  resposta = { status: 404, body: { error: 'Projeto ou decisão não encontrado (ou já apagado).' } };
  await assert.rejects(() => c.admin.apagarContinuidade(4), (e) => e instanceof ApiError && e.status === 404 && /não encontrado/.test(e.message));
  resposta = { status: 403, body: { error: 'proibido' } };
  await assert.rejects(() => c.admin.listas(), (e) => e instanceof ApiError && e.status === 403);
});

test('a tela: as três no grupo "IA e memória"; apagar só depois da confirmação; listas e skills só leitura', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const ia = admin.slice(admin.indexOf("title: 'IA e memória'"), admin.indexOf("title: 'Segurança e registros'"));
  for (const s of ["{ key: 'continuidade', label: 'Projetos e decisões' }", "{ key: 'listas', label: 'Listas' }", "{ key: 'skills', label: 'Skills' }"]) assert.ok(ia.includes(s), s);
  for (const s of ['<Continuidade client={client} />', '<Listas client={client} />', '<Skills client={client} />']) assert.ok(admin.includes(s), s);
  const tela = fs.readFileSync(path.join(raiz, 'AdminTransparencia.tsx'), 'utf8');
  assert.match(tela, /const c = confirmacaoDeApagar\(i\);\s*confirmAction\(c\.titulo, c\.mensagem,/);
  assert.ok(tela.indexOf('confirmAction(') < tela.indexOf('client.admin.apagarContinuidade('), 'o pedido fica dentro da confirmação');
  const listasESkills = tela.slice(tela.indexOf('export function Listas('), tela.indexOf('const FILTROS'));
  assert.doesNotMatch(listasESkills, /confirmAction|apagar/i, 'listas e skills: só ver');
  for (const p of ['kind="loading"', 'kind="error"', 'kind="empty"', 'TEXTO_LISTAS_DESLIGADAS', 'TEXTO_CONTINUIDADE_SEM_MEMORIA']) assert.ok(tela.includes(p), p);
});
