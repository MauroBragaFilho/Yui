/**
 * Regras da seção "Planos e avisos" do Admin (lacunas do painel, entrega B, 26/11/2026; aprovar e recusar pelo painel na entrega E, 27/11/2026, com
 * YUI_PLANOS_PAINEL), sem React e sem rede (testáveis em Node).
 *  - Decisão (POST /v1/admin/planos/:id/decisao): só no plano "aguardando", dentro da validade e com `painel: true`. O servidor chama a MESMA decisão dos
 *    botões da DM; aqui só se decide quando mostrar os botões e o texto da confirmação. A frase da resposta é a do servidor.
 *  - Planos (GET /v1/admin/planos): os últimos 20, com o estado, as datas e, de cada passo, a ferramenta, o estado e o RESUMO SEGURO (correção C1 do parecer
 *    da Liz): a ação escrita pelo código do servidor (valores de lista fechada sim; texto livre só como tamanho), o serviço, o acesso e para onde vai. O
 *    servidor nunca manda os argumentos nem os resultados. Plano com texto da pessoa indo para fora (a pesquisa) só se aprova pela DM; recusar vale aqui.
 *  - Avisos (GET /v1/admin/avisos): o modo do filtro, a fila (o que está guardado e até quando) e o que o modo observar teria adiado. O servidor manda só o
 *    assunto já limpo (uma chave fixa ou o nome de uma família; null quando não dá para mostrar), a classe, o motivo e até quando: nunca o texto do aviso.
 * Nada aqui inventa dado: o que não veio aparece como "—".
 */
import { formatarQuando } from './monitoresLogic.ts';

export type Tom = 'ok' | 'atencao' | 'critico' | 'neutro';

export interface PlanoLike {
  id: string;
  versao: number;
  hash: string | null;
  estado: string;
  criadoEm: string | null;
  validade: string | null;
  aprovadoEm: string | null;
  aprovacao: string | null;
  encerradoEm: string | null;
  motivo: string | null;
  passos: { ferramenta: string; estado: string; resumo?: ResumoLike }[];
  /** Correção C1: só se aprova pela DM (servidor antigo não manda: vale o que ele decidir). */
  aprovarSoPelaDm?: boolean;
}

/** O resumo seguro de um passo (correção C1), como o servidor manda. */
export interface ResumoLike {
  acao: string;
  servico: string;
  acesso: string;
  saida: string;
  textoLivre: { campo: string; caracteres: number }[];
  soPelaDm: boolean;
}

const SAIDAS: Record<string, string> = {
  internet: 'as palavras saem para o buscador',
  google: 'lê da sua conta Google',
  'rede-local': 'fica na rede de casa',
  nao: 'não sai do computador da Yui',
};

/** A linha de detalhe de um passo: serviço · acesso · para onde vai · texto livre (só o tamanho). Sem resumo (servidor antigo), null. */
export function detalheDoPasso(r: ResumoLike | null | undefined): string | null {
  if (!r || typeof r !== 'object') return null;
  const partes = [
    String(r.servico ?? '').trim() || 'Serviço desconhecido',
    r.acesso === 'leitura' ? 'só leitura' : 'acesso desconhecido',
    SAIDAS[r.saida] ?? 'destino desconhecido',
  ];
  for (const t of Array.isArray(r.textoLivre) ? r.textoLivre : []) {
    const n = Number(t?.caracteres);
    partes.push(`${String(t?.campo ?? 'texto')}: ${Number.isFinite(n) && n >= 0 ? n : '?'} ${n === 1 ? 'caractere' : 'caracteres'} (o texto está na DM)`);
  }
  return partes.join(' · ');
}

/** O texto de um passo: a ação do resumo (escrita pelo servidor); sem resumo, o nome da ferramenta. */
const textoDoPasso = (s: { ferramenta: string; resumo?: ResumoLike }): string => {
  const acao = typeof s?.resumo?.acao === 'string' ? s.resumo.acao.trim() : '';
  return acao || nomeDaFerramenta(s?.ferramenta);
};

const ESTADOS_DO_PLANO: Record<string, { texto: string; tom: Tom; ativo: boolean }> = {
  a_entregar: { texto: 'Enviando para a DM', tom: 'atencao', ativo: true },
  aguardando: { texto: 'Aguardando aprovação', tom: 'atencao', ativo: true },
  aprovado: { texto: 'Aprovado', tom: 'ok', ativo: true },
  executando: { texto: 'Em execução', tom: 'ok', ativo: true },
  concluido: { texto: 'Concluído', tom: 'ok', ativo: false },
  interrompido: { texto: 'Interrompido', tom: 'critico', ativo: false },
  cancelado: { texto: 'Cancelado', tom: 'neutro', ativo: false },
  recusado: { texto: 'Recusado', tom: 'neutro', ativo: false },
  expirado: { texto: 'Expirou', tom: 'neutro', ativo: false },
  falhou: { texto: 'Falhou', tom: 'critico', ativo: false },
};
const MOTIVOS: Record<string, string> = {
  concluido: 'Todos os passos foram feitos e o resultado saiu pela DM.',
  interrompido: 'Parou no meio (um passo falhou, passou do tempo ou a permissão mudou); a Yui não repete sozinha.',
  cancelado: 'Você cancelou ("cancela o plano").',
  recusado: 'Você recusou; nada foi feito.',
  expirado: 'Ninguém aprovou em 30 minutos (ou a mensagem não chegou a tempo).',
  falhou: 'Não deu para entregar ou o plano mudou depois de criado; nada foi feito.',
};
const PASSOS: Record<string, { texto: string; tom: Tom }> = {
  pendente: { texto: 'pendente', tom: 'neutro' },
  executando: { texto: 'em execução', tom: 'atencao' },
  feito: { texto: 'feito', tom: 'ok' },
  falhou: { texto: 'falhou', tom: 'critico' },
  incerto: { texto: 'incerto (não repetido)', tom: 'critico' },
};
const FERRAMENTAS: Record<string, string> = {
  biblioteca_buscar: 'Biblioteca: buscar',
  biblioteca_listar: 'Biblioteca: listar pasta',
  biblioteca_recentes: 'Biblioteca: recentes',
  biblioteca_estado: 'Biblioteca: estado',
  agenda: 'Agenda do Google',
  tarefas: 'Tarefas do Google',
  pesquisa: 'Pesquisa na web',
  lembretes: 'Lembretes',
  listas: 'Listas',
  computador: 'Estado do computador',
};

/** Como o estado do plano aparece (selo e tom). Desconhecido aparece como veio, sem tom. */
export function estadoDoPlano(estado: string): { texto: string; tom: Tom } {
  const e = ESTADOS_DO_PLANO[String(estado ?? '')];
  if (e) return { texto: e.texto, tom: e.tom };
  const bruto = String(estado ?? '').trim();
  return { texto: bruto ? bruto.charAt(0).toUpperCase() + bruto.slice(1) : '—', tom: 'neutro' };
}

/** O nome legível de uma ferramenta de plano (desconhecida aparece como veio). */
export function nomeDaFerramenta(nome: string): string {
  const n = String(nome ?? '').trim();
  return FERRAMENTAS[n] ?? (n || '—');
}

export interface VistaDoPlano {
  id: string;
  titulo: string;
  estado: { texto: string; tom: Tom };
  linhas: { rotulo: string; valor: string }[];
  passos: { texto: string; detalhe: string | null; estado: string; tom: Tom }[];
  nota: string | null;
}

/** Tudo o que o cartão de um plano mostra. */
export function vistaDoPlano(p: PlanoLike, agora: Date = new Date()): VistaDoPlano {
  const passos = Array.isArray(p.passos) ? p.passos : [];
  const feitos = passos.filter((s) => s.estado === 'feito').length;
  const ativo = ESTADOS_DO_PLANO[p.estado]?.ativo === true;
  const linhas = [
    { rotulo: 'Criado', valor: formatarQuando(p.criadoEm, agora) },
    { rotulo: 'Passos feitos', valor: `${feitos} de ${passos.length}` },
  ];
  if (p.aprovadoEm) linhas.push({ rotulo: p.aprovacao === 'automatica' ? 'Aprovado automaticamente' : 'Aprovado por você', valor: formatarQuando(p.aprovadoEm, agora) });
  if (ativo && p.validade) linhas.push({ rotulo: 'Aprovação vale até', valor: formatarQuando(p.validade, agora) });
  if (p.encerradoEm) linhas.push({ rotulo: 'Encerrado', valor: formatarQuando(p.encerradoEm, agora) });
  return {
    id: p.id,
    titulo: `Plano ${String(p.id ?? '').slice(0, 12)}${p.versao > 1 ? ` (versão ${p.versao})` : ''}`,
    estado: estadoDoPlano(p.estado),
    linhas,
    passos: passos.map((s, i) => {
      const e = PASSOS[s.estado] ?? { texto: String(s.estado ?? '—'), tom: 'neutro' as Tom };
      return { texto: `${i + 1}. ${textoDoPasso(s)}`, detalhe: detalheDoPasso(s.resumo), estado: e.texto, tom: e.tom };
    }),
    nota: p.motivo ? MOTIVOS[p.motivo] ?? null : null,
  };
}

/** Resumo para o título: "1 aguardando aprovação, 3 encerrados" / "Nenhum plano". */
export function resumoDosPlanos(lista: PlanoLike[]): string {
  if (!lista.length) return 'Nenhum plano';
  const ativos = lista.filter((p) => ESTADOS_DO_PLANO[p.estado]?.ativo === true);
  const aguardando = ativos.filter((p) => p.estado === 'aguardando' || p.estado === 'a_entregar').length;
  const andamento = ativos.length - aguardando;
  const fim = lista.length - ativos.length;
  const partes: string[] = [];
  if (aguardando) partes.push(`${aguardando} aguardando aprovação`);
  if (andamento) partes.push(`${andamento} em andamento`);
  if (fim) partes.push(`${fim} ${fim === 1 ? 'encerrado' : 'encerrados'}`);
  return partes.join(', ');
}

/** O aviso da tela com os planos desligados (YUI_PLANOS) ou com o arquivo ilegível, e por onde aprovar (DM e, com `painel`, também aqui). */
export function avisoDosPlanos(r: { ligado: boolean; auto: boolean; ilegivel: boolean; painel?: boolean } | null): string | null {
  if (!r) return null;
  if (r.ilegivel) return 'Não consegui ler o arquivo dos planos (planos.json). A Yui não executa nada enquanto ele estiver assim.';
  if (!r.ligado) return 'Os planos estão desligados ("Planos com aprovação" em Configuração e chaves). A lista mostra o que sobrou de antes, por até 7 dias.';
  const onde = r.painel === true
    ? 'Aprove ou recuse aqui ou pelos botões da DM: as regras são as mesmas e a primeira decisão vale.'
    : 'Aprovar pelo painel está desligado ("Aprovar e recusar planos pelo painel" em Configuração e chaves); use os botões da DM.';
  return r.auto
    ? `Aprovação automática ligada: os planos de leitura começam sem esperar você (a pesquisa na web continua pedindo). ${onde}`
    : `Os planos esperam a sua aprovação. ${onde}`;
}

// ── Decisão pelo painel (entrega E) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Os botões Aprovar e Recusar aparecem? Só com `painel: true`, no plano "aguardando", com o hash e dentro da validade (o servidor confere tudo de novo). */
export function podeDecidir(p: PlanoLike, r: { ligado?: boolean; painel?: boolean } | null | undefined, agora: Date = new Date()): boolean {
  if (!r || r.ligado !== true || r.painel !== true || !p || p.estado !== 'aguardando') return false;
  if (typeof p.hash !== 'string' || !/^[0-9a-f]{16,128}$/.test(p.hash) || !(Number(p.versao) >= 1)) return false;
  const validade = Date.parse(String(p.validade ?? ''));
  return !Number.isNaN(validade) && validade > agora.getTime();
}

/**
 * Correção C1: o botão Aprovar aparece? Só quando a decisão vale (podeDecidir) e o plano NÃO manda texto da pessoa para fora. Plano com pesquisa (ou passo
 * que o servidor não sabe resumir): Recusar continua aqui, a aprovação é pela DM. O servidor confere de novo (409).
 */
export function podeAprovar(p: PlanoLike, r: { ligado?: boolean; painel?: boolean } | null | undefined, agora: Date = new Date()): boolean {
  if (!podeDecidir(p, r, agora)) return false;
  if (p.aprovarSoPelaDm === true) return false;
  return (Array.isArray(p.passos) ? p.passos : []).every((s) => s?.resumo?.soPelaDm !== true);
}

/** O aviso no lugar do Aprovar, quando a aprovação é só pela DM. */
export const TEXTO_APROVAR_PELA_DM = 'Este plano manda palavras para o buscador, e o painel não mostra esse texto: aprove pela DM, onde ele aparece. Recusar funciona aqui.';

/** O corpo da decisão: o id vai no caminho; a versão e o prefixo do hash que a lista mostrou (qualquer diferença, o servidor recusa). */
export function pedidoDeDecisao(p: Pick<PlanoLike, 'versao' | 'hash'>, aprovar: boolean): { versao: number; hash: string; aprovar: boolean } {
  return { versao: Number(p.versao), hash: String(p.hash ?? ''), aprovar: aprovar === true };
}

/** A confirmação de Aprovar: "Executar estes N passos de leitura?", com a ação de cada passo (o resumo seguro do servidor; os textos livres ficam na DM). */
export function confirmacaoDeAprovacao(p: Pick<PlanoLike, 'passos'>): { titulo: string; mensagem: string; sim: string } {
  const passos = Array.isArray(p.passos) ? p.passos : [];
  const n = passos.length;
  const pergunta = n === 1 ? 'Executar este 1 passo de leitura?' : `Executar estes ${n} passos de leitura?`;
  const lista = passos.map((s, i) => {
    const detalhe = detalheDoPasso(s.resumo);
    return `${i + 1}. ${textoDoPasso(s)}${detalhe ? `\n   ${detalhe}` : ''}`;
  }).join('\n');
  return {
    titulo: 'Aprovar o plano',
    mensagem: `${pergunta}${lista ? `\n\n${lista}` : ''}\n\nOs detalhes de cada passo estão na mensagem da DM. O resultado chega pela DM.`,
    sim: 'Aprovar',
  };
}

/** A frase da resposta (a do servidor) com o tom: aprovado ou recusado com sucesso = ok; a regra recusou = atenção. */
export function resultadoDaDecisao(r: { ok: boolean; texto: string } | null | undefined): { texto: string; tom: Tom } | null {
  if (!r) return null;
  const texto = String(r.texto ?? '').trim() || (r.ok ? 'Pronto.' : 'Não consegui decidir agora.');
  return { texto, tom: r.ok ? 'ok' : 'atencao' };
}

// ── Avisos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AvisoLike { assunto: string | null; classe: string; motivo: string | null; ate: string | null; em?: string | null; criadoEm?: string | null; acao?: string; estado?: string }

const ASSUNTOS: Record<string, string> = {
  'google-reautorizar': 'Google: autorizar de novo',
  'ai-down': 'IA fora do ar',
  'evento:disco': 'Disco quase cheio',
  'evento:ram': 'RAM apertada',
  'evento:internet': 'Internet caiu',
  'evento:internet-voltou': 'Internet voltou',
  'evento:supervisor': 'Supervisor religou a Yui',
  'ia-local-privada-fora': 'IA local privada fora',
  'ia-perfil-privado-fechado': 'Perfil privado de IA fechado',
  'media:opus': 'Voz sem codificador Opus',
  'memory-purge': 'Limpeza da memória',
  'weekly-publish': 'Publicação do semanal do GTA',
  weekly: 'Semanal do GTA',
  boot: 'A Yui ligou',
  youtube: 'Aviso do YouTube',
  twitch: 'Aviso da Twitch',
  'monitor:novidade': 'Novidade de um monitor',
  'monitor:fim': 'Fim de um monitor',
  matinal: 'Resumo da manhã',
  'health-daily': 'Relatório de saúde',
  lembrete: 'Lembrete',
  provider: 'Provedor de IA parou',
  crash: 'Falha grave',
};
const CLASSES: Record<string, string> = { critico: 'crítico', 'hora-marcada': 'hora marcada', importante: 'importante', informativo: 'informativo', resumo: 'resumo' };
const MOTIVOS_DO_AVISO: Record<string, string> = {
  silencio: 'horário de silêncio',
  teto: 'teto do dia (vai no resumo da manhã)',
  falha: 'o envio falhou; tenta de novo',
  'teto-assunto-repetido': 'repetido acima do teto (seria descartado)',
};

/** O nome do assunto. Sem assunto (o servidor não pode mostrar): só a classe. */
export function rotuloDoAviso(a: Pick<AvisoLike, 'assunto' | 'classe'>): string {
  const classe = CLASSES[a.classe] ?? (String(a.classe ?? '') || 'sem classe');
  if (!a.assunto) return `Aviso ${classe}`;
  return ASSUNTOS[a.assunto] ?? a.assunto;
}
export const classeDoAviso = (classe: string): string => CLASSES[classe] ?? (String(classe ?? '') || '—');
export const motivoDoAviso = (motivo: string | null | undefined): string => (motivo ? MOTIVOS_DO_AVISO[motivo] ?? motivo : '—');

export interface LinhaDeAviso { titulo: string; detalhe: string; tom: Tom }

/** Uma linha da fila: "Aviso do YouTube" · "informativo · horário de silêncio · sai hoje às 07:00". */
export function linhaDaFila(a: AvisoLike, agora: Date = new Date()): LinhaDeAviso {
  const quando = a.ate ? `sai ${formatarQuando(a.ate, agora)}` : 'sai na próxima passada';
  const enviando = a.estado === 'enviando' ? ' · enviando agora' : '';
  return { titulo: rotuloDoAviso(a), detalhe: `${classeDoAviso(a.classe)} · ${motivoDoAviso(a.motivo)} · ${quando}${enviando}`, tom: a.motivo === 'falha' ? 'critico' : 'atencao' };
}

/** Uma linha do modo observar: "teria adiado" ou "teria descartado", quando, o motivo e até quando. */
export function linhaObservada(a: AvisoLike, agora: Date = new Date()): LinhaDeAviso {
  const acao = a.acao === 'descartar' ? 'teria descartado' : 'teria adiado';
  const ate = a.acao !== 'descartar' && a.ate ? ` até ${formatarQuando(a.ate, agora)}` : '';
  return { titulo: rotuloDoAviso(a), detalhe: `${formatarQuando(a.em ?? null, agora)} · ${acao}${ate} · ${motivoDoAviso(a.motivo)}`, tom: a.acao === 'descartar' ? 'critico' : 'neutro' };
}

/** O texto do modo do filtro de avisos. */
export function textoDoModo(modo: string): { titulo: string; texto: string; tom: Tom } {
  if (modo === 'ligar') return { titulo: 'Filtro ligado', texto: 'Os avisos fora de hora (silêncio ou teto do dia) ficam guardados e saem depois. Críticos e lembretes saem sempre na hora.', tom: 'ok' };
  if (modo === 'observar') return { titulo: 'Filtro só observando', texto: 'Tudo ainda sai na hora; abaixo está o que o filtro teria adiado, desde que cada processo ligou.', tom: 'atencao' };
  return { titulo: 'Filtro desligado', texto: 'Todos os avisos saem na hora. Para observar ou ligar o filtro, use "Avisos na hora certa" em Configuração e chaves.', tom: 'neutro' };
}

const ORIGENS: Record<string, string> = { cerebro: 'Cérebro', bot: 'Bot do Discord', unico: 'Yui' };
export const nomeDaOrigem = (origem: string): string => ORIGENS[origem] ?? origem;

/** As decisões registradas, da mais nova para a mais antiga (não altera a lista recebida). */
export function ordenarObservados<T extends { em?: string | null }>(lista: T[] | null | undefined): T[] {
  const t = (x: T) => { const n = Date.parse(String(x.em ?? '')); return Number.isNaN(n) ? 0 : n; };
  return [...(Array.isArray(lista) ? lista : [])].sort((a, b) => t(b) - t(a));
}

/** "3 enviados na hora, 2 teriam sido adiados" para o cabeçalho de cada processo. */
export function resumoDaContagem(c: { enviar: number; adiar: number; descartar: number } | null | undefined): string {
  if (!c) return '—';
  const partes = [`${c.enviar} ${c.enviar === 1 ? 'enviado' : 'enviados'} na hora`];
  if (c.adiar) partes.push(`${c.adiar} ${c.adiar === 1 ? 'teria sido adiado' : 'teriam sido adiados'}`);
  if (c.descartar) partes.push(`${c.descartar} ${c.descartar === 1 ? 'teria sido descartado' : 'teriam sido descartados'}`);
  return partes.join(', ');
}
