// O PEDIDO de monitor em português, interpretado por CÓDIGO (etapa 16, proatividade). Sem IA, sem rede, sem relógio.
//
//   interpretarPedido("me avisa quando sair o patch 1.5 do jogo X por 7 dias")
//     -> { acao: 'criar', consulta: 'patch 1.5 do jogo X', prazoMs: 7 dias, prazoLimitado: false }
//   interpretarPedido("lista meus monitores")  -> { acao: 'listar' }
//   interpretarPedido("cancela o monitor 2")   -> { acao: 'cancelar', id: 2 }   (também 'pausar' e 'retomar')
//   qualquer outra frase                       -> null (é conversa comum e segue para a IA)
//
// Regras (as mesmas dos lembretes): só vale quando a frase COMEÇA com o verbo do pedido ("me avisa quando", "monitora", "cria um monitor
// para", "cancela o monitor N"). Conversa comum ("você me avisa de tudo?") nunca é capturada. O prazo vem de "por 7 dias", "durante 2
// semanas", "pelos próximos 10 dias", "por um mês" (padrão 14 dias, no máximo 60). "em 7 dias", "daqui a 3 dias" e "amanhã" são horário de
// LEMBRETE (a pré-rota de lembretes vem antes e fica com a frase), não prazo de monitor. Quem decide se a pessoa pode pedir (só o dono) e
// onde a mensagem vale (dirigida à Yui) é o roteador (rota.js); aqui só se lê a frase.
import { normChars } from '../../reminders/when.js';
import { LIMITES } from './config.js';
import { tituloSeguro } from './assinatura.js';

const MAX_TEXTO = 400;
const HORA_MS = 60 * 60_000;
const DIA_MS = 24 * HORA_MS;

const NUMEROS = Object.freeze({
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, sessenta: 60,
});

// Jeitos educados de pedir, antes do verbo ("poderia me avisar...", "queria que você me avisasse...", "por favor, ...").
const EDUCADO = '(?:(?:voce\\s+)?(?:poderia|podia|pode|consegue|conseguiria|daria)\\s+|da\\s+(?:pra|para)\\s+(?:voce\\s+)?|(?:queria|quero|gostaria|preciso)\\s+que\\s+(?:voce\\s+)?|por favor[, ]*)?';
const GATILHO = '(?:quando|se|caso|assim que|sempre que|toda vez que|tao logo|logo que)';
const AVISA = '(?:me\\s+)?(?:avisa|avise|avisar|avisasse|alerta|alerte|alertar|notifica|notifique|notificar)(?:-me)?';
const NUM = '(\\d{1,3}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|quarenta|sessenta)';
const NUMERO_DO_MONITOR = '\\s*(?:numero |n[o.]? ?|#)?(\\d{1,4})\\s*[?!.]*$';

const RE = {
  avisaQuando: new RegExp(`^${EDUCADO}${AVISA}\\s+${GATILHO}\\s+(.+)$`),
  criarMonitor: new RegExp(`^${EDUCADO}(?:cria|crie|criar|faz|faca|fazer|adiciona|adicione|adicionar|configura|configure|configurar|programa|programe|coloca|coloque|abre|abra|inicia|inicie|liga|ligue)\\s+(?:um |uma |o |a )?(?:novo |nova )?monitor(?:amento)?\\b\\s*(?:(?:de|do|da|dos|das|para|pra|sobre|em|no|na|nos|nas)\\b)?[:,]?\\s*(.*)$`),
  monitorDoisPontos: /^monitor(?:amento)?\s*[:,-]\s*(.+)$/,
  verboDireto: new RegExp(`^${EDUCADO}(?:monitora|monitore|monitorar|acompanha|acompanhe|acompanhar|vigia|vigie|vigiar|fica de olho|fique de olho|ficar de olho)\\s+(.+)$`),
  listar: new RegExp(`^${EDUCADO}(?:me )?(?:mostra|mostre|mostrar|ve|ver|lista|liste|listar|quais(?: sao)?|manda|mande|exibe|exiba)\\s+(?:(?:os|todos os|meus|todos os meus|os meus)\\s+)*monitores(?: ativos| que tenho| que eu tenho)?\\s*[?!.]*$`),
  listarMeus: /^(?:(?:os )?meus monitores|quais monitores (?:eu )?(?:tenho|estao ativos|existem)|(?:eu )?(?:tenho|tem) (?:algum |algum outro )?monitor(?:es)?)\s*[?!.]*$/,
  cancelar: new RegExp(`^${EDUCADO}(?:cancela|cancele|cancelar|apaga|apague|apagar|remove|remova|remover|exclui|exclua|excluir|deleta|delete|deletar|encerra|encerre|encerrar|desliga|desligue|desligar|tira|tire|tirar|para|pare|parar)\\s+(?:o |a )?(?:meu )?monitor(?:amento)?${NUMERO_DO_MONITOR}`),
  pausar: new RegExp(`^${EDUCADO}(?:pausa|pause|pausar|suspende|suspenda|suspender|segura|segure)\\s+(?:o |a )?(?:meu )?monitor(?:amento)?${NUMERO_DO_MONITOR}`),
  retomar: new RegExp(`^${EDUCADO}(?:retoma|retome|retomar|reativa|reative|reativar|despausa|despause|despausar|continua|continue|continuar|volta com|volte com)\\s+(?:o |a )?(?:meu )?monitor(?:amento)?${NUMERO_DO_MONITOR}`),
};

const PRAZO_RE = new RegExp(`\\b(?:por|durante|pelos proximos|pelas proximas|pelos|pelas|nos proximos|nas proximas)\\s+(?:(?:os|as)\\s+)?(?:proximos |proximas )?${NUM}\\s+(horas?|dias?|semanas?|mes|meses)\\b`);
const VERBO_DO_EVENTO = /^(?:(?:for|forem|seja|sejam|estiver|estiverem)\s+)?(?:sair|saia|saiu|sai|aparecer|aparecerem|aparece|surgir|surgirem|surja|surge|tiver|tiverem|tem|houver|houverem|existir|existirem|lancar|lancarem|lance|lanca|publicar|publicarem|publique|rolar|rolarem|acontecer|acontecerem|chegar|chegarem|liberar|liberarem|disponibilizarem|anunciarem|anunciar)\s+/;
const ARTIGO = /^(?:o|a|os|as|um|uma|uns|umas|algum|alguma|alguns|algumas|qualquer)\s+/;
const COMECO_PESSOAL = /^(?:meu|minha|meus|minhas|eu|comigo|isso|isto|aqui|ai|voce|vc)\b/;

/** Tira, do começo do texto, as menções (<@id>) e o chamado "yui,": em duas versões do MESMO tamanho (original e normalizada). */
function cabecaDoPedido(texto) {
  const primeira = String(texto ?? '').normalize('NFC').split(/\r?\n/)[0].slice(0, MAX_TEXTO + 1);
  const limpa = primeira.replace(/^\s*(?:<@[!&]?\d+>\s*[,:;-]?\s*)*(?:@?yui\b[\s,:;!-]*)?/i, '').trim();
  return { original: limpa, norm: normChars(limpa) };
}

/** Prazo ("por 7 dias") dentro do corpo: { prazoMs, limitado, ini, fim } ou null. */
function acharPrazo(norm) {
  const m = PRAZO_RE.exec(norm);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMEROS[m[1]];
  if (!Number.isFinite(n) || n < 1) return null;
  const unidade = m[2];
  let ms;
  if (unidade.startsWith('hora')) ms = n * HORA_MS;
  else if (unidade.startsWith('dia')) ms = n * DIA_MS;
  else if (unidade.startsWith('semana')) ms = n * 7 * DIA_MS;
  else ms = n * 30 * DIA_MS;
  const teto = LIMITES.prazoMaximoDias * DIA_MS;
  return { prazoMs: Math.min(teto, Math.max(LIMITES.prazoMinimoHoras * HORA_MS, ms)), limitado: ms > teto, ini: m.index, fim: m.index + m[0].length };
}

const sem = (texto, ini, fim) => `${texto.slice(0, ini)} ${texto.slice(fim)}`;

/**
 * O corpo do pedido ("sair o patch 1.5 do jogo X por 7 dias") -> a consulta limpa e o prazo.
 * Devolve null se não sobrou consulta que preste.
 */
function lerCorpo(corpoOriginal, corpoNorm, { tiraVerboDoEvento }) {
  let orig = corpoOriginal;
  let norm = corpoNorm;
  const prazo = acharPrazo(norm);
  if (prazo) { orig = sem(orig, prazo.ini, prazo.fim); norm = sem(norm, prazo.ini, prazo.fim); }
  const aparar = (re) => {
    const m = re.exec(norm);
    if (!m) return false;
    orig = orig.slice(m[0].length);
    norm = norm.slice(m[0].length);
    return true;
  };
  norm = norm.replace(/^[\s,:;-]+/, (s) => { orig = orig.slice(s.length); return ''; });
  if (tiraVerboDoEvento) aparar(VERBO_DO_EVENTO);
  // até dois artigos seguidos no começo ("sair o patch", "monitor para o preço de ...")
  if (aparar(ARTIGO)) aparar(ARTIGO);
  // o fim: "por favor", pontuação solta, "e", vírgulas
  const fim = /(?:\s+(?:por favor|pf|pfv)|[\s,;:.!?-])+$/.exec(norm);
  if (fim) { orig = orig.slice(0, orig.length - fim[0].length); norm = norm.slice(0, norm.length - fim[0].length); }
  const solto = /\s+e$/.exec(norm);
  if (solto) { orig = orig.slice(0, orig.length - solto[0].length); norm = norm.slice(0, norm.length - solto[0].length); }
  const consulta = tituloSeguro(orig.trim(), LIMITES.consultaMax);
  if (consulta === 'sem título' || !/[\p{L}\p{N}]/u.test(consulta) || Array.from(consulta.replace(/[^\p{L}\p{N}]/gu, '')).length < 2) return null;
  return { consulta, prazoMs: prazo?.prazoMs ?? null, prazoLimitado: prazo?.limitado === true };
}

/**
 * Interpreta a frase. Devolve a ação pedida ou null (conversa comum).
 * @returns {null | { acao: 'criar', consulta: string, prazoMs: number|null, prazoLimitado: boolean }
 *   | { acao: 'criar-vazio' } | { acao: 'listar' } | { acao: 'cancelar'|'pausar'|'retomar', id: number }}
 */
export function interpretarPedido(texto) {
  const bruto = String(texto ?? '');
  if (!bruto.trim() || bruto.length > MAX_TEXTO * 8) return null;
  const { original, norm } = cabecaDoPedido(bruto);
  if (!norm || norm.length > MAX_TEXTO) return null;
  let m;

  if ((m = RE.cancelar.exec(norm))) return { acao: 'cancelar', id: Number(m[1]) };
  if ((m = RE.pausar.exec(norm))) return { acao: 'pausar', id: Number(m[1]) };
  if ((m = RE.retomar.exec(norm))) return { acao: 'retomar', id: Number(m[1]) };
  if (RE.listar.test(norm) || RE.listarMeus.test(norm)) return { acao: 'listar' };

  // "me avisa quando/se ...": o corpo começa depois do gatilho; o verbo do evento ("sair", "aparecer") sai da consulta
  if ((m = RE.avisaQuando.exec(norm))) {
    if (COMECO_PESSOAL.test(m[1])) return null; // "me avisa se eu esquecer...": é conversa ou lembrete, não busca na web
    const ini = norm.length - m[1].length;
    const lido = lerCorpo(original.slice(ini), m[1], { tiraVerboDoEvento: true });
    return lido ? { acao: 'criar', ...lido } : null;
  }
  // "cria um monitor para X", "monitor: X"
  if ((m = RE.criarMonitor.exec(norm)) || (m = RE.monitorDoisPontos.exec(norm))) {
    const ini = norm.length - m[1].length;
    const lido = m[1].trim() ? lerCorpo(original.slice(ini), m[1], { tiraVerboDoEvento: false }) : null;
    return lido ? { acao: 'criar', ...lido } : { acao: 'criar-vazio' };
  }
  // "monitora X", "acompanha X", "fica de olho em X": "meu/minha/comigo..." é conversa ("acompanha meu raciocínio")
  if ((m = RE.verboDireto.exec(norm))) {
    const ini = norm.length - m[1].length;
    let corpoOrig = original.slice(ini);
    let corpoNorm = m[1];
    const prep = /^(?:(?:o|a|os|as|um|uma)\s+)?(?:(?:em|no|na|nos|nas|de|do|da|dos|das)\s+)?/.exec(corpoNorm);
    if (prep?.[0]) { corpoOrig = corpoOrig.slice(prep[0].length); corpoNorm = corpoNorm.slice(prep[0].length); }
    if (COMECO_PESSOAL.test(corpoNorm)) return null;
    const lido = lerCorpo(corpoOrig, corpoNorm, { tiraVerboDoEvento: false });
    return lido ? { acao: 'criar', ...lido } : null;
  }
  return null;
}
