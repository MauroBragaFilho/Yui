// Etapa 8, rodada de fechamento depois da 3ª revisão da Liz (§14 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md, §15): a REUTILIZAÇÃO CANCELADA por outra pessoa.
//
// Quem só aproveitava uma busca idêntica e PÚBLICA em andamento ficava sem resultado se quem a iniciou (o "dono" dela) a cancelava. A regra da Liz: quem esperava pode
// fazer a PRÓPRIA busca, com cobrança normal, SE (a) obtiver uma reserva própria e válida (limite por pessoa, teto global e a porta de saída), (b) o cancelamento não
// foi pedido por ele mesmo nem imposto por política de segurança (e o prazo esgotado não conta), e (c) a nova execução tiver identidade própria: a reserva, o diário e a
// chave de idempotência são do esperador, nunca os do cancelado. No máximo UMA nova tentativa por esperador (sem laço); vários esperadores do mesmo cancelamento se
// juntam numa única nova busca (um lidera, os outros aproveitam; uma chamada externa, uma cobrança). A pesquisa PRIVADA continua fora de qualquer compartilhamento.
//
//  A. A razão do cancelamento é uma palavra fixa (dono, politica, prazo, desconhecida) e vai no resultado.
//  B. O dono cancela ANTES e DEPOIS do despacho: o esperador faz a própria busca, com a reserva dele (o dono fica com a cobrança só se já tinha despachado).
//  C. Três esperadores (A, B e C): UMA nova chamada externa, UMA cobrança (de quem lidera); B e C aproveitam sem cobrança e a reutilização é contada.
//  D. NÃO repete: o esperador que cancelou o próprio pedido; cancelamento por política; prazo esgotado (o da cadeia e o do pedido); razão desconhecida.
//  E. NÃO repete sem reserva própria: porta de saída fechada, limite por pessoa estourado, teto global estourado (e quem tem reserva lidera no lugar de quem não tem).
//  F. Uma nova tentativa só (sem laço): se a nova busca também for cancelada, ninguém tenta uma terceira vez.
//  G. A pesquisa PRIVADA nunca é compartilhada, aproveitada nem refeita; o cancelamento nunca vai para o cache.
//  H. O diário e a reserva do esperador são DELE (arquivos, chaves e marcas da cota separados dos do cancelado).
// SEM rede (o "buscador" é um fetch falso; o bloqueio de integração externa vale no CI), SEM arquivos reais (a cota em disco e o diário ficam numa pasta temporária).
// Execução: npm run test:buscacancelada   (node tests/test-busca-cancelada.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-busca-cancelada-'));
Object.assign(process.env, { DATABASE_DIR: path.join(T, 'db'), YUI_SEARCH_BUDGET_FILE: path.join(T, 'padrao', 'search-budget.json'), LOG_LEVEL: 'error' });
for (const k of ['YUI_COTA_HORA_DISCO', 'YUI_SEARCH_USER_PER_HOUR', 'YUI_SEARCH_GLOBAL_PER_HOUR', 'YUI_SEARCH_CACHE_TTL_MIN', 'YUI_PESQUISA_RETOMADA']) delete process.env[k];

const { createBudget } = await import('../src/search/budget.js');
const { searchWeb, resetCooldowns } = await import('../src/search/providers.js');
const { CancelamentoDeBusca, RAZOES_DE_CANCELAMENTO, cancelarBusca, razaoDoCancelamento, repeteAposCancelamento } = await import('../src/search/cancelamento.js');
const { ERRO_PESQUISA_INDISPONIVEL } = await import('../src/search/indisponivel.js');
const { createRetomadaDePesquisa, chaveProtegida, arquivoDaPessoa } = await import('../src/cerebro/pesquisaRetomada.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(10); }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${what}`);
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
/** O ambiente de busca: só o SearXNG (um buscador falso, sem rede), 5 por pessoa e 20 no global por hora. */
const ENV = { SEARXNG_URL: 'http://127.0.0.1:8080/', YUI_SEARCH_PROVIDERS: 'searxng', YUI_SEARCH_USER_PER_HOUR: '5', YUI_SEARCH_GLOBAL_PER_HOUR: '20' };
const Q = 'consulta que todo mundo faz ao mesmo tempo';

/** Um fetch que fica PENDURADO até a chamada ser abortada (como o fetch de verdade): o dono da busca "ainda está esperando o buscador". */
const penduradoAte = (signal) => new Promise((_, rejeita) => {
  const aborta = () => rejeita(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  if (signal?.aborted) aborta(); else signal?.addEventListener('abort', aborta, { once: true });
});
/** O "buscador": conta cada chamada que CHEGA a ele; `pendura` = os números das chamadas que ficam penduradas até serem abortadas; o resto responde na hora. */
function buscador({ pendura = [1] } = {}) {
  const b = {
    chamadas: [],
    fetchImpl: async (url, { signal } = {}) => {
      const n = b.chamadas.push({ q: new URL(String(url)).searchParams.get('q') });
      if (pendura.includes(n)) await penduradoAte(signal);
      return json({ results: [{ title: `Resultado da chamada ${n}`, url: `https://exemplo.invalid/chamada-${n}`, content: 'trecho' }] });
    },
  };
  return b;
}
/** Um cenário: a cota REAL (em disco, numa pasta temporária), o buscador falso e a busca. */
function cenario(nome, { env = {}, pendura = [1] } = {}) {
  resetCooldowns();
  const dir = path.join(T, nome);
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'search-budget-hora.json');
  const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
  budget.persistirHora(arquivo);
  const b = buscador({ pendura });
  const e = { ...ENV, ...env };
  const buscar = (q, o = {}) => searchWeb(q, { logger: quiet, env: e, fetchImpl: b.fetchImpl, budget, ...o });
  const hora = () => { try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return { usuarios: {}, global: [] }; } };
  return {
    dir, arquivo, budget, b, buscar, env: e, hora,
    usado: (u) => budget.userStatus(u, e).used,
    global: () => budget.globalStatus(e).used,
    /** a pessoa começa a busca e o teste espera o buscador receber a chamada (o sinal real de que ela despachou) */
    async dono(q, o = {}) {
      const ctl = new AbortController();
      const p = buscar(q, { signal: ctl.signal, ...o });
      await waitUntil(() => b.chamadas.length >= 1, 5000, 'o dono despachar a busca');
      return { ctl, p };
    },
  };
}
const canceladaPor = (r, razao, onde) => {
  assert.deepEqual(r.results, [], onde);
  assert.ok(r.errors.some((x) => /cancelado|esgotado/.test(x)), `${onde}: ${JSON.stringify(r.errors)}`);
  assert.equal(r.cancelamento, razao, `${onde}: a razão do cancelamento é uma palavra fixa`);
};
const urlDa = (r) => r.results?.[0]?.url;

try {
  // ═════════════════════════════════════════════════════════════════════════════════════
  section('A. A razão do cancelamento: uma palavra fixa, no signal.reason e no resultado');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('razaoDoCancelamento: dono e politica pelo motivo tipado; prazo pelo TimeoutError; qualquer outra coisa é desconhecida (e só o dono repete)', () => {
    assert.deepEqual(Object.values(RAZOES_DE_CANCELAMENTO).sort(), ['desconhecida', 'dono', 'politica', 'prazo']);
    assert.equal(razaoDoCancelamento(new CancelamentoDeBusca('dono')), 'dono');
    assert.equal(razaoDoCancelamento(new CancelamentoDeBusca('politica')), 'politica');
    assert.equal(razaoDoCancelamento(new CancelamentoDeBusca('qualquer coisa')), 'desconhecida', 'razão fora da lista = desconhecida');
    assert.equal(razaoDoCancelamento(new CancelamentoDeBusca()), 'desconhecida');
    assert.equal(razaoDoCancelamento(new DOMException('tempo esgotado', 'TimeoutError')), 'prazo');
    for (const r of [undefined, null, 'dono', { razao: 'dono' }, { name: 'CancelamentoDeBusca', razao: 'dono' }, new Error('cancelado'), new DOMException('abortado', 'AbortError')]) {
      assert.equal(razaoDoCancelamento(r), 'desconhecida', `${String(r)}: sem o motivo tipado de verdade, é desconhecida`);
    }
    const ctl = new AbortController();
    cancelarBusca(ctl, 'dono');
    assert.equal(ctl.signal.aborted, true);
    assert.equal(razaoDoCancelamento(ctl.signal.reason), 'dono');
    assert.deepEqual(Object.values(RAZOES_DE_CANCELAMENTO).filter(repeteAposCancelamento), ['dono'], 'só a desistência de quem iniciou a busca é repetida');
  });

  await test('o resultado cancelado leva a razão como palavra fixa: dono, politica, prazo (do pedido e da cadeia) e desconhecida; sem cancelamento, nenhuma razão', async () => {
    for (const [rotulo, motivo, esperada] of [
      ['dono', () => new CancelamentoDeBusca('dono'), 'dono'],
      ['política', () => new CancelamentoDeBusca('politica'), 'politica'],
      ['prazo do pedido', () => new DOMException('tempo esgotado', 'TimeoutError'), 'prazo'],
      ['abort() sem motivo', () => undefined, 'desconhecida'],
      ['Error qualquer', () => new Error('cancelado'), 'desconhecida'],
    ]) {
      const c = cenario(`a-${rotulo.replace(/\W/g, '')}`, { pendura: [] });
      const ctl = new AbortController();
      ctl.abort(motivo());
      const r = await c.buscar('a razão', { userId: 'u', signal: ctl.signal });
      canceladaPor(r, esperada, `cancelada ANTES de sair (${rotulo})`);
      assert.equal(c.b.chamadas.length, 0, 'nada saiu');
      assert.equal(c.usado('u'), 0, 'cancelada antes de sair: sem cobrança');
    }
    // o prazo da CADEIA (deadline): a razão é prazo
    const c = cenario('a-prazo-cadeia', { pendura: [1] });
    const r = await c.buscar('prazo da cadeia', { userId: 'u', deadlineMs: 500 });
    canceladaPor(r, 'prazo', 'prazo da cadeia');
    assert.ok(r.errors.some((x) => /esgotado/.test(x)), JSON.stringify(r.errors));
    // sem cancelamento: nenhuma razão; e uma busca que deu resultado não leva razão mesmo com o signal dado
    const ok = cenario('a-sem-cancelamento', { pendura: [] });
    const normal = await ok.buscar('normal', { userId: 'u', signal: new AbortController().signal });
    assert.equal(normal.provider, 'searxng');
    assert.equal(normal.cancelamento, undefined);
    assert.equal(normal.refeita, undefined);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('B. O dono cancela antes e depois do despacho: o esperador faz a PRÓPRIA busca, com a reserva dele');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('o dono cancela DEPOIS do despacho: o esperador refaz a busca (uma chamada nova, cobrada dele); o dono fica com a cobrança de quem já despachou', async () => {
    const c = cenario('b-depois');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    assert.equal(c.b.chamadas.length, 1, 'A só está esperando a busca do dono (nenhuma chamada nova ainda)');
    assert.equal(c.usado('A'), 0, 'e ainda não pagou nada');
    cancelarBusca(ctl, 'dono');
    const [rDono, rA] = await Promise.all([pDono, pA]);
    canceladaPor(rDono, 'dono', 'o dono');
    assert.equal(rA.provider, 'searxng', JSON.stringify(rA));
    assert.equal(urlDa(rA), 'https://exemplo.invalid/chamada-2', 'o resultado de A veio da NOVA chamada, não da cancelada');
    assert.equal(rA.refeita, true, 'marcada como a nova busca de quem esperava');
    assert.equal(rA.cancelamento, undefined);
    assert.equal(c.b.chamadas.length, 2, 'a cancelada (que saiu) + UMA nova');
    assert.equal(c.usado('dono'), 1, 'o dono já tinha despachado: a cobrança fica');
    assert.equal(c.usado('A'), 1, 'A pagou a PRÓPRIA busca, uma vez');
    assert.equal(c.global(), 2);
    const h = c.hora();
    assert.equal(h.global.length, 2, 'duas marcas no disco');
    assert.deepEqual(Object.values(h.usuarios).map((l) => l.length).sort(), [1, 1], 'cada um com a própria marca (duas chaves diferentes)');
    assert.equal(c.budget.reutilizadas(), 0, 'A não reutilizou nada: fez a própria busca');
  });

  await test('o dono cancela ANTES do despacho: o dono recebe a vaga de volta, o esperador faz a busca e paga só a dele', async () => {
    const c = cenario('b-antes', { pendura: [] });
    const ctl = new AbortController();
    cancelarBusca(ctl, 'dono'); // já cancelada quando o searchWeb começa: nada sai
    const pDono = c.buscar(Q, { userId: 'dono', signal: ctl.signal });
    const pA = c.buscar(Q, { userId: 'A' }); // na mesma hora: a busca do dono ainda está no mapa (é a que A vai esperar)
    const [rDono, rA] = await Promise.all([pDono, pA]);
    canceladaPor(rDono, 'dono', 'o dono cancelou antes de sair');
    assert.equal(rA.provider, 'searxng', JSON.stringify(rA));
    assert.equal(rA.refeita, true);
    assert.equal(urlDa(rA), 'https://exemplo.invalid/chamada-1', 'a única chamada externa foi a de A');
    assert.equal(c.b.chamadas.length, 1, 'UMA chamada externa só');
    assert.equal(c.usado('dono'), 0, 'o dono cancelou antes de sair: sem despacho, sem cobrança');
    assert.equal(c.usado('A'), 1, 'A pagou a própria');
    assert.equal(c.global(), 1);
    assert.equal(c.hora().global.length, 1, 'só a marca de A ficou no disco (a do dono foi devolvida)');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('C. Três esperadores do mesmo cancelamento: UMA nova busca (um lidera, os outros aproveitam)');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('A, B e C esperam a busca do dono e ele cancela: só UMA chamada nova, UMA cobrança (de quem lidera); B e C aproveitam sem cobrança e a reutilização é contada', async () => {
    const c = cenario('c-tres');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    const pB = c.buscar(Q, { userId: 'B' });
    const pC = c.buscar(Q, { userId: 'C' });
    assert.equal(c.b.chamadas.length, 1, 'os três só esperam');
    cancelarBusca(ctl, 'dono');
    const [rDono, rA, rB, rC] = await Promise.all([pDono, pA, pB, pC]);
    canceladaPor(rDono, 'dono', 'o dono');
    for (const [nome, r] of [['A', rA], ['B', rB], ['C', rC]]) {
      assert.equal(r.provider, 'searxng', `${nome}: ${JSON.stringify(r)}`);
      assert.equal(urlDa(r), 'https://exemplo.invalid/chamada-2', `${nome}: todos recebem o resultado da MESMA nova busca`);
      assert.equal(r.limited, undefined);
    }
    assert.equal(c.b.chamadas.length, 2, 'a cancelada + UMA nova: nada de três buscas');
    assert.equal(c.usado('dono'), 1);
    assert.equal(c.usado('A'), 1, 'A liderou a nova busca: pagou uma vez');
    assert.equal(c.usado('B'), 0, 'B só aproveitou: sem cobrança');
    assert.equal(c.usado('C'), 0, 'C só aproveitou: sem cobrança');
    assert.equal(c.global(), 2, 'duas cobranças no total: a do dono e a de quem liderou');
    assert.equal(c.hora().global.length, 2);
    assert.equal(c.budget.reutilizadas(), 2, 'B e C contam como reutilização (não como busca nova)');
    assert.equal(rA.refeita, true);
  });

  await test('o líder é o primeiro esperador que PODE (quem não tem reserva não lidera e o seguinte assume): a nova busca é UMA só e a cobrança é de quem liderou', async () => {
    const c = cenario('c-lider', { env: { YUI_SEARCH_USER_PER_HOUR: '1' } });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    const pB = c.buscar(Q, { userId: 'B' });
    const pC = c.buscar(Q, { userId: 'C' });
    // enquanto espera, A gasta o único lugar dele da hora em OUTRA consulta (a reserva própria dele acaba antes de ele poder refazer a busca)
    const rOutra = await c.buscar('outra consulta de A', { userId: 'A' });
    assert.equal(rOutra.provider, 'searxng');
    assert.equal(c.b.chamadas.length, 2, 'a do dono (pendurada) + a "outra consulta" de A');
    cancelarBusca(ctl, 'dono');
    const [, rA, rB, rC] = await Promise.all([pDono, pA, pB, pC]);
    assert.equal(rA.limited, 'user', 'A não tem mais reserva: não refaz (e não leva a busca de ninguém)');
    assert.deepEqual(rA.results, []);
    assert.equal(rB.provider, 'searxng', 'B tem reserva: lidera a nova busca');
    assert.equal(urlDa(rB), 'https://exemplo.invalid/chamada-3');
    assert.equal(urlDa(rC), 'https://exemplo.invalid/chamada-3', 'C aproveita a busca de B');
    assert.equal(c.b.chamadas.length, 3, 'só UMA chamada nova');
    assert.equal(c.usado('A'), 1, 'A só pagou a "outra consulta"');
    assert.equal(c.usado('B'), 1, 'B liderou e pagou');
    assert.equal(c.usado('C'), 0);
    assert.equal(c.global(), 3, 'dono + a outra consulta de A + a nova busca de B');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('D. NÃO repete: o esperador cancelou o próprio pedido, política, prazo, razão desconhecida');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('o esperador que CANCELOU o próprio pedido não refaz a busca (o signal dele abortou); quem não cancelou refaz', async () => {
    const c = cenario('d-propria');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const ctlA = new AbortController();
    const pA = c.buscar(Q, { userId: 'A', signal: ctlA.signal });
    const pB = c.buscar(Q, { userId: 'B' });
    cancelarBusca(ctlA, 'dono'); // A desistiu do pedido dele (mesmo com a razão "dono": é a vontade DELE, não a de quem iniciou a busca)
    cancelarBusca(ctl, 'dono');
    const [, rA, rB] = await Promise.all([pDono, pA, pB]);
    assert.deepEqual(rA.results, [], 'A não recebe a nova busca: ele mesmo cancelou');
    assert.equal(c.usado('A'), 0, 'A não pagou nada');
    assert.equal(rB.provider, 'searxng', 'B não cancelou: refaz');
    assert.equal(urlDa(rB), 'https://exemplo.invalid/chamada-2');
    assert.equal(c.b.chamadas.length, 2, 'a cancelada + UMA nova (a de B)');
    assert.equal(c.usado('B'), 1);
  });

  await test('cancelamento por POLÍTICA, por PRAZO (do pedido e da cadeia) e por razão DESCONHECIDA: ninguém refaz a busca, ninguém paga mais, e quem esperava recebe o resultado cancelado como antes', async () => {
    for (const [rotulo, motivo, esperada] of [
      ['politica', () => new CancelamentoDeBusca('politica'), 'politica'],
      ['prazo do pedido', () => new DOMException('tempo esgotado', 'TimeoutError'), 'prazo'],
      ['abort sem motivo', () => undefined, 'desconhecida'],
      ['Error qualquer', () => new Error('motivo sem tipo'), 'desconhecida'],
      ['razão fora da lista', () => new CancelamentoDeBusca('inventada'), 'desconhecida'],
    ]) {
      const c = cenario(`d-${rotulo.replace(/\W/g, '')}`);
      const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
      const pA = c.buscar(Q, { userId: 'A' });
      const pB = c.buscar(Q, { userId: 'B' });
      ctl.abort(motivo());
      const [rDono, rA, rB] = await Promise.all([pDono, pA, pB]);
      canceladaPor(rDono, esperada, `o dono (${rotulo})`);
      for (const [nome, r] of [['A', rA], ['B', rB]]) {
        canceladaPor(r, esperada, `${nome} recebe o cancelado, como hoje (${rotulo})`);
        assert.equal(r.refeita, undefined, `${nome}: nada foi refeito`);
      }
      assert.equal(c.b.chamadas.length, 1, `${rotulo}: NENHUMA chamada nova`);
      assert.equal(c.usado('A'), 0, `${rotulo}: A não pagou`);
      assert.equal(c.usado('B'), 0, `${rotulo}: B não pagou`);
      assert.equal(c.global(), 1, `${rotulo}: só a cobrança do dono`);
      assert.equal(c.budget.reutilizadas(), 2, `${rotulo}: segue contando como reutilização, como hoje`);
    }
    // o PRAZO da cadeia (o deadline do searchWeb): o prazo esgotado NÃO é cancelamento do dono; segue como hoje
    const c = cenario('d-deadline');
    const pDono = c.buscar(Q, { userId: 'dono', deadlineMs: 500 });
    await waitUntil(() => c.b.chamadas.length >= 1, 5000, 'o dono despachar');
    const pA = c.buscar(Q, { userId: 'A' });
    const [rDono, rA] = await Promise.all([pDono, pA]);
    canceladaPor(rDono, 'prazo', 'prazo da cadeia do dono');
    canceladaPor(rA, 'prazo', 'A recebe o mesmo resultado (o prazo não é cancelamento do dono)');
    assert.equal(c.b.chamadas.length, 1, 'prazo esgotado: nenhuma busca nova');
    assert.equal(c.usado('A'), 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('E. NÃO repete sem reserva própria: porta fechada, limite por pessoa, teto global');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('PORTA DE SAÍDA fechada (sem o dono da cota) na hora de refazer: nenhuma chamada nova, nada cobrado, o aviso de indisponível com o motivo fixo', async () => {
    const c = cenario('e-porta');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    const pB = c.buscar(Q, { userId: 'B' });
    c.budget.definirDespacho(false, 'trava-de-outro-processo'); // este processo perdeu o dono da cota enquanto esperava
    cancelarBusca(ctl, 'dono');
    const [, rA, rB] = await Promise.all([pDono, pA, pB]);
    for (const [nome, r] of [['A', rA], ['B', rB]]) {
      assert.equal(r.indisponivel, true, `${nome}: ${JSON.stringify(r)}`);
      assert.equal(r.motivo, 'trava-de-outro-processo');
      assert.deepEqual(r.errors, [ERRO_PESQUISA_INDISPONIVEL]);
      assert.deepEqual(r.results, []);
    }
    assert.equal(c.b.chamadas.length, 1, 'a porta fechada: nenhuma chamada nova');
    assert.equal(c.usado('A'), 0);
    assert.equal(c.usado('B'), 0);
    assert.equal(c.global(), 1, 'só a cobrança do dono (que já tinha despachado)');
  });

  await test('LIMITE POR PESSOA estourado: quem não tem reserva não refaz (nenhuma chamada por ele); o seguinte, com reserva, lidera', async () => {
    const c = cenario('e-limite', { env: { YUI_SEARCH_USER_PER_HOUR: '1' } });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    const pB = c.buscar(Q, { userId: 'B' });
    await c.buscar('outra de A', { userId: 'A' }); // A usa o único lugar da hora enquanto espera
    assert.equal(c.usado('A'), 1);
    cancelarBusca(ctl, 'dono');
    const [, rA, rB] = await Promise.all([pDono, pA, pB]);
    assert.equal(rA.limited, 'user');
    assert.deepEqual(rA.errors, ['limite de buscas por usuário atingido']);
    assert.equal(c.usado('A'), 1, 'A não gastou além do que já tinha');
    assert.equal(rB.provider, 'searxng');
    assert.equal(c.b.chamadas.length, 3, 'a do dono, a "outra de A" e a nova de B');
  });

  await test('TETO GLOBAL estourado na hora de refazer: ninguém refaz, nenhuma chamada nova, nada cobrado', async () => {
    const c = cenario('e-global', { env: { YUI_SEARCH_GLOBAL_PER_HOUR: '2' } });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    const pB = c.buscar(Q, { userId: 'B' });
    await c.buscar('outra de X', { userId: 'X' }); // o 2º lugar do teto global
    assert.equal(c.global(), 2);
    cancelarBusca(ctl, 'dono');
    const [, rA, rB] = await Promise.all([pDono, pA, pB]);
    for (const [nome, r] of [['A', rA], ['B', rB]]) {
      assert.ok(r.limited, `${nome}: recusada pelo teto: ${JSON.stringify(r)}`);
      assert.deepEqual(r.results, []);
    }
    assert.equal(c.b.chamadas.length, 2, 'a do dono e a de X: nenhuma chamada nova');
    assert.equal(c.global(), 2);
    assert.equal(c.usado('A') + c.usado('B'), 0);
  });

  await test('o registro da cota que NÃO grava: o esperador não refaz (falhar fechado), nenhuma chamada nova', async () => {
    const c = cenario('e-registro');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    // o "disco cheio" simulado: o arquivo da cota por hora vira uma pasta (o rename por cima falha)
    fs.rmSync(c.arquivo, { force: true });
    fs.mkdirSync(c.arquivo);
    cancelarBusca(ctl, 'dono');
    const [, rA] = await Promise.all([pDono, pA]);
    assert.equal(rA.indisponivel, true, JSON.stringify(rA));
    assert.equal(rA.motivo, 'registro-da-cota');
    assert.equal(c.b.chamadas.length, 1);
    assert.equal(c.usado('A'), 0, 'a reserva foi desfeita');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('F. Uma nova tentativa só (sem laço)');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('se a NOVA busca também for cancelada, ninguém tenta uma terceira vez: B e C (que a aproveitavam) recebem o cancelado, sem cobrança e sem chamada nova', async () => {
    const c = cenario('f-sem-laco', { pendura: [1, 2] });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const ctlA = new AbortController();
    const pA = c.buscar(Q, { userId: 'A', signal: ctlA.signal });
    const pB = c.buscar(Q, { userId: 'B' });
    const pC = c.buscar(Q, { userId: 'C' });
    cancelarBusca(ctl, 'dono');
    await waitUntil(() => c.b.chamadas.length >= 2, 5000, 'A (o líder) despachar a nova busca');
    cancelarBusca(ctlA, 'dono'); // quem liderou desiste da nova busca também
    const [, rA, rB, rC] = await Promise.all([pDono, pA, pB, pC]);
    canceladaPor(rA, 'dono', 'A (a nova busca cancelada)');
    for (const [nome, r] of [['B', rB], ['C', rC]]) {
      canceladaPor(r, 'dono', `${nome} recebe o cancelamento da nova busca, sem tentar de novo`);
      assert.equal(r.refeita, true, `${nome}: é o resultado da nova busca (cancelada)`);
    }
    assert.equal(c.b.chamadas.length, 2, 'a original + a nova: nenhuma terceira');
    assert.equal(c.usado('B'), 0);
    assert.equal(c.usado('C'), 0);
    assert.equal(c.usado('A'), 1, 'A despachou a nova busca: a cobrança dele fica');
    assert.equal(c.global(), 2);
  });

  await test('ninguém fica esperando para sempre: o mapa das buscas em andamento esvazia (uma busca igual depois do cancelamento começa do zero)', async () => {
    const c = cenario('f-mapa', { pendura: [1] });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    cancelarBusca(ctl, 'dono');
    await Promise.all([pDono, pA]);
    // depois de tudo, uma consulta igual NÃO se junta a nada: é uma busca nova, cobrada
    const depois = await c.buscar(Q, { userId: 'D' });
    assert.equal(depois.provider, 'searxng');
    assert.equal(depois.refeita, undefined);
    assert.equal(urlDa(depois), 'https://exemplo.invalid/chamada-3');
    assert.equal(c.usado('D'), 1);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('G. A pesquisa PRIVADA nunca é compartilhada, aproveitada nem refeita; o cancelamento nunca vai para o cache');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('a busca PRIVADA do dono cancelada: a pública idêntica não a esperava (fez a própria) e nada muda para ela', async () => {
    const c = cenario('g-privada-dono');
    const { ctl, p: pPrivada } = await c.dono(Q, { userId: 'dono', privado: true });
    const pA = c.buscar(Q, { userId: 'A' }); // pública, mesma consulta: NÃO se junta à privada
    await waitUntil(() => c.b.chamadas.length >= 2, 5000, 'a pública fazer a própria chamada');
    cancelarBusca(ctl, 'dono');
    const [rPriv, rA] = await Promise.all([pPrivada, pA]);
    canceladaPor(rPriv, 'dono', 'a privada cancelada');
    assert.equal(rA.provider, 'searxng');
    assert.equal(urlDa(rA), 'https://exemplo.invalid/chamada-2', 'a pública recebeu a PRÓPRIA chamada');
    assert.equal(rA.refeita, undefined, 'não foi uma "refeita": nunca esperou a privada');
    assert.equal(c.b.chamadas.length, 2);
    assert.equal(c.usado('A'), 1, 'A pagou a própria busca desde o começo');
  });

  await test('a pública em andamento e a PRIVADA idêntica: cada uma faz a própria chamada; cancelar a pública não refaz nada para a privada (e vice-versa)', async () => {
    const c = cenario('g-privada-espera');
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pP = c.buscar(Q, { userId: 'P', privado: true });
    await waitUntil(() => c.b.chamadas.length >= 2, 5000, 'a privada fazer a própria chamada');
    cancelarBusca(ctl, 'dono');
    const [rDono, rP] = await Promise.all([pDono, pP]);
    canceladaPor(rDono, 'dono', 'o dono público');
    assert.equal(urlDa(rP), 'https://exemplo.invalid/chamada-2', 'a privada tem o resultado da própria chamada');
    assert.equal(rP.refeita, undefined);
    assert.equal(c.b.chamadas.length, 2, 'nenhuma chamada nova depois do cancelamento');
    assert.equal(c.usado('P'), 1);
  });

  await test('uma busca cancelada não vai para o cache; a refeita (com resultado) vai, como qualquer busca pública', async () => {
    const c = cenario('g-cache', { env: { YUI_SEARCH_CACHE_TTL_MIN: '5' } });
    const { ctl, p: pDono } = await c.dono(Q, { userId: 'dono' });
    const pA = c.buscar(Q, { userId: 'A' });
    cancelarBusca(ctl, 'dono');
    const [rDono, rA] = await Promise.all([pDono, pA]);
    canceladaPor(rDono, 'dono', 'a cancelada');
    assert.equal(rA.refeita, true);
    // a repetição depois é servida do cache com o resultado da NOVA busca (nunca com o cancelado)
    const repetida = await c.buscar(Q, { userId: 'D' });
    assert.equal(repetida.cached, true);
    assert.equal(repetida.refeita, undefined, 'o cache guarda o resultado sem a marca de "refeita"');
    assert.equal(urlDa(repetida), 'https://exemplo.invalid/chamada-2');
    assert.equal(c.b.chamadas.length, 2, 'o cache não chamou ninguém');
    assert.equal(c.usado('D'), 0, 'servida do cache: sem cobrança');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('H. O diário e a reserva do esperador são DELE (arquivos, chaves e marcas da cota separados dos do cancelado)');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('com o diário da retomada de verdade: cada pessoa tem o próprio arquivo, a própria chave protegida e a própria etapa; a do dono fica cancelada e a do esperador, com o resultado da nova busca', async () => {
    const c = cenario('h-diario');
    const retomada = createRetomadaDePesquisa({ dir: path.join(c.dir, 'diario'), env: {}, budget: c.budget, logger: quiet });
    const chaveDono = 'research.turn:111111111111111111:1';
    const chaveA = 'research.turn:222222222222222222:1';
    const dDono = retomada.abrir(chaveDono, { userId: 'dono', privado: false, tipo: 'research.turn' });
    const dA = retomada.abrir(chaveA, { userId: 'A', privado: false, tipo: 'research.turn' });
    assert.ok(dDono && dA, 'os dois diários abriram');
    const buscaDono = dDono.busca('agente', (q, o) => c.buscar(q, { userId: o.userId, signal: o.signal }));
    const buscaA = dA.busca('agente', (q, o) => c.buscar(q, { userId: o.userId }));
    const ctl = new AbortController();
    const pDono = buscaDono(Q, { userId: 'dono', signal: ctl.signal });
    await waitUntil(() => c.b.chamadas.length >= 1, 5000, 'o dono despachar');
    const pA = buscaA(Q, { userId: 'A' });
    cancelarBusca(ctl, 'dono');
    const [rDono, rA] = await Promise.all([pDono, pA]);
    canceladaPor(rDono, 'dono', 'o dono');
    assert.equal(urlDa(rA), 'https://exemplo.invalid/chamada-2');
    // os arquivos do diário: um por pessoa, com o nome vindo de um hash do id (nunca o id)
    const arquivos = fs.readdirSync(path.join(c.dir, 'diario')).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(arquivos, [arquivoDaPessoa('dono'), arquivoDaPessoa('A')].sort(), 'um arquivo por pessoa: o diário do esperador não é o do cancelado');
    const lerDiario = (u) => JSON.parse(fs.readFileSync(path.join(c.dir, 'diario', arquivoDaPessoa(u)), 'utf8'));
    const regDono = lerDiario('dono').pesquisas;
    const regA = lerDiario('A').pesquisas;
    assert.deepEqual(Object.keys(regDono), [chaveProtegida(chaveDono)], 'a chave de idempotência do dono (protegida) só está no arquivo dele');
    assert.deepEqual(Object.keys(regA), [chaveProtegida(chaveA)], 'a chave do esperador é a DELE, nunca a do cancelado');
    const etapaDono = regDono[chaveProtegida(chaveDono)].etapas['agente:1'];
    const etapaA = regA[chaveProtegida(chaveA)].etapas['agente:1'];
    assert.equal(etapaDono.estado, 'completed');
    assert.deepEqual(etapaDono.resultado.results, [], 'a etapa do dono terminou cancelada, sem resultado');
    assert.ok(etapaDono.resultado.errors.some((x) => /cancelado/.test(x)), JSON.stringify(etapaDono.resultado.errors));
    assert.equal(etapaA.estado, 'completed');
    assert.equal(etapaA.resultado.results[0].url, 'https://exemplo.invalid/chamada-2', 'a etapa do esperador guardou o resultado da busca DELE');
    assert.equal(etapaA.cotaUsuario, true);
    // a reserva: cada um com a própria marca na cota em disco (o do esperador não é a do cancelado)
    assert.equal(c.usado('dono'), 1);
    assert.equal(c.usado('A'), 1);
    assert.deepEqual(Object.values(c.hora().usuarios).map((l) => l.length).sort(), [1, 1], 'duas marcas, de duas pessoas');
    assert.equal(c.b.chamadas.length, 2);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { process.chdir(ROOT); } catch { /* */ }
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[buscacancelada] não apaguei ${T}: ${err.message}`); }
}
process.exit(failures.length ? 1 : 0);
