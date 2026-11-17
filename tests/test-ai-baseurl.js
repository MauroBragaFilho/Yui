// Endereço (baseUrl) de provedor de IA próprio: fora da rede só com host liberado no .env. Execução: npm run test:aibaseurl
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-baseurl-'));
process.env.YUI_AI_SETTINGS_FILE = path.join(tmp, 'secrets', 'ai-providers.json');
delete process.env.YUI_AI_BASEURL_HOSTS;

const { checkBaseUrl, isHostAllowed, addCustom, loadSettings } = await import('../src/core/aiSettings.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.status ?? 'erro'; } };
const env = (hosts) => ({ YUI_AI_BASEURL_HOSTS: hosts });

console.log('Lista de hosts liberados');
await test('host exato e coringa de subdomínio; o coringa não cobre o domínio puro nem parecidos', () => {
  assert.equal(isHostAllowed('api.exemplo.com', env('api.exemplo.com')), true);
  assert.equal(isHostAllowed('API.Exemplo.com', env(' API.EXEMPLO.com ')), true, 'sem diferença de maiúsculas e espaços');
  assert.equal(isHostAllowed('a.b.exemplo.com', env('*.exemplo.com')), true);
  assert.equal(isHostAllowed('exemplo.com', env('*.exemplo.com')), false, 'o coringa não é o domínio puro');
  assert.equal(isHostAllowed('evilexemplo.com', env('*.exemplo.com')), false);
  assert.equal(isHostAllowed('exemplo.com.evil.example', env('exemplo.com')), false);
  assert.equal(isHostAllowed('api.exemplo.com', env('https://api.exemplo.com:443/v1')), true, 'aceita a lista escrita como URL');
});
await test('lista vazia ou ausente não libera ninguém', () => {
  assert.equal(isHostAllowed('api.exemplo.com', {}), false);
  assert.equal(isHostAllowed('api.exemplo.com', env('')), false);
  assert.equal(isHostAllowed('api.exemplo.com', env(' , ,')), false);
  assert.equal(isHostAllowed('', env('*.x.com')), false);
});

console.log('checkBaseUrl');
await test('máquina e rede local seguem livres, sem lista (OmniRoute, LM Studio)', () => {
  for (const u of ['http://127.0.0.1:20128/v1', 'http://localhost:1234/v1', 'http://192.168.15.12:20128/v1', 'http://10.0.0.5/v1', 'https://meu-pc.local/v1', 'http://100.64.0.9:8080/v1']) assert.equal(status(() => checkBaseUrl(u, {})), 200, u);
});
await test('NEGATIVO: host público não liberado é recusado com 403 (era o redirecionamento do tráfego de IA)', () => {
  for (const u of ['https://servidor-do-atacante.example/v1', 'https://api.openai.com/v1', 'https://1.2.3.4/v1']) assert.equal(status(() => checkBaseUrl(u, {})), 403, u);
  assert.equal(status(() => checkBaseUrl('https://api.exemplo.com/v1', env('outro.com'))), 403);
});
await test('host público liberado no .env passa (https)', () => {
  assert.equal(checkBaseUrl('https://api.exemplo.com/v1/', env('api.exemplo.com')), 'https://api.exemplo.com/v1');
});
await test('as regras antigas continuam: http fora da rede, usuário/senha, parâmetros e esquema errado seguem recusados mesmo com o host liberado', () => {
  const liberado = env('api.exemplo.com');
  assert.equal(status(() => checkBaseUrl('http://api.exemplo.com/v1', liberado)), 400, 'http fora da rede');
  assert.equal(status(() => checkBaseUrl('https://u:p@api.exemplo.com/v1', liberado)), 400);
  assert.equal(status(() => checkBaseUrl('https://api.exemplo.com/v1?x=1', liberado)), 400);
  assert.equal(status(() => checkBaseUrl('ftp://api.exemplo.com/v1', liberado)), 400);
  assert.equal(status(() => checkBaseUrl('isso não é uma URL', liberado)), 400);
});

console.log('Cadastro');
await test('addCustom com host não liberado recusa e NÃO grava nada; com o host liberado grava', () => {
  const body = { id: 'nuvem', label: 'Nuvem', baseUrl: 'https://api.exemplo.com/v1', models: ['m1'], key: 'sk-chave-de-teste-1234567890' };
  assert.equal(status(() => addCustom(body)), 403);
  assert.deepEqual(loadSettings().custom, [], 'nada foi salvo');
  process.env.YUI_AI_BASEURL_HOSTS = 'api.exemplo.com';
  try {
    assert.equal(status(() => addCustom(body)), 200);
    assert.equal(loadSettings().custom.length, 1);
  } finally { delete process.env.YUI_AI_BASEURL_HOSTS; }
});
await test('provedor já salvo (de antes da regra) continua carregando mesmo sem a lista', () => {
  assert.equal(loadSettings().custom[0]?.baseUrl, 'https://api.exemplo.com/v1');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
