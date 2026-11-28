/**
 * Os valores internos dos ajustes em português (Fase 1 do painel, seção 8 da matriz). A tradução é SÓ VISUAL: o que fica gravado no cofre e o que o
 * servidor usa não mudam (o botão continua mandando "off", "observar"...). Valor sem tradução aparece como veio. Sem React (testável em Node).
 */

/** O modo do AutoMod: o mesmo nome no padrão de todos os servidores (cofre) e em cada servidor (Admin > Servidores). */
export const ROTULOS_DO_AUTOMOD: Readonly<Record<string, string>> = Object.freeze({
  off: 'Desligado',
  trigger: 'Só gatilhos',
  mcp: 'Só IA',
  both: 'Gatilhos e IA',
});

/** Ajuste do cofre -> valor interno -> como aparece na tela. */
export const ROTULOS_DE_VALORES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  YUI_AVISOS_FILTRO: { off: 'Desligado', observar: 'Só observar', ligar: 'Ligado' },
  REDDIT_FETCH_MODE: { browser: 'Pelo navegador', cookies: 'Com cookies', off: 'Não consultar' },
  YUI_AUTOMOD_AI_BAN: { review: 'A IA sugere e você decide', auto: 'A IA bane sozinha' },
  YUI_AUTOMOD_MODO_PADRAO: ROTULOS_DO_AUTOMOD,
  YUI_PESQUISA_POR_INTENCAO: { off: 'Nunca', servidor: 'Só nos servidores', dono: 'Nos servidores e na sua DM' },
});

/** Como um valor de um ajuste aparece: a tradução, se houver; senão o próprio valor. */
export function rotuloDoValor(chave: string, valor: string): string {
  const tabela = ROTULOS_DE_VALORES[chave];
  return tabela && Object.prototype.hasOwnProperty.call(tabela, valor) ? tabela[valor] : valor;
}
