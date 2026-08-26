# 🚀 Installation Guide and Quick Start (Get Started)

Welcome to the technical deployment guide for **Yui**. This document details how to prepare the environment, manage dependencies, and perform the initial system startup.

---

## 📂 Summary

1. [🖥️ 1. System Requirements](#-1-system-requirements)
2. [📥 2. Step-by-Step Installation](#-2-step-by-step-installation)
3. [🎮 3. Game Database (FitGirl & DODI)](#-3-game-database-fitgirl--dodi)
4. [🚀 4. Execution](#-4-execution)

---

## 🖥️ 1. System Requirements

For stable operation, the instance must meet the following requirements:

### ⚙️ Hardware and OS

- **OS:** Linux (Kernel 5.4+) recommended for better performance with `ffmpeg`. Windows 10/11 also supported.
- **Node.js:** Version **v22.x (LTS)**. The code uses modern syntax and CJS modules that perform better in this version.
- **Memory:** Minimum 1GB RAM (AI queue processing).

### 📦 External Dependencies (Required)

The bot depends on external binaries for media processing:

1.  **yt-dlp:** Must be in `PATH`. Used for extraction and download of YouTube streams.
2.  **ffmpeg:** Required for audio conversion and metadata extraction.

---

## 📥 2. Step-by-Step Installation

### ⚡ Fast Setup (Recommended)
To automate environment checking and dependency installation (including external binaries), use the scripts in the project root:

- **Windows:** Double-click the `setup.bat` file.
- **Linux:** `chmod +x setup.sh && ./setup.sh`.

---

### 🛠️ Manual Method
1.  **Clone the Repository:**

    ```bash
    git clone https://github.com/MauroBragaFilho/Yui.git
    cd Yui
    ```

2.  **Install Modules (NPM):**

    ```bash
    npm install
    ```

    _This will install critical packages like `discord.js`, `axios` (requests), `cheerio` (scraping), and `@gradio/client`._

3.  **Data Environment Configuration:**
    Yui requires certain folders to exist for caching and persistence:
    - `src/data/temp_images/` (Generated automatically, but ensure write permission).
    - `src/data/x.json` (Global database).

---

## 🎮 3. Game Database (FitGirl & DODI)

The game search functionality (`/buscar_jogo`) doesn't work by magic; it reads a local metadata library.

1.  Access the [Hydra Library](https://library.hydra.wiki/) portal.
2.  Download the **JSON** files corresponding to the **FitGirl** and **DODI** repacks.
3.  Rename and move them to:
    - `src/data/fitgirl.json`
    - `src/data/dodi.json`

---

## 🚀 4. Execution

Once the `.env` file is configured (See the [Environment Guide](./ENVIRONMENT.md)), start the process:

```bash
# Standard mode
node index.js

# Recommended for production (uses auto-restart in case of failure)
npx pm2 start index.js --name yui
```

### 💡 Expert Tips:

- 💡 **Global Propagation:** In Discord v14+, commands registered via `rest.put` may take up to 5 minutes to appear. Re-logging into the Discord client forces the UI cache update.
- 💡 **Write Permissions:** Ensure that the user running the script has full permission in the `src/data` folder, otherwise, the search filters and databases will fail silently.
- 💡 **Proxy/VPN:** If your hosting is on Oracle Cloud or AWS, you may need a rotating user-agent or proxy for the `/baixar_musica` command to avoid YouTube blocks.

---

[🏠 Back to Main Menu](../README.md)
