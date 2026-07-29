const { Readable } = require('stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

const DEFAULT_MIN_INITIAL_SEC = 4;
const DEFAULT_MAX_BUFFER_SEC = 20;
const DEFAULT_RESUME_BUFFER_SEC = 10;

class YouTubeBufferStream extends Readable {
    constructor(url, options = {}) {
        super(options);
        this.url = url;
        this.bufferQueue = [];
        this.bufferedBytes = 0;
        this.isPausedReading = false;
        this.isFinishedDownloading = false;
        this.isBuffering = false;
        this.destroyedStream = false;

        this.minInitialBytes = (options.minBufferSec || DEFAULT_MIN_INITIAL_SEC) * BYTES_PER_SECOND;
        this.maxBufferBytes = (options.maxBufferSec || DEFAULT_MAX_BUFFER_SEC) * BYTES_PER_SECOND;
        this.resumeBufferBytes = (options.resumeBufferSec || DEFAULT_RESUME_BUFFER_SEC) * BYTES_PER_SECOND;

        this.readyPromise = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });

        this._startProcess();
    }

    _startProcess() {
        const cookiesPath = config.ytdlpCookiesPath;
        const cookieFlags = (cookiesPath && fs.existsSync(cookiesPath)) ? ['--cookies', cookiesPath] : [];
        const extraFlags = config.ytdlpExtraFlags || [];

        const ytdlpArgs = [
            '--no-playlist',
            '--no-warnings',
            '--no-update',
            ...cookieFlags,
            ...extraFlags,
            '-o', '-',
            '-f', 'bestaudio/best',
            this.url
        ];

        const ffmpegArgs = [
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ac', String(CHANNELS),
            '-ar', String(SAMPLE_RATE),
            '-loglevel', 'quiet',
            'pipe:1'
        ];

        this.ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
        this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        this.ytdlpProcess.stdout.pipe(this.ffmpegProcess.stdin);

        this.ffmpegProcess.stdout.on('data', (chunk) => {
            if (this.destroyedStream) return;

            this.bufferQueue.push(chunk);
            this.bufferedBytes += chunk.length;

            if (this._resolveReady && this.bufferedBytes >= this.minInitialBytes) {
                const resolve = this._resolveReady;
                this._resolveReady = null;
                resolve();
            }

            if (this.isBuffering && this.bufferedBytes >= this.minInitialBytes) {
                this.isBuffering = false;
            }

            if (!this.isPausedReading && this.bufferedBytes >= this.maxBufferBytes) {
                this.isPausedReading = true;
                this.ffmpegProcess.stdout.pause();
            }
        });

        this.ffmpegProcess.stdout.on('end', () => {
            this.isFinishedDownloading = true;
            if (this._resolveReady) {
                const resolve = this._resolveReady;
                this._resolveReady = null;
                resolve();
            }
        });

        const handleError = (err) => {
            if (this._rejectReady) {
                const reject = this._rejectReady;
                this._rejectReady = null;
                reject(err);
            }
            this.destroy(err);
        };

        this.ytdlpProcess.on('error', handleError);
        this.ffmpegProcess.on('error', handleError);

        this.ytdlpProcess.stdin?.on('error', () => {});
        this.ffmpegProcess.stdin?.on('error', () => {});
    }

    _read(size) {
        if (this.destroyedStream) return;

        if (this.bufferQueue.length > 0) {
            const chunk = this.bufferQueue.shift();
            this.bufferedBytes -= chunk.length;

            if (this.isPausedReading && this.bufferedBytes <= this.resumeBufferBytes) {
                this.isPausedReading = false;
                if (this.ffmpegProcess && this.ffmpegProcess.stdout) {
                    this.ffmpegProcess.stdout.resume();
                }
            }

            this.push(chunk);
        } else {
            if (this.isFinishedDownloading) {
                this.push(null);
            } else {
                this.isBuffering = true;
                const silenceFrame = Buffer.alloc(Math.floor(BYTES_PER_SECOND * 0.02));
                this.push(silenceFrame);
            }
        }
    }

    _destroy(err, callback) {
        if (this.destroyedStream) return;
        this.destroyedStream = true;
        this.bufferQueue = [];
        this.bufferedBytes = 0;

        try {
            this.push(null);
        } catch (_) {}

        if (this.ytdlpProcess) {
            try { this.ytdlpProcess.kill('SIGKILL'); } catch (_) {}
        }
        if (this.ffmpegProcess) {
            try { this.ffmpegProcess.kill('SIGKILL'); } catch (_) {}
        }

        if (callback) callback(err);
    }

    waitUntilReady() {
        return this.readyPromise;
    }
}

function createYouTubeProgressiveStream(url, options) {
    return new YouTubeBufferStream(url, options);
}

module.exports = {
    YouTubeBufferStream,
    createYouTubeProgressiveStream
};
