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
const cp = require('child_process');
const { Ytdl } = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const ytdl = new Ytdl();

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

/**
 * GET /api/info
 * POST /api/info
 * Fetch metadata and available resolutions/formats
 */
async function handleInfo(req, res) {
  const rawUrl = req.method === 'POST' ? req.body.url : req.query.url;
  const videoId = extractVideoId(rawUrl);

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: 'URL YouTube tidak valid. Masukkan link video YouTube atau ID 11 karakter.'
    });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const info = await ytdl.getInfo(videoUrl);
    const details = info.videoDetails;

    // Pick best thumbnail
    const thumbnails = details.thumbnails || [];
    const bestThumbnail = thumbnails.length > 0 
      ? thumbnails[thumbnails.length - 1].url 
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Categorize formats
    const allFormats = info.formats || [];

    // Best audio format (for muxing with video-only streams)
    const bestAudio = allFormats
      .filter(f => !f.hasVideo && f.hasAudio)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    const audioSize = bestAudio ? (parseInt(bestAudio.contentLength, 10) || 0) : 0;

    // 1. All Video Resolutions (Muxed with Audio if DASH, or Progressive if available)
    const resolutionMap = new Map();

    // Priority for resolution quality
    const resOrder = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];

    allFormats
      .filter(f => f.hasVideo)
      .forEach(format => {
        const quality = format.qualityLabel || `${format.height}p`;
        if (!quality) return;

        // Clean quality tag (e.g. 1080p60 -> 1080p, but keep 60fps info)
        const match = quality.match(/^(\d+p)/);
        const baseKey = match ? match[1] : quality;

        const is60fps = format.fps && format.fps >= 50;
        const fpsLabel = is60fps ? ` (${format.fps}fps)` : '';
        const displayQuality = `${quality}${fpsLabel}`;

        const isProgressive = format.hasVideo && format.hasAudio;
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
          hasAudio: isProgressive,
          type: isProgressive ? 'progressive' : 'mux',
          sizeBytes: estimatedBytes,
          sizeFormatted: formatBytes(estimatedBytes),
          downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=${isProgressive ? 'progressive' : 'mux'}&itag=${format.itag}&quality=${encodeURIComponent(quality)}`
        };

        // Prefer MP4 container and higher fps if already exists
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

    // Sort video resolutions by descending height
    const videoList = Array.from(resolutionMap.values()).sort((a, b) => b.height - a.height);

    // 2. Audio Formats (MP3 transcode & M4A original)
    const audioList = [];

    // MP3 320kbps
    const durationSec = parseInt(details.lengthSeconds, 10) || 0;
    const mp3SizeEst = durationSec > 0 ? Math.round((320 * 1000 / 8) * durationSec) : 0;
    audioList.push({
      label: 'MP3 Audio (High Quality)',
      bitrate: '320 kbps',
      format: 'MP3',
      type: 'mp3',
      sizeBytes: mp3SizeEst,
      sizeFormatted: formatBytes(mp3SizeEst),
      downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=mp3&bitrate=320`
    });

    // MP3 128kbps (Standard)
    const mp3StdSizeEst = durationSec > 0 ? Math.round((128 * 1000 / 8) * durationSec) : 0;
    audioList.push({
      label: 'MP3 Audio (Standard)',
      bitrate: '128 kbps',
      format: 'MP3',
      type: 'mp3',
      sizeBytes: mp3StdSizeEst,
      sizeFormatted: formatBytes(mp3StdSizeEst),
      downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=mp3&bitrate=128`
    });

    // M4A Original
    if (bestAudio) {
      audioList.push({
        label: 'M4A Original (Direct Stream)',
        bitrate: `${bestAudio.audioBitrate || 128} kbps`,
        format: bestAudio.container ? bestAudio.container.toUpperCase() : 'M4A',
        type: 'audio_direct',
        itag: bestAudio.itag,
        sizeBytes: parseInt(bestAudio.contentLength, 10) || 0,
        sizeFormatted: formatBytes(parseInt(bestAudio.contentLength, 10)),
        downloadUrl: `/api/download?url=${encodeURIComponent(videoUrl)}&type=single&itag=${bestAudio.itag}&ext=${bestAudio.container || 'm4a'}`
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
        formats: {
          videos: videoList,
          audios: audioList,
          videoOnly: videoOnlyList
        }
      }
    });

  } catch (err) {
    console.error('Error fetching video info:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal mengambil metadata video YouTube: ' + (err.message || 'Error tidak diketahui')
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
  const { url, type = 'single', itag, quality, bitrate = '320', ext = 'mp4' } = req.query;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).send('Invalid or missing YouTube URL.');
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const info = await ytdl.getInfo(videoUrl);
    const title = sanitizeFilename(info.videoDetails.title);

    // ==========================================
    // TYPE 1: MP3 Audio Transcode
    // ==========================================
    if (type === 'mp3') {
      const filename = `${title} [${bitrate}kbps].mp3`;
      res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.header('Content-Type', 'audio/mpeg');

      const audioFormat = info.formats
        .filter(f => !f.hasVideo && f.hasAudio && f.container === 'm4a')
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
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
      const audioFormat = info.formats
        .filter(f => !f.hasVideo && f.hasAudio && f.container === 'm4a')
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] ||
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
