// Google Drive through its official API.
// Google blocks other websites from playing Drive's plain download links, so a free API key is needed,
// and the file or folder has to be shared as "Anyone with the link".

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const VIDEO_NAME = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

// the address of a file's bytes through the API, which allows the picture to be read
export const driveMediaUrl = (id, key) =>
  `${API}/files/${id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key)}`;

export const NEEDS_KEY =
  "This site can't open Google Drive links by itself. Paste a free Google API key below (steps are in the Readme), or download the video and use Upload.";

// turns Google's error reply into something a person can act on. what is 'file' or 'folder'
export function explainDriveError(status, body, what = 'file') {
  const error = (body && body.error) || {};
  const reason = (error.errors && error.errors[0] && error.errors[0].reason) || '';
  const message = error.message || '';

  if (/unregistered callers|missing a valid API key|API key/i.test(message) && !/not valid/i.test(message)) {
    return 'Google needs an API key for this. Paste one in the box.';
  }
  if (/API key not valid/i.test(message)) {
    return 'Google says that API key is not valid. Check that it was copied in full.';
  }
  if (reason === 'accessNotConfigured' || /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    return 'The Google Drive API is not turned on for that key. In Google Cloud, enable the "Google Drive API" for its project and try again.';
  }
  if (reason === 'ipRefererBlocked' || /referer/i.test(message)) {
    return "That key is limited to other websites. Add this site to the key's allowed websites in Google Cloud.";
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'dailyLimitExceeded' || status === 429) {
    return 'Google is limiting requests for that key right now. Try again in a minute.';
  }
  if (status === 404 || reason === 'notFound') {
    return `That ${what} could not be found. Check the link, and that it is shared with "Anyone with the link".`;
  }
  if (status === 403 || reason === 'forbidden') {
    return `That ${what} is not shared. In Drive click Share and set General access to "Anyone with the link".`;
  }
  return `Google Drive replied with an error (${status}${message ? ': ' + message : ''}).`;
}

async function getJson(url, fetcher, what) {
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error('Could not reach Google. Check your internet connection.');
  }
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    // not json
  }
  if (!res.ok) throw new Error(explainDriveError(res.status, body, what));
  return body;
}

// { id, name, mimeType, size }
export async function getDriveFileInfo(id, apiKey, fetcher = (url) => fetch(url)) {
  const key = encodeURIComponent(apiKey);
  return getJson(`${API}/files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true&key=${key}`, fetcher, 'file');
}

// { id, name, videos: [{ id, name, size }], folders: [{ id, name }] }
export async function listDriveFolder(folderId, apiKey, fetcher = (url) => fetch(url)) {
  const key = encodeURIComponent(apiKey);
  const info = await getJson(`${API}/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true&key=${key}`, fetcher, 'folder');
  if (info.mimeType !== FOLDER) throw new Error('That link is a file, not a folder.');

  const videos = [];
  const folders = [];
  let pageToken = '';
  do {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size)');
    const page = await getJson(
      `${API}/files?q=${query}&fields=${fields}&pageSize=1000&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${key}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
      fetcher,
      'folder'
    );
    (page.files || []).forEach((f) => {
      if (f.mimeType === FOLDER) folders.push({ id: f.id, name: f.name });
      else if ((f.mimeType || '').startsWith('video/') || VIDEO_NAME.test(f.name || '')) {
        videos.push({ id: f.id, name: f.name, size: Number(f.size) || 0 });
      }
    });
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return { id: info.id, name: info.name, videos, folders };
}

// is this a file that could be a video? (documents, pictures and the like are turned away)
export function looksLikeVideo(info) {
  const type = info.mimeType || '';
  if (type.startsWith('video/') || VIDEO_NAME.test(info.name || '')) return true;
  return !(type.startsWith('application/vnd.google-apps') || type.startsWith('image/') || type.startsWith('text/') || type === 'application/pdf');
}
