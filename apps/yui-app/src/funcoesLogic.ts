/**
 * Regras da aba "Funções" do servidor (lacunas do painel, item 8): um interruptor por FUNÇÃO de uso, em português simples, por cima das ferramentas
 * técnicas do servidor (as mesmas do /yui-ferramentas, gravadas no server_tools.json pelas rotas que já existem). Quando faz sentido, várias ferramentas
 * viram uma função só (os dois downloads, os dois lembretes); a tela liga ou desliga todas juntas. Ferramenta nova que ainda não tem função aqui aparece
 * em "Outras funções" com o próprio nome, para nada ficar sem interruptor. Arquivo sem React, testável em Node.
 */
import type { AdminGuildDetail, ChannelRef, GuildTool } from './api/client.ts';
import { avisoDaFerramenta, semEmoji } from './guildLogic.ts';

export interface DefinicaoDeFuncao {
  chave: string;
  nome: string;
  descricao: string;
  /** As ferramentas técnicas (nomes do mcp_tools.json) que esta função liga e desliga juntas. */
  ferramentas: string[];
  /** Aviso mostrado antes de LIGAR (sem ele, vale o da ferramenta em guildLogic.ts). */
  aviso?: string;
}

const AVISO_DOWNLOAD = 'Downloads ocupam o disco do computador da Yui e podem envolver conteúdo protegido.';

/** As funções da tela, na ordem em que aparecem (as do pedido de 19/11: imagem, pesquisa, GTA, downloads, buscar jogo, Steam, moeda, lembretes, voz). */
export const FUNCOES: readonly DefinicaoDeFuncao[] = Object.freeze([
  { chave: 'imagem', nome: 'Gerar imagens', descricao: 'Cria imagens a partir de uma descrição, pela conversa e pelo /yui-imagem.', ferramentas: ['generate_image'] },
  { chave: 'pesquisa', nome: 'Pesquisa na internet', descricao: 'Procura informações atuais na web quando a pergunta pede.', ferramentas: ['search_web'] },
  {
    chave: 'gta', nome: 'GTA Online', ferramentas: ['gta_online'],
    descricao: 'Responde sobre o evento semanal, o reset diário e as notícias, pela conversa e pelos /gta-diario, /gta-semanal e /gta-noticias. A publicação automática nos canais é separada (veja abaixo).',
  },
  { chave: 'downloads', nome: 'Baixar áudio e vídeo por link', descricao: 'Baixa o áudio (MP3) ou o vídeo (MP4) de um link do YouTube, Instagram ou TikTok.', ferramentas: ['download_audio', 'download_video'], aviso: AVISO_DOWNLOAD },
  { chave: 'jogo', nome: 'Buscar jogo para baixar', descricao: 'Procura links de download de jogos de PC (torrent e magnet).', ferramentas: ['search_game'], aviso: 'Os links levam a sites de terceiros e podem envolver conteúdo protegido.' },
  { chave: 'steam', nome: 'Steam', descricao: 'Preço, situação e informações de um jogo na Steam.', ferramentas: ['check_steam'] },
  { chave: 'moeda', nome: 'Conversor de moedas', descricao: 'Converte valores entre moedas com a cotação do dia.', ferramentas: ['convert_currency'] },
  { chave: 'lembretes', nome: 'Lembretes', descricao: 'Cada pessoa cria e vê os próprios lembretes; o aviso chega por mensagem privada.', ferramentas: ['listar_lembretes', 'criar_lembrete'] },
  { chave: 'voz', nome: 'Voz na call', descricao: 'A Yui entra na call de quem pedir para ouvir e conversar (e sai quando pedirem).', ferramentas: ['join_voice_call'] },
  { chave: 'falar', nome: 'Falar na call', descricao: 'Com a Yui na call, ela responde falando: respostas curtas, com o texto completo no chat.', ferramentas: ['voice_tts'] },
]);

/** As outras ferramentas alternáveis, agrupadas e com nome simples (aparecem abaixo das principais). */
export const OUTRAS_FUNCOES: readonly DefinicaoDeFuncao[] = Object.freeze([
  { chave: 'musica', nome: 'Baixar música pelo nome', descricao: 'Procura e baixa uma música pelo nome, ou a que a pessoa está ouvindo agora.', ferramentas: ['search_and_download_music', 'get_current_music'], aviso: AVISO_DOWNLOAD },
  { chave: 'info-jogo', nome: 'Informações de jogos', descricao: 'Notas, gêneros, tempo de jogo e se o jogo roda no PC da pessoa.', ferramentas: ['check_game_info', 'check_pc_compatibility'] },
  { chave: 'menu', nome: 'Menu de ajuda', descricao: 'Mostra o menu de ajuda, as redes sociais e as novidades.', ferramentas: ['show_bot_menu'] },
  { chave: 'radio-voz', nome: 'Comandos de voz no rádio', descricao: 'No rádio, entende pedidos de música falados na call.', ferramentas: ['radio_voice_stt'] },
]);

export type EstadoDaFuncao = 'ligada' | 'desligada' | 'em-parte';

export interface VistaDaFuncao {
  chave: string;
  nome: string;
  descricao: string;
  /** As ferramentas desta função que existem no servidor (as que a tela vai mudar). */
  ferramentas: string[];
  estado: EstadoDaFuncao;
  /** Como fica com "Restaurar padrão". */
  padrao: EstadoDaFuncao;
  aviso: string | null;
}

const estadoDe = (ligadas: boolean[]): EstadoDaFuncao => (ligadas.every(Boolean) ? 'ligada' : ligadas.some(Boolean) ? 'em-parte' : 'desligada');

function vista(def: DefinicaoDeFuncao, presentes: GuildTool[]): VistaDaFuncao {
  return {
    chave: def.chave,
    nome: def.nome,
    descricao: def.descricao,
    ferramentas: presentes.map((f) => f.nome),
    estado: estadoDe(presentes.map((f) => f.ligada)),
    padrao: estadoDe(presentes.map((f) => f.padraoLigada)),
    aviso: def.aviso ?? presentes.map((f) => avisoDaFerramenta(f.nome)).find(Boolean) ?? null,
  };
}

/**
 * As funções da tela a partir da lista do servidor (GET /v1/admin/guilds/:id/mcp-tools). Função sem nenhuma ferramenta no servidor não aparece; ferramenta
 * do servidor que nenhuma função cobre vira uma função própria em "outras" (nome e descrição do servidor, sem emoji). Não altera a lista recebida.
 */
export function montarFuncoes(ferramentas: GuildTool[]): { principais: VistaDaFuncao[]; outras: VistaDaFuncao[] } {
  const lista = Array.isArray(ferramentas) ? ferramentas : [];
  const porNome = new Map(lista.map((f) => [f.nome, f]));
  const cobertas = new Set<string>();
  const montar = (defs: readonly DefinicaoDeFuncao[]) => defs.flatMap((def) => {
    const presentes = def.ferramentas.map((n) => porNome.get(n)).filter((f): f is GuildTool => Boolean(f));
    presentes.forEach((f) => cobertas.add(f.nome));
    return presentes.length ? [vista(def, presentes)] : [];
  });
  const principais = montar(FUNCOES);
  const outras = montar(OUTRAS_FUNCOES);
  for (const f of lista) {
    if (cobertas.has(f.nome)) continue;
    outras.push(vista({ chave: `ferramenta-${f.nome}`, nome: semEmoji(f.rotulo) || f.nome, descricao: semEmoji(f.descricao), ferramentas: [f.nome] }, [f]));
  }
  return { principais, outras };
}

/**
 * O que o interruptor faz: ligada -> desliga todas; desligada ou em parte -> liga todas. Só as ferramentas que ainda não estão no estado pedido entram
 * (a tela chama a rota de cada uma, na ordem).
 */
export function mudancaDaFuncao(f: VistaDaFuncao, atuais: GuildTool[]): { ligar: boolean; ferramentas: string[] } {
  const ligar = f.estado !== 'ligada';
  const estado = new Map((Array.isArray(atuais) ? atuais : []).map((t) => [t.nome, t.ligada]));
  return { ligar, ferramentas: f.ferramentas.filter((n) => estado.has(n) && estado.get(n) !== ligar) };
}

/** O texto da confirmação (com o aviso, quando liga) e o rótulo do botão. */
export function perguntaDaFuncao(f: Pick<VistaDaFuncao, 'nome' | 'aviso' | 'ferramentas'>, ligar: boolean): { titulo: string; texto: string; sim: string } {
  return {
    titulo: ligar ? 'Ligar função?' : 'Desligar função?',
    texto: [
      `"${f.nome}" neste servidor.`,
      ligar ? null : 'Pela conversa e pelos comandos, a Yui passa a responder que a função está desativada aqui. Na DM nada muda.',
      ligar && f.aviso ? `Atenção: ${f.aviso}` : null,
    ].filter(Boolean).join('\n\n'),
    sim: ligar ? 'Ligar' : 'Desligar',
  };
}

/** A mensagem depois de mudar: tudo certo, ou quantas mudaram antes do erro (a tela recarrega o estado verdadeiro). */
export function resultadoDaFuncao(nome: string, ligar: boolean, feitas: number, total: number, erro: string | null = null): string {
  if (!erro && feitas >= total) return `${nome}: ${ligar ? 'ligada' : 'desligada'}.`;
  const parte = feitas > 0 ? `só ${feitas} de ${total} partes mudaram` : 'nada mudou';
  return `${nome}: ${parte}${erro ? ` (${erro})` : ''}. Confira o estado abaixo e tente de novo.`;
}

export const TEXTO_DO_ESTADO: Record<EstadoDaFuncao, string> = { ligada: 'Ligada', desligada: 'Desligada', 'em-parte': 'Em parte' };

// ── GTA agendado (por canal) ──

export const GTA_AGENDADO: readonly { tipo: 'diario' | 'semanal' | 'noticias'; nome: string }[] = Object.freeze([
  { tipo: 'diario', nome: 'Reset diário' },
  { tipo: 'semanal', nome: 'Semanal do GTA' },
  { tipo: 'noticias', nome: 'Notícias da Rockstar' },
]);

const nomeDoCanal = (c: ChannelRef | null) => (c ? (c.name ? `#${c.name}` : `canal ${c.id}`) : null);

/**
 * O GTA agendado deste servidor: a publicação automática é POR CANAL, então aqui só aparece se cada tipo tem canal (e qual). Mudar é na aba Publicações.
 */
export function estadoDoGtaAgendado(canais: AdminGuildDetail['channels'] | null | undefined): { linhas: { tipo: string; nome: string; configurado: boolean; texto: string }[]; resumo: string } {
  const linhas = GTA_AGENDADO.map(({ tipo, nome }) => {
    const canal = nomeDoCanal(canais?.[tipo] ?? null);
    return { tipo, nome, configurado: Boolean(canal), texto: canal ? `Publica em ${canal}` : 'Sem canal: não publica neste servidor' };
  });
  const n = linhas.filter((l) => l.configurado).length;
  return { linhas, resumo: n === 0 ? 'Nenhum canal configurado' : n === linhas.length ? 'Os três com canal' : `${n} de ${linhas.length} com canal` };
}
