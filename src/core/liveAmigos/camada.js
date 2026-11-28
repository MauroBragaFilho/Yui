// A CAMADA OBRIGATÓRIA da live dos amigos (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §5). PURA e determinística.
//
// Roda no serviço (no cérebro, ou no processo único) ANTES do motor de políticas, em toda operação, e não depende do modo do motor
// (observe, enforce ou off): o motor só pode deixar a decisão mais restritiva, nunca transformar uma negação desta camada em autorização.
// O interruptor geral (YUI_LIVE_AMIGOS) é conferido CONFORME A AÇÃO: desligado, ele nega autorizar, mas nunca impede listar, revogar ou apagar.
import { RE_CANAL_ID, RE_CODIGO, RE_DISCORD_ID } from './frases.js';

export const ACOES = Object.freeze({
  listar: 'live_amigos.listar',
  autorizar: 'live_amigos.autorizar',
  revogar: 'live_amigos.revogar',
  apagar_meus_dados: 'live_amigos.apagar_meus_dados',
});

export const MOTIVOS = Object.freeze(['nao-e-o-dono', 'sem-vinculo', 'vinculo-de-outro', 'ja-vinculado', 'desligado', 'formato-invalido', 'acao-desconhecida', 'limite', 'indisponivel']);

/** Estados em que um vínculo ainda "ocupa" a pessoa e o canal (unicidade) e ainda existe no arquivo. */
const OCUPA = new Set(['ativo', 'encerrando']);

const nega = (motivo) => ({ ok: false, motivo });
const OK = Object.freeze({ ok: true, motivo: null });

/**
 * @param {string} acao uma das chaves de ACOES (listar, autorizar, revogar, apagar_meus_dados)
 * @param {{ ehDono: boolean, userId: string, alvo?: { discordId?: string, canalId?: string, codigo?: string }, vinculos: Array<object>, interruptor: boolean, bloqueados?: Set<string> }} c
 * @returns {{ ok: boolean, motivo: string|null }}
 */
export function conferirLiveAmigos(acao, { ehDono = false, userId = '', alvo = {}, vinculos = [], interruptor = false, bloqueados = new Set() } = {}) {
  const lista = Array.isArray(vinculos) ? vinculos : [];
  switch (acao) {
    case 'listar':
      return ehDono ? OK : nega('nao-e-o-dono');
    case 'autorizar': {
      if (!ehDono) return nega('nao-e-o-dono');
      if (!interruptor) return nega('desligado');
      if (!RE_DISCORD_ID.test(String(alvo?.discordId ?? '')) || !RE_CANAL_ID.test(String(alvo?.canalId ?? ''))) return nega('formato-invalido');
      const ocupado = lista.some((v) => OCUPA.has(v.estado) && (v.discordId === alvo.discordId || v.canalId === alvo.canalId));
      return ocupado ? nega('ja-vinculado') : OK;
    }
    case 'revogar': {
      if (!ehDono) return nega('nao-e-o-dono');
      const codigo = String(alvo?.codigo ?? '');
      if (!RE_CODIGO.test(codigo)) return nega('formato-invalido');
      const v = lista.find((x) => x.codigo === codigo);
      if (!v || v.estado !== 'ativo' || bloqueados.has(codigo)) return nega('sem-vinculo');
      return OK;
    }
    case 'apagar_meus_dados': {
      // Só sobre o PRÓPRIO vínculo: o alvo é sempre quem pede, nunca um ID vindo do texto.
      const v = lista.find((x) => x.discordId === String(userId));
      if (!v || v.estado !== 'ativo' || bloqueados.has(v.codigo)) return nega('sem-vinculo');
      if (alvo?.codigo && alvo.codigo !== v.codigo) return nega('vinculo-de-outro');
      return OK;
    }
    default:
      return nega('acao-desconhecida');
  }
}
