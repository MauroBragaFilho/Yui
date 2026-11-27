import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import config from '../config.js';
import { CATALOGO, descreverItem, exigeConfirmacao, PainelConfigError } from '../core/painelConfig.js';
import { VARIAVEIS_DA_CADEIA } from '../core/ai/ajustesIa.js';
import { gravarPeloDiscord } from '../discord/cofreRemoto.js';
import { clampOptions, clampText } from '../discord/embedLimits.js';

// O PAINEL DE CONFIGURAÇÃO DO DISCORD (/yui-criador bot_config e /yui-config_ia). Lacunas do painel, item 6 (26/11/2026; decisão do dono: "gravar no
// mesmo cofre"): as páginas gravam no COFRE do painel (src/core/painelConfig.js, o mesmo da aba "Configuração e chaves" do painel web), pelo cérebro quando ele
// é separado (src/discord/cofreRemoto.js). Os dois painéis mostram o mesmo valor e nada se perde no reinício. O src/config/config.json não é mais gravado.
// Três tipos de página:
//  - 'cofre': grava no cofre, com a validação dele (faixa, opções, formato), a confirmação dos valores sensíveis e a auditoria; mostra o valor relido do cofre;
//  - 'memoria' (prefixo, nome e prompt do sistema): como antes, só na memória do bot até reiniciar. Ficam FORA do cofre até o desenho da Liz (mexem na persona e
//    no reconhecimento de comandos);
//  - 'env' (os endereços dos provedores): só leitura. Ficam fora do painel de propósito: o endereço decide para onde vão a chave e a conversa.
const CONFIG_PAGES = [
    {
        key: 'showModel',
        label: 'Exibir Nome do Modelo',
        category: '🤖 IA — Exibição',
        icon: '🏷️',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_IA_MOSTRAR_MODELO',
        summary: 'Mostra ou esconde qual modelo respondeu.',
        description: 'Controla se o nome do modelo de IA (ex: gemini-2.5-flash-lite, Qwen2.5-72B) aparece no rodapé das respostas da Yui. Útil para debug ou curiosidade, mas pode poluir visualmente se ativado em produção.',
    },
    {
        key: 'showModelThinking',
        label: 'Exibir Modelo no Pensamento',
        category: '🤖 IA — Exibição',
        icon: '💭',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_IA_MOSTRAR_MODELO_PENSANDO',
        summary: 'Mostra o modelo durante o processamento.',
        description: 'Quando ativado, exibe qual modelo está processando o pedido na mensagem de "pensando..." antes da resposta final. Ajuda a identificar qual provider está sendo usado em tempo real durante o fallback automático.',
    },
    {
        key: 'errorRetries',
        label: 'Tentativas em Caso de Erro',
        category: '🤖 IA — Resiliência',
        icon: '🔄',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_RETENTATIVAS',
        summary: 'Quantas vezes re-tenta se der erro.',
        description: 'Define quantas vezes a Yui re-tenta gerar uma resposta quando ocorre erro de parsing, vazamento de ferramenta, ou resposta inválida do modelo. Valor 0 = sem retentativa, a primeira resposta (mesmo com erro) é final. Valores altos podem causar lentidão.',
        step: 1,
    },
    {
        key: 'local.temperature',
        label: 'Temperatura — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '🌡️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_LMSTUDIO_TEMPERATURA',
        summary: 'Criatividade do modelo local.',
        description: 'Controla a aleatoriedade das respostas do LM Studio/Ollama. Valores baixos (0.1-0.3) = respostas previsíveis e factuais. Valores altos (0.8-1.5) = respostas mais criativas e variadas. Acima de 1.0 pode gerar respostas incoerentes.',
        step: 0.1,
    },
    {
        key: 'local.timeout',
        label: 'Timeout — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '⏱️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_LMSTUDIO_TIMEOUT_MS',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo máximo em milissegundos que a Yui espera pela resposta do LM Studio antes de considerar timeout e tentar o próximo provider. Modelos grandes locais podem precisar de 60000ms+. Valor muito baixo causa falsos timeouts.',
        step: 5000,
    },
    {
        key: 'local.max_tokens',
        label: 'Max Tokens — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '📏',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_LMSTUDIO_MAX_TOKENS',
        summary: 'Limite de tokens na resposta.',
        description: 'Número máximo de tokens que o modelo local pode gerar em uma resposta. Tokens ≈ palavras (1 token ≈ 0.75 palavras em português). Valores baixos = respostas curtas e rápidas. Valores altos = respostas longas mas mais lentas e custosas em VRAM.',
        step: 128,
    },
    {
        key: 'gemini.temperature',
        label: 'Temperatura — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '🌡️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_GEMINI_TEMPERATURA',
        summary: 'Criatividade do Gemini.',
        description: 'Controla a aleatoriedade do Google Gemini. Valores baixos geram respostas seguras e previsíveis. Valores altos tornam o Gemini mais criativo mas potencialmente menos preciso. O Gemini tende a ser conservador, então 0.7-0.9 é um bom range.',
        step: 0.1,
    },
    {
        key: 'gemini.timeout',
        label: 'Timeout — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '⏱️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_GEMINI_TIMEOUT_MS',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela API do Gemini em milissegundos. O Gemini é geralmente rápido (5-15s), mas pode demorar mais em horários de pico. 60000ms (1 min) é um valor seguro. Aumente se estiver tendo muitos timeouts sem motivo.',
        step: 5000,
    },
    {
        key: 'gemini.max_tokens',
        label: 'Max Tokens — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '📏',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_GEMINI_MAX_TOKENS',
        summary: 'Limite de tokens na resposta do Gemini.',
        description: 'Limite máximo de tokens gerados pelo Gemini. O Gemini 2.5 Flash suporta até 8192 tokens de saída. Para respostas curtas e conversacionais, 1024-2048 é suficiente. Para análises longas ou code review, aumente para 4096+.',
        step: 128,
    },
    {
        key: 'pollinations.timeout',
        label: 'Timeout — Pollinations',
        category: '🌡️ Provider: Pollinations',
        icon: '⏱️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_POLLINATIONS_TIMEOUT_MS',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela API do Pollinations. Por ser um serviço gratuito, pode ter latência alta. 60000ms é o mínimo recomendado. Se estiver com muitos timeouts, aumente para 90000-120000ms.',
        step: 5000,
    },
    {
        key: 'pollinations.max_tokens',
        label: 'Max Tokens — Pollinations',
        category: '🌡️ Provider: Pollinations',
        icon: '📏',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_POLLINATIONS_MAX_TOKENS',
        summary: 'Limite de tokens do Pollinations.',
        description: 'Limite de tokens gerados pelo Pollinations quando a conversa passa pelo cérebro separado. Como é um provider de fallback gratuito, mantenha valores moderados (512-1024) para evitar respostas truncadas pelo serviço.',
        step: 128,
    },
    {
        key: 'hf.temperature',
        label: 'Temperatura — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '🌡️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HF_TEMPERATURA',
        summary: 'Criatividade do HuggingFace.',
        description: 'Controla a aleatoriedade do modelo rodando no HuggingFace Inference API (atualmente Qwen2.5-72B). Valores baixos para tarefas técnicas, valores altos para conversas casuais.',
        step: 0.1,
    },
    {
        key: 'hf.timeout',
        label: 'Timeout — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '⏱️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HF_TIMEOUT_MS',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela Inference API do HuggingFace. O Qwen2.5-72B pode demorar 20-40s dependendo da carga dos servidores. 60000ms é o mínimo seguro. Modelos grandes podem precisar de 90000ms+.',
        step: 5000,
    },
    {
        key: 'hf.max_tokens',
        label: 'Max Tokens — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '📏',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HF_MAX_TOKENS',
        summary: 'Limite de tokens do HuggingFace.',
        description: 'Limite de tokens gerados pelo HuggingFace. O tier gratuito pode ter limites implícitos menores. 512 é conservador mas seguro. Aumente para 1024+ se tiver conta PRO.',
        step: 128,
    },
    {
        key: 'horde.temperature',
        label: 'Temperatura — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '🌡️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HORDE_TEMPERATURA',
        summary: 'Criatividade do Horde.',
        description: 'Aleatoriedade dos modelos distribuídos do Stable Horde. O Horde roda modelos variados em GPUs voluntárias, então a qualidade já é inconsistente — valores moderados (0.5-0.7) ajudam a estabilizar.',
        step: 0.1,
    },
    {
        key: 'horde.timeout',
        label: 'Timeout — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '⏱️',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HORDE_TIMEOUT_MS',
        summary: 'Tempo máximo de espera (ms).',
        description: 'O Horde é assíncrono — o bot faz a requisição e depois polla o resultado. Este timeout cobre toda a operação (envio + espera + polling). O Horde pode levar 30-120s dependendo da fila. 60000ms é o mínimo, 120000ms é recomendado.',
        step: 10000,
    },
    {
        key: 'horde.max_tokens',
        label: 'Max Tokens — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '📏',
        type: 'number',
        persistence: 'cofre',
        chave: 'YUI_IA_HORDE_MAX_TOKENS',
        summary: 'Limite de tokens do Horde.',
        description: 'Limite de tokens gerados pelo AI Horde. O Horde tem limites implícitos por worker (geralmente 256-512 tokens). Definir acima de 512 pode não ter efeito prático dependendo do worker que pegar a requisição.',
        step: 64,
    },
    {
        key: 'prefix',
        label: 'Prefixo de Comandos',
        category: '⚙️ Geral',
        icon: '✏️',
        type: 'string',
        persistence: 'memoria',
        configKey: 'prefix',
        envVar: 'COMMAND_PREFIX',
        summary: 'Prefixo para comandos de texto.',
        description: 'O caractere ou texto que precede comandos de texto (não-slash) do bot. Padrão: "_". Se definido como "@Yui", o bot responde quando mencionado pelo nome. Não afeta comandos slash (/).',
    },
    {
        key: 'botName',
        label: 'Nome do Bot',
        category: '⚙️ Geral',
        icon: '📛',
        type: 'string',
        persistence: 'memoria',
        configKey: 'botName',
        envVar: 'AI_BOT_NAME',
        summary: 'Nome usado na persona da IA.',
        description: 'O nome que a IA usa para se referir a si mesma nas respostas e no system prompt. Alterar aqui muda como ela se identifica. Não altera o username do bot no Discord (isso é feito no Developer Portal).',
    },
    {
        key: 'appealChannelId',
        label: 'Canal de Apelações',
        category: '⚙️ Geral',
        icon: '📬',
        type: 'string',
        persistence: 'cofre',
        chave: 'YUI_CANAL_APELACOES',
        summary: 'ID do canal para formulários de appeal.',
        description: 'ID do canal do Discord onde os formulários de apelação de banimento (appeals) são enviados. Quando um usuário banido solicita revisão, o formulário vai para este canal. Deve ser um canal de texto acessível pelo bot.',
    },
    {
        key: 'requireTos',
        label: 'Exigir Termos de Uso',
        category: '🛡️ Moderação',
        icon: '📜',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'REQUIRE_TOS',
        summary: 'Bloqueia servers que não aceitaram o TOS.',
        description: 'Quando ativado, servidores que não executaram /aceitar_tos ficam completamente bloqueados de usar qualquer comando da Yui. Desativar permite que todos os servidores usem o bot imediatamente sem aceitar termos.',
    },
    {
        key: 'saveHistory',
        label: 'Salvar Histórico de Prompts',
        category: '🛡️ Moderação',
        icon: '💾',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_SALVAR_HISTORICO',
        summary: 'Registra prompts e respostas em arquivo.',
        description: 'Salva todos os prompts dos usuários e respostas da IA em "src/data/historico.txt" para auditoria e debug. O arquivo cresce continuamente — considere limpar periodicamente. Desativar melhora privacidade mas perde rastreabilidade.',
    },
    {
        key: 'keepMusicEmbed',
        label: 'Manter Embed ao Baixar Música',
        category: '🎵 Mídia & Áudio',
        icon: '🖼️',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_MUSICA_MANTER_CARTAO',
        summary: 'Mantém o embed de identificação da música junto com o arquivo de áudio.',
        description: 'Quando ativado (true), ao concluir o download de música (Spotify/YT Music/Metrolist ou Deezer), a mensagem mantém o embed visual de identificação (foto da capa, artista, álbum) junto com o arquivo .mp3 anexado na mesma mensagem. Quando desativado (false), a mensagem é editada apenas com o texto simples e arquivo.',
    },
    {
        key: 'defaultAutoMod',
        label: 'AutoMod Padrão em Novos Servers',
        category: '🛡️ Moderação',
        icon: '🛡️',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_AUTOMOD_PADRAO',
        summary: 'AutoMod ativo por padrão em novos servers.',
        description: 'Define se o sistema de moderação automática (AutoMod) é ativado automaticamente quando o bot entra em um novo servidor (e nos servidores onde ele nunca foi ajustado). Se desativado, cada servidor precisará ativar manualmente via /adm_automod.',
    },
    {
        key: 'automodMode',
        label: 'Modo do AutoMod Global',
        category: '🛡️ Moderação',
        icon: '⚡',
        type: 'select',
        persistence: 'cofre',
        chave: 'YUI_AUTOMOD_MODO_PADRAO',
        options: [
            { label: '🔴 Desativado', value: 'off' },
            { label: '🧠 Somente IA (MCP)', value: 'mcp' },
            { label: '🛡️ Somente Gatilhos', value: 'trigger' },
            { label: '⚡ Ambos (MCP + Gatilhos)', value: 'both' },
        ],
        summary: 'Modo padrão de moderação automática.',
        description: 'Define o modo padrão do AutoMod para novos servidores (e para os que nunca foram ajustados). "off" = desativado. "mcp" = bloqueia apenas chamadas de ferramentas perigosas. "trigger" = bloqueia mensagens com palavras proibidas. "both" = ativa ambos os modos simultaneamente.',
    },
    {
        key: 'sendEnvironmentInfo',
        label: 'Enviar Info de Contexto',
        category: '🛡️ Moderação',
        icon: '📍',
        type: 'boolean',
        persistence: 'cofre',
        chave: 'YUI_IA_CONTEXTO_DO_SERVIDOR',
        summary: 'Inclui info do server/canal no prompt.',
        description: 'Quando ativado, envia informações do servidor e canal (nome do server, nome do canal, etc.) como contexto adicional no prompt da IA. Isso permite que a Yui saiba "onde está" e adapte respostas. Desativar economiza tokens.',
    },
    {
        key: 'geminiModel',
        label: 'Modelo Gemini Principal',
        category: '🔗 Endpoints & Modelos',
        icon: '🧠',
        type: 'string',
        persistence: 'cofre',
        chave: 'GEMINI_MODEL',
        summary: 'Modelo primário do Google Gemini.',
        description: 'Nome do modelo Gemini usado como provider principal. Ex: "gemini-flash-lite-latest" (rápido e barato), "gemini-flash-latest" (equilibrado). Consulte a documentação do Google para modelos disponíveis.',
    },
    {
        key: 'geminiModelFallback',
        label: 'Modelo Gemini Fallback',
        category: '🔗 Endpoints & Modelos',
        icon: '🔄',
        type: 'string',
        persistence: 'cofre',
        chave: 'GEMINI_MODEL_FALLBACK',
        summary: 'Modelo secundário se o principal falhar.',
        description: 'Modelo usado quando todas as chaves de API falham no modelo principal. Funciona como segunda chance antes de cair para Pollinations/HF. Use um modelo diferente do principal para diversificar.',
    },
    {
        key: 'hfModel',
        label: 'Modelo HuggingFace',
        category: '🔗 Endpoints & Modelos',
        icon: '🤗',
        type: 'string',
        persistence: 'cofre',
        chave: 'HF_MODEL',
        summary: 'Modelo na Inference API do HF.',
        description: 'Nome completo do modelo no HuggingFace (formato: "Organização/NomeModelo"). Ex: "Qwen/Qwen2.5-72B-Instruct". Deve ser um modelo com endpoint de inferência ativo no HF. Modelos gated precisam de token com acesso.',
    },
    {
        key: 'localLlmModel',
        label: 'Modelo Local (LM Studio)',
        category: '🔗 Endpoints & Modelos',
        icon: '🖥️',
        type: 'string',
        persistence: 'cofre',
        chave: 'LOCAL_LLM_MODEL',
        summary: 'Nome do modelo carregado localmente.',
        description: 'Identificador do modelo rodando no LM Studio ou Ollama. Usado no campo "model" da requisição. Se o LM Studio está configurado para aceitar qualquer modelo, pode deixar "local-model". Caso contrário, use o nome exato.',
    },
    {
        key: 'localLlmUrl',
        label: 'URL do LLM Local',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'env',
        configKey: 'localLlmUrl',
        envVar: 'LOCAL_LLM_URL',
        summary: 'Endpoint do servidor LLM local.',
        description: 'URL completa do endpoint de chat completions do LM Studio ou Ollama. Formato: "http://IP:PORTA/v1/chat/completions". Use localhost para mesma máquina ou IP da rede para acesso remoto (ex: Tailscale).',
    },
    {
        key: 'geminiUrl',
        label: 'URL da API Gemini',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'env',
        configKey: 'geminiUrl',
        envVar: 'GEMINI_URL',
        summary: 'Endpoint da API do Google Gemini.',
        description: 'URL do endpoint de chat completions do Gemini. Padrão: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".',
    },
    {
        key: 'hfApiUrl',
        label: 'URL da API HuggingFace',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'env',
        configKey: 'hfApiUrl',
        envVar: 'HF_API_URL',
        summary: 'Endpoint da Inference API do HF.',
        description: 'URL da API de inferência do HuggingFace. Pode usar o router ("https://router.huggingface.co/v1/chat/completions") ou endpoint direto do modelo.',
    },
    {
        key: 'groqModel',
        label: 'Modelo GROQ',
        category: '🔗 Endpoints & Modelos',
        icon: '⚡',
        type: 'string',
        persistence: 'cofre',
        chave: 'GROQ_MODEL',
        summary: 'Modelo no GROQ (LPU Inference).',
        description: 'Identificador do modelo no GROQ. Ex: "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b". O GROQ é extremamente rápido por usar hardware LPU próprio.',
    },
    {
        key: 'groqApiUrl',
        label: 'URL da API GROQ',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'env',
        configKey: 'groqApiUrl',
        envVar: 'GROQ_API_URL',
        summary: 'Endpoint da API do GROQ.',
        description: 'URL do endpoint de chat completions do GROQ. Padrão: "https://api.groq.com/openai/v1/chat/completions".',
    },
    {
        key: 'hordeUrl',
        label: 'URL da API Horde',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'env',
        configKey: 'hordeUrl',
        envVar: 'HORDE_URL',
        summary: 'Endpoint da API do Stable Horde.',
        description: 'URL da API do Stable Horde para geração de texto. Padrão: "https://stablehorde.net/api/v2/generate/text/async".',
    },
    {
        key: 'systemPrompt',
        label: 'System Prompt Global',
        category: '🧬 Personalidade',
        icon: '🧬',
        type: 'string',
        persistence: 'memoria',
        configKey: 'systemPrompt',
        envVar: 'AI_SYSTEM_PROMPT',
        summary: 'Prompt base da personalidade da Yui.',
        description: 'O system prompt que define as regras, personalidade, estilo de fala e restrições da Yui globalmente. CUIDADO: alterar incorretamente pode quebrar a persona e o formato de resposta.',
    },
];

const ITEM_DO_COFRE = new Map(CATALOGO.map((c) => [c.chave, c]));
const itemDe = (page) => (page.persistence === 'cofre' ? ITEM_DO_COFRE.get(page.chave) ?? null : null);
/** Faixa de uma página numérica: a do catálogo do cofre (uma fonte só). */
const limitesDe = (page) => { const c = itemDe(page); return c && c.min !== undefined ? { min: c.min, max: c.max } : { min: undefined, max: undefined }; };

const PERSISTENCIA_MEMORIA = '⏳ Só na memória do bot: vale na hora e, ao reiniciar, volta ao valor do .env ou ao padrão. Fica fora do cofre do painel até o desenho da Liz (mexe na persona e no reconhecimento de comandos).';

/** O texto de "onde fica" de cada página: verdadeiro sobre o que sobrevive ao reinício. */
function textoDaPersistencia(page, d) {
    if (page.persistence === 'memoria') return PERSISTENCIA_MEMORIA;
    if (page.persistence === 'env') return `📄 Só no .env (\`${page.envVar}\`): fica fora do painel de propósito, porque o endereço decide para onde vão a chave e a conversa. Para mudar, edite o .env e reinicie a Yui.`;
    const onde = d?.origem === 'painel' ? 'Salvo no cofre: sobrevive ao reinício.' : d?.origem === 'env' ? `Ainda não ajustado no painel: vale o .env (\`${page.chave}\`).` : 'Ainda não ajustado no painel: vale o padrão.';
    const quando = d?.reinicio ? 'Mudança vale depois de reiniciar a Yui.' : 'Mudança vale na hora.';
    return `🔐 Cofre do painel (o mesmo do painel web, em Configuração e chaves). ${onde} ${quando}`;
}

// Só as páginas que ainda mudam a memória do bot têm o aviso do .env: nas do cofre o valor salvo vence o .env (e o .env nunca é reescrito).
function getActiveEnvWarning(page) {
    if (page.persistence !== 'memoria' || !page.envVar) return null;
    if (process.env[page.envVar] !== undefined && process.env[page.envVar] !== '') {
        return `⚠️ A variável de ambiente \`${page.envVar}\` está ativa no .env. O valor alterado aqui vale **só até reiniciar** a Yui: ao reiniciar, o .env tem prioridade e o valor volta a ser o dele.`;
    }
    return null;
}

/** O valor de uma página do cofre, como o painel web mostra (descreverItem), já no tipo da página. */
function valorDoCofre(page, d) {
    const v = d?.valor;
    if (v === null || v === undefined) return null;
    if (page.type === 'boolean') return v === 'true' ? true : v === 'false' ? false : null;
    if (page.type === 'number') { if (String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
    return String(v);
}

function getCurrentValue(page, d = page.persistence === 'cofre' ? descreverItem(page.chave) : null) {
    if (page.persistence === 'cofre') return valorDoCofre(page, d);
    if (page.configKey) return config[page.configKey];
    return undefined;
}

function formatValue(value, page) {
    if (value === undefined || value === null) return '`N/A`';
    if (page.type === 'boolean') return value ? '✅ **Ativado**' : '❌ **Desativado**';
    if (page.type === 'select') {
        const opt = page.options?.find(o => o.value === value);
        return opt ? `${opt.label}` : `\`${value}\``;
    }
    if (page.type === 'number') {
        if (page.key.includes('timeout')) {
            const seconds = (value / 1000).toFixed(1);
            return `\`${value}\` ms (${seconds}s)`;
        }
        return `\`${value}\``;
    }
    if (value === '') return '`(vazio)`';
    if (typeof value === 'string' && value.length > 200) {
        return `\`\`\`\n${value.substring(0, 200)}...\n\`\`\`\n*[${value.length} caracteres — clique em Editar para ver completo]*`;
    }
    return `\`${value}\``;
}

function buildHomePage() {
    const categories = {};
    for (const page of CONFIG_PAGES) {
        if (!categories[page.category]) categories[page.category] = 0;
        categories[page.category]++;
    }

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('⚙️ Central de Configuração — Yui')
        .setDescription('Painel administrativo das configurações do bot.\nUse as **setas** para navegar ou **Ir Para** para pular direto a uma config.\n\n🔐 Quase tudo aqui grava no **cofre do painel**: o mesmo da aba "Configuração e chaves" do painel web. Os dois mostram o mesmo valor e nada se perde no reinício.\n\n**Categorias disponíveis:**')
        .setFooter({ text: `Página 0/${CONFIG_PAGES.length} • Home • Yui Config • by oBraga` })
        .setTimestamp();

    for (const [cat, count] of Object.entries(categories)) {
        embed.addFields({ name: cat, value: `${count} configuração(ões)`, inline: true });
    }

    embed.addFields({ name: '​', value: `**Total:** ${CONFIG_PAGES.length} configurações disponíveis para ajuste.` });

    return embed;
}

/** `aviso`: { ok, texto } do que acabou de acontecer (gravado, recusado, cérebro fora...). */
function buildConfigEmbed(pageIndex, aviso = null) {
    if (pageIndex <= 0) return buildHomePage();

    const idx = pageIndex - 1;
    if (idx >= CONFIG_PAGES.length) return buildHomePage();

    const page = CONFIG_PAGES[idx];
    const d = page.persistence === 'cofre' ? descreverItem(page.chave) : null;
    const currentValue = getCurrentValue(page, d);
    const envWarning = getActiveEnvWarning(page);

    const embed = new EmbedBuilder()
        .setColor(page.persistence === 'memoria' ? 0x3B82F6 : page.persistence === 'env' ? 0x6B7280 : 0x10B981)
        .setTitle(`${page.icon} ${page.label}`)
        .setDescription(`${page.description}`)
        .addFields(
            { name: '📋 Resumo', value: page.summary, inline: false },
            { name: '📊 Valor Atual', value: clampText(formatValue(currentValue, page), 1000), inline: true },
            { name: '📂 Categoria', value: page.category, inline: true },
            { name: '💽 Persistência', value: clampText(textoDaPersistencia(page, d), 1000), inline: false }
        )
        .setFooter({ text: `Página ${pageIndex}/${CONFIG_PAGES.length} • ${page.key} • Yui Config • by oBraga` })
        .setTimestamp();

    if (envWarning) {
        embed.addFields({ name: '⚠️ Aviso de Ambiente', value: envWarning });
    }
    if (d && d.problema === 'cofre-ilegivel') {
        embed.addFields({ name: '🔒 Cofre', value: 'O cofre do painel existe mas não abriu (arquivo quebrado ou protegido por outra conta). Nada será gravado até conferir o arquivo e a cópia .bak.' });
    } else if (d && !d.edicaoLigada) {
        embed.addFields({ name: '🔒 Edição travada', value: 'A edição pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env). Só dá para consultar.' });
    }

    const { min, max } = limitesDe(page);
    if (page.type === 'number' && min !== undefined) {
        embed.addFields({ name: '📐 Range', value: `Mín: \`${min}\` | Máx: \`${max}\` | Step: \`${page.step}\``, inline: false });
    }
    if (aviso?.texto) {
        embed.addFields({ name: aviso.ok ? '✅ Resultado' : '❌ Resultado', value: clampText(aviso.texto, 1000), inline: false });
    }

    return embed;
}

function buildNavigationRow(pageIndex) {
    const totalPages = CONFIG_PAGES.length;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cfgpanel_prev_${pageIndex}`)
            .setLabel('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex <= 0),
        new ButtonBuilder()
            .setCustomId(`cfgpanel_home`)
            .setLabel('🏠')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`cfgpanel_next_${pageIndex}`)
            .setLabel('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex >= totalPages),
        new ButtonBuilder()
            .setCustomId(`cfgpanel_goto_open`)
            .setLabel('🔢 Ir Para...')
            .setStyle(ButtonStyle.Secondary)
    );
}

/** Pode editar esta página agora? Endereços: nunca. Cofre: só com a edição ligada e o cofre legível. */
function editavel(page, d) {
    if (page.persistence === 'env') return false;
    if (page.persistence === 'cofre') return Boolean(d && d.edicaoLigada && d.problema !== 'cofre-ilegivel');
    return true;
}

// Correção C5 do parecer da Liz: os botões e o formulário de uma página do cofre levam a VERSÃO que a página mostrou (sufixo "~v<n>" no customId).
// Se o painel web gravou no meio, o cofre recusa com 409 e a página volta com o valor atual: nada é sobrescrito sem ninguém ver. Botão sem o
// sufixo (mensagem de antes desta mudança) grava sem conferir, como antes.
const SUFIXO_VERSAO_RE = /~v(\d{1,12})$/;
/** O sufixo da versão para os botões de uma página do cofre ('' para as páginas que não são do cofre). */
export function sufixoDaVersao(d) {
    return d && Number.isSafeInteger(d.versao) && d.versao >= 0 ? `~v${d.versao}` : '';
}
/** Separa o customId da versão: { base, versao } (versao undefined quando não há sufixo). */
export function separarVersao(customId) {
    const cid = String(customId ?? '');
    const m = SUFIXO_VERSAO_RE.exec(cid);
    return m ? { base: cid.slice(0, m.index), versao: Number(m[1]) } : { base: cid, versao: undefined };
}

function buildEditRow(pageIndex) {
    if (pageIndex <= 0) return null;

    const idx = pageIndex - 1;
    if (idx >= CONFIG_PAGES.length) return null;

    const page = CONFIG_PAGES[idx];
    const d = page.persistence === 'cofre' ? descreverItem(page.chave) : null;
    if (!editavel(page, d)) return null;
    const current = getCurrentValue(page, d);
    const v = sufixoDaVersao(d);
    // Ajuste salvo no cofre: o botão de voltar ao .env (ou ao padrão), como o "Desfazer ajuste" do painel web.
    const voltar = d?.origem === 'painel'
        ? new ButtonBuilder().setCustomId(`cfgpanel_reset_${idx}${v}`).setLabel('↩️ Voltar ao padrão').setStyle(ButtonStyle.Secondary)
        : null;
    const comVoltar = (botoes) => new ActionRowBuilder().addComponents(...(voltar ? [...botoes, voltar] : botoes));

    if (page.type === 'boolean') {
        return comVoltar([
            new ButtonBuilder()
                .setCustomId(`cfgpanel_toggle_${idx}_true${v}`)
                .setLabel('✅ Ativar')
                .setStyle(ButtonStyle.Success)
                .setDisabled(current === true),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_toggle_${idx}_false${v}`)
                .setLabel('❌ Desativar')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(current === false)
        ]);
    }

    if (page.type === 'number') {
        const step = page.step || 1;
        const { min, max } = limitesDe(page);
        return comVoltar([
            new ButtonBuilder()
                .setCustomId(`cfgpanel_dec_${idx}${v}`)
                .setLabel(`➖ -${step}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current === null || current <= min),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_inc_${idx}${v}`)
                .setLabel(`➕ +${step}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current === null || current >= max),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_input_${idx}${v}`)
                .setLabel('✏️ Definir Valor')
                .setStyle(ButtonStyle.Primary)
        ]);
    }

    if (page.type === 'string') {
        return comVoltar([
            new ButtonBuilder()
                .setCustomId(`cfgpanel_input_${idx}${v}`)
                .setLabel('✏️ Editar Valor')
                .setStyle(ButtonStyle.Primary)
        ]);
    }

    if (page.type === 'select') {
        const buttons = page.options.map(opt =>
            new ButtonBuilder()
                .setCustomId(`cfgpanel_sel_${idx}_${opt.value}${v}`)
                .setLabel(opt.label.substring(0, 80))
                .setStyle(opt.value === current ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(opt.value === current)
        );
        return comVoltar(buttons);
    }

    return null;
}

// O menu "Ir Para" aceita 25 opções, mas há mais configurações do que isso (eram 41; só as 24 primeiras apareciam). Cada "janela"
// traz a opção Home mais até 24 configurações, e dois botões (cfgpanel_gotowin_<n>) trocam de janela. Ao abrir, a janela mostrada
// é a que contém a página atual.
const GOTO_WINDOW_SIZE = 24;

function gotoWindowCount() {
    return Math.max(1, Math.ceil(CONFIG_PAGES.length / GOTO_WINDOW_SIZE));
}

function gotoWindowIndex(requested, currentPage) {
    const last = gotoWindowCount() - 1;
    const wanted = Number.isFinite(requested) ? requested : Math.floor((Math.max(1, currentPage) - 1) / GOTO_WINDOW_SIZE);
    return Math.max(0, Math.min(last, wanted));
}

function buildGotoSelectMenu(currentPage, windowIndex) {
    const win = gotoWindowIndex(windowIndex, currentPage);
    const first = win * GOTO_WINDOW_SIZE;
    const lastExclusive = Math.min(CONFIG_PAGES.length, first + GOTO_WINDOW_SIZE);
    const options = [];

    options.push({
        label: '🏠 Página Inicial (Home)',
        description: 'Visão geral de todas as categorias',
        value: 'cfgpage_0',
        default: currentPage === 0
    });

    for (let i = first; i < lastExclusive; i++) {
        const page = CONFIG_PAGES[i];
        options.push({
            label: `${page.icon} ${(i + 1)}. ${page.label}`,
            description: page.summary,
            value: `cfgpage_${i + 1}`,
            default: currentPage === i + 1
        });
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId('cfgpanel_goto_select')
        .setPlaceholder(gotoWindowCount() > 1
            ? `🔢 Configurações ${first + 1} a ${lastExclusive} de ${CONFIG_PAGES.length}...`
            : '🔢 Selecione uma configuração para ir...')
        .addOptions(clampOptions(options));

    return new ActionRowBuilder().addComponents(menu);
}

/** Botões para trocar a janela do menu "Ir Para". Sem eles (uma janela só) devolve null. */
function buildGotoPagingRow(currentPage, windowIndex) {
    const total = gotoWindowCount();
    if (total <= 1) return null;
    const win = gotoWindowIndex(windowIndex, currentPage);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cfgpanel_gotowin_${Math.max(0, win - 1)}`)
            .setLabel('⬅️ Configs anteriores')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(win <= 0),
        new ButtonBuilder()
            .setCustomId(`cfgpanel_gotowin_${Math.min(total - 1, win + 1)}`)
            .setLabel('Mais configs ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(win >= total - 1)
    );
}

function buildFullPayload(pageIndex, aviso = null) {
    const embed = buildConfigEmbed(pageIndex, aviso);
    const navRow = buildNavigationRow(pageIndex);
    const editRow = buildEditRow(pageIndex);

    const components = [navRow];
    if (editRow) components.push(editRow);

    return { embeds: [embed], components };
}

const MODAL_VALUE_MAX = 4000; // limite do Discord para o texto de um campo de modal
const VALOR_DE_BOTAO_RE = /^[\w.-]{1,40}$/; // o que cabe num customId de confirmação (os valores sensíveis são ligado/desligado e opções)

/** Página que muda só a memória do bot (prefixo, nome, prompt): como antes, sem arquivo nenhum (o config.json não é mais gravado). */
function aplicarNaMemoria(page, value) {
    if (page.persistence !== 'memoria' || !page.configKey) return false;
    config[page.configKey] = value;
    return true;
}

/** Texto do resultado de uma gravação no cofre: o valor RELIDO do cofre e quando vale. */
function textoGravado(page, r) {
    const valor = formatValue(valorDoCofre(page, { valor: r?.valor }), page);
    const quando = r?.reinicio ? 'Vale depois de reiniciar a Yui.' : 'Já vale.';
    if (r?.removido) return `Ajuste tirado do cofre: voltou ao .env ou ao padrão (${valor}). ${quando}`;
    return `Gravado no cofre do painel. Relido do cofre: ${valor}. ${quando}`;
}

function textoDoErro(err) {
    if (err instanceof PainelConfigError) return `Não gravei: ${String(err.message).replace(/\.$/, '')}. Nada mudou neste painel nem em outro lugar.`;
    return 'Não gravei: aconteceu um erro inesperado. Nada foi alterado.';
}

/** A tela de confirmação de um valor que afrouxa privacidade ou segurança (ou da remoção dele): o mesmo aviso do painel web. */
function buildConfirmPayload(idx, { valor, tirar, versao }) {
    const page = CONFIG_PAGES[idx];
    const c = itemDe(page);
    const novo = tirar ? 'Tirar o ajuste do cofre (volta ao valor do .env ou ao padrão).' : `Novo valor: ${formatValue(valorDoCofre(page, { valor: String(valor) }), page)}`;
    const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle(clampText(`⚠️ Confirmar: ${page.label}`, 250))
        .setDescription(clampText(`${c?.descricao ?? page.description}\n\n${novo}`, 4000))
        .setFooter({ text: `Página ${idx + 1}/${CONFIG_PAGES.length} • ${page.key} • Yui Config • by oBraga` });
    const confirmar = new ButtonBuilder()
        .setCustomId(`${tirar ? `cfgpanel_confirmreset_${idx}` : `cfgpanel_confirm_${idx}_${valor}`}${sufixoDaVersao({ versao })}`)
        .setLabel('Confirmar')
        .setStyle(ButtonStyle.Danger);
    const cancelar = new ButtonBuilder().setCustomId(`cfgpanel_back_${idx + 1}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(confirmar, cancelar)] };
}

const pedidoDe = (interaction) => ({
    userId: String(interaction.user?.id ?? ''),
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
    isDM: !interaction.guildId,
});

/**
 * Grava uma página do cofre a partir de um botão (ou, com `modal`, do formulário). Valor sensível sem a confirmação: mostra a tela de confirmação e não grava.
 * Responde primeiro (deferUpdate/deferReply: com a DPAPI ou o cérebro, a gravação pode passar dos 3 s do Discord) e depois mostra a página com o valor relido.
 */
async function gravarPagina(interaction, idx, { valor, tirar = false, confirm = false, modal = false, versao } = {}) {
    const page = CONFIG_PAGES[idx];
    const precisa = tirar ? exigeConfirmacao(page.chave) : exigeConfirmacao(page.chave, String(valor));
    if (precisa && !confirm) {
        if (!tirar && !VALOR_DE_BOTAO_RE.test(String(valor))) {
            const payload = buildFullPayload(idx + 1, { ok: false, texto: 'Não gravei: esse valor precisa de confirmação e não coube no botão. Use o painel web.' });
            return modal ? interaction.reply({ ...payload, ephemeral: true }) : interaction.update(payload);
        }
        const payload = buildConfirmPayload(idx, { valor, tirar, versao });
        return modal ? interaction.reply({ ...payload, ephemeral: true }) : interaction.update(payload);
    }
    if (modal) await interaction.deferReply({ ephemeral: true });
    else await interaction.deferUpdate();
    let aviso;
    try {
        const r = await gravarPeloDiscord({ ...pedidoDe(interaction), chave: page.chave, ...(tirar ? { tirar: true } : { valor: String(valor) }), confirm, via: 'painel', ...(versao !== undefined ? { versao } : {}) });
        aviso = { ok: true, texto: textoGravado(page, r) };
    } catch (err) {
        aviso = { ok: false, texto: textoDoErro(err) };
    }
    return interaction.editReply(buildFullPayload(idx + 1, aviso));
}

/** Arredonda pelo passo da página (0.1 vira uma casa) sem erro de ponto flutuante. */
function noPasso(value, step) {
    const casas = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    return Number(value.toFixed(casas));
}

async function handleConfigCommand(interaction) {
    const payload = buildFullPayload(0);
    await interaction.reply({ ...payload, ephemeral: true });
}

async function handleConfigButton(interaction) {
    // A versão que a página mostrou vem no fim do customId (C5); o resto do id é lido como antes.
    const { base: cid, versao } = separarVersao(interaction.customId);
    const paginaDe = (prefixo) => CONFIG_PAGES[parseInt(cid.slice(prefixo.length), 10)] ? parseInt(cid.slice(prefixo.length), 10) : -1;

    if (cid === 'cfgpanel_home') {
        return await interaction.update(buildFullPayload(0));
    }

    if (cid.startsWith('cfgpanel_prev_')) {
        const current = parseInt(cid.split('_')[2]);
        return await interaction.update(buildFullPayload(Math.max(0, current - 1)));
    }

    if (cid.startsWith('cfgpanel_next_')) {
        const current = parseInt(cid.split('_')[2]);
        return await interaction.update(buildFullPayload(Math.min(CONFIG_PAGES.length, current + 1)));
    }

    if (cid.startsWith('cfgpanel_back_')) {
        const page = parseInt(cid.slice('cfgpanel_back_'.length), 10);
        return await interaction.update(buildFullPayload(Number.isInteger(page) ? Math.max(0, Math.min(CONFIG_PAGES.length, page)) : 0));
    }

    if (cid === 'cfgpanel_goto_open' || cid.startsWith('cfgpanel_gotowin_')) {
        const currentFooter = interaction.message.embeds[0]?.footer?.text || '';
        const match = currentFooter.match(/Página (\d+)/);
        const currentPage = match ? parseInt(match[1]) : 0;
        // Abrir mostra a janela da página atual; os botões cfgpanel_gotowin_<n> pedem outra janela.
        const requested = cid.startsWith('cfgpanel_gotowin_') ? parseInt(cid.slice('cfgpanel_gotowin_'.length), 10) : NaN;
        const win = gotoWindowIndex(requested, currentPage);
        const selectRow = buildGotoSelectMenu(currentPage, win);
        const navRow = buildNavigationRow(currentPage);
        const pagingRow = buildGotoPagingRow(currentPage, win);
        return await interaction.update({
            embeds: interaction.message.embeds,
            components: pagingRow ? [selectRow, navRow, pagingRow] : [selectRow, navRow]
        });
    }

    if (cid.startsWith('cfgpanel_confirmreset_')) {
        const idx = paginaDe('cfgpanel_confirmreset_');
        if (idx < 0 || CONFIG_PAGES[idx].persistence !== 'cofre') return await interaction.update(buildFullPayload(0));
        return await gravarPagina(interaction, idx, { tirar: true, confirm: true, versao });
    }

    if (cid.startsWith('cfgpanel_confirm_')) {
        const [idxTxt, ...resto] = cid.slice('cfgpanel_confirm_'.length).split('_');
        const idx = parseInt(idxTxt, 10);
        const page = CONFIG_PAGES[idx];
        if (!page || page.persistence !== 'cofre') return await interaction.update(buildFullPayload(0));
        return await gravarPagina(interaction, idx, { valor: resto.join('_'), confirm: true, versao });
    }

    if (cid.startsWith('cfgpanel_reset_')) {
        const idx = paginaDe('cfgpanel_reset_');
        if (idx < 0 || CONFIG_PAGES[idx].persistence !== 'cofre') return await interaction.update(buildFullPayload(0));
        return await gravarPagina(interaction, idx, { tirar: true, versao });
    }

    if (cid.startsWith('cfgpanel_toggle_')) {
        const parts = cid.split('_');
        const idx = parseInt(parts[2]);
        const newVal = parts[3] === 'true';
        const page = CONFIG_PAGES[idx];
        if (!page || page.type !== 'boolean') return await interaction.update(buildFullPayload(page ? idx + 1 : 0));
        if (page.persistence === 'cofre') return await gravarPagina(interaction, idx, { valor: newVal ? 'true' : 'false', versao });
        aplicarNaMemoria(page, newVal);
        return await interaction.update(buildFullPayload(idx + 1));
    }

    if (cid.startsWith('cfgpanel_dec_') || cid.startsWith('cfgpanel_inc_')) {
        const isInc = cid.startsWith('cfgpanel_inc_');
        const idx = parseInt(cid.split('_')[2]);
        const page = CONFIG_PAGES[idx];
        if (!page || page.persistence !== 'cofre' || page.type !== 'number') return await interaction.update(buildFullPayload(page ? idx + 1 : 0));
        const current = getCurrentValue(page);
        if (current === null) return await interaction.update(buildFullPayload(idx + 1));
        const step = page.step || 1;
        const { min, max } = limitesDe(page);
        let newVal = noPasso(isInc ? current + step : current - step, step);
        if (min !== undefined) newVal = Math.max(min, newVal);
        if (max !== undefined) newVal = Math.min(max, newVal);
        return await gravarPagina(interaction, idx, { valor: String(newVal), versao });
    }

    if (cid.startsWith('cfgpanel_input_')) {
        const idx = parseInt(cid.split('_')[2]);
        const page = CONFIG_PAGES[idx];
        if (!page || page.persistence === 'env') return await interaction.update(buildFullPayload(page ? idx + 1 : 0));
        const current = getCurrentValue(page);
        const { min, max } = limitesDe(page);

        const modal = new ModalBuilder()
            .setCustomId(`cfgmodal_${idx}${sufixoDaVersao({ versao })}`)
            .setTitle(`✏️ ${page.label}`.substring(0, 45));

        const style = (typeof current === 'string' && current.length > 100) ? TextInputStyle.Paragraph : TextInputStyle.Short;

        // O campo do modal aceita no máximo 4000 caracteres. Um valor atual maior que isso não cabe (setValue lançava e o botão
        // não respondia) e também não pode ser pré-preenchido cortado, porque salvar gravaria o texto truncado por cima do original.
        // Nesse caso o campo abre vazio e o aviso fica no texto de exemplo.
        const currentText = String(current ?? '');
        const prefill = currentText.length <= MODAL_VALUE_MAX;

        const input = new TextInputBuilder()
            .setCustomId('cfg_value')
            .setLabel(page.summary.substring(0, 45))
            .setPlaceholder(page.type === 'number'
                ? `${min} a ${max}`
                : (prefill ? 'Digite o novo valor...' : 'O valor atual é grande demais para exibir: digite o valor completo'))
            .setStyle(style)
            .setRequired(page.persistence !== 'cofre' || page.type === 'number');
        if (prefill && currentText) input.setValue(currentText);

        if (page.type === 'number') {
            input.setMinLength(1);
            input.setMaxLength(20);
        } else {
            input.setMaxLength(MODAL_VALUE_MAX);
        }

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return await interaction.showModal(modal);
    }

    if (cid.startsWith('cfgpanel_sel_')) {
        const parts = cid.split('_');
        const idx = parseInt(parts[2]);
        const newVal = parts.slice(3).join('_');
        const page = CONFIG_PAGES[idx];
        if (!page || page.persistence !== 'cofre' || page.type !== 'select' || !page.options.some((o) => o.value === newVal)) return await interaction.update(buildFullPayload(page ? idx + 1 : 0));
        return await gravarPagina(interaction, idx, { valor: newVal, versao });
    }
}

async function handleConfigModal(interaction) {
    const { base: cid, versao } = separarVersao(interaction.customId);
    if (!cid.startsWith('cfgmodal_')) return false;

    const idx = parseInt(cid.split('_')[1]);
    const page = CONFIG_PAGES[idx];
    if (!page || page.persistence === 'env') return await interaction.reply({ ...buildFullPayload(0), ephemeral: true });
    const rawValue = interaction.fields.getTextInputValue('cfg_value') ?? '';

    if (page.type === 'number') {
        // Sem cortar para a faixa: o valor vai como veio e o COFRE recusa o que estiver fora (a mesma regra do painel web).
        const texto = String(rawValue).trim();
        if (!/^-?\d+(?:[.,]\d+)?$/.test(texto)) {
            const errEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('❌ Valor Inválido')
                .setDescription('O valor digitado não é um número válido.');
            return await interaction.reply({ embeds: [errEmbed], ephemeral: true });
        }
        return await gravarPagina(interaction, idx, { valor: texto.replace(',', '.'), modal: true, versao });
    }

    if (page.persistence === 'cofre') return await gravarPagina(interaction, idx, { valor: String(rawValue).trim(), modal: true, versao });

    aplicarNaMemoria(page, rawValue);
    return await interaction.reply({
        ...buildFullPayload(idx + 1),
        ephemeral: true
    });
}

async function handleConfigSelect(interaction) {
    if (interaction.customId !== 'cfgpanel_goto_select') return false;

    const selected = interaction.values[0];
    const pageIndex = parseInt(selected.replace('cfgpage_', ''));
    return await interaction.update(buildFullPayload(pageIndex));
}

// ── /yui-config_ia (só o dono; conferido no interactionCreate): os mesmos ajustes da cadeia, no MESMO cofre ──
const NOMES_DOS_PROVEDORES = { local: 'Local (LM Studio)', gemini: 'Gemini', pollinations: 'Pollinations', hf: 'HuggingFace', horde: 'Kobold Horde' };
const NOMES_DOS_CAMPOS = { timeout: 'Timeout (ms)', temperature: 'Temperatura', max_tokens: 'Max Tokens' };

/** O valor de um ajuste da cadeia, relido do cofre (o mesmo que o painel web e as páginas mostram). */
function valorDaCadeia(variavel) {
    const d = descreverItem(variavel);
    return d?.valor === null || d?.valor === undefined || d.valor === '' ? 'N/A' : `${d.valor}${d.origem === 'painel' ? '' : d.origem === 'env' ? ' (do .env)' : ' (padrão)'}`;
}

async function handleConfigIaCommand(interaction) {
    const provider = interaction.options.getString('provider');
    const setting = interaction.options.getString('setting');
    const value = interaction.options.getNumber('value');
    const erro = (texto) => interaction.reply({ embeds: [new EmbedBuilder().setColor(0xE11D48).setTitle('❌ Configurações • Parâmetros de IA').setDescription(texto)], ephemeral: true });

    if (!provider) {
        // Sem provedor: só mostra os valores atuais (relidos do cofre).
        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle('⚙️ Configurações • Parâmetros de IA')
            .setDescription('Valores atuais, relidos do cofre do painel (o mesmo do painel web, em Configuração e chaves, grupo Inteligência). Para mudar: `/yui-config_ia provider setting value`.');
        for (const [prov, campos] of Object.entries(VARIAVEIS_DA_CADEIA)) {
            const linhas = Object.entries(campos).map(([campo, variavel]) => `${NOMES_DOS_CAMPOS[campo] ?? campo}: \`${valorDaCadeia(variavel)}\``);
            embed.addFields({ name: NOMES_DOS_PROVEDORES[prov] ?? prov, value: clampText(linhas.join('\n'), 1000), inline: true });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (!setting || value === null || value === undefined) {
        return erro('Para configurar um provedor de IA, especifique a configuração e o valor.');
    }
    const variavel = VARIAVEIS_DA_CADEIA[provider]?.[setting];
    if (!variavel) {
        return erro('Esse ajuste não existe para esse provedor (o Pollinations não recebe temperatura). Nada foi alterado.');
    }
    await interaction.deferReply({ ephemeral: true });
    try {
        const r = await gravarPeloDiscord({ ...pedidoDe(interaction), chave: variavel, valor: String(value), via: 'comando' });
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('⚙️ Configurações • Parâmetros de IA')
            .setDescription(`Gravado no cofre do painel (o mesmo do painel web). ${r?.reinicio ? 'Vale depois de reiniciar a Yui.' : 'Já vale.'}`)
            .addFields(
                { name: 'Provedor', value: NOMES_DOS_PROVEDORES[provider] ?? provider, inline: true },
                { name: 'Configuração', value: NOMES_DOS_CAMPOS[setting] ?? setting, inline: true },
                { name: 'Valor (relido do cofre)', value: `\`${r?.valor ?? 'N/A'}\``, inline: true }
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE11D48).setTitle('❌ Configurações • Parâmetros de IA').setDescription(textoDoErro(err))] });
    }
}

export { handleConfigCommand, handleConfigButton, handleConfigModal, handleConfigSelect, handleConfigIaCommand, CONFIG_PAGES };
export default {
    handleConfigCommand,
    handleConfigButton,
    handleConfigModal,
    handleConfigSelect,
    handleConfigIaCommand,
};
