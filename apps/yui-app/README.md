# 📱 Yui App

Cliente da **Yui** para **Android** e **web/desktop**, feito com **Expo (React Native + React Native Web)**: um único código para os dois. É só uma interface; toda a inteligência, memória e permissões ficam no **Yui Core** (no seu PC), acessado pela [Yui API](../../docs/content_pt/YUI_API.md).

## O que o app faz

| Aba | Função |
|-----|--------|
| 💬 **Chat** | Conversa com a Yui pelo Agent. Mostra quando uma ferramenta foi executada e pede **confirmação** (botões Confirmar/Cancelar) para ações sensíveis. O histórico fica salvo no aparelho. |
| ⌨️ **Código** | *Só para o dono, e só com `YUI_DEV_ENABLED=true` no servidor.* A Yui lê e responde sobre os seus projetos (árvore de arquivos, arquivo "em foco", modos Yui/Desenvolvedora/Revisora...) e, se você liberar (`YUI_READ_ONLY=false`), edita arquivos e roda comandos **pedindo a sua aprovação a cada vez, no computador** (pelo celular ela só lê). Guia: [Código](../../docs/content_pt/CODIGO.md). |
| 🧠 **Memória** | Lista, adiciona e apaga o que a Yui lembra de você. Mostra se é a memória **pessoal (permanente)** ou **temporária (30 dias)**. |
| 🛠️ **Admin** | *Só para o dono.* Visão geral da Yui, integrações (o que está ligado ou falta configurar), sessões do rádio (pausar, retomar, parar, tirar da call), logs (com segredos mascarados), servidores (canais, YouTube/Twitch) e AutoMod, banimentos, memória dos usuários (só metadados), auditoria, ferramentas e reinício. |
| ⚙️ **Status** | Estado do servidor, seu papel, tipo de memória e backend de IA em uso. Botão para sair do dispositivo. |

## Visual

O app segue o formato do **Braga Digital Studio**: fundo preto, cartões planos com borda de 1px, botões em pílula (brancos no tema escuro, pretos no claro), vermelho só como acento, títulos em Montserrat e texto em Inter, ícones Material Symbols. Em telas largas há uma **barra lateral recolhível**; em telas estreitas, uma barra de abas embaixo. O tema **escuro** (padrão) e o **claro** podem ser trocados na barra lateral ou em **Status → Aparência** (só na web, lembrado no navegador). As fontes ficam em `public/fonts` (sem CDN; licenças OFL/Apache).

O **papel** (dono, membro…) e o **tipo de memória** são decididos pelo servidor a partir do token. O app nunca escolhe isso.

## Requisitos

- Node 20+ (testado no Node 24) e npm.
- Para o celular: app **Expo Go** no Android (desenvolvimento) ou um APK gerado (ver abaixo).
- O **Yui Core com a API ligada** no PC e o **Tailscale** conectado no celular. Veja [YUI_API.md](../../docs/content_pt/YUI_API.md).

## Rodando

```bash
cd apps/yui-app
npm install
```

**Web (também serve como cliente de desktop):**

```bash
npm run web:build      # gera dist/
npm run web:serve      # http://localhost:8081
```

**Android (Expo Go):**

```bash
npm run android        # abra o QR code no Expo Go (celular e PC na mesma rede ou no Tailscale)
```

O app **não pede endereço do servidor**: ele vem da configuração do build.

- **Android:** defina `EXPO_PUBLIC_YUI_SERVER_URL` ao gerar/rodar o app, por exemplo `EXPO_PUBLIC_YUI_SERVER_URL=https://seu-pc.tailnet.ts.net:3939 npm run android`. Sem ela, o app avisa que o servidor não foi configurado. Há um modelo em `.env.example`.
- **Web:** usa o próprio PC que serviu a página, na porta `3939` (mude com `EXPO_PUBLIC_YUI_API_PORT` ao gerar o build, ou aponte outro servidor com `EXPO_PUBLIC_YUI_SERVER_URL`).

Na aba **Admin → IA** dá para colar chaves, ligar/desligar provedores, testar, ajustar a ordem na fila e cadastrar provedores próprios (como o OmniRoute). Em **Admin → Geral** há o botão **Enviar para o meu Discord**, que manda uma DM de teste.

Na tela de entrada há duas formas, conforme o que o servidor oferece:

- **Usuário e senha** (definidos no `.env` do PC; veja o `YUI_API.md`).
- **Chave pelo Discord:** toque em *Enviar chave para o meu Discord*; a Yui manda uma chave de uso único (válida por 5 minutos) por **mensagem privada** para você, e você digita no app. Não é preciso copiar token nenhum.

Depois de entrar, o app guarda só uma **sessão temporária** (nunca a senha nem a chave). Se a sessão expirar ou for revogada, ele volta para a tela de entrada com um aviso.

## Testar sem o bot (servidor de desenvolvimento)

Na raiz do projeto, `npm run dev:api -- --fake` sobe a API com **IA simulada**, **banco temporário** e ferramentas de demonstração (`demo.ping` e `demo.limpar_cache`, esta com confirmação). Ele imprime a URL e um token descartável. Peça "ping" ou "limpar o cache" no chat para ver os dois fluxos. Sem `--fake` usa a IA real, ainda com banco temporário e papel de membro.

## Tokens fixos (opcional, para scripts)

No `.env` do PC, cada aparelho tem o próprio token (assim você revoga um sem afetar os outros):

```env
YUI_API_ENABLED=true
YUI_API_HOST=127.0.0.1
YUI_API_TOKENS=TOKEN_DO_CELULAR=SEU_ID_DO_DISCORD,TOKEN_DO_NOTEBOOK=SEU_ID_DO_DISCORD
# só para a versão web aberta em outra origem (ex.: servida em 8081):
YUI_API_CORS_ORIGINS=http://localhost:8081
```

Gere cada token com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Para revogar, remova a entrada e reinicie a Yui.

## HTTPS pelo Tailscale (recomendado para o celular)

O celular deve falar com a API por **HTTPS**. O jeito mais simples, sem expor nada na internet:

```bash
tailscale serve --bg --https=3939 http://127.0.0.1:3939
```

Isso publica `https://<seu-pc>.<tailnet>.ts.net:3939` **somente na sua tailnet**. Não use `tailscale funnel` (ele abre para a internet).

## Testes

```bash
npm run typecheck      # TypeScript
npm test               # lógica do app contra a Yui API real (23 testes)
```

Os testes sobem a API de verdade (com IA falsa) e exercitam o cliente: conexão, papel/escopo, chat, ferramenta, confirmação e cancelamento, memória (CRUD e isolamento) e histórico.

## Gerar um APK

Opções: **EAS Build** (`npx eas build -p android --profile preview`, na nuvem da Expo) ou local com o Android SDK (`npx expo prebuild -p android` e depois `./gradlew assembleRelease` em `android/`). O identificador do app é `br.dev.braga.yui`. Para uso fora do Expo Go, prefira o endereço **HTTPS** do Tailscale: o Android bloqueia HTTP puro em apps de produção.

## Desktop

A versão web (`dist/`) já funciona no navegador do PC. Para uma **janela própria** existe a **Yui Desktop** (Electron, em `D:\Projetos\Projeto Jarvis\Yui Desktop`, fora deste repositório): ela abre este mesmo app e acrescenta o seletor de pastas da aba Código e o botão "Iniciar a Yui" quando a API está fora do ar. Sem ela, basta abrir `http://localhost:8081` e usar "Criar atalho → Abrir como janela" no Chrome/Edge.

## Segurança

- Só a **sessão temporária** fica no armazenamento do app (no Android, restrito ao app; na web, no `localStorage`); a senha e a chave de uso único nunca são guardadas. Use **Sair deste dispositivo** em aparelhos emprestados.
- Sessão inválida (401) é apagada; servidor offline não apaga, para você poder tentar de novo.
- A aba **Admin** só aparece para o dono, e o servidor recusa (403) qualquer outro papel.
- O painel **não** altera o modo somente leitura, senhas nem chaves; isso só muda no `.env`.
- O app não executa nada por conta própria: ações sensíveis só rodam depois do **Confirmar**, e o servidor revalida a permissão.

## Pendências

- **Streaming** das respostas (SSE): hoje a resposta aparece inteira ao final.
- Renderizar **markdown** nas mensagens.
- Notificações e entrada por **voz** (Whisper).
- Ícone/splash próprios e aprovações nativas do Windows na Yui Desktop.
