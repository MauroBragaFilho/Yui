# 📱 Yui App

Cliente da **Yui** para **Android** e **web/desktop**, feito com **Expo (React Native + React Native Web)**: um único código para os dois. É só uma interface; toda a inteligência, memória e permissões ficam no **Yui Core** (no seu PC), acessado pela [Yui API](../../docs/content_pt/YUI_API.md).

## O que o app faz

| Aba | Função |
|-----|--------|
| 💬 **Chat** | Conversa com a Yui pelo Agent. Mostra quando uma ferramenta foi executada e pede **confirmação** (botões Confirmar/Cancelar) para ações sensíveis. O histórico fica salvo no aparelho. |
| 🧠 **Memória** | Lista, adiciona e apaga o que a Yui lembra de você. Mostra se é a memória **pessoal (permanente)** ou **temporária (30 dias)**. |
| ⚙️ **Status** | Estado do servidor, seu papel, tipo de memória e backend de IA em uso. Botão para sair do dispositivo. |

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

Na primeira tela informe:

- **Endereço do servidor:** por exemplo `https://mnbf-neon.<sua-tailnet>.ts.net:3939` (ou `localhost:3939` no PC). Sem `http(s)://`, o app usa `https` para `*.ts.net` e `http` nos demais.
- **Token:** um token **exclusivo deste dispositivo** (veja abaixo).

## Testar sem o bot (servidor de desenvolvimento)

Na raiz do projeto, `npm run dev:api -- --fake` sobe a API com **IA simulada**, **banco temporário** e ferramentas de demonstração (`demo.ping` e `demo.limpar_cache`, esta com confirmação). Ele imprime a URL e um token descartável. Peça "ping" ou "limpar o cache" no chat para ver os dois fluxos. Sem `--fake` usa a IA real, ainda com banco temporário e papel de membro.

## Token por dispositivo

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
npm test               # lógica do app contra a Yui API real (11 testes)
```

Os testes sobem a API de verdade (com IA falsa) e exercitam o cliente: conexão, papel/escopo, chat, ferramenta, confirmação e cancelamento, memória (CRUD e isolamento) e histórico.

## Gerar um APK

Opções: **EAS Build** (`npx eas build -p android --profile preview`, na nuvem da Expo) ou local com o Android SDK (`npx expo prebuild -p android` e depois `./gradlew assembleRelease` em `android/`). O identificador do app é `br.dev.braga.yui`. Para uso fora do Expo Go, prefira o endereço **HTTPS** do Tailscale: o Android bloqueia HTTP puro em apps de produção.

## Desktop

A versão web (`dist/`) já funciona no navegador do PC. Para um app de janela própria dá para embrulhá-la com **Tauri** (exige instalar o Rust) ou **Electron** (você já usa no Jarvis); a interface não muda. Hoje basta abrir `http://localhost:8081` e usar "Criar atalho → Abrir como janela" no Chrome/Edge.

## Segurança

- O token fica no armazenamento do app (no Android, restrito ao app; na web, no `localStorage`). Use um token por dispositivo e **Sair deste dispositivo** em aparelhos emprestados.
- Token inválido (401) apaga a sessão salva; servidor offline não apaga, para você poder tentar de novo.
- O app não executa nada por conta própria: ações sensíveis só rodam depois do **Confirmar**, e o servidor revalida a permissão.

## Pendências

- **Streaming** das respostas (SSE): hoje a resposta aparece inteira ao final.
- Renderizar **markdown** nas mensagens.
- Notificações e entrada por **voz** (Whisper).
- Casca de **desktop** (Tauri/Electron) e ícone/splash próprios.
