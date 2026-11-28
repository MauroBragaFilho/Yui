// OBSERVADOR (Fase B, docs/inteligencia/06): roda o interpretador AO LADO da pré-rota atual e só REGISTRA a comparação em logs/interpretacao.jsonl.
// Não decide nada, não executa nada, não bloqueia nem atrasa a resposta: `iniciar` dispara a interpretação sem esperar e `fechar` grava a linha depois,
// em segundo plano. Qualquer erro aqui é engolido.
//
// Chave YUI_INTERPRETADOR: off (padrão: nada roda, nenhuma chamada) | observar.
// Só mensagens do DONO em conversa pessoal (DM, painel, app). Nunca voz, nunca terceiros, nunca conversa pública.
// O texto NUNCA vai ao log: só o hash (YUI_INTERPRETADOR_TEXTO=true grava o texto bruto, só para depuração do dono).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { interpretarComMeta, modoDoInterpretador } from './interpretador.js';

export const ARQUIVO_PADRAO = path.join('logs', 'interpretacao.jsonl');
export const TAMANHO_MAX_BYTES = 5 * 1024 * 1024;
export const RETENCAO_MS = 7 * 24 * 60 * 60 * 1000;
export const POR_HORA_PADRAO = 120;
const ASSUNTO_TTL_MS = 10 * 60_000;
const ASSUNTO_MAX = 50;
const MAX_ROTACIONADOS = 3;

/** O hash curto do texto (normalizado: minúsculas, espaços únicos). Só o hash vai ao log. */
export function hashDoTexto(texto) {
  const n = String(texto ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(n).digest('hex').slice(0, 16);
}

/** Só o dono, só conversa pessoal, nunca voz nem terceiros, só a chamada principal. */
export function elegivel({ role, memoryScope, voz = false, terceiros = false, principal = false, texto = '' } = {}) {
  return role === 'OWNER' && memoryScope === 'personal' && voz !== true && terceiros !== true && principal === true && typeof texto === 'string' && texto.trim().length > 0;
}

function arquivoDoLog(env) {
  const e = String(env?.YUI_INTERPRETACAO_ARQUIVO ?? '').trim();
  return path.resolve(e || ARQUIVO_PADRAO);
}

/**
 * Rotação: passou de 5 MB (ou o arquivo tem mais de 7 dias) = vira `interpretacao.<data>.jsonl`; os rotacionados com mais de 7 dias somem e só ficam os 3 mais novos.
 * Síncrona e curta (só estatísticas de arquivo). Nunca lança.
 */
export function rotacionar(arquivo, { agora = Date.now, maxBytes = TAMANHO_MAX_BYTES, retencaoMs = RETENCAO_MS } = {}) {
  try {
    const dir = path.dirname(arquivo);
    const base = path.basename(arquivo, '.jsonl');
    let st = null;
    try { st = fs.statSync(arquivo); } catch { /* ainda não existe */ }
    if (st && (st.size >= maxBytes || agora() - (st.birthtimeMs || st.mtimeMs) > retencaoMs)) {
      const carimbo = new Date(agora()).toISOString().replace(/[:.]/g, '-');
      fs.renameSync(arquivo, path.join(dir, `${base}.${carimbo}.jsonl`));
    }
    const rot = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`) && n.endsWith('.jsonl')).map((n) => {
      const p = path.join(dir, n);
      let m = 0;
      try { m = fs.statSync(p).mtimeMs; } catch { /* */ }
      return { p, m };
    }).sort((a, b) => b.m - a.m);
    rot.forEach((r, i) => { if (i >= MAX_ROTACIONADOS || agora() - r.m > retencaoMs) { try { fs.unlinkSync(r.p); } catch { /* */ } } });
  } catch { /* nunca derruba */ }
}

/**
 * @param {{ env?: object, interpretar?: Function, escrever?: (linha: object) => (void|Promise<void>), agora?: () => number, logger?: object }} [deps]
 *   `interpretar`: o `interpretarComMeta` (injetável: dublê de IA no teste). `escrever`: troca a gravação em arquivo.
 */
export function criarObservador(deps = {}) {
  const env = deps.env ?? process.env;
  const interpretarFn = deps.interpretar ?? interpretarComMeta;
  const agora = deps.agora ?? Date.now;
  const assuntos = new Map(); // userId -> { tipo, at }
  const janela = []; // instantes das chamadas na última hora (limite por hora)
  const contadores = { iniciadas: 0, gravadas: 0, puladasLimite: 0, falhasDeGravacao: 0 };

  const escrever = deps.escrever ?? (async (linha) => {
    const arquivo = arquivoDoLog(env);
    await fs.promises.mkdir(path.dirname(arquivo), { recursive: true });
    rotacionar(arquivo, { agora });
    await fs.promises.appendFile(arquivo, `${JSON.stringify(linha)}\n`, 'utf8');
  });

  function limiteDaHora() {
    const n = Number.parseInt(String(env?.YUI_INTERPRETADOR_POR_HORA ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 5000) : POR_HORA_PADRAO;
  }
  function podePorCota() {
    const t = agora();
    while (janela.length && t - janela[0] > 3_600_000) janela.shift();
    if (janela.length >= limiteDaHora()) return false;
    janela.push(t);
    return true;
  }
  function assuntoDe(userId) {
    const a = assuntos.get(userId);
    if (!a) return null;
    if (agora() - a.at > ASSUNTO_TTL_MS) { assuntos.delete(userId); return null; }
    return { tipo: a.tipo };
  }
  function guardarAssunto(userId, resultado) {
    if (!userId) return;
    if (resultado && resultado.intencao !== 'conversa' && resultado.confianca >= 0.5) {
      assuntos.delete(userId);
      assuntos.set(userId, { tipo: resultado.intencao, at: agora() });
      while (assuntos.size > ASSUNTO_MAX) assuntos.delete(assuntos.keys().next().value);
    }
  }

  return {
    contadores,
    modo: () => modoDoInterpretador(env),
    /**
     * Dispara a interpretação (SEM esperar). Devolve null quando a chave está off, a mensagem não é elegível ou a cota da hora acabou: então nada foi chamado.
     * Senão devolve `{ marcar(nome), fechar(), pronto }`: `marcar` diz qual pré-rota pegou; `fechar` (síncrona, sem espera) agenda a gravação da linha.
     * @param {{ texto: string, canal?: string, userId?: string, role?: string, memoryScope?: string, voz?: boolean, terceiros?: boolean, principal?: boolean }} p
     */
    iniciar(p = {}) {
      try {
        if (modoDoInterpretador(env) !== 'observar') return null;
        if (!elegivel({ role: p.role, memoryScope: p.memoryScope, voz: p.voz, terceiros: p.terceiros, principal: p.principal, texto: p.texto })) return null;
        if (!podePorCota()) { contadores.puladasLimite += 1; return null; }
        contadores.iniciadas += 1;
        const t0 = agora();
        const texto = p.texto;
        const userId = typeof p.userId === 'string' ? p.userId : '';
        const assunto = assuntoDe(userId);
        // dispara já, em paralelo com a resposta; nunca lança (a promessa sempre resolve)
        const feita = Promise.resolve().then(() => interpretarFn({ texto, assunto })).catch(() => null);
        let preRota = 'nenhuma';
        let fechado = false;
        const handle = {
          marcar(nome) { if (typeof nome === 'string' && /^[a-z][a-z0-9._-]{0,40}$/.test(nome)) preRota = nome; },
          fechar() {
            if (fechado) return handle.pronto;
            fechado = true;
            handle.pronto = feita.then(async (r) => {
              try {
                const resultado = r?.resultado ?? null;
                guardarAssunto(userId, resultado);
                const m = r?.meta ?? {};
                const linha = {
                  data: new Date(t0).toISOString(),
                  canal: String(p.canal ?? 'desconhecido').slice(0, 30),
                  hash: hashDoTexto(texto),
                  ...(String(env?.YUI_INTERPRETADOR_TEXTO ?? '').trim().toLowerCase() === 'true' ? { texto: String(texto).slice(0, 500) } : {}),
                  assunto: assunto?.tipo ?? null,
                  interpretacao: resultado,
                  motivo: m.motivo ?? (r ? null : 'sem-chamada'),
                  preRota,
                  latenciaMs: Number.isFinite(m.latenciaMs) ? m.latenciaMs : null,
                  perfil: m.perfil ?? null,
                  provedor: m.provedor ?? null,
                  combo: m.combo ?? null,
                  tokensEst: Number.isFinite(m.tokensEst) ? m.tokensEst : null,
                };
                await escrever(linha);
                contadores.gravadas += 1;
              } catch { contadores.falhasDeGravacao += 1; }
            }).catch(() => { contadores.falhasDeGravacao += 1; });
            return handle.pronto;
          },
          pronto: null,
        };
        return handle;
      } catch { return null; }
    },
  };
}

/** O observador do processo (lê o process.env). */
let padrao = null;
export function observadorPadrao() { if (!padrao) padrao = criarObservador(); return padrao; }
