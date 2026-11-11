// O painel web versionado (painel-web/) precisa corresponder ao código-fonte do app. Se este teste falhar:
//   cd apps/yui-app && npm run painel:build   e comite a pasta painel-web/ junto com a mudança.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fonteHash, fonteFiles } from '../scripts/fonte-hash.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const painel = path.join(appDir, 'painel-web');

test('painel-web/ existe, tem index.html e o bundle que o index.html cita', () => {
  assert.ok(fs.existsSync(path.join(painel, 'index.html')), 'rode npm run painel:build');
  const html = fs.readFileSync(path.join(painel, 'index.html'), 'utf8');
  const m = /src="(\/_expo\/static\/js\/web\/[^"]+\.js)"/.exec(html);
  assert.ok(m, 'index.html cita o bundle');
  assert.ok(fs.existsSync(path.join(painel, m[1])), `o bundle ${m[1]} está na pasta`);
});

test('o painel compilado não leva endereço de servidor embutido (usa o endereço da página)', () => {
  const dir = path.join(painel, '_expo', 'static', 'js', 'web');
  const js = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.equal(/127\.0\.0\.1:39(39|4\d)/.test(js), false, 'sem 127.0.0.1:39xx no bundle');
});

test('o carimbo de painel-web/.fonte bate com o código-fonte atual (senão: npm run painel:build)', () => {
  const guardado = fs.readFileSync(path.join(painel, '.fonte'), 'utf8').trim();
  assert.equal(fonteHash(appDir), guardado, 'o app mudou sem recompilar o painel versionado');
});

test('o carimbo ignora CRLF vs LF e muda quando o texto muda', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-fonte-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'App.tsx'), 'linha1\nlinha2\n');
  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'x\n');
  const lf = fonteHash(tmp);
  fs.writeFileSync(path.join(tmp, 'App.tsx'), 'linha1\r\nlinha2\r\n');
  assert.equal(fonteHash(tmp), lf, 'CRLF não muda o carimbo');
  fs.writeFileSync(path.join(tmp, 'App.tsx'), 'linha1\nlinha2 MUDOU\n');
  assert.notEqual(fonteHash(tmp), lf, 'mudança de texto muda o carimbo');
  assert.deepEqual(fonteFiles(tmp), ['App.tsx', 'src/a.ts']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
