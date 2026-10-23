/**
 * app.js — Frontend Client for YouTube Downloader
 */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('downloadForm');
  const urlInput = document.getElementById('urlInput');
  const pasteBtn = document.getElementById('pasteBtn');
  const clearBtn = document.getElementById('clearBtn');
  const submitBtn = document.getElementById('submitBtn');
  const btnSpinner = document.getElementById('btnSpinner');
  const btnText = submitBtn.querySelector('.btn-text');

  const errorAlert = document.getElementById('errorAlert');
  const errorMessage = document.getElementById('errorMessage');
  const errorClose = document.getElementById('errorClose');

  const resultSection = document.getElementById('resultSection');
  const videoThumb = document.getElementById('videoThumb');
  const videoDuration = document.getElementById('videoDuration');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const videoViews = document.getElementById('videoViews');
  const videoDesc = document.getElementById('videoDesc');

  const videoFormatsBody = document.getElementById('videoFormatsBody');
  const audioFormatsBody = document.getElementById('audioFormatsBody');
  const videoOnlyBody = document.getElementById('videoOnlyBody');

  const toast = document.getElementById('downloadToast');
  const toastTitle = document.getElementById('toastTitle');
  const toastMessage = document.getElementById('toastMessage');

  const audioLangBar = document.getElementById('audioLangBar');
  const audioLangSelect = document.getElementById('audioLangSelect');
  const langPill = document.getElementById('langPill');
  let currentVideoUrl = '';

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const target = document.getElementById(btn.getAttribute('data-tab'));
      if (target) target.classList.add('active');
    });
  });

  // URL input change & clear button toggle
  urlInput.addEventListener('input', () => {
    clearBtn.style.display = urlInput.value.trim() ? 'block' : 'none';
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    urlInput.focus();
  });

  // Paste from clipboard
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        clearBtn.style.display = 'block';
        fetchVideoInfo(urlInput.value);
      }
    } catch (e) {
      alert('Izin membaca clipboard tidak diizinkan di browser Anda. Silakan tempel secara manual (Ctrl+V).');
    }
  });

  // Sample Chips
  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const url = chip.getAttribute('data-url');
      urlInput.value = url;
      clearBtn.style.display = 'block';
      fetchVideoInfo(url);
    });
  });

  // Error Alert close
  errorClose.addEventListener('click', () => {
    errorAlert.style.display = 'none';
  });

  // Form submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    fetchVideoInfo(url);
  });

  function showError(msg) {
    errorMessage.textContent = msg;
    errorAlert.style.display = 'flex';
    resultSection.style.display = 'none';
  }

  function hideError() {
    errorAlert.style.display = 'none';
  }

  function setLoading(loading) {
    if (loading) {
      submitBtn.disabled = true;
      btnSpinner.style.display = 'block';
      btnText.textContent = 'Memproses...';
    } else {
      submitBtn.disabled = false;
      btnSpinner.style.display = 'none';
      btnText.textContent = 'Ambil Format';
    }
  }

  function showToast(title, message) {
    toastTitle.textContent = title;
    toastMessage.textContent = message;
    toast.style.display = 'flex';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 6000);
  }

  function getBadgeClass(quality) {
    const q = (quality || '').toLowerCase();
    if (q.includes('2160p') || q.includes('4k')) return 'badge-4k';
    if (q.includes('1440p') || q.includes('2k')) return 'badge-2k';
    if (q.includes('1080p')) return 'badge-fhd';
    if (q.includes('720p')) return 'badge-hd';
    return 'badge-sd';
  }

  // Fetch Video Info from API
  async function fetchVideoInfo(url, audioLang = 'id') {
    hideError();
    setLoading(true);
    currentVideoUrl = url;

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, audioLang })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Gagal mengambil metadata video.');
      }

      renderVideoData(data.data);
    } catch (err) {
      showError(err.message || 'Terjadi kesalahan saat menghubungi server.');
    } finally {
      setLoading(false);
    }
  }

  // Handle user changing audio language dropdown
  if (audioLangSelect) {
    audioLangSelect.addEventListener('change', () => {
      const chosenLang = audioLangSelect.value;
      if (currentVideoUrl) {
        fetchVideoInfo(currentVideoUrl, chosenLang);
      }
    });
  }

  // Render video data & formats
  function renderVideoData(video) {
    videoThumb.src = video.thumbnail;
    videoDuration.textContent = video.durationFormatted || '00:00';
    videoTitle.textContent = video.title;
    videoChannel.textContent = video.channel;
    videoViews.textContent = `${video.viewsFormatted} tayangan`;
    videoDesc.textContent = video.description || 'Tidak ada deskripsi.';

    // Setup Audio Language Selector
    const audioLangs = video.audioLanguages || [];
    if (audioLangs.length > 1) {
      audioLangBar.style.display = 'flex';
      audioLangSelect.innerHTML = '';
      audioLangs.forEach(lang => {
        const opt = document.createElement('option');
        opt.value = lang.id;
        opt.textContent = lang.name;
        if (lang.id === video.selectedAudioLang) opt.selected = true;
        audioLangSelect.appendChild(opt);
      });

      const selectedLangObj = audioLangs.find(l => l.id === video.selectedAudioLang);
      if (selectedLangObj && selectedLangObj.isIndonesian) {
        langPill.textContent = '🇮🇩 Bahasa Indonesia Aktif';
        langPill.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      } else {
        langPill.textContent = `🌐 ${selectedLangObj ? selectedLangObj.name : 'Audio Terpilih'}`;
        langPill.style.background = 'rgba(99, 102, 241, 0.4)';
      }
    } else {
      audioLangBar.style.display = 'none';
    }

    // 1. Render Video Formats (Muxed / All Resolutions)
    videoFormatsBody.innerHTML = '';
    const videos = video.formats.videos || [];

    if (videos.length === 0) {
      videoFormatsBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Format video tidak ditemukan.</td></tr>';
    } else {
      videos.forEach(v => {
        const badgeClass = getBadgeClass(v.rawQuality || v.quality);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <span class="quality-badge ${badgeClass}">${v.quality}</span>
          </td>
          <td><span class="format-tag">${v.container.toUpperCase()}</span></td>
          <td><span class="size-tag">${v.fps ? v.fps + ' fps' : '30 fps'}</span></td>
          <td><span class="size-tag">${v.sizeFormatted}</span></td>
          <td class="text-right">
            <button class="btn-download" data-url="${v.downloadUrl}" data-name="${video.title} [${v.quality}].${v.container}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <span>Download</span>
            </button>
          </td>
        `;
        videoFormatsBody.appendChild(tr);
      });
    }

    // 2. Render Audio Formats
    audioFormatsBody.innerHTML = '';
    const audios = video.formats.audios || [];

    if (audios.length === 0) {
      audioFormatsBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Format audio tidak ditemukan.</td></tr>';
    } else {
      audios.forEach(a => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${a.label}</strong></td>
          <td><span class="quality-badge badge-mp3">${a.bitrate}</span></td>
          <td><span class="format-tag">${a.format}</span></td>
          <td><span class="size-tag">${a.sizeFormatted}</span></td>
          <td class="text-right">
            <button class="btn-download" data-url="${a.downloadUrl}" data-name="${video.title}.${a.format.toLowerCase()}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <span>Download Audio</span>
            </button>
          </td>
        `;
        audioFormatsBody.appendChild(tr);
      });
    }

    // 3. Render Video Only (DASH)
    videoOnlyBody.innerHTML = '';
    const videoOnly = video.formats.videoOnly || [];

    if (videoOnly.length === 0) {
      videoOnlyBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Format DASH tidak tersedia.</td></tr>';
    } else {
      videoOnly.forEach(vo => {
        const badgeClass = getBadgeClass(vo.quality);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="quality-badge ${badgeClass}">${vo.quality}</span></td>
          <td><span class="format-tag">${vo.container}</span></td>
          <td><span class="size-tag">${vo.fps} fps</span></td>
          <td><span class="size-tag">${vo.sizeFormatted}</span></td>
          <td class="text-right">
            <button class="btn-download" data-url="${vo.downloadUrl}" data-name="${video.title} [${vo.quality}-mute].${vo.container.toLowerCase()}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <span>Download</span>
            </button>
          </td>
        `;
        videoOnlyBody.appendChild(tr);
      });
    }

    // Bind click events on all download buttons
    document.querySelectorAll('.btn-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const downloadUrl = btn.getAttribute('data-url');
        const fileName = btn.getAttribute('data-name');
        triggerDownload(downloadUrl, fileName);
      });
    });

    resultSection.style.display = 'block';
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Trigger download in browser
  function triggerDownload(url, filename) {
    showToast('Memulai Unduhan...', `Server sedang memproses dan mengirimkan file "${filename}". Unduhan akan segera muncul di browser.`);

    // Create hidden iframe or anchor to trigger browser download
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', filename);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 1000);
  }
});
