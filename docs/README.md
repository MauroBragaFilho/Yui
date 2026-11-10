# 📚 Documentação da Yui

A Yui começou como um bot de Discord sobre o **GTA Online** e hoje é uma **plataforma**: o bot continua sendo a interface pública, e por baixo existe um **Core** que também a torna uma assistente pessoal, com API, aplicativo próprio e um servidor de IA.

> Esta é a página inicial da documentação. Se você só quer rodar a Yui, comece por [Primeiros passos](content_pt/GET_STARTED.md). Para o dia a dia, veja [Operação](content_pt/OPERACAO.md).

---

## 🗺️ Mapa do sistema

```
                    ┌────────────────────────────────────────────────────────┐
                    │    NOTEBOOK SERVIDOR (Windows 10, Wi-Fi, C:\Yui)       │
                    │    YuiBot e YuiWebApp sobem no boot (conta SYSTEM)     │
                    │                                                        │
  Discord  ◄──────► │  BOT DO DISCORD ──┐                                    │
  (servidores,      │  (comandos, GTA,  │                                    │
   DMs)             │   música, voz)    ▼                                    │
                    │               YUI CORE ◄──── YUI API (:3939)           │ ◄── App web (:8081)
                    │   permissões · memória · persona · Agent               │ ◄── App Android (via Tailscale)
                    │               │                                        │
                    │               ▼                                        │
                    │   LM Studio (se houver) → YUI GATEWAY (:20130) → provedores de IA
                    │   Groq · Gemini · HF · OpenRouter · Cloudflare · Together · Pollinations
                    │   + provedores próprios, como o OmniRoute (:20128, no mesmo notebook)
                    └────────────────────────────────────────────────────────┘
                                       ▲  YuiAtualizar (1x por dia): baixa o main,
                                       │  copia para C:\Yui e reinicia a YuiBot
  PC de desenvolvimento ── push ──► GitHub (MauroBragaFilho/Yui, branch main)
  (D:\Projetos\Yui, com Git; tarefas da Yui desativadas)
```

| Peça | O que é | Onde |
|------|---------|------|
| **Bot do Discord** | Comandos, notícias e resets do GTA Online, música, voz, moderação | `src/discord`, `src/handlers`, `src/engines` |
| **Yui Core** | Permissões, memória, personalidade, Agent e ferramentas | `src/core` |
| **Yui API** | Interface HTTP do Core (login, chat, memória, painel) | `src/core/api` |
| **Yui Gateway** | Servidor de IA próprio, compatível com OpenAI, com failover | `src/gateway` |
| **App da Yui** | Cliente Android e web (chat, **código**, memória, painel do dono) | `apps/yui-app` |
| **Código** | A Yui lendo e editando os seus projetos, com aprovação (aba **Código**; o que era do Jarvis). Age na máquina onde a Yui roda (hoje, o notebook) | `src/core/dev` |
| **Atualizador** | Traz o `main` do GitHub para o notebook uma vez por dia, com volta automática se a Yui não subir | `scripts/atualizar-yui.ps1` (no notebook, `C:\Tools\atualizar-yui.ps1`) |
| **Scripts do notebook** | Instalação sem internet, SSH e limpeza do Windows | `scripts/instalar-tudo-offline.ps1`, `scripts/instalar-ssh.ps1`, `scripts/otimizar-windows.ps1` |
| **Yui Desktop** | A janela do app no computador (Electron), com seletor de pasta e "Iniciar a Yui" | `D:\Projetos\Projeto Jarvis\Yui Desktop` (fora deste repositório) |

---

## 🧭 Por onde começar

| Quero... | Leia |
|----------|------|
| Instalar e rodar a Yui pela primeira vez | [Primeiros passos](content_pt/GET_STARTED.md) |
| Montar um notebook servidor sem internet (como a produção) | [Primeiros passos: instalação no notebook](content_pt/GET_STARTED.md#-instalação-no-notebook-servidor-sem-internet) |
| Operar no dia a dia (reiniciar, logs, backups, problemas) | [Operação](content_pt/OPERACAO.md) |
| Publicar uma mudança na produção | [Operação: atualizar o código](content_pt/OPERACAO.md#-7-atualizar-o-código) |
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
| Ver quais funções já funcionam por conversa (e quais ainda só por comando) | [Conversa e comandos](content_pt/CONVERSA_E_COMANDOS.md) |
| Instalar ou gerar o app | [App da Yui](../apps/yui-app/README.md) |
| Criar ferramentas (MCP) e mexer na "alma" | [Desenvolvimento avançado](content_pt/ADVANCED.md) |
| Rodar os testes | [Testes](../README_TESTES.md) |

---

## 🟢 Estado atual (resumo)

- **Produção:** desde 03/11/2026 a Yui roda num **notebook servidor dedicado** (ASUS X450LD, i7-4500U, 4 GB de RAM, HD, Windows 10 em português), ligado no Wi-Fi (IP por DHCP) e na tailnet, com acesso por SSH com chave. O código fica em `C:\Yui`, sem Git. Três tarefas do Agendador, como conta SYSTEM: `YuiBot` e `YuiWebApp` sobem **na inicialização do sistema**, sem login, e se religam 15 s depois de qualquer queda; `YuiAtualizar` aplica uma vez por dia o que estiver no `main` do GitHub. Detalhes em [Operação](content_pt/OPERACAO.md#-1-como-a-yui-roda).
- **Ativos no notebook** (conferidos por SSH em 10/11/2026): bot do Discord, memória por usuário, Yui API (`127.0.0.1:3939`, `/v1/health` respondendo), app web (`127.0.0.1:8081`) e Yui Gateway (`127.0.0.1:20130`). No mesmo notebook rodam também, como projetos separados, o OmniRoute (`:20128`) e o BDS Server (`:80`, o servidor de arquivos que a Biblioteca por conversa consulta quando `YUI_BDS_URL` está definido). O `YuiSupervisor` (R08) existe no repositório, mas **não** está instalado.
- **Atualizar a produção** = commit + push no `main`; o notebook aplica na próxima execução da `YuiAtualizar` (ou na hora, por SSH). Veja [Operação](content_pt/OPERACAO.md#-7-atualizar-o-código).
- **Uma Yui por token:** no PC de desenvolvimento as tarefas `YuiBot` e `YuiWebApp` estão **desativadas**, e a VPS da AWS não é a produção e não deve rodar o bot (o estado dela não foi conferido desde a mudança). Duas Yuis com o mesmo token respondem em dobro.
- **Segurança padrão:** a Yui é **somente leitura** no computador (não apaga, grava, move nem executa programas), tudo escuta só em `127.0.0.1` (acesso remoto só pela tailnet), o painel de administração é exclusivo do dono e, no privado do Discord, as mensagens comuns só são respondidas para o dono.
- **Pendências conhecidas:** streaming das respostas, transporte MCP (Whisper), app em aparelho físico e aprovações nativas na Yui Desktop. Lista completa em [Assistente pessoal](content_pt/ASSISTENTE_PESSOAL.md#-pendências).

---

## 🗄️ Documentos históricos

Registros de como o projeto chegou até aqui, mantidos por referência (podem conter informações superadas): [Resumo da integração](../RESUMO_INTEGRACAO.md) · [Integração dos motores GTA](../INTEGRACAO_MOTORES_GTA.md) · [Documentação inicial](../.docs/README.md).

> A pasta `knowledge/` contém os arquivos de conhecimento que a IA lê antes de responder; veja [knowledge/README.md](../knowledge/README.md).
