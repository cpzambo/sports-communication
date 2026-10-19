// Finds the layout of a scoreboard from a few pictures of it taken at different times.
// The scoreboard stays in place while the video behind it changes, so pixels that barely change
// between pictures belong to the scoreboard. Its rows and cells are then found from where the
// text is, and each cell is read on its own.

import { parseClock, findClockInCanvas } from './ocr';

const gray = (canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const g = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < g.length; i += 1) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return g;
};

// the middle value and the typical change of every pixel across the pictures.
// The change is measured from the middle value, so a few pictures without the scoreboard don't spoil it
export function combine(canvases) {
  const w = canvases[0].width;
  const h = canvases[0].height;
  const frames = canvases.map(gray);
  const median = new Float32Array(w * h);
  const spread = new Float32Array(w * h);
  const values = new Array(frames.length);
  const away = new Array(frames.length);
  const mid = Math.floor(frames.length / 2);
  for (let i = 0; i < w * h; i += 1) {
    for (let k = 0; k < frames.length; k += 1) values[k] = frames[k][i];
    values.sort((a, b) => a - b);
    median[i] = values[mid];
    for (let k = 0; k < frames.length; k += 1) away[k] = Math.abs(values[k] - median[i]);
    away.sort((a, b) => a - b);
    spread[i] = away[mid];
  }
  return { w, h, median, spread };
}

function dilate(mask, w, h, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function erode(mask, w, h, r) {
  const inverted = mask.map((v) => 1 - v);
  return dilate(inverted, w, h, r).map((v) => 1 - v);
}

// the biggest connected group of pixels in a mask
function biggestGroup(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  let best = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const group = { pixels: [], x0: w, y0: h, x1: 0, y1: 0 };
    while (stack.length) {
      const i = stack.pop();
      group.pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < group.x0) group.x0 = x;
      if (x > group.x1) group.x1 = x;
      if (y < group.y0) group.y0 = y;
      if (y > group.y1) group.y1 = y;
      [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1].forEach((n) => {
        if (n >= 0 && mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      });
    }
    if (!best || group.pixels.length > best.pixels.length) best = group;
  }
  return best;
}

// runs of true values: [{ start, end }], joining runs that are closer than `gap`
function runs(flags, gap) {
  const out = [];
  let open = null;
  let quiet = 0;
  flags.forEach((on, i) => {
    if (on) {
      if (!open) open = { start: i, end: i };
      open.end = i;
      quiet = 0;
    } else if (open) {
      quiet += 1;
      if (quiet > gap) {
        out.push(open);
        open = null;
      }
    }
  });
  if (open) out.push(open);
  return out;
}

// rows of text and the cells inside them, in the coordinates of the pictures
export function findCells(canvases, options = {}) {
  const { still = 10, edge = 60, rowMin = 10, rowGap = 2, cellGap = 3 } = options;
  const { w, h, median, spread } = combine(canvases);

  // pixels that stay the same belong to the scoreboard. Closing fills the gaps left by changing digits
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i += 1) mask[i] = spread[i] < still ? 1 : 0;
  mask = erode(dilate(mask, w, h, 2), w, h, 2);
  let board = biggestGroup(mask, w, h);

  // no solid background: the text floats over the video, so only the pixels that stay put can be text
  let floating = false;
  const inside = new Uint8Array(w * h);
  if (!board || board.pixels.length < w * h * 0.08) {
    floating = true;
    board = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    for (let i = 0; i < inside.length; i += 1) inside[i] = spread[i] < still * 1.5 ? 1 : 0;
  } else {
    board.pixels.forEach((i) => {
      inside[i] = 1;
    });
  }

  // text has corners: strong edges in both directions close together. Straight borders and stripes do not
  const across = new Uint8Array(w * h);
  const down = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      if (!inside[i]) continue;
      across[i] = Math.abs(median[i + 1] - median[i - 1]) > edge ? 1 : 0;
      down[i] = Math.abs(median[i + w] - median[i - w]) > edge ? 1 : 0;
    }
  }
  const nearAcross = dilate(across, w, h, 2);
  const nearDown = dilate(down, w, h, 2);
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < ink.length; i += 1) {
    ink[i] = inside[i] && nearAcross[i] && nearDown[i] && (across[i] || down[i]) ? 1 : 0;
    inkCount += ink[i];
  }
  if (floating && inkCount < 30) return { found: false, w, h, median };

  const rowFlags = [];
  for (let y = board.y0; y <= board.y1; y += 1) {
    let sum = 0;
    for (let x = board.x0; x <= board.x1; x += 1) sum += ink[y * w + x];
    rowFlags.push(sum >= rowMin);
  }
  const bands = runs(rowFlags, rowGap)
    .filter((r) => r.end - r.start >= 5)
    .map((r) => ({ y0: board.y0 + r.start, y1: board.y0 + r.end }));

  const rows = bands.map((band) => {
    const colFlags = [];
    for (let x = board.x0; x <= board.x1; x += 1) {
      let count = 0;
      for (let y = band.y0; y <= band.y1; y += 1) count += ink[y * w + x];
      colFlags.push(count >= 1);
    }
    const cells = runs(colFlags, cellGap)
      .filter((c) => c.end - c.start >= 3)
      .map((c) => ({ x0: board.x0 + c.start, x1: board.x0 + c.end, y0: band.y0, y1: band.y1 }));
    return { ...band, cells };
  });

  return { found: true, floating, w, h, median, board: { x0: board.x0, y0: board.y0, x1: board.x1, y1: board.y1 }, rows };
}

// the median picture as a canvas, so a cell can be handed to the readers
export function medianCanvas(layout, box, pad = 2) {
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(layout.w - 1, box.x1 + pad);
  const y1 = Math.min(layout.h - 1, box.y1 + pad);
  const canvas = document.createElement('canvas');
  canvas.width = x1 - x0 + 1;
  canvas.height = y1 - y0 + 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const v = layout.median[(y0 + y) * layout.w + x0 + x];
      const o = (y * canvas.width + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// reads a clock like 10:45 from a small crop, trying both light and dark text
async function clockText(ocr, crop) {
  const scale = 6;
  const big = document.createElement('canvas');
  big.width = crop.width * scale;
  big.height = crop.height * scale;
  const ctx = big.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop, 0, 0, big.width, big.height);
  const img = ctx.getImageData(0, 0, big.width, big.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v;
    sum += v;
  }
  const dark = sum / (d.length / 4) < 128;
  for (const flip of [dark, !dark]) {
    const copy = ctx.createImageData(img);
    for (let i = 0; i < d.length; i += 4) {
      const v = flip ? 255 - d[i] : d[i];
      copy.data[i] = copy.data[i + 1] = copy.data[i + 2] = v;
      copy.data[i + 3] = 255;
    }
    const framed = document.createElement('canvas');
    framed.width = big.width + 60;
    framed.height = big.height + 60;
    const fctx = framed.getContext('2d');
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, framed.width, framed.height);
    ctx.putImageData(copy, 0, 0);
    fctx.drawImage(big, 30, 30);
    const raw = (await ocr.text(framed, { whitelist: '0123456789:.', psm: '7' })).replace(/\s+/g, '');
    const text = parseClock(raw);
    if (text && raw.replace(/^0+(?=\d)/, '').length <= text.length + 1) return text;
  }
  return '';
}

// a clock that is just text on the video, in any of the usual formats, found by looking for clock-shaped text
async function floatingClock(canvases) {
  for (const picture of canvases.slice(-3).reverse()) {
    const hit = await findClockInCanvas(picture);
    if (hit) {
      const { x, y, w, h } = hit.region;
      return {
        x0: Math.floor(x * picture.width),
        y0: Math.floor(y * picture.height),
        x1: Math.ceil((x + w) * picture.width) - 1,
        y1: Math.ceil((y + h) * picture.height) - 1,
      };
    }
  }
  return null;
}

// canvases: pictures of the tagged scoreboard area taken at different times (the last ones are read for the clock)
// ocr: { text(canvas, { whitelist, psm }) -> string }
// returns { found, w, h, teams: [{ name, score, nameBox, scoreBox }], clockBox } with boxes in picture coordinates
export async function detectScoreboard(canvases, ocr, createCellReader, debug) {
  const layout = findCells(canvases);
  if (!layout.found) {
    const clockBox = await floatingClock(canvases);
    return clockBox ? { found: true, w: canvases[0].width, h: canvases[0].height, teams: [], clockBox } : { found: false };
  }
  const readCell = createCellReader(ocr);

  // every row that has a name, with every cell to the right of it that could be a score
  const candidates = [];
  for (const row of layout.rows) {
    if (row.cells.length < 2) continue;
    const height = row.y1 - row.y0 + 1;

    let name = null;
    for (const cell of row.cells) {
      if (cell.x1 - cell.x0 < height * 0.6) continue;
      const read = await readCell(medianCanvas(layout, cell), {
        whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        pattern: /^[A-Z]{2,5}$/,
        minVotes: 3,
        minShare: 0.5,
      });
      if (debug) debug.push({ y: [row.y0, row.y1], name: [cell.x0, cell.x1], tally: readCell.lastTally });
      if (read) {
        name = { cell, read };
        break;
      }
    }
    if (!name) continue;

    const scores = [];
    for (const cell of row.cells) {
      const width = cell.x1 - cell.x0;
      if (cell.x0 <= name.cell.x1 || width > height * 1.8 || width < height * 0.25) continue;
      const read = await readCell(medianCanvas(layout, cell), {
        whitelist: '0123456789',
        pattern: /^\d{1,3}$/,
        minVotes: 3,
        minShare: 0.6,
      });
      if (debug) debug.push({ y: [row.y0, row.y1], score: [cell.x0, cell.x1], tally: readCell.lastTally });
      if (read) scores.push({ cell, read });
    }
    if (scores.length) candidates.push({ row, name, scores });
  }

  // borders and flags can look like digits, but the two real scores sit in the same place in both rows
  let chosen = [];
  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      for (const sa of a.scores) {
        for (const sb of b.scores) {
          const off =
            Math.abs(sa.cell.x0 - sb.cell.x0) + Math.abs(sa.cell.x1 - sb.cell.x1) + 0.3 * Math.abs(a.name.cell.x0 - b.name.cell.x0);
          if (!best || off < best.off) best = { off, pair: [{ ...a, score: sa }, { ...b, score: sb }] };
        }
      }
    }
  }
  if (best) chosen = best.pair;
  else if (candidates.length === 1) {
    // only one row found: scores are at the right end, so take the rightmost cell
    const only = candidates[0];
    chosen = [{ ...only, score: only.scores[only.scores.length - 1] }];
  }

  // one row found: the other team's row has the same layout, so read it at the same places
  if (chosen.length === 1) {
    const known = chosen[0];
    const others = layout.rows
      .filter((row) => row !== known.row && row.cells.length > 0)
      .sort((a, b) => Math.abs(a.y0 - known.row.y0) - Math.abs(b.y0 - known.row.y0));
    for (const row of others) {
      const scoreBox = { x0: known.score.cell.x0, x1: known.score.cell.x1, y0: row.y0, y1: row.y1 };
      const scoreRead = await readCell(medianCanvas(layout, scoreBox), { whitelist: '0123456789', pattern: /^\d{1,3}$/, minVotes: 4, minShare: 0.6 });
      if (!scoreRead) continue;
      const nameBox = { x0: Math.max(0, known.name.cell.x0 - 8), x1: known.name.cell.x1 + 2, y0: row.y0, y1: row.y1 };
      const nameRead = await readCell(medianCanvas(layout, nameBox), {
        whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        pattern: /^[A-Z]{2,5}$/,
        minVotes: 2,
        minShare: 0.4,
      });
      if (!nameRead || nameRead.text === known.name.read.text) continue;
      chosen = [known, { row, name: { cell: nameBox, read: nameRead }, score: { cell: scoreBox, read: scoreRead } }].sort(
        (a, b) => a.row.y0 - b.row.y0
      );
      break;
    }
  }

  // a row that is much taller than the other one has the header stuck to it, so read the name from its bottom part
  if (chosen.length === 2) {
    const heights = chosen.map((c) => c.row.y1 - c.row.y0 + 1);
    const small = Math.min(...heights);
    for (const c of chosen) {
      if (c.row.y1 - c.row.y0 + 1 <= small * 1.35) continue;
      const box = { ...c.name.cell, y0: c.row.y1 - small + 1, y1: c.row.y1 };
      const read = await readCell(medianCanvas(layout, box), {
        whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        pattern: /^[A-Z]{2,5}$/,
        minVotes: 3,
        minShare: 0.5,
      });
      if (read) c.name = { cell: box, read };
    }
  }

  const teams = chosen.map((c) => ({
    name: c.name.read.text,
    score: parseInt(c.score.read.text, 10),
    nameBox: c.name.cell,
    scoreBox: c.score.cell,
  }));
  const teamRows = new Set(chosen.map((c) => c.row));

  // the clock changes, so it is read from the latest pictures. It runs from the first cell to the next one
  let clockBox = null;
  for (const row of layout.rows) {
    if (clockBox || row.cells.length === 0 || teamRows.has(row)) continue;
    const first = row.cells[0];
    const next = row.cells[1];
    const box = { x0: Math.max(0, first.x0 - 2), y0: row.y0, x1: next ? next.x0 - 3 : layout.board.x1, y1: row.y1 };
    for (const picture of canvases.slice(-3).reverse()) {
      const crop = document.createElement('canvas');
      crop.width = box.x1 - box.x0 + 1;
      crop.height = box.y1 - box.y0 + 1;
      crop.getContext('2d').drawImage(picture, box.x0, box.y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      if (await clockText(ocr, crop)) {
        clockBox = box;
        break;
      }
    }
  }

  // the clock can also sit in a team's row, to the right of the score
  if (!clockBox) {
    for (const c of chosen) {
      for (const cell of c.row.cells) {
        if (cell.x0 <= c.score.cell.x1 || cell.x1 - cell.x0 < (c.row.y1 - c.row.y0) * 1.2) continue;
        const box = { x0: cell.x0, y0: c.row.y0, x1: cell.x1, y1: c.row.y1 };
        for (const picture of canvases.slice(-3).reverse()) {
          const crop = document.createElement('canvas');
          crop.width = box.x1 - box.x0 + 1;
          crop.height = box.y1 - box.y0 + 1;
          crop.getContext('2d').drawImage(picture, box.x0, box.y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
          if (await clockText(ocr, crop)) {
            clockBox = box;
            break;
          }
        }
        if (clockBox) break;
      }
      if (clockBox) break;
    }
  }

  if (!clockBox) clockBox = await floatingClock(canvases);

  return { found: teams.length > 0 || !!clockBox, w: layout.w, h: layout.h, teams, clockBox, board: layout.board };
}
