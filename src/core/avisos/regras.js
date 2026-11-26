// AVISOS NA HORA CERTA (Fase 3, parte 3A; docs/DESENHO_FASE3_YUI_PERSONAL_AI.md §2): as REGRAS, em um módulo puro (sem disco, sem rede, sem log,
// sem estado). Hoje só são usadas pelo modo OBSERVAR (observar.js): nada é adiado nem descartado de verdade.
import { fusoDoDono, instanteNoFuso, partesNoFuso, somarDias } from '../fuso.js';

export const CLASSES = Object.freeze({ CRITICO: 'critico', HORA_MARCADA: 'hora-marcada', IMPORTANTE: 'importante', INFORMATIVO: 'informativo', RESUMO: 'resumo' });
export const SILENCIO_PADRAO = '23-07';
export const TETO_PADRAO = 8;

const { CRITICO, HORA_MARCADA, IMPORTANTE, INFORMATIVO, RESUMO } = CLASSES;

/**
 * Chave -> classe, refeita a partir das chaves do código (o test:avisos falha se surgir uma chave sem linha aqui).
 * `lembrete`, `matinal`, `monitor:*` não são chaves do alerter: são os nomes dos outros pontos de saída.
 */
export const TABELA = Object.freeze({
  // Crítico (chave desconhecida também é crítica)
  'lock-key': CRITICO,
  'lock-login': CRITICO,
  'audit.write.fail': CRITICO,
  'memory.backup.fail': CRITICO,
  'ia-rota-privada-bloqueada': CRITICO,
  // Hora marcada
  lembrete: HORA_MARCADA,
  // Importante
  'ai-down': IMPORTANTE,
  'google-reautorizar': IMPORTANTE,
  'evento:disco': IMPORTANTE,
  'evento:ram': IMPORTANTE,
  'evento:internet': IMPORTANTE,
  'ia-local-privada-fora': IMPORTANTE,
  'ia-perfil-privado-fechado': IMPORTANTE,
  'media:opus': IMPORTANTE,
  'memory-purge': IMPORTANTE,
  'weekly-publish': IMPORTANTE,
  // Informativo
  boot: INFORMATIVO,
  youtube: INFORMATIVO,
  twitch: INFORMATIVO,
  weekly: INFORMATIVO,
  'evento:internet-voltou': INFORMATIVO,
  'evento:supervisor': INFORMATIVO,
  'monitor:novidade': INFORMATIVO,
  'monitor:fim': INFORMATIVO,
  // Resumo
  matinal: RESUMO,
  'health-daily': RESUMO,
});

/** Famílias de chaves com final variável (o final é conteúdo: causa do erro, id do provedor). */
export const PREFIXOS = Object.freeze({ 'crash:': CRITICO, 'provider:': IMPORTANTE });

const prefixoDe = (chave) => Object.keys(PREFIXOS).find((p) => chave.startsWith(p));

/** A classe de uma chave. Desconhecida = crítico. */
export function classeDaChave(chave) {
  const c = String(chave ?? '');
  if (Object.hasOwn(TABELA, c)) return TABELA[c];
  const p = prefixoDe(c);
  return p ? PREFIXOS[p] : CRITICO;
}

/** O que pode ir para o log no lugar da chave: só o trecho antes de ":" de uma chave conhecida; o resto é "desconhecida". */
export function rotuloDaChave(chave) {
  const c = String(chave ?? '');
  return Object.hasOwn(TABELA, c) || prefixoDe(c) ? c.split(':')[0] : 'desconhecida';
}

/** "23-07" -> { inicio: 23, fim: 7 }. Inválido ou vazio vale o padrão. Início igual ao fim = sem silêncio (null). */
export function lerSilencio(valor) {
  const ler = (v) => /^\s*([01]?\d|2[0-3])\s*-\s*([01]?\d|2[0-3])\s*$/.exec(String(v ?? ''));
  const m = ler(valor) ?? ler(SILENCIO_PADRAO);
  const inicio = Number(m[1]);
  const fim = Number(m[2]);
  return inicio === fim ? null : { inicio, fim };
}

/** Inteiro >= 0; qualquer outra coisa vale o padrão. */
export function lerTeto(valor) {
  const bruto = String(valor ?? '').trim();
  return /^\d{1,6}$/.test(bruto) ? Number(bruto) : TETO_PADRAO;
}

export function emSilencio(agora, silencio, fuso = fusoDoDono()) {
  if (!silencio) return false;
  const { hora } = partesNoFuso(agora, fuso);
  const { inicio, fim } = silencio;
  return inicio < fim ? hora >= inicio && hora < fim : hora >= inicio || hora < fim;
}

/** A próxima vez que o relógio do fuso marca `hora`:00, depois de `agora`. */
function proximaHora(agora, hora, fuso) {
  const p = partesNoFuso(agora, fuso);
  const d = p.hora < hora ? p : somarDias(p, 1);
  return instanteNoFuso(d.ano, d.mes, d.dia, hora, 0, fuso);
}

/**
 * A decisão da seção 2.2. Pura: não conta nada (quem chama atualiza o uso do dia).
 * @param {{ classe: string, destinatario?: 'dono'|'terceiro', agora?: number|Date, usoDoDia?: { total?: number, assuntosAcimaDoTeto?: Set<string> }, assunto?: string }} aviso
 * @param {{ silencio?: {inicio:number, fim:number}|null, teto?: number, fuso?: string }} [config]
 * @returns {{ acao: 'enviar'|'adiar'|'descartar', motivo: string, ate?: Date }}
 */
export function decidir({ classe, destinatario = 'dono', agora = Date.now(), usoDoDia = null, assunto = '' }, { silencio = lerSilencio(SILENCIO_PADRAO), teto = TETO_PADRAO, fuso = fusoDoDono() } = {}) {
  if (destinatario !== 'dono') return { acao: 'enviar', motivo: 'terceiro' };
  if (classe === CRITICO) return { acao: 'enviar', motivo: 'critico' };
  if (classe === HORA_MARCADA) return { acao: 'enviar', motivo: 'hora-marcada' };
  if (classe !== IMPORTANTE && classe !== INFORMATIVO && classe !== RESUMO) return { acao: 'enviar', motivo: 'classe-desconhecida' };
  if (emSilencio(agora, silencio, fuso)) return { acao: 'adiar', motivo: 'silencio', ate: proximaHora(agora, silencio.fim, fuso) };
  if (classe === RESUMO) return { acao: 'enviar', motivo: 'resumo' };
  if ((usoDoDia?.total ?? 0) < teto) return { acao: 'enviar', motivo: 'dentro-do-teto' };
  // Teto estourado: o informativo espera o resumo da manhã; o importante sai mesmo assim, uma vez por assunto.
  if (classe === INFORMATIVO) return { acao: 'adiar', motivo: 'teto', ate: proximaHora(agora, silencio ? silencio.fim : 0, fuso) };
  if (usoDoDia?.assuntosAcimaDoTeto?.has(assunto)) return { acao: 'descartar', motivo: 'teto-assunto-repetido' };
  return { acao: 'enviar', motivo: 'importante-acima-do-teto' };
}
