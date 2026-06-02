# ✨ Funcionalidades, IA e Processamento de Mídia

A Hikari não é apenas um wrapper de chat. Ela é um ecossistema de processamento as síncrono que combina LLMs, difusão de imagens e extração de metadados.

---

## 📂 Sumário

1. [🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt](#-1-inteligência-artificial-o-ciclo-de-vida-do-prompt)
2. [🎨 2. Geração de Imagens (Hierarquia de Provedores)](#-2-geração-de-imagens-hierarquia-de-provedores)
3. [🎵 3. Processamento de Áudio e YouTube](#-3-processamento-de-áudio-e-youtube)
4. [💡 Dicas de Uso Avançado](#-dicas-de-uso-avançado)

---

## 🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt

A Hikari processa todas as mensagens de IA através de uma **Fila Global (`processingQueue`)**.

### Fluxo de Resposta:

1.  **Captura de Contexto:** A Hikari lê as últimas 5 a 10 mensagens do canal (Short-term memory) para garantir coerência.
2.  **Identificação de Gatilhos:** O bot responde se:
    - For mencionado (`@Hikari`).
    - O texto conter a palavra "Hikari".
    - Houver uma resposta direta (reply) à mensagem dela.
3.  **Processamento Multimodal:** Se houver uma imagem anexa, ela é enviada junto ao prompt para análise Vision (sujeito à capacidade do modelo configurado). (Ainda não implementado)
4.  **Parsing de Ferramentas:** A saída da IA é passada por um parser JSON que detecta se ela "decidiu" usar uma ferramenta (Busca Web, Imagem, Música).

---

## 🎨 2. Geração de Imagens (Hierarquia de Provedores)

A Hikari possui um motor de fallback agressivo para garantir que o usuário receba sua arte, mesmo que as APIs principais falhem.

**Ordem de Execução:**

1.  **Stability AI (Ultra/Core):** Se houver uma `STABILITY_API_KEY`. Qualidade fotorealista.
2.  **Gradio/SDXL-Flash:** Fallback gratuito de alta velocidade.
3.  **HuggingFace (FLUX.1):** Modelos SOTA rodando em endpoints de inferência.
4.  **Stable Horde:** Rede descentralizada de GPUs (uso sob demanda).
5.  **Pollinations:** O fallback definitivo para 100% de disponibilidade.

---

## 🎵 3. Processamento de Mídia (Áudio, Vídeo e Compressão)

Implementamos um sistema completo de download e manipulação de mídia via `youtubeAudioHandler.js`.

- **Suporte Multplataforma:** O bot suporta download de áudio e vídeo de plataformas populares, como YouTube (geral para áudio, apenas Shorts para vídeo), Instagram Reels e TikTok (incluindo subdomínios como `vt.tiktok.com`).
- **Download Inteligente de Áudio:** Extração apenas do melhor stream de áudio (`bestaudio`) via `yt-dlp` e conversão dinâmica com `ffmpeg` para MP3.
- **Download de Vídeo com Metadados:** Ao baixar vídeos, a Hikari pode extrair o uploader original e a descrição para exibição rica no chat, configurável via parâmetro.
- **Compressão Inteligente:** Se o arquivo de vídeo ultrapassar o limite de upload do servidor (detectado dinamicamente: 25MB para padrão, 50MB para Boost Nível 2 e 100MB para Boost Nível 3), o usuário recebe a opção de iniciar a compressão.
- **Fila Global & Proteção da Host:** O processo de compressão FFMPEG roda em uma fila global (apenas uma compressão simultânea) para preservar os recursos da VPS. Há um monitor de RAM ativo: se o uso de memória passar de 95%, a compressão é cancelada imediatamente para evitar travamento do servidor.
- **Limitação de Uso:** Há uma limitação estrita de 1 download/processo ativo por usuário ao mesmo tempo para evitar sobrecarga.
- **Cleanup Automático:** Todos os arquivos temporários são deletados após o envio. Vídeos grandes que aguardam compressão expiram após 6 horas.

---

## 💡 Dicas de Uso Avançado

- 💡 **Resumo de Chat (`/chat_resumo`):** A IA lê as últimas N mensagens e cria um mapeamento semântico de quem falou o que e sobre quais tópicos. Excelente para gerenciar canais movimentados.
- 💡 **Trace.moe Integration:** A função `/anime_origem` permite que você encontre animes apenas enviando um frame. Ela retorna o título, episódio e o timestamp aproximado.
- 💡 **Busca de Jogos e Preços da Steam:** A Hikari não apenas busca links Magnéticos em bases de dados, mas também pode consultar nativamente a **Steam**! Basta perguntar naturalmente como "O Elden Ring está em promoção na Steam?" e ela retornará dados atualizados, preços e sinopse, além de fazer um comentário divertido.
- 💡 **Conversor de Moedas e Cripto:** Converta qualquer valor entre moedas reais (BRL, USD, EUR) ou cripto (BTC, ETH) apenas perguntando "quanto tá o bitcoin hoje?". Ela usa APIs financeiras com cache local de expiração diária e fallback automático.
- 💡 **Visão Computacional e Edição:** A Hikari possui regras claras avisando que ela não realiza edições de imagens existentes e não possui visão computacional nativa em tempo real.

---

> [!TIP]
> Para ver a lista completa de comandos e explicações detalhadas, veja o [Guia de Comandos](./COMMANDS.md).

---

[🏠 Voltar ao Menu Principal](../README.md)
