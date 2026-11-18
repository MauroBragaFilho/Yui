// Verificação do package-lock antes de instalar dependências (supply chain). Execução: npm run test:lockverify
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';

const { checkLock, REGISTRY } = await import('../scripts/verificar-lock.mjs');
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-lock-'));
// Etapa 8 (revisão da Liz): os processos auxiliares deste teste rodam sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers
// falham e ficam registrados; nenhuma exceção: o script só lê arquivos de lock). O registro guarda qual teste abriu cada exceção.
const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:lockverify', liberar: {} });
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const good = (n, extra = {}) => ({ version: '1.0.0', resolved: `${REGISTRY}${n}/-/${n}-1.0.0.tgz`, integrity: `sha512-${'A'.repeat(86)}==`, ...extra });
const lock = (pk) => ({ lockfileVersion: 3, packages: { '': { name: 'yui' }, ...pk } });
const cli = (novo, atual) => spawnSync(process.execPath, [...BLOQUEIO.argv, path.join(root, 'scripts', 'verificar-lock.mjs'), novo, ...(atual ? [atual] : [])], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...BLOQUEIO.env('verificar-lock') } });
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

console.log('Regras');
await test('lock normal (registro oficial + sha512) passa, e o package-lock REAL do projeto passa', () => {
  assert.deepEqual(checkLock(lock({ 'node_modules/a': good('a') })).errors, []);
  const real = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const r = checkLock(real, real);
  assert.deepEqual(r.errors, [], r.errors.slice(0, 3).join('; '));
  assert.ok(r.total > 100);
});
await test('NEGATIVO: dependência vinda de git, http, arquivo ou outro registro é recusada', () => {
  for (const resolved of ['git+ssh://git@github.com/x/y.git#abc', 'git+https://github.com/x/y.git', 'http://registry.npmjs.org/a/-/a-1.tgz', 'file:../a', 'https://registro-falso.example/a/-/a-1.tgz', 'https://registry.npmjs.org.evil.example/a/-/a-1.tgz']) {
    const r = checkLock(lock({ 'node_modules/a': good('a', { resolved }) }));
    assert.equal(r.errors.length, 1, resolved);
  }
});
await test('NEGATIVO: pacote sem hash de integridade ou com hash fraco (sha1) é recusado', () => {
  const semHash = good('a'); delete semHash.integrity;
  assert.equal(checkLock(lock({ 'node_modules/a': semHash })).errors.length, 1);
  assert.equal(checkLock(lock({ 'node_modules/a': good('a', { integrity: 'sha1-abc=' }) })).errors.length, 1);
});
await test('NEGATIVO: lockfile antigo/inválido (sem "packages") é recusado', () => {
  assert.equal(checkLock({ lockfileVersion: 1, dependencies: {} }).errors.length, 1);
  assert.equal(checkLock(null).errors.length, 1);
});
await test('AVISO (não recusa): pacote NOVO com script de instalação; pacote que já tinha não avisa', () => {
  const antes = lock({ 'node_modules/b': good('b', { hasInstallScript: true }) });
  const depois = lock({ 'node_modules/b': good('b', { hasInstallScript: true }), 'node_modules/c': good('c', { hasInstallScript: true }) });
  const r = checkLock(depois, antes);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^c@/);
});
await test('link local e pacote embutido não são tratados como violação', () => {
  const r = checkLock(lock({ 'node_modules/w': { link: true, resolved: 'packages/w' }, 'node_modules/x/node_modules/y': { version: '1.0.0', inBundle: true } }));
  assert.deepEqual(r.errors, []);
});

console.log('Comando (é o que o atualizador roda)');
await test('código de saída 0 para lock bom e 2 para lock recusado; 2 também para arquivo ilegível', () => {
  const bom = write('bom.json', lock({ 'node_modules/a': good('a') }));
  const ruim = write('ruim.json', lock({ 'node_modules/a': good('a', { resolved: 'git+ssh://git@github.com/x/y.git' }) }));
  const quebrado = write('quebrado.json', '{ nao e json');
  assert.equal(cli(bom, bom).status, 0);
  const r = cli(ruim, bom);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ERRO: a: não vem do registro oficial/);
  assert.match(r.stdout, /RECUSADO/);
  assert.equal(cli(quebrado).status, 2);
  assert.equal(cli(path.join(tmp, 'nao-existe.json')).status, 2);
});

console.log('Vigia do atualizador');
await test('o atualizador confere o package-lock ANTES do teste de subida e de copiar qualquer coisa, usando o verificador já instalado', () => {
  const ps = fs.readFileSync(path.join(root, 'scripts', 'atualizar-yui.ps1'), 'utf8');
  const lockCheck = ps.indexOf('verificar-lock.mjs');
  assert.ok(lockCheck > 0, 'chama o verificador');
  assert.ok(lockCheck < ps.indexOf('Testar-Subida $novo'), 'antes do teste de subida');
  assert.ok(lockCheck < ps.indexOf('robocopy $novo $Destino'), 'antes de copiar por cima');
  assert.match(ps, /\$Destino.scripts.verificar-lock\.mjs/, 'prefere o verificador já instalado (versão anterior confiável)');
  assert.match(ps, /archive\/\$remoto\.zip/, 'baixa o zip do commit exato (SHA), não do ramo');
  assert.doesNotMatch(ps, /[^\x00-\x7F]/, 'só ASCII (o PowerShell 5.1 do notebook lê o arquivo sem BOM)');
});

BLOQUEIO.fechar('test:lockverify'); // falha alto se o script tentou rede, DNS, UDP, programa ou worker
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
