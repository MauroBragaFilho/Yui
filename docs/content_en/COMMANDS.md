# 🎮 Advanced Commands Guide

This document details all slash commands (/) available in Hikari, their features, parameters, and permissions.

---

## 📂 Summary

1. [🧠 AI & Chat](#-ai--chat)
2. [🎨 Images & Art](#-images--art)
3. [🎵 Multimedia & Utilities](#-multimedia--utilities)
4. [🎮 Games & Downloads](#-games--downloads)
5. [🏪 Store Inquiry](#-store-inquiry)
6. [⚙️ Configuration & Administration](#-configuration--administration)
7. [💡 Expert Tips](#-expert-tips)

---

## 🧠 AI & Chat

### `/ia_chat`

The primary command for interacting with Hikari's brain.

- **Prompt:** Your question or request.
- **Visibility:** Choose between `Public` (everyone sees) or `Private` (only you see).
- **Advanced:** If you mention others in the prompt, Hikari may attempt to understand the context of the conversation.

### `/chat_resumo`

Reads the latest messages and generates a smart summary.

- **Quantity:** The number of messages to analyze (Min: 10, Max: 100).
- **Advanced:** Useful for understanding long discussions you missed.

### `/chat_humor` (Admin)

Changes Hikari's "soul" in a specific channel.

- **Instruction:** New behavior rules (e.g., "Speak like a pirate").
- **Mood:** Emotional state (e.g., "Angry", "Happy").
- **Reset:** Returns to default settings.
- **Advanced:** These changes persist only in the channel where they were applied.

### `/chat_espontaneo` (Owner)

Configures Hikari to intrude into conversations without being called.

- **State:** Enable or Disable.
- **Frequency:** Choose between `Low`, `Medium`, or `High`.
- **Percentage (🔒 Owner):** Exact chance (0-100%) for each message received in the channel.

---

## 🎨 Images & Art

### `/ia_imagem`

Generates images using various diffusion models.

- **Prompt:** Detailed description of what you want.
- **Negative Prompt:** What you DON'T want in the image.
- **Width/Height:** Image dimensions (512px to 1280px).
- **Provider:** Choose the generator (Stability, HuggingFace, Pollinations, etc.).
- **Advanced:** `Auto` mode will try providers in sequence until one works.

---

## 🎵 Multimedia & Utilities

### `/baixar_musica`

Extracts and converts video audio into MP3 format.

- **URL:** The link to the video (YouTube, Instagram Reels, or TikTok).
- **Advanced:** Uses `yt-dlp` to download the best audio stream and `ffmpeg` to cleanly convert it to MP3, deleting local temporary files afterward.

### `/baixar_musica_deezer`

Searches and downloads high quality music tracks directly from Deezer by song title or artist.

- **nome:** The song name and/or artist you want to search and download.
- **Advanced:** Uses Deezer REST API and `deemix` engine to download official studio audio in HQ MP3. Features a Match Confidence Score algorithm and presents an interactive select dropdown when ambiguous. Temporary MP3 files are automatically cleaned up right after sending.

### `/baixar_video`

Downloads videos and sends them in MP4 format in the Discord chat.

- **URL:** The link to the video (YouTube Shorts, Instagram Reels, or TikTok).
- **descricao (Boolean):** If true, displays the uploader and description of the original video in the message. Default: `false`.
- **Advanced:** Automatically detects the server's upload size limit and applies FFMPEG compression if the video exceeds the Discord threshold. Utilizes a global asynchronous compression queue.

### `/anime_origem`

Identifies an anime through a screenshot/image.

- **Image:** File upload.
- **URL:** Direct link to the image.
- **Advanced:** Uses the Trace.moe API to find the episode and the exact time of the scene.

### `/converter_moeda`

Converts fiat and cryptocurrencies in real-time.

- **Value:** Numeric amount to be converted.
- **From:** Origin code (e.g., USD, EUR, BTC).
- **To:** Destination code (e.g., BRL).
- **Advanced:** Uses a real-time exchange rate API with daily local caching (JSON) and smart fallback for less common currencies. Fully integrated into the AI chat interface.

---

## 🎮 Games & Downloads

### `/buscar_jogo`

Searches for game torrents/magnets comprehensively.

- **Name:** Game title.
- **Advanced:** Refined search across the FitGirl and DODI Repacks databases. Now includes a paginator with buttons to navigate results in sets of 5 items directly on Discord.

---

## 🏪 Store Inquiry

### `/steam_jogo`

Checks official information, price, and status in the Steam store.

- **Name:** Game name to search for.
- **Advanced:** Returns regional price, discount percentage, developers, and Metacritic score. The AI will make a small comment about the price or the game if the servers are online.

---

## ⚙️ Configuration & Administration

### `/config_servidor` (Server Admin)

Unified public dashboard for server configuration.

- **Personality & Humor:** Custom instructions (prompts) and emotional states per channel.
- **Spontaneous Messages:** Controls toggle status and speech frequency.
- **Updates Channel:** Configures the official channel for system updates.
- **Mentions Response:** Toggles response to `@everyone` and `@here` mentions.
- **MCP Tools:** Opens the interactive MCP Tool Manager with tool descriptions, status list, and toggle buttons.

### `/config_criador` (Owner / Creator)

Master Control Center for global Hikari network management (hidden/ephemeral for creator).

- **Subcommands `painel` / `dashboard`:** Opens the Master Creator dashboard with button controls.
- **Models:** Configures active LLM model and display settings.
- **Ban / Unban / Bans List:** Manages global blacklist for users, servers, and channels.
- **AutoMod:** Toggles automatic AI moderation mode (Off / Monitor / Strict).
- **MCP Tools:** Server MCP tool management.
- **Bot Config:** AI runtime settings.

### `/ia_ferramentas` (Server Admin)

Independent slash command for server admins to manage MCP tools.

- **Action `list`:** Displays a public embed listing active and disabled tools on the server.
- **Action `toggle`:** Toggles availability for a specific tool (`join_voice_call`, `search_game`, `generate_image`, etc.).
- **Action `reset`:** Restores server tools to factory defaults.

### `/aceitar_tos` (Server Admin)

Displays and records acceptance of Hikari Terms of Service to unlock bot features on the server.

### `/ia_config` (Owner)

Low-level technical configuration for AI models (`Timeout`, `Temperature`, `Max Tokens`).

---

## 💡 Expert Tips

- 💡 **Privacy First:** Use the `visibility: Private` parameter in the `/ia_chat` command to handle sensitive matters or avoid cluttering the chat with long AI texts.
- 💡 **Image Quality:** When using `/ia_imagem`, put effort into the `negative_prompt` with terms like `blurry, deformed, low quality` to force the AI to generate sharper results.
- 💡 **AI Diversity:** If an image provider is slow, try changing the `provider` manually. `Pollinations` is generally the most stable, while `Together` offers high-fidelity FLUX models.
- 💡 **Context History:** Hikari "remembers" the channel's latest messages. Use this to your advantage when asking for summaries or continuing a conversation without needing to repeat everything.

---

[🏠 Back to Main Menu](../../README.md)
