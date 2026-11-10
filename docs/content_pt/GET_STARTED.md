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

- **SO:** Windows 10/11 (a produção é um notebook com Windows 10; o desenvolvimento, um PC com Windows) ou Linux.
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

### 💻 Instalação no notebook servidor (sem internet)

Foi assim que a produção atual foi montada (veja [Operação](OPERACAO.md#-1-como-a-yui-roda)). O `scripts/instalar-tudo-offline.ps1` instala a Yui e tudo o que ela precisa a partir de um pendrive, **sem internet**. Rode-o pelo `INSTALAR-TUDO.bat`, que pede permissão de Administrador (esse `.bat` fica na pasta `scripts/` local e não vai para o Git, por causa da regra `*.bat`; sem ele, abra o PowerShell como Administrador e rode o `.ps1`). Pode rodar de novo: o que já está instalado é pulado.

No pendrive, ao lado do script, precisam estar:

| Pasta ou arquivo | Conteúdo |
|------------------|----------|
| `Yui\` | Cópia do projeto, com `node_modules` (e o `.env`, se quiser levá-lo pronto; sem ele, o instalador avisa para configurar depois). Sem `node_modules` completo, a verificação final avisa para rodar `npm install` quando houver internet) |
| `instaladores\` | `vc_redist.x64.exe`, `node-v24.14.0-x64.msi`, `python-3.12.10-amd64.exe`, `googlechromestandaloneenterprise64.msi`, `temurin-25-jre-x64.msi` e, opcional, `OpenSSH-Win64.msi` |
| `ferramentas\` | `ffmpeg` e `yt-dlp` |
| `wheels-deemix\`, `wheels-spotdl\` | Pacotes Python para criar os ambientes sem internet |
| `minecraft\` | Arquivos do servidor de Minecraft (Paper) |
| `instalar-ssh.ps1` | Chamado pelo instalador no passo do SSH |

O que ele faz, em ordem: instala Visual C++, Node.js 24, Python 3.12 e Chrome; copia `ffmpeg` e `yt-dlp` para `C:\Tools\bin` (no PATH da máquina); copia a Yui para `C:\Yui` (`-Destino`), guardando antes uma cópia `.env.bak-...` se já houver um `.env`; cria `.venv-deemix` e `.venv-spotdl` e ajusta o `PYTHON_PATH` do `.env` (e avisa se `YUI_PROJECTS`, `YUI_FILE_ROOTS` ou `YUI_EDITOR_COMMAND` ainda apontam para o PC antigo); configura o SSH (`-PublicKey "ssh-ed25519 ..."` já instala a sua chave); registra as tarefas `YuiBot` e `YuiWebApp` como conta SYSTEM, na inicialização do sistema, 45 s e 50 s depois do boot (a `YuiWebApp` só se existir `apps\yui-app\dist`); instala o Java e o servidor de Minecraft em `C:\Minecraft` (porta 25565 liberada só para a rede local; `-MinecraftAutoIniciar` cria a tarefa `MinecraftServer`); e confere `node`, `npm`, `ffmpeg`, `yt-dlp`, `spotdl` e se o `discord.js` carrega.

Nada é iniciado na hora: **reinicie o notebook uma vez** e as tarefas sobem sozinhas. A tarefa `YuiAtualizar` (atualização diária pelo GitHub) **não** é criada pelo instalador; veja [Operação](OPERACAO.md#-7-atualizar-o-código).

Dois scripts de apoio, ambos para rodar como Administrador:

- **`scripts/instalar-ssh.ps1`**: instala o OpenSSH Server no Windows 10, inclusive em português (pelo `OpenSSH-Win64.msi`, se estiver ao lado, ou pelo Windows Update), deixa o serviço automático, libera a porta 22 **só para a rede local**, põe o PowerShell como shell padrão, grava a chave de `-PublicKey` em `administrators_authorized_keys` e, com `-DesativarSenha` (só junto com `-PublicKey`), passa a aceitar só chave. Também desliga a suspensão, a hibernação e a ação de fechar a tampa com o notebook na tomada. No fim mostra o `ssh usuario@IP` e sugere reservar o IP no roteador.
- **`scripts/otimizar-windows.ps1`**: **por padrão só simula** e mostra o que faria; altera de verdade apenas com `-Aplicar`, criando antes um ponto de restauração (log em `C:\Tools\otimizar-windows.log`). Desliga Copilot, Cortana e pesquisa na web, widgets, sugestões e anúncios, telemetria (no mínimo), apps em segundo plano, OneDrive, hibernação e inicialização rápida, além de serviços e apps dispensáveis; limita a varredura do Defender a 20% da CPU (a proteção continua ligada). Mantém o Windows Update (só impede o reinício automático com alguém logado), o Firewall, o UAC e o SSH.

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

No Windows, o `Yui.bat` oferece um menu. Para a Yui **subir sozinha com o Windows** e se religar após falhas, use as tarefas agendadas descritas em [Operação](OPERACAO.md#-1-como-a-yui-roda) (na produção, `YuiBot` e `YuiWebApp` como conta SYSTEM, na inicialização do sistema); não use o PM2 no Windows.

> ⚠️ Rode **uma única instância** por token do Discord; duas fariam a Yui responder em dobro. A produção já roda no notebook servidor: no PC de desenvolvimento, `npm start`, `npm run dev` e a opção `1` do `Yui.bat` com o mesmo token criariam uma segunda Yui (o `Yui.bat` não enxerga a do notebook). Para testar no PC, use um bot de testes com outro token ou desative antes a `YuiBot` do notebook ([Operação](OPERACAO.md#-3-iniciar-parar-e-reiniciar)).

---

## 🧭 6. Primeiros ajustes no Discord

1. `/yui-configurar` para escolher os canais de **notícias**, **diário** e **semanal** do servidor.
2. Se `REQUIRE_TOS=true`, aceite os termos do servidor.
3. Teste: `/gta-diario` e `/yui mensagem: oi`.
4. Quer o app, o painel e a assistente pessoal? Veja [Assistente pessoal](ASSISTENTE_PESSOAL.md) e [Yui API](YUI_API.md).

### 💡 Dicas

- **Propagação:** comandos globais podem levar até 1 hora para aparecer. Defina `DISCORD_GUILD_ID` para testar na hora em um servidor.
- **Permissões de escrita:** sem escrita em `src/data` e `database`, configurações e bancos falham.
- **Bloqueios do YouTube:** em servidores de nuvem (como a AWS), o yt-dlp pode precisar de cookies (`YTDLP_COOKIES_PATH`).
- **Voz parada:** se `/entrar-call` ou o Modo Rádio responderem que faltam componentes de áudio, rode `npm install` (instala o Opus) e reinicie. O log da inicialização mostra `[MediaTools] Opus: OK` quando está certo.
- **A Yui entra na call mas não fala:** a resposta falada vem **desligada** em cada servidor. Ligue **🔊 Resposta por Voz (TTS)** (e **🎙️ Assistente de Voz (Call)**, que o `/entrar-call` exige) em `/yui-ferramentas`, reinicie a Yui se acabou de atualizar o código e chame por voz começando a frase com "Yui". Veja o [guia de TTS](TTS.md).
- **Teste antes de ligar:** `npm run test:media`, `npm run test:deezer`, `npm run test:spotdl` e os demais `test:*` rodam sem rede e sem tocar nos seus dados (lista em [README_TESTES.md](../../README_TESTES.md)).
- **Anexo de até 10 MB:** o servidor comum aceita 10 MB por anexo (50 MB no Boost nível 2 e 100 MB no nível 3). Um MP3 maior que isso é recomprimido automaticamente (192, 128 e 96 kbps) até caber; `YUI_UPLOAD_LIMIT_MB` ajusta a base e `YUI_AUDIO_REENCODE=false` desliga a recompressão.

---

[🏠 Voltar ao Menu Principal](../README.md)
