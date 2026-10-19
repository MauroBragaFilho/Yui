// Testes do download pelo Deezer (deemix), do plano B via YouTube e dos provedores do Modo Rádio.
// Sem rede, sem Discord, sem bancos reais, sem Python real do deemix.
// Execução: npm run test:deezer
//
// Como funciona: ganchos de módulo (module.register) trocam logger, config, binários, banHandler,
// radioCleaner, youtubeAudioHandler e radioDatabase por dublês; assim importar os módulos reais não
// cria pastas, não abre banco, não inicia timers e não escreve em logs/. Os processos filhos são
// `process.execPath` com scripts falsos e, se houver Python, o script real com pacotes deezer/deemix falsos.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { register } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-deezer-'));
process.env.DATABASE_DIR = path.join(tmp, 'db');
process.env.YUI_TEST_RADIO_DIR = path.join(tmp, 'radio');
fs.mkdirSync(process.env.YUI_TEST_RADIO_DIR, { recursive: true });

const ARL = `ARL_TESTE_${'a1B2c3D4'.repeat(20)}`; // 170 caracteres, formato de token
process.env.DEEZER_ARL = ARL;
process.env.DISCORD_TOKEN = 'token-que-nao-pode-vazar';
process.env.GROQ_API_KEY = 'chave-que-nao-pode-vazar';
process.env.DEEMIX_ARL = 'outro-arl-que-nao-pode-vazar';
delete process.env.PYTHON_PATH;
delete process.env.YUI_DEEZER_TIMEOUT_S;
delete process.env.YUI_DEEMIX_CONFIG_DIR;

// ---- dublês de módulo --------------------------------------------------------------------------
const logs = [];
globalThis.__yuiLog = {
  info: (m) => logs.push(`info: ${m}`),
  warn: (m) => logs.push(`warn: ${m}`),
  error: (m) => logs.push(`error: ${m}`),
  debug: (m) => logs.push(`debug: ${m}`),
};
const stubs = {
  dotenv: 'export default { config() { return {}; } };',
  '../utils/logger.js': 'export const logger = globalThis.__yuiLog; export default logger;',
  '../utils/binaries.js': "export const getYtdlpPath = () => 'yt-dlp-falso'; export const getFfmpegPath = () => 'ffmpeg-falso'; export default {};",
  '../config.js': "export default { ytdlpCookiesPath: '', ytdlpExtraFlags: ['--ignore-config'] };",
  './banHandler.js': 'export const checkBan = () => null;',
  './radioCleaner.js': 'export const TEMP_RADIO_DIR = process.env.YUI_TEST_RADIO_DIR; export function cleanTempRadioAudio() {}',
  '../handlers/youtubeAudioHandler.js': "export async function downloadAudio() { throw new Error('dublê: sem download real'); }",
  './radioDatabase.js': 'export function getSession() { return null; }',
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, `data:text/javascript,${encodeURIComponent(v)}`]));
const hooks = `
let stubs = {};
export function initialize(data) { stubs = data.stubs; }
export function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) return { url: stubs[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { parentURL: import.meta.url, data: { stubs: stubUrls } });

const svc = await import(pathToFileURL(path.join(root, 'src/services/deezerMusicService.js')).href);
const handler = await import(pathToFileURL(path.join(root, 'src/handlers/deezerMusicHandler.js')).href);
const media = await import(pathToFileURL(path.join(root, 'src/utils/mediaUrls.js')).href);
const axiosMod = (await import('axios')).default; // trocado por dublê nos testes de busca: nada sai para a rede
const radio = await import(pathToFileURL(path.join(root, 'src/music/radioProviders.js')).href);
const { DEEZER_ERROR_CODES: CODE } = svc;

// ---- mini framework ----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✘ FALHA: ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function skip(name, why) {
  console.log(`  - pulado: ${name} (${why})`);
}

let dirCounter = 0;
function newDir(label = 'd') {
  const dir = path.join(tmp, `${label}-${++dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** execFile falso: `handler({ file, args, options })` devolve { stdout, stderr, error }. */
function fakeExecFile(handler) {
  const calls = [];
  const fn = (file, args, options, cb) => {
    calls.push({ file, args, options });
    Promise.resolve(handler({ file, args, options, calls }))
      .then((r = {}) => cb(r.error || null, r.stdout || '', r.stderr || ''))
      .catch((e) => cb(e, '', ''));
  };
  fn.calls = calls;
  return fn;
}
function exitError(code, extra = {}) {
  return Object.assign(new Error('Command failed: python download_deezer.py ...'), { code, killed: false, signal: null, ...extra });
}
const LEAK_RE = new RegExp(`${ARL}|Traceback|Command failed|D:\\\\|[A-Za-z]:\\\\|download_deezer\\.py`);
function assertNoLeak(text, label) {
  assert.ok(!LEAK_RE.test(String(text)), `${label} vazou dado interno: ${String(text).slice(0, 200)}`);
}
function writeFile(file, content = 'x'.repeat(2048)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// ================================================================================================
console.log('classifyDeezerError');
await test('ModuleNotFoundError e "No module named" => DEEMIX_NOT_INSTALLED', () => {
  assert.equal(svc.classifyDeezerError("Traceback...\nModuleNotFoundError: No module named 'deezer'", 1, false), CODE.NOT_INSTALLED);
  assert.equal(svc.classifyDeezerError("ImportError: No module named 'deemix'", 1, false), CODE.NOT_INSTALLED);
  assert.equal(svc.classifyDeezerError('', 2, false), CODE.NOT_INSTALLED);
  assert.equal(svc.classifyDeezerError('', 'ENOENT', false), CODE.NOT_INSTALLED); // python inexistente
});
await test('código de login (3) e marcador do script => DEEZER_LOGIN', () => {
  assert.equal(svc.classifyDeezerError('', 3, false), CODE.LOGIN);
  assert.equal(svc.classifyDeezerError('YUI_DEEZER_LOGIN_FAILED: ARL invalido ou expirado', 1, false), CODE.LOGIN);
});
await test('processo morto por tempo => DEEZER_TIMEOUT (tem prioridade)', () => {
  assert.equal(svc.classifyDeezerError('', null, true), CODE.TIMEOUT);
  assert.equal(svc.classifyDeezerError('ModuleNotFoundError', null, 'SIGTERM'), CODE.TIMEOUT);
  assert.equal(svc.classifyDeezerError('', 'ETIMEDOUT', false), CODE.TIMEOUT);
});
await test('qualquer outro caso => DEEZER_ERROR', () => {
  assert.equal(svc.classifyDeezerError('algo estranho', 1, false), CODE.ERROR);
  assert.equal(svc.classifyDeezerError(undefined, undefined, undefined), CODE.ERROR);
  assert.equal(svc.classifyDeezerError('YUI_DEEZER_ERROR: notAvailable', 4, false), CODE.ERROR);
});

console.log('Utilidades puras');
await test('maskSecrets esconde o ARL, variáveis e tokens longos', () => {
  const text = `x DEEZER_ARL=${ARL} y arl: ${ARL.slice(0, 40)}zzzzzzzzzzzz ${'Q'.repeat(80)} fim`;
  const masked = svc.maskSecrets(text, [ARL]);
  assert.ok(!masked.includes(ARL) && !masked.includes('QQQQQQQQQQ'), masked);
  assert.ok(masked.includes('***'));
  assert.equal(svc.maskSecrets('mensagem normal'), 'mensagem normal');
});
await test('normalizeDeezerTrackLink aceita só faixa e devolve o link canônico', () => {
  const ok = 'https://www.deezer.com/track/3135556';
  assert.equal(svc.normalizeDeezerTrackLink('3135556'), ok);
  assert.equal(svc.normalizeDeezerTrackLink(3135556), ok);
  assert.equal(svc.normalizeDeezerTrackLink('https://www.deezer.com/track/3135556'), ok);
  assert.equal(svc.normalizeDeezerTrackLink('https://deezer.com/br/track/3135556?utm_source=x&a=b'), ok);
  assert.equal(svc.normalizeDeezerTrackLink('https://www.deezer.com/pt-br/track/3135556/'), ok);
  for (const bad of [
    'https://www.deezer.com/album/302127',
    'https://www.deezer.com/playlist/908622995',
    'https://www.deezer.com/artist/27',
    'https://evil.com/track/1',
    'https://www.deezer.com.evil.com/track/1',
    'https://user:pw@www.deezer.com/track/1',
    'https://www.deezer.com/track/1"&calc&"',
    'https://www.deezer.com/track/1 --extra',
    'javascript:alert(1)',
    '',
    null,
    '12abc',
  ]) assert.equal(svc.normalizeDeezerTrackLink(bad), null, `deveria recusar: ${bad}`);
});
await test('buildDeezerEnv: ARL e UTF-8 no ambiente; segredos do bot ficam de fora', () => {
  const env = svc.buildDeezerEnv(ARL);
  assert.equal(env.DEEZER_ARL, ARL);
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.DEEMIX_ARL, undefined);
  assert.ok(env.PATH || env.Path, 'PATH precisa continuar disponível');
});
await test('timeout padrão 180 s e configurável por YUI_DEEZER_TIMEOUT_S', () => {
  assert.equal(svc.getDeezerTimeoutMs({}), 180000);
  assert.equal(svc.getDeezerTimeoutMs({ YUI_DEEZER_TIMEOUT_S: '45' }), 45000);
  assert.equal(svc.getDeezerTimeoutMs({ YUI_DEEZER_TIMEOUT_S: 'abc' }), 180000);
  assert.equal(svc.getDeezerTimeoutMs({ YUI_DEEZER_TIMEOUT_S: '1' }), 180000);
  assert.equal(svc.getDeezerTimeoutMs({ YUI_DEEZER_TIMEOUT_S: '99999' }), 180000);
});
await test('getPythonBin usa PYTHON_PATH (sem aspas) ou o padrão do sistema', () => {
  assert.equal(svc.getPythonBin({ PYTHON_PATH: '"D:\\x\\python.exe"' }), 'D:\\x\\python.exe');
  assert.equal(svc.getPythonBin({}), process.platform === 'win32' ? 'python' : 'python3');
});

// ================================================================================================
console.log('downloadDeezerTrack (execFile injetado)');
await test('execFile com array: o ARL fica só no ambiente, nunca nos argumentos', async () => {
  const outDir = newDir('out');
  const fake = fakeExecFile(({ args }) => {
    const file = writeFile(path.join(args[2], 'Artista - Título.mp3'));
    return { stdout: `DOWNLOADED_FILE:${file}\n` };
  });
  const file = await svc.downloadDeezerTrack('3135556', { pythonBin: 'python-falso', scriptPath: 'script-falso.py', outDir, arl: ARL, execFileImpl: fake });
  const call = fake.calls[0];
  assert.equal(call.file, 'python-falso');
  assert.ok(Array.isArray(call.args) && call.args.length === 3);
  assert.equal(call.args[0], 'script-falso.py');
  assert.equal(call.args[1], 'https://www.deezer.com/track/3135556');
  for (const arg of call.args) assert.ok(!String(arg).includes(ARL), 'ARL em argumento');
  assert.equal(call.options.env.DEEZER_ARL, ARL);
  assert.equal(call.options.env.PYTHONUTF8, '1');
  assert.equal(call.options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(call.options.env.DISCORD_TOKEN, undefined);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 180000);
  assert.ok(call.options.maxBuffer > 0);
  assert.ok(fs.existsSync(file));
  assert.equal(path.dirname(path.dirname(file)), outDir, 'arquivo numa subpasta direta de outDir');
  assert.match(path.basename(path.dirname(file)), /^[0-9a-f-]{36}$/);
  assert.equal(path.dirname(file), call.args[2]);
});
await test('subpasta única por pedido e limpeza com cleanupDeezerDir', async () => {
  const outDir = newDir('out');
  const fake = fakeExecFile(({ args }) => ({ stdout: `DOWNLOADED_FILE:${writeFile(path.join(args[2], 'a.mp3'))}\n` }));
  const a = await svc.downloadDeezerTrack('1', { outDir, arl: ARL, execFileImpl: fake });
  const b = await svc.downloadDeezerTrack('1', { outDir, arl: ARL, execFileImpl: fake });
  assert.notEqual(path.dirname(a), path.dirname(b));
  assert.equal(listDir(outDir).length, 2);
  assert.equal(svc.cleanupDeezerDir(a, { baseDir: outDir }), true);
  assert.equal(fs.existsSync(path.dirname(a)), false);
  assert.equal(fs.existsSync(path.dirname(b)), true);
  assert.equal(svc.cleanupDeezerDir(path.dirname(b), { baseDir: outDir }), true); // aceita a própria pasta
  assert.equal(listDir(outDir).length, 0);
});
await test('sem DOWNLOADED_FILE e sem erro: aceita áudio DENTRO da subpasta do pedido', async () => {
  const outDir = newDir('out');
  const fake = fakeExecFile(({ args }) => { writeFile(path.join(args[2], 'faixa.flac')); return { stdout: '' }; });
  const file = await svc.downloadDeezerTrack('2', { outDir, arl: ARL, execFileImpl: fake });
  assert.equal(path.basename(file), 'faixa.flac');
  assert.equal(path.dirname(path.dirname(file)), outDir);
});
await test('NÃO existe fallback para "mp3 mais recente": arquivo alheio nunca é devolvido', async () => {
  const outDir = newDir('out');
  const alheio = writeFile(path.join(outDir, 'musica-de-outro-usuario.mp3'));
  const alheioSub = writeFile(path.join(outDir, '11111111-2222-3333-4444-555555555555', 'outra.mp3'));
  const fake = fakeExecFile(() => ({ error: exitError(1), stderr: "ModuleNotFoundError: No module named 'deezer'" }));
  await assert.rejects(svc.downloadDeezerTrack('3', { outDir, arl: ARL, execFileImpl: fake }), (e) => e.code === CODE.NOT_INSTALLED);
  assert.ok(fs.existsSync(alheio), 'arquivo alheio não pode ser tocado');
  assert.ok(fs.existsSync(alheioSub), 'pasta alheia (jovem) não pode ser tocada');
  assert.equal(listDir(outDir).length, 2, 'a subpasta do pedido falho deve ter sido removida');
});
await test('caminho impresso fora da subpasta do pedido é recusado', async () => {
  const outDir = newDir('out');
  const alheio = writeFile(path.join(outDir, 'alheio.mp3'));
  const fake = fakeExecFile(() => ({ stdout: `DOWNLOADED_FILE:${alheio}\n` }));
  await assert.rejects(svc.downloadDeezerTrack('4', { outDir, arl: ARL, execFileImpl: fake }), (e) => e instanceof svc.DeezerDownloadError && e.code === CODE.ERROR);
  assert.ok(fs.existsSync(alheio));
  const traversal = fakeExecFile(({ args }) => ({ stdout: `DOWNLOADED_FILE:${path.join(args[2], '..', 'alheio.mp3')}\n` }));
  await assert.rejects(svc.downloadDeezerTrack('4', { outDir, arl: ARL, execFileImpl: traversal }), (e) => e.code === CODE.ERROR);
});
await test('erro do script depois de gerar o arquivo ainda entrega o arquivo impresso; sem caminho, não varre a pasta', async () => {
  const outDir = newDir('out');
  const printed = fakeExecFile(({ args }) => ({ error: exitError(1), stdout: `DOWNLOADED_FILE:${writeFile(path.join(args[2], 'p.mp3'))}\n` }));
  const file = await svc.downloadDeezerTrack('5', { outDir, arl: ARL, execFileImpl: printed });
  assert.equal(path.basename(file), 'p.mp3');
  const notPrinted = fakeExecFile(({ args }) => { writeFile(path.join(args[2], 'parcial.mp3')); return { error: exitError(1), stderr: 'boom' }; });
  await assert.rejects(svc.downloadDeezerTrack('5', { outDir, arl: ARL, execFileImpl: notPrinted }), (e) => e.code === CODE.ERROR);
});
await test('ModuleNotFoundError => DEEMIX_NOT_INSTALLED; mensagem e log sem ARL, sem caminho, sem traceback', async () => {
  const outDir = newDir('out');
  const stderr = `Traceback (most recent call last):\n  File "D:\\Projetos\\Yui\\src\\services\\download_deezer.py", line 3, in <module>\n    from deezer import Deezer\nModuleNotFoundError: No module named 'deezer'\nDEEZER_ARL=${ARL}`;
  const fake = fakeExecFile(() => ({ error: exitError(1, { cmd: `python download_deezer.py link out ${ARL}` }), stderr }));
  logs.length = 0;
  let caught;
  try {
    await svc.downloadDeezerTrack('3135556', { outDir, arl: ARL, execFileImpl: fake });
  } catch (e) { caught = e; }
  assert.ok(caught, 'deveria rejeitar');
  assert.ok(caught instanceof svc.DeezerDownloadError);
  assert.equal(caught.code, 'DEEMIX_NOT_INSTALLED');
  assertNoLeak(caught.message, 'mensagem');
  assertNoLeak(caught.stack?.split('\n')[0], 'primeira linha da pilha');
  assert.equal(caught.message, 'O download de músicas por busca está indisponível no momento.');
  assert.ok(!media.mentionsOrigin(caught.message), 'a mensagem ao usuário não cita o serviço');
  const logText = logs.join('\n');
  assert.ok(logText.includes('DEEMIX_NOT_INSTALLED'), 'o detalhe técnico deve ir para o logger');
  assert.ok(!logText.includes(ARL), 'o ARL não pode aparecer no log');
  assert.ok(logText.includes('requirements-deemix.txt'), 'dica de instalação no log');
  assert.equal(listDir(outDir).length, 0, 'sem sobras');
});
await test('login (saída 3), timeout, sem ARL e link inválido', async () => {
  const outDir = newDir('out');
  const login = fakeExecFile(() => ({ error: exitError(3), stderr: 'YUI_DEEZER_LOGIN_FAILED: ARL invalido ou expirado' }));
  await assert.rejects(svc.downloadDeezerTrack('1', { outDir, arl: ARL, execFileImpl: login }), (e) => e.code === CODE.LOGIN && !LEAK_RE.test(e.message));
  const timeout = fakeExecFile(() => ({ error: exitError(null, { killed: true, signal: 'SIGTERM' }) }));
  await assert.rejects(svc.downloadDeezerTrack('1', { outDir, arl: ARL, execFileImpl: timeout, timeoutMs: 1234 }), (e) => e.code === CODE.TIMEOUT);
  assert.equal(timeout.calls[0].options.timeout, 1234);
  const never = fakeExecFile(() => ({}));
  await assert.rejects(svc.downloadDeezerTrack('1', { outDir, arl: '', execFileImpl: never }), (e) => e.code === CODE.LOGIN);
  await assert.rejects(svc.downloadDeezerTrack('https://www.deezer.com/album/1', { outDir, arl: ARL, execFileImpl: never }), (e) => e.code === CODE.ERROR);
  await assert.rejects(svc.downloadDeezerTrack('1" & calc & "', { outDir, arl: ARL, execFileImpl: never }), (e) => e.code === CODE.ERROR);
  assert.equal(never.calls.length, 0, 'não deve lançar processo sem ARL ou com link inválido');
  assert.equal(listDir(outDir).length, 0);
});
await test('o ARL de process.env é usado por padrão e não vai para os argumentos', async () => {
  const outDir = newDir('out');
  const fake = fakeExecFile(({ args }) => ({ stdout: `DOWNLOADED_FILE:${writeFile(path.join(args[2], 'x.mp3'))}\n` }));
  await svc.downloadDeezerTrack('7', { outDir, execFileImpl: fake });
  assert.equal(fake.calls[0].options.env.DEEZER_ARL, ARL);
  assert.ok(fake.calls[0].args.every((a) => !String(a).includes(ARL)));
});

console.log('downloadDeezerTrack (processo filho real: node + script falso)');
function writeFakeScript(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}
const okScript = writeFakeScript('fake-ok.cjs', `
const fs = require('fs'); const path = require('path');
const [, , link, out] = process.argv;
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ argv: process.argv, hasArl: process.env.DEEZER_ARL === ${JSON.stringify(ARL)}, token: process.env.DISCORD_TOKEN || null, utf8: process.env.PYTHONUTF8 }));
const file = path.join(out, 'Música – Canção ção.mp3');
fs.writeFileSync(file, Buffer.alloc(4096, 1));
process.stdout.write('ruído antes\\nDOWNLOADED_FILE:' + file + '\\n');
`);
await test('sucesso real: ARL só no ambiente, acentos preservados, nada vaza para o filho', async () => {
  const outDir = newDir('out');
  const file = await svc.downloadDeezerTrack('https://www.deezer.com/br/track/3135556', { pythonBin: process.execPath, scriptPath: okScript, outDir, timeoutMs: 20000 });
  assert.equal(path.basename(file), 'Música – Canção ção.mp3');
  assert.ok(fs.existsSync(file));
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'report.json'), 'utf8'));
  assert.equal(report.hasArl, true, 'o filho precisa enxergar o ARL em DEEZER_ARL');
  assert.equal(report.token, null, 'o filho não deve receber DISCORD_TOKEN');
  assert.equal(report.utf8, '1');
  assert.ok(report.argv.every((a) => !String(a).includes(ARL)), 'ARL na linha de comando do filho');
  assert.equal(report.argv[2], 'https://www.deezer.com/track/3135556');
  svc.cleanupTempAudio(file); // contrato antigo: apagar o arquivo; fora da pasta-base padrão só remove o arquivo
  assert.equal(fs.existsSync(file), false);
});
const missingScript = writeFakeScript('fake-missing.cjs', `
process.stderr.write("Traceback (most recent call last):\\n  File \\"D:\\\\Projetos\\\\Yui\\\\src\\\\services\\\\download_deezer.py\\", line 3\\nModuleNotFoundError: No module named 'deezer'\\n");
process.exit(1);
`);
const loginScript = writeFakeScript('fake-login.cjs', "process.stderr.write('YUI_DEEZER_LOGIN_FAILED: ARL invalido ou expirado\\n'); process.exit(3);");
const hangScript = writeFakeScript('fake-hang.cjs', 'setTimeout(() => {}, 15000);');
await test('real: módulo ausente => DEEMIX_NOT_INSTALLED sem vazar nada', async () => {
  const outDir = newDir('out');
  await assert.rejects(
    svc.downloadDeezerTrack('1', { pythonBin: process.execPath, scriptPath: missingScript, outDir, timeoutMs: 20000 }),
    (e) => e.code === CODE.NOT_INSTALLED && !LEAK_RE.test(e.message),
  );
  assert.equal(listDir(outDir).length, 0);
});
await test('real: saída 3 => DEEZER_LOGIN', async () => {
  const outDir = newDir('out');
  await assert.rejects(svc.downloadDeezerTrack('1', { pythonBin: process.execPath, scriptPath: loginScript, outDir, timeoutMs: 20000 }), (e) => e.code === CODE.LOGIN);
});
await test('real: estouro de tempo => DEEZER_TIMEOUT e o processo é encerrado', async () => {
  const outDir = newDir('out');
  const t0 = Date.now();
  await assert.rejects(svc.downloadDeezerTrack('1', { pythonBin: process.execPath, scriptPath: hangScript, outDir, timeoutMs: 600 }), (e) => e.code === CODE.TIMEOUT);
  assert.ok(Date.now() - t0 < 10000, 'deveria encerrar bem antes dos 15 s do script');
  assert.equal(listDir(outDir).length, 0);
});
await test('real: python inexistente => DEEMIX_NOT_INSTALLED', async () => {
  const outDir = newDir('out');
  await assert.rejects(
    svc.downloadDeezerTrack('1', { pythonBin: path.join(tmp, 'nao-existe', 'python.exe'), scriptPath: okScript, outDir }),
    (e) => e.code === CODE.NOT_INSTALLED && !LEAK_RE.test(e.message),
  );
});

console.log('Pastas por pedido');
await test('cleanupDeezerDir só apaga pasta UUID filha direta da base', () => {
  const base = newDir('base');
  const uuid = '8a1b2c3d-1111-4222-8333-444455556666';
  const inside = writeFile(path.join(base, uuid, 'a.mp3'));
  const other = writeFile(path.join(base, 'nao-uuid', 'a.mp3'));
  const nested = writeFile(path.join(base, 'x', uuid, 'a.mp3'));
  assert.equal(svc.cleanupDeezerDir(other, { baseDir: base }), false);
  assert.equal(svc.cleanupDeezerDir(nested, { baseDir: base }), false);
  assert.equal(svc.cleanupDeezerDir(base, { baseDir: base }), false);
  assert.equal(svc.cleanupDeezerDir('', { baseDir: base }), false);
  assert.ok(fs.existsSync(other) && fs.existsSync(nested));
  assert.equal(svc.cleanupDeezerDir(inside, { baseDir: base }), true);
  assert.equal(fs.existsSync(path.join(base, uuid)), false);
});
await test('sweepStaleDeezerDirs remove só pastas UUID antigas', () => {
  const base = newDir('sweep');
  const oldDir = path.join(base, '00000000-0000-4000-8000-000000000001');
  const youngDir = path.join(base, '00000000-0000-4000-8000-000000000002');
  const plain = path.join(base, 'qualquer-coisa');
  for (const d of [oldDir, youngDir, plain]) writeFile(path.join(d, 'a.mp3'));
  const past = new Date(Date.now() - 5 * 3600 * 1000);
  fs.utimesSync(oldDir, past, past);
  fs.utimesSync(plain, past, past);
  assert.equal(svc.sweepStaleDeezerDirs(base, { maxAgeMs: 3600 * 1000 }), 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.ok(fs.existsSync(youngDir) && fs.existsSync(plain));
});

// ================================================================================================
// Script Python real (download_deezer.py) com pacotes deezer/deemix FALSOS, se houver Python.
console.log('download_deezer.py (Python real, pacotes falsos, sem rede)');
const pythonBin = process.env.PYTHON_PATH || 'python';
let pythonOk = false;
try {
  pythonOk = execFileSync(pythonBin, ['-S', '-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim() === 'True';
} catch (_) { /* sem python */ }

if (!pythonOk) {
  skip('script Python', 'python não encontrado no PATH');
} else {
  const stubDir = path.join(tmp, 'pystubs');
  writeFile(path.join(stubDir, 'deezer', '__init__.py'), `
import os
class Deezer:
    def login_via_arl(self, arl, child=0):
        if os.environ.get('STUB_LOGIN_RAISES'):
            raise KeyError('USER')
        return arl.startswith('ARL_TESTE')
`);
  writeFile(path.join(stubDir, 'deemix', '__init__.py'), `
__version__ = '0.0.0-stub'
class _Obj:
    def __init__(self, link, bitrate):
        self.link = link; self.bitrate = bitrate; self.failed = 0; self.errors = []; self.files = []
def generateDownloadObject(dz, link, bitrate, plugins=None, listener=None):
    if link.endswith('/track/4'):
        raise ValueError('link nao reconhecido')
    return _Obj(link, bitrate)
`);
  writeFile(path.join(stubDir, 'deemix', 'settings.py'), `
def load(configFolder=None):
    return {'executeCommand': 'rm -rf /', 'saveArtwork': True, 'overwriteFile': 'n', 'maxBitrateFallback': True,
            'fallbackBitrate': False, 'tags': {'title': True, 'source': True},
            '_configFolder': str(configFolder) if configFolder else None}
`);
  writeFile(path.join(stubDir, 'deemix', 'downloader.py'), `
import json, os
class Downloader:
    def __init__(self, dz, obj, settings):
        self.obj = obj; self.settings = settings
    def start(self):
        out = self.settings['downloadLocation']
        with open(os.path.join(out, 'settings_dump.json'), 'w', encoding='utf-8') as f:
            json.dump(self.settings, f)
        link = self.obj.link
        if link.endswith('/track/2'):
            self.obj.failed = 1
            self.obj.errors = [{'errid': 'wrongLicense', 'message': "Your account can't stream the track at the desired bitrate."}]
            return
        if link.endswith('/track/3') and self.obj.bitrate == 3:
            self.obj.failed = 1
            self.obj.errors = [{'errid': 'wrongBitrate', 'message': 'x'}]
            return
        if link.endswith('/track/5'):
            return
        name = 'Música – Canção Ω %d.mp3' % self.obj.bitrate
        path = os.path.join(out, name)
        with open(path, 'wb') as f:
            f.write(b'ID3' + b'0' * 2048)
        if not link.endswith('/track/6'):
            self.obj.files.append({'path': path})
`);

  /** Roda o script real com python -S (sem site-packages) + pacotes falsos; força cp1252 para provar o reconfigure. */
  const withStubs = (extraEnv = {}, useStubs = true) => (file, args, options, cb) => {
    const env = { ...options.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '0', ...extraEnv };
    delete env.PYTHONIOENCODING;
    if (useStubs) env.PYTHONPATH = stubDir; else delete env.PYTHONPATH;
    return execFile(file, ['-S', ...args], { ...options, env }, cb);
  };
  const realScript = path.join(root, 'src/services/download_deezer.py');
  const run = (link, extra = {}, useStubs = true) => svc.downloadDeezerTrack(link, {
    pythonBin, scriptPath: realScript, outDir: newDir('py'), arl: ARL, timeoutMs: 30000, execFileImpl: withStubs(extra, useStubs),
  });
  const rawRun = (args, env = {}, useStubs = true) => new Promise((resolve) => {
    execFile(pythonBin, ['-S', realScript, ...args], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '0', ...(useStubs ? { PYTHONPATH: stubDir } : {}), ...env }, encoding: 'utf8', windowsHide: true, timeout: 30000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });

  await test('sintaxe do script e nenhuma chave inventada', () => {
    const src = fs.readFileSync(realScript, 'utf8');
    assert.ok(!src.includes('maxBitrateFallback'), 'a chave inexistente maxBitrateFallback não deve voltar');
    assert.ok(src.includes("settings['fallbackBitrate'] = True") && src.includes("settings['maxBitrate'] = '3'"));
    assert.ok(src.includes("os.environ.get('DEEZER_ARL')") && src.includes('--check') && src.includes('reconfigure(encoding'));
  });
  await test('--check: versões em JSON numa linha, saída 0; sem pacotes, saída 2', async () => {
    const ok = await rawRun(['--check']);
    assert.equal(ok.code, 0, ok.stderr);
    const lines = ok.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const info = JSON.parse(lines[0]);
    assert.equal(info.ok, true);
    assert.ok('deemix' in info && 'deezer-py' in info && info.python);
    const missing = await rawRun(['--check'], {}, false);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No module named/);
    assert.equal(JSON.parse(missing.stdout.trim()).ok, false);
  });
  await test('checkDeemix: ok com pacotes; DEEMIX_NOT_INSTALLED sem eles', async () => {
    const good = await svc.checkDeemix({ pythonBin, scriptPath: realScript, execFileImpl: withStubs(), log: false });
    assert.equal(good.ok, true);
    assert.match(good.message, /deemix/);
    const bad = await svc.checkDeemix({ pythonBin, scriptPath: realScript, execFileImpl: withStubs({}, false), log: false });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, CODE.NOT_INSTALLED);
  });
  await test('sem os pacotes: script sai com 2 e o serviço classifica DEEMIX_NOT_INSTALLED', async () => {
    await assert.rejects(run('3135556', {}, false), (e) => e.code === CODE.NOT_INSTALLED && !LEAK_RE.test(e.message));
  });
  await test('sucesso: uma linha DOWNLOADED_FILE, acentos íntegros mesmo com stdout em cp1252, ajustes do deemix', async () => {
    const file = await run('3135556');
    assert.equal(path.basename(file), 'Música – Canção Ω 3.mp3');
    const dump = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'settings_dump.json'), 'utf8'));
    assert.equal(dump.maxBitrate, '3');
    assert.equal(dump.fallbackBitrate, true);
    assert.equal(dump.saveArtwork, false);
    assert.equal(dump.executeCommand, '');
    assert.equal(dump.tags.source, false, 'a tag SOURCE/SOURCEID do deemix fica desligada: o arquivo não diz de onde veio');
    assert.equal(dump.tags.title, true, 'as demais tags continuam');
    assert.equal(dump.overwriteFile, 'y');
    assert.equal(dump.downloadLocation, path.dirname(file));
    assert.equal(dump.createAlbumFolder, false);
    assert.equal(dump._configFolder, null);
    const raw = await rawRun(['https://www.deezer.com/track/3135556', newDir('raw')], { DEEZER_ARL: ARL });
    assert.equal(raw.code, 0, raw.stderr);
    assert.equal(raw.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('DOWNLOADED_FILE:')).length, 1);
    assert.ok(raw.stdout.includes('Música – Canção Ω 3.mp3'), 'acentos corrompidos na saída do Python');
  });
  await test('YUI_DEEMIX_CONFIG_DIR é repassado ao deemix', async () => {
    const cfg = newDir('cfg');
    const file = await run('3135556', { YUI_DEEMIX_CONFIG_DIR: cfg });
    const dump = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'settings_dump.json'), 'utf8'));
    assert.equal(dump._configFolder, cfg);
  });
  await test('primeiro passe falha, segundo passe (128 kbps) entrega', async () => {
    const file = await run('https://www.deezer.com/track/3');
    assert.equal(path.basename(file), 'Música – Canção Ω 1.mp3');
  });
  await test('arquivo existe mas o deemix não o listou: acha na pasta do próprio pedido', async () => {
    const file = await run('https://www.deezer.com/track/6');
    assert.equal(path.basename(file), 'Música – Canção Ω 3.mp3');
  });
  await test('conta sem licença => saída 3 (DEEZER_LOGIN); sem arquivo => erro; exceção => erro, tudo sem vazamento', async () => {
    await assert.rejects(run('https://www.deezer.com/track/2'), (e) => e.code === CODE.LOGIN && !LEAK_RE.test(e.message));
    await assert.rejects(run('https://www.deezer.com/track/5'), (e) => e.code === CODE.ERROR && !LEAK_RE.test(e.message));
    await assert.rejects(run('https://www.deezer.com/track/4'), (e) => e.code === CODE.ERROR);
  });
  await test('ARL ausente/ inválido => saída 3 e o ARL nunca é impresso', async () => {
    const noArl = await rawRun(['https://www.deezer.com/track/1', newDir('raw')], { DEEZER_ARL: '', DEEMIX_ARL: '' });
    assert.equal(noArl.code, 3);
    const bad = await rawRun(['https://www.deezer.com/track/1', newDir('raw')], { DEEZER_ARL: 'invalido-xyz' });
    assert.equal(bad.code, 3);
    assert.ok(!bad.stdout.includes('invalido-xyz') && !bad.stderr.includes('invalido-xyz'));
    const raises = await rawRun(['https://www.deezer.com/track/1', newDir('raw')], { DEEZER_ARL: ARL, STUB_LOGIN_RAISES: '1' });
    assert.equal(raises.code, 3);
    const legacy = await rawRun(['https://www.deezer.com/track/1', newDir('raw'), ARL], { DEEZER_ARL: '', DEEMIX_ARL: '' });
    assert.equal(legacy.code, 0, 'argv[3] continua valendo como alternativa legada');
  });
  await test('uso incorreto => saída 64', async () => {
    assert.equal((await rawRun([])).code, 64);
  });
}

// ================================================================================================
console.log('Plano B (deezerMusicHandler)');
const track = { id: 3135556, title: 'Canção "Teste"', artist: 'Artista & Cia', album: 'Álbum', duration: 200, link: 'https://www.deezer.com/track/3135556' };
await test('buildYoutubeFallbackArgs: array sem shell, ytsearch1: é UM único argumento', () => {
  const dir = path.join(tmp, 'req');
  const args = handler.buildYoutubeFallbackArgs(track, dir, { cookiesPath: '', extraFlags: ['--ignore-config'], ffmpegPath: '' });
  assert.ok(Array.isArray(args));
  for (const flag of ['-x', '--audio-format', 'mp3', '--no-playlist', '--print-json']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
  assert.equal(args[args.length - 1], 'ytsearch1:Artista & Cia - Canção "Teste"');
  assert.equal(args.filter((a) => a.startsWith('ytsearch')).length, 1);
  assert.equal(args[args.indexOf('-o') + 1], path.join(dir, '%(id)s.%(ext)s'));
  assert.equal(args[args.indexOf('--match-filter') + 1], 'duration<=490');
  assert.ok(args.includes('--ignore-config'));
  // nenhuma aspa foi ACRESCENTADA pelo montador: só as que já fazem parte do título
  assert.ok(args.slice(0, -1).every((a) => !/^["']|["']$/.test(a)));
});
await test('consulta do plano B: remove controle/quebra de linha, limita o tamanho, aceita cookies e ffmpeg', () => {
  const evil = { title: 'Linha1\r\nLinha2\u0000fim', artist: 'A'.repeat(500), duration: 0 };
  const q = handler.buildYoutubeSearchQuery(evil);
  assert.ok(!/[\u0000-\u001f]/.test(q) && q.length <= 200);
  const args = handler.buildYoutubeFallbackArgs(evil, tmp, { cookiesPath: 'C:\\c.txt', ffmpegPath: 'C:\\f.exe' });
  assert.equal(args[args.indexOf('--cookies') + 1], 'C:\\c.txt');
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], 'C:\\f.exe');
  assert.equal(args[args.indexOf('--match-filter') + 1], 'duration<=900');
  assert.throws(() => handler.buildYoutubeFallbackArgs({ title: '', artist: '' }, tmp));
});
await test('Deezer funciona: não aciona o plano B', async () => {
  let ytCalls = 0;
  const file = writeFile(path.join(newDir('ok'), 'a.mp3'));
  const result = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async (ref) => { assert.equal(ref, 3135556); return file; },
    downloadFromYoutube: async () => { ytCalls++; throw new Error('não deveria'); },
  });
  assert.equal(result.success, true);
  assert.equal(result.fallback, undefined);
  assert.equal(result.filePath, file);
  assert.equal(ytCalls, 0);
});
for (const reason of [CODE.NOT_INSTALLED, CODE.LOGIN, CODE.TIMEOUT, CODE.ERROR]) {
  await test(`deemix falha (${reason}): plano B entrega a mesma faixa com aviso neutro de qualidade`, async () => {
    const ytFile = writeFile(path.join(newDir('yt'), 'dQw4w9WgXcQ.mp3'));
    const result = await handler.executeDownloadAndPackage(track, {
      downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(reason); },
      downloadFromYoutube: async (t) => { assert.equal(t.id, track.id); return { filePath: ytFile, youtubeTitle: 'Artista - Canção (Official)' }; },
    });
    assert.equal(result.success, true);
    assert.equal(result.fallback.source, 'youtube'); // dado interno (logs): não aparece em nenhum texto entregue
    assert.equal(result.fallback.reason, reason);
    assert.equal(result.notice, '⚠️ Aviso: a qualidade desta faixa pode ser menor que a original.');
    assert.ok(!media.mentionsOrigin(result.notice), result.notice);
    assert.equal(result.track.artist, track.artist, 'artista sem sufixo de origem');
    assert.equal(result.track.title, track.title);
    assert.equal(result.originalTrack, track);
    assert.equal(result.attachment.name, 'Canção Teste.mp3', 'nome do arquivo sem sufixo de origem');
    assert.equal(result.filePath, ytFile);
    result.cleanup();
    assert.equal(fs.existsSync(ytFile), false);
  });
}
await test('as duas fontes falham: erro amigável, sem comando, caminho, traceback ou ARL', async () => {
  const leaky = new Error(`Command failed: python D:\\Projetos\\Yui\\src\\services\\download_deezer.py link out ${ARL}\nTraceback...`);
  const result = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => { throw leaky; },
    downloadFromYoutube: async () => { throw new Error('yt-dlp sem resultado: saída 1'); },
  });
  assert.ok(result.error && !result.success);
  assertNoLeak(result.error, 'erro final');
  assert.equal(result.error, 'Erro ao baixar a música: Não consegui baixar essa faixa.');
  assert.ok(!media.mentionsOrigin(result.error), result.error);
  const typed = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.NOT_INSTALLED); },
    downloadFromYoutube: async () => { throw new Error('x'); },
  });
  assert.equal(typed.error, 'Erro ao baixar a música: O download de músicas por busca está indisponível no momento.');
  assert.ok(!media.mentionsOrigin(typed.error), typed.error);
  const logText = logs.join('\n');
  assert.ok(!logText.includes(ARL), 'o ARL não pode ir para o log do plano B');
});
await test('downloadFromYoutubeFallback: execFile com array, cwd e saída dentro da subpasta do pedido', async () => {
  const baseDir = newDir('ytbase');
  const fake = fakeExecFile(({ args, options }) => {
    const out = path.dirname(args[args.indexOf('-o') + 1]);
    assert.equal(options.cwd, out);
    writeFile(path.join(out, 'dQw4w9WgXcQ.mp3'));
    return { stdout: `${JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Título do vídeo ao vivo' })}\n` };
  });
  const res = await handler.downloadFromYoutubeFallback(track, { execFileImpl: fake, baseDir, cookiesPath: '', ffmpegPath: '', ytdlpPath: 'yt-dlp-falso', extraFlags: [] });
  assert.equal(res.youtubeTitle, 'Título do vídeo ao vivo');
  assert.equal(path.dirname(path.dirname(res.filePath)), baseDir);
  const call = fake.calls[0];
  assert.equal(call.file, 'yt-dlp-falso');
  assert.ok(Array.isArray(call.args));
  assert.equal(call.args[call.args.length - 1], 'ytsearch1:Artista & Cia - Canção "Teste"');
  assert.equal(call.options.windowsHide, true);
  assert.ok(call.options.timeout > 0);
});
await test('downloadFromYoutubeFallback: sem arquivo => rejeita e remove a subpasta', async () => {
  const baseDir = newDir('ytbase');
  const fake = fakeExecFile(() => ({ error: exitError(1) }));
  await assert.rejects(handler.downloadFromYoutubeFallback(track, { execFileImpl: fake, baseDir, cookiesPath: '', ffmpegPath: '', extraFlags: [] }), /yt-dlp sem resultado/);
  assert.equal(listDir(baseDir).length, 0);
});

// ================================================================================================
console.log('Textos neutros, consulta limitada e ajuste ao limite de upload (TG-02 / TG-21)');
await test('mensagens ao usuário são NEUTRAS (sem Deezer/YouTube/deemix); as do dono (painel) continuam citando o serviço', async () => {
  for (const [code, text] of Object.entries(svc.DEEZER_USER_MESSAGES)) {
    assert.ok(!media.mentionsOrigin(text), `${code}: ${text}`);
    assert.ok(text.length > 10 && text.length < 160, code);
  }
  assert.deepEqual(Object.keys(svc.DEEZER_OWNER_MESSAGES).sort(), Object.keys(svc.DEEZER_USER_MESSAGES).sort());
  assert.match(svc.DEEZER_OWNER_MESSAGES[CODE.LOGIN], /Deezer/);
  assert.ok(Object.isFrozen(svc.DEEZER_USER_MESSAGES) && Object.isFrozen(svc.DEEZER_OWNER_MESSAGES));
  for (const code of Object.values(CODE)) assert.ok(!media.mentionsOrigin(new svc.DeezerDownloadError(code).message), code);
  // o painel do dono (checkDeemix) usa o texto do dono, que nomeia o serviço
  const missing = fakeExecFile(() => ({ error: exitError('ENOENT') }));
  const status = await svc.checkDeemix({ pythonBin: 'python-falso', scriptPath: 'x.py', execFileImpl: missing, log: false });
  assert.equal(status.ok, false);
  assert.equal(status.code, CODE.NOT_INSTALLED);
  assert.equal(status.message, svc.DEEZER_OWNER_MESSAGES[CODE.NOT_INSTALLED]);
  assert.match(status.message, /Deezer/);
});

await test('normalizeSearchQuery: sem controle, espaços colapsados, no máximo 150 caracteres e sem partir emoji', () => {
  assert.equal(svc.MAX_SEARCH_QUERY_CHARS, 150);
  assert.equal(svc.normalizeSearchQuery('  Linkin\tPark \r\n  Numb  '), 'Linkin Park Numb');
  assert.equal(svc.normalizeSearchQuery(null), '');
  assert.equal(svc.normalizeSearchQuery(undefined), '');
  assert.equal(svc.normalizeSearchQuery(12345), '12345');
  const long = svc.normalizeSearchQuery('palavra '.repeat(1000));
  assert.ok(long.length <= 150, `tamanho ${long.length}`);
  const emoji = svc.normalizeSearchQuery('a'.repeat(149) + '😀😀');
  assert.ok(emoji.length <= 150);
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji), 'não termina em meio par substituto');
  assert.equal(svc.normalizeSearchQuery('x'.repeat(150)), 'x'.repeat(150));
});

await test('searchDeezerTracks: a consulta vai limitada a 150 caracteres (axios trocado por dublê, sem rede); consulta vazia nem chama', async () => {
  const original = axiosMod.get;
  const urls = [];
  axiosMod.get = async (url) => {
    urls.push(url);
    return { data: { data: [{ id: 1, title: 'Numb', artist: { name: 'Linkin Park' }, album: { title: 'MT', cover_medium: 'https://exemplo.invalid/c.jpg' }, duration: 185, link: 'https://www.deezer.com/track/1' }] } };
  };
  try {
    const found = await svc.searchDeezerTracks('x'.repeat(6000));
    assert.equal(found.length, 1);
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]).searchParams.get('q').length, 150);
    assert.ok(urls[0].length < 400, `URL com ${urls[0].length} caracteres`);
    assert.deepEqual(await svc.searchDeezerTracks('   '), []);
    assert.equal(urls.length, 1, 'consulta vazia não chama o serviço');
  } finally {
    axiosMod.get = original;
  }
});

await test('handleMusicSearchAndDownload: consulta cortada em 150, lista de escolha sem citar a origem e títulos longos cortados', async () => {
  const original = axiosMod.get;
  const urls = [];
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: 100 + i,
    title: `Título ${i} ${'T'.repeat(400)}`,
    artist: { name: `Artista ${'A'.repeat(400)}` },
    album: { title: 'Álbum', cover_medium: 'https://exemplo.invalid/c.jpg' },
    duration: 200 + i,
    link: `https://www.deezer.com/track/${100 + i}`,
  }));
  axiosMod.get = async (url) => { urls.push(url); return { data: { data: items } }; };
  try {
    const result = await handler.handleMusicSearchAndDownload('zzz '.repeat(2000), null, { userId: 'u-lista', guildId: 'g1' });
    assert.equal(result.isAmbiguous, true);
    assert.ok(new URL(urls[0]).searchParams.get('q').length <= 150);
    const json = result.embed.toJSON();
    assert.equal(json.footer.text, 'Sistema de Áudio HQ');
    assert.equal(json.fields.length, 3);
    for (const field of json.fields) {
      assert.ok(field.name.length <= 256, `nome do campo com ${field.name.length}`);
      assert.ok(field.value.length <= 1024, `valor do campo com ${field.value.length}`);
    }
    const menu = result.components[0].toJSON().components[0];
    assert.equal(menu.options.length, 3);
    for (const option of menu.options) {
      assert.ok(option.label.length <= 100 && option.description.length <= 100);
    }
    const everything = JSON.stringify(json) + result.textList + JSON.stringify(result.components.map((c) => c.toJSON()));
    assert.ok(!media.mentionsOrigin(everything), 'a lista de escolha não cita a origem');

    // sem resultados: o eco da consulta vai cortado e sem controle
    axiosMod.get = async () => ({ data: { data: [] } });
    const vazio = await handler.handleMusicSearchAndDownload('q'.repeat(3000), null, { userId: 'u-vazio' });
    assert.match(vazio.error, /^Nenhuma música encontrada no catálogo para "/);
    assert.ok(vazio.error.length < 200, `eco com ${vazio.error.length} caracteres`);
    assert.ok(!media.mentionsOrigin(vazio.error), vazio.error);
  } finally {
    axiosMod.get = original;
    handler.clearSession('u-lista');
  }
});

/** ffmpeg falso: a sonda (-i sem saída) não informa duração; cada bitrate grava um arquivo do tamanho combinado. */
function fakeFfmpegExec(sizes) {
  return fakeExecFile(({ args }) => {
    if (!args.includes('-b:a')) return { error: exitError(1), stderr: 'Input #0, mp3, from x.mp3:\n  Duration: N/A, start: 0.000000' };
    const kbps = Number(args[args.indexOf('-b:a') + 1].replace('k', ''));
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(sizes[kbps] ?? 100, 1));
    return {};
  });
}
const encodesOf = (fake) => fake.calls.filter((c) => c.args.includes('-b:a')).map((c) => c.args[c.args.indexOf('-b:a') + 1]);
/** Cabeçalho ID3v2.3 com os frames dados ([id, bytes]) + áudio falso. */
function id3v23(frames, audio = Buffer.alloc(64, 7)) {
  const body = Buffer.concat(frames.map(([id, data]) => {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(data.length, 4);
    return Buffer.concat([head, data]);
  }));
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f]);
  return Buffer.concat([header, body, audio]);
}

await test('Deezer acima do limite de upload: recomprime (192 -> 128) e entrega o arquivo menor', async () => {
  const dz = writeFile(path.join(newDir('big'), 'grande.mp3'), 'x'.repeat(30000));
  const ff = fakeFfmpegExec({ 192: 12000, 128: 8000, 96: 6000 });
  const result = await handler.executeDownloadAndPackage({ ...track, duration: undefined }, {
    downloadDeezerTrack: async () => dz,
    downloadFromYoutube: async () => { throw new Error('não deveria'); },
    execFileImpl: ff, ffmpegPath: 'ffmpeg-falso',
    audioFit: { limitBytes: 10000 },
  });
  assert.equal(result.success, true);
  assert.equal(result.fallback, undefined);
  assert.equal(fs.statSync(dz).size, 8000);
  assert.deepEqual(encodesOf(ff), ['192k', '128k'], 'para no primeiro degrau que cabe');
  for (const call of ff.calls) {
    assert.equal(call.file, 'ffmpeg-falso');
    assert.ok(Array.isArray(call.args));
    assert.equal(call.options.windowsHide, true);
  }
  assert.equal(listDir(path.dirname(dz)).filter((n) => n.endsWith('.part')).length, 0, 'sem temporários do ajuste');
  result.cleanup();
  assert.equal(fs.existsSync(dz), false);
});

await test('plano B acima do limite também é recomprimido (a faixa entregue cabe)', async () => {
  const yt = writeFile(path.join(newDir('bigyt'), 'yt.mp3'), 'x'.repeat(30000));
  const ff = fakeFfmpegExec({ 192: 9000 });
  const result = await handler.executeDownloadAndPackage({ ...track, duration: undefined }, {
    downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.ERROR); },
    downloadFromYoutube: async () => ({ filePath: yt, youtubeTitle: 'x' }),
    execFileImpl: ff, ffmpegPath: 'ffmpeg-falso',
    audioFit: { limitBytes: 10000 },
  });
  assert.equal(result.success, true);
  assert.ok(result.fallback);
  assert.equal(fs.statSync(yt).size, 9000);
  result.cleanup();
});

await test('Deezer: nada cabe no limite (ou recompressão desligada): erro claro, sem plano B e sem sobras', async () => {
  const dz = writeFile(path.join(newDir('big2'), 'grande.mp3'), 'x'.repeat(30000));
  const ff = fakeFfmpegExec({ 192: 12000, 128: 11000, 96: 10500 });
  const r1 = await handler.executeDownloadAndPackage({ ...track, duration: undefined }, {
    downloadDeezerTrack: async () => dz,
    downloadFromYoutube: async () => { throw new Error('o plano B não resolve tamanho'); },
    execFileImpl: ff, ffmpegPath: 'ffmpeg-falso',
    audioFit: { limitBytes: 10000 },
  });
  assert.ok(r1.error && !r1.success);
  assert.match(r1.error, /limite de envio do Discord/);
  assert.ok(!media.mentionsOrigin(r1.error), r1.error);
  assert.deepEqual(encodesOf(ff), ['192k', '128k', '96k']);
  assert.equal(fs.existsSync(dz), false, 'o arquivo grande foi apagado');

  const dz2 = writeFile(path.join(newDir('big3'), 'grande.mp3'), 'x'.repeat(30000));
  const ff2 = fakeFfmpegExec({});
  const r2 = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => dz2,
    execFileImpl: ff2, ffmpegPath: 'ffmpeg-falso',
    audioFit: { limitBytes: 10000 },
    env: { YUI_AUDIO_REENCODE: 'false' },
  });
  assert.match(r2.error, /passou do limite de envio/);
  assert.equal(ff2.calls.length, 0, 'recompressão desligada: nenhum ffmpeg');
  assert.equal(fs.existsSync(dz2), false);
});

await test('a faixa entregue sai sem as tags de URL e de comentário, mas com título e artista', async () => {
  const mp3 = id3v23([
    ['TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('Canção')])],
    ['TPE1', Buffer.concat([Buffer.from([0]), Buffer.from('Artista')])],
    ['WOAS', Buffer.from('https://exemplo.invalid/origem')],
    ['COMM', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), Buffer.from('baixado de algum lugar')])],
  ]);
  const file = path.join(newDir('tags'), 'faixa.mp3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, mp3);
  const result = await handler.executeDownloadAndPackage(track, { downloadDeezerTrack: async () => file });
  assert.equal(result.success, true);
  const out = fs.readFileSync(file);
  const text = out.toString('latin1');
  assert.ok(text.includes('TIT2') && text.includes('Can'), 'título preservado');
  assert.ok(text.includes('TPE1') && text.includes('Artista'), 'artista preservado');
  assert.ok(!text.includes('WOAS') && !text.includes('COMM') && !text.includes('exemplo.invalid'), 'URL e comentário removidos');
  assert.ok(out.length < mp3.length);
  assert.deepEqual([...out.subarray(out.length - 64)], new Array(64).fill(7), 'o áudio não foi tocado');
  result.cleanup();
});

await test('TG-21: nada do que o plano B e o Deezer ENTREGAM ao usuário cita a origem', async () => {
  const yt = writeFile(path.join(newDir('swp'), 'yt.mp3'));
  const planB = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.LOGIN); },
    downloadFromYoutube: async () => ({ filePath: yt, youtubeTitle: 'Artista - Canção (Official) [YouTube]' }),
  });
  const direto = await handler.executeDownloadAndPackage(track, { downloadDeezerTrack: async () => writeFile(path.join(newDir('swp2'), 'a.mp3')) });
  const falha = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.TIMEOUT); },
    downloadFromYoutube: async () => { throw new Error('yt-dlp sem resultado'); },
  });
  const texts = [
    planB.notice, planB.attachment.name, planB.track.title, planB.track.artist, media.formatDeezerDelivery(planB).text,
    direto.attachment.name, direto.track.artist, media.formatDeezerDelivery(direto).text,
    falha.error,
  ];
  for (const text of texts) assert.ok(!media.mentionsOrigin(text), `cita a origem: ${text}`);
  planB.cleanup();
  direto.cleanup();
});

// ================================================================================================
console.log('Modo Rádio (radioProviders)');
await test('sanitizeMediaUrl aceita links de YouTube/Deezer/Spotify e recusa o resto', () => {
  for (const good of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=30',
    'https://music.youtube.com/playlist?list=PLabc',
    'http://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.deezer.com/br/track/3135556',
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
    'https://spoti.fi/3abc',
  ]) assert.ok(radio.sanitizeMediaUrl(`ouve essa ${good} agora`), `deveria aceitar: ${good}`);
  assert.equal(radio.sanitizeMediaUrl('<https://youtu.be/dQw4w9WgXcQ>'), 'https://youtu.be/dQw4w9WgXcQ');
  for (const bad of [
    'https://youtu.be/dQw4w9WgXcQ"&calc&"',
    'https://youtu.be/dQw4w9WgXcQ`calc`',
    "https://youtu.be/dQw4w9WgXcQ'&calc",
    'https://youtu.be/dQw4w9WgXcQ\u0001',
    'https://youtu.be/dQw4w9WgXcQ|calc',
    'https://youtu.be/dQw4w9WgXcQ\\..\\x',
    'https://user:senha@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'https://evil.com/?u=youtube.com',
    'https://soundcloud.com/a/b',
    'ftp://youtube.com/x',
    'sem link nenhum',
    '',
  ]) assert.equal(radio.sanitizeMediaUrl(bad), null, `deveria recusar: ${bad}`);
});
await test('extractUrl: texto puro é devolvido; link recusado vira vazio', () => {
  assert.equal(radio.extractUrl('  linkin park numb '), 'linkin park numb');
  assert.equal(radio.extractUrl(''), '');
  assert.equal(radio.extractUrl(null), '');
  assert.equal(radio.extractUrl('toca https://youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(radio.extractUrl('https://youtu.be/dQw4w9WgXcQ"&calc&"'), '');
});
await test('argumentos do yt-dlp da rádio: arrays, alvo em UM argumento, sem aspas acrescentadas', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.deepEqual(radio.buildYtdlpInfoArgs(url), ['--no-warnings', '--no-update', '-j', url]);
  assert.deepEqual(radio.buildYtdlpInfoArgs(url, 'C:\\c.txt'), ['--no-warnings', '--no-update', '--cookies', 'C:\\c.txt', '-j', url]);
  assert.deepEqual(radio.buildYtdlpPlaylistArgs(url), ['--no-warnings', '--no-update', '--flat-playlist', '--playlist-end', '100', '-j', url]);
  const search = radio.buildYtdlpSearchArgs('algo "entre aspas"; & calc\r\nsegunda linha', 5);
  assert.equal(search[search.length - 1], 'ytsearch5:algo "entre aspas"; & calc segunda linha');
  assert.equal(search.filter((a) => a.startsWith('ytsearch')).length, 1);
  assert.ok(radio.buildYtdlpSearchArgs('x', 999).pop().startsWith('ytsearch20:'));
});
await test('searchYouTubeByName usa execFile (array), sem escape de aspas por barra invertida', async () => {
  const fake = fakeExecFile(() => ({
    stdout: [
      JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Primeira', uploader: 'Canal' }),
      JSON.stringify({ id: 'curto', title: 'ID inválido' }),
      JSON.stringify({ id: 'abcdefghijk', title: 'Segunda' }),
    ].join('\n'),
  }));
  const tracks = await radio.searchYouTubeByName('x"; calc & echo', 3, { execFileImpl: fake });
  const args = fake.calls[0].args;
  assert.ok(Array.isArray(args));
  assert.equal(args[args.length - 1], 'ytsearch3:x"; calc & echo');
  assert.ok(args.every((a) => !String(a).includes('\\"')));
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.deepEqual(tracks.map((t) => t.id), ['dQw4w9WgXcQ', 'abcdefghijk']);
  assert.equal(tracks[0].link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(await radio.searchYouTubeByName('   ', 3, { execFileImpl: fake }), []);
});

const radioDir = process.env.YUI_TEST_RADIO_DIR;
/** Imita o serviço: cria <radioDir>/<uuid>/Artista - Título.mp3 (nome SEM o id da faixa). */
function fakeDeezerDownload(counter = { n: 0 }, name = 'Artista - Título é ã.mp3') {
  return async (ref, opts) => {
    counter.n++;
    counter.ref = ref;
    counter.opts = opts;
    await new Promise((r) => setTimeout(r, 30));
    return writeFile(path.join(opts.outDir, `8a1b2c3d-0000-4000-8000-00000000000${counter.n}`, name), 'm'.repeat(5000));
  };
}
await test('rádio/Deezer: usa o caminho devolvido (não o nome), move para a pasta plana e limpa a subpasta', async () => {
  const counter = { n: 0 };
  const file = await radio.downloadTrackToDisk(
    { id: '3135556', source: 'deezer', link: 'https://www.deezer.com/br/track/3135556', title: 'x' },
    null,
    { downloadDeezerTrack: fakeDeezerDownload(counter), radioDir },
  );
  assert.equal(counter.ref, 'https://www.deezer.com/track/3135556');
  assert.equal(counter.opts.outDir, radioDir);
  assert.ok(counter.opts.timeoutMs <= 60000 && counter.opts.timeoutMs > 0);
  assert.equal(path.dirname(file), radioDir, 'arquivo na pasta plana, onde o radioCleaner o enxerga');
  assert.match(path.basename(file), /^deezer_3135556_[0-9a-f]{8}\.mp3$/);
  assert.ok(fs.existsSync(file) && fs.statSync(file).size === 5000);
  assert.equal(listDir(radioDir).filter((n) => /^[0-9a-f-]{36}$/.test(n)).length, 0, 'subpasta do pedido removida');
});
await test('rádio/Deezer: link inválido cai para o ID; sem nenhum dos dois, erro', async () => {
  const counter = { n: 0 };
  await radio.downloadTrackToDisk({ id: '99', source: 'deezer', link: 'https://evil.com/track/1' }, null, { downloadDeezerTrack: fakeDeezerDownload(counter), radioDir });
  assert.equal(counter.ref, 'https://www.deezer.com/track/99');
  await assert.rejects(radio.downloadTrackToDisk({ id: 'x"y', source: 'deezer', link: 'nada' }, null, { downloadDeezerTrack: fakeDeezerDownload(), radioDir }), /sem link ou ID válido/);
});
await test('rádio/Deezer: pedidos simultâneos da mesma faixa compartilham um único download', async () => {
  const counter = { n: 0 };
  const t = { id: '555', source: 'deezer', link: 'https://www.deezer.com/track/555' };
  const deps = { downloadDeezerTrack: fakeDeezerDownload(counter), radioDir };
  const [a, b] = await Promise.all([radio.downloadTrackToDisk(t, null, deps), radio.downloadTrackToDisk(t, null, deps)]);
  assert.equal(counter.n, 1);
  assert.equal(a, b);
  const again = await radio.downloadTrackToDisk(t, null, deps);
  assert.equal(counter.n, 2, 'depois de concluir, um novo pedido baixa de novo');
  assert.ok(again);
});
await test('rádio/Deezer: falha do deemix rejeita com erro (sem plano B no Deezer => sem laço)', async () => {
  let ytCalls = 0;
  await assert.rejects(
    radio.downloadTrackToDisk({ id: '7', source: 'deezer', link: 'https://www.deezer.com/track/7' }, null, {
      downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.NOT_INSTALLED); },
      downloadAudio: async () => { ytCalls++; return {}; },
      radioDir,
    }),
    (e) => e.code === CODE.NOT_INSTALLED,
  );
  assert.equal(ytCalls, 0);
});
await test('rádio/YouTube: se falhar, tenta o Deezer uma única vez (fallback inverso preservado)', async () => {
  const counter = { n: 0 };
  let searches = 0;
  const file = await radio.downloadTrackToDisk(
    { id: 'dQw4w9WgXcQ', source: 'youtube', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Numb', artist: 'Linkin Park' },
    null,
    {
      downloadAudio: async () => { throw new Error('YTDLP_ERROR'); },
      searchDeezerTracks: async () => { searches++; return [{ id: 77, link: 'https://www.deezer.com/track/77' }]; },
      downloadDeezerTrack: fakeDeezerDownload(counter),
      radioDir,
    },
  );
  assert.equal(searches, 1);
  assert.equal(counter.n, 1);
  assert.match(path.basename(file), /^deezer_77_/);
  // Deezer também falha: erro final, sem repetir buscas nem alternar entre os dois
  let deezerCalls = 0;
  await assert.rejects(
    radio.downloadTrackToDisk(
      { id: 'dQw4w9WgXcQ', source: 'youtube', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Numb', artist: 'Linkin Park' },
      null,
      {
        downloadAudio: async () => { throw new Error('YTDLP_ERROR'); },
        searchDeezerTracks: async () => [{ id: 78, link: 'https://www.deezer.com/track/78' }],
        downloadDeezerTrack: async () => { deezerCalls++; throw new svc.DeezerDownloadError(CODE.ERROR); },
        radioDir,
      },
    ),
    /Falha ao baixar áudio do YouTube/,
  );
  assert.equal(deezerCalls, 1);
});
await test('rádio/YouTube: download direto e caminho pré-baixado continuam valendo', async () => {
  const pre = writeFile(path.join(newDir('pre'), 'pre.mp3'));
  assert.equal(await radio.downloadTrackToDisk({ id: 'a', source: 'youtube', link: 'https://youtu.be/dQw4w9WgXcQ', preDownloadedPath: pre }, null, {}), pre);
  const direct = writeFile(path.join(newDir('dl'), 'direto.mp3'));
  assert.equal(await radio.downloadTrackToDisk({ id: 'b', source: 'youtube', link: 'https://youtu.be/dQw4w9WgXcQ' }, null, { downloadAudio: async (link) => { assert.match(link, /dQw4w9WgXcQ/); return { filePath: direct }; } }), direct);
  await assert.rejects(radio.downloadTrackToDisk(null), /inválido/);
  await assert.rejects(radio.downloadTrackToDisk({ id: 'z', source: 'outra' }), /desconhecida/);
});

// ================================================================================================
console.log('Estrutura dos arquivos');
await test('nenhum exec/execSync de string de shell nos arquivos do Deezer e da rádio; sem console.*', () => {
  for (const rel of ['src/services/deezerMusicService.js', 'src/handlers/deezerMusicHandler.js', 'src/music/radioProviders.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!/\bexecSync\s*\(/.test(src), `${rel}: execSync`);
    assert.ok(!/\bexec\s*\(/.test(src), `${rel}: exec(`);
    assert.ok(!/import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'node:child_process'/.test(src), `${rel}: import de exec`);
    assert.ok(!/\bconsole\.(log|warn|error|info)\b/.test(src), `${rel}: console.*`);
    assert.ok(!/safeQuery/.test(src), `${rel}: escape fraco de aspas`);
  }
});
await test('o serviço não acompanha mais a heurística do "arquivo mais recente" nem aceita ARL em argv', () => {
  const src = fs.readFileSync(path.join(root, 'src/services/deezerMusicService.js'), 'utf8');
  assert.ok(!/latestFile|readdirSync\(outputFolder\)/.test(src));
  assert.ok(/DEEZER_ARL: arl|env\.DEEZER_ARL = arl/.test(src));
  assert.equal(fs.readFileSync(path.join(root, 'requirements-deemix.txt'), 'utf8').trim().split(/\r?\n/).join('|'), 'deemix==3.6.6|deezer-py==1.3.7');
});

// ================================================================================================
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'OK' : 'FALHA'}: ${passed} teste(s) passaram${failed ? `, ${failed} falharam` : ''}.`);
process.exit(failed === 0 ? 0 : 1);
