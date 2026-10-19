import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Busca no código do projeto: palavras (BM25) + reordenação opcional por embeddings.
 *
 * Correções em relação ao Jarvis (code-indexer + embedding-service):
 *  - lá a busca só funcionava com modelo de embeddings carregado: se a primeira
 *    chamada falhava, o modo "fallback" ficava ligado para sempre e nunca mais
 *    buscava. Aqui a busca por palavras sempre funciona e os embeddings só melhoram
 *    o resultado quando disponíveis (e voltam a ser tentados depois de um tempo);
 *  - indexação incremental (só arquivos novos/alterados), em vez de refazer o
 *    projeto inteiro com uma chamada de rede por pedaço;
 *  - pedaços por LINHAS, então o resultado informa arquivo e linhas;
 *  - embeddings só dos candidatos da busca (poucos), em lote e com cache.
 */

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 6;
const EMBED_RETRY_MS = 5 * 60 * 1000;

const tokenize = (text) =>
  String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]{2,}/gu) || [];

function chunkFile(content) {
  const lines = content.split('\n');
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    const text = slice.join('\n');
    if (text.trim()) chunks.push({ start: start + 1, end: start + slice.length, text });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

function termFrequencies(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * @param {{ workspaceFs: object, cacheFile?: string, embed?: (texts: string[]) => Promise<number[][]|null>, now?: () => number }} options
 */
function createIndexer({ workspaceFs, cacheFile = null, embed = null, now = () => Date.now() }) {
  /** @type {Map<string, {mtimeMs: number, size: number, chunks: Array}>} */
  const files = new Map();
  const vectors = new Map(); // hash do trecho -> vetor
  let embedDisabledUntil = 0;
  let loaded = false;
  let refreshing = null;

  async function loadCache() {
    if (loaded || !cacheFile) return;
    loaded = true;
    try {
      const data = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      for (const [p, entry] of Object.entries(data.files || {})) files.set(p, entry);
    } catch {
      /* sem cache: começa do zero */
    }
  }

  async function saveCache() {
    if (!cacheFile) return;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      const obj = { version: 1, files: Object.fromEntries(files) };
      const temp = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(obj), 'utf8');
      await fs.rename(temp, cacheFile);
    } catch {
      /* cache é só otimização */
    }
  }

  /** Atualiza o índice: lê só o que mudou. Chamadas simultâneas compartilham o mesmo trabalho. */
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await loadCache();
      const current = await workspaceFs.listCodeFiles();
      const seen = new Set();
      let changed = false;
      for (const f of current) {
        seen.add(f.path);
        const old = files.get(f.path);
        if (old && old.mtimeMs === f.mtimeMs && old.size === f.size) continue;
        try {
          const { content } = await workspaceFs.readFile(f.path);
          const chunks = chunkFile(content).map((c) => ({ ...c, tf: termFrequencies(tokenize(`${f.path}\n${c.text}`)), len: 0 }));
          chunks.forEach((c) => { c.len = Object.values(c.tf).reduce((a, b) => a + b, 0); });
          files.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, chunks });
          changed = true;
        } catch {
          files.delete(f.path);
        }
      }
      for (const p of [...files.keys()]) {
        if (!seen.has(p)) {
          files.delete(p);
          changed = true;
        }
      }
      if (changed) await saveCache();
      return { files: files.size, chunks: [...files.values()].reduce((n, f) => n + f.chunks.length, 0) };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function bm25(queryTokens) {
    const all = [];
    for (const [p, f] of files) for (const c of f.chunks) all.push({ path: p, chunk: c });
    if (!all.length) return [];
    const df = {};
    let totalLen = 0;
    for (const { chunk } of all) {
      totalLen += chunk.len;
      for (const term of Object.keys(chunk.tf)) df[term] = (df[term] || 0) + 1;
    }
    const avg = totalLen / all.length || 1;
    const k1 = 1.4, b = 0.75;
    const scored = [];
    for (const { path: p, chunk } of all) {
      let score = 0;
      for (const term of new Set(queryTokens)) {
        const f = chunk.tf[term];
        if (!f) continue;
        const idf = Math.log(1 + (all.length - df[term] + 0.5) / (df[term] + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.len) / avg)));
      }
      if (score > 0) scored.push({ path: p, start: chunk.start, end: chunk.end, score });
    }
    return scored.sort((x, y) => y.score - x.score);
  }

  async function rerankWithEmbeddings(query, candidates) {
    if (!embed || now() < embedDisabledUntil || candidates.length < 2) return candidates;
    try {
      const texts = candidates.map((c) => c.text);
      const need = [];
      const hashes = texts.map((t) => crypto.createHash('sha1').update(t).digest('hex'));
      hashes.forEach((h, i) => { if (!vectors.has(h)) need.push(i); });
      const batch = await embed([query, ...need.map((i) => texts[i])]);
      if (!batch || batch.length !== need.length + 1) throw new Error('embeddings indisponíveis');
      need.forEach((i, k) => vectors.set(hashes[i], batch[k + 1]));
      const qv = batch[0];
      const maxBm = Math.max(...candidates.map((c) => c.score)) || 1;
      return candidates
        .map((c, i) => ({ ...c, score: 0.5 * (c.score / maxBm) + 0.5 * Math.max(0, cosine(qv, vectors.get(hashes[i]))) }))
        .sort((x, y) => y.score - x.score);
    } catch {
      embedDisabledUntil = now() + EMBED_RETRY_MS; // tenta de novo depois, não para sempre
      return candidates;
    }
  }

  /**
   * @returns {Promise<Array<{ path: string, start: number, end: number, score: number, text: string }>>}
   */
  async function search(query, { limit = 5 } = {}) {
    await refresh();
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const top = bm25(tokens).slice(0, Math.max(limit * 4, 20));
    const withText = [];
    for (const hit of top) {
      const chunk = files.get(hit.path)?.chunks.find((c) => c.start === hit.start);
      if (chunk) withText.push({ ...hit, text: chunk.text });
    }
    const ranked = await rerankWithEmbeddings(query, withText);
    // no máximo 2 trechos por arquivo, para variar as fontes
    const perFile = new Map();
    const out = [];
    for (const r of ranked) {
      const n = perFile.get(r.path) || 0;
      if (n >= 2) continue;
      perFile.set(r.path, n + 1);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { refresh, search, stats: () => ({ files: files.size, chunks: [...files.values()].reduce((n, f) => n + f.chunks.length, 0) }) };
}

export { createIndexer, tokenize, chunkFile, cosine };
