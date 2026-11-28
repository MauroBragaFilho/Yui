/**
 * Lógica da aba Status (diagnóstico completo), sem React e sem rede: transforma o payload do servidor (GET /v1/admin/diagnostico, só o dono) em cartões de texto simples.
 *
 * Regras:
 *  - SÓ LEITURA e SÓ O DONO: o servidor devolve 403 para o membro; o app nem pede (`podeVerDiagnostico`);
 *  - nada além dos campos que o servidor entrega (ele já filtra por uma lista de permitidos: números, booleanos, identificadores curtos e palavras fixas). Aqui cada texto
 *    do servidor ainda passa por `seguro()` (uma linha, sem caracteres de controle, tamanho limitado), e campo ausente vira "—": nada é inventado;
 *  - o diagnóstico NUNCA é guardado em disco pelo app (este arquivo não importa o armazenamento; um teste confere);
 *  - texto em português simples, sem jargão: os códigos fixos viram frases curtas; um código que o app não conhece aparece como o próprio código (já filtrado pelo servidor).
 */
import type { Diagnostico, DiagnosticoChamadaPerfil, DiagnosticoContadoresPerfil, DiagnosticoErro, EstadoGeral, EstadoRotaPrivada, Role } from './api/client.ts';
import { RECONEXOES_ATENCAO } from './overviewLogic.ts';

/** De quanto em quanto tempo a aba pede o diagnóstico de novo enquanto está aberta (o botão "Atualizar" pede na hora). */
export const DIAGNOSTICO_ATUALIZA_MS = 30_000;

export type Tom = 'ok' | 'atencao' | 'problema' | 'neutro';
export interface Linha { rotulo: string; valor: string; tom?: Tom }
export interface Item { titulo: string; detalhe?: string; tom?: Tom; /** A tela mostra rótulo à esquerda e valor à direita (em vez de título e detalhe empilhados). */ alinhado?: boolean }
/** `tecnico`: detalhe para quem mexe na configuração; a tela o deixa recolhido em "Detalhes técnicos", salvo quando o selo pede atenção. */
export interface Cartao { chave: string; titulo: string; selo?: { texto: string; tom: Tom }; linhas: Linha[]; itens?: Item[]; nota?: string; tecnico?: boolean }
export interface VisaoDoDiagnostico { estado: EstadoGeral; geradoEm: string; cartoes: Cartao[] }

/** Só o dono vê o diagnóstico (o servidor também confere: membro = 403). */
export function podeVerDiagnostico(role: Role | string | null | undefined): boolean {
  return role === 'OWNER';
}

// ── Pequenos ajudantes (todos tolerantes: dado ausente ou torto vira "—", nunca um erro) ──────────────────────────────────────────────

const VAZIO = '—';

/** Texto de uma linha só: sem caracteres de controle e com tamanho limitado. Só o que o servidor mandou, nunca algo montado de fora. */
export function seguro(valor: unknown, max = 90): string {
  if (typeof valor !== 'string') return VAZIO;
  const t = valor.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return VAZIO;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const n = (v: unknown): string => { const x = numero(v); return x === null ? VAZIO : String(Math.round(x)); };
const milhar = (v: unknown): string => { const x = numero(v); return x === null ? VAZIO : Math.round(x).toLocaleString('pt-BR'); };

/** 45 -> "45 s"; 300 -> "5 min"; 7500 -> "2 h 5 min"; 200000 -> "2 d 7 h". */
export function duracao(segundos: unknown): string {
  const s = numero(segundos);
  if (s === null || s < 0) return VAZIO;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return m ? `${h} h ${m} min` : `${h} h`; }
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "há 45 s", "há 5 min"... (e "agora" para menos de 5 s). */
export function haQuanto(segundos: unknown): string {
  const s = numero(segundos);
  if (s === null || s < 0) return VAZIO;
  if (s < 5) return 'agora';
  return `há ${duracao(s)}`;
}

/** "1 erro" / "2 erros". */
export const plural = (q: unknown, um: string, varios: string): string => { const x = numero(q); return `${x === null ? VAZIO : Math.round(x)} ${x !== null && Math.round(x) === 1 ? um : varios}`; };

const NOMES: Record<string, string> = { omniroute: 'OmniRoute', gemini: 'Google Gemini', tavily: 'Tavily', groq: 'Groq', serper: 'Serper', openai: 'OpenAI', openrouter: 'OpenRouter', ia: 'IA', tool: 'Ferramenta', search: 'Busca', discord: 'Discord', api: 'App' };
/** Nome de provedor ou etiqueta para a tela: os conhecidos com a grafia certa, os outros com inicial maiúscula. */
export function nomeBonito(valor: unknown): string {
  const t = seguro(valor, 40);
  if (t === VAZIO) return t;
  const k = t.toLowerCase();
  return Object.hasOwn(NOMES, k) ? NOMES[k] : t.charAt(0).toUpperCase() + t.slice(1);
}

const simNao = (v: unknown, sim = 'Sim', nao = 'Não'): string => (v === true ? sim : v === false ? nao : VAZIO);

/** "08:15:30" (hora local) ou "—". */
export function horaLocal(iso: unknown): string {
  if (typeof iso !== 'string') return VAZIO;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return VAZIO;
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Palavras fixas do servidor -> frases curtas ───────────────────────────────────────────────────────────────────────────────────────

const ESTADO_GERAL: Record<EstadoGeral, { texto: string; tom: Tom }> = {
  ok: { texto: 'Tudo certo', tom: 'ok' },
  atencao: { texto: 'Atenção', tom: 'atencao' },
  problema: { texto: 'Problema', tom: 'problema' },
};

/** O estado geral do servidor; um valor desconhecido nunca vira "tudo certo". */
export function estadoGeral(estado: unknown): { texto: string; tom: Tom } {
  return (typeof estado === 'string' && Object.hasOwn(ESTADO_GERAL, estado) ? ESTADO_GERAL[estado as EstadoGeral] : { texto: 'Desconhecido', tom: 'atencao' as Tom });
}

const ROTA_PRIVADA: Record<EstadoRotaPrivada, { texto: string; tom: Tom; explica: string }> = {
  desligada: { texto: 'Desligada', tom: 'neutro', explica: 'O perfil privado não está declarado: a conversa privada segue o caminho de sempre, que nunca usa provedor anônimo.' },
  incompleta: { texto: 'Incompleta', tom: 'atencao', explica: 'O perfil privado está declarado, mas falta algo na configuração: a conversa privada responde com um aviso e nada é enviado a nenhum provedor.' },
  'nao-verificada': { texto: 'Não verificada', tom: 'atencao', explica: 'Ainda não houve uma verificação válida da rota: a conversa privada responde com um aviso até a verificação passar.' },
  validada: { texto: 'Validada', tom: 'ok', explica: 'A última verificação confirmou que a rota usa só um provedor permitido.' },
  'nao-validada': { texto: 'Não validada', tom: 'atencao', explica: 'A última verificação falhou: a conversa privada responde com um aviso. A Yui tenta de novo sozinha, com limite de tentativas.' },
  bloqueada: { texto: 'Bloqueada', tom: 'problema', explica: 'A rota respondeu fora do combinado e foi bloqueada: a conversa privada fica sem IA até uma nova verificação válida.' },
};

/** O estado da rota privada com a explicação; um estado desconhecido vira "Desconhecido" (atenção), nunca "validada". */
export function rotaPrivada(estado: unknown): { texto: string; tom: Tom; explica: string } {
  return typeof estado === 'string' && Object.hasOwn(ROTA_PRIVADA, estado)
    ? ROTA_PRIVADA[estado as EstadoRotaPrivada]
    : { texto: 'Desconhecido', tom: 'atencao', explica: 'O servidor mandou um estado que este app não conhece.' };
}

const MOTIVOS_CODIGO: Record<string, string> = {
  rede: 'falha de rede',
  'tempo-esgotado': 'tempo esgotado',
  'prazo-esgotado': 'prazo esgotado',
  servidor: 'erro do servidor',
  http: 'resposta de erro',
  cota: 'cota esgotada',
  autenticacao: 'chave recusada',
  'resposta-vazia': 'resposta vazia',
  'resposta-invalida': 'resposta inválida',
  'configuracao-mudou': 'a configuração mudou',
  'rota-mudou': 'a rota mudou',
  'cabecalho-ausente': 'sem o cabeçalho de decisão',
  'cabecalho-invalido': 'cabeçalho de decisão inválido',
  'formato-desconhecido': 'formato de decisão desconhecido',
  'formato-nao-definido': 'formato de decisão não definido',
  'campo-ausente': 'sem o campo do provedor',
  'provedor-invalido': 'provedor fora da lista permitida',
  'provedor-nao-cadastrado': 'provedor não cadastrado',
  'chamada-privada': 'a chamada era privada',
  'bot-separado': 'bot separado',
  'sem-chave': 'sem chave',
};
/** Uma palavra fixa do servidor em português; uma palavra que o app não conhece aparece como ela é (o servidor já a filtrou). */
export function motivoEmTexto(codigo: unknown): string {
  if (typeof codigo !== 'string' || !codigo) return VAZIO;
  return Object.hasOwn(MOTIVOS_CODIGO, codigo) ? MOTIVOS_CODIGO[codigo] : seguro(codigo.replace(/-/g, ' '), 60);
}

const TIPO_DE_ERRO: Record<string, string> = { cota: 'cota esgotada', autenticacao: 'chave recusada', tempo: 'tempo esgotado', rede: 'falha de rede', servidor: 'erro do servidor', http: 'resposta de erro', outro: 'erro' };
/** O último erro de um provedor: só o tipo e o código HTTP (o servidor nunca manda o texto do erro). */
export function erroEmTexto(e: DiagnosticoErro | null | undefined): string {
  if (!e || typeof e !== 'object') return VAZIO;
  const tipo = typeof e.tipo === 'string' && Object.hasOwn(TIPO_DE_ERRO, e.tipo) ? TIPO_DE_ERRO[e.tipo] : 'erro';
  const status = numero(e.status);
  return status === null ? tipo : `${tipo} (HTTP ${Math.round(status)})`;
}

const RESULTADO_DA_CHAMADA: Record<string, { texto: string; tom: Tom }> = {
  ok: { texto: 'respondeu', tom: 'ok' },
  erro: { texto: 'falhou', tom: 'atencao' },
  fallback: { texto: 'caiu no caminho de sempre', tom: 'atencao' },
  fechado: { texto: 'fechada por segurança', tom: 'atencao' },
  bloqueado: { texto: 'resposta barrada', tom: 'problema' },
  recusado: { texto: 'recusada (chamada privada)', tom: 'neutro' },
};

const DECISAO: Record<string, string> = { confirmada: 'provedor confirmado', 'nao-confirmada': 'provedor não confirmado', verificada: 'provedor verificado', violada: 'provedor fora da lista', 'nao-aplicavel': '' };

/** Uma chamada recente a um perfil: o combo, o provedor que respondeu, a estratégia, o fallback, o limite e a latência. */
export function chamadaEmItem(c: DiagnosticoChamadaPerfil, agora: number): Item {
  const r = RESULTADO_DA_CHAMADA[String(c.resultado)] ?? { texto: 'resultado desconhecido', tom: 'atencao' as Tom };
  const quando = typeof c.quando === 'string' && !Number.isNaN(Date.parse(c.quando)) ? haQuanto(Math.max(0, (agora - Date.parse(c.quando)) / 1000)) : VAZIO;
  const partes = [
    `Provedor que respondeu: ${c.provedorQueRespondeu ? seguro(c.provedorQueRespondeu, 40) : 'não confirmado'}`,
    `Estratégia: ${c.estrategia ? seguro(c.estrategia, 40) : VAZIO}`,
    `Caminho de sempre usado: ${c.fallbackUsado === true ? 'sim' : c.fallbackUsado === false ? 'não' : VAZIO}`,
    `Limite: ${numero(c.limiteDeTokens) === null ? VAZIO : `${milhar(c.limiteDeTokens)} tokens`}`,
    `Demorou: ${numero(c.latenciaMs) === null ? VAZIO : `${milhar(c.latenciaMs)} ms`}`,
  ];
  const extra = [c.decisao && DECISAO[c.decisao] ? DECISAO[c.decisao] : '', c.motivo ? `motivo: ${motivoEmTexto(c.motivo)}` : ''].filter(Boolean);
  return {
    titulo: `${c.perfil ? seguro(c.perfil, 20) : 'perfil'} · combo ${c.combo ? seguro(c.combo, 40) : VAZIO} · ${r.texto} · ${quando}`,
    detalhe: [...partes, ...extra].join(' · '),
    tom: r.tom,
  };
}

// ── Os cartões ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function cartaoGeral(d: Diagnostico): Cartao {
  const e = estadoGeral(d.estado);
  const motivos = Array.isArray(d.motivos) ? d.motivos.slice(0, 20) : [];
  // O motivo do banco diz QUAL banco (antes o nome só aparecia no fim da página, em "Erros e bancos").
  const bancos = (Array.isArray(d.bancos?.comAlerta) ? d.bancos.comAlerta : []).slice(0, 10).map((x) => seguro(x, 40)).filter((x) => x !== VAZIO);
  const itens: Item[] = motivos.map((m) => ({
    titulo: m?.codigo === 'banco-com-alerta' && bancos.length ? `${bancos.length === 1 ? 'Banco de dados com alerta' : 'Bancos de dados com alerta'}: ${bancos.join(', ')}.` : seguro(m?.texto, 160),
    tom: d.estado === 'problema' ? 'problema' : 'atencao',
  } as Item));
  const rec = numero(d.erros?.reconexoesDoDiscord24h) ?? 0;
  if (rec >= RECONEXOES_ATENCAO) itens.push({ titulo: `${Math.round(rec)} reconexões do Discord nas últimas 24 h (a rede da máquina da Yui pode estar instável).`, tom: 'atencao' });
  // Com aviso na lista, o selo nunca diz "Tudo certo".
  const selo = itens.length && e.tom === 'ok' ? { texto: 'Atenção', tom: 'atencao' as Tom } : e;
  return {
    chave: 'geral',
    titulo: 'Estado geral',
    selo,
    linhas: [
      { rotulo: 'Atualizado às', valor: horaLocal(d.geradoEm) },
      { rotulo: 'Funcionamento', valor: d.modo === 'cerebro-separado' ? 'Dois processos (cérebro + bot)' : d.modo === 'unico' ? 'Processo único' : VAZIO },
    ],
    itens,
    nota: itens.length === 0 && d.estado === 'ok' ? 'Nenhum motivo de atenção agora.' : undefined,
  };
}

function cartaoProcessos(d: Diagnostico): Cartao {
  const c = d.cerebro;
  if (!c) {
    return {
      chave: 'processos', titulo: 'Yui (processo único)',
      linhas: [
        { rotulo: 'Tempo de atividade', valor: duracao(d.processo?.uptimeSegundos) },
        { rotulo: 'RAM da Yui', valor: numero(d.processo?.memoriaMB) === null ? VAZIO : `${n(d.processo.memoriaMB)} MB` },
      ],
    };
  }
  const bot = c.botConectado;
  const discord = c.discordOnline;
  const travas = numero(c.travasPerdidas) ?? 0;
  return {
    chave: 'processos', titulo: 'Cérebro e bot',
    selo: bot === true ? { texto: 'Bot conectado', tom: 'ok' } : bot === false ? { texto: 'Bot desconectado', tom: 'atencao' } : { texto: 'Bot: desconhecido', tom: 'neutro' },
    linhas: [
      { rotulo: 'Cérebro ligado há', valor: duracao(c.uptimeSegundos) },
      { rotulo: 'Bot ligado ao cérebro', valor: simNao(bot), tom: bot === false ? 'atencao' : bot === true ? 'ok' : 'neutro' },
      { rotulo: 'Discord (visto pelo bot)', valor: discord === true ? 'Conectado' : discord === false ? 'Desconectado' : 'Desconhecido', tom: discord === false ? 'atencao' : discord === true ? 'ok' : 'neutro' },
      { rotulo: 'IA que o cérebro usa', valor: c.backend ? seguro(c.backend, 40) : VAZIO },
      { rotulo: 'Travas de dono perdidas', valor: String(travas), tom: travas > 0 ? 'problema' : 'ok' },
      { rotulo: 'RAM do cérebro', valor: numero(d.processo?.memoriaMB) === null ? VAZIO : `${n(d.processo.memoriaMB)} MB` },
    ],
  };
}

/** "(anônimo)" só quando o nome ainda não diz isso ("Pollinations (grátis, anônimo)" não vira "... (anônimo) (anônimo)"). */
export function comAnonimo(nome: string, anonimo: boolean): string {
  return anonimo && !/an[oô]nimo/i.test(nome) ? `${nome} (anônimo)` : nome;
}

function cartaoIa(d: Diagnostico): Cartao {
  const ia = d.ia;
  const provedores = Array.isArray(ia?.provedores) ? ia.provedores.slice(0, 30) : [];
  const t = ia?.totais ?? {};
  return {
    chave: 'ia', titulo: 'Inteligência artificial',
    selo: !ia?.gatewayConfigurado ? { texto: 'Gateway não configurado', tom: 'neutro' }
      : ia.algumDisponivel === false ? { texto: 'Nenhum provedor disponível', tom: 'problema' }
        : ia.algumDisponivel === true ? { texto: 'Provedor disponível', tom: 'ok' } : undefined,
    linhas: [
      { rotulo: 'Caminho em uso', valor: ia?.backendAtivo ? seguro(ia.backendAtivo, 40) : VAZIO },
      { rotulo: 'Responderia agora', valor: ia?.provedorAtual ? nomeBonito(ia.provedorAtual) : ia?.gatewayConfigurado ? 'nenhum provedor disponível' : VAZIO, tom: ia?.gatewayConfigurado && !ia.provedorAtual ? 'problema' : undefined },
      { rotulo: 'Chamadas aos provedores', valor: `${milhar(t.requests)} (${milhar(t.ok)} ok, ${milhar(t.failed)} com falha)` },
    ],
    itens: provedores.map((p) => {
      const alvos = Array.isArray(p.alvos) ? p.alvos : [];
      const disponiveis = alvos.filter((a) => a.disponivel === true).length;
      const comErro = alvos.map((a) => erroEmTexto(a.ultimoErro)).find((x) => x !== VAZIO);
      const tom: Tom = alvos.length && disponiveis === 0 ? 'problema' : (numero(p.descansoSegundos) ?? 0) > 0 || comErro ? 'atencao' : 'ok';
      return {
        titulo: comAnonimo(seguro(p.rotulo || p.id, 40), p.anonimo === true),
        detalhe: [
          `${disponiveis} de ${alvos.length} ${alvos.length === 1 ? 'modelo disponível' : 'modelos disponíveis'}`,
          `${plural(p.chaves, 'chave', 'chaves')}${(numero(p.chavesEmDescanso) ?? 0) > 0 ? `, ${n(p.chavesEmDescanso)} em descanso` : ''}`,
          (numero(p.descansoSegundos) ?? 0) > 0 ? `em descanso por mais ${duracao(p.descansoSegundos)}` : '',
          comErro ? `último erro: ${comErro}` : '',
        ].filter(Boolean).join(' · '),
        tom,
      };
    }),
  };
}

function cartaoLimites(d: Diagnostico): Cartao {
  const l = d.limitesDeTokens;
  const lista = (a: { provedor: string; limite: number; origem: string }[] | undefined): Item[] => (Array.isArray(a) ? a : []).slice(0, 30)
    .map((x) => ({ titulo: nomeBonito(x.provedor), detalhe: `${milhar(x.limite)} tokens${x.origem ? ` · ${seguro(x.origem, 80)}` : ''}` }));
  const app = lista(l?.app?.provedores);
  const discord = l?.discord?.aplica === true ? lista(l.discord.provedores) : [];
  return {
    chave: 'limites', titulo: 'Limites de tokens', tecnico: true,
    selo: l?.erroDeConfiguracao === true ? { texto: 'Configuração inválida (valendo o padrão)', tom: 'atencao' } : undefined,
    linhas: [
      { rotulo: 'Teto global', valor: numero(l?.teto) === null ? VAZIO : `${milhar(l.teto)} tokens` },
      { rotulo: 'No Discord', valor: l?.discord?.aplica === true ? `${plural(discord.length, 'provedor', 'provedores')} abaixo` : 'usa os limites da cadeia do bot (processo único)' },
      { rotulo: 'No app', valor: `${plural(app.length, 'provedor', 'provedores')} abaixo` },
    ],
    itens: [...discord.map((i) => ({ ...i, titulo: `Discord · ${i.titulo}` })), ...app.map((i) => ({ ...i, titulo: `App · ${i.titulo}` }))],
  };
}

function cartaoCotas(d: Diagnostico): Cartao {
  const c = d.cotasDeBusca;
  const h = c?.hora;
  const g = h?.global;
  const p = h?.persistencia;
  const cheia = g?.cheia === true;
  const indisponivel = p?.pesquisaDisponivel === false || p?.gravacaoComFalha === true;
  // Provedor sem cota no mês (teto 0) e sem uso não diz nada: "Bing 0 de 0" sai da lista.
  const mes = (Array.isArray(c?.mes) ? c.mes.slice(0, 12) : []).filter((m) => !((numero(m?.teto) ?? 0) === 0 && (numero(m?.usadas) ?? 0) === 0));
  return {
    chave: 'cotas', titulo: 'Cotas de busca', tecnico: true,
    selo: indisponivel ? { texto: 'Pesquisa indisponível', tom: 'atencao' } : cheia ? { texto: 'Teto da hora atingido', tom: 'atencao' } : undefined,
    linhas: [
      { rotulo: 'Esta hora', valor: `${n(g?.usadas)} de ${n(g?.limite)}${cheia ? ` (libera em ${duracao(g?.liberaEmSegundos)})` : ''}`, tom: cheia ? 'atencao' : undefined },
      { rotulo: 'Limite por pessoa', valor: `${n(h?.porPessoaLimite)} por hora` },
      { rotulo: 'Buscas reaproveitadas', valor: n(h?.reutilizadas) },
      { rotulo: 'Registro da cota em disco', valor: p?.gravacaoComFalha === true ? 'falhou ao gravar' : p?.gravando === true ? 'gravando' : p?.gravando === false ? 'desligado' : VAZIO, tom: p?.gravacaoComFalha === true ? 'atencao' : undefined },
      { rotulo: 'Pesquisa na web', valor: p?.pesquisaDisponivel === true ? 'disponível' : p?.pesquisaDisponivel === false ? 'indisponível agora' : VAZIO, tom: p?.pesquisaDisponivel === false ? 'atencao' : undefined },
      ...(numero(c?.reservaPercentual) === null ? [] : [{ rotulo: 'Reserva para o /yui', valor: `${n(c.reservaPercentual)}% da cota` }]),
    ],
    itens: mes.map((m) => ({ titulo: `${nomeBonito(m.provedor)} (mês)`, alinhado: true, detalhe: `${milhar(m.usadas)} de ${milhar(m.teto)}`, tom: numero(m.teto) && (numero(m.usadas) ?? 0) >= (numero(m.teto) ?? 0) ? 'atencao' : 'ok' } as Item)),
  };
}

function cartaoPerfis(d: Diagnostico, agora: number): Cartao | null {
  const p = d.perfisDeIa;
  if (!p) return null;
  const perfis = Array.isArray(p.perfis) ? p.perfis.slice(0, 10) : [];
  const erros = Array.isArray(p.errosDeConfiguracao) ? p.errosDeConfiguracao.slice(0, 20) : [];
  const ultimas = (Array.isArray(p.ultimas) ? p.ultimas : []).slice(-10).reverse();
  const t: Partial<DiagnosticoContadoresPerfil> = p.totais ?? {};
  const itens: Item[] = [
    ...erros.map((e) => ({ titulo: `Erro na configuração${e.perfil ? ` do perfil ${seguro(e.perfil, 20)}` : ''}`, detalhe: motivoEmTexto(e.codigo), tom: 'atencao' } as Item)),
    ...perfis.map((x) => ({
      titulo: `Perfil ${seguro(x.nome, 20)}${x.habilitado === true ? '' : x.habilitado === false ? ' (desligado)' : ''}`,
      detalhe: [
        `combo ${x.combo ? seguro(x.combo, 40) : VAZIO}`,
        x.privacidade === 'privada' ? 'privado' : x.privacidade === 'geral' ? 'geral' : '',
        `limite ${numero(x.limiteEfetivo) === null ? VAZIO : `${milhar(x.limiteEfetivo)} tokens`}`,
        `${plural(x.chamadas, 'chamada', 'chamadas')}: ${n(x.ok)} ok, ${plural(x.erros, 'erro', 'erros')}, ${n(x.fallbacks)} pelo caminho de sempre, ${plural(x.fechadas, 'fechada', 'fechadas')}`,
        x.provedorCadastrado === false ? 'provedor da Yui não cadastrado' : '',
      ].filter(Boolean).join(' · '),
      tom: x.habilitado === false ? 'neutro' : x.provedorCadastrado === false ? 'atencao' : 'ok',
    } as Item)),
  ];
  if (p.configurado !== true && !perfis.length && !erros.length && !ultimas.length) {
    // Sem perfil, os contadores são todos zero: uma frase basta.
    return { chave: 'perfis', titulo: 'Perfis de IA', tecnico: true, selo: { texto: 'Nenhum perfil configurado', tom: 'neutro' }, linhas: [], nota: 'Sem perfil configurado, a IA responde pelo caminho de sempre.' };
  }
  return {
    chave: 'perfis', titulo: 'Perfis de IA', tecnico: true,
    selo: p.configurado === true ? { texto: 'Configurados', tom: erros.length ? 'atencao' : 'ok' } : { texto: 'Nenhum perfil configurado', tom: 'neutro' },
    linhas: [
      { rotulo: 'Origem da configuração', valor: p.origem === 'nenhuma' ? 'nenhuma' : p.origem === 'arquivo' ? 'arquivo' : p.origem === 'ambiente' ? 'variável de ambiente' : seguro(p.origem, 30) },
      { rotulo: 'Chamadas por perfil', valor: `${n(t.chamadas)} (${n(t.ok)} ok, ${plural(t.erros, 'erro', 'erros')}, ${n(t.fallbacks)} pelo caminho de sempre, ${plural(t.fechadas, 'fechada', 'fechadas')})` },
    ],
    itens: [...itens, ...ultimas.map((c) => chamadaEmItem(c, agora))],
    nota: p.configurado === true ? 'Abaixo dos perfis, as últimas chamadas (a mais recente primeiro).' : 'Sem perfil configurado, a IA responde pelo caminho de sempre.',
  };
}

function cartaoRotaPrivada(d: Diagnostico): Cartao | null {
  const r = d.perfisDeIa?.rotaPrivada;
  if (!r) return null;
  const e = rotaPrivada(r.estado);
  const falhas = Array.isArray(r.falhasRecentes) ? r.falhasRecentes.slice(0, 5) : [];
  const ativa = r.estado !== 'desligada' && r.estado !== 'incompleta' && r.estado !== 'bloqueada';
  const seguidas = numero(r.falhasSeguidas) ?? 0;
  if (r.estado === 'desligada' && !falhas.length && !(numero(r.violacoes) ?? 0) && !(numero(r.sondas) ?? 0)) {
    // Desligada e sem histórico: os campos seriam todos zero ou "—"; fica só o estado e a explicação.
    return { chave: 'rota-privada', titulo: 'Rota privada da IA', tecnico: true, selo: { texto: e.texto, tom: e.tom }, linhas: [], nota: e.explica };
  }
  return {
    chave: 'rota-privada', titulo: 'Rota privada da IA', tecnico: true,
    selo: { texto: e.texto, tom: e.tom },
    linhas: [
      { rotulo: 'Estado', valor: e.texto, tom: e.tom },
      ...(r.motivo ? [{ rotulo: 'Motivo', valor: motivoEmTexto(r.motivo) }] : []),
      { rotulo: 'Falhas seguidas da verificação', valor: String(seguidas), tom: seguidas > 0 ? 'atencao' as Tom : undefined },
      { rotulo: 'Verificação sozinha', valor: r.sondaSozinhaPausada === true ? 'pausada (limite de tentativas)' : ativa ? 'ativa' : 'não se aplica', tom: r.sondaSozinhaPausada === true ? 'atencao' as Tom : undefined },
      { rotulo: 'Verificações válidas', valor: `${n(r.sondasValidas)} de ${n(r.sondas)}` },
      { rotulo: 'Última verificação', valor: haQuanto(r.ultimaSondaHaSegundos) },
      { rotulo: 'Respostas fora do combinado', valor: n(r.violacoes), tom: (numero(r.violacoes) ?? 0) > 0 ? 'problema' as Tom : undefined },
      { rotulo: 'Formato da decisão definido', valor: simNao(r.formatoDefinido) },
    ],
    itens: falhas.map((f) => ({ titulo: `${haQuanto(f.haSegundos)} · ${motivoEmTexto(f.motivo)}`, tom: 'atencao' } as Item)),
    nota: e.explica,
  };
}

function cartaoMotor(d: Diagnostico): Cartao | null {
  const m = d.motorAgente;
  if (!m) return null;
  const ativo = seguro(m.ativo, 30);
  const pedido = seguro(m.pedido, 30);
  return {
    chave: 'motor', titulo: 'Motor do agente', tecnico: true,
    selo: m.recusado === true ? { texto: 'Pedido recusado', tom: 'atencao' } : undefined,
    // O Mastra foi descartado (18/11/2026): a linha "Mastra: ainda não implementado" saiu. O pedido só aparece quando difere do motor em uso.
    linhas: [
      { rotulo: 'Em uso', valor: ativo },
      ...(pedido !== ativo ? [{ rotulo: 'Pedido', valor: pedido }] : []),
    ],
    nota: m.recusado === true ? 'O motor pedido não está implementado: a Yui segue no motor nativo.' : undefined,
  };
}

function cartaoErros(d: Diagnostico): Cartao {
  const e = d.erros;
  const b = d.bancos;
  const por = (Array.isArray(e?.porEtiqueta) ? e.porEtiqueta : []).slice(0, 8);
  const comAlerta = (Array.isArray(b?.comAlerta) ? b.comAlerta : []).slice(0, 10).map((x) => seguro(x, 40));
  return {
    chave: 'erros', titulo: 'Erros e bancos',
    selo: (numero(e?.ultimas24h) ?? 0) >= 20 ? { texto: 'Muitos erros no log', tom: 'atencao' } : undefined,
    linhas: [
      { rotulo: 'Erros nas últimas 24 h', valor: n(e?.ultimas24h), tom: (numero(e?.ultimas24h) ?? 0) >= 20 ? 'atencao' : undefined },
      { rotulo: 'Reconexões do Discord (24 h)', valor: n(e?.reconexoesDoDiscord24h) },
      { rotulo: 'Bancos de dados', valor: `${plural(b?.total, 'banco aberto', 'bancos abertos')}, ${numero(b?.tamanhoTotalMB) === null ? VAZIO : `${Math.round(b.tamanhoTotalMB)} MB`}` },
      { rotulo: 'Bancos com alerta', valor: comAlerta.length ? comAlerta.join(', ') : 'nenhum', tom: comAlerta.length ? 'atencao' : undefined },
    ],
    itens: por.map((x) => ({ titulo: nomeBonito(x.etiqueta), alinhado: true, detalhe: plural(x.quantidade, 'erro', 'erros') })),
  };
}

function cartaoAvisos(d: Diagnostico): Cartao | null {
  const avisos = Array.isArray(d.avisosDeConfiguracao) ? d.avisosDeConfiguracao.slice(0, 10) : [];
  if (!avisos.length) return null;
  return {
    chave: 'avisos', titulo: 'Avisos de configuração', selo: { texto: plural(avisos.length, 'aviso', 'avisos'), tom: 'atencao' }, linhas: [],
    itens: avisos.map((a) => ({ titulo: seguro(a.variavel, 60), detalhe: `${seguro(a.problema, 160)} (valendo: ${typeof a.usando === 'number' ? String(a.usando) : seguro(a.usando, 60)})`, tom: 'atencao' } as Item)),
  };
}

/**
 * Divide os cartões em principais (sempre à vista) e técnicos (recolhidos). Um cartão técnico que pede atenção ou acusa problema
 * sobe para os principais: nada que precise do dono fica escondido.
 */
export function separarCartoes(cartoes: Cartao[]): { principais: Cartao[]; tecnicos: Cartao[] } {
  const principais: Cartao[] = [];
  const tecnicos: Cartao[] = [];
  for (const c of cartoes) {
    const alerta = c.selo?.tom === 'atencao' || c.selo?.tom === 'problema';
    (c.tecnico && !alerta ? tecnicos : principais).push(c);
  }
  return { principais, tecnicos };
}

/** Tudo que a aba Status mostra do diagnóstico, na ordem da tela. Sem dado inventado: o que o servidor não mandou não vira cartão. */
export function visaoDoDiagnostico(d: Diagnostico, agora: number = Date.now()): VisaoDoDiagnostico {
  const cartoes = [
    cartaoGeral(d), cartaoProcessos(d), cartaoIa(d), cartaoLimites(d), cartaoCotas(d), cartaoPerfis(d, agora), cartaoRotaPrivada(d), cartaoMotor(d), cartaoErros(d), cartaoAvisos(d),
  ].filter((c): c is Cartao => c !== null);
  return { estado: typeof d.estado === 'string' && Object.hasOwn(ESTADO_GERAL, d.estado) ? d.estado : 'atencao', geradoEm: horaLocal(d.geradoEm), cartoes };
}
