// Reads the number in a small score box.
// The crop is made big and smooth, stretched to full contrast, and turned so the digits are dark on a
// light background. It is read several ways and the most common answer wins, so one bad read
// doesn't decide the score.

const SCALE = 6;

function toGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const g = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < g.length; i += 1) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return g;
}

function stretch(g) {
  const sorted = Float32Array.from(g).sort();
  const lo = sorted[Math.floor(sorted.length * 0.03)];
  const hi = sorted[Math.floor(sorted.length * 0.97)];
  const range = Math.max(hi - lo, 1);
  return g.map((v) => Math.min(255, Math.max(0, ((v - lo) * 255) / range)));
}

// Otsu: the brightness that best separates the picture into two groups
function otsu(g) {
  const hist = new Array(256).fill(0);
  g.forEach((v) => {
    hist[Math.round(v)] += 1;
  });
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i += 1) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

function framed(values, w, h) {
  const out = document.createElement('canvas');
  out.width = w + 60;
  out.height = h + 60;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < values.length; i += 1) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = values[i];
    img.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 30, 30);
  return out;
}

// groups of touching dark pixels, so the digit can be cut out from the junk around it
function blobs(ink, w, h) {
  const label = new Int32Array(w * h);
  const found = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!ink[start] || label[start]) continue;
    const id = found.length + 1;
    const stack = [start];
    label[start] = id;
    const blob = { x0: w, y0: h, x1: 0, y1: 0, area: 0, edge: false };
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      blob.area += 1;
      if (x < blob.x0) blob.x0 = x;
      if (x > blob.x1) blob.x1 = x;
      if (y < blob.y0) blob.y0 = y;
      if (y > blob.y1) blob.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) blob.edge = true;
      [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1].forEach((n) => {
        if (n >= 0 && ink[n] && !label[n]) {
          label[n] = id;
          stack.push(n);
        }
      });
    }
    found.push(blob);
  }
  return found;
}

// area to keep: the digits, which are the tall blobs that don't touch the edge of the crop
function digitArea(ink, w, h) {
  const inside = blobs(ink, w, h).filter((b) => !b.edge && b.y1 - b.y0 >= h * 0.2);
  if (inside.length === 0) return { x: 0, y: 0, w, h };
  const tallest = Math.max(...inside.map((b) => b.y1 - b.y0 + 1));
  const digits = inside.filter((b) => b.y1 - b.y0 + 1 >= tallest * 0.6);
  const x0 = Math.min(...digits.map((b) => b.x0));
  const x1 = Math.max(...digits.map((b) => b.x1));
  const y0 = Math.min(...digits.map((b) => b.y0));
  const y1 = Math.max(...digits.map((b) => b.y1));
  const pad = Math.round(tallest * 0.15);
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  return { x, y, w: Math.min(w, x1 + pad + 1) - x, h: Math.min(h, y1 + pad + 1) - y };
}

function cropValues(values, w, area) {
  const out = new Float32Array(area.w * area.h);
  for (let y = 0; y < area.h; y += 1) {
    for (let x = 0; x < area.w; x += 1) out[y * area.w + x] = values[(area.y + y) * w + area.x + x];
  }
  return out;
}

// a few cleaned up versions of the crop: [{ canvas, weight }]
export function scoreVariants(raw) {
  const big = document.createElement('canvas');
  big.width = raw.width * SCALE;
  big.height = raw.height * SCALE;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(raw, 0, 0, big.width, big.height);

  const g = stretch(toGray(big));
  const w = big.width;
  const h = big.height;

  // the digits are the smaller group of pixels, so they are the opposite of the box background
  const cut = otsu(g);
  let bright = 0;
  g.forEach((v) => {
    if (v > cut) bright += 1;
  });
  const oriented = bright > g.length / 2 ? g : g.map((v) => 255 - v);

  const orientedCut = otsu(oriented);
  const ink = oriented.map((v) => (v < orientedCut ? 1 : 0));
  const area = digitArea(ink, w, h);
  const part = cropValues(oriented, w, area);
  const partCut = otsu(part);
  const binary = part.map((v) => (v > partCut ? 255 : 0));
  const flipped = part.map((v) => 255 - v);

  return [
    { canvas: framed(part, area.w, area.h), weight: 2 },
    { canvas: framed(binary, area.w, area.h), weight: 2 },
    { canvas: framed(flipped, area.w, area.h), weight: 1 },
  ];
}

// ocr: { text(canvas, { whitelist, psm }) -> string }
// Reads one cell. pattern says what a valid answer looks like. returns { text, votes, tally } or null
export function createCellReader(ocr) {
  async function readCell(raw, { whitelist, pattern, minVotes = 4, minShare = 0.6 }) {
    const tally = {};
    for (const { canvas, weight } of scoreVariants(raw)) {
      for (const psm of ['8', '7']) {
        const text = (await ocr.text(canvas, { whitelist, psm })).replace(/\s+/g, '');
        if (pattern.test(text)) tally[text] = (tally[text] || 0) + weight;
      }
    }
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, e) => sum + e[1], 0);
    const best = entries[0];
    readCell.lastTally = tally;
    // not enough agreement means the picture was not clear, so give no answer
    if (!best || best[1] < minVotes || best[1] / total < minShare) return null;
    return { text: best[0], votes: best[1], tally };
  }
  return readCell;
}

// returns { value, votes } or null when nothing readable was found
export function createScoreReader(ocr) {
  const readCell = createCellReader(ocr);
  return async function readScore(raw) {
    const read = await readCell(raw, { whitelist: '0123456789', pattern: /^\d{1,3}$/ });
    return read ? { value: parseInt(read.text, 10), votes: read.votes, tally: read.tally } : null;
  };
}
