// Chave do cérebro separado no BOT (etapa 3): YUI_CEREBRO_EXTERNO=true. Sem ela (o padrão), o bot roda tudo num processo só,
// exatamente como antes, e nada daqui muda o ambiente.
//
// Com a chave, antes de abrir qualquer banco:
//  - YUI_DB_OWNER_ROLE=bot: o bot só abre os bancos dele (core, newswire, GTA, sociais), com a trava de dono;
//  - auditoria no arquivo do bot (YUI_AUDIT_FILE_BOT, ou core-audit-bot.jsonl na mesma pasta do arquivo principal): o cérebro
//    grava o principal e a corrente de hashes de cada arquivo nunca é dividida entre dois processos;
//  - o contexto por horas (YUI_CONTEXT_ENABLED=true) é do cérebro (etapa 5): a conversa vira um turno do cérebro (chat.turn) e o bot nunca
//    lê nem grava as falas; por isso a chave funciona igual nos dois modos (até a etapa 4 o bot se recusava a subir com ela).
import path from 'node:path';

export const BOT_ROLE = 'bot';

export function cerebroExterno(env = process.env) {
  return String(env.YUI_CEREBRO_EXTERNO ?? '').trim().toLowerCase() === 'true';
}

/** Arquivo de auditoria do bot separado. */
export function botAuditFile(env = process.env) {
  const own = String(env.YUI_AUDIT_FILE_BOT ?? '').trim();
  if (own) return path.resolve(own);
  const main = String(env.YUI_AUDIT_FILE ?? '').trim() || path.join('logs', 'core-audit.jsonl');
  return path.join(path.dirname(path.resolve(main)), 'core-audit-bot.jsonl');
}

/**
 * Prepara o ambiente do bot separado. Lança erro (com código) se a configuração não serve; quem chama encerra a subida.
 * @returns {{ auditFile: string }}
 */
export function prepareSeparatedBot(env = process.env) {
  const role = String(env.YUI_DB_OWNER_ROLE ?? '').trim().toLowerCase();
  if (role && role !== BOT_ROLE) {
    throw Object.assign(new Error(`YUI_DB_OWNER_ROLE=${role} no ambiente, mas este é o bot com o cérebro separado. Tire a variável do .env (cada processo define o próprio papel).`), { code: 'YUI_BOT_PAPEL' });
  }
  const auditFile = botAuditFile(env);
  env.YUI_DB_OWNER_ROLE = BOT_ROLE;
  env.YUI_AUDIT_FILE = auditFile;
  return { auditFile };
}
