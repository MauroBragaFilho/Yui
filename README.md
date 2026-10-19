# 🤖 Yui

**Yui** é um bot de Discord sobre o **GTA Online** que evoluiu para uma plataforma: além de notícias, resets e eventos semanais, ela tem memória por usuário, uma **assistente pessoal** para o dono, uma **API**, um **aplicativo** (Android e web) e um **servidor de IA próprio** com failover entre provedores.

> 📚 **Documentação completa:** [docs/README.md](docs/README.md)

---

## ✨ O que ela faz

**No Discord**
- 📰 **GTA Online:** notícias do Rockstar Newswire, reset diário (Van de Armas, Traficantes, Colecionáveis, Desafios Contra o Relógio) e o evento semanal do r/gtaonline, traduzido e com embed paginado. [Detalhes](docs/content_pt/GTA_ONLINE.md)
- 🧠 **IA conversacional** com busca na web, geração de imagens, resumo de chat e ferramentas (MCP). [Recursos](docs/content_pt/FEATURES.md)
- 🎵 **Música e mídia:** download de áudio/vídeo, modo rádio e assistente de voz em calls. [Rádio](docs/content_pt/RADIO.md)
- 📺 **Avisos de YouTube e Twitch** por servidor.
- 🛡️ **Moderação:** termos de uso por servidor, AutoMod em três níveis e banimento global. [Moderação](docs/content_pt/MODERATION.md)
- 💾 **Memória por usuário:** lembra preferências e fatos (30 dias sem interação); cada um vê e apaga a sua com `/yui-memoria`.

**Assistente pessoal (só para o dono)**
- 🔐 **Memória permanente**, usada só em DM e canais privados, com personalidade própria.
- 🛠️ **Agent com ferramentas** (informações do PC, busca de arquivos, abrir projetos), em **modo somente leitura**: ela não apaga, grava, move nem executa programas.
- 📱 **App da Yui** (Android e web) com chat, memória e **painel de administração**; entrada por usuário e senha ou por **chave de uso único enviada por DM no Discord**. [Assistente pessoal](docs/content_pt/ASSISTENTE_PESSOAL.md) · [API](docs/content_pt/YUI_API.md)
- ⌨️ **Código:** a aba **Código** do app deixa a Yui ler e, com a sua aprovação a cada ação, editar os seus projetos e rodar comandos, **só pelo seu computador** (o que o Projeto Jarvis queria ser, dentro da mesma Yui). Somente leitura por padrão. [Código](docs/content_pt/CODIGO.md)
- 🔔 **Avisos automáticos:** a Yui manda DM ao dono quando a IA cai, um provedor fica sem crédito, há erro grave, tarefa agendada falha ou alguém erra o login várias vezes. [Operação](docs/content_pt/OPERACAO.md)
- 🖥️ **Painel completo no app:** integrações, servidores (canais e seguidos), rádio, IA (chaves e provedores, como o OmniRoute), logs, auditoria e mensagem no seu Discord.

**Infraestrutura**
- 🧭 **Yui Gateway:** servidor de IA compatível com a API OpenAI que tenta Groq, Gemini, Hugging Face, OpenRouter, Cloudflare, Together e Pollinations com failover, rodízio de chaves e descanso progressivo. Entra na cadeia logo depois do LM Studio. [Gateway](docs/content_pt/GATEWAY.md)

---

## 🏗️ Arquitetura

```
 Discord ◄──► Bot ──► YUI CORE ◄── Yui API ◄── App (web / Android)
                        │  permissões · memória · persona · Agent
                        ▼
              LM Studio → Yui Gateway → Groq · Gemini · HF · OpenRouter · ...
```

Os adaptadores (Discord, API, apps) dependem do Core; o Core nunca depende deles. A autorização é sempre decidida pelo backend, nunca pelo modelo de IA. O mapa completo está em [docs/README.md](docs/README.md).

---

## 🚀 Início rápido (Windows)

Requisitos: **Node.js 22 ou superior** (testado no 24), npm, e um bot criado no [Discord Developer Portal](https://discord.com/developers/applications).

```bash
git clone https://github.com/MauroBragaFilho/Yui.git
cd Yui
npm install
```

Crie o arquivo `.env` na raiz (veja o [guia de variáveis](docs/content_pt/ENVIRONMENT.md)); o mínimo é:

```env
DISCORD_TOKEN=seu_token
DISCORD_CLIENT_ID=id_da_aplicacao
OWNER_ID=seu_id_do_discord
```

Inicie:

```bash
npm start            # ou use o Yui.bat (menu) no Windows
```

No Discord, use `/yui-configurar` para escolher os canais de notícias, diário e semanal. Para deixar a Yui subindo sozinha com o Windows, veja [Operação](docs/content_pt/OPERACAO.md).

---

## 🔒 Segurança em resumo

- **Somente leitura por padrão** no computador do dono (`YUI_READ_ONLY`).
- API, app web e gateway escutam **só em `127.0.0.1`**; acesso remoto é pelo **Tailscale** (nunca pela internet).
- Senha do painel com **hash scrypt**; chaves de IA nunca vão para log nem para erros.
- O painel de administração **não** controla o modo somente leitura, a senha nem os tokens de acesso: isso só muda no `.env`. As chaves de IA podem ser adicionadas pelo painel, mas só entram: nunca voltam (`YUI_PANEL_AI_EDIT=false` trava).
- Memória pessoal e pública ficam em **bancos separados**, e a pessoal nunca é versionada.

---

## 🧪 Testes

```bash
npm run test:gateway   # servidor de IA
npm run test:panel     # login, chave por DM e painel
npm run test:core      # permissões e memória
```

Lista completa e o que cada suíte cobre: [README_TESTES.md](README_TESTES.md). O app tem testes próprios em `apps/yui-app`.

---

## 📁 Estrutura

```
src/
  core/        Yui Core: permissões, memória, persona, Agent, API
  gateway/     Yui Gateway (servidor de IA)
  discord/     Comandos, embeds e publicação no Discord
  engines/     Motores do GTA Online, Newswire, YouTube, Twitch
  handlers/    IA (llmHandler), moderação, mídia, voz, jogos
  scheduler/   Tarefas agendadas (resets, checagens, limpeza)
  data/        Dados de runtime e cache
apps/yui-app/  App Android e web (Expo / React Native)
database/      Bancos SQLite (sql.js)
docs/          Documentação
tests/         Testes
scripts/       Utilitários (servidor de desenvolvimento, senha do painel)
```

---

## 📄 Licença

MIT. Projeto de [MauroBragaFilho](https://github.com/MauroBragaFilho).
