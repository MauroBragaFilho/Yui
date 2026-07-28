<h1 align="center">🌌 Hikari (The Silver Glare) ✧</h1>

<div align="center">
  <picture>
    <source
      width="100%"
      srcset="https://i.imgur.com/2NTL0Cj.png"
      media="(prefers-color-scheme: dark)"
    />
    <source
      width="100%"
      srcset="https://i.imgur.com/2NTL0Cj.png"
      media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
    />
    <img width="250" src="https://i.imgur.com/2NTL0Cj.png" alt="Hikari Banner" />
  </picture>
  <p><i>"Nice to meet you! I'm Hikari, your personal AI agent for Discord... ✨"</i></p>
</div>

---

### 🎀 What can I do? (Features)

I'm not just a common chat bot! I'm an **Autonomous Agent** capable of interacting with the real world to help you:

- **🧠 Advanced Brain**: Support for multiple models via **Gemini**, **LM Studio (Local)**, and **HuggingFace**. My personality is natural and adaptable!
- **🌍 Smart Search**: If I don't know something, I research it on the internet in real-time, read the websites, and bring you a summarized report.
- **🎵 Personal DJ**: Download high-quality music tracks (Deezer HQ MP3) by song/artist name or extract audio from YouTube videos directly on Discord.
- **🎮 Gaming Corner**: I look for torrents and magnets for games (Dodi/Fitgirl) and natively consult **Steam** for prices and technical details.
- **🎨 Art Studio**: I can generate amazing images using Stability AI or Pollinations. Just ask!
- **💱 Finance Master**: I convert currencies and cryptocurrencies (BTC, USD, BRL) in real-time with official quotes.
- **🛡️ Silent Guardian**: Internal AutoMod system with automatic blocking of forbidden terms and appeal management.

---

### 🚀 How to wake me up (Installation)

#### ⚡ Fast Setup (Recommended)
For an automatic installation of all dependencies (Node.js, npm libraries, yt-dlp, and ffmpeg), use our setup scripts:

- **Windows:** Double-click the `setup.bat` file.
- **Linux:** Run `chmod +x setup.sh && ./setup.sh`.

---

#### 🛠️ Manual Method
If you prefer to do everything yourself (Ubuntu/Linux recommended):

1.  **Clone my code**:

    ```bash
    git clone https://github.com/yGuilhermy/Hikari.git
    cd Hikari
    ```

2.  **Install modules**:

    ```bash
    npm install
    ```

    _Note: You need `yt-dlp` and `ffmpeg` installed on your system for music functions to work properly!_

3.  **Configure my secrets**:
    - Rename `.env_example` to `.env` and fill in the keys.
    - **Tip:** You can change my name in `.env` by modifying `BOT_NAME`!

4.  **Start**:
    ```bash
    node index.js
    ```

---

### 📚 Wiki & Documentation

For detailed guides, configuration tips, and technical details, check our official documentation:

- [🚀 **Installation Guide**](./GET_STARTED.md): Everything to get Hikari up and running.
- [⚙️ **Configuration & Multi-Token**](./CONFIGURATION.md): How to use multiple keys and manage owners.
- [🛡️ **Security & AutoMod**](./MODERATION.md): Understand how bot protection works.
- [✨ **Features List**](./FEATURES.md): What and how to ask tasks from Hikari.
- [🎮 **Commands Guide**](./COMMANDS.md): Details for all Slash commands (/).
- [🛠️ **Variables & APIs**](./ENVIRONMENT.md): Explanation for each .env field and where to get keys.
- [🛠️ **Tools System (MCP)**](./ADVANCED.md): Documentation for developers and tools.

---

### ⚙️ Centralized Customization

Want to change my soul? Everything important is in `src/config/index.js`. There you can adjust:

- 👑 My master's ID (Owner ID)
- 📝 My System Prompt (My basic personality) (Note: If you work in English, change the system prompt to English)
- 🌐 Default AI URLs and Models
- 🤖 My activation name in chat

---

### 📝 Developer Notes

- Hikari is an AI in development, so she may not work perfectly in every case.
- You can change Hikari's name in `.env` by modifying `BOT_NAME`!
- If you're hosting a copy of Hikari, please keep the original repository linked!
- This is a personal project; don't expect extreme speed for updates, additions, or fixes.
- You're free to clone, modify, fork, and use as you wish, with due credit to the original repository.
- The primary server where Hikari was created: https://discord.gg/NXwKvKNKCd
- Original Hikari ID: 1429544961734885406

---

### 📝 ToDo (For myself)

- [ ] Add more features (MCPs)
- [ ] Support Ollama (it's easy, but I'm lazy)
- [ ] Add more AI models (Fallbacks)
- [ ] Add more integrations (APIs)
- [ ] Add more commands
- [ ] Optimize token usage
- [ ] Add more security

---

<div align="center">
  <p><i>"Don't forget to give me some love (and processing power)!"</i></p>
  <p>Made with 💜 and coffee by <b>yGuilhermy</b></p>
</div>
