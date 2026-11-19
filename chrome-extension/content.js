(() => {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__AGY_USAGE_MONITOR_UI__) return;
  window.__AGY_USAGE_MONITOR_UI__ = true;

  const EVENT_DATA = 'agy-usage:data';
  const EVENT_NET = 'agy-usage:network';
  const EVENT_CMD = 'agy-usage:command';
  const EVENT_STATUS = 'agy-usage:status';
  const EVENT_SAMPLE = 'agy-usage:sample-result';
  const EVENT_REFRESH_RESULT = 'agy-usage:refresh-result';

  const STORAGE_SETTINGS_KEY = 'agy_usage_settings_v1';
  const STORAGE_SNAPSHOT_KEY = 'agy_usage_last_snapshot_v1';

  const DEFAULT_SETTINGS = {
    warningThreshold: 70,
    criticalThreshold: 90,
    displayMode: 'remaining',
    enableNotifications: false,
    enableMockData: false,
    autoRefresh: true,
    customPollUrl: '',
    pollingIntervalSec: 60,
    position: null,
  };

  const MOCK_SNAPSHOT = {
    planName: 'Google AI Ultra (Preview)',
    email: null,
    promptCredits: { available: 41250, monthly: 50000 },
    flowCredits: null,
    sourceUrl: 'mock://antigravity-usage-monitor',
    capturedAt: Date.now(),
    models: [
      {
        id: 'gemini-3.1-pro-high',
        label: 'Gemini 3.1 Pro (High)',
        family: 'Gemini',
        remainingFraction: 0.64,
        usedFraction: 0.36,
        resetTime: Date.now() + 3 * 3600 * 1000 + 42 * 60 * 1000,
        windows: [
          {
            windowType: '5h',
            remainingFraction: 0.64,
            usedFraction: 0.36,
            resetTime: Date.now() + 3 * 3600 * 1000 + 42 * 60 * 1000,
          },
          {
            windowType: 'weekly',
            remainingFraction: 0.84,
            usedFraction: 0.16,
            resetTime: Date.now() + 4 * 86400 * 1000 + 11 * 3600 * 1000,
          },
        ],
        isRecommended: true,
      },
      {
        id: 'claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6 (Thinking)',
        family: 'Claude',
        remainingFraction: 0.26,
        usedFraction: 0.74,
        resetTime: Date.now() + 1 * 3600 * 1000 + 18 * 60 * 1000,
        windows: [
          {
            windowType: '5h',
            remainingFraction: 0.26,
            usedFraction: 0.74,
            resetTime: Date.now() + 1 * 3600 * 1000 + 18 * 60 * 1000,
          },
          {
            windowType: 'weekly',
            remainingFraction: 0.72,
            usedFraction: 0.28,
            resetTime: Date.now() + 5 * 86400 * 1000 + 3 * 3600 * 1000,
          },
        ],
        isRecommended: false,
      },
      {
        id: 'gemini-3.1-flash',
        label: 'Gemini 3.1 Flash',
        family: 'Gemini',
        remainingFraction: 0.96,
        usedFraction: 0.04,
        resetTime: Date.now() + 4 * 3600 * 1000 + 55 * 60 * 1000,
        windows: [
          {
            windowType: '5h',
            remainingFraction: 0.96,
            usedFraction: 0.04,
            resetTime: Date.now() + 4 * 3600 * 1000 + 55 * 60 * 1000,
          },
          {
            windowType: 'weekly',
            remainingFraction: 0.94,
            usedFraction: 0.06,
            resetTime: Date.now() + 4 * 86400 * 1000 + 11 * 3600 * 1000,
          },
        ],
        isRecommended: false,
      },
      {
        id: 'gpt-oss-120b',
        label: 'GPT-OSS 120B (Medium)',
        family: 'GPT',
        remainingFraction: 0.08,
        usedFraction: 0.92,
        resetTime: Date.now() + 27 * 60 * 1000 + 15 * 1000,
        windows: [
          {
            windowType: '5h',
            remainingFraction: 0.08,
            usedFraction: 0.92,
            resetTime: Date.now() + 27 * 60 * 1000 + 15 * 1000,
          },
          {
            windowType: 'weekly',
            remainingFraction: 0.55,
            usedFraction: 0.45,
            resetTime: Date.now() + 5 * 86400 * 1000 + 3 * 3600 * 1000,
          },
        ],
        isRecommended: false,
      },
    ],
  };

  let settings = { ...DEFAULT_SETTINGS };
  let liveSnapshot = null;
  let networkLog = [];
  let interceptorStatus = { active: false, version: null, canRefresh: false };
  let isOpen = false;
  let activeTab = 'overview';
  let familyFilter = 'All';
  let sampleStatusMsg = '';
  let isRefreshing = false;
  let refreshNotice = '';
  let refreshNoticeTimer = null;
  let pollTimer = null;
  let autoRefreshTimer = null;
  const alertedLevels = new Map();

  // --- Pure DOM Helper (ZERO innerHTML — 100% Trusted Types CSP compliant!) ---
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val == null || val === false) continue;
        if (key === 'className') {
          node.className = val;
        } else if (key === 'style' && typeof val === 'object') {
          Object.assign(node.style, val);
        } else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === 'checked' || key === 'value' || key === 'selected' || key === 'disabled') {
          node[key] = val;
        } else {
          node.setAttribute(key, String(val));
        }
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      if (typeof child === 'string' || typeof child === 'number') {
        node.appendChild(document.createTextNode(String(child)));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  // --- Storage abstraction ---
  const hasChromeStorage =
    typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);

  function loadStorage(key) {
    return new Promise((resolve) => {
      if (hasChromeStorage) {
        try {
          chrome.storage.local.get([key], (res) => resolve(res?.[key] ?? null));
          return;
        } catch {
          // fallback
        }
      }
      try {
        const raw = localStorage.getItem(key);
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  }

  function saveStorage(key, value) {
    if (hasChromeStorage) {
      try {
        chrome.storage.local.set({ [key]: value });
      } catch {
        // ignore
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  // --- Formatting & Health Helpers ---
  function formatNumber(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
  }

  function formatCountdown(resetMs) {
    if (!resetMs || typeof resetMs !== 'number') return 'No reset timer';
    const diff = resetMs - Date.now();
    if (diff <= 0) return 'Resetting now…';
    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hrs = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (days > 0) return `${days}d ${hrs}h ${mins}m`;
    if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
  }

  function formatShortCountdown(resetMs) {
    if (!resetMs || typeof resetMs !== 'number') return '';
    const diff = resetMs - Date.now();
    if (diff <= 0) return 'now';
    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hrs = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${Math.max(1, mins)}m`;
  }

  function formatAgo(ts) {
    if (!ts) return 'Never';
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 5) return 'Just now';
    if (sec < 60) return `${sec}s ago`;
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  function formatBytes(b) {
    if (!b || typeof b !== 'number') return '0B';
    if (b < 1024) return `${b}B`;
    return `${(b / 1024).toFixed(1)}KB`;
  }

  function getModelHealth(model) {
    const usedPct = Math.round((1 - model.remainingFraction) * 100);
    if (usedPct >= settings.criticalThreshold) return 'critical';
    if (usedPct >= settings.warningThreshold) return 'warning';
    return 'healthy';
  }

  function getActiveSnapshot() {
    if (settings.enableMockData) return { ...MOCK_SNAPSHOT, isMock: true };
    if (liveSnapshot) return { ...liveSnapshot, isMock: false };
    return null;
  }

  function getOverallHealth(snap) {
    if (!snap || !snap.models || snap.models.length === 0) return 'waiting';
    let worst = 'healthy';
    for (const m of snap.models) {
      const lvl = getModelHealth(m);
      if (lvl === 'critical') return 'critical';
      if (lvl === 'warning') worst = 'warning';
    }
    return worst;
  }

  function checkNotifications(snap) {
    if (!settings.enableNotifications || !snap || snap.isMock) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    for (const m of snap.models || []) {
      const level = getModelHealth(m);
      const prev = alertedLevels.get(m.id);
      if (level === 'healthy') {
        alertedLevels.delete(m.id);
        continue;
      }
      const usedPct = Math.round((1 - m.remainingFraction) * 100);
      if (level === 'critical' && prev !== 'critical') {
        alertedLevels.set(m.id, 'critical');
        new Notification('Antigravity Quota Critical', {
          body: `${m.label}: ${usedPct}% used (${100 - usedPct}% remaining).`,
        });
      } else if (level === 'warning' && !prev) {
        alertedLevels.set(m.id, 'warning');
        new Notification('Antigravity Quota Warning', {
          body: `${m.label}: ${usedPct}% used (${100 - usedPct}% remaining).`,
        });
      }
    }
  }

  function restartPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    const intervalMs = Math.max(10, Number(settings.pollingIntervalSec) || 60) * 1000;

    // 1. Auto-refresh live Antigravity quota XHR/fetch while tab is visible
    if (settings.autoRefresh) {
      autoRefreshTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (settings.enableMockData || !interceptorStatus.canRefresh || isRefreshing) return;
        window.dispatchEvent(new CustomEvent(EVENT_CMD, { detail: { type: 'refresh' } }));
      }, intervalMs);
    }

    // 2. Optional custom/local JSON endpoint
    const url = (settings.customPollUrl || '').trim();
    if (!url) return;

    const pollOnce = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const text = await res.text();
        window.dispatchEvent(
          new CustomEvent(EVENT_CMD, { detail: { type: 'parse-sample', text } })
        );
      } catch {
        // ignore transient errors
      }
    };

    pollOnce();
    pollTimer = setInterval(pollOnce, intervalMs);
  }

  function triggerManualRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    refreshNotice = '';
    renderPanel();
    window.dispatchEvent(new CustomEvent(EVENT_CMD, { detail: { type: 'refresh' } }));
    if (settings.customPollUrl) restartPolling();
    setTimeout(() => {
      if (isRefreshing) {
        isRefreshing = false;
        renderPanel();
      }
    }, 8000);
  }

  // --- Shadow DOM Styles ---
  const STYLES = `
    :host {
      all: initial;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e2e8f0;
      box-sizing: border-box;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .agy-pill {
      position: fixed;
      z-index: 2147483647;
      top: 12px;
      right: 118px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(148, 163, 184, 0.24);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.44), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
      color: #f8fafc;
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.01em;
      cursor: grab;
      user-select: none;
      touch-action: none;
      transition: border-color 0.18s ease, box-shadow 0.2s ease;
    }
    .agy-pill:hover {
      border-color: rgba(56, 189, 248, 0.65);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.56);
    }
    .agy-pill:active { cursor: grabbing; }
    .agy-pill-refresh {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      padding: 2px 3px;
      border-radius: 50%;
      font-size: 12px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .agy-pill-refresh:hover { color: #38bdf8; }
    .agy-pill-refresh.spinning { color: #38bdf8; animation: agySpin 0.8s linear infinite; }
    .agy-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .agy-dot.healthy { background: #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.8); }
    .agy-dot.warning { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.85); }
    .agy-dot.critical { background: #ef4444; box-shadow: 0 0 10px rgba(239, 68, 68, 0.95); animation: agyPulse 1.4s infinite; }
    .agy-dot.waiting { background: #64748b; }
    @keyframes agyPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }
    .agy-pill-reset { color: #94a3b8; font-weight: 500; font-size: 11px; }
    .agy-pill-tag {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 2px 5px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .agy-pill-tag.live { background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
    .agy-pill-tag.mock { background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); }
    .agy-pill-tag.wait { background: rgba(100, 116, 139, 0.22); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25); }

    .agy-panel {
      position: fixed;
      z-index: 2147483646;
      width: 356px;
      max-width: calc(100vw - 24px);
      max-height: min(560px, calc(100vh - 80px));
      display: flex;
      flex-direction: column;
      border-radius: 16px;
      background: rgba(13, 19, 34, 0.96);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 22px 50px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
      overflow: hidden;
    }
    .agy-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(15, 23, 42, 0.72);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .agy-header:active { cursor: grabbing; }
    .agy-title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .agy-title { font-size: 13px; font-weight: 700; color: #f8fafc; white-space: nowrap; }
    .agy-actions { display: flex; align-items: center; gap: 4px; }
    .agy-icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      width: 26px;
      height: 26px;
      border-radius: 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
    }
    .agy-icon-btn:hover { background: rgba(148, 163, 184, 0.14); color: #f8fafc; }
    .agy-icon-btn.spinning { color: #38bdf8; animation: agySpin 0.8s linear infinite; }
    @keyframes agySpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .agy-tabs {
      display: flex;
      gap: 4px;
      padding: 8px 14px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(15, 23, 42, 0.45);
    }
    .agy-tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: #94a3b8;
      font-size: 11.5px;
      font-weight: 600;
      padding: 6px 10px 8px;
      cursor: pointer;
    }
    .agy-tab:hover { color: #e2e8f0; }
    .agy-tab.active { color: #38bdf8; border-bottom-color: #38bdf8; }

    .agy-body {
      padding: 12px 14px 14px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      user-select: text;
    }
    .agy-body::-webkit-scrollbar { width: 6px; }
    .agy-body::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.25); border-radius: 99px; }

    .agy-meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: #94a3b8;
    }
    .agy-plan-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.12);
      color: #7dd3fc;
      border: 1px solid rgba(56, 189, 248, 0.25);
      font-weight: 600;
      font-size: 11px;
    }
    .agy-status-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 11px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.55);
    }
    .agy-status-banner.ok { border-color: rgba(16, 185, 129, 0.35); color: #6ee7b7; }
    .agy-status-banner.warn { border-color: rgba(245, 158, 11, 0.4); color: #fcd34d; }

    .agy-card {
      background: rgba(30, 41, 59, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 11px;
      padding: 10px 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .agy-card.warning { border-color: rgba(245, 158, 11, 0.35); }
    .agy-card.critical { border-color: rgba(239, 68, 68, 0.45); background: rgba(127, 29, 29, 0.16); }

    .agy-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .agy-model-name {
      font-size: 12.5px;
      font-weight: 600;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .agy-model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agy-family-chip {
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
      flex-shrink: 0;
    }
    .agy-win-badge {
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }
    .agy-win-badge.w-5h { background: rgba(56, 189, 248, 0.16); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); }
    .agy-win-badge.w-weekly { background: rgba(167, 139, 250, 0.16); color: #c4b5fd; border: 1px solid rgba(167, 139, 250, 0.35); }
    .agy-win-badge.w-daily { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; border: 1px solid rgba(52, 211, 153, 0.3); }
    .agy-win-badge.w-active { background: rgba(148, 163, 184, 0.14); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25); }
    .agy-win-block {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-top: 4px;
    }
    .agy-win-block + .agy-win-block {
      border-top: 1px dashed rgba(148, 163, 184, 0.14);
      padding-top: 7px;
      margin-top: 2px;
    }
    .agy-win-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
    }
    .agy-pct { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .agy-pct.healthy { color: #34d399; }
    .agy-pct.warning { color: #fbbf24; }
    .agy-pct.critical { color: #f87171; }

    .agy-bar-track {
      position: relative;
      width: 100%;
      height: 7px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.85);
      overflow: hidden;
    }
    .agy-bar-fill { height: 100%; border-radius: 999px; transition: width 0.35s ease; }
    .agy-bar-fill.healthy { background: linear-gradient(90deg, #10b981, #38bdf8); }
    .agy-bar-fill.warning { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .agy-bar-fill.critical { background: linear-gradient(90deg, #ef4444, #fb7185); }
    .agy-bar-fill.credits { background: linear-gradient(90deg, #8b5cf6, #38bdf8); }

    .agy-card-sub {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }
    .agy-filters { display: flex; flex-wrap: wrap; gap: 5px; }
    .agy-filter-btn {
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.5);
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 999px;
      cursor: pointer;
    }
    .agy-filter-btn.active {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.5);
      color: #7dd3fc;
    }
    .agy-empty {
      text-align: center;
      padding: 16px 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: #94a3b8;
      font-size: 12px;
      line-height: 1.5;
    }
    .agy-btn-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .agy-btn {
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #7dd3fc;
      font-size: 11.5px;
      font-weight: 600;
      padding: 6px 11px;
      border-radius: 8px;
      cursor: pointer;
    }
    .agy-btn:hover { background: rgba(56, 189, 248, 0.26); }
    .agy-btn.secondary {
      background: rgba(148, 163, 184, 0.12);
      border-color: rgba(148, 163, 184, 0.26);
      color: #cbd5e1;
    }
    .agy-btn.secondary:hover { background: rgba(148, 163, 184, 0.22); }
    .agy-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; }
    .agy-field-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      font-size: 12px;
    }
    .agy-input, .agy-select, .agy-textarea {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 7px;
      color: #f8fafc;
      font-size: 12px;
      padding: 5px 8px;
      font-family: inherit;
    }
    .agy-textarea {
      width: 100%;
      min-height: 68px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .agy-log-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px;
      border-radius: 7px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid rgba(148, 163, 184, 0.1);
      font-size: 10.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .agy-log-item.matched {
      border-color: rgba(16, 185, 129, 0.45);
      background: rgba(16, 185, 129, 0.08);
    }
    .agy-log-top { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
    .agy-log-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cbd5e1; flex: 1; }
    .agy-log-meta { font-size: 9.5px; color: #64748b; display: flex; justify-content: space-between; }
    .agy-hint { font-size: 11px; color: #94a3b8; line-height: 1.4; }
  `;

  let hostEl = null;
  let shadowRoot = null;
  let pillEl = null;
  let panelEl = null;
  let isDragging = false;
  let isHovered = false;
  let hoverCloseTimer = null;

  function isPanelVisible() {
    return isOpen || isHovered;
  }

  function setupHoverPeek(el) {
    el.addEventListener('pointerenter', () => {
      if (hoverCloseTimer) {
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = null;
      }
      if (!isHovered && !isDragging) {
        isHovered = true;
        renderPanel();
      }
    });
    el.addEventListener('pointerleave', () => {
      if (isOpen || isDragging) return;
      hoverCloseTimer = setTimeout(() => {
        isHovered = false;
        renderPanel();
      }, 220);
    });
  }

  function ensureMounted() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement('div');
    hostEl.id = 'agy-usage-monitor-root';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    shadowRoot.appendChild(styleEl);

    panelEl = h('div', { className: 'agy-panel', style: { display: 'none' } });
    pillEl = h('div', {
      className: 'agy-pill',
      title: 'Antigravity Usage Monitor — Hover to peek, click to pin, drag to move',
    });

    shadowRoot.appendChild(panelEl);
    shadowRoot.appendChild(pillEl);

    setupDragOnElement(pillEl, true);
    setupHoverPeek(pillEl);
    setupHoverPeek(panelEl);
    applySavedPosition();

    (document.documentElement || document.body).appendChild(hostEl);
    render();
  }

  function positionPanel() {
    if (!panelEl || !pillEl || !isPanelVisible()) return;
    const pillRect = pillEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const panelW = Math.min(356, vw - 24);

    // Horizontally align panel with pill without ever overflowing viewport
    let left = pillRect.right - panelW;
    if (left < 12) left = pillRect.left;
    left = Math.max(12, Math.min(vw - panelW - 12, left));

    // Open BELOW pill when more room below (like Gemini HUD top-right); open ABOVE when near bottom
    const spaceAbove = pillRect.top - margin - 12;
    const spaceBelow = vh - pillRect.bottom - margin - 12;

    panelEl.style.left = `${Math.round(left)}px`;
    panelEl.style.right = 'auto';

    if (spaceBelow >= spaceAbove) {
      const maxH = Math.max(180, Math.min(560, Math.floor(spaceBelow)));
      panelEl.style.maxHeight = `${maxH}px`;
      panelEl.style.bottom = 'auto';
      panelEl.style.top = `${Math.round(pillRect.bottom + margin)}px`;
    } else {
      const maxH = Math.max(180, Math.min(560, Math.floor(spaceAbove)));
      panelEl.style.maxHeight = `${maxH}px`;
      panelEl.style.top = 'auto';
      panelEl.style.bottom = `${Math.round(vh - pillRect.top + margin)}px`;
    }
  }

  function applySavedPosition() {
    if (!pillEl) return;
    if (settings.position && typeof settings.position.left === 'number' && typeof settings.position.top === 'number') {
      const pillW = pillEl.offsetWidth || 180;
      const pillH = pillEl.offsetHeight || 34;
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - pillW - 8, settings.position.left));
      const clampedTop = Math.max(8, Math.min(window.innerHeight - pillH - 8, settings.position.top));
      pillEl.style.left = `${Math.round(clampedLeft)}px`;
      pillEl.style.top = `${Math.round(clampedTop)}px`;
      pillEl.style.right = 'auto';
      pillEl.style.bottom = 'auto';
    } else {
      pillEl.style.left = 'auto';
      pillEl.style.bottom = 'auto';
      pillEl.style.top = '12px';
      pillEl.style.right = '118px';
    }
    positionPanel();
  }

  function setupDragOnElement(handleEl, toggleOnClick) {
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    const onMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      const pillW = pillEl.offsetWidth || 160;
      const pillH = pillEl.offsetHeight || 34;
      const newLeft = Math.max(8, Math.min(window.innerWidth - pillW - 8, origLeft + dx));
      const newTop = Math.max(8, Math.min(window.innerHeight - pillH - 8, origTop + dy));
      pillEl.style.left = `${Math.round(newLeft)}px`;
      pillEl.style.top = `${Math.round(newTop)}px`;
      pillEl.style.right = 'auto';
      pillEl.style.bottom = 'auto';
      positionPanel();
    };

    const onUp = () => {
      if (!isDragging) return;
      isDragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) {
        const rect = pillEl.getBoundingClientRect();
        settings.position = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveStorage(STORAGE_SETTINGS_KEY, settings);
        positionPanel();
      } else if (toggleOnClick) {
        isOpen = !isOpen;
        render();
      }
    };

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      e.preventDefault();
      isDragging = true;
      moved = false;
      const rect = pillEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function inferWindowTypeClient(resetTime) {
    if (!resetTime) return 'active';
    const diffHrs = (resetTime - Date.now()) / 3600000;
    if (diffHrs > -0.5 && diffHrs <= 6.5) return '5h';
    if (diffHrs > 6.5 && diffHrs <= 28) return 'daily';
    if (diffHrs > 28) return 'weekly';
    return 'active';
  }

  function getModelWindows(m) {
    if (Array.isArray(m.windows) && m.windows.length > 0) return m.windows;
    return [
      {
        windowType: inferWindowTypeClient(m.resetTime),
        remainingFraction: m.remainingFraction ?? 0,
        usedFraction: m.usedFraction ?? Number((1 - (m.remainingFraction ?? 0)).toFixed(4)),
        resetTime: m.resetTime ?? null,
      },
    ];
  }

  function getWindowLabel(winType) {
    if (winType === '5h') return '5h';
    if (winType === 'weekly') return 'Weekly';
    if (winType === 'daily') return 'Daily';
    return 'Active';
  }

  function renderPill() {
    if (!pillEl || isDragging) return;
    const snap = getActiveSnapshot();
    const health = getOverallHealth(snap);

    let mainText = 'Usage Monitor';
    let resetText = '';
    let tagClass = 'wait';
    let tagLabel = 'WAIT';

    if (snap) {
      tagClass = snap.isMock ? 'mock' : 'live';
      tagLabel = snap.isMock ? 'MOCK' : 'LIVE';

      if (snap.models && snap.models.length > 0) {
        const allWins = snap.models.flatMap(getModelWindows);
        const fiveH = allWins.filter((w) => w.windowType === '5h');
        const weekly = allWins.filter((w) => w.windowType === 'weekly');

        const fmtPct = (frac) => {
          const rem = Math.round(frac * 100);
          return settings.displayMode === 'used' ? `${100 - rem}%` : `${rem}%`;
        };

        if (fiveH.length > 0 && weekly.length > 0) {
          const min5h = fiveH.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
          const minW = weekly.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
          mainText = `5h ${fmtPct(min5h.remainingFraction)} · W ${fmtPct(minW.remainingFraction)}`;
        } else {
          const worst = snap.models[0];
          const wins = getModelWindows(worst);
          const w0 = wins[0];
          const prefix = w0.windowType === '5h' ? '5h ' : w0.windowType === 'weekly' ? 'W ' : '';
          const remPct = Math.round(worst.remainingFraction * 100);
          const usedPct = 100 - remPct;
          mainText =
            settings.displayMode === 'used'
              ? `${prefix}${usedPct}% used`
              : `${prefix}${remPct}% left`;
        }

        const soonestReset = allWins
          .filter((w) => w.remainingFraction < 1 && w.resetTime)
          .map((w) => w.resetTime)
          .sort((a, b) => a - b)[0];
        if (soonestReset) resetText = `↻ ${formatShortCountdown(soonestReset)}`;
      } else if (snap.promptCredits) {
        mainText = `${formatNumber(snap.promptCredits.available)} cr`;
      }
    }

    const refreshBtn = h(
      'button',
      {
        className: `agy-pill-refresh ${isRefreshing ? 'spinning' : ''}`,
        title: 'Refresh quota now',
        onClick: (e) => {
          e.stopPropagation();
          triggerManualRefresh();
        },
      },
      '↻'
    );

    const children = [
      h('span', { className: `agy-dot ${health}` }),
      h('span', null, mainText),
    ];
    if (resetText) children.push(h('span', { className: 'agy-pill-reset' }, resetText));
    children.push(h('span', { className: `agy-pill-tag ${tagClass}` }, tagLabel));
    children.push(refreshBtn);

    pillEl.replaceChildren(...children);
  }

  function buildOverviewTab(snap) {
    if (!snap) {
      return [
        h(
          'div',
          { className: 'agy-empty' },
          h('strong', null, 'Waiting for live quota data from Antigravity'),
          h(
            'div',
            null,
            'Interact with a session or open the model selector. You can also check the Inspector tab to see captured endpoints & copy diagnostics.'
          ),
          h(
            'div',
            { className: 'agy-btn-row' },
            h(
              'button',
              {
                className: 'agy-btn',
                onClick: () => {
                  settings.enableMockData = true;
                  saveStorage(STORAGE_SETTINGS_KEY, settings);
                  render();
                },
              },
              'Preview with Mock Data'
            ),
            h(
              'button',
              {
                className: 'agy-btn secondary',
                onClick: () => {
                  activeTab = 'inspector';
                  renderPanel();
                },
              },
              `Open Inspector (${networkLog.length})`
            )
          )
        ),
      ];
    }

    const out = [];

    out.push(
      h(
        'div',
        { className: 'agy-meta-row' },
        snap.planName
          ? h('span', { className: 'agy-plan-badge' }, snap.planName)
          : h('span', null, 'Active Session'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h(
            'span',
            { 'data-updated-ts': snap.capturedAt || '' },
            refreshNotice || `Updated ${formatAgo(snap.capturedAt)}`
          ),
          h(
            'button',
            {
              className: `agy-filter-btn ${settings.enableMockData ? 'active' : ''}`,
              onClick: () => {
                settings.enableMockData = !settings.enableMockData;
                saveStorage(STORAGE_SETTINGS_KEY, settings);
                render();
              },
            },
            settings.enableMockData ? 'Mock: ON' : 'Live'
          )
        )
      )
    );

    if (snap.promptCredits && snap.promptCredits.monthly > 0) {
      const pct = Math.max(
        0,
        Math.min(100, Math.round((snap.promptCredits.available / snap.promptCredits.monthly) * 100))
      );
      out.push(
        h(
          'div',
          { className: 'agy-card' },
          h(
            'div',
            { className: 'agy-card-top' },
            h('div', { className: 'agy-model-name' }, h('span', { className: 'agy-model-label' }, 'Prompt Credits')),
            h('div', { className: 'agy-pct healthy' }, `${pct}% left`)
          ),
          h(
            'div',
            { className: 'agy-bar-track' },
            h('div', { className: 'agy-bar-fill credits', style: { width: `${pct}%` } })
          ),
          h(
            'div',
            { className: 'agy-card-sub' },
            h('span', null, `${formatNumber(snap.promptCredits.available)} / ${formatNumber(snap.promptCredits.monthly)} available`),
            h('span', null, 'Monthly pool')
          )
        )
      );
    }

    const families = ['All', ...Array.from(new Set((snap.models || []).map((m) => m.family)))];
    if (!families.includes(familyFilter)) familyFilter = 'All';
    if (families.length > 2) {
      out.push(
        h(
          'div',
          { className: 'agy-filters' },
          families.map((f) =>
            h(
              'button',
              {
                className: `agy-filter-btn ${familyFilter === f ? 'active' : ''}`,
                onClick: () => {
                  familyFilter = f;
                  renderPanel();
                },
              },
              f
            )
          )
        )
      );
    }

    const filteredModels = (snap.models || []).filter(
      (m) => familyFilter === 'All' || m.family === familyFilter
    );

    let hasAny5h = false;
    let hasAnyWeekly = false;

    for (const m of filteredModels) {
      const health = getModelHealth(m);
      const windows = getModelWindows(m);
      for (const w of windows) {
        if (w.windowType === '5h') hasAny5h = true;
        if (w.windowType === 'weekly') hasAnyWeekly = true;
      }

      if (windows.length === 1) {
        const w = windows[0];
        const wHealth = getModelHealth(w);
        const remPct = Math.round(w.remainingFraction * 100);
        const usedPct = 100 - remPct;
        const barWidth = settings.displayMode === 'used' ? usedPct : remPct;
        const pctLabel = settings.displayMode === 'used' ? `${usedPct}% used` : `${remPct}% left`;
        const resetTitle = w.resetTime ? new Date(w.resetTime).toLocaleString() : '';

        out.push(
          h(
            'div',
            { className: `agy-card ${wHealth}` },
            h(
              'div',
              { className: 'agy-card-top' },
              h(
                'div',
                { className: 'agy-model-name', title: m.label },
                h('span', { className: 'agy-family-chip' }, m.family),
                h('span', { className: 'agy-model-label' }, m.label)
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('span', { className: `agy-win-badge w-${w.windowType}` }, getWindowLabel(w.windowType)),
                h('div', { className: `agy-pct ${wHealth}` }, pctLabel)
              )
            ),
            h(
              'div',
              { className: 'agy-bar-track' },
              h('div', { className: `agy-bar-fill ${wHealth}`, style: { width: `${barWidth}%` } })
            ),
            h(
              'div',
              { className: 'agy-card-sub' },
              h(
                'span',
                { 'data-reset-ts': w.resetTime || '', title: resetTitle },
                w.resetTime ? `Resets in ${formatCountdown(w.resetTime)}` : 'No active reset window'
              ),
              h('span', null, `${usedPct}% used`)
            )
          )
        );
      } else {
        // Multi-window card (e.g. BOTH 5h and Weekly!)
        const windowBlocks = windows.map((w) => {
          const wHealth = getModelHealth(w);
          const remPct = Math.round(w.remainingFraction * 100);
          const usedPct = 100 - remPct;
          const barWidth = settings.displayMode === 'used' ? usedPct : remPct;
          const pctLabel = settings.displayMode === 'used' ? `${usedPct}% used` : `${remPct}% left`;
          const resetTitle = w.resetTime ? new Date(w.resetTime).toLocaleString() : '';

          return h(
            'div',
            { className: 'agy-win-block' },
            h(
              'div',
              { className: 'agy-win-header' },
              h('span', { className: `agy-win-badge w-${w.windowType}` }, getWindowLabel(w.windowType)),
              h('span', { className: `agy-pct ${wHealth}`, style: { fontSize: '11.5px' } }, pctLabel)
            ),
            h(
              'div',
              { className: 'agy-bar-track' },
              h('div', { className: `agy-bar-fill ${wHealth}`, style: { width: `${barWidth}%` } })
            ),
            h(
              'div',
              { className: 'agy-card-sub' },
              h(
                'span',
                { 'data-reset-ts': w.resetTime || '', title: resetTitle },
                w.resetTime ? `Resets in ${formatCountdown(w.resetTime)}` : 'No active reset window'
              ),
              h('span', null, `${usedPct}% used`)
            )
          );
        });

        out.push(
          h(
            'div',
            { className: `agy-card ${health}` },
            h(
              'div',
              { className: 'agy-card-top' },
              h(
                'div',
                { className: 'agy-model-name', title: m.label },
                h('span', { className: 'agy-family-chip' }, m.family),
                h('span', { className: 'agy-model-label' }, m.label)
              )
            ),
            ...windowBlocks
          )
        );
      }
    }

    if (!snap.isMock && hasAnyWeekly && !hasAny5h) {
      out.push(
        h(
          'div',
          { className: 'agy-hint', style: { paddingTop: '2px' } },
          'Note: Only the Weekly window was present in the captured portal response so far. Antigravity\'s GetUserStatus returns whichever quota window is currently binding unless a separate 5h summary RPC is sent.'
        )
      );
    }

    return out;
  }

  function buildSettingsTab() {
    return [
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Warning threshold (% used)'),
        h('input', {
          className: 'agy-input',
          type: 'number',
          min: 10,
          max: 95,
          style: { width: '72px' },
          value: settings.warningThreshold,
          onChange: (e) => {
            settings.warningThreshold = Math.max(10, Math.min(95, Number(e.target.value) || 70));
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            render();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Critical threshold (% used)'),
        h('input', {
          className: 'agy-input',
          type: 'number',
          min: 20,
          max: 100,
          style: { width: '72px' },
          value: settings.criticalThreshold,
          onChange: (e) => {
            settings.criticalThreshold = Math.max(20, Math.min(100, Number(e.target.value) || 90));
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            render();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Display metric'),
        h(
          'select',
          {
            className: 'agy-select',
            onChange: (e) => {
              settings.displayMode = e.target.value === 'used' ? 'used' : 'remaining';
              saveStorage(STORAGE_SETTINGS_KEY, settings);
              render();
            },
          },
          h('option', { value: 'remaining', selected: settings.displayMode === 'remaining' }, 'Remaining %'),
          h('option', { value: 'used', selected: settings.displayMode === 'used' }, 'Used %')
        )
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Desktop alerts on threshold'),
        h('input', {
          type: 'checkbox',
          checked: settings.enableNotifications,
          onChange: async (e) => {
            settings.enableNotifications = e.target.checked;
            if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
              try {
                await Notification.requestPermission();
              } catch {
                // ignore
              }
            }
            saveStorage(STORAGE_SETTINGS_KEY, settings);
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Mock data preview'),
        h('input', {
          type: 'checkbox',
          checked: settings.enableMockData,
          onChange: (e) => {
            settings.enableMockData = e.target.checked;
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            render();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Auto-refresh live quota'),
        h('input', {
          type: 'checkbox',
          checked: settings.autoRefresh,
          onChange: (e) => {
            settings.autoRefresh = e.target.checked;
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            restartPolling();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field-row' },
        h('label', null, 'Refresh interval (sec)'),
        h('input', {
          className: 'agy-input',
          type: 'number',
          min: 10,
          max: 600,
          style: { width: '72px' },
          value: settings.pollingIntervalSec,
          onChange: (e) => {
            settings.pollingIntervalSec = Math.max(10, Math.min(600, Number(e.target.value) || 60));
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            restartPolling();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-field', style: { paddingTop: '6px' } },
        h('label', null, 'Optional local/custom JSON endpoint'),
        h('input', {
          className: 'agy-input',
          type: 'url',
          placeholder: 'e.g. http://127.0.0.1:8484/api/usage',
          value: settings.customPollUrl,
          onChange: (e) => {
            settings.customPollUrl = e.target.value.trim();
            saveStorage(STORAGE_SETTINGS_KEY, settings);
            restartPolling();
          },
        })
      ),
      h(
        'div',
        { className: 'agy-btn-row', style: { justifyContent: 'flex-start', paddingTop: '4px' } },
        h(
          'button',
          {
            className: 'agy-btn secondary',
            onClick: () => {
              settings.position = null;
              saveStorage(STORAGE_SETTINGS_KEY, settings);
              applySavedPosition();
            },
          },
          'Reset Widget Position'
        )
      ),
    ];
  }

  function buildInspectorTab() {
    const sampleTa = h('textarea', {
      className: 'agy-textarea',
      placeholder: '{"userStatus":{"cascadeModelConfigData":{"clientModelConfigs":[...]}}}',
    });

    const out = [
      h(
        'div',
        { className: `agy-status-banner ${interceptorStatus.active ? 'ok' : 'warn'}` },
        h(
          'span',
          null,
          interceptorStatus.active
            ? `Network hook: Active (v${interceptorStatus.version || '1.5.2'})${interceptorStatus.canRefresh ? ' · Refresh ready' : ''}`
            : 'Network hook: Waiting for MAIN script… (reload page)'
        ),
        h('span', null, `${networkLog.length} unique`)
      ),
      h(
        'div',
        { className: 'agy-hint' },
        'Captures fetch, streams, XHR, WebSockets & WebRTC (JSON, JSPB + Base64 bytes, Connect-RPC & Protobuf). Tokens are never logged.'
      ),
    ];

    if (networkLog.length === 0) {
      out.push(h('div', { className: 'agy-hint' }, 'No API calls captured yet — reload the page or send a prompt.'));
    } else {
      const list = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
        networkLog.slice(0, 25).map((entry) => {
          const flags = [
            entry.hasModelStrings ? 'M' : '',
            entry.hasFractions ? 'F' : '',
            entry.hasTimestamps ? 'T' : '',
          ]
            .filter(Boolean)
            .join('');
          const b64Tag =
            entry.b64Count > 0
              ? ` · b64:${entry.b64Count}(${(entry.b64Kinds || []).join(',') || '?'})`
              : '';
          return h(
            'div',
            { className: `agy-log-item ${entry.matched ? 'matched' : ''}`, title: entry.url },
            h(
              'div',
              { className: 'agy-log-top' },
              h('span', { style: { color: '#38bdf8', fontWeight: '700' } }, entry.method),
              h('span', { className: 'agy-log-url' }, entry.url.replace(/^https?:\/\/[^/]+/, '')),
              h(
                'span',
                { style: { color: entry.matched ? '#34d399' : '#64748b' } },
                entry.matched
                  ? `✓ ${entry.modelCount}m`
                  : `${entry.status ?? '—'}${entry.hits > 1 ? ` ×${entry.hits}` : ''}`
              )
            ),
            h(
              'div',
              { className: 'agy-log-meta' },
              h('span', null, `${entry.transport} · ${entry.contentType || 'unknown'}`),
              h(
                'span',
                null,
                `${formatBytes(entry.maxBytes || entry.bytes)} · ${entry.decodeKind || 'none'}${b64Tag}${flags ? ` [${flags}]` : ''}`
              )
            )
          );
        })
      );
      out.push(list);
    }

    out.push(
      h(
        'div',
        { className: 'agy-field', style: { paddingTop: '6px', borderTop: '1px solid rgba(148,163,184,0.12)' } },
        h('label', null, 'Test / import a JSON payload:'),
        sampleTa,
        h(
          'div',
          { className: 'agy-btn-row', style: { justifyContent: 'space-between', alignItems: 'center' } },
          h(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            h(
              'button',
              {
                className: 'agy-btn',
                onClick: () => {
                  const text = sampleTa.value.trim();
                  if (!text) {
                    sampleStatusMsg = 'Paste JSON first';
                    renderPanel();
                    return;
                  }
                  window.dispatchEvent(
                    new CustomEvent(EVENT_CMD, { detail: { type: 'parse-sample', text } })
                  );
                },
              },
              'Parse JSON'
            ),
            h(
              'button',
              {
                className: 'agy-btn secondary',
                onClick: async () => {
                  const diag = {
                    version: '1.5.2',
                    host: window.location.host,
                    interceptorActive: interceptorStatus.active,
                    canRefresh: Boolean(interceptorStatus.canRefresh),
                    hasLiveSnapshot: Boolean(liveSnapshot),
                    capturedModels: liveSnapshot?.models?.length ?? 0,
                    detectedWindows: (liveSnapshot?.models || []).map((m) => ({
                      label: m.label,
                      windows: getModelWindows(m).map((w) => ({
                        type: w.windowType,
                        remPct: Math.round(w.remainingFraction * 100),
                        hasReset: Boolean(w.resetTime),
                      })),
                    })),
                    uniqueEndpoints: networkLog.slice(0, 40),
                  };
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
                    sampleStatusMsg = 'Copied!';
                  } catch {
                    sampleStatusMsg = 'Copy blocked';
                  }
                  renderPanel();
                },
              },
              'Copy Diagnostics'
            )
          ),
          h('span', { className: 'agy-hint' }, sampleStatusMsg)
        )
      )
    );

    return out;
  }

  function renderPanel() {
    if (!panelEl) return;
    if (!isPanelVisible()) {
      panelEl.style.display = 'none';
      return;
    }
    const prevBody = panelEl.querySelector('.agy-body');
    const prevScrollTop = prevBody ? prevBody.scrollTop : 0;

    panelEl.style.display = 'flex';
    const snap = getActiveSnapshot();
    const health = getOverallHealth(snap);

    const header = h(
      'div',
      { className: 'agy-header', title: 'Drag to move widget' },
      h(
        'div',
        { className: 'agy-title-wrap' },
        h('span', { className: `agy-dot ${health}` }),
        h('span', { className: 'agy-title' }, 'Antigravity Usage Monitor')
      ),
      h(
        'div',
        { className: 'agy-actions' },
        h(
          'button',
          {
            className: `agy-icon-btn ${isRefreshing ? 'spinning' : ''}`,
            title: isRefreshing ? 'Refreshing…' : 'Refresh quota now',
            onClick: triggerManualRefresh,
          },
          '↻'
        ),
        h(
          'button',
          {
            className: 'agy-icon-btn',
            title: 'Minimize',
            onClick: () => {
              isOpen = false;
              isHovered = false;
              renderPanel();
            },
          },
          '✕'
        )
      )
    );

    const tabs = h(
      'div',
      { className: 'agy-tabs' },
      ['overview', 'settings', 'inspector'].map((tabId) => {
        const label =
          tabId === 'overview'
            ? 'Overview'
            : tabId === 'settings'
            ? 'Settings'
            : `Inspector (${networkLog.length})`;
        return h(
          'button',
          {
            className: `agy-tab ${activeTab === tabId ? 'active' : ''}`,
            onClick: () => {
              activeTab = tabId;
              renderPanel();
            },
          },
          label
        );
      })
    );

    const bodyChildren =
      activeTab === 'overview'
        ? buildOverviewTab(snap)
        : activeTab === 'settings'
        ? buildSettingsTab()
        : buildInspectorTab();

    const body = h('div', { className: 'agy-body' }, ...bodyChildren);

    panelEl.replaceChildren(header, tabs, body);
    setupDragOnElement(header, false);
    if (prevScrollTop > 0) body.scrollTop = prevScrollTop;
    positionPanel();
  }

  function render() {
    renderPill();
    renderPanel();
  }

  setInterval(() => {
    renderPill();
    if (isPanelVisible() && activeTab === 'overview' && panelEl) {
      panelEl.querySelectorAll('[data-reset-ts]').forEach((el) => {
        const ts = Number(el.getAttribute('data-reset-ts'));
        if (ts > 0) {
          el.textContent = `Resets in ${formatCountdown(ts)}`;
        }
      });
      if (!refreshNotice) {
        panelEl.querySelectorAll('[data-updated-ts]').forEach((el) => {
          const ts = Number(el.getAttribute('data-updated-ts'));
          if (ts > 0) {
            el.textContent = `Updated ${formatAgo(ts)}`;
          }
        });
      }
    }
  }, 1000);

  window.addEventListener(EVENT_REFRESH_RESULT, (ev) => {
    isRefreshing = false;
    const res = ev?.detail;
    if (refreshNoticeTimer) clearTimeout(refreshNoticeTimer);
    if (res?.ok) {
      refreshNotice = 'Refreshed ✓';
    } else if (res?.reason) {
      refreshNotice = res.reason;
    } else {
      refreshNotice = 'Refresh unavailable';
    }
    refreshNoticeTimer = setTimeout(() => {
      refreshNotice = '';
      if (isPanelVisible() && activeTab === 'overview') renderPanel();
    }, 3500);
    render();
  });

  window.addEventListener(EVENT_STATUS, (ev) => {
    if (ev?.detail) {
      const prevCanRefresh = interceptorStatus.canRefresh;
      interceptorStatus = { ...interceptorStatus, ...ev.detail };
      if (!prevCanRefresh && interceptorStatus.canRefresh) {
        restartPolling();
      }
      if (isPanelVisible() && activeTab === 'inspector') renderPanel();
    }
  });

  window.addEventListener(EVENT_DATA, (ev) => {
    const snap = ev?.detail;
    if (!snap) return;
    liveSnapshot = snap;
    saveStorage(STORAGE_SNAPSHOT_KEY, snap);
    checkNotifications(snap);
    render();
  });

  window.addEventListener(EVENT_NET, (ev) => {
    const entry = ev?.detail;
    if (!entry) return;
    const idx = networkLog.findIndex(
      (x) => x.transport === entry.transport && x.method === entry.method && x.url === entry.url
    );
    if (idx !== -1) {
      networkLog.splice(idx, 1);
    }
    networkLog.unshift(entry);
    if (networkLog.length > 50) networkLog.length = 50;
    if (isPanelVisible() && activeTab === 'inspector') {
      renderPanel();
    }
  });

  window.addEventListener(EVENT_SAMPLE, (ev) => {
    const res = ev?.detail;
    if (res?.ok) {
      settings.enableMockData = false;
      saveStorage(STORAGE_SETTINGS_KEY, settings);
      sampleStatusMsg = `Parsed ${res.modelCount} model(s)!`;
      activeTab = 'overview';
    } else {
      sampleStatusMsg = 'No quota fields found';
    }
    render();
  });

  async function init() {
    const [savedSettings, savedSnapshot] = await Promise.all([
      loadStorage(STORAGE_SETTINGS_KEY),
      loadStorage(STORAGE_SNAPSHOT_KEY),
    ]);
    if (savedSettings && typeof savedSettings === 'object') {
      settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    }
    if (savedSnapshot && typeof savedSnapshot === 'object' && Array.isArray(savedSnapshot.models)) {
      liveSnapshot = savedSnapshot;
    }

    const mountNow = () => {
      ensureMounted();
      window.dispatchEvent(new CustomEvent(EVENT_CMD, { detail: { type: 'sync-state' } }));
      restartPolling();
    };

    if (document.documentElement) {
      mountNow();
    } else {
      document.addEventListener('DOMContentLoaded', mountNow, { once: true });
    }

    window.addEventListener('resize', applySavedPosition);

    const observer = new MutationObserver(() => {
      if (document.documentElement && (!hostEl || !document.documentElement.contains(hostEl))) {
        ensureMounted();
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true });
    }
  }

  init();
})();
