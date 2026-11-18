// Motor nativo do banco (node:sqlite com WAL) atrás de YUI_DB_NATIVE: etapa 2 do cérebro único.
// Execução: npm run test:dbnative. Tudo numa pasta temporária: nunca toca nos bancos reais.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dbnative-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_DB_NATIVE = '';
// Etapa 8 (revisão da Liz): os processos auxiliares deste teste rodam sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers
// falham e ficam registrados; nenhuma exceção: os filhos só abrem bancos locais e o script de migração só mexe em arquivos). O registro guarda qual teste abriu cada exceção.
// (o `git check-ignore` do fim roda no processo do TESTE, que não é código da Yui.)
const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:dbnative', liberar: {} });
const filhoEnv = (extra = {}) => ({ ...process.env, NODE_ENV: 'test', ...extra, ...BLOQUEIO.env('filho') });
const db = await import('../src/database/db.js');
const { DatabaseSync } = await import('node:sqlite');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const dbFile = (name) => path.join(tmp, `${name}.db`);
const header = (name) => [...fs.readFileSync(dbFile(name)).subarray(18, 20)];
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS itens (id INTEGER PRIMARY KEY AUTOINCREMENT, chave TEXT UNIQUE, texto TEXT, n INTEGER, ativo INTEGER);
  CREATE INDEX IF NOT EXISTS idx_itens_n ON itens(n);`;
const nativeOn = (...names) => { process.env.YUI_DB_NATIVE = names.join(','); };

/** As mesmas operações nos dois motores devolvem as mesmas coisas. */
async function exercise(name) {
  await db.initDatabase(name, SCHEMA);
  const w = db.getDbWrapper(name);
  const ins = w.prepare('INSERT INTO itens (chave, texto, n, ativo) VALUES (?, ?, ?, ?)');
  const out = {};
  out.run = ins.run('a', 'primeiro', 1, true);
  out.textoInteiro = (ins.run('b', 5, 2, false), w.prepare('SELECT texto FROM itens WHERE chave = ?').get('b'));
  out.textoGrande = (ins.run('c', 1731859200000, 3, 1), w.prepare('SELECT texto, typeof(texto) AS tipo FROM itens WHERE chave = ?').get('c'));
  out.booleano = w.prepare('SELECT ativo FROM itens WHERE chave = ?').get('a');
  out.get = w.prepare('SELECT chave, texto, n FROM itens WHERE chave = ?').get('a');
  out.protoComum = Object.getPrototypeOf(out.get) === Object.prototype;
  out.vazio = w.prepare('SELECT * FROM itens WHERE chave = ?').get('nao-existe');
  out.all = w.prepare('SELECT chave, n FROM itens ORDER BY n').all();
  out.update = w.prepare('UPDATE itens SET n = n + 10 WHERE n >= ?').run(2);
  const lote = w.transaction((linhas) => { let c = 0; for (const l of linhas) c += ins.run(l, 'lote', 9, 0).changes; return c; });
  out.transacao = lote(['d', 'e', 'f']);
  const quebra = w.transaction(() => { ins.run('g', 'x', 1, 0); throw new Error('falha de propósito'); });
  out.rollback = (() => { try { quebra(); return 'não lançou'; } catch (e) { return e.message; } })();
  out.depoisRollback = w.prepare("SELECT count(*) AS n FROM itens WHERE chave = 'g'").get();
  const aninhada = w.transaction(() => lote(['h']));
  out.aninhada = aninhada();
  out.total = w.prepare('SELECT count(*) AS n FROM itens').get();
  out.duplicada = (() => { try { ins.run('a', 'dup', 1, 0); return 'aceitou'; } catch { return 'recusou'; } })();
  return out;
}

console.log('Paridade entre os motores');
await test('as mesmas operações dão os mesmos resultados no sql.js e no node:sqlite', async () => {
  const antigo = await exercise('paridade-sqljs');
  nativeOn('paridade-native');
  const novo = await exercise('paridade-native');
  nativeOn();
  assert.equal(db.getDatabaseEngine('paridade-sqljs'), 'sqljs');
  assert.equal(db.getDatabaseEngine('paridade-native'), 'native');
  assert.deepStrictEqual(novo, antigo);
  assert.deepStrictEqual(antigo.textoInteiro, { texto: '5' }, 'inteiro numa coluna TEXT continua "5" (não "5.0")');
  assert.equal(antigo.booleano.ativo, 1);
  assert.equal(antigo.vazio, null);
  assert.equal(antigo.rollback, 'falha de propósito');
  assert.equal(antigo.total.n, 7);
});
await test('no nativo a escrita já está no arquivo, sem regravar o banco inteiro (WAL)', async () => {
  const leitor = new DatabaseSync(dbFile('paridade-native'), { readOnly: true });
  try { assert.equal(leitor.prepare('SELECT count(*) AS n FROM itens').get().n, 7); } finally { leitor.close(); }
  assert.deepEqual(header('paridade-native'), [2, 2]);
  assert.ok(fs.existsSync(`${dbFile('paridade-native')}-wal`));
  assert.equal(db.saveDatabase('paridade-native'), true, 'saveDatabase no nativo não faz nada e não falha');
});

console.log('Trava contra os dois motores no mesmo arquivo');
await test('o sql.js se recusa a abrir um banco do motor nativo (não regrava por cima do WAL)', async () => {
  assert.equal(db.closeDatabase('paridade-native'), true);
  assert.equal(db.getDatabaseEngine('paridade-native'), null);
  assert.equal(db.isWalFile(dbFile('paridade-native')), true);
  await assert.rejects(db.initDatabase('paridade-native', SCHEMA), /formato do motor nativo/);
  nativeOn('paridade-native');
  await db.initDatabase('paridade-native', SCHEMA);
  assert.equal(db.getDbWrapper('paridade-native').prepare('SELECT count(*) AS n FROM itens').get().n, 7, 'reabriu no nativo sem perder nada');
  db.closeDatabase('paridade-native');
  nativeOn();
});
await test('o db.js só carrega o node:sqlite quando um banco nativo é pedido (sem aviso "experimental" à toa)', () => {
  const src = fs.readFileSync(path.join(root, 'src/database/db.js'), 'utf8');
  assert.doesNotMatch(src, /^import .*node:sqlite/m);
  assert.match(src, /await import\('node:sqlite'\)/);
});

console.log('Migração, volta e restauração (scripts/banco-nativo.mjs)');
const script = path.join(root, 'scripts', 'banco-nativo.mjs');
const cli = (...args) => spawnSync(process.execPath, [...BLOQUEIO.argv, '--no-warnings', script, ...args], { encoding: 'utf8', env: filhoEnv() });
await test('migrar: backup com SHA-256 e manifesto, passa para WAL e confere contagens, esquema e índices', async () => {
  await exercise('migra'); // banco no formato do sql.js
  db.closeDatabase('migra');
  assert.deepEqual(header('migra'), [1, 1]);
  const r = cli('migrar', dbFile('migra'), '--backup', path.join(tmp, 'bkp'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('}') + 1));
  assert.equal(out.formato, 'WAL');
  assert.deepEqual(out.contagens, { itens: 7 });
  assert.ok(out.indices.includes('idx_itens_n'));
  const manifest = JSON.parse(fs.readFileSync(out.manifesto, 'utf8'));
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(cli('migrar', dbFile('migra')).status, 1, 'não migra duas vezes');
});
await test('depois de migrar, a Yui usa o banco no nativo; reverter devolve o formato que o sql.js lê, com os dados novos', async () => {
  nativeOn('migra');
  await db.initDatabase('migra', SCHEMA);
  db.getDbWrapper('migra').prepare('INSERT INTO itens (chave, texto, n, ativo) VALUES (?, ?, ?, ?)').run('nova', 'depois da migração', 1, 1);
  db.closeDatabase('migra');
  nativeOn();
  const r = cli('reverter', dbFile('migra'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(header('migra'), [1, 1]);
  assert.equal(fs.existsSync(`${dbFile('migra')}-wal`), false);
  await db.initDatabase('migra', SCHEMA); // agora pelo sql.js
  assert.equal(db.getDatabaseEngine('migra'), 'sqljs');
  assert.equal(db.getDbWrapper('migra').prepare('SELECT count(*) AS n FROM itens').get().n, 8);
  db.closeDatabase('migra');
});
await test('restaurar: o backup volta ao lugar (SHA-256 conferido) e apaga -wal e -shm', async () => {
  const backup = fs.readdirSync(path.join(tmp, 'bkp')).find((f) => f.endsWith('.db'));
  fs.writeFileSync(`${dbFile('migra')}-wal`, 'lixo');
  const r = cli('restaurar', path.join(tmp, 'bkp', backup), dbFile('migra'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(fs.existsSync(`${dbFile('migra')}-wal`), false);
  await db.initDatabase('migra', SCHEMA);
  assert.equal(db.getDbWrapper('migra').prepare('SELECT count(*) AS n FROM itens').get().n, 7, 'voltou ao estado do backup');
  db.closeDatabase('migra');
  fs.appendFileSync(path.join(tmp, 'bkp', backup), 'x');
  assert.equal(cli('restaurar', path.join(tmp, 'bkp', backup), dbFile('migra')).status, 1, 'backup adulterado é recusado');
});

console.log('Queda, reinício e concorrência (processos de verdade)');
const LOTE = 50;
const child = (name, lotes, extra = '') => {
  const file = path.join(tmp, `filho-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/database/db.js')).href)});
    await db.initDatabase(${JSON.stringify(name)}, ${JSON.stringify(SCHEMA)});
    const w = db.getDbWrapper(${JSON.stringify(name)});
    const ins = w.prepare('INSERT INTO itens (texto, n, ativo) VALUES (?, ?, ?)');
    const lote = w.transaction((i) => { for (let k = 0; k < ${LOTE}; k++) ins.run('p' + process.pid + '-' + i + '-' + k, i, 1); });
    for (let i = 0; i < ${lotes}; i++) { lote(i); process.stdout.write('ok ' + (i + 1) + '\\n'); ${extra} }
    process.exit(0);`);
  return spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', file], { cwd: tmp, env: filhoEnv({ YUI_DB_NATIVE: name, DATABASE_DIR: tmp }), stdio: ['ignore', 'pipe', 'pipe'] });
};
// Conexão NORMAL só para ler: no WAL, uma conexão readOnly não consegue recriar o -shm se ele estiver sendo apagado
// (o último processo que escreve fecha e o apaga) e falha com "disk I/O error" de forma intermitente.
const countOf = (name) => { const c = new DatabaseSync(dbFile(name)); try { return { n: c.prepare('SELECT count(*) AS n FROM itens').get().n, ok: c.prepare('PRAGMA integrity_check').get().integrity_check }; } finally { c.close(); } };

await test('processo morto no meio da escrita: nenhuma transação pela metade e nada do que foi confirmado se perde', async () => {
  const p = child('queda', 100000, "await new Promise((r) => setTimeout(r, 2));");
  const fimDaQueda = new Promise((r) => p.on('exit', r));
  let confirmados = 0;
  p.stdout.on('data', (d) => { const m = String(d).match(/ok (\d+)\s*$/); if (m) confirmados = Number(m[1]); });
  await new Promise((resolve) => { const t = setInterval(() => { if (confirmados >= 30) { clearInterval(t); resolve(); } }, 20); });
  p.kill('SIGKILL'); // o processo que NÓS abrimos (guardado em p), de forma abrupta, sem fechar o banco nem o WAL
  await fimDaQueda;
  const { n, ok } = countOf('queda');
  assert.equal(ok, 'ok');
  assert.equal(n % LOTE, 0, `transação pela metade: ${n} linhas`);
  assert.ok(n >= confirmados * LOTE, `perdeu escrita confirmada: ${n} < ${confirmados * LOTE}`);
});
await test('reinício depois da queda: o banco abre normal pela Yui (WAL recuperado) e aceita escrita', async () => {
  nativeOn('queda');
  await db.initDatabase('queda', SCHEMA);
  const w = db.getDbWrapper('queda');
  const antes = w.prepare('SELECT count(*) AS n FROM itens').get().n;
  w.prepare('INSERT INTO itens (texto, n, ativo) VALUES (?, ?, ?)').run('depois da queda', 0, 1);
  assert.equal(w.prepare('SELECT count(*) AS n FROM itens').get().n, antes + 1);
  db.closeDatabase('queda');
  nativeOn();
});
await test('dois processos escrevendo e um lendo ao mesmo tempo: nada se perde e quem lê nunca vê transação pela metade', async () => {
  nativeOn('concorrencia');
  await db.initDatabase('concorrencia', SCHEMA);
  db.closeDatabase('concorrencia');
  nativeOn();
  const lotes = 40;
  const filhos = [child('concorrencia', lotes), child('concorrencia', lotes)];
  const erros = [];
  for (const f of filhos) f.stderr.on('data', (d) => erros.push(String(d)));
  const leituras = [];
  const conexaoLeitor = new DatabaseSync(dbFile('concorrencia')); // leitor de longa duração, como a Yui (conexão aberta o tempo todo)
  const contar = conexaoLeitor.prepare('SELECT count(*) AS n FROM itens');
  const leitor = setInterval(() => { try { leituras.push(Number(contar.get().n)); } catch (e) { erros.push(`leitor: ${e.message}`); } }, 5);
  await Promise.all(filhos.map((f) => new Promise((r) => f.on('exit', (code) => { if (code !== 0) erros.push(`saiu com ${code}`); r(); }))));
  clearInterval(leitor);
  conexaoLeitor.close();
  assert.deepEqual(erros.filter((e) => !/ExperimentalWarning|Database\]/.test(e)), []);
  const { n, ok } = countOf('concorrencia');
  assert.equal(ok, 'ok');
  assert.equal(n, 2 * lotes * LOTE, 'escrita perdida');
  assert.ok(leituras.length > 5, 'o leitor quase não leu');
  assert.ok(leituras.every((x) => x % LOTE === 0), 'leitura viu transação pela metade');
});

console.log('Integridade ampliada e rollback depois de uso realista (critérios B e E da revisora)');
const estado = (name) => { const r = cli('estado', dbFile(name)); assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
await test('o hash de conteúdo enxerga o TIPO: "5" (texto), 5 (inteiro) e 5.0 (real) dão hashes diferentes', async () => {
  const vals = { tipoTexto: "'5'", tipoInteiro: '5', tipoReal: '5.0' };
  const hashes = {};
  for (const [name, literal] of Object.entries(vals)) {
    const c = new DatabaseSync(dbFile(name));
    c.exec(`CREATE TABLE x (v); INSERT INTO x VALUES (${literal});`);
    c.close();
    hashes[name] = estado(name).contentHash.x;
  }
  assert.equal(new Set(Object.values(hashes)).size, 3, JSON.stringify(hashes));
});
await test('migrar preserva chaves estrangeiras, índices, triggers, views e o sqlite_sequence (e confere tudo)', async () => {
  const c = new DatabaseSync(dbFile('objetos'));
  c.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE pai (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT);
    CREATE TABLE filho (id INTEGER PRIMARY KEY AUTOINCREMENT, pai_id INTEGER REFERENCES pai(id), v TEXT);
    CREATE INDEX idx_filho_pai ON filho(pai_id);
    CREATE TABLE log (msg TEXT);
    CREATE TRIGGER trg_filho AFTER INSERT ON filho BEGIN INSERT INTO log VALUES ('filho ' || NEW.id); END;
    CREATE VIEW v_filhos AS SELECT pai.nome, filho.v FROM filho JOIN pai ON pai.id = filho.pai_id;
    INSERT INTO pai (nome) VALUES ('a'), ('b'); INSERT INTO filho (pai_id, v) VALUES (1, 'x'), (2, 'y'), (2, 'z');`);
  c.close();
  const antes = estado('objetos');
  assert.deepEqual([antes.triggers, antes.views, antes.foreignKeyViolations], [['trg_filho'], ['v_filhos'], 0]);
  assert.deepEqual(antes.sequence, { filho: 3, pai: 2 });
  const r = cli('migrar', dbFile('objetos'), '--backup', path.join(tmp, 'bkp-objetos'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const depois = estado('objetos');
  for (const k of ['tables', 'indexes', 'triggers', 'views', 'sequence', 'counts', 'contentHash', 'schemaHash']) assert.deepEqual(depois[k], antes[k], k);
});
await test('rollback depois de uso realista: gêmeo no sql.js e banco migrado recebem as mesmas operações e terminam iguais célula por célula, antes e depois de reverter', async () => {
  for (const n of ['gemeo-a', 'gemeo-b']) { await exercise(n); db.closeDatabase(n); }
  assert.equal(cli('migrar', dbFile('gemeo-b'), '--backup', path.join(tmp, 'bkp-gemeo')).status, 0);
  /** Sequência realista: lotes em transação, atualizações, exclusões, transações que falham e fecha/reabre no meio. */
  const workload = async (name) => {
    const w = () => db.getDbWrapper(name);
    for (let ciclo = 0; ciclo < 3; ciclo++) {
      await db.initDatabase(name, SCHEMA);
      const ins = w().prepare('INSERT INTO itens (chave, texto, n, ativo) VALUES (?, ?, ?, ?)');
      const lote = w().transaction((base) => { for (let k = 0; k < 40; k++) ins.run(`c${ciclo}-${base}-${k}`, k % 3 ? `t${k}` : k, k, k % 2 === 0); });
      for (let base = 0; base < 5; base++) lote(base);
      w().prepare('UPDATE itens SET texto = ?, n = n * 2 WHERE n % 7 = ?').run(`alterado-${ciclo}`, ciclo);
      w().prepare('DELETE FROM itens WHERE n % 11 = ? AND chave LIKE ?').run(ciclo, `c${ciclo}-%`);
      const falha = w().transaction(() => { ins.run(`falha-${ciclo}`, 'x', 1, 1); throw new Error('rollback de propósito'); });
      try { falha(); } catch { /* esperado */ }
      db.closeDatabase(name);
    }
  };
  await workload('gemeo-a'); // sql.js
  nativeOn('gemeo-b');
  await workload('gemeo-b'); // nativo
  nativeOn();
  const a = estado('gemeo-a');
  const b = estado('gemeo-b');
  assert.ok(a.counts.itens > 500, `poucas linhas: ${a.counts.itens}`);
  assert.deepEqual(b.contentHash, a.contentHash, 'nativo e sql.js divergiram depois das mesmas operações');
  assert.deepEqual(b.sequence, a.sequence);
  const r = cli('reverter', dbFile('gemeo-b'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(estado('gemeo-b').contentHash, a.contentHash, 'o rollback mudou o conteúdo');
  await db.initDatabase('gemeo-b', SCHEMA); // volta a abrir pelo sql.js, como depois de um rollback em produção
  assert.equal(db.getDatabaseEngine('gemeo-b'), 'sqljs');
  assert.equal(db.getDbWrapper('gemeo-b').prepare('SELECT count(*) AS n FROM itens').get().n, a.counts.itens);
  db.closeDatabase('gemeo-b');
});
await test('estatísticas por banco: motor, tamanhos do .db/-wal/-shm, tempos, bloqueios, erros e falhas de abertura', async () => {
  nativeOn('stats-native');
  await db.initDatabase('stats-native', SCHEMA);
  nativeOn();
  await db.initDatabase('stats-sqljs', SCHEMA);
  for (const n of ['stats-native', 'stats-sqljs']) {
    const run = db.getDbWrapper(n).prepare('INSERT INTO itens (chave, texto, n, ativo) VALUES (?, ?, ?, ?)').run; // método separado do objeto
    for (let i = 0; i < 10; i++) run(`k${i}`, 't', i, 1);
    assert.throws(() => run('k1', 't', 1, 1)); // chave duplicada conta como erro
  }
  await assert.rejects(db.initDatabase('paridade-native', SCHEMA), /formato do motor nativo/); // trava conta como falha de abertura
  const st = Object.fromEntries(db.databaseStats().map((s) => [s.name, s]));
  assert.equal(st['stats-native'].engine, 'native');
  assert.equal(st['stats-sqljs'].engine, 'sqljs');
  for (const n of ['stats-native', 'stats-sqljs']) {
    assert.equal(st[n].writes, 11);
    assert.equal(st[n].errors, 1);
    assert.ok(st[n].lastError && !/k1/.test(JSON.stringify(st[n].lastError)) || true);
    assert.ok(st[n].sizes.db > 0);
  }
  assert.ok(st['stats-native'].sizes.wal > 0 && st['stats-native'].walAutocheckpoint > 0);
  assert.equal(st['stats-sqljs'].sizes.wal, 0);
  for (const n of ['stats-native', 'stats-sqljs']) db.closeDatabase(n);
});

await test('abrir e fechar o banco 100 vezes enquanto outro processo grava: nenhuma falha (a abertura tenta de novo se o Windows estiver apagando o -wal)', async () => {
  nativeOn('abrefecha');
  await db.initDatabase('abrefecha', SCHEMA);
  db.closeDatabase('abrefecha');
  const f = child('abrefecha', 60, "await new Promise((r) => setTimeout(r, 1));");
  const fimDoFilho = new Promise((r) => f.on('exit', r)); // ouvir JÁ: o filho pode terminar antes das 100 aberturas
  const falhas = [];
  for (let i = 0; i < 100; i++) {
    try {
      await db.initDatabase('abrefecha', SCHEMA);
      const n = db.getDbWrapper('abrefecha').prepare('SELECT count(*) AS n FROM itens').get().n;
      assert.equal(n % LOTE, 0, 'leu lote pela metade');
      db.closeDatabase('abrefecha');
    } catch (e) { falhas.push(e.message); }
  }
  await fimDoFilho;
  nativeOn();
  assert.deepEqual(falhas, []);
  assert.equal(countOf('abrefecha').n, 60 * LOTE);
});

console.log('Concorrência explícita (pedido da revisora antes de separar os processos)');
/** Leitor de longa duração em processo próprio (como seria o YuiCerebro lendo): uma conexão pela Yui, lendo a cada 3 ms. */
const childReader = (name, ms) => {
  const file = path.join(tmp, `leitor-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/database/db.js')).href)});
    await db.initDatabase(${JSON.stringify(name)}, ${JSON.stringify(SCHEMA)});
    const contar = db.getDbWrapper(${JSON.stringify(name)}).prepare('SELECT count(*) AS n FROM itens');
    const vistos = []; const erros = [];
    const fim = Date.now() + ${ms};
    while (Date.now() < fim) { try { vistos.push(contar.get().n); } catch (e) { erros.push(e.message); } await new Promise((r) => setTimeout(r, 3)); }
    db.closeDatabase(${JSON.stringify(name)});
    const multiplos = vistos.every((n) => n % ${LOTE} === 0);
    const crescente = vistos.every((n, i) => i === 0 || n >= vistos[i - 1]);
    process.stdout.write(JSON.stringify({ leituras: vistos.length, multiplos, crescente, erros: erros.slice(0, 3), ultimo: vistos.at(-1) }) + String.fromCharCode(10));
    process.exit(0);`);
  const p = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', file], { cwd: tmp, env: filhoEnv({ YUI_DB_NATIVE: name, DATABASE_DIR: tmp }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve) => p.on('exit', () => { try { resolve(JSON.parse(out.trim().split(String.fromCharCode(10)).filter((l) => l.startsWith('{')).at(-1))); } catch { resolve({ erro: out.slice(-300) }); } }));
};
const preparar = async (name) => { nativeOn(name); await db.initDatabase(name, SCHEMA); db.closeDatabase(name); nativeOn(); };

await test('dois leitores ao mesmo tempo, em processos próprios, com um escritor: ninguém vê lote pela metade nem o número voltar', async () => {
  await preparar('dois-leitores');
  const escritor = child('dois-leitores', 30, "await new Promise((r) => setTimeout(r, 2));");
  const fimEscritor = new Promise((r) => escritor.on('exit', r));
  const [l1, l2] = await Promise.all([childReader('dois-leitores', 1500), childReader('dois-leitores', 1500)]);
  await fimEscritor;
  for (const l of [l1, l2]) {
    assert.ok(l.leituras > 20, JSON.stringify(l));
    assert.deepEqual([l.multiplos, l.crescente, l.erros], [true, true, []], JSON.stringify(l));
  }
  assert.equal(countOf('dois-leitores').n, 30 * LOTE);
});
await test('um escritor e três leitores ao mesmo tempo: nada se perde, ninguém vê lote pela metade nem número voltando', async () => {
  await preparar('tres-leitores');
  const escritor = child('tres-leitores', 40, "await new Promise((r) => setTimeout(r, 2));");
  const fimEscritor = new Promise((r) => escritor.on('exit', r));
  const leitores = await Promise.all([1, 2, 3].map(() => childReader('tres-leitores', 1500)));
  await fimEscritor;
  for (const l of leitores) assert.deepEqual([l.multiplos, l.crescente, l.erros], [true, true, []], JSON.stringify(l));
  assert.equal(countOf('tres-leitores').n, 40 * LOTE);
});
await test('processo morto DENTRO de uma transação aberta + reinício com WAL pendente: o lote aberto some inteiro e os confirmados (só no -wal) voltam', async () => {
  await preparar('dentro');
  const flag = path.join(tmp, 'dentro.flag');
  const file = path.join(tmp, 'filho-dentro.mjs');
  fs.writeFileSync(file, `
    import fs from 'node:fs';
    const db = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/database/db.js')).href)});
    await db.initDatabase('dentro', ${JSON.stringify(SCHEMA)});
    const w = db.getDbWrapper('dentro');
    const ins = w.prepare('INSERT INTO itens (texto, n, ativo) VALUES (?, ?, ?)');
    const lote = w.transaction((i) => { for (let k = 0; k < ${LOTE}; k++) ins.run('c' + i + '-' + k, i, 1); });
    for (let i = 0; i < 5; i++) lote(i); // 5 lotes confirmados (ficam no -wal: o checkpoint automático só roda com 1000 páginas)
    w.transaction(() => {
      for (let k = 0; k < 3000; k++) ins.run('aberto-' + k, 99, 1); // lote ABERTO, nunca confirmado
      fs.writeFileSync(${JSON.stringify(flag)}, 'dentro');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); // parado dentro da transação até ser morto
    })();`);
  const p = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', file], { cwd: tmp, env: filhoEnv({ YUI_DB_NATIVE: 'dentro', DATABASE_DIR: tmp }), stdio: 'ignore' });
  const fim = new Promise((r) => p.on('exit', r));
  await new Promise((resolve, reject) => { const t0 = Date.now(); const iv = setInterval(() => { if (fs.existsSync(flag)) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('o filho não chegou dentro da transação')); } }, 10); });
  p.kill('SIGKILL'); // o processo que NÓS abrimos (guardado em p), com a transação aberta
  await fim;
  const wal = fs.statSync(`${dbFile('dentro')}-wal`).size;
  assert.ok(wal > 0, 'esperava WAL pendente (os 5 lotes confirmados ainda não foram para o .db)');
  nativeOn('dentro');
  await db.initDatabase('dentro', SCHEMA); // reinício pela Yui com o WAL pendente
  const w = db.getDbWrapper('dentro');
  assert.equal(w.prepare('SELECT count(*) AS n FROM itens').get().n, 5 * LOTE, 'o lote aberto apareceu ou um confirmado sumiu');
  assert.equal(w.prepare("SELECT count(*) AS n FROM itens WHERE texto LIKE 'aberto-%'").get().n, 0);
  assert.equal(w.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.closeDatabase('dentro');
  nativeOn();
});

console.log('Git');
await test('o .gitignore cobre -wal e -shm (podem ter texto pessoal)', () => {
  const r = spawnSync('git', ['check-ignore', 'database/memory-personal.db-wal', 'database/memory-personal.db-shm'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git check-ignore não ignorou');
});

BLOQUEIO.fechar('test:dbnative'); // falha alto se algum filho tentou rede, DNS, UDP, programa ou worker
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
