# 📻 Sistema de Modo Rádio e Streaming de Áudio

O **Modo Rádio** da Hikari é um ecossistema completo de reprodução musical e voz interativa para canais do Discord, combinando streaming progressivo de áudio em tempo real, suporte a múltiplas plataformas e controle autônomo por IA.

---

## 📂 Sumário

1. [🎵 1. Reprodução e Streaming Progressivo (YouTube & PCM)](#-1-reprodução-e-streaming-progressivo-youtube--pcm)
2. [🌐 2. Suporte a Links e Resolução de Mídia](#-2-suporte-a-links-e-resolução-de-mídia)
3. [🎙️ 3. Controle por Voz e Reconhecimento (Whisper STT)](#-3-controle-por-voz-e-reconhecimento-whisper-stt)
4. [🎛️ 4. Interface Gráfica e Controles (Embeds & Botões)](#-4-interface-gráfica-e-controles-embeds--botões)
5. [🧹 5. Limpeza Inteligente e Gerenciamento Temporário](#-5-limpeza-inteligente-e-gerenciamento-temporário)
6. [💡 Dicas e Resolução de Problemas](#-dicas-e-resolução-de-problemas)

---

## 🎵 1. Reprodução e Streaming Progressivo (YouTube & PCM)

O Modo Rádio elimina a necessidade de realizar o download completo de arquivos do YouTube antes de iniciar a reprodução.

- **Streaming em Tempo Real (`youtubeBufferStream.js`)**: Redireciona a saída do `yt-dlp` diretamente para o `ffmpeg`, produzindo um fluxo contínuo de áudio em PCM s16le (48.000 Hz, estéreo 16-bit).
- **Buffer Inicial Mínimo**: Aguarda apenas **4 segundos de áudio** (768.000 bytes) para iniciar o som no Discord em cerca de ~4 segundos após a solicitação.
- **Controle de Fluxo (Backpressure)**: Pausa temporariamente a leitura do processo quando o buffer em memória atinge **20 segundos** (3.840.000 bytes) e retoma a leitura ao cair para **10 segundos**, otimizando a RAM da VPS.
- **Tratamento de Underflow**: Em flutuações de rede, envia pequenos frames de silêncio (20ms) mantendo a sincronia de tempo do `@discordjs/voice` sem derrubar o player.

---

## 🌐 2. Suporte a Links e Resolução de Mídia

A resolução de mídia (`radioProviders.js`) suporta múltiplos formatos com extração instantânea:

- **YouTube & YouTube Music**:
  - Vídeos Individuais (`youtube.com/watch?v=...`, `music.youtube.com/watch?v=...`).
  - Playlists (`youtube.com/playlist?list=...`, `music.youtube.com/playlist?list=...`): Extração via NDJSON (Line-delimited JSON) adicionando todas as faixas válidas à fila.
  - Metadados Rápido: Combina a **YouTube oEmbed API** (~50ms) com o parser do `yt-dlp -j` para resgatar título, artista/canal e capa HD sem falhar em logs de aviso.
- **Spotify**:
  - Resolução inteligente de links de músicas (`open.spotify.com/track/...`), álbuns (`/album/...`) e playlists (`/playlist/...`).
  - Extrai os metadados do Spotify e realiza a busca e correspondência automática do áudio em altíssima qualidade no **Deezer**.
- **Deezer**:
  - Músicas (`deezer.com/.../track/ID`), Playlists (`deezer.com/.../playlist/ID`) e Álbuns (`deezer.com/.../album/ID`).
- **Busca por Nome (Texto Livre)**:
  - Buscas sem link utilizam a API do Deezer com cálculo de confiança fonética. Se o score for `>= 80%`, adiciona a faixa; se for ambíguo, apresenta um menu de escolha no Discord.

---

## 🎙️ 3. Controle por Voz e Reconhecimento (Whisper STT)

- **Comandos de Voz em Tempo Real**: Ouvinte integrado que captura fala de usuários não mutados no canal, decodifica o áudio PCM WAV e envia para a API Whisper.
- **Ferramentas MCP**: Os comandos de voz do rádio acionam nativamente as MCP Tools da Hikari (`radioMCPTools.json`).
- **Autoproteção de Rate Limit (429/492)**: Ao atingir o limite da API do Whisper, a escuta de voz é desativada temporariamente por **1 minuto**, com notificação automática no chat e reativação agendada.
- **Monitoramento de Canal Vazio**: Encerra a sessão e desloga a chamada se não houver usuários humanos no canal por mais de 10 segundos.

---

## 🎛️ 4. Interface Gráfica e Controles (Embeds & Botões)

O painel visual do Rádio (`radioEmbed.js`) fornece controles interativos em tempo real:

- **Controles Disponíveis**:
  - `➕ Adicionar`: Modal interativo para colar links ou pesquisar músicas.
  - `🗑️ Remover`: Modal interativo para remover uma música da lista especificando o número da posição (`#x`).
  - `⏯️ Play/Pause`: Alterna pausa e reprodução.
  - `⏹️ Parar`: Interrompe completamente a reprodução, avança o índice para o final e coloca o rádio em "tocando nada".
  - `⏭️ Próxima` / `⏮️ Anterior`: Navega entre faixas da fila/histórico.
  - `🔀 Embaralhar`: Ativa/desativa ordem aleatória.
  - `🔁 Loop`: Alterna modos (Off ➔ Playlist ➔ Música).
  - `🎙️ Voz`: Ativa ou desativa a escuta por voz. *(Desativada por padrão no servidor para economia de tokens. Caso desativada, exibe aviso para que um Administrador ative a ferramenta `join_voice_call` via `/ia_ferramentas`).*
  - `📋 Fila`: Exibe menu efêmero com as próximas músicas.
  - `👋 Sair`: Encerra o modo rádio e desconecta o bot.
- **Cancelamento Ambíguo**: O botão `Cancelar` nas escolhas de busca ambígua remove os botões da tela e limpa a pendência.

---

## 🧹 5. Limpeza Inteligente e Gerenciamento Temporário

- **Serviço de Limpeza (`radioCleaner.js`)**: Monitora o diretório `src/music/data/temp_radio_audio`.
- **Preservação de Mídia em Execução**: Verifica todas as sessões ativas (`getAllSessions()`) e não deleta arquivos que estejam tocando no momento.
- **Expurgo Automático**: Apaga arquivos inativos com mais de 15 minutos de idade. Roda na inicialização e periodicamente a cada 10 minutos.
- **Configuração no `.gitignore`**:
  ```gitignore
  src/music/data/temp_radio_audio/
  src/music/data/
  ```

---

## 💡 Dicas e Resolução de Problemas

- 💡 **Transição Suave**: O sistema utiliza travas internas (`transitioningGuilds`) para prevenir loops de transição e suprimir erros do tipo `Premature close`.
- 💡 **Exclusão de Mensagens**: Todas as remoções de mensagens temporárias possuem tratamento `.catch(() => {})` contra exceções `Unknown Message`.

---

> [!TIP]
> Para conferir as especificações avançadas das ferramentas da IA, acesse a [Documentação de Tools (MCP)](./ADVANCED.md).

---

[🏠 Voltar ao Menu Principal](../README.md)
