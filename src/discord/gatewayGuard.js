import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';

/**
 * Proteção contra um defeito da @discordjs/ws 1.x (a camada de conexão do discord.js 14).
 *
 * O defeito: ao reconectar, `WebSocketShard.destroy()` solta o tratador de erro da conexão atual
 * (`connection.onerror = null`), mas só fecha a conexão se ela já estiver ABERTA. Se a rede cai
 * durante o aperto de mão (handshake), a conexão em andamento fica órfã; quando o prazo dela
 * vence (30 s sem resposta), o pacote `ws` emite 'error' sem ninguém ouvindo e o Node transforma
 * isso em exceção não capturada: "Opening handshake has timed out". A Yui já estava reconectando
 * por conta própria, então o erro era só barulho que chegava ao dono como "Erro grave na Yui".
 *
 * Quando acontece: notebook sem internet ou Wi-Fi instável por alguns minutos (visto em 10/11/2026,
 * com a rede fora de ~23h41 a ~00h20).
 *
 * A correção: antes do `destroy` original, uma conexão que ainda não abriu (ou que já está fechando)
 * ganha um ouvinte de 'error' que só registra no log. Nada mais muda no comportamento da biblioteca.
 */

const GUARDED = Symbol.for('yui.gatewayGuard.connection');
const PATCHED = Symbol.for('yui.gatewayGuard.patched');

// Estados do WebSocket (iguais no pacote ws e no padrão da web).
const OPEN = 1;
const CLOSED = 3;

/**
 * Dá à conexão um ouvinte de 'error' que só registra no log, se ela puder ficar órfã.
 * Conexão ABERTA é fechada pelo próprio destroy (que espera o fechamento); conexão FECHADA não emite mais nada.
 * @returns {boolean} true se o ouvinte foi colocado agora.
 */
export function guardConnection(connection, { log = logger } = {}) {
  if (!connection || typeof connection.on !== 'function') return false;
  if (connection[GUARDED]) return false;
  const state = connection.readyState;
  if (state === OPEN || state === CLOSED) return false;
  connection[GUARDED] = true;
  connection.on('error', (err) => {
    log.warn(`[Discord] Uma conexão antiga, descartada durante a reconexão, falhou (${err?.message || err}). Sem efeito: a Yui segue reconectando sozinha.`);
  });
  return true;
}

/** Carrega a @discordjs/ws exatamente como o discord.js a carrega (mesma instância, mesmo se estiver aninhada). */
function loadDiscordWs() {
  const requireFromHere = createRequire(import.meta.url);
  const requireFromDiscordJs = createRequire(requireFromHere.resolve('discord.js'));
  return requireFromDiscordJs('@discordjs/ws');
}

/**
 * Instala a proteção (uma vez por processo). Nunca lança: se a biblioteca mudar e o ponto de
 * encaixe sumir, só registra um aviso no log e segue.
 * @param {{ WebSocketShard?: Function, log?: object }} [o] WebSocketShard injetável nos testes.
 * @returns {boolean} true se a proteção está ativa.
 */
export function installGatewayGuard({ WebSocketShard = null, log = logger } = {}) {
  try {
    const Shard = WebSocketShard ?? loadDiscordWs().WebSocketShard;
    const proto = Shard?.prototype;
    if (typeof proto?.destroy !== 'function') {
      log.warn('[Discord] Proteção de reconexão não instalada: a @discordjs/ws mudou (WebSocketShard.destroy não existe).');
      return false;
    }
    if (proto[PATCHED]) return true;
    const original = proto.destroy;
    proto.destroy = function destroyWithGuard(...args) {
      try {
        guardConnection(this.connection, { log });
      } catch {
        // A proteção nunca pode atrapalhar o destroy original.
      }
      return original.apply(this, args);
    };
    proto[PATCHED] = true;
    return true;
  } catch (err) {
    log.warn(`[Discord] Proteção de reconexão não instalada: ${err?.message || err}`);
    return false;
  }
}
