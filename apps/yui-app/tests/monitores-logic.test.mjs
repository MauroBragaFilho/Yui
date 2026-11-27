// Testes da seção "Monitores" do Admin (item 7 do plano das lacunas do painel, 26/11/2026): a lógica pura (src/monitoresLogic.ts), o cliente da API
// (GET e DELETE /v1/admin/monitores) e a ligação na tela. Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  TEXTO_MONITORES_DESLIGADOS,
  assuntoDoMonitor,
  confirmacaoDeCancelamento,
  estadoDoMonitor,
  formatarQuando,
  ordenarMonitores,
  resumoDosMonitores,
  vistaDoMonitor,
} from '../src/monitoresLogic.ts';

const AGORA = new Date(2026, 10, 26, 14, 30, 0);
const em = (dia, h, m = 0, mes = 10, ano = 2026) => new Date(ano, mes, dia, h, m).toISOString();
const M = (over = {}) => ({ id: 1, consulta: 'patch novo do GTA', estado: 'ativo', proximaChecagem: em(26, 15, 0), ate: em(3, 9, 0, 11), avisos: 0, ...over });

test('estado: ativo, pausado e encerrado com o tom certo; desconhecido aparece como veio, sem tom', () => {
  assert.deepEqual(estadoDoMonitor('ativo'), { texto: 'Ativo', tom: 'ok' });
  assert.deepEqual(estadoDoMonitor('pausado'), { texto: 'Pausado', tom: 'atencao' });
  assert.deepEqual(estadoDoMonitor('encerrado'), { texto: 'Encerrado', tom: 'neutro' });
  assert.deepEqual(estadoDoMonitor('novo'), { texto: 'Novo', tom: 'neutro' });
  assert.deepEqual(estadoDoMonitor(''), { texto: '—', tom: 'neutro' });
  assert.deepEqual(estadoDoMonitor(undefined), { texto: '—', tom: 'neutro' });
});

test('assunto: no máximo 60 caracteres, espaços juntados; encerrado (null) diz que o assunto foi apagado', () => {
  assert.equal(assuntoDoMonitor({ consulta: '  patch   novo  ' }), 'patch novo');
  const longo = assuntoDoMonitor({ consulta: 'x'.repeat(200) });
  assert.equal(longo.length, 60);
  assert.ok(longo.endsWith('…'));
  assert.equal(assuntoDoMonitor({ consulta: 'y'.repeat(60) }), 'y'.repeat(60), 'exatamente 60 não corta');
  assert.equal(assuntoDoMonitor({ consulta: null }), 'Assunto apagado (monitor encerrado)');
  assert.equal(assuntoDoMonitor({ consulta: '   ' }), 'Assunto apagado (monitor encerrado)');
});

test('quando: hoje, amanhã, ontem, outro dia, outro ano; sem data ou data inválida vira "—" (nada inventado)', () => {
  assert.equal(formatarQuando(em(26, 15, 5), AGORA), 'hoje às 15:05');
  assert.equal(formatarQuando(em(27, 9, 0), AGORA), 'amanhã às 09:00');
  assert.equal(formatarQuando(em(25, 23, 59), AGORA), 'ontem às 23:59');
  assert.equal(formatarQuando(em(3, 10, 0, 11), AGORA), '03/12 às 10:00');
  assert.equal(formatarQuando(em(2, 8, 0, 0, 2027), AGORA), '02/01/2027 às 08:00');
  for (const nada of [null, undefined, '', 'lixo']) assert.equal(formatarQuando(nada, AGORA), '—', String(nada));
});

test('cartão: ativo mostra a próxima checagem, o prazo e os avisos enviados, e pode ser cancelado', () => {
  const v = vistaDoMonitor(M({ id: 7, avisos: 2 }), AGORA);
  assert.equal(v.id, 7);
  assert.equal(v.titulo, 'patch novo do GTA');
  assert.deepEqual(v.estado, { texto: 'Ativo', tom: 'ok' });
  assert.deepEqual(v.linhas, [
    { rotulo: 'Próxima checagem', valor: 'hoje às 15:00' },
    { rotulo: 'Até', valor: '03/12 às 09:00' },
    { rotulo: 'Avisos enviados', valor: '2' },
  ]);
  assert.equal(v.nota, null);
  assert.equal(v.podeCancelar, true);
});

test('cartão: pausado sem próxima checagem; encerrado sem botão, com o motivo; aviso em andamento aparece; avisos estranhos viram 0', () => {
  const pausado = vistaDoMonitor(M({ estado: 'pausado', proximaChecagem: null }), AGORA);
  assert.equal(pausado.linhas[0].valor, '—');
  assert.equal(pausado.podeCancelar, true);
  const fim = vistaDoMonitor(M({ estado: 'encerrado', consulta: null, proximaChecagem: null, fim: 'cancelado', avisos: 3 }), AGORA);
  assert.equal(fim.titulo, 'Assunto apagado (monitor encerrado)');
  assert.equal(fim.podeCancelar, false, 'encerrado não tem o que cancelar');
  assert.equal(fim.linhas[1].rotulo, 'Valia até');
  assert.equal(fim.linhas[2].valor, '3');
  assert.equal(fim.nota, 'Cancelado.');
  assert.equal(vistaDoMonitor(M({ estado: 'encerrado', consulta: null, fim: 'vencido' }), AGORA).nota, 'Chegou ao fim do prazo.');
  assert.match(vistaDoMonitor(M({ entrega: 'incerto' }), AGORA).nota, /pode não ter chegado/);
  assert.equal(vistaDoMonitor(M({ fim: 'motivo-novo' }), AGORA).nota, null, 'motivo desconhecido não inventa texto');
  for (const ruim of [-1, 'abc', null, undefined, Number.NaN]) assert.equal(vistaDoMonitor(M({ avisos: ruim }), AGORA).linhas[2].valor, '0', String(ruim));
});

test('ordem: ativos primeiro (pela próxima checagem), depois pausados, depois encerrados; a lista recebida não muda', () => {
  const lista = [
    M({ id: 4, estado: 'encerrado', consulta: null }),
    M({ id: 3, estado: 'ativo', proximaChecagem: em(27, 8) }),
    M({ id: 2, estado: 'pausado' }),
    M({ id: 1, estado: 'ativo', proximaChecagem: em(26, 16) }),
    M({ id: 5, estado: 'ativo', proximaChecagem: null }),
  ];
  const copia = JSON.stringify(lista);
  assert.deepEqual(ordenarMonitores(lista).map((m) => m.id), [1, 3, 5, 2, 4]);
  assert.equal(JSON.stringify(lista), copia);
  assert.deepEqual(ordenarMonitores([]), []);
});

test('resumo do título', () => {
  assert.equal(resumoDosMonitores([]), 'Nenhum monitor');
  assert.equal(resumoDosMonitores([M()]), '1 ativo');
  assert.equal(resumoDosMonitores([M(), M({ id: 2 }), M({ id: 3, estado: 'encerrado' })]), '2 ativos, 1 encerrado');
  assert.equal(resumoDosMonitores([M({ estado: 'pausado' }), M({ id: 2, estado: 'pausado' }), M({ id: 3, estado: 'x' })]), '2 pausados, 1 em outro estado');
});

test('cancelar pede confirmação explícita, com o número e o assunto, e diz que não dá para desfazer', () => {
  const c = confirmacaoDeCancelamento({ id: 9, consulta: 'promoção do Elden Ring' });
  assert.equal(c.titulo, 'Cancelar este monitor?');
  assert.match(c.mensagem, /^#9 · promoção do Elden Ring/);
  assert.match(c.mensagem, /Não dá para desfazer/);
  assert.equal(c.sim, 'Cancelar monitor');
});

test('desligados: o aviso diz onde ligar e que precisa do cérebro separado e de reinício', () => {
  assert.match(TEXTO_MONITORES_DESLIGADOS, /desligados/);
  assert.match(TEXTO_MONITORES_DESLIGADOS, /cérebro separado/);
  assert.match(TEXTO_MONITORES_DESLIGADOS, /Configuração e chaves/);
  assert.match(TEXTO_MONITORES_DESLIGADOS, /reinicie/);
});

test('cliente: GET /v1/admin/monitores e DELETE /v1/admin/monitores/:id (sem corpo); os erros do servidor chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ligado: true, monitores: [M({ id: 3 })], resumo: { ativos: 1 } } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ?? null, auth: init?.headers?.Authorization });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  const r = await c.admin.monitores();
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['GET', 'http://yui.local:3939/v1/admin/monitores']);
  assert.equal(calls.at(-1).auth, 'Bearer tok-1234567890123456');
  assert.equal(r.ligado, true);
  assert.equal(r.monitores[0].id, 3);
  resposta = { status: 200, body: { ok: true } };
  assert.deepEqual(await c.admin.cancelMonitor(3), { ok: true });
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['DELETE', 'http://yui.local:3939/v1/admin/monitores/3', null]);
  await c.admin.cancelMonitor(7.9);
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/monitores/7', 'só o número inteiro vai no caminho');
  resposta = { status: 404, body: { error: 'Monitor não encontrado (ou já encerrado).' } };
  await assert.rejects(() => c.admin.cancelMonitor(4), (e) => e instanceof ApiError && e.status === 404 && /já encerrado/.test(e.message));
  resposta = { status: 200, body: { ligado: false, monitores: [] } };
  assert.deepEqual(await c.admin.monitores(), { ligado: false, monitores: [] });
  resposta = { status: 403, body: { error: 'proibido' } };
  await assert.rejects(() => c.admin.monitores(), (e) => e instanceof ApiError && e.status === 403);
});

test('a tela: "Monitores" no grupo Operação do Admin, com confirmação antes de cancelar e os estados de carregando, erro, vazio e desligado', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const operacao = admin.slice(admin.indexOf("title: 'Operação'"), admin.indexOf("title: 'IA e memória'"));
  assert.match(operacao, /\{ key: 'monitores', label: 'Monitores' \}/);
  assert.match(admin, /section === 'monitores' \? <Monitores client=\{client\} \/>/);
  const tela = fs.readFileSync(path.join(raiz, 'AdminMonitores.tsx'), 'utf8');
  assert.match(tela, /const c = confirmacaoDeCancelamento\(m\);\s*confirmAction\(\s*c\.titulo,\s*c\.mensagem,/, 'cancelar só depois da confirmação');
  assert.ok(tela.indexOf('confirmAction(') < tela.indexOf('client.admin.cancelMonitor('), 'o pedido de cancelamento fica dentro da confirmação');
  for (const estado of ['kind="loading"', 'kind="error"', 'kind="empty"', 'TEXTO_MONITORES_DESLIGADOS', 'data && !data.ligado']) assert.ok(tela.includes(estado), estado);
  assert.ok(tela.includes('vistaDoMonitor(m)') && tela.includes('ordenarMonitores('), 'a tela usa a lógica pura');
});
