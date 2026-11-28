// CIRCUIT BREAKER (disjuntor) por provedor/perfil (docs/inteligencia/02 §8): 3 falhas (ou timeouts) seguidas abrem o disjuntor por 5 minutos;
// aberto, quem chama NEM tenta (fecha rápido, sem gastar cota nem tempo). Passado o prazo, UMA chamada de prova passa (meio-aberto): se der certo,
// fecha; se falhar, abre de novo por mais 5 minutos. Só RAM, só contadores, nada de conteúdo.
//
// Fase B: só o interpretador usa. Os outros perfis NÃO mudam de comportamento; quem quiser usar depois chama `disjuntorDeIa` com a sua chave.

export const FALHAS_PARA_ABRIR = 3;
export const ABERTO_POR_MS = 5 * 60_000;

/**
 * @param {{ falhas?: number, abertoMs?: number, agora?: () => number }} [opcoes]
 */
export function criarDisjuntor({ falhas = FALHAS_PARA_ABRIR, abertoMs = ABERTO_POR_MS, agora = Date.now } = {}) {
  /** chave -> { seguidas, abertoAte, provando } */
  const chaves = new Map();
  const get = (k) => { let c = chaves.get(k); if (!c) { c = { seguidas: 0, abertoAte: 0, provando: false }; chaves.set(k, c); } return c; };

  return {
    /** Pode chamar agora? Fechado: sim. Aberto: não. Passado o prazo: sim para UMA chamada de prova por vez. */
    permitir(chave) {
      const c = get(String(chave));
      if (c.abertoAte === 0) return true;
      if (agora() < c.abertoAte) return false;
      if (c.provando) return false;
      c.provando = true;
      return true;
    },
    sucesso(chave) {
      const c = get(String(chave));
      c.seguidas = 0; c.abertoAte = 0; c.provando = false;
    },
    /** Uma falha (erro, timeout, resposta inválida da rota). */
    falha(chave) {
      const c = get(String(chave));
      c.provando = false;
      c.seguidas += 1;
      if (c.seguidas >= falhas || c.abertoAte !== 0) c.abertoAte = agora() + abertoMs;
    },
    estado(chave) {
      const c = get(String(chave));
      const aberto = c.abertoAte !== 0 && agora() < c.abertoAte;
      return { estado: aberto ? 'aberto' : (c.abertoAte !== 0 ? 'meio-aberto' : 'fechado'), seguidas: c.seguidas, reabreEmMs: aberto ? c.abertoAte - agora() : 0 };
    },
    zerar() { chaves.clear(); },
  };
}

/** O disjuntor do processo (a chave é o provedor/perfil, por exemplo "interpretar"). */
export const disjuntorDeIa = criarDisjuntor();
