/**
 * server.js — YouTube Multi-Resolution Video & Audio Downloader Backend
 * 
 * Express + @distube/ytdl-core + ffmpeg-static
 * Supports:
 *   - Video with Audio for ALL resolutions (4K 2160p, 2K 1440p, 1080p, 720p, 480p, 360p)
 *   - On-the-fly zero-CPU video remuxing with audio via ffmpeg (-c:v copy)
 *   - Audio transcode to MP3 (320kbps) & Original M4A stream
 *   - Raw DASH Video-only & Progressive stream downloads
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { Ytdl, createPoTokenProvider } = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: load YouTube cookie from env var YOUTUBE_COOKIE or local cookies.txt
function getCookie() {
  if (process.env.YOUTUBE_COOKIE && process.env.YOUTUBE_COOKIE.trim()) {
    return process.env.YOUTUBE_COOKIE.trim();
  }
  const cookieFile = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookieFile)) {
    try {
      const content = fs.readFileSync(cookieFile, 'utf8').trim();
      if (content) {
        console.log('🍪 Loaded YouTube cookie from cookies.txt');
        return content;
      }
    } catch (e) {
      console.warn('⚠️ Gagal membaca cookies.txt:', e.message);
    }
  }
  return undefined;
}

// Dynamic Ytdl instance manager with Proof-of-Origin (PO Token) & Cookie support
// Bypasses YouTube datacenter bot detection ("Sign in to confirm you're not a bot") on Heroku/AWS
let ytdlInstance = null;
let poTokenPromise = null;

async function getYtdl() {
  if (ytdlInstance) return ytdlInstance;
  if (!poTokenPromise) {
    poTokenPromise = (async () => {
      const cookie = getCookie();
      if (cookie) {
        console.log('🔐 Initializing Ytdl with authenticated YouTube session (signedIn: true)');
      }
      try {
        console.log('🔄 Minting PO Token provider for cloud/Heroku bypass...');
        const poTokenProvider = await createPoTokenProvider({ timeoutMs: 25000 });
        console.log('✅ PO Token provider active');
        return new Ytdl({
          getPoToken: poTokenProvider,
          cookie: cookie,
          lang: 'id'
        });
      } catch (err) {
        console.warn('⚠️ Could not mint PO Token, falling back to client:', err.message);
        return new Ytdl({
          cookie: cookie,
          lang: 'id'
        });
      }
    })();
  }
  ytdlInstance = await poTokenPromise;
  return ytdlInstance;
}

// Pre-warm PO token on server startup
getYtdl().catch(() => {});

// Helper: get video info with automatic region/geo-fence fallback
async function getVideoInfo(videoUrl) {
  const ytdl = await getYtdl();
  try {
    return await ytdl.getInfo(videoUrl);
  } catch (err) {
    if (err.message && (err.message.includes('not made this video available in your country') || err.code === 'REGION_BLOCKED')) {
      console.log('🌐 Region block detected, retrying with global fallback...');
      const cookie = getCookie();
      const fallbackYtdl = new Ytdl({ cookie, lang: 'id' });
      return await fallbackYtdl.getInfo(videoUrl);
    }
    throw err;
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Utility: format bytes to human readable string
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return 'Ukuran bervariasi';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

// Utility: format seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  const sec = parseInt(seconds, 10);
  if (isNaN(sec)) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Utility: sanitize filename for Windows & Unix
function sanitizeFilename(name) {
  return (name || 'youtube_video')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 150);
}

// Utility: extract video id from various YouTube URL formats
function extractVideoId(input) {
  if (!input) return null;
  const str = input.trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  if (match) return match[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return null;
}

// Utility: extract list of all audio languages available on the video
function getAudioLanguages(formats) {
  const map = new Map();
  const audioFormats = formats.filter(f => !f.hasVideo && f.hasAudio);

  audioFormats.forEach(f => {
    if (f.audioTrack) {
      const trackId = f.audioTrack.id || 'default';
      const rawName = f.audioTrack.displayName || trackId;
      const isIndonesian = trackId.toLowerCase().startsWith('id') || rawName.toLowerCase().includes('indonesia');
      const key = isIndonesian ? 'id' : trackId;
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name: isIndonesian ? 'Bahasa Indonesia (Dubbing)' : rawName,
          isDefault: !!f.audioTrack.audioIsDefault,
          isIndonesian: isIndonesian
        });
      }
    }
  });

  if (map.size === 0) {
    map.set('original', {
      id: 'original',
      name: 'Bahasa Asli (Original)',
      isDefault: true,
      isIndonesian: false
    });
  }

  // Indonesian first, then default track, then alphabetically
  return Array.from(map.values()).sort((a, b) => {
    if (a.isIndonesian) return -1;
    if (b.isIndonesian) return 1;
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
}

// Utility: find best audio stream by target language (defaults to Indonesian if available)
function findBestAudio(formats, targetLang = 'id') {
  const audioFormats = formats.filter(f => !f.hasVideo && f.hasAudio);
  if (audioFormats.length === 0) return null;

  // 1. If targetLang is 'id' or default, prioritize Indonesian audio track
  if (targetLang === 'id' || !targetLang) {
    const idAudios = audioFormats.filter(f =>
      f.audioTrack && (
        f.audioTrack.id?.toLowerCase().startsWith('id') ||
        f.audioTrack.displayName?.toLowerCase().includes('indonesia')
      )
    );
    if (idAudios.length > 0) {
      return idAudios.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
    }
  }

  // 2. Specific language ID requested
  if (targetLang && targetLang !== 'id' && targetLang !== 'original') {
    const matchAudios = audioFormats.filter(f =>
      f.audioTrack && (
        f.audioTrack.id?.toLowerCase().startsWith(targetLang.toLowerCase()) ||
        f.audioTrack.displayName?.toLowerCase().includes(targetLang.toLowerCase())
      )
    );
    if (matchAudios.length > 0) {
      return matchAudios.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
    }
  }

  // 3. Default original audio track
  const defaultAudios = audioFormats.filter(f => f.audioTrack?.audioIsDefault);
  if (defaultAudios.length > 0) {
    return defaultAudios.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
  }

  // 4. Highest bitrate audio fallback
  return audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
}

/**
 * GET /api/info
 * POST /api/info
 * Fetch metadata and available resolutions/formats
 */
async function handleInfo(req, res) {
  const rawUrl = req.method === 'POST' ? req.body.url : req.query.url;
  const requestedLang = (req.method === 'POST' ? req.body.audioLang : req.query.audioLang) || 'id';
  const videoId = extractVideoId(rawUrl);

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: 'URL YouTube tidak valid. Masukkan link video YouTube atau ID 11 karakter.'
    });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const ytdl = await getYtdl();
    const info = await getVideoInfo(videoUrl);
    const details = info.videoDetails;

    // Pick best thumbnail
    const thumbnails = details.thumbnails || [];
    const bestThumbnail = thumbnails.length > 0 
      ? thumbnails[thumbnails.length - 1].url 
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Categorize formats
    const allFormats = info.formats || [];
    const audioLanguages = getAudioLanguages(allFormats);
    const hasIndonesian = audioLanguages.some(l => l.isIndonesian);

    // Active audio language: if requested is 'id' and Indonesian exists, use 'id'
    const activeLang = (requestedLang === 'id' && !hasIndonesian)
      ? (audioLanguages[0] ? audioLanguages[0].id : 'original')
      : requestedLang;

    // Best audio format for selected language
    const bestAudio = findBestAudio(allFormats, activeLang);
    const audioSize = bestAudio ? (parseInt(bestAudio.contentLength, 10) || 0) : 0;

    // 1. All Video Resolutions (Muxed with chosen audio language)
    const resolutionMap = new Map();

    allFormats
      .filter(f => f.hasVideo)
      .forEach(format => {
        const quality = format.qualityLabel || `${format.height}p`;
        if (!quality) return;

        const match = quality.match(/^(\d+p)/);
        const baseKey = match ? match[1] : quality;

        const is60fps = format.fps && format.fps >= 50;
        const fpsLabel = is60fps ? ` (${format.fps}fps)` : '';
        const displayQuality = `${quality}${fpsLabel}`;

        // If multi-language audio exists, we MUST mux to guarantee Indonesian dubbing!
        const isProgressive = format.hasVideo && format.hasAudio && audioLanguages.length <= 1;
        const videoSize = parseInt(format.contentLength, 10) || 0;
        const estimatedBytes = isProgressive ? videoSize : (videoSize > 0 && audioSize > 0 ? videoSize + audioSize : videoSize);

        const item = {
          itag: format.itag,
          baseKey: baseKey,
          quality: displayQuality,
          rawQuality: quality,
          height: format.height || parseInt(baseKey, 10) || 0,
          fps: format.fps || 30,
          container: format.container || 'mp4',
          hasAudio: true,
          type: isProgressive ? 'progressive' : 'mux',
          audioLang: activeLang,
          sizeBytes: estimatedBytes,
          sizeFormatted: formatBytes(estimatedBytes),
          downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=${isProgressive ? 'progressive' : 'mux'}&itag=${format.itag}&quality=${encodeURIComponent(quality)}&audioLang=${encodeURIComponent(activeLang)}`
        };

        const existing = resolutionMap.get(baseKey);
        if (!existing) {
          resolutionMap.set(baseKey, item);
        } else {
          const isBetterFps = item.fps > existing.fps;
          const isBetterContainer = existing.container !== 'mp4' && item.container === 'mp4';
          const isBetterSize = !existing.sizeBytes && item.sizeBytes > 0;
          if (isBetterFps || isBetterContainer || isBetterSize) {
            resolutionMap.set(baseKey, item);
          }
        }
      });

    const videoList = Array.from(resolutionMap.values()).sort((a, b) => b.height - a.height);

    // 2. Audio Formats in Selected Language
    const audioList = [];
    const activeLangObj = audioLanguages.find(l => l.id === activeLang);
    const langLabel = activeLangObj ? ` [${activeLangObj.name}]` : '';

    const durationSec = parseInt(details.lengthSeconds, 10) || 0;
    const mp3SizeEst = durationSec > 0 ? Math.round((320 * 1000 / 8) * durationSec) : 0;
    audioList.push({
      label: `MP3 Audio (High Quality)${langLabel}`,
      bitrate: '320 kbps',
      format: 'MP3',
      type: 'mp3',
      audioLang: activeLang,
      sizeBytes: mp3SizeEst,
      sizeFormatted: formatBytes(mp3SizeEst),
      downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=mp3&bitrate=320&audioLang=${encodeURIComponent(activeLang)}`
    });

    const mp3StdSizeEst = durationSec > 0 ? Math.round((128 * 1000 / 8) * durationSec) : 0;
    audioList.push({
      label: `MP3 Audio (Standard)${langLabel}`,
      bitrate: '128 kbps',
      format: 'MP3',
      type: 'mp3',
      audioLang: activeLang,
      sizeBytes: mp3StdSizeEst,
      sizeFormatted: formatBytes(mp3StdSizeEst),
      downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=mp3&bitrate=128&audioLang=${encodeURIComponent(activeLang)}`
    });

    if (bestAudio) {
      audioList.push({
        label: `M4A Track Asli${langLabel}`,
        bitrate: `${bestAudio.audioBitrate || 128} kbps`,
        format: (bestAudio.container || 'M4A').toUpperCase(),
        type: 'audio_direct',
        itag: bestAudio.itag,
        audioLang: activeLang,
        sizeBytes: parseInt(bestAudio.contentLength, 10) || 0,
        sizeFormatted: formatBytes(parseInt(bestAudio.contentLength, 10)),
        downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=single&itag=${bestAudio.itag}&ext=${bestAudio.container || 'm4a'}&audioLang=${encodeURIComponent(activeLang)}`
      });
    }

    // 3. Raw Video Only (DASH)
    const videoOnlyList = allFormats
      .filter(f => f.hasVideo && !f.hasAudio)
      .map(f => {
        const size = parseInt(f.contentLength, 10) || 0;
        return {
          itag: f.itag,
          quality: f.qualityLabel || `${f.height}p`,
          container: (f.container || 'mp4').toUpperCase(),
          fps: f.fps || 30,
          sizeBytes: size,
          sizeFormatted: formatBytes(size),
          downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=single&itag=${f.itag}&ext=${f.container || 'mp4'}`
        };
      })
      .slice(0, 8);

    return res.json({
      success: true,
      data: {
        id: videoId,
        url: videoUrl,
        title: details.title,
        channel: details.author ? details.author.name : 'Unknown Channel',
        channelUrl: details.author ? details.author.channel_url : null,
        durationSeconds: durationSec,
        durationFormatted: formatDuration(durationSec),
        views: parseInt(details.viewCount, 10) || 0,
        viewsFormatted: Number(details.viewCount || 0).toLocaleString('id-ID'),
        uploadDate: details.uploadDate,
        thumbnail: bestThumbnail,
        description: (details.description || '').substring(0, 300),
        audioLanguages: audioLanguages,
        selectedAudioLang: activeLang,
        hasIndonesianAudio: hasIndonesian,
        formats: {
          videos: videoList,
          audios: audioList,
          videoOnly: videoOnlyList
        }
      }
    });

  } catch (err) {
    console.error('Error fetching video info:', err);
    let msg = err.message || 'Error tidak diketahui';
    if (err.code === 'BOT_CHECK' || (err.message && err.message.toLowerCase().includes('bot'))) {
      msg = 'YouTube mendeteksi IP Datacenter Heroku (Bot Check). Masukkan YOUTUBE_COOKIE di Config Vars Heroku untuk mengaktifkan sesi terautentikasi.';
    }
    return res.status(500).json({
      success: false,
      code: err.code || 'ERROR',
      error: 'Gagal mengambil metadata video YouTube: ' + msg
    });
  }
}

app.get('/api/info', handleInfo);
app.post('/api/info', handleInfo);

/**
 * GET /api/download
 * Stream video/audio file with attachment header
 */
app.get('/api/download', async (req, res) => {
  const { url, type = 'single', itag, quality, bitrate = '320', ext = 'mp4', audioLang = 'id' } = req.query;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).send('Invalid or missing YouTube URL.');
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const ytdl = await getYtdl();
    const info = await getVideoInfo(videoUrl);
    const title = sanitizeFilename(info.videoDetails.title);

    // ==========================================
    // TYPE 1: MP3 Audio Transcode
    // ==========================================
    if (type === 'mp3') {
      const filename = `${title} [${bitrate}kbps].mp3`;
      res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.header('Content-Type', 'audio/mpeg');

      const audioFormat = findBestAudio(info.formats, audioLang || 'id') ||
        info.formats.filter(f => !f.hasVideo && f.hasAudio)[0];

      const audioStream = ytdl.download(videoUrl, { format: audioFormat });

      audioStream.on('error', err => {
        console.error('Audio stream error:', err);
        if (!res.headersSent) res.status(500).send('Stream error');
      });

      const ffmpegProcess = cp.spawn(ffmpegPath, [
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', `${bitrate}k`,
        '-f', 'mp3',
        'pipe:1'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      audioStream.pipe(ffmpegProcess.stdin);
      ffmpegProcess.stdout.pipe(res);

      ffmpegProcess.stdin.on('error', () => {});
      ffmpegProcess.stdout.on('error', () => {});
      ffmpegProcess.on('error', () => {});

      req.on('close', () => {
        try { audioStream.unpipe(); } catch (e) {}
        try { audioStream.destroy(); } catch (e) {}
        try { ffmpegProcess.kill(); } catch (e) {}
      });

      ffmpegProcess.stderr.on('data', d => console.error('FFmpeg stderr:', d.toString()));
      return;
    }

    // ==========================================
    // TYPE 2: Muxed High-Res Video + Audio (1080p, 1440p, 4K, 720p)
    // ==========================================
    if (type === 'mux') {
      // Find requested video format
      let videoFormat = null;
      if (itag) {
        videoFormat = info.formats.find(f => f.itag == itag);
      }
      if (!videoFormat && quality) {
        videoFormat = info.formats.find(f => f.hasVideo && !f.hasAudio && f.qualityLabel === quality && f.container === 'mp4') ||
                      info.formats.find(f => f.hasVideo && !f.hasAudio && f.qualityLabel === quality);
      }
      if (!videoFormat) {
        // Fallback to highest video format
        videoFormat = info.formats
          .filter(f => f.hasVideo)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      }

      // Best audio stream
      const audioFormat = findBestAudio(info.formats, audioLang || 'id') ||
        info.formats.filter(f => !f.hasVideo && f.hasAudio)[0];

      const qLabel = videoFormat.qualityLabel || `${videoFormat.height}p`;
      const filename = `${title} [${qLabel}].mp4`;

      res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.header('Content-Type', 'video/mp4');

      const videoStream = ytdl.download(videoUrl, { format: videoFormat });
      const audioStream = ytdl.download(videoUrl, { format: audioFormat });

      videoStream.on('error', err => console.error('Video stream error:', err.message));
      audioStream.on('error', err => console.error('Audio stream error:', err.message));

      // Fast remux: zero video re-encoding (-c:v copy)
      // MP4 output streamed via fragmented moov flags
      const ffmpegProcess = cp.spawn(ffmpegPath, [
        '-loglevel', 'error',
        '-i', 'pipe:3',
        '-i', 'pipe:4',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        'pipe:1'
      ], {
        stdio: ['inherit', 'pipe', 'pipe', 'pipe', 'pipe']
      });

      ffmpegProcess.stdio[1].on('error', () => {});
      ffmpegProcess.stdio[2].on('error', () => {});
      ffmpegProcess.stdio[3].on('error', () => {});
      ffmpegProcess.stdio[4].on('error', () => {});
      ffmpegProcess.on('error', () => {});

      videoStream.pipe(ffmpegProcess.stdio[3]);
      audioStream.pipe(ffmpegProcess.stdio[4]);
      ffmpegProcess.stdio[1].pipe(res);

      req.on('close', () => {
        try { videoStream.unpipe(); } catch (e) {}
        try { audioStream.unpipe(); } catch (e) {}
        try { videoStream.destroy(); } catch (e) {}
        try { audioStream.destroy(); } catch (e) {}
        try { ffmpegProcess.kill(); } catch (e) {}
      });

      ffmpegProcess.stdio[2].on('data', d => console.error('FFmpeg mux error:', d.toString()));
      return;
    }

    // ==========================================
    // TYPE 3: Single Direct Stream (Progressive or Audio M4A or Raw Video)
    // ==========================================
    let targetFormat = null;
    if (itag) {
      targetFormat = info.formats.find(f => f.itag == itag);
    }
    if (!targetFormat) {
      targetFormat = info.formats.find(f => f.hasVideo && f.hasAudio) || info.formats[0];
    }

    const fileExt = ext || targetFormat.container || 'mp4';
    const qualityTag = targetFormat.qualityLabel ? ` [${targetFormat.qualityLabel}]` : '';
    const filename = `${title}${qualityTag}.${fileExt}`;

    res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.header('Content-Type', targetFormat.mimeType ? targetFormat.mimeType.split(';')[0] : 'application/octet-stream');

    if (targetFormat.contentLength) {
      res.header('Content-Length', targetFormat.contentLength);
    }

    const stream = ytdl.download(videoUrl, { format: targetFormat });
    stream.on('error', err => console.error('Single stream error:', err.message));
    stream.pipe(res);

    req.on('close', () => {
      try { stream.destroy(); } catch (e) {}
    });

  } catch (err) {
    console.error('Download stream error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error streaming media: ' + (err.message || 'Unknown error'));
    }
  }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'YouTube Multi-Resolution Downloader API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Guard against client abort / socket EOF exceptions
process.on('uncaughtException', (err) => {
  if (err.code === 'EOF' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET') {
    return; // Normal client disconnect during streaming
  }
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 YouTube Downloader Server running on port ${PORT}`);
  console.log(`🌐 Web UI: http://localhost:${PORT}`);
  console.log(`📡 API Endpoints:`);
  console.log(`   - POST/GET /api/info?url=<youtube_url>`);
  console.log(`   - GET /api/download?url=<url>&type=mux&quality=1080p`);
  console.log(`   - GET /api/health`);
  console.log(`====================================================`);
});
