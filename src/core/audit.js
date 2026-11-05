import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { alertOwner } from './alerts.js';
import { redact } from './api/panelLogs.js';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
let lastAuditErrorAlertTime = 0;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/** Caminho do arquivo de auditoria (YUI_AUDIT_FILE permite trocar; usado nos testes). */
export function auditFilePath() {
  return process.env.YUI_AUDIT_FILE || path.resolve('logs', 'core-audit.jsonl');
}

/**
 * Calcula o hash canônico SHA-256 de uma linha de auditoria.
 * O hash cobre os metadados do evento ordenados de forma determinística, incluindo seq e prev_hash.
 */
export function computeEntryHash(entry) {
  // Cria cópia omitindo o próprio campo hash se já existir
  const copy = { ...entry };
  delete copy.hash;

  // Ordena as chaves para garantir serialização canônica
  const sortedKeys = Object.keys(copy).sort();
  const canonicalObj = {};
  for (const k of sortedKeys) {
    canonicalObj[k] = copy[k];
  }
  const payload = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Lê o estado do último registro do arquivo de auditoria (para encadeamento).
 * @param {string} file
 * @returns {{ lastSeq: number, lastHash: string }}
 */
export function getLastAuditState(file = auditFilePath()) {
  try {
    if (!fs.existsSync(file)) {
      return { lastSeq: 0, lastHash: GENESIS_HASH };
    }
    const stat = fs.statSync(file);
    if (stat.size === 0) {
      return { lastSeq: 0, lastHash: GENESIS_HASH };
    }

    // Lê até os últimos 64KB para encontrar a última linha válida
    const fd = fs.openSync(file, 'r');
    const readSize = Math.min(stat.size, 64 * 1024);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (typeof parsed.seq === 'number' && parsed.hash) {
          return { lastSeq: parsed.seq, lastHash: parsed.hash };
        }
      } catch {
        // Ignora linha incompleta
      }
    }
    return { lastSeq: 0, lastHash: GENESIS_HASH };
  } catch {
    return { lastSeq: 0, lastHash: GENESIS_HASH };
  }
}

/**
 * Sanitiza campos de detalhes para garantir que nenhuma senha, token ou conteúdo confidencial
 * seja gravado na auditoria. Redacta strings sensíveis.
 */
function sanitizeDetails(details, env = process.env) {
  if (!details || typeof details !== 'object') return {};
  const cleaned = {};
  for (const [k, v] of Object.entries(details)) {
    // Proíbe expressamente chaves que contenham conteúdo cru ou senhas
    if (['password', 'token', 'secret', 'key', 'apiKey', 'memoryContent', 'content'].includes(k)) {
      continue;
    }
    if (typeof v === 'string') {
      cleaned[k] = redact(v, env);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      cleaned[k] = sanitizeDetails(v, env);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

/**
 * Registro de auditoria append-only com hash encadeado (seq, prev_hash, hash).
 * Mantém compatibilidade de leitura com linhas antigas sem hash.
 * Falhas de gravação disparam alerta ao dono via alerts.js.
 */
export function audit(event, ctx, details = {}, { env = process.env, throwOnError = false } = {}) {
  try {
    const file = auditFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Verifica rotação se o arquivo de auditoria exceder tamanho configurável (padrão 10MB)
    rotateAuditIfNeeded(file, env);

    const { lastSeq, lastHash } = getLastAuditState(file);
    const seq = lastSeq + 1;
    const prev_hash = lastHash;

    const sanitized = sanitizeDetails(details, env);

    const entry = {
      seq,
      prev_hash,
      ts: new Date().toISOString(),
      event,
      userId: ctx?.userId ?? null,
      role: ctx?.role ?? null,
      platform: ctx?.platform ?? null,
      channelKind: ctx?.channelKind ?? null,
      ...sanitized,
    };

    entry.hash = computeEntryHash(entry);

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(file, line);
    return entry;
  } catch (err) {
    const now = Date.now();
    if (now - lastAuditErrorAlertTime > ALERT_COOLDOWN_MS) {
      lastAuditErrorAlertTime = now;
      try {
        alertOwner('audit.write.fail', 'Falha na gravação da auditoria', `Não foi possível registrar evento no arquivo de auditoria: ${err.message}`, { level: 'error' });
      } catch {}
    }
    if (throwOnError) throw err;
  }
}

/**
 * Rotação do log de auditoria quando excede o limite.
 * Preserva até N arquivos rotacionados (.1, .2, etc.).
 */
export function rotateAuditIfNeeded(file, env = process.env) {
  try {
    if (!fs.existsSync(file)) return;
    const maxBytes = parseInt(env.YUI_AUDIT_MAX_BYTES || `${10 * 1024 * 1024}`, 10);
    const stat = fs.statSync(file);
    if (stat.size < maxBytes) return;

    const maxKeep = parseInt(env.YUI_AUDIT_MAX_ROTATE || '5', 10);
    for (let i = maxKeep - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i + 1 > maxKeep) fs.unlinkSync(src);
        else fs.renameSync(src, dst);
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Rotação silenciosa para não quebrar gravação
  }
}

/**
 * Valida a integridade da cadeia de auditoria.
 * Detecta:
 * - Linhas adulteradas (hash não confere)
 * - Linhas removidas ou truncadas (quebra na sequência de seq ou prev_hash)
 * - Linhas reordenadas
 * Tolera linhas legadas sem encadeamento (início do log antes da Fase 0).
 *
 * @param {string} [filePath]
 * @returns {{ ok: boolean, total: number, chained: number, errors: Array<{ line: number, reason: string }> }}
 */
export function verifyAudit(filePath = auditFilePath()) {
  if (!fs.existsSync(filePath)) {
    return { ok: true, total: 0, chained: 0, errors: [] };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

  let expectedSeq = null;
  let expectedPrevHash = GENESIS_HASH;
  let chainedCount = 0;
  const errors = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    let parsed;
    try {
      parsed = JSON.parse(lines[idx]);
    } catch (e) {
      errors.push({ line: lineNum, reason: `JSON inválido na linha ${lineNum}: ${e.message}` });
      continue;
    }

    // Suporte a linhas legadas: se não tiver seq/hash, apenas aceita
    if (parsed.seq === undefined && !parsed.hash) {
      continue;
    }

    chainedCount++;

    if (expectedSeq === null) {
      expectedSeq = parsed.seq;
      if (parsed.prev_hash && parsed.prev_hash !== GENESIS_HASH) {
        expectedPrevHash = parsed.prev_hash;
      }
    }

    // 1. Checagem de sequência
    if (parsed.seq !== expectedSeq) {
      errors.push({
        line: lineNum,
        reason: `Quebra de sequência na linha ${lineNum}: esperava seq ${expectedSeq}, obteve ${parsed.seq}`,
      });
    }

    // 2. Checagem de elo da cadeia (prev_hash)
    if (parsed.prev_hash !== expectedPrevHash) {
      errors.push({
        line: lineNum,
        reason: `Elo quebrado na linha ${lineNum}: esperava prev_hash ${expectedPrevHash}, obteve ${parsed.prev_hash}`,
      });
    }

    // 3. Checagem de hash da própria linha
    const computed = computeEntryHash(parsed);
    if (parsed.hash !== computed) {
      errors.push({
        line: lineNum,
        reason: `Hash adulterado na linha ${lineNum}: gravado ${parsed.hash}, calculado ${computed}`,
      });
    }

    expectedSeq = parsed.seq + 1;
    expectedPrevHash = parsed.hash;
  }

  return {
    ok: errors.length === 0,
    total: lines.length,
    chained: chainedCount,
    errors,
  };
}
