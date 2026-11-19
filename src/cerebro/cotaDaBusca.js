// A reserva da cota de busca (etapa 6, ajustes da Liz; movida do pesquisa.js na etapa 11 para a conversa e a pesquisa usarem a MESMA conta sem importar uma a outra).
// Só LÊ os contadores: nunca gasta uma busca.
import { activeProviders } from '../search/providers.js';
import { getDefaultBudget, userLimitPerHour, globalLimitPerHour, monthlyCap } from '../search/budget.js';

/** Reserva da cota (YUI_CEREBRO_BUSCA_RESERVA, em %, padrão 20; 0 desliga o aviso): abaixo disto do que sobra, a cota está "perto do fim". */
export function reservaDaCota(env = process.env) {
  const n = Number.parseInt(String(env.YUI_CEREBRO_BUSCA_RESERVA ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 90) : 20;
}

/**
 * A cota de busca está perto do fim para esta pessoa? Só LÊ os contadores (não gasta nada): o limite por hora da pessoa
 * (YUI_SEARCH_USER_PER_HOUR), o teto global por hora (YUI_SEARCH_GLOBAL_PER_HOUR) e, se TODOS os buscadores ativos tiverem teto mensal, a cota
 * do mês. "Perto do fim" = sobram até YUI_CEREBRO_BUSCA_RESERVA % (no mínimo 1 busca). Só números no resultado.
 * @returns {{ perto: boolean, motivo: string, restantes: { usuario: number|null, global: number|null, mensal: number|null } }}
 */
export function cotaDaBusca(userId, { budget = getDefaultBudget(), env = process.env } = {}) {
  const pct = reservaDaCota(env);
  const out = { perto: false, motivo: '', restantes: { usuario: null, global: null, mensal: null } };
  if (!pct) return out;
  const reserva = (limite) => Math.max(1, Math.ceil((limite * pct) / 100));
  try {
    const u = budget.userStatus?.(userId, env);
    if (u && userLimitPerHour(env) > 0 && userId) {
      out.restantes.usuario = Math.max(0, u.limit - u.used);
      if (out.restantes.usuario <= reserva(u.limit)) { out.perto = true; out.motivo = 'usuario'; }
    }
    const g = budget.globalStatus?.(env);
    if (g && globalLimitPerHour(env) > 0) {
      out.restantes.global = Math.max(0, g.limit - g.used);
      if (!out.perto && out.restantes.global <= reserva(g.limit)) { out.perto = true; out.motivo = 'global'; }
    }
    const ativos = activeProviders(env);
    const comTeto = ativos.filter((p) => monthlyCap(p, env) > 0);
    if (ativos.length && comTeto.length === ativos.length && typeof budget.used === 'function') {
      const sobras = comTeto.map((p) => ({ sobra: Math.max(0, monthlyCap(p, env) - budget.used(p)), cap: monthlyCap(p, env) }));
      out.restantes.mensal = sobras.reduce((s, x) => s + x.sobra, 0);
      if (!out.perto && sobras.every((x) => x.sobra <= reserva(x.cap))) { out.perto = true; out.motivo = 'mensal'; }
    }
  } catch { /* sem como ler a cota: segue sem o aviso (a cota de verdade continua valendo no buscador) */ }
  return out;
}
