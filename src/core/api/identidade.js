// Prova de IDENTIDADE do servidor da Yui para o app (rota pública GET /v1/identidade).
//
// Problema: o app aceita uma lista de endereços (rede local e Tailscale) e escolhe o primeiro que responde /v1/health. Só isso prova que ALGUÉM responde, não QUEM
// responde: em outra rede, uma máquina com o mesmo IP privado receberia a senha e o token. Solução: o servidor assina um desafio com uma chave PRIVADA Ed25519
// que só ele tem, e o app confere a assinatura com a chave PÚBLICA que vai no build (a pública pode estar no APK; a privada NUNCA sai do servidor).
//
//   GET /v1/identidade?nonce=<hex de 32 a 64 caracteres>  ->  { ok: true, assinatura: "<base64 da assinatura Ed25519 de 'yui-identidade-v1|' + nonce>" }
//
// O nonce é aleatório e novo a cada verificação (quem gera é o app), então uma assinatura antiga não vale para um desafio novo.
// A chave privada fica num arquivo restrito ao dono (secrets/identidade-yui.key, ou o caminho de YUI_API_IDENTIDADE_ARQUIVO), gerado por
// scripts/gerar-identidade-yui.mjs. Sem o arquivo, a rota responde 404 (recurso desligado). A chave nunca é logada, nunca vai numa resposta e nunca está no código.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** Prefixo do que é assinado (separa este uso de qualquer outro uso da mesma chave). O app confere o MESMO texto. */
export const PREFIXO_IDENTIDADE = 'yui-identidade-v1|';
const NONCE_RE = /^[0-9a-fA-F]{32,64}$/;
/** Repetição por origem: o app pede uma vez a cada abertura e depois de uma queda; 30 por minuto sobra, e adivinhar nada rende. */
export const LIMITE_IDENTIDADE = { max: 30, windowMs: 60_000 };

/** Onde fica a chave privada: YUI_API_IDENTIDADE_ARQUIVO ou secrets/identidade-yui.key (pasta ignorada pelo git). */
export function arquivoDaIdentidade(env = process.env) {
  const configurado = String(env.YUI_API_IDENTIDADE_ARQUIVO ?? '').trim();
  return configurado ? path.resolve(configurado) : path.join(ROOT, 'secrets', 'identidade-yui.key');
}

/**
 * Lê a chave privada. Devolve `{ privada, aviso }`: `privada` é o KeyObject (ou null se a prova ficou desligada) e `aviso` é uma frase curta para o log (ou null).
 * O aviso nunca traz o conteúdo do arquivo nem o texto do erro do parser. Arquivo ausente no caminho PADRÃO é só "desligado" (sem aviso).
 */
export function lerIdentidade({ arquivo = arquivoDaIdentidade(), env = process.env } = {}) {
  const configurado = String(env.YUI_API_IDENTIDADE_ARQUIVO ?? '').trim() !== '';
  let texto;
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { privada: null, aviso: configurado ? 'YUI_API_IDENTIDADE_ARQUIVO aponta para um arquivo que não existe: a prova de identidade do servidor ficou desligada.' : null };
    }
    return { privada: null, aviso: 'Não consegui ler o arquivo da identidade do servidor: a prova de identidade ficou desligada.' };
  }
  try {
    const privada = crypto.createPrivateKey(texto);
    if (privada.asymmetricKeyType !== 'ed25519') throw new Error('tipo');
    return { privada, aviso: null };
  } catch {
    return { privada: null, aviso: 'O arquivo da identidade do servidor não tem uma chave privada Ed25519 válida: a prova de identidade ficou desligada.' };
  }
}

/** A assinatura Ed25519 (base64) do desafio. Determinística: o mesmo nonce dá sempre a mesma assinatura. */
export function assinarIdentidade(privada, nonce) {
  return crypto.sign(null, Buffer.from(PREFIXO_IDENTIDADE + nonce, 'utf8'), privada).toString('base64');
}

/** Limite de repetição POR ORIGEM (janela deslizante). `tentar` conta o pedido e diz se pode: `{ ok: true }` ou `{ ok: false, retryAfter }` (segundos). */
export function criarLimitadorPorOrigem({ max = LIMITE_IDENTIDADE.max, windowMs = LIMITE_IDENTIDADE.windowMs, now = () => Date.now(), maxOrigens = 2000 } = {}) {
  const porOrigem = new Map(); // origem -> horários dos pedidos dentro da janela
  return {
    tentar(origem) {
      const t = now();
      const chave = String(origem ?? '?');
      const lista = (porOrigem.get(chave) || []).filter((x) => t - x < windowMs);
      if (lista.length >= max) {
        porOrigem.set(chave, lista);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((lista[0] + windowMs - t) / 1000)) };
      }
      lista.push(t);
      porOrigem.delete(chave); // reinsere no fim: as origens mais antigas saem primeiro
      porOrigem.set(chave, lista);
      if (porOrigem.size > maxOrigens) {
        for (const [k, l] of porOrigem) {
          if (porOrigem.size <= maxOrigens) break;
          if (!l.some((x) => t - x < windowMs)) porOrigem.delete(k);
        }
        while (porOrigem.size > maxOrigens) porOrigem.delete(porOrigem.keys().next().value);
      }
      return { ok: true };
    },
  };
}

/**
 * A prova de identidade da API.
 * @param {object} [options]
 * @param {string|null} [options.arquivo]  arquivo da chave privada (padrão: arquivoDaIdentidade()); null = desligada, sem ler nada
 * @param {object} [options.privada]       KeyObject Ed25519 já carregada (testes); tem prioridade sobre o arquivo
 * @param {object} [options.limitador]     limite de repetição por origem (criarLimitadorPorOrigem)
 * @returns {{ ativa: boolean, aviso: string|null, responder: (pedido: { method: string, searchParams: URLSearchParams, origem: string }) => { status: number, body: object, retryAfter?: number } }}
 */
export function criarIdentidade({ arquivo, env = process.env, privada: injetada = null, limitador = criarLimitadorPorOrigem() } = {}) {
  let privada = injetada;
  let aviso = null;
  if (!privada && arquivo !== null) ({ privada, aviso } = lerIdentidade({ arquivo, env }));
  const ativa = Boolean(privada);

  function responder({ method, searchParams, origem }) {
    if (!ativa) return { status: 404, body: { error: 'rota não encontrada' } };
    if (method !== 'GET') return { status: 405, body: { error: 'método não permitido' } };
    const limite = limitador.tentar(origem);
    if (!limite.ok) return { status: 429, body: { error: 'muitas requisições', retryAfter: limite.retryAfter }, retryAfter: limite.retryAfter };
    const nonces = searchParams.getAll('nonce');
    if (nonces.length !== 1 || !NONCE_RE.test(nonces[0])) return { status: 400, body: { error: 'nonce inválido' } };
    return { status: 200, body: { ok: true, assinatura: assinarIdentidade(privada, nonces[0]) } };
  }

  return { ativa, aviso, responder };
}
