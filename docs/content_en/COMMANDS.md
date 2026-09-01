# 🎮 Advanced Commands Guide

This document details all slash commands (/) available in Yui, their features, parameters, and permissions.

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

### `/yui`

The primary command for interacting with Yui's brain.

- **Prompt:** Your question or request.
- **Visibility:** Choose between `Public` (everyone sees) or `Private` (only you see).
- **Advanced:** If you mention others in the prompt, Yui may attempt to understand the context of the conversation.

### `/chat_resumo`

Reads the latest messages and generates a smart summary.

- **Quantity:** The number of messages to analyze (Min: 10, Max: 100).
- **Advanced:** Useful for understanding long discussions you missed.

### `/chat_humor` (Admin)

Changes Yui's "soul" in a specific channel.

- **Instruction:** New behavior rules (e.g., "Speak like a pirate").
- **Mood:** Emotional state (e.g., "Angry", "Happy").
- **Reset:** Returns to default settings.
- **Advanced:** These changes persist only in the channel where they were applied.

### `/chat_espontaneo` (Owner)

Configures Yui to intrude into conversations without being called.

- **State:** Enable or Disable.
- **Frequency:** Choose between `Low`, `Medium`, or `High`.
- **Percentage (🔒 Owner):** Exact chance (0-100%) for each message received in the channel.

---

## 🎨 Images & Art

### `/yui-imagem`

Generates images using various diffusion models.

- **Prompt:** Detailed description of what you want.
- **Negative Prompt:** What you DON'T want in the image.
- **Width/Height:** Image dimensions (512px to 1280px).
- **Provider:** Choose the generator (Stability, HuggingFace, Pollinations, etc.).
- **Advanced:** `Auto` mode will try providers in sequence until one works.

---

## 🎵 Multimedia & Utilities

### `/baixar_musica`

Central music download command in MP3 — accepts a link or a search.

- **URL (optional):** Link from YouTube, Spotify, Instagram, or TikTok.
- **Busca (optional):** Song name and/or artist (searches the Deezer catalog).
- **Advanced:** Automatically detects the URL source. For YouTube/Instagram/TikTok it uses `yt-dlp` + `ffmpeg`; for Spotify it uses `spot-dlp` natively when available, falling back to `yt-dlp`; for name/artist it uses the Deezer REST API with the `deemix` engine in HQ MP3 (with an interactive selection menu when ambiguous). Detects the server upload limit and reports the file size. Temporary files are removed after sending.

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

### `/yui-servidor` (Server Admin)

Unified public dashboard for server configuration.

- **Personality & Humor:** Custom instructions (prompts) and emotional states per channel.
- **Spontaneous Messages:** Controls toggle status and speech frequency.
- **Updates Channel:** Configures the official channel for system updates.
- **Mentions Response:** Toggles response to `@everyone` and `@here` mentions.
- **MCP Tools:** Opens the interactive MCP Tool Manager with tool descriptions, status list, and toggle buttons.

### `/yui-criador` (Owner / Creator)

Master Control Center for global Yui network management (hidden/ephemeral for creator).

- **Subcommands `painel` / `dashboard`:** Opens the Master Creator dashboard with button controls.
- **Models:** Configures active LLM model and display settings.
- **Ban / Unban / Bans List:** Manages global blacklist for users, servers, and channels.
- **AutoMod:** Toggles automatic AI moderation mode (Off / Monitor / Strict).
- **MCP Tools:** Server MCP tool management.
- **Bot Config:** AI runtime settings.

### `/yui-ferramentas` (Server Admin)

Independent slash command for server admins to manage MCP tools.

- **Action `list`:** Displays a public embed listing active and disabled tools on the server.
- **Action `toggle`:** Toggles availability for a specific tool (`join_voice_call`, `search_game`, `generate_image`, etc.).
- **Action `reset`:** Restores server tools to factory defaults.

### `/aceitar_tos` (Server Admin)

Displays and records acceptance of Yui Terms of Service to unlock bot features on the server.

### `/yui-config_ia` (Owner)

Low-level technical configuration for AI models (`Timeout`, `Temperature`, `Max Tokens`).

---

## 💡 Expert Tips

- 💡 **Privacy First:** Use the `visibility: Private` parameter in the `/yui` command to handle sensitive matters or avoid cluttering the chat with long AI texts.
- 💡 **Image Quality:** When using `/yui-imagem`, put effort into the `negative_prompt` with terms like `blurry, deformed, low quality` to force the AI to generate sharper results.
- 💡 **AI Diversity:** If an image provider is slow, try changing the `provider` manually. `Pollinations` is generally the most stable, while `Together` offers high-fidelity FLUX models.
- 💡 **Context History:** Yui "remembers" the channel's latest messages. Use this to your advantage when asking for summaries or continuing a conversation without needing to repeat everything.

---

[🏠 Back to Main Menu](../../README.md)
