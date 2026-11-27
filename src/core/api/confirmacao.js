// CORREÇÃO C2 do parecer da Liz (docs/PLANO_LACUNAS_PAINEL_CORRECOES.md, 27/11/2026): a CHAVE DE CONFIRMAÇÃO pela DM nas ações críticas do painel.
// Reaproveita a identidade que já existe (o Discord do dono, o mesmo da chave de login), sem senha nova e sem outro sistema de credencial. Não é um segundo
// fator independente (usa o mesmo Discord): é uma confirmação ligada à operação, para uma sessão roubada do painel não aprovar nem reautorizar sozinha.
//
// Regras (tests/test-painel-confirmacao.js):
//  - 6 dígitos gerados por crypto.randomInt; só o HASH fica guardado, só na memória deste processo;
//  - a chave fica presa ao dono, à SESSÃO do painel que a pediu (o hash do Bearer), à AÇÃO e ao ALVO (o plano com versão e hash, ou "google"):
//    a de uma ação ou de um alvo não serve para outro, nem em outra sessão;
//  - vale VALIDADE_DA_CHAVE_MS (5 min) e UMA vez: conferir e consumir acontecem juntos, no mesmo passo síncrono; pedir outra para o mesmo alvo invalida a anterior;
//  - a sessão que acaba (sair do painel) leva as chaves dela; a sessão que vence (12 h) deixa de entrar, e a chave dela não tem mais por onde ser usada;
//  - 5 chaves erradas em 15 min travam a conferência por 15 min (quem chama avisa o dono); 10 pedidos em 15 min travam os pedidos;
//  - as mensagens de erro não dizem o que deu errado (vencida, de outra ação, errada): só "inválida ou vencida";
//  - a chave nunca volta numa resposta, nem vai para log ou auditoria.
import crypto from 'node:crypto';
import { createLoginLimiter } from './auth.js';

/** As ações que pedem a chave, com o texto que a DM mostra. */
export const ACOES_COM_CHAVE = Object.freeze({
  'plano.aprovar': 'aprovar um plano',
  'google.reautorizar': 'reautorizar o Google pelo painel',
});
export const VALIDADE_DA_CHAVE_MS = 5 * 60 * 1000;
export const DIGITOS_DA_CHAVE = 6;
export const LIMITE_DE_ERROS = Object.freeze({ max: 5, janelaMs: 15 * 60 * 1000 });
export const LIMITE_DE_PEDIDOS = Object.freeze({ max: 10, janelaMs: 15 * 60 * 1000 });

export const TEXTOS_DA_CONFIRMACAO = Object.freeze({
  necessaria: 'Confirmação necessária: peça a chave pela DM e digite aqui.',
  invalida: 'Chave de confirmação inválida ou vencida. Peça outra pela DM.',
  // começam com "Muit": o app mostra a frase do servidor no 429 só quando ela começa assim (src/api/client.ts: messageForStatus)
  travada: (min) => `Muitas chaves de confirmação erradas seguidas. Tente de novo em ${min} min.`,
  muitosPedidos: (min) => `Muitos pedidos de chave de confirmação. Tente de novo em ${min} min.`,
  semSessao: 'Esta ação só pode ser confirmada numa sessão do painel.',
  acaoDesconhecida: 'Ação de confirmação desconhecida.',
});

export class ConfirmacaoError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ConfirmacaoError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// A sessão de cada pedido HTTP. O contexto do Core é congelado: o server.js marca a sessão aqui, ao lado dele, logo depois de autenticar.
const sessoes = new WeakMap();
/** O server.js chama com o Bearer do pedido. Guarda só um resumo (hash) dele. */
export function marcarSessao(ctx, bearer) {
  if (ctx && typeof ctx === 'object' && typeof bearer === 'string' && bearer) sessoes.set(ctx, sha(`sessao-do-painel:${bearer}`).toString('hex').slice(0, 32));
}
/** A sessão do painel deste contexto, ou null (chamada que não veio de uma sessão HTTP). */
export const sessaoDe = (ctx) => (ctx && typeof ctx === 'object' ? sessoes.get(ctx) ?? null : null);

/** O texto da chave na DM: "482-913". */
export const formatarChave = (codigo) => `${codigo.slice(0, 3)}-${codigo.slice(3)}`;
/** O que a pessoa digitou, só os dígitos ("482 913", "482-913" -> "482913"). */
export const normalizarChave = (texto) => String(texto ?? '').replace(/\D/g, '').slice(0, 12);

/**
 * @param {{ agora?: () => number, validadeMs?: number }} [o]
 * @returns {{ emitir: Function, conferir: Function, esquecerSessao: Function, tamanho: () => number }}
 */
export function criarConfirmacoes({ agora = () => Date.now(), validadeMs = VALIDADE_DA_CHAVE_MS } = {}) {
  const chaves = new Map(); // dono|sessão|ação|alvo -> { hash, expira, sessao }
  const erros = createLoginLimiter({ max: LIMITE_DE_ERROS.max, windowMs: LIMITE_DE_ERROS.janelaMs, now: agora });
  const pedidos = createLoginLimiter({ max: LIMITE_DE_PEDIDOS.max, windowMs: LIMITE_DE_PEDIDOS.janelaMs, now: agora });
  const idDe = ({ userId, sessao, acao, alvo }) => `${String(userId)}|${sessao}|${acao}|${String(alvo)}`;
  const limpar = () => { const t = agora(); for (const [k, v] of chaves) if (v.expira <= t) chaves.delete(k); };
  const conferirAcao = (acao) => { if (!Object.hasOwn(ACOES_COM_CHAVE, acao)) throw new ConfirmacaoError(400, TEXTOS_DA_CONFIRMACAO.acaoDesconhecida); };
  const minutos = (s) => Math.max(1, Math.ceil(s / 60));

  return {
    /**
     * Gera a chave de UMA ação num alvo (substitui a anterior do mesmo alvo nesta sessão). Devolve o código (só para a DM) e `revogar` (a DM não saiu).
     * Lança ConfirmacaoError: ação desconhecida (400), sem sessão (403), pedidos demais (429).
     */
    emitir({ userId, sessao, acao, alvo }) {
      conferirAcao(acao);
      if (!sessao) throw new ConfirmacaoError(403, TEXTOS_DA_CONFIRMACAO.semSessao);
      const espera = pedidos.lockedForSeconds();
      if (espera > 0) throw new ConfirmacaoError(429, TEXTOS_DA_CONFIRMACAO.muitosPedidos(minutos(espera)), { retryAfter: espera });
      pedidos.fail(); // todo pedido conta, como no login por DM
      limpar();
      const codigo = String(crypto.randomInt(0, 10 ** DIGITOS_DA_CHAVE)).padStart(DIGITOS_DA_CHAVE, '0');
      const id = idDe({ userId, sessao, acao, alvo });
      chaves.set(id, { hash: sha(`chave:${codigo}`), expira: agora() + validadeMs, sessao });
      return { codigo: formatarChave(codigo), expiraEmSegundos: Math.round(validadeMs / 1000), revogar: () => chaves.delete(id) };
    },

    /**
     * Confere e CONSOME a chave (uso único; tudo síncrono, sem nada no meio). true quando vale. Lança ConfirmacaoError: sem chave (428), travada (429),
     * inválida (422, com `travou: true` quando este erro travou a conferência). A mensagem nunca diz se a chave era de outra ação, venceu ou estava errada.
     */
    conferir({ userId, sessao, acao, alvo, chave }) {
      conferirAcao(acao);
      const espera = erros.lockedForSeconds();
      if (espera > 0) throw new ConfirmacaoError(429, TEXTOS_DA_CONFIRMACAO.travada(minutos(espera)), { retryAfter: espera });
      const dada = normalizarChave(chave);
      if (!dada) throw new ConfirmacaoError(428, TEXTOS_DA_CONFIRMACAO.necessaria, { confirmacao: 'necessaria' });
      limpar();
      const id = idDe({ userId, sessao, acao, alvo });
      const atual = sessao ? chaves.get(id) : null;
      const vale = Boolean(atual) && dada.length === DIGITOS_DA_CHAVE && crypto.timingSafeEqual(sha(`chave:${dada}`), atual.hash);
      if (!vale) {
        erros.fail();
        throw new ConfirmacaoError(422, TEXTOS_DA_CONFIRMACAO.invalida, { travou: erros.lockedForSeconds() > 0 });
      }
      chaves.delete(id);
      return true;
    },

    /** A sessão saiu do painel: as chaves dela deixam de valer. */
    esquecerSessao(sessao) {
      if (!sessao) return 0;
      let n = 0;
      for (const [k, v] of chaves) if (v.sessao === sessao) { chaves.delete(k); n += 1; }
      return n;
    },

    /** Quantas chaves estão guardadas (para teste). */
    tamanho: () => { limpar(); return chaves.size; },
  };
}

let compartilhadas = null;
/** As chaves deste processo: a rota que pede e as ações que conferem usam o MESMO lugar (a API roda num processo só). */
export const confirmacoesDoPainel = () => (compartilhadas ??= criarConfirmacoes());
/** Só para teste. */
export function definirConfirmacoesParaTestes(c) { compartilhadas = c ?? null; }
