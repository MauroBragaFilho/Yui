/**
 * Regras da seção "Monitores" do Admin (os monitores de busca que o dono cria pela conversa: "me avisa quando..."), sem React e sem rede
 * (testáveis em Node). O servidor (GET /v1/admin/monitores) só manda o assunto curto (até 60 caracteres), o estado, as datas e a contagem de
 * avisos: nunca o texto de um resultado. Nada aqui inventa dado; o que não veio aparece como "—".
 */

export interface MonitorLike {
  id: number;
  /** Assunto (até 60 caracteres); null depois de encerrado (o servidor apaga o assunto ao encerrar). */
  consulta: string | null;
  estado: string;
  proximaChecagem: string | null;
  ate: string | null;
  avisos: number;
  /** Entrega de um aviso em andamento: 'pendente' | 'enviando' | 'incerto'. */
  entrega?: string;
  /** Por que encerrou: 'vencido' | 'cancelado' | 'barrado'. */
  fim?: string;
}

export type Tom = 'ok' | 'atencao' | 'neutro';

const ESTADOS: Record<string, { texto: string; tom: Tom; ordem: number }> = {
  ativo: { texto: 'Ativo', tom: 'ok', ordem: 0 },
  pausado: { texto: 'Pausado', tom: 'atencao', ordem: 1 },
  encerrado: { texto: 'Encerrado', tom: 'neutro', ordem: 2 },
};
const FIM: Record<string, string> = {
  vencido: 'Chegou ao fim do prazo.',
  cancelado: 'Cancelado.',
  barrado: 'Parado pelas regras de segurança.',
};
const ENTREGA: Record<string, string> = {
  pendente: 'Um aviso está na fila para sair por DM.',
  enviando: 'Um aviso está sendo enviado por DM.',
  incerto: 'Um aviso pode não ter chegado: a Yui confere antes de mandar de novo.',
};

/** O aviso da tela quando o servidor responde `ligado: false`. */
export const TEXTO_MONITORES_DESLIGADOS =
  'Os monitores estão desligados. Eles só funcionam com o cérebro separado e com "Monitores de busca" ligado em Configuração e chaves (grupo Monitores); depois de ligar, reinicie a Yui.';

/** Como o estado aparece (selo e tom). Estado desconhecido aparece como veio, sem tom. */
export function estadoDoMonitor(estado: string): { texto: string; tom: Tom } {
  const e = ESTADOS[String(estado ?? '')];
  if (e) return { texto: e.texto, tom: e.tom };
  const bruto = String(estado ?? '').trim();
  return { texto: bruto ? bruto.charAt(0).toUpperCase() + bruto.slice(1) : '—', tom: 'neutro' };
}

/** O assunto, no máximo 60 caracteres (o servidor já corta; aqui é só a garantia). Encerrado não tem assunto. */
export function assuntoDoMonitor(m: Pick<MonitorLike, 'consulta'>): string {
  const t = typeof m.consulta === 'string' ? m.consulta.replace(/\s+/g, ' ').trim() : '';
  if (!t) return 'Assunto apagado (monitor encerrado)';
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

const dois = (n: number) => String(n).padStart(2, '0');
const inicioDoDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "hoje às 14:30", "amanhã às 09:00", "ontem às 08:00" ou "28/11 às 10:00" (outro ano: "28/11/2027 às 10:00"); sem data ou inválida, "—". */
export function formatarQuando(iso: string | null | undefined, agora: Date = new Date()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const hora = `${dois(d.getHours())}:${dois(d.getMinutes())}`;
  const dias = Math.round((inicioDoDia(d) - inicioDoDia(agora)) / 86_400_000);
  if (dias === 0) return `hoje às ${hora}`;
  if (dias === 1) return `amanhã às ${hora}`;
  if (dias === -1) return `ontem às ${hora}`;
  const data = `${dois(d.getDate())}/${dois(d.getMonth() + 1)}${d.getFullYear() !== agora.getFullYear() ? `/${d.getFullYear()}` : ''}`;
  return `${data} às ${hora}`;
}

export interface VistaDoMonitor {
  id: number;
  titulo: string;
  estado: { texto: string; tom: Tom };
  linhas: { rotulo: string; valor: string }[];
  /** Por que encerrou ou como está a entrega de um aviso (ou null). */
  nota: string | null;
  podeCancelar: boolean;
}

/** Tudo o que o cartão mostra: assunto, estado, próxima checagem (só ativo), até quando e quantos avisos já saíram. */
export function vistaDoMonitor(m: MonitorLike, agora: Date = new Date()): VistaDoMonitor {
  const avisos = Number.isFinite(Number(m.avisos)) && Number(m.avisos) >= 0 ? Math.floor(Number(m.avisos)) : 0;
  const encerrado = m.estado === 'encerrado';
  const notas = [m.fim ? FIM[m.fim] ?? null : null, m.entrega ? ENTREGA[m.entrega] ?? null : null].filter(Boolean) as string[];
  return {
    id: m.id,
    titulo: assuntoDoMonitor(m),
    estado: estadoDoMonitor(m.estado),
    linhas: [
      { rotulo: 'Próxima checagem', valor: m.estado === 'ativo' ? formatarQuando(m.proximaChecagem, agora) : '—' },
      { rotulo: encerrado ? 'Valia até' : 'Até', valor: formatarQuando(m.ate, agora) },
      { rotulo: 'Avisos enviados', valor: String(avisos) },
    ],
    nota: notas.length ? notas.join(' ') : null,
    podeCancelar: !encerrado,
  };
}

/** Ativos primeiro (pela próxima checagem), depois pausados e por fim os encerrados; empate pelo número. Não altera a lista recebida. */
export function ordenarMonitores<T extends MonitorLike>(lista: T[]): T[] {
  const ordem = (e: string) => ESTADOS[e]?.ordem ?? 3;
  const quando = (m: T) => { const t = Date.parse(String(m.proximaChecagem ?? '')); return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
  return [...lista].sort((a, b) => ordem(a.estado) - ordem(b.estado) || (a.estado === 'ativo' && b.estado === 'ativo' ? quando(a) - quando(b) : 0) || a.id - b.id);
}

/** Resumo para o título: "2 ativos, 1 encerrado" / "Nenhum monitor". */
export function resumoDosMonitores(lista: MonitorLike[]): string {
  if (!lista.length) return 'Nenhum monitor';
  const conta = (e: string) => lista.filter((m) => m.estado === e).length;
  const partes: string[] = [];
  const a = conta('ativo');
  const p = conta('pausado');
  const f = conta('encerrado');
  if (a) partes.push(`${a} ${a === 1 ? 'ativo' : 'ativos'}`);
  if (p) partes.push(`${p} ${p === 1 ? 'pausado' : 'pausados'}`);
  if (f) partes.push(`${f} ${f === 1 ? 'encerrado' : 'encerrados'}`);
  const outros = lista.length - a - p - f;
  if (outros) partes.push(`${outros} em outro estado`);
  return partes.join(', ');
}

/** O texto da confirmação do botão "Cancelar" (cancelar é definitivo: o assunto é apagado e a Yui não confere mais). */
export function confirmacaoDeCancelamento(m: Pick<MonitorLike, 'id' | 'consulta'>): { titulo: string; mensagem: string; sim: string } {
  return {
    titulo: 'Cancelar este monitor?',
    mensagem: `#${m.id} · ${assuntoDoMonitor(m)}\n\nA Yui para de conferir e não manda mais avisos sobre isso. Não dá para desfazer.`,
    sim: 'Cancelar monitor',
  };
}
