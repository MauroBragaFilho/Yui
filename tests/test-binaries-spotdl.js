// Item "spotdl" da checagem de ferramentas opcionais na inicialização (src/utils/binaries.js).
// Sem rede e sem rodar o spotdl: a checagem só olha se o ARQUIVO existe (SPOTDL_PATH, .venv-spotdl ou PATH).
// Tudo roda em pasta temporária, com env, caminhos e log injetados.
// Execução: npm run test:binaries-spotdl
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-binspotdl-'));

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const binaries = await import(new URL('../src/utils/binaries.js', import.meta.url));
const { OPTIONAL_PYTHON_TOOLS, checkOptionalPythonTools } = binaries;
const source = fs.readFileSync(path.join(root, 'src/utils/binaries.js'), 'utf8');

const fakeLog = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(`info: ${m}`), warn: (m) => lines.push(`warn: ${m}`) };
};
const spotdlTool = () => OPTIONAL_PYTHON_TOOLS.filter((t) => t.key === 'spotdl');
const win = process.platform === 'win32';
const exeName = win ? 'spotdl.exe' : 'spotdl';

// Árvore falsa de uma raiz de projeto: sem .venv-spotdl (rootDir vazio), com .venv-spotdl, e uma pasta no lugar do arquivo.
const emptyRoot = path.join(sandbox, 'sem-venv');
fs.mkdirSync(emptyRoot, { recursive: true });
const venvRoot = path.join(sandbox, 'com-venv');
const venvExe = win ? path.join(venvRoot, '.venv-spotdl', 'Scripts', exeName) : path.join(venvRoot, '.venv-spotdl', 'bin', exeName);
fs.mkdirSync(path.dirname(venvExe), { recursive: true });
fs.writeFileSync(venvExe, '');
const customExe = path.join(sandbox, 'custom', exeName);
fs.mkdirSync(path.dirname(customExe), { recursive: true });
fs.writeFileSync(customExe, '');
const dirInstead = path.join(sandbox, 'pasta-no-lugar');
fs.mkdirSync(dirInstead, { recursive: true });

console.log('1. A lista de ferramentas opcionais');

await test('OPTIONAL_PYTHON_TOOLS tem o deemix e, depois dele, o spotdl com rótulo, dica e check', () => {
  assert.deepStrictEqual(OPTIONAL_PYTHON_TOOLS.map((t) => t.key), ['deemix', 'spotdl']);
  const [item] = spotdlTool();
  assert.strictEqual(item.label, 'Spotdl');
  assert.strictEqual(typeof item.check, 'function');
  assert.ok(item.hint.includes('.venv-spotdl') && item.hint.includes('SPOTDL_PATH'), 'a dica diz onde instalar');
});

await test('o código não importa o spotdlTools ao carregar (import dinâmico no check) e o retorno de validateMediaTools traz spotdlOk', () => {
  assert.ok(!/^import .*spotdlTools/m.test(source), 'import estático traria o módulo do spotdl para quem só quer os caminhos dos binários');
  assert.ok(/await import\('\.\/spotdlTools\.js'\)/.test(source));
  const body = binaries.validateMediaTools.toString();
  assert.match(body, /Boolean\(optionalTools\.spotdl\?\.ok\)/);
  assert.match(body, /return \{[^}]*deemixOk[^}]*spotdlOk[^}]*\}/, 'spotdlOk é ADITIVO: os campos de antes continuam no retorno');
  assert.match(body, /optionalTools/);
});

await test('o check do spotdl não usa processo nem rede (só confere arquivos)', () => {
  const start = source.indexOf("key: 'spotdl'");
  const block = source.slice(start, source.indexOf('];', start));
  assert.ok(block.length > 100);
  assert.ok(!/execFile|spawn|exec\(|https?\.|fetch\(|axios/.test(block), 'o item não executa nada');
});

console.log('2. Os três desfechos da checagem');

await test('spotdl achado em SPOTDL_PATH: "[MediaTools] Spotdl: OK (...)" e nada de aviso', async () => {
  const log = fakeLog();
  const res = await checkOptionalPythonTools({ tools: spotdlTool(), log, options: { spotdl: { env: { SPOTDL_PATH: customExe, PATH: '' }, rootDir: emptyRoot } } });
  assert.strictEqual(res.spotdl.ok, true);
  assert.strictEqual(res.spotdl.code, null);
  assert.strictEqual(log.lines.length, 1);
  assert.ok(log.lines[0].startsWith('info: [MediaTools] Spotdl: OK ('), log.lines[0]);
  assert.ok(log.lines[0].includes('origem: SPOTDL_PATH'), log.lines[0]);
});

await test('spotdl no .venv-spotdl da raiz do projeto: OK com origem "venv"', async () => {
  const log = fakeLog();
  const res = await checkOptionalPythonTools({ tools: spotdlTool(), log, options: { spotdl: { env: { PATH: '' }, rootDir: venvRoot } } });
  assert.strictEqual(res.spotdl.ok, true);
  assert.ok(log.lines[0].includes('origem: venv'), log.lines[0]);
});

await test('spotdl no PATH (um arquivo spotdl existe numa pasta do PATH): OK com origem "PATH"', async () => {
  const log = fakeLog();
  const pathDir = path.dirname(customExe);
  const res = await checkOptionalPythonTools({
    tools: spotdlTool(),
    log,
    options: { spotdl: { env: { PATH: pathDir }, rootDir: emptyRoot, isWin: win } },
  });
  assert.strictEqual(res.spotdl.ok, true, JSON.stringify(res.spotdl));
  assert.ok(log.lines[0].includes('origem: PATH'), log.lines[0]);
});

await test('sem spotdl em lugar nenhum: "[MediaTools] Spotdl: FALTANDO (SPOTDL_NOT_FOUND)" com a dica, sem lançar', async () => {
  const log = fakeLog();
  const res = await checkOptionalPythonTools({ tools: spotdlTool(), log, options: { spotdl: { env: { PATH: '' }, rootDir: emptyRoot } } });
  assert.strictEqual(res.spotdl.ok, false);
  assert.strictEqual(res.spotdl.code, 'SPOTDL_NOT_FOUND');
  assert.strictEqual(log.lines.length, 1);
  assert.ok(log.lines[0].startsWith('warn: [MediaTools] Spotdl: FALTANDO (SPOTDL_NOT_FOUND).'), log.lines[0]);
  assert.ok(log.lines[0].includes('.venv-spotdl') && log.lines[0].includes('yt-dlp'), log.lines[0]);
});

await test('SPOTDL_PATH apontando para uma PASTA não vale (precisa ser arquivo): cai no .venv-spotdl ou no PATH', async () => {
  const log = fakeLog();
  const semVenv = await checkOptionalPythonTools({ tools: spotdlTool(), log, options: { spotdl: { env: { SPOTDL_PATH: dirInstead, PATH: '' }, rootDir: emptyRoot } } });
  assert.strictEqual(semVenv.spotdl.ok, false, 'uma pasta não é um spotdl');
  const log2 = fakeLog();
  const comVenv = await checkOptionalPythonTools({ tools: spotdlTool(), log: log2, options: { spotdl: { env: { SPOTDL_PATH: dirInstead, PATH: '' }, rootDir: venvRoot } } });
  assert.strictEqual(comVenv.spotdl.ok, true);
  assert.ok(log2.lines[0].includes('origem: venv'), log2.lines[0]);
});

console.log('3. Convivência com o deemix');

await test('a lista padrão verifica os dois e registra uma linha por ferramenta, na ordem deemix e spotdl', async () => {
  const log = fakeLog();
  const tools = [
    { key: 'deemix', label: 'Deemix', hint: 'dica', check: async () => ({ ok: true, message: 'v1' }) },
    ...spotdlTool(),
  ];
  const res = await checkOptionalPythonTools({ tools, log, options: { spotdl: { env: { SPOTDL_PATH: customExe, PATH: '' }, rootDir: emptyRoot } } });
  assert.deepStrictEqual(Object.keys(res), ['deemix', 'spotdl']);
  assert.strictEqual(log.lines.length, 2);
  assert.ok(log.lines[0].startsWith('info: [MediaTools] Deemix: OK'), log.lines[0]);
  assert.ok(log.lines[1].startsWith('info: [MediaTools] Spotdl: OK'), log.lines[1]);
});

await test('o spotdl ausente não atrapalha o deemix (e vice-versa): cada resultado é independente', async () => {
  const log = fakeLog();
  const tools = [
    { key: 'deemix', label: 'Deemix', hint: 'dica', check: async () => ({ ok: false, code: 'DEEMIX_NOT_INSTALLED', message: 'x' }) },
    ...spotdlTool(),
  ];
  const res = await checkOptionalPythonTools({ tools, log, options: { spotdl: { env: { SPOTDL_PATH: customExe, PATH: '' }, rootDir: emptyRoot } } });
  assert.strictEqual(res.deemix.ok, false);
  assert.strictEqual(res.spotdl.ok, true);
  assert.ok(log.lines[0].startsWith('warn:') && log.lines[1].startsWith('info:'));
});

await test('o log da checagem não carrega segredos nem o texto cru de erro técnico', async () => {
  const log = fakeLog();
  await checkOptionalPythonTools({ tools: spotdlTool(), log, options: { spotdl: { env: { PATH: '', DISCORD_TOKEN: 'token-secreto-123' }, rootDir: emptyRoot } } });
  assert.ok(!log.lines.join('\n').includes('token-secreto-123'));
  assert.ok(!/ENOENT|spawn/.test(log.lines.join('\n')));
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failed ? `\nFALHA: ${passed} teste(s) passaram, ${failed} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failed ? 1 : 0);
