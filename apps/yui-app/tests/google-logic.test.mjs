// Testes da reautorização do Google pelo painel (lacunas do painel, entrega F, item 14, 27/11/2026): quando o botão aparece, a confirmação, a conferência do
// endereço colado ANTES de mandar (a sessão do servidor é de uso único), o que mostrar depois do início e do retorno, o cliente da API (as duas rotas POST) e a
// ligação na tela (Admin > Integrações). Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import {
  ENDERECO_DO_RETORNO, INSTRUCOES_DA_REAUTORIZACAO, PORTA_DO_RETORNO, TEXTO_ENDERECO_ERRADO, TEXTO_GMAIL_NO_SCRIPT, TEXTO_SEM_ENDERECO, confirmacaoDeInicio, podeReautorizar,
  resultadoDoInicio, resultadoDoRetorno, validarEnderecoColado,
} from '../src/googleLogic.ts';

const AGORA = new Date(2026, 10, 27, 15, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const COLADO = `${ENDERECO_DO_RETORNO}/?state=${'ab'.repeat(24)}&code=4/0AeanS0-codigo-falso&scope=x`;

test('o botão só aparece com a chave (reautorizarPeloPainel: true); servidor antigo, sem resposta ou desligado: não aparece', () => {
  assert.equal(podeReautorizar({ reautorizarPeloPainel: true }), true);
  for (const g of [null, undefined, {}, { reautorizarPeloPainel: false }, { reautorizarPeloPainel: 'true' }]) assert.equal(podeReautorizar(g), false, JSON.stringify(g));
});

test('a porta e as instruções: a porta fixa do servidor e a frase "a página que não abre; copie o endereço inteiro dela e cole aqui"', () => {
  assert.equal(PORTA_DO_RETORNO, 47615);
  assert.equal(ENDERECO_DO_RETORNO, 'http://127.0.0.1:47615');
  const t = INSTRUCOES_DA_REAUTORIZACAO.join(' ');
  assert.match(t, /Depois de autorizar, o navegador vai mostrar uma página que não abre; copie o endereço inteiro dela e cole aqui\./);
  assert.match(t, /só Agenda e Tarefas, somente leitura/);
  assert.match(t, /vale uma vez só/);
  assert.ok(!/gmail/i.test(t), 'as instruções não falam em pedir o Gmail');
});

test('a confirmação de começar: diz o que acontece; com o Gmail no arquivo atual, avisa que ele fica para o script', () => {
  const sem = confirmacaoDeInicio({ reautorizarPeloPainel: true, escopos: ['agenda', 'tarefas'] });
  assert.equal(sem.titulo, 'Reautorizar o Google?');
  assert.match(sem.mensagem, /Agenda e as Tarefas \(somente leitura\)/);
  assert.match(sem.mensagem, /trocada pela nova/);
  assert.ok(!sem.mensagem.includes(TEXTO_GMAIL_NO_SCRIPT));
  const com = confirmacaoDeInicio({ reautorizarPeloPainel: true, escopos: ['agenda', 'tarefas', 'gmail'] });
  assert.ok(com.mensagem.includes(TEXTO_GMAIL_NO_SCRIPT));
  assert.match(TEXTO_GMAIL_NO_SCRIPT, /--gmail/);
  assert.equal(confirmacaoDeInicio(null).sim, 'Começar');
});

test('o endereço colado é conferido antes de mandar: o certo passa (com ou sem http://, com espaços nas pontas); vazio, outro host, outra porta, https, sem state ou sem code não saem', () => {
  assert.deepEqual(validarEnderecoColado(COLADO), { ok: true, endereco: COLADO });
  assert.deepEqual(validarEnderecoColado(`  ${COLADO}\n`), { ok: true, endereco: COLADO });
  const semProtocolo = COLADO.replace('http://', '');
  assert.deepEqual(validarEnderecoColado(semProtocolo), { ok: true, endereco: semProtocolo });
  assert.equal(validarEnderecoColado(`${ENDERECO_DO_RETORNO}?state=s123&error=access_denied`).ok, true, 'o Google disse que não foi concluída: o servidor responde com a frase');
  assert.deepEqual(validarEnderecoColado(''), { ok: false, erro: TEXTO_SEM_ENDERECO });
  assert.deepEqual(validarEnderecoColado(null), { ok: false, erro: TEXTO_SEM_ENDERECO });
  for (const errado of [
    COLADO.replace('127.0.0.1', 'localhost'), COLADO.replace('47615', '47616'), COLADO.replace('http://', 'https://'), `${ENDERECO_DO_RETORNO}/?code=4/abc-0123456789`,
    `${ENDERECO_DO_RETORNO}/?state=abc`, `${ENDERECO_DO_RETORNO}/`, `${ENDERECO_DO_RETORNO}/outra?state=a&code=b`, `${COLADO} mais`, `http://evil.example/?u=${ENDERECO_DO_RETORNO}/?state=a&code=b`,
    `${COLADO}${'x'.repeat(4100)}`, 'qualquer coisa',
  ]) assert.deepEqual(validarEnderecoColado(errado), { ok: false, erro: TEXTO_ENDERECO_ERRADO }, errado.slice(0, 80));
});

test('depois do início: o link, até quando vale e o aviso do Gmail; a falha mostra a frase do servidor; link que não é http(s) não aparece', () => {
  const r = resultadoDoInicio({ ok: true, link: 'http://127.0.0.1:9/o/oauth2/v2/auth?client_id=x', expiraEm: iso(AGORA.getTime() + 10 * 60_000), gmailFicaNoScript: false }, AGORA);
  assert.deepEqual(r, { ok: true, vista: { link: 'http://127.0.0.1:9/o/oauth2/v2/auth?client_id=x', validade: 'O link vale até hoje às 15:10.', gmail: null } });
  assert.equal(resultadoDoInicio({ ok: true, link: 'https://x/y', expiraEm: iso(AGORA.getTime()), gmailFicaNoScript: true }, AGORA).vista.gmail, TEXTO_GMAIL_NO_SCRIPT);
  assert.deepEqual(resultadoDoInicio({ ok: false, codigo: 'sem-arquivo', texto: 'Ainda não há autorização... use o script.' }), { ok: false, erro: 'Ainda não há autorização... use o script.' });
  assert.deepEqual(resultadoDoInicio({ ok: false, codigo: 'x', texto: '' }), { ok: false, erro: 'Não consegui começar a reautorização.' });
  assert.equal(resultadoDoInicio({ ok: true, link: 'javascript:alert(1)', expiraEm: '', gmailFicaNoScript: false }).ok, false);
  assert.equal(resultadoDoInicio(null), null);
});

test('depois do retorno: "Autorizado até <data>"; o que o Google não concedeu vira atenção; a falha é a frase do código fixo, em vermelho', () => {
  const ok = resultadoDoRetorno({ ok: true, codigo: 'autorizado', venceEm: iso(new Date(2026, 11, 4, 15, 0).getTime()), escopos: ['agenda', 'tarefas'], faltam: [], gmailFicaNoScript: false }, AGORA);
  assert.equal(ok.tom, 'ok');
  assert.match(ok.texto, /^Autorizado até 04\/12 às 15:00 \(7 dias, no modo Testando do Google\)\. A Agenda e as Tarefas voltam sozinhas\.$/);
  const parcial = resultadoDoRetorno({ ok: true, codigo: 'autorizado', venceEm: iso(AGORA.getTime()), escopos: ['tarefas'], faltam: ['agenda'], gmailFicaNoScript: true }, AGORA);
  assert.equal(parcial.tom, 'atencao');
  assert.match(parcial.texto, /não concedeu a Agenda; reautorize marcando todas as caixas/);
  assert.ok(parcial.texto.includes(TEXTO_GMAIL_NO_SCRIPT));
  assert.deepEqual(resultadoDoRetorno({ ok: false, codigo: 'state-diferente', texto: 'Esse endereço é de outra autorização. Comece de novo e use o link novo.' }), { texto: 'Esse endereço é de outra autorização. Comece de novo e use o link novo.', tom: 'critico' });
  assert.deepEqual(resultadoDoRetorno({ ok: false, codigo: 'erro', texto: '' }), { texto: 'Não deu certo. Comece de novo.', tom: 'critico' });
  assert.equal(resultadoDoRetorno(undefined), null);
});

test('cliente: POST /v1/admin/google/autorizar/inicio (sem dados) e /retorno ({ endereco }); os erros do servidor (403, 404, 429) chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: { ok: true, link: 'http://127.0.0.1:9/auth', expiraEm: iso(AGORA.getTime()), gmailFicaNoScript: false } };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  assert.equal((await c.admin.googleReautorizarInicio()).ok, true);
  assert.deepEqual(calls.at(-1), { url: 'http://yui.local:3939/v1/admin/google/autorizar/inicio', method: 'POST', body: {} });
  resposta = { status: 200, body: { ok: true, codigo: 'autorizado', venceEm: iso(AGORA.getTime()), escopos: ['agenda', 'tarefas'], faltam: [], gmailFicaNoScript: false } };
  assert.equal((await c.admin.googleReautorizarRetorno(COLADO)).codigo, 'autorizado');
  assert.deepEqual(calls.at(-1), { url: 'http://yui.local:3939/v1/admin/google/autorizar/retorno', method: 'POST', body: { endereco: COLADO } });
  resposta = { status: 429, body: { error: 'Muitas tentativas de reautorizar o Google nesta hora (o limite é 5). Espere e tente de novo.' } };
  await assert.rejects(() => c.admin.googleReautorizarInicio(), (e) => e instanceof ApiError && e.status === 429 && /^Muitas tentativas de reautorizar/.test(e.message));
  for (const status of [403, 404, 503]) {
    resposta = { status, body: { error: `erro ${status}` } };
    await assert.rejects(() => c.admin.googleReautorizarRetorno(COLADO), (e) => e instanceof ApiError && e.status === status, String(status));
  }
});

test('a tela: em Admin > Integrações, só com a chave; começar com confirmação; o endereço conferido antes de mandar; o link abre em outra aba; o resultado aparece', () => {
  const raiz = path.resolve(import.meta.dirname, '..', 'src', 'screens');
  const admin = fs.readFileSync(path.join(raiz, 'AdminScreen.tsx'), 'utf8');
  const integracoes = admin.slice(admin.indexOf('function Integracoes('), admin.indexOf('function GuildDetail('));
  assert.match(integracoes, /<ReautorizarGoogle client=\{client\} \/>/, 'o cartão fica na seção Integrações');
  assert.match(admin, /import \{ ReautorizarGoogle \} from '\.\/AdminGoogle\.tsx';/);
  const tela = fs.readFileSync(path.join(raiz, 'AdminGoogle.tsx'), 'utf8');
  assert.match(tela, /if \(!podeReautorizar\(google\)\) return null;/, 'sem a chave, nada aparece');
  // começar só depois da confirmação e da chave pela DM (correção C2; o detalhe está em confirmacao-logic.test.mjs)
  assert.match(tela, /confirmacaoDeInicio\(google\)[\s\S]*confirmAction\(c\.titulo, c\.mensagem, \(\) => \{ pedirChave\(\); \}, c\.sim\)/, 'começar só depois da confirmação');
  assert.match(tela, /client\.admin\.googleReautorizarInicio\(confirmacao\)/, 'o início leva a chave');
  assert.match(tela, /const v = validarEnderecoColado\(endereco\);\s*if \(!v\.ok\)/, 'o endereço é conferido antes de mandar');
  assert.match(tela, /client\.admin\.googleReautorizarRetorno\(v\.endereco\)/);
  assert.match(tela, /window\.open\(link, '_blank', 'noopener,noreferrer'\)/, 'o link abre em outra aba, sem referrer');
  assert.match(tela, /setResposta\(resultadoDoRetorno\(r\)\)/);
  assert.match(tela, /setVista\(null\); \/\/ uso único/, 'depois de mandar, o campo some (a sessão acabou)');
  for (const t of ['testID="google-reautorizar"', 'testID="google-abrir-link"', 'testID="google-endereco"', 'testID="google-enviar"', 'INSTRUCOES_DA_REAUTORIZACAO.map']) assert.ok(tela.includes(t), t);
  assert.ok(!/localStorage|AsyncStorage|setItem/.test(tela), 'nada da reautorização é guardado no aparelho');
});
