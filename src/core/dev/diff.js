/**
 * Edição cirúrgica por blocos SEARCH/REPLACE (formato herdado do Jarvis).
 *
 * Correções em relação ao Jarvis:
 *  - a substituição usava String.replace com texto vindo do modelo, então "$&",
 *    "$1" e "$$" no código novo eram interpretados e corrompiam o arquivo;
 *    aqui a troca é feita por posição (slice);
 *  - o SEARCH precisa casar UMA vez: se não existir ou se for ambíguo, o erro
 *    explica e nada é gravado (antes, só a primeira ocorrência era trocada em
 *    silêncio);
 *  - tolera diferença de quebra de linha (CRLF/LF) e de espaços no fim das linhas;
 *  - é tudo-ou-nada: se um bloco falhar, nenhum é aplicado.
 */

const BLOCK_RE = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

function parseBlocks(diffText) {
  const blocks = [];
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(String(diffText ?? ''))) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

function findAll(haystack, needle) {
  const found = [];
  if (!needle) return found;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    found.push(i);
    from = i + Math.max(1, needle.length);
  }
  return found;
}

const trimEnds = (text) => text.split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n');

/**
 * @param {string} content conteúdo atual do arquivo
 * @param {string} diffText blocos SEARCH/REPLACE
 * @returns {{ content: string, blocks: number }}
 */
function applyDiff(content, diffText) {
  const blocks = parseBlocks(diffText);
  if (blocks.length === 0) {
    throw new Error('Nenhum bloco SEARCH/REPLACE válido. Use:\n<<<<<<< SEARCH\n(trecho atual)\n=======\n(trecho novo)\n>>>>>>> REPLACE');
  }

  const usesCrlf = content.includes('\r\n');
  let work = content.replace(/\r\n/g, '\n');
  const compare = (text) => text.replace(/\r\n/g, '\n');

  blocks.forEach((block, index) => {
    const label = `bloco ${index + 1}`;
    const search = compare(block.search);
    const replace = compare(block.replace);
    if (!search.trim()) throw new Error(`${label}: o SEARCH está vazio.`);

    let hits = findAll(work, search);
    let matchedLength = search.length;

    if (hits.length === 0) {
      // 2ª tentativa: ignora espaços no fim das linhas.
      const lines = work.split('\n');
      const searchLines = trimEnds(search).split('\n');
      const starts = [];
      for (let i = 0; i + searchLines.length <= lines.length; i++) {
        if (searchLines.every((l, k) => lines[i + k].replace(/[ \t]+$/g, '') === l)) starts.push(i);
      }
      if (starts.length === 1) {
        const offset = lines.slice(0, starts[0]).reduce((n, l) => n + l.length + 1, 0);
        const length = lines.slice(starts[0], starts[0] + searchLines.length).join('\n').length;
        hits = [offset];
        matchedLength = length;
      } else if (starts.length > 1) {
        throw new Error(`${label}: o SEARCH aparece ${starts.length} vezes. Inclua mais linhas ao redor para ficar único.`);
      }
    }

    if (hits.length === 0) {
      throw new Error(`${label}: o SEARCH não foi encontrado no arquivo. Copie o trecho exatamente como está hoje (indentação incluída).`);
    }
    if (hits.length > 1) {
      throw new Error(`${label}: o SEARCH aparece ${hits.length} vezes. Inclua mais linhas ao redor para ficar único.`);
    }

    work = work.slice(0, hits[0]) + replace + work.slice(hits[0] + matchedLength);
  });

  return { content: usesCrlf ? work.replace(/\n/g, '\r\n') : work, blocks: blocks.length };
}

export { applyDiff, parseBlocks };
