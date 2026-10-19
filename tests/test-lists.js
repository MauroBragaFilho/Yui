// Listas por conversa natural: armazenamento (JSON por usuário) e interpretação de pedidos. Sem rede, sem Discord.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createListStore, listSlug, cleanText, formatList, LIST_LIMITS, ListError } from '../src/handlers/listStore.js';
import { parseListRequest, runListRequest, splitItems } from '../src/handlers/listAssistant.js';

let ok = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FALHA', name, '\n       ', e?.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-listas-'));
let clock = 1_000;
const mk = (sub) => createListStore({ dir: path.join(tmp, sub), now: () => ++clock });
const U1 = '111111111111111111';
const U2 = '222222222222222222';

console.log('A. Armazenamento');
await test('slug e limpeza de texto', () => {
  assert.equal(listSlug('Lista de Compras!'), 'lista-de-compras');
  assert.equal(listSlug('  ../../etc/passwd '), 'etc-passwd');
  assert.equal(listSlug('Ação & Aventura'), 'acao-aventura');
  assert.equal(cleanText('a\u0000b\u202Ec\n\n  d', 20), 'a b c d');
  assert.equal(Array.from(cleanText('😀'.repeat(10), 3)).length, 3);
});
await test('adiciona, mostra, remove por posição e por texto, marca feito', async () => {
  const s = mk('a');
  const r = await s.addItems(U1, 'Compras', ['Leite', 'Pão', 'leite', '  ']);
  assert.deepEqual([r.added, r.duplicated, r.total], [2, 1, 2]);
  const l = await s.getList(U1, 'compras');
  assert.deepEqual(l.items.map((i) => i.text), ['Leite', 'Pão']);
  await s.setDone(U1, 'compras', 2);
  assert.equal((await s.getList(U1, 'compras')).items[1].done, true);
  assert.equal((await s.removeItem(U1, 'compras', 1)).removed, 'Leite');
  assert.equal((await s.removeItem(U1, 'compras', 'PÃO')).total, 0);
  await assert.rejects(s.removeItem(U1, 'compras', 5), /não achei/i);
});
await test('cada pessoa só vê as suas (arquivos separados)', async () => {
  const s = mk('b');
  await s.addItems(U1, 'segredo', ['a']);
  assert.equal(await s.getList(U2, 'segredo'), null);
  assert.deepEqual(await s.listLists(U2), []);
  assert.ok(fs.existsSync(path.join(s.dir, `${U1}.json`)));
  assert.ok(!fs.existsSync(path.join(s.dir, `${U2}.json`)));
});
await test('userId inválido (caminho) é recusado; nome de lista nunca vira caminho', async () => {
  const s = mk('c');
  await assert.rejects(s.addItems('../../x', 'l', ['a']), (e) => e instanceof ListError && e.code === 'USER');
  await s.addItems(U1, '../../evil', ['a']);
  assert.deepEqual(fs.readdirSync(s.dir), [`${U1}.json`]);
});
await test('limites de itens, listas e tamanho do item', async () => {
  const s = mk('d');
  await s.addItems(U1, 'x', Array.from({ length: LIST_LIMITS.maxItems }, (_, i) => `i${i}`));
  await assert.rejects(s.addItems(U1, 'x', ['mais']), /itens/);
  for (let i = 0; i < LIST_LIMITS.maxLists - 1; i++) await s.addItems(U2, `l${i}`, ['a']);
  await s.addItems(U2, 'ultima', ['a']);
  await assert.rejects(s.addItems(U2, 'estoura', ['a']), /listas/);
  const r = await s.addItems('333333333333333333', 'g', ['z'.repeat(5000)]);
  assert.equal((await s.getList('333333333333333333', 'g')).items[0].text.length, LIST_LIMITS.maxItemChars);
  assert.equal(r.added, 1);
});
await test('gravações simultâneas do mesmo usuário não se perdem (fila por usuário)', async () => {
  const s = mk('e');
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.addItems(U1, 'par', [`item ${i}`])));
  assert.equal((await s.getList(U1, 'par')).items.length, 25);
});
await test('arquivo corrompido: guarda cópia e recomeça sem lançar', async () => {
  const s = mk('f');
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, `${U1}.json`), '{quebrado');
  assert.deepEqual(await s.listLists(U1), []);
  assert.ok(fs.readdirSync(s.dir).some((f) => f.includes('corrompido')));
  await s.addItems(U1, 'nova', ['a']);
  assert.equal((await s.listLists(U1)).length, 1);
});
await test('gravação atômica: nenhum .tmp sobra e o JSON é legível', async () => {
  const s = mk('g');
  await s.addItems(U1, 'l', ['a', 'b']);
  assert.ok(!fs.readdirSync(s.dir).some((f) => f.endsWith('.tmp')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, `${U1}.json`), 'utf8')).lists.l.items.length, 2);
});
await test('exporta JSON da lista e de todas', async () => {
  const s = mk('h');
  await s.addItems(U1, 'um', ['a']);
  await s.addItems(U1, 'dois', ['b', 'c']);
  assert.deepEqual(JSON.parse(await s.exportJson(U1, 'dois')).items.map((i) => i.text), ['b', 'c']);
  assert.equal(JSON.parse(await s.exportJson(U1)).lists.length, 2);
});
await test('formatList neutraliza @ e <>', () => {
  const t = formatList({ name: '@everyone', items: [{ n: 1, text: '<@123> oi @here', done: false }] });
  assert.ok(!/@everyone/.test(t) && !/<@/.test(t) && !/@here/.test(t));
});

console.log('B. Interpretação de pedidos');
const P = parseListRequest;
await test('anotar: itens depois de dois-pontos, vírgulas, linhas e marcadores', () => {
  assert.deepEqual(P('anota na lista de compras: leite, pão e manteiga'), { action: 'add', listName: 'compras', items: ['leite', 'pão e manteiga'] });
  assert.deepEqual(P('Yui, anota na lista Filmes: Matrix\n- Alien\n2. Duna').items, ['Matrix', 'Alien', 'Duna']);
  assert.deepEqual(P('adiciona leite na lista de mercado'), { action: 'add', listName: 'mercado', items: ['leite'] });
  assert.equal(P('coloca pão, ovos na minha lista de compras').items.length, 2);
  assert.equal(P('anota na lista de Ideias de Mods: A, B').listName, 'Ideias de Mods');
});
await test('mostrar, listar listas, apagar, esvaziar, tirar, marcar', () => {
  assert.deepEqual(P('mostra a lista de compras'), { action: 'show', listName: 'compras' });
  assert.deepEqual(P('o que tem na lista de filmes?'), { action: 'show', listName: 'filmes' });
  assert.deepEqual(P('quais são as minhas listas?'), { action: 'lists' });
  assert.deepEqual(P('apaga a lista de compras'), { action: 'delete', listName: 'compras' });
  assert.deepEqual(P('esvazia a lista de compras'), { action: 'clear', listName: 'compras' });
  assert.deepEqual(P('tira o item 3 da lista de compras'), { action: 'remove', position: 3, listName: 'compras' });
  assert.deepEqual(P('tira leite da lista de compras'), { action: 'remove', which: 'leite', listName: 'compras' });
  assert.deepEqual(P('marca o item 2 da lista de compras como feito'), { action: 'done', position: 2, listName: 'compras', done: true });
  assert.deepEqual(P('me manda a lista de compras em json'), { action: 'export', listName: 'compras' });
  assert.deepEqual(P('exporta todas as minhas listas em json'), { action: 'export', all: true });
});
await test('conversa comum NÃO vira pedido de lista', () => {
  for (const t of ['oi yui, tudo bem?', 'anota isso pra mim', 'qual a lista de espera do hospital?', 'a lista de convidados é grande', 'faz uma lista dos melhores jogos de 2020', 'minha lista de reprodução está ótima', 'apaga isso', 'mostra o carro mais rápido', '']) {
    assert.equal(P(t), null, t);
  }
});
await test('entrada hostil e gigante termina rápido', () => {
  const t0 = Date.now();
  for (const x of ['lista '.repeat(5000), 'anota na lista ' + 'a'.repeat(100000), 'tira ' + 'x '.repeat(3000) + 'da lista y', 'anota ' + 'a '.repeat(2000) + ' na lista ' + 'b '.repeat(2000)]) P(x);
  assert.ok(Date.now() - t0 < 1500, `levou ${Date.now() - t0} ms`);
});
await test('splitItems', () => {
  assert.deepEqual(splitItems('a, b;c\n• d\n3) e'), ['a', 'b', 'c', 'd', 'e']);
});

console.log('C. Execução ponta a ponta (respostas em português)');
await test('fluxo completo', async () => {
  const store = mk('z');
  const run = (text, user = U1) => runListRequest({ text, userId: user, store });
  assert.match(await run('anota na lista de compras: leite, pão'), /Anotei 2 itens na lista \*\*compras\*\*/);
  assert.match(await run('anota ovos na lista de compras'), /Anotei 1 item/);
  assert.match(await run('mostra a lista de compras'), /1\. leite\n2\. pão\n3\. ovos/);
  assert.match(await run('marca o item 2 da lista de compras como comprado'), /Marquei "pão"/);
  assert.match(await run('tira o item 1 da lista de compras'), /Tirei "leite"/);
  assert.match(await run('minhas listas'), /compras/);
  assert.match(await run('me manda a lista de compras em json'), /```json[\s\S]*"ovos"/);
  assert.match(await run('mostra a lista de compras', U2), /Não achei essa lista/);
  assert.match(await run('apaga a lista de compras'), /Apaguei a lista/);
  assert.equal(await run('que dia é hoje?'), null);
  assert.match(await run('anota na lista:'), /Qual é o nome|O que eu anoto/);
});
await test('erro interno vira mensagem educada (sem vazar caminho)', async () => {
  const quebrado = { listLists: async () => { throw new Error('EACCES D:/segredo/x.json'); } };
  const r = await runListRequest({ text: 'minhas listas', userId: U1, store: quebrado });
  assert.ok(!/EACCES|segredo/.test(r));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ok} teste(s) ok, ${fail} falha(s).`);
process.exit(fail ? 1 : 0);
