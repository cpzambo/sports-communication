// A small relay for public Google Drive files and folders.
//
// Google refuses to send a video to a page on another website, but it does send it to a server.
// So the page asks this relay (on its own site), and the relay asks Google. No API key is needed,
// the file or folder just has to be shared as "Anyone with the link".
//
// It only talks to Google, and only for ids that look like Drive ids.

const { Readable } = require('stream');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ID = /^[\w-]{10,100}$/;
const CHUNK = 8 * 1024 * 1024; // each reply carries at most this much, the player asks for the next part when it needs it

const TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
};

const typeFromName = (name) => TYPES[(String(name).split('.').pop() || '').toLowerCase()] || 'video/mp4';

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Drive-Relay': '1', ...extra });
  res.end(JSON.stringify(body));
}

const fail = (res, status, code, message) => send(res, status, { error: code, message });

// what went wrong, from what Google sent back instead of a file
function explainUpstream(status, text = '') {
  if (/too many users have viewed or downloaded/i.test(text)) {
    return [429, 'quota', 'Google is limiting downloads of this file right now. Try again later.'];
  }
  if (status === 404 || /file you have requested does not exist|not found/i.test(text)) {
    return [404, 'not-found', 'That could not be found. Check the link, and that it is shared with "Anyone with the link".'];
  }
  if (status === 401 || status === 403 || /sign in|request access|you need access/i.test(text)) {
    return [403, 'not-shared', 'That is not shared. In Drive click Share and set General access to "Anyone with the link".'];
  }
  if (status === 429) return [429, 'quota', 'Google is limiting downloads right now. Try again later.'];
  return [502, 'upstream', `Google replied with an unexpected answer (${status}).`];
}

function filenameOf(disposition) {
  const d = String(disposition || '');
  const star = d.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch (e) {
      return star[1];
    }
  }
  const plain = d.match(/filename="([^"]+)"/);
  return plain ? plain[1] : '';
}

const downloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

async function upstreamFile(id, range, signal) {
  return fetch(downloadUrl(id), { headers: { 'User-Agent': UA, Range: range }, redirect: 'follow', signal });
}

// ---- GET drive-info?id=FILE ----
async function info(id, res) {
  let up;
  try {
    up = await upstreamFile(id, 'bytes=0-0');
  } catch (e) {
    return fail(res, 502, 'upstream', 'Could not reach Google from the server.');
  }
  const type = up.headers.get('content-type') || '';
  if (!(up.status === 200 || up.status === 206) || /text\/html/i.test(type)) {
    const text = /text\/html/i.test(type) ? await up.text().catch(() => '') : '';
    const [status, code, message] = explainUpstream(up.status, text);
    return fail(res, status, code, message);
  }
  const range = up.headers.get('content-range') || '';
  const total = Number((range.match(/\/(\d+)$/) || [])[1]) || Number(up.headers.get('content-length')) || 0;
  const name = filenameOf(up.headers.get('content-disposition'));
  if (up.body) up.body.cancel().catch(() => {});
  return send(res, 200, { id, name, size: total, mimeType: typeFromName(name) });
}

// ---- GET drive-video?id=FILE (with a Range header) ----
async function video(id, req, res) {
  const asked = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  const start = asked && asked[1] ? Number(asked[1]) : 0;
  let end = asked && asked[2] ? Number(asked[2]) : start + CHUNK - 1;
  end = Math.min(end, start + CHUNK - 1);

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let up;
  try {
    up = await upstreamFile(id, `bytes=${start}-${end}`, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) return;
    return fail(res, 502, 'upstream', 'Could not reach Google from the server.');
  }
  if (up.status === 416) return fail(res, 416, 'range', 'That part of the file does not exist.');
  const type = up.headers.get('content-type') || '';
  if (!(up.status === 200 || up.status === 206) || /text\/html/i.test(type)) {
    const text = /text\/html/i.test(type) ? await up.text().catch(() => '') : '';
    const [status, code, message] = explainUpstream(up.status, text);
    return fail(res, status, code, message);
  }

  const name = filenameOf(up.headers.get('content-disposition'));
  const headers = {
    'Content-Type': typeFromName(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Drive-Relay': '1',
  };
  const range = up.headers.get('content-range');
  if (range) headers['Content-Range'] = range;
  const length = up.headers.get('content-length');
  if (length) headers['Content-Length'] = length;

  // Google answered the whole file instead of the part we asked for: cut it down to the part
  if (up.status === 200 && length && Number(length) > CHUNK) {
    const total = Number(length);
    headers['Content-Range'] = `bytes ${start}-${Math.min(end, total - 1)}/${total}`;
    headers['Content-Length'] = String(Math.min(end, total - 1) - start + 1);
    res.writeHead(206, headers);
    let seen = 0;
    const reader = Readable.fromWeb(up.body);
    reader.on('data', (chunk) => {
      const from = Math.max(start - seen, 0);
      const part = chunk.subarray(from, Math.max(end + 1 - seen, 0));
      seen += chunk.length;
      if (part.length) res.write(part);
      if (seen > end) {
        reader.destroy();
        controller.abort();
        res.end();
      }
    });
    reader.on('end', () => res.end());
    reader.on('error', () => res.end());
    return;
  }

  res.writeHead(up.status === 200 && !range ? 200 : 206, headers);
  Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
}

const entities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// ---- GET drive-folder?id=FOLDER ----
async function folder(id, res) {
  let up;
  try {
    up = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  } catch (e) {
    return fail(res, 502, 'upstream', 'Could not reach Google from the server.');
  }
  const html = await up.text().catch(() => '');
  if (up.status !== 200 || !/flip-entries/.test(html)) {
    const [status, code, message] = explainUpstream(up.status === 200 ? 403 : up.status, html);
    return fail(res, status, code, message.replace('That is', 'That folder is').replace('That could not', 'That folder could not'));
  }

  const name = entities((html.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]).trim();
  const videos = [];
  const folders = [];
  const entry = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?\/type\/([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = entry.exec(html))) {
    const [, entryId, href, rawType, rawTitle] = m;
    const title = entities(rawTitle.replace(/<[^>]*>/g, '')).trim();
    const mimeType = decodeURIComponent(rawType);
    if (/\/drive\/folders\//.test(href) || mimeType === 'application/vnd.google-apps.folder') folders.push({ id: entryId, name: title });
    else if (mimeType.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|ogv|mpe?g|ts|3gp|wmv|flv)$/i.test(title)) {
      videos.push({ id: entryId, name: title, mimeType });
    }
  }
  return send(res, 200, { id, name, videos, folders });
}

// handles /drive-info, /drive-video and /drive-folder. returns false for anything else
async function handle(req, res, url) {
  const u = new URL(url || req.url, 'http://relay.local');
  const route = u.pathname.replace(/^.*\/(drive-[a-z]+).*$/, '$1');
  if (!['drive-info', 'drive-video', 'drive-folder', 'drive-ping'].includes(route)) return false;
  if (route === 'drive-ping') {
    send(res, 200, { ok: true });
    return true;
  }
  const id = u.searchParams.get('id') || '';
  if (!ID.test(id)) {
    fail(res, 400, 'bad-id', 'That does not look like a Drive id.');
    return true;
  }
  try {
    if (route === 'drive-info') await info(id, res);
    else if (route === 'drive-video') await video(id, req, res);
    else await folder(id, res);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, 'relay', 'The relay hit a problem.');
    else res.end();
  }
  return true;
}

module.exports = { handle, filenameOf, typeFromName, explainUpstream };
