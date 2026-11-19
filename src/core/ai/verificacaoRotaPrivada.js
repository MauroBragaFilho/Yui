// O PEDIDO DE NOVA VERIFICAÇÃO DA ROTA PRIVADA (etapa 13): o que a rota de administração `POST /v1/admin/ia/rota-privada/verificar` faz por baixo.
//
// Regras (decisão da revisora, etapa 9, §11):
//  - o dono só PEDE uma nova verificação: nunca desbloqueia direto. Quem libera uma rota bloqueada é UMA sonda VÁLIDA (cabeçalho lido pelo leitor
//    estrito, nomeando um provedor da lista permitida), feita por `verificarRotaPrivada({ origem: 'pedido', desbloquear: true })`, que mantém a rota
//    bloqueada quando a sonda falha. Este módulo não mexe no estado da rota: só chama essa função;
//  - a sonda é uma chamada paga ao combo privado (uma frase fixa, sem conteúdo privado): os pedidos têm LIMITE DE REPETIÇÃO (por padrão 3 a cada 10
//    minutos). Pedidos ao mesmo tempo dividem UMA sonda só (a própria `verificarRotaPrivada` faz isso), mas cada um conta no limite;
//  - a resposta tem só PALAVRAS FIXAS: o estado (um dos seis), o motivo (uma palavra fixa ou null) e uma mensagem curta de um texto fixo. Nunca
//    chave, cabeçalho, nome de combo, endereço, prompt nem conteúdo.
import { estadoDaRotaPrivada, verificarRotaPrivada } from './rotaPerfil.js';

/** Os estados da rota privada (os mesmos do diagnóstico). */
export const ESTADOS_DA_ROTA = Object.freeze(['desligada', 'incompleta', 'nao-verificada', 'validada', 'nao-validada', 'bloqueada']);
/** O limite de pedidos que gastam uma sonda: no máximo `max` a cada `janelaMs`. */
export const LIMITE_DO_PEDIDO = Object.freeze({ max: 3, janelaMs: 10 * 60_000 });

/** A mensagem de cada estado: texto fixo, curto e sem detalhe técnico. */
export const MENSAGENS_DA_ROTA = Object.freeze({
  desligada: 'O perfil privado de IA não está configurado: não há o que verificar e nada foi enviado a nenhum provedor.',
  incompleta: 'A configuração do perfil privado está incompleta: nada foi enviado a nenhum provedor.',
  'nao-verificada': 'A rota privada ainda não foi verificada e continua fechada.',
  validada: 'A rota privada foi verificada e está liberada.',
  'nao-validada': 'A verificação não passou: a rota privada continua fechada.',
  bloqueada: 'A rota privada continua bloqueada: só uma verificação válida a libera.',
});

/** Um motivo só vale como uma palavra fixa (letras minúsculas e hífen, sem cara de segredo); qualquer outra coisa vira "outro". */
const MOTIVO_RE = /^[a-z][a-z-]{1,47}$/;
const PARTES_PROIBIDAS = new Set(['sk', 'gsk', 'hf', 'rk', 'pk', 'ak', 'ghp', 'glpat', 'bearer', 'secret', 'senha', 'password', 'key', 'apikey', 'authorization']);
export function motivoEmPalavraFixa(motivo) {
  if (motivo === null || motivo === undefined) return null;
  const s = String(motivo);
  if (!MOTIVO_RE.test(s) || s.split('-').some((parte) => PARTES_PROIBIDAS.has(parte))) return 'outro';
  return s;
}

/** A resposta do pedido, só com palavras fixas. Estado desconhecido nunca vale como liberado: vira "nao-validada". */
export function respostaDoEstado(resultado) {
  const conhecido = ESTADOS_DA_ROTA.includes(resultado?.estado);
  const estado = conhecido ? resultado.estado : 'nao-validada';
  const motivo = conhecido ? motivoEmPalavraFixa(resultado?.motivo) : 'outro';
  return {
    ok: true,
    estado,
    motivo,
    liberada: estado === 'validada',
    sondaEnviada: estado !== 'desligada' && estado !== 'incompleta',
    mensagem: MENSAGENS_DA_ROTA[estado],
  };
}

/**
 * Cria o "pedir verificação" de um createAdmin (o limite de repetição vive aqui, em memória: reinicia com o processo).
 * @param {{ estado?: Function, verificar?: Function, agora?: () => number, limite?: { max: number, janelaMs: number } }} [o]  tudo injetável para teste
 * @returns {() => Promise<ReturnType<typeof respostaDoEstado> | { limitado: true, esperaSegundos: number, max: number, janelaMin: number }>}
 */
export function criarPedidoDeVerificacao({ estado = estadoDaRotaPrivada, verificar = verificarRotaPrivada, agora = Date.now, limite = LIMITE_DO_PEDIDO } = {}) {
  const pedidos = []; // os horários dos pedidos que gastam uma sonda
  return async function pedirVerificacao() {
    // Sem perfil privado ou com a configuração incompleta não há sonda: o pedido não gasta nada e não conta no limite.
    let atual = null;
    try { atual = estado(); } catch { atual = null; }
    if (atual && (atual.estado === 'desligada' || atual.estado === 'incompleta')) return respostaDoEstado({ estado: atual.estado, motivo: atual.motivo });

    const t = agora();
    while (pedidos.length && t - pedidos[0] >= limite.janelaMs) pedidos.shift();
    if (pedidos.length >= limite.max) {
      return { limitado: true, esperaSegundos: Math.max(1, Math.ceil((limite.janelaMs - (t - pedidos[0])) / 1000)), max: limite.max, janelaMin: Math.max(1, Math.round(limite.janelaMs / 60_000)) };
    }
    pedidos.push(t);
    let r;
    try {
      // Um PEDIDO de nova verificação (origem 'pedido', `desbloquear: true`): é o único jeito de tentar sair do bloqueio, e só sai com uma sonda VÁLIDA.
      r = await verificar({ origem: 'pedido', desbloquear: true });
    } catch {
      r = { estado: 'nao-validada', motivo: 'erro' };
    }
    return respostaDoEstado(r);
  };
}
