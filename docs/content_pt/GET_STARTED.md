# 🚀 Primeiros passos

Como preparar o ambiente e iniciar a Yui pela primeira vez. Para o dia a dia (reiniciar, logs, backups), veja [Operação](OPERACAO.md).

---

## 📂 Sumário

1. [Requisitos](#-1-requisitos)
2. [Instalação](#-2-instalação)
3. [Configuração mínima](#-3-configuração-mínima)
4. [Banco de jogos (opcional)](#-4-banco-de-jogos-opcional)
5. [Execução](#-5-execução)
6. [Primeiros ajustes no Discord](#-6-primeiros-ajustes-no-discord)

---

## 🖥️ 1. Requisitos

- **SO:** Windows 10/11 (uso atual do dono) ou Linux.
- **Node.js 22 ou superior** (a Yui é testada no **24**) e npm.
- **Chrome ou Edge instalado**: usado para ler o evento semanal do Reddit e o Newswire.
- **yt-dlp** e **ffmpeg** para música e mídia. A Yui localiza ou baixa os binários sozinha (`YTDLP_PATH`/`FFMPEG_PATH` só são necessários para usar versões próprias) e mantém o yt-dlp atualizado.
- **Codificador Opus** para entrar em calls e usar o Modo Rádio. Vem com o `npm install` (`opusscript` e `@noble/ciphers` estão no `package.json`); sem ele a Yui recusa a voz e avisa o dono. Veja [Variáveis de ambiente](ENVIRONMENT.md#-voz-e-modo-rádio-opus-e-criptografia).
- **Python 3.12** (opcional) com um ambiente virtual para o `deemix`, que baixa músicas do Deezer em alta qualidade. Sem ele a música continua vindo do YouTube.
- **spotdl** (opcional), num ambiente Python próprio (`.venv-spotdl`, **Python 3.12**), para baixar faixas do Spotify. Sem ele, a faixa do Spotify costuma não baixar (o `yt-dlp` não consegue o áudio do Spotify) e a Yui avisa que o recurso não está disponível; ela não instala o `spotdl`. O relógio do PC precisa estar certo (hora sincronizada). Veja a seção abaixo.
- **Voz do Windows em pt-BR** (opcional) para a Yui **falar** na call (TTS local, sem rede e sem custo; só funciona no Windows). O `setup.ps1` confere se existe uma voz pt-BR. O guia [TTS](TTS.md) mostra como conferir a voz, ligar a fala em cada servidor (vem desligada) e resolver problemas; as variáveis estão em [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local).
- **Memória:** 1 GB de RAM no mínimo.
- Um bot criado no [Discord Developer Portal](https://discord.com/developers/applications) com as *intents* de mensagens e membros ligadas.

---

## 📥 2. Instalação

**Método rápido (Windows):** execute `setup.bat` (ou `setup.ps1`); ele verifica o ambiente, instala as dependências, confere o Opus e, se você quiser, cria o ambiente Python do `deemix`.

**Método manual:**

```bash
git clone https://github.com/MauroBragaFilho/Yui.git
cd Yui
npm install
```

As pastas de dados (`database/`, `logs/`, `src/data/`) são criadas sozinhas, mas o usuário que roda a Yui precisa de permissão de escrita nelas.

### 🐍 Deezer (opcional): ambiente Python do deemix

O `deemix` roda num ambiente virtual dentro do projeto (a pasta `.venv-deemix` não vai para o Git). Na pasta do projeto:

```powershell
py -3.12 -m venv .venv-deemix
.venv-deemix\Scripts\python.exe -m pip install -r requirements-deemix.txt
```

No `.env`, aponte para o Python do ambiente e informe o cookie `arl` da sua conta Deezer (segredo; nunca versione):

```env
PYTHON_PATH=D:\Projetos\Yui\.venv-deemix\Scripts\python.exe
DEEZER_ARL=seu_cookie_arl
```

O `setup.ps1` faz a parte do ambiente se você aceitar o passo opcional. Reinicie a Yui depois de mexer no `.env`.

### 🟢 Spotify (opcional): ambiente Python do spotdl

O `spotdl` também roda num ambiente virtual dentro do projeto (a pasta `.venv-spotdl` não vai para o Git). O `setup.ps1` **não** cria este ambiente; faça na pasta do projeto:

```powershell
py -3.12 -m venv .venv-spotdl
.venv-spotdl\Scripts\python.exe -m pip install --only-binary=:all: -c requirements-spotdl.lock.txt -r requirements-spotdl.txt
```

O `requirements-spotdl.lock.txt` fixa as versões testadas. A Yui acha o `spotdl` sozinha (`SPOTDL_PATH`, se você definir um **arquivo** `.exe`; depois `.venv-spotdl\Scripts\spotdl.exe`; depois o `PATH`), então não precisa configurar mais nada. Na inicialização o log mostra `[MediaTools] Spotdl: OK` ou `FALTANDO`.

Duas armadilhas conhecidas: nenhuma pasta do caminho de `src/data/temp_spotify` (incluindo as pastas acima dela, como a pasta do projeto) pode começar com `.` nem terminar com `.`, `*` ou `$`, senão o pedido falha cedo; e o relógio do PC precisa estar certo, senão o Spotify recusa o acesso. Mais detalhes, limites e como atualizar em [Variáveis de ambiente](ENVIRONMENT.md#-spotify-ambiente-python-do-spotdl).

---

## 🔑 3. Configuração mínima

Crie o arquivo `.env` na raiz (nunca o versione):

```env
DISCORD_TOKEN=seu_token
DISCORD_CLIENT_ID=id_da_aplicacao
OWNER_ID=seu_id_do_discord
```

Para a IA responder, configure ao menos um provedor (por exemplo `GEMINI_API_KEY` ou `GROQ_API_KEY`). Todas as opções estão em [Variáveis de ambiente](ENVIRONMENT.md).

---

## 🎮 4. Banco de jogos (opcional)

A busca de jogos lê uma biblioteca local de metadados:

1. Acesse a [Hydra Library](https://library.hydra.wiki/).
2. Baixe os JSON dos repacks da **FitGirl** e da **DODI**.
3. Salve como `src/data/fitgirl.json` e `src/data/dodi.json`.

---

## ▶️ 5. Execução

```bash
npm start                   # inicia a Yui (node src/index.js)
npm run dev                 # modo desenvolvimento, reinicia ao editar o código
npm run deploy:commands     # registra os slash commands manualmente (a Yui também faz isso ao iniciar)
```

No Windows, o `Yui.bat` oferece um menu. Para a Yui **subir sozinha com o Windows** e se religar após falhas, use as tarefas agendadas descritas em [Operação](OPERACAO.md); não use o PM2 no PC.

> ⚠️ Rode **uma única instância** por token do Discord; duas fariam a Yui responder em dobro.

---

## 🧭 6. Primeiros ajustes no Discord

1. `/yui-configurar` para escolher os canais de **notícias**, **diário** e **semanal** do servidor.
2. Se `REQUIRE_TOS=true`, aceite os termos do servidor.
3. Teste: `/gta-diario` e `/yui mensagem: oi`.
4. Quer o app, o painel e a assistente pessoal? Veja [Assistente pessoal](ASSISTENTE_PESSOAL.md) e [Yui API](YUI_API.md).

### 💡 Dicas

- **Propagação:** comandos globais podem levar até 1 hora para aparecer. Defina `DISCORD_GUILD_ID` para testar na hora em um servidor.
- **Permissões de escrita:** sem escrita em `src/data` e `database`, configurações e bancos falham.
- **Bloqueios do YouTube:** em servidores de nuvem (AWS, Oracle), o yt-dlp pode precisar de cookies (`YTDLP_COOKIES_PATH`).
- **Voz parada:** se `/entrar-call` ou o Modo Rádio responderem que faltam componentes de áudio, rode `npm install` (instala o Opus) e reinicie. O log da inicialização mostra `[MediaTools] Opus: OK` quando está certo.
- **A Yui entra na call mas não fala:** a resposta falada vem **desligada** em cada servidor. Ligue **🔊 Resposta por Voz (TTS)** (e **🎙️ Assistente de Voz (Call)**, que o `/entrar-call` exige) em `/yui-ferramentas`, reinicie a Yui se acabou de atualizar o código e chame por voz começando a frase com "Yui". Veja o [guia de TTS](TTS.md).
- **Teste antes de ligar:** `npm run test:media`, `npm run test:deezer`, `npm run test:spotdl` e os demais `test:*` rodam sem rede e sem tocar nos seus dados (lista em [README_TESTES.md](../../README_TESTES.md)).
- **Anexo de até 10 MB:** o servidor comum aceita 10 MB por anexo (50 MB no Boost nível 2 e 100 MB no nível 3). Um MP3 maior que isso é recomprimido automaticamente (192, 128 e 96 kbps) até caber; `YUI_UPLOAD_LIMIT_MB` ajusta a base e `YUI_AUDIO_REENCODE=false` desliga a recompressão.

---

[🏠 Voltar ao Menu Principal](../README.md)
