# 🚀 Guia de Instalação e Início Rápido (Get Started)

Bem-vindo ao guia técnico de implantação da **Yui**. Este documento detalha como preparar o ambiente, gerenciar dependências e realizar a primeira inicialização do sistema.

---

## 📂 Sumário

1. [🖥️ 1. Requisitos do Sistema](#-1-requisitos-do-sistema)
2. [📥 2. Instalação Passo a Passo](#-2-instalação-passo-a-passo)
3. [🎮 3. Banco de Dados de Jogos (FitGirl & DODI)](#-3-banco-de-dados-de-jogos-fitgirl--dodi)
4. [🚀 4. Execução](#-4-execução)

---

## 🖥️ 1. Requisitos do Sistema

Para uma operação estável, a instância deve atender aos seguintes requisitos:

### ⚙️ Hardware e SO

- **SO:** Linux (Kernel 5.4+) recomendado para melhor performance com `ffmpeg`. Windows 10/11 também suportado.
- **Node.js:** Versão **v22.x (LTS)**. O código utiliza sintaxes modernas e módulos CJS que performam melhor nesta versão.
- **Memória:** Mínimo de 1GB RAM (processamento de fila de IA).

### 📦 Dependências Externas (Obrigatório)

O bot depende de binários externos para processamento de mídia:

1.  **yt-dlp:** Deve estar no `PATH`. Usado para extração e download de streams do YouTube.
2.  **ffmpeg:** Necessário para conversão de áudio e extração de metadados.

---

## 📥 2. Instalação Passo a Passo

### ⚡ Método Rápido (Recomendado)
Para automatizar a verificação de ambiente e instalação de dependências (incluindo binários externos), utilize os scripts na raiz do projeto:

- **Windows:** Clique no arquivo `setup.bat`.
- **Linux:** `chmod +x setup.sh && ./setup.sh`.

---

### 🛠️ Método Manual
1.  **Clone o Repositório:**

    ```bash
    git clone https://github.com/MauroBragaFilho/Yui.git
    cd Yui
    ```

2.  **Instalação de Módulos (NPM):**

    ```bash
    npm install
    ```

    _Isso instalará pacotes críticos como `discord.js`, `axios` (requests), `cheerio` (scraping) e `@gradio/client`._

3.  **Configuração de Ambiente de Dados:**
    A Yui exige que certas pastas existam para cache e persistência:
    - `src/data/temp_images/` (Gerado automaticamente, mas garanta permissão de escrita).
    - `src/data/x.json` (Banco global).

---

## 🎮 3. Banco de Dados de Jogos (FitGirl & DODI)

A funcionalidade de busca de jogos (`/buscar_jogo`) não funciona por mágica; ela lê uma biblioteca local de metadados.

1.  Acesse o portal [Hydra Library](https://library.hydra.wiki/).
2.  Baixe os arquivos **JSON** correspondentes aos repacks da **FitGirl** e **DODI**.
3.  Renomeie e mova-os para:
    - `src/data/fitgirl.json`
    - `src/data/dodi.json`

---

## 🚀 4. Execução

Uma vez configurado o arquivo `.env` (Veja o [Guia de Ambiente](./ENVIRONMENT.md)), inicie o processo:

```bash
# Modo standard
node index.js

# Recomendado para produção (usa auto-restart em caso de falha)
npx pm2 start index.js --name yui
```

### 💡 Dicas de Especialista:

- 💡 **Propagação Global:** No Discord v14+, comandos registrados via `rest.put` podem levar até 5 minutos para aparecer. Re-logar no cliente Discord força a atualização do cache UI.
- 💡 **Permissões de Escrita:** Certifique-se de que o usuário que roda o script tem permissão total na pasta `src/data`, caso contrário, os filtros de busca e bancos de dados falharão silenciosamente.
- 💡 **Proxy/VPN:** Se sua hospedagem for em Oracle Cloud ou AWS, você pode precisar de um agente de user-agent rotativo ou proxy para o comando `/baixar_musica` evitar bloqueios do YouTube.

---

[🏠 Voltar ao Menu Principal](../README.md)
