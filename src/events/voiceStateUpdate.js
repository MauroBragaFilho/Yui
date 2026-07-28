const { handleVoiceStateUpdate } = require('../handlers/voiceHandler');

module.exports = {
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
