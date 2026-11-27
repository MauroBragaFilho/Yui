// Testes da seção "Modo Rádio" do Admin (lacunas do painel, item 10, entrega E parte 2, 27/11/2026): a lógica pura (src/radioLogic.ts), o cliente da API
// (as ações novas no POST /v1/admin/radio/:guildId e os canais em GET /v1/admin/radio/:guildId/canais) e a ligação na tela. Sem React e sem rede.
// Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  TEXTO_BUSCA_INVALIDA, buscaValida, canaisParaEscolher, duracao, linhasDaFila, podeIniciar, podePular, rotuloDaFaixa, servidoresParaIniciar, textoDoResultado,
} from '../src/radioLogic.ts';

const CANAIS = {
  guildId: '1',
  voz: [
    { id: 'v1', nome: 'Música', pessoas: 2, pode: true, motivo: null },
    { id: 'v2', nome: 'Vazia', pessoas: 0, pode: true, motivo: null },
    { id: 'v3', nome: 'Sem falar', pessoas: 0, pode: false, motivo: 'sem-permissao' },
    { id: 'v4', nome: 'Cheio', pessoas: 5, pode: false, motivo: 'cheio' },
  ],
  texto: [
    { id: 't1', nome: 'geral', pode: true, motivo: null },
    { id: 't2', nome: 'sem-embed', pode: false, motivo: 'sem-permissao' },
  ],
};

test('duração e rótulo da faixa: "3:05", "1:02:03"; sem duração ou artista, só o que veio', () => {
  assert.deepEqual([duracao(185), duracao(3723), duracao(0), duracao(59.6), duracao(null), duracao(-1), duracao(Number.NaN)], ['3:05', '1:02:03', '0:00', '1:00', '', '', '']);
  assert.equal(rotuloDaFaixa({ title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 270 }), 'Evidências — Chitãozinho & Xororó (4:30)');
  assert.equal(rotuloDaFaixa({ title: 'Faixa', artist: '', duration: null }), 'Faixa');
  assert.equal(rotuloDaFaixa(null), '');
});

test('a fila: linhas numeradas com a duração e quantas ficam além das mostradas; servidor antigo sem "upcoming", nada', () => {
  const r = linhasDaFila({ upcoming: [{ title: 'Um', duration: 200 }, { title: '', duration: null }], queueLength: 14 });
  assert.deepEqual(r, { linhas: ['1. Um (3:20)', '2. Sem título'], resto: 12 });
  assert.deepEqual(linhasDaFila({ queueLength: 3 }), { linhas: [], resto: 3 });
  assert.equal(podePular({ current: null, queueLength: 0 }), false);
  assert.equal(podePular({ current: { title: 'x', artist: 'y', album: null }, queueLength: 0 }), true);
  assert.equal(podePular({ current: null, queueLength: 2 }), true);
});

test('busca: a mesma regra do servidor (2 a 200 caracteres, numa linha só)', () => {
  assert.equal(buscaValida('  lofi '), 'lofi');
  for (const ruim of ['', ' a ', 'x'.repeat(201), 'duas\nlinhas', null, undefined]) assert.equal(buscaValida(ruim), null, JSON.stringify(ruim));
  assert.match(TEXTO_BUSCA_INVALIDA, /2 a 200/);
});

test('o que o rádio respondeu vira uma frase: ligado, tocando, na fila, playlist, não achou, escolher e fim da fila', () => {
  const f = { title: 'Faixa', artist: 'Artista', duration: 125 };
  assert.match(textoDoResultado({ ok: true, iniciado: true }), /^Rádio ligado\. .*10 minutos/);
  assert.equal(textoDoResultado({ ok: true, resultado: 'tocando', faixa: f, adicionadas: 1 }), 'Tocando agora: Faixa — Artista (2:05).');
  assert.equal(textoDoResultado({ ok: true, resultado: 'na-fila', faixa: f, adicionadas: 1 }), 'Na fila: Faixa — Artista (2:05).');
  assert.equal(textoDoResultado({ ok: true, resultado: 'na-fila', adicionadas: 12 }), '12 faixa(s) entraram na fila.');
  assert.equal(textoDoResultado({ ok: true, resultado: 'tocando', adicionadas: 3 }), '3 faixa(s) na fila; já começou a tocar.');
  assert.equal(textoDoResultado({ ok: true, resultado: 'nao-encontrado' }), 'Não achei nada com essa busca. Tente outro nome ou um link.');
  assert.equal(textoDoResultado({ ok: true, resultado: 'escolher', opcoes: [f, f, f] }), 'Achei 3 opções: escolha uma (vale por 5 minutos).');
  assert.equal(textoDoResultado({ ok: true, resultado: 'fim-da-fila' }), 'Não há próxima faixa na fila.');
  assert.equal(textoDoResultado({ ok: true }), '');
  assert.equal(textoDoResultado(null), '');
});

test('iniciar: só os servidores sem rádio ligado; só os canais que a Yui pode usar (com as pessoas na call) e, à parte, os que não dá e por quê', () => {
  const guilds = [{ id: '2', name: 'Beta' }, { id: '1', name: 'Alfa' }, { id: '3', name: 'Gama' }];
  assert.deepEqual(servidoresParaIniciar(guilds, [{ guildId: '3' }]).map((g) => g.name), ['Alfa', 'Beta']);
  assert.deepEqual(servidoresParaIniciar(null, null), []);
  const e = canaisParaEscolher(CANAIS);
  assert.deepEqual(e.voz, [{ id: 'v1', rotulo: 'Música · 2 na call' }, { id: 'v2', rotulo: 'Vazia · vazia' }]);
  assert.deepEqual(e.texto, [{ id: 't1', rotulo: '#geral' }]);
  assert.equal(e.indisponiveis, 'Não dá para usar: Sem falar (sem permissão), Cheio (cheio), #sem-embed (sem permissão).');
  assert.deepEqual(canaisParaEscolher(null), { voz: [], texto: [], indisponiveis: null });
  assert.equal(podeIniciar(CANAIS, 'v2', 't1'), true, 'canal vazio pode: ninguém precisa estar na call');
  for (const [v, t] of [['v3', 't1'], ['v4', 't1'], ['v1', 't2'], ['v1', null], [null, 't1'], ['x', 't1']]) assert.equal(podeIniciar(CANAIS, v, t), false, `${v}/${t}`);
  assert.equal(podeIniciar(null, 'v1', 't1'), false);
});

test('cliente: as ações novas no mesmo POST de sempre (start sem busca, play, choose só com o número, skip) e os canais por GET', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ok: true } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  const base = 'http://yui.local:3939/v1/admin/radio/123';
  resposta = { status: 200, body: CANAIS };
  assert.deepEqual((await c.admin.radioCanais('123')).voz.length, 4);
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['GET', `${base}/canais`, null]);
  resposta = { status: 200, body: { ok: true, iniciado: true } };
  await c.admin.radioIniciar('123', { voiceChannelId: 'v1', textChannelId: 't1' });
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['POST', base, { action: 'start', voiceChannelId: 'v1', textChannelId: 't1' }]);
  resposta = { status: 200, body: { ok: true, resultado: 'escolher', opcoes: [{ title: 'A', artist: 'B', duration: 1 }] } };
  assert.equal((await c.admin.radioTocar('123', 'lofi')).resultado, 'escolher');
  assert.deepEqual(calls.at(-1).body, { action: 'play', query: 'lofi' });
  await c.admin.radioEscolher('123', 2.9);
  assert.deepEqual(calls.at(-1).body, { action: 'choose', opcao: 2 }, 'só o número (inteiro); nunca uma faixa');
  resposta = { status: 200, body: { ok: true, resultado: 'fim-da-fila' } };
  assert.equal((await c.admin.radioAction('123', 'skip')).resultado, 'fim-da-fila');
  assert.deepEqual(calls.at(-1).body, { action: 'skip' });
  resposta = { status: 409, body: { error: 'A Yui não tem permissão para entrar e falar nesse canal de voz.' } };
  await assert.rejects(() => c.admin.radioIniciar('123', { voiceChannelId: 'v3', textChannelId: 't1' }), (e) => e instanceof ApiError && e.status === 409 && /permissão/.test(e.message));
});

test('a tela: iniciar (servidor, canal de voz, canal de texto e busca), pular, ver a fila, tocar e escolher entre as opções; pausar, parar e tirar da call continuam', () => {
  const tela = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'screens', 'AdminOps.tsx'), 'utf8');
  for (const p of [
    'client.admin.radioCanais(', 'client.admin.radioIniciar(', 'client.admin.radioTocar(', 'client.admin.radioEscolher(', "act('skip')",
    'servidoresParaIniciar(', 'canaisParaEscolher(', 'podeIniciar(', 'linhasDaFila(', 'textoDoResultado(', 'buscaValida(', '<OpcoesDaBusca',
    'testID="radio-iniciar"', 'radio-voz-', 'radio-texto-', 'radio-skip-', 'radio-fila-', 'radio-tocar-',
    "act('pause')", "act('resume')", "act('stop')", "act('leave')",
  ]) assert.ok(tela.includes(p), p);
  assert.doesNotMatch(tela, /Escolher música e pular faixa continuam no menu/, 'o aviso antigo saiu');
});
