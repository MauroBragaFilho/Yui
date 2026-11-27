// Etapa 8, item 1 (revisão da Liz, §9 do relatório da etapa 7) e a rodada depois da revisão da Liz da etapa 8 (§12 do relatório): a cota de busca POR HORA em
// disco TAMBÉM no processo único, com as mesmas regras do cérebro, UM dono só para o arquivo em cada configuração, NENHUMA cota independente em memória
// (sem a trava, nenhuma busca sai e a pesquisa fica indisponível) e nenhuma cobrança sem despacho. Execução: npm run test:cotahora
//
// A. A contagem: cada busca REALMENTE despachada conta uma vez (a marca vai para o disco ANTES de ela sair), a que não chega a nenhum provedor
//    (nenhum ativo, todos descansando, cota mensal cheia, cancelada antes, ou só aproveitou uma busca idêntica em andamento) não custa nada, o
//    reinício traz exatamente o que foi cobrado (nada em dobro) e a janela de 1 h anda pelo instante de cada busca. Num processo só, com buscador falso.
// B. O dono do arquivo (src/search/cotaHora.js): `unico` e `cerebro` gravam, o `bot-separado` nunca grava NEM BUSCA; a trava de dono impede um segundo gravador
//    (ele NÃO pesquisa: a pesquisa fica indisponível, e assume quando o dono sai ou morre), a trava perdida para de gravar E de buscar, o erro na trava também,
//    YUI_COTA_HORA_DISCO=false (escolha explícita do dono) volta a só memória e as buscas seguem saindo.
// C. PROCESSOS DE VERDADE (tests/helpers/cotaHoraFilho.mjs, cada um com o bloqueio de integração externa e NENHUMA exceção): um único e um cérebro
//    disputando o mesmo arquivo (o segundo NÃO busca), um bot separado que nunca busca nem grava, a saída limpa, a queda (a pesquisa fica indisponível até
//    o prazo de abandono vencer; depois a trava é retomada e as buscas voltam).
// D. A fiação: o index.js e o cerebro.js chamam o ligarCotaHora com o papel certo e mais nada chama persistirHora.
// E. A QUEDA ENTRE A GRAVAÇÃO E O DESPACHO (abordagem conservadora aprovada pela Liz): a vaga só volta quando a AUSÊNCIA de despacho é comprovada. Cada saída:
//    nenhum provedor ativo, todos descansando, cota mensal cheia e cancelada antes DEVOLVEM; a exceção depois do despacho e a queda do processo no meio
//    (processo de verdade, derrubado com o pedido já no "buscador") MANTÊM a cobrança.
// F. A VARREDURA DOS CAMINHOS: só o searchWeb despacha uma busca externa (o provedor só é chamado dentro da cadeia, a cadeia só dentro do searchWeb, a porta de
//    saída vem antes do cache, do compartilhamento e da cobrança), todo caminho do bot (o agente, a busca automática, o ramo antigo) passa por ele, e os pontos de
//    entrada ligam a cota antes de qualquer coisa que possa buscar.
// SEM rede, SEM bancos reais, SEM o arquivo de cota real (tudo numa pasta temporária). Só são encerrados os processos que este teste abriu, pelo handle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { criarBloqueio } from './helpers/bloqueioExternoTeste.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cota-hora-'));
Object.assign(process.env, { DATABASE_DIR: path.join(T, 'db'), YUI_AUDIT_FILE: path.join(T, 'audit.jsonl'), YUI_SEARCH_BUDGET_FILE: path.join(T, 'padrao', 'search-budget.json'), LOG_LEVEL: 'error', YUI_OWNER_ID: '111111111111111111' });
for (const k of ['YUI_COTA_HORA_DISCO', 'YUI_SEARCH_USER_PER_HOUR', 'YUI_SEARCH_GLOBAL_PER_HOUR', 'YUI_CEREBRO_EXTERNO']) delete process.env[k];
process.chdir(T);

const { createBudget, hourlyFileFor, hourlyPersistEnabled } = await import('../src/search/budget.js');
const { searchWeb, resetCooldowns } = await import('../src/search/providers.js');
const { ligarCotaHora, estadoDaCotaHora, donoDoArquivoDaCota, PAPEIS_COTA_HORA } = await import('../src/search/cotaHora.js');
const { TEXTO_PESQUISA_INDISPONIVEL, ERRO_PESQUISA_INDISPONIVEL, MOTIVOS_INDISPONIVEL } = await import('../src/search/indisponivel.js');
const { searchForAgent, smartSearchDetailed, classifySearchOutcome } = await import('../src/core/ai/searchManager.js');
const { classifyFailure, failureMessage } = await import('../src/core/ai/researchAgent.js');
const { createCoreResearch } = await import('../src/core/ai/research.js');
const { describeSearchOutcome } = await import('../src/core/ai/llmSafety.js');

let passed = 0;
const failures = [];
let BLOQUEIO = null;
const procs = new Set();
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); BLOQUEIO?.conferir(name); passed += 1; say(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(50); }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${typeof what === 'function' ? what() : what}`);
}
const MIN = 60_000;
const HORA = 60 * MIN;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const RESULTADOS = { results: [{ title: 'T', url: 'https://exemplo.invalid/a', content: 'c' }] };
/** O ambiente de busca: só o SearXNG (um buscador falso, sem rede), limite de 3 por pessoa e 10 no global por hora. */
const ENV = { SEARXNG_URL: 'http://127.0.0.1:8080/', YUI_SEARCH_PROVIDERS: 'searxng', YUI_SEARCH_USER_PER_HOUR: '3', YUI_SEARCH_GLOBAL_PER_HOUR: '10' };
const busca = (q, o = {}) => searchWeb(q, { logger: quiet, env: ENV, fetchImpl: async () => json(RESULTADOS), ...o });
const pasta = (n) => { const d = path.join(T, n); fs.mkdirSync(d, { recursive: true }); return d; };
const lerHora = (arquivo) => { try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; } };
const marcas = (arquivo) => lerHora(arquivo)?.global?.length ?? 0;
const trava = (arquivo) => { try { return JSON.parse(fs.readFileSync(`${arquivo}.owner`, 'utf8')); } catch { return null; } };
const TEMPO = { YUI_DB_OWNER_HEARTBEAT_MS: '100', YUI_DB_OWNER_STALE_MS: '500' }; // as travas do teste batem e vencem rápido
/** Uma busca "que sai": o buscador falso conta quantas chamadas chegaram a ele. */
const contador = () => { const c = { saiu: 0, fetchImpl: async () => { c.saiu += 1; return json(RESULTADOS); } }; return c; };
/** Confere que a busca NÃO saiu: pesquisa indisponível, nenhum provedor chamado, nada cobrado. */
const indisponivel = (r, c, motivo, onde) => {
  assert.equal(r.provider, null, onde);
  assert.equal(r.indisponivel, true, `${onde}: pesquisa indisponível`);
  assert.deepEqual(r.errors, [ERRO_PESQUISA_INDISPONIVEL], onde);
  assert.equal(r.motivo, motivo, `${onde}: o motivo é uma palavra fixa`);
  assert.equal(c.saiu, 0, `${onde}: NENHUMA chamada externa`);
};

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. A contagem: cada busca despachada conta uma vez, antes de sair; sem despacho, sem cobrança');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('a marca vai para o DISCO antes de a busca sair, e o reinício traz exatamente o que foi cobrado (nada em dobro)', async () => {
    resetCooldowns();
    const dir = pasta('a1');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const t0 = Date.parse('2026-11-18T10:00:00Z');
    let agora = t0;
    const A = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    A.persistirHora(arquivo, agora);
    // no instante em que a busca SAI para o provedor, a marca dela já está no arquivo
    let marcasNoDespacho = null;
    const r = await busca('consulta a1', { userId: 'u1', budget: A, now: () => agora, fetchImpl: async () => { marcasNoDespacho = marcas(arquivo); return json(RESULTADOS); } });
    assert.equal(r.provider, 'searxng');
    assert.equal(marcasNoDespacho, 1, 'a marca persistente vem ANTES do despacho ao buscador');
    // uma busca despachada que FALHA no provedor também conta (ela saiu): uma vez só
    resetCooldowns();
    agora += MIN;
    const falha = await busca('consulta a1b', { userId: 'u1', budget: A, now: () => agora, fetchImpl: async () => { throw new Error('rede caiu (teste)'); } });
    assert.equal(falha.provider, null);
    assert.equal(A.userStatus('u1', ENV).used, 2, 'as duas saíram: contam duas vezes, nem mais nem menos');
    assert.equal(A.globalStatus(ENV).used, 2);
    assert.equal(marcas(arquivo), 2);
    // "reinício": outro processo (contadores novos) relê o arquivo
    agora += MIN;
    const B = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    assert.equal(B.persistirHora(arquivo, agora), 4, '2 do usuário + 2 globais');
    assert.equal(B.userStatus('u1', ENV).used, 2);
    assert.equal(B.globalStatus(ENV).used, 2);
    // e um terceiro reinício seguido (sem nenhuma busca no meio) não muda nada: nunca conta duas vezes por causa de um reinício
    const C = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    assert.equal(C.persistirHora(arquivo, agora), 4);
    assert.equal(C.userStatus('u1', ENV).used, 2);
    assert.equal(marcas(arquivo), 2, 'o arquivo continua com as mesmas 2 marcas');
  });

  await test('SEM DESPACHO, SEM COBRANÇA: nenhum provedor ativo, todos descansando, cota mensal cheia, cancelada antes e busca idêntica em andamento não custam nada', async () => {
    const dir = pasta('a2');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    let agora = Date.parse('2026-11-18T10:00:00Z');
    const B = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    B.persistirHora(arquivo, agora);
    const usados = () => ({ u1: B.userStatus('u1', ENV).used, u2: B.userStatus('u2', ENV).used, global: B.globalStatus(ENV).used, marcas: marcas(arquivo) });
    const igual = (esperado, onde) => assert.deepEqual(usados(), esperado, onde);
    // 0. uma busca despachada de verdade: a base da conta
    resetCooldowns();
    assert.equal((await busca('base', { userId: 'u1', budget: B, now: () => agora })).provider, 'searxng');
    igual({ u1: 1, u2: 0, global: 1, marcas: 1 }, 'a base: uma busca despachada');
    // 1. nenhum provedor ativo: nada sai, nada é cobrado (e o arquivo volta a ter só a marca da base)
    resetCooldowns();
    let saiu = 0;
    const semProvedor = await busca('sem provedor', { userId: 'u1', budget: B, now: () => agora, env: { ...ENV, YUI_SEARCH_PROVIDERS: 'brave' }, fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.equal(semProvedor.provider, null);
    assert.equal(saiu, 0, 'nada saiu');
    igual({ u1: 1, u2: 0, global: 1, marcas: 1 }, 'nenhum provedor ativo: sem cobrança');
    // 2. todos descansando: o provedor leva um 429 (essa busca saiu e conta), a seguinte nem chega a ele
    resetCooldowns();
    agora += 1000;
    await busca('leva 429', { userId: 'u1', budget: B, now: () => agora, fetchImpl: async () => { saiu += 1; return json({}, 429); } });
    assert.equal(saiu, 1);
    igual({ u1: 2, u2: 0, global: 2, marcas: 2 }, 'a que levou 429 saiu: conta');
    agora += 1000;
    const descansando = await busca('provedor descansando', { userId: 'u2', budget: B, now: () => agora, fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.ok(descansando.errors.some((e) => /descansando/.test(e)), JSON.stringify(descansando.errors));
    assert.equal(saiu, 1, 'o provedor descansando nem foi chamado');
    igual({ u1: 2, u2: 0, global: 2, marcas: 2 }, 'todos descansando: sem cobrança');
    // 3. cota mensal do provedor cheia: a primeira sai e conta, a segunda não tem para onde ir
    resetCooldowns();
    // o teto mensal do provedor deixa passar só mais UMA (as buscas anteriores deste orçamento já gastaram parte dele)
    const mensal = { ...ENV, YUI_SEARCH_MONTHLY_CAP_SEARXNG: String(B.used('searxng', agora) + 1), YUI_SEARCH_USER_PER_HOUR: '9' };
    agora += 1000;
    assert.equal((await busca('mensal 1', { userId: 'u2', budget: B, now: () => agora, env: mensal })).provider, 'searxng');
    igual({ u1: 2, u2: 1, global: 3, marcas: 3 }, 'a primeira da cota mensal saiu: conta');
    const cheia = await busca('mensal 2', { userId: 'u2', budget: B, now: () => agora, env: mensal, fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.ok(cheia.errors.some((e) => /cota mensal atingida/.test(e)), JSON.stringify(cheia.errors));
    assert.equal(saiu, 1);
    igual({ u1: 2, u2: 1, global: 3, marcas: 3 }, 'cota mensal cheia: sem cobrança');
    // 4. cancelada antes de sair
    resetCooldowns();
    const cancelada = await busca('cancelada', { userId: 'u2', budget: B, now: () => agora, signal: AbortSignal.abort(), fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.equal(cancelada.provider, null);
    assert.equal(saiu, 1, 'cancelada antes: nada saiu');
    igual({ u1: 2, u2: 1, global: 3, marcas: 3 }, 'cancelada antes de sair: sem cobrança');
    // 5. duas buscas idênticas ao mesmo tempo, de duas pessoas: UM despacho, UMA cobrança (quem só aproveitou a busca em andamento não paga)
    resetCooldowns();
    let despachos = 0;
    const lenta = async () => { despachos += 1; await sleep(80); return json(RESULTADOS); };
    const [x, y] = await Promise.all([
      busca('mesma consulta', { userId: 'u1', budget: B, now: () => agora, fetchImpl: lenta }),
      busca('mesma consulta', { userId: 'u2', budget: B, now: () => agora, fetchImpl: lenta }),
    ]);
    assert.equal(x.provider, 'searxng');
    assert.equal(y.provider, 'searxng');
    assert.equal(despachos, 1, 'um despacho só');
    igual({ u1: 3, u2: 1, global: 4, marcas: 4 }, 'busca idêntica em andamento: só o primeiro pagou');
    // 6. cache: a repetição servida do cache nem chega a pedir a vaga
    resetCooldowns();
    const comCache = { ...ENV, YUI_SEARCH_CACHE_TTL_MIN: '5', YUI_SEARCH_USER_PER_HOUR: '9' };
    await busca('com cache', { userId: 'u2', budget: B, now: () => agora, env: comCache });
    igual({ u1: 3, u2: 2, global: 5, marcas: 5 }, 'a primeira com cache saiu: conta');
    const repetida = await busca('com cache', { userId: 'u2', budget: B, now: () => agora, env: comCache });
    assert.equal(repetida.cached, true);
    igual({ u1: 3, u2: 2, global: 5, marcas: 5 }, 'servida do cache: sem cobrança');
    // o reinício traz EXATAMENTE isso (as 5 despachadas), nem as devolvidas, nem em dobro
    const C = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    C.persistirHora(arquivo, agora);
    assert.equal(C.globalStatus(ENV).used, 5);
    assert.equal(C.userStatus('u1', ENV).used, 3);
    assert.equal(C.userStatus('u2', { ...ENV, YUI_SEARCH_USER_PER_HOUR: '9' }).used, 2);
  });

  await test('o limite recusado não despacha, não cobra e não grava; e vale depois do reinício, com a janela de 1 h certa', async () => {
    resetCooldowns();
    const dir = pasta('a3');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const t0 = Date.parse('2026-11-18T10:00:00Z');
    let agora = t0;
    const A = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    A.persistirHora(arquivo, agora);
    for (const min of [0, 10, 50]) { agora = t0 + min * MIN; assert.equal((await busca(`q${min}`, { userId: 'u1', budget: A, now: () => agora })).provider, 'searxng'); }
    agora = t0 + 51 * MIN;
    let saiu = 0;
    const recusada = await busca('quarta', { userId: 'u1', budget: A, now: () => agora, fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.equal(recusada.limited, 'user');
    assert.equal(saiu, 0, 'recusada: nada sai');
    assert.equal(marcas(arquivo), 3, 'e nada é gravado');
    // reinício às 10:55
    agora = t0 + 55 * MIN;
    const B = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    B.persistirHora(arquivo, agora);
    const de_novo = await busca('depois do reinício', { userId: 'u1', budget: B, now: () => agora, fetchImpl: async () => { saiu += 1; return json(RESULTADOS); } });
    assert.equal(de_novo.limited, 'user', 'o limite sobreviveu ao reinício');
    assert.equal(de_novo.retryAfterMs, 5 * MIN, 'a vaga abre às 11:00 (uma hora depois da busca das 10:00)');
    assert.equal(saiu, 0);
    agora = t0 + HORA + MIN; // 11:01: a das 10:00 saiu da janela
    assert.equal((await busca('abriu a vaga', { userId: 'u1', budget: B, now: () => agora })).provider, 'searxng');
    assert.equal(marcas(arquivo), 3, 'duas antigas (10:10 e 10:50) + a nova (11:01); a das 10:00 já saiu da janela');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. UM dono, nenhuma cota independente em memória: sem a trava a pesquisa NÃO sai (fica indisponível)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('o dono em cada configuração: processo único = o próprio processo; cérebro separado = o cérebro; o bot separado nunca grava NEM busca; parado, ninguém busca', async () => {
    assert.equal(donoDoArquivoDaCota(false), 'unico');
    assert.equal(donoDoArquivoDaCota(true), 'cerebro');
    assert.deepEqual(Object.values(PAPEIS_COTA_HORA).sort(), ['bot-separado', 'cerebro', 'unico']);
    assert.throws(() => ligarCotaHora({ papel: 'qualquer' }), /papel inválido/);
    for (const papel of ['unico', 'cerebro']) {
      resetCooldowns();
      const dir = pasta(`b-${papel}`);
      const arquivo = path.join(dir, 'search-budget-hora.json');
      const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
      const h = ligarCotaHora({ papel, budget, logger: quiet, env: TEMPO });
      const e = h.estado();
      assert.equal(e.ligada, true, `${papel} liga`);
      assert.equal(e.dono, papel);
      assert.equal(e.pesquisaDisponivel, true, 'com a trava na mão, a pesquisa sai');
      assert.equal(trava(arquivo)?.role, papel, 'a trava de dono é do papel');
      assert.equal(trava(arquivo)?.pid, process.pid);
      assert.equal(budget.hourlyStats().persistente, true);
      await busca('do dono', { userId: 'u1', budget });
      assert.equal(marcas(arquivo), 1, `${papel} grava`);
      assert.equal(estadoDaCotaHora().papel, papel, 'o estado do processo (o diagnóstico lê daqui)');
      h.parar();
      assert.equal(trava(arquivo), null, 'parar solta a trava');
      // parado (desligamento): a porta fecha, nenhuma busca nova (e nada na memória nem no disco)
      const c = contador();
      indisponivel(await busca('depois de parar', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'parada', 'depois de parar');
      assert.equal(marcas(arquivo), 1, 'parado: não grava mais');
      assert.equal(budget.userStatus('u1', ENV).used, 1, 'e nada foi contado só na memória');
    }
    // o bot separado: nem o arquivo, nem a trava, nem a gravação, NEM A BUSCA (a pesquisa dele vai ao cérebro)
    resetCooldowns();
    const dir = pasta('b-bot');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    const h = ligarCotaHora({ papel: 'bot-separado', budget, logger: quiet, env: TEMPO });
    assert.equal(h.estado().ligada, false);
    assert.equal(h.estado().dono, 'cerebro', 'o dono do arquivo é o cérebro');
    assert.equal(h.estado().pesquisaDisponivel, false, 'o bot separado nunca despacha uma busca por conta própria');
    assert.equal(h.estado().codigo, 'bot-separado');
    const c = contador();
    indisponivel(await busca('do bot', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'bot-separado', 'bot separado');
    indisponivel(await busca('do bot 2', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'bot-separado', 'bot separado (2)');
    assert.equal(fs.existsSync(arquivo), false, 'o bot separado nunca cria o arquivo');
    assert.equal(fs.existsSync(`${arquivo}.owner`), false, 'nem pega a trava');
    assert.equal(budget.hourlyStats().persistente, false);
    assert.equal(budget.userStatus('u1', ENV).used, 0, 'nada foi contado, nem na memória do bot');
    h.parar();
  });

  await test('YUI_COTA_HORA_DISCO=false é ESCOLHA EXPLÍCITA do dono (não falha): volta a só memória nas duas configurações, as buscas SEGUEM saindo, com o aviso no log e o código no diagnóstico', async () => {
    assert.equal(hourlyPersistEnabled({ YUI_COTA_HORA_DISCO: 'false' }), false);
    for (const papel of ['unico', 'cerebro']) {
      resetCooldowns();
      const dir = pasta(`b-off-${papel}`);
      const arquivo = path.join(dir, 'search-budget-hora.json');
      const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
      const avisos = [];
      const h = ligarCotaHora({ papel, budget, logger: { ...quiet, warn: (m) => avisos.push(m) }, env: { YUI_COTA_HORA_DISCO: 'false' } });
      assert.equal(h.estado().ligada, false);
      assert.match(h.estado().motivo, /YUI_COTA_HORA_DISCO=false/);
      assert.equal(h.estado().codigo, 'desligada', 'o código fixo do diagnóstico');
      assert.equal(h.estado().pesquisaDisponivel, true, 'a pesquisa segue saindo: o dono escolheu só a memória');
      assert.match(avisos.join('\n'), /só na memória/);
      assert.match(avisos.join('\n'), /escolha explícita do dono/);
      const c = contador();
      assert.equal((await busca('sem disco', { userId: 'u1', budget, fetchImpl: c.fetchImpl })).provider, 'searxng');
      assert.equal(c.saiu, 1);
      assert.equal(fs.existsSync(arquivo), false);
      assert.equal(fs.existsSync(`${arquivo}.owner`), false);
      assert.equal(budget.userStatus('u1', ENV).used, 1, 'conta na memória (zera num reinício: o dono sabe)');
    }
  });

  await test('dois gravadores no mesmo arquivo: o segundo NÃO grava e NÃO busca (indisponível, nada na memória), assume quando o primeiro sai e nada conta em dobro', async () => {
    resetCooldowns();
    const dir = pasta('b-dois');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const mensal = path.join(dir, 'search-budget.json');
    const A = createBudget({ filePath: mensal });
    const hA = ligarCotaHora({ papel: 'unico', budget: A, logger: quiet, env: TEMPO });
    assert.equal(hA.estado().ligada, true);
    await busca('a1', { userId: 'ua', budget: A });
    await busca('a2', { userId: 'ua', budget: A });
    // um segundo "processo" (outro budget, outro papel) no MESMO arquivo, com A vivo
    const avisos = [];
    const B = createBudget({ filePath: mensal });
    const hB = ligarCotaHora({ papel: 'cerebro', budget: B, logger: { ...quiet, warn: (m) => avisos.push(m) }, env: TEMPO });
    assert.equal(hB.estado().ligada, false, 'a trava é do outro');
    assert.equal(hB.estado().aguardandoTrava, true);
    assert.equal(hB.estado().pesquisaDisponivel, false, 'sem a trava, a pesquisa fica indisponível');
    assert.equal(hB.estado().codigo, 'trava-de-outro-processo');
    assert.match(hB.estado().motivo, /outro processo \(unico/);
    assert.match(avisos.join('\n'), /NÃO grava a cota por hora e NÃO busca/);
    const cB = contador();
    indisponivel(await busca('b1', { userId: 'ub', budget: B, fetchImpl: cB.fetchImpl }), cB, 'trava-de-outro-processo', 'B sem a trava (1)');
    indisponivel(await busca('b2', { userId: 'ub', budget: B, fetchImpl: cB.fetchImpl }), cB, 'trava-de-outro-processo', 'B sem a trava (2)');
    assert.equal(marcas(arquivo), 2, 'só as marcas de A estão no arquivo: B nunca gravou');
    assert.equal(B.hourlyStats().persistente, false);
    assert.equal(B.hourlyStats().gravacoes ?? 0, 0);
    assert.equal(B.userStatus('ub', ENV).used, 0, 'e B NÃO contou nada na memória: nenhuma cota independente');
    assert.equal(B.globalStatus(ENV).used, 0);
    await busca('a3', { userId: 'ua', budget: A });
    assert.equal(marcas(arquivo), 3);
    // A sai: a trava é solta, B assume (tenta de novo sozinho) e a pesquisa volta; as 3 de A voltam do disco, cada uma uma vez
    hA.parar();
    await waitUntil(() => hB.estado().ligada, 8000, () => `B assumir o arquivo: ${JSON.stringify(hB.estado())}`);
    assert.equal(hB.estado().pesquisaDisponivel, true);
    assert.equal(trava(arquivo)?.role, 'cerebro');
    assert.equal(B.globalStatus(ENV).used, 3, 'as 3 de A voltaram do arquivo, cada uma uma vez só');
    assert.equal(B.userStatus('ua', ENV).used, 3);
    assert.equal(B.userStatus('ub', ENV).used, 0);
    assert.equal((await busca('b3', { userId: 'ub', budget: B, fetchImpl: cB.fetchImpl })).provider, 'searxng');
    assert.equal(cB.saiu, 1, 'só agora, com a trava, a busca sai');
    assert.equal(marcas(arquivo), 4);
    hB.parar();
  });

  await test('a trava de um dono que MORREU (queda): a pesquisa fica INDISPONÍVEL até o prazo de abandono vencer (sem atrasar a subida e sem encerrar nada); depois a trava é retomada e as buscas do dono morto voltam', async () => {
    resetCooldowns();
    const dir = pasta('b-morto');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    // o dono que caiu deixou 2 buscas no arquivo da hora
    const antigo = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    antigo.persistirHora(arquivo);
    await busca('do dono morto 1', { userId: 'u1', budget: antigo });
    await busca('do dono morto 2', { userId: 'u1', budget: antigo });
    assert.equal(marcas(arquivo), 2);
    // um processo que já saiu (a trava ficou para trás, com batimento recente)
    const filho = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
    assert.ok(filho.pid > 0);
    fs.writeFileSync(`${arquivo}.owner`, `${JSON.stringify({ role: 'cerebro', pid: filho.pid, hostname: os.hostname(), processStartMs: Date.now() - 60_000, acquiredAt: new Date().toISOString(), token: 'abandonada' })}\n`);
    const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    const t0 = Date.now();
    const h = ligarCotaHora({ papel: 'cerebro', budget, logger: quiet, env: TEMPO });
    assert.ok(Date.now() - t0 < 500, 'a subida não esperou');
    assert.equal(h.estado().ligada, false);
    assert.equal(h.estado().codigo, 'dono-morto');
    assert.equal(h.estado().pesquisaDisponivel, false);
    assert.match(h.estado().motivo, /não existe mais/);
    const c = contador();
    indisponivel(await busca('durante a espera', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'dono-morto', 'esperando o prazo de abandono');
    assert.equal(marcas(arquivo), 2, 'nada gravado na espera');
    assert.equal(budget.userStatus('u1', ENV).used, 0, 'e nada contado só na memória');
    await waitUntil(() => h.estado().ligada, 8000, () => `retomar a trava: ${JSON.stringify(h.estado())}`);
    assert.equal(trava(arquivo)?.pid, process.pid, 'a trava agora é deste processo');
    assert.equal(h.estado().carregadas, 4, 'as 2 buscas do dono morto voltaram a contar (2 do usuário + 2 do global)');
    assert.equal(budget.userStatus('u1', ENV).used, 2);
    assert.equal((await busca('depois da espera', { userId: 'u1', budget, fetchImpl: c.fetchImpl })).provider, 'searxng');
    assert.equal(marcas(arquivo), 3);
    h.parar();
  });

  await test('trava PERDIDA (alguém trocou a trava): para de gravar na hora E de buscar até reiniciar (indisponível), nunca volta a ler o arquivo (contaria em dobro)', async () => {
    resetCooldowns();
    const dir = pasta('b-perdida');
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    const erros = [];
    const h = ligarCotaHora({ papel: 'unico', budget, logger: { ...quiet, error: (m) => erros.push(m) }, env: TEMPO });
    await busca('antes', { userId: 'u1', budget });
    assert.equal(marcas(arquivo), 1);
    const outra = JSON.parse(fs.readFileSync(`${arquivo}.owner`, 'utf8'));
    fs.writeFileSync(`${arquivo}.owner`, `${JSON.stringify({ ...outra, token: 'de-outro-processo', pid: process.pid })}\n`);
    await waitUntil(() => h.estado().perdida, 5000, 'perceber a perda da trava');
    assert.match(erros.join('\n'), /PERDIDA/);
    assert.match(erros.join('\n'), /parei de buscar/);
    assert.equal(budget.hourlyStats().persistente, false);
    assert.equal(h.estado().pesquisaDisponivel, false);
    const c = contador();
    indisponivel(await busca('depois', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'perdida', 'trava perdida');
    assert.equal(marcas(arquivo), 1, 'não grava mais');
    assert.equal(budget.userStatus('u1', ENV).used, 1, 'a cota não anda: nada de contar só na memória');
    await sleep(1300); // nem tenta de novo
    assert.equal(h.estado().ligada, false);
    indisponivel(await busca('depois de esperar', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'perdida', 'segue indisponível até reiniciar');
    h.parar();
  });

  await test('erro na trava (nem de outro processo vivo, nem de dono morto): a pesquisa também fica indisponível, com o código fixo "erro-na-trava"', async () => {
    resetCooldowns();
    const dir = pasta('b-erro');
    const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    const h = ligarCotaHora({ papel: 'cerebro', budget, logger: quiet, env: TEMPO, acquire: () => { throw Object.assign(new Error('sem permissão (teste)'), { code: 'EACCES' }); } });
    assert.equal(h.estado().codigo, 'erro-na-trava');
    assert.equal(h.estado().pesquisaDisponivel, false);
    const c = contador();
    indisponivel(await busca('erro', { userId: 'u1', budget, fetchImpl: c.fetchImpl }), c, 'erro-na-trava', 'erro na trava');
    assert.equal(budget.userStatus('u1', ENV).used, 0);
    h.parar();
  });

  await test('o motivo do diagnóstico é uma palavra FIXA: todos os códigos que a trava produz estão na lista de motivos e nunca levam texto livre', () => {
    const vistos = new Set(['bot-separado', 'aguardando-trava', 'trava-de-outro-processo', 'dono-morto', 'erro-na-trava', 'perdida', 'parada']);
    for (const codigo of vistos) assert.ok(MOTIVOS_INDISPONIVEL.includes(codigo), codigo);
    for (const m of MOTIVOS_INDISPONIVEL) assert.match(m, /^[a-z][a-z0-9-]{0,40}$/);
    assert.ok(MOTIVOS_INDISPONIVEL.includes('registro-da-cota') && MOTIVOS_INDISPONIVEL.includes('registro-do-diario') && MOTIVOS_INDISPONIVEL.includes('registro-mensal'));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. Processos de verdade: o único e o cérebro disputando o arquivo, o bot separado que nunca busca, a saída e a queda');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:cotahora', liberar: {} }); // nenhuma exceção: os filhos não usam rede nem programas
  const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramFiles', 'ProgramData', 'SystemDrive', 'LANG'];
  const HELPER = path.join(ROOT, 'tests', 'helpers', 'cotaHoraFilho.mjs');
  function filho(label, papel, orcamento, tempo = { YUI_DB_OWNER_HEARTBEAT_MS: '200', YUI_DB_OWNER_STALE_MS: '1000' }) {
    const env = {};
    for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    const child = spawn(process.execPath, [...BLOQUEIO.argv, HELPER], {
      cwd: T, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...env, NODE_ENV: 'test', NO_COLOR: '1', LOG_LEVEL: 'error', YUI_REPO: ROOT, YUI_SEARCH_BUDGET_FILE: orcamento, COTA_PAPEL: papel, ...tempo, ...BLOQUEIO.env(label) },
    });
    const f = { label, child, pid: child.pid, out: '', exited: false, msgs: [], waiters: [] };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { f.out += d; }); child.stderr.on('data', (d) => { f.out += d; });
    child.on('message', (m) => { f.msgs.push(m); });
    f.exit = new Promise((r) => child.on('exit', (code) => { f.exited = true; f.code = code; procs.delete(f); r(code); }));
    procs.add(f);
    f.esperar = async (tipo, de = 0) => {
      await waitUntil(() => f.msgs.slice(de).some((m) => m.tipo === tipo || m.tipo === 'erro') || f.exited, 30_000, () => `${label}: ${tipo}\n${f.out}`);
      const m = f.msgs.slice(de).find((x) => x.tipo === tipo || x.tipo === 'erro');
      if (!m) throw new Error(`${label} saiu antes de responder (${tipo})\n${f.out}`);
      if (m.tipo === 'erro') throw new Error(`${label}: ${m.mensagem}`);
      return m;
    };
    f.pedir = async (msg, tipoResposta) => { const de = f.msgs.length; f.child.send(msg); return f.esperar(tipoResposta, de); };
    return f;
  }
  const PROC = path.join(T, 'proc');
  fs.mkdirSync(PROC, { recursive: true });
  const ORC = path.join(PROC, 'search-budget.json');
  const HORA_ARQ = hourlyFileFor(ORC);

  await test('um processo ÚNICO e um CÉREBRO no mesmo arquivo: só o primeiro busca e grava; o segundo e o bot separado NÃO buscam (indisponível, nada sai); a saída limpa passa o arquivo adiante sem contar em dobro', async () => {
    const A = filho('unico-A', 'unico', ORC);
    const pA = await A.esperar('pronto');
    assert.equal(pA.estado.ligada, true);
    assert.equal(pA.estado.dono, 'unico');
    assert.equal(pA.estado.pesquisaDisponivel, true);
    assert.equal(trava(HORA_ARQ)?.pid, A.pid, 'a trava é do processo A');
    await A.pedir({ tipo: 'buscar', n: 3, usuario: 'ua' }, 'buscou');
    // o cérebro sobe com A vivo: não é o dono, não grava e NÃO BUSCA
    const B = filho('cerebro-B', 'cerebro', ORC);
    const pB = await B.esperar('pronto');
    assert.equal(pB.estado.ligada, false);
    assert.equal(pB.estado.aguardandoTrava, true);
    assert.equal(pB.estado.pesquisaDisponivel, false);
    assert.match(pB.estado.motivo, /outro processo \(unico/);
    assert.equal(pB.hora.persistente, false);
    const bB = await B.pedir({ tipo: 'tentar', n: 2, usuario: 'ub' }, 'tentou');
    assert.equal(bB.saiu, 0, 'B NÃO chamou nenhum buscador');
    assert.deepEqual(bB.resultados.map((r) => [r.provider, r.indisponivel, r.motivo]), [[null, true, 'trava-de-outro-processo'], [null, true, 'trava-de-outro-processo']]);
    assert.equal(bB.hora.gravacoes ?? 0, 0, 'B nunca gravou');
    assert.equal(bB.globalUsadas, 0, 'e nada contado na memória dele');
    await A.pedir({ tipo: 'buscar', n: 2, usuario: 'ua' }, 'buscou');
    assert.equal(marcas(HORA_ARQ), 5, 'só as marcas de A (5) estão no arquivo');
    assert.equal(trava(HORA_ARQ)?.pid, A.pid);
    // o bot separado: nem grava, nem busca (a pesquisa dele vai ao cérebro)
    const BOT = filho('bot-separado-C', 'bot-separado', ORC);
    const pC = await BOT.esperar('pronto');
    assert.equal(pC.estado.ligada, false);
    assert.equal(pC.estado.dono, 'cerebro');
    assert.equal(pC.estado.pesquisaDisponivel, false);
    assert.equal(pC.hora.persistente, false);
    const bC = await BOT.pedir({ tipo: 'tentar', n: 4, usuario: 'uc' }, 'tentou');
    assert.equal(bC.saiu, 0, 'o bot separado NÃO chamou nenhum buscador');
    assert.equal(bC.resultados.length, 4);
    assert.ok(bC.resultados.every((r) => r.provider === null && r.indisponivel === true && r.motivo === 'bot-separado'), JSON.stringify(bC.resultados));
    assert.equal(bC.hora.persistente, false);
    assert.equal(bC.globalUsadas, 0);
    assert.equal(marcas(HORA_ARQ), 5, 'o bot separado nunca grava, e nem busca');
    // A sai (normal): a trava é solta e B assume sozinho; as 5 de A voltam do disco (nada em dobro) e a pesquisa de B volta
    A.child.send({ tipo: 'sair' });
    assert.equal(await A.exit, 0);
    await waitUntil(async () => (await B.pedir({ tipo: 'estado' }, 'estado')).estado.ligada, 15_000, 'B assumir o arquivo depois da saída de A');
    const eB = await B.pedir({ tipo: 'estado' }, 'estado');
    assert.equal(eB.estado.pesquisaDisponivel, true);
    assert.equal(eB.globalUsadas, 5, 'as 5 de A voltaram do arquivo, cada uma uma vez');
    assert.equal(marcas(HORA_ARQ), 5);
    assert.equal(trava(HORA_ARQ)?.pid, B.pid);
    assert.equal(trava(HORA_ARQ)?.role, 'cerebro');
    await B.pedir({ tipo: 'buscar', n: 1, usuario: 'ub' }, 'buscou');
    assert.equal(marcas(HORA_ARQ), 6);
    // "sem despacho, sem cobrança" também com processo de verdade: 3 tentativas sem provedor não mudam nada
    const antes = (await B.pedir({ tipo: 'estado' }, 'estado')).globalUsadas;
    const sem = await B.pedir({ tipo: 'sem-despacho', n: 3, usuario: 'ub' }, 'buscou');
    assert.equal(sem.globalUsadas, antes, 'nenhuma cobrança');
    assert.equal(marcas(HORA_ARQ), 6, 'e nada novo no arquivo');
    // B e o bot saem
    B.child.send({ tipo: 'sair' });
    BOT.child.send({ tipo: 'sair' });
    assert.equal(await B.exit, 0);
    assert.equal(await BOT.exit, 0);
    assert.equal(trava(HORA_ARQ), null, 'a trava foi solta na saída');
    // um novo processo único relê tudo: 6 buscas (12 marcas: usuário + global), cada uma uma vez
    const D = filho('unico-D', 'unico', ORC);
    const pD = await D.esperar('pronto');
    assert.equal(pD.estado.ligada, true);
    assert.equal(pD.estado.carregadas, 12, 'as 6 buscas voltaram (6 do usuário + 6 do global), nem uma a mais');
    assert.equal(pD.globalUsadas, 6);
    D.child.send({ tipo: 'sair' });
    assert.equal(await D.exit, 0);
  });

  await test('QUEDA: o dono morto (encerrado à força, trava para trás) é substituído depois do prazo de abandono; ENQUANTO ESPERA a pesquisa fica indisponível (nada sai) e, depois, a cota da hora sobrevive à queda', async () => {
    const orc = path.join(PROC, 'queda', 'search-budget.json');
    const arq = hourlyFileFor(orc);
    // prazo de abandono mais longo (4 s): o processo novo sobe ANTES de a trava vencer, e o teste vê a espera (sem corrida com o tempo de subida do Node)
    const lento = { YUI_DB_OWNER_HEARTBEAT_MS: '200', YUI_DB_OWNER_STALE_MS: '4000' };
    const E = filho('cerebro-E', 'cerebro', orc, lento);
    await E.esperar('pronto');
    await E.pedir({ tipo: 'buscar', n: 2, usuario: 'ue' }, 'buscou');
    assert.equal(marcas(arq), 2);
    E.child.kill(); // o filho que ESTE teste abriu, pelo handle: a queda (a trava fica no disco)
    await E.exit;
    assert.ok(trava(arq), 'a trava ficou para trás');
    const F = filho('cerebro-F', 'cerebro', orc, lento);
    const pF = await F.esperar('pronto');
    assert.equal(pF.estado.ligada, false, 'o novo processo não esperou: sobe na hora');
    assert.match(pF.estado.motivo, /não existe mais/);
    assert.equal(pF.estado.pesquisaDisponivel, false);
    // a janela da queda: a pesquisa fica indisponível (é o risco documentado: até ~75 s com os tempos de produção)
    const na_espera = await F.pedir({ tipo: 'tentar', n: 2, usuario: 'ue' }, 'tentou');
    assert.equal(na_espera.saiu, 0, 'F não busca enquanto a trava do dono morto não vence');
    assert.ok(na_espera.resultados.every((r) => r.indisponivel === true && r.motivo === 'dono-morto'), JSON.stringify(na_espera.resultados));
    assert.equal(marcas(arq), 2);
    await waitUntil(async () => (await F.pedir({ tipo: 'estado' }, 'estado')).estado.ligada, 15_000, 'F assumir depois do prazo de abandono');
    const eF = (await F.pedir({ tipo: 'estado' }, 'estado'));
    assert.equal(eF.estado.carregadas, 4, 'as 2 buscas do processo que caiu voltaram (2 do usuário + 2 do global)');
    assert.equal(eF.globalUsadas, 2);
    assert.equal(eF.estado.pesquisaDisponivel, true);
    assert.equal(trava(arq)?.pid, F.pid);
    await F.pedir({ tipo: 'buscar', n: 1, usuario: 'ue' }, 'buscou');
    assert.equal(marcas(arq), 3);
    F.child.send({ tipo: 'sair' });
    assert.equal(await F.exit, 0);
    assert.equal(trava(arq), null);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. A fiação: cada ponto de entrada liga o papel certo e mais ninguém grava a cota');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('index.js liga `unico` no processo único e `bot-separado` com o cérebro separado; cerebro.js liga `cerebro`; só o cotaHora.js chama persistirHora', () => {
    const lerSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    const index = lerSrc('src/index.js');
    const iSep = index.indexOf("ligarCotaHora({ papel: 'bot-separado'");
    const iUnico = index.indexOf("ligarCotaHora({ papel: 'unico'");
    const iIf = index.indexOf('if (SEPARADO) {\n    // Cota de busca por hora em disco');
    const iElse = index.indexOf('} else {\n    await initMemory();');
    assert.ok(iSep > 0 && iUnico > 0 && iIf > 0 && iElse > 0, 'as duas chamadas existem');
    assert.ok(iIf < iSep && iSep < iElse, 'o bot-separado só no ramo do cérebro separado');
    assert.ok(iElse < iUnico, 'o unico só no ramo sem a chave');
    assert.equal((index.match(/ligarCotaHora\(/g) ?? []).length, 2, 'duas chamadas, nenhuma outra');
    const cerebro = lerSrc('src/cerebro.js');
    assert.match(cerebro, /ligarCotaHora\(\{ papel: 'cerebro'/);
    assert.equal((cerebro.match(/ligarCotaHora\(/g) ?? []).length, 1);
    // ninguém mais liga os contadores em disco (um gravador por configuração, escolhido num lugar só)
    const quem = [];
    const varre = (dir) => {
      for (const d of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, d.name);
        if (d.isDirectory()) { varre(rel); continue; }
        if (/\.(js|mjs)$/.test(d.name) && /\.persistirHora\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) quem.push(rel.replace(/\\/g, '/'));
      }
    };
    varre('src');
    assert.deepEqual(quem, ['src/search/cotaHora.js'], 'só o ligarCotaHora chama persistirHora');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. A queda entre a gravação e o despacho: a vaga só volta quando a AUSÊNCIA de despacho é comprovada');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  /** Um orçamento em disco, com a devolução observada: cada saída diz se devolveu a vaga (e quantas vezes). */
  function orcamentoObservado(nome) {
    const dir = pasta(nome);
    const arquivo = path.join(dir, 'search-budget-hora.json');
    const agora = Date.parse('2026-11-18T10:00:00Z');
    const b = createBudget({ filePath: path.join(dir, 'search-budget.json'), now: () => agora });
    b.persistirHora(arquivo, agora);
    const devolucoes = [];
    const refundOriginal = b.refund.bind(b);
    b.refund = (turn) => { const r = refundOriginal(turn); devolucoes.push(r); return r; };
    return { b, arquivo, devolucoes, agora, dir };
  }
  await test('as 4 saídas COM PROVA de que nada saiu DEVOLVEM a vaga: nenhum provedor ativo, todos descansando, cota mensal cheia e cancelada antes (e o arquivo volta a ter só o que saiu)', async () => {
    const MENSAL = { ...ENV, YUI_SEARCH_MONTHLY_CAP_SEARXNG: '1' }; // o teto de 1 busca por mês deste provedor
    for (const saida of ['sem-provedor', 'descansando', 'mensal-cheia', 'cancelada']) {
      resetCooldowns();
      const { b, arquivo, devolucoes, agora } = orcamentoObservado(`e-${saida}`);
      const base = { userId: 'u1', budget: b, now: () => agora };
      // o preparo (essas buscas SAÍRAM e contam): uma que levou 429 (o provedor passa a descansar) ou a única que o teto do mês deixa passar
      if (saida === 'descansando') await busca('esquenta', { ...base, fetchImpl: async () => json({}, 429) });
      if (saida === 'mensal-cheia') assert.equal((await busca('primeira do mês', { ...base, env: MENSAL })).provider, 'searxng');
      devolucoes.length = 0;
      const antes = { u: b.userStatus('u1', ENV).used, g: b.globalStatus(ENV).used, m: marcas(arquivo) };
      const c = contador(); // a busca sob teste: NADA pode chegar ao buscador
      const opts = { ...base, fetchImpl: c.fetchImpl };
      let r;
      if (saida === 'sem-provedor') r = await busca('x', { ...opts, env: { ...ENV, YUI_SEARCH_PROVIDERS: 'brave' } });
      else if (saida === 'descansando') r = await busca('x', opts);
      else if (saida === 'mensal-cheia') r = await busca('x', { ...opts, env: MENSAL });
      else r = await busca('x', { ...opts, signal: AbortSignal.abort() });
      assert.equal(r.provider, null, saida);
      if (saida === 'descansando') assert.ok(r.errors.some((e) => /descansando/.test(e)), JSON.stringify(r.errors));
      if (saida === 'mensal-cheia') assert.ok(r.errors.some((e) => /cota mensal atingida/.test(e)), JSON.stringify(r.errors));
      assert.equal(c.saiu, 0, `${saida}: nada saiu`);
      assert.deepEqual({ u: b.userStatus('u1', ENV).used, g: b.globalStatus(ENV).used, m: marcas(arquivo) }, antes, `${saida}: a vaga voltou (o arquivo também)`);
      assert.deepEqual(devolucoes, [true], `${saida}: devolveu UMA vez (com prova de que nada saiu)`);
    }
  });

  await test('as saídas SEM PROVA MANTÊM a cobrança: a exceção depois do despacho (rede, resposta ruim, prazo do provedor) e o provedor que respondeu "sem resultados" (a busca saiu)', async () => {
    const casos = {
      'a rede caiu depois do despacho': async () => { throw new Error('rede caiu (teste)'); },
      'resposta com erro do servidor (HTTP 500)': async () => json({}, 500),
      'corpo que não é JSON (a leitura lança depois do despacho)': async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('x'); }, text: async () => '{ não é json' }),
      'o provedor respondeu, sem resultados': async () => json({ results: [] }),
    };
    for (const [nome, fetchImpl] of Object.entries(casos)) {
      resetCooldowns();
      const { b, arquivo, devolucoes, agora } = orcamentoObservado(`e-pos-${Object.keys(casos).indexOf(nome)}`);
      let saiu = 0;
      const r = await busca('depois do despacho', { userId: 'u1', budget: b, now: () => agora, fetchImpl: async (...a) => { saiu += 1; return fetchImpl(...a); } });
      assert.equal(saiu, 1, `${nome}: a chamada CHEGOU ao provedor`);
      assert.equal(r.provider, null, nome);
      assert.deepEqual(devolucoes, [], `${nome}: NENHUMA devolução (sem prova de que nada saiu, a cobrança fica)`);
      assert.equal(b.userStatus('u1', ENV).used, 1, `${nome}: a cobrança ficou`);
      assert.equal(b.globalStatus(ENV).used, 1);
      assert.equal(marcas(arquivo), 1, `${nome}: e a marca continua no arquivo`);
    }
  });

  await test('QUEDA DO PROCESSO NO MEIO (processo de verdade): a busca já gravada que chegou ao "buscador" e o processo caiu CONTA ao voltar (falso consumo possível, nunca de menos); a gravada e devolvida (sem despacho) não conta', async () => {
    const orc = path.join(PROC, 'queda-meio', 'search-budget.json');
    const arq = hourlyFileFor(orc);
    const G = filho('cerebro-G', 'cerebro', orc);
    await G.esperar('pronto');
    // uma busca sem despacho (nenhum provedor): gravada e DEVOLVIDA; não deixa marca
    await G.pedir({ tipo: 'sem-despacho', n: 1, usuario: 'ug' }, 'buscou');
    assert.equal(marcas(arq), 0, 'a sem despacho foi devolvida (o arquivo ficou sem a marca)');
    // uma busca que chega ao "buscador" e fica pendurada: o teste espera o SINAL de que a chamada começou (nada de espera fixa) e derruba o processo ali
    const de = G.msgs.length;
    G.child.send({ tipo: 'pendurar', usuario: 'ug' });
    const d = await G.esperar('despachou', de);
    assert.equal(d.saiu, 1, 'a chamada chegou ao buscador');
    assert.equal(marcas(arq), 1, 'e a marca dela já estava no disco ANTES do despacho');
    G.child.kill(); // a queda (a trava fica no disco)
    await G.exit;
    const lento = { YUI_DB_OWNER_HEARTBEAT_MS: '200', YUI_DB_OWNER_STALE_MS: '1000' };
    const H = filho('cerebro-H', 'cerebro', orc, lento);
    await H.esperar('pronto');
    await waitUntil(async () => (await H.pedir({ tipo: 'estado' }, 'estado')).estado.ligada, 15_000, 'H assumir depois do prazo de abandono');
    const eH = await H.pedir({ tipo: 'estado' }, 'estado');
    assert.equal(eH.globalUsadas, 1, 'a busca que estava no ar quando o processo caiu CONTA (sem prova de que nada saiu, a cobrança fica)');
    assert.equal(eH.estado.carregadas, 2);
    H.child.send({ tipo: 'sair' });
    assert.equal(await H.exit, 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('F. A varredura dos caminhos: só o searchWeb despacha uma busca externa e todo caminho do bot passa por ele');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const lerSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const todosOsArquivos = (dir, acc = []) => {
    for (const d of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${d.name}`;
      if (d.isDirectory()) todosOsArquivos(rel, acc); else if (/\.(js|mjs)$/.test(d.name)) acc.push(rel);
    }
    return acc;
  };
  await test('a ÚNICA porta: o provedor só é chamado dentro da cadeia, a cadeia só dentro do searchWeb, e a porta de saída vem ANTES do cache, do compartilhamento e da cobrança', () => {
    const prov = lerSrc('src/search/providers.js');
    assert.equal((prov.match(/PROVIDERS\[name\]\.search\(/g) ?? []).length, 1, 'um único ponto chama o provedor');
    assert.equal((prov.match(/runChain\(/g) ?? []).length, 2, 'a definição e a chamada (só no searchWeb)');
    const iPorta = prov.indexOf('bud.despacho()');
    const iCache = prov.indexOf('cache.get(key)');
    const iJuntar = prov.indexOf('inflight.has(key)');
    const iCobra = prov.indexOf('bud.takeUser(');
    const iChain = prov.indexOf('await runChain(');
    assert.ok(iPorta > 0 && iPorta < iCache && iCache < iJuntar && iJuntar < iCobra && iCobra < iChain, 'a ordem: porta -> cache -> compartilhar -> cobrar -> cadeia');
    // o registro da cota mensal também vem antes de cada chamada ao provedor
    assert.ok(prov.indexOf('budget.registrarProvedor') > 0 && prov.indexOf('budget.registrarProvedor') < prov.indexOf('PROVIDERS[name].search('));
    // NENHUM outro arquivo do src fala com os buscadores externos: a exceção que existia (o agente de código do app, src/core/dev/web-search.js, que buscava no
    // DuckDuckGo por conta própria, fora da cota) acabou na revisão da Liz (§14 do relatório da etapa 8: "nenhum caminho de busca pode contornar o dono da cota").
    // Depois o próprio agente de código saiu, com os restos da aba Código (27/11/2026): o web-search.js e o módulo de código não existem mais.
    const hosts = /api\.search\.brave\.com|api\.tavily\.com|html\.duckduckgo\.com|www\.bing\.com\/search/;
    const outros = todosOsArquivos('src').filter((f) => f !== 'src/search/providers.js' && hosts.test(lerSrc(f)));
    assert.deepEqual(outros, [], 'só o providers.js conhece os endereços dos buscadores: nenhuma exceção, nem o agente de código do app');
    assert.equal(fs.existsSync(path.join(ROOT, 'src/core/dev/web-search.js')), false, 'o buscador do agente de código saiu com a aba Código');
    assert.deepEqual(todosOsArquivos('src').filter((f) => /\bcreateWebSearch\b/.test(lerSrc(f))), [], 'ninguém mais liga um buscador próprio');
    assert.deepEqual(todosOsArquivos('src').filter((f) => /from '[^']*\/dev\/(?:index|web-search|routes)\.js'/.test(lerSrc(f))), [], 'e nada importa o módulo de código removido');
    const indexJs = lerSrc('src/index.js');
    const iRamoSep = indexJs.indexOf('if (SEPARADO) {\n    logger.info(\'[Bootstrap] Yui API e Gateway: sobem no cérebro');
    assert.ok(iRamoSep > 0 && indexJs.indexOf('startApi(client)') > iRamoSep, 'com o cérebro separado o bot NÃO sobe a API: o startApi só no ramo sem a chave');
  });

  await test('quem chama o searchWeb (e seus envoltórios) é uma lista FECHADA: o agente, a busca automática e o ramo antigo; um chamador novo falha este teste até ser revisado', () => {
    // quem IMPORTA a porta (o searchWeb) ou um dos envoltórios dela (o searchForAgent do agente, o smartSearch da busca automática)
    const chamadores = todosOsArquivos('src').filter((f) => f !== 'src/search/providers.js'
      && /import\s*\{[^}]*\b(?:searchWeb|searchForAgent|smartSearchDetailed|smartSearch)\b[^}]*\}\s*from/.test(lerSrc(f)));
    assert.deepEqual(chamadores.sort(), [
      'src/cerebro/conversa.js', // a busca automática do passo do chat.turn
      'src/cerebro/monitores/executor.js', // os monitores de busca do dono (etapa 16): a MESMA porta, só se a porta está aberta e sobra mais que a reserva da conversa, privada e com identidade própria
      'src/cerebro/pesquisa.js', // o agente da fila e do /yui no cérebro e o ramo antigo
      'src/core/ai/research.js', // o agente do app (o adaptador do Core)
      'src/core/ai/searchManager.js', // searchForAgent e a busca automática (smartSearchDetailed)
      'src/handlers/llmHandler.js', // o processo único: o agente, a busca automática e o ramo antigo
    ].sort(), 'a lista de chamadores mudou: revise se o novo caminho passa pela porta de saída');
    // TODOS usam o searchWeb do providers.js (que tem a porta): nenhum tem a sua própria cadeia de buscadores
    for (const f of chamadores) assert.ok(!/\bPROVIDERS\b|runChain/.test(lerSrc(f)), `${f} não tem uma cadeia própria`);
    // a ORDEM nos pontos de entrada: a cota é ligada (a porta fecha, ou abre com a trava) ANTES de qualquer coisa que possa buscar: o login do Discord, o agendador, a
    // API (processo único) e os métodos de pesquisa do canal (cérebro)
    const index = lerSrc('src/index.js');
    const iBot = index.indexOf("ligarCotaHora({ papel: 'bot-separado'");
    const iUnico = index.indexOf("ligarCotaHora({ papel: 'unico'");
    for (const [nome, i] of [['bot-separado', iBot], ['unico', iUnico]]) {
      assert.ok(i > 0, `${nome}: a chamada existe`);
      for (const depois of ['client.login(', 'startScheduler(', 'startApi(client)']) assert.ok(i < index.indexOf(depois), `${nome}: o ligarCotaHora vem antes de ${depois}`);
    }
    const cerebroSrc = lerSrc('src/cerebro.js');
    const iCerebro = cerebroSrc.indexOf("ligarCotaHora({ papel: 'cerebro'");
    for (const depois of ['registerChatMethods(', 'registerResearchMethods(', 'startApi(null']) assert.ok(iCerebro > 0 && iCerebro < cerebroSrc.indexOf(depois), `cerebro: o ligarCotaHora vem antes de ${depois}`);
  });

  await test('NA PRÁTICA, com a porta fechada (bot separado): o agente de pesquisa, a busca automática e o searchForAgent falham de forma controlada, com o texto ÚNICO, sem chamar nenhum buscador', async () => {
    resetCooldowns();
    const budget = createBudget({ filePath: path.join(pasta('f-bot'), 'search-budget.json') });
    const h = ligarCotaHora({ papel: 'bot-separado', budget, logger: quiet });
    const c = contador();
    // 1. o searchForAgent (o adaptador de busca do agente): o resultado traz a razão e o texto único
    const out = await searchForAgent('qualquer consulta', { userId: 'u1', budget, env: ENV, fetchImpl: c.fetchImpl, logger: quiet });
    assert.equal(out.indisponivel, true);
    assert.equal(out.reason, 'unavailable');
    assert.equal(out.cause, 'unavailable');
    assert.equal(out.message, TEXTO_PESQUISA_INDISPONIVEL);
    // 2. o agente inteiro (o app e o cérebro usam o mesmo): a resposta é o aviso único, nenhuma chamada saiu
    const sinteses = [];
    const pesquisa = createCoreResearch({
      searchImpl: (q, o) => searchWeb(q, { ...o, fetchImpl: c.fetchImpl, env: ENV }), budget, readPage: async () => null,
      chat: async (a) => { sinteses.push(a); return 'resposta [1]'; }, forbiddenKeywords: [], isToolDisabled: () => false, userGuard: { tryAcquire: () => () => {} }, log: () => {},
    });
    const agente = await pesquisa.runResearchFor({ question: 'qual o preço do PS5 hoje', query: 'preço do ps5', userId: 'u1' });
    assert.equal(agente.kind, 'failed');
    assert.equal(agente.text, TEXTO_PESQUISA_INDISPONIVEL, agente.text);
    assert.equal(sinteses.length, 0, 'a síntese nem roda: não há web');
    // 3. a busca automática (o /yui e o passo do chat.turn): o motivo é "unavailable" e a mensagem é o texto único
    const auto = await smartSearchDetailed('pesquise o preço do ps5 hoje', async () => ({ text: 'SIM: preço do ps5' }), {
      userId: 'u1', forbiddenKeywords: [], logger: quiet, searchImpl: (q, o) => searchWeb(q, { ...o, fetchImpl: c.fetchImpl, env: ENV, budget, logger: quiet }),
    });
    assert.equal(auto.context, null);
    assert.equal(auto.reason, 'unavailable');
    assert.equal(auto.message, TEXTO_PESQUISA_INDISPONIVEL);
    // 4. o ramo antigo (a busca rápida + describeSearchOutcome): o mesmo texto
    const rapida = await searchWeb('consulta antiga', { userId: 'u1', budget, env: ENV, fetchImpl: c.fetchImpl, logger: quiet });
    assert.deepEqual(describeSearchOutcome(rapida, { hasContext: false }), { status: 'unavailable', message: TEXTO_PESQUISA_INDISPONIVEL });
    assert.equal(c.saiu, 0, 'NENHUMA chamada externa em nenhum dos caminhos');
    assert.equal(budget.userStatus('u1', ENV).used, 0);
    h.parar();
  });

  await test('o texto é ÚNICO e o motivo é o mesmo em todos os consumidores: classifyFailure, failureMessage, classifySearchOutcome e describeSearchOutcome', () => {
    assert.equal(classifyFailure([ERRO_PESQUISA_INDISPONIVEL]), 'unavailable');
    assert.equal(classifyFailure(['searxng: HTTP 500', ERRO_PESQUISA_INDISPONIVEL]), 'unavailable', 'vale por cima de um erro anterior da cadeia');
    assert.equal(failureMessage('unavailable'), TEXTO_PESQUISA_INDISPONIVEL);
    assert.equal(classifySearchOutcome({ results: [], errors: [ERRO_PESQUISA_INDISPONIVEL], indisponivel: true }).message, TEXTO_PESQUISA_INDISPONIVEL);
    assert.equal(describeSearchOutcome({ results: [], errors: [ERRO_PESQUISA_INDISPONIVEL] }).message, TEXTO_PESQUISA_INDISPONIVEL);
    // o texto ÚNICO que a Liz aprovou (§14 do relatório da etapa 8): exatamente este, curto e SEM a causa interna (nada de trava, diário, cota, dono ou processo)
    assert.equal(TEXTO_PESQUISA_INDISPONIVEL, 'Não consegui realizar a pesquisa agora. Posso continuar ajudando com o que já sei.');
    assert.ok(TEXTO_PESQUISA_INDISPONIVEL.length < 120, 'curto');
    assert.ok(!/trava|di[aá]rio|cota|processo|dono|disco|registro|bot\b|limite|teto/i.test(TEXTO_PESQUISA_INDISPONIVEL), 'sem dizer a causa');
    assert.ok(!/temporariamente|Tenta de novo daqui a pouco/.test(TEXTO_PESQUISA_INDISPONIVEL), 'a frase antiga não voltou');
  });

  await test('a porta de saída vem ANTES do cache: um resultado já guardado NÃO é entregue por um processo sem a trava', async () => {
    resetCooldowns();
    const budget = createBudget({ filePath: path.join(pasta('f-cache'), 'search-budget.json') });
    const comCache = { ...ENV, YUI_SEARCH_CACHE_TTL_MIN: '5' };
    const c = contador();
    assert.equal((await busca('cacheada', { budget, env: comCache, userId: 'u1', fetchImpl: c.fetchImpl })).provider, 'searxng');
    assert.equal((await busca('cacheada', { budget, env: comCache, userId: 'u1', fetchImpl: c.fetchImpl })).cached, true);
    budget.definirDespacho(false, 'perdida'); // perdeu a trava
    const c2 = contador();
    indisponivel(await busca('cacheada', { budget, env: comCache, userId: 'u1', fetchImpl: c2.fetchImpl }), c2, 'perdida', 'sem a trava nem o cache serve');
  });
} finally {
  say(`\n  bloqueio de integração externa: nenhuma tentativa nos processos auxiliares; exceções declaradas: ${BLOQUEIO?.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  for (const f of [...procs]) { try { f.child.kill(); } catch { /* */ } }
  await sleep(300);
  try { process.chdir(ROOT); } catch { /* */ }
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[cotahora] não apaguei ${T}: ${err.message}`); }
}
process.exit(failures.length ? 1 : 0);
