# 📱 Yui App

Cliente da **Yui** para **Android** e **web/desktop**, feito com **Expo (React Native + React Native Web)**: um único código para os dois. É só uma interface; toda a inteligência, memória e permissões ficam no **Yui Core** (no computador que roda a Yui; desde 03/11/2026, um notebook servidor), acessado pela [Yui API](../../docs/content_pt/YUI_API.md).

## O que o app faz

| Aba | Função |
|-----|--------|
| 📊 **Início** (Visão Geral) | *Só para o dono; é a tela em que ele abre.* Estado da Yui (Discord, IA, tempo ligada), servidores ativos, pessoas com memória, **saúde do computador** (RAM e disco livres, com alerta quando aperta), atividade recente (do registro de auditoria, sem o texto das conversas), **alertas** (Discord ou IA fora, computador apertado, logins recusados e ferramentas com erro nas últimas 24 h), **gráfico de respostas da IA por hora** (contador em memória: zera quando a Yui reinicia), regras de retenção da memória e atalhos. Atualiza sozinha a cada 30 s. Custos de IA e "Yui Live" ainda não existem e não aparecem com número inventado. O nome na saudação vem de `YUI_OWNER_NAME` (opcional). |
| 💬 **Chat** | Conversa com a Yui pelo Agent. Mostra quando uma ferramenta foi executada e pede **confirmação** (botões Confirmar/Cancelar) para ações sensíveis. O histórico fica salvo no aparelho. |
| ⏰ **Lembretes** | *Só para o dono.* Cria lembretes escrevendo o "quando" em português ("amanhã às 9h", "em 2 horas", "todo dia às 8h") ou pelos atalhos, adia (+30 min, +1 h, amanhã 9h) e apaga (com confirmação). A Yui avisa por mensagem privada na hora marcada. Também mostra e envia o **resumo do dia** (lembretes, pendências e saúde da Yui). Tudo funciona também por conversa. |
| 📁 **Arquivos** | *Só para o dono; precisa de `YUI_BDS_URL` no servidor.* O servidor de arquivos **BDS** dentro do painel: navegar pelas pastas (trilha clicável), buscar, ver recentes e o espaço do disco, **assistir/ouvir/ver** vídeo, áudio, foto e PDF pelo navegador (link curto de 10 min), baixar, **enviar** (botão ou arrastar e soltar, com progresso), criar pasta, renomear, apagar para a **lixeira** (com restaurar e apagar de vez, sempre com confirmação) e a aba *Servidor* (estado do computador e auditoria). Tudo passa pela API da Yui; o painel nunca fala direto com o BDS Server. |
| 🧠 **Memória** | Lista, adiciona e apaga o que a Yui lembra de você. Mostra se é a memória **pessoal (permanente)** ou **temporária (30 dias)**. |
| 🛠️ **Admin** | *Só para o dono.* Visão geral da Yui, integrações (o que está ligado ou falta configurar), sessões do rádio (pausar, retomar, parar, tirar da call), logs (com segredos mascarados), servidores (canais, YouTube/Twitch) e AutoMod, banimentos, memória dos usuários (só metadados), **IA** (chaves, provedores e teste), auditoria, ferramentas, mensagem no seu Discord e reinício. |
| ⚙️ **Status** | Estado do servidor e **qual endereço está em uso** (rede local ou reserva, quando o build tem mais de um), seu papel, tipo de memória e backend de IA em uso. Botão para sair do dispositivo. |

## Visual

O app usa as **cores da Yui**: fundo preto com toque violeta, cartões planos com borda de 1px, botões em pílula roxa e roxo neon como acento (o vermelho fica só para ações perigosas e erros). Paleta (tema escuro): fundo `#0B0912`, cartões `#130F1D`/`#1B1529`, borda `#2B2240`, roxo `#8A3FE6` e destaque `#C77DFF`; tudo definido em `src/theme.ts` (Android) e `src/web.ts` (web), e o avatar fica em `assets/yui-avatar.webp`. No mais, segue o formato do **Braga Digital Studio**: títulos em Montserrat e texto em Inter, ícones Material Symbols. Em telas largas há uma **barra lateral recolhível**; em telas estreitas, uma barra de abas embaixo. O tema **escuro** (padrão) e o **claro** podem ser trocados na barra lateral ou em **Status → Aparência** (só na web, lembrado no navegador). As fontes ficam em `public/fonts` (sem CDN; licenças OFL/Apache).

O **papel** (dono, membro…) e o **tipo de memória** são decididos pelo servidor a partir do token. O app nunca escolhe isso.

## Requisitos

- Node 20+ (testado no Node 24) e npm.
- Para o celular: app **Expo Go** no Android (desenvolvimento) ou um APK gerado (ver abaixo).
- O **Yui Core com a API ligada** no servidor da Yui (hoje, o notebook servidor, em `127.0.0.1:3939`) e o **Tailscale** conectado no celular. Veja [YUI_API.md](../../docs/content_pt/YUI_API.md).

## Rodando

```bash
cd apps/yui-app
npm install
```

**Web (também serve como cliente de desktop):**

```bash
npm run web:build      # gera dist/
npm run painel:build   # gera painel-web/ (o build VERSIONADO que o atualizador leva ao notebook): rode e comite ANTES de dar push de mudança no app
npm run web:serve      # http://localhost:8081
```

O `web:serve` escuta só em `127.0.0.1:8081` (mude com as variáveis `HOST` e `PORT`). No notebook servidor ele roda nesse endereço, ao lado da API.

**Android (Expo Go):**

```bash
npm run android        # abra o QR code no Expo Go (celular e PC na mesma rede ou no Tailscale)
```

O app **não pede endereço do servidor**: ele vem da configuração do build.

- **Android:** defina `EXPO_PUBLIC_YUI_SERVER_URLS` (a lista de endereços, veja [Dois endereços do servidor](#dois-endereços-do-servidor-rede-local-e-tailscale)) ou, para um endereço só, `EXPO_PUBLIC_YUI_SERVER_URL` ao gerar/rodar o app, por exemplo `EXPO_PUBLIC_YUI_SERVER_URL=https://seu-pc.tailnet.ts.net:3939 npm run android`. Sem nenhuma das duas, o app avisa que o servidor não foi configurado. Há um modelo em `.env.example`.
- **Web:** usa o mesmo computador que serviu a página, na porta `3939` (mude com `EXPO_PUBLIC_YUI_API_PORT` ao gerar o build, ou aponte outro servidor com `EXPO_PUBLIC_YUI_SERVER_URL`). A lista de endereços não vale na web.

### Dois endereços do servidor (rede local e Tailscale)

Em casa, o computador da Yui costuma ser alcançado pelo endereço da **rede local**; fora de casa, só pelo do **Tailscale**. Para ter **uma versão só** do app que funcione nos dois lugares, o build aceita uma **lista de endereços**, em ordem de preferência, separados por vírgula:

```bash
EXPO_PUBLIC_YUI_SERVER_URLS=http://<ip-da-rede-local>:3939,http://<ip-do-tailscale>:3939 npm run android
```

Os endereços reais ficam **só na variável de ambiente do build** (ou no seu `.env` local, que não vai para o repositório); nada de endereço real em arquivo versionado.

- **Ordem:** o primeiro é o **preferido** (use o da rede local) e os seguintes são **reserva**. No máximo **4** endereços. Cada item precisa ser `http` ou `https`, com host e porta válidos e **sem usuário nem senha** na URL; item inválido ou repetido é ignorado. Se **todos** forem inválidos, o app avisa ("Os endereços do servidor configurados neste app são inválidos.") e não conecta em lugar nenhum.
- **Escolha:** ao abrir e depois de uma falha de rede, o app consulta `GET <endereço>/v1/health` (só leitura, **sem token**) na ordem de preferência, com prazo de 2,5 s para o primeiro e 4 s para os demais, e usa o **primeiro que responde `ok`**. Ele lembra o último que funcionou (só o endereço, no armazenamento do app) e tenta esse primeiro na próxima vez; um endereço lembrado que saiu da lista do build é esquecido.
- **No meio do uso:** se a conexão cair (falha de rede, não erro HTTP do servidor), o app refaz a escolha **uma vez** e repete o pedido **uma vez**, sem laço. Uma espera esgotada no mesmo endereço (servidor lento, não caído) não é repetida, para um pedido lento não rodar em dobro, e o envio de arquivo não é repetido sozinho.
- **Sessão e segurança:** a sessão (o token) é do servidor e vale nos dois endereços. O app **nunca envia token nem senha a um endereço que não passou pela consulta** (e, com a chave de identidade no build, pela [prova de identidade](#prova-de-identidade-do-servidor)).
- **Status:** a aba mostra qual endereço está em uso: `Servidor: <host> (rede local)` quando é o primeiro da lista e `Servidor: <host> (reserva)` nos demais. O rótulo vem da **ordem** da lista; o app não tenta adivinhar a rede.
- **Um endereço só** (`EXPO_PUBLIC_YUI_SERVER_URL`, ou uma lista de um item) e a **web** funcionam como sempre: sem consulta e sem reserva (com a chave de identidade no build, o endereço único também passa pela [prova de identidade](#prova-de-identidade-do-servidor); a web não). O `npm run painel:build` remove essas variáveis do ambiente, inclusive a da chave de identidade.

### Prova de identidade do servidor

A consulta `GET /v1/health` só prova que **alguém** responde. Em outra rede, uma máquina com o mesmo IP privado do endereço preferido poderia responder `{"ok":true}` e receber a senha e o token. Para o app ter certeza de **quem** responde, o servidor assina um desafio com uma chave **privada** Ed25519 que só ele tem (arquivo restrito ao dono, fora do código e fora do APK) e o app confere a assinatura com a chave **pública** que vai no build:

1. No servidor: `node scripts/gerar-identidade-yui.mjs` (na raiz do projeto) cria o par, grava a privada com permissão restrita e imprime **só a chave pública** (base64). Reinicie a Yui. Detalhes e a rota `GET /v1/identidade`: [YUI_API.md](../../docs/content_pt/YUI_API.md).
2. No ambiente do build do app (nunca no repositório): `EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY=<a chave pública em base64>`. É pública: pode estar no APK.

```bash
EXPO_PUBLIC_YUI_SERVER_URLS=http://<ip-da-rede-local>:3939,http://<ip-do-tailscale>:3939 \
EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY=<chave-publica-em-base64> npm run android
```

Com a chave no build, **depois da consulta de saúde** o app gera um desafio aleatório novo (32 bytes, nunca repetido), pede `GET <endereço>/v1/identidade?nonce=<desafio>` (sem nenhum cabeçalho de login) e confere a assinatura Ed25519 do texto `yui-identidade-v1|<desafio>` com a chave pública. A verificação é código TypeScript puro e sem pacote (`src/identidade.ts`: SHA-512 e a curva Ed25519 com `BigInt`, RFC 8032), conferida com os vetores do RFC 8032 e com assinaturas do `node:crypto`.

- **Só com a assinatura válida** o endereço recebe senha, token ou qualquer pedido autenticado. Vale para **todos** os endereços, inclusive o **"lembrado"** e **um endereço só**, a cada nova escolha, depois de uma queda de rede e a cada 60 s de uso (se o celular trocou de rede sem nada cair, a próxima requisição confere antes de enviar).
- **Rejeitado como se não respondesse:** 404 (servidor sem a identidade ligada), atraso, JSON ou base64 malformado, tamanho errado, assinatura de outra chave, de outro desafio (uma resposta antiga repetida) ou com **um bit trocado**. O app tenta o próximo endereço; se nenhum passar, mostra "Não consegui confirmar que este servidor é a sua Yui." e **não envia nada**. A aba Status mostra "confirmado" no endereço em uso.
- **Falha fechada:** se a chave do build for inválida (base64 ruim, tamanho errado, ponto fora da curva ou de ordem pequena), o app avisa e não conecta em lugar nenhum. Sem a variável, o comportamento é o de antes. A **web** não muda (o servidor é o que serviu a página) e o `npm run painel:build` remove a variável do ambiente.
- **Limite atual do app nativo:** o desafio precisa de números aleatórios **seguros** (`getRandomValues`; nunca `Math.random`). O Expo SDK 57 (Hermes, React Native 0.86) **não traz** `globalThis.crypto`, e o `expo-crypto` não está instalado: sem uma fonte, um APK gerado com a chave mostra "Este app foi gerado sem a função que confirma o servidor" e não conecta. Para ligar a prova no APK: `npx expo install expo-crypto` e, em `App.tsx`, passar `gerarNonce: () => nonceAleatorio(Crypto)` (com `import * as Crypto from 'expo-crypto'` e `nonceAleatorio` de `src/identidade.ts`) em `identidade`. Isso ainda não foi feito nem verificado em aparelho.
- **O que a prova não faz:** não cifra o tráfego (com `http://` na rede local o token ainda passa em texto claro pelo Wi-Fi) e não impede quem consiga retransmitir o desafio em tempo real ao servidor verdadeiro (um intermediário ativo na mesma rede). O caminho do Tailscale já é cifrado; HTTPS com certificado fixado na rede local não está implementado.

### Android e HTTP sem TLS

O Android 9 ou mais novo **bloqueia `http://` em apps de produção** (APK/AAB). Como o endereço da rede local não tem certificado, o app inclui um plugin local (`plugins/withCleartextTraffic.js`, ligado em `plugins` no `app.json`, sem pacote novo) que marca `usesCleartextTraffic` no manifesto gerado pelo `expo prebuild`/EAS Build. Para voltar ao padrão do Android (só HTTPS), tire essa linha de `plugins`. Atenção: com `http://` na rede local, o login e o token passam **sem cifra** pelo Wi-Fi de casa; o caminho do Tailscale já é cifrado por ele mesmo.

Na aba **Admin → IA** dá para colar chaves, ligar/desligar provedores, testar, ajustar a ordem na fila e cadastrar provedores próprios (como o OmniRoute). Em **Admin → Geral** há o botão **Enviar para o meu Discord**, que manda uma DM de teste.

Na tela de entrada há duas formas, conforme o que o servidor oferece:

- **Usuário e senha** (definidos no `.env` do servidor da Yui; veja o `YUI_API.md`).
- **Chave pelo Discord:** toque em *Enviar chave para o meu Discord*; a Yui manda uma chave de uso único (válida por 5 minutos) por **mensagem privada** para você, e você digita no app. Não é preciso copiar token nenhum.

Depois de entrar, o app guarda só uma **sessão temporária** (nunca a senha nem a chave). Se a sessão expirar ou for revogada, ele volta para a tela de entrada com um aviso.

## Testar sem o bot (servidor de desenvolvimento)

Na raiz do projeto, `npm run dev:api -- --fake` sobe a API com **IA simulada**, **banco temporário** e ferramentas de demonstração (`demo.ping` e `demo.limpar_cache`, esta com confirmação). Ele imprime a URL e um token descartável. Peça "ping" ou "limpar o cache" no chat para ver os dois fluxos. Sem `--fake` usa a IA real, ainda com banco temporário e papel de membro.

## Tokens fixos (opcional, para scripts)

No `.env` do servidor da Yui, cada aparelho tem o próprio token (assim você revoga um sem afetar os outros):

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
npm test               # lógica do app: cliente contra a Yui API real, telas e os dois endereços do servidor
```

Os testes sobem a API de verdade (com IA falsa) e exercitam o cliente: conexão, papel/escopo, chat, ferramenta, confirmação e cancelamento, memória (CRUD e isolamento) e histórico. A lista de endereços e a escolha do que responde (`src/servidores.ts`) têm testes próprios, com servidores falsos em `127.0.0.1` abertos pelo teste (`tests/servidores-logic.test.mjs`). A prova de identidade tem os seus: as peças puras (`tests/identidade-logic.test.mjs`: SHA-512 com os vetores do FIPS 180-4, Ed25519 com os 5 vetores do RFC 8032 §7.1 e com assinaturas do `node:crypto`, base64 estrito, nonce) e os cenários com um servidor legítimo e **impostores** que respondem `/v1/health` perfeitamente mas não têm a chave (`tests/identidade-servidor.test.mjs`: o impostor não recebe `Authorization`, nem corpo de login, nem nenhum pedido além de `/v1/health` e `/v1/identidade`).

## Gerar um APK

Opções: **EAS Build** (`npx eas build -p android --profile preview`, na nuvem da Expo) ou local com o Android SDK (`npx expo prebuild -p android` e depois `./gradlew assembleRelease` em `android/`). O identificador do app é `br.dev.braga.yui`. Defina `EXPO_PUBLIC_YUI_SERVER_URLS` (ou `EXPO_PUBLIC_YUI_SERVER_URL`) e, para confirmar quem responde, `EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY` (a chave pública; veja [Prova de identidade do servidor](#prova-de-identidade-do-servidor)) no ambiente do build. Para endereços `http://` no APK, veja [Android e HTTP sem TLS](#android-e-http-sem-tls); o endereço **HTTPS** do Tailscale não precisa disso.

## Desktop

A versão web (`dist/`) já funciona no navegador do PC. Para uma **janela própria** existe a **Yui Desktop** (Electron, em `D:\Projetos\Projeto Jarvis\Yui Desktop`, fora deste repositório): ela abre este mesmo app e acrescenta o seletor de pastas da aba Código e o botão "Iniciar a Yui" quando a API está fora do ar. Sem ela, basta abrir `http://localhost:8081` e usar "Criar atalho → Abrir como janela" no Chrome/Edge.

## Segurança

- Só a **sessão temporária** fica no armazenamento do app (no Android, restrito ao app; na web, no `localStorage`); a senha e a chave de uso único nunca são guardadas. Use **Sair deste dispositivo** em aparelhos emprestados.
- Sessão inválida (401) é apagada; servidor offline não apaga, para você poder tentar de novo.
- As abas **Início** e **Admin** só aparecem para o dono, e o servidor recusa (403) qualquer outro papel.
- O painel **não** altera o modo somente leitura, senhas nem chaves; isso só muda no `.env`.
- O app não executa nada por conta própria: ações sensíveis só rodam depois do **Confirmar**, e o servidor revalida a permissão.

## Pendências

- **Streaming** das respostas (SSE): hoje a resposta aparece inteira ao final.
- Renderizar **markdown** nas mensagens.
- Notificações e entrada por **voz** (Whisper).
- Ícone/splash próprios e aprovações nativas do Windows na Yui Desktop.
