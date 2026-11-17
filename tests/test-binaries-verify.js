// Verificação de integridade dos binários baixados (yt-dlp, ffmpeg): hash publicado tem que bater, falha fechada.
// Execução: npm run test:binverify
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const { parseSha256Sums, hashFile, downloadFile, downloadVerified } = await import('../src/utils/binaries.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-binverify-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const GOOD = Buffer.from('binario-bom-v1');
const EVIL = Buffer.from('binario-trocado-no-caminho');
const files = {
  '/yt-dlp.exe': GOOD,
  '/evil/yt-dlp.exe': EVIL,
  '/SUMS': Buffer.from(`${sha(GOOD)}  yt-dlp.exe\n${sha(Buffer.from('x'))} *outro.bin\n`),
  '/SUMS-sem-o-arquivo': Buffer.from(`${sha(Buffer.from('x'))}  outro.bin\n`),
  '/ff.tar.xz': GOOD,
  '/ff.tar.xz.md5': Buffer.from(`${md5(GOOD)}  ff.tar.xz\n`),
};
const server = http.createServer((req, res) => {
  const body = files[req.url];
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const leftovers = () => fs.readdirSync(tmp).filter((n) => n.includes('.tmp'));

console.log('Lista de hashes');
await test('parseSha256Sums lê "hash  arquivo" e "hash *arquivo", ignora lixo e devolve null se não achar', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseSha256Sums(`${h}  yt-dlp.exe\n`, 'yt-dlp.exe'), h);
  assert.equal(parseSha256Sums(`${h.toUpperCase()} *yt-dlp.exe\r\n`, 'yt-dlp.exe'), h);
  assert.equal(parseSha256Sums(`${h}  yt-dlp.exe\n`, 'yt-dlp'), null);
  assert.equal(parseSha256Sums('lixo sem hash\n', 'yt-dlp.exe'), null);
  assert.equal(parseSha256Sums(undefined, 'x'), null);
});
await test('hashFile calcula o hash do conteúdo', async () => {
  const f = path.join(tmp, 'h.bin'); fs.writeFileSync(f, GOOD);
  assert.equal(await hashFile(f), sha(GOOD));
  assert.equal(await hashFile(f, 'md5'), md5(GOOD));
});

console.log('Download verificado');
await test('hash confere: o binário é instalado', async () => {
  const dest = path.join(tmp, 'ok', 'yt-dlp.exe');
  await downloadVerified({ url: `${base}/yt-dlp.exe`, sumsUrl: `${base}/SUMS`, fileName: 'yt-dlp.exe', destPath: dest, env: {} });
  assert.deepEqual(fs.readFileSync(dest), GOOD);
});
await test('NEGATIVO: arquivo trocado no caminho (hash diferente) é recusado e o binário anterior continua intocado', async () => {
  const dest = path.join(tmp, 'evil-dest.exe');
  fs.writeFileSync(dest, 'binario-antigo-confiavel');
  await assert.rejects(downloadVerified({ url: `${base}/evil/yt-dlp.exe`, sumsUrl: `${base}/SUMS`, fileName: 'yt-dlp.exe', destPath: dest, env: {} }), /não confere/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'binario-antigo-confiavel');
  assert.deepEqual(leftovers(), [], 'sem arquivo temporário sobrando');
});
await test('NEGATIVO: lista de hashes sem o arquivo (falha fechada: nada é instalado)', async () => {
  const dest = path.join(tmp, 'sem-hash.exe');
  await assert.rejects(downloadVerified({ url: `${base}/yt-dlp.exe`, sumsUrl: `${base}/SUMS-sem-o-arquivo`, fileName: 'yt-dlp.exe', destPath: dest, env: {} }), /não encontrado/);
  assert.equal(fs.existsSync(dest), false);
});
await test('NEGATIVO: lista de hashes inacessível (404) também não instala nada', async () => {
  const dest = path.join(tmp, 'sem-lista.exe');
  await assert.rejects(downloadVerified({ url: `${base}/yt-dlp.exe`, sumsUrl: `${base}/nao-existe`, fileName: 'yt-dlp.exe', destPath: dest, env: {} }));
  assert.equal(fs.existsSync(dest), false);
});
await test('MD5 do ffmpeg (única coisa que o projeto publica) também é conferido', async () => {
  const dest = path.join(tmp, 'ff.tar.xz');
  await downloadVerified({ url: `${base}/ff.tar.xz`, sumsUrl: `${base}/ff.tar.xz.md5`, fileName: 'ff.tar.xz', destPath: dest, algo: 'md5', env: {} });
  assert.deepEqual(fs.readFileSync(dest), GOOD);
});
await test('YUI_BINARIES_VERIFY=false é a única saída (instala sem conferir, com aviso); o padrão é conferir', async () => {
  const dest = path.join(tmp, 'sem-verificar.exe');
  await downloadVerified({ url: `${base}/evil/yt-dlp.exe`, sumsUrl: `${base}/SUMS`, fileName: 'yt-dlp.exe', destPath: dest, env: { YUI_BINARIES_VERIFY: 'false' } });
  assert.deepEqual(fs.readFileSync(dest), EVIL);
  const dest2 = path.join(tmp, 'padrao.exe');
  await assert.rejects(downloadVerified({ url: `${base}/evil/yt-dlp.exe`, sumsUrl: `${base}/SUMS`, fileName: 'yt-dlp.exe', destPath: dest2, env: {} }));
});
await test('downloadFile sem hash esperado continua funcionando como antes (outros usos)', async () => {
  const dest = path.join(tmp, 'puro.bin');
  await downloadFile(`${base}/yt-dlp.exe`, dest);
  assert.deepEqual(fs.readFileSync(dest), GOOD);
});

console.log('Vigia do código');
await test('ensureYtdlp e ensureFfmpeg instalam por downloadVerified, nunca por downloadFile direto', () => {
  const src = fs.readFileSync(new URL('../src/utils/binaries.js', import.meta.url), 'utf8');
  const ytdlp = src.slice(src.indexOf('export async function ensureYtdlp'), src.indexOf('export async function ensureFfmpeg'));
  const ffmpeg = src.slice(src.indexOf('export async function ensureFfmpeg'), src.indexOf('const YTDLP_UPDATE_TIMEOUT_MS'));
  for (const [nome, trecho] of [['ensureYtdlp', ytdlp], ['ensureFfmpeg', ffmpeg]]) {
    assert.match(trecho, /downloadVerified\(/, nome);
    assert.doesNotMatch(trecho, /await downloadFile\(/, `${nome} não pode baixar sem conferir`);
  }
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
