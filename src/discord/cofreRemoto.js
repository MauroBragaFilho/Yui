// ONDE o painel do Discord grava a configuração (lacunas do painel, item 6, 26/11/2026: o Discord e o painel web gravam no MESMO cofre).
//  - processo único: direto no cofre deste processo (src/core/ajustesPeloDiscord.js);
//  - cérebro separado (YUI_CEREBRO_EXTERNO=true): pelo canal, ao cérebro, que é o dono do cofre (método `painel.config.discord`). O canalCerebro.js instala
//    o pedido aqui (definirCofreRemoto). Sem o canal (cérebro fora, ainda conectando), NÃO grava: nunca num segundo lugar, nunca na memória do bot.
// Depois de gravar pelo cérebro, o bot relê o cofre na hora (os itens que valem sem reiniciar já mudam neste processo).
import { gravarAjusteDoDiscord } from '../core/ajustesPeloDiscord.js';
import { PainelConfigError, recarregarAoVivo } from '../core/painelConfig.js';
import { buildContext } from '../core/permissions.js';
import { cerebroExterno } from './modoSeparado.js';

export const CEREBRO_FORA = 'o cérebro da Yui está fora agora. Nada foi alterado; tente de novo quando ele voltar.';
export const SEM_RESPOSTA = 'o cérebro não respondeu a tempo. Não sei se gravou: confira o valor antes de tentar de novo.';

// De onde veio o pedido (o cérebro passa pela política com a MESMA ação que o guarda do Discord usou no bot): o painel de configuração (admin.bot_config),
// o /yui-config_ia (admin.ai_configure) ou o /yui-criador modelo e o formulário do painel master (admin.guild_configure).
const VIAS = new Set(['painel', 'comando', 'criador']);

let remoto = null;
/** Instala (ou tira, com null) o pedido ao cérebro: `(corpo) => Promise<resultado>`. */
export function definirCofreRemoto(fn) { remoto = typeof fn === 'function' ? fn : null; }

const FORA = new Set(['NOT_CONNECTED', 'CONNECTION_LOST', 'CLOSED', 'METHOD_NOT_FOUND']);

/** Erro do canal -> PainelConfigError com status e texto curto (nunca o valor). */
export function erroDoCanal(err) {
  if (err instanceof PainelConfigError) return err;
  const m = /^ADMIN_(\d{3})$/.exec(String(err?.code ?? ''));
  if (m) return new PainelConfigError(Number(m[1]), String(err.message ?? 'Erro.').slice(0, 300));
  if (FORA.has(err?.code)) return new PainelConfigError(503, CEREBRO_FORA);
  if (err?.code === 'TIMEOUT') return new PainelConfigError(504, SEM_RESPOSTA);
  if (['FORBIDDEN', 'POLICY_DENIED', 'POLICY_CRITICAL', 'METHOD_NOT_ALLOWED'].includes(err?.code)) return new PainelConfigError(403, String(err.message ?? 'Não permitido.').slice(0, 300));
  return new PainelConfigError(502, 'o cérebro não conseguiu gravar o ajuste. Confira o valor no painel antes de tentar de novo.');
}

/**
 * Grava (ou remove, com `tirar`) um ajuste do cofre a pedido do painel do Discord.
 * @param {{ userId: string, guildId?: string|null, channelId?: string|null, isDM?: boolean, chave: string, valor?: string|number|boolean, tirar?: boolean,
 *           confirm?: boolean, via?: 'painel'|'comando'|'criador' }} pedido
 * @returns {Promise<{ ok: true, chave: string, reinicio: boolean, valor: string|null, origem: string, removido?: true }>}  lança PainelConfigError
 */
export async function gravarPeloDiscord(pedido, { env = process.env, separado = cerebroExterno(env), audit = null } = {}) {
  const origem = {
    platform: 'discord', userId: String(pedido?.userId ?? ''), guildId: pedido?.guildId ? String(pedido.guildId) : null,
    channelId: pedido?.channelId ? String(pedido.channelId) : null, isDM: pedido?.isDM === true,
  };
  const tirar = pedido?.tirar === true;
  // A versão que a página mostrou (correção C5): só um inteiro; sem ela (botão antigo), o cofre não confere.
  const versao = Number.isSafeInteger(pedido?.versao) && pedido.versao >= 0 ? pedido.versao : undefined;
  const corpo = {
    ctx: origem, chave: String(pedido?.chave ?? ''), ...(tirar ? { tirar: true } : { valor: String(pedido?.valor ?? '') }),
    confirm: pedido?.confirm === true, via: VIAS.has(pedido?.via) ? pedido.via : 'painel', ...(versao !== undefined ? { versao } : {}),
  };
  if (separado) {
    if (!remoto) throw new PainelConfigError(503, CEREBRO_FORA);
    let r;
    try { r = await remoto(corpo); } catch (err) { throw erroDoCanal(err); }
    try { recarregarAoVivo(env); } catch { /* o aviso do cérebro e a reconexão também relêem */ }
    return r;
  }
  return gravarAjusteDoDiscord(
    { ctx: buildContext(origem), chave: corpo.chave, valor: corpo.valor, tirar, confirm: corpo.confirm, versao: corpo.versao },
    { env, ...(audit ? { audit } : {}) },
  );
}

/** A origem de um pedido a partir da interação do Discord (quem, onde). */
export function pedidoDaInteracao(interaction) {
  return { userId: String(interaction?.user?.id ?? ''), guildId: interaction?.guildId ?? null, channelId: interaction?.channelId ?? null, isDM: !interaction?.guildId };
}

/**
 * Vários ajustes de uma vez (o "/yui-criador modelo" e o formulário "Modelos & Pensamento" do painel master): um por um, cada um com o seu resultado
 * (um erro não esconde os outros). `pares`: [[chave, valor], ...]. Nunca lança.
 * @returns {Promise<Array<{ chave: string, ok: boolean, valor?: string|null, reinicio?: boolean, erro?: string }>>}
 */
export async function gravarVariosPeloDiscord(pedido, pares, opcoes = {}) {
  const out = [];
  // Cada par pode trazer a versão que a tela mostrou (C5): [chave, valor, versao]. Sem ela, grava sem conferir.
  for (const [chave, valor, versao] of pares) {
    try {
      const r = await gravarPeloDiscord({ ...pedido, chave, valor, ...(versao !== undefined ? { versao } : {}) }, opcoes);
      out.push({ chave, ok: true, valor: r?.valor ?? null, reinicio: r?.reinicio === true });
    } catch (err) {
      out.push({ chave, ok: false, erro: err instanceof PainelConfigError ? String(err.message) : 'erro inesperado' });
    }
  }
  return out;
}
