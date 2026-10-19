import crypto from 'crypto';

/**
 * Login por usuário e senha para o painel/app da Yui.
 *
 * Fluxo: o app envia usuário e senha para POST /v1/auth/login; o servidor
 * confere com o que está no .env e devolve uma SESSÃO temporária (token
 * aleatório). O app guarda só a sessão, nunca a senha.
 *
 * .env:
 *   YUI_PANEL_USER=seu_usuario
 *   YUI_PANEL_PASSWORD_HASH=scrypt$...      (recomendado; gere com `npm run panel:password`)
 *   YUI_PANEL_PASSWORD=...                  (alternativa em texto; mínimo 10 caracteres)
 *   YUI_PANEL_USER_ID=...                   (opcional; por padrão é o dono: YUI_OWNER_ID/OWNER_ID)
 *   YUI_PANEL_SESSION_HOURS=12              (opcional)
 *
 * Proteções: comparação em tempo constante (usuário E senha são sempre
 * calculados), mensagem de erro genérica, atraso nas falhas e bloqueio global
 * temporário após muitas tentativas erradas.
 */

export const MIN_PLAIN_PASSWORD = 10;
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// ───────────────────────── Hash de senha (scrypt) ─────────────────────────

/** Gera "scrypt$N$salt$hash" (base64). */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Confere a senha contra um hash gerado por hashPassword (tempo constante). */
export function verifyPasswordHash(password, stored) {
  try {
    const [scheme, n, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ───────────────────────── Dono (alvo do login e da chave por DM) ─────────────────────────

/** ID do Discord do dono: YUI_PANEL_USER_ID, YUI_OWNER_ID, OWNER_ID ou o primeiro de OWNER_IDS. */
export function ownerUserId(env = process.env) {
  const firstOwner = String(env.OWNER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return String(env.YUI_PANEL_USER_ID || env.YUI_OWNER_ID || env.OWNER_ID || firstOwner || '').trim() || null;
}

// ───────────────────────── Credenciais do painel ─────────────────────────

/**
 * Lê as credenciais do ambiente.
 * @returns {{ enabled: boolean, userId: string|null, warnings: string[], reasons: string[], check: (user:string, pass:string) => boolean }}
 */
export function loadPanelCredentials(env = process.env) {
  const user = String(env.YUI_PANEL_USER || '').trim();
  const hash = String(env.YUI_PANEL_PASSWORD_HASH || '').trim();
  const plain = String(env.YUI_PANEL_PASSWORD || '');
  const warnings = [];
  const reasons = [];

  const userId = ownerUserId(env);

  if (!user && !hash && !plain) return { enabled: false, userId, warnings, reasons: [], check: () => false };

  if (!user) reasons.push('YUI_PANEL_USER não definido');
  if (!hash && !plain) reasons.push('defina YUI_PANEL_PASSWORD_HASH (ou YUI_PANEL_PASSWORD)');
  if (!hash && plain && plain.length < MIN_PLAIN_PASSWORD) reasons.push(`YUI_PANEL_PASSWORD precisa de pelo menos ${MIN_PLAIN_PASSWORD} caracteres`);
  if (!userId) reasons.push('sem ID de dono (YUI_OWNER_ID/OWNER_ID) para vincular o login');
  if (reasons.length) return { enabled: false, userId, warnings, reasons, check: () => false };

  if (!hash) warnings.push('Senha em texto no .env: prefira YUI_PANEL_PASSWORD_HASH (npm run panel:password).');

  const userDigest = sha(user);
  const plainDigest = plain ? sha(plain) : null;

  /** Sempre calcula usuário E senha, sem curto-circuito. */
  function check(givenUser, givenPass) {
    const userOk = crypto.timingSafeEqual(sha(givenUser ?? ''), userDigest);
    const passOk = hash
      ? verifyPasswordHash(givenPass ?? '', hash)
      : crypto.timingSafeEqual(sha(givenPass ?? ''), plainDigest);
    return userOk && passOk;
  }

  return { enabled: true, userId, warnings, reasons: [], check };
}

// ───────────────────────── Sessões ─────────────────────────

const MAX_SESSIONS = 20;

/** Sessões em memória (somem ao reiniciar a Yui; é preciso entrar de novo). */
export function createSessionStore({ ttlMs = 12 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const sessions = new Map(); // sha256(token) em hex -> { userId, expiresAt, createdAt }
  const key = (token) => sha(token).toString('hex');

  function purge() {
    const t = now();
    for (const [k, s] of sessions) if (s.expiresAt <= t) sessions.delete(k);
  }

  return {
    create(userId) {
      purge();
      // limita o número de sessões: descarta as mais antigas
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + ttlMs;
      sessions.set(key(token), { userId: String(userId), expiresAt, createdAt: now() });
      return { token, expiresAt };
    },
    get(token) {
      if (!token) return null;
      const s = sessions.get(key(token));
      if (!s) return null;
      if (s.expiresAt <= now()) { sessions.delete(key(token)); return null; }
      return s;
    },
    revoke(token) {
      return sessions.delete(key(token));
    },
    clear() {
      sessions.clear();
    },
    size() {
      purge();
      return sessions.size;
    },
  };
}

// ───────────────────────── Limite de tentativas ─────────────────────────

/**
 * Bloqueio GLOBAL do login por senha após `max` falhas dentro da janela.
 * (Atrás do Tailscale Serve todas as requisições chegam de 127.0.0.1, então
 * um limite por IP não funcionaria; para um painel de um só dono, o global
 * é o certo.)
 */
export function createLoginLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  let failures = [];
  return {
    /** Segundos até poder tentar de novo, ou 0 se liberado. */
    lockedForSeconds() {
      const t = now();
      failures = failures.filter((f) => t - f < windowMs);
      if (failures.length < max) return 0;
      return Math.max(1, Math.ceil((failures[0] + windowMs - t) / 1000));
    },
    fail() {
      failures.push(now());
    },
    reset() {
      failures = [];
    },
    count() {
      const t = now();
      failures = failures.filter((f) => t - f < windowMs);
      return failures.length;
    },
  };
}


// ───────────────────────── Chave de uso único (enviada por DM no Discord) ─────────────────────────

// Alfabeto sem caracteres que se confundem (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10; // 31^10 ≈ 8e14 combinações
const MAX_WRONG_PER_CODE = 5;

/** Remove espaços, traços e converte para maiúsculas (aceita "abcde-fghij"). */
export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "ABCDEFGHJK" -> "ABCDE-FGHJK" (mais fácil de ler e digitar). */
export function formatCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Chave de pareamento: UMA ativa por vez (pedir outra invalida a anterior),
 * validade curta, uso único e invalidada após poucos erros. Só o hash fica
 * em memória.
 */
export function createPairing({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let active = null; // { hash, expiresAt, wrong }

  return {
    /** Gera uma chave nova (substitui a anterior). Retorna o texto formatado. */
    issue() {
      let code = '';
      const bytes = crypto.randomBytes(CODE_LENGTH);
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      active = { hash: sha(code), expiresAt: now() + ttlMs, wrong: 0 };
      return { code: formatCode(code), expiresAt: active.expiresAt, expiresInSeconds: Math.round(ttlMs / 1000) };
    },
    /** Confere e CONSOME a chave. Erros repetidos a invalidam. */
    verify(input) {
      if (!active) return false;
      if (active.expiresAt <= now()) { active = null; return false; }
      const given = normalizeCode(input);
      const ok = given.length === CODE_LENGTH && crypto.timingSafeEqual(sha(given), active.hash);
      if (ok) { active = null; return true; }
      active.wrong += 1;
      if (active.wrong >= MAX_WRONG_PER_CODE) active = null;
      return false;
    },
    /** Descarta a chave ativa (ex.: se o envio da DM falhou). */
    revoke() {
      active = null;
    },
    hasActive() {
      if (active && active.expiresAt <= now()) active = null;
      return Boolean(active);
    },
  };
}
