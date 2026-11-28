/**
 * Regras das seções "Listas", "Skills" e "Projetos e decisões" do Admin (lacunas do painel, item 12: o que a Yui guarda, visto pelo dono). Só ver; o único
 * apagar é o de UM projeto ou decisão, com confirmação. O servidor já manda tudo com lista fechada de campos (as listas são só as do dono). Sem React e sem
 * rede (testável em Node).
 */
import type { ContinuidadeItem, ContinuidadeView, ListaPessoal, ListasView, SkillView, SkillsView } from './api/client.ts';

export type Tom = 'ok' | 'atencao' | 'neutro';

const dois = (n: number) => String(n).padStart(2, '0');
/** "26/11/2026" (data local); sem data ou inválida, "—". */
export function dataCurta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()}`;
}
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

// ── Listas ──

export const TEXTO_LISTAS_DESLIGADAS = 'As listas pela conversa estão desligadas (Configuração e chaves, grupo Conversa). As que já existem continuam aqui.';
export const TEXTO_LISTAS_VAZIAS = 'Você ainda não tem listas. Na sua DM: "anota na lista de compras: leite, pão".';
export const TEXTO_LISTAS_ILEGIVEIS = 'Não consegui ler o arquivo das suas listas. Nada foi mexido nele; a Yui arruma na próxima vez que você mexer numa lista pela conversa.';

/** "2 listas, 5 itens (1 feito)". */
export function resumoDasListas(v: Pick<ListasView, 'listas'> | null | undefined): string {
  const listas = v?.listas ?? [];
  if (!listas.length) return 'Nenhuma lista';
  const itens = listas.reduce((n, l) => n + l.total, 0);
  const feitos = listas.reduce((n, l) => n + l.feitos, 0);
  return `${plural(listas.length, 'lista', 'listas')}, ${plural(itens, 'item', 'itens')}${feitos ? ` (${plural(feitos, 'feito', 'feitos')})` : ''}`;
}

/** O cartão de uma lista: título, contagem e os itens numerados, com os feitos marcados. */
export function vistaDaLista(l: ListaPessoal): { titulo: string; contagem: string; quando: string; itens: { n: number; texto: string; feito: boolean }[] } {
  return {
    titulo: l.nome,
    contagem: l.total ? `${plural(l.total, 'item', 'itens')}${l.feitos ? `, ${plural(l.feitos, 'feito', 'feitos')}` : ''}` : 'Vazia',
    quando: l.atualizadaEm ? `Mudou em ${dataCurta(l.atualizadaEm)}` : '',
    itens: l.itens.map((i, idx) => ({ n: idx + 1, texto: i.texto, feito: i.feito })),
  };
}

// ── Skills ──

const ORIGENS: Record<string, string> = { yui: 'vem com a Yui', dono: 'instalada por você', extra: 'pasta extra' };
const MOTIVOS: Record<string, string> = {
  link_simbolico: 'link simbólico', fora_da_pasta: 'fora da pasta', sem_skill_md: 'sem SKILL.md', arquivo_grande: 'arquivo grande', ilegivel: 'ilegível',
  utf8_invalido: 'texto inválido', caractere_invalido: 'caractere inválido', frontmatter_ausente: 'sem cabeçalho', frontmatter_grande: 'cabeçalho grande',
  yaml_invalido: 'cabeçalho inválido', yaml_perigoso: 'cabeçalho perigoso', campo_desconhecido: 'campo desconhecido', nome_ausente: 'sem nome',
  nome_invalido: 'nome inválido', nome_diferente_da_pasta: 'nome diferente da pasta', descricao_ausente: 'sem descrição', descricao_invalida: 'descrição inválida',
  licenca_invalida: 'licença inválida', compatibilidade_invalida: 'compatibilidade inválida', metadata_invalido: 'metadata inválido', corpo_vazio: 'corpo vazio',
  corpo_grande: 'corpo grande', nome_duplicado: 'nome repetido', muitas_skills: 'skills demais', muitas_pastas: 'pastas demais',
};
/** O motivo de uma pasta não ter carregado, em português (o desconhecido aparece como veio). */
export const motivoDaSkill = (m: string) => MOTIVOS[m] ?? m;

/** A linha de cima: desligadas (YUI_SKILLS), ou quantas valem e por quê (todas ou só as da lista). */
export function textoDoFiltro(v: Pick<SkillsView, 'ligado' | 'filtro' | 'total' | 'ativas'>): { texto: string; tom: Tom } {
  if (!v.ligado) return { texto: 'As skills estão desligadas (Configuração e chaves, grupo Inteligência). Nenhuma é usada agora.', tom: 'neutro' };
  if (v.filtro === 'lista') return { texto: `${plural(v.ativas, 'skill permitida', 'skills permitidas')} de ${v.total} (só as da lista de permitidas).`, tom: v.ativas ? 'ok' : 'atencao' };
  if (!v.total) return { texto: 'Nenhuma skill instalada.', tom: 'neutro' };
  return { texto: `${v.total === 1 ? 'A única skill instalada vale' : `Todas as ${v.total} skills instaladas valem`} (a lista de permitidas está vazia).`, tom: 'ok' };
}

/** O cartão de uma skill: nome, de onde veio, selo (permitida ou fora da lista), descrição e o que foi ignorado dela. */
export function vistaDaSkill(s: SkillView, ligado = true): { nome: string; origem: string; selo: string; tom: Tom; descricao: string; nota: string | null } {
  const ign = s.ignorados.map((i) => (i === 'scripts' ? 'a pasta scripts' : i === 'allowed-tools' ? 'o allowed-tools' : i));
  return {
    nome: s.nome,
    origem: [ORIGENS[s.origem] ?? s.origem, s.licenca ? `licença ${s.licenca}` : null].filter(Boolean).join(' • '),
    selo: !ligado ? 'Desligada' : s.permitida ? 'Permitida' : 'Fora da lista',
    tom: !ligado ? 'neutro' : s.permitida ? 'ok' : 'atencao',
    descricao: s.descricao,
    nota: ign.length ? `Ignorado por segurança: ${ign.join(' e ')} (nada de uma skill é executado).` : null,
  };
}

// ── Projetos e decisões (continuidade) ──

export type FiltroDaContinuidade = 'todos' | 'projeto' | 'decisao';
export const TEXTO_CONTINUIDADE_SEM_MEMORIA = 'A memória está desligada: os projetos e as decisões não podem ser lidos agora.';
export const TEXTO_CONTINUIDADE_DESLIGADA = 'Registrar novos projetos e decisões pela conversa está desligado ("Registrar projetos e decisões" em Configuração e chaves). O que já foi guardado continua aqui.';
export const TEXTO_CONTINUIDADE_VAZIA = 'Nada registrado ainda. Na sua DM: "novo projeto: nome do projeto" ou "registra a decisão: o que foi decidido".';

/** "2 projetos e 1 decisão" / "Nada registrado". */
export function resumoDaContinuidade(v: Pick<ContinuidadeView, 'projetos' | 'decisoes'> | null | undefined): string {
  if (!v || (!v.projetos && !v.decisoes)) return 'Nada registrado';
  return `${plural(v.projetos, 'projeto', 'projetos')} e ${plural(v.decisoes, 'decisão', 'decisões')}`;
}

/** Os itens do filtro, do mais recente para o mais antigo (pela última mudança, depois pelo número). Não altera a lista recebida. */
export function filtrarContinuidade(itens: ContinuidadeItem[], filtro: FiltroDaContinuidade): ContinuidadeItem[] {
  const quando = (i: ContinuidadeItem) => { const t = Date.parse(String(i.atualizadoEm ?? i.criadoEm ?? '')); return Number.isNaN(t) ? 0 : t; };
  return (Array.isArray(itens) ? itens : []).filter((i) => filtro === 'todos' || i.tipo === filtro).sort((a, b) => quando(b) - quando(a) || b.id - a.id);
}

/** O cartão de um item: tipo, texto, quando foi guardado e o número. */
export function vistaDoItem(i: ContinuidadeItem): { tipo: string; texto: string; quando: string; numero: string } {
  return {
    tipo: i.tipo === 'projeto' ? 'Projeto' : i.tipo === 'decisao' ? 'Decisão' : 'Registro',
    texto: i.texto,
    quando: `Guardado em ${dataCurta(i.criadoEm)}${i.atualizadoEm && i.atualizadoEm !== i.criadoEm ? ` (renovado em ${dataCurta(i.atualizadoEm)})` : ''}`,
    numero: `#${i.id}`,
  };
}

/** A confirmação de apagar: o tipo, o número, um pedaço do texto e o aviso de que não dá para desfazer. */
export function confirmacaoDeApagar(i: Pick<ContinuidadeItem, 'id' | 'tipo' | 'texto'>): { titulo: string; mensagem: string; sim: string } {
  const nome = i.tipo === 'projeto' ? 'este projeto' : 'esta decisão';
  const trecho = i.texto.length > 120 ? `${i.texto.slice(0, 119)}…` : i.texto;
  return {
    titulo: `Apagar ${nome}?`,
    mensagem: `#${i.id} · ${trecho}\n\nA Yui esquece este registro (ele sai da sua memória pessoal). Não dá para desfazer.`,
    sim: 'Apagar',
  };
}
