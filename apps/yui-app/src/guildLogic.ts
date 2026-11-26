/** Textos e regras das configurações por servidor (ferramentas, Termos de Uso, canal). Arquivo sem React, testável em Node. */
import type { ChannelConfig, ChatterChange, ConfigItem, GuildTool, GuildTosState, PersonaChange } from './api/client.ts';

/** Ferramentas que pedem aviso claro antes de ligar. */
const AVISOS: Record<string, string> = {
  voice_tts: 'A fala vale para todos que estiverem na call.',
  join_voice_call: 'A Yui poderá entrar em calls deste servidor e ouvir o que for dito a ela.',
  radio_voice_stt: 'O áudio da call poderá ir para transcrição na nuvem.',
};

export function avisoDaFerramenta(nome: string): string | null {
  if (AVISOS[nome]) return AVISOS[nome];
  return /download/i.test(nome) ? 'Downloads ocupam o disco do computador da Yui e podem envolver conteúdo protegido.' : null;
}

/** Os rótulos chegam do Discord com emoji na frente: no painel fica só o texto. */
export function semEmoji(texto: string): string {
  const limpo = String(texto ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '').replace(/[ \t]{2,}/g, ' ').trim();
  return limpo || String(texto ?? '');
}

export function perguntaDaFerramenta(f: Pick<GuildTool, 'nome' | 'rotulo'>, ligar: boolean): { titulo: string; texto: string } {
  const aviso = ligar ? avisoDaFerramenta(f.nome) : null;
  return {
    titulo: ligar ? 'Ligar ferramenta?' : 'Desligar ferramenta?',
    texto: [`"${semEmoji(f.rotulo)}" neste servidor.`, aviso ? `Atenção: ${aviso}` : null].filter(Boolean).join('\n\n'),
  };
}

/** Markdown do Discord em texto corrido (os termos são só para leitura). */
export function textoSemMarkdown(texto: string): string {
  return String(texto ?? '')
    .split('\n')
    .map((linha) => {
      const l = linha
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[*-]\s+/, '• ')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]*)`/g, '$1');
      return l.trim() ? semEmoji(l) : '';
    })
    .join('\n');
}

export function resumoDosTermos(e: GuildTosState): string {
  if (!e.exigido) return 'Os Termos de Uso não são exigidos nesta instalação.';
  if (!e.aceito) return 'Pendente: os termos ainda não foram aceitos neste servidor.';
  const quando = e.aceitoEm ? new Date(e.aceitoEm) : null;
  const data = quando && !Number.isNaN(quando.getTime()) ? ` em ${quando.toLocaleString('pt-BR')}` : '';
  const via = e.origem === 'painel' ? ' pelo painel' : e.origem === 'discord' ? ' pelo Discord' : '';
  return `Aceitos${data}${via}${e.aceitoPor ? ` (usuário ${e.aceitoPor})` : ''}.`;
}

export function perguntaDoAceite(e: Pick<GuildTosState, 'donoDoServidor'>, servidor: string): string {
  return [
    `Aceitar os Termos de Uso em "${servidor}".`,
    e.donoDoServidor ? null : 'Você não é o dono deste servidor: está aceitando em nome de terceiros.',
    'A Yui vai registrar o aceite, escolher o canal de avisos se faltar e ENVIAR uma mensagem nesse canal no Discord.',
  ].filter(Boolean).join('\n\n');
}

export function resultadoDoAceite(r: { jaAceito: boolean; avisoEnviado: boolean }): string {
  if (r.jaAceito) return 'Já estava aceito: nada foi regravado nem enviado.';
  return r.avisoEnviado ? 'Termos aceitos e aviso enviado no canal.' : 'Termos aceitos, mas o aviso no canal não foi enviado.';
}

export const FREQUENCIAS: { valor: 'low' | 'medium' | 'high'; rotulo: string }[] = [
  { valor: 'low', rotulo: 'Baixa (1%)' },
  { valor: 'medium', rotulo: 'Média (5%)' },
  { valor: 'high', rotulo: 'Alta (15%)' },
];

/** Ligar sem frequência nem porcentagem deixaria a chance em zero: já entra com a frequência baixa. */
export function mudancaAoAlternarFalas(atual: ChannelConfig['espontaneo']): { pergunta: string; mudanca: ChatterChange } {
  if (atual.ativo) return { pergunta: 'Desligar', mudanca: { ativo: false } };
  if (atual.frequencia === null && atual.porcentagem === null) return { pergunta: 'Ligar com frequência Baixa (1%)', mudanca: { ativo: true, frequencia: 'low' } };
  return { pergunta: 'Ligar', mudanca: { ativo: true } };
}

/** Texto da confirmação de um ajuste do painel, ou null quando o valor não pede confirmação. */
export function perguntaDoAjuste(item: Pick<ConfigItem, 'rotulo' | 'descricao' | 'confirmar'>, valor: string): string | null {
  return item.confirmar?.includes(valor) ? `"${item.rotulo}": ${item.descricao}` : null;
}

/** Recarga que falhou com dados antigos na tela: avisa que o que se vê pode estar desatualizado. */
export function avisoDeRecarga(temDados: boolean, erro: string | null): string | null {
  return temDados && erro ? `Não consegui atualizar os dados (${erro}). O que aparece abaixo pode estar desatualizado.` : null;
}

/** Porcentagem digitada: inteiro de 0 a 100, ou null se inválida. */
export function lerPorcentagem(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? n : null;
}

/** Só o que mudou na persona ("" limpa o campo). null quando não há nada para salvar. */
export function mudancaDaPersona(atual: ChannelConfig['persona'], instrucao: string, humor: string): PersonaChange | null {
  const mudanca: PersonaChange = {};
  if (instrucao !== (atual.instrucao ?? '')) mudanca.instrucao = instrucao;
  if (humor !== (atual.humor ?? '')) mudanca.humor = humor;
  return Object.keys(mudanca).length ? mudanca : null;
}
