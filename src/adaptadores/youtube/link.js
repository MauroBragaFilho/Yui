// O LINK DA LIVE e QUEM PODE MANDÁ-LO (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §7.1 e §7.4; docs/CANAIS_NOVOS.md §3). PURO, sem rede.
//
// Só o dono manda o link, e só pelo Discord ou pelo app. O chat da própria live nunca manda (nem quando a mensagem é do dono: todo mundo ali é público).
// O programa do PC também fica de fora desta etapa ("só por Discord ou app").

export const ID_DO_VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
/** Os canais pelos quais o dono pode mandar a Yui entrar ou sair de uma live. */
export const CANAIS_QUE_COMANDAM = Object.freeze(['discord_dm', 'discord_guild', 'app']);
const HOSTS_DO_YOUTUBE = new Set(['youtube.com', 'm.youtube.com', 'www.youtube.com']);
const HOST_CURTO = 'youtu.be';
const LINK_MAX = 300;

/**
 * Tira o id do vídeo de um link de live (watch?v=, /live/, /embed/ ou youtu.be). Recusa qualquer outro endereço, com usuário/senha ou porta.
 * @returns {{ ok: true, videoId: string } | { ok: false, codigo: 'link-invalido'|'host-nao-permitido'|'sem-video' }}
 */
export function extrairIdDoVideo(link) {
  const texto = String(link ?? '').trim();
  if (!texto || texto.length > LINK_MAX || /[\s\u0000-\u001f]/.test(texto)) return { ok: false, codigo: 'link-invalido' };
  let url;
  try { url = new URL(texto); } catch { return { ok: false, codigo: 'link-invalido' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, codigo: 'link-invalido' };
  if (url.username || url.password || url.port) return { ok: false, codigo: 'host-nao-permitido' };
  const host = url.hostname.toLowerCase();
  let id = null;
  if (HOSTS_DO_YOUTUBE.has(host)) {
    const partes = url.pathname.split('/').filter(Boolean);
    if (partes[0] === 'watch') id = url.searchParams.get('v');
    else if ((partes[0] === 'live' || partes[0] === 'embed') && partes.length === 2) id = partes[1];
    else return { ok: false, codigo: 'sem-video' };
  } else if (host === HOST_CURTO) {
    const partes = url.pathname.split('/').filter(Boolean);
    if (partes.length !== 1) return { ok: false, codigo: 'sem-video' };
    id = partes[0];
  } else {
    return { ok: false, codigo: 'host-nao-permitido' };
  }
  if (!id || !ID_DO_VIDEO_RE.test(id)) return { ok: false, codigo: 'sem-video' };
  return { ok: true, videoId: id };
}

/**
 * Quem pode mandar a Yui entrar, sair ou ficar quieta numa live: o DONO (papel decidido pelo cérebro, nunca pelo texto) pelo Discord ou pelo app.
 * @param {{ canal: string, papel: string }} quem
 * @returns {{ ok: true } | { ok: false, codigo: 'nao-e-o-dono'|'canal-nao-permitido' }}
 */
export function podeComandarALive({ canal, papel } = {}) {
  if (papel !== 'dono') return { ok: false, codigo: 'nao-e-o-dono' };
  if (!CANAIS_QUE_COMANDAM.includes(canal)) return { ok: false, codigo: 'canal-nao-permitido' };
  return { ok: true };
}
