// Os ajustes da IA da CADEIA DO BOT (lacunas do painel, item 6, 26/11/2026): mostrar o modelo, novas tentativas e temperatura, prazo e tamanho da
// resposta por provedor. Antes ficavam só na memória do bot (o painel do Discord mudava e o reinício apagava). Agora a fonte é UMA: o cofre do painel
// (src/core/painelConfig.js), que põe os valores no ambiente dos dois processos; o painel do Discord e o painel web gravam lá.
//
// Quem lê: SÓ o bot (handlers/llmHandler.js), A CADA USO, por este módulo. O cérebro separado não roda a cadeia do bot: o tamanho da resposta chega a
// ele pelo fato do canal que o bot manda a cada turno (llmHandler.channelFactsForCerebro -> core/ai/limitesTokens.js, limitesDoCanal). Por isso os itens
// valem na hora (`reinicio: false`): o bot relê o cofre quando o cérebro avisa (ou ao reconectar), e a próxima chamada já usa o valor novo.
//
// O valor passa pela MESMA validação do cofre (lista fechada, faixa, tipo): um valor ruim escrito à mão no .env é ignorado (vale o padrão), nunca
// chega ao provedor. Sem a variável, vale o padrão de sempre (a tabela de providerSettings do bot e o YUI_REPLY_MAX_TOKENS): nada muda para quem não
// configurar nada.
import { CATALOGO, validarValor } from '../painelConfig.js';

/** provedor da cadeia do bot -> campo de providerSettings -> variável do cofre. */
export const VARIAVEIS_DA_CADEIA = Object.freeze({
  local: Object.freeze({ temperature: 'YUI_IA_LMSTUDIO_TEMPERATURA', timeout: 'YUI_IA_LMSTUDIO_TIMEOUT_MS', max_tokens: 'YUI_IA_LMSTUDIO_MAX_TOKENS' }),
  gemini: Object.freeze({ temperature: 'YUI_IA_GEMINI_TEMPERATURA', timeout: 'YUI_IA_GEMINI_TIMEOUT_MS', max_tokens: 'YUI_IA_GEMINI_MAX_TOKENS' }),
  // O Pollinations da cadeia não manda temperatura (o campo nunca foi usado); o tamanho só vale com o cérebro separado (fato do canal).
  pollinations: Object.freeze({ timeout: 'YUI_IA_POLLINATIONS_TIMEOUT_MS', max_tokens: 'YUI_IA_POLLINATIONS_MAX_TOKENS' }),
  hf: Object.freeze({ temperature: 'YUI_IA_HF_TEMPERATURA', timeout: 'YUI_IA_HF_TIMEOUT_MS', max_tokens: 'YUI_IA_HF_MAX_TOKENS' }),
  horde: Object.freeze({ temperature: 'YUI_IA_HORDE_TEMPERATURA', timeout: 'YUI_IA_HORDE_TIMEOUT_MS', max_tokens: 'YUI_IA_HORDE_MAX_TOKENS' }),
});

/** Os ajustes gerais da exibição e das novas tentativas. */
export const VARIAVEIS_GERAIS = Object.freeze({
  showModel: 'YUI_IA_MOSTRAR_MODELO',
  showModelThinking: 'YUI_IA_MOSTRAR_MODELO_PENSANDO',
  errorRetries: 'YUI_IA_RETENTATIVAS',
});

const POR_CHAVE = new Map(CATALOGO.map((c) => [c.chave, c]));

/**
 * O valor de UMA variável do cofre (ou do .env), validado pela regra do cofre: booleano para ligado/desligado, número para inteiro e decimal.
 * Ausente, vazio ou inválido = null (quem chama usa o padrão). Lido a cada chamada; nunca lança.
 */
export function lerAjusteIa(variavel, env = process.env) {
  const item = POR_CHAVE.get(String(variavel));
  const bruto = env?.[variavel];
  if (!item || bruto === undefined || bruto === null || String(bruto).trim() === '') return null;
  try {
    const v = validarValor(item, bruto);
    if (item.tipo === 'bool') return v === 'true';
    if (item.tipo === 'int' || item.tipo === 'decimal') return Number(v);
    return v;
  } catch {
    return null;
  }
}

/**
 * Liga os campos ajustáveis da tabela de provedores da cadeia (providerSettings do llmHandler) ao ambiente: LER um campo devolve o ajuste do cofre
 * (quando há um válido) ou o valor de BASE (o padrão do código, o YUI_REPLY_MAX_TOKENS e o que os testes atribuem); GRAVAR muda só a base. Os campos
 * sem variável (groq, cloudflare, gateway e o top_p, que nunca vai ao modelo) ficam como estão. Devolve `base(provedor, campo)` (o valor sem o cofre).
 */
export function ligarAjustesDaCadeia(tabela, env = process.env) {
  const bases = new Map();
  for (const [provedor, campos] of Object.entries(VARIAVEIS_DA_CADEIA)) {
    const alvo = tabela?.[provedor];
    if (!alvo) continue;
    for (const [campo, variavel] of Object.entries(campos)) {
      const chave = `${provedor}.${campo}`;
      bases.set(chave, alvo[campo]);
      Object.defineProperty(alvo, campo, {
        enumerable: true,
        configurable: true,
        get: () => lerAjusteIa(variavel, env) ?? bases.get(chave),
        set: (v) => { bases.set(chave, v); },
      });
    }
  }
  return {
    base: (provedor, campo) => (bases.has(`${provedor}.${campo}`) ? bases.get(`${provedor}.${campo}`) : tabela?.[provedor]?.[campo]),
  };
}

/** O tamanho da resposta que o PAINEL (o cofre) definiu para um provedor da cadeia, ou null. É o "ajuste do painel" do Discord (limitesTokens.js). */
export function maxTokensDoPainel(provedor, env = process.env) {
  const variavel = VARIAVEIS_DA_CADEIA[provedor]?.max_tokens;
  return variavel ? lerAjusteIa(variavel, env) : null;
}

/** Todas as variáveis deste módulo (para os testes e a documentação). */
export const TODAS_AS_VARIAVEIS = Object.freeze([
  ...Object.values(VARIAVEIS_GERAIS),
  ...Object.values(VARIAVEIS_DA_CADEIA).flatMap((campos) => Object.values(campos)),
]);
