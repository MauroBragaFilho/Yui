// Processo auxiliar do test:cotahora (tests/test-cota-hora-disco.js): faz o papel de UM processo da Yui (único, cérebro ou bot separado) no que
// toca a cota de busca por hora em disco: liga a cota (src/search/cotaHora.js, o mesmo código que o index.js e o cerebro.js chamam), faz buscas de
// verdade pelo searchWeb (com um buscador FALSO: nenhuma rede) e responde ao teste por IPC. Só roda com NODE_ENV=test e sempre sob o bloqueio de
// integração externa (o teste abre este arquivo com `node --import tests/helpers/bloqueioExterno.mjs`).
//
// Variáveis: YUI_REPO (a raiz do código), YUI_SEARCH_BUDGET_FILE (o arquivo mensal; o da hora fica ao lado), COTA_PAPEL (unico | cerebro | bot-separado).
// Mensagens do teste ({ tipo, ... }): `buscar` { n, usuario } faz n buscas despachadas e FALHA se alguma não sair; `tentar` { n, usuario } faz n buscas e
// devolve o que aconteceu com cada uma (o que saiu para o "buscador" e o que voltou: é como o teste vê a pesquisa INDISPONÍVEL); `pendurar` { usuario }
// começa uma busca cujo "buscador" NUNCA responde e avisa (`despachou`) quando a chamada chega a ele (o teste derruba este processo ali: a queda no
// meio); `sem-despacho` { n } faz n buscas SEM provedor ativo (nada sai); `estado`; `sair` (saída normal: a trava é solta).
// Respostas: { tipo: 'pronto'|'buscou'|'tentou'|'despachou'|'estado', ... }.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (String(process.env.NODE_ENV ?? '').toLowerCase() !== 'test') { console.error('só para teste (NODE_ENV=test)'); process.exit(97); }
const repo = String(process.env.YUI_REPO ?? '');
const imp = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { getDefaultBudget } = await imp('src/search/budget.js');
const { ligarCotaHora, estadoDaCotaHora } = await imp('src/search/cotaHora.js');
const { searchWeb, resetCooldowns } = await imp('src/search/providers.js');

const logs = [];
const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug() {} };
const budget = getDefaultBudget();
const handle = ligarCotaHora({ papel: String(process.env.COTA_PAPEL), budget, logger });

const ENV = { SEARXNG_URL: 'http://127.0.0.1:8080/', YUI_SEARCH_PROVIDERS: 'searxng', YUI_SEARCH_USER_PER_HOUR: '500', YUI_SEARCH_GLOBAL_PER_HOUR: '1000' };
const ENV_SEM_PROVEDOR = { YUI_SEARCH_PROVIDERS: 'brave', YUI_SEARCH_USER_PER_HOUR: '500', YUI_SEARCH_GLOBAL_PER_HOUR: '1000' }; // sem chave: nenhum provedor ativo
let nBusca = 0;
let saiu = 0; // quantas chamadas CHEGARAM ao "buscador" falso deste processo
const CORPO = { results: [{ title: 'T', url: 'https://exemplo.invalid/a', content: 'c' }] };
const resposta = { ok: true, status: 200, headers: new Headers(), json: async () => CORPO, text: async () => JSON.stringify(CORPO) };
const snapshot = () => ({ estado: estadoDaCotaHora(), hora: budget.hourlyStats(), globalUsadas: budget.globalStatus(ENV).used, saiu, logs: logs.slice(-6) });

process.on('message', async (m) => {
  try {
    if (m?.tipo === 'buscar') {
      for (let i = 0; i < Number(m.n || 1); i += 1) {
        resetCooldowns();
        const r = await searchWeb(`consulta ${process.pid} ${++nBusca}`, { env: ENV, fetchImpl: async () => { saiu += 1; return resposta; }, userId: m.usuario ?? 'u', budget, logger });
        if (!r.provider) throw new Error(`a busca não saiu: ${JSON.stringify(r.errors)}`);
      }
      process.send({ tipo: 'buscou', ...snapshot() });
    } else if (m?.tipo === 'tentar') {
      const resultados = [];
      for (let i = 0; i < Number(m.n || 1); i += 1) {
        resetCooldowns();
        const r = await searchWeb(`tentativa ${process.pid} ${++nBusca}`, { env: ENV, fetchImpl: async () => { saiu += 1; return resposta; }, userId: m.usuario ?? 'u', budget, logger });
        resultados.push({ provider: r.provider, indisponivel: r.indisponivel === true, motivo: r.motivo ?? null, errors: r.errors });
      }
      process.send({ tipo: 'tentou', resultados, ...snapshot() });
    } else if (m?.tipo === 'pendurar') {
      resetCooldowns();
      // o "buscador" nunca responde: a chamada fica pendurada até o teste derrubar este processo (a queda no meio do despacho)
      searchWeb(`pendurada ${process.pid} ${++nBusca}`, { env: ENV, fetchImpl: () => { saiu += 1; process.send({ tipo: 'despachou', ...snapshot() }); return new Promise(() => {}); }, userId: m.usuario ?? 'u', budget, logger, deadlineMs: 120_000, providerTimeoutMs: 120_000 }).catch(() => {});
    } else if (m?.tipo === 'sem-despacho') {
      for (let i = 0; i < Number(m.n || 1); i += 1) await searchWeb(`sem provedor ${++nBusca}`, { env: ENV_SEM_PROVEDOR, fetchImpl: async () => { throw new Error('não podia sair'); }, userId: m.usuario ?? 'u', budget, logger });
      process.send({ tipo: 'buscou', ...snapshot() });
    } else if (m?.tipo === 'estado') {
      process.send({ tipo: 'estado', ...snapshot() });
    } else if (m?.tipo === 'sair') {
      process.exit(0);
    }
  } catch (err) {
    process.send({ tipo: 'erro', mensagem: String(err?.message ?? err).slice(0, 300) });
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ tipo: 'pronto', ...snapshot(), handle: Boolean(handle) });
