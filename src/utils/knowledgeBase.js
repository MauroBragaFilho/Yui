import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Limites para não estourar o contexto da IA (principalmente em modelos
// locais rodando no LM Studio, que costumam ter janelas de contexto menores).
const MAX_CHARS_PER_FILE = 6000;
const MAX_TOTAL_CHARS = 18000;
const CACHE_TTL_MS = 60 * 1000; // recarrega a cada 1 minuto, sem precisar reiniciar o bot

const caches = new Map();

// Arquivos de regras/dicas específicas de GTA só entram quando a pergunta é sobre GTA
// (economiza tokens e evita puxar o assunto em conversas sobre outros jogos).
const GTA_FILE = /regras_ia|gta/i;

/** GTA pelo caminho ou pelo título (1ª linha) do arquivo. */
function isGtaFile(file) {
  if (GTA_FILE.test(file.rel)) return true;
  try {
    return GTA_FILE.test(fs.readFileSync(file.rel, 'utf8').slice(0, 200).split('\n')[0]);
  } catch {
    return false;
  }
}

function readKnowledgeFiles(dir, { gta = true } = {}) {
  if (!fs.existsSync(dir)) {
    return { content: '', fileCount: 0 };
  }

  // Coleta arquivos .md/.txt da raiz e também de subpastas (exceto GTA_Online,
  // que possui regra própria de escopo na Knowledge Base e é gerenciado à parte).
  const EXCLUDED_SUBDIRS = new Set(['gta_online']);
  const collected = [];

  function walk(currentDir, depth) {
    if (depth > 3) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_SUBDIRS.has(name.toLowerCase())) continue;
        walk(path.join(currentDir, name), depth + 1);
      } else if (entry.isFile()) {
        const lower = name.toLowerCase();
        const isDoc = lower.endsWith('.txt') || lower.endsWith('.md');
        const isReadme = lower === 'readme.md';
        if (isDoc && !isReadme) {
          collected.push({ rel: path.join(currentDir, name), name });
        }
      }
    }
  }

  walk(dir, 0);
  collected.sort((a, b) => a.rel.localeCompare(b.rel, 'pt-BR'));

  const files = gta ? collected : collected.filter((f) => !isGtaFile(f));

  if (files.length === 0) {
    return { content: '', fileCount: 0 };
  }

  const parts = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      logger.warn(
        `[KnowledgeBase] Limite total de contexto atingido — arquivo "${file.name}" e seguintes foram ignorados desta vez.`
      );
      break;
    }

    const fullPath = file.rel;
    let text;
    try {
      text = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      logger.warn(`[KnowledgeBase] Não foi possível ler "${file.name}": ${err.message}`);
      continue;
    }

    if (text.length > MAX_CHARS_PER_FILE) {
      text = `${text.slice(0, MAX_CHARS_PER_FILE)}\n[...conteúdo truncado, arquivo muito grande...]`;
    }

    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n[...conteúdo truncado...]`;
    }

    parts.push(`### Arquivo: ${file.rel}\n${text.trim()}`);
    totalChars += text.length;
  }

  return { content: parts.join('\n\n---\n\n'), fileCount: files.length };
}

/**
 * Retorna o conteúdo combinado de todos os arquivos .txt/.md da pasta de
 * conhecimento, com cache de 1 minuto (para não reler o disco a cada
 * pergunta, mas ainda pegar atualizações sem precisar reiniciar o bot).
 */
export function getKnowledgeContext(knowledgeDir, { gta = true } = {}) {
  const key = `${knowledgeDir}|${gta}`;
  const now = Date.now();
  const hit = caches.get(key);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) {
    return hit;
  }

  const { content, fileCount } = readKnowledgeFiles(knowledgeDir, { gta });
  const entry = { content, loadedAt: now, fileCount };
  caches.set(key, entry);
  return entry;
}
