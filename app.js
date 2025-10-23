// app.js (ESM)
const APP_VERSION = 1;
const STORAGE_PREFIX = 'lotto:v1:';
const DEFAULT_CLASS_KEY = 'trida-1';
const DEFAULT_SETTINGS = {
  spinMs: 2600,
  reducedMotionMode: 'auto',
  theme: 'auto'
};

const utils = {
  /** Normalize whitespace, remove empties, deduplicate */
  sanitizeRawInput(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.normalize('NFC').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  },
  /** Create deterministic key for a name */
  createKey(raw) {
    const normalized = raw.normalize('NFKD');
    const withoutMarks = normalized.replace(/\p{Diacritic}/gu, '');
    const lower = withoutMarks.toLocaleLowerCase('cs');
    const dashed = lower.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    const trimmed = dashed.replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (trimmed) {
      return trimmed;
    }
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return `id-${buffer[0].toString(16)}`;
  },
  /** Merge new raw names with existing ones */
  mergeNames(existing, rawNames) {
    const map = new Map(existing.map((item) => [item.key, item]));
    for (const raw of rawNames) {
      const clean = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      const key = utils.createKey(clean);
      // Update or add - new raw value always overwrites (allows fixing typos)
      map.set(key, { raw: clean, key });
    }
    return Array.from(map.values());
  },
  formatTimestamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('cs-CZ', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(date);
  }
};

const state = (() => {
  const listeners = new Set();
  let data = {
    classKey: DEFAULT_CLASS_KEY,
    names: [],
    absentKeys: new Set(),
    history: [],
    settings: { ...DEFAULT_SETTINGS }
  };

  function notify() {
    for (const listener of listeners) listener(getSnapshot());
  }

  function getSnapshot() {
    return {
      classKey: data.classKey,
      names: [...data.names],
      absentKeys: new Set(data.absentKeys),
      history: [...data.history],
      settings: { ...data.settings }
    };
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      fn(getSnapshot());
      return () => listeners.delete(fn);
    },
    setClassKey(key) {
      data.classKey = key || DEFAULT_CLASS_KEY;
      notify();
    },
    updateFromStorage(payload) {
      if (!payload) return;
      data.names = payload.names ?? [];
      data.absentKeys = new Set(payload.absentKeys ?? []);
      data.history = payload.history ?? [];
      data.settings = { ...DEFAULT_SETTINGS, ...(payload.settings ?? {}) };
      notify();
    },
    setNames(newNames) {
      data.names = newNames;
      const validKeys = new Set(newNames.map((n) => n.key));
      data.absentKeys = new Set([...data.absentKeys].filter((key) => validKeys.has(key)));
      notify();
    },
    toggleAbsent(key, isAbsent) {
      if (isAbsent) {
        data.absentKeys.add(key);
      } else {
        data.absentKeys.delete(key);
      }
      notify();
    },
    clearAbsent() {
      data.absentKeys.clear();
      notify();
    },
    addHistory(entry) {
      data.history = [entry, ...data.history].slice(0, 20);
      notify();
    },
    resetHistory() {
      data.history = [];
      notify();
    },
    setSettings(partial) {
      data.settings = { ...data.settings, ...partial };
      notify();
    },
    getPresentNames() {
      return data.names.filter((n) => !data.absentKeys.has(n.key));
    },
    getState() {
      return getSnapshot();
    }
  };
})();

const rng = {
  /** Return random index in range [0, max) using crypto */
  index(max) {
    if (max <= 0) return 0;
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const fraction = array[0] / (0xffffffff + 1);
    return Math.floor(fraction * max);
  }
};

const storage = (() => {
  function buildKey(classKey) {
    return `${STORAGE_PREFIX}${classKey}`;
  }

  function migrate(payload) {
    if (!payload) return null;
    if (payload.version === APP_VERSION) return payload;
    // Placeholder for future migrations
    return {
      version: APP_VERSION,
      classKey: payload.classKey ?? DEFAULT_CLASS_KEY,
      names: payload.names ?? [],
      absentKeys: payload.absentKeys ?? [],
      history: payload.history ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(payload.settings ?? {}) }
    };
  }

  function parse(json) {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Soubor neobsahuje platná JSON data (očekáván objekt).');
      }
      if (parsed.version !== APP_VERSION) {
        throw new Error(`Nepodporovaná verze souboru (očekávána verze ${APP_VERSION}, nalezena ${parsed.version ?? 'žádná'}).`);
      }
      return migrate(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Soubor obsahuje neplatnou JSON syntaxi. Zkontrolujte, zda je soubor správný.');
      }
      console.error(error);
      throw error;
    }
  }

  return {
    load(classKey) {
      try {
        const raw = localStorage.getItem(buildKey(classKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const migrated = migrate(parsed);
        return migrated;
      } catch (error) {
        console.error('Chyba při načítání', error);
        return null;
      }
    },
    save(classKey, snapshot) {
      try {
        const payload = {
          version: APP_VERSION,
          classKey,
          names: snapshot.names,
          absentKeys: [...snapshot.absentKeys],
          history: snapshot.history,
          settings: snapshot.settings
        };
        localStorage.setItem(buildKey(classKey), JSON.stringify(payload));
      } catch (error) {
        console.error('Chyba při ukládání', error);
      }
    },
    exportPayload(snapshot) {
      return {
        version: APP_VERSION,
        classKey: snapshot.classKey,
        names: snapshot.names,
        absentKeys: [...snapshot.absentKeys],
        history: snapshot.history,
        settings: snapshot.settings
      };
    },
    importPayload(json) {
      const parsed = parse(json);
      if (!parsed) {
        throw new Error('Soubor neobsahuje platná data.');
      }
      const rawNames = Array.isArray(parsed.names) ? parsed.names : [];
      const sanitizedNames = [];
      const seenKeys = new Set();
      rawNames.forEach((item) => {
        const raw =
          typeof item.raw === 'string' ? item.raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
        if (!raw) return;
        const key = utils.createKey(raw);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        sanitizedNames.push({ raw, key });
      });
      const absentKeys = Array.isArray(parsed.absentKeys)
        ? parsed.absentKeys.filter((key) => seenKeys.has(key))
        : [];
      const history = Array.isArray(parsed.history)
        ? parsed.history
            .map((entry) => ({
              key: entry.key,
              ts: entry.ts,
              id: entry.id || crypto.randomUUID()
            }))
            .filter((entry) =>
              seenKeys.has(entry.key) && typeof entry.ts === 'string' && !Number.isNaN(new Date(entry.ts).getTime())
            )
            .slice(0, 20)
        : [];
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings ?? {})
      };
      settings.spinMs = Number.isFinite(Number(settings.spinMs)) ? Number(settings.spinMs) : DEFAULT_SETTINGS.spinMs;
      if (!['auto', 'on', 'off'].includes(settings.reducedMotionMode)) settings.reducedMotionMode = DEFAULT_SETTINGS.reducedMotionMode;
      if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
      return {
        version: APP_VERSION,
        classKey: parsed.classKey || DEFAULT_CLASS_KEY,
        names: sanitizedNames,
        absentKeys,
        history,
        settings
      };
    }
  };
})();

const render = (() => {
  const namesList = document.getElementById('namesList');
  const winnerStatus = document.getElementById('winnerStatus');
  const historyList = document.getElementById('historyList');
  const highlightList = document.getElementById('highlightList');

  function renderNames(names, absentKeys, selectedKey = null) {
    namesList.textContent = '';
    if (!names.length) {
      const li = document.createElement('li');
      li.className = 'rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300';
      li.textContent = 'Zatím nebyla přidána žádná jména.';
      namesList.appendChild(li);
      return;
    }
    names.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm dark:border-slate-700 dark:bg-slate-900';
      li.dataset.key = name.key;
      const label = document.createElement('label');
      label.className = 'flex flex-1 items-center gap-3 text-sm';
      label.setAttribute('for', `absent-${name.key}`);
      const span = document.createElement('span');
      span.className = 'truncate font-medium';
      span.textContent = name.raw;
      span.title = name.raw;
      if (selectedKey && selectedKey === name.key) {
        span.classList.add('text-accent');
      }
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'h-4 w-4 rounded border-slate-300 text-accent focus-visible:outline-none focus-visible:ring focus-visible:ring-accent/60 dark:border-slate-600';
      checkbox.id = `absent-${name.key}`;
      checkbox.checked = absentKeys.has(name.key);
      checkbox.dataset.key = name.key;
      label.appendChild(checkbox);
      label.appendChild(span);
      const status = document.createElement('span');
      status.className = 'text-xs text-slate-500 dark:text-slate-400';
      status.textContent = checkbox.checked ? 'Nepřítomen' : 'Přítomen';
      li.appendChild(label);
      li.appendChild(status);
      namesList.appendChild(li);
    });
  }

  function renderWinner(name) {
    winnerStatus.textContent = name ? name.raw : '';
  }

  function renderHistory(history, namesMap) {
    historyList.textContent = '';
    if (!history.length) {
      const li = document.createElement('li');
      li.className = 'text-sm text-slate-500 dark:text-slate-400';
      li.textContent = 'Historie je prázdná.';
      historyList.appendChild(li);
      return;
    }
    history.forEach((entry) => {
      const li = document.createElement('li');
      li.className = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900';
      const name = namesMap.get(entry.key);
      const text = name ? name.raw : entry.key;
      const ts = utils.formatTimestamp(entry.ts);
      li.textContent = ts ? `${ts} · ${text}` : text;
      li.title = text;
      historyList.appendChild(li);
    });
  }

  function renderHighlightList(names) {
    highlightList.textContent = '';
    names.forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name.raw;
      li.dataset.key = name.key;
      li.className = 'rounded px-2 py-1 text-slate-600 dark:text-slate-300';
      highlightList.appendChild(li);
    });
  }

  function highlightResult(key) {
    highlightList.querySelectorAll('[data-key]').forEach((el) => {
      if (el.dataset.key === key) {
        el.classList.add('bg-accent/20', 'text-accent');
      } else {
        el.classList.remove('bg-accent/20', 'text-accent');
      }
    });
    namesList.querySelectorAll('li').forEach((li) => {
      const span = li.querySelector('span.truncate');
      if (!span) return;
      if (li.dataset.key === key) {
        span.classList.add('text-accent');
      } else {
        span.classList.remove('text-accent');
      }
    });
  }

  return {
    names: renderNames,
    winner: renderWinner,
    history: renderHistory,
    highlightList: renderHighlightList,
    highlightResult
  };
})();

const wheel = (() => {
  const segmentsGroup = document.getElementById('wheelSegments');
  let currentRotation = 0;
  let currentNames = [];
  let spinning = false;

  function createSegmentPath(startAngle, endAngle, radius, index, total) {
    const start = polarToCartesian(150, 150, radius, endAngle);
    const end = polarToCartesian(150, 150, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
    const pathData = [
      `M 150 150`,
      `L ${start.x} ${start.y}`,
      `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
      'Z'
    ].join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    const palette = ['#1f7aec', '#9333ea', '#ec4899', '#f97316', '#0ea5e9', '#22c55e'];
    path.setAttribute('fill', palette[index % palette.length]);
    path.setAttribute('data-index', String(index));
    path.setAttribute('data-total', String(total));
    return path;
  }

  function polarToCartesian(cx, cy, radius, angleInDegrees) {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: cx + radius * Math.cos(angleInRadians),
      y: cy + radius * Math.sin(angleInRadians)
    };
  }

  function update(names) {
    currentNames = names;
    segmentsGroup.textContent = '';
    segmentsGroup.style.transform = `rotate(${currentRotation}deg)`;
    if (!names.length) return;
    const total = names.length;
    const slice = 360 / total;
    names.forEach((name, index) => {
      const startAngle = index * slice;
      const endAngle = startAngle + slice;
      const path = createSegmentPath(startAngle, endAngle, 140, index, total);
      path.setAttribute('data-key', name.key);
      segmentsGroup.appendChild(path);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '150');
      text.setAttribute('y', '150');
      text.setAttribute('class', 'wheel-label');
      text.setAttribute('data-key', name.key);
      text.textContent = name.raw;
      text.setAttribute('transform', `rotate(${startAngle + slice / 2} 150 150) translate(0 -90)`);
      segmentsGroup.appendChild(text);
    });
  }

  function spinTo(index, durationMs, reduceMotion) {
    if (!currentNames.length) return Promise.resolve();
    const total = currentNames.length;
    const slice = 360 / total;
    if (reduceMotion) {
      currentRotation = (360 - index * slice - slice / 2) % 360;
      segmentsGroup.style.transform = `rotate(${currentRotation}deg)`;
      return Promise.resolve(currentNames[index]);
    }
    if (spinning) return Promise.resolve(null);
    spinning = true;
    const targetAngle = 360 * 5 + (360 - index * slice - slice / 2);
    return new Promise((resolve) => {
      const onTransitionEnd = () => {
        segmentsGroup.removeEventListener('transitionend', onTransitionEnd);
        segmentsGroup.style.transition = '';
        currentRotation = targetAngle % 360;
        spinning = false;
        resolve(currentNames[index]);
      };
      requestAnimationFrame(() => {
        segmentsGroup.addEventListener('transitionend', onTransitionEnd, { once: true });
        segmentsGroup.style.transition = `transform ${durationMs}ms cubic-bezier(0.23, 1, 0.32, 1)`;
        segmentsGroup.style.transform = `rotate(${targetAngle}deg)`;
      });
    });
  }

  function stopEarly() {
    if (!spinning) return;
    segmentsGroup.dispatchEvent(new Event('transitionend'));
  }

  return {
    update,
    spinTo,
    stopEarly,
    isSpinning: () => spinning
  };
})();

const ocr = (() => {
  const workerBlob = new Blob([
    `self.importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@2/dist/tesseract.min.js');\n` +
      `self.addEventListener('message', async (event) => {\n` +
      `  const { id, image } = event.data;\n` +
      `  try {\n` +
      `    const result = await Tesseract.recognize(image, 'ces', {\n` +
      `      langPath: 'https://tessdata.projectnaptha.com/4.0.0'\n` +
      `    });\n` +
      `    const text = result.data && result.data.text ? result.data.text : '';\n` +
      `    self.postMessage({ id, status: 'done', text });\n` +
      `  } catch (error) {\n` +
      `    self.postMessage({ id, status: 'error', message: error.message });\n` +
      `  }\n` +
      `});`
  ], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);

  const callbacks = new Map();
  const OCR_TIMEOUT_MS = 60000; // 60 seconds

  worker.addEventListener('message', (event) => {
    const { id, status, text, message } = event.data;
    const callback = callbacks.get(id);
    if (!callback) return;
    if (callback.timeoutId) {
      clearTimeout(callback.timeoutId);
    }
    if (status === 'done') {
      callback.resolve(text);
    } else {
      callback.reject(new Error(message || 'OCR selhalo.'));
    }
    callbacks.delete(id);
  });

  worker.addEventListener('error', (error) => {
    console.error('OCR Worker error:', error);
    // Reject all pending callbacks
    for (const [id, callback] of callbacks.entries()) {
      if (callback.timeoutId) {
        clearTimeout(callback.timeoutId);
      }
      callback.reject(new Error('OCR worker selhal. Zkuste stránku znovu načíst.'));
    }
    callbacks.clear();
  });

  return {
    recognize(imageDataUrl) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const callback = callbacks.get(id);
          if (callback) {
            callbacks.delete(id);
            reject(new Error('OCR vypršel časový limit (60s). Zkuste menší obrázek.'));
          }
        }, OCR_TIMEOUT_MS);

        callbacks.set(id, { resolve, reject, timeoutId });
        try {
          worker.postMessage({ id, image: imageDataUrl });
        } catch (error) {
          clearTimeout(timeoutId);
          callbacks.delete(id);
          reject(new Error('Nepodařilo se odeslat obrázek do OCR: ' + error.message));
        }
      });
    }
  };
})();

const ui = (() => {
  const drawBtn = document.getElementById('drawBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetHistoryBtn = document.getElementById('resetHistoryBtn');
  const addNamesBtn = document.getElementById('addNamesBtn');
  const namesInput = document.getElementById('namesInput');
  const namesListEl = document.getElementById('namesList');
  const jsonImportBtn = document.getElementById('importJsonBtn');
  const jsonFileInput = document.getElementById('jsonFileInput');
  const exportJsonBtn = document.getElementById('exportJsonBtn');
  const ocrBtn = document.getElementById('ocrBtn');
  const ocrFileInput = document.getElementById('ocrFileInput');
  const spinDuration = document.getElementById('spinDuration');
  const motionMode = document.getElementById('motionMode');
  const themeMode = document.getElementById('themeMode');
  const themeToggle = document.getElementById('themeToggle');
  const classKeyInput = document.getElementById('classKey');
  const historyToggle = document.getElementById('toggleHistory');
  const lockZones = document.querySelectorAll('[data-lock-zone]');

  const mediaReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mediaTheme = window.matchMedia('(prefers-color-scheme: dark)');

  let currentReduced = mediaReduced.matches;
  let lastWinnerKey = null;
  let isHydrating = true;
  let isDrawing = false;

  function handleStateChange(snapshot, presentNames) {
    classKeyInput.value = snapshot.classKey;
    render.names(snapshot.names, snapshot.absentKeys);
    render.highlightList(presentNames);
    if (lastWinnerKey && !presentNames.some((n) => n.key === lastWinnerKey)) {
      lastWinnerKey = null;
      render.winner(null);
    }
    if (lastWinnerKey) {
      render.highlightResult(lastWinnerKey);
    } else {
      render.highlightResult(null);
    }
    const namesMap = new Map(snapshot.names.map((n) => [n.key, n]));
    if (lastWinnerKey && namesMap.has(lastWinnerKey)) {
      render.winner(namesMap.get(lastWinnerKey));
    }
    render.history(snapshot.history, namesMap);
    updateButtons(snapshot);
    updateSettings(snapshot.settings);
    if (!isHydrating) {
      storage.save(snapshot.classKey, snapshot);
    }
  }

  function updateButtons(snapshot) {
    const present = snapshot.names.filter((n) => !snapshot.absentKeys.has(n.key));
    const disabled = present.length <= 1;
    drawBtn.disabled = disabled;
    drawBtn.setAttribute('aria-disabled', String(disabled));
  }

  function updateSettings(settings) {
    spinDuration.value = settings.spinMs;
    motionMode.value = settings.reducedMotionMode;
    themeMode.value = settings.theme;
    applyMotionPreference(settings.reducedMotionMode);
    applyTheme(settings.theme);
  }

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'dark') {
      root.classList.add('dark');
    } else if (mode === 'light') {
      root.classList.remove('dark');
    } else {
      if (mediaTheme.matches) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
  }

  function applyMotionPreference(mode) {
    const body = document.body;
    if (!body) return;
    if (mode === 'on') {
      body.dataset.motionPreference = 'on';
    } else if (mode === 'off') {
      body.dataset.motionPreference = 'off';
    } else {
      delete body.dataset.motionPreference;
    }
  }

  function shouldReduceMotion(settings) {
    if (settings.reducedMotionMode === 'on') return true;
    if (settings.reducedMotionMode === 'off') return false;
    return currentReduced;
  }

  function lockInteractions(lock) {
    lockZones.forEach((zone) => {
      if (lock) {
        zone.setAttribute('inert', '');
        zone.setAttribute('aria-disabled', 'true');
      } else {
        zone.removeAttribute('inert');
        zone.removeAttribute('aria-disabled');
      }
    });
    [addNamesBtn, jsonImportBtn, exportJsonBtn, ocrBtn, themeToggle, historyToggle, namesInput, jsonFileInput, ocrFileInput, spinDuration, motionMode, themeMode, classKeyInput].forEach((el) => {
      if (!el) return;
      if (el === stopBtn || el === resetHistoryBtn) return;
      if (lock) {
        el.setAttribute('aria-disabled', 'true');
        el.disabled = true;
      } else {
        el.removeAttribute('aria-disabled');
        if ('disabled' in el) el.disabled = false;
      }
    });
    if (lock) {
      drawBtn.disabled = true;
      drawBtn.setAttribute('aria-disabled', 'true');
    } else {
      updateButtons(state.getState());
    }
  }

  function addNamesFromInput() {
    const raw = utils.sanitizeRawInput(namesInput.value);
    if (!raw.length) return;
    const snapshot = state.getState();
    const merged = utils.mergeNames(snapshot.names, raw);
    state.setNames(merged);
    namesInput.value = '';
  }

  async function handleDraw() {
    // Prevent double-click and concurrent draws
    if (isDrawing || wheel.isSpinning()) return;
    isDrawing = true;

    const snapshot = state.getState();
    const present = snapshot.names.filter((n) => !snapshot.absentKeys.has(n.key));
    if (present.length === 0) {
      isDrawing = false;
      return;
    }

    const index = rng.index(present.length);
    const reduceMotion = shouldReduceMotion(snapshot.settings);
    lockInteractions(true);
    let selected = null;
    try {
      selected = await wheel.spinTo(index, snapshot.settings.spinMs, reduceMotion);
    } finally {
      lockInteractions(false);
      isDrawing = false;
    }
    if (!selected) return;
    lastWinnerKey = selected.key;
    render.winner(selected);
    render.highlightResult(selected.key);
    state.addHistory({ key: selected.key, ts: new Date().toISOString(), id: crypto.randomUUID() });
  }

  function handleStop() {
    wheel.stopEarly();
  }

  function handleResetHistory() {
    state.resetHistory();
  }

  function handleAbsentToggle(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.dataset.key) return;
    const key = target.dataset.key;
    const isAbsent = target.checked;
    // Immediate UI update for better responsiveness
    const li = target.closest('li');
    if (li) {
      const statusSpan = li.querySelector('span.text-xs');
      if (statusSpan) {
        statusSpan.textContent = isAbsent ? 'Nepřítomen' : 'Přítomen';
      }
    }
    state.toggleAbsent(key, isAbsent);
  }

  function handleJsonImport() {
    jsonFileInput.click();
  }

  function handleJsonFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size === 0) {
      alert('Soubor je prázdný. Vyberte platný JSON soubor.');
      jsonFileInput.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Soubor je příliš velký (max 5 MB).');
      jsonFileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = storage.importPayload(reader.result);
        lastWinnerKey = payload.history.length ? payload.history[0].key : null;
        isHydrating = true;
        state.setClassKey(payload.classKey);
        state.updateFromStorage(payload);
        isHydrating = false;
        alert(`Import úspěšný! Načteno ${payload.names.length} žáků.`);
      } catch (error) {
        alert('Chyba při importu: ' + error.message);
      } finally {
        jsonFileInput.value = '';
      }
    };
    reader.onerror = () => {
      alert('Chyba při čtení souboru. Zkuste to prosím znovu.');
      jsonFileInput.value = '';
    };
    reader.readAsText(file);
  }

  function handleExport() {
    const snapshot = state.getState();
    const payload = storage.exportPayload(snapshot);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${snapshot.classKey || 'trida'}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function preprocessImage(image) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const scale = 1;
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const value = avg > 140 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function handleOcrImport() {
    ocrFileInput.click();
  }

  function handleOcrFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    // Set loading state
    const originalText = ocrBtn.textContent;
    ocrBtn.textContent = '⏳ Zpracovávám obrázek...';
    ocrBtn.disabled = true;
    ocrBtn.setAttribute('aria-busy', 'true');

    const resetLoadingState = () => {
      ocrBtn.textContent = originalText;
      ocrBtn.disabled = false;
      ocrBtn.removeAttribute('aria-busy');
      ocrFileInput.value = '';
    };

    const image = new Image();
    image.onload = async () => {
      try {
        const dataUrl = preprocessImage(image);
        const text = await ocr.recognize(dataUrl);
        const raw = utils.sanitizeRawInput(text);
        if (raw.length === 0) {
          alert('Z obrázku se nepodařilo rozpoznat žádný text. Zkuste jiný obrázek.');
        } else {
          const snapshot = state.getState();
          const merged = utils.mergeNames(snapshot.names, raw);
          state.setNames(merged);
        }
      } catch (error) {
        alert('Chyba při rozpoznávání textu: ' + error.message);
      } finally {
        resetLoadingState();
      }
    };
    image.onerror = () => {
      alert('Obrázek se nepodařilo načíst.');
      resetLoadingState();
    };
    const reader = new FileReader();
    reader.onload = () => {
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function handleSpinDurationChange(event) {
    const value = Number.parseInt(event.target.value, 10);
    if (Number.isNaN(value)) return;
    // Clamp value between 500 and 10000
    const clamped = Math.max(500, Math.min(10000, value));
    if (clamped !== value) {
      // Reset input to clamped value if out of range
      event.target.value = clamped;
    }
    state.setSettings({ spinMs: clamped });
  }

  function handleMotionModeChange(event) {
    const value = event.target.value;
    state.setSettings({ reducedMotionMode: value });
    applyMotionPreference(value);
  }

  function handleThemeModeChange(event) {
    const value = event.target.value;
    state.setSettings({ theme: value });
    applyTheme(value);
  }

  function handleThemeToggle() {
    const snapshot = state.getState();
    const next = snapshot.settings.theme === 'dark' ? 'light' : 'dark';
    state.setSettings({ theme: next });
    applyTheme(next);
  }

  function handleClassKeyChange(event) {
    const key = event.target.value.trim() || DEFAULT_CLASS_KEY;
    isHydrating = true;
    // Clear current winner before loading new class
    lastWinnerKey = null;
    render.winner(null);
    state.setClassKey(key);
    const stored = storage.load(key);
    if (stored) {
      lastWinnerKey = stored.history.length ? stored.history[0].key : null;
      state.updateFromStorage(stored);
    } else {
      state.updateFromStorage({
        names: [],
        absentKeys: [],
        history: [],
        settings: { ...DEFAULT_SETTINGS }
      });
    }
    isHydrating = false;
  }

  function handleHistoryToggle() {
    const expanded = historyToggle.getAttribute('aria-expanded') === 'true';
    historyToggle.setAttribute('aria-expanded', String(!expanded));
    document.getElementById('historyList').classList.toggle('hidden', expanded);
  }

  function handleKeyboard(event) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      return;
    }
    if (event.key === 'Enter' || event.key.toLowerCase() === 'z') {
      event.preventDefault();
      handleDraw();
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      handleResetHistory();
    }
  }

  function init() {
    state.subscribe((snapshot) => {
      const present = state.getPresentNames();
      handleStateChange(snapshot, present);
      wheel.update(present);
    });

    drawBtn.addEventListener('click', handleDraw);
    stopBtn.addEventListener('click', handleStop);
    resetHistoryBtn.addEventListener('click', handleResetHistory);
    addNamesBtn.addEventListener('click', addNamesFromInput);
    namesListEl.addEventListener('change', handleAbsentToggle);
    jsonImportBtn.addEventListener('click', handleJsonImport);
    jsonFileInput.addEventListener('change', handleJsonFileChange);
    exportJsonBtn.addEventListener('click', handleExport);
    ocrBtn.addEventListener('click', handleOcrImport);
    ocrFileInput.addEventListener('change', handleOcrFileChange);
    spinDuration.addEventListener('change', handleSpinDurationChange);
    motionMode.addEventListener('change', handleMotionModeChange);
    themeMode.addEventListener('change', handleThemeModeChange);
    themeToggle.addEventListener('click', handleThemeToggle);
    classKeyInput.addEventListener('change', handleClassKeyChange);
    historyToggle.addEventListener('click', handleHistoryToggle);

    mediaReduced.addEventListener('change', (event) => {
      currentReduced = event.matches;
    });
    mediaTheme.addEventListener('change', () => {
      const snapshot = state.getState();
      if (snapshot.settings.theme === 'auto') {
        applyTheme('auto');
      }
    });
    window.addEventListener('keydown', handleKeyboard);

    const stored = storage.load(state.getState().classKey);
    if (stored) {
      lastWinnerKey = stored.history.length ? stored.history[0].key : null;
      state.updateFromStorage(stored);
    }

    document.getElementById('year').textContent = new Date().getFullYear();
    applyTheme(state.getState().settings.theme);
    render.highlightList(state.getPresentNames());
    isHydrating = false;
  }

  return {
    init
  };
})();

ui.init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((error) => {
      console.error('SW registrace selhala', error);
    });
  });
}
