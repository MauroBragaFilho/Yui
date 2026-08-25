import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import config from '../config.js';
import {
    updateShowModel,
    getShowModel,
    updateShowModelThinking,
    getShowModelThinking,
    updateErrorRetries,
    getErrorRetries,
    updateProviderSetting,
    getProviderSettings,
} from './llmHandler.js';

const CONFIG_PAGES = [
    {
        key: 'showModel',
        label: 'Exibir Nome do Modelo',
        category: '🤖 IA — Exibição',
        icon: '🏷️',
        type: 'boolean',
        persistence: 'runtime',
        summary: 'Mostra ou esconde qual modelo respondeu.',
        description: 'Controla se o nome do modelo de IA (ex: gemini-2.5-flash-lite, Qwen2.5-72B) aparece no rodapé das respostas da Yui. Útil para debug ou curiosidade, mas pode poluir visualmente se ativado em produção.',
        get: () => getShowModel(),
        set: (v) => updateShowModel(v),
    },
    {
        key: 'showModelThinking',
        label: 'Exibir Modelo no Pensamento',
        category: '🤖 IA — Exibição',
        icon: '💭',
        type: 'boolean',
        persistence: 'runtime',
        summary: 'Mostra o modelo durante o processamento.',
        description: 'Quando ativado, exibe qual modelo está processando o pedido na mensagem de "pensando..." antes da resposta final. Ajuda a identificar qual provider está sendo usado em tempo real durante o fallback automático.',
        get: () => getShowModelThinking(),
        set: (v) => updateShowModelThinking(v),
    },
    {
        key: 'errorRetries',
        label: 'Tentativas em Caso de Erro',
        category: '🤖 IA — Resiliência',
        icon: '🔄',
        type: 'number',
        persistence: 'runtime',
        summary: 'Quantas vezes re-tenta se der erro.',
        description: 'Define quantas vezes a Yui re-tenta gerar uma resposta quando ocorre erro de parsing, vazamento de ferramenta, ou resposta inválida do modelo. Valor 0 = sem retentativa, a primeira resposta (mesmo com erro) é final. Valores altos podem causar lentidão.',
        min: 0, max: 10, step: 1,
        get: () => getErrorRetries(),
        set: (v) => updateErrorRetries(v),
    },
    {
        key: 'local.temperature',
        label: 'Temperatura — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '🌡️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Criatividade do modelo local.',
        description: 'Controla a aleatoriedade das respostas do LM Studio/Ollama. Valores baixos (0.1-0.3) = respostas previsíveis e factuais. Valores altos (0.8-1.5) = respostas mais criativas e variadas. Acima de 1.0 pode gerar respostas incoerentes.',
        min: 0.0, max: 2.0, step: 0.1,
        get: () => getProviderSettings().local.temperature,
        set: (v) => updateProviderSetting('local', 'temperature', v),
    },
    {
        key: 'local.timeout',
        label: 'Timeout — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '⏱️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo máximo em milissegundos que a Yui espera pela resposta do LM Studio antes de considerar timeout e tentar o próximo provider. Modelos grandes locais podem precisar de 60000ms+. Valor muito baixo causa falsos timeouts.',
        min: 5000, max: 300000, step: 5000,
        get: () => getProviderSettings().local.timeout,
        set: (v) => updateProviderSetting('local', 'timeout', v),
    },
    {
        key: 'local.max_tokens',
        label: 'Max Tokens — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '📏',
        type: 'number',
        persistence: 'runtime',
        summary: 'Limite de tokens na resposta.',
        description: 'Número máximo de tokens que o modelo local pode gerar em uma resposta. Tokens ≈ palavras (1 token ≈ 0.75 palavras em português). Valores baixos = respostas curtas e rápidas. Valores altos = respostas longas mas mais lentas e custosas em VRAM.',
        min: 64, max: 8192, step: 128,
        get: () => getProviderSettings().local.max_tokens,
        set: (v) => updateProviderSetting('local', 'max_tokens', v),
    },
    {
        key: 'local.top_p',
        label: 'Top P — Local (LM Studio)',
        category: '🌡️ Provider: Local',
        icon: '🎯',
        type: 'number',
        persistence: 'runtime',
        summary: 'Nucleus sampling do modelo local.',
        description: 'Controla a diversidade via nucleus sampling. 1.0 = considera todos os tokens. 0.5 = considera apenas os tokens que formam 50% da probabilidade acumulada. Usado em conjunto com temperature. Reduza para respostas mais focadas.',
        min: 0.0, max: 1.0, step: 0.05,
        get: () => getProviderSettings().local.top_p,
        set: (v) => updateProviderSetting('local', 'top_p', v),
    },
    {
        key: 'gemini.temperature',
        label: 'Temperatura — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '🌡️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Criatividade do Gemini.',
        description: 'Controla a aleatoriedade do Google Gemini. Valores baixos geram respostas seguras e previsíveis. Valores altos tornam o Gemini mais criativo mas potencialmente menos preciso. O Gemini tende a ser conservador, então 0.7-0.9 é um bom range.',
        min: 0.0, max: 2.0, step: 0.1,
        get: () => getProviderSettings().gemini.temperature,
        set: (v) => updateProviderSetting('gemini', 'temperature', v),
    },
    {
        key: 'gemini.timeout',
        label: 'Timeout — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '⏱️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela API do Gemini em milissegundos. O Gemini é geralmente rápido (5-15s), mas pode demorar mais em horários de pico. 60000ms (1 min) é um valor seguro. Aumente se estiver tendo muitos timeouts sem motivo.',
        min: 5000, max: 300000, step: 5000,
        get: () => getProviderSettings().gemini.timeout,
        set: (v) => updateProviderSetting('gemini', 'timeout', v),
    },
    {
        key: 'gemini.max_tokens',
        label: 'Max Tokens — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '📏',
        type: 'number',
        persistence: 'runtime',
        summary: 'Limite de tokens na resposta do Gemini.',
        description: 'Limite máximo de tokens gerados pelo Gemini. O Gemini 2.5 Flash suporta até 8192 tokens de saída. Para respostas curtas e conversacionais, 1024-2048 é suficiente. Para análises longas ou code review, aumente para 4096+.',
        min: 64, max: 8192, step: 128,
        get: () => getProviderSettings().gemini.max_tokens,
        set: (v) => updateProviderSetting('gemini', 'max_tokens', v),
    },
    {
        key: 'gemini.top_p',
        label: 'Top P — Gemini',
        category: '🌡️ Provider: Gemini',
        icon: '🎯',
        type: 'number',
        persistence: 'runtime',
        summary: 'Nucleus sampling do Gemini.',
        description: 'Nucleus sampling para o Gemini. 1.0 = padrão (sem restrição). Reduza para 0.8-0.9 se quiser respostas mais focadas. Funciona como um filtro complementar à temperatura.',
        min: 0.0, max: 1.0, step: 0.05,
        get: () => getProviderSettings().gemini.top_p,
        set: (v) => updateProviderSetting('gemini', 'top_p', v),
    },
    {
        key: 'pollinations.temperature',
        label: 'Temperatura — Pollinations',
        category: '🌡️ Provider: Pollinations',
        icon: '🌡️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Criatividade do Pollinations.',
        description: 'Controla a aleatoriedade do provedor Pollinations AI (gratuito, sem API key). Como é um provider de fallback, valores moderados (0.6-0.8) são recomendados para manter qualidade.',
        min: 0.0, max: 2.0, step: 0.1,
        get: () => getProviderSettings().pollinations.temperature,
        set: (v) => updateProviderSetting('pollinations', 'temperature', v),
    },
    {
        key: 'pollinations.timeout',
        label: 'Timeout — Pollinations',
        category: '🌡️ Provider: Pollinations',
        icon: '⏱️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela API do Pollinations. Por ser um serviço gratuito, pode ter latência alta. 60000ms é o mínimo recomendado. Se estiver com muitos timeouts, aumente para 90000-120000ms.',
        min: 5000, max: 300000, step: 5000,
        get: () => getProviderSettings().pollinations.timeout,
        set: (v) => updateProviderSetting('pollinations', 'timeout', v),
    },
    {
        key: 'pollinations.max_tokens',
        label: 'Max Tokens — Pollinations',
        category: '🌡️ Provider: Pollinations',
        icon: '📏',
        type: 'number',
        persistence: 'runtime',
        summary: 'Limite de tokens do Pollinations.',
        description: 'Limite de tokens gerados pelo Pollinations. Como é um provider de fallback gratuito, mantenha valores moderados (512-1024) para evitar respostas truncadas pelo serviço.',
        min: 64, max: 4096, step: 128,
        get: () => getProviderSettings().pollinations.max_tokens,
        set: (v) => updateProviderSetting('pollinations', 'max_tokens', v),
    },
    {
        key: 'hf.temperature',
        label: 'Temperatura — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '🌡️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Criatividade do HuggingFace.',
        description: 'Controla a aleatoriedade do modelo rodando no HuggingFace Inference API (atualmente Qwen2.5-72B). Valores baixos para tarefas técnicas, valores altos para conversas casuais.',
        min: 0.0, max: 2.0, step: 0.1,
        get: () => getProviderSettings().hf.temperature,
        set: (v) => updateProviderSetting('hf', 'temperature', v),
    },
    {
        key: 'hf.timeout',
        label: 'Timeout — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '⏱️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Tempo máximo de espera (ms).',
        description: 'Tempo de espera pela Inference API do HuggingFace. O Qwen2.5-72B pode demorar 20-40s dependendo da carga dos servidores. 60000ms é o mínimo seguro. Modelos grandes podem precisar de 90000ms+.',
        min: 5000, max: 300000, step: 5000,
        get: () => getProviderSettings().hf.timeout,
        set: (v) => updateProviderSetting('hf', 'timeout', v),
    },
    {
        key: 'hf.max_tokens',
        label: 'Max Tokens — HuggingFace',
        category: '🌡️ Provider: HuggingFace',
        icon: '📏',
        type: 'number',
        persistence: 'runtime',
        summary: 'Limite de tokens do HuggingFace.',
        description: 'Limite de tokens gerados pelo HuggingFace. O tier gratuito pode ter limites implícitos menores. 512 é conservador mas seguro. Aumente para 1024+ se tiver conta PRO.',
        min: 64, max: 4096, step: 128,
        get: () => getProviderSettings().hf.max_tokens,
        set: (v) => updateProviderSetting('hf', 'max_tokens', v),
    },
    {
        key: 'horde.temperature',
        label: 'Temperatura — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '🌡️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Criatividade do Horde.',
        description: 'Aleatoriedade dos modelos distribuídos do Stable Horde. O Horde roda modelos variados em GPUs voluntárias, então a qualidade já é inconsistente — valores moderados (0.5-0.7) ajudam a estabilizar.',
        min: 0.0, max: 2.0, step: 0.1,
        get: () => getProviderSettings().horde.temperature,
        set: (v) => updateProviderSetting('horde', 'temperature', v),
    },
    {
        key: 'horde.timeout',
        label: 'Timeout — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '⏱️',
        type: 'number',
        persistence: 'runtime',
        summary: 'Tempo máximo de espera (ms).',
        description: 'O Horde é assíncrono — o bot faz a requisição e depois polla o resultado. Este timeout cobre toda a operação (envio + espera + polling). O Horde pode levar 30-120s dependendo da fila. 60000ms é o mínimo, 120000ms é recomendado.',
        min: 10000, max: 300000, step: 10000,
        get: () => getProviderSettings().horde.timeout,
        set: (v) => updateProviderSetting('horde', 'timeout', v),
    },
    {
        key: 'horde.max_tokens',
        label: 'Max Tokens — AI Horde',
        category: '🌡️ Provider: Horde',
        icon: '📏',
        type: 'number',
        persistence: 'runtime',
        summary: 'Limite de tokens do Horde.',
        description: 'Limite de tokens gerados pelo AI Horde. O Horde tem limites implícitos por worker (geralmente 256-512 tokens). Definir acima de 512 pode não ter efeito prático dependendo do worker que pegar a requisição.',
        min: 64, max: 2048, step: 64,
        get: () => getProviderSettings().horde.max_tokens,
        set: (v) => updateProviderSetting('horde', 'max_tokens', v),
    },
    {
        key: 'prefix',
        label: 'Prefixo de Comandos',
        category: '⚙️ Geral',
        icon: '✏️',
        type: 'string',
        persistence: 'json',
        configKey: 'prefix',
        summary: 'Prefixo para comandos de texto.',
        description: 'O caractere ou texto que precede comandos de texto (não-slash) do bot. Padrão: "_". Se definido como "@Yui", o bot responde quando mencionado pelo nome. Não afeta comandos slash (/).',
    },
    {
        key: 'botName',
        label: 'Nome do Bot',
        category: '⚙️ Geral',
        icon: '📛',
        type: 'string',
        persistence: 'json',
        configKey: 'botName',
        summary: 'Nome usado na persona da IA.',
        description: 'O nome que a IA usa para se referir a si mesma nas respostas e no system prompt. Alterar aqui muda como ela se identifica. Não altera o username do bot no Discord (isso é feito no Developer Portal).',
    },
    {
        key: 'appealChannelId',
        label: 'Canal de Apelações',
        category: '⚙️ Geral',
        icon: '📬',
        type: 'string',
        persistence: 'json',
        configKey: 'appealChannelId',
        summary: 'ID do canal para formulários de appeal.',
        description: 'ID do canal do Discord onde os formulários de apelação de banimento (appeals) são enviados. Quando um usuário banido solicita revisão, o formulário vai para este canal. Deve ser um canal de texto acessível pelo bot.',
    },
    {
        key: 'requireTos',
        label: 'Exigir Termos de Uso',
        category: '🛡️ Moderação',
        icon: '📜',
        type: 'boolean',
        persistence: 'json',
        configKey: 'requireTos',
        summary: 'Bloqueia servers que não aceitaram o TOS.',
        description: 'Quando ativado, servidores que não executaram /aceitar_tos ficam completamente bloqueados de usar qualquer comando da Yui. Desativar permite que todos os servidores usem o bot imediatamente sem aceitar termos.',
    },
    {
        key: 'saveHistory',
        label: 'Salvar Histórico de Prompts',
        category: '🛡️ Moderação',
        icon: '💾',
        type: 'boolean',
        persistence: 'json',
        configKey: 'saveHistory',
        summary: 'Registra prompts e respostas em arquivo.',
        description: 'Salva todos os prompts dos usuários e respostas da IA em "src/data/historico.txt" para auditoria e debug. O arquivo cresce continuamente — considere limpar periodicamente. Desativar melhora privacidade mas perde rastreabilidade.',
    },
    {
        key: 'keepMusicEmbed',
        label: 'Manter Embed ao Baixar Música',
        category: '🎵 Mídia & Áudio',
        icon: '🖼️',
        type: 'boolean',
        persistence: 'json',
        configKey: 'keepMusicEmbed',
        summary: 'Mantém o embed de identificação da música junto com o arquivo de áudio.',
        description: 'Quando ativado (true), ao concluir o download de música (Spotify/YT Music/Metrolist ou Deezer), a mensagem mantém o embed visual de identificação (foto da capa, artista, álbum) junto com o arquivo .mp3 anexado na mesma mensagem. Quando desativado (false), a mensagem é editada apenas com o texto simples e arquivo.',
    },
    {
        key: 'defaultAutoMod',
        label: 'AutoMod Padrão em Novos Servers',
        category: '🛡️ Moderação',
        icon: '🛡️',
        type: 'boolean',
        persistence: 'json',
        configKey: 'defaultAutoMod',
        summary: 'AutoMod ativo por padrão em novos servers.',
        description: 'Define se o sistema de moderação automática (AutoMod) é ativado automaticamente quando o bot entra em um novo servidor. Se desativado, cada servidor precisará ativar manualmente via /adm_automod.',
    },
    {
        key: 'automodMode',
        label: 'Modo do AutoMod Global',
        category: '🛡️ Moderação',
        icon: '⚡',
        type: 'select',
        persistence: 'json',
        configKey: 'automodMode',
        options: [
            { label: '🔴 Desativado', value: 'off' },
            { label: '🧠 Somente IA (MCP)', value: 'mcp' },
            { label: '🛡️ Somente Gatilhos', value: 'trigger' },
            { label: '⚡ Ambos (MCP + Gatilhos)', value: 'both' },
        ],
        summary: 'Modo padrão de moderação automática.',
        description: 'Define o modo padrão do AutoMod para novos servidores. "off" = desativado. "mcp" = bloqueia apenas chamadas de ferramentas perigosas. "trigger" = bloqueia mensagens com palavras proibidas. "both" = ativa ambos os modos simultaneamente.',
    },
    {
        key: 'sendEnvironmentInfo',
        label: 'Enviar Info de Contexto',
        category: '🛡️ Moderação',
        icon: '📍',
        type: 'boolean',
        persistence: 'json',
        configKey: 'sendEnvironmentInfo',
        summary: 'Inclui info do server/canal no prompt.',
        description: 'Quando ativado, envia informações do servidor e canal (nome do server, nome do canal, etc.) como contexto adicional no prompt da IA. Isso permite que a Yui saiba "onde está" e adapte respostas. Desativar economiza tokens.',
    },
    {
        key: 'geminiModel',
        label: 'Modelo Gemini Principal',
        category: '🔗 Endpoints & Modelos',
        icon: '🧠',
        type: 'string',
        persistence: 'json',
        configKey: 'geminiModel',
        summary: 'Modelo primário do Google Gemini.',
        description: 'Nome do modelo Gemini usado como provider principal. Ex: "gemini-2.5-flash-lite" (rápido e barato), "gemini-2.5-flash" (equilibrado), "gemini-2.5-pro" (mais capaz mas caro). Consulte a documentação do Google para modelos disponíveis.',
    },
    {
        key: 'geminiModelFallback',
        label: 'Modelo Gemini Fallback',
        category: '🔗 Endpoints & Modelos',
        icon: '🔄',
        type: 'string',
        persistence: 'json',
        configKey: 'geminiModelFallback',
        summary: 'Modelo secundário se o principal falhar.',
        description: 'Modelo usado quando todas as chaves de API falham no modelo principal. Funciona como segunda chance antes de cair para Pollinations/HF. Use um modelo diferente do principal para diversificar.',
    },
    {
        key: 'hfModel',
        label: 'Modelo HuggingFace',
        category: '🔗 Endpoints & Modelos',
        icon: '🤗',
        type: 'string',
        persistence: 'json',
        configKey: 'hfModel',
        summary: 'Modelo na Inference API do HF.',
        description: 'Nome completo do modelo no HuggingFace (formato: "Organização/NomeModelo"). Ex: "Qwen/Qwen2.5-72B-Instruct". Deve ser um modelo com endpoint de inferência ativo no HF. Modelos gated precisam de token com acesso.',
    },
    {
        key: 'localLlmModel',
        label: 'Modelo Local (LM Studio)',
        category: '🔗 Endpoints & Modelos',
        icon: '🖥️',
        type: 'string',
        persistence: 'json',
        configKey: 'localLlmModel',
        summary: 'Nome do modelo carregado localmente.',
        description: 'Identificador do modelo rodando no LM Studio ou Ollama. Usado no campo "model" da requisição. Se o LM Studio está configurado para aceitar qualquer modelo, pode deixar "local-model". Caso contrário, use o nome exato.',
    },
    {
        key: 'localLlmUrl',
        label: 'URL do LLM Local',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'json',
        configKey: 'localLlmUrl',
        summary: 'Endpoint do servidor LLM local.',
        description: 'URL completa do endpoint de chat completions do LM Studio ou Ollama. Formato: "http://IP:PORTA/v1/chat/completions". Use localhost para mesma máquina ou IP da rede para acesso remoto (ex: Tailscale).',
    },
    {
        key: 'geminiUrl',
        label: 'URL da API Gemini',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'json',
        configKey: 'geminiUrl',
        summary: 'Endpoint da API do Google Gemini.',
        description: 'URL do endpoint de chat completions do Gemini. Padrão: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions". Pode ser alterado para proxies compatíveis com OpenAI API format.',
    },
    {
        key: 'hfApiUrl',
        label: 'URL da API HuggingFace',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'json',
        configKey: 'hfApiUrl',
        summary: 'Endpoint da Inference API do HF.',
        description: 'URL da API de inferência do HuggingFace. Pode usar o router ("https://router.huggingface.co/v1/chat/completions") ou endpoint direto do modelo. O router distribui automaticamente entre réplicas disponíveis.',
    },
    {
        key: 'hordeUrl',
        label: 'URL da API Horde',
        category: '🔗 Endpoints & Modelos',
        icon: '🌐',
        type: 'string',
        persistence: 'json',
        configKey: 'hordeUrl',
        summary: 'Endpoint da API do Stable Horde.',
        description: 'URL da API do Stable Horde para geração de texto. Padrão: "https://stablehorde.net/api/v2/generate/text/async". Não altere a menos que esteja usando um Horde privado ou mirror.',
    },
    {
        key: 'systemPrompt',
        label: 'System Prompt Global',
        category: '🧬 Personalidade',
        icon: '🧬',
        type: 'string',
        persistence: 'json',
        configKey: 'systemPrompt',
        summary: 'Prompt base da personalidade da Yui.',
        description: 'O system prompt que define as regras, personalidade, estilo de fala e restrições da Yui globalmente. CUIDADO: alterar incorretamente pode quebrar a persona e o formato de resposta.',
    },
];

const envConfigMap = {
    prefix: 'PREFIX',
    botName: 'BOT_NAME',
    appealChannelId: 'APPEAL_CHANNEL_ID',
    requireTos: 'REQUIRE_TOS',
    saveHistory: 'SAVE_HISTORY',
    keepMusicEmbed: 'KEEP_MUSIC_EMBED',
    defaultAutoMod: 'DEFAULT_AUTOMOD',
    automodMode: 'AUTOMOD_MODE',
    sendEnvironmentInfo: 'SEND_ENVIRONMENT_INFO',
    geminiModel: 'GEMINI_MODEL',
    geminiModelFallback: 'GEMINI_MODEL_FALLBACK',
    hfModel: 'HF_MODEL',
    localLlmModel: 'LOCAL_LLM_MODEL',
    localLlmUrl: 'LOCAL_LLM_URL',
    geminiUrl: 'GEMINI_URL',
    hfApiUrl: 'HF_API_URL',
    hordeUrl: 'HORDE_URL',
    systemPrompt: 'SYSTEM_PROMPT',
};

function getActiveEnvWarning(page) {
    if (page.persistence !== 'json') return null;
    const envKey = envConfigMap[page.configKey];
    if (!envKey) return null;
    if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
        return `⚠️ A variável de ambiente \`${envKey}\` está ativa no .env. Alterar aqui no JSON **não terá efeito** enquanto o ENV existir (o ENV sobrescreve o JSON).`;
    }
    return null;
}

function getCurrentValue(page) {
    if (page.get) return page.get();
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
        .setDescription('Painel administrativo para ajuste de todas as configurações do bot em tempo real.\nUse as **setas** para navegar ou **Ir Para** para pular direto a uma config.\n\n**Categorias disponíveis:**')
        .setFooter({ text: `Página 0/${CONFIG_PAGES.length} • Home • Yui Config • by yGuilhermy` })
        .setTimestamp();

    for (const [cat, count] of Object.entries(categories)) {
        embed.addFields({ name: cat, value: `${count} configuração(ões)`, inline: true });
    }

    embed.addFields({ name: '\u200B', value: `**Total:** ${CONFIG_PAGES.length} configurações disponíveis para ajuste.` });

    return embed;
}

function buildConfigEmbed(pageIndex) {
    if (pageIndex <= 0) return buildHomePage();

    const idx = pageIndex - 1;
    if (idx >= CONFIG_PAGES.length) return buildHomePage();

    const page = CONFIG_PAGES[idx];
    const currentValue = getCurrentValue(page);
    const envWarning = getActiveEnvWarning(page);

    const embed = new EmbedBuilder()
        .setColor(page.persistence === 'runtime' ? 0x3B82F6 : 0x10B981)
        .setTitle(`${page.icon} ${page.label}`)
        .setDescription(`${page.description}`)
        .addFields(
            { name: '📋 Resumo', value: page.summary, inline: false },
            { name: '📊 Valor Atual', value: formatValue(currentValue, page), inline: true },
            { name: '📂 Categoria', value: page.category, inline: true },
            { name: '💽 Persistência', value: page.persistence === 'runtime' ? '⚡ Runtime (volta ao padrão no restart)' : '💾 JSON Permanente (salvo em disco)', inline: false }
        )
        .setFooter({ text: `Página ${pageIndex}/${CONFIG_PAGES.length} • ${page.key} • Yui Config • by yGuilhermy` })
        .setTimestamp();

    if (envWarning) {
        embed.addFields({ name: '⚠️ Aviso de Ambiente', value: envWarning });
    }

    if (page.type === 'number' && page.min !== undefined) {
        embed.addFields({ name: '📐 Range', value: `Mín: \`${page.min}\` | Máx: \`${page.max}\` | Step: \`${page.step}\``, inline: false });
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

function buildEditRow(pageIndex) {
    if (pageIndex <= 0) return null;

    const idx = pageIndex - 1;
    if (idx >= CONFIG_PAGES.length) return null;

    const page = CONFIG_PAGES[idx];

    if (page.type === 'boolean') {
        const current = getCurrentValue(page);
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cfgpanel_toggle_${idx}_true`)
                .setLabel('✅ Ativar')
                .setStyle(ButtonStyle.Success)
                .setDisabled(current === true),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_toggle_${idx}_false`)
                .setLabel('❌ Desativar')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(current === false)
        );
    }

    if (page.type === 'number') {
        const current = getCurrentValue(page);
        const step = page.step || 1;
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cfgpanel_dec_${idx}`)
                .setLabel(`➖ -${step}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current <= page.min),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_inc_${idx}`)
                .setLabel(`➕ +${step}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current >= page.max),
            new ButtonBuilder()
                .setCustomId(`cfgpanel_input_${idx}`)
                .setLabel('✏️ Definir Valor')
                .setStyle(ButtonStyle.Primary)
        );
    }

    if (page.type === 'string') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cfgpanel_input_${idx}`)
                .setLabel('✏️ Editar Valor')
                .setStyle(ButtonStyle.Primary)
        );
    }

    if (page.type === 'select') {
        const current = getCurrentValue(page);
        const buttons = page.options.map(opt =>
            new ButtonBuilder()
                .setCustomId(`cfgpanel_sel_${idx}_${opt.value}`)
                .setLabel(opt.label.substring(0, 80))
                .setStyle(opt.value === current ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(opt.value === current)
        );
        return new ActionRowBuilder().addComponents(buttons);
    }

    return null;
}

function buildGotoSelectMenu(currentPage) {
    const pageSize = 25;
    const options = [];

    options.push({
        label: '🏠 Página Inicial (Home)',
        description: 'Visão geral de todas as categorias',
        value: 'cfgpage_0',
        default: currentPage === 0
    });

    for (let i = 0; i < CONFIG_PAGES.length && options.length < pageSize; i++) {
        const page = CONFIG_PAGES[i];
        options.push({
            label: `${page.icon} ${(i + 1)}. ${page.label}`.substring(0, 100),
            description: page.summary.substring(0, 100),
            value: `cfgpage_${i + 1}`,
            default: currentPage === i + 1
        });
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId('cfgpanel_goto_select')
        .setPlaceholder('🔢 Selecione uma configuração para ir...')
        .addOptions(options);

    return new ActionRowBuilder().addComponents(menu);
}

function buildFullPayload(pageIndex) {
    const embed = buildConfigEmbed(pageIndex);
    const navRow = buildNavigationRow(pageIndex);
    const editRow = buildEditRow(pageIndex);

    const components = [navRow];
    if (editRow) components.push(editRow);

    return { embeds: [embed], components };
}

import fs from 'fs.js';
import path from 'path.js';

function updateConfigJson(key, value) {
    const configJsonPath = path.join(__dirname, '../config/config.json');
    try {
        const rawContent = fs.readFileSync(configJsonPath, 'utf8');
        const cleanContent = rawContent.replace(/\\"|"(?:\\"|[^"])*"|(\/{2}.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
        const jsonConfig = JSON.parse(cleanContent);
        jsonConfig[key] = value;
        fs.writeFileSync(configJsonPath, JSON.stringify(jsonConfig, null, 2));
        config[key] = value;
        return true;
    } catch (error) {
        console.error('[ConfigPanel] Erro ao salvar config.json:', error.message);
        return false;
    }
}

function applyValue(page, value) {
    if (page.persistence === 'runtime' && page.set) {
        page.set(value);
        return true;
    }
    if (page.persistence === 'json' && page.configKey) {
        return updateConfigJson(page.configKey, value);
    }
    return false;
}

async function handleConfigCommand(interaction) {
    const payload = buildFullPayload(0);
    await interaction.reply({ ...payload, ephemeral: true });
}

async function handleConfigButton(interaction) {
    const cid = interaction.customId;

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

    if (cid === 'cfgpanel_goto_open') {
        const currentFooter = interaction.message.embeds[0]?.footer?.text || '';
        const match = currentFooter.match(/Página (\d+)/);
        const currentPage = match ? parseInt(match[1]) : 0;
        const selectRow = buildGotoSelectMenu(currentPage);
        const navRow = buildNavigationRow(currentPage);
        return await interaction.update({
            embeds: interaction.message.embeds,
            components: [selectRow, navRow]
        });
    }

    if (cid.startsWith('cfgpanel_toggle_')) {
        const parts = cid.split('_');
        const idx = parseInt(parts[2]);
        const newVal = parts[3] === 'true';
        const page = CONFIG_PAGES[idx];
        applyValue(page, newVal);
        return await interaction.update(buildFullPayload(idx + 1));
    }

    if (cid.startsWith('cfgpanel_dec_') || cid.startsWith('cfgpanel_inc_')) {
        const isInc = cid.startsWith('cfgpanel_inc_');
        const idx = parseInt(cid.split('_')[2]);
        const page = CONFIG_PAGES[idx];
        let current = getCurrentValue(page);
        const step = page.step || 1;
        let newVal = isInc ? current + step : current - step;
        newVal = Math.round(newVal * 1000) / 1000;
        if (page.min !== undefined) newVal = Math.max(page.min, newVal);
        if (page.max !== undefined) newVal = Math.min(page.max, newVal);
        applyValue(page, newVal);
        return await interaction.update(buildFullPayload(idx + 1));
    }

    if (cid.startsWith('cfgpanel_input_')) {
        const idx = parseInt(cid.split('_')[2]);
        const page = CONFIG_PAGES[idx];
        const current = getCurrentValue(page);

        const modal = new ModalBuilder()
            .setCustomId(`cfgmodal_${idx}`)
            .setTitle(`✏️ ${page.label}`.substring(0, 45));

        const style = (typeof current === 'string' && current.length > 100) ? TextInputStyle.Paragraph : TextInputStyle.Short;

        const input = new TextInputBuilder()
            .setCustomId('cfg_value')
            .setLabel(page.summary.substring(0, 45))
            .setPlaceholder(page.type === 'number' ? `${page.min} a ${page.max}` : 'Digite o novo valor...')
            .setValue(String(current ?? ''))
            .setStyle(style)
            .setRequired(true);

        if (page.type === 'number') {
            input.setMinLength(1);
            input.setMaxLength(20);
        }

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return await interaction.showModal(modal);
    }

    if (cid.startsWith('cfgpanel_sel_')) {
        const parts = cid.split('_');
        const idx = parseInt(parts[2]);
        const newVal = parts.slice(3).join('_');
        const page = CONFIG_PAGES[idx];
        applyValue(page, newVal);
        return await interaction.update(buildFullPayload(idx + 1));
    }
}

async function handleConfigModal(interaction) {
    const cid = interaction.customId;
    if (!cid.startsWith('cfgmodal_')) return false;

    const idx = parseInt(cid.split('_')[1]);
    const page = CONFIG_PAGES[idx];
    const rawValue = interaction.fields.getTextInputValue('cfg_value');

    let finalValue;
    if (page.type === 'number') {
        finalValue = parseFloat(rawValue);
        if (isNaN(finalValue)) {
            const errEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('❌ Valor Inválido')
                .setDescription(`O valor "\`${rawValue}\`" não é um número válido.`);
            return await interaction.reply({ embeds: [errEmbed], ephemeral: true });
        }
        if (page.min !== undefined && finalValue < page.min) finalValue = page.min;
        if (page.max !== undefined && finalValue > page.max) finalValue = page.max;
    } else {
        finalValue = rawValue;
    }

    const success = applyValue(page, finalValue);

    if (!success) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Erro ao Salvar')
            .setDescription('Não foi possível salvar a configuração. Verifique os logs do console.');
        return await interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

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

export default {
    handleConfigCommand,
    handleConfigButton,
    handleConfigModal,
    handleConfigSelect,
};
