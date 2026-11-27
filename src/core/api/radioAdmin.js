/**
 * Sessões do Modo Rádio para o painel: ver o que está tocando em cada servidor (a faixa atual e as próximas) e
 * pausar/retomar, parar a música ou tirar a Yui da call.
 * Lacunas do painel, item 10 (entrega E, parte 2): iniciar o rádio SEM ninguém na call (o canal de voz e o de texto
 * escolhidos no painel, entre os do servidor em que a Yui pode entrar e falar / escrever), pular, tocar um gênero ou
 * uma música (com as opções para escolher quando a busca é ambígua) e ver a fila. Tudo pelas MESMAS funções do rádio
 * do Discord (src/music/radioManager.js: startRadioMode, a fila do pedido por voz/conversa, nextTrack + playTrack, resolveInput).
 */

/** As ações sobre uma sessão que já existe (as do começo). */
export const RADIO_CONTROLES = Object.freeze(['pause', 'resume', 'stop', 'leave']);
/** Todas as ações de POST /v1/admin/radio/:guildId (as do item 10: pular, iniciar, tocar e escolher uma opção). */
export const RADIO_ACTIONS = Object.freeze([...RADIO_CONTROLES, 'skip', 'start', 'play', 'choose']);
/** Iniciado pelo painel, o rádio espera alguém entrar na call por este tempo antes de sair sozinho do canal vazio. */
export const RADIO_ESPERA_SEM_NINGUEM_MS = 10 * 60_000;
/** As opções de uma busca ambígua valem por este tempo (depois, "busque de novo"). */
export const RADIO_ESCOLHA_MS = 5 * 60_000;
export const MAX_OPCOES_DO_RADIO = 10;
export const MAX_PROXIMAS = 10;
const MAX_CANAIS = 100;

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
    // Item 10: as MESMAS funções do rádio do Discord. Iniciar num canal escolhido (o miolo do /modo-radio), buscar (resolveInput), pôr na fila e tocar
    // se estiver parado (a fila do pedido por voz/conversa) e pular (nextTrack + playTrack).
    start: (voiceChannel, textChannel, client) => manager.startRadioInChannel(voiceChannel, textChannel, client, { esperaSemNinguemMs: RADIO_ESPERA_SEM_NINGUEM_MS }),
    resolve: (query, guildId) => manager.resolveRadioInput(query, guildId),
    enqueue: (guildId, result, userId, client) => manager.enqueueRadioResult(guildId, result, userId, null, client),
    skip: (guildId, client) => manager.skipRadioTrack(guildId, client),
  };
}

const track = (t) => (t ? { title: String(t.title ?? ''), artist: String(t.artist ?? ''), album: t.album ? String(t.album) : null } : null);
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/g;
const curto = (v, max) => String(v ?? '').replace(CONTROLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Duração em segundos (inteiro de 0 a 24 h); o resto, null. */
export function duracaoDaFaixa(v) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 86_400 ? Math.round(n) : null;
}
/** Uma faixa para o painel: só título, artista e duração (nunca o link, a capa nem quem pediu). */
export function faixaCurta(t) {
  return t && typeof t === 'object' ? { title: curto(t.title, 120), artist: curto(t.artist, 80), duration: duracaoDaFaixa(t.duration) } : null;
}
/** As opções de uma busca ambígua, na mesma ordem (o painel devolve só o NÚMERO da escolhida). */
export const opcoesDoRadio = (results) => (Array.isArray(results) ? results.slice(0, MAX_OPCOES_DO_RADIO).map(faixaCurta).filter(Boolean) : []);

/** A busca digitada no painel (gênero, música ou link): 2 a 200 caracteres, sem caractere de controle; senão, null. Nunca vai para a auditoria. */
export function buscaDoRadio(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 2 && s.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(s) ? s : null;
}

// Tipos de canal do Discord (ChannelType): 2 = voz (o palco, 13, fica de fora: lá a Yui entra como ouvinte e não toca), 0 = texto e 5 = anúncios.
const TIPO_VOZ = 2;
const TIPOS_TEXTO = Object.freeze([0, 5]);
const PERMS_VOZ = Object.freeze(['ViewChannel', 'Connect', 'Speak']);
const PERMS_TEXTO = Object.freeze(['ViewChannel', 'SendMessages', 'EmbedLinks']);

function pode(canal, eu, perms) {
  try {
    const p = canal?.permissionsFor?.(eu);
    return Boolean(p && typeof p.has === 'function' && p.has([...perms]));
  } catch {
    return false;
  }
}
function pessoasNaCall(canal) {
  const ms = canal?.members;
  if (!ms || typeof ms.values !== 'function') return 0;
  let n = 0;
  for (const m of ms.values()) if (!m?.user?.bot) n += 1;
  return n;
}

/**
 * Os canais do servidor para iniciar o rádio: os de VOZ (com quantas pessoas estão neles e se a Yui pode entrar e falar; cheio sem "Mover membros" não
 * dá) e os de TEXTO (se ela pode escrever com embeds, onde fica o painel do rádio). Só canais DESTE servidor, conferidos pelo id do servidor de cada um.
 * @returns {{ voz: {id: string, nome: string, pessoas: number, pode: boolean, motivo: 'sem-permissao'|'cheio'|null}[], texto: {id: string, nome: string, pode: boolean, motivo: 'sem-permissao'|null}[] }}
 */
export function canaisDoRadio(guild) {
  const gid = String(guild?.id ?? '');
  const eu = guild?.members?.me ?? guild?.client?.user?.id ?? null;
  const todos = guild?.channels?.cache && typeof guild.channels.cache.values === 'function' ? [...guild.channels.cache.values()] : [];
  const deste = todos.filter((c) => c && gid && String(c.guildId ?? c.guild?.id ?? '') === gid);
  const ordem = (a, b) => (Number(a.rawPosition ?? a.position ?? 0) - Number(b.rawPosition ?? b.position ?? 0)) || String(a.name ?? '').localeCompare(String(b.name ?? ''));
  const voz = deste.filter((c) => c.type === TIPO_VOZ).sort(ordem).slice(0, MAX_CANAIS).map((c) => {
    const entra = pode(c, eu, PERMS_VOZ);
    const cheio = entra && c.full === true && !pode(c, eu, ['MoveMembers']);
    return { id: String(c.id), nome: curto(c.name, 60), pessoas: pessoasNaCall(c), pode: entra && !cheio, motivo: !entra ? 'sem-permissao' : cheio ? 'cheio' : null };
  });
  const texto = deste.filter((c) => TIPOS_TEXTO.includes(c.type)).sort(ordem).slice(0, MAX_CANAIS).map((c) => {
    const escreve = pode(c, eu, PERMS_TEXTO);
    return { id: String(c.id), nome: curto(c.name, 60), pode: escreve, motivo: escreve ? null : 'sem-permissao' };
  });
  return { voz, texto };
}

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
      // A fila (item 10): as próximas faixas, só título e duração.
      upcoming: Array.isArray(s.queue) ? s.queue.slice(0, MAX_PROXIMAS).map((t) => ({ title: curto(t?.title, 120), duration: duracaoDaFaixa(t?.duration) })) : [],
      position: Array.isArray(s.playlist) && s.currentIndex >= 0 ? `${s.currentIndex + 1}/${s.playlist.length}` : null,
      shuffle: Boolean(s.shuffle),
      loopMode: String(s.loopMode ?? 'OFF'),
      voiceMode: String(s.voiceMode ?? 'OFF'),
      streamMode: String(s.streamMode ?? ''),
    });
  }
  return out;
}
