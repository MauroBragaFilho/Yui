// Textos dos motivos da voz desligada (getTtsStatus().reason). Módulo PURO, sem imports: a API do Core o usa no painel
// sem carregar o serviço de voz na subida (o serviço continua sendo carregado sob demanda). Reexportado por ./index.js.

const OFF_REASON_TEXT = Object.freeze({
  'not-initialized': 'ainda não iniciou',
  disabled: 'desligada em YUI_TTS_ENABLED',
  'no-opus': 'sem o codificador Opus',
  'no-providers': 'nenhum provedor de voz disponível na configuração',
  'init-error': 'falhou ao iniciar (veja o log)',
  shutdown: 'encerrada',
  ready: 'pronta',
});

/** Motivo (código de getTtsStatus().reason) em português, para /yui-status e para o painel. Código desconhecido = texto genérico. */
export function describeTtsReason(reason) {
  return Object.hasOwn(OFF_REASON_TEXT, reason) ? OFF_REASON_TEXT[reason] : 'motivo desconhecido';
}
