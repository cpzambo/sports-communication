// Turns a pasted link into something the app can open.
//   kind 'drive'       a Google Drive file { id, key, name }
//   kind 'driveFolder' a Google Drive folder { id }
//   kind 'url'         any other address, with addresses to try [{ url, cors }]
// cors true asks the server to allow reading the picture (needed for the clock and score reading).

const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];

export function parseVideoLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'Paste a link first.' };

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (e) {
    return { ok: false, error: "That doesn't look like a link." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The link has to start with http or https.' };
  }

  const host = url.hostname.toLowerCase();

  // browsers are lenient about what they call an address, so check the host looks like a real one
  const looksReal = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host === 'localhost' || /^\[[0-9a-f:]+\]$/.test(host);
  if (!looksReal) return { ok: false, error: "That doesn't look like a link." };

  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    return { ok: false, error: "YouTube links can't be used here. Download the video and upload it, or use a Google Drive link." };
  }

  if (DRIVE_HOSTS.includes(host)) {
    const folder = url.pathname.match(/\/folders\/([\w-]{10,})/) || (/\/folderview/.test(url.pathname) ? [null, url.searchParams.get('id')] : null);
    if (folder && folder[1] && /^[\w-]{10,}$/.test(folder[1])) {
      return { ok: true, kind: 'driveFolder', id: folder[1] };
    }
    if (/\/drive\/(u\/\d+\/)?(my-drive|shared-with-me|recent|starred)/.test(url.pathname)) {
      return { ok: false, error: 'That is the Drive home page. Open the folder or the video, click Share, and paste that link.' };
    }
    const fromPath = url.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]{10,})/);
    const fromQuery = url.searchParams.get('id');
    const id = fromPath ? fromPath[1] : fromQuery && /^[\w-]{10,}$/.test(fromQuery) ? fromQuery : '';
    if (!id) return { ok: false, error: "Couldn't find a file in that Google Drive link." };
    return { ok: true, kind: 'drive', id, key: `drive:${id}`, name: `drive-${id.slice(0, 8)}` };
  }

  // any other address is used as it is
  url.hash = '';
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  const name = (last.replace(/\.[^/.]+$/, '') || host).replace(/[^\w.-]+/g, '-');
  return {
    ok: true,
    kind: 'url',
    key: `url:${url.href}`,
    name,
    candidates: [
      { url: url.href, cors: true },
      { url: url.href, cors: false },
    ],
  };
}
