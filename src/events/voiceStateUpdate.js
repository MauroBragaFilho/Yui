import { handleVoiceStateUpdate } from '../handlers/voiceHandler.js';

export default {
    name: 'voiceStateUpdate',
    once: false,
    async execute(oldState, newState) {
        try {
            await handleVoiceStateUpdate(oldState, newState);
        } catch (error) {
            console.error('[voiceStateUpdate] Erro:', error);
        }
    }
};
