/**
 * Cliente da Yui API (ver docs/content_pt/YUI_API.md).
 *
 * Mantido SEM dependências de React/Expo para ser testado em Node contra a
 * API real. Evita recursos de TypeScript que não são só "tipos" (enums,
 * parameter properties) para rodar direto com a remoção de tipos do Node.
 */

export type Role = 'OWNER' | 'TRUSTED' | 'MEMBER' | 'GUEST' | 'BLOCKED';
export type MemoryScope = 'personal' | 'public';

export interface Me {
  userId: string;
  role: Role;
  memoryScope: MemoryScope;
  /** Como esta conexão foi autenticada: token fixo ou sessão de login. */
  auth?: 'token' | 'session';
}

export interface LoginResult {
  token: string;
  /** Quando a sessão expira (epoch em ms). */
  expiresAt: number;
  userId: string;
}

// ── Painel de administração (somente o dono) ──
export interface AdminOverview {
  uptimeSeconds: number;
  pid: number;
  node: string;
  memoryMB: number;
  discord: { online: boolean; tag: string | null; guilds: number };
  bans: { users: number; guilds: number; channels: number };
  memoryUsers: number | null;
  flags: { readOnly: boolean; memoryEnabled: boolean; pcToolsEnabled: boolean };
  /** Nome do dono para a saudação (YUI_OWNER_NAME no servidor), ou null. */
  ownerName?: string | null;
  /** Saúde da máquina (RAM e disco livres). Ausente em servidores antigos; cada campo pode vir null. O nível vem do servidor (NivelDoComputador). */
  host?: {
    platform: string; ramTotalMB: number | null; ramFreeMB: number | null; diskTotalGB: number | null; diskFreeGB: number | null;
    /** Raiz da unidade medida (ex.: "C:\"), nunca o caminho. Servidor antigo não manda. */
    volume?: string | null;
    /** Fase 1 do painel (R10): os limites do alerta por DM (cofre) e o nível de cada recurso pela MESMA regra. Servidor antigo não manda: o Início não colore. */
    alerta?: { discoLivreMinGB: number | null; ramLivreMinMB: number | null; ramMinutos: number; nivelDisco: NivelDoComputador | null; nivelRam: NivelDoComputador | null } | null;
  };
  /** Últimos eventos do registro de auditoria (só quando, o quê e por onde; nunca o conteúdo). */
  activity?: { ts: string | null; event: string; role: string | null; platform: string | null }[];
  /** Retenção da memória: a do dono é permanente; as demais expiram em `othersDays` dias. */
  retention?: { ownerPermanent: boolean; othersPermanent?: boolean; othersDays: number | null };
  limits?: { dmMax: number; dmWindowMinutes: number; fileLinkMinutes: number };
  interactions?: { series: { hour: string; count: number }[]; total: number; since: string };
  problems?: { loginFail: number; toolError: number; toolDenied: number; alertFail: number };
  /** Só com o cérebro separado (dois processos): se o bot do Discord está ligado ao cérebro. Ausente no processo único. */
  cerebro?: AdminOverviewCerebro;
}
/** Presente só quando a Yui roda em dois processos (cérebro + bot): diz se o bot está ligado ao cérebro. Ausente no processo único. */
export interface AdminOverviewCerebro { botConectado: boolean }

// ── Diagnóstico (GET /v1/admin/diagnostico; só o dono, só leitura) ──
// O servidor entrega SÓ números, booleanos, identificadores curtos e palavras fixas (uma lista de permitidos): nunca texto de conversa, pesquisa privada, id de pessoa,
// segredo, caminho nem o texto de um erro. Estes tipos descrevem exatamente isso; o app não pede, não guarda em disco e não mostra nada além destes campos.
export type EstadoGeral = 'ok' | 'atencao' | 'problema';
export type EstadoRotaPrivada = 'desligada' | 'incompleta' | 'nao-verificada' | 'validada' | 'nao-validada' | 'bloqueada';
export interface DiagnosticoMotivo { codigo: string; texto: string }
export interface DiagnosticoErro { tipo: string; status: number | null }
export interface DiagnosticoAlvoIa {
  modelo: string; disponivel: boolean | null; descansoSegundos: number; falhasSeguidas: number; acertos: number; falhas: number;
  ultimoErro: DiagnosticoErro | null; ultimoOkHaSegundos: number | null;
}
export interface DiagnosticoProvedorIa {
  id: string; rotulo: string; anonimo: boolean | null; prioridade: number | null; chaves: number; chavesEmDescanso: number; descansoSegundos: number; alvos: DiagnosticoAlvoIa[];
}
export interface DiagnosticoLimiteProvedor { provedor: string; limite: number; configurado: number; capacidade: number; origem: string }
export interface DiagnosticoCerebro {
  uptimeSegundos: number; backend: string | null; ponteDoBot: boolean | null; botConectado: boolean | null; discordOnline: boolean | null; travasPerdidas: number;
  [k: string]: unknown;
}
export interface DiagnosticoContadoresPerfil { chamadas: number; ok: number; erros: number; fallbacks: number; fechadas: number; recusadasPorPrivacidade: number }
export interface DiagnosticoPerfil extends DiagnosticoContadoresPerfil {
  nome: string; habilitado: boolean | null; privacidade: 'privada' | 'geral' | null; combo: string | null; provedorDaYui: string | null; provedorCadastrado: boolean | null;
  maxTokens: number | null; limiteEfetivo: number | null; capacidadeConhecida: number | null;
}
export interface DiagnosticoChamadaPerfil {
  quando: string | null; ponto: string | null; perfil: string | null; combo: string | null; provedorQueRespondeu: string | null; estrategia: string | null;
  fallbackUsado: boolean | null; limiteDeTokens: number | null; latenciaMs: number | null; resultado: string | null; decisao: string | null; motivo: string | null;
}
export interface DiagnosticoRotaPrivada {
  estado: EstadoRotaPrivada; motivo: string | null; motivos: string[]; formatoDefinido: boolean; sondas: number; sondasValidas: number; violacoes: number;
  ultimaSondaHaSegundos: number | null; falhasSeguidas: number; sondaSozinhaPausada: boolean; falhasRecentes: { haSegundos: number | null; motivo: string | null }[];
}
export interface DiagnosticoPerfisIa {
  configurado: boolean; origem: string; errosDeConfiguracao: { perfil: string | null; codigo: string | null }[]; perfis: DiagnosticoPerfil[];
  totais: DiagnosticoContadoresPerfil; ultimas: DiagnosticoChamadaPerfil[]; rotaPrivada: DiagnosticoRotaPrivada;
}
export interface Diagnostico {
  versao: number;
  geradoEm: string;
  modo: 'unico' | 'cerebro-separado';
  estado: EstadoGeral;
  motivos: DiagnosticoMotivo[];
  processo: { uptimeSegundos: number; memoriaMB: number };
  cerebro: DiagnosticoCerebro | null;
  ia: {
    backendAtivo: string | null; backends: { nome: string; ativo: boolean | null; local: boolean | null }[]; gatewayConfigurado: boolean; algumDisponivel: boolean | null;
    provedorAtual: string | null; totais: { requests?: number; ok?: number; failed?: number }; provedores: DiagnosticoProvedorIa[];
  };
  limitesDeTokens: {
    teto: number | null; discord: { aplica: boolean; provedores: DiagnosticoLimiteProvedor[] }; app: { provedores: DiagnosticoLimiteProvedor[] }; erroDeConfiguracao: boolean;
  };
  cotasDeBusca: {
    hora: {
      global: { usadas: number; limite: number; cheia: boolean | null; liberaEmSegundos: number }; porPessoaLimite: number; reutilizadas: number;
      persistencia: { gravando: boolean | null; pesquisaDisponivel: boolean | null; gravacaoComFalha: boolean | null; dono: string | null; aguardandoTrava: boolean | null; perdeuATrava: boolean | null; motivo: string | null };
    };
    mes: { provedor: string; usadas: number; teto: number }[];
    reservaPercentual: number | null;
  };
  avisosDeConfiguracao: { variavel: string; problema: string; usando: string | number }[];
  erros: { ultimas24h: number; reconexoesDoDiscord24h: number; porEtiqueta: { etiqueta: string; quantidade: number }[] };
  bancos: { total: number; motores: Record<string, number>; tamanhoTotalMB: number; comAlerta: string[] };
  /** Desde a etapa 9. Ausente em servidores mais antigos: a tela só mostra o que veio. */
  perfisDeIa?: DiagnosticoPerfisIa;
  motorAgente?: { pedido: string; ativo: string; recusado: boolean; motivo: string | null; implementados: { nativo: boolean; mastra: boolean } };
}

export type AutomodMode = 'off' | 'trigger' | 'mcp' | 'both';
/** O nível de RAM ou disco que o SERVIDOR calcula com os limites do alerta por DM (Fase 1 do painel, R10). */
export type NivelDoComputador = 'ok' | 'atencao' | 'critico';
export interface AdminGuild { id: string; name: string; members: number | null; automod: AutomodMode; tosAccepted: boolean }
export type BanType = 'user' | 'guild' | 'channel';
export interface BanEntry { id: string; reason: string; timestamp: string | null }
export interface AdminBans { users: BanEntry[]; guilds: BanEntry[]; channels: BanEntry[] }
export interface AdminMemoryUser { userId: string; name?: string | null; count: number; lastSeen: number; expiresAt: number | null }
export interface AdminMemoryMeta { id: number; type: string; content: string; tags: string; source: string; importance: number; createdAt: number; updatedAt: number; expiresAt: number | null }
export interface AdminMemoryList { users: AdminMemoryUser[]; total: number; permanent?: boolean }
export interface AuditEvent { ts: string; event: string; userId: string | null; role: string | null; platform: string | null; [k: string]: unknown }
export interface GatewayTarget {
  id: string; model: string; tier: string; available: boolean; cooldownSeconds: number;
  failures: number; ok: number; fail: number; lastError: string | null; lastOkSecondsAgo: number | null;
}
export interface GatewayProvider {
  id: string; label: string; anonymous: boolean; priority: number; keys: number; keysCoolingDown: number;
  cooldownSeconds: number; targets: GatewayTarget[];
}
export interface GatewayStatus { totals: { requests: number; ok: number; failed: number }; combos: string[]; providers: GatewayProvider[] }
export type IntegrationStatus = 'ok' | 'off' | 'missing';
export interface IntegrationItem { key: string; name: string; status: IntegrationStatus; detail: string }
export interface IntegrationGroup { title: string; items: IntegrationItem[] }
export interface ChannelRef { id: string; name: string | null }
export interface AdminGuildDetail {
  id: string; name: string; members: number | null;
  channels: { noticias: ChannelRef | null; diario: ChannelRef | null; semanal: ChannelRef | null; atualizacoes: ChannelRef | null };
  respondToEveryone: boolean | null;
  textChannels: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  youtube: { id: string; name: string; role: string | null; channel: ChannelRef | null; videos: boolean; shorts: boolean; lives: boolean; liveMode?: YoutubeLiveMode }[];
  twitch: { id: string; name: string; role: string | null; channel: ChannelRef | null }[];
  tools: { enabled: string[]; disabled: string[] } | null;
}
export type GuildChannelType = 'noticias' | 'diario' | 'semanal' | 'atualizacoes';
// ── Configurações por servidor ──
export interface GuildTool { nome: string; rotulo: string; descricao: string; ligada: boolean; padraoLigada: boolean }
export interface TosPage { titulo: string; texto: string }
export interface GuildTosState { donoDoServidor: boolean; aceito: boolean; exigido: boolean; aceitoEm: string | null; aceitoPor: string | null; origem: 'discord' | 'painel' | null }
export interface TosAcceptResult { ok: boolean; jaAceito: boolean; canalAtualizacoes: string | null; avisoEnviado: boolean; estado: GuildTosState }
export interface ChannelConfig {
  channelId: string; nome: string;
  persona: { instrucao: string | null; humor: string | null };
  espontaneo: { ativo: boolean; frequencia: 'low' | 'medium' | 'high' | 'custom' | null; porcentagem: number | null };
  limites: { instrucao: number; humor: number };
}
export interface PersonaChange { instrucao?: string; humor?: string }
export interface ChatterChange { ativo?: boolean; frequencia?: 'low' | 'medium' | 'high'; porcentagem?: number }
/** Como os avisos de live saem: 'auto' (edita se a live começa logo), 'new' (mensagem nova a cada etapa) ou 'edit' (sempre a mesma mensagem). */
export type YoutubeLiveMode = 'auto' | 'new' | 'edit';
export interface FollowYoutubeInput { channel: string; discordChannelId: string; roleId?: string | null; videos: boolean; shorts: boolean; lives: boolean; liveMode?: YoutubeLiveMode }
export interface AiKeyHint { index: number; hint: string }
export interface AiProvider {
  id: string; label: string; url: string | null; needsAccount: boolean; accountConfigured: boolean | null;
  envKeys: number; ignoredEnvKeys?: number; panelKeys: AiKeyHint[]; enabled: boolean; toggle: boolean; active: boolean | null; keyless?: boolean;
}
export interface AiCustomProvider {
  id: string; label: string; baseUrl: string; models: string[]; keys: AiKeyHint[]; anonymous: boolean; first?: boolean;
  enabled: boolean; active: boolean; source: 'panel' | 'env';
}
export interface AiTemplate { id: string; label: string; baseUrl: string; models: string[]; needsKey: boolean; first?: boolean; anonymous?: boolean }
export interface AiOverview { editable: boolean; providers: AiProvider[]; custom: AiCustomProvider[]; templates: AiTemplate[] }
export interface AiCustomInput { id: string; label: string; baseUrl: string; models: string; key?: string; first?: boolean; anonymous?: boolean }
export interface AiTestResult { ok: boolean; ms: number; via?: string | null; error?: string }
export interface ConfigItem {
  chave: string; rotulo: string; grupo: string; descricao: string; tipo: 'segredo' | 'bool' | 'int' | 'decimal' | 'enum' | 'texto'; reinicio: boolean;
  definido: boolean; origem: 'painel' | 'env' | 'padrao'; opcoes?: string[]; confirmar?: string[]; min?: number; max?: number; padrao?: string;
  secreto?: boolean; ultimos4?: string | null; valor?: string | null; alteradoEm?: string | null;
  /** Versão do ajuste no cofre (só cresce). A tela devolve a que viu ao gravar: se o Discord gravou no meio, o servidor responde 409. */
  versao?: number;
}
export interface ConfigOverview { edicaoLigada: boolean; protegido?: boolean; problema?: 'cofre-ilegivel'; itens: ConfigItem[] }
export interface RadioTrack { title: string; artist: string; album: string | null }
/** Uma das próximas faixas da fila: só título e duração (segundos). */
export interface RadioUpcoming { title: string; duration: number | null }
export interface RadioSession {
  guildId: string; guildName: string | null; voiceChannel: string | null; status: string; connected: boolean;
  current: RadioTrack | null; next: RadioTrack | null; queueLength: number; position: string | null;
  shuffle: boolean; loopMode: string; voiceMode: string; streamMode: string;
  /** As próximas faixas (até 10). Servidores antigos não mandam. */
  upcoming?: RadioUpcoming[];
}
export type RadioAction = 'pause' | 'resume' | 'stop' | 'leave' | 'skip';
// ── Lacunas do painel, item 10 (entrega E, parte 2): o rádio completo. O servidor nunca manda link, capa nem quem pediu uma faixa. ──
export interface RadioFaixa { title: string; artist: string; duration: number | null }
export type RadioResultadoTipo = 'tocando' | 'na-fila' | 'nao-encontrado' | 'escolher' | 'fim-da-fila';
export interface RadioResultado {
  ok: boolean;
  /** Só no `start`. */
  iniciado?: boolean;
  resultado?: RadioResultadoTipo | string;
  faixa?: RadioFaixa | null;
  adicionadas?: number;
  /** Só quando `resultado` é 'escolher': escolha devolvendo o NÚMERO (posição na lista, a partir de 0). */
  opcoes?: RadioFaixa[];
}
export interface RadioCanalDeVoz { id: string; nome: string; pessoas: number; pode: boolean; motivo: 'sem-permissao' | 'cheio' | null | string }
export interface RadioCanalDeTexto { id: string; nome: string; pode: boolean; motivo: 'sem-permissao' | null | string }
export interface RadioCanais { guildId: string; voz: RadioCanalDeVoz[]; texto: RadioCanalDeTexto[] }
export type LogKind = 'app' | 'error';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { time: string; level: string; text: string }
export interface LogFile { name: string; kind: LogKind; date: string; size: number }
export interface LogsResult { files: LogFile[]; file: string | null; entries: LogEntry[]; truncated: boolean }
export interface LogsQuery { kind?: LogKind; date?: string | null; level?: LogLevel | null; q?: string; limit?: number }
// ── Monitores de busca (só o dono; só com o cérebro separado e YUI_MONITORES ligado) ──
// O servidor manda só o assunto curto (até 60 caracteres, null depois de encerrado), o estado, as datas e a contagem: nunca o texto de um resultado.
export interface MonitorView {
  id: number;
  consulta: string | null;
  estado: 'ativo' | 'pausado' | 'encerrado' | string;
  proximaChecagem: string | null;
  ate: string | null;
  avisos: number;
  entrega?: 'pendente' | 'enviando' | 'incerto' | string;
  fim?: 'vencido' | 'cancelado' | 'barrado' | string;
}
/** `ligado: false` = monitores desligados (processo único ou YUI_MONITORES=false): a lista vem vazia. `resumo` só tem contadores. */
export interface MonitoresResult { ligado: boolean; monitores: MonitorView[]; resumo?: Record<string, unknown> }
// ── Lacunas do painel, entrega B (só leitura, só o dono): live do YouTube, Google, planos e avisos ──
// O servidor monta cada resposta com uma lista fechada de campos: nada de token, segredo, texto do chat, autor, argumentos de plano nem texto de aviso.
export interface LiveView {
  ligado: boolean;
  /** false = a chave está ligada, mas o serviço da live não subiu no servidor. */
  disponivel: boolean;
  estado: 'desligado' | 'ociosa' | 'procurando' | 'ouvindo' | 'encerrada' | 'interrompida' | string;
  ativo: boolean;
  live: { videoId: string | null; titulo: string | null } | null;
  desde: string | null;
  mensagens: { lidas: number; respondidas: number; espontaneas: number } | null;
  cota: { dia: string | null; usado: number; limiteDiario: number; reserva: number; restante: number; nivel: 'ok' | 'atencao' | 'critico' | 'esgotada' | string } | null;
  ultimoErro: { codigo: string; em: string | null } | null;
}
export interface GoogleView {
  ligado: boolean;
  conectado: boolean;
  arquivo: 'ok' | 'ausente' | 'ilegivel' | 'invalido' | null | string;
  /** Nomes curtos (agenda, tarefas, gmail, outro); null = o arquivo não informa. */
  escopos: string[] | null;
  autorizadoEm: string | null;
  /** 7 dias depois da autorização (a regra do modo Testando); null = não informado. */
  venceEm: string | null;
  validade: 'testando-7-dias' | 'nao-informado' | string;
  ultimaRenovacaoEm: string | null;
  ultimoErro: { codigo: 'rede' | 'erro' | 'precisa-autorizar' | string; em: string | null } | null;
  renovacaoFalhou: boolean;
  precisaAutorizar: boolean;
  motivoDeAutorizar: 'recusada' | 'sem-arquivo' | 'arquivo-invalido' | null | string;
  avisoPendente: boolean;
  renovacoes: number;
  /** Entrega F (item 14): o botão "Reautorizar o Google" vale (YUI_GOOGLE_REAUTORIZAR_PAINEL). Servidor antigo não manda: só o script. */
  reautorizarPeloPainel?: boolean;
}
// ── Lacunas do painel, entrega F, item 14 (só o dono): reautorizar o Google pelo painel. Nunca token, código, segredo nem corpo de resposta do Google. ──
/** O início: só o link de consentimento (e até quando vale), ou um código fixo (sem arquivo de autorização: a primeira vez é pelo script). */
export type InicioDaReautorizacao =
  | { ok: true; link: string; expiraEm: string; gmailFicaNoScript: boolean }
  | { ok: false; codigo: string; texto: string };
/** O retorno (o endereço colado): "autorizado" com a nova validade e o que o Google não concedeu, ou um código fixo com a frase dele. */
export type RetornoDaReautorizacao =
  | { ok: true; codigo: 'autorizado'; venceEm: string; escopos: string[]; faltam: string[]; gmailFicaNoScript: boolean }
  | { ok: false; codigo: string; texto: string };
export interface PlanoView {
  id: string;
  versao: number;
  hash: string | null;
  estado: string;
  criadoEm: string | null;
  validade: string | null;
  aprovadoEm: string | null;
  aprovacao: 'dono' | 'automatica' | null | string;
  encerradoEm: string | null;
  motivo: string | null;
  passos: { ferramenta: string; estado: string; resumo?: ResumoDoPasso }[];
  /** Correção C1: o plano manda texto da pessoa para fora (a pesquisa): só se aprova pela DM. Servidor antigo não manda. */
  aprovarSoPelaDm?: boolean;
}
/**
 * Correção C1 do parecer da Liz: o resumo SEGURO de um passo, montado pelo servidor a partir do passo guardado. Os valores de lista fechada aparecem na
 * ação; o texto livre (o nome buscado, a consulta, o nome da lista) só como tamanho. Nunca vem o argumento.
 */
export interface ResumoDoPasso {
  acao: string;
  servico: string;
  acesso: 'leitura' | 'desconhecido' | string;
  saida: 'internet' | 'google' | 'rede-local' | 'nao' | 'desconhecida' | string;
  textoLivre: { campo: string; caracteres: number }[];
  soPelaDm: boolean;
}
/** Correção C2: o pedido da chave de confirmação pela DM (aprovar um plano, com id, versão e hash; ou reautorizar o Google). */
export type PedidoDeConfirmacao =
  | { acao: 'plano.aprovar'; plano: { id: string; versao: number; hash: string } }
  | { acao: 'google.reautorizar' };
/** `painel` (entrega E): Aprovar e Recusar valem pelo painel (YUI_PLANOS_PAINEL e os planos ligados). Servidor antigo não manda: só leitura. */
export interface PlanosResult { ligado: boolean; auto: boolean; painel?: boolean; ilegivel: boolean; total: number; planos: PlanoView[] }
// ── Lacunas do painel, entrega E (só o dono): as ações. As respostas trazem só a frase do serviço, nunca argumentos, resultados nem o link. ──
/** A resposta da decisão de um plano (a mesma decidir() dos botões da DM). `final: false` = dá para tentar de novo em instantes. */
export interface DecisaoDoPlano { ok: boolean; final: boolean; texto: string }
/** A resposta de entrar ou sair da live (o mesmo comando da conversa). `ok` = entrou / saiu de fato. */
export interface AcaoDaLive { ok: boolean; texto: string }
export interface AvisoNaFila { assunto: string | null; classe: string; motivo: string; ate: string | null; estado: string; criadoEm: string | null }
export interface AvisoObservado { em: string | null; assunto: string | null; classe: string; acao: string; motivo: string | null; ate: string | null }
export interface ObservadosDoProcesso {
  origem: 'cerebro' | 'bot' | 'unico' | string;
  /** O bot (com os dois processos) não respondeu: a parte dele fica sem leitura. */
  indisponivel?: boolean;
  desde?: string | null;
  contagem?: { enviar: number; adiar: number; descartar: number };
  registros?: AvisoObservado[];
}
export interface AvisosResult {
  modo: 'off' | 'observar' | 'ligar' | string;
  fila: { existe: boolean; ilegivel: boolean; resumoPendente: boolean; total: number; itens: AvisoNaFila[] };
  observados: ObservadosDoProcesso[];
}
// ── Lacunas do painel, entrega D (só o dono): GTA (só leitura), listas pessoais, skills e continuidade ──
// O servidor monta cada resposta com uma lista fechada de campos: nada do texto inteiro do post ou do artigo, da análise da IA, do caminho ou do corpo de uma skill.
export type EstadoLigado = 'ligado' | 'desligado';
export interface GtaPublicacao { servidorId: string; servidor: string | null; canalId: string | null; canal: string | null; em: string | null }
/** Onde dá para republicar (item 9 v2): um servidor com o canal daquele tipo configurado. */
export interface GtaAlvo { servidorId: string; servidor: string | null; canalId: string; canal: string | null }
export type TipoDoGta = 'diario' | 'semanal' | 'noticia';
export interface RepublicacaoDoGta { ok: boolean; tipo: TipoDoGta; guildId: string; canalId: string | null }
export interface GtaView {
  fontes: {
    diario: { estado: 'ligado' | string; horario: string };
    semanal: { estado: EstadoLigado | string; aoReiniciar: EstadoLigado | null | string; intervaloMin: number | null };
    reddit: { estado: 'ligado' | 'desligado' | 'em-espera' | string; voltaEm: string | null; falhas: number };
    reserva: { estado: EstadoLigado | string };
    newswire: { estado: EstadoLigado | string; aoReiniciar: EstadoLigado | null | string; intervaloMin: number | null };
  };
  /** Quantos servidores têm canal de cada tipo configurado. */
  canais: { diario: number; semanal: number; noticias: number };
  /** Onde dá para republicar cada tipo (item 9 v2). Servidores antigos não mandam. */
  alvos?: { diario: GtaAlvo[]; semanal: GtaAlvo[]; noticia: GtaAlvo[] };
  diario: {
    data: string | null;
    coletadoEm: string | null;
    vanDeArmas: { local: string | null; armas: { nome: string; desconto: number | null }[] } | null;
    comerciantes: { local: string; produto: string | null }[];
    naufragio: string | null;
    baus: number;
    desafios: { nome: string; local: string | null }[];
    publicado: GtaPublicacao[];
  } | null;
  semanal: {
    semana: string | null;
    fonte: 'reddit' | 'gtabase' | 'newswire' | 'outra' | string;
    titulo: string | null;
    periodo: { inicio: string | null; fim: string | null };
    bonus: { multiplicador: number | null; atividades: string[] }[];
    descontos: string[];
    podio: string | null;
    premio: string | null;
    temAnalise: boolean;
    link: string | null;
    salvoEm: string | null;
    publicado: GtaPublicacao[];
  } | null;
  noticia: { titulo: string | null; categoria: string | null; publicadaEm: string | null; link: string | null; publicado: GtaPublicacao[] } | null;
  /** O que não deu para ler: 'diario' | 'semanal' | 'noticia' | 'canais'. */
  erros: string[];
}
export interface ListaPessoal { nome: string; total: number; feitos: number; atualizadaEm: string | null; itens: { texto: string; feito: boolean }[] }
export interface ListasView { ligado: boolean; situacao: 'ok' | 'ausente' | 'ilegivel' | string; total: number; listas: ListaPessoal[] }
export interface SkillView { nome: string; descricao: string; origem: 'yui' | 'dono' | 'extra' | string; licenca: string | null; permitida: boolean; ignorados: string[] }
export interface SkillsView {
  ligado: boolean;
  /** 'todas' = YUI_SKILLS_PERMITIDAS vazia (todas as válidas valem); 'lista' = só as da lista. */
  filtro: 'todas' | 'lista' | string;
  permitidas: string[] | null;
  /** Nomes da lista de permitidas que não estão instalados. */
  naoInstaladas: string[];
  total: number;
  ativas: number;
  skills: SkillView[];
  avisos: { pasta: string; origem: string; motivo: string }[];
}
export interface ContinuidadeItem { id: number; tipo: 'projeto' | 'decisao' | string; texto: string; criadoEm: string | null; atualizadoEm: string | null }
export interface ContinuidadeView { ligado: boolean; memoria: boolean; total: number; projetos: number; decisoes: number; itens: ContinuidadeItem[] }
// ── Lembretes e relatório matinal ──
export interface ReminderView { id: number; text: string; at: string; repeat: { kind: string; hour: number; minute: number; weekday?: number; day?: number } | null; whenText: string; repeatText: string | null; tries: number }
export interface RemindersResult { reminders: ReminderView[]; now: string }

// ── Arquivos (BDS Server, pela API da Yui) ──
export interface BdsEntry { nome: string; tipo: 'pasta' | 'arquivo'; caminho?: string; tamanho?: number | null; modificado?: string | null; [k: string]: unknown }
export interface BdsList { caminho?: string; itens?: BdsEntry[]; [k: string]: unknown }
export interface BdsStatus { versao?: string; [k: string]: unknown }
export interface AdminTool { name: string; description: string; access: string; confirm: boolean; allowed: boolean; reason: string | null }

export interface Backend {
  name: string;
  local: boolean;
  active: boolean;
}

export interface Health {
  ok: boolean;
  memory: boolean;
  /** Modo somente leitura: a Yui não pode apagar, gravar nem executar programas. */
  readOnly?: boolean;
  backends: Backend[];
}

export type AgentReplyType = 'reply' | 'tool_result' | 'needs_confirmation' | 'denied';

/**
 * Imagem gerada pelo Chat do app (lacunas do painel, item 11; YUI_APP_IMAGEM no servidor). `url` é um caminho RELATIVO `/v1/imagem/<código>`: o próprio
 * código é a credencial, vale `expiresInSec` (10 min) e nunca é um caminho de arquivo do servidor. `alt` é o texto alternativo (o assunto pedido).
 */
export interface AgentImage { url: string; alt: string; expiresInSec: number | null }

export interface AgentReply {
  type: AgentReplyType;
  reply: string;
  tool?: string;
  pendingId?: string;
  imagem?: AgentImage;
  /** O limite de imagens por hora barrou o pedido (o `reply` diz quando tentar de novo). */
  limiteImagem?: { minutos: number };
}

export interface MemoryItem {
  id: number;
  type: string;
  content: string;
  tags: string;
  importance: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Normaliza o endereço do servidor digitado pelo usuário:
 *  - sem esquema: usa https para *.ts.net (Tailscale Serve) e http nos demais;
 *  - remove barras finais e um eventual "/v1".
 */
export function normalizeBaseUrl(input: string): string {
  let raw = String(input ?? '').trim();
  if (!raw) throw new ApiError(0, 'Informe o endereço do servidor.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `${/\.ts\.net(?::\d+)?(\/|$)/i.test(raw) ? 'https' : 'http'}://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(0, 'Endereço do servidor inválido.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(0, 'Use um endereço http:// ou https://.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Tempo máximo por requisição (respostas de IA podem demorar). */
  timeoutMs?: number;
  /** Chamado quando o servidor recusa a sessão/token (401): o app volta para o login. */
  onUnauthorized?: () => void;
}

function messageForStatus(status: number, serverMessage?: string): string {
  if (status === 401) return serverMessage && serverMessage !== 'não autorizado' ? serverMessage : 'Token ou sessão inválidos ou expirados.';
  if (status === 403) return 'Acesso negado para este usuário.';
  if (status === 429) return serverMessage && /^muit/i.test(serverMessage) && serverMessage !== 'muitas requisições' ? serverMessage : 'Muitas requisições. Aguarde um instante e tente de novo.';
  if (status === 503) return serverMessage || 'Recurso indisponível no servidor.';
  return serverMessage || `Erro do servidor (HTTP ${status}).`;
}

export function createClient(options: ClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = String(options.token ?? '').trim();
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  const defaultTimeout = options.timeoutMs ?? 130_000;

  async function request<T>(method: string, path: string, body?: unknown, timeoutMs = defaultTimeout): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ApiError(
        0,
        aborted
          ? 'O servidor demorou demais para responder.'
          : 'Não foi possível conectar ao servidor. Verifique o endereço, o Tailscale e se o PC está ligado.'
      );
    } finally {
      clearTimeout(timer);
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* corpo vazio ou não-JSON */
    }
    if (res.status === 401 && token && options.onUnauthorized) options.onUnauthorized();
    if (!res.ok) {
      const serverMessage = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : undefined;
      throw new ApiError(res.status, messageForStatus(res.status, serverMessage));
    }
    return data as T;
  }

  return {
    baseUrl,
    health: () => request<Health>('GET', '/v1/health', undefined, 15_000),
    me: () => request<Me>('GET', '/v1/me', undefined, 15_000),
    /** Conversa pelo Agent: responde, executa ferramenta ou pede confirmação. */
    send: (message: string) => request<AgentReply>('POST', '/v1/agent', { message }),
    confirm: (id: string, approve: boolean) => request<AgentReply>('POST', '/v1/agent/confirm', { id, approve }),
    memories: async () => (await request<{ scope: MemoryScope; memories: MemoryItem[]; permanent?: boolean; retentionDays?: number | null }>('GET', '/v1/memory', undefined, 20_000)),
    addMemory: (content: string, type = 'note') =>
      request<{ ok: boolean; scope: MemoryScope }>('POST', '/v1/memory', { content, type }, 20_000),
    deleteMemory: (id: number) => request<{ ok: boolean }>('DELETE', `/v1/memory/${id}`, undefined, 20_000),
    clearMemories: () => request<{ removed: number }>('DELETE', '/v1/memory', undefined, 20_000),

    // ── Login por usuário e senha ──
    authStatus: () => request<{ passwordLogin: boolean; discordKey: boolean }>('GET', '/v1/auth/status', undefined, 15_000),
    /** Pede uma chave de uso único; ela chega por DM no Discord do dono (não volta nesta resposta). */
    discordRequest: () => request<{ ok: boolean; expiresInSeconds: number }>('POST', '/v1/auth/discord/request', {}, 30_000),
    /** Troca a chave recebida por DM por uma sessão. */
    discordVerify: (code: string) => request<LoginResult>('POST', '/v1/auth/discord/verify', { code }, 20_000),
    login: (user: string, password: string) => request<LoginResult>('POST', '/v1/auth/login', { user, password }, 20_000),
    logout: () => request<{ ok: boolean; revoked: boolean }>('POST', '/v1/auth/logout', {}, 10_000),

    // ── Lembretes e relatório matinal (só o dono) ──
    reminders: {
      list: () => request<RemindersResult>('GET', '/v1/admin/reminders', undefined, 20_000),
      /** `when` em português ("amanhã às 9h", "em 2 horas", "todo dia às 8h"): o servidor interpreta. */
      add: (text: string, when: string) => request<{ reminder: ReminderView }>('POST', '/v1/admin/reminders', { text, when }, 20_000),
      remove: (id: number) => request<{ ok: boolean }>('DELETE', `/v1/admin/reminders/${id}`, undefined, 20_000),
      snooze: (id: number, by: { minutes?: number; when?: string }) => request<{ reminder: ReminderView }>('POST', `/v1/admin/reminders/${id}/snooze`, by, 20_000),
      morningPreview: () => request<{ text: string }>('GET', '/v1/admin/morning', undefined, 30_000),
      morningSend: () => request<{ ok: boolean }>('POST', '/v1/admin/morning/send', {}, 30_000),
    },

    // ── Arquivos do BDS Server (só o dono): a Yui é a única porta de entrada ──
    bds: {
      status: () => request<BdsStatus>('GET', '/v1/admin/bds/status', undefined, 35_000),
      roots: () => request<any>('GET', '/v1/admin/bds/roots', undefined, 35_000),
      list: (caminho: string) => request<BdsList>('GET', `/v1/admin/bds/list?caminho=${encodeURIComponent(caminho)}`, undefined, 35_000),
      search: (q: string) => request<any>('GET', `/v1/admin/bds/search?q=${encodeURIComponent(q)}`, undefined, 35_000),
      recent: (limite = 30) => request<any>('GET', `/v1/admin/bds/recent?limite=${limite}`, undefined, 35_000),
      usage: () => request<any>('GET', '/v1/admin/bds/usage', undefined, 35_000),
      trash: () => request<any>('GET', '/v1/admin/bds/trash', undefined, 35_000),
      audit: (limite = 50) => request<any>('GET', `/v1/admin/bds/audit?limite=${limite}`, undefined, 35_000),
      mkdir: (caminho: string) => request<any>('POST', '/v1/admin/bds/mkdir', { caminho }, 35_000),
      rename: (de: string, para: string) => request<any>('POST', '/v1/admin/bds/rename', { de, para }, 35_000),
      remove: (caminho: string) => request<any>('POST', '/v1/admin/bds/delete', { caminho, confirmar: true }, 35_000),
      restore: (caminho: string) => request<any>('POST', '/v1/admin/bds/restore', { caminho }, 35_000),
      purge: (caminho: string) => request<any>('POST', '/v1/admin/bds/purge', { caminho, confirmar: true }, 35_000),
      /** Endereço curto (10 min) para abrir/baixar um arquivo no navegador sem cabeçalho de login. `inline` = tocar/mostrar em vez de baixar. */
      link: async (caminho: string, inline: boolean): Promise<string> => {
        const r = await request<{ url: string }>('POST', '/v1/admin/bds/link', { caminho, inline }, 20_000);
        return `${baseUrl}${r.url}`;
      },
      /** Igual a `link`, mas devolve também por quantos minutos o endereço vale (o servidor informa; a tela não chuta). */
      linkInfo: async (caminho: string, inline: boolean): Promise<{ url: string; minutes: number | null }> => {
        const r = await request<{ url: string; expiresInSec?: number }>('POST', '/v1/admin/bds/link', { caminho, inline }, 20_000);
        return { url: `${baseUrl}${r.url}`, minutes: typeof r.expiresInSec === 'number' ? Math.max(1, Math.round(r.expiresInSec / 60)) : null };
      },
      /** Envia um arquivo (web): corpo em fluxo, com progresso. Devolve { bytes }. */
      upload: (caminho: string, file: Blob, onProgress?: (enviado: number, total: number) => void) =>
        new Promise<{ bytes?: number }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', `${baseUrl}/v1/admin/bds/upload?caminho=${encodeURIComponent(caminho)}`);
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
          xhr.onerror = () => reject(new ApiError(0, 'Não foi possível enviar: a conexão caiu.'));
          xhr.onabort = () => reject(new ApiError(0, 'Envio cancelado.'));
          xhr.onload = () => {
            let data: any = null;
            try { data = JSON.parse(xhr.responseText); } catch { /* sem corpo */ }
            if (xhr.status === 401 && token && options.onUnauthorized) options.onUnauthorized();
            if (xhr.status >= 200 && xhr.status < 300) resolve(data ?? {});
            else reject(new ApiError(xhr.status, messageForStatus(xhr.status, data?.error)));
          };
          xhr.send(file);
        }),
    },

    // ── Painel de administração (somente o dono) ──
    admin: {
      overview: () => request<AdminOverview>('GET', '/v1/admin/overview', undefined, 20_000),
      guilds: async () => (await request<{ guilds: AdminGuild[] }>('GET', '/v1/admin/guilds', undefined, 20_000)).guilds,
      setAutomod: (guildId: string, mode: AutomodMode) =>
        request<{ ok: boolean; automod: AutomodMode }>('POST', `/v1/admin/guilds/${guildId}/automod`, { mode }, 20_000),
      bans: () => request<AdminBans>('GET', '/v1/admin/bans', undefined, 20_000),
      addBan: (type: BanType, id: string, reason: string) => request<{ ok: boolean }>('POST', '/v1/admin/bans', { type, id, reason }, 20_000),
      removeBan: (type: BanType, id: string) => request<{ ok: boolean }>('DELETE', `/v1/admin/bans/${type}/${id}`, undefined, 20_000),
      memoryUsers: () => request<AdminMemoryList>('GET', '/v1/admin/memory/users', undefined, 20_000),
      memoryInspect: async (userId: string) =>
        (await request<{ memories: AdminMemoryMeta[] }>('GET', `/v1/admin/memory/users/${userId}`, undefined, 20_000)).memories,
      memoryForget: (userId: string, memoryId: number) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/memory/users/${userId}/${memoryId}`, undefined, 20_000),
      memoryForgetUser: (userId: string) => request<{ removed: number }>('DELETE', `/v1/admin/memory/users/${userId}`, undefined, 20_000),
      audit: async (limit = 100) => (await request<{ events: AuditEvent[] }>('GET', `/v1/admin/audit?limit=${limit}`, undefined, 20_000)).events,
      tools: () => request<{ readOnly: boolean; tools: AdminTool[] }>('GET', '/v1/admin/tools', undefined, 20_000),
      integrations: async () => (await request<{ groups: IntegrationGroup[] }>('GET', '/v1/admin/integrations', undefined, 20_000)).groups,
      guildDetail: (guildId: string) => request<AdminGuildDetail>('GET', `/v1/admin/guilds/${guildId}`, undefined, 20_000),
      guildTools: (guildId: string) => request<{ ferramentas: GuildTool[] }>('GET', `/v1/admin/guilds/${guildId}/mcp-tools`, undefined, 20_000),
      setGuildTool: (guildId: string, nome: string, ligada: boolean) =>
        request<{ ok: boolean; ferramentas: GuildTool[] }>('PUT', `/v1/admin/guilds/${guildId}/mcp-tools/${encodeURIComponent(nome)}`, { ligada, confirm: true }, 30_000),
      resetGuildTools: (guildId: string) => request<{ ok: boolean; ferramentas: GuildTool[] }>('POST', `/v1/admin/guilds/${guildId}/mcp-tools/reset`, { confirm: true }, 30_000),
      tosTerms: () => request<{ paginas: TosPage[] }>('GET', '/v1/admin/tos', undefined, 20_000),
      guildTos: (guildId: string) => request<GuildTosState>('GET', `/v1/admin/guilds/${guildId}/tos`, undefined, 20_000),
      acceptGuildTos: (guildId: string, emNomeDeTerceiros = false) => request<TosAcceptResult>('POST', `/v1/admin/guilds/${guildId}/tos`, { confirm: true, ...(emNomeDeTerceiros ? { emNomeDeTerceiros: true } : {}) }, 30_000),
      revokeGuildTos: (guildId: string) => request<{ ok: boolean; estado: GuildTosState }>('DELETE', `/v1/admin/guilds/${guildId}/tos`, { confirm: true }, 30_000),
      channelConfig: (guildId: string, channelId: string) => request<ChannelConfig>('GET', `/v1/admin/guilds/${guildId}/channels/${channelId}`, undefined, 20_000),
      setPersona: (guildId: string, channelId: string, change: PersonaChange) =>
        request<ChannelConfig>('PUT', `/v1/admin/guilds/${guildId}/channels/${channelId}/persona`, { ...change, confirm: true }, 30_000),
      resetPersona: (guildId: string, channelId: string) => request<ChannelConfig>('DELETE', `/v1/admin/guilds/${guildId}/channels/${channelId}/persona`, { confirm: true }, 30_000),
      setChatter: (guildId: string, channelId: string, change: ChatterChange) =>
        request<ChannelConfig>('PUT', `/v1/admin/guilds/${guildId}/channels/${channelId}/espontaneo`, { ...change, confirm: true }, 30_000),
      setMentions: (guildId: string, respondToEveryone: boolean) =>
        request<{ ok: boolean; respondToEveryone: boolean }>('PUT', `/v1/admin/guilds/${guildId}/mentions`, { respondToEveryone, confirm: true }, 30_000),
      setGuildChannel: (guildId: string, type: GuildChannelType, channelId: string | null) =>
        request<{ ok: boolean }>('PUT', `/v1/admin/guilds/${guildId}/channels`, { type, channelId, ...(type === 'atualizacoes' ? { confirm: true } : {}) }, 20_000),
      followYoutube: (guildId: string, input: FollowYoutubeInput) =>
        request<{ ok: boolean; added: boolean; name: string }>('POST', `/v1/admin/guilds/${guildId}/youtube`, input, 30_000),
      setYoutubeLiveMode: (guildId: string, youtubeId: string, discordChannelId: string, liveMode: YoutubeLiveMode) =>
        request<{ ok: boolean; updated: boolean; liveMode: YoutubeLiveMode }>('PUT', `/v1/admin/guilds/${guildId}/youtube/${encodeURIComponent(youtubeId)}/${discordChannelId}`, { liveMode }, 20_000),
      unfollowYoutube: (guildId: string, youtubeId: string, discordChannelId: string) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/guilds/${guildId}/youtube/${encodeURIComponent(youtubeId)}/${discordChannelId}`, undefined, 20_000),
      followTwitch: (guildId: string, input: { streamer: string; discordChannelId: string; roleId?: string | null }) =>
        request<{ ok: boolean; added: boolean; name: string }>('POST', `/v1/admin/guilds/${guildId}/twitch`, input, 30_000),
      unfollowTwitch: (guildId: string, login: string, discordChannelId: string) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/guilds/${guildId}/twitch/${encodeURIComponent(login)}/${discordChannelId}`, undefined, 20_000),
      ai: () => request<AiOverview>('GET', '/v1/admin/ai', undefined, 20_000),
      aiAddKey: (provider: string, key: string) => request<{ ok: boolean }>('POST', '/v1/admin/ai/keys', { provider, key }, 20_000),
      aiRemoveKey: (provider: string, index: number) => request<{ ok: boolean }>('DELETE', `/v1/admin/ai/keys/${provider}/${index}`, undefined, 20_000),
      aiCloudflare: (accountId: string) => request<{ ok: boolean }>('PUT', '/v1/admin/ai/cloudflare', { accountId }, 20_000),
      aiSetEnabled: (provider: string, enabled: boolean) => request<{ ok: boolean }>('POST', `/v1/admin/ai/providers/${provider}`, { enabled }, 20_000),
      aiAddCustom: (input: AiCustomInput) => request<{ ok: boolean }>('POST', '/v1/admin/ai/custom', input, 20_000),
      aiAddCustomKey: (id: string, key: string) => request<{ ok: boolean }>('POST', `/v1/admin/ai/custom/${id}/keys`, { key }, 20_000),
      aiCustomOptions: (id: string, options: { first?: boolean; anonymous?: boolean; models?: string }) => request<{ ok: boolean; first: boolean; anonymous: boolean }>('POST', `/v1/admin/ai/custom/${id}/options`, options, 20_000),
      aiRemoveCustom: (id: string) => request<{ ok: boolean }>('DELETE', `/v1/admin/ai/custom/${id}`, undefined, 20_000),
      aiTest: (provider: string) => request<AiTestResult>('POST', `/v1/admin/ai/test/${provider}`, {}, 60_000),
      config: () => request<ConfigOverview>('GET', '/v1/admin/config', undefined, 20_000),
      configSet: (chave: string, valor: string, confirm = false, versao?: number) => request<{ ok: boolean; chave: string; reinicio: boolean; versao?: number; botConectado?: boolean }>('PUT', `/v1/admin/config/${chave}`, { valor, ...(confirm ? { confirm: true } : {}), ...(typeof versao === 'number' ? { versao } : {}) }, 20_000),
      configRemove: (chave: string, confirm = false, versao?: number) => {
        const body = { ...(confirm ? { confirm: true } : {}), ...(typeof versao === 'number' ? { versao } : {}) };
        return request<{ ok: boolean; chave: string; reinicio: boolean; versao?: number; botConectado?: boolean }>('DELETE', `/v1/admin/config/${chave}`, Object.keys(body).length ? body : undefined, 20_000);
      },
      sendDiscordDm: (message: string) => request<{ ok: boolean }>('POST', '/v1/admin/discord/dm', { message }, 30_000),
      radio: async () => (await request<{ sessions: RadioSession[] }>('GET', '/v1/admin/radio', undefined, 20_000)).sessions,
      /** Pausar, retomar, parar, tirar da call ou pular (`skip` responde com a faixa que começou ou 'fim-da-fila'). */
      radioAction: (guildId: string, action: RadioAction) => request<RadioResultado>('POST', `/v1/admin/radio/${guildId}`, { action }, 45_000),
      /** Os canais de voz e de texto do servidor para iniciar o rádio (com quem está na call e se a Yui pode entrar/falar ou escrever). Só leitura. */
      radioCanais: (guildId: string) => request<RadioCanais>('GET', `/v1/admin/radio/${guildId}/canais`, undefined, 25_000),
      /** Liga o rádio sem ninguém na call, no canal de voz e no de texto escolhidos (do servidor; a Yui espera alguém entrar por até 10 min). */
      radioIniciar: (guildId: string, input: { voiceChannelId: string; textChannelId: string }) =>
        request<RadioResultado>('POST', `/v1/admin/radio/${guildId}`, { action: 'start', voiceChannelId: input.voiceChannelId, textChannelId: input.textChannelId }, 45_000),
      /** Toca um gênero, uma música ou um link. Quando a busca é ambígua volta `resultado: 'escolher'` com as opções. */
      radioTocar: (guildId: string, query: string) => request<RadioResultado>('POST', `/v1/admin/radio/${guildId}`, { action: 'play', query }, 45_000),
      /** Escolhe uma das opções da última busca ambígua (só o número; as faixas ficam no servidor). */
      radioEscolher: (guildId: string, opcao: number) => request<RadioResultado>('POST', `/v1/admin/radio/${guildId}`, { action: 'choose', opcao: Math.trunc(Number(opcao)) }, 45_000),
      /** Os monitores de busca do dono (lista e estado; nunca o texto de um resultado). */
      monitores: () => request<MonitoresResult>('GET', '/v1/admin/monitores', undefined, 20_000),
      /** Cancela um monitor (definitivo; a tela confirma antes). 404 se já encerrou ou se os monitores estão desligados. */
      cancelMonitor: (id: number) => request<{ ok: boolean }>('DELETE', `/v1/admin/monitores/${Math.trunc(Number(id))}`, undefined, 20_000),
      /** A live do YouTube (estado, qual live, mensagens desta live, cota e último erro). Só leitura. */
      live: () => request<LiveView>('GET', '/v1/admin/live', undefined, 20_000),
      /** A autorização do Google (escopos, validade, renovação, se precisa autorizar de novo). Só leitura; nunca token. */
      google: () => request<GoogleView>('GET', '/v1/admin/google', undefined, 20_000),
      /** Começa a reautorização do Google (a tela confirma antes): devolve só o link de consentimento. 404 com YUI_GOOGLE_REAUTORIZAR_PAINEL desligada; 429 passou de 5 por hora. */
      googleReautorizarInicio: (confirmacao?: string) => request<InicioDaReautorizacao>('POST', '/v1/admin/google/autorizar/inicio', confirmacao ? { confirmacao } : {}, 20_000),
      /**
       * Correção C2: pede a chave de confirmação de UMA ação crítica (aprovar um plano, reautorizar o Google). A chave chega só pela DM do dono (6 dígitos,
       * 5 minutos, uma vez, presa a esta sessão); a resposta nunca a traz. 429 com pedidos demais; 502 se a DM não saiu.
       */
      pedirConfirmacao: (input: PedidoDeConfirmacao) => request<{ ok: boolean; acao: string; expiraEmSegundos: number }>('POST', '/v1/admin/confirmacao/pedir', input, 30_000),
      /** Conclui com o endereço colado (o da página 127.0.0.1 que não abriu). Uso único: errou, comece de novo. */
      googleReautorizarRetorno: (endereco: string) => request<RetornoDaReautorizacao>('POST', '/v1/admin/google/autorizar/retorno', { endereco: String(endereco ?? '') }, 30_000),
      /** Os últimos 20 planos (estado e, dos passos, só a ferramenta e o estado). `painel: true` = dá para aprovar e recusar por aqui. */
      planos: () => request<PlanosResult>('GET', '/v1/admin/planos', undefined, 20_000),
      /** Aprova ou recusa UM plano (a tela confirma antes de aprovar). 404 com YUI_PLANOS_PAINEL desligada; recusa da regra vem com `ok: false` e a frase. */
      decidirPlano: (id: string, input: { versao: number; hash: string; aprovar: boolean; confirmacao?: string }) =>
        request<DecisaoDoPlano>('POST', `/v1/admin/planos/${encodeURIComponent(id)}/decisao`, { versao: input.versao, hash: input.hash, aprovar: input.aprovar === true, ...(input.confirmacao ? { confirmacao: input.confirmacao } : {}) }, 20_000),
      /** Entra numa live do YouTube (o mesmo "entra na live <link> por N horas" da conversa). Pode demorar: a Yui procura o chat e cumprimenta. */
      entrarNaLive: (input: { endereco: string; horas?: number | null }) =>
        request<AcaoDaLive>('POST', '/v1/admin/live/entrar', { endereco: input.endereco, ...(input.horas ? { horas: input.horas } : {}) }, 75_000),
      /** Sai da live (o mesmo "sai da live" da conversa; a tela confirma antes). */
      sairDaLive: () => request<AcaoDaLive>('POST', '/v1/admin/live/sair', {}, 30_000),
      /** A fila de avisos e o que o modo observar registrou (assunto, classe, motivo e até quando). Só leitura. */
      avisos: () => request<AvisosResult>('GET', '/v1/admin/avisos', undefined, 20_000),
      /** GTA: o último diário, o último semanal, a última notícia, onde cada um saiu e o estado das fontes. Só leitura (lido no bot). */
      gta: () => request<GtaView>('GET', '/v1/admin/gta', undefined, 25_000),
      /** Republica o diário, o semanal ou a notícia mais recentes num servidor, no canal daquele tipo configurado nele (a tela confirma antes). 1 a cada 10 min. */
      republicarGta: (input: { tipo: TipoDoGta; guildId: string }) =>
        request<RepublicacaoDoGta>('POST', '/v1/admin/gta/republicar', { tipo: input.tipo, guildId: input.guildId, confirm: true }, 30_000),
      /** As listas pessoais do dono da sessão (nomes, itens e feito). Só leitura. */
      listas: () => request<ListasView>('GET', '/v1/admin/listas', undefined, 20_000),
      /** As skills instaladas e quais estão permitidas. Só leitura. */
      skills: () => request<SkillsView>('GET', '/v1/admin/skills', undefined, 20_000),
      /** Os projetos e as decisões registrados na memória pessoal do dono. */
      continuidade: () => request<ContinuidadeView>('GET', '/v1/admin/continuidade', undefined, 20_000),
      /** Apaga UM projeto ou decisão (definitivo; a tela confirma antes). 404 se não existe ou não é projeto nem decisão. */
      apagarContinuidade: (id: number) => request<{ ok: boolean }>('DELETE', `/v1/admin/continuidade/${Math.trunc(Number(id))}`, { confirm: true }, 20_000),
      logs: (query: LogsQuery = {}) => {
        const qs = new URLSearchParams();
        if (query.kind) qs.set('kind', query.kind);
        if (query.date) qs.set('date', query.date);
        if (query.level) qs.set('level', query.level);
        if (query.q) qs.set('q', query.q);
        if (query.limit) qs.set('limit', String(query.limit));
        return request<LogsResult>('GET', `/v1/admin/logs${qs.toString() ? `?${qs}` : ''}`, undefined, 20_000);
      },
      gateway: () => request<GatewayStatus>('GET', '/v1/admin/gateway', undefined, 20_000),
      gatewayReset: () => request<{ ok: boolean }>('POST', '/v1/admin/gateway/reset', {}, 20_000),
      /** Reinicia a Yui (só o dono, com a confirmação). `escopo`: 'cerebro-e-bot' (dois processos, pelo supervisor) ou 'processo-unico'. O `message` diz a verdade sobre o que reinicia. */
      restart: () => request<{ ok: boolean; message: string; escopo?: 'cerebro-e-bot' | 'processo-unico' }>('POST', '/v1/admin/restart', { confirm: true }, 20_000),
      /** Diagnóstico completo (só o dono, só leitura): o app só mostra, nunca guarda. Membro recebe 403. */
      diagnostico: () => request<Diagnostico>('GET', '/v1/admin/diagnostico', undefined, 20_000),
    },
  };
}

export type YuiClient = ReturnType<typeof createClient>;
