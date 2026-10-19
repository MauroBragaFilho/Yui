// Testes de src/utils/promptBudget.js (orçamento de prompt, erro de tamanho seguro) e src/utils/sseLines.js
// (leitor de linhas SSE tolerante a pedaços e UTF-8 partido). Sem Discord e sem rede externa: o único
// servidor é um loopback efêmero (127.0.0.1, porta 0) fechado ao fim, para ter um IncomingMessage de verdade.
// Execução: npm run test:inputlimits   (ou: node tests/test-input-limits.js)
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import axios from 'axios';
import {
  buildChatLog, clipHeadTail, isTooLargeError, errorBodyText, sizeErrorText, estimateTokens, SIZE_ERROR_MARKER,
} from '../src/utils/promptBudget.js';
import { createLineSplitter, sseDataOf } from '../src/utils/sseLines.js';

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✘ FALHA ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`); }
};
const wellFormed = (s) => s.isWellFormed();

// ---------------------------------------------------------------- clipHeadTail
console.log('clipHeadTail');
await test('texto que cabe volta idêntico', () => assert.equal(clipHeadTail('abc', 10), 'abc'));
await test('nunca passa de max e mantém início e fim', () => {
  const s = `INICIO-${'m'.repeat(5000)}-FIM`;
  for (const max of [20, 50, 100, 600, 1000]) {
    const r = clipHeadTail(s, max);
    assert.ok(r.length <= max, `${r.length} > ${max}`);
    assert.ok(r.startsWith('INICIO'), 'perdeu o início');
    assert.ok(r.endsWith('FIM'), 'perdeu o fim');
    assert.ok(r.includes(' [...] '));
  }
});
await test('divide 70% início / 30% fim', () => {
  const r = clipHeadTail('a'.repeat(1000) + 'b'.repeat(1000), 507);
  const [head, tail] = r.split(' [...] ');
  assert.equal(head.length + tail.length, 500);
  assert.ok(head.length > tail.length && /^a+$/.test(head) && /^b+$/.test(tail));
});
await test('max pequeno só fatia; zero, negativo e inválido viram vazio', () => {
  assert.equal(clipHeadTail('abcdefghijklmnopqrstuvwxyz', 5), 'abcde');
  for (const m of [0, -1, NaN, undefined]) assert.equal(clipHeadTail('abc', m), '');
  assert.equal(clipHeadTail(null, 10), '');
});
await test('não parte emoji na junção do início nem do fim', () => {
  for (let n = 60; n < 90; n++) {
    const r = clipHeadTail(`${'a'.repeat(n)}${'😀'.repeat(60)}${'b'.repeat(n)}${'😀'.repeat(60)}`, 100);
    assert.ok(r.length <= 100 && wellFormed(r), `n=${n}`);
  }
});

// ---------------------------------------------------------------- buildChatLog
console.log('buildChatLog');
const mk = (n, len = 30) => Array.from({ length: n }, (_, i) => ({ time: `10:${String(i % 60).padStart(2, '0')}`, user: `user${i}`, content: `msg${i} ${'x'.repeat(len)}` }));
await test('conversa curta entra inteira, na ordem, sem quebra final', () => {
  const r = buildChatLog(mk(3));
  assert.equal(r.used, 3);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.clipped, 0);
  const lines = r.log.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('[10:00] user0: msg0') && lines[2].startsWith('[10:02] user2: msg2'));
  assert.ok(!r.log.endsWith('\n'));
});
await test('100 mensagens de 4000 caracteres: nunca passa de 20000 e mantém as mais NOVAS', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ time: 't', user: `u${i}`, content: `m${i} ${'y'.repeat(4000)}` }));
  const r = buildChatLog(msgs);
  assert.ok(r.log.length <= 20000, `log=${r.log.length}`);
  assert.equal(r.total, 100);
  assert.equal(r.truncated, true);
  assert.ok(r.used >= 25 && r.used < 100, `used=${r.used}`);
  assert.equal(r.clipped, r.used);
  assert.ok(r.log.includes(': m99 '), 'faltou a mais nova');
  assert.ok(!r.log.includes(': m0 '), 'a mais antiga não deveria caber');
  const first = Number(/\[t\] u(\d+):/.exec(r.log)[1]);
  assert.equal(first, 100 - r.used, 'a janela precisa ser contínua até a última');
});
await test('47 de 100 mensagens de ~400 caracteres (cenário medido nos relatórios)', () => {
  const r = buildChatLog(mk(100, 400));
  assert.ok(r.log.length <= 20000);
  assert.ok(r.used > 30 && r.used < 100, `used=${r.used}`);
  assert.equal(r.truncated, true);
  assert.ok(r.log.includes('msg99 '));
});
await test('cada mensagem longa é encurtada com início e fim (perMsg)', () => {
  const r = buildChatLog([{ time: 't', user: 'u', content: `COMECO ${'z'.repeat(3000)} FINAL` }], { perMsg: 300 });
  assert.equal(r.clipped, 1);
  assert.ok(r.log.length <= '[t] u: '.length + 300);
  assert.ok(r.log.includes('COMECO') && r.log.endsWith('FINAL') && r.log.includes('[...]'));
});
await test('mensagens vazias são ignoradas e não contam no total', () => {
  const r = buildChatLog([{ time: 't', user: 'a', content: '' }, { time: 't', user: 'b', content: '   ' }, { time: 't', user: 'c', content: 'oi' }, null, { time: 't', user: 'd' }]);
  assert.equal(r.total, 1);
  assert.equal(r.used, 1);
  assert.equal(r.log, '[t] c: oi');
});
await test('uma mensagem sozinha acima do teto entra encurtada em vez de sumir', () => {
  const r = buildChatLog([{ time: 't', user: 'u', content: 'q'.repeat(5000) }], { maxChars: 1000, perMsg: 4000 });
  assert.equal(r.used, 1);
  assert.ok(r.log.length <= 1000 && r.log.length > 500);
  assert.equal(r.clipped, 1);
});
await test('entrada inválida devolve log vazio', () => {
  for (const bad of [undefined, null, 'texto', 5, {}]) {
    const r = buildChatLog(bad);
    assert.deepEqual([r.log, r.used, r.total, r.truncated], ['', 0, 0, false]);
  }
});
await test('respeita YUI_SUMMARY_MAX_CHARS e YUI_SUMMARY_PER_MESSAGE (ambiente injetado) e aceita opções explícitas', () => {
  const msgs = mk(100, 400);
  const small = buildChatLog(msgs, { env: { YUI_SUMMARY_MAX_CHARS: '3000', YUI_SUMMARY_PER_MESSAGE: '100' } });
  assert.ok(small.log.length <= 3000 && small.clipped > 0);
  const explicit = buildChatLog(msgs, { maxChars: 2500, perMsg: 200, env: { YUI_SUMMARY_MAX_CHARS: '9000' } });
  assert.ok(explicit.log.length <= 2500);
  const bad = buildChatLog(msgs, { env: { YUI_SUMMARY_MAX_CHARS: 'abc' } });
  assert.ok(bad.log.length <= 20000 && bad.log.length > 15000);
});
await test('é rápido (100 mensagens de 4000 caracteres em poucos ms)', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ time: 't', user: `u${i}`, content: 'w'.repeat(4000) }));
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) buildChatLog(msgs);
  assert.ok((performance.now() - t0) / 50 < 20, 'lento');
});

// ---------------------------------------------------------------- isTooLargeError
console.log('isTooLargeError (seguro, C2)');
const stat = (status, data, message = `Request failed with status code ${status}`) => ({ message, response: { status, data } });
await test('413 é tamanho, sempre', () => {
  assert.equal(isTooLargeError(stat(413, 'x')), true);
  assert.equal(isTooLargeError(stat(413, undefined)), true);
});
await test('400/422 com mensagem de contexto/tamanho no corpo (string, objeto, Buffer)', () => {
  assert.equal(isTooLargeError(stat(400, 'This model maximum context length is 8192 tokens')), true);
  assert.equal(isTooLargeError(stat(400, { error: { message: 'Context size has been exceeded.' } })), true);
  assert.equal(isTooLargeError(stat(422, Buffer.from('input is too long for this model'))), true);
  assert.equal(isTooLargeError(stat(400, { error: { message: 'The input token count (150000) exceeds the maximum number of tokens allowed' } })), true);
  assert.equal(isTooLargeError(stat(400, new Uint8Array(Buffer.from('prompt is too large')))), true);
  assert.equal(isTooLargeError(stat(400, new TextEncoder().encode('too many tokens').buffer)), true);
});
await test('400 sem sinal de tamanho só conta com prompt estimado grande', () => {
  assert.equal(isTooLargeError(stat(400, { error: { message: 'chave inválida' } })), false);
  assert.equal(isTooLargeError(stat(400, { error: { message: 'chave inválida' } }), 11999), false);
  assert.equal(isTooLargeError(stat(400, { error: { message: 'chave inválida' } }), 12001), true);
  assert.equal(isTooLargeError(stat(422, ''), 20000), true);
});
await test('429, 5xx, rede e cota NUNCA são tamanho (mantém o alerta ao dono)', () => {
  for (const s of [429, 500, 502, 503, 401, 403, 404]) {
    assert.equal(isTooLargeError(stat(s, 'context too long')), false, String(s));
    assert.equal(isTooLargeError(stat(s, 'x'), 50000), false, `${s} com prompt grande`);
  }
  assert.equal(isTooLargeError(new Error('ECONNRESET')), false);
  assert.equal(isTooLargeError({ message: 'timeout of 15000ms exceeded', code: 'ECONNABORTED' }, 99999), false);
});
await test('lê status de err.status, statusCode e da mensagem quando não há response', () => {
  assert.equal(isTooLargeError({ status: 413, message: 'x' }), true);
  assert.equal(isTooLargeError({ statusCode: 413 }), true);
  assert.equal(isTooLargeError(new Error('Request failed with status code 413')), true);
  assert.equal(isTooLargeError('Request failed with status code 413'), true);
  assert.equal(isTooLargeError(new Error('Request failed with status code 400: context length exceeded')), true);
});
await test('NUNCA lança com lixo: null, números, objetos circulares, getters que lançam', () => {
  const circular = { message: 'x', response: { status: 400, data: {} } };
  circular.response.data.self = circular.response.data;
  const getter = { get message() { throw new Error('boom'); }, get response() { throw new Error('boom2'); } };
  for (const bad of [null, undefined, 0, 42, true, [], {}, 'texto', circular, getter, { response: null }, { response: { status: 'abc' } }]) {
    assert.doesNotThrow(() => isTooLargeError(bad, 1000), String(bad));
    assert.doesNotThrow(() => isTooLargeError(bad, NaN));
  }
  assert.equal(isTooLargeError(circular), false);
  assert.equal(isTooLargeError(getter), false);
});
await test('corpo que é STREAM é ignorado sem lançar: PassThrough, Readable, web ReadableStream', () => {
  const pt = new PassThrough();
  pt.write('Context size has been exceeded.');
  const rd = Readable.from(['Context size has been exceeded.']);
  const web = new ReadableStream();
  for (const body of [pt, rd, web]) {
    assert.doesNotThrow(() => isTooLargeError(stat(400, body)));
    assert.equal(isTooLargeError(stat(400, body)), false, 'stream não é lido: sem tamanho sem prompt grande');
    assert.equal(isTooLargeError(stat(400, body), 13000), true);
    assert.equal(errorBodyText(stat(400, body)), '');
  }
  pt.destroy(); rd.destroy();
});
await test('errorBodyText limita o tamanho e entende string, Buffer e objeto', () => {
  assert.equal(errorBodyText(stat(400, 'a'.repeat(5000))).length, 2000);
  assert.equal(errorBodyText(stat(400, Buffer.from('b'.repeat(5000)))).length, 2000);
  assert.equal(errorBodyText(stat(400, { error: 'ctx' })), 'ctx');
  assert.equal(errorBodyText(stat(400, { error: { message: 'm' } })), '{"message":"m"}');
  assert.equal(errorBodyText(stat(400, { outro: 1 })), '{"outro":1}');
  assert.equal(errorBodyText(undefined), '');
  assert.equal(errorBodyText({}), '');
});

// IncomingMessage de verdade e erro real do axios com responseType 'stream' (como tryLocal faz com o LM Studio).
const srv = http.createServer((req, res) => {
  res.statusCode = 400;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { message: 'Context size has been exceeded.' } }));
});
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
const port = srv.address().port;
try {
  await test('a premissa: JSON.stringify de um IncomingMessage LANÇA (era o furo do plano original)', async () => {
    const incoming = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port }, resolve).on('error', reject); });
    try { assert.throws(() => JSON.stringify(incoming), /circular/i); } finally { incoming.destroy(); }
  });
  await test('IncomingMessage real como corpo: não lança, é ignorado', async () => {
    const incoming = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port }, resolve).on('error', reject); });
    try {
      const err = { message: 'Request failed with status code 400', response: { status: 400, data: incoming } };
      assert.doesNotThrow(() => isTooLargeError(err, 0));
      assert.equal(isTooLargeError(err, 0), false);
      assert.equal(isTooLargeError(err, 13000), true);
      assert.equal(errorBodyText(err), '');
    } finally { incoming.destroy(); }
  });
  await test('erro real do axios (responseType stream, 400): não lança; só a mensagem e o tamanho estimado decidem', async () => {
    let caught = null;
    try { await axios.post(`http://127.0.0.1:${port}/v1/chat/completions`, { a: 1 }, { responseType: 'stream', timeout: 5000 }); } catch (e) { caught = e; }
    assert.ok(caught, 'o servidor falso devolve 400');
    try {
      assert.equal(caught.response.status, 400);
      assert.equal(typeof caught.response.data.pipe, 'function', 'o corpo é um stream');
      assert.doesNotThrow(() => isTooLargeError(caught, 5000));
      assert.equal(isTooLargeError(caught, 5000), false);
      assert.equal(isTooLargeError(caught, 12500), true);
    } finally { caught.response?.data?.destroy?.(); }
  });
} finally {
  srv.closeAllConnections?.();
  await new Promise((resolve) => srv.close(resolve));
}

console.log('sizeErrorText, estimateTokens');
await test('sizeErrorText traz a frase que o projeto já trata como erro (minúsculas)', () => {
  const t = sizeErrorText(30000);
  assert.ok(t.includes('erro ao processar seu pedido'));
  assert.ok(t.includes(SIZE_ERROR_MARKER));
  assert.ok(t.includes('cerca de 30 mil tokens'));
  assert.ok(/erro ao processar seu pedido/i.test(t), 'mesma checagem do isErrorReply');
});
await test('sizeErrorText sem estimativa útil omite o parêntese', () => {
  for (const v of [0, 400, NaN, undefined, -5]) assert.ok(!sizeErrorText(v).includes('mil tokens'), String(v));
  assert.ok(sizeErrorText(NaN).endsWith('Encurte o texto ou mande em partes.'));
});
await test('estimateTokens: 3,5 caracteres por token', () => {
  assert.equal(estimateTokens(35000), 10000);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-4), 0);
  assert.equal(estimateTokens('x'), 0);
});

// ---------------------------------------------------------------- sseLines
console.log('createLineSplitter');
const feed = (chunks) => {
  const sp = createLineSplitter();
  const lines = [];
  for (const c of chunks) lines.push(...sp.push(c));
  lines.push(...sp.flush());
  return lines;
};
await test('linhas completas, \\n, \\r\\n e \\r', () => {
  assert.deepEqual(feed([Buffer.from('a\nb\r\nc\rd\n')]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(feed([Buffer.from('a\n\nb\n')]), ['a', '', 'b']);
});
await test('linha partida entre pedaços é remontada', () => {
  assert.deepEqual(feed([Buffer.from('data: {"a'), Buffer.from('b":1}\nda'), Buffer.from('ta: 2\n')]), ['data: {"ab":1}', 'data: 2']);
});
await test('\\r\\n partido entre dois pedaços não gera linha vazia extra', () => {
  assert.deepEqual(feed([Buffer.from('a\r'), Buffer.from('\nb\r'), Buffer.from('\nc\n')]), ['a', 'b', 'c']);
  assert.deepEqual(feed([Buffer.from('a\r'), Buffer.from('b\n')]), ['a', 'b']);
});
await test('aceita string além de Buffer', () => assert.deepEqual(feed(['a\nb', '\nc']), ['a', 'b', 'c']));
await test('flush devolve a última linha sem quebra e zera o estado', () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push(Buffer.from('data: {"fim":true}')), []);
  assert.deepEqual(sp.flush(), ['data: {"fim":true}']);
  assert.deepEqual(sp.flush(), []);
  assert.deepEqual(sp.push(Buffer.from('novo\n')), ['novo']);
});
await test('UTF-8 partido entre pedaços: ç, ã, emoji de 4 bytes', () => {
  const text = 'ação coração 😀 ok\n';
  const bytes = Buffer.from(text);
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.deepEqual(feed([bytes.subarray(0, cut), bytes.subarray(cut)]), ['ação coração 😀 ok'], `corte em ${cut}`);
  }
  assert.deepEqual(feed([...bytes].map((b) => Buffer.from([b]))), ['ação coração 😀 ok'], 'um byte por vez');
});
await test('byte solto no fim do fluxo não lança', () => {
  const sp = createLineSplitter();
  sp.push(Buffer.from([0x61, 0xC3]));
  assert.doesNotThrow(() => sp.flush());
});
await test('linha gigante sem quebra é descartada acima de maxLineChars (e a seguinte passa)', () => {
  const sp = createLineSplitter({ maxLineChars: 100 });
  assert.deepEqual(sp.push(Buffer.from('x'.repeat(150))), []);
  assert.deepEqual(sp.push(Buffer.from('y'.repeat(50) + '\nbom\n')), ['bom']);
  assert.deepEqual(sp.flush(), []);
});
await test('linha longa em muitos pedaços pequenos é linear (300 KB em pedaços de 1 KB)', () => {
  const sp = createLineSplitter();
  const piece = Buffer.from('q'.repeat(1024));
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) sp.push(piece);
  const lines = sp.push(Buffer.from('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 300 * 1024);
  assert.ok(performance.now() - t0 < 1000, 'lento');
});

console.log('createLineSplitter + sseDataOf: fluxo SSE do LM Studio (TG-11)');
const WORDS = ['ação', 'coração', 'não', 'você', 'é', 'três', '😀', 'pão', 'maçã', 'olá', 'à', 'ü'];
const expectedText = WORDS.map((w) => `${w} `).join('').repeat(3);
const events = [];
for (let r = 0; r < 3; r++) for (const w of WORDS) events.push(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: `${w} ` }, finish_reason: null }] })}\n\n`);
events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`, 'data: [DONE]\n\n');
const sseBytes = Buffer.from(events.join(''));
const sseCrlf = Buffer.from(events.join('').replaceAll('\n', '\r\n'));

// Mesmo tratamento de linha do tryLocal: JSON em "data:", conteúdo concatenado, finish_reason guardado.
function consume(chunks) {
  const sp = createLineSplitter();
  let text = '';
  let finish = null;
  let done = false;
  const handle = (line) => {
    const data = sseDataOf(line);
    if (data === null || data === '') return;
    if (data === '[DONE]') { done = true; return; }
    try {
      const d = JSON.parse(data);
      text += d.choices?.[0]?.delta?.content ?? '';
      finish = d.choices?.[0]?.finish_reason ?? finish;
    } catch { /* linha ruim: ignora, como o código real */ }
  };
  for (const c of chunks) for (const l of sp.push(c)) handle(l);
  for (const l of sp.flush()) handle(l);
  return { text, finish, done };
}
const split2 = (buf, cut) => [buf.subarray(0, cut), buf.subarray(cut)];

await test('sem cortes: texto, finish_reason e [DONE]', () => {
  const r = consume([sseBytes]);
  assert.equal(r.text, expectedText);
  assert.equal(r.finish, 'length');
  assert.equal(r.done, true);
});
await test('cortado em CADA posição de byte (2 pedaços): texto e finish_reason idênticos', () => {
  for (let cut = 1; cut < sseBytes.length; cut++) {
    const r = consume(split2(sseBytes, cut));
    if (r.text !== expectedText || r.finish !== 'length' || !r.done) assert.fail(`corte em ${cut}: texto ${r.text === expectedText ? 'ok' : 'DIFERENTE'}, finish=${r.finish}, done=${r.done}`);
  }
});
await test('cortado em cada posição com CRLF no lugar de LF', () => {
  for (let cut = 1; cut < sseCrlf.length; cut += 3) {
    const r = consume(split2(sseCrlf, cut));
    if (r.text !== expectedText || r.finish !== 'length') assert.fail(`corte em ${cut}`);
  }
});
await test('um byte por vez, pedaços de 3, 7, 64, 300 e 1400 bytes', () => {
  for (const size of [1, 3, 7, 64, 300, 1400]) {
    const chunks = [];
    for (let i = 0; i < sseBytes.length; i += size) chunks.push(sseBytes.subarray(i, i + size));
    const r = consume(chunks);
    if (r.text !== expectedText || r.finish !== 'length' || !r.done) assert.fail(`pedaços de ${size}`);
  }
});
await test('três pedaços em posições aleatórias (fuzz determinístico)', () => {
  let seed = 4242;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 800; i++) {
    const a = 1 + Math.floor(rnd() * (sseBytes.length - 2));
    const b = a + 1 + Math.floor(rnd() * (sseBytes.length - a - 1));
    const r = consume([sseBytes.subarray(0, a), sseBytes.subarray(a, b), sseBytes.subarray(b)]);
    if (r.text !== expectedText || r.finish !== 'length') assert.fail(`cortes em ${a} e ${b}`);
  }
});
await test('o último evento sem quebra de linha final ainda chega (flush)', () => {
  const semDone = sseBytes.subarray(0, sseBytes.length - Buffer.byteLength('data: [DONE]\n\n'));
  const semQuebraFinal = semDone.subarray(0, semDone.length - 2); // tira o \n\n do evento com finish_reason
  const r = consume([semQuebraFinal]);
  assert.equal(r.finish, 'length');
  assert.equal(r.text, expectedText);
});

console.log('sseDataOf');
await test('extrai o dado, ignora comentário, evento, vazio e lixo', () => {
  assert.equal(sseDataOf('data: {"a":1}'), '{"a":1}');
  assert.equal(sseDataOf('data:{"a":1}'), '{"a":1}');
  assert.equal(sseDataOf('data: [DONE]'), '[DONE]');
  assert.equal(sseDataOf('  data: x  '), 'x');
  assert.equal(sseDataOf('data:'), '');
  assert.equal(sseDataOf('data:  dois espaços'), ' dois espaços');
  for (const bad of ['', ': keep-alive', 'event: ping', 'id: 3', 'xdata: no', null, undefined]) assert.equal(sseDataOf(bad), null, String(bad));
});

console.log(`\n${passed} ok, ${failures.length} falha(s)`);
if (failures.length) { console.log(`FALHAS: ${failures.join(' | ')}`); process.exit(1); }
