// Testes da seção "Live do YouTube" do Admin (lacunas do painel, entrega E, 27/11/2026; item 4 v2): a lógica pura (src/liveLogic.ts), o cliente da API
// (POST /v1/admin/live/entrar e /sair) e a ligação na tela. Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  DURACOES_SUGERIDAS,
  HORAS_MAX,
  HORAS_MIN,
  TEXTO_LINK_INVALIDO,
  confirmacaoDeSaida,
  resultadoDaAcao,
  rotuloDaDuracao,
  situacaoDaLive,
  validarEntrada,
} from '../src/liveLogic.ts';

const V = (over = {}) => ({
  ligado: true, disponivel: true, estado: 'ociosa', ativo: false, live: null, desde: null, mensagens: null,
  cota: { dia: '2026-11-28', usado: 0, limiteDiario: 10000, reserva: 1000, restante: 9000, nivel: 'ok' }, ultimoErro: null, ...over,
});

test('validar a entrada: o mesmo formato que o servidor aceita (link numa linha, do YouTube ou http(s); duração vazia ou de 1 a 99)', () => {
  assert.deepEqual(validarEntrada(' https://youtube.com/live/abcdefghijk ', ''), { ok: true, corpo: { endereco: 'https://youtube.com/live/abcdefghijk' } });
  assert.deepEqual(validarEntrada('youtu.be/abcdefghijk', '8'), { ok: true, corpo: { endereco: 'youtu.be/abcdefghijk', horas: 8 } });
  assert.deepEqual(validarEntrada('www.youtube.com/watch?v=abcdefghijk', ' 2 '), { ok: true, corpo: { endereco: 'www.youtube.com/watch?v=abcdefghijk', horas: 2 } });
  for (const e of ['', '   ', 'não é link', 'https://youtu.be/x y', 'qualquer-coisa', 'https://youtu.be/abc<script>', `https://youtu.be/${'x'.repeat(300)}`, 'ftp://youtube.com/live/x', 'linha\nquebrada']) {
    assert.deepEqual(validarEntrada(e, ''), { ok: false, erro: TEXTO_LINK_INVALIDO }, JSON.stringify(e));
  }
  for (const h of ['0', '100', '2.5', 'oito', '-1', '123']) {
    const r = validarEntrada('https://youtube.com/live/abcdefghijk', h);
    assert.equal(r.ok, false, h);
    assert.match(r.erro, /de 1 a 99/);
  }
  assert.deepEqual([HORAS_MIN, HORAS_MAX], [1, 99]);
  // o link de outro site passa daqui (o formato vale): quem recusa é o serviço, com a mesma frase da conversa
  assert.equal(validarEntrada('https://example.com/live/abcdefghijk', '').ok, true);
});

test('as durações sugeridas e o rótulo de cada uma', () => {
  assert.deepEqual([...DURACOES_SUGERIDAS], ['', '2', '4', '6', '8']);
  assert.deepEqual(DURACOES_SUGERIDAS.map(rotuloDaDuracao), ['Sem duração', '2 h', '4 h', '6 h', '8 h']);
  for (const h of DURACOES_SUGERIDAS) assert.equal(validarEntrada('https://youtu.be/abcdefghijk', h).ok, true, h);
});

test('situação: desligada e indisponível sem botões; fora de live = Entrar; procurando ou no chat = Sair; sem leitura = nada', () => {
  assert.deepEqual(situacaoDaLive(V({ ligado: false, disponivel: false, estado: 'desligado' })), {
    titulo: 'Desligada', texto: situacaoDaLive(V({ ligado: false })).texto, tom: 'neutro', podeEntrar: false, podeSair: false,
  });
  assert.match(situacaoDaLive(V({ ligado: false })).texto, /"Yui no chat de uma live do YouTube" em Configuração e chaves/);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V({ disponivel: false }))[k]), ['Indisponível', false, false]);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V())[k]), ['Fora de live', true, false]);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V({ estado: 'encerrada' }))[k]), ['Fora de live', true, false]);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V({ estado: 'interrompida', ultimoErro: { codigo: 'cota_esgotada', em: null } }))[k]), ['Fora de live', true, false]);
  assert.deepEqual(['titulo', 'tom', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V({ estado: 'ouvindo', ativo: true, live: { videoId: 'abcdefghijk', titulo: 'Live' } }))[k]), ['No chat', 'ok', false, true]);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(V({ estado: 'procurando', ativo: true }))[k]), ['Procurando o chat', false, true]);
  assert.deepEqual(['titulo', 'podeEntrar', 'podeSair'].map((k) => situacaoDaLive(null)[k]), ['Sem leitura', false, false]);
});

test('confirmação de sair (com o título da live quando há) e a frase do resultado', () => {
  const c = confirmacaoDeSaida(V({ live: { videoId: 'abcdefghijk', titulo: 'Live do Braga' } }));
  assert.deepEqual([c.titulo, c.sim], ['Sair da live', 'Sair']);
  assert.equal(c.mensagem, 'A Yui sai do chat de "Live do Braga" e para de ler e de responder. Para voltar, é preciso entrar de novo.');
  assert.match(confirmacaoDeSaida(V()).mensagem, /^A Yui sai do chat da live e para/);
  assert.match(confirmacaoDeSaida(null).mensagem, /^A Yui sai do chat da live/);
  assert.deepEqual(resultadoDaAcao({ ok: true, texto: 'Saí da live.' }), { texto: 'Saí da live.', tom: 'ok' });
  assert.deepEqual(resultadoDaAcao({ ok: false, texto: 'Já estou numa live. Mande "sai da live" antes.' }), { texto: 'Já estou numa live. Mande "sai da live" antes.', tom: 'atencao' });
  assert.equal(resultadoDaAcao({ ok: false, texto: '' }).texto, 'Não deu certo agora.');
  assert.equal(resultadoDaAcao(null), null);
});

test('cliente: POST /v1/admin/live/entrar (endereço e, só se houver, as horas) e /sair; os erros do servidor chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ok: true, texto: 'Entrei no chat da live "x".' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  assert.equal((await c.admin.entrarNaLive({ endereco: 'https://youtu.be/abcdefghijk', horas: 8 })).ok, true);
  assert.deepEqual(calls.at(-1), { url: 'http://yui.local:3939/v1/admin/live/entrar', method: 'POST', body: { endereco: 'https://youtu.be/abcdefghijk', horas: 8 } });
  await c.admin.entrarNaLive({ endereco: 'https://youtu.be/abcdefghijk' });
  assert.deepEqual(calls.at(-1).body, { endereco: 'https://youtu.be/abcdefghijk' }, 'sem duração, sem o campo');
  await c.admin.entrarNaLive({ endereco: 'https://youtu.be/abcdefghijk', horas: null });
  assert.deepEqual(calls.at(-1).body, { endereco: 'https://youtu.be/abcdefghijk' });
  resposta = { status: 200, body: { ok: true, texto: 'Saí da live.' } };
  assert.equal((await c.admin.sairDaLive()).texto, 'Saí da live.');
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['POST', 'http://yui.local:3939/v1/admin/live/sair', {}]);
  for (const status of [400, 403, 404, 429, 503]) {
    resposta = { status, body: { error: `erro ${status}` } };
    await assert.rejects(() => c.admin.entrarNaLive({ endereco: 'https://youtu.be/abcdefghijk' }), (e) => e instanceof ApiError && e.status === status, String(status));
  }
});

test('a tela: "Live do YouTube" no grupo Operação do Admin; Entrar com link e duração (validados antes), Sair com confirmação; a frase aparece e o estado recarrega', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const operacao = admin.slice(admin.indexOf("title: 'Operação'"), admin.indexOf("title: 'IA e memória'"));
  assert.match(operacao, /\{ key: 'live', label: 'Live do YouTube' \}/);
  assert.match(admin, /section === 'live' \? <LiveDoYoutube client=\{client\} \/>/);
  const tela = fs.readFileSync(path.join(raiz, 'AdminLive.tsx'), 'utf8');
  for (const t of ['kind="loading"', 'kind="error"', 'situacaoDaLive(live)', 'cartaoDaLive(live)', 's.podeSair ?', 's?.podeEntrar ?', 'DURACOES_SUGERIDAS.map', 'testID="live-endereco"', 'testID="live-entrar"', 'testID="live-sair"']) assert.ok(tela.includes(t), t);
  assert.match(tela, /const v = validarEntrada\(endereco, horas\);\s*if \(!v\.ok\)/, 'o formato é conferido antes de mandar');
  assert.match(tela, /client\.admin\.entrarNaLive\(v\.corpo\)/);
  assert.match(tela, /confirmacaoDeSaida\(live\)[\s\S]*confirmAction\(\s*c\.titulo,\s*c\.mensagem,[\s\S]*client\.admin\.sairDaLive\(\)/, 'sair só depois da confirmação');
  assert.ok(!/confirmAction[\s\S]{0,200}entrarNaLive/.test(tela), 'entrar não pede confirmação (o desenho pede só no sair)');
  assert.equal((tela.match(/await reload\(\);/g) ?? []).length, 2, 'o estado recarrega depois de entrar e de sair');
  assert.match(tela, /setResposta\(resultadoDaAcao\(/);
});
