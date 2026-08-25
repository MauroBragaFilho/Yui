# 🔑 Environment Variables and Configuration Guide

This guide explains each entry in the `.env` file and Yui's internal settings, including the necessary links to obtain API keys.

---

## 📂 Summary

1. [🌐 Mandatory Settings](#-mandatory-settings)
2. [🤖 AI API Keys](#-ai-api-keys)
3. [🌍 Providers and URLs](#-providers-and-urls)
4. [👑 Governance and Preferences](#-governance-and-preferences)

---

## 🌐 Mandatory Settings

| Variable            | Description                            | Where to Obtain                                                        |
| :------------------ | :------------------------------------- | :--------------------------------------------------------------------- |
| `DISCORD_TOKEN`     | Your Discord bot access token.         | [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CLIENT_ID` | Your bot's application ID.             | [Discord Developer Portal](https://discord.com/developers/applications) |

---

## 🤖 AI API Keys

### 🧠 Language Models (LLM)

- **`GEMINI_API_KEY`**: Primary key for Yui's engine. Supports rotation (e.g., `key1,key2`).
  - 🔗 **Obtain from:** [Google AI Studio](https://aistudio.google.com/app/apikey)
- **`HF_TOKEN`**: Token for Hugging Face models (such as FLUX for images or chat models).
  - 🔗 **Obtain from:** [Hugging Face Settings](https://huggingface.co/settings/tokens)
- **`LM_STUDIO_API_KEY`**: Optional. Use if you are running a local model via [LM Studio](https://lmstudio.ai/).

### 🎨 Image Generation

- **`STABILITY_API_KEY`**: For ultra-quality image generation (SDXL/Stable Diffusion).
  - 🔗 **Obtain from:** [Stability AI Platform](https://platform.stability.ai/account/keys)
- **`HORDE_API_KEY`**: Key for the decentralized AI Horde network. Use `0000000000` for anonymous use with lower priority.
  - 🔗 **Obtain from:** [AI Horde Register](https://aihorde.net/register)

### 🔍 Search and Others

- **`BRAVE_API_KEY`**: Used so the AI can search the internet in real-time.
  - 🔗 **Obtain from:** [Brave Search API](https://api.search.brave.com/app/dashboard)

- **`DEEZER_ARL`** (or `DEEMIX_ARL`): Deezer account ARL authentication token to enable high quality music downloads via `deemix`.
  - 🔗 **Obtain from:** The `arl` cookie in your browser developer tools on [Deezer.com](https://www.deezer.com).

---

## 🌍 Providers and URLs

- **`LOCAL_LLM_URL`**: Endpoint of your local server (LM Studio / Ollama). Default: `http://localhost:1234/v1/chat/completions`.
- **`GEMINI_URL`**: Gemini API URL (OpenAI compatible).
- **`HF_API_URL`**: Hugging Face inference endpoint.
- **`LOG_WEBHOOK_URL`**: Discord webhook URL to receive error logs and status directly in your server.

---

## 👑 Governance and Preferences

- **`OWNER_ID`**: Your Discord user ID (or multiple separated by commas). This ID is the bot owner, and only they can use commands with the Owner flag.
- **`PREFIX`**: Prefix for legacy commands (if any). Default: `@`.
- **`BOT_NAME`**: The name Yui will recognize as her own.
- **`REQUIRE_TOS`**: If `true`, new servers must accept the terms of use before using the bot.
- **`SAVE_HISTORY`**: Saves message history in `src/data/history.txt` for debugging.

---

## 💡 Expert Tips

- 💡 **Key Rotation:** In the `GEMINI_API_KEY` field, you can enter multiple keys separated by commas. This prevents the bot from stopping if one of the keys reaches its free usage limit.
- 💡 **Token Savings:** Use `LOCAL_LLM_URL` with LM Studio or Ollama to process conversations without token costs, ideal for private or test servers.
- 💡 **Webhook Security:** Never share your `LOG_WEBHOOK_URL`. It contains system logs that might expose details of your infrastructure. Keep it in a locked channel.
- 💡 **Owner ID:** Ensure the first ID in `OWNER_ID` is yours. Some system commands prioritize the "Primary Owner" for critical actions.

---
[🏠 Back to Main Menu](../../README.md)
