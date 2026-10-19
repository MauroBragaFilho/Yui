# 📚 Documentação da Yui

A Yui começou como um bot de Discord sobre o **GTA Online** e hoje é uma **plataforma**: o bot continua sendo a interface pública, e por baixo existe um **Core** que também a torna uma assistente pessoal, com API, aplicativo próprio e um servidor de IA.

> Esta é a página inicial da documentação. Se você só quer rodar a Yui, comece por [Primeiros passos](content_pt/GET_STARTED.md). Para o dia a dia, veja [Operação](content_pt/OPERACAO.md).

---

## 🗺️ Mapa do sistema

```
                    ┌──────────────────────────────────────────────┐
                    │                  PC (Windows)                │
                    │                                              │
  Discord  ◄──────► │  BOT DO DISCORD ──┐                          │
  (servidores,      │  (comandos, GTA,  │                          │
   DMs)             │   música, voz)    ▼                          │
                    │               YUI CORE ◄──── YUI API (:3939) │ ◄── App web (:8081)
                    │   permissões · memória · persona · Agent     │ ◄── App Android (via Tailscale)
                    │               │                              │
                    │               ▼                              │
                    │   LM Studio → YUI GATEWAY (:20130) → provedores de IA
                    │   (local)      Groq · Gemini · HF · OpenRouter · Cloudflare · Together · Pollinations
                    └──────────────────────────────────────────────┘
```

| Peça | O que é | Onde |
|------|---------|------|
| **Bot do Discord** | Comandos, notícias e resets do GTA Online, música, voz, moderação | `src/discord`, `src/handlers`, `src/engines` |
| **Yui Core** | Permissões, memória, personalidade, Agent e ferramentas | `src/core` |
| **Yui API** | Interface HTTP do Core (login, chat, memória, painel) | `src/core/api` |
| **Yui Gateway** | Servidor de IA próprio, compatível com OpenAI, com failover | `src/gateway` |
| **App da Yui** | Cliente Android e web (chat, **código**, memória, painel do dono) | `apps/yui-app` |
| **Código** | A Yui lendo e editando os seus projetos, com aprovação (aba **Código**; o que era do Jarvis) | `src/core/dev` |
| **Yui Desktop** | A janela do app no computador (Electron), com seletor de pasta e "Iniciar a Yui" | `D:\Projetos\Projeto Jarvis\Yui Desktop` (fora deste repositório) |

---

## 🧭 Por onde começar

| Quero... | Leia |
|----------|------|
| Instalar e rodar a Yui pela primeira vez | [Primeiros passos](content_pt/GET_STARTED.md) |
| Operar no dia a dia (reiniciar, logs, backups, problemas) | [Operação](content_pt/OPERACAO.md) |
| Saber o que cada variável do `.env` faz | [Variáveis de ambiente](content_pt/ENVIRONMENT.md) · [Configuração e governança](content_pt/CONFIGURATION.md) |
| Ver todos os comandos | [Comandos](content_pt/COMMANDS.md) |
| Conhecer os recursos (IA, imagens, mídia, voz) | [Funcionalidades](content_pt/FEATURES.md) · [Rádio](content_pt/RADIO.md) |
| Entender as notícias, resets e eventos semanais do GTA | [GTA Online](content_pt/GTA_ONLINE.md) |
| Moderação, AutoMod e termos de uso | [Moderação](content_pt/MODERATION.md) |
| Entender o Core, a memória, as permissões e o Agent | [Assistente pessoal](content_pt/ASSISTENTE_PESSOAL.md) |
| Usar a API (login, rotas, painel de administração) | [Yui API](content_pt/YUI_API.md) |
| Configurar a IA e os provedores | [Yui Gateway](content_pt/GATEWAY.md) · [Provedores gratuitos](../PROVEDORES_IA_GRATUITOS.md) |
| Deixar a Yui ler e editar meus projetos (aba Código) | [Código](content_pt/CODIGO.md) |
| Comandos do PC, skills e provedores de busca na web | [Comandos e skills](content_pt/COMANDOS_E_SKILLS.md) |
| Instalar ou gerar o app | [App da Yui](../apps/yui-app/README.md) |
| Criar ferramentas (MCP) e mexer na "alma" | [Desenvolvimento avançado](content_pt/ADVANCED.md) |
| Rodar os testes | [Testes](../README_TESTES.md) |

---

## 🟢 Estado atual (resumo)

- A Yui roda **só no PC**, iniciada pelo Agendador de Tarefas do Windows (tarefas `YuiBot` e `YuiWebApp`, com reinício automático). A VPS da AWS está **com o bot parado**.
- **Ativos:** bot do Discord, memória por usuário, Yui API (`127.0.0.1:3939`, publicada na tailnet por HTTPS), app web (`127.0.0.1:8081`), Yui Gateway (`127.0.0.1:20130`).
- **Segurança padrão:** a Yui é **somente leitura** no computador (não apaga, grava, move nem executa programas), tudo escuta só em `127.0.0.1` e o painel de administração é exclusivo do dono.
- **Pendências conhecidas:** streaming das respostas, transporte MCP (Whisper), app em aparelho físico e aprovações nativas na Yui Desktop. Lista completa em [Assistente pessoal](content_pt/ASSISTENTE_PESSOAL.md#-pendências).

---

## 🗄️ Documentos históricos

Registros de como o projeto chegou até aqui, mantidos por referência (podem conter informações superadas): [Resumo da integração](../RESUMO_INTEGRACAO.md) · [Integração dos motores GTA](../INTEGRACAO_MOTORES_GTA.md) · [Documentação inicial](../.docs/README.md).

> A pasta `knowledge/` contém os arquivos de conhecimento que a IA lê antes de responder; veja [knowledge/README.md](../knowledge/README.md).
