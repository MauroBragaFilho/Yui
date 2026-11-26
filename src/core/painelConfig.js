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
 * `confirmar`: valores que afrouxam privacidade ou segurança; gravá-los (ou remover o item, que pode voltar a um .env mais frouxo) exige `confirm: true` na API.
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
  // Voz na call e privacidade (na dúvida, deixe desligado)
  bool({ chave: 'YUI_VOZ_UNIFICADA', confirmar: ['true'], rotulo: 'Voz unificada (memória pessoal na call)', grupo: 'Privacidade', descricao: 'ATENÇÃO, PRIVACIDADE: com você sozinho na call, a Yui usa na voz a sua memória pessoal e a persona, e fala isso em voz alta. Quem estiver perto do alto-falante ouve.', reinicio: true, padrao: 'false' }),
  bool({ chave: 'YUI_VOZ_GOOGLE', confirmar: ['true'], rotulo: 'Agenda do Google por voz', grupo: 'Privacidade', descricao: 'ATENÇÃO, PRIVACIDADE: com você sozinho na call, a Yui pode falar os compromissos da sua agenda em voz alta. Só vale com a voz unificada e o Google ligados.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_VOZ_PRAZO_S', rotulo: 'Prazo da resposta na voz unificada (segundos)', grupo: 'Privacidade', descricao: 'Passou desse tempo, a Yui avisa que demorou e não publica a resposta atrasada.', reinicio: true, min: 3, max: 12, padrao: '8' }),
  // Contexto das conversas, pesquisa e clima
  bool({ chave: 'YUI_CONTEXT_ENABLED', confirmar: ['true'], rotulo: 'Contexto das conversas por horas', grupo: 'Conversa', descricao: 'A Yui lembra as últimas falas de cada conversa por algumas horas (ficam guardadas no computador). O alcance (só você ou todos) continua no .env.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_CONTEXT_TTL_HOURS', rotulo: 'Por quantas horas lembrar', grupo: 'Conversa', descricao: 'Depois desse tempo a fala é descartada.', reinicio: true, min: 1, max: 48, padrao: '6' }),
  inteiro({ chave: 'YUI_CONTEXT_MAX_CHARS', rotulo: 'Tamanho máximo do contexto (caracteres)', grupo: 'Conversa', descricao: 'Quanto da conversa anterior vai para a IA. Mais caracteres gastam mais cota.', reinicio: true, min: 1000, max: 30000, padrao: '6000' }),
  inteiro({ chave: 'YUI_CONTEXT_MAX_TURNS', rotulo: 'Máximo de falas no contexto', grupo: 'Conversa', descricao: 'Conta as suas e as da Yui. Número ímpar é arredondado para baixo.', reinicio: true, min: 2, max: 60, padrao: '20' }),
  bool({ chave: 'YUI_HISTORICO_COMPARTILHADO', confirmar: ['true'], rotulo: 'Mesmo fio no painel, no app e na DM', grupo: 'Conversa', descricao: 'O seu chat no painel e no app continua a conversa da sua DM do Discord. Só vale com o contexto por horas ligado.', reinicio: false, padrao: 'false' }),
  opcao({ chave: 'YUI_PESQUISA_POR_INTENCAO', rotulo: 'Pesquisar sozinha quando a pergunta pede', grupo: 'Conversa', descricao: '"off" nunca; "servidor" só nos servidores; "dono" nos servidores e na sua DM (a DM ainda depende da pesquisa privada liberada no .env).', reinicio: true, opcoes: ['off', 'servidor', 'dono'], padrao: 'dono' }),
  bool({ chave: 'YUI_CLIMA', rotulo: 'Consulta de clima e previsão', grupo: 'Conversa', descricao: 'Responde perguntas de tempo e previsão consultando o Open-Meteo.', reinicio: true, padrao: 'true' }),
  // Monitores, alertas e relatório matinal
  bool({ chave: 'YUI_MONITORES', rotulo: 'Monitores de busca ("me avisa quando...")', grupo: 'Monitores', descricao: 'Só com o cérebro separado. Gasta cota de busca e avisa só você, por DM.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_MONITORES_MS', rotulo: 'Conferir monitores a cada (milissegundos)', grupo: 'Monitores', descricao: '600000 = 10 minutos.', reinicio: true, min: 60000, max: 86400000, padrao: '600000' }),
  inteiro({ chave: 'YUI_MONITORES_RESERVA', rotulo: 'Cota de busca reservada à conversa (%)', grupo: 'Monitores', descricao: 'Parte da cota por hora que os monitores nunca usam.', reinicio: true, min: 0, max: 90, padrao: '10' }),
  bool({ chave: 'YUI_ALERTS', confirmar: ['false'], rotulo: 'Avisos de erro por DM', grupo: 'Alertas', descricao: 'Desligar faz a Yui parar de avisar você quando algo dá errado.', reinicio: true, padrao: 'true' }),
  inteiro({ chave: 'YUI_ALERTS_COOLDOWN_MINUTES', rotulo: 'Intervalo para repetir o mesmo aviso (minutos)', grupo: 'Alertas', descricao: 'Evita receber o mesmo aviso em sequência.', reinicio: true, min: 1, max: 1440, padrao: '30' }),
  bool({ chave: 'YUI_ALERTAS_EVENTOS', rotulo: 'Alertas de disco, memória e internet', grupo: 'Alertas', descricao: 'Avisa por DM quando o computador da Yui está com problema (precisa dos avisos de erro ligados).', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_ALERTAS_EVENTOS_MS', rotulo: 'Conferir o computador a cada (milissegundos)', grupo: 'Alertas', descricao: '300000 = 5 minutos.', reinicio: true, min: 60000, max: 86400000, padrao: '300000' }),
  inteiro({ chave: 'YUI_ALERTA_DISCO_GB', rotulo: 'Avisar com disco livre abaixo de (GB)', grupo: 'Alertas', descricao: '0 desliga essa verificação.', reinicio: true, min: 0, max: 10000, padrao: '5' }),
  inteiro({ chave: 'YUI_ALERTA_RAM_MB', rotulo: 'Avisar com memória livre abaixo de (MB)', grupo: 'Alertas', descricao: '0 desliga essa verificação.', reinicio: true, min: 0, max: 1000000, padrao: '400' }),
  inteiro({ chave: 'YUI_ALERTA_RAM_MIN', rotulo: 'Minutos de memória baixa antes de avisar', grupo: 'Alertas', descricao: 'Um pico curto não gera aviso.', reinicio: true, min: 0, max: 1440, padrao: '5' }),
  texto({ chave: 'YUI_ALERTA_INTERNET_ALVO', rotulo: 'Endereço para testar a internet', grupo: 'Alertas', descricao: 'host ou host:porta (porta padrão 443). Só abre a conexão, sem enviar nada. Vazio não testa.', reinicio: true, max: 259, padrao: '', formato: /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/, validar: (v) => { const porta = v.includes(':') ? Number(v.split(':')[1]) : 443; if (porta < 1 || porta > 65535) throw new Error('porta'); } }),
  bool({ chave: 'YUI_MORNING_REPORT', rotulo: 'Relatório matinal por DM', grupo: 'Relatório', descricao: 'Lembretes do dia, pendências e a saúde da Yui. Desligado, volta o relatório só de saúde.', reinicio: true, padrao: 'true' }),
  inteiro({ chave: 'YUI_MORNING_REPORT_HOUR', rotulo: 'Hora do relatório matinal', grupo: 'Relatório', descricao: 'No seu fuso horário.', reinicio: true, min: 0, max: 23, padrao: '8' }),
  // Ajustes finos da voz (o texto sensível na nuvem e a lista de provedores continuam só no .env)
  bool({ chave: 'YUI_TTS_ENABLED', rotulo: 'Yui fala na call', grupo: 'Voz', descricao: 'Desligado, a Yui responde só por texto.', reinicio: true, padrao: 'true' }),
  texto({ chave: 'YUI_TTS_OMNIROUTE_MODELO', rotulo: 'Modelo de voz no OmniRoute', grupo: 'Voz', descricao: 'Nome do modelo exatamente como o OmniRoute mostra.', reinicio: true, max: 120, padrao: 'google/gemini-3.8-flash-tts', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  texto({ chave: 'YUI_TTS_OMNIROUTE_VOZ', rotulo: 'Voz no OmniRoute', grupo: 'Voz', descricao: 'Por exemplo Leda, Kore ou Aoede.', reinicio: true, max: 80, padrao: 'Leda', formato: /^[A-Za-z0-9][\w.:@/-]{0,79}$/ }),
  inteiro({ chave: 'YUI_TTS_OMNIROUTE_TETO_DIA', rotulo: 'Máximo de falas por dia no OmniRoute', grupo: 'Voz', descricao: 'Cada frase falada conta uma.', reinicio: true, min: 1, max: 100000, padrao: '400' }),
  inteiro({ chave: 'YUI_TTS_OMNIROUTE_TIMEOUT_MS', rotulo: 'Prazo da voz no OmniRoute (milissegundos)', grupo: 'Voz', descricao: 'Passou disso, a próxima voz da fila assume.', reinicio: true, min: 2000, max: 60000, padrao: '10000' }),
  texto({ chave: 'YUI_TTS_AZURE_VOICE', rotulo: 'Voz do Azure', grupo: 'Voz', descricao: 'Por exemplo pt-BR-ThalitaMultilingualNeural.', reinicio: true, max: 80, padrao: 'pt-BR-ThalitaMultilingualNeural', formato: /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]{2,60}Neural$/ }),
  texto({ chave: 'YUI_TTS_EDGE_VOICE', rotulo: 'Voz do Edge', grupo: 'Voz', descricao: 'Por exemplo pt-BR-FranciscaNeural.', reinicio: true, max: 80, padrao: 'pt-BR-FranciscaNeural', formato: /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]{2,60}Neural$/ }),
  inteiro({ chave: 'YUI_TTS_SAPI_RATE', rotulo: 'Velocidade da voz do Windows', grupo: 'Voz', descricao: 'Negativo fala mais devagar.', reinicio: true, min: -10, max: 10, padrao: '0' }),
  inteiro({ chave: 'YUI_TTS_MAX_CHARS', rotulo: 'Caracteres falados por resposta', grupo: 'Voz', descricao: 'O resto fica só no texto.', reinicio: true, min: 60, max: 600, padrao: '220' }),
  inteiro({ chave: 'YUI_TTS_MAX_SENTENCES', rotulo: 'Frases faladas por resposta', grupo: 'Voz', descricao: 'No máximo quantas frases ela fala.', reinicio: true, min: 1, max: 6, padrao: '3' }),
  inteiro({ chave: 'YUI_TTS_MAX_SENTENCE_CHARS', rotulo: 'Caracteres por frase falada', grupo: 'Voz', descricao: 'Limite de tamanho de cada frase.', reinicio: true, min: 60, max: 400, padrao: '160' }),
  inteiro({ chave: 'YUI_TTS_MAX_SECONDS', rotulo: 'Segundos de fala por resposta', grupo: 'Voz', descricao: 'Tempo máximo falando.', reinicio: true, min: 5, max: 60, padrao: '25' }),
  inteiro({ chave: 'YUI_TTS_USER_GAP_SECONDS', rotulo: 'Intervalo entre falas para a mesma pessoa (segundos)', grupo: 'Voz', descricao: 'Protege contra abuso e eco.', reinicio: true, min: 0, max: 120, padrao: '6' }),
  inteiro({ chave: 'YUI_TTS_USER_PER_MIN', rotulo: 'Falas por minuto por pessoa', grupo: 'Voz', descricao: 'Limite contra abuso.', reinicio: true, min: 1, max: 60, padrao: '5' }),
  inteiro({ chave: 'YUI_TTS_GUILD_PER_MIN', rotulo: 'Falas por minuto por servidor', grupo: 'Voz', descricao: 'Limite contra abuso.', reinicio: true, min: 1, max: 120, padrao: '8' }),
  inteiro({ chave: 'YUI_TTS_GLOBAL_PER_MIN', rotulo: 'Falas por minuto no total', grupo: 'Voz', descricao: 'Limite contra abuso.', reinicio: true, min: 1, max: 240, padrao: '12' }),
  bool({ chave: 'YUI_TTS_BARGE_IN', rotulo: 'Parar de falar quando alguém interrompe', grupo: 'Voz', descricao: 'A Yui se cala quando alguém fala por cima.', reinicio: true, padrao: 'true' }),
  inteiro({ chave: 'YUI_TTS_BARGE_IN_MS', rotulo: 'Fala que conta como interrupção (milissegundos)', grupo: 'Voz', descricao: 'Valores baixos interrompem com qualquer ruído.', reinicio: true, min: 200, max: 5000, padrao: '800' }),
  // Mídia e avisos (os tetos começam em 1: "sem limite" continua só no .env)
  inteiro({ chave: 'YUI_DL_MAX_MINUTES', rotulo: 'Duração máxima de download (minutos)', grupo: 'Mídia', descricao: 'Não vale para o Modo Rádio nem para o Spotify.', reinicio: true, min: 1, max: 1440, padrao: '20' }),
  inteiro({ chave: 'YUI_DL_MAX_FILESIZE_MB', rotulo: 'Tamanho máximo de download (MB)', grupo: 'Mídia', descricao: 'Arquivos maiores são recusados.', reinicio: true, min: 1, max: 10240, padrao: '200' }),
  inteiro({ chave: 'YUI_DL_TIMEOUT_SECONDS', rotulo: 'Tempo máximo de um download (segundos)', grupo: 'Mídia', descricao: 'Passou disso, o download é cancelado.', reinicio: true, min: 30, max: 3600, padrao: '300' }),
  inteiro({ chave: 'YUI_DL_MAX_CONCURRENT', rotulo: 'Downloads ao mesmo tempo', grupo: 'Mídia', descricao: 'O dono nunca é barrado por esse teto.', reinicio: true, min: 1, max: 50, padrao: '3' }),
  inteiro({ chave: 'YUI_UPLOAD_LIMIT_MB', rotulo: 'Limite de anexo do Discord (MB)', grupo: 'Mídia', descricao: 'Acima do que o Discord aceita, o envio falha.', reinicio: true, min: 1, max: 100, padrao: '10' }),
  inteiro({ chave: 'YUI_IMAGE_PER_HOUR', rotulo: 'Imagens por pessoa por hora', grupo: 'Mídia', descricao: 'O dono não tem limite.', reinicio: true, min: 1, max: 100, padrao: '6' }),
  inteiro({ chave: 'YUI_YT_LIVE_AUTO_EDIT_MIN', rotulo: 'Janela para editar aviso de live (minutos)', grupo: 'Mídia', descricao: 'Tempo em que o aviso ainda é atualizado sozinho.', reinicio: true, min: 5, max: 1440, padrao: '120' }),
  inteiro({ chave: 'YOUTUBE_INTERVAL_MINUTES', rotulo: 'Conferir o YouTube a cada (minutos)', grupo: 'Mídia', descricao: 'Intervalos curtos gastam mais cota da API.', reinicio: true, min: 1, max: 59, padrao: '5' }),
  inteiro({ chave: 'TWITCH_INTERVAL_MINUTES', rotulo: 'Conferir a Twitch a cada (minutos)', grupo: 'Mídia', descricao: 'Entre 1 e 2 minutos é o recomendado.', reinicio: true, min: 1, max: 59, padrao: '2' }),
  bool({ chave: 'YTDLP_AUTO_UPDATE', rotulo: 'Atualizar o yt-dlp sozinho', grupo: 'Mídia', descricao: 'Mantém o programa de download em dia.', reinicio: true, padrao: 'true' }),
  inteiro({ chave: 'YTDLP_UPDATE_HOUR', rotulo: 'Hora da atualização do yt-dlp', grupo: 'Mídia', descricao: 'Escolha um horário de pouco uso.', reinicio: true, min: 0, max: 23, padrao: '4' }),
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

/** Precisa de `confirm: true`? `valor` ausente = remoção do item. */
export function exigeConfirmacao(chave, valor) {
  const lista = POR_CHAVE.get(String(chave))?.confirmar;
  if (!lista) return false;
  return valor === undefined || lista.includes(String(valor).trim().toLowerCase());
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
        ...(c.opcoes ? { opcoes: [...c.opcoes] } : {}), ...(c.confirmar ? { confirmar: [...c.confirmar] } : {}), ...(c.min !== undefined ? { min: c.min, max: c.max } : {}), ...(c.padrao !== undefined ? { padrao: c.padrao } : {}),
      };
      if (c.secreto) return { ...base, secreto: true, ultimos4: doPainel ? valores[c.chave].slice(-4) : null };
      return { ...base, valor: definido ? String(efetivo ?? valores[c.chave] ?? '') : null };
    }),
  };
}

/** Só para teste: esquece o que o módulo lembra do ambiente. */
export function esquecerParaTeste() { originais.clear(); }
