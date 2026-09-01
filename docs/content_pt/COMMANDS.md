# 🎮 Guia Avançado de Comandos / Advanced Commands Guide

Este documento detalha todos os comandos slash (/) disponíveis na Yui, suas funcionalidades, parâmetros e permissões.

---

## 📂 Sumário

1. [🧠 IA & Chat](#-ia--chat)
2. [🎨 Imagens & Arte](#-imagens--arte)
3. [🎵 Multimídia & Utilidades](#-multimídia--utilidades)
4. [🎮 Jogos & Downloads](#-jogos--downloads)
5. [🏪 Consulta na Loja](#-consulta-na-loja)
6. [⚙️ Configuração & Administração](#-configuração--administração)
7. [💡 Dicas de Especialista](#-dicas-de-especialista)

---

## 🧠 IA & Chat

### `/yui`

O comando principal para interagir com o cérebro da Yui.

- **Prompt:** Sua pergunta ou pedido.
- **Visibilidade:** Escolha entre `Público` (todos veem) ou `Privado` (apenas você vê).
- **Advanced:** Se você mencionar outras pessoas no prompt, a Yui pode tentar entender o contexto da conversa.

### `/chat_resumo`

Faz a leitura das últimas mensagens e gera um resumo inteligente.

- **Quantidade:** O número de mensagens a analisar (Min: 10, Max: 100).
- **Advanced:** Útil para entender discussões longas que você perdeu.

### `/chat_humor` (Admin)

Altera a "alma" da Yui em um canal específico.

- **Instrucao:** Novas regras de comportamento (ex: "Fale como um pirata").
- **Mood:** Estado emocional (ex: "Brava", "Feliz").
- **Reset:** Volta às configurações padrão.
- **Advanced:** Essas mudanças persistem apenas no canal onde foram aplicadas.

### `/chat_espontaneo` (Dono)

Configura a Yui para se intrometer nas conversas sem ser chamada.

- **Estado:** Ativar ou Desativar.
- **Frequência:** Escolha entre `Baixa`, `Média` ou `Alta`.
- **Porcentagem (🔒 Dono):** Chance exata (0-100%) para cada mensagem recebida no canal.

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

### `/sair-call`

Desconecta a Yui do canal de voz em que ela está conectada no servidor.

- **Advanced:** Pode ser acionado via comando slash, voz ("Yui, saia da call") ou via ferramenta MCP. Desconecta automaticamente em caso de inatividade quando todos os usuários saem da call.

---

## 🎵 Multimídia & Utilidades

### `/baixar_musica`

Central de downloads de música em MP3 — aceita link ou busca.

- **URL (opcional):** Link do YouTube, Spotify, Instagram ou TikTok.
- **Busca (opcional):** Nome da música e/ou artista (busca no catálogo do Deezer).
- **Advanced:** Detecta automaticamente a origem da URL. Para YouTube/Instagram/TikTok usa `yt-dlp` + `ffmpeg`; para Spotify usa `spot-dlp` nativamente quando disponível, com fallback para `yt-dlp`; para nome/artista usa a API REST do Deezer com o motor `deemix` em MP3 HQ (com menu de seleção interativo em caso de ambiguidade). Detecta o limite de upload do servidor e informa o tamanho do arquivo. Arquivos temporários são removidos após o envio.

### `/baixar_video`

Baixa vídeos e envia em formato MP4 no chat do Discord.

- **URL:** O link do vídeo (YouTube Shorts, Instagram Reels ou TikTok).
- **Descricao (Boolean):** Se verdadeiro, exibe o autor e a descrição do vídeo original na mensagem. Padrão: `false`.
- **Advanced:** Detecta o limite de upload do servidor para aplicar compressão de vídeo em FFMPEG se ultrapassar os limites do Discord. Oferece fila de compressão assíncrona.

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

## ⚙️ Configuração & Administração

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
- **Banir / Desbanir / Lista de Bans:** Gerencia a lista negra global de usuários, servidores e canais banidos.
- **AutoMod:** Alterna o modo de moderação automática (Off / Monitor / Strict).
- **Ferramentas MCP:** Gerencia a ativação de ferramentas MCP por servidor.
- **Bot Config:** Abre as configurações de Runtime da IA.

### `/yui-ferramentas` (Server Admin)

Comando independente para administradores de servidor gerenciarem as ferramentas da IA.

- **Ação `list`:** Exibe um embed público com as ferramentas MCP ativas e desativadas no servidor.
- **Ação `toggle`:** Alterna a disponibilidade de uma ferramenta específica (`join_voice_call`, `search_game`, `generate_image`, etc.).
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
