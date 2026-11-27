/**
 * Regras da reautorização do Google pelo painel (lacunas do painel, entrega F, item 14, 27/11/2026), sem React e sem rede (testáveis em Node):
 *  - o botão "Reautorizar o Google" só aparece com YUI_GOOGLE_REAUTORIZAR_PAINEL (o GET /v1/admin/google manda `reautorizarPeloPainel`);
 *  - começar pede confirmação (mexe com a credencial guardada no servidor) e devolve SÓ o link de consentimento (Agenda e Tarefas, somente leitura; nunca o Gmail);
 *  - o endereço colado é conferido AQUI antes de mandar, porque o servidor gasta a sessão na primeira tentativa (certa ou errada): um erro de digitação não
 *    deve queimar a sessão. O servidor confere tudo de novo;
 *  - o resultado: "Autorizado até <data>" ou a frase do código fixo que o servidor mandou. Nada de token, código ou segredo chega aqui.
 */
import type { TomDaConta } from './contasLogic.ts';
import { formatarQuando } from './monitoresLogic.ts';

/** A porta fixa do retorno (a mesma do servidor: src/integrations/google/reautorizar.js). */
export const PORTA_DO_RETORNO = 47615;
export const ENDERECO_DO_RETORNO = `http://127.0.0.1:${PORTA_DO_RETORNO}`;
const MAX_ENDERECO = 4096;

/** As instruções curtas da tela. */
export const INSTRUCOES_DA_REAUTORIZACAO = Object.freeze([
  'Abra o link e entre com a sua conta do Google. Marque todas as caixas (só Agenda e Tarefas, somente leitura).',
  'Depois de autorizar, o navegador vai mostrar uma página que não abre; copie o endereço inteiro dela e cole aqui.',
  `O endereço começa com ${ENDERECO_DO_RETORNO}/ e vale uma vez só, por 10 minutos. Errou? Comece de novo.`,
]);
export const TEXTO_SEM_ENDERECO = 'Cole o endereço da página que não abriu.';
export const TEXTO_ENDERECO_ERRADO = `Esse não parece o endereço da página que não abriu: ele começa com ${ENDERECO_DO_RETORNO}/ e tem "state=" e "code=". Confira e cole o endereço inteiro.`;
export const TEXTO_GMAIL_NO_SCRIPT = 'O Gmail não entra por aqui: a autorização nova terá só a Agenda e as Tarefas. Para o Gmail, use o script (node scripts/google-autorizar.mjs --gmail).';

interface GoogleComPainel { reautorizarPeloPainel?: boolean; escopos?: string[] | null }

/** O botão "Reautorizar o Google" aparece? (só com a chave; servidor antigo não manda o campo: não aparece) */
export function podeReautorizar(g: GoogleComPainel | null | undefined): boolean {
  return Boolean(g && g.reautorizarPeloPainel === true);
}

/** A confirmação antes de começar. Se a autorização atual tem o Gmail, avisa que ele sai (fica para o script). */
export function confirmacaoDeInicio(g: GoogleComPainel | null | undefined): { titulo: string; mensagem: string; sim: string } {
  const gmail = Array.isArray(g?.escopos) && g!.escopos!.includes('gmail');
  return {
    titulo: 'Reautorizar o Google?',
    mensagem: `Você vai abrir o Google e autorizar de novo a Agenda e as Tarefas (somente leitura). Quando concluir, a autorização guardada no servidor é trocada pela nova.${gmail ? ` ${TEXTO_GMAIL_NO_SCRIPT}` : ''}`,
    sim: 'Começar',
  };
}

export type ValidacaoDoEndereco = { ok: true; endereco: string } | { ok: false; erro: string };

/**
 * Confere o endereço colado ANTES de mandar (a sessão do servidor é de uso único): numa linha, sem espaço, até 4096 caracteres, começando por
 * http://127.0.0.1:47615/ (o "http://" pode faltar), com "state=" e com "code=" (ou "error=", quando o Google diz que não foi concluída).
 */
export function validarEnderecoColado(texto: string | null | undefined): ValidacaoDoEndereco {
  const e = String(texto ?? '').trim();
  if (!e) return { ok: false, erro: TEXTO_SEM_ENDERECO };
  if (e.length > MAX_ENDERECO || /[\s\u0000-\u001f\u007f-\u009f]/.test(e)) return { ok: false, erro: TEXTO_ENDERECO_ERRADO };
  const m = /^(?:http:\/\/)?127\.0\.0\.1:(\d{1,5})\/?\?(.*)$/i.exec(e);
  if (!m || Number(m[1]) !== PORTA_DO_RETORNO) return { ok: false, erro: TEXTO_ENDERECO_ERRADO };
  const q = new URLSearchParams(m[2].split('#')[0]);
  if (!q.get('state') || (!q.get('code') && !q.get('error'))) return { ok: false, erro: TEXTO_ENDERECO_ERRADO };
  return { ok: true, endereco: e };
}

export interface LinkDaReautorizacao { link: string; validade: string; gmail: string | null }

/** O que mostrar depois do início: o link, até quando ele vale e o aviso do Gmail; ou o erro (a frase do servidor). */
export function resultadoDoInicio(
  r: { ok: true; link: string; expiraEm: string; gmailFicaNoScript: boolean } | { ok: false; codigo: string; texto: string } | null | undefined,
  agora: Date = new Date(),
): { ok: true; vista: LinkDaReautorizacao } | { ok: false; erro: string } | null {
  if (!r) return null;
  if (r.ok !== true) return { ok: false, erro: String((r as { texto?: string }).texto ?? '').trim() || 'Não consegui começar a reautorização.' };
  const link = String(r.link ?? '');
  if (!/^https?:\/\//i.test(link)) return { ok: false, erro: 'O servidor não mandou um link válido.' };
  return { ok: true, vista: { link, validade: `O link vale até ${formatarQuando(r.expiraEm, agora)}.`, gmail: r.gmailFicaNoScript === true ? TEXTO_GMAIL_NO_SCRIPT : null } };
}

const NOMES: Record<string, string> = { agenda: 'a Agenda', tarefas: 'as Tarefas' };

/** O resultado do retorno: "Autorizado até <data>" (com o que o Google não concedeu e o aviso do Gmail) ou a frase do código fixo. */
export function resultadoDoRetorno(
  r: { ok: true; venceEm: string; faltam?: string[]; gmailFicaNoScript?: boolean } | { ok: false; codigo: string; texto: string } | null | undefined,
  agora: Date = new Date(),
): { texto: string; tom: TomDaConta } | null {
  if (!r) return null;
  if (r.ok !== true) return { texto: String((r as { texto?: string }).texto ?? '').trim() || 'Não deu certo. Comece de novo.', tom: 'critico' };
  const faltam = (Array.isArray(r.faltam) ? r.faltam : []).map((f) => NOMES[f]).filter(Boolean);
  const partes = [`Autorizado até ${formatarQuando(r.venceEm, agora)} (7 dias, no modo Testando do Google). A Agenda e as Tarefas voltam sozinhas.`];
  if (faltam.length) partes.push(`Atenção: o Google não concedeu ${faltam.join(' nem ')}; reautorize marcando todas as caixas.`);
  if (r.gmailFicaNoScript === true) partes.push(TEXTO_GMAIL_NO_SCRIPT);
  return { texto: partes.join(' '), tom: faltam.length ? 'atencao' : 'ok' };
}
