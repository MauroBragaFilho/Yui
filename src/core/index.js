/**
 * Yui Core — ponto único de entrada. Adaptadores (Discord, API, apps)
 * devem depender daqui e nunca o contrário.
 */
export * from './permissions.js';
// A memória do bot passa pela fachada: igual ao store no processo único; pedido ao cérebro com YUI_CEREBRO_EXTERNO=true.
export * as memory from './memory/facade.js';
export { initMemory } from './memory/store.js';
export { audit } from './audit.js';
export { buildPersonaPrompt, resolvePersonaId, applyPersona } from './persona.js';
export * as ai from './ai/manager.js';
export { runAgent, resolvePending } from './agent/agent.js';
export { registerTool } from './agent/tools.js';
