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
  const btnStyle = document.getElementById('btnStyle');

  const BLOCK_LEVELS = [' ', '░', '▒', '▓', '█'];
  const PUNCT_LEVELS = [' ', '`', ';', ':', "'", '"', ',', '.', '!', '-', '$'];
  const BAR_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const CLASSIC_LEVELS = ['.', ':', '-', '=', '+', '*', '#', '%', '@'];
  // Real 2x2 subpixel rendering: each cell samples a 2x2 block, each
  // corner is thresholded to lit/unlit, and the 4-bit pattern picks the
  // matching Unicode quadrant glyph - so the glyph's shape encodes actual
  // sub-cell detail (edges, corners) instead of just an average brightness.
  // Index = (TL<<3)|(TR<<2)|(BL<<1)|BR.
  const QUADRANT_GLYPHS = [
    ' ', '▗', '▖', '▄',
    '▝', '▐', '▞', '▟',
    '▘', '▚', '▌', '▙',
    '▀', '▜', '▛', '█'
  ];
  // Vertical-stroke/slash glyphs sorted light-to-heavy ink: tiny caret,
  // dots, thin verticals and single-barb harpoons, then letters/digits,
  // multi-component harpoons, parens/slashes, and finally the double
  // harpoon glyph as the densest.
  const LINE_LEVELS = [
    '^', ':', ';', '|', '⏐', '⇃', '⇂', 'l', 'i', '!', '¡', '1', 'I', 'j',
    '⥜', '⥙', '⥕', '(', ')', '\\', '/', '⥠'
  ];
  // Digits sorted light-to-heavy ink: '1' is a single thin stroke, '8' has
  // two enclosed loops and is the densest-looking digit.
  const NUM_LEVELS = ['1', '7', '4', '2', '3', '5', '9', '6', '0', '8'];
  // Subscript digits are smaller/lighter than full-size ones, so they make
  // a natural lighter tier ahead of the same digits at full size - doubling
  // the ramp to 20 levels for finer gradients.
  const SUB_LEVELS = ['₁', '₇', '₄', '₂', '₃', '₅', '₉', '₆', '₀', '₈'];
  const POWER_LEVELS = SUB_LEVELS.concat(NUM_LEVELS);
  const STYLES = [
    { mode: 'ramp', levels: PUNCT_LEVELS, label: 'STYLE 1' },
    { mode: 'ramp', levels: CLASSIC_LEVELS, label: 'STYLE 2' },
    { mode: 'quadrant', label: 'STYLE 3' },
    { mode: 'ramp', levels: BLOCK_LEVELS, label: 'STYLE 4' },
    { mode: 'ramp', levels: BAR_LEVELS, label: 'STYLE 5' },
    { mode: 'ramp', levels: LINE_LEVELS, label: 'STYLE 6' },
    { mode: 'ramp', levels: POWER_LEVELS, label: 'STYLE 7' }
  ];
  let styleIndex = 0; // always start on Style 1
  let levels = STYLES[styleIndex].levels;
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
  let sampleCols = cols;
  let sampleRows = rows;
  let fontSize = 10;
  let facing = 'environment';
  let frozen = false;
  let stream = null;
  let lastFrameTime = 0;
  let camGen = 0;
  let lastOut = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let pendingRecording = null;

  function setStatus(msg) {
    statusEl.textContent = 'STATUS: ' + msg;
    statusEl.classList.remove('hidden');
  }

  function clearStatus() {
    statusEl.classList.add('hidden');
  }

  function layout() {
    // Derive rows from the screen's own aspect ratio (not the camera's),
    // accounting for CHAR_ASPECT so the rendered character grid's pixel
    // aspect already matches the screen exactly. That means no stretching
    // is needed to fill the screen - the camera frame is center-cropped to
    // this same aspect instead (see renderFrame), so content keeps its
    // correct proportions and just loses the edges, like object-fit: cover.
    rows = Math.max(8, Math.round(cols * CHAR_ASPECT * window.innerHeight / window.innerWidth));
    // Quadrant mode samples a 2x2 block per character cell, so it needs
    // double the resolution in each dimension.
    const subpixel = STYLES[styleIndex].mode === 'quadrant';
    sampleCols = subpixel ? cols * 2 : cols;
    sampleRows = subpixel ? rows * 2 : rows;
    sampleCanvas.width = sampleCols;
    sampleCanvas.height = sampleRows;

    const dpr = window.devicePixelRatio || 1;
    displayCanvas.width = Math.round(window.innerWidth * dpr);
    displayCanvas.height = Math.round(window.innerHeight * dpr);
    displayCanvas.style.width = window.innerWidth + 'px';
    displayCanvas.style.height = window.innerHeight + 'px';
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    fontSize = Math.max(2, snapToDevicePixel(window.innerHeight / rows));
  }

  function snapToDevicePixel(cssPx) {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(cssPx * dpr) / dpr;
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
      clearStatus();
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
    dctx.imageSmoothingEnabled = false;
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    dctx.font = `${fontSize}px ${FONT_STACK}`;
    dctx.textBaseline = 'top';
    dctx.fillStyle = '#fff';
    for (let y = 0; y < out.length; y++) {
      dctx.fillText(out[y], 0, y * fontSize);
    }
  }

  function renderFrame(timestamp) {
    requestAnimationFrame(renderFrame);
    if (frozen) return;
    if (!video.videoWidth) return;
    const minInterval = 1000 / TARGET_FPS;
    if (timestamp - lastFrameTime < minInterval) return;
    lastFrameTime = timestamp;

    // Center-crop the camera frame to the screen's aspect ratio (object-fit:
    // cover), NOT the sample grid's cols/rows ratio - the grid is
    // deliberately skewed by CHAR_ASPECT (narrow monospace cells), and
    // sampling the full camera frame into it relies on that skew being
    // cancelled out by the character rendering. Cropping to cols/rows
    // instead breaks that cancellation and squishes the content.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const targetAspect = window.innerWidth / window.innerHeight;
    let sx, sy, sw, sh;
    if (vw / vh > targetAspect) {
      sh = vh;
      sw = vh * targetAspect;
      sx = (vw - sw) / 2;
      sy = 0;
    } else {
      sw = vw;
      sh = vw / targetAspect;
      sx = 0;
      sy = (vh - sh) / 2;
    }

    sctx.save();
    if (facing === 'user') {
      sctx.translate(sampleCols, 0);
      sctx.scale(-1, 1);
    }
    sctx.drawImage(video, sx, sy, sw, sh, 0, 0, sampleCols, sampleRows);
    sctx.restore();

    const data = sctx.getImageData(0, 0, sampleCols, sampleRows).data;
    const contrastFactor = parseInt(contrastSlider.value, 10) / 100;
    const invert = invertCb.checked;
    const dither = ditherCb.checked;

    function lumAt(x, y) {
      const p = (y * sampleCols + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      lum = (lum - 0.5) * contrastFactor + 0.5;
      if (invert) lum = 1 - lum;
      if (lum < 0) lum = 0;
      if (lum > 1) lum = 1;
      return lum;
    }

    const out = new Array(rows);
    if (STYLES[styleIndex].mode === 'quadrant') {
      for (let y = 0; y < rows; y++) {
        let line = '';
        const sy = y * 2;
        for (let x = 0; x < cols; x++) {
          const sx = x * 2;
          const tl = litBit(lumAt(sx, sy), sx, sy, dither);
          const tr = litBit(lumAt(sx + 1, sy), sx + 1, sy, dither);
          const bl = litBit(lumAt(sx, sy + 1), sx, sy + 1, dither);
          const br = litBit(lumAt(sx + 1, sy + 1), sx + 1, sy + 1, dither);
          line += QUADRANT_GLYPHS[(tl << 3) | (tr << 2) | (bl << 1) | br];
        }
        out[y] = line;
      }
    } else {
      for (let y = 0; y < rows; y++) {
        let line = '';
        for (let x = 0; x < cols; x++) {
          line += charFor(lumAt(x, y), x, y, dither);
        }
        out[y] = line;
      }
    }
    lastOut = out;
    paint(out);
  }

  function litBit(lum, x, y, dither) {
    if (dither) {
      const threshold = (BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
      return lum > threshold ? 1 : 0;
    }
    return lum > 0.5 ? 1 : 0;
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
      captureStream.getTracks().forEach(t => t.stop());
      setStatus('ERROR: ' + err.name + ' - ' + err.message);
      return;
    }
    recordedChunks = [];
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = (event) => {
      // Read the recorder off the event, not the outer `mediaRecorder`
      // variable: stopRecording() sets that to null right after calling
      // .stop(), and this handler fires later, asynchronously - so by the
      // time it runs, `mediaRecorder` is already null and `.mimeType` would
      // throw, silently aborting the save before it ever produced a file.
      const recorder = event.target;
      // The canvas capture track keeps feeding frames in the background
      // until explicitly stopped - without this, each recording leaks a
      // live capture pipeline that's never reclaimed for the rest of the
      // page's life.
      recorder.stream.getTracks().forEach(t => t.stop());
      const type = recorder.mimeType || 'video/mp4';
      const blob = new Blob(recordedChunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      recordedChunks = [];
      // iOS Safari only allows navigator.share()/anchor downloads inside a
      // real user gesture - onstop fires asynchronously after the gesture
      // that called stop(), so saving here would silently fail. Stage the
      // blob and require one more tap to save it.
      pendingRecording = { blob, filename: `ascii-cam-${Date.now()}.${ext}` };
      btnRecord.textContent = '[ SAVE VIDEO ]';
      btnRecord.classList.remove('active');
      btnRecord.classList.add('ready');
      btnRecord.disabled = false;
    };
    mediaRecorder.onerror = (event) => {
      setStatus('ERROR: RECORDING FAILED - ' + (event.error ? event.error.name : 'UNKNOWN'));
      btnRecord.textContent = '[ REC ]';
      btnRecord.classList.remove('active');
      btnRecord.disabled = false;
      mediaRecorder = null;
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
    btnRecord.textContent = '[ SAVING... ]';
    btnRecord.classList.remove('active');
    // onstop/onerror fire asynchronously after this returns - disable the
    // button so a fast double-tap can't call startRecording() while the
    // old recorder is still finalizing, which would leak it and let its
    // onstop clobber the new recording's UI state.
    btnRecord.disabled = true;
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

  btnStyle.addEventListener('click', () => {
    styleIndex = (styleIndex + 1) % STYLES.length;
    const style = STYLES[styleIndex];
    if (style.mode === 'ramp') levels = style.levels;
    btnStyle.textContent = style.label;
    layout();
  });

  displayCanvas.addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  btnPhoto.addEventListener('click', takePhoto);

  btnRecord.addEventListener('click', () => {
    if (pendingRecording) {
      const { blob, filename } = pendingRecording;
      pendingRecording = null;
      btnRecord.textContent = '[ REC ]';
      btnRecord.classList.remove('ready');
      shareOrDownload(blob, filename);
    } else if (mediaRecorder && mediaRecorder.state !== 'inactive') {
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
