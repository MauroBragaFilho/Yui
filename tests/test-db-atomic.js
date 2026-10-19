// Gravação atômica do banco (TG-20): src/database/db.js.
// Sem rede, sem Discord e SEM os bancos reais: tudo numa pasta temporária (DATABASE_DIR).
// Execução: npm run test:db-atomic
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT);';
const THIS_FILE = fileURLToPath(import.meta.url);

// ───────────────────────── Modo filho (teste de processo morto) ─────────────────────────
// O pai inicia este mesmo arquivo com --child, deixa gravar e MATA o processo no meio.
if (process.argv[2] === '--child') {
  process.chdir(process.env.DATABASE_DIR); // o logger grava em ./logs: não polui os logs reais
  const { initDatabase, getDbWrapper } = await import('../src/database/db.js');
  await initDatabase('crash', SCHEMA);
  const w = getDbWrapper('crash');
  process.stdout.write('@@pronto@@\n');
  for (;;) {
    w.prepare('INSERT INTO t (v) VALUES (?)').run('y'.repeat(2000)); // cada INSERT reescreve o arquivo inteiro
    await new Promise((r) => setImmediate(r));
  }
}

// ───────────────────────── Preparação ─────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dbatomic-'));
process.env.DATABASE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.chdir(tmp); // o logger grava em ./logs (relativo ao cwd): os erros simulados abaixo não vão para os logs reais da Yui

// Sobras de uma gravação interrompida, ANTES do primeiro initDatabase: a subida deve limpar só a antiga.
const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
fs.writeFileSync(path.join(tmp, 'orfao.db.4242.tmp'), 'sobra');
fs.utimesSync(path.join(tmp, 'orfao.db.4242.tmp'), hourAgo, hourAgo);
fs.writeFileSync(path.join(tmp, 'recente.db.4243.tmp'), 'em uso agora');

const db = await import('../src/database/db.js');
const require = createRequire(import.meta.url);
const SQL = await require('sql.js')();

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA ${name}\n        ${err.stack || err.message}`);
  }
};

const dbFile = (name) => path.join(tmp, `${name}.db`);
const tmpFiles = (dir = tmp) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
/** Abre o arquivo com um sql.js novo (o que o próximo bootstrap faria) e conta as linhas. */
function countRows(file) {
  const d = new SQL.Database(fs.readFileSync(file));
  try {
    assert.equal(d.exec('PRAGMA integrity_check')[0].values[0][0], 'ok', 'integrity_check');
    return d.exec('SELECT COUNT(*) FROM t')[0].values[0][0];
  } finally {
    d.close();
  }
}
const fsWith = (over) => ({ ...fs, ...over });
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

console.log('Gravação atômica do banco');

await test('subida: limpa o temporário ANTIGO e preserva o recente (TG-20, limpeza)', async () => {
  assert.ok(fs.existsSync(path.join(tmp, 'orfao.db.4242.tmp')), 'pré-condição');
  await db.initDatabase('basico', SCHEMA);
  assert.ok(!fs.existsSync(path.join(tmp, 'orfao.db.4242.tmp')), 'o temporário velho devia ter sido removido');
  assert.ok(fs.existsSync(path.join(tmp, 'recente.db.4243.tmp')), 'o recente pode ser de outro processo gravando agora');
  fs.unlinkSync(path.join(tmp, 'recente.db.4243.tmp'));
});

await test('grava, recarrega e não deixa .tmp sobrando', async () => {
  const w = db.getDbWrapper('basico');
  for (let i = 0; i < 3; i++) w.prepare('INSERT INTO t (v) VALUES (?)').run(`linha ${i}`);
  assert.equal(countRows(dbFile('basico')), 3);
  assert.deepEqual(tmpFiles(), []);
});

await test('banco desconhecido: devolve false e não lança', async () => {
  assert.equal(db.saveDatabase('nao-existe'), false);
});

await test('run() continua devolvendo .changes correto (contador lido antes do export)', async () => {
  const w = db.getDbWrapper('basico');
  assert.equal(w.prepare('INSERT INTO t (v) VALUES (?)').run('mais uma').changes, 1);
  assert.equal(w.prepare('UPDATE t SET v = v').run().changes, 4);
});

await test('o temporário nasce na MESMA pasta e o .db só muda por rename (nada grava direto no .db)', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  handle.run('INSERT INTO t (v) VALUES (?)', ['via rename']);
  const calls = [];
  const spy = fsWith({
    writeFileSync: (p, b) => { calls.push(['write', p]); return fs.writeFileSync(p, b); },
    renameSync: (a, b) => { calls.push(['rename', a, b]); return fs.renameSync(a, b); },
    unlinkSync: (p) => { calls.push(['unlink', p]); return fs.unlinkSync(p); },
  });
  assert.equal(db.saveDatabase('basico', { fsImpl: spy }), true);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  const [w, r] = calls;
  assert.equal(w[0], 'write');
  assert.equal(r[0], 'rename');
  assert.notEqual(w[1], dbFile('basico'), 'a escrita não pode ir direto para o .db');
  assert.equal(path.dirname(w[1]), path.dirname(dbFile('basico')), 'mesma pasta (mesmo volume) para o rename ser atômico');
  assert.match(path.basename(w[1]), /^basico\.db\.\d+\.tmp$/);
  assert.equal(r[1], w[1]);
  assert.equal(r[2], dbFile('basico'));
  assert.deepEqual(tmpFiles(), []);
  assert.equal(countRows(dbFile('basico')), 5);
});

await test('falha ANTES do rename (disco cheio no meio da escrita): o .db anterior fica intacto e o .tmp é removido', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  const before = fs.readFileSync(dbFile('basico'));
  const rowsBefore = countRows(dbFile('basico'));
  handle.run('INSERT INTO t (v) VALUES (?)', ['só na memória']);
  const halfWrite = fsWith({
    writeFileSync: (p, b) => { fs.writeFileSync(p, b.subarray(0, Math.floor(b.length / 2))); throw enospc(); },
  });
  assert.equal(db.saveDatabase('basico', { fsImpl: halfWrite }), false);
  assert.ok(Buffer.compare(before, fs.readFileSync(dbFile('basico'))) === 0, 'o arquivo do banco foi alterado');
  assert.equal(countRows(dbFile('basico')), rowsBefore);
  assert.deepEqual(tmpFiles(), [], 'sobrou temporário parcial');
  // a próxima gravação normal leva também a linha que ficou só na memória
  assert.equal(db.saveDatabase('basico'), true);
  assert.equal(countRows(dbFile('basico')), rowsBefore + 1);
});

await test('rename com falha passageira (EPERM do Windows): tenta de novo e segue atômico', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  const rowsBefore = countRows(dbFile('basico'));
  handle.run('INSERT INTO t (v) VALUES (?)', ['depois do tranco']);
  let renames = 0;
  const writes = [];
  const waits = [];
  const flaky = fsWith({
    writeFileSync: (p, b) => { writes.push(p); return fs.writeFileSync(p, b); },
    renameSync: (a, b) => { if (renames++ === 0) throw eperm(); return fs.renameSync(a, b); },
  });
  assert.equal(db.saveDatabase('basico', { fsImpl: flaky, sleep: (ms) => waits.push(ms) }), true);
  assert.equal(renames, 2);
  assert.deepEqual(waits, [5]);
  assert.equal(writes.length, 1, 'não devia ter caído no plano B (gravação direta)');
  assert.notEqual(writes[0], dbFile('basico'));
  assert.equal(countRows(dbFile('basico')), rowsBefore + 1);
  assert.deepEqual(tmpFiles(), []);
});

await test('rename que NUNCA funciona: grava direto, o banco não corrompe e não sobra .tmp', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  const rowsBefore = countRows(dbFile('basico'));
  handle.run('INSERT INTO t (v) VALUES (?)', ['plano B']);
  const writes = [];
  const waits = [];
  const locked = fsWith({
    writeFileSync: (p, b) => { writes.push(p); return fs.writeFileSync(p, b); },
    renameSync: () => { throw eperm(); },
  });
  assert.equal(db.saveDatabase('basico', { fsImpl: locked, sleep: (ms) => waits.push(ms) }), true);
  assert.deepEqual(waits, [5, 25], 'duas novas tentativas antes de desistir');
  assert.equal(writes.length, 2);
  assert.equal(writes[1], dbFile('basico'), 'o plano B grava direto no .db');
  assert.equal(countRows(dbFile('basico')), rowsBefore + 1);
  assert.deepEqual(tmpFiles(), []);
});

await test('rename com erro que não é passageiro (ENOENT): vai direto ao plano B, sem esperar', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  const rowsBefore = countRows(dbFile('basico'));
  handle.run('INSERT INTO t (v) VALUES (?)', ['sem espera']);
  const waits = [];
  const gone = fsWith({ renameSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(db.saveDatabase('basico', { fsImpl: gone, sleep: (ms) => waits.push(ms) }), true);
  assert.deepEqual(waits, []);
  assert.equal(countRows(dbFile('basico')), rowsBefore + 1);
  assert.deepEqual(tmpFiles(), []);
});

await test('rename E plano B falham: devolve false, não lança e o .db anterior segue legível', async () => {
  const handle = await db.initDatabase('basico', SCHEMA);
  const before = fs.readFileSync(dbFile('basico'));
  const rowsBefore = countRows(dbFile('basico'));
  handle.run('INSERT INTO t (v) VALUES (?)', ['não vai']);
  const dead = fsWith({
    writeFileSync: (p, b) => { if (p === dbFile('basico')) throw enospc(); return fs.writeFileSync(p, b); },
    renameSync: () => { throw eperm(); },
  });
  assert.equal(db.saveDatabase('basico', { fsImpl: dead, sleep: () => {} }), false);
  assert.ok(Buffer.compare(before, fs.readFileSync(dbFile('basico'))) === 0);
  assert.equal(countRows(dbFile('basico')), rowsBefore);
  assert.deepEqual(tmpFiles(), []);
  assert.equal(db.saveDatabase('basico'), true); // volta a gravar quando o problema passa
});

await test('transação: uma única gravação (temporário + rename) após o COMMIT', async () => {
  await db.initDatabase('trans', SCHEMA);
  const w = db.getDbWrapper('trans');
  const seen = [];
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  // fs real é o padrão do módulo: espiona o objeto compartilhado, só para a pasta deste teste.
  fs.writeFileSync = function (p, ...rest) { if (String(p).startsWith(tmp)) seen.push(`write:${path.basename(String(p))}`); return origWrite.call(this, p, ...rest); };
  fs.renameSync = function (a, b) { if (String(a).startsWith(tmp)) seen.push(`rename:${path.basename(String(b))}`); return origRename.call(this, a, b); };
  try {
    const insertMany = w.transaction(() => {
      for (let i = 0; i < 5; i++) w.prepare('INSERT INTO t (v) VALUES (?)').run(`t${i}`);
    });
    insertMany();
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }
  assert.equal(seen.length, 2, seen.join(' | '));
  assert.match(seen[0], /^write:trans\.db\.\d+\.tmp$/);
  assert.equal(seen[1], 'rename:trans.db');
  assert.equal(countRows(dbFile('trans')), 5);
});

await test('cleanStaleTempFiles: só apaga temporário de gravação VELHO; nunca .db, .bak, outro .tmp ou pasta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dbclean-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const make = (name, { dirOnly = false, aged = true } = {}) => {
    const p = path.join(dir, name);
    if (dirOnly) fs.mkdirSync(p); else fs.writeFileSync(p, 'x');
    if (aged) fs.utimesSync(p, old, old);
  };
  make('a.db.111.tmp');
  make('a.db.tmp');
  make('b.db.222.tmp', { aged: false });
  make('a.db');
  make('a.db.bak');
  make('notas.tmp');
  make('d.db.9.tmp', { dirOnly: true });
  const removed = db.cleanStaleTempFiles(dir).sort();
  assert.deepEqual(removed, ['a.db.111.tmp', 'a.db.tmp']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.db', 'a.db.bak', 'b.db.222.tmp', 'd.db.9.tmp', 'notas.tmp']);
  // idade zero (relógio injetado): o recente também sai, o resto continua intocado
  assert.deepEqual(db.cleanStaleTempFiles(dir, { maxAgeMs: 0 }), ['b.db.222.tmp']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.db', 'a.db.bak', 'd.db.9.tmp', 'notas.tmp']);
  // pasta que não existe: devolve vazio, não lança
  assert.deepEqual(db.cleanStaleTempFiles(path.join(dir, 'nao-existe')), []);
});

await test('desempenho: gravar ~5 MB com temporário + rename não é mais lento que o método antigo', async () => {
  const handle = await db.initDatabase('grande', SCHEMA);
  handle.run('BEGIN');
  const pad = 'x'.repeat(2000);
  for (let i = 0; i < 2600; i++) handle.run('INSERT INTO t (v) VALUES (?)', [pad + i]);
  handle.run('COMMIT');
  assert.equal(db.saveDatabase('grande'), true);
  const size = fs.statSync(dbFile('grande')).size;
  assert.ok(size > 4.5 * 1024 * 1024, `banco de teste pequeno demais: ${size}`);
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const oldWay = []; const newWay = [];
  for (let i = 0; i < 15; i++) {
    oldWay.push(time(() => fs.writeFileSync(path.join(tmp, 'antigo.bin'), Buffer.from(handle.export())))); // export + cópia + escrita direta
    newWay.push(time(() => db.saveDatabase('grande')));
  }
  const o = median(oldWay); const n = median(newWay);
  console.log(`        ${(size / 1048576).toFixed(1)} MB: antigo ${o.toFixed(1)} ms, novo ${n.toFixed(1)} ms (mediana de 15)`);
  assert.ok(n <= o * 1.6 + 10, `gravação ficou mais lenta: antigo ${o.toFixed(1)} ms, novo ${n.toFixed(1)} ms`);
});

await test('estresse: processo MORTO no meio de várias gravações nunca deixa o .db ilegível', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dbcrash-'));
  // banco semente de ~400 KB (cada gravação reescreve tudo: janela de escrita não desprezível)
  const seed = new SQL.Database();
  seed.run(SCHEMA);
  for (let i = 0; i < 200; i++) seed.run('INSERT INTO t (v) VALUES (?)', ['s'.repeat(2000)]);
  fs.writeFileSync(path.join(dir, 'crash.db'), Buffer.from(seed.export()));
  seed.close();

  const children = [];
  try {
    for (let round = 0; round < 6; round++) {
      const child = spawn(process.execPath, [THIS_FILE, '--child'], {
        env: { ...process.env, DATABASE_DIR: dir, LOG_LEVEL: 'error' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      children.push(child);
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      const started = Date.now();
      while (!out.includes('@@pronto@@')) {
        if (child.exitCode !== null) throw new Error('o processo filho terminou antes de ficar pronto');
        if (Date.now() - started > 30000) throw new Error('o processo filho não ficou pronto em 30 s');
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 90))); // deixa gravar um pouco e mata em ponto aleatório
      const exited = child.exitCode !== null ? Promise.resolve() : once(child, 'exit');
      if (child.exitCode === null) child.kill();
      await exited;
      const rows = countRows(path.join(dir, 'crash.db')); // lança se o arquivo estiver truncado/ilegível
      assert.ok(rows >= 200, `perdeu linhas: ${rows}`);
    }
    // as sobras (se a morte caiu entre escrever o temporário e o rename) saem na limpeza
    db.cleanStaleTempFiles(dir, { maxAgeMs: 0 });
    assert.deepEqual(tmpFiles(dir), []);
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill();
  }
});

console.log(`\n${passed} ok, ${failed} falha(s)`);
process.chdir(os.tmpdir()); // não dá para apagar a pasta onde o processo está
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sobra em %TEMP%: inofensiva */ }
process.exit(failed ? 1 : 0);
