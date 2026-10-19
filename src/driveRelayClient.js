// Talks to this site's own Drive relay (see server/driveRelay.js). It needs no Google key.
// The functions give back null when the site has no relay, so the caller can try something else.

const BASE = process.env.REACT_APP_DRIVE_RELAY || '/api';

export const relayVideoUrl = (id) => `${BASE}/drive-video?id=${encodeURIComponent(id)}`;

// { status, body, relay }. relay is false when the answer did not come from the relay (a site without one)
async function ask(path) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`);
  } catch (e) {
    return { relay: false };
  }
  if (res.headers.get('x-drive-relay') !== '1') return { relay: false };
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    // not json
  }
  return { relay: true, status: res.status, body };
}

// the relay's own words for a problem. code says whether trying the API key route instead could help
export class RelayError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function ask200(path) {
  const r = await ask(path);
  if (!r.relay) return null;
  if (r.status !== 200 || !r.body) {
    throw new RelayError((r.body && r.body.message) || `The relay replied with an error (${r.status}).`, (r.body && r.body.error) || 'relay');
  }
  return r.body;
}

// { id, name, size, mimeType } or null
export const relayInfo = (id) => ask200(`/drive-info?id=${encodeURIComponent(id)}`);

// { id, name, videos: [{ id, name, mimeType }], folders: [{ id, name }] } or null
export const relayFolder = (id) => ask200(`/drive-folder?id=${encodeURIComponent(id)}`);

// a problem the API key route could not fix either
export const isFinal = (err) => err instanceof RelayError && (err.code === 'not-shared' || err.code === 'not-found' || err.code === 'bad-id');
