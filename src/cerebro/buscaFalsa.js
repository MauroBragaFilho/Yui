// BUSCA FALSA para os testes de ponta a ponta da pesquisa no cérebro (tests/test-pesquisa-cerebro.js). NUNCA vale em produção.
//
// Só liga com as DUAS condições: YUI_TESTE_BUSCA_FALSA=true E NODE_ENV=test (o mesmo padrão da IA falsa). Fora disso a variável é ignorada
// e o cérebro avisa no log. Sem rede: os "buscadores" devolvem resultados montados a partir da própria consulta (com as marcas `tok-...`
// dela, para o teste conferir que cada pessoa recebeu a evidência da PRÓPRIA pergunta) e o "leitor de páginas" devolve um texto fixo com a
// marca da página. Cada busca e cada leitura vira uma linha JSON em YUI_TESTE_BUSCA_FALSA_REGISTRO (o teste conta quantas buscas rodaram:
// idempotência). O arquivo YUI_TESTE_BUSCA_FALSA_CONTROLE (relido a cada chamada) simula a busca lenta ({ "atrasoMs": 4000 }), fora do ar
// ({ "falhar": true }) ou sem resultados ({ "semResultados": true }).
// Ajustes da Liz (etapa 6, §11): com YUI_TESTE_BUSCA_FALSA_COTA=true (ou `budget` injetado) cada busca passa pela cota por hora de verdade
// (search/budget.js: takeUser), como o searchWeb, para o teste conferir que a retomada conta a cota certo. `pausa` (só injetado, nos testes de
// unidade) segura a busca DEPOIS de ela chegar ao "buscador" (o registro já foi feito): o teste derruba o cérebro nesse instante.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDefaultBudget } from '../search/budget.js';
import { resultadoIndisponivel } from '../search/indisponivel.js';

/** 'on', 'off' ou 'refused' (variável ligada fora de NODE_ENV=test). */
export function fakeSearchMode(env = process.env) {
  const wanted = String(env.YUI_TESTE_BUSCA_FALSA ?? '').trim().toLowerCase() === 'true';
  if (!wanted) return 'off';
  return String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test' ? 'on' : 'refused';
}

function controle(env) {
  const file = String(env.YUI_TESTE_BUSCA_FALSA_CONTROLE ?? '').trim();
  if (!file) return {};
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return { atrasoMs: Math.max(0, Math.min(60_000, Number(c.atrasoMs) || 0)), falhar: c.falhar === true, semResultados: c.semResultados === true };
  } catch {
    return {};
  }
}

function registrar(env, linha) {
  const file = String(env.YUI_TESTE_BUSCA_FALSA_REGISTRO ?? '').trim();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...linha, pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch { /* o registro do teste nunca derruba a busca */ }
}

const tokensIn = (text) => [...new Set(String(text ?? '').match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const sleep = (ms, signal) => new Promise((resolve) => {
  if (!ms) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Os dublês: search (o do agente), searchWeb (o da busca automática e do ramo antigo) e readPage. */
export function createFakeSearch({ env = process.env, budget = null, pausa = null } = {}) {
  const resultados = (query) => {
    const h = crypto.createHash('sha256').update(String(query)).digest('hex').slice(0, 8);
    const marcas = tokensIn(query).join(' ');
    return [1, 2, 3].map((n) => ({
      title: `Resultado ${n} sobre ${String(query).slice(0, 60)}`,
      url: `https://fonte${n}.exemplo-teste.org/artigo-${h}-${n}`,
      snippet: `Trecho ${n} da web para a consulta ${marcas || h}: informação útil sobre o assunto pedido, com detalhes ${n}.`,
    }));
  };
  async function base(tipo, query, o = {}) {
    const c = controle(env);
    // A porta de saída e a cota por hora, como no searchWeb de verdade: sem o dono da cota, sem gravar o registro ou recusada, não chega ao "buscador"
    // (etapa 8, revisão da Liz §12: a pesquisa fica indisponível, nunca uma cota independente em memória).
    if (budget) {
      const porta = budget.despacho?.();
      if (porta && porta.permitido === false) return resultadoIndisponivel(porta.codigo);
      const turn = budget.takeUser(o.userId ?? null, env);
      if (!turn.ok && turn.scope === 'registro') return resultadoIndisponivel('registro-da-cota');
      if (!turn.ok) return { provider: null, results: [], errors: ['limite de buscas por usuário atingido'], limited: 'user', retryAfterMs: turn.retryAfterMs };
    }
    // `private` é o nome do agente de pesquisa; `privado`, o da busca automática (etapa 11: a pesquisa por intenção na conversa privada)
    registrar(env, { tipo, consulta: String(query ?? '').slice(0, 300), userId: o.userId ?? null, privado: o.private === true || o.privado === true });
    if (typeof pausa === 'function') await pausa({ tipo, consulta: String(query ?? '') });
    await sleep(c.atrasoMs, o.signal);
    if (c.falhar) return { provider: null, results: [], errors: ['busca-falsa: erro de teste'] };
    if (c.semResultados) return { provider: 'busca-falsa', results: [], errors: ['busca-falsa: sem resultados'] };
    return { provider: 'busca-falsa', results: resultados(query), errors: [] };
  }
  return {
    falsa: true,
    search: (query, o) => base('agente', query, o),
    searchWeb: (query, o) => base('rapida', query, o),
    async readPage(url, o = {}) {
      registrar(env, { tipo: 'pagina', url: String(url).slice(0, 200), privado: o.private === true || o.quiet === true });
      const n = /fonte(\d)/.exec(String(url))?.[1] ?? '0';
      return `Conteúdo da página ${n} (tok-PAGINA${n}). ${'Texto de teste com informação sobre o assunto. '.repeat(6)}`;
    },
  };
}

/** Liga a busca falsa se (e só se) o modo for 'on'. Devolve os dublês ou null. */
export function activateFakeSearch({ env = process.env, logger = null } = {}) {
  const mode = fakeSearchMode(env);
  if (mode === 'on') {
    logger?.warn?.('[Cérebro] BUSCA FALSA ligada: só para teste (NODE_ENV=test). Nenhuma busca real na web.');
    const comCota = String(env.YUI_TESTE_BUSCA_FALSA_COTA ?? '').trim().toLowerCase() === 'true';
    return createFakeSearch({ env, budget: comCota ? getDefaultBudget() : null });
  }
  if (mode === 'refused') logger?.error?.('[Cérebro] YUI_TESTE_BUSCA_FALSA=true ignorado: a busca falsa só liga com NODE_ENV=test.');
  return null;
}
