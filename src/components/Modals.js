import React, { useEffect, useState } from 'react';
import { COLOR_PALETTE, isHex, colorProps, parseList, formatTime, csvCell } from '../panelUtils';

function Modal({ title, onClose, children, width = 'w-96' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`bg-gray-800 p-5 rounded-xl border border-gray-600 ${width} max-w-[95vw] max-h-[90vh] overflow-y-auto shadow-2xl`}>
        <h2 className="text-lg font-bold mb-3 text-center">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const inputCls = 'w-full bg-gray-700 text-white text-sm px-2 py-1.5 rounded border border-gray-600 focus:border-blue-500';
const labelCls = 'text-xs text-gray-400 block mb-1';

export function ColorPicker({ value, onChange }) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {COLOR_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            {...colorProps(c, `w-6 h-6 rounded-full border-2 ${value === c ? 'border-white' : 'border-transparent'}`)}
            title={c.replace('bg-', '')}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input
          type="color"
          value={isHex(value) ? value : '#3b82f6'}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-6 bg-transparent cursor-pointer"
        />
        <span className="text-xs text-gray-400">Custom colour</span>
        <span {...colorProps(value, 'ml-auto px-2 py-0.5 rounded-full text-xs font-semibold')}>Preview</span>
      </div>
    </div>
  );
}

export function ActionEditModal({ action, groups, takenHotkeys, onSave, onDelete, onClose }) {
  const [label, setLabel] = useState(action.label);
  const [definition, setDefinition] = useState(action.definition || '');
  const [group, setGroup] = useState(action.group || '');
  const [color, setColor] = useState(action.color);
  const [hotkey, setHotkey] = useState(action.hotkey || '');
  const [lead, setLead] = useState(action.lead || 0);
  const [lag, setLag] = useState(action.lag || 0);
  const [descriptors, setDescriptors] = useState((action.descriptors || []).join(', '));
  const [isShot, setIsShot] = useState(action.kind === 'shot');

  const hotkeyConflict = hotkey && takenHotkeys[hotkey];

  const handleHotkeyKey = (e) => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Backspace' || e.key === 'Delete') setHotkey('');
    else if (e.key.length === 1 && e.key !== ' ') setHotkey(e.key.toLowerCase());
  };

  const save = () => {
    if (!label.trim()) return;
    onSave({
      ...action,
      label: label.trim(),
      definition,
      group: group.trim(),
      color,
      hotkey,
      lead: Number(lead) || 0,
      lag: Number(lag) || 0,
      descriptors: parseList(descriptors),
      kind: isShot ? 'shot' : '',
    });
  };

  return (
    <Modal title={`Edit "${action.label}"`} onClose={onClose} width="w-[28rem]">
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Label</label>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Definition (shown as a tooltip)</label>
          <textarea className={inputCls} rows={2} value={definition} onChange={(e) => setDefinition(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Colour</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Group (optional)</label>
            <input className={inputCls} list="action-groups" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. Gestures" />
            <datalist id="action-groups">
              {groups.filter(Boolean).map((g) => <option key={g} value={g} />)}
            </datalist>
          </div>
          <div>
            <label className={labelCls}>Hotkey (press a key, Backspace clears)</label>
            <input className={inputCls} value={hotkey.toUpperCase()} readOnly onKeyDown={handleHotkeyKey} placeholder="none" />
            {hotkeyConflict && <p className="text-[11px] text-yellow-400 mt-1">Also used by "{hotkeyConflict}"</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Lead: seconds before the tag</label>
            <input type="number" min="0" step="0.5" className={inputCls} value={lead} onChange={(e) => setLead(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Lag: seconds after the tag</label>
            <input type="number" min="0" step="0.5" className={inputCls} value={lag} onChange={(e) => setLag(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Descriptors: options asked after each tag, comma separated (optional)</label>
          <input className={inputCls} value={descriptors} onChange={(e) => setDescriptors(e.target.value)} placeholder="e.g. Teammate, Official, Opponent" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={isShot} onChange={(e) => setIsShot(e.target.checked)} />
          Ask for shot location and result
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={() => onDelete(action.id)} className="bg-red-700 hover:bg-red-600 px-3 py-2 rounded text-sm font-bold">
            Delete
          </button>
          <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">
            Cancel
          </button>
          <button onClick={save} disabled={!label.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 px-4 py-2 rounded text-sm font-bold">
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function BulkAddModal({ existingLabels, groups, onAdd, onClose }) {
  const [text, setText] = useState('');
  const [group, setGroup] = useState('');
  const labels = parseList(text);
  const existing = new Set(existingLabels.map((l) => l.toLowerCase()));
  const fresh = labels.filter((l) => !existing.has(l.toLowerCase()));
  const dupes = labels.length - fresh.length;

  return (
    <Modal title="Bulk add buttons" onClose={onClose} width="w-[28rem]">
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Button names, separated by commas, semicolons or new lines</label>
          <textarea
            className={inputCls}
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Hand wave, Tap on chest, Backdoor signal"
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Add to group (optional)</label>
          <input className={inputCls} list="bulk-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
          <datalist id="bulk-groups">
            {groups.filter(Boolean).map((g) => <option key={g} value={g} />)}
          </datalist>
        </div>
        <p className="text-xs text-gray-400">
          {fresh.length} new button{fresh.length === 1 ? '' : 's'}
          {dupes > 0 && `, ${dupes} already exist and will be skipped`}. You can recolour and edit each one afterwards.
        </p>
        {fresh.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {fresh.map((l) => (
              <span key={l} className="bg-gray-700 text-xs px-2 py-0.5 rounded-full">{l}</span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Cancel</button>
          <button
            onClick={() => onAdd(fresh, group.trim())}
            disabled={fresh.length === 0}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-600 px-4 py-2 rounded text-sm font-bold"
          >
            Add {fresh.length || ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DescriptorModal({ action, onPick, onClose }) {
  return (
    <Modal title={`${action.label}: choose one`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {action.descriptors.map((d) => (
          <button
            key={d}
            onClick={() => onPick(d)}
            {...colorProps(action.color, 'py-3 rounded font-bold text-sm hover:brightness-110')}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => onPick('')} className="flex-1 bg-gray-700 hover:bg-gray-600 py-2 rounded text-sm">
          Skip (no descriptor)
        </button>
        <button onClick={onClose} className="flex-1 text-gray-400 hover:text-white text-sm">Cancel</button>
      </div>
    </Modal>
  );
}

export function AnnotationEditModal({ annotation, onSave, onClose }) {
  const [label, setLabel] = useState(annotation.label);
  const [time, setTime] = useState(Number(annotation.timestamp.toFixed(2)));
  const [clock, setClock] = useState(annotation.gameClockTime && annotation.gameClockTime !== 'N/A' ? annotation.gameClockTime : '');
  const [descriptor, setDescriptor] = useState(annotation.descriptor || '');
  const [note, setNote] = useState(annotation.note || '');

  const save = () => {
    const t = Math.max(0, Number(time) || 0);
    onSave(annotation.id, { label: label.trim() || annotation.label, timestamp: t, gameClockTime: clock.trim() || 'N/A', descriptor, note });
  };

  return (
    <Modal title="Edit annotation" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Label</label>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Video time (seconds): {formatTime(Number(time) || 0)}</label>
            <div className="flex gap-1">
              <button type="button" className="bg-gray-700 hover:bg-gray-600 px-2 rounded text-xs" onClick={() => setTime((Number(time) || 0) - 0.5 < 0 ? 0 : Number(((Number(time) || 0) - 0.5).toFixed(2)))}>-0.5</button>
              <input type="number" step="0.1" min="0" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
              <button type="button" className="bg-gray-700 hover:bg-gray-600 px-2 rounded text-xs" onClick={() => setTime(Number(((Number(time) || 0) + 0.5).toFixed(2)))}>+0.5</button>
            </div>
          </div>
          <div>
            <label className={labelCls}>Game clock</label>
            <input className={inputCls} value={clock} onChange={(e) => setClock(e.target.value)} placeholder="10:45 Q2" />
          </div>
        </div>
        <div>
          <label className={labelCls}>Descriptor</label>
          <input className={inputCls} value={descriptor} onChange={(e) => setDescriptor(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Note</label>
          <textarea className={inputCls} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Cancel</button>
          <button onClick={save} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-bold">Save</button>
        </div>
      </div>
    </Modal>
  );
}

export function buildSummary(annotations, teamNames) {
  const columns = [...teamNames];
  const rows = {};
  annotations.forEach((a) => {
    const team = a.activeTeamName || '(no team)';
    if (!columns.includes(team)) columns.push(team);
    const row = (rows[a.type] = rows[a.type] || { type: a.type, total: 0, counts: {} });
    row.counts[team] = (row.counts[team] || 0) + 1;
    row.total += 1;
  });
  return { columns, rows: Object.values(rows).sort((a, b) => b.total - a.total) };
}

export function summaryToCSV({ columns, rows }) {
  const lines = [['Action', ...columns, 'Total'].map(csvCell).join(',')];
  rows.forEach((r) => lines.push([r.type, ...columns.map((c) => r.counts[c] || 0), r.total].map(csvCell).join(',')));
  return lines.join('\n');
}

export function SummaryModal({ annotations, teamNames, onExport, onClose }) {
  const summary = buildSummary(annotations, teamNames);
  return (
    <Modal title={`Summary (${annotations.length} annotations)`} onClose={onClose} width="w-[36rem]">
      {summary.rows.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-4">Nothing to summarise yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-600">
                <th className="py-1 pr-3">Action</th>
                {summary.columns.map((c) => <th key={c} className="py-1 px-2 text-right">{c}</th>)}
                <th className="py-1 pl-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.type} className="border-b border-gray-700">
                  <td className="py-1 pr-3">{r.type}</td>
                  {summary.columns.map((c) => <td key={c} className="py-1 px-2 text-right">{r.counts[c] || 0}</td>)}
                  <td className="py-1 pl-2 text-right font-bold">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2 mt-4">
        <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Close</button>
        <button
          onClick={() => onExport(summary)}
          disabled={summary.rows.length === 0}
          className="bg-yellow-500 hover:bg-yellow-400 disabled:bg-gray-600 text-black px-4 py-2 rounded text-sm font-bold"
        >
          Export CSV
        </button>
      </div>
    </Modal>
  );
}

// a small form: fields is [{ key, label, value }]
export function InputModal({ title, fields, confirmLabel = 'Save', onSubmit, onClose }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.value || ''])));
  const ready = fields.every((f) => String(values[f.key]).trim());
  const submit = () => {
    if (ready) onSubmit(values);
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {fields.map((f, i) => (
          <div key={f.key}>
            <label className={labelCls}>{f.label}</label>
            <input
              className={inputCls}
              value={values[f.key]}
              autoFocus={i === 0}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Cancel</button>
          <button onClick={submit} disabled={!ready} className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 px-4 py-2 rounded text-sm font-bold">
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ConfirmModal({ title, message, confirmLabel = 'OK', onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-gray-300 mb-4">{message}</p>
      <div className="flex gap-2">
        <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Cancel</button>
        <button onClick={onConfirm} autoFocus className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded text-sm font-bold">
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// paste a Google Drive link (a video or a folder) or a direct link to a video.
// onSubmit(text, key) gives back a problem to show, or nothing. It may take a while, so it can return a promise
export function LinkModal({ onSubmit, onClose, savedKey }) {
  const [text, setText] = useState('');
  const [key, setKey] = useState(savedKey || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const problem = await onSubmit(text, key);
      if (problem) setError(problem);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Link a video" onClose={onClose} width="w-[30rem]">
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Google Drive link (a video or a folder), or a direct link to a video file</label>
          <input
            className={inputCls}
            value={text}
            autoFocus
            placeholder="https://drive.google.com/file/d/..."
            onChange={(e) => {
              setText(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div>
          <label className={labelCls}>Google API key (optional: only needed if this site can't open Drive links by itself)</label>
          <input
            className={inputCls}
            value={key}
            autoComplete="off"
            placeholder="AIza..."
            onChange={(e) => {
              setKey(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <p className="text-xs text-gray-400">
          In Google Drive, share the video or folder with General access set to "Anyone with the link". A key is free and is saved in this browser. Steps to get one are in the Readme.
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm">Cancel</button>
          <button onClick={submit} disabled={!text.trim() || busy} className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 px-4 py-2 rounded text-sm font-bold">
            {busy ? 'Looking...' : 'Open'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
