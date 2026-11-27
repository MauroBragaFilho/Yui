// O painel de configuração do DISCORD (/yui-criador bot_config e /yui-config_ia) grava no MESMO cofre do painel web (lacunas do painel, item 6;
// decisão do dono em 26/11/2026: "gravar no mesmo cofre"). Antes, metade ficava só na memória do bot e a outra metade ia para o src/config/config.json,
// que nada lê ao subir: o reinício apagava tudo e o painel web não via nada.
//
// Uma regra só, usada nos dois modos:
//  - processo único: o bot chama gravarAjusteDoDiscord direto (o cofre é deste processo);
//  - cérebro separado: o bot pede ao cérebro pelo canal (método `painel.config.discord`, src/cerebro/metodos.js), e o CÉREBRO chama esta mesma função.
//    O bot nunca grava o cofre nesse modo: cérebro fora = não grava em lugar nenhum.
// O que vale nos dois: só o DONO; só as chaves da lista fechada abaixo (o resto do cofre continua só pelo painel web); a validação do próprio cofre
// (painelConfig.definir/remover: catálogo, faixa, opções, formato, edição travada por YUI_PAINEL_CONFIG_EDIT=false, cofre que não abre); a confirmação
// dos valores que afrouxam privacidade ou segurança; e a auditoria com o NOME do ajuste, nunca o valor. A resposta traz o valor RELIDO do cofre.
import { definir, remover, descreverItem, exigeConfirmacao, PainelConfigError } from './painelConfig.js';
import { ROLES } from './permissions.js';
import { audit as auditPadrao } from './audit.js';

/** As chaves do cofre que o painel do Discord pode gravar (cada uma é uma página dele). Nenhuma é segredo. */
export const CHAVES_DO_DISCORD = Object.freeze([
  // IA: exibição, novas tentativas e a cadeia do bot (src/core/ai/ajustesIa.js)
  'YUI_IA_MOSTRAR_MODELO', 'YUI_IA_MOSTRAR_MODELO_PENSANDO', 'YUI_IA_RETENTATIVAS', 'YUI_IA_CONTEXTO_DO_SERVIDOR',
  'YUI_IA_LMSTUDIO_TEMPERATURA', 'YUI_IA_LMSTUDIO_TIMEOUT_MS', 'YUI_IA_LMSTUDIO_MAX_TOKENS',
  'YUI_IA_GEMINI_TEMPERATURA', 'YUI_IA_GEMINI_TIMEOUT_MS', 'YUI_IA_GEMINI_MAX_TOKENS',
  'YUI_IA_POLLINATIONS_TIMEOUT_MS', 'YUI_IA_POLLINATIONS_MAX_TOKENS',
  'YUI_IA_HF_TEMPERATURA', 'YUI_IA_HF_TIMEOUT_MS', 'YUI_IA_HF_MAX_TOKENS',
  'YUI_IA_HORDE_TEMPERATURA', 'YUI_IA_HORDE_TIMEOUT_MS', 'YUI_IA_HORDE_MAX_TOKENS',
  // Modelos (pedem reinício)
  'GEMINI_MODEL', 'GEMINI_MODEL_FALLBACK', 'GROQ_MODEL', 'HF_MODEL', 'LOCAL_LLM_MODEL',
  // Moderação, privacidade e mídia (getters de src/config/index.js) e os Termos de Uso (já estavam no cofre)
  'REQUIRE_TOS', 'YUI_AUTOMOD_PADRAO', 'YUI_AUTOMOD_MODO_PADRAO', 'YUI_CANAL_APELACOES', 'YUI_SALVAR_HISTORICO', 'YUI_MUSICA_MANTER_CARTAO',
]);

export const CONFIRMACAO_NECESSARIA = 'Confirmação necessária: esse valor afrouxa a privacidade ou a segurança.';

/**
 * Grava (ou, com `tirar`, remove do cofre, voltando ao .env ou ao padrão) UM ajuste a pedido do painel do Discord.
 * `ctx`: o contexto do Core de quem pediu (montado por quem recebe o pedido, nunca o que o outro lado afirmou). `confirm`: true só depois do botão
 * "Confirmar" (valores da lista `confirmar` do catálogo e a remoção deles). Lança PainelConfigError (status HTTP e texto sem o valor).
 * @returns {{ ok: true, chave: string, reinicio: boolean, valor: string|null, origem: 'painel'|'env'|'padrao', removido?: true }}
 */
export function gravarAjusteDoDiscord({ ctx, chave, valor, tirar = false, confirm = false, versao } = {}, { env = process.env, audit = auditPadrao } = {}) {
  if (ctx?.role !== ROLES.OWNER) throw new PainelConfigError(403, 'Apenas o dono pode mudar a configuração da Yui.');
  const k = String(chave ?? '');
  if (!CHAVES_DO_DISCORD.includes(k)) throw new PainelConfigError(404, 'Esse ajuste não pode ser mudado pelo Discord.');
  if (!tirar && (valor === undefined || valor === null || typeof valor === 'object')) throw new PainelConfigError(400, 'Informe um valor.');
  const precisa = tirar ? exigeConfirmacao(k) : exigeConfirmacao(k, String(valor));
  if (precisa && confirm !== true) throw new PainelConfigError(428, CONFIRMACAO_NECESSARIA);
  // `versao`: a que a página do Discord mostrou (correção C5); se o painel web gravou no meio, o cofre recusa com 409.
  const r = tirar ? remover(k, env, { versao }) : definir(k, String(valor), env, { versao });
  try { audit(tirar ? 'admin.config.remove' : 'admin.config.set', ctx, { chave: r.chave, via: 'discord' }); } catch { /* a auditoria nunca desfaz a gravação */ }
  const relido = descreverItem(k, env);
  return { ok: true, chave: r.chave, reinicio: r.reinicio, valor: relido?.valor ?? null, origem: relido?.origem ?? 'padrao', versao: r.versao, ...(tirar ? { removido: true } : {}) };
}
