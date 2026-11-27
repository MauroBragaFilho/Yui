// MODO OBSERVAR dos avisos (Fase 3, parte 3A; docs/DESENHO_FASE3_YUI_PERSONAL_AI.md §2.6): decide e registra o que o filtro FARIA, mas tudo
// continua sendo enviado como hoje. Os pontos de saída chamam `observarAviso` DEPOIS do envio confirmado; ela é síncrona, não devolve nada que
// mude o envio e nunca lança.
//
// YUI_AVISOS_FILTRO: off (padrão; qualquer outro valor também), observar ou ligar (fila.js; aqui nada é registrado). YUI_SILENCIO (23-07), YUI_AVISOS_POR_DIA (8), no fuso YUI_FUSO.
// Privacidade: a linha do log leva só o prefixo da chave, a classe e a decisão. Nunca título, texto, usuário ou conteúdo.
// O uso do dia fica só em memória, POR PROCESSO (bot e cérebro contam cada um o seu) e recomeça a cada reinício.
import { logger } from '../../utils/logger.js';
import { chaveDoDia, fusoDoDono } from '../fuso.js';
import { CLASSES, assuntoDaChave, classeDaChave, decidir, lerSilencio, lerTeto, rotuloDaChave } from './regras.js';

const usoVazio = (dia = '', total = 0) => ({ dia, total, assuntosAcimaDoTeto: new Set() });
let uso = usoVazio();
// Adiados pelo silêncio cuja entrega cairia em outro dia: entram no teto daquele dia.
let aEntregar = { dia: '', total: 0 };

// O que o painel mostra do modo observar (GET /v1/admin/avisos), só em memória e POR PROCESSO: as últimas decisões de ADIAR ou DESCARTAR um aviso do dono
// (o que o filtro faria) e a contagem de cada decisão desde que o processo subiu. Só o assunto já limpo (assuntoDaChave), a classe, a decisão, o motivo e
// até quando: nunca a chave crua, o texto, o título nem o usuário.
const MAX_REGISTROS = 30;
const contagemVazia = () => ({ enviar: 0, adiar: 0, descartar: 0 });
let registros = [];
let contagem = contagemVazia();
let desde = Date.now();

export function modoDoFiltro(env = process.env) {
  const v = String(env?.YUI_AVISOS_FILTRO ?? '').trim().toLowerCase();
  return v === 'observar' || v === 'ligar' ? v : 'off';
}

/** Só para teste. */
export function reiniciarUsoDosAvisos() { uso = usoVazio(); aEntregar = { dia: '', total: 0 }; registros = []; contagem = contagemVazia(); desde = Date.now(); }

/** O que o modo observar registrou neste processo (cópia; só campos fixos). */
export function registrosDoObservar() {
  return { desde: new Date(desde).toISOString(), contagem: { ...contagem }, registros: registros.map((r) => ({ ...r })) };
}

function guardarRegistro(chave, classe, d, agora) {
  if (Object.hasOwn(contagem, d.acao)) contagem[d.acao] += 1;
  if (d.acao === 'enviar') return;
  const em = Number(agora instanceof Date ? agora.getTime() : agora);
  const ate = d.ate instanceof Date ? d.ate.getTime() : null;
  registros.push({
    em: Number.isFinite(em) ? new Date(em).toISOString() : null, assunto: assuntoDaChave(chave), classe, acao: d.acao, motivo: d.motivo,
    ate: Number.isFinite(ate) ? new Date(ate).toISOString() : null,
  });
  if (registros.length > MAX_REGISTROS) registros = registros.slice(-MAX_REGISTROS);
}

/**
 * @param {{ chave: string, destinatario?: 'dono'|'terceiro', env?: object, agora?: number, log?: { info: Function } }} aviso
 * @returns {{ acao: string, motivo: string, ate?: Date }|null} a decisão (só para teste), ou null (desligado ou falha)
 */
export function observarAviso({ chave, destinatario = 'dono', env = process.env, agora = Date.now(), log = logger } = {}) {
  try {
    if (modoDoFiltro(env) !== 'observar') return null; // em "ligar" quem decide e registra é a fila
    const fuso = fusoDoDono(env);
    const dia = chaveDoDia(agora, fuso);
    if (dia !== uso.dia) uso = usoVazio(dia, aEntregar.dia === dia ? aEntregar.total : 0);
    const classe = classeDaChave(chave);
    const config = { silencio: lerSilencio(env.YUI_SILENCIO), teto: lerTeto(env.YUI_AVISOS_POR_DIA), fuso };
    const d = decidir({ classe, destinatario, agora, usoDoDia: uso, assunto: String(chave) }, config);
    // Conta no teto (importante e informativo do dono) no dia em que o filtro entregaria: agora, ou no fim do silêncio.
    // O adiado pelo teto vai para o resumo da manhã e o descartado não sai: nenhum dos dois conta.
    if (destinatario === 'dono' && (classe === CLASSES.IMPORTANTE || classe === CLASSES.INFORMATIVO)) {
      if (d.acao === 'enviar') {
        uso.total += 1;
        if (d.motivo === 'importante-acima-do-teto') uso.assuntosAcimaDoTeto.add(String(chave));
      } else if (d.motivo === 'silencio') {
        const entrega = chaveDoDia(d.ate.getTime(), fuso);
        if (entrega === dia) uso.total += 1;
        else aEntregar = { dia: entrega, total: (aEntregar.dia === entrega ? aEntregar.total : 0) + 1 };
      }
    }
    if (destinatario === 'dono') { try { guardarRegistro(chave, classe, d, agora); } catch { /* o registro do painel nunca muda a observação */ } }
    log.info(`[Avisos] observar: chave=${rotuloDaChave(chave)} classe=${classe} decisao=${d.acao} motivo=${d.motivo}`);
    return d;
  } catch {
    return null; // a observação nunca interfere no envio
  }
}
