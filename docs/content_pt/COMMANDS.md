# 🎮 Guia Avançado de Comandos / Advanced Commands Guide

Este documento detalha todos os comandos slash (/) disponíveis na Hikari, suas funcionalidades, parâmetros e permissões.

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

### `/ia_chat`

O comando principal para interagir com o cérebro da Hikari.

- **Prompt:** Sua pergunta ou pedido.
- **Visibilidade:** Escolha entre `Público` (todos veem) ou `Privado` (apenas você vê).
- **Advanced:** Se você mencionar outras pessoas no prompt, a Hikari pode tentar entender o contexto da conversa.

### `/chat_resumo`

Faz a leitura das últimas mensagens e gera um resumo inteligente.

- **Quantidade:** O número de mensagens a analisar (Min: 10, Max: 100).
- **Advanced:** Útil para entender discussões longas que você perdeu.

### `/chat_humor` (Admin)

Altera a "alma" da Hikari em um canal específico.

- **Instrucao:** Novas regras de comportamento (ex: "Fale como um pirata").
- **Mood:** Estado emocional (ex: "Brava", "Feliz").
- **Reset:** Volta às configurações padrão.
- **Advanced:** Essas mudanças persistem apenas no canal onde foram aplicadas.

### `/chat_espontaneo` (Dono)

Configura a Hikari para se intrometer nas conversas sem ser chamada.

- **Estado:** Ativar ou Desativar.
- **Frequência:** Escolha entre `Baixa`, `Média` ou `Alta`.
- **Porcentagem (🔒 Dono):** Chance exata (0-100%) para cada mensagem recebida no canal.

---

## 🎨 Imagens & Arte

### `/ia_imagem`

Gera imagens usando diversos modelos de difusão.

- **Prompt:** Descrição detalhada do que você quer.
- **Negative Prompt:** O que você NÃO quer na imagem.
- **Width/Height:** Dimensões da imagem (512px a 1280px).
- **Provider:** Escolha o gerador (Stability, HuggingFace, Pollinations, etc).
- **Advanced:** O modo `Auto` tentará os provedores em sequência até um funcionar.

---

## 🎵 Multimídia & Utilidades

### `/baixar_musica`

Extrai e converte o áudio de vídeos em formato MP3.

- **URL:** O link do vídeo (YouTube, Instagram Reels ou TikTok).
- **Advanced:** Utiliza `yt-dlp` para baixar a melhor qualidade de áudio e `ffmpeg` para converter em MP3 de forma limpa, limpando os arquivos locais em seguida.

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

### `/ia_config` (Dono)

Ajusta parâmetros técnicos dos modelos de IA.

- **Provider:** Qual IA configurar.
- **Setting:** Escolha entre `Timeout`, `Temperatura` ou `Max Tokens`.
- **Value:** O novo valor numérico.

### `/ia_model_config` (Dono)

Configura a exibição do nome do modelo nas respostas e no pensamento/processamento da IA.

- **Mostrar Modelo:** Exibe ou oculta o nome do modelo na resposta da IA.
- **Mostrar Modelo Pensamento:** Exibe ou oculta o nome do modelo que está processando a resposta no pensamento.

### `/ia_prompt` (Dono)

Modifica o System Prompt do servidor.

- **Set:** Define um novo prompt completo.
- **Reset:** Volta ao padrão.
- **View:** Mostra o prompt atual.

### `/ia_ferramentas` (Admin)

Gerencia quais ferramentas (MCP) a IA pode usar no servidor.

- **Toggle:** Ativa ou desativa ferramentas como `web_search`, `image_gen`, etc.
- **List:** Mostra o status de todas as ferramentas.

### `/ia_mention_todos` (Admin)

Configura se a Hikari deve responder a marcações de `@everyone` e `@here` no servidor.

- **Ativo:** Sim para responder, Não para ignorar.
- **Advanced:** Útil para evitar que a IA se intrometa em avisos globais do servidor, ou para permitir que ela interaja quando o servidor todo for chamado.

### `/aceitar_tos` (Admin)

Aceita os Termos de Serviço da Hikari para liberar e autorizar a utilização de todas as funções do bot neste servidor.

- **Advanced:** Este comando desbloqueia o servidor. Todos os chats e comandos permanecem sob bloqueio completo até que o TOS seja aceito por um administrador.

### `/chat_updates` (Admin)

Configura o canal onde o bot enviará anúncios de atualizações e novas versões do sistema Hikari.

- **Canal (Opcional):** O canal de texto a ser configurado (se deixado em branco, utiliza o canal atual).
- **Advanced:** Servidores novos registram automaticamente o canal onde o TOS foi aceito como chat de updates. Servidores antigos salvam o último chat utilizado.

### `/adm_banir` / `/adm_desbanir` (Dono)

Sistema de banimento global da rede Hikari.

- **Tipo:** Usuário, Servidor ou Canal.
- **ID:** Identificador do alvo.
- **Motivo:** Justificativa do bloqueio.

---

## 💡 Dicas de Especialista

- 💡 **Privacidade em Primeiro Lugar:** Use o parâmetro `visibilidade: Privado` no comando `/ia_chat` para tratar de assuntos sensíveis ou evitar poluir o chat com textos longos da IA.
- 💡 **Qualidade de Imagem:** Ao usar `/ia_imagem`, capriche no `negative_prompt` com termos como `blurry, deformed, low quality` para forçar a IA a gerar resultados mais nítidos.
- 💡 **Multiversidade de IAs:** Se um provedor de imagem estiver lento, experimente trocar o `provider` manualmente. O `Pollinations` é geralmente o mais estável, enquanto o `Together` oferece modelos FLUX de alta fidelidade.
- 💡 **Histórico de Contexto:** A Hikari "lembra" das últimas mensagens do canal. Use isso a seu favor ao pedir resumos ou continuar uma conversa sem precisar repetir tudo.

---

[🏠 Voltar ao Menu Principal](../README.md)
