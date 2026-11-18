/**
 * O texto da confirmação de "Reiniciar a Yui" (sem React, testável em Node). Diz a VERDADE sobre o que reinicia:
 *  - com o cérebro separado (a visão geral traz `cerebro`): o servidor pede ao supervisor o reinício do cérebro E do bot, nessa ordem de parada (o bot, depois o cérebro) e de
 *    subida (o cérebro, depois o bot). O bot sai do Discord e o app fica sem resposta até o cérebro voltar;
 *  - processo único (sem `cerebro`): a Yui inteira sai e volta sozinha.
 * A confirmação continua explícita (o servidor também exige `confirm: true` e o dono) e o app não decide nada: a resposta do servidor (`message`) é mostrada como veio.
 */
export interface ConfirmacaoDeReinicio { titulo: string; mensagem: string; sim: string }

export function confirmacaoDeReinicio(overview: { cerebro?: { botConectado?: boolean } | null } | null | undefined): ConfirmacaoDeReinicio {
  if (overview?.cerebro) {
    const botFora = overview.cerebro.botConectado === false ? ' O bot já está desconectado do cérebro agora.' : '';
    return {
      titulo: 'Reiniciar o cérebro e o bot?',
      mensagem: `Reinicia os DOIS: o cérebro (que atende este app) e o bot do Discord. O bot sai do Discord e este app fica sem resposta até o cérebro voltar, de alguns segundos a cerca de um minuto. Conversas e músicas em andamento são interrompidas.${botFora}`,
      sim: 'Reiniciar os dois',
    };
  }
  return {
    titulo: 'Reiniciar a Yui?',
    mensagem: 'A Yui fica offline por alguns segundos e volta sozinha. Conversas em andamento são interrompidas.',
    sim: 'Reiniciar',
  };
}
