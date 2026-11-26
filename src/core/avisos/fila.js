// AVISOS NA HORA CERTA, modo LIGAR (Fase 3, parte 3A; docs/DESENHO_FASE3_YUI_PERSONAL_AI.md §2): a FILA DURÁVEL e a descarga.
//
// DONO ÚNICO: o arquivo <DATABASE_DIR>/avisos-fila.json é do CÉREBRO (ou do processo único). O bot separado nunca o abre: ele entrega o aviso
// ao cérebro pelo método `avisos.entregar` (filtro remoto, mais abaixo).
//
// Regra de segurança: nenhum aviso se perde. Só responde "adiado" DEPOIS de gravar; um item só sai do arquivo com o envio confirmado; qualquer
// erro (arquivo ilegível, disco, fila cheia, canal fora) vale "enviar agora". Duplicar é preferível a perder.
// Com YUI_AVISOS_FILTRO diferente de "ligar" nada é aberto nem criado; se sobraram itens de quando estava ligado, a descarga os envia.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger as loggerPadrao } from '../../utils/logger.js';
import { redact } from '../api/panelLogs.js';
import { writeJsonAtomic } from '../channel/idemPersistente.js';
import { chaveDoDia, fusoDoDono } from '../fuso.js';
import { CLASSES, classeDaChave, decidir, emSilencio, lerSilencio, lerTeto, rotuloDaChave } from './regras.js';
import { modoDoFiltro } from './observar.js';

export const METODO_DO_CANAL = 'avisos.entregar';
const MAX_ITENS = 300;
const MAX_TEXTO = 2000;
const MAX_MENSAGEM = 6000; // o bot aceita até 8000 por pedido
const MAX_SECAO = 3000;
const ESPERA_APOS_FALHA_MS = 5 * 60_000;
const ESPERA_PELO_RESUMO_MS = 6 * 60 * 60_000; // passou disso sem resumo, os avisos de ontem saem sozinhos
const GUARDA_ENTREGUES_MS = 24 * 60 * 60_000;
const MAX_ENTREGUES = 100;

export const arquivoDaFila = (env = process.env) => path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'avisos-fila.json');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const vazio = () => ({ versao: 1, itens: [], uso: { dia: '', total: 0, assuntos: [] }, entregues: [], resumo: null });
const ligado = (env) => modoDoFiltro(env) === 'ligar';
const contaNoTeto = (classe) => classe === CLASSES.IMPORTANTE || classe === CLASSES.INFORMATIVO;
const itemValido = (i) => i && typeof i.idem === 'string' && typeof i.chave === 'string' && typeof i.texto === 'string';

export function criarFiltroDeAvisos({ env = process.env, file = null, now = () => Date.now(), logger = loggerPadrao } = {}) {
  const arquivo = file ?? arquivoDaFila(env);
  let estado = null;
  let avisouIlegivel = false;
  let ocupado = false;
  let resumoFn = null;

  const config = () => ({ silencio: lerSilencio(env.YUI_SILENCIO), teto: lerTeto(env.YUI_AVISOS_POR_DIA), fuso: fusoDoDono(env) });

  /** O estado (lido uma vez), ou null se o arquivo existe e não pôde ser lido: aí o filtro não segura nada e não toca no arquivo. */
  function ler() {
    if (estado) return estado;
    try {
      let bruto;
      try { bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        estado = vazio();
        return estado;
      }
      if (!bruto || !Array.isArray(bruto.itens)) throw new Error('formato inesperado');
      estado = {
        versao: 1,
        itens: bruto.itens.filter(itemValido),
        uso: { dia: String(bruto.uso?.dia ?? ''), total: Number(bruto.uso?.total) || 0, assuntos: Array.isArray(bruto.uso?.assuntos) ? bruto.uso.assuntos : [] },
        entregues: Array.isArray(bruto.entregues) ? bruto.entregues : [],
        resumo: bruto.resumo && typeof bruto.resumo.dia === 'string' ? bruto.resumo : null,
      };
      return estado;
    } catch (err) {
      if (!avisouIlegivel) {
        avisouIlegivel = true;
        logger.warn?.(`[Avisos] não consegui ler a fila de avisos (${String(err?.code ?? err?.name ?? 'erro').slice(0, 40)}): os avisos saem na hora e o arquivo fica como está.`);
      }
      return null;
    }
  }

  /** Muda uma cópia, grava e só então vale. Lança se o disco não aceitou. */
  function gravar(mutar) {
    const base = ler();
    if (!base) throw new Error('fila ilegível');
    const novo = JSON.parse(JSON.stringify(base));
    mutar(novo);
    writeJsonAtomic(arquivo, novo);
    estado = novo;
  }
  const tentarGravar = (mutar) => {
    try { gravar(mutar); } catch (err) {
      logger.warn?.(`[Avisos] não consegui gravar a fila de avisos (${String(err?.code ?? 'erro').slice(0, 40)}).`);
    }
  };

  /** Para o que já aconteceu (envio feito): se o disco recusar, vale ao menos em memória, senão a mesma DM sairia a cada passada. */
  const gravarOuLembrar = (mutar) => {
    try { gravar(mutar); } catch (err) {
      if (estado) mutar(estado);
      logger.warn?.(`[Avisos] não consegui gravar a fila de avisos (${String(err?.code ?? 'erro').slice(0, 40)}); o envio fica anotado só em memória.`);
    }
  };

  function usoDe(s, t) {
    const dia = chaveDoDia(t, fusoDoDono(env));
    if (s.uso.dia !== dia) s.uso = { dia, total: 0, assuntos: [] };
    return s.uso;
  }
  function decisaoPara(s, chave, classe, t) {
    const u = usoDe({ uso: { ...s.uso } }, t);
    const dados = { classe, agora: t, usoDoDia: { total: u.total, assuntosAcimaDoTeto: new Set(u.assuntos) }, assunto: chave };
    const d = decidir(dados, config());
    // O "descartar" das regras (importante repetido acima do teto) aqui não descarta: guarda como o informativo, para o dia seguinte.
    if (d.acao === 'descartar') return { acao: 'adiar', motivo: 'teto', ate: decidir({ ...dados, classe: CLASSES.INFORMATIVO }, config()).ate };
    return d;
  }
  function contar(s, chave, classe, t, motivo) {
    if (!contaNoTeto(classe)) return;
    const u = usoDe(s, t);
    u.total += 1;
    if (motivo === 'importante-acima-do-teto' && !u.assuntos.includes(chave)) u.assuntos.push(chave);
  }
  const registrar = (chave, classe, decisao, motivo) => {
    try { logger.info?.(`[Avisos] ligar: chave=${rotuloDaChave(chave)} classe=${classe} decisao=${decisao} motivo=${motivo}`); } catch { /* */ }
  };

  /**
   * Um aviso do alerter. `falhou`: o envio direto não saiu (guarda para tentar de novo). `confirmado`: quem pede precisa saber quando saiu.
   * `ocorrencia`: separa dois fatos diferentes com o mesmo texto (ex.: duas autorizações do Google perdidas).
   * Nunca lança.
   * @returns {{ acao: 'enviar'|'adiado'|'enviado' }}
   */
  function filtrar({ chave, texto, falhou = false, confirmado = false, ocorrencia = '' } = {}) {
    try {
      const c = String(chave ?? '').slice(0, 200);
      const classe = classeDaChave(c);
      if (!ligado(env) || classe === CLASSES.CRITICO || classe === CLASSES.HORA_MARCADA) return { acao: 'enviar' };
      const corpo = redact(String(texto ?? ''), env).slice(0, MAX_TEXTO);
      const s = ler();
      if (!s || !corpo) return { acao: 'enviar' };
      const t = now();
      const idem = `${c}:${sha(ocorrencia ? `${corpo}|${ocorrencia}` : corpo)}`;
      if (confirmado && s.entregues.some((e) => e.idem === idem && t - e.em < GUARDA_ENTREGUES_MS)) return { acao: 'enviado' };
      if (s.itens.some((i) => i.idem === idem)) return { acao: 'adiado' };
      let motivo = 'falha';
      let liberaEm = t + ESPERA_APOS_FALHA_MS;
      if (!falhou) {
        const d = decisaoPara(s, c, classe, t);
        if (d.acao === 'enviar') {
          tentarGravar((n) => contar(n, c, classe, t, d.motivo));
          registrar(c, classe, 'enviar', d.motivo);
          return { acao: 'enviar' };
        }
        motivo = d.motivo;
        liberaEm = motivo === 'teto' ? d.ate.getTime() : 0; // no silêncio basta o silêncio acabar
      }
      if (s.itens.length >= MAX_ITENS) return { acao: 'enviar' };
      gravar((n) => { n.itens.push({ idem, chave: c, classe, texto: corpo, motivo, criadoEm: t, liberaEm, estado: 'pendente', tentativa: 0, contado: falhou }); });
      registrar(c, classe, 'adiar', motivo);
      return { acao: 'adiado' };
    } catch (err) {
      logger.warn?.(`[Avisos] o filtro falhou (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}): o aviso sai agora.`);
      return { acao: 'enviar' };
    }
  }

  /** Para quem guarda o próprio aviso (monitores): pode sair agora? Não conta nada; erro = pode. */
  function podeSair(chave) {
    try {
      if (!ligado(env)) return true;
      const s = ler();
      return !s || decisaoPara(s, chave, classeDaChave(chave), now()).acao === 'enviar';
    } catch { return true; }
  }
  /** Depois do envio confirmado de quem usou `podeSair`: conta no teto do dia. */
  function registrarEnvio(chave) {
    if (ligado(env) && ler()) tentarGravar((n) => contar(n, chave, classeDaChave(chave), now(), 'dentro-do-teto'));
  }

  /** O resumo da manhã: true se o filtro passa a cuidar dele (gravou a retomada); false = mandar como sempre. */
  function agendarResumo() {
    try {
      if (!ligado(env) || !resumoFn || !ler()) return false;
      const t = now();
      gravar((n) => { n.resumo = { dia: chaveDoDia(t, fusoDoDono(env)), liberaEm: 0 }; });
      return true;
    } catch { return false; }
  }

  /** Divide em lotes que cabem numa mensagem, na ordem. */
  function lotes(itens) {
    const out = [];
    let atual = [];
    let tamanho = 0;
    for (const i of itens) {
      if (atual.length && tamanho + i.texto.length + 2 > MAX_MENSAGEM) { out.push(atual); atual = []; tamanho = 0; }
      atual.push(i);
      tamanho += i.texto.length + 2;
    }
    if (atual.length) out.push(atual);
    return out;
  }

  function confirmar(n, ids, t) {
    for (const i of n.itens.filter((x) => ids.has(x.idem))) {
      if (!i.contado) contar(n, i.chave, i.classe, t, 'dentro-do-teto');
      n.entregues.push({ idem: i.idem, em: t });
    }
    n.itens = n.itens.filter((i) => !ids.has(i.idem));
    n.entregues = n.entregues.filter((e) => t - e.em < GUARDA_ENTREGUES_MS).slice(-MAX_ENTREGUES);
  }

  /**
   * A descarga. `enviar(texto, { idem })` resolve true / { ok: true } (saiu), { incerto: true } (não dá para saber) ou false (não saiu).
   * `podeAlertas`/`podeResumo`: os guardas de quem agenda. Nunca lança.
   */
  async function passada({ enviar = null, podeAlertas = () => true, podeResumo = () => true } = {}) {
    if (ocupado) return { pulou: 'ocupado' };
    ocupado = true;
    const saida = { enviadas: 0, resumo: null };
    try {
      if (!estado && !fs.existsSync(arquivo)) return saida;
      const s = ler();
      if (!s || (!s.itens.length && !s.resumo)) return saida;
      const ativo = ligado(env);
      const { silencio, fuso } = config();
      const t = now();
      if (ativo && emSilencio(t, silencio, fuso)) return saida;
      const venceu = (i) => !ativo || t >= i.liberaEm;

      // 1. O resumo da manhã, com os avisos que o teto deixou para ele.
      if (s.resumo && resumoFn && podeResumo() && (!ativo || t >= s.resumo.liberaEm)) {
        const naSecao = [];
        let tamanho = 0;
        for (const i of s.itens.filter((x) => x.motivo === 'teto' && venceu(x))) {
          if (tamanho + i.texto.length > MAX_SECAO) break;
          naSecao.push(i);
          tamanho += i.texto.length + 2;
        }
        const secao = naSecao.length ? `\n\n**Avisos de ontem**\n${naSecao.map((i) => i.texto).join('\n\n')}` : '';
        let r = null;
        try { r = await resumoFn(secao); } catch (err) { logger.warn?.(`[Avisos] o resumo da manhã falhou (${String(err?.message ?? err).slice(0, 80)}).`); }
        saida.resumo = r?.ok ? 'enviado' : r?.incerto ? 'incerto' : 'falhou';
        gravarOuLembrar((n) => {
          if (r?.ok || r?.incerto) n.resumo = null;
          else if (n.resumo) n.resumo.liberaEm = t + ESPERA_APOS_FALHA_MS;
          // A seção só conta como entregue se ESTA mensagem saiu agora (uma reconciliada pode ser a antiga, sem a seção).
          if (r?.ok && r.secaoConfirmada) confirmar(n, new Set(naSecao.map((i) => i.idem)), t);
        });
      }

      // 2. O resto: o informativo num grupo só, o importante um grupo por assunto. Um lote já tentado se repete igual.
      if (!enviar || !podeAlertas()) return saida;
      const esperaResumo = (i) => ativo && resumoFn && i.motivo === 'teto' && t < i.liberaEm + ESPERA_PELO_RESUMO_MS;
      const grupos = new Map();
      for (const i of ler().itens.filter((x) => venceu(x) && !esperaResumo(x))) {
        const g = i.lote ?? (i.motivo === 'teto' ? 'teto' : i.classe === CLASSES.INFORMATIVO ? 'informativo' : `assunto:${i.chave}`);
        if (!grupos.has(g)) grupos.set(g, []);
        grupos.get(g).push(i);
      }
      for (const [grupo, itens] of grupos) {
        for (const lote of itens[0].lote ? [itens] : lotes(itens)) {
          const ids = new Set(lote.map((i) => i.idem));
          // A hora em que cada item entrou vai no nome: o mesmo texto adiado outro dia não pode repetir a chave que o bot já marcou como feita.
          const nome = lote[0].lote ?? `lote-${sha(lote.map((i) => `${i.idem}@${i.criadoEm}`).join('|'))}`;
          const tentativa = lote[0].tentativa ?? 0;
          // Marca antes de pedir o envio: uma queda aqui repete o mesmo lote, com a mesma chave. Se não gravar, envia assim mesmo.
          tentarGravar((n) => { for (const i of n.itens) if (ids.has(i.idem)) { i.estado = 'enviando'; i.lote = nome; } });
          const cabecalho = grupo === 'teto' ? '**Avisos de ontem**\n' : lote.length > 1 ? '**Avisos guardados**\n' : '';
          let r = false;
          try { r = await enviar(`${cabecalho}${lote.map((i) => i.texto).join('\n\n')}`, { idem: `avisos:${nome}:${tentativa}` }); } catch { r = false; }
          if (r === true || r?.ok === true) {
            gravarOuLembrar((n) => confirmar(n, ids, t));
            saida.enviadas += 1;
          } else if (r?.incerto) {
            // Sem marcador para reconciliar: a próxima passada manda com chave nova (duplicar é preferível a perder).
            tentarGravar((n) => { for (const i of n.itens) if (ids.has(i.idem)) i.tentativa = tentativa + 1; });
          } else {
            return saida; // o caminho está fora: tenta de novo na próxima passada
          }
        }
      }
      return saida;
    } catch (err) {
      logger.warn?.(`[Avisos] a descarga falhou (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); tento de novo.`);
      return saida;
    } finally {
      ocupado = false;
    }
  }

  return {
    arquivo,
    filtrar,
    podeSair,
    registrarEnvio,
    agendarResumo,
    definirResumo: (fn) => { resumoFn = fn; },
    passada,
    status: () => { const s = ler(); return s ? { guardados: s.itens.length, resumoPendente: Boolean(s.resumo) } : { ilegivel: true }; },
  };
}

/** Liga a descarga periódica. Devolve { passada, parar }. Sem fila nem resumo pendente, a passada não faz nada. */
export function iniciarDescarga(filtro, { enviar, podeAlertas, podeResumo, tickMs = 60_000 } = {}) {
  const passada = () => filtro.passada({ enviar, podeAlertas, podeResumo });
  const timer = setInterval(() => { passada(); }, tickMs);
  timer.unref?.();
  return { passada, parar: () => clearInterval(timer) };
}

/** No cérebro: o método do canal pelo qual o bot entrega o aviso. */
export function registrarMetodoDosAvisos(channel, filtro) {
  channel.handle(METODO_DO_CANAL, async (p) => filtro.filtrar({ chave: p?.chave, texto: p?.texto, falhou: p?.falhou === true, confirmado: p?.confirmado === true, ocorrencia: String(p?.ocorrencia ?? '').slice(0, 64) }), { roles: ['bot'] });
}

/** No bot separado: pergunta ao cérebro. Sem resposta clara, "enviar". */
export function criarFiltroRemoto(channel, { env = process.env, timeoutMs = 5_000 } = {}) {
  let n = 0;
  return {
    async filtrar(aviso) {
      if (!ligado(env) || classeDaChave(aviso?.chave) === CLASSES.CRITICO) return { acao: 'enviar' };
      try {
        const r = await channel.request(METODO_DO_CANAL, aviso, { idem: `${METODO_DO_CANAL}:${process.pid}:${Date.now()}:${(n += 1)}`, timeoutMs });
        return { acao: r?.acao === 'adiado' || r?.acao === 'enviado' ? r.acao : 'enviar' };
      } catch {
        return { acao: 'enviar' };
      }
    },
  };
}

// ── O filtro do processo (cérebro ou processo único): quem agenda o resumo o recebe daqui. ──
let doProcesso = null;
export const definirFiltroDoProcesso = (f) => { doProcesso = f; };
export const filtroDoProcesso = () => doProcesso;
