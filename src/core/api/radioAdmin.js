/**
 * Sessões do Modo Rádio para o painel: ver o que está tocando em cada servidor e
 * pausar/retomar, parar a música ou tirar a Yui da call. Pular faixa e escolher
 * música continuam no menu do próprio rádio (precisam de um canal de texto).
 */

export const RADIO_ACTIONS = ['pause', 'resume', 'stop', 'leave'];

/** Dependências reais do rádio (carregadas só quando usadas; os testes injetam fakes). */
export async function defaultRadioDeps() {
  const db = await import('../../music/radioDatabase.js');
  const player = await import('../../music/radioAudioPlayer.js');
  const manager = await import('../../music/radioManager.js');
  const { getVoiceConnection } = await import('@discordjs/voice');
  return {
    sessions: () => db.getAllSessions(),
    getSession: (g) => db.getSession(g),
    connected: (g) => Boolean(getVoiceConnection(g)),
    pause: (g) => player.pausePlayer(g),
    resume: (g) => player.resumePlayer(g),
    stopMusic: (g) => { player.stopPlayer(g); db.stopRadio(g); },
    leave: (g) => manager.leaveRadioCall(g, null),
  };
}

const track = (t) => (t ? { title: String(t.title ?? ''), artist: String(t.artist ?? ''), album: t.album ? String(t.album) : null } : null);

export async function listRadio(deps, guildName, voiceName) {
  const out = [];
  for (const s of deps.sessions()) {
    out.push({
      guildId: s.guildId,
      guildName: guildName(s.guildId),
      voiceChannel: voiceName(s.guildId, s.voiceChannelId),
      status: String(s.status ?? 'STOPPED'),
      connected: Boolean(deps.connected?.(s.guildId)),
      current: track(s.currentTrack),
      next: track(Array.isArray(s.queue) ? s.queue[0] : null),
      queueLength: Array.isArray(s.queue) ? s.queue.length : 0,
      position: Array.isArray(s.playlist) && s.currentIndex >= 0 ? `${s.currentIndex + 1}/${s.playlist.length}` : null,
      shuffle: Boolean(s.shuffle),
      loopMode: String(s.loopMode ?? 'OFF'),
      voiceMode: String(s.voiceMode ?? 'OFF'),
      streamMode: String(s.streamMode ?? ''),
    });
  }
  return out;
}
