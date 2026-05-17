# ⚙️ Configuration, Governance, and Multi-Token

This document covers Hikari's configuration architecture, focusing on API resilience and scalability of ownership permissions (Multi-Owner).

---

## 📂 Summary

1. [🔑 1. Multi-Token Architecture](#-1-multi-token-architecture)
2. [👑 2. Governance System (Multi-Owner)](#-2-governance-system-multi-owner)
3. [🛠️ 3. Configuration Mapping](#-3-configuration-mapping-srcconfigindexjs)
4. [💡 Advanced Configuration Tips](#-advanced-configuration-tips)

---

## 🔑 1. Multi-Token Architecture

To bypass rate limits imposed by providers such as Google and Stability, we implemented a **Key Rotation** system in the bot's core.

### Supported Providers for Rotation:
- **Gemini (LLM):** Define in `.env` as `GEMINI_API_KEY=key1,key2,key3`.
  - **Logic:** Implemented as `Ordered Retry` (Tries the 1st key; if it fails due to 429 or quota error, it tries the 2nd).
- **Stability AI (Images):** Define as `STABILITY_API_KEY=key1,key2`.
  - **Logic:** Implemented as `Random Load Balancing` (Randomly chooses one of the keys for each request to distribute credit consumption).

---

## 👑 2. Governance System (Multi-Owner)

Unlike legacy bots that support only one owner, Hikari uses a list of IDs for administrative privilege validation.

### Configuration:
In the `.env` file, fill `OWNER_ID` with the user IDs separated by commas.
```env
OWNER_ID=593372065730396160,123456789012345678
```

### Technical Implementation:
In the code (`src/config/index.js`), the `isOwner(userId)` method is used to check if the ID is part of the `ownerIds` array. If a command is global (restricted), only a `true` return from this method will allow execution.

---

## 🛠️ 3. Configuration Mapping (`src/config/index.js`)

All global constants are centralized for easier maintenance. Below are the primary fields:

| Field | Source (.env) | Function |
| :--- | :--- | :--- |
| `discordToken` | `DISCORD_TOKEN` | Discord Gateway connection credential. |
| `geminiModel` | `GEMINI_MODEL` | Base model identifier (e.g., `gemini-1.5-flash`). |
| `systemPrompt` | `SYSTEM_PROMPT` | The Core Context that defines the AI's behavior. |
| `requireTos` | `REQUIRE_TOS` | If `true`, requires acceptance of terms when joining new servers. |
| `saveHistory` | `SAVE_HISTORY` | If `true`, saves prompt and response logs to `history.txt`. |
| `localLlmUrl` | `LOCAL_LLM_URL` | Endpoint for integration with LM Studio or Ollama. |
| `defaultAutoMod` | `DEFAULT_AUTOMOD` | Enables or disables AutoMod by default for new servers (Default: `true`). |
| `automodMode` | `AUTOMOD_MODE` | Defines the AutoMod operating mode (`off`, `trigger`, `mcp`, `both`). |

---

## 💡 Advanced Configuration Tips

- 💡 **Local Rate Limiting:** If using local models via `LOCAL_LLM_URL`, you can configure the `timeout` within the `providerSettings` object in `llmHandler.js` to prevent queue hangups.
- 💡 **Log Security:** `LOG_WEBHOOK_URL` captures `stderr` and `stdout`. Keep this webhook in a high-security private channel, as it displays error traces that may contain internal execution details.
- 💡 **Backward Compatibility:** The `ownerId` field (singular) in the config object will always point to the first ID in the list, ensuring that legacy modules continue to function.

---
[🏠 Back to Main Menu](../../README.md)
