// Só quem declara "auto: true" pode entrar num plano aprovado automaticamente (ferramenta nova nasce sem; a pesquisa fica de fora porque manda palavras para fora).
// A LISTA FECHADA das ferramentas dos planos (v1: só leitura), independente da API e do registro do agente.
// Cada uma declara a ação na matriz de política, os parâmetros fechados, quando está disponível, a frase do plano (escrita pelo CÓDIGO a partir
// dos argumentos reais) e a leitura. Nenhuma grava nada (lembretes e listas são lidos direto, sem o armazenamento que move arquivo corrompido).
// Gmail, comandos, programas e escrita ficam de fora.
import fs from 'node:fs';
import path from 'node:path';
import { systemInfo, validateArgs } from '../agent/tools.js';
import { TOOL_ACCESS } from '../permissions.js';
import { fusoDoDono } from '../fuso.js';
import { createCoreResearch } from '../ai/research.js';
import { readResearchConfig, privateSearchAllowed, scrubQuery, trimLiteralQuery, saneQuery } from '../ai/researchAgent.js';
import { preRouteDecision } from '../ai/searchIntent.js';
import { forbiddenKeywords as PALAVRAS_PROIBIDAS } from '../forbiddenKeywords.js';
import { FOLDER_ALIASES, readBdsConfig, searchLibrary, listLibraryFolder, recentLibrary, statusLibrary, BdsError } from '../../services/bdsLibrary.js';
import { googleDoProcesso } from '../../integrations/google/index.js';
import { googleLigado, fusoDoGoogle } from '../../integrations/google/config.js';
import { listarEventos } from '../../integrations/google/agenda.js';
import { listarTarefas } from '../../integrations/google/tarefas.js';
import { limparTexto } from '../../integrations/google/dados.js';
import { dataDeHoje, somarDias, partesNoFuso, formatarHora } from '../../integrations/google/fuso.js';
import { defaultReminderFile } from '../../reminders/store.js';
import { defaultListDir, listSlug } from '../../handlers/listStore.js';

export const MAX_SAIDA_POR_PASSO = 900;
const falha = (mensagem) => Object.assign(new Error(mensagem), { expor: true });
// Argumentos: só tira controles, SEM acrescentar nada (aplicar de novo não muda; o hash aprovado confere na execução).
const semControle = (t, max = 120) => String(t ?? '').replace(/[\p{Cc}\p{Cf}`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
// Só para o que é MOSTRADO (frase do plano e resultado): também desarma a menção. Nunca usar em argumento.
const limpo = (t, max = 120) => semControle(t, max).replace(/@/g, '@​');

/** A consulta que REALMENTE sai para o buscador (as mesmas funções da pesquisa privada), ou null se não pode. Estável: aplicar de novo não muda. */
export function consultaDaPesquisa(texto, { forbiddenKeywords = PALAVRAS_PROIBIDAS } = {}) {
  const passo = (t) => {
    const bruto = String(t ?? '').trim();
    if (!bruto || !scrubQuery(bruto, { forbiddenKeywords }).ok) return null;
    const pre = preRouteDecision(`pesquise ${bruto}`, { direct: true });
    if (!pre.explicit) return null;
    const sane = saneQuery(trimLiteralQuery(pre.query));
    const checado = sane ? scrubQuery(sane, { forbiddenKeywords }) : null;
    return checado?.ok ? saneQuery(checado.query) || null : null;
  };
  const a = passo(texto);
  return a && passo(a) === a ? a : null;
}

function lerJson(arquivo) {
  try {
    if (fs.statSync(arquivo).size > 1024 * 1024) throw falha('O arquivo está grande demais para ler.');
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err?.expor ? err : falha('Não consegui ler o arquivo agora.');
  }
}

async function daBiblioteca(fn) {
  try { return await fn(); } catch (err) {
    throw falha(err instanceof BdsError ? 'Não consegui consultar o servidor de arquivos agora.' : 'Deu erro ao consultar a biblioteca.');
  }
}

const PERIODOS = { hoje: 'hoje', amanha: 'amanhã', semana: 'os próximos 7 dias', todas: 'todas' };

/**
 * @param {{ env?: object, deps?: object }} [o]  deps (teste): google, bds, pesquisa (runResearchFor), systemInfo, agora
 * @returns {Map<string, object>}
 */
export function criarFerramentasDePlano({ env = process.env, deps = {} } = {}) {
  const agora = deps.agora ?? Date.now;
  const bds = () => deps.bds ?? {};
  const comumGoogle = () => ({ env, ...(deps.google ?? { autenticador: googleDoProcesso(env).autenticador }) });
  const temBds = () => readBdsConfig(env).enabled;

  const lista = [
    {
      name: 'biblioteca_buscar', auto: true, action: 'bds.read', descricao: 'procura arquivos pelo nome na biblioteca (filmes, séries, importações)',
      params: { nome: { type: 'string', required: true, max: 80 } }, disponivel: temBds,
      preparar: (a) => { if (/[\\/]/.test(a.nome) || a.nome.includes('..')) return null; const nome = semControle(a.nome, 80); return nome.length >= 2 ? { nome } : null; },
      frase: (a) => `Procurar "${limpo(a.nome, 80)}" na biblioteca`,
      run: (a) => daBiblioteca(() => searchLibrary(a.nome, bds())),
    },
    {
      name: 'biblioteca_listar', auto: true, action: 'bds.read', descricao: 'lista uma pasta da biblioteca',
      params: { pasta: { type: 'string', required: true, max: 20, enum: Object.keys(FOLDER_ALIASES) } }, disponivel: temBds,
      frase: (a) => `Listar a pasta "${a.pasta}" da biblioteca`,
      run: (a) => daBiblioteca(() => listLibraryFolder(a.pasta, bds())),
    },
    {
      name: 'biblioteca_recentes', auto: true, action: 'bds.read', descricao: 'últimos arquivos que chegaram na biblioteca', params: {}, disponivel: temBds,
      frase: () => 'Ver o que chegou por último na biblioteca',
      run: () => daBiblioteca(() => recentLibrary(bds())),
    },
    {
      name: 'biblioteca_estado', auto: true, action: 'bds.read', descricao: 'se o servidor de arquivos está no ar e o espaço livre', params: {}, disponivel: temBds,
      frase: () => 'Ver a situação do servidor de arquivos',
      run: () => daBiblioteca(() => statusLibrary(bds())),
    },
    {
      name: 'agenda', auto: true, action: 'plan.agenda_read', descricao: 'compromissos da agenda do Google',
      params: { periodo: { type: 'string', required: true, max: 10, enum: ['hoje', 'amanha', 'semana'] } }, disponivel: () => googleLigado(env),
      frase: (a) => `Ler a sua agenda do Google (${PERIODOS[a.periodo]})`,
      async run(a) {
        const fuso = fusoDoGoogle(env);
        const r = await listarEventos({ ...comumGoogle(), periodo: a.periodo, agora, fuso });
        if (!r.ok) throw falha('Não consegui ler a sua agenda agora.');
        const linhas = r.eventos.map((e) => `• ${e.diaInteiro ? `${e.inicio} (dia inteiro)` : `${dataDeHoje(Date.parse(e.inicio), fuso)} ${formatarHora(e.inicio, fuso)}`}: ${limparTexto(e.titulo, 100)}`);
        if (r.truncado) linhas.push('(há mais compromissos)');
        return linhas.join('\n') || 'Nenhum compromisso no período.';
      },
    },
    {
      name: 'tarefas', auto: true, action: 'plan.tasks_read', descricao: 'tarefas pendentes do Google',
      params: { periodo: { type: 'string', required: true, max: 10, enum: Object.keys(PERIODOS) } }, disponivel: () => googleLigado(env),
      frase: (a) => `Ler as suas tarefas do Google (${PERIODOS[a.periodo]})`,
      async run(a) {
        let ate = null;
        if (a.periodo !== 'todas') {
          const p = partesNoFuso(agora(), fusoDoGoogle(env));
          const d = somarDias({ ano: p.ano, mes: p.mes, dia: p.dia }, a.periodo === 'amanha' ? 1 : a.periodo === 'semana' ? 6 : 0);
          ate = `${d.ano}-${String(d.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`;
        }
        const r = await listarTarefas({ ...comumGoogle(), ate });
        if (!r.ok) throw falha('Não consegui ler as suas tarefas agora.');
        const linhas = r.tarefas.map((t) => `• ${limparTexto(t.titulo, 100)}${t.vence ? ` (${t.vence})` : ''}`);
        if (r.truncado) linhas.push('(há mais tarefas)');
        return linhas.join('\n') || 'Nenhuma tarefa pendente.';
      },
    },
    {
      name: 'pesquisa', action: 'plan.web_search', descricao: 'pesquisa na web (devolve links)',
      params: { consulta: { type: 'string', required: true, max: 120 } },
      disponivel: () => readResearchConfig(env).enabled && privateSearchAllowed(readResearchConfig(env).privateSearch, { isOwner: true }),
      preparar: (a) => { const consulta = consultaDaPesquisa(a.consulta); return consulta ? { consulta } : null; },
      frase: (a) => `Pesquisar na web: "${a.consulta}" (essas palavras saem para o buscador)`,
      async run(a, { userId }) {
        if (consultaDaPesquisa(a.consulta) !== a.consulta) throw falha('A consulta aprovada não pode mais ser usada.');
        const { privateSearch } = readResearchConfig(env);
        // Sem síntese pela IA e sem abrir páginas: sai só a consulta aprovada, e o texto é montado aqui com os links.
        const pesquisar = deps.pesquisa ?? createCoreResearch({
          config: () => ({ maxSteps: 1, maxPages: 0, privateSearch }),
          chat: async () => { throw new Error('os planos não usam a IA no resultado'); },
        }).runResearchFor;
        const r = await pesquisar({ question: `pesquise ${a.consulta}`, userId, sensitive: true, isOwner: true });
        const fontes = Array.isArray(r?.sources) ? r.sources : [];
        if (!fontes.length) throw falha('A pesquisa não trouxe resultados agora.');
        return fontes.slice(0, 3).map((f) => `• ${limpo(f.title, 90)} <${String(f.url).replace(/[<>\s]/g, '')}>`).join('\n');
      },
    },
    {
      name: 'lembretes', auto: true, action: 'plan.reminders_read', descricao: 'seus lembretes', params: {}, disponivel: () => true,
      frase: () => 'Ler os seus lembretes',
      async run() {
        const bruto = lerJson(defaultReminderFile(env));
        const itens = (Array.isArray(bruto?.items) ? bruto.items : [])
          .filter((r) => r && (!r.userId || r.fromOwner === true) && !Number.isNaN(Date.parse(r.at)))
          .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
        const data = new Intl.DateTimeFormat('pt-BR', { timeZone: fusoDoDono(env), dateStyle: 'short', timeStyle: 'short' });
        const linhas = itens.slice(0, 15).map((r) => `• ${data.format(new Date(r.at))}: ${limpo(r.text, 100)}`);
        if (itens.length > 15) linhas.push(`(mais ${itens.length - 15})`);
        return linhas.join('\n') || 'Nenhum lembrete.';
      },
    },
    {
      name: 'listas', auto: true, action: 'plan.lists_read', descricao: 'suas listas salvas (sem "lista": só os nomes)',
      params: { lista: { type: 'string', max: 60 } }, disponivel: () => true,
      preparar: (a) => (a.lista === undefined ? {} : listSlug(a.lista) ? { lista: semControle(a.lista, 60) } : null),
      frase: (a) => (a.lista ? `Ler a lista "${limpo(a.lista, 60)}"` : 'Ver os nomes das suas listas'),
      async run(a, { userId }) {
        if (!/^\d{5,25}$/.test(String(userId))) throw falha('Usuário inválido.');
        const bruto = lerJson(path.join(defaultListDir(env), `${userId}.json`));
        const listas = bruto?.lists && typeof bruto.lists === 'object' ? bruto.lists : {};
        if (!a.lista) return Object.values(listas).map((l) => `• ${limpo(l.name, 60)} (${l.items?.length ?? 0})`).join('\n') || 'Nenhuma lista salva.';
        const slug = listSlug(a.lista);
        const l = Object.hasOwn(listas, slug) ? listas[slug] : null;
        if (!l) throw falha('Não achei essa lista.');
        return (l.items ?? []).map((i, n) => `${n + 1}. ${limpo(i.text, 100)}${i.done ? ' (feito)' : ''}`).join('\n') || 'A lista está vazia.';
      },
    },
    {
      name: 'computador', auto: true, action: 'system.info', descricao: 'estado do computador da Yui',
      params: { parte: { type: 'string', max: 10, enum: ['all', 'cpu', 'memory', 'disk', 'uptime'] } },
      disponivel: () => String(env.YUI_TOOLS_PC_ENABLED ?? '').trim().toLowerCase() === 'true',
      frase: (a) => `Ver o estado do computador${a.parte && a.parte !== 'all' ? ` (${a.parte})` : ''}`,
      run: (a) => (deps.systemInfo ?? systemInfo)(a.parte ?? 'all'),
    },
  ];
  return new Map(lista.map((f) => [f.name, Object.freeze({ access: TOOL_ACCESS.READ, auto: false, preparar: (a) => a, ...f })]));
}

/** Argumentos conferidos contra o esquema fechado (nada de objeto, lista ou chave a mais). null = não vale. */
export function argumentosValidos(ferramenta, brutos) {
  const src = brutos ?? {};
  if (typeof src !== 'object' || Array.isArray(src) || Object.keys(src).some((k) => !Object.hasOwn(ferramenta.params, k))) return null;
  if (Object.values(src).some((v) => v !== null && typeof v !== 'string')) return null;
  try { return ferramenta.preparar(validateArgs(ferramenta, src)); } catch { return null; }
}
