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

Converts YouTube videos to MP3.

- **URL:** The video link.
- **Advanced:** Uses `yt-dlp` to extract audio with the best possible quality and cleans up temporary files after sending.

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
- **Advanced:** Uses the official exchange rate API to give the exact current quote. Integrated into the AI (you can just ask via chat).

---

## 🎮 Games & Downloads

### `/buscar_jogo`

Search for game torrents/magnets.

- **Name:** Game title.
- **Advanced:** Searches the FitGirl and DODI Repacks databases.

---

## 🏪 Store Inquiry

### `/steam_jogo`

Checks official information, price, and status in the Steam store.

- **Name:** Game name to search for.
- **Advanced:** Returns regional price, discount percentage, developers, and Metacritic score. The AI will make a small comment about the price or the game if the servers are online.

---

## ⚙️ Configuration & Administration

### `/ia_config` (Owner)

Adjusts technical parameters of AI models.

- **Provider:** Which AI to configure.
- **Setting:** Choose between `Timeout`, `Temperature`, or `Max Tokens`.
- **Value:** The new numeric value.

### `/ia_model_config` (Owner)

Configures the display of the model name in responses and in the AI's thinking/processing.

- **Show Model:** Displays or hides the model name in the AI's response.
- **Show Model Thought:** Displays or hides the name of the model that is processing the response in the thinking message.

### `/ia_prompt` (Owner)

Modifies the server's System Prompt.

- **Set:** Defines a complete new prompt.
- **Reset:** Returns to default.
- **View:** Shows the current prompt.

### `/ia_ferramentas` (Admin)

Manages which tools (MCP) the AI can use on the server.

- **Toggle:** Enables or disables tools like `web_search`, `image_gen`, etc.
- **List:** Shows the status of all tools.

### `/ia_mention_todos` (Admin)

Configures whether Hikari should respond to `@everyone` and `@here` mentions on the server.

- **Active:** Yes to respond, No to ignore.
- **Advanced:** Useful for preventing the AI from intruding on global server announcements, or for allowing it to interact when the whole server is called.

### `/adm_banir` / `/adm_desbanir` (Owner)

Hikari network global ban system.

- **Type:** User, Server, or Channel.
- **ID:** Target identifier.
- **Reason:** Justification for the block.

---

## 💡 Expert Tips

- 💡 **Privacy First:** Use the `visibility: Private` parameter in the `/ia_chat` command to handle sensitive matters or avoid cluttering the chat with long AI texts.
- 💡 **Image Quality:** When using `/ia_imagem`, put effort into the `negative_prompt` with terms like `blurry, deformed, low quality` to force the AI to generate sharper results.
- 💡 **AI Diversity:** If an image provider is slow, try changing the `provider` manually. `Pollinations` is generally the most stable, while `Together` offers high-fidelity FLUX models.
- 💡 **Context History:** Hikari "remembers" the channel's latest messages. Use this to your advantage when asking for summaries or continuing a conversation without needing to repeat everything.

---

[🏠 Back to Main Menu](../../README.md)
