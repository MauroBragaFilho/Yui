import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Limites para não estourar o contexto da IA (principalmente em modelos
// locais rodando no LM Studio, que costumam ter janelas de contexto menores).
const MAX_CHARS_PER_FILE = 6000;
const MAX_TOTAL_CHARS = 18000;
const CACHE_TTL_MS = 60 * 1000; // recarrega a cada 1 minuto, sem precisar reiniciar o bot

let cache = { content: '', loadedAt: 0, fileCount: 0 };

function readKnowledgeFiles(dir) {
  if (!fs.existsSync(dir)) {
    return { content: '', fileCount: 0 };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'))
    .filter((f) => f.toLowerCase() !== 'readme.md')
    .sort();

  if (files.length === 0) {
    return { content: '', fileCount: 0 };
  }

  const parts = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      logger.warn(
        `[KnowledgeBase] Limite total de contexto atingido — arquivo "${file}" e seguintes foram ignorados desta vez.`
      );
      break;
    }

    const fullPath = path.join(dir, file);
    let text;
    try {
      text = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      logger.warn(`[KnowledgeBase] Não foi possível ler "${file}": ${err.message}`);
      continue;
    }

    if (text.length > MAX_CHARS_PER_FILE) {
      text = `${text.slice(0, MAX_CHARS_PER_FILE)}\n[...conteúdo truncado, arquivo muito grande...]`;
    }

    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n[...conteúdo truncado...]`;
    }

    parts.push(`### Arquivo: ${file}\n${text.trim()}`);
    totalChars += text.length;
  }

  return { content: parts.join('\n\n---\n\n'), fileCount: files.length };
}

/**
 * Retorna o conteúdo combinado de todos os arquivos .txt/.md da pasta de
 * conhecimento, com cache de 1 minuto (para não reler o disco a cada
 * pergunta, mas ainda pegar atualizações sem precisar reiniciar o bot).
 */
export function getKnowledgeContext(knowledgeDir) {
  const now = Date.now();
  if (now - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }

  const { content, fileCount } = readKnowledgeFiles(knowledgeDir);
  cache = { content, loadedAt: now, fileCount };
  return cache;
}
