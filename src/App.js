import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Upload, Download, Trash2, Volume2, VolumeX, Pencil, BarChart3, Link2 } from 'lucide-react';
import {
  COLOR_PALETTE,
  colorProps,
  uid,
  csvCell,
  formatTime,
  downloadFile,
  normalizeAction,
  actionType,
  makePanel,
  loadPanels,
  savePanels,
  defaultActionsCopy,
  buildPanelExport,
  parseImportedPanels,
  loadAnnotations,
  saveAnnotations,
  loadClockKeys,
  saveClockKeys,
  loadScoreBoxes,
  saveScoreBoxes,
  loadScoreArea,
  saveScoreArea,
} from './panelUtils';

import Timeline from './components/Timeline';
import RegionSelector from './components/RegionSelector';
import { createScoreReader, createCellReader } from './scoreboard';
import { detectScoreboard } from './scoreboardLayout';
import { ReadingGuard } from './readingGuard';
import { parseVideoLink } from './videoLink';
import { listDriveFolder, getDriveFileInfo, driveMediaUrl, looksLikeVideo, NEEDS_KEY } from './driveApi';
import { relayInfo, relayFolder, relayVideoUrl, isFinal } from './driveRelayClient';
import { recognizeText, cropToCanvas, contentRect, parseClock, regionAt, findClockInCanvas, seekVideo } from './ocr';
import {
  ActionEditModal,
  BulkAddModal,
  DescriptorModal,
  AnnotationEditModal,
  SummaryModal,
  InputModal,
  ConfirmModal,
  LinkModal,
  summaryToCSV,
} from './components/Modals';

const LIVE_KEY = 'live-session'; // annotations made without a video

// with no video the timestamp is the computer's time of day
const secondsOfDay = (d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
const wallLabel = (secs) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + secs * 1000).toLocaleTimeString();
};

export default function VideoAnnotator() {
  const [videoSrc, setVideoSrc] = useState(null);
  const [annotations, setAnnotations] = useState(() => loadAnnotations(LIVE_KEY));
  const [activeShot, setActiveShot] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [gameClockTime, setGameClockTime] = useState('');
  const [playbackSpeed, setPlaybackSpeed] = useState(0.5);
  const [customAnnotation, setCustomAnnotation] = useState('');
  const [volume, setVolume] = useState(1);
  const [prevVolume, setPrevVolume] = useState(1);
  const [exportName, setExportName] = useState('annotations');
  const [teams, setTeams] = useState([
    { id: 'team-a', name: 'Team A', color: '#2563eb' },
    { id: 'team-b', name: 'Team B', color: '#dc2626' }
  ]);
  const [activeTeamId, setActiveTeamId] = useState('team-a');
  const [folderFiles, setFolderFiles] = useState([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(null);
  const [newActionLabel, setNewActionLabel] = useState('');

  // buttons of the current panel
  const [initialPanelData] = useState(loadPanels);
  const [panels, setPanels] = useState(initialPanelData.panels);
  const [activePanelId, setActivePanelId] = useState(initialPanelData.activePanelId);
  const activePanel = panels.find((p) => p.id === activePanelId) || panels[0];
  const actions = activePanel.actions;

  const updatePanelActions = (panelId, updater) =>
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId ? { ...p, actions: typeof updater === 'function' ? updater(p.actions) : updater } : p
      )
    );
  const setActions = (updater) => updatePanelActions(activePanel.id, updater);

  const [editingAction, setEditingAction] = useState(null);
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [descriptorPrompt, setDescriptorPrompt] = useState(null);
  const [editingAnnotation, setEditingAnnotation] = useState(null);
  const [showSummary, setShowSummary] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind, teamId }
  const [showLink, setShowLink] = useState(false);
  const [driveKey, setDriveKey] = useState(() => {
    try {
      return localStorage.getItem('tc_google_key') || process.env.REACT_APP_GOOGLE_API_KEY || '';
    } catch (e) {
      return process.env.REACT_APP_GOOGLE_API_KEY || '';
    }
  });
  const [folderName, setFolderName] = useState('');
  const [driveTrail, setDriveTrail] = useState([]); // Drive folders opened so far, the last one is showing
  const [videoCors, setVideoCors] = useState(false); // ask the server to allow reading the picture
  const [readable, setReadable] = useState(true); // false when the picture can't be read (some linked videos)
  const [toast, setToast] = useState(null);
  const [filterType, setFilterType] = useState('all');
  const [filterTeam, setFilterTeam] = useState('all');
  const [clipMode, setClipMode] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [dragActionId, setDragActionId] = useState(null);
  const [videoKey, setVideoKey] = useState(null);
  const [clockKeys, setClockKeys] = useState([]);
  const clockRegion = regionAt(clockKeys, currentTime);
  const [selectingRegion, setSelectingRegion] = useState(false); // false, 'clock', 'scoreA', 'scoreB' or 'scoreArea'
  const [clockStatic, setClockStatic] = useState(true);
  const [scoreBoxes, setScoreBoxes] = useState({ a: null, b: null });
  const [scoreValues, setScoreValues] = useState(null);
  const [scoreArea, setScoreArea] = useState(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [scoreText, setScoreText] = useState('');
  const [scoreBusy, setScoreBusy] = useState(false);
  const [liveRead, setLiveRead] = useState(true);
  const [autoClock, setAutoClock] = useState(false);
  const [period, setPeriod] = useState('');
  const [clockBusy, setClockBusy] = useState(false);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const panelImportRef = useRef(null);
  const clipRef = useRef(null);
  const hotkeyRef = useRef(null);
  const [now, setNow] = useState(() => new Date()); // computer time, shown and used for tags when there is no video
 // seconds counted before the last start, and when it started
  const modalOpenRef = useRef(false);
  const lastIdRef = useRef(0);
  const liveBusyRef = useRef(false);
  const nameRef = useRef(''); // file name of the open video, for format hints
  const linkRef = useRef(null); // addresses still to try for a linked video
  const autoDetectRef = useRef(null);
  const detectKeyRef = useRef('');
  const areaDrawnRef = useRef(false);
  const readFailsRef = useRef(0);
  const lastRedetectRef = useRef(0);
  const seekEpochRef = useRef(0);
  const rerunRef = useRef(false);
  const liveReadRef = useRef(null);
  const guardRef = useRef(null);
  const scoreReaderRef = useRef(null);
  if (!guardRef.current) guardRef.current = new ReadingGuard();

  const nextId = () => {
    const id = Math.max(Date.now(), lastIdRef.current + 1);
    lastIdRef.current = id;
    return id;
  };

  modalOpenRef.current = !!(
    selectingRegion || activeShot || editingAction || showBulkAdd || descriptorPrompt || editingAnnotation || showSummary || dialog || showLink
  );

  useEffect(() => {
    savePanels(panels, activePanelId);
  }, [panels, activePanelId]);

  useEffect(() => {
    if (videoKey) saveClockKeys(videoKey, clockKeys);
  }, [videoKey, clockKeys]);

  useEffect(() => {
    if (videoKey) saveScoreBoxes(videoKey, scoreBoxes);
  }, [videoKey, scoreBoxes]);

  useEffect(() => {
    if (videoKey) saveScoreArea(videoKey, scoreArea);
  }, [videoKey, scoreArea]);

  // look for the scoreboard by itself when its area is drawn, or when a video with a saved area opens
  useEffect(() => {
    if (!scoreArea || !videoSrc || !duration) return undefined;
    const key = `${videoKey}|${JSON.stringify(scoreArea)}`;
    if (detectKeyRef.current === key) return undefined;
    detectKeyRef.current = key;
    if (!areaDrawnRef.current && scoreBoxes.a && scoreBoxes.b) return undefined;
    areaDrawnRef.current = false;
    const timer = setTimeout(() => autoDetectRef.current && autoDetectRef.current(), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreArea, videoKey, videoSrc, duration]);

  useEffect(() => {
    if (!liveRead) return undefined;
    if (!isPlaying) {
      const once = setTimeout(() => liveReadRef.current && liveReadRef.current(), 300);
      return () => clearTimeout(once);
    }
    const timer = setInterval(() => liveReadRef.current && liveReadRef.current(), 1500);
    return () => clearInterval(timer);
  }, [liveRead, isPlaying]);

  useEffect(() => {
    saveAnnotations(videoKey || LIVE_KEY, annotations);
  }, [videoKey, annotations]);

  useEffect(() => {
    if (videoSrc) return undefined;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [videoSrc]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const shotLocations = [
    'Paint', 'Restricted Area', 'Left Corner 3', 'Right Corner 3', 
    'Left Wing 3', 'Right Wing 3', 'Above Break 3', 'Midrange Left', 'Midrange Right', 'Midrange Center'
  ];

  const teamColors = {
    'Jazz': '#753bbd',
    'Hawks': '#e03a3e',
    'Magic': '#0077c0',
    'Rockets': '#ce1141',
    'Nuggets': '#0e2240',
    'Kings': '#5a2d81',
    'Spurs': '#c4ced4',
    'Warriors': '#1d428a',
    'Thunder': '#ef3b24',
    'Lakers': '#552583',
    'Northwestern': '#4E2A84',
    'Illinois': '#13294b',
    'Indiana': '#990000',
    'Iowa': '#FFCD00',
    'Maryland': '#E03a3e',
    'Michigan': '#00274c',
    'Michigan State': '#18453B',
    'Minnesota': '#7A0019',
    'Nebraska': '#e41c38',
    'Ohio State': '#BB0000',
    'Penn State': '#041E42',
    'Purdue': '#ceb888',
    'Rutgers': '#cc0033',
    'Wisconsin': '#c5050c'
  };

  const seekBy = useCallback(
    (delta) => {
      if (!videoRef.current) return;
      const newTime = Math.min(Math.max(videoRef.current.currentTime + delta, 0), duration || 0);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    },
    [duration]
  );

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (!videoRef.current || e.target.matches('input, textarea, select') || modalOpenRef.current) return;
      const hasVideo = !!videoRef.current.getAttribute('src');

      if (!hasVideo) {
        if (!e.ctrlKey && !e.metaKey && !e.altKey && hotkeyRef.current) hotkeyRef.current(e);
      } else if (e.code === 'Space') {
        e.preventDefault();
        videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
        setIsPlaying(!videoRef.current.paused);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seekBy(3);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seekBy(-3);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && hotkeyRef.current) {
        hotkeyRef.current(e);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [seekBy]);

  const UNREADABLE =
    "Reading the clock and score needs the video uploaded from your computer. This link doesn't allow it, so type them in, or download the video and use Upload.";

  // opens a video and starts fresh for it
  const openVideo = ({ src, key, baseName, index = null, cors = false, candidates = null, fileName = '' }) => {
    nameRef.current = fileName;
    stopClips(false);
    linkRef.current = candidates;
    setVideoCors(cors);
    setReadable(true);
    setVideoSrc(src);
    setVideoKey(key);
    setAnnotations(loadAnnotations(key));
    setClockKeys(loadClockKeys(key));
    setScoreBoxes(loadScoreBoxes(key));
    setScoreArea(loadScoreArea(key));
    setScoreText('');
    setScoreValues(null);
    guardRef.current.reset();
    setDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setPlaybackSpeed(0.5);
    setVolume(1);
    setPrevVolume(1);
    setExportName(baseName);
    setCurrentFileIndex(index);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      openVideo({ src: URL.createObjectURL(file), key: file.name, baseName: file.name.replace(/\.[^/.]+$/, '') });
    }
  };

  const saveDriveKey = (key) => {
    setDriveKey(key);
    try {
      localStorage.setItem('tc_google_key', key);
    } catch (e) {
      // ignore
    }
  };

  // opens a video from Google Drive. The site's own relay is tried first and needs no key, then the Google API with a key.
  // returns a problem to show, or nothing
  const openDriveVideo = async (id, nameHint, index, key) => {
    const open = (src, name, info) =>
      openVideo({
        src,
        key: `drive:${id}`,
        baseName: (name || nameHint || `drive-${id.slice(0, 8)}`).replace(/\.[^/.]+$/, ''),
        fileName: name || nameHint || '',
        index,
        cors: src.startsWith('http'), // the API address is another site, the relay is this one
        candidates: { list: [{ url: src, cors: src.startsWith('http') }], index: 0, kind: 'drive' },
      });

    let relayProblem = null;
    try {
      const info = await relayInfo(id);
      if (info) {
        if (!looksLikeVideo(info)) return 'That Drive file is not a video.';
        open(relayVideoUrl(id), info.name, info);
        return '';
      }
    } catch (err) {
      if (isFinal(err) || !key) return err.message;
      relayProblem = err;
    }

    if (!key) return NEEDS_KEY;
    try {
      const info = await getDriveFileInfo(id, key);
      if (!looksLikeVideo(info)) return 'That Drive file is not a video.';
      open(driveMediaUrl(id, key), info.name, info);
      return '';
    } catch (err) {
      return relayProblem ? `${relayProblem.message}` : err.message;
    }
  };

  // shows a Drive folder in the Folder Contents list. trail is the folders above it. throws a plain message on trouble
  const openDriveFolder = async (id, trail, key) => {
    let listing = null;
    try {
      listing = await relayFolder(id);
    } catch (err) {
      if (isFinal(err) || !key) throw err;
    }
    if (!listing) {
      if (!key) throw new Error(NEEDS_KEY);
      listing = await listDriveFolder(id, key);
    }

    const nextTrail = [...trail, { id: listing.id, name: listing.name }];
    const items = [];
    if (nextTrail.length > 1) items.push({ name: '..', driveType: 'back' });
    listing.folders.forEach((f) => items.push({ name: `${f.name}/`, driveId: f.id, driveType: 'folder' }));
    sortFiles(listing.videos).forEach((v) => items.push({ name: v.name, driveId: v.id, driveType: 'video' }));

    setFolderFiles(items);
    setCurrentFileIndex(null);
    setDriveTrail(nextTrail);
    setFolderName(nextTrail.map((t) => t.name).join(' / '));
    if (trail.length === 0) {
      // the first folder names the teams, like a folder from the computer does
      const [team1, team2] = extractTeamsFromFolderName(listing.name);
      setTeams([team1, team2]);
      setActiveTeamId(team1.id);
    }
  };

  // returns a problem to show, or nothing when the link was opened
  const linkVideo = async (text, keyText) => {
    const parsed = parseVideoLink(text);
    if (!parsed.ok) return parsed.error;

    if (parsed.kind === 'url') {
      const first = parsed.candidates[0];
      openVideo({
        src: first.url,
        key: parsed.key,
        baseName: parsed.name,
        cors: first.cors,
        candidates: { list: parsed.candidates, index: 0, kind: 'url' },
      });
      setShowLink(false);
      return '';
    }

    // Google Drive: through this site's relay if it has one, otherwise through the Google API with a key
    const key = (keyText || driveKey || '').trim();
    try {
      if (parsed.kind === 'driveFolder') {
        await openDriveFolder(parsed.id, [], key);
      } else {
        const problem = await openDriveVideo(parsed.id, parsed.name, null, key);
        if (problem) return problem;
      }
    } catch (err) {
      return err.message;
    }
    if (key && key !== driveKey) saveDriveKey(key);
    setShowLink(false);
    return '';
  };

  // a click in the Folder Contents list: a video, a Drive subfolder, the way back, or a file from the computer
  const handleFolderItem = async (file, idx) => {
    if (!file.driveType) {
      loadVideoFromFile(file, idx);
      return;
    }
    try {
      if (file.driveType === 'video') {
        const problem = await openDriveVideo(file.driveId, file.name, idx, driveKey);
        if (problem) setToast({ message: problem });
      } else if (file.driveType === 'folder') {
        await openDriveFolder(file.driveId, driveTrail, driveKey);
      } else if (file.driveType === 'back' && driveTrail.length > 1) {
        await openDriveFolder(driveTrail[driveTrail.length - 2].id, driveTrail.slice(0, -2), driveKey);
      }
    } catch (err) {
      setToast({ message: err.message });
    }
  };

  // a link that won't play: try the next address, and say so when none work
  const handleVideoError = () => {
    if (!videoSrc) return;
    const tries = linkRef.current;
    if (tries && tries.index + 1 < tries.list.length) {
      tries.index += 1;
      const next = tries.list[tries.index];
      setVideoCors(next.cors);
      setVideoSrc(next.url);
      return;
    }
    const ext = nameRef.current.split('.').pop().toLowerCase();
    let message = "This video can't be played in the browser. An MP4 (H.264) plays best.";
    if (['avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp'].includes(ext)) {
      message = `Browsers can't play .${ext} files. Convert it to MP4 (H.264) with a free tool like HandBrake or VLC and open that.`;
    } else if (['mov', 'mkv'].includes(ext)) {
      message = `This .${ext} uses a codec the browser can't play (often HEVC or ProRes). Convert it to MP4 (H.264) with HandBrake or VLC and open that.`;
    }
    if (tries && tries.kind === 'drive') {
      message = "Google sent the file but the browser can't play it. It may be in a format browsers don't support. An MP4 (H.264) plays best.";
    } else if (tries) {
      message = 'Could not play that link. Check that it goes straight to a video file the browser can play, like an MP4.';
    }
    setToast({ message });
  };

  // can the picture be read for the clock and score? (some linked videos don't allow it)
  const checkReadable = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || video.readyState < 2) return true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch (e) {
      return false;
    }
  };

  // the picture can look readable before its first frame is really there, so look again a moment later
  const handleVideoReady = () => {
    setReadable(checkReadable());
    [400, 1500].forEach((ms) => setTimeout(() => setReadable(checkReadable()), ms));
  };

  function extractTeamsFromFolderName(folderName) {
    const parts = folderName.split('_');
    if (parts.length < 2) {
      return [
        { id: 'team-a', name: 'Team A', color: '#2563eb' },
        { id: 'team-b', name: 'Team B', color: '#dc2626' }
      ];
    }

    const teamA = parts[0].replace(/[^a-zA-Z0-9 ]+/g, ' ').trim();
    const teamB = parts[1].replace(/[^a-zA-Z0-9 ]+/g, ' ').trim();
    const teamACap = capitalizeWords(teamA)
    const teamBCap = capitalizeWords(teamB)
    return [
      {
        id: teamACap, 
        name: teamACap, 
        color: teamColors[teamACap] || '#2563eb' // Fallback to blue if not in teamColors
      }, 
      {
        id: teamBCap,
        name: teamBCap,
        color: teamColors[teamBCap] || '#dc2626' // Fallback to red if not in teamColors
      }
    ];
  }

  const handleTeamRightClick = (e, teamId) => {
    e.preventDefault();
    setDialog({ kind: 'team', teamId });
  };

  function capitalizeWords(str) {
    return str
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  function sortFiles(files) {
    return [...files].sort((a, b) => {
      const parse = (file) => {
        const name = file.name.replace(/\.[^/.]+$/, '');
        const parts = name.split('_');

        const quarterPart = parts[0];
        const timePart = parts[2];

        const quarterMatch = quarterPart.match(/Q(\d+)/i);
        const quarter = quarterMatch ? parseInt(quarterMatch[1], 10) : 99;
        const time = parseInt(timePart, 10) || 0;

        return { quarter, time };
      };

      const A = parse(a);
      const B = parse(b);

      if (A.quarter !== B.quarter) return A.quarter - B.quarter;
      return B.time - A.time;
    });
  }

  const handleFolderSelect = (e) => {
    const files = Array.from(e.target.files);
    setFolderFiles(sortFiles(files));
    setCurrentFileIndex(null);

    setDriveTrail([]);

    if (files.length > 0) {
      const name = files[0].webkitRelativePath.split('/')[0];
      setFolderName(name);
      const [team1, team2] = extractTeamsFromFolderName(name);
      setTeams([team1, team2]);
      setActiveTeamId(team1.id);
    }
  };

  const loadVideoFromFile = (file, index) => {
    openVideo({
      src: URL.createObjectURL(file),
      key: file.webkitRelativePath || file.name,
      baseName: file.name.replace(/\.[^/.]+$/, ''),
      fileName: file.name,
      index,
    });
  };

  const handlePlayPause = () => {
    if (!videoRef.current || !videoSrc) return;
    if (isPlaying) videoRef.current.pause();
    else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const clipRange = (a) => {
    const start = a.startTime !== undefined ? a.startTime : a.timestamp;
    const end = a.endTime !== undefined ? a.endTime : a.timestamp;
    return end > start ? { start, end } : { start: Math.max(0, a.timestamp - 1), end: a.timestamp + 3 };
  };

  const playClip = (index) => {
    const clip = clipRef.current;
    if (!clip || !videoRef.current) return;
    const { start } = clip.list[index];
    videoRef.current.currentTime = start;
    setCurrentTime(start);
    const p = videoRef.current.play();
    if (p && p.catch) p.catch(() => {});
    setIsPlaying(true);
  };

  const stopClips = (pause = true) => {
    clipRef.current = null;
    setClipMode(false);
    if (pause && videoRef.current) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const advanceClip = () => {
    const clip = clipRef.current;
    if (!clip) return false;
    if (clip.idx + 1 < clip.list.length) {
      clip.idx += 1;
      playClip(clip.idx);
    } else {
      stopClips();
    }
    return true;
  };

  const startClips = () => {
    if (!videoRef.current) return;
    const list = [...visibleAnnotations].sort((a, b) => a.timestamp - b.timestamp).map(clipRange);
    if (list.length === 0) return;
    clipRef.current = { list, idx: 0 };
    setClipMode(true);
    playClip(0);
  };

  const handleVideoEnded = () => {
    if (advanceClip()) return;
    setIsPlaying(false);
  };

  const handleVideoClick = () => handlePlayPause();

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime;
    setCurrentTime(t);
    const clip = clipRef.current;
    if (clip && t >= clip.list[clip.idx].end) advanceClip();
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      videoRef.current.playbackRate = playbackSpeed;
      videoRef.current.volume = volume;
      videoRef.current.muted = volume === 0;
    }
  };

  const handleSeek = (e) => {
    if (!videoSrc || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const newTime = pos * duration;
    stopClips(false);
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleSpeedChange = (speed) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
  };

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    if (newVolume > 0) setPrevVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = newVolume === 0;
    }
  };

  const toggleMute = () => {
    if (volume === 0) handleVolumeChange(prevVolume || 1);
    else {
      setPrevVolume(volume);
      handleVolumeChange(0);
    }
  };

  const handleActionClick = (action) => {
    if (!videoRef.current) return;
    const timestamp = videoSrc ? videoRef.current.currentTime : secondsOfDay(new Date());

    if (action.kind === 'shot') {
      // Pause video while they fill out the form
      if (isPlaying) handlePlayPause();
      setActiveShot({ ...action, timestamp });
    } else if (action.descriptors && action.descriptors.length > 0) {
      setDescriptorPrompt({ action, timestamp });
    } else {
      addAnnotation(action, { timestamp });
    }
  };

  // hotkeys
  hotkeyRef.current = (e) => {
    if (e.key.length !== 1) return;
    const key = e.key.toLowerCase();
    const action = actions.find((a) => a.hotkey === key);
    if (!action) return;
    e.preventDefault();
    if (!e.repeat) handleActionClick(action);
  };

  const handleRightClick = (e, actionId) => {
    e.preventDefault(); // Stop the default browser menu from appearing
    const action = actions.find((a) => a.id === actionId);
    if (action) setEditingAction(action);
  };

  const buildAnnotation = (action, { timestamp, label, descriptor, metadata } = {}) => {
    const ts = timestamp !== undefined ? timestamp : videoRef.current ? videoRef.current.currentTime : 0;
    const lead = Number(action.lead) || 0;
    const lag = Number(action.lag) || 0;
    const team = teams.find((t) => t.id === activeTeamId);
    return {
      id: nextId(),
      type: actionType(action),
      label: label !== undefined ? label : action.label,
      color: action.color,
      timestamp: ts,
      formattedTime: videoSrc ? formatTime(ts) : wallLabel(ts),
      ...(videoSrc ? {} : { recordedAt: new Date().toISOString() }),
      startTime: Math.max(0, ts - lead),
      endTime: duration ? Math.min(duration, ts + lag) : ts + lag,
      gameClockTime: gameClockTime || 'N/A',
      ...(scoreText ? { scoreboard: scoreText } : {}),
      ...(scoreText && scoreValues ? { scores: scoreValues } : {}),
      activeTeamName: team ? team.name : '',
      ...(descriptor ? { descriptor } : {}),
      note: '',
      metadata: metadata || {},
    };
  };

  const finalizeShotAnnotation = (location, result) => {
    const newAnnotation = buildAnnotation(activeShot, {
      timestamp: activeShot.timestamp,
      label: `${activeShot.label} (${result}) - ${location}`,
      // Store metadata for cleaner data analysis later
      metadata: { location, result, shotType: activeShot.label },
    });

    setAnnotations([newAnnotation, ...annotations]);
    setActiveShot(null);
    autoReadClock(newAnnotation.id);
  };

  const addAnnotation = (action, options) => {
    if (!videoRef.current) return;
    const newAnnotation = buildAnnotation(action, options);
    setAnnotations((prev) => [newAnnotation, ...prev]);
    autoReadClock(newAnnotation.id);
  };

  const addCustomAnnotation = () => {
    if (!videoRef.current || !customAnnotation.trim()) return;
    const newAnnotation = buildAnnotation(
      { id: 'Other', label: customAnnotation.trim(), color: 'bg-gray-500' },
      { timestamp: videoSrc ? videoRef.current.currentTime : secondsOfDay(new Date()) }
    );
    setAnnotations([newAnnotation, ...annotations]);
    setCustomAnnotation('');
    autoReadClock(newAnnotation.id);
  };

  const addNewActionButton = () => {
    const label = newActionLabel.trim();
    if (!label) return;
    if (actions.some((a) => a.label.toLowerCase() === label.toLowerCase())) {
      setToast({ message: `A button named "${label}" already exists` });
      return;
    }

    const newBtn = normalizeAction({
      id: uid('btn'),
      label,
      color: COLOR_PALETTE[actions.length % COLOR_PALETTE.length],
      definition: 'User created action',
    });

    setActions([...actions, newBtn]);
    setNewActionLabel('');
  };

  const addBulkActions = (labels, group) => {
    const newBtns = labels.map((label, i) =>
      normalizeAction({
        id: uid('btn'),
        label,
        group,
        color: COLOR_PALETTE[(actions.length + i) % COLOR_PALETTE.length],
        definition: 'User created action',
      })
    );
    setActions((prev) => [...prev, ...newBtns]);
    setShowBulkAdd(false);
    setToast({ message: `Added ${newBtns.length} button${newBtns.length === 1 ? '' : 's'}` });
  };

  const saveActionEdit = (updated) => {
    const clean = normalizeAction(updated);
    setActions((prev) => {
      // built in buttons use the label as id, keep that unless it clashes
      const canRename =
        !String(updated.id).startsWith('btn-') &&
        clean.label !== updated.id &&
        !prev.some((a) => a.id === clean.label);
      const finalAction = canRename ? { ...clean, id: clean.label } : clean;
      return prev.map((a) => (a.id === updated.id ? finalAction : a));
    });
    setEditingAction(null);
  };

  const deleteAction = (id) => {
    const index = actions.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = actions[index];
    const panelId = activePanel.id;
    updatePanelActions(panelId, (prev) => prev.filter((a) => a.id !== id));
    setEditingAction(null);
    setToast({
      message: `Deleted button "${removed.label}"`,
      undo: () =>
        updatePanelActions(panelId, (prev) => {
          const copy = [...prev];
          copy.splice(Math.min(index, copy.length), 0, removed);
          return copy;
        }),
    });
  };

  const moveAction = (dragId, targetId, groupOverride) => {
    if (!dragId || dragId === targetId) return;
    setActions((prev) => {
      const from = prev.findIndex((a) => a.id === dragId);
      if (from < 0) return prev;
      const copy = [...prev];
      const [item] = copy.splice(from, 1);
      const target = copy.find((a) => a.id === targetId);
      const moved = { ...item, group: groupOverride !== undefined ? groupOverride : target ? target.group : item.group };
      if (target) copy.splice(copy.indexOf(target), 0, moved);
      else copy.push(moved);
      return copy;
    });
  };

  const newPanel = () => setDialog({ kind: 'newPanel' });

  const renamePanel = () => setDialog({ kind: 'renamePanel' });

  const duplicatePanel = () => {
    const copy = makePanel(`${activePanel.name} copy`, activePanel.actions);
    setPanels((prev) => [...prev, copy]);
    setActivePanelId(copy.id);
  };

  const deletePanel = () => {
    if (panels.length <= 1) {
      setToast({ message: 'You need at least one panel' });
      return;
    }
    setDialog({ kind: 'deletePanel' });
  };

  const resetPanel = () => setDialog({ kind: 'resetPanel' });

  const runDialog = (values) => {
    const kind = dialog.kind;
    setDialog(null);
    if (kind === 'newPanel') {
      const panel = makePanel(values.name.trim(), []);
      setPanels((prev) => [...prev, panel]);
      setActivePanelId(panel.id);
    } else if (kind === 'renamePanel') {
      setPanels((prev) => prev.map((p) => (p.id === activePanel.id ? { ...p, name: values.name.trim() } : p)));
    } else if (kind === 'team') {
      setTeams((prev) => prev.map((t) => (t.id === dialog.teamId ? { ...t, name: values.name.trim(), color: values.color.trim() } : t)));
    } else if (kind === 'deletePanel') {
      const remaining = panels.filter((p) => p.id !== activePanel.id);
      setPanels(remaining);
      setActivePanelId(remaining[0].id);
    } else if (kind === 'resetPanel') {
      setActions(defaultActionsCopy());
    }
  };

  const exportPanels = (all) => {
    const list = all ? panels : [activePanel];
    const name = all ? 'tagging-panels' : activePanel.name.replace(/[^a-z0-9-_]+/gi, '_') || 'tagging-panel';
    downloadFile(`${name}.json`, JSON.stringify(buildPanelExport(list), null, 2), 'application/json');
  };

  const importPanels = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseImportedPanels(String(reader.result));
        const names = new Set(panels.map((p) => p.name));
        const renamed = imported.map((p) => {
          let name = p.name;
          if (names.has(name)) name = `${name} (imported)`;
          names.add(name);
          return { ...p, name };
        });
        setPanels((prev) => [...prev, ...renamed]);
        setActivePanelId(renamed[0].id);
        setToast({ message: `Imported ${renamed.length} panel${renamed.length === 1 ? '' : 's'}` });
      } catch (err) {
        setToast({ message: `Import failed: ${err.message}` });
      }
    };
    reader.readAsText(file);
  };

  const deleteAnnotation = (id) => {
    const index = annotations.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = annotations[index];
    setAnnotations(annotations.filter((a) => a.id !== id));
    setToast({
      message: 'Annotation deleted',
      undo: () =>
        setAnnotations((prev) => {
          const copy = [...prev];
          copy.splice(Math.min(index, copy.length), 0, removed);
          return copy;
        }),
    });
  };

  const saveAnnotationEdit = (id, changes) => {
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const delta = changes.timestamp - a.timestamp;
        return {
          ...a,
          ...changes,
          formattedTime: formatTime(changes.timestamp),
          startTime: Math.max(0, (a.startTime !== undefined ? a.startTime : a.timestamp) + delta),
          endTime: (a.endTime !== undefined ? a.endTime : a.timestamp) + delta,
        };
      })
    );
    setEditingAnnotation(null);
  };

  const hasGameClock = (ann) => !!ann.gameClockTime && ann.gameClockTime !== 'N/A';

  const seekToAnnotation = (timestamp) => {
    if (!videoRef.current || !videoSrc) return;
    videoRef.current.currentTime = timestamp;
    setCurrentTime(timestamp);
  };


  const getSafeExportName = (ext) => {
    const base = exportName.trim() !== '' ? exportName.trim() : 'annotations';
    return `${base}.${ext}`;
  };

  const getCleanAnnotations = () => annotations.map(({ color, ...rest }) => rest);

  const exportAnnotationsJSON = () => {
    const cleanAnnotations = getCleanAnnotations();
    const dataStr = JSON.stringify(cleanAnnotations, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = getSafeExportName('json');
    link.click();
  };

  const exportAnnotationsCSV = () => {
    const cleanAnnotations = getCleanAnnotations();
    // new columns go at the end
    const headers = ['Timestamp', 'Game Clock', 'Team', 'Action', 'Label', 'Start', 'End', 'Descriptor', 'Note', 'Scoreboard'];

    const csvRows = cleanAnnotations.map((ann) => {
      return [
        ann.formattedTime,
        ann.gameClockTime || '',
        ann.activeTeamName || '',
        ann.type,
        `"${ann.label.replace(/"/g, '""')}"`, // Wrap in quotes to handle commas
        ann.startTime !== undefined ? ann.startTime.toFixed(2) : '',
        ann.endTime !== undefined ? ann.endTime.toFixed(2) : '',
        csvCell(ann.descriptor || ''),
        csvCell(ann.note || ''),
        csvCell(ann.scoreboard || ''),
      ].join(',');
    });

    downloadFile(getSafeExportName('csv'), [headers.join(','), ...csvRows].join('\n'), 'text/csv;charset=utf-8;');
  };

  const exportSummaryCSV = (summary) => {
    downloadFile(getSafeExportName('summary.csv'), summaryToCSV(summary), 'text/csv;charset=utf-8;');
  };

  const visibleAnnotations = annotations.filter(
    (a) => (filterType === 'all' || a.type === filterType) && (filterTeam === 'all' || a.activeTeamName === filterTeam)
  );
  const annotationTypes = [...new Set(annotations.map((a) => a.type))];
  const annotationTeams = [...new Set(annotations.map((a) => a.activeTeamName).filter(Boolean))];

  const formatClock = (t) => (period.trim() ? `${t} ${period.trim()}` : t);

  const addClockKey = (region, atTime) => {
    const t = atTime !== undefined ? atTime : videoRef.current ? videoRef.current.currentTime : 0;
    const key = { t: clockStatic ? 0 : t, x: region.x, y: region.y, w: region.w, h: region.h };
    setClockKeys((prev) =>
      clockStatic ? [key] : [...prev.filter((k) => Math.abs(k.t - t) > 0.5), key].sort((a, b) => a.t - b.t)
    );
    try {
      localStorage.setItem('tc_clock_region_v1', JSON.stringify(region));
    } catch (e) {
      // ignore
    }
  };

  // the clock area as a few differently processed pictures, in case the first one can't be read
  const captureClock = () => {
    const video = videoRef.current;
    const region = video ? regionAt(clockKeys, video.currentTime) : null;
    if (!region) return null;
    return ['auto', true, false].map((invert) => cropToCanvas(video, region, { minHeight: 120, invert }));
  };

  const captureFrame = (invert = 'auto') =>
    videoRef.current
      ? cropToCanvas(videoRef.current, { x: 0, y: 0, w: 1, h: 1 }, { minHeight: 0, maxWidth: 1600, invert })
      : null;

  const readClockText = async (canvases) => {
    for (const canvas of [].concat(canvases)) {
      if (!canvas) continue;
      const text = parseClock(await recognizeText(canvas, { whitelist: '0123456789:.', psm: '7' }));
      if (text) return text;
    }
    return '';
  };

  // looks for the clock anywhere in the frame
  const findClock = async () => {
    if (!videoRef.current) return;
    if (!checkReadable()) {
      setReadable(false);
      setToast({ message: UNREADABLE });
      return;
    }
    setClockBusy(true);
    try {
      for (const invert of [true, false]) {
        const canvas = captureFrame(invert);
        const hit = canvas ? await findClockInCanvas(canvas) : null;
        if (hit) {
          addClockKey(hit.region);
          setGameClockTime(formatClock(hit.text));
          return;
        }
      }
      setToast({ message: 'No clock found in this frame. Try a frame where the scoreboard is clearly visible, or draw the region by hand.' });
    } catch (err) {
      setToast({ message: `OCR failed: ${err.message}` });
    } finally {
      setClockBusy(false);
    }
  };

  const readGameClock = async () => {
    if (!checkReadable()) {
      setReadable(false);
      setToast({ message: UNREADABLE });
      return;
    }
    if (clockKeys.length === 0) {
      await findClock();
      return;
    }
    const canvas = captureClock();
    if (!canvas) return;
    setClockBusy(true);
    try {
      const t = await readClockText(canvas);
      if (t) setGameClockTime(formatClock(t));
      else setToast({ message: 'Could not read the clock here. Try "Find clock", or set the region again at this point in the video.' });
    } catch (err) {
      setToast({ message: `OCR failed: ${err.message}` });
    } finally {
      setClockBusy(false);
    }
  };

  const getScoreReader = () => {
    if (!scoreReaderRef.current) scoreReaderRef.current = createScoreReader({ text: recognizeText });
    return scoreReaderRef.current;
  };

  const captureBox = (region) =>
    region && videoRef.current ? cropToCanvas(videoRef.current, region, { minHeight: 0, raw: true }) : null;

  // the number in each score box, or null where the box is missing or unclear
  const readScoreBoxes = async (canvases) => {
    const reader = getScoreReader();
    const values = [];
    for (const canvas of canvases) {
      const read = canvas ? await reader(canvas) : null;
      values.push(read ? read.value : null);
    }
    return values;
  };

  const scoreLine = (values) =>
    values
      .map((v, i) => (v === null ? null : `${teams[i] ? teams[i].name : 'Team ' + (i + 1)} ${v}`))
      .filter(Boolean)
      .join(' - ');

  // runs the readings through the guard. gives the accepted scores, or null if a box has none yet
  const settleScores = (values, canvases) => {
    const guard = guardRef.current;
    const accepted = values.map((v, i) => {
      if (!canvases[i]) return null;
      if (v === null) return guard.scores[i] ? guard.scores[i].value : null;
      return guard.acceptScore(i, v);
    });
    const ready = canvases.every((c, i) => !c || accepted[i] !== null);
    return ready && accepted.some((v) => v !== null) ? accepted : null;
  };

  // looks at the tagged scoreboard in a few moments of the video and works out where the names, scores and clock are
  const autoDetectScoreboard = async (quiet = false) => {
    const video = videoRef.current;
    if (!video || !scoreArea) {
      if (!quiet) setSelectingRegion('scoreArea');
      return;
    }
    if (!checkReadable()) {
      setReadable(false);
      if (!quiet) setToast({ message: UNREADABLE });
      return;
    }
    setDetectBusy(true);
    const hidden = document.createElement('video');
    try {
      hidden.muted = true;
      hidden.preload = 'auto';
      if (videoCors) hidden.crossOrigin = 'anonymous';
      hidden.src = videoSrc;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The video took too long to open')), 20000);
        hidden.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        hidden.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Could not open the video'));
        };
      });

      // pictures from different moments, the last one is the current moment
      const start = video.currentTime;
      const limit = (video.duration || start + 60) - 0.5;
      const offsets = [36, 26, 18, 12, 8, 4, 0];
      const ahead = offsets.map((o) => start + o).filter((t) => t <= limit);
      const times = ahead.length >= 4 ? ahead : offsets.map((o) => start - o).filter((t) => t >= 0);
      const pictures = [];
      for (const t of times) {
        await seekVideo(hidden, t);
        const picture = cropToCanvas(hidden, scoreArea, { minHeight: 0, raw: true });
        if (picture) pictures.push(picture);
      }
      if (pictures.length < 3) throw new Error('Not enough of the video to look at');

      const result = await detectScoreboard(pictures, { text: recognizeText }, createCellReader);
      if (!result.found) {
        if (!quiet) setToast({ message: "Couldn't work out the scoreboard. Open Manual options and draw the score boxes yourself." });
        return;
      }

      const place = (box) => ({
        x: scoreArea.x + ((box.x0 - 1) / result.w) * scoreArea.w,
        y: scoreArea.y + ((box.y0 - 1) / result.h) * scoreArea.h,
        w: ((box.x1 - box.x0 + 3) / result.w) * scoreArea.w,
        h: ((box.y1 - box.y0 + 3) / result.h) * scoreArea.h,
      });
      const [first, second] = result.teams;
      if (first || second) {
        setScoreBoxes({ a: first ? place(first.scoreBox) : null, b: second ? place(second.scoreBox) : null });
        setTeams((prev) => prev.map((t, i) => (result.teams[i] ? { ...t, name: result.teams[i].name } : t)));
      }
      if (result.clockBox) addClockKey(place(result.clockBox));

      guardRef.current.reset();
      if (result.teams.length) {
        const values = [first ? first.score : null, second ? second.score : null];
        setScoreValues(values);
        setScoreText(result.teams.map((t) => `${t.name} ${t.score}`).join(' - '));
      }

      const parts = [];
      if (result.teams.length) parts.push(result.teams.map((t) => t.name).join(' and '));
      if (result.clockBox) parts.push('the clock');
      const missing =
        result.teams.length === 1 ? ' Only found ' + result.teams.length + ' team, draw the other score box in Manual options.' : '';
      if (!quiet) setToast({ message: `Found ${parts.join(' and ')}.${missing}` });
    } catch (err) {
      if (!quiet) setToast({ message: `Auto-detect failed: ${err.message}. You can draw the boxes yourself.` });
    } finally {
      hidden.removeAttribute('src');
      hidden.load();
      setDetectBusy(false);
    }
  };

  autoDetectRef.current = autoDetectScoreboard;

  const readScoreboard = async () => {
    if (!checkReadable()) {
      setReadable(false);
      setToast({ message: UNREADABLE });
      return;
    }
    const canvases = [captureBox(scoreBoxes.a), captureBox(scoreBoxes.b)];
    if (!canvases[0] && !canvases[1]) {
      setSelectingRegion('scoreA');
      return;
    }
    setScoreBusy(true);
    try {
      const values = await readScoreBoxes(canvases);
      guardRef.current.resetScores();
      const accepted = settleScores(values, canvases);
      if (accepted) {
        setScoreValues(accepted);
        setScoreText(scoreLine(accepted));
      } else {
        setToast({ message: 'Could not read the scores. Draw a tighter box around each number.' });
      }
    } catch (err) {
      setToast({ message: `OCR failed: ${err.message}` });
    } finally {
      setScoreBusy(false);
    }
  };

  // auto mode reads the clock and scores for each new tag, and searches the whole frame if the clock region misses
  const autoReadClock = (annotationId) => {
    if (!autoClock || !videoRef.current || !videoSrc || !readable) return;
    const video = videoRef.current;
    const crop = captureClock();
    const frame = captureFrame();
    const boxes = [captureBox(scoreBoxes.a), captureBox(scoreBoxes.b)];
    const at = video.currentTime;
    const speed = video.playbackRate;
    const patch = (changes) =>
      setAnnotations((prev) => prev.map((a) => (a.id === annotationId ? { ...a, ...changes } : a)));
    (async () => {
      let t = crop ? await readClockText(crop) : '';
      if (!t && frame) {
        const hit = await findClockInCanvas(frame);
        if (hit) {
          t = hit.text;
          addClockKey(hit.region, at);
        }
      }
      if (t) patch({ gameClockTime: formatClock(guardRef.current.acceptClock(t, at, speed) || t) });
      if (boxes[0] || boxes[1]) {
        const accepted = settleScores(await readScoreBoxes(boxes), boxes);
        if (accepted) patch({ scoreboard: scoreLine(accepted), scores: accepted });
      }
    })().catch(() => {});
  };

  // fills the clock and score boxes from the video, only keeping readings that make sense
  liveReadRef.current = async (force) => {
    const video = videoRef.current;
    if (!video || video.seeking || !readable) return;
    if (liveBusyRef.current) {
      // a seek while a read is running: read again as soon as it finishes
      if (force) rerunRef.current = true;
      return;
    }
    const clock = captureClock();
    const boxes = [captureBox(scoreBoxes.a), captureBox(scoreBoxes.b)];
    if (!clock && !boxes[0] && !boxes[1]) return;
    const at = video.currentTime;
    const speed = video.playbackRate;
    const epoch = seekEpochRef.current;
    liveBusyRef.current = true;
    try {
      const guard = guardRef.current;
      if (guard.seen(at)) {
        setGameClockTime('');
        setScoreText('');
        setScoreValues(null);
      }
      if (clock) {
        const text = await readClockText(clock);
        if (epoch !== seekEpochRef.current) return;
        const accepted = text ? guard.acceptClock(text, at, speed) : null;
        if (accepted) setGameClockTime(formatClock(accepted));
      }
      if (boxes[0] || boxes[1]) {
        const values = await readScoreBoxes(boxes);
        if (epoch !== seekEpochRef.current) return;
        if (scoreArea && !detectBusy) {
          readFailsRef.current = values.some((v, i) => boxes[i] && v === null) ? readFailsRef.current + 1 : 0;
          if (readFailsRef.current >= 6 && Date.now() - lastRedetectRef.current > 30000) {
            readFailsRef.current = 0;
            lastRedetectRef.current = Date.now();
            autoDetectRef.current(true);
          }
        }
        const accepted = settleScores(values, boxes);
        if (accepted) {
          setScoreValues(accepted);
          setScoreText(scoreLine(accepted));
        }
      }
    } catch (err) {
      // ignore
    } finally {
      liveBusyRef.current = false;
      if (rerunRef.current || epoch !== seekEpochRef.current) {
        rerunRef.current = false;
        setTimeout(() => liveReadRef.current && liveReadRef.current(), 0);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white p-4">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="video/*,.mov,.m4v,.mkv,.avi,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.m2ts,.3gp,.ogv,.webm"
        style={{ display: 'none' }}
      />

      <input
        type="file"
        webkitdirectory="true"
        directory="true"
        multiple
        ref={folderInputRef}
        onChange={handleFolderSelect}
        style={{ display: 'none' }}
      />

      <input
        type="file"
        ref={panelImportRef}
        onChange={importPanels}
        accept=".json,application/json"
        style={{ display: 'none' }}
      />

      <div className="max-w-full mx-auto">
        <h1 className="text-3xl font-bold mb-4 text-center bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          Sports Non Verbal Communication
        </h1>

        <div className="flex gap-4">
            {/* LEFT SIDE */}
            <div className="flex-[7] flex flex-col gap-3">
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="relative w-full overflow-hidden rounded-lg bg-black group">
                  <video
                    key={`${videoSrc}|${videoCors}`}
                    ref={videoRef}
                    src={videoSrc}
                    crossOrigin={videoCors ? 'anonymous' : undefined}
                    onError={handleVideoError}
                    onLoadedData={handleVideoReady}
                    onCanPlay={handleVideoReady}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onClick={handleVideoClick}
                    className={`w-full rounded-lg cursor-pointer ${videoSrc ? '' : 'hidden'}`}
                    style={{ maxHeight: '60vh' }}
                    onEnded={handleVideoEnded}
                    onSeeking={() => {
                      // the picture is not at the new time yet, so anything read now would be old
                      seekEpochRef.current += 1;
                      const hasAreas = clockKeys.length > 0 || scoreBoxes.a || scoreBoxes.b;
                      // a big jump in the video makes the old clock and score wrong, so clear them right away
                      if (liveRead && hasAreas && videoRef.current && guardRef.current.seen(videoRef.current.currentTime)) {
                        setGameClockTime('');
                        setScoreText('');
                        setScoreValues(null);
                      }
                    }}
                    onSeeked={() => {
                      seekEpochRef.current += 1;
                      handleVideoReady();
                      if (liveRead && liveReadRef.current) liveReadRef.current(true);
                    }}
                  />

                  {selectingRegion && (
                    <RegionSelector
                      videoRef={videoRef}
                      label={
                        selectingRegion === 'scoreA'
                          ? 'Drag a box around the first score (just the number)'
                          : selectingRegion === 'scoreB'
                          ? 'Drag a box around the second score (just the number)'
                          : selectingRegion === 'scoreArea'
                          ? 'Drag a box around the whole scoreboard'
                          : undefined
                      }
                      onDone={(region) => {
                        if (selectingRegion === 'scoreA') setScoreBoxes((prev) => ({ ...prev, a: region }));
                        else if (selectingRegion === 'scoreB') setScoreBoxes((prev) => ({ ...prev, b: region }));
                        else if (selectingRegion === 'scoreArea') {
                          areaDrawnRef.current = true;
                          setScoreArea(region);
                        }
                        else addClockKey(region);
                        setSelectingRegion(false);
                      }}
                      onCancel={() => setSelectingRegion(false)}
                    />
                  )}

                  {clockRegion && !selectingRegion && !isPlaying && videoRef.current && (() => {
                    const c = contentRect(videoRef.current);
                    return (
                      <div
                        className="absolute border border-dashed border-yellow-400/70 pointer-events-none z-10"
                        title="Game clock region"
                        style={{
                          left: c.left + clockRegion.x * c.width,
                          top: c.top + clockRegion.y * c.height,
                          width: clockRegion.w * c.width,
                          height: clockRegion.h * c.height,
                        }}
                      />
                    );
                  })()}

                  {scoreArea && !selectingRegion && !isPlaying && videoRef.current && (() => {
                    const c = contentRect(videoRef.current);
                    return (
                      <div
                        className="absolute border border-dashed border-purple-400/70 pointer-events-none z-10"
                        title="Scoreboard area"
                        style={{
                          left: c.left + scoreArea.x * c.width,
                          top: c.top + scoreArea.y * c.height,
                          width: scoreArea.w * c.width,
                          height: scoreArea.h * c.height,
                        }}
                      />
                    );
                  })()}

                  {!selectingRegion && !isPlaying && videoRef.current &&
                    ['a', 'b'].map((key) => {
                      const box = scoreBoxes[key];
                      if (!box) return null;
                      const c = contentRect(videoRef.current);
                      return (
                        <div
                          key={key}
                          className="absolute border border-dashed border-sky-400/80 pointer-events-none z-10"
                          title={`Score box ${key.toUpperCase()}`}
                          style={{
                            left: c.left + box.x * c.width,
                            top: c.top + box.y * c.height,
                            width: box.w * c.width,
                            height: box.h * c.height,
                          }}
                        />
                      );
                    })}

                  {!videoSrc && (
                    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 min-h-[260px] text-center">
                      <p className="text-lg text-gray-300">Pick a video to start tagging</p>
                      <div className="flex flex-wrap justify-center gap-2 text-sm">
                        <button
                          onClick={() => fileInputRef.current && fileInputRef.current.click()}
                          className="bg-blue-600 hover:bg-blue-500 px-3 py-2 rounded flex items-center gap-2"
                        >
                          <Upload size={16} />
                          Upload a video
                        </button>
                        <button
                          onClick={() => setShowLink(true)}
                          className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded flex items-center gap-2"
                        >
                          <Link2 size={16} />
                          Link a video
                        </button>
                        <button
                          onClick={() => folderInputRef.current && folderInputRef.current.click()}
                          className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded"
                        >
                          Choose a folder
                        </button>
                      </div>
                      <div className="mt-2 flex flex-col items-center gap-1">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Live time</div>
                        <div className="text-5xl font-mono text-white" aria-label="Live time">
                          {now.toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* PLAYER CONTROLS */}
                <div className="mt-2 space-y-2">
                  <div
                    className="relative h-2 bg-gray-700 rounded-full cursor-pointer group"
                    onClick={handleSeek}
                  >
                    <div
                      className="absolute h-full bg-red-600 rounded-full transition-all"
                      style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={handlePlayPause}
                      disabled={!videoSrc}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 p-2 rounded-full"
                    >
                      {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                    </button>

                    <span className="text-sm font-mono">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </span>

                    {/* SPEED */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Speed:</span>
                      <select
                        value={playbackSpeed}
                        onChange={(e) => handleSpeedChange(Number(e.target.value))}
                        className="bg-gray-700 text-white px-2 py-1 text-sm rounded border-2 border-gray-600 focus:border-blue-500"
                      >
                        {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => (
                          <option key={s} value={s}>
                            {s}x
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* VOLUME */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={toggleMute}
                        className="bg-gray-700 hover:bg-gray-600 p-2 rounded-full"
                      >
                        {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                      </button>

                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={volume}
                        onChange={(e) => handleVolumeChange(Number(e.target.value))}
                        className="w-24 accent-blue-400"
                      />
                    </div>

                    <button
                      onClick={() => setShowLink(true)}
                      className="ml-auto bg-gray-700 hover:bg-gray-600 px-3 py-1 text-sm rounded flex items-center gap-2"
                      title="Use a Google Drive link instead of uploading"
                    >
                      <Link2 size={16} />
                      Link
                    </button>
                    <button
                      onClick={() => fileInputRef.current && fileInputRef.current.click()}
                      className="bg-gray-700 hover:bg-gray-600 px-3 py-1 text-sm rounded flex items-center gap-2"
                    >
                      <Upload size={16} />
                      Upload
                    </button>
                  </div>

                  <Timeline
                    annotations={visibleAnnotations}
                    duration={duration}
                    currentTime={currentTime}
                    onSeek={seekToAnnotation}
                  />
                </div>
              </div>

              {/* ANNOTATIONS + FOLDER CONTENTS under video */}
              <div className="flex gap-3">
                {/* ANNOTATIONS */}
                <div className="bg-gray-800 rounded-lg p-3 flex flex-col min-h-[260px] max-h-[360px] flex-1">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-bold">Annotations ({annotations.length})</h2>

                    {annotations.length > 0 && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowSummary(true)}
                          className="bg-gray-600 hover:bg-gray-500 px-3 py-1 text-xs rounded flex items-center gap-1"
                        >
                          <BarChart3 size={14} />
                          Summary
                        </button>
                        <button
                          onClick={exportAnnotationsJSON}
                          className="bg-green-600 hover:bg-green-700 px-3 py-1 text-xs rounded flex items-center gap-1"
                        >
                          <Download size={14} />
                          JSON
                        </button>
                        <button
                          onClick={exportAnnotationsCSV}
                          className="bg-yellow-500 hover:bg-yellow-600 px-3 py-1 text-xs rounded flex items-center gap-1 text-black font-semibold"
                        >
                          <Download size={14} />
                          CSV
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs text-gray-300">Export name:</label>
                    <input
                      type="text"
                      value={exportName}
                      onChange={(e) => setExportName(e.target.value)}
                      placeholder="e.g., hawks-jazz-q1"
                      className="bg-gray-700 text-white px-2 py-1 text-xs rounded border border-gray-600 focus:border-blue-500 flex-1"
                    />
                  </div>

                  {annotations.length > 0 && (
                    <div className="flex items-center gap-2 mb-2 text-xs">
                      <select
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value)}
                        className="bg-gray-700 text-white px-1 py-1 rounded border border-gray-600 min-w-0 flex-1"
                      >
                        <option value="all">All actions</option>
                        {annotationTypes.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <select
                        value={filterTeam}
                        onChange={(e) => setFilterTeam(e.target.value)}
                        className="bg-gray-700 text-white px-1 py-1 rounded border border-gray-600 min-w-0 flex-1"
                      >
                        <option value="all">All teams</option>
                        {annotationTeams.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <button
                        onClick={clipMode ? () => stopClips() : startClips}
                        disabled={!clipMode && visibleAnnotations.length === 0}
                        className={`px-2 py-1 rounded font-semibold whitespace-nowrap ${
                          clipMode ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600'
                        }`}
                      >
                        {clipMode ? 'Stop clips' : `Play clips (${visibleAnnotations.length})`}
                      </button>
                    </div>
                  )}

                  {annotations.length === 0 ? (
                    <p className="text-gray-400 text-center py-6 text-sm">No annotations yet.</p>
                  ) : visibleAnnotations.length === 0 ? (
                    <p className="text-gray-400 text-center py-6 text-sm">No annotations match the filters.</p>
                  ) : (
                    <div className="space-y-2 overflow-y-auto flex-1 pr-2">
                      {visibleAnnotations.map((ann) => (
                        <div
                          key={ann.id}
                          className="bg-gray-700 rounded-lg p-3 flex items-center justify-between hover:bg-gray-600 transition group"
                        >
                          <button
                            onClick={() => seekToAnnotation(ann.timestamp)}
                            className="flex items-center gap-2 flex-1 text-left"
                          >
                            <span {...colorProps(ann.color, 'px-2 py-1 rounded-full text-xs font-semibold')}>
                              {ann.formattedTime}
                            </span>

                            {videoSrc && hasGameClock(ann) && (
                              <span className="bg-orange-600 px-2 py-1 rounded-full text-xs font-semibold">
                                {ann.gameClockTime}
                              </span>
                            )}

                            <span className="font-medium text-sm">
                              {ann.label}
                              {ann.descriptor && <span className="text-gray-300"> ({ann.descriptor})</span>}
                              {ann.activeTeamName && (
                                <span className="text-gray-400 text-xs font-normal"> · {ann.activeTeamName}</span>
                              )}
                              {ann.note && <span className="block text-xs text-gray-400 font-normal">{ann.note}</span>}
                            </span>
                          </button>

                          <button
                            onClick={() => setEditingAnnotation(ann)}
                            className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-white mr-2"
                            title="Edit annotation"
                          >
                            <Pencil size={15} />
                          </button>

                          <button
                            onClick={() => deleteAnnotation(ann.id)}
                            className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* FOLDER CONTENTS */}
                <div className="bg-gray-800 rounded-lg p-3 flex flex-col min-h-[260px] max-h-[360px] flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <div className="min-w-0">
                      <h2 className="text-lg font-bold">Folder Contents</h2>
                      {folderName && <p className="text-xs text-gray-400 truncate" title={folderName}>{folderName}</p>}
                    </div>
                    <button
                      onClick={() => folderInputRef.current && folderInputRef.current.click()}
                      className="bg-gray-700 hover:bg-gray-600 px-3 py-1 text-sm rounded flex items-center gap-2"
                    >
                      Choose Folder
                    </button>
                  </div>

                  {folderFiles.length === 0 ? (
                    <p className="text-gray-400 text-sm">{folderName ? 'No videos in this folder.' : 'No folder selected.'}</p>
                  ) : (
                    <ul className="text-sm overflow-y-auto space-y-1 flex-1">
                      {folderFiles.map((file, idx) => (
                        <li
                          key={idx}
                          onClick={() => handleFolderItem(file, idx)}
                          className={`${
                            currentFileIndex === idx
                              ? 'text-blue-400 bg-blue-900/30 font-semibold'
                              : 'text-gray-300 hover:text-blue-400'
                          } cursor-pointer px-2 py-1 rounded transition`}
                        >
                          {file.webkitRelativePath || file.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT SIDE — ACTION BUTTONS */}
            <div className="flex-[3] overflow-y-auto">
              {/* GAME CLOCK AND SCOREBOARD */}
              <div className="mb-4 p-3 bg-gray-700 rounded">
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={gameClockTime}
                    onChange={(e) => setGameClockTime(e.target.value)}
                    placeholder="e.g. 10:45 Q2"
                    title="Game clock"
                    className="flex-1 min-w-0 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 focus:border-blue-500"
                  />
                  <input
                    type="text"
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                    placeholder="Q2"
                    title="Period added to the clock when it is read from the video"
                    className="w-14 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 focus:border-blue-500"
                  />
                </div>
                <input
                  type="text"
                  value={scoreText}
                  onChange={(e) => {
                    setScoreText(e.target.value);
                    setScoreValues(null);
                  }}
                  placeholder="e.g. LAL 88 - BOS 84"
                  title="Scoreboard"
                  className="w-full bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 focus:border-blue-500 mb-2"
                />
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  <button
                    onClick={() => setSelectingRegion('scoreArea')}
                    disabled={!videoSrc}
                    className="bg-blue-700 hover:bg-blue-600 disabled:opacity-60 px-2 py-1 rounded font-semibold"
                    title="Draw a box around the scoreboard. It is read automatically. The box can include the clock or not"
                  >
                    {scoreArea ? 'Redraw scoreboard' : 'Set scoreboard area'}
                  </button>
                  {scoreArea && (
                    <>
                      <button
                        onClick={() => autoDetectScoreboard()}
                        disabled={detectBusy || !videoSrc}
                        className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                        title="Look at the scoreboard again"
                      >
                        {detectBusy ? 'Looking...' : 'Re-detect'}
                      </button>
                      <button
                        onClick={() => setScoreArea(null)}
                        className="bg-gray-800 hover:bg-gray-600 px-2 py-1 rounded"
                      >
                        Clear
                      </button>
                    </>
                  )}
                  <label className="flex items-center gap-1 text-gray-300 ml-auto" title="Keep the clock and scores up to date while the video plays">
                    <input type="checkbox" checked={liveRead} onChange={(e) => setLiveRead(e.target.checked)} />
                    Live
                  </label>
                  <label className="flex items-center gap-1 text-gray-300" title="Read the clock and scores for every new tag and save them on it">
                    <input type="checkbox" checked={autoClock} onChange={(e) => setAutoClock(e.target.checked)} />
                    On tag
                  </label>
                </div>

                {videoSrc && !readable && (
                  <p className="text-[11px] text-yellow-400 mt-2">
                    The clock and score can't be read from this linked video. Type them in, or upload the file.
                  </p>
                )}

                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-gray-400 hover:text-white">Manual options</summary>
                  <div className="flex flex-wrap items-center gap-1 mt-2">
                    <button
                      onClick={() => setSelectingRegion('clock')}
                      disabled={!videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                      title="Draw a box around the game clock"
                    >
                      Set clock area
                    </button>
                    <button
                      onClick={findClock}
                      disabled={clockBusy || !videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                      title="Search the whole picture for the clock"
                    >
                      Find clock
                    </button>
                    <button
                      onClick={() => setClockKeys([])}
                      disabled={clockKeys.length === 0}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                    >
                      Clear clock area
                    </button>
                    <label className="flex items-center gap-1 text-gray-300" title="Tick if the clock moves around the screen, then set its area at a few points in the video">
                      <input type="checkbox" checked={!clockStatic} onChange={(e) => setClockStatic(!e.target.checked)} />
                      Camera moves
                    </label>
                    <button
                      onClick={() => setSelectingRegion('scoreA')}
                      disabled={!videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                      title="Draw a box around the number of the first team's score"
                    >
                      {scoreBoxes.a ? 'Redraw score A' : 'Set score A'}
                    </button>
                    <button
                      onClick={() => setSelectingRegion('scoreB')}
                      disabled={!videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                      title="Draw a box around the number of the second team's score"
                    >
                      {scoreBoxes.b ? 'Redraw score B' : 'Set score B'}
                    </button>
                    <button
                      onClick={() => setScoreBoxes({ a: null, b: null })}
                      disabled={!scoreBoxes.a && !scoreBoxes.b}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                    >
                      Clear boxes
                    </button>
                    <button
                      onClick={readGameClock}
                      disabled={clockBusy || !videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                    >
                      {clockBusy ? 'Reading...' : 'Read clock'}
                    </button>
                    <button
                      onClick={readScoreboard}
                      disabled={scoreBusy || !videoSrc}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                    >
                      {scoreBusy ? 'Reading...' : 'Read scores'}
                    </button>
                    <button
                      onClick={() => {
                        setGameClockTime('');
                        setScoreText('');
                        setScoreValues(null);
                      }}
                      disabled={!gameClockTime && !scoreText}
                      className="bg-gray-800 hover:bg-gray-600 disabled:opacity-60 px-2 py-1 rounded"
                    >
                      Clear text
                    </button>
                  </div>
                </details>
              </div>

              {/* TAGGING PANELS */}
              <div className="mb-4 p-3 bg-gray-700 rounded">
                <h3 className="text-sm font-bold mb-2">Tagging Panel</h3>
                <select
                  value={activePanel.id}
                  onChange={(e) => setActivePanelId(e.target.value)}
                  className="w-full bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 mb-2"
                >
                  {panels.map((pn) => (
                    <option key={pn.id} value={pn.id}>
                      {pn.name} ({pn.actions.length})
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-1 text-xs">
                  {[
                    ['New', newPanel],
                    ['Rename', renamePanel],
                    ['Duplicate', duplicatePanel],
                    ['Delete', deletePanel],
                    ['Export', () => exportPanels(false)],
                    ['Export all', () => exportPanels(true)],
                    ['Import', () => panelImportRef.current && panelImportRef.current.click()],
                    ['Reset', resetPanel],
                  ].map(([text, fn]) => (
                    <button key={text} onClick={fn} className="bg-gray-800 hover:bg-gray-600 px-2 py-1 rounded">
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              {/* TEAM SELECTORS */}
              <div className="mb-4 p-3 bg-gray-700 rounded">
                <h3 className="text-sm font-bold mb-2">Team</h3>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {teams.map((t) => {
                    const isActive = activeTeamId === t.id;

                    return (
                      <button
                        key={t.id}
                        onClick={() => setActiveTeamId(t.id)}
                        onContextMenu={(e) => handleTeamRightClick(e, t.id)}
                        style={{
                          backgroundColor: isActive ? t.color : '#444',
                          border: `2px solid ${t.color}`,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        className="px-1 py-2 rounded font-bold text-white hover:opacity-90 transition-all"
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>

                <div className="space-y-4">
                  {/* NEW BUTTON CREATOR */}
                  <div className="p-3 bg-gray-900 rounded-lg border border-gray-700">
                    <h3 className="text-xs font-bold text-gray-400 uppercase mb-2">Create New Button</h3>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newActionLabel}
                        onChange={(e) => setNewActionLabel(e.target.value)}
                        placeholder="Button Name"
                        className="flex-1 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600"
                      />
                      <button
                        onClick={addNewActionButton}
                        className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-sm font-bold"
                      >
                        +
                      </button>
                    </div>
                    <button
                      onClick={() => setShowBulkAdd(true)}
                      className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                    >
                      Bulk add (comma separated)...
                    </button>
                  </div>

                  {/* ACTION BUTTONS GRID */}
                  {actions.length === 0 && (
                    <p className="text-gray-400 text-sm text-center">No buttons in this panel yet.</p>
                  )}
                  {[...new Set(actions.map((a) => a.group || ''))]
                    .sort((x, y) => (x === '' ? -1 : y === '' ? 1 : 0))
                    .map((groupName) => (
                      <div key={groupName || '__ungrouped'}>
                        {groupName && (
                          <button
                            onClick={() => setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }))}
                            onDragOver={(e) => dragActionId && e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              moveAction(dragActionId, null, groupName);
                              setDragActionId(null);
                            }}
                            className="w-full flex items-center gap-1 text-xs font-bold text-gray-400 uppercase mb-1 hover:text-white"
                          >
                            <span>{collapsedGroups[groupName] ? '▸' : '▾'}</span>
                            {groupName}
                            <span className="text-gray-500">({actions.filter((a) => (a.group || '') === groupName).length})</span>
                          </button>
                        )}
                        {!(groupName && collapsedGroups[groupName]) && (
                          <div className="grid grid-cols-2 gap-2">
                            {actions
                              .filter((a) => (a.group || '') === groupName)
                              .map((action) => (
                                <div
                                  key={action.id}
                                  draggable
                                  onDragStart={() => setDragActionId(action.id)}
                                  onDragOver={(e) => dragActionId && e.preventDefault()}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    moveAction(dragActionId, action.id);
                                    setDragActionId(null);
                                  }}
                                  onDragEnd={() => setDragActionId(null)}
                                  className={`group relative ${dragActionId === action.id ? 'opacity-40' : ''}`}
                                >
                                  <button
                                    onClick={() => handleActionClick(action)}
                                    onContextMenu={(e) => handleRightClick(e, action.id)} // RIGHT CLICK TO EDIT
                                    title={action.definition || action.label}
                                    {...colorProps(
                                      action.color,
                                      'relative w-full h-full p-3 rounded-lg text-white font-bold text-sm transition-all active:scale-95 hover:brightness-110 shadow-lg'
                                    )}
                                  >
                                    {action.label}
                                    {action.hotkey && (
                                      <span className="absolute bottom-0.5 left-1.5 text-[9px] font-mono uppercase opacity-70">
                                        {action.hotkey}
                                      </span>
                                    )}
                                  </button>
                                  <button
                                    onClick={() => setEditingAction(action)}
                                    className="absolute top-1 right-1 p-0.5 rounded bg-black/30 text-white opacity-0 group-hover:opacity-90"
                                    title="Edit button"
                                  >
                                    <Pencil size={11} />
                                  </button>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                {/* </div> */}

                {/* CUSTOM ANNOTATION */}
                <div className="mt-3 p-2 bg-gray-700 rounded">
                  <h3 className="text-sm font-bold mb-2">Custom Annotation</h3>
                  <input
                    type="text"
                    value={customAnnotation}
                    onChange={(e) => setCustomAnnotation(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && addCustomAnnotation()}
                    placeholder="Type custom action"
                    className="bg-gray-600 text-white px-2 py-2 text-sm rounded w-full mb-2 border border-gray-500 focus:border-purple-500"
                  />
                  <button
                    onClick={addCustomAnnotation}
                    disabled={!customAnnotation.trim()}
                    className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 px-3 py-2 text-sm rounded font-bold"
                  >
                    Add Other
                  </button>
                </div>
              </div>
            </div>
          </div>
      </div>
        {showLink && (
          <LinkModal
            onSubmit={linkVideo}
            onClose={() => setShowLink(false)}
            savedKey={driveKey}
          />
        )}

        {dialog && dialog.kind === 'newPanel' && (
          <InputModal
            title="New panel"
            fields={[{ key: 'name', label: 'Panel name', value: '' }]}
            confirmLabel="Create"
            onSubmit={runDialog}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog && dialog.kind === 'renamePanel' && (
          <InputModal
            title="Rename panel"
            fields={[{ key: 'name', label: 'Panel name', value: activePanel.name }]}
            onSubmit={runDialog}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog && dialog.kind === 'team' && teams.find((t) => t.id === dialog.teamId) && (
          <InputModal
            title="Edit team"
            fields={[
              { key: 'name', label: 'Team name', value: teams.find((t) => t.id === dialog.teamId).name },
              { key: 'color', label: 'Color (a name or a hex code like #2563eb)', value: teams.find((t) => t.id === dialog.teamId).color },
            ]}
            onSubmit={runDialog}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog && dialog.kind === 'deletePanel' && (
          <ConfirmModal
            title="Delete panel"
            message={`Delete "${activePanel.name}" and its ${actions.length} buttons?`}
            confirmLabel="Delete"
            onConfirm={() => runDialog({})}
            onClose={() => setDialog(null)}
          />
        )}

        {dialog && dialog.kind === 'resetPanel' && (
          <ConfirmModal
            title="Reset panel"
            message={`Replace all buttons in "${activePanel.name}" with the built-in defaults?`}
            confirmLabel="Reset"
            onConfirm={() => runDialog({})}
            onClose={() => setDialog(null)}
          />
        )}

        {editingAction && (
          <ActionEditModal
            key={editingAction.id}
            action={editingAction}
            groups={[...new Set(actions.map((a) => a.group || ''))]}
            takenHotkeys={Object.fromEntries(
              actions.filter((a) => a.hotkey && a.id !== editingAction.id).map((a) => [a.hotkey, a.label])
            )}
            onSave={saveActionEdit}
            onDelete={deleteAction}
            onClose={() => setEditingAction(null)}
          />
        )}

        {showBulkAdd && (
          <BulkAddModal
            existingLabels={actions.map((a) => a.label)}
            groups={[...new Set(actions.map((a) => a.group || ''))]}
            onAdd={addBulkActions}
            onClose={() => setShowBulkAdd(false)}
          />
        )}

        {descriptorPrompt && (
          <DescriptorModal
            action={descriptorPrompt.action}
            onPick={(descriptor) => {
              addAnnotation(descriptorPrompt.action, { timestamp: descriptorPrompt.timestamp, descriptor });
              setDescriptorPrompt(null);
            }}
            onClose={() => setDescriptorPrompt(null)}
          />
        )}

        {editingAnnotation && (
          <AnnotationEditModal
            key={editingAnnotation.id}
            annotation={editingAnnotation}
            onSave={saveAnnotationEdit}
            onClose={() => setEditingAnnotation(null)}
          />
        )}

        {showSummary && (
          <SummaryModal
            annotations={annotations}
            teamNames={teams.map((t) => t.name)}
            onExport={exportSummaryCSV}
            onClose={() => setShowSummary(false)}
          />
        )}

        {toast && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 shadow-2xl flex items-center gap-3 text-sm">
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                onClick={() => {
                  toast.undo();
                  setToast(null);
                }}
                className="text-blue-400 hover:text-blue-300 font-bold"
              >
                Undo
              </button>
            )}
            <button onClick={() => setToast(null)} className="text-gray-400 hover:text-white">
              ×
            </button>
          </div>
        )}

        {activeShot && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-800 p-6 rounded-xl border border-gray-600 w-96 shadow-2xl">
        <h2 className="text-xl font-bold mb-4 text-center">
          Details for {activeShot.label}
        </h2>
        
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 block mb-2">Location</label>
            <select 
              id="shotLocation"
              className="w-full bg-gray-700 p-2 rounded border border-gray-600"
            >
              {shotLocations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
            </select>
          </div>

          <div>
            <label className="text-sm text-gray-400 block mb-2">Result</label>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => finalizeShotAnnotation(document.getElementById('shotLocation').value, 'Made')}
                className="bg-green-600 hover:bg-green-500 py-3 rounded font-bold"
              >
                MADE
              </button>
              <button 
                onClick={() => finalizeShotAnnotation(document.getElementById('shotLocation').value, 'Missed')}
                className="bg-red-600 hover:bg-red-500 py-3 rounded font-bold"
              >
                MISSED
              </button>
            </div>
          </div>
          
          <button 
            onClick={() => setActiveShot(null)}
            className="w-full mt-2 text-gray-400 hover:text-white text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )}
    </div>
  );
}
