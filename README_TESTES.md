# 🧪 Suite de Testes - Yui Bot GTA Online

Este documento descreve como testar individualmente cada motor do Yui Bot.

## 📦 Scripts Disponíveis

### Windows (.bat)

| Script | Descrição |
|--------|-----------|
| `yui.bat` | **Suite completa**: testa GTAO Engine + Newswire Engine + lista comandos |
| `scripts/test-commands.bat` | Lista todos os comandos Slash disponíveis |
| `scripts/deploy-commands.bat` | Implanta os comandos no Discord |

### Linux/macOS (.sh)

| Script | Descrição |
|--------|-----------|
| `scripts/run-tests.sh` | **Suite completa**: testa ambos engines |
| `scripts/test-gtao-standalone.sh` | Testa apenas o GTAO Engine (diário e semanal) |
| `scripts/test-newswire-standalone.sh` | Testa apenas o Newswire Engine (notícias) |
| `scripts/test-commands.sh` | Lista todos os comandos Slash disponíveis |
| `scripts/deploy-commands.sh` | Implanta os comandos no Discord |

## 🎯 Comandos npm

```bash
# Testar GTAO Engine (sistemas diários e semanais)
npm run test:gtao

# Testar Newswire Engine (notícias Rockstar)
npm run test:newswire

# Implantar comandos no Discord
npm run deploy:commands

# Iniciar o bot
npm start

# Modo desenvolvimento (auto-reload)
npm run dev
```

## 🔍 O que cada teste verifica

### GTAO Engine (`test-gtao.js`)

✅ **Sistemas Diários:**
- Gun Van (Van de Armas)
- Street Dealers (Traficantes de Rua)
- Collectibles (Colecionáveis do dia)
- Time Trials (Desafios Contra Relógio)

✅ **Sistema Semanal:**
- Weekly Events (Bônus, Descontos, Veículo do Pódio)

### Newswire Engine (`test-newswire.js`)

✅ **Funcionalidades:**
- Scraping da página Rockstar Newswire
- Tradução automática para PT-BR
- Detecção de artigos inéditos
- Salvamento no banco SQLite
- Monitoramento de memória RAM (Puppeteer)

## 📋 Comandos Slash do Discord

| Comando | Descrição |
|---------|-----------|
| `/yui-diario` | Consulta o resumo diário do GTA Online |
| `/yui-semanal` | Consulta eventos e descontos da semana |
| `/yui-noticias [quantidade]` | Exibe últimas notícias (1-5, padrão: 2) |

## 🚀 Fluxo Recomendado

1. **Primeira execução:**
   ```bash
   npm install
   npm run deploy:commands
   ```

2. **Testar engines isoladamente:**
   ```bash
   npm run test:gtao
   npm run test:newswire
   ```

3. **Rodar suite completa:**
   - Windows: `yui.bat`
   - Linux/macOS: `./scripts/run-tests.sh`

4. **Iniciar o bot:**
   ```bash
   npm start
   ```

## 📊 Agendamento Automático

O scheduler já está configurado para:

| Tarefa | Horário | Frequência |
|--------|---------|------------|
| Newswire | - | A cada 30 minutos |
| Reset Diário | 06:00 UTC | Diariamente |
| Evento Semanal | 09:00-15:00 UTC | Quintas-feiras (hora em hora) |

## ⚙️ Configuração

Certifique-se de configurar as variáveis de ambiente no arquivo `.env`:

```env
DISCORD_TOKEN=seu_token_aqui
GUILD_ID=id_do_servidor_teste
NEWSPAPER_CHANNEL_ID=canal_de_noticias
DAILY_CHANNEL_ID=canal_diario
WEEKLY_CHANNEL_ID=canal_semanal
```
