// Testes de src/utils/uploadLimit.js (limite de anexo do Discord: 10 MB no servidor do dono), sem rede.
// Execução: npm run test:uploadlimit   (ou: node tests/test-upload-limit.js)
import assert from 'node:assert/strict';
import {
  getUploadLimitBytes, getNominalLimitMB, limitLabelMB, formatUploadLimit, formatMB, maxAudioMinutes,
  UPLOAD_SAFETY_FACTOR, DEFAULT_UPLOAD_LIMIT_MB,
} from '../src/utils/uploadLimit.js';

let passed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✘ FALHA ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`); }
};

const MIB = 1024 * 1024;
const safe = (mb) => Math.floor(mb * MIB * 0.95);
const NOENV = {}; // ambiente vazio: nada de YUI_UPLOAD_LIMIT_MB

console.log('getUploadLimitBytes');
test('constantes', () => { assert.equal(UPLOAD_SAFETY_FACTOR, 0.95); assert.equal(DEFAULT_UPLOAD_LIMIT_MB, 10); });
test('sem guild (DM, produtores de MP3) = base de 10 MiB com folga: 9.961.472 bytes', () => {
  assert.equal(getUploadLimitBytes(null, NOENV), 9961472);
  assert.equal(getUploadLimitBytes(undefined, NOENV), 9961472);
  assert.equal(getUploadLimitBytes({}, NOENV), 9961472);
});
test('o teto fica abaixo de 10.000.000 (cobre MB decimal) e de 10 MiB', () => {
  const l = getUploadLimitBytes(null, NOENV);
  assert.ok(l < 10_000_000 && l < 10 * MIB);
});
test('tier 0 e 1 usam 10 MiB', () => {
  assert.equal(getUploadLimitBytes({ premiumTier: 0 }, NOENV), safe(10));
  assert.equal(getUploadLimitBytes({ premiumTier: 1 }, NOENV), safe(10));
});
test('tier 2 usa 50 MiB e tier 3 usa 100 MiB', () => {
  assert.equal(getUploadLimitBytes({ premiumTier: 2 }, NOENV), safe(50));
  assert.equal(getUploadLimitBytes({ premiumTier: 3 }, NOENV), safe(100));
});
test('tier em texto ou inválido não quebra', () => {
  assert.equal(getUploadLimitBytes({ premiumTier: '2' }, NOENV), safe(50));
  assert.equal(getUploadLimitBytes({ premiumTier: 'x' }, NOENV), safe(10));
  assert.equal(getUploadLimitBytes({ premiumTier: 7 }, NOENV), safe(10));
});
test('YUI_UPLOAD_LIMIT_MB troca a base (tier 0/1 e sem guild)', () => {
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '25' }), safe(25));
  assert.equal(getUploadLimitBytes({ premiumTier: 1 }, { YUI_UPLOAD_LIMIT_MB: '25' }), safe(25));
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '8' }), safe(8));
});
test('com a base trocada, tier 2 e 3 nunca ficam abaixo de 50 e 100', () => {
  assert.equal(getUploadLimitBytes({ premiumTier: 2 }, { YUI_UPLOAD_LIMIT_MB: '25' }), safe(50));
  assert.equal(getUploadLimitBytes({ premiumTier: 3 }, { YUI_UPLOAD_LIMIT_MB: '8' }), safe(100));
  assert.equal(getUploadLimitBytes({ premiumTier: 2 }, { YUI_UPLOAD_LIMIT_MB: '75' }), safe(75));
});
test('valores inválidos de YUI_UPLOAD_LIMIT_MB caem no padrão; extremos são limitados a 1..100', () => {
  for (const bad of ['', 'abc', '0', '-5', 'NaN', '   ']) assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: bad }), safe(10), JSON.stringify(bad));
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '500' }), safe(100));
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '0.2' }), safe(1));
});
test('aceita decimal com ponto ou vírgula', () => {
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '7.5' }), safe(7.5));
  assert.equal(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '7,5' }), safe(7.5));
});
test('sem o segundo argumento lê process.env (e restaura depois)', () => {
  const before = process.env.YUI_UPLOAD_LIMIT_MB;
  try {
    delete process.env.YUI_UPLOAD_LIMIT_MB;
    assert.equal(getUploadLimitBytes(null), safe(10));
    process.env.YUI_UPLOAD_LIMIT_MB = '30';
    assert.equal(getUploadLimitBytes(null), safe(30));
  } finally {
    if (before === undefined) delete process.env.YUI_UPLOAD_LIMIT_MB; else process.env.YUI_UPLOAD_LIMIT_MB = before;
  }
});
test('retorna sempre inteiro', () => {
  for (const mb of ['7.3', '12.7', '33.33']) assert.ok(Number.isInteger(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: mb })));
});

console.log('rótulos');
test('getNominalLimitMB', () => {
  assert.equal(getNominalLimitMB(null, NOENV), 10);
  assert.equal(getNominalLimitMB({ premiumTier: 2 }, NOENV), 50);
  assert.equal(getNominalLimitMB({ premiumTier: 3 }, NOENV), 100);
  assert.equal(getNominalLimitMB(null, { YUI_UPLOAD_LIMIT_MB: '25' }), 25);
});
test('limitLabelMB desfaz a folga e volta ao número do Discord', () => {
  assert.equal(limitLabelMB(getUploadLimitBytes(null, NOENV)), 10);
  assert.equal(limitLabelMB(getUploadLimitBytes({ premiumTier: 2 }, NOENV)), 50);
  assert.equal(limitLabelMB(getUploadLimitBytes({ premiumTier: 3 }, NOENV)), 100);
  assert.equal(limitLabelMB(getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '25' })), 25);
});
test('formatUploadLimit', () => {
  assert.equal(formatUploadLimit(getUploadLimitBytes(null, NOENV)), '10 MB');
  assert.equal(formatUploadLimit(getUploadLimitBytes({ premiumTier: 3 }, NOENV)), '100 MB');
});

console.log('formatMB');
test('inteiros e decimais em MiB com vírgula', () => {
  assert.equal(formatMB(10 * MIB), '10 MB');
  assert.equal(formatMB(9961472), '9,5 MB');
  assert.equal(formatMB(1.5 * MIB), '1,5 MB');
  assert.equal(formatMB(12.34 * MIB), '12,3 MB');
  assert.equal(formatMB(150 * MIB), '150 MB');
});
test('muito pequeno, zero e entrada inválida', () => {
  assert.equal(formatMB(300), 'menos de 0,1 MB');
  assert.equal(formatMB(0), '0 MB');
  for (const bad of [-1, NaN, undefined, null, 'abc', Infinity]) assert.equal(formatMB(bad), '0 MB', String(bad));
});

console.log('maxAudioMinutes');
test('192 kbps: 10 MiB cabem em cerca de 7 min 17 s; com a folga, 6 min 55 s', () => {
  const nominal = maxAudioMinutes(10 * MIB, 192);
  assert.ok(Math.abs(nominal - (7 + 17 / 60)) < 0.02, String(nominal));
  const withSafety = maxAudioMinutes(getUploadLimitBytes(null, NOENV), 192);
  assert.ok(Math.abs(withSafety - (6 + 55 / 60)) < 0.03, String(withSafety));
});
test('128 e 96 kbps cabem mais; 320 kbps menos', () => {
  const l = getUploadLimitBytes(null, NOENV);
  assert.ok(maxAudioMinutes(l, 128) > maxAudioMinutes(l, 192));
  assert.ok(maxAudioMinutes(l, 96) > maxAudioMinutes(l, 128));
  assert.ok(maxAudioMinutes(l, 320) < 4.2);
});
test('entradas inválidas devolvem 0', () => {
  assert.equal(maxAudioMinutes(0, 192), 0);
  assert.equal(maxAudioMinutes(1000, 0), 0);
  assert.equal(maxAudioMinutes('x', 192), 0);
});

console.log(`\n${passed} ok, ${failures.length} falha(s)`);
if (failures.length) { console.log(`FALHAS: ${failures.join(' | ')}`); process.exit(1); }
