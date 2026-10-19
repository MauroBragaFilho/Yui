// Testes da leitura de configuração (nomes de variáveis do .env).
// Execução: npm run test:config
import assert from 'assert';

// Define o ambiente ANTES de importar (o .env real não sobrescreve variáveis já definidas).
Object.assign(process.env, {
  GEMINI_API_KEYS: '',
  GEMINI_API_KEY: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  GEMINI_MODEL: 'gemini-2.5-flash-lite', // aposentado pelo Google
  GEMINI_MODEL_FALLBACK: 'gemini-2.5-flash', // aposentado pelo Google
  STABILITY_API_KEYS: '',
  STABILITY_API_KEY: 'stab-key-0000000001, stab-key-0000000002',
  OWNER_ID: '111111111111111111',
  OWNER_IDS: '222222222222222222, 333333333333333333',
});

const { default: config } = await import('../src/config/index.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✔ ${name}`); };

test('Gemini: aceita GEMINI_API_KEY (singular) e GEMINI_API_KEYS (plural)', () => {
  assert.deepEqual(config.geminiApiKeys, ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1']);
});

test('Gemini: modelos aposentados no .env viram os apelidos atuais', () => {
  assert.equal(config.geminiModel, 'gemini-flash-lite-latest');
  assert.equal(config.geminiModelFallback, 'gemini-flash-latest');
});

test('Stability: aceita STABILITY_API_KEY (singular) com várias chaves', () => {
  assert.deepEqual(config.stabilityApiKeys, ['stab-key-0000000001', 'stab-key-0000000002']);
});

test('Stability: getStabilityKey existe (o imageHandler a chama) e devolve uma das chaves', () => {
  assert.equal(typeof config.getStabilityKey, 'function');
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(config.getStabilityKey());
  assert.ok([...seen].every((k) => config.stabilityApiKeys.includes(k)));
  assert.equal(seen.size, 2, 'sorteia entre as chaves (balanceamento)');
});

test('dono: OWNER_ID e a lista OWNER_IDS valem; outros não', () => {
  assert.ok(config.isOwner('111111111111111111'));
  assert.ok(config.isOwner('333333333333333333'));
  assert.ok(!config.isOwner('999999999999999999'));
  assert.ok(!config.isOwner(''));
});

console.log(`\n${passed} testes OK`);
process.exit(0);
