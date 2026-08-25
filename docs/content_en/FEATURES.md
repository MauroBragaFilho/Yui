# ✨ Features, AI, and Media Processing

Yui is not just a chat wrapper. It is an asynchronous processing ecosystem that combines LLMs, image diffusion, and metadata extraction.

---

## 📂 Summary

1. [🧠 1. Artificial Intelligence: The Prompt Life Cycle](#-1-artificial-intelligence-the-prompt-life-cycle)
2. [🎨 2. Image Generation (Provider Hierarchy)](#-2-image-generation-provider-hierarchy)
3. [🎵 3. Audio and YouTube Processing](#-3-audio-and-youtube-processing)
4. [💡 Advanced Usage Tips](#-advanced-usage-tips)

---

## 🧠 1. Artificial Intelligence: The Prompt Life Cycle

Yui processes all AI messages through a **Global Queue (`processingQueue`)**.

### Response Flow:

1.  **Context Capture:** Yui reads the last 5 to 10 messages from the channel (Short-term memory) to ensure coherence.
2.  **Trigger Identification:** The bot responds if:
    - It is mentioned (`@Yui`).
    - The text contains the word "Yui".
    - There is a direct reply to its message.
3.  **Multimodal Processing:** If an image is attached, it is sent along with the prompt for Vision analysis (subject to the capacity of the configured model). *(Vision support is currently being optimized)*
4.  **Tool Parsing:** The AI output is passed through a JSON parser that detects if it "decided" to use a tool (Web Search, Image, Music).

---

## 🎨 2. Image Generation (Provider Hierarchy)

Yui has an aggressive fallback engine to ensure the user receives their art, even if the main APIs fail.

**Execution Order:**

1.  **Stability AI (Ultra/Core):** If a `STABILITY_API_KEY` is present. Photorealistic quality.
2.  **Gradio/SDXL-Flash:** High-speed free fallback.
3.  **Hugging Face (FLUX.1):** SOTA models running on inference endpoints.
4.  **Stable Horde:** Decentralized GPU network (on-demand usage).
5.  **Pollinations:** The ultimate fallback for 100% availability.

---

## 🎵 3. Media Processing (Audio, Video, and Compression)

We implemented a complete system for downloading and manipulating media via `youtubeAudioHandler.js`.

- **Multiplatform Support:** The bot supports downloading audio and video from popular platforms such as YouTube (general for audio, Shorts-only for video), Instagram Reels, and TikTok (including subdomains like `vt.tiktok.com`).
- **Smart Audio Download:** Extracts only the best audio stream (`bestaudio`) via `yt-dlp` and dynamically converts it to MP3 using `ffmpeg`.
- **Deezer HQ Music Engine (100% Deezer):** Dedicated module (`deezerMusicService.js` / `deezerMusicHandler.js`) to search and download studio-quality tracks in high quality (HQ MP3 / 320kbps) via `deemix`. Features a keyword confidence scoring algorithm and presents an interactive select dropdown with 5 options when search is ambiguous. All MP3 files are temporary and cleaned up immediately after sending.
- **Video Download with Metadata:** When downloading videos, Yui can extract the original uploader and description for rich chat display, configurable via command parameters.
- **Smart Compression:** If the video file exceeds the server's upload limit (dynamically detected: 25MB default, 50MB for Boost Level 2, and 100MB for Boost Level 3), the user will be prompted to try compressing the video.
- **Global Queue & Host Protection:** The FFMPEG compression process runs in a global queue (only one compression at a time) to preserve VPS resources. There is an active RAM monitor: if memory usage exceeds 95%, the compression process is killed immediately to prevent host crashes.
- **Usage Limits:** There is a strict limit of 1 active download/process per user at a time to prevent abuse.
- **Automatic Cleanup:** All temporary files are deleted after sending. Large videos waiting for compression expire and are deleted after 6 hours.

---

## 💡 Advanced Usage Tips

- 💡 **Chat Summary (`/chat_resumo`):** The AI reads the last N messages and creates a semantic mapping of who said what and about which topics. Excellent for managing busy channels.
- 💡 **Trace.moe Integration:** The `/anime_origem` function allows you to find animes just by sending a frame. It returns the title, episode, and approximate timestamp.
- 💡 **Game Search and Steam Prices:** Yui not only searches for Magnet links in databases but can also natively consult **Steam**! Just ask naturally, like "Is Elden Ring on sale on Steam?", and she will return updated data, prices, and a synopsis, as well as add a fun comment.
- 💡 **Currency and Crypto Converter:** Convert any value between real currencies (BRL, USD, EUR) or crypto (BTC, ETH) just by asking "how much is bitcoin today?". She uses financial APIs with daily local caching and automatic fallback.
- 💡 **Computer Vision & Editing:** Yui has clear guidelines warning users that she cannot edit existing images and does not possess native computer vision in real-time.

---

> [!TIP]
> To see the full list of commands and detailed explanations, see the [Commands Guide](./COMMANDS.md).

---
[🏠 Back to Main Menu](../../README.md)
