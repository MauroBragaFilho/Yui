/**
 * O registro de uso do bot (src/data/historico.txt): gravação, poda por idade e exclusão das entradas de uma pessoa.
 *
 * Decisão do dono (26/11/2026): guardar por 7 dias (YUI_HISTORICO_DIAS; 0 desliga a poda).
 *
 * Concorrência: o bot e o cérebro podem gravar no mesmo arquivo. Toda gravação, poda e exclusão passa por uma trava em
 * arquivo (`historico.txt.lock`, criada com 'wx'). A reescrita é temporário + rename e é refeita se o arquivo cresceu no meio.
 *
 * Formato de uma entrada: `[data] Usuário: tag (ID: n)` ... `Local: {..} {..}` seguido de `-------------`.
 * Entrada SEM data legível: vale a data da próxima entrada datada (o arquivo só cresce no fim, então ela é pelo menos tão
 * antiga quanto aquela); sem nenhuma datada depois, FICA.
 *
 * Só fs e path; nada acontece ao importar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQUIVO_PADRAO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'historico.txt');
let arquivoAtual = ARQUIVO_PADRAO;
/** Só para os testes: troca o arquivo (sem argumento, volta ao real). */
export function definirArquivoDoHistoricoParaTeste(arquivo) { arquivoAtual = arquivo || ARQUIVO_PADRAO; }

export const DIAS_PADRAO = 7;
const DIA_MS = 86_400_000;
const TRAVA_VELHA_MS = 30_000; // trava de um processo que morreu
const INTERVALO_PODA_MS = 60 * 60 * 1000;

export function diasDeRetencao(env = process.env) {
  const bruto = String(env.YUI_HISTORICO_DIAS ?? '').trim();
  return /^\d{1,5}$/.test(bruto) ? Number(bruto) : DIAS_PADRAO;
}

/** Impede que o texto de uma conversa pareça cabeçalho ou fim de entrada. */
export function neutralizarParaHistorico(texto) {
  return String(texto).replace(/^(?=\[\d{2}\/\d{2}\/\d{4}|-------------|Local: \{)/gm, '  ');
}

// ── Trava entre processos ────────────────────────────────────────────────────────────────────────

/** 'minha' | 'ocupada' | 'indisponivel' (sem como criar o arquivo de trava). */
function tentarTravar(trava) {
  try {
    fs.closeSync(fs.openSync(trava, 'wx'));
    return 'minha';
  } catch (err) {
    if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') return 'indisponivel';
    try {
      if (Date.now() - fs.statSync(trava).mtimeMs > TRAVA_VELHA_MS) fs.rmSync(trava, { force: true });
    } catch { /* sumiu agora */ }
    return 'ocupada';
  }
}
const soltar = (trava) => { try { fs.rmSync(trava, { force: true }); } catch { /* vira trava velha e sai sozinha */ } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function comTrava(arquivo, prazoMs, fn) {
  const trava = `${arquivo}.lock`;
  const limite = Date.now() + prazoMs;
  for (;;) {
    const estado = tentarTravar(trava);
    if (estado === 'minha') break;
    if (estado === 'indisponivel' || Date.now() >= limite) {
      throw Object.assign(new Error('o historico.txt está ocupado'), { code: 'HISTORICO_OCUPADO' });
    }
    await esperar(25);
  }
  try { return fn(); } finally { soltar(trava); }
}

// ── Gravação ─────────────────────────────────────────────────────────────────────────────────────

const filas = new Map(); // arquivo -> { pendentes, ocupado, desde, agendado }

function drenar(arquivo) {
  const fila = filas.get(arquivo);
  if (!fila || fila.ocupado || !fila.pendentes.length) return;
  const trava = `${arquivo}.lock`;
  const estado = tentarTravar(trava);
  // Trava presa além do prazo de "velha": grava assim mesmo, para não perder a linha.
  if (estado === 'ocupada') {
    fila.desde ??= Date.now();
    if (Date.now() - fila.desde < TRAVA_VELHA_MS + 5000) {
      if (!fila.agendado) {
        fila.agendado = true;
        setTimeout(() => { fila.agendado = false; drenar(arquivo); }, 25);
      }
      return;
    }
  }
  fila.desde = null;
  fila.ocupado = true;
  const lote = fila.pendentes.splice(0);
  fs.appendFile(arquivo, lote.map((p) => p.texto).join(''), (err) => {
    if (estado === 'minha') soltar(trava);
    fila.ocupado = false;
    if (err) for (const p of lote) p.aoErrar?.(err);
    drenar(arquivo);
  });
}

export function registrarNoHistorico(texto, { arquivo = arquivoAtual, userId = null, aoErrar } = {}) {
  let fila = filas.get(arquivo);
  if (!fila) filas.set(arquivo, fila = { pendentes: [], ocupado: false, desde: null, agendado: false });
  fila.pendentes.push({ texto, userId: String(userId ?? ''), aoErrar });
  drenar(arquivo);
}

// ── Poda e exclusão ──────────────────────────────────────────────────────────────────────────────

const FIM_RE = /^Local: \{[^\r\n]*\} \{[^\r\n]*\}\r?\n-------------(?:\r?\n|$)/gm;
const CABECALHO_RE = /^\[(\d{2})\/(\d{2})\/(\d{4}),? (\d{2}):(\d{2}):(\d{2})\] Usuário: ([^\r\n]*)/gm;

function separar(texto) {
  const blocos = [];
  let inicio = 0;
  for (const m of texto.matchAll(FIM_RE)) {
    blocos.push(texto.slice(inicio, m.index + m[0].length));
    inicio = m.index + m[0].length;
  }
  if (inicio < texto.length) blocos.push(texto.slice(inicio));
  return blocos.flatMap(separarNosCabecalhos);
}

// Entrada truncada (queda ou disco cheio no meio do append) não tem fim: o próximo cabeçalho também separa, para ela não se
// fundir com a entrada seguinte (que pode ser de outra pessoa). O texto das conversas é neutralizado na gravação.
function separarNosCabecalhos(bloco) {
  const cortes = [0, ...[...bloco.matchAll(CABECALHO_RE)].map((m) => m.index).filter((i) => i > 0), bloco.length];
  return cortes.slice(1).map((fim, i) => bloco.slice(cortes[i], fim));
}

/** Data (ms) do bloco, ou null. O registro usa o horário de Brasília (UTC-3, sem horário de verão). */
function dataDoBloco(bloco) {
  let maior = null;
  for (const [, d, m, a, h, min, s] of bloco.matchAll(CABECALHO_RE)) {
    const ms = Date.UTC(+a, +m - 1, +d, +h + 3, +min, +s);
    if (Number.isFinite(ms) && (maior === null || ms > maior)) maior = ms;
  }
  return maior;
}

const blocoDaPessoa = (bloco, id) => [...bloco.matchAll(CABECALHO_RE)].some((m) => /\(ID: ([^()]*)\)\s*$/.exec(m[7])?.[1] === id);

/** Reescreve o arquivo só com os blocos que `filtrar` devolver. Devolve quantos saíram. Chamar com a trava. */
function reescrever(arquivo, filtrar) {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    let original;
    try {
      original = fs.readFileSync(arquivo);
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      throw err;
    }
    const blocos = separar(original.toString('utf8'));
    const ficam = filtrar(blocos);
    if (ficam.length === blocos.length) return 0;
    const tmp = `${arquivo}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, ficam.join(''), 'utf8');
      if (fs.statSync(arquivo).size !== original.length) continue; // alguém gravou sem a trava: refaz
      fs.renameSync(tmp, arquivo);
      return blocos.length - ficam.length;
    } catch (err) {
      if (tentativa === 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw Object.assign(new Error('o historico.txt mudou durante a reescrita'), { code: 'HISTORICO_OCUPADO' });
}

/** Apaga as entradas com mais de `dias` dias. 0 = não poda. Devolve quantas saíram. */
export async function podarHistorico({ arquivo = arquivoAtual, dias = diasDeRetencao(), agora = Date.now() } = {}) {
  if (!(dias > 0) || !fs.existsSync(arquivo)) return 0;
  const corte = agora - dias * DIA_MS;
  return comTrava(arquivo, 5000, () => reescrever(arquivo, (blocos) => {
    const datas = blocos.map(dataDoBloco);
    for (let i = datas.length - 2; i >= 0; i--) datas[i] ??= datas[i + 1];
    return blocos.filter((_, i) => datas[i] === null || datas[i] >= corte);
  }));
}

/** Apaga todas as entradas de uma pessoa (e as que ainda esperavam a gravação neste processo). Lança erro se não conseguir. */
export async function apagarDoHistorico(userId, { arquivo = arquivoAtual } = {}) {
  const id = String(userId ?? '').trim();
  if (!id) return 0;
  let removidas = 0;
  const fila = filas.get(arquivo);
  if (fila) {
    const antes = fila.pendentes.length;
    fila.pendentes = fila.pendentes.filter((p) => p.userId !== id);
    removidas = antes - fila.pendentes.length;
  }
  // Sem arquivo e sem gravação em andamento não há o que apagar.
  if (!fs.existsSync(arquivo) && !fila?.ocupado) return removidas;
  return removidas + await comTrava(arquivo, 2000, () => reescrever(arquivo, (blocos) => blocos.filter((b) => !blocoDaPessoa(b, id))));
}

/** Poda na subida e a cada hora. Nunca lança. Os dias são relidos a cada passada. */
export function iniciarPodaDoHistorico({ logger, intervaloMs = INTERVALO_PODA_MS } = {}) {
  const passada = async () => {
    try {
      const n = await podarHistorico();
      if (n) logger?.info(`[Historico] ${n} entrada(s) com mais de ${diasDeRetencao()} dia(s) apagada(s) do historico.txt.`);
    } catch (err) {
      logger?.warn(`[Historico] não consegui podar o historico.txt: ${err.code || err.message}`);
    }
  };
  passada();
  const timer = setInterval(passada, intervaloMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
