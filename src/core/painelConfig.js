// O COFRE DE CONFIGURAÇÃO DO PAINEL (25/11/2026): chaves de API e ajustes da Yui que o dono muda pelo painel web em vez de editar o .env.
//
// Onde fica: `secrets/painel-config.json` (fora do Git, permissão restrita; troque com YUI_PAINEL_CONFIG_FILE). Como entra no sistema: `aplicarPainelConfig()` coloca os valores salvos em
// process.env NO COMEÇO de cada processo (antes de a configuração ser lida), e o valor do painel VENCE o do .env; remover do painel devolve o valor do .env (ou o padrão). O .env nunca é reescrito.
//
// Regras (parecer da Liz para o painel):
//  - LISTA FECHADA: só os nomes do CATALOGO podem ser gravados. O token do Discord, a senha e a sessão do painel, o dono, as políticas de segurança, a rota privada, o Gmail, a retenção da
//    memória, os caminhos de arquivo e os comandos NÃO estão aqui de propósito (continuam só no .env/na decisão do dono).
//  - SEGREDO só ENTRA: nenhuma resposta devolve o valor, só "definido" e, quando veio do painel, os 4 últimos caracteres. Nem o log, nem a auditoria, nem o erro levam o valor.
//  - Escrita atômica com permissão restrita e cópia de segurança do arquivo anterior (`.bak`, também restrita); YUI_PAINEL_CONFIG_EDIT=false trava toda edição.
//  - CRIPTOGRAFIA EM REPOUSO (parecer da Liz, 25/11): com YUI_PAINEL_CONFIG_DPAPI=true (Windows) o arquivo e o `.bak` são gravados protegidos pela DPAPI (escopo do USUÁRIO que roda a Yui; a conta SISTEMA no
//    notebook). Só essa conta, nessa máquina, consegue ler: copiar o arquivo para outro lugar não revela as chaves. Arquivo protegido que não abre NUNCA é sobrescrito (a edição é recusada).
//  - Quem muda o quê: o painel roda no processo do CÉREBRO e aplica na hora ali; o BOT (voz, semanal, avisos) só relê o arquivo ao REINICIAR. Por isso `reinicio: true` vale também para o que o bot lê.
//  - Cada item diz se a mudança precisa de REINÍCIO da Yui para valer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class PainelConfigError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PainelConfigError';
    this.status = status;
  }
}

const bool = (v) => ({ tipo: 'bool', ...v });
const inteiro = (v) => ({ tipo: 'int', ...v });
const opcao = (v) => ({ tipo: 'enum', ...v });
const texto = (v) => ({ tipo: 'texto', ...v });
const segredo = (v) => ({ tipo: 'segredo', secreto: true, ...v });

/**
 * O catálogo: `reinicio: true` = lido na subida do processo (vale depois de reiniciar a Yui); `false` = lido a cada uso (vale na hora no processo do cérebro).
 * Para acrescentar um ajuste: uma linha aqui, um teste e a documentação em docs/content_pt/ENVIRONMENT.md.
 */
export const CATALOGO = Object.freeze([
  // Chaves de serviços (as chaves de IA, como Groq e Gemini, têm a tela própria da aba IA)
  segredo({ chave: 'AZURE_SPEECH_KEY', rotulo: 'Azure Speech (voz)', grupo: 'Chaves', descricao: 'Chave do recurso Azure Speech, usada como voz de reserva (a voz roda no bot: vale depois de reiniciar).', reinicio: true }),
  texto({ chave: 'AZURE_SPEECH_REGION', rotulo: 'Região do Azure Speech', grupo: 'Chaves', descricao: 'Por exemplo brazilsouth.', reinicio: true, max: 40, padrao: '', formato: /^[a-z0-9-]{3,40}$/ }),
  segredo({ chave: 'YOUTUBE_API_KEY', rotulo: 'YouTube Data API', grupo: 'Chaves', descricao: 'Chave da API de dados do YouTube (avisos de vídeos e lives).', reinicio: true }),
  segredo({ chave: 'BRAVE_API_KEY', rotulo: 'Brave Search', grupo: 'Chaves', descricao: 'Chave da busca Brave (pesquisa na web).', reinicio: true }),
  segredo({ chave: 'TAVILY_API_KEY', rotulo: 'Tavily Search', grupo: 'Chaves', descricao: 'Chave da busca Tavily (pesquisa na web).', reinicio: true }),
  segredo({ chave: 'HORDE_API_KEY', rotulo: 'AI Horde', grupo: 'Chaves', descricao: 'Chave do AI Horde.', reinicio: true }),
  segredo({ chave: 'TWITCH_CLIENT_SECRET', rotulo: 'Twitch (segredo do cliente)', grupo: 'Chaves', descricao: 'Segredo do aplicativo da Twitch.', reinicio: true }),
  // Voz
  bool({ chave: 'YUI_TTS_OMNIROUTE', rotulo: 'Voz pelo OmniRoute (Leda)', grupo: 'Voz', descricao: 'Liga a voz da Leda pelo OmniRoute na frente da cadeia de voz.', reinicio: true, padrao: 'false' }),
  bool({ chave: 'YUI_TTS_CLOUD', rotulo: 'Vozes de nuvem de reserva (Azure, Edge)', grupo: 'Voz', descricao: 'Permite o Azure e a Edge como reserva da voz.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES', rotulo: 'Aquecimento da voz (minutos)', grupo: 'Voz', descricao: '0 = desligado. De quantos em quantos minutos manter o OmniRoute acordado durante uma call.', reinicio: true, min: 0, max: 60, padrao: '0' }),
  inteiro({ chave: 'YUI_TTS_ESPERA_429_S', rotulo: 'Espera depois de limite de uso (segundos)', grupo: 'Voz', descricao: '0 = desligado. Depois de um 429 da voz na nuvem, fala pela voz local por esse tempo.', reinicio: true, min: 0, max: 600, padrao: '0' }),
  texto({ chave: 'YUI_TTS_OMNIROUTE_ESTILO', rotulo: 'Estilo da voz da Leda', grupo: 'Voz', descricao: 'Use "nenhum" para a voz falar só o texto (o padrão do código pode ser lido em voz alta).', reinicio: true, max: 200, padrao: '' }),
  // Inteligência
  bool({ chave: 'YUI_IA_REFAZER_RECUSA', rotulo: 'Refazer recusa genérica em perguntas de jogo', grupo: 'Inteligência', descricao: 'Se um modelo só disser "não posso ajudar" a uma pergunta de GTA Online, tenta uma vez de novo com o contexto do jogo.', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_SKILLS', rotulo: 'Skills no padrão aberto', grupo: 'Inteligência', descricao: 'Liga o carregador de skills (só o dono, só no privado; nunca executa nada vindo de uma skill).', reinicio: false, padrao: 'false' }),
  // Geral
  texto({ chave: 'YUI_FUSO', rotulo: 'Fuso horário do dono', grupo: 'Geral', descricao: 'Por exemplo America/Cuiaba. Sem valor, vale o horário de Brasília. Só muda como as horas são mostradas e lidas.', reinicio: true, max: 60, padrao: '', validar: (v) => { new Intl.DateTimeFormat('pt-BR', { timeZone: v }); } }),
  texto({ chave: 'YUI_CLIMA_CIDADE_PADRAO', rotulo: 'Cidade padrão do clima', grupo: 'Geral', descricao: 'Por exemplo Cuiaba-MT.', reinicio: true, max: 80, padrao: '' }),
  opcao({ chave: 'REDDIT_FETCH_MODE', rotulo: 'Semanal: consulta ao Reddit', grupo: 'Geral', descricao: '"off" não abre o navegador (recomendado em máquina de pouca memória).', reinicio: true, opcoes: ['browser', 'cookies', 'off'], padrao: 'browser' }),
  bool({ chave: 'YUI_GOOGLE', rotulo: 'Google Agenda e Tarefas (somente leitura)', grupo: 'Geral', descricao: 'Liga a leitura de Agenda e Tarefas. A autorização (token) continua sendo feita à parte.', reinicio: true, padrao: 'false' }),
]);

const POR_CHAVE = new Map(CATALOGO.map((c) => [c.chave, c]));
const SEGREDO_RE = /^[\x21-\x2b\x2d-\x7e]{10,512}$/; // ASCII visível, sem espaço e sem vírgula
const CONTROLE_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

const arquivo = () => process.env.YUI_PAINEL_CONFIG_FILE || path.join(process.cwd(), 'secrets', 'painel-config.json');

export function edicaoLigada(env = process.env) {
  return String(env.YUI_PAINEL_CONFIG_EDIT ?? 'true').trim().toLowerCase() !== 'false';
}

const vazio = () => ({ version: 1, valores: {}, alteradoEm: {} });

// ── Proteção em repouso (DPAPI do Windows) ──────────────────────────────────────────────────
const ESCOPO_DPAPI = 'CurrentUser';
const windowsPowerShell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function dpapi(modo, entrada) {
  // O texto vai pela ENTRADA PADRÃO do PowerShell (nunca na linha de comando nem no ambiente); a saída é só base64 (proteger) ou o texto (abrir).
  const script = modo === 'proteger'
    ? "Add-Type -AssemblyName System.Security; $b = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, '" + ESCOPO_DPAPI + "'))"
    : "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, '" + ESCOPO_DPAPI + "'))";
  return execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], { input: entrada, encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}
/** O protetor padrão (DPAPI, só no Windows). Injetável para teste: { proteger(texto) -> texto, abrir(texto) -> texto }. */
const protetorDpapi = { rotulo: 'dpapi-' + ESCOPO_DPAPI.toLowerCase(), proteger: (s) => dpapi('proteger', s), abrir: (s) => dpapi('abrir', s) };
let protetor = protetorDpapi;
export function usarProtetorParaTeste(p) { protetor = p ?? protetorDpapi; }

export function protecaoLigada(env = process.env) {
  return String(env.YUI_PAINEL_CONFIG_DPAPI ?? 'false').trim().toLowerCase() === 'true';
}

function conteudoProtegido(estado) {
  return JSON.stringify({ valores: estado.valores, alteradoEm: estado.alteradoEm }, null, 2);
}
function serializar(estado, env = process.env) {
  if (!protecaoLigada(env)) return JSON.stringify({ version: 1, valores: estado.valores, alteradoEm: estado.alteradoEm }, null, 2);
  return JSON.stringify({ version: 2, protecao: protetor.rotulo, dados: protetor.proteger(conteudoProtegido(estado)) }, null, 2);
}

function limparEstado(raw) {
  const valores = {};
  const alteradoEm = {};
  for (const [k, v] of Object.entries(raw?.valores ?? {})) {
    if (!POR_CHAVE.has(k) || typeof v !== 'string') continue;
    valores[k] = v;
    const quando = raw?.alteradoEm?.[k];
    if (typeof quando === 'string' && !Number.isNaN(Date.parse(quando))) alteradoEm[k] = new Date(quando).toISOString();
  }
  return { version: 1, valores, alteradoEm };
}

/** Lê o arquivo: { estado, situacao: 'ok' | 'ausente' | 'ilegivel' }. 'ilegivel' = existe mas não abre (JSON quebrado, protegido por outra conta ou máquina): NUNCA se sobrescreve. */
export function lerCofre() {
  let texto;
  try { texto = fs.readFileSync(arquivo(), 'utf8'); } catch (e) { return { estado: vazio(), situacao: e?.code === 'ENOENT' ? 'ausente' : 'ilegivel' }; }
  try {
    let raw = JSON.parse(texto.replace(/^\uFEFF/, ''));
    if (raw?.version === 2) raw = JSON.parse(protetor.abrir(String(raw.dados ?? '')));
    return { estado: limparEstado(raw), situacao: 'ok' };
  } catch {
    return { estado: vazio(), situacao: 'ilegivel' };
  }
}

export function carregar() {
  return lerCofre().estado;
}

function gravarArquivoRestrito(file, conteudo) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, conteudo, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function gravar(estado, env = process.env) {
  const file = arquivo();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conteudo = serializar(estado, env); // se a proteção falhar, lança ANTES de mexer em qualquer arquivo
  if (fs.existsSync(file)) {
    // A cópia de segurança guarda os bytes do arquivo anterior (protegidos, se eram) e também nasce restrita.
    try { gravarArquivoRestrito(`${file}.bak`, fs.readFileSync(file)); } catch { /* a cópia de segurança nunca impede a gravação */ }
  }
  gravarArquivoRestrito(file, conteudo);
}

/** Estado para ALTERAR: recusa quando o cofre existe e não abre (não pode ser sobrescrito às cegas). */
function estadoParaAlterar() {
  const { estado, situacao } = lerCofre();
  if (situacao === 'ilegivel') throw new PainelConfigError(409, 'O cofre de configuração existe mas não abriu (arquivo quebrado ou protegido por outra conta). Nada foi alterado; confira o arquivo e a cópia .bak antes de continuar.');
  return estado;
}

/** Valida e normaliza um valor pelo tipo do item. Lança PainelConfigError(400) sem NUNCA repetir o valor na mensagem. */
export function validarValor(item, bruto) {
  if (bruto === undefined || bruto === null) throw new PainelConfigError(400, `${item.rotulo}: informe um valor.`);
  const s = typeof bruto === 'boolean' || typeof bruto === 'number' ? String(bruto) : String(bruto);
  switch (item.tipo) {
    case 'segredo':
      if (!SEGREDO_RE.test(s)) throw new PainelConfigError(400, `${item.rotulo}: a chave deve ter de 10 a 512 caracteres visíveis, sem espaço e sem vírgula.`);
      return s;
    case 'bool': {
      const v = s.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') throw new PainelConfigError(400, `${item.rotulo}: use ligado ou desligado.`);
      return v;
    }
    case 'int': {
      const t = s.trim();
      if (!/^-?\d{1,9}$/.test(t)) throw new PainelConfigError(400, `${item.rotulo}: use um número inteiro.`);
      const n = Number(t);
      if (n < item.min || n > item.max) throw new PainelConfigError(400, `${item.rotulo}: use um número de ${item.min} a ${item.max}.`);
      return String(n);
    }
    case 'enum': {
      const v = s.trim();
      if (!item.opcoes.includes(v)) throw new PainelConfigError(400, `${item.rotulo}: escolha uma destas opções: ${item.opcoes.join(', ')}.`);
      return v;
    }
    default: { // texto
      const t = s.trim();
      if (CONTROLE_RE.test(s)) throw new PainelConfigError(400, `${item.rotulo}: o texto não pode ter quebra de linha nem caractere de controle.`);
      if (t.length > (item.max ?? 200)) throw new PainelConfigError(400, `${item.rotulo}: no máximo ${item.max ?? 200} caracteres.`);
      if (item.formato && t && !item.formato.test(t)) throw new PainelConfigError(400, `${item.rotulo}: formato inválido.`);
      if (item.validar && t) { try { item.validar(t); } catch { throw new PainelConfigError(400, `${item.rotulo}: valor inválido.`); } }
      return t;
    }
  }
}

// ── Aplicação em process.env ───────────────────────────────────────────────────────────────
/** O valor que a variável tinha ANTES de o painel mexer (o que veio do .env ou do ambiente), para devolvê-lo quando o item sair do painel. */
const originais = new Map();

/** Coloca os valores do painel em process.env (o do painel vence o do .env); o que saiu do painel volta ao valor original. Idempotente; nunca lança. */
export function aplicarPainelConfig(env = process.env) {
  try {
    const { estado, situacao } = lerCofre();
    if (situacao === 'ilegivel') return 0; // não aplica nada de um cofre que não abriu (e não derruba a subida)
    const { valores } = estado;
    for (const chave of POR_CHAVE.keys()) {
      if (Object.hasOwn(valores, chave)) {
        if (!originais.has(chave)) originais.set(chave, env[chave]);
        env[chave] = valores[chave];
      } else if (originais.has(chave)) {
        const o = originais.get(chave);
        if (o === undefined) delete env[chave]; else env[chave] = o;
        originais.delete(chave);
      }
    }
    return Object.keys(valores).length;
  } catch {
    return 0;
  }
}

export function definir(chave, valor, env = process.env) {
  const item = POR_CHAVE.get(String(chave));
  if (!item) throw new PainelConfigError(404, 'Esse ajuste não existe no painel.');
  if (!edicaoLigada(env)) throw new PainelConfigError(403, 'A edição de configuração pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env).');
  const v = validarValor(item, valor);
  const estado = estadoParaAlterar();
  estado.valores[item.chave] = v;
  estado.alteradoEm[item.chave] = new Date().toISOString();
  gravar(estado, env);
  aplicarPainelConfig(env);
  return { chave: item.chave, reinicio: item.reinicio };
}

export function remover(chave, env = process.env) {
  const item = POR_CHAVE.get(String(chave));
  if (!item) throw new PainelConfigError(404, 'Esse ajuste não existe no painel.');
  if (!edicaoLigada(env)) throw new PainelConfigError(403, 'A edição de configuração pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env).');
  const estado = estadoParaAlterar();
  if (!Object.hasOwn(estado.valores, item.chave)) throw new PainelConfigError(404, 'Esse ajuste não está salvo no painel.');
  delete estado.valores[item.chave];
  delete estado.alteradoEm[item.chave];
  gravar(estado, env);
  aplicarPainelConfig(env);
  return { chave: item.chave, reinicio: item.reinicio };
}

/** O estado para a tela: NUNCA devolve um segredo (só "definido" e os 4 últimos caracteres do que veio do painel). */
export function descrever(env = process.env) {
  const { estado, situacao } = lerCofre();
  const { valores, alteradoEm } = estado;
  return {
    edicaoLigada: edicaoLigada(env),
    protegido: protecaoLigada(env),
    ...(situacao === 'ilegivel' ? { problema: 'cofre-ilegivel' } : {}),
    itens: CATALOGO.map((c) => {
      const doPainel = Object.hasOwn(valores, c.chave);
      const efetivo = env[c.chave];
      const definido = doPainel || (efetivo !== undefined && String(efetivo).trim() !== '');
      const origem = doPainel ? 'painel' : definido ? 'env' : 'padrao';
      const base = {
        chave: c.chave, rotulo: c.rotulo, grupo: c.grupo, descricao: c.descricao, tipo: c.tipo, reinicio: c.reinicio, definido, origem, alteradoEm: doPainel ? (alteradoEm[c.chave] ?? null) : null,
        ...(c.opcoes ? { opcoes: [...c.opcoes] } : {}), ...(c.min !== undefined ? { min: c.min, max: c.max } : {}), ...(c.padrao !== undefined ? { padrao: c.padrao } : {}),
      };
      if (c.secreto) return { ...base, secreto: true, ultimos4: doPainel ? valores[c.chave].slice(-4) : null };
      return { ...base, valor: definido ? String(efetivo ?? valores[c.chave] ?? '') : null };
    }),
  };
}

/** Só para teste: esquece o que o módulo lembra do ambiente. */
export function esquecerParaTeste() { originais.clear(); }
