import {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    PermissionFlagsBits,
    Routes,
    ChannelType
} from 'discord.js';

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
            .setDescription('[User] Faça uma pergunta ou pedido à IA.')
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
            .setDescription('[User] Mostra o menu de ajuda interativo.')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('buscar_jogo')
            .setDescription('[User] Busca jogos (FitGirl/DODI) e gera arquivo .torrent')
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
            .setDescription('[User] Gera uma imagem nova a partir do texto.')
            .addStringOption(option =>
                option.setName('prompt')
                    .setDescription('A descrição da imagem que você quer gerar.')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('negative_prompt')
                    .setDescription('O que você NÃO quer na imagem.')
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
                    .setDescription('Provedor de imagem')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Auto', value: 'auto' },
                        { name: 'Gradio', value: 'gradio' },
                        { name: 'HuggingFace', value: 'huggingface' },
                        { name: 'Stable Horde', value: 'stablehorde' },
                        { name: 'Together AI', value: 'together' },
                        { name: 'Pollinations AI', value: 'pollinations' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('baixar_musica')
            .setDescription('[User] Baixa o áudio de um vídeo em MP3.')
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('A URL do vídeo.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('baixar_musica_deezer')
            .setDescription('[User] Baixa áudios de música em alta qualidade (Deezer).')
            .addStringOption(option =>
                option.setName('nome')
                    .setDescription('O nome da música e/ou artista.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('baixar_video')
            .setDescription('[User] Baixa um vídeo em MP4.')
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('A URL do vídeo.')
                    .setRequired(true))
            .addBooleanOption(option =>
                option.setName('descricao')
                    .setDescription('Exibir descrição?')
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('config_servidor')
            .setDescription('[Server Admin] Central de configurações do servidor e canal.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(opt => opt.setName('instrucao').setDescription('Nova instrução de comportamento para o canal.').setRequired(false))
            .addStringOption(opt => opt.setName('mood').setDescription('Novo humor/estado emocional do canal.').setRequired(false))
            .addBooleanOption(opt => opt.setName('reset_humor').setDescription('Restaurar humor e instruções para o padrão?').setRequired(false))
            .addStringOption(opt => opt.setName('espontaneo_estado').setDescription('Ativar/Desativar falas espontâneas.').setRequired(false).addChoices({ name: '🟢 Ativado', value: 'on' }, { name: '🔴 Desativado', value: 'off' }))
            .addStringOption(opt => opt.setName('espontaneo_frequencia').setDescription('Frequência das falas espontâneas.').setRequired(false).addChoices({ name: '🐢 Baixa', value: 'low' }, { name: '🐇 Média', value: 'medium' }, { name: '🐆 Alta', value: 'high' }))
            .addIntegerOption(opt => opt.setName('espontaneo_porcentagem').setDescription('Porcentagem exata de respostas (0-100%).').setMinValue(0).setMaxValue(100).setRequired(false))
            .addChannelOption(opt => opt.setName('canal_updates').setDescription('Canal de texto para receber avisos de atualizações.').addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addBooleanOption(opt => opt.setName('mencoes_ativo').setDescription('Responder a marcações de @everyone e @here?').setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('chat_resumo')
            .setDescription('[User] Faz um resumo das últimas mensagens do chat.')
            .addIntegerOption(option =>
                option.setName('quantidade')
                    .setDescription('Quantidade de mensagens para resumir (10-100).')
                    .setMinValue(10)
                    .setMaxValue(100)
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('aceitar_tos')
            .setDescription('[Server Admin] Envia o painel com os Termos de Uso da Yui.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_ferramentas')
            .setDescription('[Server Admin] Gerencie e ative/desative ferramentas (pesquisa, imagens, voz) neste servidor.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option =>
                option.setName('acao')
                    .setDescription('Ação desejada')
                    .setRequired(true)
                    .addChoices(
                        { name: '📜 Listar Status das Tools', value: 'list' },
                        { name: '⚡ Alternar Tool (Ativar/Desativar)', value: 'toggle' },
                        { name: '🔄 Restaurar Padrão do Servidor', value: 'reset' }
                    ))
            .addStringOption(option =>
                option.setName('ferramenta')
                    .setDescription('Ferramenta para alterar (opção Alternar).')
                    .setAutocomplete(true)
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('estado')
                    .setDescription('Defina se a ferramenta estará ativa ou desativa.')
                    .setRequired(false)
                    .addChoices(
                        { name: '✅ Ativar', value: 'on' },
                        { name: '❌ Desativar', value: 'off' }
                    ))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('anime_origem')
            .setDescription('[User] Descobre o nome do anime através de uma imagem.')
            .addAttachmentOption(option =>
                option.setName('imagem')
                    .setDescription('Upload da imagem do anime.')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('URL da imagem.')
                    .setRequired(false))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('ia_config')
            .setDescription('[Creator] Configura timeouts e parâmetros dos modelos de IA.')
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
            .setName('config_criador')
            .setDescription('[Creator] Central de controle master do criador.')
            .addSubcommand(sub =>
                sub.setName('modelo')
                    .setDescription('[Creator] Configura exibição do modelo nas respostas e pensamentos.')
                    .addBooleanOption(opt => opt.setName('mostrar_nome').setDescription('Mostrar nome do modelo nas respostas?').setRequired(false))
                    .addBooleanOption(opt => opt.setName('mostrar_pensamento').setDescription('Mostrar modelo durante o pensamento?').setRequired(false))
                    .addIntegerOption(opt => opt.setName('retentativas').setDescription('Tentativas em caso de erro (0-10).').setMinValue(0).setMaxValue(10).setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('banir')
                    .setDescription('[Creator] Bane usuário, servidor ou canal.')
                    .addStringOption(opt => opt.setName('tipo').setDescription('O que banir?').setRequired(true).addChoices({ name: 'Usuário', value: 'user' }, { name: 'Servidor', value: 'guild' }, { name: 'Canal', value: 'channel' }))
                    .addStringOption(opt => opt.setName('id').setDescription('ID do alvo.').setRequired(true))
                    .addStringOption(opt => opt.setName('motivo').setDescription('Motivo do banimento.').setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('desbanir')
                    .setDescription('[Creator] Remove banimento de um alvo.')
                    .addStringOption(opt => opt.setName('tipo').setDescription('O que desbanir?').setRequired(true).addChoices({ name: 'Usuário', value: 'user' }, { name: 'Servidor', value: 'guild' }, { name: 'Canal', value: 'channel' }))
                    .addStringOption(opt => opt.setName('id').setDescription('ID do alvo.').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('bans_lista')
                    .setDescription('[Creator] Exibe a central de bloqueios ativos.')
            )
            .addSubcommand(sub =>
                sub.setName('automod')
                    .setDescription('[Creator] Configura o AutoMod em um servidor.')
                    .addStringOption(opt => opt.setName('servidor_id').setDescription('ID do servidor.').setRequired(true))
                    .addStringOption(opt => opt.setName('modo').setDescription('Modo do AutoMod.').setRequired(true).addChoices({ name: '🔴 Desativado (off)', value: 'off' }, { name: '🛡️ Gatilhos (trigger)', value: 'trigger' }, { name: '🧠 IA (mcp)', value: 'mcp' }, { name: '⚡ Ambos (both)', value: 'both' }))
            )
            .addSubcommand(sub =>
                sub.setName('ferramenta')
                    .setDescription('[Creator] Gestor de ferramentas MCP por servidor.')
                    .addStringOption(opt => opt.setName('acao').setDescription('Ação desejada').setRequired(true).addChoices({ name: 'Alterar Tool', value: 'toggle' }, { name: 'Listar Tools', value: 'list' }, { name: 'Resetar Servidor', value: 'reset' }))
                    .addStringOption(opt => opt.setName('ferramenta').setDescription('Nome da ferramenta (para toggle).').setAutocomplete(true).setRequired(false))
                    .addStringOption(opt => opt.setName('estado').setDescription('Estado (para toggle).').setRequired(false).addChoices({ name: '✅ Ativar', value: 'on' }, { name: '❌ Desativar', value: 'off' }))
                    .addStringOption(opt => opt.setName('servidor_id').setDescription('ID do servidor target (opcional).').setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('bot_config')
                    .setDescription('[Creator] Painel de configuração de runtime do bot.')
            )
            .addSubcommand(sub =>
                sub.setName('painel')
                    .setDescription('[Creator] Abre o painel interativo do criador.')
            )
            .addSubcommand(sub =>
                sub.setName('dashboard')
                    .setDescription('[Creator] Abre o painel interativo do criador.')
            )
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('steam_jogo')
            .setDescription('[User] Consulte o preço e informações de um jogo diretamente na Steam.')
            .addStringOption(option =>
                option.setName('nome')
                    .setDescription('O nome do jogo que você quer consultar.')
                    .setRequired(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('converter_moeda')
            .setDescription('[User] Converte valores entre diferentes moedas e criptomoedas.')
            .addNumberOption(option =>
                option.setName('valor')
                    .setDescription('O valor numérico para converter.')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('de')
                    .setDescription('Código da moeda de origem.')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addStringOption(option =>
                option.setName('para')
                    .setDescription('Código da moeda de destino.')
                    .setRequired(true)
                    .setAutocomplete(true))
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('entrar-call')
            .setDescription('[User] Faz a Yui entrar no seu canal de voz atual.')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('sair-call')
            .setDescription('[User] Faz a Yui sair do canal de voz atual.')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('modo-radio')
            .setDescription('[User] Ativa o Modo Rádio de Música.')
    ),
    setGlobalContext(
        new SlashCommandBuilder()
            .setName('baixar_musica_atual')
            .setDescription('[User] Baixa a música que você ou outro usuário está ouvindo (Spotify/YT Music/Metrolist).')
            .addStringOption(option =>
                option.setName('usuario')
                    .setDescription('Usuário (menção ou ID do Discord) para checar a música (opcional)')
                    .setAutocomplete(true)
                    .setRequired(false))
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

export default { commands, registerCommands };