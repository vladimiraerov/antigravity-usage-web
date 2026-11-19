// ==UserScript==
// @name         Antigravity Usage Monitor (Web Portal)
// @namespace    https://antigravity.google.com/
// @version      1.5.1
// @description  Live 5h + Weekly model quota, prompt credits & reset countdown widget on antigravity.google.com (draggable top-right HUD matching Gemini HUD)
// @match        https://antigravity.google.com/*
// @match        https://*.antigravity.google.com/*
// @match        https://antigravity.google/*
// @match        https://*.antigravity.google/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// --- Passive Network Interceptor ---
(() => {
  'use strict';

  if (window.__AGY_USAGE_MONITOR_INJECTED__) return;
  window.__AGY_USAGE_MONITOR_INJECTED__ = true;

  const EVENT_DATA = 'agy-usage:data';
  const EVENT_NET = 'agy-usage:network';
  const EVENT_CMD = 'agy-usage:command';
  const EVENT_STATUS = 'agy-usage:status';
  const EVENT_REFRESH_RESULT = 'agy-usage:refresh-result';
  const BRIDGE_TAG = '__AGY_USAGE_BRIDGE_V1__';
  const MAX_LOG = 50;
  const IS_TOP = window.self === window.top;

  const state = {
    lastSnapshot: null,
    networkLog: [],
    uniqueEndpoints: new Map(),
    lastReplayableFetch: null,
    lastReplayableXhr: null,
    startedAt: Date.now(),
  };

  const SKIP_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|css|map|mp4|webm|mp3|wav|wasm)(?:$|\?)/i;
  const SKIP_HOST_RE = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|www\.google-analytics\.com|googletagmanager\.com|doubleclick\.net|play\.google\.com\/log)/i;
  const SAFE_REPLAY_RE = /(?:GetUserStatus|RetrieveUserQuotaSummary|GetCommandModelConfigs|GetQuota|UserStatus|Quota|Usage|PlanStatus|ModelConfig|ListModels|AccountStatus)/i;
  const MODEL_LABEL_RE = /\b(?:gemini|claude|gpt|deepseek|llama|sonnet|opus|haiku|o1|o3|o4)\b/i;
  const PLAN_NAME_RE = /\b(?:Google AI (?:Pro|Ultra|Free|Plus)|Antigravity (?:Pro|Ultra|Team|Enterprise|Free)|Enterprise|Team|Individual)\b/i;
  const ISO_TS_RE = /^20[2-9]\d-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
  const B64_STRING_RE = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
  const QUOTED_B64_RE = /"([A-Za-z0-9+/_-]{48,}={0,2})"/g;

  function emitToTop(type, detail) {
    if (IS_TOP) {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } else {
      try {
        window.top.postMessage({ [BRIDGE_TAG]: true, type, detail }, '*');
      } catch {
        // cross-origin parent blocked
      }
    }
  }

  if (IS_TOP) {
    window.addEventListener('message', (ev) => {
      const msg = ev?.data;
      if (!msg || typeof msg !== 'object' || msg[BRIDGE_TAG] !== true) return;
      if (msg.type === EVENT_NET && msg.detail) {
        recordLogEntry(msg.detail);
      } else if (msg.type === EVENT_DATA && msg.detail) {
        state.lastSnapshot = msg.detail;
        window.dispatchEvent(new CustomEvent(EVENT_DATA, { detail: msg.detail }));
      }
    });
  }

  function recordLogEntry(logEntry) {
    const key = `${logEntry.transport}:${logEntry.method}:${logEntry.url}`;
    const prev = state.uniqueEndpoints.get(key);
    const mergedKinds = Array.from(
      new Set([...(prev?.b64Kinds || []), ...(logEntry.b64Kinds || [])])
    ).slice(0, 6);

    const merged = {
      ...logEntry,
      hits: (prev?.hits || 0) + 1,
      maxBytes: Math.max(prev?.maxBytes || 0, logEntry.bytes || 0),
      b64Count: (prev?.b64Count || 0) + (logEntry.b64Count || 0),
      b64Kinds: mergedKinds,
      matched: Boolean(prev?.matched || logEntry.matched),
      modelCount: Math.max(prev?.modelCount || 0, logEntry.modelCount || 0),
      hasModelStrings: Boolean(prev?.hasModelStrings || logEntry.hasModelStrings),
      hasTimestamps: Boolean(prev?.hasTimestamps || logEntry.hasTimestamps),
      hasFractions: Boolean(prev?.hasFractions || logEntry.hasFractions),
      firstSeen: prev?.firstSeen || logEntry.timestamp,
      lastSeen: logEntry.timestamp,
    };
    state.uniqueEndpoints.set(key, merged);

    const existingIdx = state.networkLog.findIndex(
      (x) => x.transport === logEntry.transport && x.method === logEntry.method && x.url === logEntry.url
    );
    if (existingIdx !== -1) {
      state.networkLog.splice(existingIdx, 1);
    }
    state.networkLog.unshift(merged);
    if (state.networkLog.length > MAX_LOG) {
      state.networkLog.length = MAX_LOG;
    }
    emitToTop(EVENT_NET, merged);
  }

  function sanitizeUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, window.location.origin);
      return `${u.origin}${u.pathname}`;
    } catch {
      return String(rawUrl || '').split('?')[0].slice(0, 180);
    }
  }

  function shouldInspectUrl(rawUrl) {
    if (!rawUrl) return false;
    const str = String(rawUrl);
    if (str.startsWith('data:') || str.startsWith('blob:') || str.startsWith('chrome-extension:')) return false;
    if (SKIP_EXT_RE.test(str) || SKIP_HOST_RE.test(str)) return false;
    return true;
  }

  function inferFamily(label, id) {
    const text = `${label || ''} ${id || ''}`.toLowerCase();
    if (text.includes('gemini')) return 'Gemini';
    if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) return 'Claude';
    if (text.includes('gpt') || /\bo[134]\b/.test(text)) return 'GPT';
    if (text.includes('deepseek')) return 'DeepSeek';
    if (text.includes('llama')) return 'Llama';
    return 'Other';
  }

  function parseTimestamp(val) {
    if (val == null) return null;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return null;
      if (ISO_TS_RE.test(trimmed)) {
        const ms = Date.parse(trimmed);
        if (!Number.isNaN(ms) && ms > 1600000000000) return ms;
      }
      if (/^\d{10,13}$/.test(trimmed)) {
        const num = Number(trimmed);
        if (num > 1700000000 && num < 2500000000) return num * 1000;
        if (num > 1700000000000 && num < 2500000000000) return num;
      }
      return null;
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
      if (val > 1700000000 && val < 2500000000) return val * 1000;
      if (val > 1700000000000 && val < 2500000000000) return val;
      return null;
    }
    if (Array.isArray(val) && val.length >= 1 && val.length <= 2) {
      const secs = Number(val[0]);
      const nanos = val.length === 2 ? Number(val[1] ?? 0) : 0;
      if (
        Number.isFinite(secs) &&
        secs > 1700000000 &&
        secs < 2500000000 &&
        Number.isFinite(nanos) &&
        nanos >= 0 &&
        nanos < 1000000000
      ) {
        return secs * 1000 + Math.floor(nanos / 1e6);
      }
      return null;
    }
    if (typeof val === 'object') {
      const secs = Number(val.seconds ?? val.sec);
      const nanos = Number(val.nanos ?? 0);
      if (Number.isFinite(secs) && secs > 1700000000 && secs < 2500000000) {
        return secs * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6);
      }
    }
    return null;
  }

  function clamp01(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100));
    if (n >= 0 && n <= 1) return n;
    return null;
  }

  const WINDOW_ORDER = { '5h': 0, daily: 1, weekly: 2, active: 3 };

  function classifyWindow(hintText, resetTime, durationSec) {
    const text = String(hintText || '').toLowerCase();
    if (/\b(?:5h|5hr|5-hour|five.?hour|session|short.?term)\b/.test(text)) return '5h';
    if (/\b(?:weekly|7d|7-day|week)\b/.test(text)) return 'weekly';
    if (/\b(?:daily|24h|1d|day)\b/.test(text)) return 'daily';

    if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
      if (durationSec >= 10800 && durationSec <= 25200) return '5h';
      if (durationSec >= 64800 && durationSec <= 108000) return 'daily';
      if (durationSec >= 432000 && durationSec <= 777600) return 'weekly';
    }

    if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
      const diffHrs = (resetTime - Date.now()) / 3600000;
      if (diffHrs > -0.5 && diffHrs <= 6.5) return '5h';
      if (diffHrs > 6.5 && diffHrs <= 28) return 'daily';
      if (diffHrs > 28) return 'weekly';
    }

    return 'active';
  }

  function normalizeWindows(rawWindows) {
    const byKey = new Map();
    for (const w of rawWindows || []) {
      if (!w || typeof w.remainingFraction !== 'number') continue;
      const winType = w.windowType || classifyWindow(w.hint, w.resetTime, w.durationSec);
      const entry = {
        windowType: winType,
        remainingFraction: Math.max(0, Math.min(1, w.remainingFraction)),
        usedFraction: Number((1 - Math.max(0, Math.min(1, w.remainingFraction))).toFixed(4)),
        resetTime: w.resetTime ?? null,
      };
      const prev = byKey.get(winType);
      if (
        !prev ||
        (prev.resetTime == null && entry.resetTime != null) ||
        (w.score ?? 0) > (prev._score ?? -99)
      ) {
        byKey.set(winType, { ...entry, _score: w.score ?? 0 });
      }
    }
    return Array.from(byKey.values())
      .map(({ _score, ...clean }) => clean)
      .sort((a, b) => (WINDOW_ORDER[a.windowType] ?? 9) - (WINDOW_ORDER[b.windowType] ?? 9));
  }

  function mergeModelEntries(prev, next) {
    if (!prev) return next;
    const windows = normalizeWindows([...(prev.windows || []), ...(next.windows || [])]);
    const tightest = windows.reduce(
      (min, w) => (!min || w.remainingFraction < min.remainingFraction ? w : min),
      null
    );
    return {
      ...prev,
      ...next,
      label: prev.label.length >= next.label.length ? prev.label : next.label,
      windows,
      remainingFraction: tightest ? tightest.remainingFraction : next.remainingFraction,
      usedFraction: tightest ? tightest.usedFraction : next.usedFraction,
      resetTime: tightest ? tightest.resetTime : next.resetTime ?? prev.resetTime,
    };
  }

  function mergeSnapshots(prev, next) {
    if (!next) return prev;
    if (!prev || !Array.isArray(prev.models) || Date.now() - (prev.capturedAt || 0) > 10 * 60 * 1000) {
      return next;
    }
    // Only merge windows from prev when next is missing a window type that prev had (e.g. 5h vs weekly from separate RPCs)
    const nextTypes = new Set();
    for (const m of next.models || []) {
      for (const w of m.windows || []) nextTypes.add(w.windowType);
    }
    const prevByKey = new Map((prev.models || []).map((m) => [m.label.toLowerCase(), m]));
    const mergedModels = (next.models || []).map((m) => {
      const p = prevByKey.get(m.label.toLowerCase());
      if (!p || !Array.isArray(p.windows)) return m;
      const extraWindows = p.windows.filter((w) => !nextTypes.has(w.windowType));
      if (extraWindows.length === 0) return m;
      return mergeModelEntries({ ...p, windows: extraWindows }, m);
    });
    return {
      ...next,
      planName: next.planName || prev.planName,
      promptCredits: next.promptCredits || prev.promptCredits,
      flowCredits: next.flowCredits || prev.flowCredits,
      models: mergedModels,
    };
  }

  function parseSingleQuotaObj(qi, hintText) {
    if (!qi || typeof qi !== 'object') return null;

    let remainingFraction = null;
    if (typeof qi.remainingFraction === 'number') {
      remainingFraction = clamp01(qi.remainingFraction);
    } else if (typeof qi.remaining_fraction === 'number') {
      remainingFraction = clamp01(qi.remaining_fraction);
    } else if (typeof qi.remainingPercentage === 'number') {
      remainingFraction = clamp01(qi.remainingPercentage / 100);
    } else if (typeof qi.remaining_percentage === 'number') {
      remainingFraction = clamp01(qi.remaining_percentage / 100);
    } else if (typeof qi.percentRemaining === 'number') {
      remainingFraction = clamp01(qi.percentRemaining / 100);
    } else if (typeof qi.usedFraction === 'number') {
      const uf = clamp01(qi.usedFraction);
      if (uf !== null) remainingFraction = 1 - uf;
    } else if (typeof qi.used_fraction === 'number') {
      const uf = clamp01(qi.used_fraction);
      if (uf !== null) remainingFraction = 1 - uf;
    } else if (typeof qi.usedPercentage === 'number') {
      const uf = clamp01(qi.usedPercentage / 100);
      if (uf !== null) remainingFraction = 1 - uf;
    } else if (typeof qi.used_percentage === 'number') {
      const uf = clamp01(qi.used_percentage / 100);
      if (uf !== null) remainingFraction = 1 - uf;
    } else if (typeof qi.remaining === 'number' && typeof qi.limit === 'number' && qi.limit > 0) {
      remainingFraction = clamp01(qi.remaining / qi.limit);
    } else if (typeof qi.used === 'number' && typeof qi.limit === 'number' && qi.limit > 0) {
      remainingFraction = clamp01(1 - qi.used / qi.limit);
    }

    const resetMs = parseTimestamp(
      qi.resetTime ??
        qi.reset_time ??
        qi.resetAt ??
        qi.reset_at ??
        qi.nextResetTime ??
        qi.windowResetTime
    );

    const durSec = Number(qi.windowDurationSeconds ?? qi.window_duration_seconds ?? qi.durationSeconds);
    const durationSec = Number.isFinite(durSec) && durSec > 0 ? durSec : null;

    if (remainingFraction === null && resetMs === null) return null;
    if (remainingFraction === null && resetMs !== null) remainingFraction = 0;

    const hint = `${hintText || ''} ${qi.windowType || qi.window_type || qi.window || qi.bucketId || qi.bucket_id || qi.label || ''}`;
    return {
      windowType: classifyWindow(hint, resetMs, durationSec),
      remainingFraction,
      usedFraction: Number((1 - remainingFraction).toFixed(4)),
      resetTime: resetMs,
    };
  }

  // =========================================================================
  // 1. Named-Key JSON Quota Extractor (Multi-Window: 5h + Weekly + Daily)
  // =========================================================================
  function extractModelFromObject(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

    const rawWindows = [];
    const subKeys = [
      ['quotaInfo', ''],
      ['quota_info', ''],
      ['quota', ''],
      ['rateLimit', ''],
      ['rate_limit', ''],
      ['fiveHourQuota', '5h'],
      ['five_hour_quota', '5h'],
      ['shortTermQuota', '5h'],
      ['short_term_quota', '5h'],
      ['sessionQuota', '5h'],
      ['weeklyQuota', 'weekly'],
      ['weekly_quota', 'weekly'],
      ['dailyQuota', 'daily'],
      ['daily_quota', 'daily'],
    ];

    for (const [k, hint] of subKeys) {
      if (item[k] && typeof item[k] === 'object' && !Array.isArray(item[k])) {
        const w = parseSingleQuotaObj(item[k], hint);
        if (w) rawWindows.push(w);
        // Check nested windows array inside quotaInfo
        const innerArr = item[k].windows || item[k].quotaWindows || item[k].quota_windows || item[k].buckets;
        if (Array.isArray(innerArr)) {
          for (const subW of innerArr) {
            const parsedSub = parseSingleQuotaObj(subW, hint);
            if (parsedSub) rawWindows.push(parsedSub);
          }
        }
      }
    }

    const arrayKeys = ['quotaWindows', 'quota_windows', 'windows', 'quotaBuckets', 'quota_buckets'];
    for (const ak of arrayKeys) {
      if (Array.isArray(item[ak])) {
        for (const subW of item[ak]) {
          const parsedSub = parseSingleQuotaObj(subW, '');
          if (parsedSub) rawWindows.push(parsedSub);
        }
      }
    }

    if (rawWindows.length === 0) {
      const selfW = parseSingleQuotaObj(item, item.bucketId || item.bucket_id || item.label || item.name || '');
      if (selfW) rawWindows.push(selfW);
    }

    if (rawWindows.length === 0) return null;

    const modelId =
      item.modelOrAlias?.model ||
      item.model_or_alias?.model ||
      item.modelId ||
      item.model_id ||
      item.bucketId ||
      item.bucket_id ||
      item.model ||
      item.id ||
      '';

    const rawLabel =
      item.label ||
      item.displayName ||
      item.display_name ||
      item.modelName ||
      item.model_name ||
      item.name ||
      modelId;

    if (!rawLabel || typeof rawLabel !== 'string') return null;

    // Clean window suffixes from bucket labels like "gemini-5h" / "gemini-weekly" so they group under one card
    const cleanedLabel = String(rawLabel)
      .trim()
      .replace(/[-_\s]+(?:5h|5hr|5-hour|weekly|7d|daily)$/i, '')
      .trim() || String(rawLabel).trim();

    const windows = normalizeWindows(rawWindows);
    const tightest = windows.reduce(
      (min, w) => (!min || w.remainingFraction < min.remainingFraction ? w : min),
      windows[0]
    );

    return {
      id: String(modelId || cleanedLabel),
      label: cleanedLabel,
      family: inferFamily(cleanedLabel, modelId),
      remainingFraction: tightest.remainingFraction,
      usedFraction: tightest.usedFraction,
      resetTime: tightest.resetTime,
      windows,
      isRecommended: Boolean(item.isRecommended || item.is_recommended),
    };
  }

  function extractUsageFromObject(root, sourceUrl) {
    if (!root || typeof root !== 'object') return null;

    const visited = new WeakSet();
    const modelsMap = new Map();
    let planName = null;
    let email = null;
    let promptCredits = null;
    let flowCredits = null;

    function addModel(m) {
      if (!m) return;
      const key = m.label.toLowerCase();
      modelsMap.set(key, mergeModelEntries(modelsMap.get(key), m));
    }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 14) return;
      if (visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const el = node[i];
          if (el && typeof el === 'object' && !Array.isArray(el)) {
            const parsed = extractModelFromObject(el);
            if (parsed) addModel(parsed);
          }
          walk(el, depth + 1);
        }
        return;
      }

      if (typeof node.email === 'string' && node.email.includes('@') && !email) {
        email = node.email;
      }

      const planStatus = node.planStatus || node.plan_status;
      if (planStatus && typeof planStatus === 'object') {
        const planInfo = planStatus.planInfo || planStatus.plan_info || planStatus;
        const pName =
          planInfo.planName ||
          planInfo.plan_name ||
          planInfo.teamsTier ||
          planStatus.planName ||
          node.userTier?.name ||
          node.user_tier?.name;
        if (typeof pName === 'string' && pName.trim()) {
          planName = pName.trim();
        }

        const availPrompt = Number(
          planStatus.availablePromptCredits ??
            planStatus.available_prompt_credits ??
            planInfo.availablePromptCredits
        );
        const monthlyPrompt = Number(
          planInfo.monthlyPromptCredits ??
            planInfo.monthly_prompt_credits ??
            planStatus.monthlyPromptCredits ??
            planStatus.monthly_prompt_credits
        );
        if (Number.isFinite(monthlyPrompt) && monthlyPrompt > 0) {
          promptCredits = {
            available: Number.isFinite(availPrompt) ? Math.max(0, availPrompt) : 0,
            monthly: monthlyPrompt,
          };
        }

        const availFlow = Number(
          planStatus.availableFlowCredits ??
            planStatus.available_flow_credits ??
            planInfo.availableFlowCredits
        );
        const monthlyFlow = Number(
          planInfo.monthlyFlowCredits ??
            planInfo.monthly_flow_credits ??
            planStatus.monthlyFlowCredits ??
            planStatus.monthly_flow_credits
        );
        if (Number.isFinite(monthlyFlow) && monthlyFlow > 0) {
          flowCredits = {
            available: Number.isFinite(availFlow) ? Math.max(0, availFlow) : 0,
            monthly: monthlyFlow,
          };
        }
      }

      if (!planName && (node.userTier?.name || node.user_tier?.name)) {
        planName = String(node.userTier?.name || node.user_tier?.name).trim();
      }

      const configs =
        node.clientModelConfigs ||
        node.client_model_configs ||
        node.cascadeModelConfigData?.clientModelConfigs ||
        node.cascade_model_config_data?.client_model_configs;
      if (Array.isArray(configs)) {
        for (const cfg of configs) {
          const parsed = extractModelFromObject(cfg);
          if (parsed) addModel(parsed);
        }
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const val = node[keys[i]];
        if (val && typeof val === 'object') {
          walk(val, depth + 1);
        } else if (
          typeof val === 'string' &&
          val.length > 20 &&
          (val[0] === '{' || val[0] === '[') &&
          (val.includes('quota') ||
            val.includes('remaining') ||
            val.includes('Credits') ||
            MODEL_LABEL_RE.test(val))
        ) {
          try {
            walk(JSON.parse(val), depth + 1);
          } catch {
            // ignore
          }
        }
      }
    }

    walk(root, 0);

    const models = Array.from(modelsMap.values());
    if (models.length === 0 && !promptCredits && !flowCredits) {
      return null;
    }

    models.sort((a, b) => {
      if (a.remainingFraction !== b.remainingFraction) {
        return a.remainingFraction - b.remainingFraction;
      }
      return a.label.localeCompare(b.label);
    });

    return {
      models,
      planName,
      email,
      promptCredits,
      flowCredits,
      sourceUrl: sanitizeUrl(sourceUrl),
      capturedAt: Date.now(),
    };
  }

  // =========================================================================
  // 2. Google JSPB (application/json+protobuf) Positional Array Extractor
  //    + Base64 bytes collector (for ProxyCommand / StreamProxyCommand!)
  // =========================================================================
  function extractQuotaFromJspbArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0 || arr.length > 8) return null;

    let remainingFraction = null;
    let resetTime = null;
    let hasNonQuotaJunk = false;

    for (const el of arr) {
      if (el == null || typeof el === 'boolean') continue;
      if (typeof el === 'number' && Number.isFinite(el)) {
        if (el >= 0 && el <= 1) {
          if (remainingFraction === null || !Number.isInteger(el)) {
            remainingFraction = el;
          }
        } else {
          const ts = parseTimestamp(el);
          if (ts) resetTime = ts;
          else hasNonQuotaJunk = true;
        }
      } else if (typeof el === 'string') {
        const ts = parseTimestamp(el);
        if (ts) resetTime = ts;
        else hasNonQuotaJunk = true;
      } else if (Array.isArray(el)) {
        const ts = parseTimestamp(el);
        if (ts) resetTime = ts;
        else hasNonQuotaJunk = true;
      } else {
        hasNonQuotaJunk = true;
      }
    }

    if (hasNonQuotaJunk && resetTime === null) return null;
    if (remainingFraction === null && resetTime === null) return null;
    if (resetTime === null && (remainingFraction === 0 || remainingFraction === 1)) {
      return null;
    }
    if (remainingFraction === null && resetTime !== null) {
      remainingFraction = 0;
    }

    return { remainingFraction, resetTime };
  }

  function extractUsageFromJspb(root, sourceUrl) {
    if (!Array.isArray(root)) return null;

    const visited = new WeakSet();
    const modelsMap = new Map();
    const b64Candidates = [];
    let planName = null;
    const hints = { hasModelStrings: false, hasTimestamps: false, hasFractions: false };

    function scan(node, depth) {
      if (!node || typeof node !== 'object' || depth > 14) return;
      if (visited.has(node)) return;
      visited.add(node);

      if (!Array.isArray(node)) {
        for (const v of Object.values(node)) scan(v, depth + 1);
        return;
      }

      let labelCandidate = null;
      const directQuotas = [];

      for (let i = 0; i < node.length; i++) {
        const el = node[i];
        if (typeof el === 'string') {
          if (!planName && PLAN_NAME_RE.test(el) && el.length < 48) {
            planName = el.trim();
          }
          if (
            !labelCandidate &&
            el.length >= 4 &&
            el.length <= 72 &&
            MODEL_LABEL_RE.test(el) &&
            !el.startsWith('http') &&
            !el.startsWith('/') &&
            !el.includes('\n')
          ) {
            labelCandidate = el.trim();
            hints.hasModelStrings = true;
          }
          if (parseTimestamp(el)) hints.hasTimestamps = true;

          if (el.length > 20 && (el[0] === '[' || el[0] === '{')) {
            try {
              scan(JSON.parse(el), depth + 1);
            } catch {
              // ignore
            }
          } else if (el.length >= 40 && B64_STRING_RE.test(el) && b64Candidates.length < 24) {
            b64Candidates.push(el);
          }
        } else if (typeof el === 'number' && el > 0 && el < 1) {
          hints.hasFractions = true;
        } else if (Array.isArray(el)) {
          if (parseTimestamp(el)) hints.hasTimestamps = true;
          const q = extractQuotaFromJspbArray(el);
          if (q) {
            directQuotas.push(q);
          }
          scan(el, depth + 1);
        } else if (el && typeof el === 'object') {
          scan(el, depth + 1);
        }
      }

      if (labelCandidate && directQuotas.length > 0) {
        const cleanedLabel =
          labelCandidate.replace(/[-_\s]+(?:5h|5hr|5-hour|weekly|7d|daily)$/i, '').trim() ||
          labelCandidate;
        const windows = normalizeWindows(
          directQuotas.map((q) => ({
            windowType: classifyWindow(labelCandidate, q.resetTime, null),
            remainingFraction: q.remainingFraction,
            resetTime: q.resetTime,
          }))
        );
        const tightest = windows.reduce(
          (min, w) => (!min || w.remainingFraction < min.remainingFraction ? w : min),
          windows[0]
        );
        const key = cleanedLabel.toLowerCase();
        modelsMap.set(
          key,
          mergeModelEntries(modelsMap.get(key), {
            id: key,
            label: cleanedLabel,
            family: inferFamily(cleanedLabel, ''),
            remainingFraction: tightest.remainingFraction,
            usedFraction: tightest.usedFraction,
            resetTime: tightest.resetTime,
            windows,
            isRecommended: false,
          })
        );
      }
    }

    scan(root, 0);

    const models = Array.from(modelsMap.values());
    if (models.length === 0) {
      return { snapshot: null, hints, b64Candidates };
    }

    models.sort((a, b) => {
      if (a.remainingFraction !== b.remainingFraction) {
        return a.remainingFraction - b.remainingFraction;
      }
      return a.label.localeCompare(b.label);
    });

    return {
      snapshot: {
        models,
        planName,
        email: null,
        promptCredits: null,
        flowCredits: null,
        sourceUrl: sanitizeUrl(sourceUrl),
        capturedAt: Date.now(),
      },
      hints,
      b64Candidates,
    };
  }

  // =========================================================================
  // 3. Schema-less Binary Protobuf Wire-Format Decoder
  // =========================================================================
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  const utf8Loose = new TextDecoder('utf-8', { fatal: false });

  function isPrintableString(s) {
    if (!s || s.length === 0 || s.length > 200) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 && c !== 0x09) return false;
      if (c === 0x7f) return false;
    }
    return true;
  }

  function decodeProtoMessage(bytes, maxFields = 500) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
    const fields = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;

    while (pos < bytes.length && fields.length < maxFields) {
      let tag = 0;
      let shift = 0;
      let b = 0;
      do {
        if (pos >= bytes.length || shift > 28) return null;
        b = bytes[pos++];
        tag |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);

      const fieldNo = tag >>> 3;
      const wireType = tag & 7;
      if (fieldNo === 0 || fieldNo > 536870911) return null;

      if (wireType === 0) {
        let val = 0n;
        let vShift = 0n;
        do {
          if (pos >= bytes.length || vShift > 63n) return null;
          b = bytes[pos++];
          val |= BigInt(b & 0x7f) << vShift;
          vShift += 7n;
        } while (b & 0x80);
        fields.push({ fieldNo, wireType: 0, value: Number(val) });
      } else if (wireType === 1) {
        if (pos + 8 > bytes.length) return null;
        const f64 = view.getFloat64(pos, true);
        pos += 8;
        fields.push({ fieldNo, wireType: 1, value: f64 });
      } else if (wireType === 2) {
        let len = 0;
        let lShift = 0;
        do {
          if (pos >= bytes.length || lShift > 28) return null;
          b = bytes[pos++];
          len |= (b & 0x7f) << lShift;
          lShift += 7;
        } while (b & 0x80);
        if (len < 0 || pos + len > bytes.length) return null;
        const slice = bytes.subarray(pos, pos + len);
        pos += len;
        fields.push({ fieldNo, wireType: 2, bytes: slice });
      } else if (wireType === 5) {
        if (pos + 4 > bytes.length) return null;
        const f32 = view.getFloat32(pos, true);
        pos += 4;
        fields.push({ fieldNo, wireType: 5, value: f32 });
      } else {
        return null;
      }
    }

    if (pos !== bytes.length || fields.length === 0) return null;
    return fields;
  }

  function tryDecodeTimestampProto(fields) {
    if (!fields || fields.length === 0 || fields.length > 2) return null;
    let secs = null;
    let nanos = 0;
    for (const f of fields) {
      if (f.fieldNo === 1 && f.wireType === 0 && f.value > 1700000000 && f.value < 2500000000) {
        secs = f.value;
      } else if (f.fieldNo === 2 && f.wireType === 0 && f.value >= 0 && f.value < 1000000000) {
        nanos = f.value;
      } else {
        return null;
      }
    }
    if (secs == null) return null;
    return secs * 1000 + Math.floor(nanos / 1e6);
  }

  function extractQuotaFromProtoSubmsg(fields, outerHint) {
    if (!fields || fields.length === 0 || fields.length > 8) return null;
    let remainingFraction = null;
    let resetTime = null;
    let durationSec = null;
    let hintStr = outerHint || '';
    let unknownFields = 0;

    for (const f of fields) {
      if ((f.wireType === 5 || f.wireType === 1) && Number.isFinite(f.value)) {
        if (f.value >= 0 && f.value <= 1.0001) {
          remainingFraction = Math.max(0, Math.min(1, f.value));
          continue;
        }
      } else if (f.wireType === 0 && f.value >= 10800 && f.value <= 777600) {
        // Duration in seconds (e.g., 18000 = 5h, 604800 = 7d)
        durationSec = f.value;
        continue;
      } else if (f.wireType === 2 && f.bytes.length >= 2 && f.bytes.length <= 48) {
        try {
          const s = utf8Decoder.decode(f.bytes);
          if (ISO_TS_RE.test(s)) {
            const ms = Date.parse(s);
            if (!Number.isNaN(ms)) {
              resetTime = ms;
              continue;
            }
          } else if (/\b(?:5h|5-hour|weekly|7d|daily|session)\b/i.test(s)) {
            hintStr += ` ${s}`;
            continue;
          }
        } catch {
          // not string
        }
        const sub = decodeProtoMessage(f.bytes, 5);
        const ts = tryDecodeTimestampProto(sub);
        if (ts) {
          resetTime = ts;
          continue;
        }
        // Check protobuf.Duration submessage: field 1 = seconds (10800..777600)
        if (sub && sub.length <= 2 && sub[0]?.fieldNo === 1 && sub[0]?.wireType === 0 && sub[0].value >= 10800 && sub[0].value <= 777600) {
          durationSec = sub[0].value;
          continue;
        }
      }
      unknownFields++;
    }

    if (remainingFraction === null && resetTime === null) return null;
    if (unknownFields > 2 && resetTime === null) return null;
    if (remainingFraction === null && resetTime !== null) remainingFraction = 0;
    const windowType = classifyWindow(hintStr, resetTime, durationSec);
    return {
      windowType,
      remainingFraction,
      resetTime,
      durationSec,
      score: (resetTime !== null ? 10 : 0) + (remainingFraction < 1 ? 3 : 1) - unknownFields,
    };
  }

  function extractUsageFromProtoBytes(bytes, sourceUrl, hintsOut) {
    const rootFields = decodeProtoMessage(bytes, 1200);
    if (!rootFields) return null;

    const modelsMap = new Map();
    let planName = null;
    let embeddedJsonSnap = null;

    function walkFields(fields, depth) {
      if (!fields || depth > 9 || embeddedJsonSnap) return;

      const directStrings = [];
      const childMsgs = [];

      for (const f of fields) {
        if ((f.wireType === 5 || f.wireType === 1) && f.value > 0 && f.value < 1 && hintsOut) {
          hintsOut.hasFractions = true;
        }
        if (f.wireType !== 2 || f.bytes.length === 0) continue;

        // Check if bytes field carries embedded JSON (e.g., ProxyCommand wrapping Connect-JSON!)
        if (f.bytes.length > 20 && (f.bytes[0] === 0x7b || f.bytes[0] === 0x5b)) {
          try {
            const jsonText = utf8Decoder.decode(f.bytes);
            const parsed = JSON.parse(jsonText);
            const snap = extractUsageFromObject(parsed, sourceUrl);
            if (snap) {
              embeddedJsonSnap = snap;
              return;
            }
            if (Array.isArray(parsed)) {
              const jr = extractUsageFromJspb(parsed, sourceUrl);
              if (jr?.snapshot) {
                embeddedJsonSnap = jr.snapshot;
                return;
              }
            }
          } catch {
            // not JSON
          }
        }

        let decodedStr = null;
        if (f.bytes.length <= 160) {
          try {
            const s = utf8Decoder.decode(f.bytes);
            if (isPrintableString(s)) decodedStr = s;
          } catch {
            // binary
          }
        }

        if (decodedStr) {
          directStrings.push(decodedStr);
          if (MODEL_LABEL_RE.test(decodedStr) && hintsOut) hintsOut.hasModelStrings = true;
          if (ISO_TS_RE.test(decodedStr) && hintsOut) hintsOut.hasTimestamps = true;
          if (!planName && PLAN_NAME_RE.test(decodedStr) && decodedStr.length < 48) {
            planName = decodedStr.trim();
          }
        }

        if (f.bytes.length >= 4) {
          const sub = decodeProtoMessage(f.bytes, 500);
          if (sub) {
            if (tryDecodeTimestampProto(sub) && hintsOut) hintsOut.hasTimestamps = true;
            childMsgs.push(sub);
          }
        }
      }

      const labelCandidate = directStrings.find(
        (s) => s.length >= 4 && s.length <= 72 && MODEL_LABEL_RE.test(s) && !s.startsWith('http') && !s.startsWith('/')
      );

      if (labelCandidate) {
        const outerHint = directStrings.join(' ');
        const foundWindows = [];

        // Check direct quota fields on this message itself (e.g. RetrieveUserQuotaSummary bucket)
        const selfQ = extractQuotaFromProtoSubmsg(fields, outerHint);
        if (selfQ && selfQ.resetTime !== null) {
          foundWindows.push(selfQ);
        }

        // Check all child submessages AND one level deeper (e.g., quotaInfo -> [5h, weekly])
        for (const sub of childMsgs) {
          const q = extractQuotaFromProtoSubmsg(sub, outerHint);
          if (q && (q.resetTime !== null || q.remainingFraction > 0)) {
            foundWindows.push(q);
          }
          // Inspect nested submessages inside a quota container
          for (const f of sub) {
            if (f.wireType === 2 && f.bytes.length >= 4 && f.bytes.length <= 160) {
              const grandSub = decodeProtoMessage(f.bytes, 12);
              if (grandSub) {
                const gq = extractQuotaFromProtoSubmsg(grandSub, outerHint);
                if (gq && gq.resetTime !== null) {
                  foundWindows.push(gq);
                }
              }
            }
          }
        }

        if (foundWindows.length > 0) {
          const cleanedLabel =
            labelCandidate
              .trim()
              .replace(/[-_\s]+(?:5h|5hr|5-hour|weekly|7d|daily)$/i, '')
              .trim() || labelCandidate.trim();
          const windows = normalizeWindows(foundWindows);
          const tightest = windows.reduce(
            (min, w) => (!min || w.remainingFraction < min.remainingFraction ? w : min),
            windows[0]
          );
          const key = cleanedLabel.toLowerCase();
          modelsMap.set(
            key,
            mergeModelEntries(modelsMap.get(key), {
              id: key,
              label: cleanedLabel,
              family: inferFamily(cleanedLabel, ''),
              remainingFraction: tightest.remainingFraction,
              usedFraction: tightest.usedFraction,
              resetTime: tightest.resetTime,
              windows,
              isRecommended: false,
            })
          );
        }
      }

      for (const sub of childMsgs) walkFields(sub, depth + 1);
    }

    walkFields(rootFields, 0);

    if (embeddedJsonSnap) return embeddedJsonSnap;

    const models = Array.from(modelsMap.values());
    if (models.length === 0) return null;

    models.sort((a, b) => {
      if (a.remainingFraction !== b.remainingFraction) {
        return a.remainingFraction - b.remainingFraction;
      }
      return a.label.localeCompare(b.label);
    });

    return {
      models,
      planName,
      email: null,
      promptCredits: null,
      flowCredits: null,
      sourceUrl: sanitizeUrl(sourceUrl),
      capturedAt: Date.now(),
    };
  }

  // =========================================================================
  // Text, Base64 (standard + URL-safe), Connect-RPC Envelope, & Gzip Parsing
  // =========================================================================
  function tryParseTextCandidates(text) {
    const candidates = [];
    if (!text || typeof text !== 'string') return candidates;

    let cleaned = text.trim();
    if (!cleaned) return candidates;

    if (cleaned.startsWith(")]}'")) {
      cleaned = cleaned.replace(/^\)\]\}'\r?\n?/, '').trim();
    }

    if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
      try {
        candidates.push(JSON.parse(cleaned));
        return candidates;
      } catch {
        // Fall through to line-by-line
      }
    }

    const lines = cleaned.split(/\r?\n/);
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line.endsWith(',')) line = line.slice(0, -1).trim();
      if (!line || (line[0] !== '{' && line[0] !== '[')) continue;
      try {
        candidates.push(JSON.parse(line));
      } catch {
        // ignore partial line
      }
    }

    return candidates;
  }

  function decodeBase64ToBytes(b64) {
    try {
      let cleaned = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (cleaned.length < 8) return null;
      const mod = cleaned.length % 4;
      if (mod === 1) return null;
      if (mod > 0) cleaned += '='.repeat(4 - mod);
      const bin = atob(cleaned);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function gunzipBytes(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const resp = new Response(ds.readable);
      return new Uint8Array(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  async function extractFramedPayloads(bytes) {
    const frames = [];
    if (!(bytes instanceof Uint8Array) || bytes.length < 6) return frames;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let count = 0;

    while (offset + 5 <= bytes.length && count < 60) {
      const flags = bytes[offset];
      if (flags !== 0 && flags !== 1 && flags !== 2 && flags !== 3 && flags !== 128 && flags !== 129) {
        break;
      }
      const len = view.getUint32(offset + 1, false);
      if (len === 0 || offset + 5 + len > bytes.length || len > 5 * 1024 * 1024) break;

      let slice = bytes.subarray(offset + 5, offset + 5 + len);
      if (flags & 1) {
        const unzipped = await gunzipBytes(slice);
        if (unzipped) slice = unzipped;
      }
      frames.push(slice);
      offset += 5 + len;
      count++;
    }
    return frames;
  }

  async function inspectPayload(payload, meta) {
    let matchedSnapshot = null;
    let decodeKind = 'none';
    let byteLength = 0;
    let b64Count = 0;
    const b64Kinds = new Set();
    const hints = { hasModelStrings: false, hasTimestamps: false, hasFractions: false };
    const pendingB64 = [];

    const tryParsedCandidate = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      const namedSnap = extractUsageFromObject(obj, meta.url);
      if (namedSnap) {
        decodeKind = 'json-named';
        matchedSnapshot = namedSnap;
        return true;
      }
      if (Array.isArray(obj)) {
        const jspbRes = extractUsageFromJspb(obj, meta.url);
        if (jspbRes?.hints) {
          hints.hasModelStrings = hints.hasModelStrings || jspbRes.hints.hasModelStrings;
          hints.hasTimestamps = hints.hasTimestamps || jspbRes.hints.hasTimestamps;
          hints.hasFractions = hints.hasFractions || jspbRes.hints.hasFractions;
        }
        if (jspbRes?.b64Candidates?.length) {
          for (const s of jspbRes.b64Candidates) {
            if (pendingB64.length < 24) pendingB64.push(s);
          }
        }
        if (jspbRes?.snapshot) {
          decodeKind = 'json-jspb';
          matchedSnapshot = jspbRes.snapshot;
          return true;
        }
      }
      return false;
    };

    const tryBytes = async (rawU8, isFromB64 = false) => {
      if (!rawU8 || rawU8.length === 0) return;
      let u8 = rawU8;
      if (!isFromB64) byteLength = Math.max(byteLength, u8.length);

      // Auto-decompress raw gzip payload (magic 0x1f 0x8b)
      if (u8.length >= 10 && u8[0] === 0x1f && u8[1] === 0x8b) {
        const unzipped = await gunzipBytes(u8);
        if (unzipped) {
          u8 = unzipped;
          if (isFromB64) b64Kinds.add('gzip');
        }
      }

      // 1. Connect-RPC / gRPC-Web framed payloads
      const frames = await extractFramedPayloads(u8);
      if (frames.length > 0) {
        if (isFromB64) b64Kinds.add('framed');
        else decodeKind = 'framed';
        for (const frame of frames) {
          const text = utf8Loose.decode(frame);
          for (const obj of tryParseTextCandidates(text)) {
            if (tryParsedCandidate(obj)) {
              decodeKind = isFromB64 ? 'b64-framed-json' : `framed-${decodeKind}`;
              return;
            }
          }
          const protoSnap = extractUsageFromProtoBytes(frame, meta.url, hints);
          if (protoSnap) {
            decodeKind = isFromB64 ? 'b64-framed-proto' : 'framed-proto';
            matchedSnapshot = protoSnap;
            return;
          }
        }
      }

      // 2. UTF-8 JSON / JSPB
      if (u8.length < 4 * 1024 * 1024 && (u8[0] === 0x7b || u8[0] === 0x5b || u8[0] === 0x29 || u8[0] === 0x20 || u8[0] === 0x0a)) {
        const text = utf8Loose.decode(u8);
        const objs = tryParseTextCandidates(text);
        if (objs.length > 0) {
          if (isFromB64) b64Kinds.add(Array.isArray(objs[0]) ? 'jspb' : 'json');
          else if (decodeKind === 'none') decodeKind = Array.isArray(objs[0]) ? 'jspb' : 'json';
        }
        for (const obj of objs) {
          if (tryParsedCandidate(obj)) {
            if (isFromB64) decodeKind = `b64-${decodeKind}`;
            return;
          }
        }
      }

      // 3. Raw Binary Protobuf
      const validProtoFields = decodeProtoMessage(u8, 600);
      if (validProtoFields) {
        if (isFromB64) b64Kinds.add('proto');
        else if (decodeKind === 'none') decodeKind = 'proto';
        const rawProto = extractUsageFromProtoBytes(u8, meta.url, hints);
        if (rawProto) {
          decodeKind = isFromB64 ? 'b64-proto' : 'proto';
          matchedSnapshot = rawProto;
          return;
        }
      } else if (isFromB64) {
        b64Kinds.add('opaque');
      }
    };

    if (typeof payload === 'string') {
      byteLength = payload.length;
      if (/grpc-web-text/i.test(meta.contentType || '')) {
        const b64Bytes = decodeBase64ToBytes(payload);
        if (b64Bytes) {
          decodeKind = 'grpc-web-text';
          await tryBytes(b64Bytes, false);
        }
      }
      if (!matchedSnapshot) {
        const objs = tryParseTextCandidates(payload);
        if (objs.length > 0) {
          decodeKind = Array.isArray(objs[0]) ? 'jspb' : 'json';
          for (const obj of objs) {
            if (tryParsedCandidate(obj)) break;
          }
        } else {
          // Streaming partial JSPB chunk (e.g. StreamProxyCommand): pull quoted Base64 strings directly!
          QUOTED_B64_RE.lastIndex = 0;
          let m;
          while ((m = QUOTED_B64_RE.exec(payload)) !== null && pendingB64.length < 24) {
            pendingB64.push(m[1]);
          }
        }
      }
    } else if (payload instanceof Uint8Array) {
      await tryBytes(payload, false);
    } else if (payload instanceof ArrayBuffer) {
      await tryBytes(new Uint8Array(payload), false);
    } else if (payload && typeof payload === 'object') {
      decodeKind = Array.isArray(payload) ? 'jspb' : 'object';
      tryParsedCandidate(payload);
    }

    // Unpack Base64 bytes fields collected from JSPB / StreamProxyCommand!
    if (!matchedSnapshot && pendingB64.length > 0) {
      for (const b64Str of pendingB64) {
        const decoded = decodeBase64ToBytes(b64Str);
        if (!decoded || decoded.length < 12) continue;
        b64Count++;
        await tryBytes(decoded, true);
        if (matchedSnapshot) break;
      }
    }

    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      transport: meta.transport,
      method: meta.method || 'GET',
      url: sanitizeUrl(meta.url),
      status: meta.status ?? null,
      contentType: (meta.contentType || '').split(';')[0].trim(),
      bytes: byteLength,
      decodeKind,
      b64Count,
      b64Kinds: Array.from(b64Kinds),
      matched: Boolean(matchedSnapshot),
      modelCount: matchedSnapshot ? matchedSnapshot.models.length : 0,
      hasModelStrings: hints.hasModelStrings,
      hasTimestamps: hints.hasTimestamps,
      hasFractions: hints.hasFractions,
      timestamp: Date.now(),
    };

    recordLogEntry(logEntry);

    if (matchedSnapshot) {
      matchedSnapshot = mergeSnapshots(state.lastSnapshot, matchedSnapshot);
      state.lastSnapshot = matchedSnapshot;
      emitToTop(EVENT_DATA, matchedSnapshot);
    }

    return matchedSnapshot;
  }

  async function readResponseStream(clone, meta, onMatched) {
    const ct = meta.contentType || '';
    const isStreamType = /event-stream|connect\+|grpc-web|ndjson|octet-stream|proto/i.test(ct);

    if (!clone.body || typeof clone.body.getReader !== 'function') {
      const buf = await clone.arrayBuffer();
      const snap = await inspectPayload(buf, meta);
      if (snap && onMatched) onMatched(snap);
      return;
    }

    const reader = clone.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    const MAX_ACCUM = 4 * 1024 * 1024;
    let emittedChunkMatch = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value && value.byteLength > 0) {
          if (totalBytes + value.byteLength <= MAX_ACCUM) {
            chunks.push(value);
            totalBytes += value.byteLength;
          }
          if (isStreamType) {
            const snap = await inspectPayload(value, {
              ...meta,
              transport: `${meta.transport}:stream`,
            });
            if (snap) {
              emittedChunkMatch = true;
              if (onMatched) onMatched(snap);
            }
          }
        }
        if (done) break;
      }
    } catch {
      // stream closed
    }

    if (totalBytes > 0 && (!isStreamType || !emittedChunkMatch)) {
      const merged = new Uint8Array(totalBytes);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const isGrpcWebText = /grpc-web-text/i.test(ct);
      const payload = isGrpcWebText ? utf8Loose.decode(merged) : merged;
      const snap = await inspectPayload(payload, meta);
      if (snap && onMatched) onMatched(snap);
    }
  }

  // =========================================================================
  // 4. Passive fetch() hook
  // =========================================================================
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function agyWrappedFetch(input, init) {
      const reqUrl = typeof input === 'string' ? input : input?.url || '';
      const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      let preClonedInput = null;
      if (
        typeof input !== 'string' &&
        input &&
        typeof input.clone === 'function' &&
        (method === 'GET' || SAFE_REPLAY_RE.test(reqUrl))
      ) {
        try {
          preClonedInput = input.clone();
        } catch {
          preClonedInput = null;
        }
      }

      const promise = origFetch.apply(this, arguments);

      if (shouldInspectUrl(reqUrl)) {
        promise
          .then((response) => {
            if (!response || typeof response.clone !== 'function') return;
            const ct = response.headers?.get?.('content-type') || '';
            if (/^(?:image|video|audio|font)\/|text\/(?:html|css)|javascript/i.test(ct)) {
              return;
            }
            const clone = response.clone();
            readResponseStream(
              clone,
              {
                transport: 'fetch',
                method,
                url: reqUrl,
                status: response.status,
                contentType: ct,
              },
              () => {
                if (method === 'GET' || SAFE_REPLAY_RE.test(reqUrl)) {
                  try {
                    const clonedInit = init ? { ...init } : undefined;
                    if (typeof input === 'string') {
                      state.lastReplayableFetch = { input, init: clonedInit };
                    } else if (preClonedInput) {
                      state.lastReplayableFetch = { input: preClonedInput, init: clonedInit };
                    }
                  } catch {
                    state.lastReplayableFetch = null;
                  }
                }
              }
            ).catch(() => {});
          })
          .catch(() => {});
      }

      return promise;
    };
  }

  // =========================================================================
  // 5. Passive XMLHttpRequest hook (unary load + streaming progress + replay capture)
  // =========================================================================
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function agyWrappedOpen(method, url) {
    this.__agyMeta = {
      method: String(method || 'GET').toUpperCase(),
      url: String(url || ''),
      headers: [],
      body: null,
      seenOffset: 0,
    };
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function agyWrappedSetHeader(name, value) {
    if (this.__agyMeta && Array.isArray(this.__agyMeta.headers)) {
      this.__agyMeta.headers.push([String(name), String(value)]);
    }
    return origXhrSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function agyWrappedSend(body) {
    const meta = this.__agyMeta;
    if (meta && shouldInspectUrl(meta.url)) {
      // Save small request body strictly in memory for safe on-demand refresh replay
      try {
        if (typeof body === 'string' && body.length <= 65536) {
          meta.body = body;
        } else if (body instanceof Uint8Array && body.byteLength <= 65536) {
          meta.body = body.slice();
        } else if (body instanceof ArrayBuffer && body.byteLength <= 65536) {
          meta.body = body.slice(0);
        }
      } catch {
        meta.body = null;
      }

      const saveReplayableIfMatched = (snap, xhrRef) => {
        if (!snap || !snap.models || snap.models.length === 0) return;
        state.lastReplayableXhr = {
          method: meta.method,
          url: meta.url,
          headers: meta.headers.slice(),
          body: meta.body,
          withCredentials: Boolean(xhrRef.withCredentials),
        };
        emitToTop(EVENT_STATUS, {
          active: true,
          startedAt: state.startedAt,
          version: '1.5.0',
          canRefresh: true,
        });
      };

      this.addEventListener(
        'progress',
        () => {
          try {
            if (this.readyState !== 3) return;
            if (this.responseType !== '' && this.responseType !== 'text') return;
            const text = this.responseText || '';
            if (text.length <= meta.seenOffset + 10) return;
            const delta = text.slice(meta.seenOffset);
            meta.seenOffset = text.length;
            const ct = this.getResponseHeader('content-type') || '';
            if (/^(?:image|video|audio|font)\/|text\/(?:html|css)|javascript/i.test(ct)) return;
            inspectPayload(delta, {
              transport: 'xhr:stream',
              method: meta.method,
              url: meta.url,
              status: this.status,
              contentType: ct,
            });
          } catch {
            // ignore
          }
        },
        { passive: true }
      );

      this.addEventListener(
        'load',
        () => {
          try {
            const ct = this.getResponseHeader('content-type') || '';
            if (/^(?:image|video|audio|font)\/|text\/(?:html|css)|javascript/i.test(ct)) return;
            let payload = null;
            if (this.responseType === '' || this.responseType === 'text') {
              payload = this.responseText;
            } else if (this.responseType === 'json' || this.responseType === 'arraybuffer') {
              payload = this.response;
            } else if (this.responseType === 'blob' && this.response instanceof Blob) {
              this.response.arrayBuffer().then((buf) => {
                inspectPayload(buf, {
                  transport: 'xhr',
                  method: meta.method,
                  url: meta.url,
                  status: this.status,
                  contentType: ct,
                }).then((snap) => saveReplayableIfMatched(snap, this));
              });
              return;
            }
            if (payload != null) {
              inspectPayload(payload, {
                transport: 'xhr',
                method: meta.method,
                url: meta.url,
                status: this.status,
                contentType: ct,
              }).then((snap) => saveReplayableIfMatched(snap, this));
            }
          } catch {
            // ignore
          }
        },
        { passive: true }
      );
    }
    return origXhrSend.apply(this, arguments);
  };

  // =========================================================================
  // 6. Passive WebSocket hook
  // =========================================================================
  const OrigWebSocket = window.WebSocket;
  if (typeof OrigWebSocket === 'function') {
    const WrappedWebSocket = function (url, protocols) {
      const ws =
        protocols !== undefined
          ? new OrigWebSocket(url, protocols)
          : new OrigWebSocket(url);

      const wsUrl = String(url || '');
      ws.addEventListener(
        'message',
        (ev) => {
          try {
            if (typeof ev.data === 'string' && ev.data.length > 12) {
              inspectPayload(ev.data, {
                transport: 'ws',
                method: 'MSG',
                url: wsUrl,
                status: 101,
                contentType: 'websocket/text',
              });
            } else if (ev.data instanceof ArrayBuffer && ev.data.byteLength < 2 * 1024 * 1024) {
              inspectPayload(new Uint8Array(ev.data), {
                transport: 'ws',
                method: 'BIN',
                url: wsUrl,
                status: 101,
                contentType: 'websocket/binary',
              });
            } else if (ev.data instanceof Blob && ev.data.size < 2 * 1024 * 1024) {
              ev.data.arrayBuffer().then((buf) => {
                inspectPayload(new Uint8Array(buf), {
                  transport: 'ws',
                  method: 'BLOB',
                  url: wsUrl,
                  status: 101,
                  contentType: 'websocket/binary',
                });
              });
            }
          } catch {
            // ignore
          }
        },
        { passive: true }
      );

      return ws;
    };
    WrappedWebSocket.prototype = OrigWebSocket.prototype;
    WrappedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = OrigWebSocket.OPEN;
    WrappedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    window.WebSocket = WrappedWebSocket;
  }

  // =========================================================================
  // 7. Passive WebRTC RTCDataChannel hook (for Remote Control Mesh sessions!)
  // =========================================================================
  const OrigRTCPC = window.RTCPeerConnection;
  if (typeof OrigRTCPC === 'function') {
    const attachDataChannel = (ch, labelHint) => {
      if (!ch || ch.__agyHooked) return;
      ch.__agyHooked = true;
      const chLabel = ch.label || labelHint || 'datachannel';
      ch.addEventListener(
        'message',
        (ev) => {
          try {
            if (typeof ev.data === 'string' && ev.data.length > 16) {
              inspectPayload(ev.data, {
                transport: 'rtc',
                method: 'DC',
                url: `webrtc://${chLabel}`,
                status: 200,
                contentType: 'webrtc/text',
              });
            } else if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 8 && ev.data.byteLength < 4 * 1024 * 1024) {
              inspectPayload(new Uint8Array(ev.data), {
                transport: 'rtc',
                method: 'DC',
                url: `webrtc://${chLabel}`,
                status: 200,
                contentType: 'webrtc/binary',
              });
            } else if (ev.data instanceof Blob && ev.data.size > 8 && ev.data.size < 4 * 1024 * 1024) {
              ev.data.arrayBuffer().then((buf) => {
                inspectPayload(new Uint8Array(buf), {
                  transport: 'rtc',
                  method: 'DC',
                  url: `webrtc://${chLabel}`,
                  status: 200,
                  contentType: 'webrtc/binary',
                });
              });
            }
          } catch {
            // ignore
          }
        },
        { passive: true }
      );
    };

    const origCreateDC = OrigRTCPC.prototype.createDataChannel;
    if (typeof origCreateDC === 'function') {
      OrigRTCPC.prototype.createDataChannel = function agyCreateDC(label) {
        const ch = origCreateDC.apply(this, arguments);
        try {
          attachDataChannel(ch, label);
        } catch {
          // ignore
        }
        return ch;
      };
    }

    const WrappedRTCPC = function (...args) {
      const pc = new OrigRTCPC(...args);
      pc.addEventListener(
        'datachannel',
        (ev) => {
          try {
            attachDataChannel(ev.channel, ev.channel?.label);
          } catch {
            // ignore
          }
        },
        { passive: true }
      );
      return pc;
    };
    WrappedRTCPC.prototype = OrigRTCPC.prototype;
    Object.setPrototypeOf(WrappedRTCPC, OrigRTCPC);
    window.RTCPeerConnection = WrappedRTCPC;
  }

  // =========================================================================
  // 8. Command channel from isolated UI (top frame only)
  // =========================================================================
  if (IS_TOP) {
    window.addEventListener(EVENT_CMD, (ev) => {
      const cmd = ev?.detail;
      if (!cmd || typeof cmd !== 'object') return;

      if (cmd.type === 'sync-state') {
        window.dispatchEvent(
          new CustomEvent(EVENT_STATUS, {
            detail: {
              active: true,
              startedAt: state.startedAt,
              version: '1.5.0',
              canRefresh: Boolean(state.lastReplayableXhr || state.lastReplayableFetch),
            },
          })
        );
        if (state.lastSnapshot) {
          window.dispatchEvent(new CustomEvent(EVENT_DATA, { detail: state.lastSnapshot }));
        }
        for (let i = state.networkLog.length - 1; i >= 0; i--) {
          window.dispatchEvent(new CustomEvent(EVENT_NET, { detail: state.networkLog[i] }));
        }
      } else if (cmd.type === 'refresh') {
        const emitRefresh = (ok, status, reason) => {
          window.dispatchEvent(
            new CustomEvent(EVENT_REFRESH_RESULT, { detail: { ok, status, reason } })
          );
        };

        if (state.lastReplayableXhr) {
          const req = state.lastReplayableXhr;
          try {
            const xhr = new XMLHttpRequest();
            origXhrOpen.call(xhr, req.method, req.url, true);
            xhr.withCredentials = req.withCredentials;
            for (const [k, v] of req.headers) {
              try {
                origXhrSetHeader.call(xhr, k, v);
              } catch {
                // skip browser-restricted header
              }
            }
            xhr.addEventListener('load', () => {
              const ct = xhr.getResponseHeader('content-type') || '';
              if (xhr.status >= 200 && xhr.status < 300) {
                inspectPayload(xhr.responseText, {
                  transport: 'xhr:refresh',
                  method: req.method,
                  url: req.url,
                  status: xhr.status,
                  contentType: ct,
                }).then((snap) => {
                  emitRefresh(Boolean(snap), xhr.status, snap ? 'Refreshed' : 'No quota in response');
                });
              } else {
                emitRefresh(false, xhr.status, `HTTP ${xhr.status}`);
              }
            });
            xhr.addEventListener('error', () => emitRefresh(false, 0, 'Network error'));
            xhr.addEventListener('timeout', () => emitRefresh(false, 0, 'Timeout'));
            xhr.timeout = 15000;
            origXhrSend.call(xhr, req.body);
          } catch (err) {
            emitRefresh(false, 0, err?.message || 'Replay error');
          }
        } else if (state.lastReplayableFetch) {
          try {
            const input =
              typeof state.lastReplayableFetch.input === 'string'
                ? state.lastReplayableFetch.input
                : state.lastReplayableFetch.input.clone();
            window
              .fetch(input, state.lastReplayableFetch.init)
              .then((res) => emitRefresh(res.ok, res.status, res.ok ? 'Refreshed' : `HTTP ${res.status}`))
              .catch(() => emitRefresh(false, 0, 'Fetch failed'));
          } catch {
            emitRefresh(false, 0, 'Replay error');
          }
        } else {
          emitRefresh(false, 0, 'No live quota request captured yet — reload tab once');
        }
      } else if (cmd.type === 'parse-sample' && typeof cmd.text === 'string') {
        inspectPayload(cmd.text, {
          transport: 'manual',
          method: 'PASTE',
          url: 'manual://sample-json',
          status: 200,
          contentType: 'application/json',
        }).then((snap) => {
          window.dispatchEvent(
            new CustomEvent('agy-usage:sample-result', {
              detail: { ok: Boolean(snap), modelCount: snap ? snap.models.length : 0 },
            })
          );
        });
      }
    });
  }
})();

// --- Shadow DOM Widget UI ---
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
            ? `Network hook: Active (v${interceptorStatus.version || '1.5.0'})${interceptorStatus.canRefresh ? ' · Refresh ready' : ''}`
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
                    version: '1.5.1',
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
