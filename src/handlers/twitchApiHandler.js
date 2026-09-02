import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_HELIX_BASE = 'https://api.twitch.tv/helix';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Obtém (e cacheia) o App Access Token da Twitch usando OAuth
 * Client Credentials. Renova automaticamente antes de expirar.
 *
 * @returns {Promise<string>} access_token
 */
async function getAppAccessToken() {
  const { clientId, clientSecret } = config.twitch;

  if (!clientId || !clientSecret) {
    logger.warn('[TwitchAPI] TWITCH_CLIENT_ID/CLIENT_SECRET não configurados. Pulando checagem.');
    return null;
  }

  // Token válido obedece a margem de segurança de 60s
  if (cachedToken && Date.now() < (cachedTokenExpiresAt - 60 * 1000)) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch token error ${response.status}: ${body}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Consulta o status de streams de vários logins em UMA chamada só.
 *
 * @param {string[]} logins — array de logins da Twitch
 * @returns {Promise<Map<string, object|null>>} Map de login -> stream info (ou null se offline)
 */
export async function getStreamStatus(logins) {
  if (!logins || logins.length === 0) return new Map();

  const token = await getAppAccessToken();
  if (!token) return new Map();

  const { clientId } = config.twitch;

  // A Helix aceita até 100 logins por chamada
  const params = new URLSearchParams();
  for (const login of logins) {
    params.append('user_login', login);
  }

  const url = `${TWITCH_HELIX_BASE}/streams?${params}`;

  const response = await fetch(url, {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch streams error ${response.status}: ${body}`);
  }

  const data = await response.json();

  const result = new Map();
  // Inicializa todos como offline (null)
  for (const login of logins) {
    result.set(login.toLowerCase(), null);
  }

  for (const stream of data.data || []) {
    result.set(stream.user_login.toLowerCase(), {
      login: stream.user_login,
      streamId: stream.id,
      title: stream.title,
      gameName: stream.game_name,
      thumbnailUrl: stream.thumbnail_url,
      startedAt: stream.started_at,
      viewerCount: stream.viewer_count,
      language: stream.language,
    });
  }

  return result;
}

/**
 * Busca informações de usuário da Twitch (para resolver login -> user_id).
 *
 * @param {string} login — login exato do canal
 * @returns {Promise<{id: string, login: string, displayName: string}|null>}
 */
export async function getTwitchUser(login) {
  const token = await getAppAccessToken();
  if (!token) return null;

  const { clientId } = config.twitch;

  const params = new URLSearchParams({ login });
  const url = `${TWITCH_HELIX_BASE}/users?${params}`;

  const response = await fetch(url, {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch users error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const user = data.data?.[0];
  if (!user) return null;

  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
  };
}