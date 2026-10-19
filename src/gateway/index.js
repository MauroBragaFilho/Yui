import { logger } from '../utils/logger.js';
import { loadProviders, loadCombos } from './providers.js';
import { createRouter } from './router.js';
import { createGatewayServer, parseGatewayKeys } from './server.js';

/**
 * Yui Gateway — servidor de IA próprio (estilo OmniRoute).
 *
 * Dois usos, o mesmo roteador:
 *  1. EM PROCESSO: a cadeia de IA da Yui chama o gateway logo depois do LM Studio
 *     (sem HTTP, sem chave). Ativo sempre que houver ao menos um provedor
 *     configurado; desligue com YUI_GATEWAY_IN_CHAIN=false.
 *  2. SERVIDOR HTTP compatível com OpenAI para outros apps (YUI_GATEWAY_ENABLED=true):
 *     escuta em 127.0.0.1:20130 e exige chave (YUI_GATEWAY_KEYS).
 */

let singleton = null;
let singletonEnv = process.env;

function build() {
  const { providers, warnings } = loadProviders(singletonEnv);
  const { combos, errors } = loadCombos(singletonEnv);
  for (const w of [...warnings, ...errors]) logger.warn(`[Gateway] ${w}`);
  const router = createRouter({ providers, combos });
  logger.info(`[Gateway] ${providers.length} provedor(es) ativo(s): ${providers.map((p) => p.id).join(', ') || 'nenhum'}`);
  return router;
}

/**
 * Fachada estável: quem guardou a referência (servidor HTTP, cadeia de IA) continua
 * usando o roteador atual depois de uma recarga (chaves/provedores trocados no painel).
 */
const facade = new Proxy({}, {
  get: (_t, prop) => (...args) => {
    singleton ??= build();
    return singleton[prop](...args);
  },
});

/** Roteador único do processo, criado sob demanda a partir do .env. */
export function getGateway(env = process.env) {
  if (!singleton) singletonEnv = env;
  singleton ??= build();
  return facade;
}

/** Descarta o roteador (testes e recarga de configuração): o próximo uso lê o ambiente de novo. */
export function resetGateway() {
  singleton = null;
}

/** A cadeia de IA da Yui deve usar o gateway? */
export function gatewayInChain(env = process.env) {
  if (String(env.YUI_GATEWAY_IN_CHAIN ?? 'true').toLowerCase() === 'false') return false;
  return getGateway(env).hasTargets();
}

/** Sobe o servidor HTTP se YUI_GATEWAY_ENABLED=true e houver chave. */
export function startGatewayServer(env = process.env) {
  if (String(env.YUI_GATEWAY_ENABLED ?? 'false').toLowerCase() !== 'true') return null;
  const keys = parseGatewayKeys(env.YUI_GATEWAY_KEYS);
  if (!keys.length) {
    logger.warn('[Gateway] YUI_GATEWAY_ENABLED=true mas YUI_GATEWAY_KEYS está vazio (chave com 16+ caracteres). Servidor HTTP não iniciado.');
    return null;
  }
  const router = getGateway(env);
  if (!router.hasTargets()) {
    logger.warn('[Gateway] Nenhum provedor configurado (chaves no .env). Servidor HTTP não iniciado.');
    return null;
  }
  const host = env.YUI_GATEWAY_HOST || '127.0.0.1';
  const port = parseInt(env.YUI_GATEWAY_PORT || '20130', 10);
  const server = createGatewayServer({ router, keys });
  server.listen(port, host, () => logger.info(`[Gateway] Servidor de IA em http://${host}:${port}/v1 (${keys.length} chave(s))`));
  server.on('error', (err) => logger.error(`[Gateway] Falha ao iniciar: ${err.message}`));
  return server;
}
