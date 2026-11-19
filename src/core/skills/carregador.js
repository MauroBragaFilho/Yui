// Carregador e validador de SKILLS no padrão aberto (https://agentskills.io/specification), etapa 14 (item 4a).
//
// Uma skill é uma PASTA `<nome>/` com um `SKILL.md`: o cabeçalho (frontmatter) entre `---` e o corpo em Markdown. As pastas lidas são:
//  - `skills/` na raiz do repositório (as que vêm com a Yui);
//  - `secrets/skills/` (as que o dono instala à mão; o Git ignora `secrets/`);
//  - as pastas extras de YUI_SKILLS_PASTAS (separadas por `|`).
// Só LEITURA: este módulo nunca baixa nada da internet, nunca instala, nunca grava, nunca executa e nunca interpreta nada de uma skill como
// código. `scripts/` e `allowed-tools` são IGNORADOS (e registrados como ignorados); `assets/` nunca é aberta; `references/` só é lida sob
// demanda, na hora do uso (lerSkill), por um nome conferido. Nada é importado dinamicamente e nenhum programa é aberto.
//
// Revelação progressiva: o CATÁLOGO (carregarCatalogo) guarda só nome e descrição (cerca de 100 tokens por skill); o corpo só é lido quando a
// skill é usada (lerSkill, que valida tudo de novo, no mesmo instante da leitura).
//
// Toda skill é validada pelas regras da especificação. Uma skill inválida NÃO carrega: vira um aviso { pasta, origem, motivo } com o motivo
// numa palavra fixa (nunca o texto do arquivo): link_simbolico, fora_da_pasta, sem_skill_md, arquivo_grande, ilegivel, utf8_invalido,
// caractere_invalido, frontmatter_ausente, frontmatter_grande, yaml_invalido, yaml_perigoso, campo_desconhecido, nome_ausente, nome_invalido,
// nome_diferente_da_pasta, descricao_ausente, descricao_invalida, licenca_invalida, compatibilidade_invalida, metadata_invalido, corpo_vazio,
// corpo_grande, nome_duplicado, muitas_skills, muitas_pastas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErroSkill, lerSkillMd } from './yaml.js';

export { ErroSkill };

/** Os limites da especificação (nome, descrição, compatibilidade) e os da Yui (tamanho do arquivo, do corpo e das referências). */
export const LIMITES = Object.freeze({
  nome: 64,
  descricao: 1024,
  compatibilidade: 500,
  licenca: 200,
  bytesArquivo: 100 * 1024,
  linhasCorpo: 500,
  caracteresCorpo: 20_000, // ~5000 tokens
  maxPastasPorRaiz: 200,
  maxSkills: 100,
  maxReferencias: 3,
  bytesReferencia: 12_000,
  bytesReferenciasTotal: 24_000,
});

/** Só minúsculas, números e hífens; sem hífen no começo, no fim nem em sequência. */
export const NOME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Os campos do cabeçalho que a especificação define (qualquer outro recusa a skill). */
export const CAMPOS_ACEITOS = Object.freeze(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const CAMPOS = new Set(CAMPOS_ACEITOS);
const REFERENCIA_RE = /^(?:\.\/)?references\/([A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md)$/;
// Uma "palavra" do corpo (sequência sem espaço nem pontuação de abertura ou fechamento) e a marca de que ela cita a pasta references/.
// Duas expressões simples e lineares (nada de prefixo guloso seguido de busca): um corpo de 20 mil caracteres seguidos custa o mesmo que um normal.
const PALAVRA_RE = /[^\s()[\]<>"'`,;]+/g;
const CITA_REFERENCIAS_RE = /references[\\/]/i;
// Zero-width, bidirecionais, hífen suave, BOM e os caracteres Tag: escondem texto de quem lê, mas o modelo lê (o U+200D, do emoji composto, fica).
const INVISIVEL_RE = /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\u00ad\u180e\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
const COMENTARIO_HTML_RE = /<!--[\s\S]*?(?:-->|$)/g;

/** A raiz do repositório (esta pasta é src/core/skills): não depende do diretório de trabalho do processo. */
export const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** O texto de uma skill sem o que se esconde do olhar (invisíveis e comentários HTML) e sem as pontas. */
export function limparTexto(texto) {
  return String(texto ?? '').replace(INVISIVEL_RE, '').replace(COMENTARIO_HTML_RE, '').trim();
}

const pastaSegura = (nome) => String(nome ?? '').replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);

/** `alvo` está estritamente DENTRO de `base` (os dois já com o caminho real)? */
export function dentroDe(base, alvo) {
  const rel = path.relative(base, alvo);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** As pastas lidas, na ordem de prioridade: [{ dir, origem: 'yui' | 'dono' | 'extra' }]. Pasta que não existe é simplesmente pulada depois. */
export function raizesDeSkills(env = process.env, { raizRepo = RAIZ_REPO } = {}) {
  const lista = [
    { dir: path.join(raizRepo, 'skills'), origem: 'yui' },
    { dir: path.join(raizRepo, 'secrets', 'skills'), origem: 'dono' },
  ];
  for (const bruto of String(env?.YUI_SKILLS_PASTAS ?? '').split('|')) {
    const p = bruto.trim();
    if (p) lista.push({ dir: path.resolve(raizRepo, p), origem: 'extra' });
  }
  const vistos = new Set();
  return lista.filter((r) => {
    const chave = process.platform === 'win32' ? r.dir.toLowerCase() : r.dir;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

/**
 * Lê um arquivo REGULAR de até `max` bytes, sem seguir link simbólico (nem junção do Windows), e devolve os bytes.
 * `motivos` troca as palavras de "não existe" e "grande demais" (a SKILL.md e as referências usam palavras diferentes).
 */
function lerArquivoSeguro(arquivo, max, motivos = {}) {
  let st;
  try { st = fs.lstatSync(arquivo); } catch { throw new ErroSkill(motivos.ausente ?? 'sem_skill_md'); }
  if (st.isSymbolicLink()) throw new ErroSkill('link_simbolico');
  if (!st.isFile()) throw new ErroSkill(motivos.ausente ?? 'sem_skill_md');
  if (st.size > max) throw new ErroSkill(motivos.grande ?? 'arquivo_grande');
  let fd;
  try {
    fd = fs.openSync(arquivo, 'r');
    const aberto = fs.fstatSync(fd);
    if (!aberto.isFile()) throw new ErroSkill(motivos.ausente ?? 'sem_skill_md');
    if (aberto.size > max) throw new ErroSkill(motivos.grande ?? 'arquivo_grande');
    const buf = Buffer.alloc(aberto.size);
    let lido = 0;
    while (lido < aberto.size) {
      const n = fs.readSync(fd, buf, lido, aberto.size - lido, lido);
      if (n <= 0) break;
      lido += n;
    }
    return buf.subarray(0, lido);
  } catch (err) {
    if (err instanceof ErroSkill) throw err;
    throw new ErroSkill('ilegivel');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
  }
}

function decodificar(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new ErroSkill('utf8_invalido'); }
}

/** O valor de texto de um campo do cabeçalho: undefined = ausente, null = presente mas não é texto. */
function textoDe(dados, chave) {
  const d = dados.get(chave);
  if (d === undefined) return undefined;
  return d.tipo === 'texto' ? d.valor : null;
}

/**
 * Valida o texto de um SKILL.md contra a especificação. `pasta` é o nome da pasta onde ele está (o `name` precisa ser igual).
 * Devolve { nome, descricao, licenca, compatibilidade, metadata, ignorados, corpo } ou lança ErroSkill com a palavra do motivo.
 */
export function validarSkill(texto, pasta) {
  const { dados, corpo: corpoBruto } = lerSkillMd(texto);
  for (const chave of dados.keys()) if (!CAMPOS.has(chave)) throw new ErroSkill('campo_desconhecido');

  const nome = textoDe(dados, 'name');
  if (nome === undefined || nome === '') throw new ErroSkill('nome_ausente');
  if (nome === null || nome.length > LIMITES.nome || !NOME_RE.test(nome)) throw new ErroSkill('nome_invalido');
  if (nome !== pasta) throw new ErroSkill('nome_diferente_da_pasta');

  const bruta = textoDe(dados, 'description');
  if (bruta === undefined) throw new ErroSkill('descricao_ausente');
  if (bruta === null) throw new ErroSkill('descricao_invalida');
  const descricao = bruta.replace(INVISIVEL_RE, '').replace(/\s+/g, ' ').trim();
  if (!descricao) throw new ErroSkill('descricao_ausente');
  if (descricao.length > LIMITES.descricao) throw new ErroSkill('descricao_invalida');

  const licenca = textoDe(dados, 'license');
  if (licenca !== undefined && (licenca === null || !licenca.trim() || licenca.length > LIMITES.licenca)) throw new ErroSkill('licenca_invalida');

  const compat = textoDe(dados, 'compatibility');
  if (compat !== undefined && (compat === null || !compat.trim() || compat.length > LIMITES.compatibilidade)) throw new ErroSkill('compatibilidade_invalida');

  const meta = dados.get('metadata');
  if (meta !== undefined && meta.tipo !== 'mapa') throw new ErroSkill('metadata_invalido');

  const ignorados = [];
  if (dados.has('allowed-tools')) ignorados.push('allowed-tools');

  if (corpoBruto.replace(/\n+$/, '').split('\n').length > LIMITES.linhasCorpo) throw new ErroSkill('corpo_grande');
  const corpo = limparTexto(corpoBruto);
  if (!corpo) throw new ErroSkill('corpo_vazio');
  if (corpo.length > LIMITES.caracteresCorpo) throw new ErroSkill('corpo_grande');

  return {
    nome,
    descricao,
    licenca: licenca?.trim() ?? null,
    compatibilidade: compat?.trim() ?? null,
    metadata: meta ? Object.fromEntries(meta.valor) : {},
    ignorados,
    corpo,
  };
}

/**
 * Examina UMA pasta de skill dentro de `raizReal` (o caminho real da pasta de skills). Devolve { skill, corpo } ou lança ErroSkill.
 * Recusa link simbólico (e junção do Windows) na pasta e no SKILL.md, e qualquer caminho que, resolvido, saia da pasta.
 */
function examinarPasta(raizReal, nomePasta, origem) {
  const dir = path.join(raizReal, nomePasta);
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new ErroSkill('ilegivel'); }
  if (st.isSymbolicLink()) throw new ErroSkill('link_simbolico');
  let dirReal;
  try { dirReal = fs.realpathSync(dir); } catch { throw new ErroSkill('ilegivel'); }
  if (!dentroDe(raizReal, dirReal)) throw new ErroSkill('fora_da_pasta');
  // O arquivo se chama exatamente SKILL.md (no Windows, "skill.md" abriria o mesmo arquivo; aqui é recusado nos dois sistemas).
  let nomesNaPasta;
  try { nomesNaPasta = fs.readdirSync(dirReal); } catch { throw new ErroSkill('ilegivel'); }
  if (!nomesNaPasta.includes('SKILL.md')) throw new ErroSkill('sem_skill_md');
  const arquivo = path.join(dirReal, 'SKILL.md');
  const bytes = lerArquivoSeguro(arquivo, LIMITES.bytesArquivo);
  let arquivoReal;
  try { arquivoReal = fs.realpathSync(arquivo); } catch { throw new ErroSkill('ilegivel'); }
  if (!dentroDe(dirReal, arquivoReal)) throw new ErroSkill('fora_da_pasta');
  const v = validarSkill(decodificar(bytes), nomePasta);
  // `scripts/` só é REGISTRADA como ignorada (nunca aberta nem listada): nada de uma skill é executado.
  const ignorados = [...v.ignorados];
  try { if (fs.lstatSync(path.join(dirReal, 'scripts'))) ignorados.push('scripts'); } catch { /* sem scripts */ }
  const { corpo, ...resto } = v;
  return { skill: Object.freeze({ ...resto, ignorados, pasta: nomePasta, origem, dir: dirReal, raiz: raizReal }), corpo };
}

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * O catálogo das skills válidas: { skills, avisos }. `skills` (ordenadas pelo nome) leva só nome e descrição e o que é preciso para achar a
 * pasta; o corpo NÃO é guardado. `avisos`: [{ pasta, origem, motivo }] das pastas que não carregaram. Nunca lança e nunca escreve.
 * Em nome repetido vale a primeira pasta (a da Yui, depois a do dono, depois as extras).
 */
export function carregarCatalogo({ env = process.env, raizes = raizesDeSkills(env) } = {}) {
  const skills = [];
  const avisos = [];
  const vistos = new Set();
  for (const raiz of raizes) {
    let raizReal;
    try {
      raizReal = fs.realpathSync(raiz.dir);
      if (!fs.statSync(raizReal).isDirectory()) continue;
    } catch { continue; } // a pasta não existe: normal
    let entradas;
    try { entradas = fs.readdirSync(raizReal, { withFileTypes: true }); } catch { continue; }
    const nomes = entradas.map((e) => e.name).filter((n) => !n.startsWith('.')).sort(comparar);
    if (nomes.length > LIMITES.maxPastasPorRaiz) avisos.push({ pasta: '*', origem: raiz.origem, motivo: 'muitas_pastas' });
    for (const nomePasta of nomes.slice(0, LIMITES.maxPastasPorRaiz)) {
      let st;
      try { st = fs.lstatSync(path.join(raizReal, nomePasta)); } catch { continue; }
      if (st.isSymbolicLink()) { avisos.push({ pasta: pastaSegura(nomePasta), origem: raiz.origem, motivo: 'link_simbolico' }); continue; }
      if (!st.isDirectory()) continue; // arquivo solto (um README, por exemplo): não é skill e não é aviso
      try {
        const { skill } = examinarPasta(raizReal, nomePasta, raiz.origem);
        if (vistos.has(skill.nome)) { avisos.push({ pasta: pastaSegura(nomePasta), origem: raiz.origem, motivo: 'nome_duplicado' }); continue; }
        if (skills.length >= LIMITES.maxSkills) { avisos.push({ pasta: pastaSegura(nomePasta), origem: raiz.origem, motivo: 'muitas_skills' }); continue; }
        vistos.add(skill.nome);
        skills.push(skill);
      } catch (err) {
        avisos.push({ pasta: pastaSegura(nomePasta), origem: raiz.origem, motivo: err instanceof ErroSkill ? err.motivo : 'ilegivel' });
      }
    }
  }
  skills.sort((a, b) => comparar(a.nome, b.nome));
  return { skills, avisos };
}

/**
 * Os arquivos de `references/` que o CORPO pede, pelo caminho relativo `references/<nome>.md` (um nível só, sem `..`, sem pasta acima).
 * Devolve { pedidas: [nome.md...], recusadas: n }: o que tem cara de caminho de referência mas não tem a forma exata é contado e nunca aberto.
 */
export function extrairReferencias(corpo) {
  const pedidas = [];
  let recusadas = 0;
  for (const m of String(corpo ?? '').matchAll(PALAVRA_RE)) {
    if (!CITA_REFERENCIAS_RE.test(m[0])) continue;
    let fim = m[0].length;
    while (fim > 0 && '.:!?'.includes(m[0][fim - 1])) fim -= 1; // pontuação final da frase, sem expressão regular
    const token = m[0].slice(0, fim);
    const ok = REFERENCIA_RE.exec(token);
    if (!ok || ok[1].includes('..')) { recusadas += 1; continue; }
    if (!pedidas.includes(ok[1])) pedidas.push(ok[1]);
  }
  return { pedidas, recusadas };
}

/** Lê as referências pedidas (só as que EXISTEM dentro de `<pasta da skill>/references/`, são arquivos comuns e cabem no limite). */
function carregarReferencias(dirReal, nomes) {
  const referencias = [];
  const recusadas = [];
  const pasta = path.join(dirReal, 'references');
  let pastaReal = null;
  try {
    const st = fs.lstatSync(pasta);
    if (st.isSymbolicLink()) { for (const n of nomes) recusadas.push({ caminho: `references/${n}`, motivo: 'link_simbolico' }); return { referencias, recusadas }; }
    if (st.isDirectory()) pastaReal = fs.realpathSync(pasta);
  } catch { /* sem a pasta references/ */ }
  let total = 0;
  for (const nome of nomes) {
    const caminho = `references/${nome}`;
    if (referencias.length >= LIMITES.maxReferencias) { recusadas.push({ caminho, motivo: 'muitas_referencias' }); continue; }
    if (!pastaReal || !dentroDe(dirReal, pastaReal)) { recusadas.push({ caminho, motivo: 'referencia_inexistente' }); continue; }
    try {
      const arquivo = path.join(pastaReal, nome);
      const bytes = lerArquivoSeguro(arquivo, LIMITES.bytesReferencia, { ausente: 'referencia_inexistente', grande: 'referencia_grande' });
      if (!dentroDe(pastaReal, fs.realpathSync(arquivo))) throw new ErroSkill('fora_da_pasta');
      if (total + bytes.length > LIMITES.bytesReferenciasTotal) throw new ErroSkill('referencia_grande');
      const texto = limparTexto(decodificar(bytes));
      if (!texto) throw new ErroSkill('referencia_inexistente');
      total += bytes.length;
      referencias.push({ caminho, texto });
    } catch (err) {
      recusadas.push({ caminho, motivo: err instanceof ErroSkill ? err.motivo : 'ilegivel' });
    }
  }
  return { referencias, recusadas };
}

/**
 * Lê a skill ESCOLHIDA para uso: valida tudo de novo (o arquivo pode ter mudado desde o catálogo), devolve o corpo e as referências que o corpo
 * pede (só as que existem dentro da pasta dela). Lança ErroSkill se a skill deixou de ser válida.
 * @returns {{ nome: string, descricao: string, origem: string, corpo: string, referencias: {caminho: string, texto: string}[],
 *             recusadas: {caminho?: string, motivo: string}[], ignorados: string[] }}
 */
export function lerSkill(entrada) {
  const pasta = String(entrada?.pasta ?? '');
  const raiz = String(entrada?.raiz ?? '');
  // O nome da pasta vem do catálogo, mas é conferido de novo: nada de "..", barra ou nome fora do padrão chega a um caminho.
  if (!NOME_RE.test(pasta) || pasta.length > LIMITES.nome) throw new ErroSkill('nome_invalido');
  if (!raiz || !path.isAbsolute(raiz)) throw new ErroSkill('fora_da_pasta');
  let raizReal;
  try { raizReal = fs.realpathSync(raiz); } catch { throw new ErroSkill('fora_da_pasta'); }
  const { skill, corpo } = examinarPasta(raizReal, pasta, String(entrada.origem ?? 'extra'));
  const { pedidas, recusadas: malFormadas } = extrairReferencias(corpo);
  const { referencias, recusadas } = carregarReferencias(skill.dir, pedidas);
  return {
    nome: skill.nome,
    descricao: skill.descricao,
    origem: skill.origem,
    corpo,
    referencias,
    recusadas: [...Array.from({ length: malFormadas }, () => ({ motivo: 'referencia_recusada' })), ...recusadas],
    ignorados: skill.ignorados,
  };
}
