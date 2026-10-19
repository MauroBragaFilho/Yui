import fsp from 'fs/promises';
import path from 'path';

/**
 * Monta o contexto que acompanha a pergunta, com orçamento de tamanho.
 *
 * No Jarvis o contexto (arquivo aberto de até 30 KB + 5 trechos + resumo) ia
 * inteiro em TODA mensagem. Aqui há um limite total de caracteres: arquivo aberto
 * primeiro (cortado), depois os trechos mais relevantes até acabar o orçamento.
 */

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Resumo curto do projeto: nome, scripts e pastas de topo. */
async function summarizeWorkspace(workspaceFs) {
  const parts = [`Projeto: ${path.basename(workspaceFs.root)}`];
  const pkg = await readJson(path.join(workspaceFs.root, 'package.json'));
  if (pkg) {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 12);
    parts.push(`package.json: ${pkg.name || '(sem nome)'}; scripts: ${Object.keys(pkg.scripts || {}).join(', ') || 'nenhum'}${deps.length ? `; deps: ${deps.join(', ')}` : ''}`);
  }
  try {
    const top = await workspaceFs.listDir('');
    parts.push(`Raiz: ${top.slice(0, 25).map((i) => (i.isDirectory ? `${i.name}/` : i.name)).join('  ')}`);
  } catch {
    /* sem listagem */
  }
  return parts.join('\n');
}

/**
 * @param {{ workspaceFs: object, indexer: object, query: string, activeFile?: string|null, budget?: number }} input
 */
async function buildContext({ workspaceFs, indexer, query, activeFile = null, budget = 6000 }) {
  let remaining = budget;
  const sections = [];
  const add = (title, body) => {
    if (remaining <= 200 || !body) return;
    const text = body.length > remaining ? `${body.slice(0, remaining)}\n[...cortado...]` : body;
    sections.push(`### ${title}\n${text}`);
    remaining -= text.length + title.length + 8;
  };

  if (activeFile) {
    try {
      const file = await workspaceFs.readFile(activeFile);
      add(`Arquivo aberto no editor: ${file.path}`, file.content.slice(0, Math.floor(budget * 0.5)));
    } catch {
      /* arquivo sumiu ou é sensível: ignora */
    }
  }

  if (indexer && String(query ?? '').trim().length > 2) {
    try {
      const hits = await indexer.search(query, { limit: 5 });
      for (const hit of hits) {
        if (hit.path === activeFile) continue;
        add(`Trecho relevante: ${hit.path}:${hit.start}-${hit.end}`, hit.text.slice(0, 1500));
      }
    } catch {
      /* busca é um extra */
    }
  }

  return { text: sections.join('\n\n'), used: budget - remaining };
}

export { buildContext, summarizeWorkspace };
