/**
 * Regras da tela "Visão Geral", sem React e sem rede (testáveis em Node): saudação, tempo ligada, nível de RAM/disco,
 * texto de "há quanto tempo" e como cada evento do registro de auditoria aparece para o dono.
 * Nada aqui inventa número: o que a API não trouxe vira null e a tela mostra "—".
 */
import { alertasDoGoogle, type GoogleLike } from './contasLogic.ts';

export type Level = 'ok' | 'warn' | 'danger' | 'unknown';

/** "Bom dia" (5h às 11h59), "Boa tarde" (12h às 17h59) e "Boa noite" (o resto). */
export function greetingFor(hour: number): string {
  if (!Number.isFinite(hour)) return 'Olá';
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** 93784 s -> "1d 2h"; 5400 -> "1h 30min"; 90 -> "1min"; inválido -> "—". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

/** Percentual inteiro de `part` em `total`; null se não der para calcular. */
export function percent(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part === null || part === undefined || total === null || total === undefined) return null;
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

/**
 * Barra de RAM ou disco no padrão que se lê de relance: a barra mostra o que está EM USO (cheia = lotado), e o texto diz quanto está
 * livre. (Antes a barra mostrava o livre: disco com 91% livre aparecia quase cheio e parecia lotado.) Sem leitura: tudo null.
 */
export function medidorDeUso(livre: number | null | undefined, total: number | null | undefined, unidade: 'MB' | 'GB'): { usadoPercent: number | null; detalhe: string | null } {
  const livrePercent = percent(livre, total);
  if (livrePercent === null || livre === null || livre === undefined || total === null || total === undefined) return { usadoPercent: null, detalhe: null };
  const casas = unidade === 'GB' ? 1 : 0;
  const fmt = (v: number) => Math.max(0, v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  return { usadoPercent: 100 - livrePercent, detalhe: `${fmt(total - livre)} ${unidade} em uso de ${fmt(total)} ${unidade} · ${fmt(livre)} ${unidade} livres` };
}

/**
 * Cor da barra de RAM/disco: no normal, a cor da Yui (roxo); só muda quando há motivo, amarelo se apertado e vermelho se crítico.
 * Assim a cor de alerta continua chamando atenção, porque só aparece quando precisa.
 */
export function corDoMedidor(level: Level): 'yui' | 'atencao' | 'critico' {
  return level === 'danger' ? 'critico' : level === 'warn' ? 'atencao' : 'yui';
}

/** Quanto MENOS livre, pior: abaixo de 15% livre é atenção, abaixo de 8% é crítico. */
export function levelForFree(freePercent: number | null): Level {
  if (freePercent === null) return 'unknown';
  if (freePercent < 8) return 'danger';
  if (freePercent < 15) return 'warn';
  return 'ok';
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "agora", "há 5 min", "há 3 h", "há 2 d"; sem data legível, "—". */
export function relativeTime(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, now - t);
  if (diff < MIN) return 'agora';
  if (diff < HOUR) return `há ${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`;
  return `há ${Math.floor(diff / DAY)} d`;
}

export interface EventView { label: string; icon: string; tone: 'normal' | 'good' | 'bad' }

const EXACT: Record<string, EventView> = {
  'api.chat': { label: 'Conversa pelo app', icon: 'chat_bubble', tone: 'normal' },
  'memory.write': { label: 'Memória atualizada', icon: 'psychology', tone: 'normal' },
  'memory.read': { label: 'Memória consultada', icon: 'psychology', tone: 'normal' },
  'memory.forget': { label: 'Lembrança apagada', icon: 'delete', tone: 'normal' },
  'memory.forgetAll': { label: 'Memória apagada', icon: 'delete', tone: 'normal' },
  'context.forgetAll': { label: 'Contexto das conversas apagado', icon: 'delete', tone: 'normal' },
  'agent.tool.ok': { label: 'Ferramenta executada', icon: 'build', tone: 'good' },
  'agent.tool.error': { label: 'Ferramenta com erro', icon: 'warning', tone: 'bad' },
  'agent.tool.denied': { label: 'Ferramenta negada', icon: 'lock', tone: 'bad' },
  'agent.tool.pending': { label: 'Ferramenta aguardando aprovação', icon: 'schedule', tone: 'normal' },
  'agent.tool.cancelled': { label: 'Ferramenta cancelada', icon: 'cancel', tone: 'normal' },
  'agent.tool.badargs': { label: 'Ferramenta com argumentos inválidos', icon: 'warning', tone: 'bad' },
  'agent.skill': { label: 'Habilidade usada', icon: 'bolt', tone: 'normal' },
  'auth.login.ok': { label: 'Login no painel', icon: 'lock', tone: 'good' },
  'auth.login.fail': { label: 'Tentativa de login recusada', icon: 'lock', tone: 'bad' },
  'auth.logout': { label: 'Saída do painel', icon: 'logout', tone: 'normal' },
  'alert.sent': { label: 'Alerta enviado ao dono', icon: 'notifications', tone: 'normal' },
  'alert.fail': { label: 'Falha ao enviar alerta', icon: 'warning', tone: 'bad' },
  'admin.restart': { label: 'Yui reiniciada pelo painel', icon: 'refresh', tone: 'normal' },
  'admin.restart.recusado': { label: 'Reinício pedido e recusado pelo supervisor (nada reiniciou)', icon: 'warning', tone: 'bad' },
  'admin.follow.youtube.liveMode': { label: 'Modo das lives alterado', icon: 'tune', tone: 'normal' },
  'admin.follow.youtube.add': { label: 'Canal do YouTube adicionado', icon: 'hub', tone: 'normal' },
  'admin.follow.youtube.remove': { label: 'Canal do YouTube removido', icon: 'hub', tone: 'normal' },
  'admin.follow.twitch.add': { label: 'Streamer da Twitch adicionado', icon: 'hub', tone: 'normal' },
  'admin.follow.twitch.remove': { label: 'Streamer da Twitch removido', icon: 'hub', tone: 'normal' },
  'admin.ban.add': { label: 'Bloqueio aplicado', icon: 'lock', tone: 'normal' },
  'admin.ban.remove': { label: 'Bloqueio removido', icon: 'lock', tone: 'normal' },
  // Segurança (motor de política e aprovações): nomes internos viram frases.
  'policy.evaluate': { label: 'Permissão conferida', icon: 'lock', tone: 'normal' },
  'policy.violation': { label: 'Tentativa barrada pela segurança', icon: 'lock', tone: 'bad' },
  'policy.approval_created': { label: 'Aprovação pedida ao dono', icon: 'schedule', tone: 'normal' },
  'policy.approved': { label: 'Aprovação concedida', icon: 'check_circle', tone: 'good' },
  'policy.rejected': { label: 'Aprovação recusada', icon: 'cancel', tone: 'normal' },
  'policy.expired': { label: 'Aprovação expirou', icon: 'schedule', tone: 'normal' },
  'policy.enacted': { label: 'Ação aprovada executada', icon: 'check_circle', tone: 'good' },
  'auth.discord.verify.ok': { label: 'Entrada pelo Discord', icon: 'lock', tone: 'good' },
  'auth.discord.verify.fail': { label: 'Chave do Discord recusada', icon: 'lock', tone: 'bad' },
  'auth.discord.request.fail': { label: 'Falha ao enviar a chave pelo Discord', icon: 'lock', tone: 'bad' },
  'reminder.fire': { label: 'Lembrete enviado', icon: 'alarm', tone: 'normal' },
  'reminder.drop': { label: 'Lembrete descartado', icon: 'alarm', tone: 'bad' },
  'alert.adiado': { label: 'Aviso ao dono adiado', icon: 'notifications', tone: 'normal' },
  'channel.violation': { label: 'Pedido barrado no canal interno', icon: 'lock', tone: 'bad' },
  'channel.dm_incerta': { label: 'Mensagem privada com entrega incerta', icon: 'warning', tone: 'bad' },
  'api.prerota': { label: 'Comando reconhecido no app', icon: 'chat_bubble', tone: 'normal' },
  'api.agent': { label: 'Pedido ao agente pelo app', icon: 'chat_bubble', tone: 'normal' },
  'api.imagem': { label: 'Imagem pelo Chat do app', icon: 'chat_bubble', tone: 'normal' },
  'monitor.cancelado': { label: 'Monitor cancelado', icon: 'cancel', tone: 'normal' },
};

const PREFIX: [string, EventView][] = [
  ['auth.discord', { label: 'Entrada pelo Discord', icon: 'lock', tone: 'normal' }],
  ['policy.', { label: 'Verificação de segurança', icon: 'lock', tone: 'normal' }],
  ['reminder.', { label: 'Lembrete', icon: 'alarm', tone: 'normal' }],
  ['memory.admin', { label: 'Administração de memória', icon: 'psychology', tone: 'normal' }],
  ['dev.', { label: 'Módulo de código', icon: 'code', tone: 'normal' }],
  ['admin.', { label: 'Ajuste feito no painel', icon: 'tune', tone: 'normal' }],
];

/** Como um evento da auditoria aparece na lista: texto simples, ícone e tom. Evento desconhecido mostra o próprio nome. */
export function describeEvent(event: string): EventView {
  const key = String(event ?? '');
  if (EXACT[key]) return EXACT[key];
  for (const [prefix, view] of PREFIX) if (key.startsWith(prefix)) return view;
  return { label: key || 'Evento', icon: 'history', tone: 'normal' };
}

export interface GroupedEvent extends EventView { ts: string | null; count: number }

/** Junta eventos iguais seguidos ("Módulo de código" ×5) e mantém a hora do mais recente. Entrada: do mais novo para o mais antigo. */
export function groupEvents(events: { ts: string | null; event: string }[]): GroupedEvent[] {
  const out: GroupedEvent[] = [];
  for (const e of events) {
    const view = describeEvent(e.event);
    const last = out[out.length - 1];
    if (last && last.label === view.label) last.count += 1;
    else out.push({ ...view, ts: e.ts, count: 1 });
  }
  return out;
}

export interface SummaryInput { discordOnline: boolean; aiOk: boolean | null; hostLevel: Level }

/** Frase do cartão de saudação: diz a verdade sobre o estado, sem prometer "tudo certo" quando não está. */
export function systemSummary({ discordOnline, aiOk, hostLevel, avisos = 0 }: SummaryInput & { avisos?: number }): { text: string; ok: boolean } {
  const problems: string[] = [];
  if (!discordOnline) problems.push('o Discord está desconectado');
  if (aiOk === false) problems.push('nenhum provedor de IA está disponível');
  if (hostLevel === 'danger') problems.push('o computador está com pouca memória ou disco');
  if (problems.length === 0) {
    const watch = hostLevel === 'warn' ? ' O computador está apertado em memória ou disco; vale ficar de olho.' : '';
    // Com aviso no cartão de alertas, a frase do topo não promete "todos operacionais" (os principais seguem no ar).
    if (avisos > 0) return { ok: true, text: `Estou funcionando, mas há ${avisos === 1 ? '1 aviso' : `${avisos} avisos`} nos alertas abaixo.${watch}` };
    return { ok: true, text: `Estou funcionando normalmente. Todos os sistemas principais estão operacionais.${watch}` };
  }
  const joined = problems.length === 1 ? problems[0] : `${problems.slice(0, -1).join(', ')} e ${problems[problems.length - 1]}`;
  return { ok: false, text: `Preciso de atenção: ${joined}.` };
}

export interface Bar { hour: string; count: number; heightPercent: number; label: string }

/** Barras do gráfico de 24 h: altura proporcional ao maior valor (mínimo 6% quando há resposta, 0 quando não há) e a hora local de cada barra. */
export function chartBars(series: { hour: string; count: number }[] | null | undefined): Bar[] {
  const list = Array.isArray(series) ? series : [];
  const max = list.reduce((m, s) => Math.max(m, Number(s.count) || 0), 0);
  return list.map((s) => {
    const count = Math.max(0, Number(s.count) || 0);
    const d = new Date(s.hour);
    return {
      hour: s.hour,
      count,
      heightPercent: max === 0 || count === 0 ? 0 : Math.max(6, Math.round((count / max) * 100)),
      label: Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}h`,
    };
  });
}

export interface Problems { loginFail: number; toolError: number; toolDenied: number; alertFail: number }
export interface AlertItem { text: string; level: 'warn' | 'danger' }

/** O que o Início usa do diagnóstico (GET /v1/admin/diagnostico): os mesmos motivos que a aba Status mostra. */
export interface DiagnosticoResumo {
  motivos?: { codigo: string; texto: string }[] | null;
  bancosComAlerta?: string[] | null;
  reconexoesDoDiscord24h?: number | null;
}

/** A partir de quantas reconexões do Discord em 24 h vale avisar (o Início e a aba Status usam o mesmo número). */
export const RECONEXOES_ATENCAO = 5;
/** Motivos que o Início já mede direto (não repete o aviso). */
const MOTIVOS_JA_COBERTOS = new Set(['discord-fora', 'sem-provedor-de-ia']);
/** Motivos que o servidor trata como problema (os outros são atenção). */
const MOTIVOS_PROBLEMA = new Set(['sem-provedor-de-ia', 'trava-perdida', 'rota-privada-bloqueada', 'ia-local-privada-url-invalida']);

/** Texto do servidor em uma linha, sem caracteres de controle e com tamanho limitado. */
function linha(valor: unknown, max: number): string {
  if (typeof valor !== 'string') return '';
  const t = valor.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Nomes dos bancos com alerta, limpos (no máximo 10). */
export function nomesDosBancos(nomes: unknown): string[] {
  return (Array.isArray(nomes) ? nomes : []).slice(0, 10).map((n) => linha(n, 40)).filter(Boolean);
}

/**
 * Os avisos do diagnóstico para o Início (os mesmos da aba Status), sem repetir o que o Início já mede:
 * cada motivo do servidor vira um aviso (o do banco ganha o nome do banco) e muitas reconexões do Discord também avisam.
 */
export function alertasDoDiagnostico(d: DiagnosticoResumo | null | undefined): AlertItem[] {
  if (!d) return [];
  const out: AlertItem[] = [];
  const vistos = new Set<string>();
  const bancos = nomesDosBancos(d.bancosComAlerta);
  for (const m of Array.isArray(d.motivos) ? d.motivos.slice(0, 20) : []) {
    const codigo = typeof m?.codigo === 'string' ? m.codigo : '';
    if (!codigo || vistos.has(codigo) || MOTIVOS_JA_COBERTOS.has(codigo)) continue;
    vistos.add(codigo);
    const texto = codigo === 'banco-com-alerta' && bancos.length
      ? `${bancos.length === 1 ? 'Banco de dados com alerta' : 'Bancos de dados com alerta'}: ${bancos.join(', ')}.`
      : linha(m?.texto, 160) || codigo;
    out.push({ level: MOTIVOS_PROBLEMA.has(codigo) ? 'danger' : 'warn', text: texto });
  }
  const rec = typeof d.reconexoesDoDiscord24h === 'number' && Number.isFinite(d.reconexoesDoDiscord24h) ? Math.round(d.reconexoesDoDiscord24h) : 0;
  if (rec >= RECONEXOES_ATENCAO) out.push({ level: 'warn', text: `${rec} reconexões do Discord nas últimas 24 h (a rede da máquina da Yui pode estar instável).` });
  return out;
}

/**
 * Alertas para o dono, só com o que a API mediu: estado atual (Discord, IA, computador), problemas das últimas 24 h, os motivos do diagnóstico e a autorização
 * do Google (GET /v1/admin/google: perto de vencer, renovação falhando, autorizar de novo; contasLogic.ts). Lista vazia = nada a avisar.
 */
export function buildAlerts(input: { discordOnline: boolean; aiOk: boolean | null; hostLevel: Level; problems?: Problems | null; diagnostico?: DiagnosticoResumo | null; google?: GoogleLike | null; agora?: Date }): AlertItem[] {
  const out: AlertItem[] = [];
  if (!input.discordOnline) out.push({ level: 'danger', text: 'O Discord está desconectado.' });
  if (input.aiOk === false) out.push({ level: 'danger', text: 'Nenhum provedor de IA está disponível.' });
  if (input.hostLevel === 'danger') out.push({ level: 'danger', text: 'O computador está com pouca memória ou disco.' });
  else if (input.hostLevel === 'warn') out.push({ level: 'warn', text: 'O computador está apertado em memória ou disco.' });
  const p = input.problems;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (p?.loginFail) out.push({ level: 'warn', text: `${plural(p.loginFail, 'tentativa de login recusada', 'tentativas de login recusadas')} nas últimas 24 h.` });
  if (p?.toolError) out.push({ level: 'warn', text: `${plural(p.toolError, 'ferramenta com erro', 'ferramentas com erro')} nas últimas 24 h.` });
  if (p?.toolDenied) out.push({ level: 'warn', text: `${plural(p.toolDenied, 'ferramenta negada', 'ferramentas negadas')} nas últimas 24 h.` });
  if (p?.alertFail) out.push({ level: 'danger', text: `${plural(p.alertFail, 'aviso ao dono que não foi entregue', 'avisos ao dono que não foram entregues')} nas últimas 24 h.` });
  out.push(...alertasDoDiagnostico(input.diagnostico));
  out.push(...alertasDoGoogle(input.google, input.agora ?? new Date()));
  return out;
}

/** Abaixo deste total de respostas em 24 h o Início mostra uma linha de texto em vez do gráfico (24 barras quase vazias não dizem nada). */
export const RESPOSTAS_PARA_GRAFICO = 5;

/** Resumo em texto das respostas da IA: "Nenhuma resposta…" ou "1 resposta nas últimas 24 h (a última por volta das 20h)." */
export function resumoDasRespostas(bars: Bar[]): string {
  const total = bars.reduce((s, b) => s + b.count, 0);
  if (total === 0) return 'Nenhuma resposta da IA nas últimas 24 h.';
  const ultima = [...bars].reverse().find((b) => b.count > 0);
  const quando = ultima?.label ? ` (a última por volta das ${ultima.label})` : '';
  return `${total} ${total === 1 ? 'resposta' : 'respostas'} da IA nas últimas 24 h${quando}.`;
}

export interface SessaoDeVoz { guildName: string | null; voiceChannel: string | null; connected: boolean; status?: string | null; current?: { title?: string | null } | null }

/** O cartão "Voz" do Início, a partir das sessões de voz do Rádio (GET /v1/admin/radio). null = o servidor não respondeu. */
export function resumoDaVoz(sessoes: SessaoDeVoz[] | null | undefined): { level: Level; text: string } {
  if (!Array.isArray(sessoes)) return { level: 'unknown', text: 'Sem leitura (o servidor não informou as chamadas de voz).' };
  if (sessoes.length === 0) return { level: 'ok', text: 'Fora dos canais de voz agora.' };
  const conectadas = sessoes.filter((s) => s.connected);
  if (conectadas.length === 0) return { level: 'warn', text: `${sessoes.length === 1 ? 'Uma sessão de voz está' : `${sessoes.length} sessões de voz estão`} sem conexão.` };
  const s = conectadas[0];
  const onde = [linha(s.guildName, 40), linha(s.voiceChannel, 40)].filter(Boolean).join(' · ') || 'um servidor';
  const tocando = linha(s.current?.title, 60);
  const mais = conectadas.length > 1 ? ` (+${conectadas.length - 1})` : '';
  return { level: 'ok', text: `Em chamada: ${onde}${mais}${tocando ? `. Tocando: ${tocando}` : ''}` };
}
