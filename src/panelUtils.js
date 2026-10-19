import { DEFAULT_ACTIONS } from './defaultActions';

// tailwind classes
export const COLOR_PALETTE = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-500', 'bg-lime-500', 'bg-green-500',
  'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-sky-500', 'bg-blue-500', 'bg-indigo-500',
  'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500', 'bg-gray-600',
];

const SHOT_LABELS = ['Layup', 'Mid-range shot', 'Three Pointer'];

export const isHex = (c) => typeof c === 'string' && c.startsWith('#');

// color is a tailwind class or a hex string
export const colorProps = (color, className = '') =>
  isHex(color)
    ? { className, style: { backgroundColor: color } }
    : { className: `${color || 'bg-gray-500'} ${className}`.trim() };

export const uid = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const csvCell = (v) => {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const downloadFile = (filename, text, mime) => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const parseList = (text) => {
  const seen = new Set();
  return String(text || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s || seen.has(s.toLowerCase())) return false;
      seen.add(s.toLowerCase());
      return true;
    });
};

export const normalizeAction = (a) => ({
  id: a.id || uid('btn'),
  label: String(a.label || '').trim(),
  color: a.color || 'bg-gray-600',
  definition: a.definition || '',
  hotkey: typeof a.hotkey === 'string' && a.hotkey.length === 1 && a.hotkey !== ' ' ? a.hotkey.toLowerCase() : '',
  lead: Math.max(0, Number(a.lead) || 0),
  lag: Math.max(0, Number(a.lag) || 0),
  group: String(a.group || '').trim(),
  descriptors: Array.isArray(a.descriptors) ? a.descriptors.map(String).filter(Boolean) : [],
  kind: a.kind || (SHOT_LABELS.includes(a.label) || SHOT_LABELS.includes(a.id) ? 'shot' : ''),
});

// ids starting with btn- are generated, so the label is used as the type
export const actionType = (a) => (String(a.id).startsWith('btn-') ? a.label : a.id);

export const makePanel = (name, actions) => ({
  id: uid('panel'),
  name,
  actions: actions.map(normalizeAction),
});

const sanitizePanel = (p) => ({
  id: p.id || uid('panel'),
  name: String(p.name || 'Panel'),
  actions: (Array.isArray(p.actions) ? p.actions : [])
    .filter((a) => a && a.label)
    .map(normalizeAction),
});

const PANELS_KEY = 'tc_panels_v1';

export function loadPanels() {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.panels) && parsed.panels.length) {
        const panels = parsed.panels.map(sanitizePanel);
        const active = panels.some((p) => p.id === parsed.activePanelId) ? parsed.activePanelId : panels[0].id;
        return { panels, activePanelId: active };
      }
    }
  } catch (e) {
    // use the defaults
  }
  // the earlier version of the app saved its buttons under this key, keep them
  try {
    const old = JSON.parse(localStorage.getItem('actionButtons'));
    if (Array.isArray(old) && old.some((a) => a && a.label)) {
      const migrated = makePanel('Default', old.filter((a) => a && a.label));
      return { panels: [migrated], activePanelId: migrated.id };
    }
  } catch (e) {
    // ignore
  }
  const def = makePanel('Default', DEFAULT_ACTIONS);
  return { panels: [def], activePanelId: def.id };
}

export function savePanels(panels, activePanelId) {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify({ panels, activePanelId }));
  } catch (e) {
    // ignore
  }
}

export const defaultActionsCopy = () => DEFAULT_ACTIONS.map(normalizeAction);

export function buildPanelExport(panels) {
  return { format: 'tagging-panels', version: 1, panels };
}

// accepts an export file, one panel or a plain list of buttons
export function parseImportedPanels(text) {
  const data = JSON.parse(text);
  let list;
  if (Array.isArray(data)) list = [{ name: 'Imported panel', actions: data }];
  else if (Array.isArray(data.panels)) list = data.panels;
  else if (Array.isArray(data.actions)) list = [data];
  else throw new Error('Not a tagging panel file');
  const panels = list.map((p) => ({ ...sanitizePanel(p), id: uid('panel') }));
  if (!panels.length || panels.every((p) => p.actions.length === 0)) throw new Error('No buttons found in file');
  return panels;
}

const annKey = (videoKey) => `tc_ann_v1:${videoKey}`;

export function loadAnnotations(videoKey) {
  try {
    const raw = localStorage.getItem(annKey(videoKey));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function saveAnnotations(videoKey, annotations) {
  try {
    if (annotations.length) localStorage.setItem(annKey(videoKey), JSON.stringify(annotations));
    else localStorage.removeItem(annKey(videoKey));
  } catch (e) {
    // ignore
  }
}

// clock regions are saved per video
const clockKey = (videoKey) => `tc_clock_v2:${videoKey}`;
const LAST_REGION_KEY = 'tc_clock_region_v1';

export function loadClockKeys(videoKey) {
  try {
    const raw = localStorage.getItem(clockKey(videoKey));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
    // no regions yet, start from the last one used
    const last = JSON.parse(localStorage.getItem(LAST_REGION_KEY));
    if (last && typeof last.x === 'number') return [{ t: 0, x: last.x, y: last.y, w: last.w, h: last.h }];
  } catch (e) {
    // ignore
  }
  return [];
}

export function saveClockKeys(videoKey, keys) {
  try {
    if (keys.length) localStorage.setItem(clockKey(videoKey), JSON.stringify(keys));
    else localStorage.removeItem(clockKey(videoKey));
  } catch (e) {
    // ignore
  }
}

const scoreKey = (videoKey) => `tc_score_v2:${videoKey}`;
const LAST_SCORE_KEY = 'tc_score_last_v2';
const noBoxes = { a: null, b: null };

export function loadScoreBoxes(videoKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(scoreKey(videoKey)));
    if (saved && (saved.a || saved.b)) return { ...noBoxes, ...saved };
    const last = JSON.parse(localStorage.getItem(LAST_SCORE_KEY));
    if (last && (last.a || last.b)) return { ...noBoxes, ...last };
  } catch (e) {
    // ignore
  }
  return noBoxes;
}

export function saveScoreBoxes(videoKey, boxes) {
  try {
    if (boxes.a || boxes.b) {
      localStorage.setItem(scoreKey(videoKey), JSON.stringify(boxes));
      localStorage.setItem(LAST_SCORE_KEY, JSON.stringify(boxes));
    } else {
      localStorage.removeItem(scoreKey(videoKey));
    }
  } catch (e) {
    // ignore
  }
}

const scoreAreaKey = (videoKey) => `tc_score_area_v1:${videoKey}`;
const LAST_SCORE_AREA_KEY = 'tc_score_area_last_v1';

export function loadScoreArea(videoKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(scoreAreaKey(videoKey)));
    if (saved && typeof saved.x === 'number') return saved;
    const last = JSON.parse(localStorage.getItem(LAST_SCORE_AREA_KEY));
    if (last && typeof last.x === 'number') return last;
  } catch (e) {
    // ignore
  }
  return null;
}

export function saveScoreArea(videoKey, area) {
  try {
    if (area) {
      localStorage.setItem(scoreAreaKey(videoKey), JSON.stringify(area));
      localStorage.setItem(LAST_SCORE_AREA_KEY, JSON.stringify(area));
    } else {
      localStorage.removeItem(scoreAreaKey(videoKey));
    }
  } catch (e) {
    // ignore
  }
}
