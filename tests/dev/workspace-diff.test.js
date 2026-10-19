import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyDiff } from '../../src/core/dev/diff.js';
import { createWorkspaceFs } from '../../src/core/dev/workspace-fs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ws-'));
const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

test('diff: troca um trecho único e preserva o resto', () => {
  const out = applyDiff('a\nb\nc\n', block('b', 'B'));
  assert.equal(out.content, 'a\nB\nc\n');
});

test('diff: "$&", "$1" e "$$" no código novo ficam literais (bug do replace do Jarvis)', () => {
  const out = applyDiff('preco = 1\n', block('preco = 1', 'preco = "$&" + "$1" + "$$"'));
  assert.equal(out.content, 'preco = "$&" + "$1" + "$$"\n');
});

test('diff: SEARCH ambíguo ou ausente dá erro e NADA é gravado', () => {
  assert.throws(() => applyDiff('x\nx\n', block('x', 'y')), /2 vezes/);
  assert.throws(() => applyDiff('abc', block('zzz', 'y')), /não foi encontrado/);
  assert.throws(() => applyDiff('abc', 'sem blocos'), /Nenhum bloco/);
});

test('diff: tudo-ou-nada com vários blocos', () => {
  assert.throws(() => applyDiff('a\nb\n', `${block('a', 'A')}\n${block('nao existe', 'x')}`), /bloco 2/);
  const ok = applyDiff('a\nb\n', `${block('a', 'A')}\n${block('b', 'B')}`);
  assert.equal(ok.content, 'A\nB\n');
});

test('diff: tolera CRLF e espaços no fim das linhas', () => {
  const out = applyDiff('um  \r\ndois\r\n', block('um\ndois', 'UM\nDOIS'));
  assert.equal(out.content, 'UM\r\nDOIS\r\n');
});

test('workspace: pasta irmã com mesmo prefixo NÃO passa (bug do startsWith do Jarvis)', async () => {
  const base = tmp();
  const root = path.join(base, 'proj');
  const evil = path.join(base, 'proj-evil');
  fs.mkdirSync(root);
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'segredo.txt'), 'x');
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.readFile('../proj-evil/segredo.txt'), /fora do projeto/);
  await assert.rejects(w.readFile(path.join(evil, 'segredo.txt')), /fora do projeto/);
  await assert.rejects(w.writeFile('../proj-evil/novo.txt', 'x'), /fora do projeto/);
});

test('workspace: link simbólico/junção que aponta para fora é bloqueado', async (t) => {
  const base = tmp();
  const root = path.join(base, 'proj');
  const outside = path.join(base, 'fora');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'a.txt'), 'x');
  try {
    fs.symlinkSync(outside, path.join(root, 'atalho'), 'junction');
  } catch {
    t.skip('sem permissão para criar link');
    return;
  }
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.readFile('atalho/a.txt'), /fora do projeto/);
  await assert.rejects(w.writeFile('atalho/novo.txt', 'x'), /fora do projeto/);
});

test('workspace: arquivos sensíveis (.env, chaves) não são lidos nem gravados nem listados', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
  fs.writeFileSync(path.join(root, 'id_rsa'), 'x');
  fs.writeFileSync(path.join(root, 'ok.js'), '1');
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.readFile('.env'), /sensível/);
  await assert.rejects(w.readFile('id_rsa'), /sensível/);
  await assert.rejects(w.writeFile('.env', 'x'), /sensível/);
  await assert.rejects(w.writeFile('config/server.pem', 'x'), /sensível/);
  assert.deepEqual((await w.listDir('')).map((i) => i.name), ['ok.js']);
});

test('workspace: gravar cria backup em .yui/backups (não ao lado do arquivo) e é atômico', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.js'), 'v1');
  const w = await createWorkspaceFs(root);
  const res = await w.writeFile('a.js', 'v2');
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'v2');
  assert.match(res.backupPath, /^\.yui\/backups\//);
  assert.equal(fs.readFileSync(path.join(root, res.backupPath), 'utf8'), 'v1');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.bak') || n.endsWith('.tmp')), []);
  const created = await w.writeFile('novo/dir/b.js', 'x');
  assert.equal(created.created, true);
});

test('workspace: não grava em .git, node_modules nem .yui', async () => {
  const root = tmp();
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.writeFile('.git/config', 'x'), /não grava/);
  await assert.rejects(w.writeFile('node_modules/x/index.js', 'x'), /não grava/);
});

test('workspace: apply_diff grava com backup; erro de SEARCH não altera o arquivo', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.js'), 'let a = 1;\nlet b = 2;\n');
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.applyDiff('a.js', block('let c = 3;', 'x')), /não foi encontrado/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'let a = 1;\nlet b = 2;\n');
  const res = await w.applyDiff('a.js', block('let b = 2;', 'let b = 20;'));
  assert.equal(res.blocks, 1);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'let a = 1;\nlet b = 20;\n');
});

test('workspace: recusa binário e arquivo grande; busca de texto acha linhas', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
  fs.writeFileSync(path.join(root, 'code.js'), 'function soma(a, b) {\n  return a + b;\n}\n');
  const w = await createWorkspaceFs(root);
  await assert.rejects(w.readFile('bin.dat'), /binário/);
  await assert.rejects(w.readFile('big.txt'), /grande/);
  const hits = await w.searchText('SOMA');
  assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`), ['code.js:1']);
});
