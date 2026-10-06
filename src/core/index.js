/**
 * Yui Core — ponto único de entrada. Adaptadores (Discord, API, apps)
 * devem depender daqui e nunca o contrário.
 */
export * from './permissions.js';
export * as memory from './memory/store.js';
export { initMemory } from './memory/store.js';
export { audit } from './audit.js';
export { buildPersonaPrompt, resolvePersonaId, applyPersona } from './persona.js';
export * as ai from './ai/manager.js';
export { runAgent, resolvePending } from './agent/agent.js';
export { registerTool } from './agent/tools.js';
