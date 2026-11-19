// O ESTADO dos monitores (etapa 16, proatividade): UM arquivo JSON, <DATABASE_DIR>/monitores.json.
//
// DONO ÚNICO: o arquivo é do CÉREBRO. Só o processo do cérebro (um só, protegido pela trava de dono dos bancos de memória) o abre e grava;
// o bot nunca o abre (este módulo recusa abrir com YUI_DB_OWNER_ROLE=bot). Gravação ATÔMICA e durável (temporário + fsync + rename: o
// mesmo writeJsonAtomic da idempotência persistente): uma queda no meio deixa o arquivo antigo inteiro ou o novo inteiro. Se a gravação
// falha (disco cheio, somente leitura), a mudança NÃO vale: a memória só muda depois que o disco aceitou (quem chama trata o erro).
// Mesmo padrão do lembretes.json (src/reminders/store.js) e do diário da pesquisa (src/cerebro/pesquisaRetomada.js).
//
// O que cada monitor guarda:
//   { id, dono, consulta, criadoEm, ate, intervaloMin, ultimaChecagem, ultimaAssinatura, estado: ativo|pausado|encerrado, avisos,
//     proximaChecagem, falhas, aviso, motivoFim, encerradoEm }
// NUNCA o texto dos resultados da busca (nem título, nem trecho, nem endereço): só `ultimaAssinatura`, o hash dos 3 primeiros resultados.
// `consulta` é o que a PESSOA pediu (texto dela, curto e já limpo). `aviso` é a entrega de UM aviso em andamento (veja entrega.js):
//   { tipo: 'novidade'|'fim', estado: 'pendente'|'enviando'|'incerto', chave, assinatura?, tentativas, desde?, proximaTentativa?, motivo? }
// (a chave de idempotência, o estado e nada do conteúdo do aviso). Arquivo ilegível: a cópia vai para `monitores.json.corrompido` e o
// estado recomeça vazio (nunca derruba a Yui).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/channel/idemPersistente.js';
import { LIMITES } from './config.js';
import { assinaturaValida, normalizarTitulo } from './assinatura.js';

export const ESTADOS = Object.freeze({ ATIVO: 'ativo', PAUSADO: 'pausado', ENCERRADO: 'encerrado' });
export const TIPOS_DE_AVISO = Object.freeze({ NOVIDADE: 'novidade', FIM: 'fim' });
export const ESTADOS_DO_AVISO = Object.freeze({ PENDENTE: 'pendente', ENVIANDO: 'enviando', INCERTO: 'incerto' });
export const MOTIVOS_DO_FIM = Object.freeze(['vencido', 'cancelado']);

const VERSAO = 1;
const MAX_ABERTOS = 15; // ativos + pausados (o arquivo fica pequeno)
const MAX_BYTES = 256 * 1024;
const DIA_MS = 24 * 60 * 60_000;
const HORA_MS = 60 * 60_000;
const CHAVE_AVISO_RE = /^monitor:\d{1,6}:(?:[0-9a-f]{24}|fim)(?::r\d{1,3})?$/;
const set = (obj) => new Set(Object.values(obj));
const ESTADOS_VALIDOS = set(ESTADOS);
const TIPOS_VALIDOS = set(TIPOS_DE_AVISO);
const ESTADOS_AVISO_VALIDOS = set(ESTADOS_DO_AVISO);

export class MonitorError extends Error {
  /** codigo: 'limite' | 'repetido' | 'consulta' | 'inexistente' | 'estado' */
  constructor(codigo, mensagem, extra = {}) {
    super(mensagem);
    this.name = 'MonitorError';
    this.codigo = codigo;
    Object.assign(this, extra);
  }
}

/** O arquivo do estado (dono: o cérebro): <DATABASE_DIR>/monitores.json. */
export function arquivoDosMonitores(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'monitores.json');
}

const dataValida = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const iso = (ms) => new Date(ms).toISOString();
const inteiro = (v, min, max, padrao) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

/** O aviso em andamento, conferido campo a campo (o que não presta vira null). */
function avisoValido(a) {
  if (!a || typeof a !== 'object') return null;
  if (!TIPOS_VALIDOS.has(a.tipo) || !ESTADOS_AVISO_VALIDOS.has(a.estado)) return null;
  if (typeof a.chave !== 'string' || !CHAVE_AVISO_RE.test(a.chave)) return null;
  const out = { tipo: a.tipo, estado: a.estado, chave: a.chave, tentativas: inteiro(a.tentativas, 0, 100_000, 0) };
  if (assinaturaValida(a.assinatura)) out.assinatura = a.assinatura;
  if (dataValida(a.desde)) out.desde = a.desde;
  if (dataValida(a.proximaTentativa)) out.proximaTentativa = a.proximaTentativa;
  if (dataValida(a.incertoDesde)) out.incertoDesde = a.incertoDesde;
  if (typeof a.motivo === 'string') out.motivo = a.motivo.slice(0, 160);
  return out;
}

/** Um registro lido do disco, conferido campo a campo (campos desconhecidos somem: nada de texto de resultado entra por aqui). */
function monitorValido(m) {
  if (!m || typeof m !== 'object') return null;
  if (!Number.isInteger(m.id) || m.id < 1) return null;
  if (typeof m.dono !== 'string' || !/^\d{5,25}$/.test(m.dono)) return null;
  if (typeof m.consulta !== 'string' || !m.consulta.trim() || m.consulta.length > 400) return null;
  if (!dataValida(m.criadoEm) || !dataValida(m.ate)) return null;
  if (!ESTADOS_VALIDOS.has(m.estado)) return null;
  const out = {
    id: m.id,
    dono: m.dono,
    consulta: m.consulta,
    criadoEm: m.criadoEm,
    ate: m.ate,
    intervaloMin: inteiro(m.intervaloMin, LIMITES.intervaloMinimoMin, LIMITES.intervaloMaximoMin, LIMITES.intervaloPadraoMin),
    ultimaChecagem: dataValida(m.ultimaChecagem) ? m.ultimaChecagem : null,
    ultimaAssinatura: assinaturaValida(m.ultimaAssinatura) ? m.ultimaAssinatura : null,
    estado: m.estado,
    avisos: inteiro(m.avisos, 0, 1_000_000, 0),
    proximaChecagem: dataValida(m.proximaChecagem) ? m.proximaChecagem : m.criadoEm,
    falhas: inteiro(m.falhas, 0, 1_000_000, 0),
    aviso: avisoValido(m.aviso),
  };
  if (dataValida(m.ultimaTentativa)) out.ultimaTentativa = m.ultimaTentativa;
  if (MOTIVOS_DO_FIM.includes(m.motivoFim)) out.motivoFim = m.motivoFim;
  if (dataValida(m.encerradoEm)) out.encerradoEm = m.encerradoEm;
  return out;
}

const copia = (m) => JSON.parse(JSON.stringify(m));
/** A chave de comparação da consulta (sem acento, minúscula, só letras e números): "Patch 1.5!" e "patch 1 5" são o mesmo monitor. */
export const chaveDaConsulta = (consulta) => normalizarTitulo(consulta);

/**
 * @param {{ file?: string, now?: () => number, env?: object, logger?: object|null }} [opcoes]
 */
export function criarStoreDeMonitores({ file = arquivoDosMonitores(), now = () => Date.now(), env = process.env, logger = null } = {}) {
  if (String(env?.YUI_DB_OWNER_ROLE ?? '').trim().toLowerCase() === 'bot') {
    throw Object.assign(new Error('Os monitores são do cérebro: o bot nunca abre o monitores.json.'), { code: 'YUI_MONITORES_DONO' });
  }
  let estado = null;

  function carregar() {
    if (estado) return estado;
    estado = { proximoId: 1, itens: [] };
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > MAX_BYTES) throw new Error('arquivo grande demais');
        const bruto = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (bruto && Array.isArray(bruto.itens)) {
          estado.itens = bruto.itens.map(monitorValido).filter(Boolean);
          estado.proximoId = Math.max(inteiro(bruto.proximoId, 1, 1_000_000_000, 1), ...estado.itens.map((m) => m.id + 1), 1);
        }
      }
    } catch (err) {
      try { fs.copyFileSync(file, `${file}.corrompido`); } catch { /* sem cópia */ }
      logger?.warn?.(`[Monitores] o arquivo de estado estava ilegível (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); recomeçando vazio.`);
      estado = { proximoId: 1, itens: [] };
    }
    return estado;
  }

  /** Os encerrados antigos saem do arquivo (mas nunca um que ainda tem aviso para entregar). */
  function podar(itens, at) {
    const mantidos = itens.filter((m) => m.estado !== ESTADOS.ENCERRADO || m.aviso || at - Date.parse(m.encerradoEm ?? m.criadoEm) < LIMITES.encerradoGuardadoMs);
    if (mantidos.length <= LIMITES.maxRegistros) return mantidos;
    const excesso = mantidos.length - LIMITES.maxRegistros;
    const saem = new Set(mantidos.filter((m) => m.estado === ESTADOS.ENCERRADO && !m.aviso)
      .sort((a, b) => Date.parse(a.encerradoEm ?? a.criadoEm) - Date.parse(b.encerradoEm ?? b.criadoEm)).slice(0, excesso).map((m) => m.id));
    return mantidos.filter((m) => !saem.has(m.id));
  }

  /** Aplica a mudança numa cópia, grava (atômico) e só então passa a valer na memória. Lança se o disco não aceitou. */
  function efetivar(mutar) {
    const base = carregar();
    const novo = { proximoId: base.proximoId, itens: base.itens.map(copia) };
    const resultado = mutar(novo);
    novo.itens = podar(novo.itens, now());
    writeJsonAtomic(file, { versao: VERSAO, proximoId: novo.proximoId, itens: novo.itens });
    estado = novo;
    return resultado;
  }

  const buscar = (itens, id) => itens.find((m) => m.id === Number(id)) ?? null;

  const api = {
    file,
    /** Todos os monitores (cópias), do id menor para o maior. */
    todos: () => carregar().itens.map(copia).sort((a, b) => a.id - b.id),
    obter: (id) => { const m = buscar(carregar().itens, id); return m ? copia(m) : null; },
    contarAtivos: (dono) => carregar().itens.filter((m) => m.dono === String(dono) && m.estado === ESTADOS.ATIVO).length,

    /**
     * Cria um monitor. `prazoMs` (padrão 14 dias) fica entre 1 hora e 60 dias. Lança MonitorError: 'consulta' (vazia), 'limite' (já tem 5
     * ativos, ou 15 abertos) ou 'repetido' (já existe um monitor aberto para a mesma consulta; `.id` diz qual).
     */
    criar({ dono, consulta, prazoMs = null }) {
      const quem = String(dono ?? '');
      const texto = String(consulta ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!/^\d{5,25}$/.test(quem) || !chaveDaConsulta(texto)) throw new MonitorError('consulta', 'Sobre o que devo ficar de olho?');
      return copia(efetivar((s) => {
        const meus = s.itens.filter((m) => m.dono === quem);
        const repetido = meus.find((m) => m.estado !== ESTADOS.ENCERRADO && chaveDaConsulta(m.consulta) === chaveDaConsulta(texto));
        if (repetido) throw new MonitorError('repetido', `Já existe o monitor #${repetido.id} para essa consulta.`, { id: repetido.id });
        if (meus.filter((m) => m.estado === ESTADOS.ATIVO).length >= LIMITES.maxAtivos || s.itens.filter((m) => m.estado !== ESTADOS.ENCERRADO).length >= MAX_ABERTOS) {
          throw new MonitorError('limite', `Você já tem ${LIMITES.maxAtivos} monitores ativos.`);
        }
        const t = now();
        const prazo = Math.min(LIMITES.prazoMaximoDias * DIA_MS, Math.max(LIMITES.prazoMinimoHoras * HORA_MS, Number.isFinite(prazoMs) && prazoMs > 0 ? prazoMs : LIMITES.prazoPadraoDias * DIA_MS));
        const m = {
          id: s.proximoId++, dono: quem, consulta: texto, criadoEm: iso(t), ate: iso(t + prazo), intervaloMin: LIMITES.intervaloPadraoMin,
          ultimaChecagem: null, ultimaAssinatura: null, estado: ESTADOS.ATIVO, avisos: 0, proximaChecagem: iso(t), falhas: 0, aviso: null,
        };
        s.itens.push(m);
        return m;
      }));
    },

    /**
     * Muda campos de UM monitor (só os que o estado conhece; `undefined` apaga o campo opcional). Devolve a cópia nova ou null se o id não existe.
     * Lança se o disco não gravou (a mudança não vale).
     */
    atualizar(id, patch = {}) {
      if (!buscar(carregar().itens, id)) return null;
      return copia(efetivar((s) => {
        const m = buscar(s.itens, id);
        const bruto = { ...m, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete bruto[k];
        const valido = monitorValido(bruto);
        if (!valido) throw new MonitorError('estado', 'Mudança inválida no monitor.');
        Object.keys(m).forEach((k) => delete m[k]);
        Object.assign(m, valido);
        return m;
      }));
    },

    /** Cancela (encerra a pedido da pessoa). O aviso de novidade que estava para sair é descartado. Devolve { ok, monitor, motivo? }. */
    cancelar(id) {
      const atual = buscar(carregar().itens, id);
      if (!atual) return { ok: false, motivo: 'inexistente' };
      if (atual.estado === ESTADOS.ENCERRADO) return { ok: false, motivo: 'encerrado', monitor: copia(atual) };
      const monitor = api.atualizar(id, { estado: ESTADOS.ENCERRADO, motivoFim: 'cancelado', encerradoEm: iso(now()), aviso: null });
      return { ok: true, monitor };
    },

    pausar(id) {
      const atual = buscar(carregar().itens, id);
      if (!atual) return { ok: false, motivo: 'inexistente' };
      if (atual.estado !== ESTADOS.ATIVO) return { ok: false, motivo: atual.estado, monitor: copia(atual) };
      return { ok: true, monitor: api.atualizar(id, { estado: ESTADOS.PAUSADO }) };
    },

    /** Retoma um pausado: a referência é refeita (a primeira checagem depois de retomar não avisa) e o limite de ativos vale de novo. */
    retomar(id) {
      const atual = buscar(carregar().itens, id);
      if (!atual) return { ok: false, motivo: 'inexistente' };
      if (atual.estado !== ESTADOS.PAUSADO) return { ok: false, motivo: atual.estado, monitor: copia(atual) };
      if (carregar().itens.filter((m) => m.dono === atual.dono && m.estado === ESTADOS.ATIVO).length >= LIMITES.maxAtivos) return { ok: false, motivo: 'limite', monitor: copia(atual) };
      return { ok: true, monitor: api.atualizar(id, { estado: ESTADOS.ATIVO, ultimaAssinatura: null, proximaChecagem: iso(now()) }) };
    },

    /** Números para a saúde (sem consulta, sem id de pessoa). */
    resumo() {
      const itens = carregar().itens;
      const conta = (e) => itens.filter((m) => m.estado === e).length;
      const avisoEm = (e) => itens.filter((m) => m.aviso?.estado === e).map((m) => m.id);
      return { ativos: conta(ESTADOS.ATIVO), pausados: conta(ESTADOS.PAUSADO), encerrados: conta(ESTADOS.ENCERRADO), avisosPendentes: avisoEm('pendente'), avisosEnviando: avisoEm('enviando'), avisosIncertos: avisoEm('incerto') };
    },
  };
  return api;
}
