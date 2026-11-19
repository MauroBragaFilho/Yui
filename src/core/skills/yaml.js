// Leitor MÍNIMO e SEGURO do cabeçalho (frontmatter) das skills no padrão aberto (https://agentskills.io/specification).
//
// Não é um interpretador de YAML: lê só o que uma skill precisa e recusa o resto. Nada é executado, nada é carregado de fora,
// nada vira objeto de código: o resultado é só texto (um mapa de chave para texto, ou de chave para um mapa de texto).
// O que é aceito:
//  - `chave: valor` na primeira coluna (chaves só com letras, números, `_` e `-`), comentários de linha inteira ou depois de ` #`;
//  - valor em texto puro, entre aspas simples ou entre aspas duplas (escapes `\\`, `\"`, `\n`, `\t`, `\/` e `\uXXXX`), na MESMA linha;
//  - texto puro que continua nas linhas seguintes recuadas (junta com espaço);
//  - bloco de texto `|` ou `>` (com `-` ou `+`), recuado com espaços;
//  - `metadata:` com um nível de `chave: texto`; `allowed-tools:` como texto, lista curta `[a, b]` ou lista em blocos (só é reconhecido e IGNORADO).
// O que é recusado, com uma palavra fixa (ErroSkill.motivo):
//  - tags (`!`), âncoras (`&`) e apelidos (`*`) do YAML, e a chave de mesclagem `<<`: `yaml_perigoso`;
//  - tabulação na indentação, aninhamento que não seja o `metadata`, lista ou mapa onde só cabe texto, chave repetida, aspas que não fecham,
//    escapes desconhecidos, linha que não é `chave: valor`, indicadores reservados (`%`, `@`, crase): `yaml_invalido`;
//  - caracteres de controle e CR solto: `caractere_invalido`; arquivo sem o cabeçalho `---`: `frontmatter_ausente`;
//  - cabeçalho grande demais (8 KB ou 120 linhas): `frontmatter_grande`.
export class ErroSkill extends Error {
  /** @param {string} motivo palavra fixa (snake_case ASCII): nunca carrega texto do arquivo */
  constructor(motivo) {
    super(motivo);
    this.name = 'ErroSkill';
    this.motivo = motivo;
  }
}

export const LIMITES_YAML = Object.freeze({
  bytesCabecalho: 8 * 1024,
  linhasCabecalho: 120,
  maxEntradasMetadata: 32,
  maxChaveMetadata: 64,
  maxValorMetadata: 512,
  maxFlow: 500,
});

// Controle (menos tab e quebra de linha), DEL e o resto das quebras Unicode que não são "\n".
const CONTROLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u0085]/;
const SEPARADORES_UNICODE = [0x2028, 0x2029].map((n) => String.fromCharCode(n)); // LS e PS: quebras de linha que não são \n
const CHAVE_RE = /^([A-Za-z0-9_-]{1,64}):(?:[ \t]+(.*))?$/;
const CHAVE_META_RE = /^([A-Za-z0-9_.-]{1,64}):(?:[ \t]+(.*))?$/;

const invalido = () => new ErroSkill('yaml_invalido');
const perigoso = () => new ErroSkill('yaml_perigoso');

/** Separa o cabeçalho `---`...`---` do corpo. Devolve { linhas, corpo } (corpo com o fim de linha normalizado para \n). */
export function separarFrontmatter(texto) {
  let t = String(texto ?? '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n');
  if (t.includes('\r') || CONTROLE_RE.test(t) || SEPARADORES_UNICODE.some((s) => t.includes(s))) throw new ErroSkill('caractere_invalido');
  const linhas = t.split('\n');
  if (linhas[0].trimEnd() !== '---') throw new ErroSkill('frontmatter_ausente');
  let fim = -1;
  for (let i = 1; i < linhas.length; i += 1) {
    if (linhas[i].trimEnd() === '---') { fim = i; break; }
  }
  if (fim < 0) throw new ErroSkill('frontmatter_ausente');
  const cab = linhas.slice(1, fim);
  if (cab.length > LIMITES_YAML.linhasCabecalho || Buffer.byteLength(cab.join('\n'), 'utf8') > LIMITES_YAML.bytesCabecalho) throw new ErroSkill('frontmatter_grande');
  return { linhas: cab, corpo: linhas.slice(fim + 1).join('\n') };
}

const recuo = (linha) => /^ */.exec(linha)[0].length;
const vazia = (linha) => /^\s*$/.test(linha);
const comentario = (linha) => /^\s*#/.test(linha);

/** Texto entre aspas duplas que começa em `v[0]`. Devolve [texto, resto depois da aspa de fechamento]. */
function aspasDuplas(v) {
  let out = '';
  for (let i = 1; i < v.length; i += 1) {
    const c = v[i];
    if (c === '"') return [out, v.slice(i + 1)];
    if (c !== '\\') { out += c; continue; }
    const n = v[i + 1];
    if (n === undefined) throw invalido();
    if (n === '"' || n === '\\' || n === '/') out += n;
    else if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'u') {
      const hex = v.slice(i + 2, i + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw invalido();
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else throw invalido();
    i += 1;
  }
  throw invalido(); // as aspas não fecham na mesma linha
}

/** Texto entre aspas simples que começa em `v[0]` (`''` vira `'`). Devolve [texto, resto]. */
function aspasSimples(v) {
  let out = '';
  for (let i = 1; i < v.length; i += 1) {
    if (v[i] !== "'") { out += v[i]; continue; }
    if (v[i + 1] === "'") { out += "'"; i += 1; continue; }
    return [out, v.slice(i + 1)];
  }
  throw invalido();
}

/** Depois de um valor entre aspas só pode vir um comentário (com espaço antes do #). */
function soComentario(resto) {
  if (resto.trim() !== '' && !/^\s+#/.test(resto)) throw invalido();
}

/**
 * O valor de uma linha `chave: valor` (o que vem depois dos dois pontos).
 * Devolve { tipo: 'vazio' } | { tipo: 'texto', valor } | { tipo: 'bloco', cabecalho } | { tipo: 'flow', bruto }.
 */
function lerValor(bruto) {
  const v = String(bruto ?? '').trim();
  if (v === '' || v.startsWith('#')) return { tipo: 'vazio' };
  const c = v[0];
  if (c === '!' || c === '&' || c === '*') throw perigoso();
  if (c === '"') { const [texto, resto] = aspasDuplas(v); soComentario(resto); return { tipo: 'texto', valor: texto, citado: true }; }
  if (c === "'") { const [texto, resto] = aspasSimples(v); soComentario(resto); return { tipo: 'texto', valor: texto, citado: true }; }
  if (c === '|' || c === '>') {
    if (!/^[|>][+-]?\s*(?:#.*)?$/.test(v)) throw invalido();
    return { tipo: 'bloco', cabecalho: c };
  }
  if (c === '[' || c === '{') return { tipo: 'flow', bruto: v };
  if (c === '%' || c === '@' || c === '`') throw invalido();
  if ((c === '-' || c === '?') && (v.length === 1 || v[1] === ' ')) throw invalido();
  // texto puro: um " #" começa um comentário
  const corte = v.search(/\s#/);
  return { tipo: 'texto', valor: (corte >= 0 ? v.slice(0, corte) : v).trim(), citado: false };
}

/** As linhas recuadas (ou em branco) logo depois de `i`: [linhas, próximo índice]. */
function linhasRecuadas(linhas, i) {
  const out = [];
  let j = i + 1;
  while (j < linhas.length && (vazia(linhas[j]) || recuo(linhas[j]) > 0)) { out.push(linhas[j]); j += 1; }
  while (out.length && vazia(out[out.length - 1])) out.pop(); // brancas do fim não pertencem ao bloco
  return [out, i + 1 + out.length];
}

function blocoDeTexto(cabecalho, filhas) {
  const uteis = filhas.filter((l) => !vazia(l));
  if (!uteis.length) return '';
  if (uteis.some((l) => /^ *\t/.test(l))) throw invalido();
  const base = Math.min(...uteis.map(recuo));
  const itens = filhas.map((l) => (vazia(l) ? '' : l.slice(base)));
  if (cabecalho === '|') return itens.join('\n').trim();
  // `>`: linhas seguidas viram uma só (com espaço); linha em branco vira quebra
  let out = '';
  for (const it of itens) {
    if (it === '') { out += '\n'; continue; }
    out += out === '' || out.endsWith('\n') ? it : ` ${it}`;
  }
  return out.trim();
}

function mapaMetadata(filhas) {
  const uteis = filhas.filter((l) => !vazia(l) && !comentario(l));
  if (!uteis.length) throw new ErroSkill('metadata_invalido');
  if (uteis.some((l) => /^ *\t/.test(l))) throw invalido();
  const base = recuo(uteis[0]);
  const mapa = new Map();
  for (const l of uteis) {
    if (recuo(l) !== base) throw new ErroSkill('metadata_invalido'); // só um nível
    const m = CHAVE_META_RE.exec(l.slice(base));
    if (!m) throw new ErroSkill('metadata_invalido');
    const val = lerValor(m[2]);
    if (val.tipo !== 'texto' && val.tipo !== 'vazio') throw new ErroSkill('metadata_invalido');
    const texto = val.tipo === 'texto' ? val.valor : '';
    if (m[1].length > LIMITES_YAML.maxChaveMetadata || texto.length > LIMITES_YAML.maxValorMetadata || mapa.has(m[1])) throw new ErroSkill('metadata_invalido');
    mapa.set(m[1], texto);
    if (mapa.size > LIMITES_YAML.maxEntradasMetadata) throw new ErroSkill('metadata_invalido');
  }
  return mapa;
}

/** `allowed-tools` só é reconhecido (e ignorado): texto, lista curta ou lista em blocos; sem tag, âncora ou apelido. */
function reconhecerFerramentas(valor, filhas) {
  if (valor.tipo === 'flow') {
    if (valor.bruto.length > LIMITES_YAML.maxFlow || !/^\[[^\[\]{}]*\]$/.test(valor.bruto)) throw invalido();
    if (/(?:^\[|,)\s*[!&*]/.test(valor.bruto)) throw perigoso();
    return;
  }
  if (valor.tipo === 'vazio') {
    if (filhas.some((l) => !vazia(l) && !comentario(l) && !/^ +- +\S/.test(l))) throw invalido();
    if (filhas.some((l) => /^ +- +[!&*]/.test(l))) throw perigoso();
  }
}

/**
 * Lê as linhas do cabeçalho e devolve um Map: chave -> { tipo: 'texto', valor } | { tipo: 'mapa', valor: Map } | { tipo: 'ignorado' }.
 * Só `metadata` vira mapa; `allowed-tools` vira `ignorado`; o resto é sempre texto.
 */
export function lerMapa(linhas) {
  const dados = new Map();
  let i = 0;
  while (i < linhas.length) {
    const linha = linhas[i];
    if (vazia(linha) || comentario(linha)) { i += 1; continue; }
    if (/^ *\t/.test(linha) || recuo(linha) !== 0) throw invalido();
    if (linha.startsWith('<<')) throw perigoso();
    const m = CHAVE_RE.exec(linha);
    if (!m) throw invalido();
    const chave = m[1];
    if (dados.has(chave)) throw invalido();
    const valor = lerValor(m[2]);
    const [filhas, proximo] = linhasRecuadas(linhas, i);
    const filhasUteis = filhas.filter((l) => !vazia(l) && !comentario(l));
    if (chave === 'metadata') {
      if (valor.tipo !== 'vazio') throw new ErroSkill('metadata_invalido');
      dados.set(chave, { tipo: 'mapa', valor: mapaMetadata(filhas) });
    } else if (chave === 'allowed-tools') {
      reconhecerFerramentas(valor, filhas);
      if (valor.tipo === 'bloco') blocoDeTexto(valor.cabecalho, filhas); // só confere que o bloco é legível
      dados.set(chave, { tipo: 'ignorado' });
    } else if (valor.tipo === 'bloco') {
      dados.set(chave, { tipo: 'texto', valor: blocoDeTexto(valor.cabecalho, filhas) });
    } else if (valor.tipo === 'flow') {
      throw invalido(); // lista ou mapa onde só cabe texto
    } else if (valor.tipo === 'vazio') {
      if (filhasUteis.length) throw invalido(); // aninhamento que não é o `metadata`
      dados.set(chave, { tipo: 'texto', valor: '' });
    } else if (valor.citado) {
      if (filhasUteis.length) throw invalido(); // texto entre aspas em várias linhas: não suportado
      dados.set(chave, { tipo: 'texto', valor: valor.valor });
    } else {
      // texto puro que continua nas linhas recuadas: junta com espaço (uma linha "x: y" recuada seria um mapa aninhado: recusada)
      if (filhasUteis.some((l) => /^ *\t/.test(l) || CHAVE_META_RE.test(l.trim()))) throw invalido();
      const partes = [valor.valor, ...filhasUteis.map((l) => l.trim())];
      dados.set(chave, { tipo: 'texto', valor: partes.join(' ').trim() });
    }
    i = proximo;
  }
  return dados;
}

/** O cabeçalho + o corpo de um SKILL.md: { dados: Map, corpo: string }. Lança ErroSkill. */
export function lerSkillMd(texto) {
  const { linhas, corpo } = separarFrontmatter(texto);
  return { dados: lerMapa(linhas), corpo };
}
