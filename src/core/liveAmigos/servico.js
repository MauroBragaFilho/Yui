// O SERVIÇO da live dos amigos, etapa 1: vínculos (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md, versão 3, aprovada pela Liz em 27/11/2026).
//
// Roda no cérebro (ou no processo único). O bot só faz entrada e saída: encaminha a frase e o clique e manda as mensagens.
// Ordem de cada operação: (1) a origem já foi conferida pelo canal (só o papel bot chama); (2) a identidade: o userId do clique tem de ser o
// mesmo a que a confirmação está presa; (3) a CAMADA OBRIGATÓRIA (camada.js); (4) o motor de políticas (gate); (5) vale a mais restritiva.
// Tudo passa por UMA fila (corrente de promessas): ler, alterar e gravar acontecem um de cada vez.
// Auditoria: um escritor só (este serviço); o ctx não leva userId (a audit() grava o userId cru); o alvo do motor é o CÓDIGO do vínculo.
// Encerramento (revogar, apagar meus dados, esquecer) RECUPERÁVEL: cada passo é anotado no diário antes de seguir; a retomada continua do passo.
// Nada de live, chat, perfil, credencial ou cota nesta etapa: nenhuma chamada ao YouTube.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { audit as auditPadrao, auditFilePath } from '../audit.js';
import { getPolicyEngine } from '../security/policyEngine.js';
import { ORIGINS } from '../security/permissionMatrix.js';
import { POLICY_STATES, ROLES } from '../permissions.js';
import { ACOES, conferirLiveAmigos } from './camada.js';
import { reconhecerFrase } from './frases.js';
import { criarStoreLiveAmigos } from './store.js';

export const liveAmigosLigado = (env = process.env) => String(env.YUI_LIVE_AMIGOS ?? 'false').trim().toLowerCase() === 'true';

export const PREFIXO_BOTAO = 'liveamg_';
const RE_BOTAO = /^liveamg_(ok|no)_([a-f0-9]{16})$/;
const ALFABETO = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 símbolos, sem l, o, 0 e 1
const CONFIRMACAO_MS = 5 * 60_000;
const LISTA_MS = 10 * 60_000;
const LIMITE_PEDIDOS = 3;
const JANELA_LIMITE_MS = 15 * 60_000;
const MAX_TENTATIVAS_LIMPEZA = 3;
const NOME = (id) => `@@NOME:${id}@@`; // o bot troca pelo nome atual no Discord (buscado na hora, nunca guardado)

export const TEXTOS = Object.freeze({
  avisoAmigoRevogado: 'Seu acesso à Yui na live foi encerrado pelo Braga, e os seus dados foram apagados.',
  feitoApagar: 'Pronto: seu vínculo e seus dados foram apagados.',
  venceu: 'Esta confirmação venceu. Nada foi feito.',
  cancelado: 'Cancelado. Nada foi feito.',
  falhaGravar: 'Não consegui: falha ao gravar. Nada foi apagado; tente de novo daqui a pouco.',
  limpezaFalhou: 'Não consegui apagar ou editar uma mensagem minha com IDs de amigos da live. Apague você, se quiser.',
  ilegivel: 'O arquivo dos vínculos da live dos amigos está ilegível: nenhum vínculo vale até você confirmar o recomeço ("recomeça os vínculos da live").',
});

const NEGADO = Object.freeze({
  'nao-e-o-dono': 'Só o dono da Yui pode fazer isso.',
  desligado: 'A Yui na live dos amigos está desligada (YUI_LIVE_AMIGOS).',
  'formato-invalido': 'Não entendi. Use: "autoriza amigo da live <ID do Discord ou menção> canal <ID do canal (UC...) ou link youtube.com/channel/...>", "lista os amigos da live" ou "revoga o amigo <código>".',
  'ja-vinculado': 'Essa pessoa ou esse canal já tem um vínculo.',
  'sem-vinculo': 'Não achei esse vínculo.',
  'vinculo-de-outro': 'Esse vínculo não é seu.',
  limite: 'Muitos pedidos seguidos; tente daqui a pouco.',
  indisponivel: 'Os vínculos estão indisponíveis agora; o dono foi avisado.',
  'acao-desconhecida': 'Não entendi o pedido.',
});

const aleatorio = (n) => crypto.randomBytes(n).toString('hex');

/** `amigo-` + 16 caracteres aleatórios (80 bits). */
export function novoCodigo() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALFABETO[bytes[i] & 31];
  return `amigo-${s}`;
}

/** A correlação já está no fim da auditoria? (a retomada não grava a mesma conclusão duas vezes) */
export function correlacaoNaAuditoria(correlacao, file = auditFilePath()) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const tam = fs.fstatSync(fd).size;
      const ler = Math.min(tam, 512 * 1024);
      const buf = Buffer.alloc(ler);
      fs.readSync(fd, buf, 0, ler, tam - ler);
      return buf.toString('utf8').includes(`"correlacao":"${correlacao}"`) && buf.toString('utf8').includes('"live_amigos.encerramento"');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * @param {{
 *   env?: object, store?: object, auditFn?: Function, engine?: object, ehDono: (id: string) => boolean,
 *   avisar?: (p: { userId: string|null, dono: boolean, texto: string, chave: string }) => Promise<boolean>,
 *   limparDm?: (p: { messageId: string, channelId: string, acao: 'editar'|'apagar', texto?: string }) => Promise<{ feito: boolean, motivo?: string }>,
 *   jaAuditado?: (correlacao: string) => boolean, agora?: () => number, logger?: object, falhar?: (passo: string) => void,
 * }} o
 */
export function criarServicoLiveAmigos({
  env = process.env, store = null, auditFn = auditPadrao, engine = getPolicyEngine(), ehDono,
  avisar = async () => false, limparDm = async () => ({ feito: false, motivo: 'sem-bot' }),
  jaAuditado = (c) => correlacaoNaAuditoria(c), agora = Date.now, logger = console, falhar = () => {},
} = {}) {
  if (typeof ehDono !== 'function') throw new TypeError('criarServicoLiveAmigos: informe ehDono');
  const dados = store ?? criarStoreLiveAmigos({ env });
  const audit = auditFn; // chamadas literais audit('live_amigos.…'): o teste do dicionário do painel enxerga cada nome
  const bloqueados = new Set();
  const tokens = new Map(); // token -> { acao, userId, dados, expiraEm, ref }
  const pedidos = new Map(); // userId -> [instantes]
  let fila = Promise.resolve();
  let avisouIlegivel = false;

  const naFila = (fn) => {
    const r = fila.then(fn, fn);
    fila = r.catch(() => {});
    return r;
  };
  const ctxDe = (dono) => ({ role: dono ? ROLES.OWNER : ROLES.MEMBER, platform: 'discord', channelKind: 'dm' });
  const registrar = (evento, dono, campos) => {
    try {
      switch (evento) { // literais: o dicionário do painel (auditoriaLogic.ts) e o teste painel-fase1 enxergam cada nome
        case 'live_amigos.autorizar': audit('live_amigos.autorizar', ctxDe(dono), campos); break;
        case 'live_amigos.listar': audit('live_amigos.listar', ctxDe(dono), campos); break;
        case 'live_amigos.revogar': audit('live_amigos.revogar', ctxDe(dono), campos); break;
        case 'live_amigos.apagar_meus_dados': audit('live_amigos.apagar_meus_dados', ctxDe(dono), campos); break;
        case 'live_amigos.encerramento': audit('live_amigos.encerramento', ctxDe(dono), campos); break;
        case 'live_amigos.limpeza_dm': audit('live_amigos.limpeza_dm', ctxDe(dono), campos); break;
        default: audit('live_amigos.negado', ctxDe(dono), campos);
      }
    } catch { /* a auditoria nunca derruba a operação */ }
  };
  const ator = (userId) => (ehDono(userId) ? 'dono' : 'outro');

  // ── Leitura dos vínculos (falha fechada) ──
  async function lerVinculosOuAvisar() {
    try { return { vinculos: dados.lerVinculos() }; } catch (err) {
      if (err?.code === 'ILEGIVEL') {
        if (!avisouIlegivel) {
          avisouIlegivel = true;
          await avisar({ userId: null, dono: true, texto: TEXTOS.ilegivel, chave: `liveamigos:ilegivel:${Math.floor(agora() / 3_600_000)}` }).catch(() => false);
        }
        return { ilegivel: true, vinculos: [] };
      }
      throw err;
    }
  }

  // ── Camada obrigatória + motor ──
  function decidir(acao, userId, { alvo = {}, vinculos = [], codigo = null } = {}) {
    const dono = ehDono(userId);
    const camada = conferirLiveAmigos(acao, { ehDono: dono, userId, alvo, vinculos, interruptor: liveAmigosLigado(env), bloqueados });
    let decision = POLICY_STATES.DENY;
    try {
      // A decisão da camada vai como "legacy": negação = deny; as ações confirmadas por botão (autorizar, revogar, apagar) = ask, que é o que acontece de fato.
      const legacy = !camada.ok ? 'deny' : acao === 'listar' ? 'allow' : 'ask';
      decision = engine.gate({ action: ACOES[acao], ctx: ctxDe(dono), origin: ORIGINS.DISCORD_DM, legacy, target: codigo }).decision;
    } catch { decision = POLICY_STATES.DENY; }
    const motor = decision === POLICY_STATES.AUTO || decision === POLICY_STATES.ASK;
    if (camada.ok && motor) return { ok: true, motivo: null };
    return { ok: false, motivo: camada.ok ? 'politica' : camada.motivo };
  }

  function excedeuLimite(userId) {
    if (ehDono(userId)) return false;
    const t = agora();
    const lista = (pedidos.get(userId) ?? []).filter((x) => t - x < JANELA_LIMITE_MS);
    if (lista.length >= LIMITE_PEDIDOS) { pedidos.set(userId, lista); return true; }
    lista.push(t);
    pedidos.set(userId, lista);
    return false;
  }

  function novaConfirmacao(acao, userId, extra) {
    const token = aleatorio(8);
    tokens.set(token, { acao, userId: String(userId), dados: extra, expiraEm: agora() + CONFIRMACAO_MS });
    return {
      token,
      botoes: [
        { customId: `${PREFIXO_BOTAO}ok_${token}`, label: 'Confirmar', estilo: 'perigo' },
        { customId: `${PREFIXO_BOTAO}no_${token}`, label: 'Cancelar', estilo: 'secundario' },
      ],
    };
  }

  const negar = (acao, userId, motivo, extra = {}) => {
    registrar('live_amigos.negado', ehDono(userId), { acao: ACOES[acao] ?? acao, ator: ator(userId), resultado: 'negado', motivo, ...extra });
    return { texto: NEGADO[motivo] ?? NEGADO['acao-desconhecida'] };
  };

  // ── Diário ──
  const lerDiario = () => dados.lerDiario();
  const gravarDiario = (d) => dados.gravarDiario({ encerramentos: d.encerramentos, limpezas: d.limpezas });

  function agendarLimpeza(ref, messageId, channelId, acao, quando, texto) {
    const d = lerDiario();
    d.limpezas = d.limpezas.filter((l) => l.ref !== ref);
    d.limpezas.push({ ref, messageId: String(messageId), channelId: String(channelId), acao, quando, texto: texto ?? null, tentativas: 0 });
    gravarDiario(d);
  }
  function tirarLimpeza(ref) {
    const d = lerDiario();
    const antes = d.limpezas.length;
    d.limpezas = d.limpezas.filter((l) => l.ref !== ref);
    if (d.limpezas.length !== antes) gravarDiario(d);
  }

  // ── Encerramento recuperável (plano §7) ──
  async function continuarEncerramento(entrada, d, { retomada = false } = {}) {
    // Passo 5: apagar o vínculo (se ainda existir).
    if (entrada.passo === 'iniciado') {
      const vinculos = dados.lerVinculos();
      const resto = vinculos.filter((v) => v.codigo !== entrada.codigo);
      if (resto.length !== vinculos.length) dados.gravarVinculos(resto);
      falhar('apagou');
      entrada.passo = 'apagado';
      gravarDiario(d);
      falhar('apagado-anotado');
    }
    // Passo 6: auditoria (sem duplicar na retomada).
    if (entrada.passo === 'apagado') {
      if (!(retomada && jaAuditado(entrada.correlacao))) {
        registrar('live_amigos.encerramento', entrada.tipo === 'revogacao', {
          op: entrada.op, vinculo: entrada.codigo, ator: entrada.tipo === 'revogacao' ? 'dono' : 'amigo', tipo: entrada.tipo, resultado: 'concluido',
          interrupcao: 'sem-live', pendencias: 'canceladas', exclusao: 'concluida', correlacao: entrada.correlacao, ...(retomada ? { retomada: true } : {}),
        });
      }
      falhar('auditou');
      entrada.passo = 'auditado';
      gravarDiario(d);
      falhar('auditado-anotado');
    }
    // Passo 7: avisos (pelo menos uma vez; cada um sai do diário quando sai a DM, e o discordId some com ele).
    if (entrada.passo === 'auditado') {
      while (entrada.avisos.length) {
        const a = entrada.avisos[0];
        let ok = false;
        try { ok = await avisar({ userId: a.discordId ?? null, dono: a.destino === 'dono', texto: a.texto, chave: `liveamigos:${entrada.correlacao}:${a.destino}` }); } catch { ok = false; }
        if (!ok) {
          entrada.tentativas = (entrada.tentativas ?? 0) + 1;
          gravarDiario(d);
          return { completo: false };
        }
        falhar('avisou');
        entrada.avisos.shift();
        gravarDiario(d);
        falhar('aviso-anotado');
      }
      // Passo 8: fechar.
      d.encerramentos = d.encerramentos.filter((e) => e !== entrada);
      gravarDiario(d);
    }
    return { completo: true };
  }

  /** Abre e roda um encerramento. Devolve { ok, motivo? } (ok = os dados foram apagados; os avisos podem ficar para a retomada). */
  async function encerrar({ vinculo, tipo, avisos }) {
    const correlacao = aleatorio(8);
    const op = aleatorio(6);
    bloqueados.add(vinculo.codigo); // passo 1
    // passo 2: abrir no diário
    const d = lerDiario();
    const entrada = { op, codigo: vinculo.codigo, tipo, correlacao, passo: 'iniciado', avisos, tentativas: 0, abertoEm: new Date(agora()).toISOString() };
    try {
      d.encerramentos.push(entrada);
      gravarDiario(d);
    } catch {
      registrar('live_amigos.encerramento', tipo === 'revogacao', { op, vinculo: vinculo.codigo, tipo, resultado: 'falhou', motivo: 'gravar-diario', correlacao });
      return { ok: false, motivo: 'gravar' };
    }
    falhar('diario-aberto');
    // passo 3: marcar "encerrando"
    try {
      const vinculos = dados.lerVinculos();
      const v = vinculos.find((x) => x.codigo === vinculo.codigo);
      if (v) { v.estado = 'encerrando'; dados.gravarVinculos(vinculos); }
    } catch {
      // Desfaz a abertura (nada foi apagado); se nem isso der, a retomada termina o pedido depois.
      try { d.encerramentos = d.encerramentos.filter((e) => e !== entrada); gravarDiario(d); } catch { /* fica para a retomada */ }
      registrar('live_amigos.encerramento', tipo === 'revogacao', { op, vinculo: vinculo.codigo, tipo, resultado: 'falhou', motivo: 'gravar-vinculos', correlacao });
      return { ok: false, motivo: 'gravar' };
    }
    falhar('encerrando');
    // passo 4: cancelar as confirmações abertas daquele vínculo ou daquela pessoa
    for (const [t, c] of tokens) {
      if (c.userId === vinculo.discordId || c.dados?.codigo === vinculo.codigo || c.dados?.discordId === vinculo.discordId) tokens.delete(t);
    }
    await continuarEncerramento(entrada, d);
    return { ok: true };
  }

  // ── Fluxos ──
  async function comando({ userId, texto }) {
    const uid = String(userId ?? '');
    const frase = reconhecerFrase(texto);
    if (!frase) return null;
    return naFila(async () => {
      if (excedeuLimite(uid)) return negar(frase.acao === 'recomecar' ? 'revogar' : frase.acao, uid, 'limite');
      if (frase.acao === 'recomecar') return pedirRecomeco(uid);
      const lidos = await lerVinculosOuAvisar();
      if (lidos.ilegivel && frase.acao !== 'apagar_meus_dados') return negar(frase.acao, uid, ehDono(uid) ? 'indisponivel' : 'nao-e-o-dono');
      const { vinculos } = lidos;
      if (frase.acao === 'listar') {
        const r = decidir('listar', uid, { vinculos });
        if (!r.ok) return negar('listar', uid, r.motivo);
        registrar('live_amigos.listar', true, { ator: 'dono', resultado: 'permitido', quantidade: vinculos.length });
        if (!vinculos.length) return { texto: 'Nenhum amigo autorizado na live.' };
        const linhas = vinculos.map((v) => `• ${v.codigo}: ${NOME(v.discordId)} (ID ${v.discordId}), canal ${v.canalId} https://www.youtube.com/channel/${v.canalId}, desde ${String(v.criadoEm).slice(0, 10)}${v.estado === 'encerrando' ? ' (encerrando)' : ''}`);
        const ref = `lista_${aleatorio(8)}`;
        return { texto: `Amigos da live (${vinculos.length}):\n${linhas.join('\n')}\n\nEsta lista some em 10 minutos.`, ref, limpeza: { acao: 'apagar', emMs: LISTA_MS } };
      }
      if (frase.acao === 'autorizar') {
        const alvo = { discordId: frase.discordId, canalId: frase.canalId };
        const r = decidir('autorizar', uid, { alvo, vinculos });
        if (!r.ok) return negar('autorizar', uid, r.motivo);
        const conf = novaConfirmacao('autorizar', uid, alvo);
        return {
          texto: `Autorizar este amigo na Yui da live?\n• Pessoa: ${NOME(alvo.discordId)} (ID ${alvo.discordId})\n• Canal do YouTube: ${alvo.canalId}\n  https://www.youtube.com/channel/${alvo.canalId}\nIsto é uma autorização sua. Não prova que o canal é dessa pessoa.\nA confirmação vale por 5 minutos.`,
          botoes: conf.botoes, ref: conf.token, limpeza: { acao: 'editar', emMs: CONFIRMACAO_MS, texto: TEXTOS.venceu },
        };
      }
      if (frase.acao === 'revogar') {
        let codigo = frase.codigo;
        if (!codigo && frase.discordId) codigo = vinculos.find((v) => v.discordId === frase.discordId)?.codigo ?? null;
        const r = decidir('revogar', uid, { alvo: { codigo }, vinculos, codigo });
        if (!r.ok) return negar('revogar', uid, frase.formatoInvalido ? 'formato-invalido' : r.motivo, codigo ? { vinculo: codigo } : {});
        const v = vinculos.find((x) => x.codigo === codigo);
        const conf = novaConfirmacao('revogar', uid, { codigo, discordId: v.discordId });
        return {
          texto: `Revogar o amigo ${codigo}?\n• Pessoa: ${NOME(v.discordId)} (ID ${v.discordId})\n• Canal: ${v.canalId}\nO vínculo e os dados dele serão apagados. A confirmação vale por 5 minutos.`,
          botoes: conf.botoes, ref: conf.token, limpeza: { acao: 'editar', emMs: CONFIRMACAO_MS, texto: TEXTOS.venceu },
        };
      }
      if (frase.acao === 'apagar_meus_dados') {
        // Mesma confirmação com ou sem vínculo: a resposta nunca diz se a pessoa tinha um.
        const conf = novaConfirmacao('apagar_meus_dados', uid, {});
        return { texto: 'Apagar seu vínculo com a Yui da live e os seus dados? A confirmação vale por 5 minutos.', botoes: conf.botoes, ref: conf.token };
      }
      return negar(frase.acao, uid, 'acao-desconhecida');
    });
  }

  function pedirRecomeco(uid) {
    if (!ehDono(uid)) return negar('revogar', uid, 'nao-e-o-dono');
    const conf = novaConfirmacao('recomecar', uid, {});
    return { texto: 'Recomeçar os vínculos da live? O arquivo ilegível será apagado, sem cópia, e todos os amigos terão de ser autorizados de novo.', botoes: conf.botoes, ref: conf.token };
  }

  async function botao({ userId, customId }) {
    const uid = String(userId ?? '');
    const m = RE_BOTAO.exec(String(customId ?? ''));
    if (!m) return { texto: 'Esses botões não valem mais.' };
    return naFila(async () => {
      const [, escolha, token] = m;
      const c = tokens.get(token);
      if (!c) { tirarLimpezaSegura(token); return { texto: TEXTOS.venceu }; }
      if (c.userId !== uid) {
        registrar('live_amigos.negado', ehDono(uid), { acao: ACOES[c.acao] ?? c.acao, ator: ator(uid), resultado: 'negado', motivo: 'vinculo-de-outro' });
        return { texto: 'Esta confirmação não é sua.', naoEditar: true };
      }
      tokens.delete(token);
      tirarLimpezaSegura(token);
      if (c.expiraEm <= agora()) return { texto: TEXTOS.venceu };
      if (escolha === 'no') return { texto: TEXTOS.cancelado };
      if (c.acao === 'recomecar') return executarRecomeco(uid);
      const lidos = await lerVinculosOuAvisar();
      if (lidos.ilegivel && c.acao !== 'apagar_meus_dados') return negar(c.acao, uid, 'indisponivel');
      const { vinculos } = lidos;
      if (c.acao === 'autorizar') return executarAutorizar(uid, c.dados, vinculos);
      if (c.acao === 'revogar') return executarRevogar(uid, c.dados.codigo, vinculos);
      if (c.acao === 'apagar_meus_dados') return executarApagar(uid, vinculos);
      return { texto: 'Não entendi o pedido.' };
    });
  }

  function tirarLimpezaSegura(ref) { try { tirarLimpeza(ref); } catch { /* a limpeza fica e é tentada depois */ } }

  function executarRecomeco(uid) {
    if (!ehDono(uid)) return negar('revogar', uid, 'nao-e-o-dono');
    try { dados.apagarVinculosIlegiveis(); } catch { return { texto: TEXTOS.falhaGravar }; }
    avisouIlegivel = false;
    registrar('live_amigos.revogar', true, { ator: 'dono', resultado: 'concluido', motivo: 'recomeco', op: aleatorio(6) });
    return { texto: 'Pronto: os vínculos recomeçaram do zero.' };
  }

  function executarAutorizar(uid, alvo, vinculos) {
    const r = decidir('autorizar', uid, { alvo, vinculos });
    if (!r.ok) return negar('autorizar', uid, r.motivo);
    let codigo = novoCodigo();
    while (vinculos.some((v) => v.codigo === codigo)) codigo = novoCodigo();
    const novo = { codigo, discordId: alvo.discordId, canalId: alvo.canalId, estado: 'ativo', criadoEm: new Date(agora()).toISOString() };
    try { dados.gravarVinculos([...vinculos, novo]); } catch {
      registrar('live_amigos.autorizar', true, { ator: 'dono', resultado: 'falhou', motivo: 'gravar', op: aleatorio(6) });
      return { texto: TEXTOS.falhaGravar };
    }
    registrar('live_amigos.autorizar', true, { vinculo: codigo, ator: 'dono', resultado: 'concluido', op: aleatorio(6) });
    return { texto: `Pronto: amigo autorizado. Código do vínculo: ${codigo}.`, codigo };
  }

  async function executarRevogar(uid, codigo, vinculos) {
    const r = decidir('revogar', uid, { alvo: { codigo }, vinculos, codigo });
    if (!r.ok) return negar('revogar', uid, r.motivo, { vinculo: codigo });
    const v = vinculos.find((x) => x.codigo === codigo);
    registrar('live_amigos.revogar', true, { vinculo: codigo, ator: 'dono', resultado: 'permitido' });
    const res = await encerrar({ vinculo: v, tipo: 'revogacao', avisos: [{ destino: 'amigo', discordId: v.discordId, texto: TEXTOS.avisoAmigoRevogado }] });
    return res.ok ? { texto: `Pronto: ${codigo} revogado, e os dados dele foram apagados.` } : { texto: TEXTOS.falhaGravar };
  }

  async function executarApagar(uid, vinculos) {
    const v = vinculos.find((x) => x.discordId === uid);
    const r = decidir('apagar_meus_dados', uid, { vinculos, codigo: v?.codigo ?? null });
    if (!r.ok) {
      // Sem vínculo: a MESMA frase neutra, nada apagado, auditoria "sem-vinculo".
      registrar('live_amigos.apagar_meus_dados', false, { ator: 'outro', resultado: 'negado', motivo: r.motivo });
      return { texto: TEXTOS.feitoApagar };
    }
    registrar('live_amigos.apagar_meus_dados', false, { vinculo: v.codigo, ator: 'amigo', resultado: 'permitido' });
    const res = await encerrar({ vinculo: v, tipo: 'exclusao_pelo_amigo', avisos: [{ destino: 'dono', texto: `Um amigo da live apagou o próprio vínculo (${v.codigo}).` }] });
    return res.ok ? { texto: TEXTOS.feitoApagar } : { texto: TEXTOS.falhaGravar };
  }

  /** Os "esquecer" da Yui (forgetAll, forgetUserContext): quem pede para esquecer tudo sobre si também perde o vínculo. */
  function apagarVinculoDe(userId) {
    const uid = String(userId ?? '');
    return naFila(async () => {
      let vinculos;
      try { vinculos = dados.lerVinculos(); } catch { return { ok: false, motivo: 'indisponivel' }; }
      const v = vinculos.find((x) => x.discordId === uid && x.estado === 'ativo' && !bloqueados.has(x.codigo));
      if (!v) return { ok: true, nada: true };
      return encerrar({ vinculo: v, tipo: 'esquecer', avisos: [{ destino: 'dono', texto: `Um amigo da live pediu para a Yui esquecer tudo; o vínculo ${v.codigo} foi apagado.` }] });
    });
  }

  /** O bot mandou a mensagem: as que têm IDs entram no diário para serem editadas (confirmação vencida) ou apagadas (listagem). */
  function mensagemEnviada({ ref, messageId, channelId, limpeza }) {
    if (!ref || !limpeza || !messageId || !channelId) return Promise.resolve(false);
    return naFila(async () => {
      try {
        agendarLimpeza(String(ref), messageId, channelId, limpeza.acao === 'apagar' ? 'apagar' : 'editar', agora() + Math.max(0, Number(limpeza.emMs) || 0), limpeza.texto ?? null);
        return true;
      } catch { return false; }
    });
  }

  /** As limpezas vencidas: editar ou apagar a mensagem; três falhas = sai do diário, auditoria "falhou" e o dono avisado. */
  function rodarLimpezas() {
    return naFila(async () => {
      const d = lerDiario();
      const t = agora();
      let mudou = false;
      for (const l of [...d.limpezas]) {
        if (l.quando > t) continue;
        let r;
        try { r = await limparDm({ messageId: l.messageId, channelId: l.channelId, acao: l.acao, texto: l.texto ?? undefined }); } catch (err) { r = { feito: false, motivo: String(err?.code ?? 'erro').slice(0, 40) }; }
        if (r?.feito) {
          d.limpezas = d.limpezas.filter((x) => x !== l);
          registrar('live_amigos.limpeza_dm', true, { acao: l.acao, resultado: 'concluido' });
        } else {
          l.tentativas = (l.tentativas ?? 0) + 1;
          if (l.tentativas >= MAX_TENTATIVAS_LIMPEZA) {
            d.limpezas = d.limpezas.filter((x) => x !== l);
            registrar('live_amigos.limpeza_dm', true, { acao: l.acao, resultado: 'falhou', motivo: String(r?.motivo ?? 'erro').replace(/\d{6,}/g, '#').slice(0, 40) });
            await avisar({ userId: null, dono: true, texto: TEXTOS.limpezaFalhou, chave: `liveamigos:limpeza:${l.ref}` }).catch(() => false);
          } else {
            l.quando = t + 60_000;
          }
        }
        mudou = true;
      }
      if (mudou) gravarDiario(d);
      return d.limpezas.length;
    });
  }

  /** Retomada: continua cada encerramento do passo em que parou; vínculos "encerrando" sem entrada no diário também terminam. */
  function retomar() {
    return naFila(async () => {
      const d = lerDiario();
      let feitos = 0;
      let pendentes = 0;
      for (const entrada of [...d.encerramentos]) {
        bloqueados.add(entrada.codigo);
        try {
          const r = await continuarEncerramento(entrada, d, { retomada: true });
          if (r.completo) feitos++; else pendentes++;
        } catch { pendentes++; }
        if ((entrada.tentativas ?? 0) >= 3 && !entrada.donoAvisado) {
          entrada.donoAvisado = true;
          try { gravarDiario(d); } catch { /* */ }
          await avisar({ userId: null, dono: true, texto: `Um encerramento da live dos amigos (${entrada.codigo}) ainda não terminou; continuo tentando.`, chave: `liveamigos:pendente:${entrada.correlacao}` }).catch(() => false);
        }
      }
      // Vínculos presos em "encerrando" sem diário (o diário se perdeu): termina a exclusão.
      try {
        const vinculos = dados.lerVinculos();
        const presos = vinculos.filter((v) => v.estado === 'encerrando' && !d.encerramentos.some((e) => e.codigo === v.codigo));
        for (const v of presos) {
          const entrada = { op: aleatorio(6), codigo: v.codigo, tipo: 'retomada', correlacao: aleatorio(8), passo: 'iniciado', avisos: [], tentativas: 0 };
          d.encerramentos.push(entrada);
          gravarDiario(d);
          const r = await continuarEncerramento(entrada, d, { retomada: true });
          if (r.completo) feitos++;
        }
      } catch { /* ilegível: fica para o recomeço */ }
      return { feitos, pendentes };
    });
  }

  return {
    comando, botao, mensagemEnviada, apagarVinculoDe, rodarLimpezas, retomar,
    /** Para testes e diagnóstico: só números. */
    estado: () => ({ confirmacoes: tokens.size, bloqueados: bloqueados.size }),
  };
}
