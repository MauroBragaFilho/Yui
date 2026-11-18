// Trava de dono dos bancos (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §3): src/database/ownerLock.js.
// Execução: npm run test:ownerlock
//
// Tudo numa pasta temporária: nenhum banco real é tocado. Os únicos processos encerrados aqui são os filhos que o
// próprio teste abriu, sempre pelo handle do spawn (nunca por PID achado em varredura).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { criarBloqueio } from './helpers/bloqueioExternoTeste.js';

const root = path.resolve(import.meta.dirname, '..');
const modPath = path.join(root, 'src', 'database', 'ownerLock.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-owner-lock-'));
// Etapa 8 (revisão da Liz): os filhos deste teste rodam sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers falham e ficam
// registrados) e NENHUMA exceção é declarada: eles só seguram uma trava de arquivo e respondem pela saída padrão.
const BLOQUEIO = criarBloqueio(path.join(tmp, 'bloqueio'), { teste: 'test:ownerlock', liberar: {} });
const {
  acquireOwnerLock, inspectOwnerLock, ownerLockStats, ownerLockPath, defaultQueryProcess,
  OWNER_HELD, OWNER_HUNG, PROCESS_START_MS,
} = await import('../src/database/ownerLock.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (name) => path.join(tmp, `${name}.db`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const staleFiles = (dbPath) => fs.readdirSync(path.dirname(dbPath)).filter((n) => n.startsWith(`${path.basename(dbPath)}.owner.stale-`));
const children = new Set();

/** Grava uma trava "de outro processo" à mão, com o batimento parado há ageMs. */
function writeForeignLock(dbPath, { pid = 424242, processStartMs = 1_700_000_000_000, hostname = os.hostname(), token = 'token-velho', ageMs = 120_000, raw = null } = {}) {
  const file = ownerLockPath(dbPath);
  const content = raw ?? JSON.stringify({ role: 'bot', pid, hostname, processStartMs, acquiredAt: new Date(Date.now() - ageMs).toISOString(), token });
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return { file, content };
}

function expectCode(fn, code) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `esperava erro ${code}, mas pegou a trava`);
  assert.equal(err.code, code, `código: ${err.code} (${err.message})`);
  return err;
}

/** Abre um filho node com um módulo ESM inline; guarda o handle para encerrar no fim (só pelo handle). */
function spawnChild(code, args = []) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, '--input-type=module', '-e', code, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_ENV: 'test', ...BLOQUEIO.env('filho') } });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { child.lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); child.emit('line'); }
  });
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { child.stderrText += d; });
  return child;
}
const waitLine = (child, pred, timeoutMs = 15_000) => new Promise((resolve, reject) => {
  const check = () => { const l = child.lines.find(pred); if (l !== undefined) { cleanup(); resolve(l); } };
  const timer = setTimeout(() => { cleanup(); reject(new Error(`filho não respondeu a tempo; stderr: ${child.stderrText.slice(0, 500)}`)); }, timeoutMs);
  const onExit = () => { cleanup(); reject(new Error(`filho saiu antes da hora; stderr: ${child.stderrText.slice(0, 500)}`)); };
  function cleanup() { clearTimeout(timer); child.off('line', check); child.off('exit', onExit); }
  child.on('line', check);
  child.on('exit', onExit);
  check();
});
const waitExit = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r)));

const MOD_URL = JSON.stringify(pathToFileURL(modPath).href);

try {
  console.log('Trava de dono');

  await test('grava papel, PID, máquina, hora de início do processo, hora da posse e token', () => {
    const dbPath = db('campos');
    const before = Date.now();
    const h = acquireOwnerLock(dbPath, { role: 'cerebro' });
    try {
      assert.equal(h.path, `${path.resolve(dbPath)}.owner`);
      const rec = readJson(h.path);
      assert.deepEqual(Object.keys(rec).sort(), ['acquiredAt', 'hostname', 'pid', 'processStartMs', 'role', 'token']);
      assert.equal(rec.role, 'cerebro');
      assert.equal(rec.pid, process.pid);
      assert.equal(rec.hostname, os.hostname());
      assert.equal(rec.processStartMs, PROCESS_START_MS);
      assert.ok(Math.abs(rec.processStartMs - (Date.now() - process.uptime() * 1000)) < 2000, 'hora de início do processo');
      assert.ok(Date.parse(rec.acquiredAt) >= before - 5 && Date.parse(rec.acquiredAt) <= Date.now() + 5, 'hora da posse');
      assert.match(rec.token, /^[0-9a-f]{32}$/);
      assert.equal(rec.token, h.token);
      assert.equal(h.held, true);
      assert.equal(h.takeover, false);
      assert.equal(h.record.token, undefined, 'o registro devolvido não expõe o token');
      const info = inspectOwnerLock(dbPath);
      assert.equal(info.exists, true);
      assert.equal(info.owner.pid, process.pid);
      assert.equal(info.owner.token, undefined, 'inspectOwnerLock não expõe o token');
      assert.equal(info.owner.hasToken, true);
      assert.equal(info.stale, false);
    } finally {
      assert.equal(h.release(), true);
    }
    assert.equal(fs.existsSync(h.path), false, 'release apaga a trava');
    assert.equal(h.release(), false, 'segundo release não faz nada');
    assert.equal(inspectOwnerLock(dbPath).exists, false);
  });

  await test('segunda abertura como dono é recusada com YUI_DB_OWNER_HELD (com o dono atual no erro)', () => {
    const dbPath = db('dupla');
    const h = acquireOwnerLock(dbPath, { role: 'bot' });
    try {
      const before = fs.readFileSync(h.path, 'utf8');
      const err = expectCode(() => acquireOwnerLock(dbPath, { role: 'cerebro' }), OWNER_HELD);
      assert.equal(err.owner.pid, process.pid);
      assert.equal(err.owner.role, 'bot');
      assert.equal(err.owner.token, undefined, 'o erro não carrega o token do dono');
      assert.ok(!err.message.includes(h.token), 'a mensagem não carrega o token');
      assert.equal(err.lockPath, h.path);
      assert.equal(fs.readFileSync(h.path, 'utf8'), before, 'a recusa não altera a trava');
    } finally { h.release(); }
  });

  await test('5 processos filhos disputando ao mesmo tempo: exatamente 1 vence (3 rodadas)', async () => {
    const childCode = `
      import { acquireOwnerLock } from ${MOD_URL};
      const [dbPath] = process.argv.slice(1);
      let held = null; let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        buf += d;
        const m = buf.match(/go (\\d+)/);
        if (!m || held !== null) return;
        held = false;
        const at = Number(m[1]);
        setTimeout(() => {
          while (Date.now() < at) { /* barreira: todos tentam no mesmo milissegundo */ }
          try { held = acquireOwnerLock(dbPath, { role: 'bot' }); console.log(JSON.stringify({ ok: true })); }
          catch (e) { console.log(JSON.stringify({ ok: false, code: e.code })); }
        }, Math.max(0, at - Date.now() - 20));
      });
      process.stdin.on('end', () => { if (held) held.release(); process.exit(0); });
      console.log('pronto');`;
    for (let round = 1; round <= 3; round++) {
      const dbPath = db(`corrida-${round}`);
      const kids = Array.from({ length: 5 }, () => spawnChild(childCode, [dbPath]));
      await Promise.all(kids.map((k) => waitLine(k, (l) => l === 'pronto')));
      const at = Date.now() + 300;
      for (const k of kids) k.stdin.write(`go ${at}\n`);
      const results = (await Promise.all(kids.map((k) => waitLine(k, (l) => l.startsWith('{'))))).map((l) => JSON.parse(l));
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1, `rodada ${round}: ${JSON.stringify(results)}`);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.code === OWNER_HELD), `rodada ${round}: ${JSON.stringify(results)}`);
      for (const k of kids) k.stdin.end();
      await Promise.all(kids.map(waitExit));
      assert.equal(fs.existsSync(ownerLockPath(dbPath)), false, `rodada ${round}: o vencedor liberou ao sair`);
    }
    // Disputa pela RETOMADA de uma trava abandonada (PID ímpar: no Windows os PIDs são múltiplos de 4, então não existe).
    for (let round = 1; round <= 3; round++) {
      const dbPath = db(`corrida-retomada-${round}`);
      writeForeignLock(dbPath, { pid: 424_243, token: `abandonada-${round}` });
      const kids = Array.from({ length: 5 }, () => spawnChild(childCode, [dbPath]));
      await Promise.all(kids.map((k) => waitLine(k, (l) => l === 'pronto')));
      const at = Date.now() + 300;
      for (const k of kids) k.stdin.write(`go ${at}\n`);
      const results = (await Promise.all(kids.map((k) => waitLine(k, (l) => l.startsWith('{'))))).map((l) => JSON.parse(l));
      assert.equal(results.filter((r) => r.ok).length, 1, `retomada ${round}: ${JSON.stringify(results)}`);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.code === OWNER_HELD), `retomada ${round}: ${JSON.stringify(results)}`);
      const stale = staleFiles(dbPath);
      assert.equal(stale.length, 1, `retomada ${round}: uma só trava velha guardada (${stale.join(', ')})`);
      assert.equal(readJson(path.join(tmp, stale[0])).token, `abandonada-${round}`);
      const mutexLeft = fs.readdirSync(tmp).filter((n) => n.startsWith(`${path.basename(dbPath)}.owner.takeover`));
      assert.deepEqual(mutexLeft, [], 'o mutex da retomada não sobra');
      for (const k of kids) k.stdin.end();
      await Promise.all(kids.map(waitExit));
    }
  });

  await test('mutex da retomada: recente bloqueia (recusa); sobra velha de retomada que caiu é recolhida', () => {
    const dbPath = db('mutex');
    writeForeignLock(dbPath, { pid: 424_243 });
    const mutex = `${ownerLockPath(dbPath)}.takeover`;
    fs.writeFileSync(mutex, '{"pid":1}');
    const err = expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: false }) }), OWNER_HELD);
    assert.match(err.reason, /retomando/);
    assert.equal(readJson(ownerLockPath(dbPath)).token, 'token-velho', 'a trava velha continua no lugar');
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(mutex, old, old);
    const h = acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: false }) });
    try {
      assert.equal(h.takeover, true);
      assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith(`${path.basename(dbPath)}.owner.takeover`)), [], 'nenhuma sobra do mutex');
    } finally { h.release(); }
  });

  await test('trava velha de processo morto: retoma e a velha vira .owner.stale-<hora>', () => {
    const dbPath = db('morto');
    const { content } = writeForeignLock(dbPath, { pid: 424242 });
    const asked = [];
    const h = acquireOwnerLock(dbPath, { role: 'cerebro', queryProcess: (pid) => { asked.push(pid); return { alive: false, startMs: null }; } });
    try {
      assert.deepEqual(asked, [424242]);
      assert.equal(h.takeover, true);
      assert.match(path.basename(h.staleFile), /\.owner\.stale-\d+-[0-9a-f]{6}$/);
      assert.equal(fs.readFileSync(h.staleFile, 'utf8'), content, 'a velha foi preservada com outro nome');
      assert.equal(readJson(h.path).token, h.token);
      assert.deepEqual(staleFiles(dbPath), [path.basename(h.staleFile)]);
    } finally { h.release(); }
  });

  await test('PID reaproveitado (vivo, com outra hora de início): retoma; dentro da tolerância de 3 s: recusa', () => {
    const dbPath = db('pid-reaproveitado');
    const start = 1_700_000_000_000;
    writeForeignLock(dbPath, { pid: 4321, processStartMs: start });
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: true, startMs: start + 2_500 }) }), OWNER_HUNG);
    const h = acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: true, startMs: start + 3_600_000 }) });
    try {
      assert.equal(h.takeover, true);
      assert.equal(readJson(h.staleFile).token, 'token-velho');
    } finally { h.release(); }
  });

  await test('vivo com a mesma hora de início e batimento parado: recusa YUI_DB_OWNER_HUNG e não encerra nada', async () => {
    // (a) dublê: mesma hora de início
    const dbPath = db('travado');
    const start = 1_700_000_000_000;
    const { content } = writeForeignLock(dbPath, { pid: 777, processStartMs: start });
    const err = expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: true, startMs: start + 1_000 }) }), OWNER_HUNG);
    assert.equal(err.owner.pid, 777);
    assert.ok(err.heartbeatAgeMs >= 119_000);
    assert.equal(fs.readFileSync(ownerLockPath(dbPath), 'utf8'), content, 'a trava do dono travado fica intacta');
    assert.deepEqual(staleFiles(dbPath), [], 'nada foi renomeado');
    // (b) hora de início indisponível (consulta falhou) com processo vivo: não arrisca, recusa
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: true, startMs: null }) }), OWNER_HUNG);
    // (c) consulta que lança erro: tratada como vivo sem prova, recusa
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => { throw new Error('falhou'); } }), OWNER_HUNG);
    // (d) trava de outra máquina: nem consulta (não dá para saber de processo remoto), recusa
    const other = db('outra-maquina');
    writeForeignLock(other, { hostname: 'OUTRA-MAQUINA' });
    let asked = 0;
    expectCode(() => acquireOwnerLock(other, { role: 'bot', queryProcess: () => { asked += 1; return { alive: false }; } }), OWNER_HUNG);
    assert.equal(asked, 0);

    // (e) processo REAL vivo (um filho deste teste), com a consulta padrão: recusa, e o filho continua vivo
    const sleeper = spawnChild("setInterval(() => {}, 1000); console.log('vivo');");
    await waitLine(sleeper, (l) => l === 'vivo');
    const q = defaultQueryProcess(sleeper.pid);
    assert.equal(q.alive, true);
    assert.ok(Number.isFinite(q.startMs), 'hora de início do filho consultada');
    const realDb = db('travado-real');
    writeForeignLock(realDb, { pid: sleeper.pid, processStartMs: q.startMs });
    const signals = [];
    const originalKill = process.kill;
    process.kill = (pid, sig) => { signals.push([pid, sig]); return originalKill.call(process, pid, sig); };
    try {
      expectCode(() => acquireOwnerLock(realDb, { role: 'bot' }), OWNER_HUNG);
    } finally { process.kill = originalKill; }
    assert.ok(signals.length >= 1, 'consultou o processo');
    assert.ok(signals.every(([pid, sig]) => pid === sleeper.pid && sig === 0), `só sinal 0 (consulta): ${JSON.stringify(signals)}`);
    await sleep(300);
    assert.equal(sleeper.exitCode, null, 'o filho continua vivo');
    assert.equal(sleeper.signalCode, null, 'o filho continua vivo');
    assert.equal(defaultQueryProcess(sleeper.pid).alive, true);
    sleeper.kill(); // encerra o filho que o próprio teste abriu, pelo handle
    await waitExit(sleeper);
  });

  await test('release não apaga a trava de outro token; o batimento percebe a perda (onLost)', async () => {
    const dbPath = db('outro-token');
    const lost = [];
    const h = acquireOwnerLock(dbPath, { role: 'bot', heartbeatMs: 50, staleMs: 1000, onLost: (info) => lost.push(info) });
    const foreign = JSON.stringify({ role: 'cerebro', pid: 999, hostname: os.hostname(), processStartMs: 1, acquiredAt: new Date().toISOString(), token: 'outro' });
    fs.writeFileSync(h.path, foreign);
    await sleep(200);
    assert.equal(lost.length, 1, 'onLost chamado uma vez');
    assert.equal(lost[0].owner.pid, 999);
    assert.equal(h.held, false);
    assert.equal(h.release(), false, 'release devolve false');
    assert.equal(fs.readFileSync(h.path, 'utf8'), foreign, 'a trava do outro token ficou intacta');
    fs.rmSync(h.path);

    // Mesmo sem o batimento ter rodado: release confere o token antes de apagar.
    const h2 = acquireOwnerLock(dbPath, { role: 'bot' });
    fs.writeFileSync(h2.path, foreign);
    assert.equal(h2.release(), false);
    assert.equal(fs.readFileSync(h2.path, 'utf8'), foreign);
    fs.rmSync(h2.path);
  });

  await test('trava ilegível: recente é recusada; sem batimento é retomada', () => {
    const dbPath = db('ilegivel');
    writeForeignLock(dbPath, { raw: '', ageMs: 0 });
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => assert.fail('não consulta processo sem PID') }), OWNER_HELD);
    writeForeignLock(dbPath, { raw: '{quebrado', ageMs: 120_000 });
    const h = acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => assert.fail('não consulta processo sem PID') });
    try { assert.equal(h.takeover, true); } finally { h.release(); }
  });

  await test('queda real: filho com batimento de 200 ms é encerrado à força; depois do prazo, retoma com a consulta real', async () => {
    const dbPath = db('queda-real');
    const childCode = `
      import { acquireOwnerLock } from ${MOD_URL};
      const h = acquireOwnerLock(process.argv[1], { role: 'bot', heartbeatMs: 200, staleMs: 1500 });
      console.log(JSON.stringify({ pid: process.pid, token: h.token }));
      setInterval(() => {}, 1000);`;
    const child = spawnChild(childCode, [dbPath]);
    const info = JSON.parse(await waitLine(child, (l) => l.startsWith('{')));
    assert.equal(info.pid, child.pid);
    const lockFile = ownerLockPath(dbPath);
    const m1 = fs.statSync(lockFile).mtimeMs;
    await sleep(700);
    const m2 = fs.statSync(lockFile).mtimeMs;
    assert.ok(m2 > m1, 'o batimento renova a data de modificação');
    expectCode(() => acquireOwnerLock(dbPath, { role: 'cerebro', heartbeatMs: 200, staleMs: 1500 }), OWNER_HELD);

    child.kill('SIGKILL'); // queda: o teste encerra À FORÇA o filho que ele mesmo abriu, pelo handle
    await waitExit(child);
    assert.ok(fs.existsSync(lockFile), 'a queda deixou a trava para trás');
    // Logo depois da queda o batimento ainda é recente: recusa.
    expectCode(() => acquireOwnerLock(dbPath, { role: 'cerebro', heartbeatMs: 200, staleMs: 1500 }), OWNER_HELD);
    const lastBeat = fs.statSync(lockFile).mtimeMs;
    await sleep(Math.max(0, lastBeat + 1700 - Date.now()));
    const h = acquireOwnerLock(dbPath, { role: 'cerebro', heartbeatMs: 200, staleMs: 1500 }); // consulta REAL
    try {
      assert.equal(h.takeover, true);
      assert.equal(readJson(h.staleFile).token, info.token, 'a velha (do filho) foi preservada como .stale');
      assert.equal(readJson(h.path).pid, process.pid);
    } finally { h.release(); }
  });

  await test('o código-fonte não tem nenhuma chamada que encerre processo', () => {
    const src = fs.readFileSync(modPath, 'utf8');
    for (const bad of [/taskkill/i, /Stop-Process/i, /SIGKILL/, /SIGTERM/, /SIGINT/, /SIGHUP/, /TerminateProcess/i, /\.terminate\(/, /\bkill\s+-\d/, /\bpkill\b/, /\bkillall\b/]) {
      assert.doesNotMatch(src, bad, `achei ${bad}`);
    }
    const kills = [...src.matchAll(/\bkill\s*\(([^)]*)\)/g)].map((m) => m[0].replace(/\s+/g, ''));
    assert.ok(kills.length >= 1, 'a consulta de existência usa process.kill(pid, 0)');
    assert.ok(kills.every((k) => k === 'kill(pid,0)'), `só sinal 0: ${kills.join(', ')}`);
    assert.equal([...src.matchAll(/process\.kill/g)].length, kills.length, 'nenhum process.kill fora do padrão (ex.: por referência)');
  });

  await test('estatísticas: acquired, refused, takeovers, hung e o último conflito', () => {
    const before = ownerLockStats();
    const dbPath = db('estatisticas');
    const h = acquireOwnerLock(dbPath, { role: 'bot' });
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot' }), OWNER_HELD);
    let s = ownerLockStats();
    assert.equal(s.lastConflict.kind, 'refused');
    assert.equal(s.lastConflict.code, OWNER_HELD);
    assert.equal(s.lastConflict.owner.token, undefined, 'o último conflito não carrega token');
    h.release();
    writeForeignLock(dbPath, { pid: 555 });
    expectCode(() => acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: true, startMs: 1_700_000_000_000 }) }), OWNER_HUNG);
    s = ownerLockStats();
    assert.equal(s.lastConflict.kind, 'hung');
    const h2 = acquireOwnerLock(dbPath, { role: 'bot', queryProcess: () => ({ alive: false, startMs: null }) });
    h2.release();
    const after = ownerLockStats();
    assert.equal(after.acquired - before.acquired, 2);
    assert.equal(after.refused - before.refused, 2);
    assert.equal(after.hung - before.hung, 1);
    assert.equal(after.takeovers - before.takeovers, 1);
    assert.equal(after.released - before.released, 2);
    assert.equal(after.lastConflict.kind, 'takeover');
    assert.equal(after.lastConflict.owner.pid, 555);
    assert.ok(after.lastConflict.staleFile.includes('.owner.stale-'));
    // A cópia devolvida não altera o estado interno.
    after.acquired = -1;
    assert.notEqual(ownerLockStats().acquired, -1);
  });

  await test('parâmetros inválidos são recusados antes de tocar no disco', () => {
    assert.throws(() => acquireOwnerLock(db('sem-papel'), {}), TypeError);
    assert.throws(() => acquireOwnerLock(db('prazo'), { role: 'bot', heartbeatMs: 1000, staleMs: 500 }), RangeError);
    assert.equal(fs.existsSync(ownerLockPath(db('sem-papel'))), false);
  });

  console.log(`\n${passed} verificações de trava de dono passaram.`);
  BLOQUEIO.conferir('test:ownerlock'); // falha alto se algum filho tentou rede, DNS, UDP, programa ou worker
  console.log(`  bloqueio de integração externa nos filhos: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
} finally {
  for (const c of children) { try { c.kill(); } catch { /* já saiu */ } } // só filhos deste teste, pelo handle
  await Promise.all([...children].map(waitExit));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
