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
//  - Quem muda o quê: o painel roda no processo do CÉREBRO e aplica na hora ali. Depois de salvar ou remover, o cérebro avisa o BOT pelo canal (evento `painel.settingsChanged`, sem nenhum
//    valor); o bot relê o cofre e atualiza no processo dele SÓ as chaves `reinicio: false` (`recarregarAoVivo`), e relê também ao (re)conectar. No processo único o painel já muda o próprio processo.
//  - Cada item diz se a mudança precisa de REINÍCIO da Yui para valer. `reinicio: false` só quando TODO consumidor, nos dois processos, lê a variável a cada uso; as de privacidade de voz
//    (YUI_VOZ_*) pedem reinício de propósito. `soNaSubida`: nem o cérebro muda em execução (os dois processos têm de concordar).
//  - Com a DPAPI cada abertura do cofre chama o PowerShell de forma SÍNCRONA (execFileSync: o processo para durante a chamada). Por isso o bot só abre o cofre quando o arquivo mudou: uma vez por mudança; se não abrir, o mesmo arquivo só é tentado de novo
//    depois de ESPERA_FALHA_MS (e o bot registra um aviso, sem valores).
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
// Número com casas decimais (lacunas do painel, item 6: a temperatura da IA). `casas`: quantas casas depois do ponto (padrão 2); aceita vírgula.
const decimal = (v) => ({ tipo: 'decimal', casas: 2, ...v });
const opcao = (v) => ({ tipo: 'enum', ...v });
const texto = (v) => ({ tipo: 'texto', ...v });
const segredo = (v) => ({ tipo: 'segredo', secreto: true, ...v });

/**
 * O catálogo: `reinicio: true` = só vale com segurança depois de reiniciar a Yui; `false` = lido a cada uso (vale na hora no cérebro, e no bot quando ele recebe o aviso ou reconecta).
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
  // Lacunas do painel, item 2 (26/11/2026): as chaves que só existiam no .env. O padrão de cada uma é o do código (sem o cofre nada muda).
  bool({ chave: 'YUI_VISION', rotulo: 'Ver imagens anexadas', grupo: 'Inteligência', descricao: 'A Yui olha as imagens anexadas à mensagem (por um modelo com visão: Gemini e, de reserva, Groq) e responde com base nelas. Desligado, ela ignora as imagens.', reinicio: false, padrao: 'true' }),
  // Lacunas do painel, item 6 (26/11/2026; decisão do dono: "gravar no mesmo cofre"): a configuração da IA que só existia no painel do Discord (/yui-criador
  // bot_config e /yui-config_ia). O Discord e o painel web gravam AQUI (src/core/ajustesPeloDiscord.js). O padrão de cada um é o do código (sem o cofre nada muda).
  //  - mostrar o modelo, novas tentativas e temperatura/prazo/tamanho por provedor da cadeia do bot: lidos a CADA USO só pelo bot (src/core/ai/ajustesIa.js); o
  //    cérebro não os lê (o tamanho chega a ele pelo fato do canal que o bot manda a cada turno). Por isso valem na hora;
  //  - os modelos: lidos na SUBIDA pelos dois processos (src/config/index.js e o Gateway): pedem reinício;
  //  - os endereços (URLs) ficam de fora de propósito: decidem para onde vão a chave e a conversa.
  bool({ chave: 'YUI_IA_MOSTRAR_MODELO', rotulo: 'Mostrar qual modelo respondeu', grupo: 'Inteligência', descricao: 'No Discord, o rodapé da resposta mostra o nome do modelo de IA que respondeu. Bom para conferir; polui um pouco a conversa.', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_IA_MOSTRAR_MODELO_PENSANDO', rotulo: 'Mostrar o modelo enquanto pensa', grupo: 'Inteligência', descricao: 'No Discord, a mensagem de "pensando..." mostra qual modelo está tentando responder naquele momento.', reinicio: false, padrao: 'false' }),
  inteiro({ chave: 'YUI_IA_RETENTATIVAS', rotulo: 'Novas tentativas quando a resposta vem quebrada', grupo: 'Inteligência', descricao: 'Quantas vezes a Yui pede de novo ao modelo quando a resposta vem com erro (ferramenta escrita como texto, formato inválido). 0 = nenhuma. Muitas tentativas deixam a resposta lenta.', reinicio: false, min: 0, max: 10, padrao: '0' }),
  bool({ chave: 'YUI_IA_CONTEXTO_DO_SERVIDOR', rotulo: 'Contar à IA o servidor e o canal', grupo: 'Inteligência', descricao: 'Manda à IA o nome do servidor e do canal da conversa, para ela saber onde está. Desligado, economiza um pouco de cota.', reinicio: false, padrao: 'true' }),
  texto({ chave: 'GEMINI_MODEL', rotulo: 'Gemini: modelo principal', grupo: 'Inteligência', descricao: 'Nome do modelo do Google Gemini, por exemplo gemini-flash-lite-latest. Nome aposentado pelo Google é trocado sozinho pelo apelido atual.', reinicio: true, max: 120, padrao: 'gemini-flash-lite-latest', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  texto({ chave: 'GEMINI_MODEL_FALLBACK', rotulo: 'Gemini: modelo reserva', grupo: 'Inteligência', descricao: 'Modelo do Gemini tentado quando o principal falha em todas as chaves. Use um diferente do principal.', reinicio: true, max: 120, padrao: 'gemini-flash-latest', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  texto({ chave: 'GROQ_MODEL', rotulo: 'Groq: modelo', grupo: 'Inteligência', descricao: 'Nome do modelo no Groq, por exemplo openai/gpt-oss-120b.', reinicio: true, max: 120, padrao: 'openai/gpt-oss-120b', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  texto({ chave: 'HF_MODEL', rotulo: 'Hugging Face: modelo', grupo: 'Inteligência', descricao: 'Nome completo do modelo no Hugging Face (Organização/Modelo), por exemplo Qwen/Qwen2.5-72B-Instruct.', reinicio: true, max: 120, padrao: 'Qwen/Qwen2.5-72B-Instruct', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  texto({ chave: 'LOCAL_LLM_MODEL', rotulo: 'LM Studio: modelo', grupo: 'Inteligência', descricao: 'Nome do modelo carregado no LM Studio ou no Ollama. Sem valor, vale o AI_MODEL do .env ou local-model.', reinicio: true, max: 120, padrao: 'local-model', formato: /^[A-Za-z0-9][\w.:@/-]{0,119}$/ }),
  decimal({ chave: 'YUI_IA_LMSTUDIO_TEMPERATURA', rotulo: 'LM Studio: temperatura', grupo: 'Inteligência', descricao: 'Criatividade do modelo local: perto de 0 responde de forma previsível; acima de 1 fica mais solto e pode se perder.', reinicio: false, min: 0, max: 2, padrao: '0.7' }),
  inteiro({ chave: 'YUI_IA_LMSTUDIO_TIMEOUT_MS', rotulo: 'LM Studio: prazo (milissegundos)', grupo: 'Inteligência', descricao: 'Quanto a Yui espera o modelo local antes de passar para o próximo provedor. 60000 = 1 minuto.', reinicio: false, min: 5000, max: 300000, padrao: '60000' }),
  inteiro({ chave: 'YUI_IA_LMSTUDIO_MAX_TOKENS', rotulo: 'LM Studio: tamanho máximo da resposta (tokens)', grupo: 'Inteligência', descricao: 'Limite de tokens da resposta do modelo local (1 token é cerca de 3/4 de palavra). Sem ajuste, vale o padrão (ou o YUI_REPLY_MAX_TOKENS do .env).', reinicio: false, min: 64, max: 8192, padrao: '1024' }),
  decimal({ chave: 'YUI_IA_GEMINI_TEMPERATURA', rotulo: 'Gemini: temperatura', grupo: 'Inteligência', descricao: 'Criatividade do Gemini: perto de 0 responde de forma previsível; acima de 1 fica mais solto.', reinicio: false, min: 0, max: 2, padrao: '0.7' }),
  inteiro({ chave: 'YUI_IA_GEMINI_TIMEOUT_MS', rotulo: 'Gemini: prazo (milissegundos)', grupo: 'Inteligência', descricao: 'Quanto a Yui espera o Gemini antes de passar para o próximo provedor. 60000 = 1 minuto.', reinicio: false, min: 5000, max: 300000, padrao: '60000' }),
  inteiro({ chave: 'YUI_IA_GEMINI_MAX_TOKENS', rotulo: 'Gemini: tamanho máximo da resposta (tokens)', grupo: 'Inteligência', descricao: 'Limite de tokens da resposta do Gemini no Discord (vale também com o cérebro separado). O app não herda este ajuste. Sem ajuste, vale o padrão (ou o YUI_REPLY_MAX_TOKENS do .env).', reinicio: false, min: 64, max: 8192, padrao: '2048' }),
  inteiro({ chave: 'YUI_IA_POLLINATIONS_TIMEOUT_MS', rotulo: 'Pollinations: prazo (milissegundos)', grupo: 'Inteligência', descricao: 'Quanto a Yui espera o Pollinations (gratuito, anônimo e às vezes lento) antes de desistir dele.', reinicio: false, min: 5000, max: 300000, padrao: '60000' }),
  inteiro({ chave: 'YUI_IA_POLLINATIONS_MAX_TOKENS', rotulo: 'Pollinations: tamanho máximo da resposta (tokens)', grupo: 'Inteligência', descricao: 'Limite de tokens da resposta do Pollinations quando a conversa do Discord passa pelo cérebro separado. Sem ajuste, vale o padrão (ou o YUI_REPLY_MAX_TOKENS do .env).', reinicio: false, min: 64, max: 4096, padrao: '1024' }),
  decimal({ chave: 'YUI_IA_HF_TEMPERATURA', rotulo: 'Hugging Face: temperatura', grupo: 'Inteligência', descricao: 'Criatividade do modelo do Hugging Face: valores baixos para assuntos técnicos, altos para conversa solta.', reinicio: false, min: 0, max: 2, padrao: '0.7' }),
  inteiro({ chave: 'YUI_IA_HF_TIMEOUT_MS', rotulo: 'Hugging Face: prazo (milissegundos)', grupo: 'Inteligência', descricao: 'Quanto a Yui espera o Hugging Face antes de passar para o próximo provedor. Modelos grandes podem precisar de 90000.', reinicio: false, min: 5000, max: 300000, padrao: '60000' }),
  inteiro({ chave: 'YUI_IA_HF_MAX_TOKENS', rotulo: 'Hugging Face: tamanho máximo da resposta (tokens)', grupo: 'Inteligência', descricao: 'Limite de tokens da resposta do Hugging Face. O plano gratuito pode cortar antes. Sem ajuste, vale o padrão (ou o YUI_REPLY_MAX_TOKENS do .env).', reinicio: false, min: 64, max: 4096, padrao: '512' }),
  decimal({ chave: 'YUI_IA_HORDE_TEMPERATURA', rotulo: 'AI Horde: temperatura', grupo: 'Inteligência', descricao: 'Criatividade dos modelos do AI Horde (GPUs voluntárias, qualidade variável). Valores moderados ajudam.', reinicio: false, min: 0, max: 2, padrao: '0.7' }),
  inteiro({ chave: 'YUI_IA_HORDE_TIMEOUT_MS', rotulo: 'AI Horde: prazo (milissegundos)', grupo: 'Inteligência', descricao: 'Quanto a Yui espera a fila do AI Horde (o pedido e a espera pelo resultado). 120000 = 2 minutos.', reinicio: false, min: 10000, max: 300000, padrao: '60000' }),
  inteiro({ chave: 'YUI_IA_HORDE_MAX_TOKENS', rotulo: 'AI Horde: tamanho máximo da resposta (tokens)', grupo: 'Inteligência', descricao: 'Limite de tokens da resposta do AI Horde. Muitos voluntários aceitam no máximo 256 a 512. Sem ajuste, vale o padrão (ou o YUI_REPLY_MAX_TOKENS do .env, até 512).', reinicio: false, min: 64, max: 2048, padrao: '256' }),
  // Geral
  texto({ chave: 'YUI_FUSO', rotulo: 'Fuso horário do dono', grupo: 'Geral', descricao: 'Por exemplo America/Cuiaba. Sem valor, vale o horário de Brasília. Só muda como as horas são mostradas e lidas.', reinicio: true, max: 60, padrao: '', validar: (v) => { new Intl.DateTimeFormat('pt-BR', { timeZone: v }); } }),
  texto({ chave: 'YUI_CLIMA_CIDADE_PADRAO', rotulo: 'Cidade padrão do clima', grupo: 'Geral', descricao: 'Por exemplo Cuiaba-MT.', reinicio: false, max: 80, padrao: '' }),
  opcao({ chave: 'REDDIT_FETCH_MODE', rotulo: 'Semanal: consulta ao Reddit', grupo: 'Geral', descricao: '"Não consultar" não abre o navegador (recomendado em máquina de pouca memória).', reinicio: false, opcoes: ['browser', 'cookies', 'off'], padrao: 'browser' }),
  bool({ chave: 'GTA_WEEKLY_ENABLED', rotulo: 'Semanal do GTA: conferir e publicar sozinho', grupo: 'Geral', descricao: 'Confere o evento semanal do GTA Online de tempos em tempos e publica nos canais configurados. Desligado, o /gta-semanal continua funcionando.', reinicio: true, padrao: 'true' }),
  bool({ chave: 'NEWSWIRE_ENABLED', rotulo: 'Notícias da Rockstar: conferir e publicar sozinho', grupo: 'Geral', descricao: 'Confere o Rockstar Newswire de tempos em tempos e publica as notícias novas nos canais de notícias. Desligado, o /gta-noticias continua funcionando.', reinicio: true, padrao: 'false' }),
  bool({ chave: 'YUI_GOOGLE', rotulo: 'Google Agenda e Tarefas (somente leitura)', grupo: 'Geral', descricao: 'Liga a leitura de Agenda e Tarefas. A autorização (token) continua sendo feita à parte.', reinicio: false, padrao: 'false' }),
  // Lacunas do painel, item 14 (entrega F, 27/11/2026; decisão do dono: "reautorizar o Google pelo painel"): lida A CADA PEDIDO só pela API do painel (o cérebro,
  // com os dois processos; o bot nunca a lê), por isso vale na hora. Desligada, as duas rotas respondem 404 e só o script renova.
  bool({ chave: 'YUI_GOOGLE_REAUTORIZAR_PAINEL', confirmar: ['true'], rotulo: 'Reautorizar o Google pelo painel', grupo: 'Geral', descricao: 'Em Admin > Integrações aparece o botão "Reautorizar o Google": a Yui gera o link de consentimento (só Agenda e Tarefas, somente leitura; o Gmail continua só pelo script), você autoriza no navegador e cola de volta o endereço da página que não abre. Só funciona quando já existe a autorização feita pelo script. Desligado, só o script renova.', reinicio: false, padrao: 'false' }),
  // Voz na call e privacidade (na dúvida, deixe desligado)
  bool({ chave: 'YUI_VOZ_UNIFICADA', confirmar: ['true'], rotulo: 'Voz unificada (memória pessoal na call)', grupo: 'Privacidade', descricao: 'ATENÇÃO, PRIVACIDADE: com você sozinho na call, a Yui usa na voz a sua memória pessoal e a persona, e fala isso em voz alta. Quem estiver perto do alto-falante ouve.', reinicio: true, padrao: 'false' }),
  bool({ chave: 'YUI_VOZ_GOOGLE', confirmar: ['true'], rotulo: 'Agenda do Google por voz', grupo: 'Privacidade', descricao: 'ATENÇÃO, PRIVACIDADE: com você sozinho na call, a Yui pode falar os compromissos da sua agenda em voz alta. Só vale com a voz unificada e o Google ligados.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_VOZ_PRAZO_S', rotulo: 'Prazo da resposta na voz unificada (segundos)', grupo: 'Privacidade', descricao: 'Passou desse tempo, a Yui avisa que demorou e não publica a resposta atrasada.', reinicio: true, min: 3, max: 12, padrao: '8' }),
  bool({ chave: 'YUI_SALVAR_HISTORICO', confirmar: ['true'], rotulo: 'Guardar os pedidos e as respostas num arquivo', grupo: 'Privacidade', descricao: 'ATENÇÃO, PRIVACIDADE: guarda cada pedido feito à Yui por escrito no Discord, a resposta dela, o nome e o ID de quem pediu e o servidor no arquivo historico.txt do computador da Yui (a fala da call nunca entra). Serve para conferir depois; o arquivo só cresce.', reinicio: false, padrao: 'true' }),
  // Moderação (o dono nunca é banido; a lista de bans continua na aba Bans)
  bool({ chave: 'REQUIRE_TOS', confirmar: ['false'], rotulo: 'Exigir os Termos de Uso nos servidores', grupo: 'Moderação', descricao: 'ATENÇÃO: desligado, a Yui passa a responder em servidores que nunca aceitaram os Termos de Uso.', reinicio: true, padrao: 'true' }),
  opcao({ chave: 'YUI_AUTOMOD_AI_BAN', confirmar: ['auto'], rotulo: 'Ban decidido pela IA (AutoMod)', grupo: 'Moderação', descricao: '"A IA sugere e você decide": a IA só propõe o ban e você decide pelo botão do aviso. "A IA bane sozinha": ATENÇÃO, ela bane na hora, sem passar por você.', reinicio: false, opcoes: ['review', 'auto'], padrao: 'review' }),
  // Item 6 (26/11/2026): os ajustes de moderação do painel do Discord, lidos a cada uso pelo bot (getters de src/config/index.js). Nomes YUI_* novos de propósito:
  // os antigos (DEFAULT_AUTOMOD, AUTOMOD_MODE, APPEAL_CHANNEL_ID...) nunca foram lidos, e reaproveitá-los ligaria de surpresa um valor esquecido num .env.
  bool({ chave: 'YUI_AUTOMOD_PADRAO', confirmar: ['false'], rotulo: 'AutoMod nos servidores sem ajuste próprio', grupo: 'Moderação', descricao: 'Vale para servidor novo e para todo servidor onde o AutoMod nunca foi ajustado. ATENÇÃO: desligado, esses servidores ficam sem moderação automática.', reinicio: false, padrao: 'true' }),
  opcao({ chave: 'YUI_AUTOMOD_MODO_PADRAO', confirmar: ['off'], rotulo: 'Modo do AutoMod nos servidores sem ajuste próprio', grupo: 'Moderação', descricao: '"Gatilhos e IA": palavras proibidas e ferramentas perigosas da IA; "Só IA": só as ferramentas; "Só gatilhos": só as palavras; "Desligado": ATENÇÃO, nenhum. Servidor com ajuste próprio não muda.', reinicio: false, opcoes: ['both', 'mcp', 'trigger', 'off'], padrao: 'both' }),
  texto({ chave: 'YUI_CANAL_APELACOES', rotulo: 'Canal das apelações de banimento', grupo: 'Moderação', descricao: 'ID do canal do Discord que recebe os pedidos de revisão de quem foi bloqueado. Vazio: o pedido não chega a canal nenhum.', reinicio: false, max: 20, padrao: '', formato: /^\d{17,20}$/ }),
  // Contexto das conversas, pesquisa e clima
  bool({ chave: 'YUI_CONTEXT_ENABLED', confirmar: ['true'], rotulo: 'Contexto das conversas por horas', grupo: 'Conversa', descricao: 'A Yui lembra as últimas falas de cada conversa por algumas horas (ficam guardadas no computador). O alcance (só você ou todos) continua no .env.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_CONTEXT_TTL_HOURS', rotulo: 'Por quantas horas lembrar', grupo: 'Conversa', descricao: 'Depois desse tempo a fala é descartada. Vale na hora: diminuir apaga de vez as falas mais antigas que o novo prazo.', reinicio: false, min: 1, max: 48, padrao: '6' }),
  inteiro({ chave: 'YUI_CONTEXT_MAX_CHARS', rotulo: 'Tamanho máximo do contexto (caracteres)', grupo: 'Conversa', descricao: 'Quanto da conversa anterior vai para a IA. Mais caracteres gastam mais cota. Vale na hora: diminuir apaga de vez o que passar do novo tamanho.', reinicio: false, min: 1000, max: 30000, padrao: '6000' }),
  inteiro({ chave: 'YUI_CONTEXT_MAX_TURNS', rotulo: 'Máximo de falas no contexto', grupo: 'Conversa', descricao: 'Conta as suas e as da Yui. Número ímpar é arredondado para baixo. Vale na hora: diminuir apaga de vez as falas mais antigas.', reinicio: false, min: 2, max: 60, padrao: '20' }),
  bool({ chave: 'YUI_HISTORICO_COMPARTILHADO', confirmar: ['true'], rotulo: 'Mesmo fio no painel, no app e na DM', grupo: 'Conversa', descricao: 'O seu chat no painel e no app continua a conversa da sua DM do Discord. Só vale com o contexto por horas ligado.', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_APP_COMANDOS', confirmar: ['true'], rotulo: 'Listas, lembretes e memória pelo chat do app', grupo: 'Conversa', descricao: 'O seu chat no painel e no app entende os pedidos de lista, lembrete, resumo do dia e memória, como a sua DM.', reinicio: true, soNaSubida: true, padrao: 'false' }),
  bool({ chave: 'YUI_PLANOS', confirmar: ['true'], rotulo: 'Planos com aprovação (só leitura)', grupo: 'Conversa', descricao: 'Na sua DM, "monta um plano: ..." gera um plano de leituras que só começa quando você toca em Aprovar. Cada leitura passa pelas regras de segurança.', reinicio: true, soNaSubida: true, padrao: 'false' }),
  bool({ chave: 'YUI_PLANOS_AUTO', confirmar: ['true'], rotulo: 'Aprovar planos automaticamente', grupo: 'Conversa', descricao: 'ATENÇÃO: o plano que você pedir na DM começa sem o botão Aprovar (a pesquisa na web continua pedindo). "só o plano: ..." mantém os botões. Só vale com os planos ligados.', reinicio: true, soNaSubida: true, padrao: 'false' }),
  // Lacunas do painel, item 3 v2 (27/11/2026; decisão do dono: "ver e aprovar"): lida A CADA PEDIDO só pela API do painel (o cérebro, com os dois processos;
  // o bot nunca a lê), por isso vale na hora. Desligada, a rota de decisão responde 404 e a tela só mostra.
  bool({ chave: 'YUI_PLANOS_PAINEL', confirmar: ['true'], rotulo: 'Aprovar e recusar planos pelo painel', grupo: 'Conversa', descricao: 'Os planos que esperam a sua aprovação ganham os botões Aprovar e Recusar em Admin > Planos e avisos, com as mesmas regras dos botões da DM (o mesmo plano, a mesma versão, dentro dos 30 minutos; o primeiro a decidir vale). Desligado, o painel só mostra. Só vale com os planos ligados.', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_YOUTUBE_LIVE', confirmar: ['true'], rotulo: 'Yui na live (chat de uma live do YouTube)', grupo: 'Conversa', descricao: 'ATENÇÃO: a Yui escreve em público. Na sua DM ou no app: "entra na live <link>", "sai da live", "como está a live". Precisa da autorização do canal dela (docs/GUIA_YOUTUBE_LIVE.md).', reinicio: true, soNaSubida: true, padrao: 'false' }),
  bool({ chave: 'YUI_LIVE_AMIGOS', confirmar: ['true'], rotulo: 'Amigos autorizados na live', grupo: 'Conversa', descricao: 'ATENÇÃO: libera você a autorizar amigos (pessoa do Discord ligada ao canal dela no YouTube) pela sua DM: "autoriza amigo da live <ID> canal <UC...>". Desligado, ninguém novo é autorizado, mas listar, revogar e o "apagar meus dados da live" do amigo continuam funcionando. Etapa 1: ainda sem live dos amigos.', reinicio: false, padrao: 'false' }),
  // Lida a CADA entrada na live, só pelo serviço da live (que roda no cérebro): vale na hora, sem reiniciar (a live que já está aberta continua como entrou).
  opcao({ chave: 'YUI_YOUTUBE_LEITURA', rotulo: 'Leitura do chat da live', grupo: 'Conversa', descricao: '"fluxo" (padrão): o YouTube empurra as mensagens quase em tempo real (cerca de 1 s); se o fluxo falhar, a Yui passa sozinha para a consulta. "consulta": só a consulta de tempos em tempos (a cada 15 s ou mais), a reserva de sempre. Vale na próxima vez que ela entrar numa live.', reinicio: false, opcoes: ['fluxo', 'consulta'], padrao: 'fluxo' }),
  bool({ chave: 'YUI_CONTINUIDADE', confirmar: ['true'], rotulo: 'Registrar projetos e decisões', grupo: 'Conversa', descricao: 'Na sua DM e no app, guarda projetos e decisões quando você pede, sempre perguntando antes.', reinicio: false, padrao: 'false' }),
  inteiro({ chave: 'YUI_HISTORICO_DIAS', confirmar: ['0'], rotulo: 'Guardar o registro de uso por (dias)', grupo: 'Conversa', descricao: 'Perguntas e respostas gravadas no historico.txt são apagadas depois desse prazo. 0 desliga a limpeza (guarda sem prazo).', reinicio: false, min: 0, max: 365, padrao: '7' }),
  opcao({ chave: 'YUI_PESQUISA_POR_INTENCAO', rotulo: 'Pesquisar sozinha quando a pergunta pede', grupo: 'Conversa', descricao: '"Nunca"; "Só nos servidores"; "Nos servidores e na sua DM" (a DM ainda depende da pesquisa privada liberada no arquivo de configuração do servidor).', reinicio: false, opcoes: ['off', 'servidor', 'dono'], padrao: 'dono' }),
  bool({ chave: 'YUI_RESEARCH_ENABLED', rotulo: 'Agente de pesquisa na web', grupo: 'Conversa', descricao: 'O agente pesquisa, lê as páginas e responde citando as fontes. Desligado, volta o jeito antigo da busca (uma resposta simples sobre os resultados), sem a pré-rota e sem transformar um "vou pesquisar" em pesquisa.', reinicio: false, padrao: 'true' }),
  bool({ chave: 'YUI_MEMORY_ENABLED', confirmar: ['false'], rotulo: 'Memória por usuário', grupo: 'Conversa', descricao: 'A Yui guarda o que cada pessoa conta e usa nas respostas. ATENÇÃO: desligado, ela para de usar e de guardar lembranças (desligar não apaga nada).', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_LISTS_ENABLED', rotulo: 'Listas pessoais pela conversa', grupo: 'Conversa', descricao: '"anota na lista de compras: leite", "mostra a lista de compras". Cada pessoa só mexe nas próprias listas.', reinicio: false, padrao: 'true' }),
  bool({ chave: 'YUI_REMINDERS_ENABLED', rotulo: 'Lembretes pela conversa', grupo: 'Conversa', descricao: '"me lembra amanhã às 9h de ...", "meus lembretes". Desligado, a conversa não cria nem muda lembretes; os já marcados continuam chegando.', reinicio: false, padrao: 'true' }),
  bool({ chave: 'YUI_CLIMA', rotulo: 'Consulta de clima e previsão', grupo: 'Conversa', descricao: 'Responde perguntas de tempo e previsão consultando o Open-Meteo.', reinicio: false, padrao: 'true' }),
  // Monitores, alertas e relatório matinal
  bool({ chave: 'YUI_MONITORES', rotulo: 'Monitores de busca ("me avisa quando...")', grupo: 'Monitores', descricao: 'Só com o cérebro separado. Gasta cota de busca e avisa só você, por DM.', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_MONITORES_MS', rotulo: 'Conferir monitores a cada (milissegundos)', grupo: 'Monitores', descricao: '600000 = 10 minutos.', reinicio: true, min: 60000, max: 86400000, padrao: '600000' }),
  inteiro({ chave: 'YUI_MONITORES_RESERVA', rotulo: 'Cota de busca reservada à conversa (%)', grupo: 'Monitores', descricao: 'Parte da cota por hora que os monitores nunca usam.', reinicio: false, min: 0, max: 90, padrao: '10' }),
  bool({ chave: 'YUI_ALERTS', confirmar: ['false'], rotulo: 'Avisos de erro por DM', grupo: 'Alertas', descricao: 'Desligar faz a Yui parar de avisar você quando algo dá errado.', reinicio: false, padrao: 'true' }),
  inteiro({ chave: 'YUI_ALERTS_COOLDOWN_MINUTES', rotulo: 'Intervalo para repetir o mesmo aviso (minutos)', grupo: 'Alertas', descricao: 'Evita receber o mesmo aviso em sequência.', reinicio: true, min: 1, max: 1440, padrao: '30' }),
  bool({ chave: 'YUI_ALERTAS_EVENTOS', rotulo: 'Alertas de disco, memória e internet', grupo: 'Alertas', descricao: 'Avisa por DM quando o computador da Yui está com problema (precisa dos avisos de erro ligados).', reinicio: true, padrao: 'false' }),
  inteiro({ chave: 'YUI_ALERTAS_EVENTOS_MS', rotulo: 'Conferir o computador a cada (milissegundos)', grupo: 'Alertas', descricao: '300000 = 5 minutos.', reinicio: true, min: 60000, max: 86400000, padrao: '300000' }),
  inteiro({ chave: 'YUI_ALERTA_DISCO_GB', rotulo: 'Avisar com disco livre abaixo de (GB)', grupo: 'Alertas', descricao: '0 desliga essa verificação.', reinicio: true, min: 0, max: 10000, padrao: '5' }),
  inteiro({ chave: 'YUI_ALERTA_RAM_MB', rotulo: 'Avisar com memória livre abaixo de (MB)', grupo: 'Alertas', descricao: '0 desliga essa verificação.', reinicio: true, min: 0, max: 1000000, padrao: '400' }),
  inteiro({ chave: 'YUI_ALERTA_RAM_MIN', rotulo: 'Minutos de memória baixa antes de avisar', grupo: 'Alertas', descricao: 'Um pico curto não gera aviso.', reinicio: true, min: 0, max: 1440, padrao: '5' }),
  texto({ chave: 'YUI_ALERTA_INTERNET_ALVO', rotulo: 'Endereço para testar a internet', grupo: 'Alertas', descricao: 'host ou host:porta (porta padrão 443). Só abre a conexão, sem enviar nada. Vazio não testa.', reinicio: true, max: 259, padrao: '', formato: /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/, validar: (v) => { const porta = v.includes(':') ? Number(v.split(':')[1]) : 443; if (porta < 1 || porta > 65535) throw new Error('porta'); } }),
  opcao({ chave: 'YUI_AVISOS_FILTRO', rotulo: 'Avisos na hora certa', grupo: 'Alertas', descricao: '"Só observar" só registra no log o que seria feito. "Ligado" segura de verdade os avisos no horário silencioso e acima do teto e envia depois. "Desligado" envia tudo na hora.', reinicio: false, opcoes: ['off', 'observar', 'ligar'], padrao: 'off' }),
  texto({ chave: 'YUI_SILENCIO', rotulo: 'Horário silencioso', grupo: 'Alertas', descricao: 'Hora de início e de fim, como 23-07, no seu fuso.', reinicio: false, max: 5, padrao: '23-07', formato: /^(?:[01]?\d|2[0-3])-(?:[01]?\d|2[0-3])$/ }),
  inteiro({ chave: 'YUI_AVISOS_POR_DIA', rotulo: 'Teto de avisos por dia', grupo: 'Alertas', descricao: 'Avisos importantes e informativos.', reinicio: false, min: 0, max: 100, padrao: '8' }),
  bool({ chave: 'YUI_MORNING_REPORT', rotulo: 'Resumo do dia por DM', grupo: 'Relatório', descricao: 'Lembretes do dia, pendências e a saúde da Yui (com o Google conectado, também a agenda e as tarefas de hoje). Desligado, volta o relatório só de saúde.', reinicio: true, padrao: 'true' }),
  inteiro({ chave: 'YUI_MORNING_REPORT_HOUR', rotulo: 'Hora do resumo do dia', grupo: 'Relatório', descricao: 'No seu fuso horário.', reinicio: true, min: 0, max: 23, padrao: '8' }),
  bool({ chave: 'YUI_HEALTH_REPORT', rotulo: 'Relatório de saúde diário', grupo: 'Relatório', descricao: 'Só vale com o resumo do dia desligado: uma DM por dia com o estado da Yui (memória, disco, erros, reconexões).', reinicio: true, padrao: 'true' }),
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
  inteiro({ chave: 'YUI_DL_MAX_MINUTES', rotulo: 'Duração máxima de download (minutos)', grupo: 'Mídia', descricao: 'Não vale para o Modo Rádio nem para o Spotify.', reinicio: false, min: 1, max: 1440, padrao: '20' }),
  inteiro({ chave: 'YUI_DL_MAX_FILESIZE_MB', rotulo: 'Tamanho máximo de download (MB)', grupo: 'Mídia', descricao: 'Arquivos maiores são recusados.', reinicio: false, min: 1, max: 10240, padrao: '200' }),
  inteiro({ chave: 'YUI_DL_TIMEOUT_SECONDS', rotulo: 'Tempo máximo de um download (segundos)', grupo: 'Mídia', descricao: 'Passou disso, o download é cancelado.', reinicio: false, min: 30, max: 3600, padrao: '300' }),
  inteiro({ chave: 'YUI_DL_MAX_CONCURRENT', rotulo: 'Downloads ao mesmo tempo', grupo: 'Mídia', descricao: 'O dono nunca é barrado por esse teto.', reinicio: false, min: 1, max: 50, padrao: '3' }),
  inteiro({ chave: 'YUI_UPLOAD_LIMIT_MB', rotulo: 'Limite de anexo do Discord (MB)', grupo: 'Mídia', descricao: 'Acima do que o Discord aceita, o envio falha.', reinicio: false, min: 1, max: 100, padrao: '10' }),
  inteiro({ chave: 'YUI_IMAGE_PER_HOUR', rotulo: 'Imagens por pessoa por hora', grupo: 'Mídia', descricao: 'O dono não tem limite.', reinicio: false, min: 1, max: 100, padrao: '6' }),
  // Lacunas do painel, item 11: lida a cada pedido só pela API (a pré-rota e a ferramenta de imagem do chat, src/core/imagemDoApp.js), então vale na hora.
  bool({ chave: 'YUI_APP_IMAGEM', rotulo: 'Gerar imagem pelo Chat do app', grupo: 'Mídia', descricao: 'Pedidos como "gera uma imagem de um gato" no Chat do app viram imagem, com o mesmo filtro de conteúdo e o mesmo limite por hora do Discord. A imagem chega por um link curto que vence em minutos.', reinicio: false, padrao: 'false' }),
  bool({ chave: 'YUI_MUSICA_MANTER_CARTAO', rotulo: 'Manter o cartão da música junto do arquivo', grupo: 'Mídia', descricao: 'Ao terminar um download de música, a mensagem mantém o cartão com capa, artista e álbum junto do arquivo. Desligado, fica só o texto e o arquivo.', reinicio: false, padrao: 'true' }),
  inteiro({ chave: 'YUI_YT_LIVE_AUTO_EDIT_MIN', rotulo: 'Janela para editar o aviso de transmissão (minutos)', grupo: 'Mídia', descricao: 'Tempo em que o aviso ainda é atualizado sozinho.', reinicio: false, min: 5, max: 1440, padrao: '120' }),
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

// `versoes`: um número por ajuste que só cresce (correção C5 do parecer da Liz, docs/PLANO_LACUNAS_PAINEL_CORRECOES.md). Cada gravação e cada remoção
// sobem o número; a remoção NÃO zera (o número continua no arquivo). Quem edita manda a versão que viu; se outro (o painel web ou o Discord) gravou
// no meio, a gravação é recusada com 409 e nada é sobrescrito sem ninguém ver.
const vazio = () => ({ version: 1, valores: {}, alteradoEm: {}, versoes: {} });

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
  return JSON.stringify({ valores: estado.valores, alteradoEm: estado.alteradoEm, versoes: estado.versoes }, null, 2);
}
function serializar(estado, env = process.env) {
  if (!protecaoLigada(env)) return JSON.stringify({ version: 1, valores: estado.valores, alteradoEm: estado.alteradoEm, versoes: estado.versoes }, null, 2);
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
  const versoes = {};
  for (const [k, n] of Object.entries(raw?.versoes ?? {})) {
    if (POR_CHAVE.has(k) && Number.isSafeInteger(n) && n > 0) versoes[k] = n;
  }
  return { version: 1, valores, alteradoEm, versoes };
}

/** A frase do 409 (a mesma no painel web e no Discord). */
export const TEXTO_VERSAO_MUDOU = 'Esse ajuste mudou enquanto você editava (no painel web ou no Discord). Confira o valor atual e salve de novo';

/** A versão atual de um ajuste (0 = nunca gravado pelo painel nem pelo Discord). */
const versaoDe = (estado, chave) => estado.versoes?.[chave] ?? 0;

/**
 * Confere a versão que a tela viu. Sem versão (`undefined`/`null`): não confere (pedidos antigos e scripts). Com versão: precisa ser a atual,
 * senão 409. A conferência e a gravação acontecem juntas, no mesmo passo síncrono (ler, conferir e gravar sem nada no meio).
 */
function conferirVersao(estado, chave, versao) {
  if (versao === undefined || versao === null) return;
  const n = typeof versao === 'string' && /^\d{1,15}$/.test(versao) ? Number(versao) : versao;
  if (!Number.isSafeInteger(n) || n < 0) throw new PainelConfigError(400, 'Versão do ajuste inválida.');
  if (n !== versaoDe(estado, chave)) throw new PainelConfigError(409, TEXTO_VERSAO_MUDOU);
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
    case 'decimal': {
      const casas = Number.isInteger(item.casas) && item.casas > 0 ? item.casas : 2;
      const t = s.trim().replace(',', '.');
      if (!new RegExp(`^-?\\d{1,6}(?:\\.\\d{1,${casas}})?$`).test(t)) throw new PainelConfigError(400, `${item.rotulo}: use um número com até ${casas} casas depois da vírgula.`);
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

/** Para cada ambiente, o conteúdo do arquivo do cofre já aplicado (evita abrir de novo, com a DPAPI, um cofre que não mudou). */
const aplicado = new WeakMap();
/** A última abertura que falhou, por ambiente: { texto, em }. Evita repetir o PowerShell a cada aviso ou reconexão. */
const falhou = new WeakMap();
export const ESPERA_FALHA_MS = 5 * 60_000;
/** O texto cru do arquivo ('' = não existe; null = não deu para ler). Não decifra nada. */
function textoDoCofre() {
  try { return fs.readFileSync(arquivo(), 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? '' : null; }
}

function aplicarValores(env, valores, itens) {
  const mudaram = [];
  for (const { chave } of itens) {
    const antes = env[chave];
    if (Object.hasOwn(valores, chave)) {
      if (!originais.has(chave)) originais.set(chave, env[chave]);
      env[chave] = valores[chave];
    } else if (originais.has(chave)) {
      const o = originais.get(chave);
      if (o === undefined) delete env[chave]; else env[chave] = o;
      originais.delete(chave);
    }
    if (env[chave] !== antes) mudaram.push(chave);
  }
  return mudaram;
}

/**
 * Coloca os valores do painel em process.env (o do painel vence o do .env); o que saiu do painel volta ao valor original. Idempotente; nunca lança.
 * `emExecucao`: a mudança veio com o processo já rodando; os itens `soNaSubida` ficam como estão até reiniciar.
 */
export function aplicarPainelConfig(env = process.env, { emExecucao = false } = {}) {
  try {
    const texto = textoDoCofre();
    const { estado, situacao } = lerCofre();
    if (situacao === 'ilegivel') return 0; // não aplica nada de um cofre que não abriu (e não derruba a subida)
    const { valores } = estado;
    aplicarValores(env, valores, emExecucao ? CATALOGO.filter((c) => !c.soNaSubida) : CATALOGO);
    if (texto !== null) aplicado.set(env, texto);
    return Object.keys(valores).length;
  } catch {
    return 0;
  }
}

/**
 * Para o processo que NÃO grava o cofre (o bot): relê e atualiza só as chaves `reinicio: false`; as que pedem reinício não mudam.
 * Arquivo igual ao já aplicado não é aberto de novo. Devolve os NOMES que mudaram, ou `null` se não conseguiu ler o cofre (não mexe em nada); nunca lança.
 */
export function recarregarAoVivo(env = process.env, { agora = Date.now } = {}) {
  try {
    const texto = textoDoCofre();
    if (texto === null) return null;
    if (aplicado.get(env) === texto) return [];
    const antes = falhou.get(env);
    if (antes?.texto === texto && agora() - antes.em < ESPERA_FALHA_MS) return null;
    const { estado, situacao } = lerCofre();
    if (situacao === 'ilegivel') { falhou.set(env, { texto, em: agora() }); return null; }
    falhou.delete(env);
    const mudaram = aplicarValores(env, estado.valores, CATALOGO.filter((c) => !c.reinicio));
    aplicado.set(env, texto);
    return mudaram;
  } catch {
    return null;
  }
}

/** Precisa de `confirm: true`? `valor` ausente = remoção do item. */
export function exigeConfirmacao(chave, valor) {
  const lista = POR_CHAVE.get(String(chave))?.confirmar;
  if (!lista) return false;
  return valor === undefined || lista.includes(String(valor).trim().toLowerCase());
}

/** Grava um ajuste. `versao`: a que a tela viu (C5); diferente da atual = 409. Devolve a versão nova. */
export function definir(chave, valor, env = process.env, { versao } = {}) {
  const item = POR_CHAVE.get(String(chave));
  if (!item) throw new PainelConfigError(404, 'Esse ajuste não existe no painel.');
  if (!edicaoLigada(env)) throw new PainelConfigError(403, 'A edição de configuração pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env).');
  const v = validarValor(item, valor);
  const estado = estadoParaAlterar();
  conferirVersao(estado, item.chave, versao);
  estado.valores[item.chave] = v;
  estado.alteradoEm[item.chave] = new Date().toISOString();
  estado.versoes[item.chave] = versaoDe(estado, item.chave) + 1;
  gravar(estado, env);
  aplicarPainelConfig(env, { emExecucao: true });
  return { chave: item.chave, reinicio: item.reinicio, versao: estado.versoes[item.chave] };
}

/** Tira um ajuste do cofre (volta ao .env ou ao padrão). `versao` como em definir; a versão sobe também aqui (nunca volta a 0). */
export function remover(chave, env = process.env, { versao } = {}) {
  const item = POR_CHAVE.get(String(chave));
  if (!item) throw new PainelConfigError(404, 'Esse ajuste não existe no painel.');
  if (!edicaoLigada(env)) throw new PainelConfigError(403, 'A edição de configuração pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env).');
  const estado = estadoParaAlterar();
  conferirVersao(estado, item.chave, versao);
  if (!Object.hasOwn(estado.valores, item.chave)) throw new PainelConfigError(404, 'Esse ajuste não está salvo no painel.');
  delete estado.valores[item.chave];
  delete estado.alteradoEm[item.chave];
  estado.versoes[item.chave] = versaoDe(estado, item.chave) + 1;
  gravar(estado, env);
  aplicarPainelConfig(env, { emExecucao: true });
  return { chave: item.chave, reinicio: item.reinicio, versao: estado.versoes[item.chave] };
}

/** O estado para a tela: NUNCA devolve um segredo (só "definido" e os 4 últimos caracteres do que veio do painel). */
export function descrever(env = process.env) {
  const { estado, situacao } = lerCofre();
  const { valores, alteradoEm, versoes } = estado;
  return {
    edicaoLigada: edicaoLigada(env),
    protegido: protecaoLigada(env),
    ...(situacao === 'ilegivel' ? { problema: 'cofre-ilegivel' } : {}),
    itens: CATALOGO.map((c) => {
      const doPainel = Object.hasOwn(valores, c.chave);
      // `soNaSubida` não muda em execução: a tela mostra o que foi salvo (ou o original, se saiu do painel), que é o que vale após reiniciar.
      const efetivo = !c.soNaSubida ? env[c.chave] : doPainel ? valores[c.chave] : originais.has(c.chave) ? originais.get(c.chave) : env[c.chave];
      const definido = doPainel || (efetivo !== undefined && String(efetivo).trim() !== '');
      const origem = doPainel ? 'painel' : definido ? 'env' : 'padrao';
      const base = {
        chave: c.chave, rotulo: c.rotulo, grupo: c.grupo, descricao: c.descricao, tipo: c.tipo, reinicio: c.reinicio, definido, origem, alteradoEm: doPainel ? (alteradoEm[c.chave] ?? null) : null,
        versao: versoes[c.chave] ?? 0,
        ...(c.opcoes ? { opcoes: [...c.opcoes] } : {}), ...(c.confirmar ? { confirmar: [...c.confirmar] } : {}), ...(c.min !== undefined ? { min: c.min, max: c.max } : {}), ...(c.padrao !== undefined ? { padrao: c.padrao } : {}),
      };
      if (c.secreto) return { ...base, secreto: true, ultimos4: doPainel ? valores[c.chave].slice(-4) : null };
      return { ...base, valor: definido ? String(efetivo ?? valores[c.chave] ?? '') : null };
    }),
  };
}

// A tela do Discord (lacunas do painel, item 6) abre o cofre só quando o arquivo mudou: com a DPAPI cada abertura é uma chamada ao PowerShell.
let cacheDaTela = { texto: undefined, valores: {}, versoes: {}, situacao: 'ausente' };
function valoresParaTela() {
  const texto = textoDoCofre();
  if (texto !== null && texto === cacheDaTela.texto) return cacheDaTela;
  const { estado, situacao } = lerCofre();
  cacheDaTela = { texto, valores: estado.valores, versoes: estado.versoes, situacao };
  return cacheDaTela;
}

/**
 * UM ajuste como a tela do painel web mostra (lacunas do painel, item 6: o painel do Discord mostra o MESMO valor): o salvo no cofre; sem ele, o do .env
 * (o original, de antes de o painel mexer); sem os dois, o padrão. Lê o cofre do ARQUIVO porque, no bot separado, os itens que pedem reinício não mudam o
 * ambiente dele em execução. NUNCA devolve um segredo (só se está definido). Item fora do catálogo = null. Nunca lança.
 */
export function descreverItem(chave, env = process.env) {
  const c = POR_CHAVE.get(String(chave));
  if (!c) return null;
  try {
    const { valores, versoes, situacao } = valoresParaTela();
    const doPainel = Object.hasOwn(valores, c.chave);
    const original = originais.has(c.chave) ? originais.get(c.chave) : env[c.chave];
    const doEnv = original !== undefined && String(original).trim() !== '';
    const origem = doPainel ? 'painel' : doEnv ? 'env' : 'padrao';
    const valor = doPainel ? valores[c.chave] : doEnv ? String(original) : (c.padrao ?? '');
    return {
      chave: c.chave, rotulo: c.rotulo, tipo: c.tipo, reinicio: c.reinicio, origem, edicaoLigada: edicaoLigada(env), versao: versoes?.[c.chave] ?? 0,
      valor: c.secreto ? null : valor, ...(c.secreto ? { definido: doPainel || doEnv } : {}), ...(situacao === 'ilegivel' ? { problema: 'cofre-ilegivel' } : {}),
    };
  } catch {
    return { chave: c.chave, rotulo: c.rotulo, tipo: c.tipo, reinicio: c.reinicio, origem: 'padrao', edicaoLigada: false, valor: c.secreto ? null : (c.padrao ?? ''), problema: 'cofre-ilegivel' };
  }
}

/** Só para teste: esquece o que o módulo lembra do ambiente. */
export function esquecerParaTeste() { originais.clear(); cacheDaTela = { texto: undefined, valores: {}, versoes: {}, situacao: 'ausente' }; }
