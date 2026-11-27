/**
 * Regras do Início para as "contas da Yui" (lacunas do painel, entrega B, 26/11/2026), sem React e sem rede (testáveis em Node):
 *  - o cartão "Live do YouTube", que só aparece enquanto a Yui está numa live (GET /v1/admin/live);
 *  - os avisos do Google (GET /v1/admin/google): autorização perto de vencer (menos de 2 dias, na regra de 7 dias do modo Testando), renovação falhando
 *    e autorizar de novo.
 * O servidor nunca manda texto do chat, autor, token nem segredo; aqui nada é inventado: o que não veio aparece como "—" ou não aparece.
 */
import { formatarQuando } from './monitoresLogic.ts';

export type TomDaConta = 'ok' | 'atencao' | 'critico' | 'neutro';
/** O mesmo formato dos avisos do Início (AlertItem em overviewLogic.ts). */
export interface AvisoDaConta { text: string; level: 'warn' | 'danger' }

export interface LiveLike {
  ligado: boolean;
  disponivel?: boolean;
  estado: string;
  ativo: boolean;
  live: { videoId: string | null; titulo: string | null } | null;
  desde: string | null;
  mensagens: { lidas: number; respondidas: number; espontaneas: number } | null;
  cota: { usado: number; limiteDiario: number; reserva?: number; restante?: number; nivel: string } | null;
  ultimoErro: { codigo: string; em: string | null } | null;
}

export interface GoogleLike {
  ligado: boolean;
  conectado: boolean;
  venceEm: string | null;
  ultimaRenovacaoEm: string | null;
  ultimoErro: { codigo: string; em: string | null } | null;
  renovacaoFalhou: boolean;
  precisaAutorizar: boolean;
  motivoDeAutorizar: string | null;
}

const ERROS_DA_LIVE: Record<string, string> = {
  removida: 'o YouTube tirou o acesso ao chat (removida, silenciada ou banida)',
  cota_esgotada: 'a cota diária da API do YouTube acabou',
  'cota-esgotada': 'a cota diária da API do YouTube acabou',
  erro_permanente: 'deu um erro que não passa sozinho',
  'leituras-falharam': 'as leituras do chat falharam várias vezes seguidas',
  'nao-escreve': 'o YouTube não deixou escrever no chat',
  'sem-credencial': 'falta a autorização do canal da Yui',
  'nao-autenticado': 'o YouTube recusou a autorização do canal',
  'sem-permissao': 'o YouTube negou o acesso',
  'sem-chat': 'o chat não foi encontrado (a live ainda não começou ou o chat está desligado)',
  'live-acabou': 'a live já tinha acabado',
  'nao-e-live': 'o vídeo não é uma transmissão ao vivo',
  'video-nao-encontrado': 'o vídeo não foi encontrado',
  'falha-temporaria': 'o YouTube não respondeu naquela hora',
  'link-invalido': 'o link não era de uma live',
  'host-nao-permitido': 'o link não era do YouTube',
  'sem-video': 'o link não tinha o vídeo',
  'ja-esta-numa-live': 'ela já estava numa live',
};

/** O último erro da live em português (código desconhecido aparece como código, sem inventar). */
export function textoDoErroDaLive(codigo: string | null | undefined): string {
  const c = String(codigo ?? '').trim();
  if (!c) return '—';
  return ERROS_DA_LIVE[c] ?? `erro (código ${c.slice(0, 40)})`;
}

/** Quanto tempo desde um instante: "12 min", "1 h 05 min", "3 h". Sem data, data inválida ou no futuro: null. */
export function duracaoDesde(iso: string | null | undefined, agora: Date = new Date()): string | null {
  const t = Date.parse(String(iso ?? ''));
  if (Number.isNaN(t)) return null;
  const min = Math.floor((agora.getTime() - t) / 60_000);
  if (min < 0) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

const inteiro = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const TOM_DA_COTA: Record<string, TomDaConta> = { ok: 'ok', atencao: 'atencao', critico: 'critico', esgotada: 'critico' };

export interface CartaoDaLive {
  titulo: string;
  estado: { texto: string; tom: TomDaConta };
  linhas: { rotulo: string; valor: string }[];
  /** A barra da cota do dia (percentual do limite contado pela Yui) ou null se o servidor não mandou. */
  cota: { percentual: number; tom: TomDaConta; texto: string } | null;
  nota: string | null;
}

/**
 * O cartão "Live do YouTube" do Início. null quando não há o que mostrar: sem resposta, live desligada ou a Yui fora de uma live (o cartão só existe
 * enquanto ela está procurando o chat ou ouvindo).
 */
export function cartaoDaLive(v: LiveLike | null | undefined, agora: Date = new Date()): CartaoDaLive | null {
  if (!v || v.ligado !== true || v.ativo !== true) return null;
  const titulo = (v.live?.titulo ?? '').trim() || (v.live?.videoId ? `Vídeo ${v.live.videoId}` : 'Live sem título');
  const ouvindo = v.estado === 'ouvindo';
  const desde = v.desde ? `${formatarQuando(v.desde, agora)}${duracaoDesde(v.desde, agora) ? ` (há ${duracaoDesde(v.desde, agora)})` : ''}` : '—';
  const m = v.mensagens;
  const linhas = [
    { rotulo: 'Desde', valor: desde },
    { rotulo: 'Mensagens lidas', valor: m ? String(inteiro(m.lidas)) : '—' },
    { rotulo: 'Respostas dela', valor: m ? `${inteiro(m.respondidas)}${inteiro(m.espontaneas) ? ` (+${inteiro(m.espontaneas)} puxando assunto)` : ''}` : '—' },
  ];
  let cota: CartaoDaLive['cota'] = null;
  if (v.cota && inteiro(v.cota.limiteDiario) > 0) {
    const usado = inteiro(v.cota.usado);
    const limite = inteiro(v.cota.limiteDiario);
    const percentual = Math.min(100, Math.round((usado / limite) * 100));
    cota = { percentual, tom: TOM_DA_COTA[v.cota.nivel] ?? 'neutro', texto: `${usado.toLocaleString('pt-BR')} de ${limite.toLocaleString('pt-BR')} unidades (${percentual}%)` };
  }
  linhas.push({ rotulo: 'Cota de hoje', valor: cota ? cota.texto : '—' });
  // Só o erro que aconteceu DEPOIS de entrar nesta live (o de antes não diz nada sobre ela).
  const erro = v.ultimoErro && v.desde && v.ultimoErro.em && Date.parse(v.ultimoErro.em) >= Date.parse(v.desde) ? v.ultimoErro : null;
  return {
    titulo,
    estado: ouvindo ? { texto: 'No chat', tom: 'ok' } : { texto: 'Procurando o chat', tom: 'atencao' },
    linhas,
    cota,
    nota: erro ? `Último erro: ${textoDoErroDaLive(erro.codigo)}.` : null,
  };
}

/** A partir de quanto tempo antes do vencimento o Início avisa (2 dias). */
export const AVISO_DE_VENCIMENTO_MS = 2 * 86_400_000;

/** "em 1 dia e 3 h", "em 5 h", "em 40 min". */
function faltam(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `em ${h} h`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return `em ${d} dia${d === 1 ? '' : 's'}${r ? ` e ${r} h` : ''}`;
}

/**
 * Os avisos do Google para o Início. Lista vazia = nada a avisar (desligado, sem resposta do servidor ou tudo certo).
 *  - autorizar de novo (o Google recusou, falta o arquivo ou ele não abre): problema;
 *  - a renovação do acesso falhou (rede ou erro) e não voltou desde então: atenção;
 *  - menos de 2 dias para os 7 dias do modo Testando: atenção; passou dos 7 dias sem renovar depois disso: problema. Se renovou depois dos 7 dias, o
 *    projeto não está em modo Testando e não há aviso.
 */
export function alertasDoGoogle(g: GoogleLike | null | undefined, agora: Date = new Date()): AvisoDaConta[] {
  if (!g || g.ligado !== true) return [];
  if (g.motivoDeAutorizar === 'recusada') return [{ level: 'danger', text: 'O Google recusou a autorização guardada: a Agenda e as Tarefas pararam. Autorize de novo (scripts/google-autorizar.mjs).' }];
  if (g.motivoDeAutorizar === 'sem-arquivo') return [{ level: 'danger', text: 'O Google está ligado, mas falta a autorização (rode scripts/google-autorizar.mjs).' }];
  if (g.precisaAutorizar || !g.conectado) return [{ level: 'danger', text: 'O arquivo da autorização do Google não pôde ser lido: autorize de novo (scripts/google-autorizar.mjs).' }];
  const out: AvisoDaConta[] = [];
  if (g.renovacaoFalhou) {
    out.push({ level: 'warn', text: `A renovação do acesso ao Google falhou${g.ultimoErro?.codigo === 'rede' ? ' (rede)' : ''}. A Yui tenta de novo sozinha; se continuar, a Agenda para.` });
  }
  const vence = Date.parse(String(g.venceEm ?? ''));
  if (!Number.isNaN(vence)) {
    const resta = vence - agora.getTime();
    const renovou = Date.parse(String(g.ultimaRenovacaoEm ?? ''));
    if (resta <= 0) {
      if (Number.isNaN(renovou) || renovou < vence) out.push({ level: 'danger', text: 'A autorização do Google passou dos 7 dias do modo Testando: se a Agenda parou, autorize de novo (scripts/google-autorizar.mjs).' });
    } else if (resta < AVISO_DE_VENCIMENTO_MS) {
      out.push({ level: 'warn', text: `A autorização do Google vence ${faltam(resta)} (modo Testando): renove com scripts/google-autorizar.mjs antes que a Agenda pare.` });
    }
  }
  return out;
}
