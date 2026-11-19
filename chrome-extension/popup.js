(() => {
  'use strict';

  const STORAGE_SETTINGS_KEY = 'agy_usage_settings_v1';
  const STORAGE_SNAPSHOT_KEY = 'agy_usage_last_snapshot_v1';

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'className') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function formatCountdown(resetMs) {
    if (!resetMs) return 'No reset timer';
    const diff = resetMs - Date.now();
    if (diff <= 0) return 'Resetting now…';
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const hr = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `Resets in ${d}d ${hr}h`;
    if (hr > 0) return `Resets in ${hr}h ${m}m`;
    return `Resets in ${Math.max(1, m)}m`;
  }

  function formatAgo(ts) {
    if (!ts) return 'Never';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 10) return 'Just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  chrome.storage.local.get([STORAGE_SETTINGS_KEY, STORAGE_SNAPSHOT_KEY], (res) => {
    const root = document.getElementById('content');
    const settings = { warningThreshold: 70, criticalThreshold: 90, ...(res?.[STORAGE_SETTINGS_KEY] || {}) };
    const snap = res?.[STORAGE_SNAPSHOT_KEY];

    if (!snap || !Array.isArray(snap.models) || snap.models.length === 0) {
      root.replaceChildren(
        h(
          'div',
          { className: 'empty' },
          'No live quota snapshot captured yet. Open ',
          h('strong', null, 'antigravity.google.com'),
          ' — the floating Usage Monitor pill will appear automatically and sync here.'
        )
      );
      return;
    }

    const cards = snap.models.map((m) => {
      const remPct = Math.round((m.remainingFraction ?? 0) * 100);
      const usedPct = 100 - remPct;
      const health =
        usedPct >= settings.criticalThreshold
          ? 'critical'
          : usedPct >= settings.warningThreshold
          ? 'warning'
          : 'healthy';
      return h(
        'div',
        { className: 'card' },
        h(
          'div',
          { className: 'row' },
          h('span', { className: 'label', title: m.label }, m.label),
          h('span', { className: health }, `${remPct}% left`)
        ),
        h('div', { className: 'track' }, h('div', { className: `fill ${health}`, style: { width: `${remPct}%` } })),
        h('div', { className: 'sub' }, h('span', null, formatCountdown(m.resetTime)), h('span', null, `${usedPct}% used`))
      );
    });

    root.replaceChildren(
      h('div', { className: 'meta' }, h('span', null, snap.planName || 'Antigravity'), h('span', null, `Updated ${formatAgo(snap.capturedAt)}`)),
      h('div', { className: 'list' }, cards)
    );
  });
})();
