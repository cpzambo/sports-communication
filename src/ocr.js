// OCR helpers. tesseract.js loads on first use and needs internet for its data files.

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js')
      .then(({ createWorker }) => createWorker('eng'))
      .catch((err) => {
        workerPromise = null; // try again next time
        throw err;
      });
  }
  return workerPromise;
}

// one job at a time
function runOcr(canvas, { whitelist, psm = '7' } = {}, wantBlocks = false) {
  const job = async () => {
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: whitelist || '',
      tessedit_pageseg_mode: psm,
    });
    // word boxes need blocks: true
    const { data } = await worker.recognize(canvas, {}, wantBlocks ? { blocks: true } : {});
    return data;
  };
  const result = queue.then(job, job);
  queue = result.catch(() => {});
  return result;
}

export const recognizeText = (canvas, opts) => runOcr(canvas, opts).then((d) => d.text || '');

// words with their pixel boxes
export async function recognizeWords(canvas, opts) {
  const data = await runOcr(canvas, opts, true);
  const words = [];
  (data.blocks || []).forEach((b) =>
    b.paragraphs.forEach((p) =>
      p.lines.forEach((l) =>
        l.words.forEach((w) => words.push({ text: w.text, confidence: w.confidence, ...w.bbox }))
      )
    )
  );
  return words;
}

// waits for the seek to finish, with a timeout
export function seekVideo(video, time) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    timer = setTimeout(done, 2500);
    video.currentTime = time;
  });
}

// region at time t, blended between keyframes [{ t, x, y, w, h }]
export function regionAt(keys, t) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1 || t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i += 1;
  const a = keys[i];
  const b = keys[i + 1];
  const f = (t - a.t) / (b.t - a.t || 1);
  const lerp = (u, v) => u + (v - u) * f;
  return { t, x: lerp(a.x, b.x), y: lerp(a.y, b.y), w: lerp(a.w, b.w), h: lerp(a.h, b.h) };
}

// finds clock shaped text (like 10:45) in a frame, returns the text and a padded region
export async function findClockInCanvas(canvas) {
  const words = await recognizeWords(canvas, { whitelist: '0123456789:.', psm: '11' });
  const hits = words
    .map((w) => ({ w, text: parseClock(w.text) }))
    .filter((h) => h.text && /\d{1,2}[:;.,']\d/.test(h.w.text))
    .sort((a, b) => b.w.confidence - a.w.confidence);
  if (hits.length === 0) return null;
  const { w, text } = hits[0];
  const padX = (w.x1 - w.x0) * 0.2;
  const padY = (w.y1 - w.y0) * 0.35;
  const x0 = Math.max(0, w.x0 - padX);
  const y0 = Math.max(0, w.y0 - padY);
  const x1 = Math.min(canvas.width, w.x1 + padX);
  const y1 = Math.min(canvas.height, w.y1 + padY);
  return {
    text,
    region: { x: x0 / canvas.width, y: y0 / canvas.height, w: (x1 - x0) / canvas.width, h: (y1 - y0) / canvas.height },
  };
}

// where the picture sits inside the video element (it can be letterboxed)
export function contentRect(video) {
  const w = video.clientWidth;
  const h = video.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { left: 0, top: 0, width: w, height: h };
  const scale = Math.min(w / vw, h / vh);
  const cw = vw * scale;
  const ch = vh * scale;
  return { left: (w - cw) / 2, top: (h - ch) / 2, width: cw, height: ch };
}

// crops a region (fractions 0 to 1) and prepares it for OCR: bigger, grey, dark text on light
export function cropToCanvas(video, region, { minHeight = 120, maxWidth = 0, invert: invertMode = 'auto', raw = false } = {}) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = Math.max(0, Math.floor(region.x * vw));
  const sy = Math.max(0, Math.floor(region.y * vh));
  const sw = Math.max(2, Math.min(vw - sx, Math.floor(region.w * vw)));
  const sh = Math.max(2, Math.min(vh - sy, Math.floor(region.h * vh)));

  let scale = Math.max(1, minHeight / sh);
  if (maxWidth && sw * scale > maxWidth) scale = maxWidth / sw;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (raw) return canvas;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  const invert = invertMode === 'auto' ? sum / (d.length / 4) < 128 : !!invertMode;
  if (invert) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// "10:45" and "09:45" become "10:45" and "9:45", "9:45.3" keeps its tenths, "9.3" becomes "0:09.3".
// Separators that get misread (; , ') count as a colon
export function parseClock(text) {
  const words = String(text || '').trim().split(/\s+/);
  // "Q2 9:53": read each piece on its own so the quarter doesn't stick to the minutes
  for (const word of words) {
    const t = word.replace(/(?<=\d)[;,'](?=\d{2})/g, ':');
    const mmss = t.match(/(\d{1,2}):([0-5]\d)(?:\.(\d))?/);
    if (mmss) return `${parseInt(mmss[1], 10)}:${mmss[2]}${mmss[3] ? '.' + mmss[3] : ''}`;
  }
  for (const word of words) {
    const tenths = word.match(/(?<!\d)(\d{1,2})\.(\d)(?!\d)/);
    if (tenths && parseInt(tenths[1], 10) < 60) return `0:${tenths[1].padStart(2, '0')}.${tenths[2]}`;
  }
  return '';
}
