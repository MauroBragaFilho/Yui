# 🎮 GTA Online: notícias, resets e evento semanal

Como a Yui coleta, traduz e publica as informações do GTA Online. O código vive em `src/engines/` (coleta), `src/discord/embeds/` (aparência) e `src/scheduler/` (horários).

---

## 📂 Sumário

1. [Visão geral](#-1-visão-geral)
2. [Reset diário](#-2-reset-diário)
3. [Evento semanal (Reddit)](#-3-evento-semanal-reddit)
4. [O embed semanal](#-4-o-embed-semanal)
5. [Notícias (Rockstar Newswire)](#-5-notícias-rockstar-newswire)
6. [Dados de veículos e armas](#-6-dados-de-veículos-e-armas)
7. [Comandos e agendamento](#-7-comandos-e-agendamento)
8. [Testes](#-8-testes)

---

## 🧭 1. Visão geral

| Motor | O que entrega | Fonte | Quando |
|-------|---------------|-------|--------|
| **GTAO Engine (diário)** | Van de Armas, Traficantes, Colecionáveis, Desafios Contra o Relógio | Cálculo determinístico a partir das *seeds* do jogo | Todo dia, **06:00 UTC** |
| **GTAO Engine (semanal)** | Bônus, descontos, pódio, carro premiado, Van de Armas, GTA+, desafio | Post semanal do **r/gtaonline** | Verificação periódica |
| **Newswire Engine** | Notícias da Rockstar | Página Newswire (Puppeteer) | **Desligado** por padrão |

Cada servidor escolhe os canais de destino com `/yui-configurar` (`noticias`, `diario`, `semanal`).

---

## 🌅 2. Reset diário

O reset do GTA Online acontece às **06:00 UTC**. A Yui calcula os sistemas do dia com as mesmas regras do jogo e publica um embed no canal `diario`:

- **Van de Armas** (Gun Van), incluindo as armas com desconto.
- **Traficantes** (Street Dealers).
- **Colecionáveis** do dia.
- **Desafios Contra o Relógio** (RC Bandito e Junk Energy Bike).

O resultado fica em `database/gta-diario.db` e pode ser consultado a qualquer hora com `/gta-diario`.

---

## 📅 3. Evento semanal (Reddit)

A fonte principal é o post **"Weekly Bonuses and Discounts"** do r/gtaonline. O fluxo é:

```
Reddit (feed RSS via Chrome) → conversão para markdown → parser → validação
        → tradução PT-BR (IA + glossário) → embed paginado → publicação
```

### Por que o Chrome?

O Reddit **bloqueia** requisições comuns (`curl`, `fetch`) e o endpoint `.json` com `403 "blocked by network security"`, mesmo com cookies. O **feed RSS da busca**, porém, é entregue normalmente a um navegador real. Por isso a Yui:

1. abre o **Chrome (ou Edge) instalado no sistema**, sem baixar nada, **só durante a consulta**, e o fecha em seguida;
2. carrega o feed Atom de busca do r/gtaonline;
3. converte o HTML de cada post de volta para o markdown que o parser entende (`# Título`, `* [Chave](url): Valor`, `**negrito**`);
4. entrega objetos no mesmo formato do `.json` do Reddit, de modo que o restante do sistema não muda.

Se o navegador falhar, a Yui cai no método antigo (cookies via Puppeteer + `fetch`). Variáveis:

| Variável | Função |
|----------|--------|
| `GTA_WEEKLY_ENABLED` | Liga/desliga a verificação semanal (padrão: ligada) |
| `GTA_WEEKLY_INTERVAL_MINUTES` | Intervalo entre verificações (padrão 30; o `.env` atual usa 120) |
| `REDDIT_FETCH_MODE` | `browser` (padrão) ou `cookies` (só o método antigo) |
| `REDDIT_BROWSER_PATH` | Caminho do Chrome/Edge (se não achar sozinho; também vale `PUPPETEER_EXECUTABLE_PATH`) |
| `REDDIT_USER_AGENT` | Identificação usada no método de cookies |

> O Reddit limita o número de consultas (`429`). Evite rodar testes ao vivo em sequência.

### Parser e validação

O parser (`weekly/parser.js`) extrai período, bônus (2x/3x...), veículos (pódio e carro premiado), descontos, Van de Armas, GTA+ e desafios. O validador descarta posts incompletos, e o último post processado fica em cache para não repetir a publicação.

---

## 🧾 4. O embed semanal

O embed foi pensado para **ler em segundos**: a página 1 é um resumo e os detalhes ficam nas páginas seguintes (botões ◀ ▶, ativos por 24 h).

| Página | Conteúdo |
|--------|----------|
| **1. Resumo** (~800 caracteres) | Período; bônus compactados (uma linha por multiplicador, até 3 atividades e "+N"); pódio e carro premiado; **só os destaques de desconto** (itens grátis e descontos de 50% ou mais); um desafio |
| **2. Bônus da Semana** | Lista completa de atividades por multiplicador (só aparece se o resumo omitiu algo) |
| **3. Descontos da Semana** | Todos os descontos **agrupados por loja** (Legendary Motorsport, Southern San Andreas Super Autos, Maze Bank Foreclosures...); vira "cont." se passar dos limites do Discord |
| **4. Van de Armas, GTA+ e Desafios** | As seções que existirem |
| **5+. Análise da Yui** | Destaques e itens gratuitos, melhores pontos de farm, avaliação da semana (gerados pela IA a partir do post) |

O código está em `src/discord/embeds/weeklyRedditEmbed.js` (`createWeeklyRedditEmbed` para a página 1 e `buildWeeklyDetailSections` para as de detalhe) e em `src/engines/gtao/weeklyAnalysis.js` (composição das páginas). Os limites do Discord (25 campos, 1024 caracteres por campo, 6000 por embed) são respeitados e testados com posts reais.

---

## 📰 5. Notícias (Rockstar Newswire)

O motor abre o Chromium **sob demanda**, extrai os artigos em lote, ordena por data e deduplica no SQLite (`database/newswire.db`), para não perder artigos publicados no mesmo intervalo. O navegador é fechado num bloco `finally` logo depois.

- **Desligado por padrão:** `NEWSWIRE_ENABLED=true` liga a checagem automática (intervalo em `NEWSWIRE_INTERVAL_MINUTES`, padrão 30).
- Sempre disponível sob demanda: `/gta-noticias quantidade:N` e `/gta-semanal fonte:newswire`.
- Os textos são traduzidos para o português antes de publicar.

---

## 🚗 6. Dados de veículos e armas

Para responder com dados técnicos reais (e não só com o conhecimento do modelo), o `/yui` injeta no prompt informações de:

- **Dump do [DurtyFree/gta-v-data-dumps](https://github.com/DurtyFree/gta-v-data-dumps):** `vehicles.json` (nome PT/EN, classe, fabricante, handling) e `weapons.json` (categoria, tipo de munição e de dano). Baixados na inicialização (`src/utils/vehicleData.js`, `weaponData.js`) e guardados em `src/data/vehicles.json` e `src/data/weaponsDump.json`. Se o GitHub estiver fora, usa o cache local.
- **GTACars:** base independente de veículos, atualizada a cada 24 h (`src/services/gta/vehicles/gtacars`).
- **Tunables (RDO.GG):** valores da Van de Armas (`src/data/tunables-decrypted.json`).

A busca (`buildVehicleWeaponContext` em `ask.js`) extrai palavras e bigramas da pergunta, procura correspondências nos dumps e injeta o resultado como "dados técnicos oficiais".

### Velocidade máxima

O campo `MaxSpeed` do dump é o valor bruto do handling (`fInitialDriveMaxFlatVel`). A conversão documentada pela comunidade de modding ([GTAMods Wiki: Handling.meta](https://gtamods.com/wiki/Handling.meta)) é:

> **km/h = MaxSpeed × 1,32**

É o máximo teórico em pista plana e reta; no jogo pode divergir levemente por tração, vento e estrada.

### Limitação das armas

O `weapons.json` **não traz dano numérico, alcance nem precisão**; esses números ficam no `weaponinfo.meta`, que não está nesse repositório. Por isso só categoria, munição e tipo de dano são expostos.

Teste rápido no Discord: `/yui mensagem: qual a classe do Truffade Adder?` e `/yui mensagem: me fala sobre a Carbine Rifle`.

---

## ⏱️ 7. Comandos e agendamento

| Comando | O que faz |
|---------|-----------|
| `/gta-diario` | Resumo do reset diário atual |
| `/gta-semanal fonte:reddit\|newswire` | Evento da semana (Reddit por padrão), com a análise da Yui |
| `/gta-noticias quantidade:N` | Últimas notícias do Newswire |
| `/yui-configurar` | Define os canais `noticias`, `diario` e `semanal` do servidor |

Agendador (`src/scheduler/scheduler.js`, tudo em **UTC**):

| Tarefa | Horário |
|--------|---------|
| Limpeza da memória temporária expirada | Diária, 05:30 |
| Reset diário do GTA Online | Diária, 06:00 |
| Checagem do evento semanal (Reddit) | A cada `GTA_WEEKLY_INTERVAL_MINUTES` |
| Newswire (se `NEWSWIRE_ENABLED`) | A cada `NEWSWIRE_INTERVAL_MINUTES` |
| YouTube / Twitch | A cada `YOUTUBE_INTERVAL_MINUTES` (5) / `TWITCH_INTERVAL_MINUTES` (2) |

Bancos: `database/gta-diario.db`, `database/gta-semanal.db`, `database/newswire.db`.

---

## 🧪 8. Testes

```bash
npm run test:gtao              # sistemas diários e semanais
npm run test:newswire          # Newswire (Puppeteer)
npm run test:weekly-reddit     # parser, validação e cache do evento semanal
npm run test:weekly-browser    # feed do Reddit via Chrome (offline com posts reais; LIVE=1 consulta o Reddit)
npm run test:gtacars           # base de veículos GTACars
node tests/test-weekly-embed-ptbr.js        # embed (página 1 e detalhes), tradução e limites do Discord
node tests/test-weekly-combined-embed.js    # composição de todas as páginas
```
