// Testes dos avisos automáticos ao dono (DM no Discord).
// Execução: npm run test:alerts
import assert from 'assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.YUI_AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-alerts-')), 'audit.jsonl');
const { createAlerter } = await import('../src/core/alerts.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

function make(extra = {}) {
  const sent = [];
  let clock = 1_000_000;
  const alerter = createAlerter({
    notify: async (id, text) => { sent.push({ id, text }); },
    ownerId: '111111111111111111',
    env: {},
    now: () => clock,
    ...extra,
  });
  return { alerter, sent, advance: (min) => { clock += min * 60_000; } };
}

console.log('Envio');
await test('manda DM para o dono, com título, detalhe e como desligar', async () => {
  const { alerter, sent } = make();
  assert.equal(await alerter.alert('ia', 'Todos os provedores de IA falharam', 'sem créditos', { level: 'error' }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, '111111111111111111');
  assert.match(sent[0].text, /Yui: Todos os provedores de IA falharam/);
  assert.match(sent[0].text, /sem créditos/);
  assert.match(sent[0].text, /YUI_ALERTS=false/);
});

await test('mascara chaves e senhas no texto', async () => {
  const SECRET = 'segredo-que-nao-pode-vazar-0123456789';
  const { alerter, sent } = make({ env: { MINHA_API_KEY: SECRET } });
  await alerter.alert('x', 'Falha', `erro com ${SECRET} e AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY12`);
  assert.ok(!sent[0].text.includes(SECRET));
  assert.ok(!sent[0].text.includes('AIzaSy'));
  assert.ok(sent[0].text.includes('••••'));
});

console.log('Proteção contra enxurrada');
await test('o mesmo aviso só repete depois do intervalo (30 min por padrão)', async () => {
  const { alerter, sent, advance } = make();
  assert.equal(await alerter.alert('ia', 'a'), true);
  assert.equal(await alerter.alert('ia', 'a'), false);
  advance(29);
  assert.equal(await alerter.alert('ia', 'a'), false);
  advance(2);
  assert.equal(await alerter.alert('ia', 'a'), true);
  assert.equal(sent.length, 2);
});
await test('avisos de tipos diferentes não se bloqueiam; intervalo próprio por aviso', async () => {
  const { alerter, sent, advance } = make();
  assert.equal(await alerter.alert('a', 'A'), true);
  assert.equal(await alerter.alert('b', 'B'), true);
  assert.equal(await alerter.alert('c', 'C', '', { cooldownMinutes: 5 }), true);
  advance(6);
  assert.equal(await alerter.alert('c', 'C', '', { cooldownMinutes: 5 }), true);
  assert.equal(sent.length, 4);
});
await test('teto global de 10 avisos por hora', async () => {
  const { alerter, sent, advance } = make();
  for (let i = 0; i < 15; i++) await alerter.alert(`k${i}`, `T${i}`);
  assert.equal(sent.length, 10);
  advance(61);
  assert.equal(await alerter.alert('novo', 'Novo'), true);
});

console.log('Desligado e falhas');
await test('YUI_ALERTS=false desliga tudo', async () => {
  const { alerter, sent } = make({ env: { YUI_ALERTS: 'false' } });
  assert.equal(await alerter.alert('x', 'X'), false);
  assert.equal(sent.length, 0);
});
await test('sem Discord (notify ausente) ou sem dono: nada acontece e nada quebra', async () => {
  assert.equal(await createAlerter({ notify: null, ownerId: '1', env: {} }).alert('x', 'X'), false);
  assert.equal(await createAlerter({ notify: async () => {}, ownerId: null, env: {} }).alert('x', 'X'), false);
});
await test('falha ao enviar (DM bloqueada) não lança erro', async () => {
  const alerter = createAlerter({ notify: async () => { throw new Error('Cannot send messages to this user'); }, ownerId: '1', env: {} });
  assert.equal(await alerter.alert('x', 'X'), false);
});
await test('YUI_ALERTS_COOLDOWN_MINUTES muda o intervalo padrão', async () => {
  const { alerter, advance } = make({ env: { YUI_ALERTS_COOLDOWN_MINUTES: '5' } });
  assert.equal(await alerter.alert('x', 'X'), true);
  advance(6);
  assert.equal(await alerter.alert('x', 'X'), true);
});

console.log('Erros graves: chave pela causa-raiz');
const { crashAlertKey, crashCause, firstProjectFrame, formatCrashDetail, describeReason } = await import('../src/core/alerts.js');

// Mensagem real do prism-media quando falta o Opus: junta os erros de cada módulo, começando por "Error: ".
const OPUS_MESSAGE = "Error: Cannot find module '@discordjs/opus'\nRequire stack:\n- D:\\Projetos\\Yui\\node_modules\\prism-media\\src\\util\\loader.js\nError: Cannot find module 'node-opus'";
const ROOT = 'D:/Projetos/Yui';
const STACK = [
  'Error: ' + OPUS_MESSAGE.split('\n')[0],
  '    at loader (D:\\Projetos\\Yui\\node_modules\\prism-media\\src\\util\\loader.js:12:9)',
  '    at loadOpus (D:\\Projetos\\Yui\\node_modules\\prism-media\\src\\opus\\Opus.js:14:10)',
  '    at new OpusStream (D:\\Projetos\\Yui\\node_modules\\prism-media\\src\\opus\\Opus.js:45:12)',
  '    at new Decoder (D:\\Projetos\\Yui\\node_modules\\prism-media\\src\\opus\\Opus.js:136:5)',
  '    at EventEmitter.<anonymous> (file:///D:/Projetos/Yui/src/handlers/voiceHandler.js:229:25)',
  '    at EventEmitter.emit (node:events:508:28)',
].join('\n');

function opusError() {
  const err = new Error(OPUS_MESSAGE);
  err.stack = STACK;
  return err;
}

await test('exceção e rejeição da MESMA causa têm a mesma chave (uma única DM)', async () => {
  const asException = opusError();
  const asRejection = new Error(OPUS_MESSAGE.replace(/^Error: /, '')); // a rejeição costuma vir sem o prefixo
  assert.equal(crashAlertKey(asException), crashAlertKey(asRejection));
  assert.equal(crashAlertKey(asException), "crash:Cannot find module '@discordjs/opus'");
});
await test('a chave não tem prefixo exception/rejection nem "Error: " e é limitada a 80 caracteres', async () => {
  const key = crashAlertKey(new Error('Error: Error: ' + 'x'.repeat(200)));
  assert.ok(key.startsWith('crash:x'));
  assert.ok(!key.includes('exception') && !key.includes('rejection'));
  assert.equal(key.length, 'crash:'.length + 80);
});
await test('causas diferentes geram chaves diferentes; origem diferente NÃO muda a chave', async () => {
  assert.notEqual(crashAlertKey(new Error('ECONNRESET')), crashAlertKey(new Error('EADDRINUSE')));
  const a = new Error('mesma causa'); a.stack = 'Error: mesma causa\n    at x (D:/Projetos/Yui/src/a.js:1:1)';
  const b = new Error('mesma causa'); b.stack = 'Error: mesma causa\n    at y (D:/Projetos/Yui/src/b.js:2:2)';
  assert.equal(crashAlertKey(a), crashAlertKey(b));
});
await test('aceita o que não é Error (texto, objeto, undefined) sem lançar', async () => {
  assert.equal(crashAlertKey('falhou feio'), 'crash:falhou feio');
  assert.equal(crashAlertKey({ code: 7 }), 'crash:{"code":7}');
  assert.equal(crashCause(undefined), 'undefined');
  assert.equal(crashCause(''), 'sem mensagem');
  assert.equal(describeReason(undefined), 'undefined');
});

console.log('Erros graves: primeiro frame em src/');
await test('acha o primeiro frame do projeto, ignorando node_modules e node:', async () => {
  assert.equal(firstProjectFrame(STACK, { root: ROOT }), 'src/handlers/voiceHandler.js:229:25');
});
await test('entende caminhos do Windows com barra invertida e frame sem função', async () => {
  const stack = 'Error: x\n    at D:\\Projetos\\Yui\\src\\music\\radioManager.js:176:25\n    at node:internal/x:1:1';
  assert.equal(firstProjectFrame(stack, { root: 'D:\\Projetos\\Yui' }), 'src/music/radioManager.js:176:25');
});
await test('sem passar a raiz, usa a pasta real do projeto (onde o src/ da Yui está)', async () => {
  const realRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
  const frame = `    at fn (${path.join(realRoot, 'src', 'handlers', 'voiceHandler.js')}:10:5)`;
  assert.equal(firstProjectFrame(`Error: x\n${frame}`), 'src/handlers/voiceHandler.js:10:5');
});
await test('devolve null quando nenhum frame é do projeto (ou não há pilha)', async () => {
  assert.equal(firstProjectFrame('Error: x\n    at a (C:/outro/src/x.js:1:1)\n    at b (node:events:1:1)', { root: ROOT }), null);
  assert.equal(firstProjectFrame('', { root: ROOT }), null);
  assert.equal(firstProjectFrame(undefined, { root: ROOT }), null);
});
await test('o corpo da DM começa pela origem em src/ e mantém só as primeiras linhas da pilha', async () => {
  const detail = formatCrashDetail(opusError(), { maxLines: 4, root: ROOT });
  const lines = detail.split('\n');
  assert.equal(lines[0], 'Origem na Yui: src/handlers/voiceHandler.js:229:25');
  assert.equal(lines.length, 1 + 4);
});
await test('a origem sobrevive ao corte de 500 caracteres do aviso (vai no começo)', async () => {
  const { alerter, sent } = make();
  const err = opusError();
  err.stack = ['Error: ' + 'longa '.repeat(120), ...STACK.split('\n').slice(1)].join('\n');
  await alerter.alert(crashAlertKey(err), 'Erro grave na Yui', formatCrashDetail(err, { maxLines: 4, root: ROOT }), { level: 'error' });
  assert.match(sent[0].text, /Origem na Yui: src\/handlers\/voiceHandler\.js:229:25/);
});
await test('sem frame do projeto, o corpo é só a pilha cortada (sem linha de origem)', async () => {
  const err = new Error('boom'); err.stack = 'Error: boom\n    at a (node:events:1:1)';
  assert.ok(!formatCrashDetail(err, { root: ROOT }).includes('Origem na Yui'));
});

console.log('Erros graves: cooldown');
await test('exceção + rejeição da mesma causa geram UMA DM só; causa nova gera outra', async () => {
  const { alerter, sent } = make();
  const exceptionOk = await alerter.alert(crashAlertKey(opusError()), 'Erro grave na Yui', 'a', { level: 'error' });
  const rejectionOk = await alerter.alert(crashAlertKey(new Error(OPUS_MESSAGE.replace(/^Error: /, ''))), 'Erro inesperado (promessa rejeitada)', 'b', { level: 'error' });
  assert.equal(exceptionOk, true);
  assert.equal(rejectionOk, false);
  assert.equal(await alerter.alert(crashAlertKey(new Error('outra causa')), 'Erro grave na Yui', 'c', { level: 'error' }), true);
  assert.equal(sent.length, 2);
});
await test('a mesma causa volta a avisar depois do intervalo (30 min) e o teto de 10/h continua valendo', async () => {
  const { alerter, sent, advance } = make();
  const key = crashAlertKey(opusError());
  assert.equal(await alerter.alert(key, 'T'), true);
  advance(31);
  assert.equal(await alerter.alert(key, 'T'), true);
  for (let i = 0; i < 20; i++) await alerter.alert(crashAlertKey(new Error('causa ' + i)), 'T');
  assert.equal(sent.length, 10);
});
await test('DM que falha queima o intervalo (documentado): não repete até o cooldown passar', async () => {
  let fail = true;
  const sent = [];
  let clock = 1_000_000;
  const alerter = createAlerter({
    notify: async (id, text) => { if (fail) throw new Error('Cannot send messages to this user'); sent.push(text); },
    ownerId: '1', env: {}, now: () => clock,
  });
  assert.equal(await alerter.alert('k', 'T'), false);
  fail = false;
  assert.equal(await alerter.alert('k', 'T'), false);
  clock += 31 * 60_000;
  assert.equal(await alerter.alert('k', 'T'), true);
  assert.equal(sent.length, 1);
});
await test('YUI_ALERTS=false continua desligando os avisos de erro grave', async () => {
  const { alerter, sent } = make({ env: { YUI_ALERTS: 'false' } });
  assert.equal(await alerter.alert(crashAlertKey(opusError()), 'Erro grave na Yui', formatCrashDetail(opusError(), { root: ROOT })), false);
  assert.equal(sent.length, 0);
});

console.log(`\n${passed} testes OK`);
