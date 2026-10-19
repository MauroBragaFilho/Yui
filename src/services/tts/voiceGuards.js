/**
 * Regras puras que ligam a fala (TTS) ao fluxo de IA do bot.
 *
 * Ficam aqui, fora do llmHandler/voiceHandler (arquivos enormes e com efeitos
 * colaterais ao importar), para o llmHandler, o voiceHandler e os testes usarem
 * exatamente a mesma definição. Sem estado, sem I/O, sem logger.
 */

/** Resposta fixa quando alguém pede, por voz, algo que só vale no chat de texto. */
export const VOICE_TOOL_REFUSAL = 'Isso eu faço só pelo chat.';

/**
 * Item de voz = veio do voiceHandler (options.voice) E a mensagem é de voz.
 * O radioManager também marca `isVoice`, por isso `options.voice` é o portão real.
 */
export function isVoiceItem(options, interaction) {
  return options?.voice === true && interaction?.isVoice === true;
}

/** Chave de histórico/persona/escopo da voz: um fio por pessoa em cada servidor. */
export function buildVoiceKey(guildId, userId) {
  return `voice:${guildId}:${userId}`;
}

/** YUI_VOICE_TOOLS=true devolve o comportamento antigo (ferramentas ligadas na voz). */
export function voiceToolsAllowed(env = process.env) {
  return String(env?.YUI_VOICE_TOOLS ?? '').trim().toLowerCase() === 'true';
}

/**
 * Deve a chamada de ferramenta devolvida pela IA ser DESCARTADA? Sim, quando o
 * item é de voz e as ferramentas por voz não foram liberadas. `disableTools`
 * sozinho só tira a ferramenta da OFERTA; quem executa o JSON precisa deste guarda.
 */
export function shouldBlockToolForVoice(options, env = process.env) {
  return options?.voice === true && !voiceToolsAllowed(env);
}

/** Pedido de voz velho demais (a fila da IA é serial): não vale mais responder. */
export function isStaleVoiceItem(options, nowMs = Date.now(), staleSeconds = 30) {
  if (options?.voice !== true) return false;
  const at = Number(options.voiceRequestedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return nowMs - at > staleSeconds * 1000;
}

/**
 * Texto de voz que vai ao chat: no máx. `max` caracteres, cortado no fim de frase
 * (ou no último espaço). O divisor de respostas longas não se aplica à voz.
 */
export function clipForChat(text, max = 1900) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  if (sentenceEnd >= max * 0.5) return head.slice(0, sentenceEnd + 1).trimEnd();
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}
