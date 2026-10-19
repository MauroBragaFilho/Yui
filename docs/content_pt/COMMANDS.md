# 🎮 Guia Avançado de Comandos / Advanced Commands Guide

Este documento detalha todos os comandos slash (/) disponíveis na Yui, suas funcionalidades, parâmetros e permissões.

---

## 📂 Sumário

1. [🧠 IA & Chat](#-ia--chat)
2. [💾 Memória](#-memória)
3. [🎮 GTA Online](#-gta-online)
4. [🎨 Imagens & Arte](#-imagens--arte)
5. [🎵 Multimídia & Utilidades](#-multimídia--utilidades)
6. [🎮 Jogos & Downloads](#-jogos--downloads)
7. [🏪 Consulta na Loja](#-consulta-na-loja)
8. [📺 YouTube e Twitch](#-youtube-e-twitch)
9. [⚙️ Configuração & Administração](#-configuração--administração)
10. [💡 Dicas de Especialista](#-dicas-de-especialista)

> 📌 Os slash commands são registrados automaticamente na inicialização. Comandos globais podem levar até 1 hora para aparecer (use `DISCORD_GUILD_ID` para testar na hora). `/ajuda` lista os comandos dentro do Discord.

---

## 🧠 IA & Chat

### `/yui`

O comando principal para interagir com o cérebro da Yui.

- **Prompt:** Sua pergunta ou pedido.
- **Visibilidade:** Escolha entre `Público` (todos veem) ou `Privado` (apenas você vê).
- **Advanced:** Se você mencionar outras pessoas no prompt, a Yui pode tentar entender o contexto da conversa.
- **Tamanho:** a pergunta pode ter até 4000 caracteres (`YUI_ASK_MAX_CHARS`; o mesmo vale para `+yui perguntar`) e cada pessoa tem uma resposta por vez. Para um texto maior, mande uma **mensagem normal mencionando a Yui** com um anexo `.txt`, `.md` ou `.log`: ela lê o arquivo (até 100 KB e 12000 caracteres), tratando o conteúdo como dado, nunca como ordem. Comandos de barra não leem anexo.
- **Respostas longas:** o Discord aceita 2000 caracteres por mensagem, então uma resposta maior é dividida em várias mensagens (a Yui escreve a lista ou o texto completo, sem prometer "parte 2"). Passando de 4 mensagens (`YUI_REPLY_MAX_PARTS`) ou de 20000 caracteres, ela manda uma introdução e o texto inteiro em anexo `.md` (`YUI_REPLY_ATTACH_EXT=txt` volta ao `.txt`). Quem é citado no arquivo e não aparece na introdução vai na linha "Citados no arquivo", porque menção dentro de anexo não notifica.
- **Pesquisa na web:** só quando a pergunta pede dado atual ou factual específico, nunca em conversa privada, e limitada por pessoa (5 por hora, `YUI_SEARCH_USER_PER_HOUR`). Veja [Comandos e skills](COMANDOS_E_SKILLS.md#-4-busca-na-web).
- **Lista de mods (Minecraft):** com 5 ou mais linhas de nomes de mods e um pedido de link ou download, a Yui procura cada nome no Modrinth, confere o loader e a versão do Minecraft em comum e devolve a lista com os links e as dependências obrigatórias (**Important Complements**). Vale também no `+yui perguntar`, na menção e na DM. Escreva `Forge 1.20.1` ou `fabric 1.21` para fixar a combinação. Veja [Lista de mods](ENVIRONMENT.md#-lista-de-mods-minecraft).

### `/chat_resumo`

Faz a leitura das últimas mensagens e gera um resumo inteligente.

- **Quantidade:** O número de mensagens a analisar (Min: 10, Max: 100).
- **Advanced:** Útil para entender discussões longas que você perdeu. O que os outros escreveram no canal entra como **registro de terceiros** (dado, nunca ordem), sem usar a memória de ninguém e sem gravar esse log no `historico.txt`. O log enviado à IA tem até 20000 caracteres (cada mensagem, até 600): as mensagens mais novas têm prioridade e, se algo for cortado, o resumo abre avisando quantas entraram.

### `/chat_humor` (Admin)

Altera a "alma" da Yui em um canal específico.

- **Instrucao:** Novas regras de comportamento (ex: "Fale como um pirata"), até 1500 caracteres.
- **Mood:** Estado emocional (ex: "Brava", "Feliz"), até 100 caracteres.
- **Reset:** Volta às configurações padrão.
- **Advanced:** Essas mudanças persistem apenas no canal onde foram aplicadas.

### `/chat_espontaneo` (Dono)

Configura a Yui para se intrometer nas conversas sem ser chamada.

- **Estado:** Ativar ou Desativar.
- **Frequência:** Escolha entre `Baixa`, `Média` ou `Alta`.
- **Porcentagem (🔒 Dono):** Chance exata (0-100%) para cada mensagem recebida no canal.

---

## 💾 Memória

### `/yui-memoria`

Cada usuário vê e controla o que a Yui lembra sobre ele (preferências, nome, anotações). A memória pública **expira após 30 dias sem interação**; a Yui também guarda sozinha frases como "lembra que eu gosto de X".

- **`ver`:** Lista as suas lembranças com um número.
- **`lembrar texto:`** Pede para guardar uma informação (até 300 caracteres).
- **`esquecer id:`** Apaga uma lembrança pelo número.
- **`apagar-tudo`:** Apaga toda a sua memória com a Yui e também as falas guardadas pelo **contexto por horas** (se o recurso estiver ligado), em todos os canais. O registro de uso do bot (`historico.txt`) não é apagado por este comando, e a resposta avisa isso.
- **Advanced:** A resposta é só para você. A memória **pessoal** do dono (permanente) não aparece em canais públicos. Veja [Assistente pessoal](ASSISTENTE_PESSOAL.md).

---

## 🎮 GTA Online

Detalhes em [GTA Online](GTA_ONLINE.md).

- **`/gta-diario`:** Resumo do reset diário (Van de Armas, Traficantes, Colecionáveis, Desafios Contra o Relógio).
- **`/gta-semanal fonte:`** Evento da semana, com a análise da Yui. `reddit` (padrão) ou `newswire`. Embed paginado com botões ◀ ▶.
- **`/gta-noticias quantidade:`** Últimas notícias do Rockstar Newswire (1 a 5).
- **`/yui-configurar`** (Server Admin): Define os canais `noticias`, `diario` e `semanal` do servidor.

---

## 🎨 Imagens & Arte

### `/yui-imagem`

Gera imagens usando diversos modelos de difusão.

- **Prompt:** Descrição detalhada do que você quer.
- **Negative Prompt:** O que você NÃO quer na imagem.
- **Width/Height:** Dimensões da imagem (512px a 1280px).
- **Provider:** Escolha o gerador (Stability, HuggingFace, Pollinations, etc).
- **Advanced:** O modo `Auto` tentará os provedores em sequência até um funcionar.

---

## 🎙️ Voz & Calls

### `/entrar-call`

Conecta a Yui ao seu canal de voz atual para atendimento inteligente por voz.

- **Advanced:** A Yui escuta os usuários no canal de voz e responde ao ouvir o gatilho "Yui" (ou equivalências fonéticas). Suporta nativamente o protocolo DAVE (E2EE) de criptografia do Discord e filtro de silêncio por RMS de áudio.
- **Requisito:** o codificador Opus (vem com o `npm install`). Sem ele o comando é recusado com um aviso claro, em vez de entrar e falhar na primeira fala. O servidor também precisa ter a ferramenta **🎙️ Assistente de Voz (Call)** ligada em `/yui-ferramentas` (vem desligada); senão o comando avisa que as ferramentas de voz estão desativadas.
- **Responder falando:** por padrão a Yui responde só no chat de texto. Para ela responder também **falando** na call, ligue **🔊 Resposta por Voz (TTS)** em `/yui-ferramentas`. Veja abaixo [Falar com a Yui por voz](#-falar-com-a-yui-por-voz).
- **Robustez:** se a captura de voz de alguém falhar, essa pessoa fica 60 segundos ignorada (a falha é registrada uma vez, sem o conteúdo da fala). Depois de 5 falhas seguidas a escuta da sessão é desligada, com aviso no canal; usar `/entrar-call` de novo religa a escuta.

### `/sair-call`

Desconecta a Yui do canal de voz em que ela está conectada no servidor.

- **Advanced:** Pode ser acionado via comando slash, voz ("Yui, saia da call") ou via ferramenta MCP. Desconecta automaticamente em caso de inatividade quando todos os usuários saem da call. Sair interrompe qualquer fala em andamento.

### 🗣️ Falar com a Yui por voz

Não é um comando de barra: com a Yui na call (`/entrar-call`), é só falar.

- **Chamar:** comece a frase com o nome dela, nas 3 primeiras palavras: *"Yui, que dia é hoje?"*. A resposta sai **no chat de texto** (com a sua menção) e, com **🔊 Resposta por Voz (TTS)** ligado no servidor, também **falada** na call, em 1 a 3 frases curtas (o resto fica no chat). Se o nome vier só no meio da frase, ela responde apenas em texto.
- **Interromper:** quem fez o pedido pode falar por cima dela. *"Yui, para"* (também "chega", "silêncio") funciona quando não é dito em cima da voz dela.
- **Sair:** *"Yui, sai da call"* (precisa do **🎙️ Assistente de Voz (Call)** ligado).
- **O que ela não faz por voz:** baixar música, buscar na web, gerar imagem e as demais ferramentas; ela responde *"Isso eu faço só pelo chat."* Também não repete frases que mandarem (*"Essa eu passo."*). Não fala durante o Modo Rádio.
- **Limites:** 1 pedido a cada 6 s por pessoa e fila curta por servidor; pedidos além disso são ignorados.
- **Privacidade e ajuste:** o áudio da call é enviado a serviços de transcrição na nuvem; a voz da Yui é gerada no seu PC. Detalhes, limites e solução de problemas no [guia de TTS](TTS.md).

---

## 🎵 Multimídia & Utilidades

### `/baixar_musica`

Central de downloads de música em MP3 — aceita link ou busca.

- **URL (opcional):** Link do YouTube, Spotify, Instagram ou TikTok.
- **Busca (opcional):** Nome da música e/ou artista (busca no catálogo do Deezer).
- **Advanced:** Detecta automaticamente a origem da URL. Para YouTube/Instagram/TikTok usa `yt-dlp` + `ffmpeg`; para Spotify usa o `spotdl` (do ambiente `.venv-spotdl`, de `SPOTDL_PATH` ou do `PATH`), e o `yt-dlp` só entra como reserva se o `spotdl` não estiver instalado (ele costuma falhar no Spotify, por causa de DRM); para nome/artista usa a API REST do Deezer com o motor `deemix` em MP3 HQ (com menu de seleção interativo em caso de ambiguidade). Detecta o limite de upload do servidor (10 MB no padrão, 50 MB no Boost nível 2 e 100 MB no nível 3) e recomprime o MP3 a 192, 128 e 96 kbps, nessa ordem, até caber; se nem assim couber, avisa que passou do limite. Arquivos temporários são removidos após o envio.
- **Links com playlist:** se o link traz um vídeo e uma playlist (`...watch?v=ID&list=...`), a Yui baixa **só o vídeo** e avisa numa linha discreta. Se o link é só de playlist (ou perfil/coleção do TikTok), baixa **só o primeiro item** e também avisa. Nunca baixa a playlist inteira.
- **Spotify:** só links de **faixa** (`open.spotify.com/track/...`). Álbum, playlist, artista e podcast são recusados com uma mensagem clara. O áudio é procurado em outro catálogo, então a faixa pode vir numa versão diferente da do Spotify. O limite de duração (`YUI_DL_MAX_MINUTES`) não vale para o Spotify, e o relógio do PC precisa estar certo para o `spotdl` conseguir o acesso.
- **Deezer:** só faixa. Se o `deemix` falhar (ARL vencido, conta sem acesso, tempo esgotado), a Yui baixa de outra fonte e **avisa só que a qualidade desta faixa pode ser menor que a original**.
- **Sem indicar a origem:** o arquivo chega sem campo "Fonte" nem aviso com o nome do serviço (Deezer, YouTube, Spotify), e as tags de URL e de comentário do MP3 são tiradas. A origem fica só nos logs.
- **Limites** (configuráveis no `.env`): duração máxima de 20 minutos (`YUI_DL_MAX_MINUTES`), arquivo de até 200 MB (`YUI_DL_MAX_FILESIZE_MB`) e 5 minutos por download (`YUI_DL_TIMEOUT_SECONDS`). Transmissões ao vivo são recusadas. O Modo Rádio e o Spotify não têm o limite de duração. Há ainda um teto de 3 downloads ao mesmo tempo no total (`YUI_DL_MAX_CONCURRENT`): acima disso a Yui pede para tentar de novo em instantes.
- **Segurança:** o link é validado e reconstruído antes de chegar ao `yt-dlp`; o texto que você digita nunca vai para um terminal. Mensagens de erro são curtas e o detalhe técnico fica só no log. Títulos vindos da internet aparecem dentro de um trecho de código e nunca marcam ninguém.

### `/baixar_video`

Baixa vídeos e envia em formato MP4 no chat do Discord.

- **URL:** O link do vídeo (YouTube Shorts, Instagram Reels ou TikTok).
- **Descricao (Boolean):** Se verdadeiro, exibe o autor e a descrição do vídeo original na mensagem. Padrão: `false`.
- **Advanced:** Detecta o limite de upload do servidor (10 MB no padrão, 50 MB no Boost nível 2 e 100 MB no nível 3) para aplicar compressão de vídeo em FFMPEG se ultrapassar os limites do Discord. Oferece fila de compressão assíncrona.
- **Playlist e limites:** valem as mesmas regras do `/baixar_musica`: link com playlist baixa só o vídeo, playlist/perfil/coleção baixa só o primeiro item, e os limites de duração, tamanho e tempo do `.env` (`YUI_DL_*`) se aplicam.

### `/anime_origem`

Identifica um anime através de um print/imagem.

- **Imagem:** Upload de um arquivo.
- **URL:** Link direto para a imagem.
- **Advanced:** Usa a API Trace.moe para encontrar o episódio e o tempo exato da cena.

### `/converter_moeda`

Converte moedas fiduciárias e criptomoedas em tempo real.

- **Valor:** Montante numérico a ser convertido.
- **De:** Código de origem (Ex: USD, EUR, BTC).
- **Para:** Código de destino (Ex: BRL).
- **Advanced:** Utiliza uma API de câmbio em tempo real integrada com cache físico diário (JSON) no bot e fallback inteligente para moedas menos comuns. Totalmente integrada à IA via chat.

---

## 🎮 Jogos & Downloads

### `/buscar_jogo`

Procura torrents/magnets de jogos de forma abrangente.

- **Nome:** Título do jogo.
- **Advanced:** Pesquisa refinada nas bases de dados da FitGirl e DODI Repacks. Agora inclui um paginador com botões para alternar as páginas de 5 em 5 itens diretamente no Discord.

---

## 🏪 Consulta na Loja

### `/steam_jogo`

Consulta informações oficiais, preço e status na loja da Steam.

- **Nome:** Nome do jogo para pesquisar.
- **Advanced:** Retorna preço regional, porcentagem de desconto, desenvolvedores e pontuação do Metacritic. A IA fará um pequeno comentário sobre o preço ou o jogo se os servidores estiverem online.

---

## 📺 YouTube e Twitch

Avisos automáticos por servidor (checagem a cada 5 min no YouTube e 2 min na Twitch).

- **`/yui-seguir-youtube canal: canal_discord: cargo:`** Avisa novos vídeos, Shorts e lives (`notificar_videos`, `notificar_shorts`, `notificar_lives`).
- **`/yui-seguir-twitch streamer: canal_discord: cargo:`** Avisa quando o streamer entra ao vivo.
- **`/yui-listar-seguindo`:** Lista o que o servidor segue.
- **`/yui-parar-seguir plataforma: alvo:`** Para de seguir.

---

## ⚙️ Configuração & Administração

### `/yui-status`

Mostra o estado da Yui: versão, tempo ligada, provedor de IA em uso (incluindo o Gateway) e saúde dos serviços, com uma linha sobre a voz falada (TTS): se está ativa, o provedor, quantas falas fez e quantas foram recusadas.

### `/yui-configurar` (Server Admin)

Escolhe os canais de notícias, diário e semanal do GTA Online no servidor.

### `/yui-servidor` (Server Admin)

Painel gráfico unificado e público no chat para administração do servidor.

- **Personalidade & Humor:** Define instruções customizadas (prompts) e estados emocionais para a IA no canal.
- **Mensagens Espontâneas:** Controla o status (ativado/desativado) e a frequência em que a IA se intromete nas conversas.
- **Canal de Updates:** Define o canal oficial para receber comunicados de atualizações.
- **Respostas a Mentions:** Configura se a IA deve responder quando o servidor for mencionado em `@everyone` ou `@here`.
- **Ferramentas MCP:** Abre o Gerenciador Gráfico de Ferramentas MCP com lista de ativas/desativadas, descrições detalhadas e botões de ativar/desativar.

### `/yui-criador` (Dono / Criador)

Central de Controle Master para gerenciamento global da rede Yui (oculta e restrita ao criador).

- **Subcomando `painel` / `dashboard`:** Abre o Dashboard Master por botões.
- **Modelos:** Configura o modelo LLM ativo e exibição de modelo/pensamento.
- **Banir / Desbanir / Lista de Bans:** Gerencia a lista negra global de usuários, servidores e canais banidos (o motivo vale até 300 caracteres).
- **AutoMod:** Alterna o modo de moderação automática (Off / Monitor / Strict).
- **Ferramentas MCP:** Gerencia a ativação de ferramentas MCP por servidor.
- **Bot Config:** Abre as configurações de Runtime da IA.
- **Subcomando `memorias`:** Administra a memória dos usuários **sem ver o conteúdo**: lista quem tem memória e a quantidade de lembranças, e apaga uma lembrança ou tudo de um usuário. Também disponível no app, em **Admin → Memória**.

> Para controlar a Yui por um painel gráfico (servidores, banimentos, memória, auditoria, provedores de IA), use o **app da Yui**: [Assistente pessoal](ASSISTENTE_PESSOAL.md).

### `/yui-ferramentas` (Server Admin)

Comando independente para administradores de servidor gerenciarem as ferramentas da IA.

- **Ação `list`:** Exibe um embed público com as ferramentas MCP ativas e desativadas no servidor.
- **Ação `toggle`:** Alterna a disponibilidade de uma ferramenta específica (`join_voice_call`, `search_game`, `generate_image`, etc.). Duas delas vêm **desligadas** e controlam a voz: **🎙️ Assistente de Voz (Call)** (deixa a Yui entrar e sair da call) e **🔊 Resposta por Voz (TTS)** (ela responde falando; a IA nunca enxerga este interruptor). Veja [TTS](TTS.md).
- **Ação `reset`:** Restaura as ferramentas do servidor para os padrões de fábrica.

### `/aceitar_tos` (Server Admin)

Exibe e registra o aceite dos Termos de Serviço da Yui para liberar e autorizar as funções do bot no servidor.

### `/yui-config_ia` (Dono)

Ajusta parâmetros técnicos de baixo nível dos modelos de IA (`Timeout`, `Temperatura`, `Max Tokens`).

---

## 💡 Dicas de Especialista

- 💡 **Privacidade em Primeiro Lugar:** Use o parâmetro `visibilidade: Privado` no comando `/yui` para tratar de assuntos sensíveis ou evitar poluir o chat com textos longos da IA.
- 💡 **Qualidade de Imagem:** Ao usar `/yui-imagem`, capriche no `negative_prompt` com termos como `blurry, deformed, low quality` para forçar a IA a gerar resultados mais nítidos.
- 💡 **Multiversidade de IAs:** Se um provedor de imagem estiver lento, experimente trocar o `provider` manualmente. O `Pollinations` é geralmente o mais estável, enquanto o `Together` oferece modelos FLUX de alta fidelidade.
- 💡 **Histórico de Contexto:** A Yui "lembra" das últimas mensagens do canal. Use isso a seu favor ao pedir resumos ou continuar uma conversa sem precisar repetir tudo.

---

[🏠 Voltar ao Menu Principal](../README.md)
