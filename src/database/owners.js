// DONO de cada banco (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §2 e §3).
//
// Com o cérebro separado do bot, cada banco tem UM processo dono, o único que o abre (para ler e escrever). Os outros
// pedem ao dono pelo canal local (src/core/channel). A chave é YUI_DB_OWNER_ROLE ('cerebro' ou 'bot'):
//  - SEM a variável (o padrão, processo único): nada muda; o db.js abre qualquer banco, como sempre;
//  - COM a variável: o db.js RECUSA abrir um banco de outro papel (código YUI_DB_NOT_OWNER) ou fora deste mapa, e, para os
//    bancos do próprio papel, pega a trava de dono (src/database/ownerLock.js) ANTES de abrir; se a trava estiver com outro
//    processo vivo, recusa (YUI_DB_OWNER_HELD / YUI_DB_OWNER_HUNG). Fechar o banco solta a trava.
//
// O motor do banco NÃO precisa ser o nativo (YUI_DB_NATIVE) para separar os processos: como cada banco tem um dono só, só um
// processo grava em cada arquivo, e o sql.js (que regrava o arquivo inteiro a cada escrita) também serve. O motor nativo
// (WAL) continua recomendado pelos outros motivos da etapa 2 (escrita incremental, sobrevive à morte do processo), mas não é
// exigido aqui. O que o sql.js NÃO aguenta é dois processos gravando o mesmo arquivo, e é justamente isso que a trava impede.
//
// Banco novo: acrescente aqui com o dono certo. Sem isso, um processo com YUI_DB_OWNER_ROLE definido recusa abri-lo
// (recusa por padrão: banco esquecido no mapa nunca vira banco com dois donos).

/** Papéis de processo que podem ser donos de banco. */
export const OWNER_ROLES = Object.freeze(['cerebro', 'bot']);

/** Banco -> papel dono. */
export const DB_OWNERS = Object.freeze({
  // YuiCerebro: a memória e o contexto por horas (privados; os outros pedem pelo canal: memory.*, context.*)
  'memory-personal': 'cerebro',
  'memory-discord': 'cerebro',
  'memory-context': 'cerebro',
  'memory-context-personal': 'cerebro',
  // YuiBot: canais, publicações e motores que publicam no Discord (o painel pede pelo canal: guild.*)
  core: 'bot',
  newswire: 'bot',
  'gta-diario': 'bot',
  'gta-semanal': 'bot',
  'social-youtube': 'bot',
  'social-twitch': 'bot',
});

export const NOT_OWNER = 'YUI_DB_NOT_OWNER';
export const BAD_ROLE = 'YUI_DB_BAD_ROLE';

/**
 * Papel deste processo (YUI_DB_OWNER_ROLE) ou null (sem a chave: processo único, nada muda).
 * Valor fora da lista lança erro (BAD_ROLE): melhor não subir do que subir sem saber de quem são os bancos.
 */
export function ownerRoleFromEnv(env = process.env) {
  const raw = String(env.YUI_DB_OWNER_ROLE ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!OWNER_ROLES.includes(raw)) {
    const err = new Error(`YUI_DB_OWNER_ROLE inválido: "${raw.slice(0, 20)}". Use ${OWNER_ROLES.join(' ou ')} (ou deixe vazio para o processo único).`);
    err.code = BAD_ROLE;
    throw err;
  }
  return raw;
}

/** Papel dono do banco `name` (null = banco fora do mapa). */
export function databaseOwner(name) {
  return Object.hasOwn(DB_OWNERS, name) ? DB_OWNERS[name] : null;
}

/** Bancos de um papel (para relatório e testes). */
export function databasesOf(role) {
  return Object.keys(DB_OWNERS).filter((name) => DB_OWNERS[name] === role);
}

/**
 * Confere se o processo de papel `role` pode abrir o banco `name`. Devolve null se pode; senão o erro (com código
 * NOT_OWNER) que o db.js lança. A mensagem não usa palavras como "corrompido" (o contexto manda para a quarentena só arquivo
 * com cara de corrompido) e diz o que fazer.
 */
export function ownershipError(name, role) {
  const owner = databaseOwner(name);
  if (owner === role) return null;
  const err = owner
    ? new Error(`O banco "${name}" pertence ao processo ${owner}; este processo é ${role}. Peça ao ${owner} pelo canal local em vez de abrir o arquivo.`)
    : new Error(`O banco "${name}" não está no mapa de donos (src/database/owners.js); com YUI_DB_OWNER_ROLE=${role} ele não é aberto. Acrescente o banco ao mapa com o dono certo.`);
  err.code = NOT_OWNER;
  err.database = name;
  err.owner = owner;
  err.role = role;
  return err;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const MIN_HEARTBEAT_MS = 100;
const MIN_STALE_MS = 500;

/**
 * Tempos da trava (batimento e prazo para considerar abandonada). Padrão 15 s e 60 s (docs §3). As variáveis
 * YUI_DB_OWNER_HEARTBEAT_MS e YUI_DB_OWNER_STALE_MS existem para os testes de ponta a ponta (processos de verdade com
 * prazos curtos); valores inválidos voltam ao padrão. O prazo é sempre maior que dois batimentos.
 */
export function ownerLockTiming(env = process.env) {
  const read = (name, fallback, min) => {
    const n = Number(String(env[name] ?? '').trim());
    return Number.isFinite(n) && n >= min ? Math.round(n) : fallback;
  };
  const heartbeatMs = read('YUI_DB_OWNER_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS, MIN_HEARTBEAT_MS);
  let staleMs = read('YUI_DB_OWNER_STALE_MS', DEFAULT_STALE_MS, MIN_STALE_MS);
  if (staleMs <= heartbeatMs * 2) staleMs = heartbeatMs * 4;
  return { heartbeatMs, staleMs };
}
