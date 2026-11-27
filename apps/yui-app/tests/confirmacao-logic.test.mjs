// Correção C2 do parecer da Liz (27/11/2026): a chave de confirmação pela DM no app (aprovar um plano, reautorizar o Google). A lógica pura
// (src/confirmacaoLogic.ts), o cliente (o pedido da chave e a chave nas duas ações) e a ligação nas telas. Sem React e sem rede. Execução: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '../src/api/client.ts';
import { chavePronta, erroDaChave, mascaraDaChave, normalizarChave, textoDaChaveEnviada, TEXTOS_DA_CHAVE } from '../src/confirmacaoLogic.ts';

test('a chave digitada: só os dígitos contam; só 6 dígitos liberam o Confirmar; o campo mostra "482-913"', () => {
  assert.equal(normalizarChave(' 48-2 9.13 '), '482913');
  for (const ok of ['482913', '482-913', '482 913']) assert.equal(chavePronta(ok), true, ok);
  for (const ruim of ['', '48291', '4829134', 'abcdef', null, undefined]) assert.equal(chavePronta(ruim), false, String(ruim));
  assert.deepEqual(['4', '482', '4829', '482913', '4829137', '48a2-91 3'].map(mascaraDaChave), ['4', '482', '482-9', '482-913', '482-913', '482-913']);
});

test('o aviso depois de pedir (com a validade que o servidor deu) e quais erros são da chave (o campo fica aberto)', () => {
  assert.equal(textoDaChaveEnviada({ expiraEmSegundos: 300 }, TEXTOS_DA_CHAVE.paraAprovar), 'Mandei uma chave de 6 dígitos na sua DM para aprovar este plano. Ela vale 5 minutos e só pode ser usada uma vez.');
  assert.match(textoDaChaveEnviada({ expiraEmSegundos: 60 }, TEXTOS_DA_CHAVE.paraGoogle), /reautorizar o Google\. Ela vale 1 minuto e/);
  assert.match(textoDaChaveEnviada(null, 'x'), /vale 5 minutos/);
  assert.deepEqual([422, 428, 429, 400, 403, 404, 409, 502, null].map(erroDaChave), [true, true, true, false, false, false, false, false, false]);
});

test('o cliente: pede a chave (só a ação e o plano), manda a chave ao aprovar e ao começar a reautorização; sem chave, o corpo fica como antes', async () => {
  const pedidos = [];
  const { admin } = createClient({
    baseUrl: 'http://192.168.0.2:3939',
    token: 't',
    fetchImpl: async (url, init) => {
      pedidos.push([init.method, String(url).replace('http://192.168.0.2:3939', ''), init.body ? JSON.parse(init.body) : undefined]);
      return { ok: true, status: 200, json: async () => ({ ok: true, acao: 'x', expiraEmSegundos: 300, final: true, texto: 'ok' }) };
    },
  });
  await admin.pedirConfirmacao({ acao: 'plano.aprovar', plano: { id: 'a1b2c3d4e5f6', versao: 1, hash: 'abcdef0123456789' } });
  await admin.pedirConfirmacao({ acao: 'google.reautorizar' });
  await admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: true, confirmacao: '482913' });
  await admin.decidirPlano('a1b2c3d4e5f6', { versao: 1, hash: 'abcdef0123456789', aprovar: false });
  await admin.googleReautorizarInicio('482913');
  await admin.googleReautorizarInicio();
  assert.deepEqual(pedidos, [
    ['POST', '/v1/admin/confirmacao/pedir', { acao: 'plano.aprovar', plano: { id: 'a1b2c3d4e5f6', versao: 1, hash: 'abcdef0123456789' } }],
    ['POST', '/v1/admin/confirmacao/pedir', { acao: 'google.reautorizar' }],
    ['POST', '/v1/admin/planos/a1b2c3d4e5f6/decisao', { versao: 1, hash: 'abcdef0123456789', aprovar: true, confirmacao: '482913' }],
    ['POST', '/v1/admin/planos/a1b2c3d4e5f6/decisao', { versao: 1, hash: 'abcdef0123456789', aprovar: false }],
    ['POST', '/v1/admin/google/autorizar/inicio', { confirmacao: '482913' }],
    ['POST', '/v1/admin/google/autorizar/inicio', {}],
  ]);
});

test('as telas: aprovar pede a chave depois da confirmação e manda a chave; recusar não pede; o Google pede a chave antes do link; erro da chave mantém o campo', () => {
  const ler = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...rel.split('/')), 'utf8');
  const planos = ler('screens/AdminPlanos.tsx');
  assert.match(planos, /confirmAction\(c\.titulo, c\.mensagem, \(\) => \{ pedirChave\(p\); \}, c\.sim\)/);
  assert.match(planos, /client\.admin\.pedirConfirmacao\(\{ acao: 'plano\.aprovar', plano: \{ id: p\.id, versao: p\.versao, hash: String\(p\.hash \?\? ''\) \} \}\)/);
  assert.match(planos, /confirmar: \(p, c\) => \{ enviarDecisao\(p, true, c\); \}/);
  assert.match(planos, /if \(!aprovar\) \{\s+setChave\(null\);\s+enviarDecisao\(p, false\);/);
  assert.match(planos, /if \(confirmacao && e instanceof ApiError && erroDaChave\(e\.status\)\)/);
  const google = ler('screens/AdminGoogle.tsx');
  assert.match(google, /confirmAction\(c\.titulo, c\.mensagem, \(\) => \{ pedirChave\(\); \}, c\.sim\)/);
  assert.match(google, /client\.admin\.pedirConfirmacao\(\{ acao: 'google\.reautorizar' \}\)/);
  assert.match(google, /client\.admin\.googleReautorizarInicio\(confirmacao\)/);
  assert.doesNotMatch(google, /googleReautorizarInicio\(\)\)/, 'nenhum início sem a chave');
  const campo = ler('components/ChaveDaDm.tsx');
  assert.match(campo, /disabled=\{!chavePronta\(texto\)\}/);
  assert.match(campo, /onConfirmar\(normalizarChave\(texto\)\)/);
});
