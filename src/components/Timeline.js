import React from 'react';
import { colorProps } from '../panelUtils';

// one row per action type
export default function Timeline({ annotations, duration, currentTime, onSeek }) {
  if (!duration || annotations.length === 0) return null;

  const lanes = [];
  annotations.forEach((a) => {
    let lane = lanes.find((l) => l.type === a.type);
    if (!lane) {
      lane = { type: a.type, items: [] };
      lanes.push(lane);
    }
    lane.items.push(a);
  });

  const seekFromTrack = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * duration);
  };

  return (
    <div className="mt-2 flex max-h-36 overflow-y-auto text-[10px] text-gray-300">
      <div className="w-28 shrink-0 space-y-0.5 pr-2">
        {lanes.map((l) => (
          <div key={l.type} className="h-3.5 leading-[14px] truncate" title={l.type}>{l.type}</div>
        ))}
      </div>
      <div className="relative flex-1 space-y-0.5">
        {lanes.map((l) => (
          <div key={l.type} className="relative h-3.5 bg-gray-700 rounded cursor-pointer" onClick={seekFromTrack}>
            {l.items.map((a) => {
              const start = a.startTime !== undefined ? a.startTime : a.timestamp;
              const end = a.endTime !== undefined ? a.endTime : a.timestamp;
              return (
                <div
                  key={a.id}
                  title={`${a.label} @ ${a.formattedTime}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(a.timestamp);
                  }}
                  {...colorProps(a.color, 'absolute top-0 h-full rounded-sm opacity-90 hover:opacity-100 min-w-[4px]')}
                  style={{
                    ...(colorProps(a.color).style || {}),
                    left: `${(start / duration) * 100}%`,
                    width: `${Math.max(((end - start) / duration) * 100, 0.4)}%`,
                  }}
                />
              );
            })}
          </div>
        ))}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
          style={{ left: `${Math.min((currentTime / duration) * 100, 100)}%` }}
        />
      </div>
    </div>
  );
}
