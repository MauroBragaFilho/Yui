// Adaptador de YouTube Live (esqueleto DESLIGADO por YUI_YOUTUBE_LIVE=false; nada o carrega ainda). Veja docs/CANAIS_NOVOS.md.
export { criarAdaptadorYoutube, youtubeLigado, CONFIG_PADRAO } from './adaptador.js';
export { criarClienteYoutube, validarBaseUrl, mapearErroHttp, ErroYoutube, BASE_PADRAO } from './api.js';
export { criarCota, planejarCota, intervaloMinimoQueCabe, diaDaCota, CUSTOS_PADRAO, COTA_DIARIA_PADRAO } from './cota.js';
export { ESTADOS, EVENTOS, TRANSICOES, transicao, estaAtiva } from './estado.js';
export { criarGuardaDeFala, criarLimiteDeMensagens, classificarMensagem, normalizarMensagem, mencionaAYui, montarContextoDeAssunto, LIMITES_DA_FALA } from './fala.js';
export { extrairIdDoVideo, podeComandarALive, CANAIS_QUE_COMANDAM } from './link.js';
