/**
 * Regras da seção "Live do YouTube" do Admin (lacunas do painel, entrega E, 27/11/2026; item 4 v2), sem React e sem rede (testáveis em Node).
 *  - Entrar (POST /v1/admin/live/entrar { endereco, horas? }) e Sair (POST /v1/admin/live/sair): o servidor monta o MESMO comando da conversa ("entra na live
 *    <link> por N horas", "sai da live") e passa pelo mesmo serviço. Aqui só se confere o formato antes de mandar (o servidor confere tudo de novo), quando cada
 *    botão aparece e o texto da confirmação de sair. A frase do resultado é a do servidor.
 *  - O estado vem de GET /v1/admin/live (o mesmo do cartão do Início): nunca texto do chat nem quem escreveu.
 */
import type { LiveLike, TomDaConta } from './contasLogic.ts';

/** O mesmo teto do servidor: horas inteiras de 1 a 99 (a conversa aceita "por 1 hora" a "por 99 horas"). */
export const HORAS_MIN = 1;
export const HORAS_MAX = 99;
/** As durações sugeridas na tela (o campo aceita outra). Vazio = sem duração (o ritmo padrão). */
export const DURACOES_SUGERIDAS = Object.freeze(['', '2', '4', '6', '8']);
export const TEXTO_LINK_INVALIDO = 'Esse link não parece de uma live do YouTube.';

export type Validacao = { ok: true; corpo: { endereco: string; horas?: number } } | { ok: false; erro: string };

/**
 * Confere o link e a duração ANTES de mandar (o mesmo formato que o servidor aceita): o link numa linha, sem espaço, até 300 caracteres, começando por
 * http(s):// ou youtube.com / youtu.be; a duração vazia ou um número inteiro de 1 a 99. Não decide se é live: isso é do servidor (e do YouTube).
 */
export function validarEntrada(endereco: string, horas: string): Validacao {
  const e = String(endereco ?? '').trim();
  if (!e || e.length > 300 || /[\s<>\u0000-\u001f\u007f-\u009f]/.test(e)) return { ok: false, erro: TEXTO_LINK_INVALIDO };
  if (!/^(?:https?:\/\/|(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be)\/)/i.test(e)) return { ok: false, erro: TEXTO_LINK_INVALIDO };
  const h = String(horas ?? '').trim();
  if (!h) return { ok: true, corpo: { endereco: e } };
  if (!/^\d{1,2}$/.test(h) || Number(h) < HORAS_MIN || Number(h) > HORAS_MAX) return { ok: false, erro: `A duração vai em horas inteiras, de ${HORAS_MIN} a ${HORAS_MAX} (ou deixe em branco).` };
  return { ok: true, corpo: { endereco: e, horas: Number(h) } };
}

/** O rótulo de uma duração sugerida. */
export const rotuloDaDuracao = (h: string): string => (h ? `${h} h` : 'Sem duração');

export interface SituacaoDaLive {
  titulo: string;
  texto: string;
  tom: TomDaConta;
  /** Os botões que valem agora. */
  podeEntrar: boolean;
  podeSair: boolean;
}

/**
 * A situação da live para a seção: desligada (sem botões e com o caminho para ligar), sem o serviço no servidor, procurando o chat ou no chat (Sair), ou fora
 * de uma live (Entrar). Sem resposta do servidor: nada de botão.
 */
export function situacaoDaLive(v: LiveLike | null | undefined): SituacaoDaLive {
  if (!v) return { titulo: 'Sem leitura', texto: 'Não consegui ler o estado da live agora.', tom: 'neutro', podeEntrar: false, podeSair: false };
  if (v.ligado !== true) {
    return { titulo: 'Desligada', texto: 'A Yui no chat de uma live está desligada ("Yui no chat de uma live do YouTube" em Configuração e chaves; vale depois de reiniciar).', tom: 'neutro', podeEntrar: false, podeSair: false };
  }
  if (v.disponivel === false) {
    return { titulo: 'Indisponível', texto: 'A chave está ligada, mas o serviço da live não subiu no servidor. Reinicie a Yui e confira o log.', tom: 'critico', podeEntrar: false, podeSair: false };
  }
  if (v.ativo === true && v.estado === 'ouvindo') return { titulo: 'No chat', texto: 'A Yui está no chat da live e responde quando a chamam pelo nome.', tom: 'ok', podeEntrar: false, podeSair: true };
  if (v.ativo === true) return { titulo: 'Procurando o chat', texto: 'A Yui está procurando o chat da live.', tom: 'atencao', podeEntrar: false, podeSair: true };
  return { titulo: 'Fora de live', texto: 'Cole o link da live (youtube.com/live/..., youtube.com/watch?v=... ou youtu.be/...) e, se quiser, a duração.', tom: 'neutro', podeEntrar: true, podeSair: false };
}

/** A confirmação de Sair: a Yui para de ler e responder e só volta se entrar de novo. */
export function confirmacaoDeSaida(v: Pick<LiveLike, 'live'> | null | undefined): { titulo: string; mensagem: string; sim: string } {
  const nome = String(v?.live?.titulo ?? '').trim();
  return {
    titulo: 'Sair da live',
    mensagem: `A Yui sai do chat${nome ? ` de "${nome}"` : ' da live'} e para de ler e de responder. Para voltar, é preciso entrar de novo.`,
    sim: 'Sair',
  };
}

/** A frase do resultado (a do servidor) com o tom: entrou ou saiu de fato = ok; o serviço recusou = atenção. */
export function resultadoDaAcao(r: { ok: boolean; texto: string } | null | undefined): { texto: string; tom: TomDaConta } | null {
  if (!r) return null;
  const texto = String(r.texto ?? '').trim() || (r.ok ? 'Pronto.' : 'Não deu certo agora.');
  return { texto, tom: r.ok ? 'ok' : 'atencao' };
}
