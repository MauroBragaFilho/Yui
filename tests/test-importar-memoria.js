// Teste do script scripts/importar-memoria-yui.mjs: simulação, gravação, repetição sem duplicar, conferência, token de membro nunca usado,
// desfazer só o lote e NENHUM token na saída. A API é a de verdade (em memória, numa pasta temporária); nada toca no banco real.
// Execução: node tests/test-importar-memoria.js
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-importar-memoria-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.MEMORY_RETENTION_DAYS = '30';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const { initMemory } = await import('../src/core/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const OWNER = 'owner-token-segredo-0123456789';
const MEMBER = 'member-token-segredo-0123456789';
const server = createApiServer({ tokens: parseTokens(`${MEMBER}=222,${OWNER}=111`) }); // o token de membro vem PRIMEIRO de propósito
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (token, method, route) => {
  const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const envFile = path.join(tmp, '.env');
fs.writeFileSync(envFile, `OUTRA=1\nYUI_API_TOKENS=${MEMBER}=222,${OWNER}=111\n`);
const ETIQUETA = 'lote-teste-2026';
const lote = [
  { type: 'project', content: 'Projeto de teste Alfa: um app de exemplo para o teste da importação.', tags: ['Alfa', ETIQUETA], importance: 3 },
  { type: 'preference', content: 'O Braga de teste prefere respostas diretas e práticas.', tags: ['preferencias', ETIQUETA], importance: 4 },
  { type: 'fact', content: 'Equipamento de teste: um notebook com 4 GB de RAM.', tags: ['equipamentos', ETIQUETA], importance: 2 },
];
const loteFile = path.join(tmp, 'lote.json');
fs.writeFileSync(loteFile, JSON.stringify(lote));
// ASSÍNCRONO de propósito: a API do teste roda NESTE processo, e uma chamada síncrona travaria o servidor enquanto o script espera a resposta dele.
const executar = (args) => new Promise((resolve) => {
  const filho = spawn(process.execPath, ['scripts/importar-memoria-yui.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true });
  let stdout = '';
  let stderr = '';
  filho.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  filho.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const limite = setTimeout(() => filho.kill(), 60_000);
  filho.on('close', (status) => { clearTimeout(limite); resolve({ status, stdout, stderr }); });
});
const roda = (...extra) => executar(['--url', base, '--env', envFile, ...extra]);
const saida = (r) => `${r.stdout}${r.stderr}`;
const donos = async () => (await call(OWNER, 'GET', '/v1/memory')).json.memories;

console.log('Importar memória na Yui');
await test('simulação: diz o que gravaria e NÃO grava nada', async () => {
  const r = await roda('--lote', loteFile);
  assert.equal(r.status, 0, saida(r));
  assert.match(saida(r), /simulação: nada será gravado/);
  assert.match(saida(r), /Novos: 3/);
  assert.equal((await donos()).length, 0);
});
await test('o token de membro nunca é usado: o dono é achado mesmo com o token de membro na frente', async () => {
  const r = await roda('--lote', loteFile);
  assert.match(saida(r), /Token do dono encontrado/);
  assert.notEqual((await call(MEMBER, 'GET', '/v1/memory')).json.scope, 'personal', 'o membro nunca tem a memória pessoal');
  assert.equal((await call(MEMBER, 'GET', '/v1/memory')).json.memories.length, 0, 'nada na memória do membro');
});
await test('--aplicar grava, confere e não mostra nenhum token', async () => {
  const r = await roda('--lote', loteFile, '--aplicar');
  assert.equal(r.status, 0, saida(r));
  assert.match(saida(r), /Gravados agora: 3/);
  assert.match(saida(r), /3 de 3 presentes/);
  const lista = await donos();
  assert.equal(lista.length, 3);
  assert.ok(lista.every((m) => String(m.tags).includes(ETIQUETA)), 'cada lembrança leva a etiqueta do lote');
  assert.ok(!saida(r).includes(OWNER) && !saida(r).includes(MEMBER), 'nenhum token na saída');
  assert.equal((await call(MEMBER, 'GET', '/v1/memory')).json.memories.length, 0, 'nada vazou para o membro');
});
await test('rodar de novo não duplica (já estão na memória)', async () => {
  const r = await roda('--lote', loteFile, '--aplicar');
  assert.equal(r.status, 0, saida(r));
  assert.match(saida(r), /Novos: 0/);
  assert.match(saida(r), /Gravados agora: 0/);
  assert.equal((await donos()).length, 3);
});
await test('--verificar (só leitura): a etiqueta acha exatamente o lote, dá o id de cada item e não grava nada', async () => {
  const mapa = path.join(tmp, 'mapa.json');
  const antes = (await donos()).length;
  const r = await roda('--verificar', '--lote', loteFile, '--saida', mapa);
  assert.equal(r.status, 0, saida(r));
  assert.match(saida(r), /acha 3 lembrança\(s\); o lote tem 3/);
  assert.match(saida(r), /a etiqueta acha EXATAMENTE os itens do lote/);
  const j = JSON.parse(fs.readFileSync(mapa, 'utf8'));
  assert.equal(j.exato, true);
  assert.equal(j.itens.length, 3);
  assert.ok(j.itens.every((x) => Number.isInteger(x.idNaYui) && x.comEtiqueta === true));
  assert.equal((await donos()).length, antes, 'não gravou nada');
  // uma lembrança nova (fora do lote) NÃO é achada pela etiqueta
  await fetch(`${base}/v1/memory`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'note', content: 'Lembrança posterior, fora do lote.', tags: ['posterior'], importance: 1 }) });
  const r2 = await roda('--verificar', '--lote', loteFile);
  assert.equal(r2.status, 0, saida(r2));
  assert.match(saida(r2), /Outras lembranças \(sem a etiqueta do lote, anteriores ou posteriores\): 1/);
  assert.match(saida(r2), /acha 3 lembrança/);
});
await test('desfazer: a simulação não apaga; com --aplicar apaga só o lote e deixa as outras lembranças', async () => {
  const outra = await fetch(`${base}/v1/memory`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'note', content: 'Uma lembrança que NÃO é do lote.', tags: ['outra'], importance: 1 }) });
  assert.equal(outra.status, 201);
  assert.equal((await donos()).length, 5);
  const sim = await roda('--desfazer', '--lote', loteFile);
  assert.equal(sim.status, 0, saida(sim));
  assert.match(saida(sim), /com a etiqueta "lote-teste-2026": 3/);
  assert.equal((await donos()).length, 5, 'simulação não apaga');
  const real = await roda('--desfazer', '--lote', loteFile, '--aplicar');
  assert.equal(real.status, 0, saida(real));
  assert.match(saida(real), /Apagadas: 3/);
  const resto = await donos();
  assert.equal(resto.length, 2, 'ficam a lembrança posterior e a que não é do lote');
  assert.ok(resto.some((m) => /NÃO é do lote/.test(m.content)));
});
await test('erros claros e sem vazar token: lote inválido, tipo inválido, token que não é do dono, API fora', async () => {
  fs.writeFileSync(path.join(tmp, 'ruim.json'), JSON.stringify([{ type: 'qualquer', content: 'x', tags: ['t'], importance: 3 }]));
  const a = await roda('--lote', path.join(tmp, 'ruim.json'));
  assert.equal(a.status, 1);
  assert.match(saida(a), /tipo inválido/);
  const envMembro = path.join(tmp, 'membro.env');
  fs.writeFileSync(envMembro, `YUI_API_TOKENS=${MEMBER}=222\n`);
  const b = await executar(['--url', base, '--env', envMembro, '--lote', loteFile, '--aplicar']);
  assert.equal(b.status, 1);
  assert.match(saida(b), /nenhum token do arquivo é do DONO/);
  assert.equal((await donos()).length, 2, 'nada foi gravado com token de membro');
  assert.ok(!saida(b).includes(MEMBER), 'o token de membro não aparece');
  const c = await executar(['--url', 'http://127.0.0.1:1', '--env', envFile, '--lote', loteFile]);
  assert.equal(c.status, 1);
  assert.match(saida(c), /a API da Yui não respondeu/);
  assert.ok(!saida(c).includes(OWNER));
});

await new Promise((r) => server.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
