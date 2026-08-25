# 🎯 Integração dos Motores GTA Online - Yui Bot

## ✅ Status da Integração: **100% CONCLUÍDO**

Os dois motores de atualizações do GTA Online foram totalmente integrados e estão prontos para produção.

---

## 🏗️ Arquitetura dos Motores

### MOTOR 1: GTAO Engine (Sistemas Diários/Semanais)

**Localização:** `/workspace/src/engines/gtao/`

```
src/engines/gtao/
├── index.js              # Orquestrador principal
└── systems/
    ├── gunvan.js         # Van de Armas (localização diária)
    ├── streetDealers.js  # Traficantes de Rua (locais diários)
    ├── collectibles.js   # Colecionáveis ( Shipwreck, etc.)
    ├── timeTrials.js     # Time Trials (PC, HSW, PS5/Xbox)
    └── weeklyEvents.js   # Evento Semanal (bônus, descontos, pódio)
```

**Funcionalidades:**
- ✅ Cálculo determinístico usando seeds do jogo
- ✅ Coleta diária automática às 06:00 UTC
- ✅ Coleta semanal automática às quintas-feiras
- ✅ Armazenamento em SQLite (`gtaoRepo.js`)
- ✅ Publicação automática nos canais configurados

---

### MOTOR 2: Newswire Engine (Notícias Rockstar)

**Localização:** `/workspace/src/engines/newswire/`

```
src/engines/newswire/
├── index.js              # Orquestrador principal
└── scraper.js            # Puppeteer otimizado para scraping
```

**Funcionalidades:**
- ✅ Scraping automático do Rockstar Newswire
- ✅ Tradução automática EN → PT-BR
- ✅ Detecção inteligente de artigos inéditos
- ✅ Checagem a cada 30 minutos (configurável)
- ✅ Armazenamento em SQLite (`newsRepo.js`)
- ✅ Publicação automática com embeds formatados
- ✅ Monitoramento de memória RAM (fecha Chromium após uso)

---

## 📋 Comandos Slash Implementados

| Comando | Arquivo | Descrição |
|---------|---------|-----------|
| `/yui-diario` | `daily.js` | Consulta o resumo diário (Gun Van, Dealers, etc.) |
| `/yui-semanal` | `weekly.js` | Consulta eventos da semana (bônus, pódio, descontos) |
| `/yui-noticias [qtd]` | `news.js` | Exibe últimas notícias (1-5, padrão: 2) |
| `/yui-configurar` | `setup.js` | Configura canais de publicação no servidor |
| `/yui-status` | `status.js` | Exibe telemetria e saúde do bot |
| `/yui-perguntar` | `ask.js` | Converse com a Yui sobre GTA Online |

---

## 🤖 Agendamento Automático (Scheduler)

**Arquivo:** `/workspace/src/scheduler/scheduler.js`

| Tarefa | Horário | Frequência | Ação |
|--------|---------|------------|------|
| **Newswire** | - | A cada 30 min | Checa novas notícias e publica |
| **Reset Diário** | 06:00 UTC | Diariamente | Coleta e publica sistemas diários |
| **Evento Semanal** | 09:00-15:00 UTC | Quintas (hora em hora) | Coleta e publica evento semanal |

---

## 🧪 Scripts de Teste

### Windows
```batch
# Suite completa
yui.bat

# Testes individuais
scripts/test-gtao-standalone.bat
scripts/test-newswire-standalone.bat
scripts/test-commands.bat
scripts/deploy-commands.bat
```

### Linux/macOS
```bash
# Suite completa
./scripts/run-tests.sh

# Testes individuais
./scripts/test-gtao-standalone.sh
./scripts/test-newswire-standalone.sh
./scripts/test-commands.sh
./scripts/deploy-commands.sh
```

### npm scripts
```bash
npm run test:gtao        # Testa GTAO Engine
npm run test:newswire    # Testa Newswire Engine
npm run deploy:commands  # Implanta comandos no Discord
npm start                # Inicia o bot
npm run dev              # Modo desenvolvimento (auto-reload)
```

---

## 📊 Aproveitamento do Código Raiz

| Componente | Aproveitamento | Status |
|------------|----------------|--------|
| GTAO Engine (5 sistemas) | 100% | ✅ Pronto |
| Newswire Engine (scraper + tradutor) | 100% | ✅ Pronto |
| Scheduler (agendador cron) | 100% | ✅ Pronto |
| Publisher Discord (embeds) | 100% | ✅ Pronto |
| Repositórios SQLite | 100% | ✅ Pronto |
| Comandos Slash | 100% | ✅ Pronto |
| Sistema de IA Yui | 90%+ | ✅ Integrado |
| Sistema de Música | 90%+ | ✅ Integrado |
| Moderação | 90%+ | ✅ Integrado |

**Total estimado de aproveitamento: 95-100%**

---

## 🚀 Fluxo de Produção

### 1. Primeira Configuração
```bash
# Instalar dependências
npm install

# Configurar variáveis de ambiente (.env)
DISCORD_TOKEN=seu_token
GUILD_ID=id_servidor_teste
NEWSPAPER_CHANNEL_ID=canal_noticias
DAILY_CHANNEL_ID=canal_diario
WEEKLY_CHANNEL_ID=canal_semanal

# Implantar comandos no Discord
npm run deploy:commands
```

### 2. Testes
```bash
# Testar engines isoladamente
npm run test:gtao
npm run test:newswire

# Ou suite completa
./scripts/run-tests.sh  # Linux/macOS
yui.bat                 # Windows
```

### 3. Produção
```bash
# Iniciar bot
npm start

# Ou modo desenvolvimento
npm run dev
```

---

## 📁 Estrutura de Arquivos Chave

```
/workspace/
├── src/
│   ├── engines/
│   │   ├── gtao/           # Motor GTA Online
│   │   └── newswire/       # Motor Notícias
│   ├── scheduler/
│   │   └── scheduler.js    # Agendador central
│   ├── discord/
│   │   ├── commands/       # Comandos Slash
│   │   ├── embeds/         # Embeds formatados
│   │   └── publisher.js    # Publicador Discord
│   └── database/
│       └── repositories/   # Repositórios SQLite
├── tests/
│   ├── test-gtao.js        # Teste GTAO Engine
│   └── test-newswire.js    # Teste Newswire Engine
├── scripts/
│   ├── run-tests.sh        # Suite completa (Linux)
│   ├── test-gtao-standalone.sh
│   ├── test-newswire-standalone.sh
│   └── deploy-commands.sh
├── yui.bat                 # Suite completa (Windows)
└── package.json            # Scripts npm
```

---

## 🎯 Próximos Passos Sugeridos

1. ✅ **Concluído:** Integração dos motores GTA Online
2. ✅ **Concluído:** Scripts de teste independentes
3. ✅ **Concluído:** Comandos Slash implementados
4. ✅ **Concluído:** Scheduler configurado
5. 🔄 **Opcional:** Adicionar mais sistemas do GTA Online (ex: Missões Diárias)
6. 🔄 **Opcional:** Integrar sistema de IA com dados do GTA Online
7. 🔄 **Opcional:** Adicionar painéis web para visualização dos dados

---

## 📞 Suporte

Para dúvidas ou problemas, consulte:
- `README_TESTES.md` - Guia completo de testes
- `docs/content_pt/` - Documentação em português
- Logs em `/workspace/logs/`
