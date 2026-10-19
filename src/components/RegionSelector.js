import React, { useEffect, useRef, useState } from 'react';
import { contentRect } from '../ocr';

// drag a box over part of the video
export default function RegionSelector({ videoRef, onDone, onCancel, label }) {
  const overlayRef = useRef(null);
  const startRef = useRef(null);
  const rectRef = useRef(null);
  const [rect, setRect] = useState(null);

  // keeps the point inside the overlay, so dragging past the edge still works
  const point = (e) => {
    const box = overlayRef.current.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - box.left, 0), box.width),
      y: Math.min(Math.max(e.clientY - box.top, 0), box.height),
    };
  };

  const finish = () => {
    const r = rectRef.current;
    startRef.current = null;
    if (!r || r.w < 8 || r.h < 6 || !videoRef.current) {
      rectRef.current = null;
      setRect(null);
      return;
    }
    const c = contentRect(videoRef.current);
    const clamp = (v) => Math.min(Math.max(v, 0), 1);
    const x = clamp((r.x - c.left) / c.width);
    const y = clamp((r.y - c.top) / c.height);
    const x2 = clamp((r.x + r.w - c.left) / c.width);
    const y2 = clamp((r.y + r.h - c.top) / c.height);
    if (x2 - x > 0.002 && y2 - y > 0.002) onDone({ x, y, w: x2 - x, h: y2 - y });
    else {
      rectRef.current = null;
      setRect(null);
    }
  };

  // move and release are listened for on the whole window, so letting go outside the video still ends the drag
  useEffect(() => {
    const move = (e) => {
      const start = startRef.current;
      if (!start) return;
      const p = point(e);
      const next = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      rectRef.current = next;
      setRect(next);
    };
    const up = () => {
      if (startRef.current) finish();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMouseDown = (e) => {
    e.stopPropagation();
    const p = point(e);
    startRef.current = p;
    rectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
    setRect(rectRef.current);
  };

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 cursor-crosshair bg-black/30"
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/80 text-xs px-3 py-1 rounded flex items-center gap-3">
        {label || 'Drag a box around the game clock digits'}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCancel}
          className="text-gray-300 hover:text-white underline"
        >
          Cancel
        </button>
      </div>
      {rect && (
        <div
          className="absolute border-2 border-yellow-400 bg-yellow-400/10 pointer-events-none"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
    </div>
  );
}
