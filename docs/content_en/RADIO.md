# 📻 Radio Mode System & Audio Streaming

Hikari's **Radio Mode** is a complete musical playback and interactive voice ecosystem for Discord channels, combining real-time progressive audio streaming, multi-platform support, and autonomous AI control.

---

## 📂 Table of Contents

1. [🎵 1. Playback & Progressive Streaming (YouTube & PCM)](#-1-playback--progressive-streaming-youtube--pcm)
2. [🌐 2. Link Support & Media Resolution](#-2-link-support--media-resolution)
3. [🎙️ 3. Voice Control & Speech Recognition (Whisper STT)](#-3-voice-control--speech-recognition-whisper-stt)
4. [🎛️ 4. Graphical Interface & Controls (Embeds & Buttons)](#-4-graphical-interface--controls-embeds--buttons)
5. [🧹 5. Smart Cleanup & Temporary File Management](#-5-smart-cleanup--temporary-file-management)
6. [💡 Tips & Troubleshooting](#-tips--troubleshooting)

---

## 🎵 1. Playback & Progressive Streaming (YouTube & PCM)

Radio Mode eliminates the need to download full YouTube files before starting playback.

- **Real-Time Streaming (`youtubeBufferStream.js`)**: Pipes `yt-dlp` output directly into `ffmpeg`, producing a continuous stream of linear PCM s16le audio (48,000 Hz, 16-bit stereo).
- **Minimum Initial Buffer**: Waits for **4 seconds of audio** (768,000 bytes) to start playing on Discord in ~4 seconds after request.
- **Flow Control (Backpressure)**: Pauses process reading when buffer reaches **20 seconds** (3,840,000 bytes) and resumes when it drops below **10 seconds**, optimizing VPS memory.
- **Underflow Handling**: On network drops, feeds 20ms silence frames to maintain `@discordjs/voice` clock sync without dropping the player.

---

## 🌐 2. Link Support & Media Resolution

Media resolution (`radioProviders.js`) supports multiple formats with instant extraction:

- **YouTube & YouTube Music**:
  - Individual Videos (`youtube.com/watch?v=...`, `music.youtube.com/watch?v=...`).
  - Playlists (`youtube.com/playlist?list=...`, `music.youtube.com/playlist?list=...`): Extracted via NDJSON (Line-delimited JSON) adding all valid tracks to the queue.
  - Fast Metadata: Combines **YouTube oEmbed API** (~50ms) with `yt-dlp -j` parser to fetch title, channel/artist, and HD cover without failing on warning logs.
- **Deezer**:
  - Songs (`deezer.com/.../track/ID`), Playlists (`deezer.com/.../playlist/ID`), and Albums (`deezer.com/.../album/ID`).
- **Text Search**:
  - Non-link text queries search Deezer API with phonetic confidence scoring. Scores `>= 80%` add the track directly; ambiguous queries present a Discord selection menu.

---

## 🎙️ 3. Voice Control & Speech Recognition (Whisper STT)

- **Real-Time Voice Commands**: Integrated listener captures speech from unmuted users in the channel, decodes PCM WAV audio, and sends it to the Whisper API.
- **MCP Tools**: Radio voice commands natively trigger Hikari's MCP Tools (`radioMCPTools.json`).
- **Rate Limit Protection (429/492)**: Upon hitting Whisper API quota limits, voice listening is temporarily paused for **1 minute**, notifying the chat and auto-enabling afterward.
- **Empty Channel Monitoring**: Closes session and disconnects call if no human users are present in the channel for over 10 seconds.

---

## 🎛️ 4. Graphical Interface & Controls (Embeds & Buttons)

The visual Radio panel (`radioEmbed.js`) provides real-time interactive controls:

- **Available Controls**:
  - `➕ Add`: Interactive modal to paste links or search songs.
  - `🗑️ Remove`: Interactive modal to remove a specific song from the playlist by position number (`#x`).
  - `⏯️ Play/Pause`: Toggles playback and pause.
  - `⏹️ Stop`: Completely stops playback, jumps to the end of the queue, and sets the radio status to "playing nothing".
  - `⏭️ Next` / `⏮️ Prev`: Navigates between queue/history tracks.
  - `🔀 Shuffle`: Toggles random queue order.
  - `🔁 Loop`: Cycles modes (Off ➔ Playlist ➔ Song).
  - `🎙️ Voice`: Toggles voice listening.
  - `📋 Queue`: Displays ephemeral menu with upcoming tracks.
  - `👋 Leave`: Stops radio mode and disconnects the bot.
- **Ambiguous Cancel**: The `Cancel` button on ambiguous search selections removes components and clears pending state.

---

## 🧹 5. Smart Cleanup & Temporary File Management

- **Cleanup Service (`radioCleaner.js`)**: Monitors `src/music/data/temp_radio_audio`.
- **Active Track Protection**: Checks all active sessions (`getAllSessions()`) and preserves currently playing files.
- **Auto Purge**: Deletes unreferenced temporary files older than 15 minutes. Runs on startup and every 10 minutes.
- **`.gitignore` Configuration**:
  ```gitignore
  src/music/data/temp_radio_audio/
  src/music/data/
  ```

---

## 💡 Tips & Troubleshooting

- 💡 **Smooth Transitions**: Uses internal locks (`transitioningGuilds`) to prevent transition loops and suppress `Premature close` errors.
- 💡 **Message Deletion**: All temporary message deletions use `.catch(() => {})` handlers against `Unknown Message` exceptions.

---

> [!TIP]
> For advanced specifications on AI tools, visit the [Tools Documentation (MCP)](./ADVANCED.md).

---

[🏠 Back to Main Menu](../README.md)
