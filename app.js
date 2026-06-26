(() => {
  const displayCanvas = document.getElementById('display');
  const dctx = displayCanvas.getContext('2d');
  const video = document.getElementById('video');
  const sampleCanvas = document.getElementById('sample');
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const statusEl = document.getElementById('status');

  const colsSlider = document.getElementById('cols');
  const colsVal = document.getElementById('colsVal');
  const contrastSlider = document.getElementById('contrast');
  const contrastVal = document.getElementById('contrastVal');
  const invertCb = document.getElementById('invert');
  const ditherCb = document.getElementById('dither');
  const btnFlip = document.getElementById('btnFlip');
  const btnFreeze = document.getElementById('btnFreeze');
  const btnPanel = document.getElementById('btnPanel');
  const panel = document.getElementById('panel');
  const btnPhoto = document.getElementById('btnPhoto');
  const btnRecord = document.getElementById('btnRecord');
  const styleBlocksBtn = document.getElementById('styleBlocks');
  const stylePunctBtn = document.getElementById('stylePunct');

  const BLOCK_LEVELS = [' ', '░', '▒', '▓', '█'];
  const PUNCT_LEVELS = [' ', ';', ':', "'", '"', ',', '.', '-', '$'];
  let levels = BLOCK_LEVELS;
  const CHAR_ASPECT = 0.58; // approx width/height ratio of a monospace glyph
  const FONT_STACK = "Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";
  const BAYER = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 5, 13
  ];
  const TARGET_FPS = 20;

  let cols = parseInt(colsSlider.value, 10);
  let rows = 30;
  let fontSize = 10;
  let offsetX = 0;
  let offsetY = 0;
  let facing = 'environment';
  let frozen = false;
  let stream = null;
  let lastFrameTime = 0;
  let camGen = 0;
  let lastOut = null;
  let mediaRecorder = null;
  let recordedChunks = [];

  function setStatus(msg) {
    statusEl.textContent = 'STATUS: ' + msg;
  }

  function layout() {
    const vw = video.videoWidth || 4;
    const vh = video.videoHeight || 3;
    rows = Math.max(8, Math.round(cols * (vh / vw) * CHAR_ASPECT));
    sampleCanvas.width = cols;
    sampleCanvas.height = rows;

    const dpr = window.devicePixelRatio || 1;
    displayCanvas.width = Math.round(window.innerWidth * dpr);
    displayCanvas.height = Math.round(window.innerHeight * dpr);
    displayCanvas.style.width = window.innerWidth + 'px';
    displayCanvas.style.height = window.innerHeight + 'px';
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const fsByWidth = window.innerWidth / (cols * CHAR_ASPECT);
    const fsByHeight = window.innerHeight / rows;
    fontSize = Math.max(2, Math.floor(Math.min(fsByWidth, fsByHeight)));

    dctx.font = `${fontSize}px ${FONT_STACK}`;
    const textWidth = dctx.measureText('#'.repeat(cols)).width;
    offsetX = Math.max(0, (window.innerWidth - textWidth) / 2);
    offsetY = Math.max(0, (window.innerHeight - rows * fontSize) / 2);
  }

  async function startCamera(preferredFacing) {
    const gen = ++camGen;
    setStatus('REQUESTING CAMERA...');
    if (!window.isSecureContext) {
      setStatus('ERROR: INSECURE CONTEXT - USE HTTPS URL');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('ERROR: CAMERA API UNAVAILABLE IN THIS BROWSER');
      return;
    }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: preferredFacing },
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });
      // Another startCamera call superseded this one, or the page went to
      // the background while we were awaiting permission: drop this stream
      // instead of leaving an orphaned, unstoppable live track.
      if (gen !== camGen || document.hidden) {
        s.getTracks().forEach(t => t.stop());
        return;
      }
      stream = s;
      video.srcObject = stream;
      await video.play();
      facing = preferredFacing;
      layout();
      setStatus('CAMERA ACTIVE (' + (facing === 'user' ? 'FRONT' : 'REAR') + ')');
    } catch (err) {
      setStatus('ERROR: ' + err.name + ' - ' + err.message);
    }
  }

  function charFor(brightness, x, y, dither) {
    const n = levels.length;
    const scaled = brightness * (n - 1);
    let idx = Math.floor(scaled);
    const frac = scaled - idx;
    if (dither) {
      const threshold = (BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
      if (frac > threshold && idx < n - 1) idx++;
    } else {
      idx = Math.round(scaled);
    }
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    return levels[idx];
  }

  function paint(out) {
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    dctx.font = `${fontSize}px ${FONT_STACK}`;
    dctx.textBaseline = 'top';
    dctx.fillStyle = '#d8d8d8';
    for (let y = 0; y < out.length; y++) {
      dctx.fillText(out[y], offsetX, offsetY + y * fontSize);
    }
  }

  function renderFrame(timestamp) {
    requestAnimationFrame(renderFrame);
    if (frozen) return;
    if (!video.videoWidth) return;
    const minInterval = 1000 / TARGET_FPS;
    if (timestamp - lastFrameTime < minInterval) return;
    lastFrameTime = timestamp;

    sctx.save();
    if (facing === 'user') {
      sctx.translate(cols, 0);
      sctx.scale(-1, 1);
    }
    sctx.drawImage(video, 0, 0, cols, rows);
    sctx.restore();

    const data = sctx.getImageData(0, 0, cols, rows).data;
    const contrastFactor = parseInt(contrastSlider.value, 10) / 100;
    const invert = invertCb.checked;
    const dither = ditherCb.checked;

    const out = new Array(rows);
    let p = 0;
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        p += 4;
        let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        lum = (lum - 0.5) * contrastFactor + 0.5;
        if (invert) lum = 1 - lum;
        if (lum < 0) lum = 0;
        if (lum > 1) lum = 1;
        line += charFor(lum, x, y, dither);
      }
      out[y] = line;
    }
    lastOut = out;
    paint(out);
  }

  async function shareOrDownload(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch {
        // user cancelled, or share failed - fall through to a plain download
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function takePhoto() {
    if (lastOut) paint(lastOut); // make sure the canvas holds a fresh frame
    displayCanvas.toBlob(blob => {
      if (blob) shareOrDownload(blob, `ascii-cam-${Date.now()}.png`);
    }, 'image/png');
  }

  function pickRecordingMimeType() {
    const candidates = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  function startRecording() {
    if (!window.MediaRecorder || !displayCanvas.captureStream) {
      setStatus('ERROR: RECORDING UNSUPPORTED IN THIS BROWSER');
      return;
    }
    const captureStream = displayCanvas.captureStream(TARGET_FPS);
    const mimeType = pickRecordingMimeType();
    try {
      mediaRecorder = new MediaRecorder(captureStream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      setStatus('ERROR: ' + err.name + ' - ' + err.message);
      return;
    }
    recordedChunks = [];
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || 'video/mp4';
      const blob = new Blob(recordedChunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      shareOrDownload(blob, `ascii-cam-${Date.now()}.${ext}`);
      recordedChunks = [];
    };
    mediaRecorder.start();
    btnRecord.textContent = '[ STOP ]';
    btnRecord.classList.add('active');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
    btnRecord.textContent = '[ REC ]';
    btnRecord.classList.remove('active');
  }

  colsSlider.addEventListener('input', () => {
    cols = parseInt(colsSlider.value, 10);
    colsVal.textContent = cols;
    layout();
  });

  contrastSlider.addEventListener('input', () => {
    contrastVal.textContent = contrastSlider.value;
  });

  btnFlip.addEventListener('click', () => {
    startCamera(facing === 'user' ? 'environment' : 'user');
  });

  btnFreeze.addEventListener('click', () => {
    frozen = !frozen;
    btnFreeze.textContent = frozen ? 'UNFREEZE' : 'FREEZE';
    if (stream) {
      stream.getVideoTracks().forEach(t => { t.enabled = !frozen; });
    }
  });

  btnPanel.addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });

  styleBlocksBtn.addEventListener('click', () => {
    levels = BLOCK_LEVELS;
    styleBlocksBtn.classList.add('active');
    stylePunctBtn.classList.remove('active');
  });

  stylePunctBtn.addEventListener('click', () => {
    levels = PUNCT_LEVELS;
    stylePunctBtn.classList.add('active');
    styleBlocksBtn.classList.remove('active');
  });

  displayCanvas.addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  btnPhoto.addEventListener('click', takePhoto);

  btnRecord.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
    } else {
      startCamera(facing).then(() => {
        if (frozen && stream) stream.getVideoTracks().forEach(t => { t.enabled = false; });
      });
    }
  });

  window.addEventListener('resize', layout);
  video.addEventListener('loadedmetadata', layout);

  startCamera(facing);
  requestAnimationFrame(renderFrame);
})();
