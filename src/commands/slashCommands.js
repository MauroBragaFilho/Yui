const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    PermissionFlagsBits,
    Routes,
    ChannelType
} = require('discord.js');
const setGlobalContext = (builder) => {
    return builder
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        .setContexts([
            InteractionContextType.BotDM,
            InteractionContextType.Guild,
            InteractionContextType.PrivateChannel
        ]);
};
const commands = [
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_chat')
            .setDescription('Faça uma pergunta ou pedido à IA.')
            .addStringOption(option =>
                option.setName('prompt')
                    .setDescription('Sua pergunta ou pedido para a IA.')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('visibilidade')
                    .setDescription('A resposta deve ser pública no chat? (Padrão: Não/Privado)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Sim (Público)', value: 'public' },
                        { name: 'Não (Privado)', value: 'private' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ajuda')
            .setDescription('Mostra o menu de ajuda interativo.')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('buscar_jogo')
            .setDescription('Busca jogos (FitGirl/DODI) e gera arquivo .torrent')
            .addStringOption(option =>
                option.setName('nome')
                    .setDescription('Nome do jogo para buscar')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('fonte')
                    .setDescription('Filtrar por fonte específica (opcional)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Qualquer uma', value: 'any' },
                        { name: 'DODI Repacks', value: 'dodi' },
                        { name: 'FitGirl Repacks', value: 'fitgirl' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_imagem')
            .setDescription('Gera uma imagem usando a IA dreamstudio (SDXL).')
            .addStringOption(option =>
                option.setName('prompt')
                    .setDescription('A descrição da imagem que você quer gerar.')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('negative_prompt')
                    .setDescription('O que você NÃO quer na imagem (ex: deformed, blurry).')
                    .setRequired(false))
            .addIntegerOption(option =>
                option.setName('width')
                    .setDescription('Largura da imagem (padrão 1024, max 1280).')
                    .setMinValue(512)
                    .setMaxValue(1280)
                    .setRequired(false))
            .addIntegerOption(option =>
                option.setName('height')
                    .setDescription('Altura da imagem (padrão 1024, max 1280).')
                    .setMinValue(512)
                    .setMaxValue(1280)
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('provider')
                    .setDescription('Escolha qual provedor de imagem usar (opcional)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Auto (Tentativa em Sequência)', value: 'auto' },
                        { name: 'Gradio (SDXL-Flash)', value: 'gradio' },
                        { name: 'HuggingFace (FLUX)', value: 'huggingface' },
                        { name: 'Stable Horde (Diversos)', value: 'stablehorde' },
                        { name: 'Together AI (FLUX)', value: 'together' },
                        { name: 'Pollinations AI (Flux)', value: 'pollinations' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('baixar_musica')
            .setDescription('Baixa o áudio de um vídeo do YouTube em MP3.')
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('A URL do vídeo do YouTube.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('chat_humor')
            .setDescription('Configura a personalidade e humor da Hikari neste canal. (Admin)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(option =>
                option.setName('instrucao')
                    .setDescription('Nova instrução de personalidade (Opcional).')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('mood')
                    .setDescription('Novo humor/estado emocional (Opcional). Ex: "Estressada", "Apaixonada".')
                    .setRequired(false))
            .addBooleanOption(option =>
                option.setName('reset')
                    .setDescription('Se VERDADEIRO, reseta tudo para o padrão (ignora outros campos).')
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('chat_espontaneo')
            .setDescription('Configura a Hikari para falar sozinha de tempos em tempos. (Admin/Dono)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addStringOption(option =>
                option.setName('estado')
                    .setDescription('Ativar ou Desativar?')
                    .setRequired(true)
                    .addChoices(
                        { name: '🟢 Ativado', value: 'on' },
                        { name: '🔴 Desativado', value: 'off' }
                    ))
            .addStringOption(option =>
                option.setName('frequencia')
                    .setDescription('Com que frequência ela deve se intrometer? (Padrão: Baixa)')
                    .setRequired(false)
                    .addChoices(
                        { name: '🐢 Baixa (Raro)', value: 'low' },
                        { name: '🐇 Média (Ocasional)', value: 'medium' },
                        { name: '🐆 Alta (Faladora)', value: 'high' }
                    ))
            .addIntegerOption(option =>
                option.setName('porcentagem')
                    .setDescription('Definir chance exata (0-100%). Substitui a frequência. 🔒 (Dono Apenas)')
                    .setMinValue(0)
                    .setMaxValue(100)
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('chat_resumo')
            .setDescription('Faz um resumo das últimas mensagens do chat.')
            .addIntegerOption(option =>
                option.setName('quantidade')
                    .setDescription('Quantidade de mensagens para resumir (10-100).')
                    .setMinValue(10)
                    .setMaxValue(100)
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('chat_updates')
            .setDescription('Configura o canal para receber avisos de atualizações da Hikari. (Admin)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addChannelOption(option =>
                option.setName('canal')
                    .setDescription('O canal de texto para os updates. (Deixe vazio para o canal atual)')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('aceitar_tos')
            .setDescription('Envia o painel com os Termos de Uso da Hikari para aceitação da administração. (Admin)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('anime_origem')
            .setDescription('Descobre o nome do anime através de uma imagem (screenshot).')
            .addAttachmentOption(option =>
                option.setName('imagem')
                    .setDescription('Upload da imagem do anime.')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('Ou a URL da imagem.')
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_config')
            .setDescription('Configura timeouts e parâmetros dos modelos de IA. (Admin Only)')
            .addStringOption(option =>
                option.setName('provider')
                    .setDescription('Qual provedor configurar?')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Local (LM Studio)', value: 'local' },
                        { name: 'Gemini', value: 'gemini' },
                        { name: 'Pollinations', value: 'pollinations' },
                        { name: 'HuggingFace', value: 'hf' },
                        { name: 'Kobold Horde', value: 'horde' }
                    ))
            .addStringOption(option =>
                option.setName('setting')
                    .setDescription('Qual configuração alterar?')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Timeout (ms)', value: 'timeout' },
                        { name: 'Temperatura (0.1 - 1.0)', value: 'temperature' },
                        { name: 'Max Tokens', value: 'max_tokens' }
                    ))
            .addNumberOption(option =>
                option.setName('value')
                    .setDescription('O novo valor para a configuração.')
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_model_config')
            .setDescription('Configura a exibição do modelo nas respostas e pensamentos. (Admin Only)')
            .addBooleanOption(option =>
                option.setName('mostrar_modelo')
                    .setDescription('Mostrar ou não o nome do modelo nas respostas (Global).')
                    .setRequired(false))
            .addBooleanOption(option =>
                option.setName('mostrar_modelo_pensamento')
                    .setDescription('Mostrar ou não o modelo que está processando no pensamento (Global).')
                    .setRequired(false))
            .addIntegerOption(option =>
                option.setName('tentativas_erro')
                    .setDescription('Número de re-tentativas caso ocorra erro ou vazamento de ferramenta (Global).')
                    .setMinValue(0)
                    .setRequired(false))
    ),

    setGlobalContext(
        new SlashCommandBuilder()
            .setName('adm_banir')
            .setDescription('Bane um usuário, servidor ou canal da rede Hikari. (Admin Only)')
            .addStringOption(opt => opt.setName('tipo').setDescription('O que banir?').setRequired(true).addChoices({ name: 'Usuário', value: 'user' }, { name: 'Servidor', value: 'guild' }, { name: 'Canal', value: 'channel' }))
            .addStringOption(opt => opt.setName('id').setDescription('O ID do alvo.').setRequired(true))
            .addStringOption(opt => opt.setName('motivo').setDescription('Motivo do banimento.').setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('adm_desbanir')
            .setDescription('Remove o banimento de um alvo. (Admin Only)')
            .addStringOption(opt => opt.setName('tipo').setDescription('O que desbanir?').setRequired(true).addChoices({ name: 'Usuário', value: 'user' }, { name: 'Servidor', value: 'guild' }, { name: 'Canal', value: 'channel' }))
            .addStringOption(opt => opt.setName('id').setDescription('O ID do alvo.').setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('adm_lista_bans')
            .setDescription('Lista os bloqueios ativos. (Admin Only)')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('adm_automod')
            .setDescription('Configura o modo do AutoMod em um servidor específico. (Admin Only)')
            .addStringOption(opt =>
                opt.setName('id')
                    .setDescription('ID do servidor para configurar.')
                    .setRequired(true))
            .addStringOption(opt =>
                opt.setName('modo')
                    .setDescription('Escolha o modo de funcionamento do AutoMod para este servidor.')
                    .setRequired(true)
                    .addChoices(
                        { name: '🔴 Desativado (off)', value: 'off' },
                        { name: '🛡️ Somente Palavras Gatilho (trigger)', value: 'trigger' },
                        { name: '🧠 Somente IA (mcp)', value: 'mcp' },
                        { name: '⚡ Ambos: Gatilhos + IA (both)', value: 'both' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_prompt')
            .setDescription('Sobrescreve o system prompt da Hikari neste servidor. (Somente criador)')
            .addSubcommand(sub =>
                sub.setName('set')
                    .setDescription('Define um novo system prompt para este servidor.')
                    .addStringOption(opt =>
                        opt.setName('prompt')
                            .setDescription('O novo system prompt completo.')
                            .setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('reset')
                    .setDescription('Remove o system prompt customizado e volta ao padrão do código.')
            )
            .addSubcommand(sub =>
                sub.setName('view')
                    .setDescription('Exibe o system prompt atual deste servidor.')
            )
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_ferramentas')
            .setDescription('Habilita ou desabilita ferramentas MCP da Hikari por servidor. (Somente criador)')
            .addSubcommand(sub =>
                sub.setName('toggle')
                    .setDescription('Ativa ou desativa uma tool específica neste servidor.')
                    .addStringOption(opt =>
                        opt.setName('tool')
                            .setDescription('Nome da ferramenta para configurar.')
                            .setRequired(true)
                            .setAutocomplete(true))
                    .addStringOption(opt =>
                        opt.setName('estado')
                            .setDescription('Ativar ou desativar?')
                            .setRequired(true)
                            .addChoices(
                                { name: '✅ Ativar', value: 'on' },
                                { name: '❌ Desativar', value: 'off' }
                            ))
            )
            .addSubcommand(sub =>
                sub.setName('list')
                    .setDescription('Lista todas as tools e o status delas neste servidor.')
            )
            .addSubcommand(sub =>
                sub.setName('reset')
                    .setDescription('Reabilita todas as tools desabilitadas neste servidor.')
            )
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_mention_todos')
            .setDescription('Configura se a Hikari deve responder a marcações de @everyone e @here no servidor. (Server-Admin)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addBooleanOption(option =>
                option.setName('ativo')
                    .setDescription('Sim para responder a @everyone/@here, Não para ignorar.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('steam_jogo')
            .setDescription('Consulte o preço e informações de um jogo diretamente na Steam.')
            .addStringOption(option =>
                option.setName('nome')
                    .setDescription('O nome do jogo que você quer consultar.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('converter_moeda')
            .setDescription('Converte valores entre diferentes moedas e criptomoedas.')
            .addNumberOption(option =>
                option.setName('valor')
                    .setDescription('O valor numérico para converter.')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('de')
                    .setDescription('Código da moeda de origem (Ex: USD, BTC, EUR).')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addStringOption(option =>
                option.setName('para')
                    .setDescription('Código da moeda de destino (Ex: BRL).')
                    .setRequired(true)
                    .setAutocomplete(true))
    ),
].map(command => command.toJSON());
async function registerCommands(client, rest) {
    try {
        console.log('Iniciando o registro Global (User/Guild) dos comandos slash (/).');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Comandos slash (/) registrados com sucesso para todos os contextos!');
    } catch (error) {
        console.error('Erro ao registrar comandos slash:', error);
    }
}
module.exports = { commands, registerCommands };