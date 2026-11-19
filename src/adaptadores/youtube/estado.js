// MÁQUINA DE ESTADOS do adaptador de YouTube Live (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §7; docs/CANAIS_NOVOS.md §3). PURA: não lê, não escreve e não espera nada.
//
//   desligado ──ligar──▶ ociosa ──entrar──▶ procurando ──chat_encontrado──▶ ouvindo
//                          ▲  ◀─sem_chat────┘   │                              │ │ │
//                          │                    └─live_acabou / sair──▶ encerrada ◀┘ │ (live_acabou, sair)
//   interrompida ◀─────────┴── removida, cota_esgotada, erro_permanente ────────────┘
//   encerrada e interrompida voltam a `procurando` com um novo `entrar` (o dono manda outro link); `desligar` leva qualquer estado a `desligado`.
//
//  - ociosa:       ligada (YUI_YOUTUBE_LIVE=true), sem live;
//  - procurando:   recebeu o link e está achando o chat (activeLiveChatId);
//  - ouvindo:      lendo o chat no ritmo do pollingIntervalMillis e respondendo;
//  - encerrada:    a live acabou ou o dono mandou sair (saiu em paz);
//  - interrompida: removida/silenciada/banida, cota esgotada ou erro que não passa sozinho: para e AVISA o dono.
export const ESTADOS = Object.freeze(['desligado', 'ociosa', 'procurando', 'ouvindo', 'encerrada', 'interrompida']);
export const EVENTOS = Object.freeze(['ligar', 'desligar', 'entrar', 'chat_encontrado', 'sem_chat', 'live_acabou', 'sair', 'removida', 'cota_esgotada', 'erro_permanente']);

/** estado -> { evento: próximo estado }. O que não está aqui é recusado. */
export const TRANSICOES = Object.freeze({
  desligado: Object.freeze({ ligar: 'ociosa' }),
  ociosa: Object.freeze({ entrar: 'procurando', desligar: 'desligado' }),
  procurando: Object.freeze({ chat_encontrado: 'ouvindo', sem_chat: 'ociosa', live_acabou: 'encerrada', sair: 'encerrada', erro_permanente: 'interrompida', desligar: 'desligado' }),
  ouvindo: Object.freeze({ live_acabou: 'encerrada', sair: 'encerrada', removida: 'interrompida', cota_esgotada: 'interrompida', erro_permanente: 'interrompida', desligar: 'desligado' }),
  encerrada: Object.freeze({ entrar: 'procurando', desligar: 'desligado' }),
  interrompida: Object.freeze({ entrar: 'procurando', desligar: 'desligado' }),
});

/** Os eventos que fazem o adaptador AVISAR o dono por conta própria (ser removida, estourar a cota, falhar de vez). Os outros acontecem dentro de um comando do dono, e a resposta do comando já diz o que houve. */
export const EVENTOS_QUE_AVISAM_O_DONO = Object.freeze(['removida', 'cota_esgotada', 'erro_permanente']);

/** O adaptador está atento a uma live (procurando ou ouvindo)? */
export const estaAtiva = (estado) => estado === 'procurando' || estado === 'ouvindo';

/**
 * A transição de um estado por um evento.
 * @returns {{ ok: true, de: string, evento: string, para: string, avisarDono: boolean } | { ok: false, codigo: 'estado-desconhecido'|'evento-desconhecido'|'transicao-invalida', de: string, evento: string }}
 */
export function transicao(de, evento) {
  if (!ESTADOS.includes(de)) return { ok: false, codigo: 'estado-desconhecido', de: String(de), evento: String(evento) };
  if (!EVENTOS.includes(evento)) return { ok: false, codigo: 'evento-desconhecido', de, evento: String(evento) };
  const para = TRANSICOES[de][evento];
  if (!para) return { ok: false, codigo: 'transicao-invalida', de, evento };
  return { ok: true, de, evento, para, avisarDono: EVENTOS_QUE_AVISAM_O_DONO.includes(evento) };
}
