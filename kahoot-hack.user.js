// ==UserScript==
// @name         Kahoot Test Helper 3.5 - Hybrid AI
// @version      3.5.1
// @namespace    local.kahoot.test
// @description  Test helper for your own Kahoot quizzes: verified quiz-data answers when available, DOM-text AI fallback when not.
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const NS = 'kth35';
  const BRIDGE_KEY = `${NS}.hostBridge.v1`;
  const BRIDGE_MAX_AGE_MS = 30000;

  const CFG = {
    pollMs: 120,
    answerDelayMin: 650,
    answerDelayMax: 1100,
    multiGapMs: 120,
    submitDelayMs: 180,
    fetchTimeoutMs: 7000,
    questionMatchThreshold: 0.78,
    aiEndpoint: 'http://127.0.0.1:8787/solve',
    aiTimeoutMs: 14000,
  };

  const state = {
    pin: '',
    quizId: '',
    quizTitle: '',
    questions: [],
    source: '',
    currentQuizIndex: -1,
    lastHandledKey: '',
    busy: false,

    showAnswers: localStorage.getItem(`${NS}.showAnswers`) !== '0',
    autoAnswer: localStorage.getItem(`${NS}.autoAnswer`) === '1',
    aiFallback: localStorage.getItem(`${NS}.aiFallback`) !== '0',
    aiAutoAnswer: localStorage.getItem(`${NS}.aiAutoAnswer`) === '1',
    debug: localStorage.getItem(`${NS}.debug`) === '1',

    diagnostics: [],
    aiBusy: false,
    aiLastKey: '',
    aiCache: new Map(),
    aiLastResult: null,
    bridgeActive: false,
  };

  let panel, body, inputEl, quizLabel, questionLabel, statusLabel, debugBox, aiBox;
  let showToggle, autoToggle, aiToggle, aiAutoToggle, debugToggle;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randDelay = () =>
    CFG.answerDelayMin + Math.floor(Math.random() * (CFG.answerDelayMax - CFG.answerDelayMin + 1));

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.diagnostics.push(line);
    if (state.diagnostics.length > 160) state.diagnostics.splice(0, 30);
    console.log('[KTH35]', msg);
    updateDebug();
  }

  function normalize(s) {
    return String(s ?? '')
      .replace(/<[^>]*>/g, ' ')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    a = normalize(a);
    b = normalize(b);
    if (!a) return b.length;
    if (!b) return a.length;

    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let left = i;
      let diag = i - 1;
      for (let j = 1; j <= b.length; j++) {
        const up = prev[j];
        const cur = Math.min(
          up + 1,
          left + 1,
          diag + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        prev[j - 1] = left;
        diag = up;
        left = cur;
      }
      prev[b.length] = left;
    }
    return prev[b.length];
  }

  function similarity(a, b) {
    const x = normalize(a), y = normalize(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.94;

    const maxLen = Math.max(x.length, y.length);
    const lev = maxLen ? 1 - levenshtein(x, y) / maxLen : 0;

    const xs = new Set(x.split(' '));
    const ys = new Set(y.split(' '));
    let inter = 0;
    for (const t of xs) if (ys.has(t)) inter++;
    const union = new Set([...xs, ...ys]).size || 1;
    const jac = inter / union;

    return lev * 0.62 + jac * 0.38;
  }

  function extractUUID(value) {
    const m = String(value ?? '').match(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
    );
    return m ? m[0] : '';
  }

  function extractPin(value) {
    const s = String(value ?? '').trim();

    try {
      const u = new URL(s, location.href);
      const p = u.searchParams.get('pin') || u.searchParams.get('gameId');
      if (p && /^\d{5,10}$/.test(p)) return p;
    } catch {}

    if (/^\d{5,10}$/.test(s)) return s;

    const m = s.match(/(?:pin|game)[^\d]{0,12}(\d{5,10})/i);
    return m ? m[1] : '';
  }

  function resetQuiz(reason = 'session changed') {
    state.quizId = '';
    state.quizTitle = '';
    state.questions = [];
    state.source = '';
    state.currentQuizIndex = -1;
    state.lastHandledKey = '';
    clearHighlights();
    updateQuizLabel();
    log(`Quiz state cleared: ${reason}`);
  }

  function setPin(pin) {
    pin = extractPin(pin);
    if (!pin) return false;

    if (state.pin && state.pin !== pin) {
      resetQuiz(`PIN changed ${state.pin} -> ${pin}`);
      state.aiLastKey = '';
      state.aiCache.clear();
    }

    state.pin = pin;
    sessionStorage.setItem(`${NS}.pin`, pin);
    if (inputEl) inputEl.value = pin;
    return true;
  }

  function deepFindQuizId(obj, depth = 0) {
    if (obj == null || depth > 10) return '';

    if (typeof obj === 'string') return extractUUID(obj);

    if (Array.isArray(obj)) {
      for (const v of obj) {
        const id = deepFindQuizId(v, depth + 1);
        if (id) return id;
      }
      return '';
    }

    if (typeof obj === 'object') {
      for (const k of ['quizId', 'kahootId', 'quizUuid', 'uuid']) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const id = extractUUID(obj[k]);
          if (id) return id;
        }
      }
      for (const v of Object.values(obj)) {
        const id = deepFindQuizId(v, depth + 1);
        if (id) return id;
      }
    }

    return '';
  }

  function deepFindQuestions(obj, depth = 0) {
    if (obj == null || depth > 10) return null;

    if (Array.isArray(obj)) {
      for (const v of obj) {
        const x = deepFindQuestions(v, depth + 1);
        if (x) return x;
      }
      return null;
    }

    if (typeof obj === 'object') {
      if (Array.isArray(obj.questions) && obj.questions.length) {
        const looksLikeQuiz = obj.questions.some(q =>
          q && (Array.isArray(q.choices) || q.question || q.title)
        );

        if (looksLikeQuiz) {
          return {
            title: obj.title || obj.name || 'Untitled',
            quizId: deepFindQuizId(obj),
            questions: obj.questions
          };
        }
      }

      for (const v of Object.values(obj)) {
        const x = deepFindQuestions(v, depth + 1);
        if (x) return x;
      }
    }

    return null;
  }

  function parseQuestions(raw) {
    return (raw || []).map((q, index) => ({
      index,
      type: q.type || q.questionType || 'quiz',
      text: q.question || q.title || q.text || '',
      time: Number(q.time || 20000),
      choices: (q.choices || []).map((c, i) => ({
        index: i,
        text: c.answer ?? c.text ?? c.title ?? '',
        correct: !!c.correct
      }))
    }));
  }

  // ---------- Current-session network capture ----------
  const originalFetch = window.fetch.bind(window);

  async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.fetchTimeoutMs);

    try {
      return await originalFetch(url, {
        ...opts,
        signal: controller.signal,
        credentials: opts.credentials ?? 'include'
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(url, opts = {}) {
    const r = await fetchWithTimeout(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  function acceptQuizPayload(payload, source = 'network') {
    try {
      const found = deepFindQuestions(payload);

      if (!found?.questions?.length) {
        const id = deepFindQuizId(payload);
        if (id) setTimeout(() => loadQuizById(id, source), 0);
        return false;
      }

      const parsed = parseQuestions(found.questions);
      const correctCount = parsed.reduce(
        (n, q) => n + q.choices.filter(c => c.correct).length,
        0
      );

      if (!correctCount) return false;

      const live = readQuestionText();
      if (live) {
        const best = Math.max(...parsed.map(q => similarity(live, q.text)), 0);
        if (best < 0.60) {
          log(`Rejected quiz payload ${source}: live mismatch ${best.toFixed(2)}`);
          return false;
        }
      }

      state.quizId = found.quizId || deepFindQuizId(payload) || state.quizId;
      state.quizTitle = found.title || 'Untitled';
      state.questions = parsed;
      state.source = source;
      state.currentQuizIndex = -1;
      state.lastHandledKey = '';

      updateQuizLabel();
      setStatus(`QUIZ DATA CAPTURED (${source})`, 'ok');
      log(`Accepted quiz: ${state.quizTitle} (${parsed.length} Q)`);
      return true;
    } catch (e) {
      log(`Payload error ${source}: ${e.message}`);
      return false;
    }
  }

  function inspectTextPayload(text, source) {
    if (!text || typeof text !== 'string' || text.length > 2_500_000) return;

    try {
      if (acceptQuizPayload(JSON.parse(text), source)) return;
    } catch {}

    const id = extractUUID(text);
    if (id && id !== state.quizId) {
      setTimeout(() => loadQuizById(id, source), 0);
    }
  }

  window.fetch = async function(...args) {
    const response = await originalFetch(...args);

    try {
      const clone = response.clone();
      const ct = clone.headers.get('content-type') || '';

      if (ct.includes('json')) {
        clone.json().then(d => acceptQuizPayload(d, 'fetch')).catch(() => {});
      } else {
        clone.text().then(t => inspectTextPayload(t, 'fetch-text')).catch(() => {});
      }
    } catch {}

    return response;
  };

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__kth35Url = String(url || '');
    return XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try { inspectTextPayload(this.responseText, 'xhr'); } catch {}
    });
    return XHRSend.apply(this, args);
  };

  const OriginalWS = window.WebSocket;
  window.WebSocket = function(...args) {
    const ws = new OriginalWS(...args);

    ws.addEventListener('message', ev => {
      try {
        if (typeof ev.data === 'string') {
          inspectTextPayload(ev.data, 'websocket');
        } else if (ev.data instanceof Blob) {
          ev.data.text()
            .then(t => inspectTextPayload(t, 'websocket-blob'))
            .catch(() => {});
        }
      } catch {}
    });

    return ws;
  };
  window.WebSocket.prototype = OriginalWS.prototype;

  async function loadQuizById(id, source = 'manual') {
    id = extractUUID(id);
    if (!id) return false;

    if (state.quizId === id && state.questions.length) return true;

    const urls = [
      `https://kahoot.it/rest/kahoots/${id}`,
      `https://play.kahoot.it/rest/kahoots/${id}`,
      `https://create.kahoot.it/rest/kahoots/${id}`,
      `https://kahoot.it/rest/kahoots/${id}/card/?includeKahoot=true`
    ];

    let lastError = '';

    for (const url of urls) {
      try {
        const d = await fetchJson(url);
        const found = deepFindQuestions(d?.questions ? d : (d?.kahoot || d));
        if (!found?.questions?.length) continue;

        const parsed = parseQuestions(found.questions);
        const live = readQuestionText();

        if (live) {
          const best = Math.max(...parsed.map(q => similarity(live, q.text)), 0);
          if (best < 0.60) {
            log(`Rejected quizId ${id}: live mismatch ${best.toFixed(2)}`);
            continue;
          }
        }

        state.quizId = id;
        state.quizTitle = found.title || d.title || 'Untitled';
        state.questions = parsed;
        state.source = source;
        state.currentQuizIndex = -1;
        state.lastHandledKey = '';

        updateQuizLabel();
        setStatus('QUIZ DATA LOADED', 'ok');
        return true;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (!state.questions.length) {
      setStatus(`Verified quiz unavailable: ${lastError || 'not exposed'}`, 'warn');
    }

    return false;
  }

  async function resolvePin(pin) {
    pin = extractPin(pin);

    if (!pin) {
      setStatus('Invalid PIN', 'error');
      return false;
    }

    setPin(pin);
    setStatus(`Resolving PIN ${pin}…`, 'muted');
    log(`Resolve PIN ${pin}`);

    for (const url of [
      'https://kahoot.it/reserve/session/',
      'https://play.kahoot.it/reserve/session/'
    ]) {
      try {
        const d = await fetchJson(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ game: pin })
        });

        if (acceptQuizPayload(d, 'pin-post')) return true;

        const id = deepFindQuizId(d);
        if (id && await loadQuizById(id, 'pin-post')) return true;
      } catch (e) {
        log(`PIN POST failed: ${e.message}`);
      }
    }

    setStatus(
      state.aiFallback
        ? `PIN ${pin}: verified data unavailable — AI fallback ready`
        : `PIN ${pin}: waiting for current game traffic`,
      'warn'
    );

    return false;
  }

  function scanCurrentPage() {
    const urlId = extractUUID(location.href);
    if (urlId) {
      loadQuizById(urlId, 'current-url');
      return true;
    }

    for (const el of document.querySelectorAll('script,meta')) {
      const text = el.textContent || el.getAttribute?.('content') || '';
      if (!text) continue;

      try {
        if (acceptQuizPayload(JSON.parse(text), 'page-json')) return true;
      } catch {}

      const id = extractUUID(text);
      if (id) {
        loadQuizById(id, 'page-scan');
        return true;
      }
    }

    return false;
  }

  // ---------- Live DOM ----------
  function readQuestionText() {
    const selectors = [
      '[data-functional-selector="block-title"]',
      '[data-functional-selector="question-title"]',
      '[data-functional-selector="question-text"]',
      '[data-testid*="question-title"]',
      '[data-testid*="question-text"]',
      '[class*="question-title" i]',
      '[class*="question-text" i]',
      '[class*="block-title" i]',
      'main h1', 'main h2', 'main h3',
      'h1', 'h2'
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('#kth35-panel') || el.offsetParent === null) continue;

        const t = el.textContent?.trim();
        if (!t || t.length < 3 || t.length > 1200) continue;

        const nt = normalize(t);
        if (/^(kahoot|question|submit|next|answer|quiz|true or false|puzzle|type answer|poll)$/i.test(nt)) continue;

        return t;
      }
    }

    return '';
  }

  function buttonText(btn) {
    return (
      btn.getAttribute('aria-label') ||
      btn.innerText ||
      btn.textContent ||
      ''
    ).trim();
  }

  function getAnswerButtons() {
    const selectors = [
      'button[data-functional-selector^="answer-"]',
      '[data-functional-selector^="answer-"][role="button"]',
      'button[data-functional-selector^="multi-select-button-"]',
      '[data-functional-selector^="multi-select-button-"][role="button"]',
      '[data-testid^="answer-"]',
      '[data-testid*="choice"]',
      '[class*="answer" i] button',
      '[class*="choice" i] button'
    ];

    const out = [];
    const seen = new Set();

    for (const sel of selectors) {
      for (const b of document.querySelectorAll(sel)) {
        if (b.closest('#kth35-panel')) continue;
        if (seen.has(b) || b.offsetParent === null || b.offsetWidth < 30 || b.offsetHeight < 22) continue;
        seen.add(b);
        out.push(b);
      }
    }

    return out;
  }

  function getTextInput() {
    const sels = [
      'input[data-functional-selector="text-answer-input"]',
      'textarea[data-functional-selector="text-answer-input"]',
      'input[placeholder*="answer" i]',
      'textarea[placeholder*="answer" i]',
      'main input[type="text"]',
      'main textarea'
    ];

    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('#kth35-panel') || el.offsetParent === null) continue;
        return el;
      }
    }

    return null;
  }

  function getPuzzleTiles() {
    const sels = [
      '[data-functional-selector^="jumble-answer-"]',
      '[data-functional-selector^="jumble-"]',
      '[data-testid*="jumble"]',
      '[data-testid*="puzzle"]',
      '[draggable="true"]',
      '[class*="sortable" i] [role="button"]',
      '[class*="puzzle" i] [role="button"]',
      '[class*="jumble" i] [role="button"]'
    ];

    const out = [];
    const seen = new Set();

    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('#kth35-panel')) continue;
        if (seen.has(el) || el.offsetParent === null || el.offsetWidth < 70 || el.offsetHeight < 25) continue;

        const text = buttonText(el);
        if (!text) continue;

        seen.add(el);
        out.push(el);
      }
    }

    return out;
  }

  function getQuestionIndex() {
    for (const sel of [
      '[data-functional-selector="question-index-counter"]',
      '[data-functional-selector="question-index"]',
      '[data-testid*="question-number"]',
      '[data-testid*="question-index"]',
      '[class*="question-index" i]',
      '[class*="question-count" i]',
      '[class*="progress-counter" i]'
    ]) {
      const el = document.querySelector(sel);
      if (!el || el.closest('#kth35-panel')) continue;

      const m = el.textContent?.match(/\d+/);
      if (m) return Math.max(0, parseInt(m[0], 10) - 1);
    }

    return -1;
  }

  function detectQuestionType() {
    const bodyText = normalize(
      [...document.querySelectorAll('body *')]
        .filter(el => el.offsetParent !== null && !el.closest('#kth35-panel'))
        .slice(0, 700)
        .map(el => el.textContent || '')
        .join(' ')
    );

    const tiles = getPuzzleTiles();
    const input = getTextInput();
    const answerButtons = getAnswerButtons();

    if (/\bpoll\b/.test(bodyText)) return 'poll';
    if (/\bpuzzle\b/.test(bodyText) || tiles.length >= 3) return 'puzzle';
    if (/\btype answer\b|\bopen ended\b/.test(bodyText) || input) return 'open_ended';
    if (/\btrue or false\b/.test(bodyText) || (
      answerButtons.length === 2 &&
      answerButtons.some(b => normalize(buttonText(b)) === 'true') &&
      answerButtons.some(b => normalize(buttonText(b)) === 'false')
    )) return 'true_false';

    if (
      document.querySelector('[data-functional-selector^="multi-select-button-"]') ||
      document.querySelector('button[data-functional-selector="multi-select-submit-button"]')
    ) return 'multiple_select_quiz';

    if (answerButtons.length) return 'quiz';
    return 'unknown';
  }

  function matchCurrentQuestion() {
    if (!state.questions.length) return null;

    const live = readQuestionText();
    if (!live) return null;

    let best = { score: 0, q: null };

    for (const q of state.questions) {
      const s = similarity(live, q.text);
      if (s > best.score) best = { score: s, q };
    }

    if (best.q && best.score >= CFG.questionMatchThreshold) {
      return {
        q: best.q,
        confidence: best.score >= 0.96 ? 'exact' : 'text',
        score: best.score
      };
    }

    return null;
  }

  function mapCorrectButtons(question) {
    const buttons = getAnswerButtons();
    if (!question?.choices?.length || !buttons.length) return [];

    const correct = question.choices.filter(c => c.correct);
    if (!correct.length) return [];

    const live = buttons.map((btn, i) => ({
      btn,
      i,
      text: normalize(buttonText(btn)),
      fs: btn.getAttribute('data-functional-selector') || ''
    }));

    const mapped = [];
    const used = new Set();

    for (const c of correct) {
      const ct = normalize(c.text);
      let found = null;

      if (ct) {
        found = live.find(x => !used.has(x.i) && x.text === ct);

        if (!found) {
          const scored = live
            .filter(x => !used.has(x.i) && x.text)
            .map(x => ({ ...x, score: similarity(ct, x.text) }))
            .sort((a, b) => b.score - a.score);

          if (
            scored[0]?.score >= 0.88 &&
            (!scored[1] || scored[0].score - scored[1].score >= 0.08)
          ) {
            found = scored[0];
          }
        }
      }

      if (!found) {
        const names = [`answer-${c.index}`, `multi-select-button-${c.index}`];
        found = live.find(x => !used.has(x.i) && names.includes(x.fs));
      }

      if (!found) return [];

      used.add(found.i);
      mapped.push(found.btn);
    }

    return mapped.length === correct.length ? mapped : [];
  }

  function clearHighlights() {
    document.querySelectorAll('[data-kth35-highlight="1"]').forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('box-shadow');
      el.removeAttribute('data-kth35-highlight');
    });

    document.getElementById('kth35-puzzle-order')?.remove();
  }

  function highlightButtons(buttons) {
    clearHighlights();

    for (const btn of buttons) {
      btn.dataset.kth35Highlight = '1';
      btn.style.setProperty('outline', '4px solid #45ff9a', 'important');
      btn.style.setProperty('outline-offset', '-4px', 'important');
      btn.style.setProperty('box-shadow', '0 0 24px rgba(69,255,154,.78)', 'important');
    }
  }

  function showPuzzleOrder(order) {
    document.getElementById('kth35-puzzle-order')?.remove();

    if (!Array.isArray(order) || !order.length) return false;

    const box = document.createElement('div');
    box.id = 'kth35-puzzle-order';
    box.textContent = `ORDER: ${order.join('  →  ')}`;

    Object.assign(box.style, {
      position: 'fixed',
      left: '50%',
      bottom: '18px',
      transform: 'translateX(-50%)',
      zIndex: '2147483646',
      maxWidth: '88vw',
      padding: '10px 16px',
      borderRadius: '10px',
      background: 'rgba(8,70,45,.95)',
      color: '#fff',
      fontWeight: '700',
      fontFamily: 'Inter,system-ui,sans-serif',
      boxShadow: '0 0 18px rgba(69,255,154,.45)',
      pointerEvents: 'none'
    });

    document.body.appendChild(box);
    return true;
  }

  function showVerified(question) {
    clearHighlights();

    if (['jumble', 'puzzle', 'ordering'].includes(question.type)) {
      return showPuzzleOrder(question.choices.map(c => c.text).filter(Boolean)) ? 1 : 0;
    }

    if (['open_ended', 'word_cloud', 'brainstorm'].includes(question.type)) {
      const answer =
        question.choices.find(c => c.correct)?.text ||
        question.choices[0]?.text ||
        '';

      if (answer) {
        setAIBox(`Verified text: ${answer}`, 'ok');
        return 1;
      }

      return 0;
    }

    const buttons = mapCorrectButtons(question);
    highlightButtons(buttons);
    return buttons.length;
  }

  function clickElement(el) {
    if (!el || el.disabled || el.offsetParent === null) return false;

    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}

    try {
      el.click();
      return true;
    } catch {}

    try {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      }));
      return true;
    } catch {
      return false;
    }
  }

  function setReactInput(el, value) {
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (setter) setter.call(el, value);
      else el.value = value;
    } catch {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSubmitButton() {
    const selectors = [
      'button[data-functional-selector="multi-select-submit-button"]',
      'button[data-functional-selector="submit-answer"]',
      'button[data-functional-selector="submit-button"]',
      'button[data-functional-selector*="submit"]',
      'button[data-testid*="submit"]',
      'button[data-testid*="confirm"]',
      'main button[type="submit"]',
      'form button[type="submit"]'
    ];

    for (const sel of selectors) {
      for (const b of document.querySelectorAll(sel)) {
        if (b.closest('#kth35-panel') || b.offsetParent === null || b.disabled) continue;
        return b;
      }
    }

    const words = [
      'submit', 'confirm', 'done', 'send', 'answer',
      'tasdiq', 'tasdiqlash', 'yuborish',
      'готово', 'отправить'
    ];

    for (const b of document.querySelectorAll('button')) {
      if (b.closest('#kth35-panel') || b.offsetParent === null || b.disabled) continue;
      const t = normalize(buttonText(b));
      if (words.some(w => t === normalize(w) || t.includes(normalize(w)))) return b;
    }

    return null;
  }

  async function waitSubmitButton(maxMs = 1800) {
    const start = performance.now();

    while (performance.now() - start < maxMs) {
      const b = findSubmitButton();
      if (b) return b;
      await sleep(100);
    }

    return null;
  }

  async function dragTile(from, to) {
    if (!from || !to || from === to) return true;

    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.left + a.width / 2;
    const y1 = a.top + a.height / 2;
    const x2 = b.left + b.width / 2;
    const y2 = b.top + b.height / 2;

    try {
      from.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true,
        pointerId: 9, pointerType: 'mouse',
        clientX: x1, clientY: y1, buttons: 1
      }));

      await sleep(70);

      for (let i = 1; i <= 7; i++) {
        const x = x1 + (x2 - x1) * (i / 7);
        const y = y1 + (y2 - y1) * (i / 7);

        (document.elementFromPoint(x, y) || from).dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true, cancelable: true,
            pointerId: 9, pointerType: 'mouse',
            clientX: x, clientY: y, buttons: 1
          })
        );

        await sleep(25);
      }

      (document.elementFromPoint(x2, y2) || to).dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true, cancelable: true,
          pointerId: 9, pointerType: 'mouse',
          clientX: x2, clientY: y2, buttons: 0
        })
      );

      await sleep(120);
      return true;
    } catch {
      return false;
    }
  }

  async function answerPuzzleOrder(order) {
    if (!Array.isArray(order) || !order.length) return false;

    let tiles = getPuzzleTiles();
    if (tiles.length < order.length) return false;

    const desired = order.map(normalize);

    for (let target = 0; target < desired.length; target++) {
      tiles = getPuzzleTiles();
      const current = tiles.map(x => normalize(buttonText(x)));

      if (current[target] === desired[target]) continue;

      const sourceIndex = current.findIndex(
        (text, i) => i > target && similarity(text, desired[target]) >= 0.90
      );

      if (sourceIndex < 0) return false;

      if (!await dragTile(tiles[sourceIndex], tiles[target])) return false;
      await sleep(130);
    }

    const submit = await waitSubmitButton(1200);
    if (submit) clickElement(submit);

    return true;
  }

  async function answerVerified(question) {
    const wait = randDelay();
    setStatus(`Verified answer — ${wait}ms`, 'ok');
    await sleep(wait);

    if (['open_ended', 'word_cloud', 'brainstorm'].includes(question.type)) {
      const answer =
        question.choices.find(c => c.correct)?.text ||
        question.choices[0]?.text ||
        '';

      const input = getTextInput();
      if (!answer || !input) return false;

      setReactInput(input, answer);
      await sleep(120);

      const submit = await waitSubmitButton(1200);
      if (submit) clickElement(submit);

      return true;
    }

    if (['jumble', 'puzzle', 'ordering'].includes(question.type)) {
      const order = question.choices.map(c => c.text).filter(Boolean);
      showPuzzleOrder(order);
      return await answerPuzzleOrder(order);
    }

    const buttons = mapCorrectButtons(question);
    const correct = question.choices.filter(c => c.correct);

    if (!buttons.length || buttons.length !== correct.length) return false;

    const isMulti =
      question.type === 'multiple_select_quiz' ||
      correct.length > 1 ||
      !!document.querySelector('[data-functional-selector^="multi-select-button-"]');

    for (let i = 0; i < buttons.length; i++) {
      if (i) await sleep(CFG.multiGapMs);
      if (!clickElement(buttons[i])) return false;
    }

    if (isMulti) {
      await sleep(CFG.submitDelayMs);
      const submit = await waitSubmitButton(1800);
      if (!submit) return false;
      return clickElement(submit);
    }

    return true;
  }

  // ---------- AI fallback ----------
  function collectVisiblePageText() {
    const root = document.querySelector('main') || document.body;
    if (!root) return '';

    const clone = root.cloneNode(true);

    clone.querySelectorAll(
      '#kth35-panel,script,style,noscript,svg,canvas,video,audio'
    ).forEach(el => el.remove());

    return String(clone.innerText || clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4500);
  }

  function readHostBridge() {
    try {
      const data = GM_getValue(BRIDGE_KEY, null);
      if (!data || typeof data !== 'object') return null;
      if (!data.ts || Date.now() - data.ts > BRIDGE_MAX_AGE_MS) return null;
      if (state.pin && data.pin && state.pin !== data.pin) return null;
      return data;
    } catch {
      return null;
    }
  }

  function detectHostPin(pageText = '') {
    for (const source of [document.title, location.href, pageText]) {
      const m = String(source || '').match(/(?:game\s*pin|pin)\D{0,20}(\d{5,10})/i);
      if (m) return m[1];
    }
    return '';
  }

  function publishHostBridge() {
    if (location.hostname !== 'play.kahoot.it') return;

    const question = readQuestionText();
    const questionType = detectQuestionType();
    const pageText = collectVisiblePageText();

    const choices = getAnswerButtons()
      .map((btn, index) => ({
        index,
        text: buttonText(btn).replace(/\s+/g, ' ').trim()
      }))
      .filter(x => x.text);

    const puzzleTiles = getPuzzleTiles()
      .map((el, index) => ({
        index,
        text: buttonText(el).replace(/\s+/g, ' ').trim()
      }))
      .filter(x => x.text);

    const isQuestion = !!question && (
      choices.length >= 2 ||
      puzzleTiles.length >= 2 ||
      questionType === 'open_ended' ||
      questionType === 'true_false' ||
      questionType === 'multiple_select_quiz'
    );

    if (!isQuestion) return;

    let previous = null;
    try { previous = GM_getValue(BRIDGE_KEY, null); } catch {}

    const pin = detectHostPin(pageText) || previous?.pin || state.pin || '';

    try {
      GM_setValue(BRIDGE_KEY, {
        ts: Date.now(),
        pin,
        question_type: questionType,
        question,
        choices,
        puzzle_tiles: puzzleTiles,
        page_text: pageText,
        question_number: getQuestionIndex() >= 0 ? getQuestionIndex() + 1 : null
      });
    } catch (e) {
      log(`Host bridge write failed: ${e.message}`);
    }
  }

  function buildAIPayload() {
    let questionType = detectQuestionType();
    let question = readQuestionText();

    let choices = getAnswerButtons()
      .map((btn, index) => ({
        index,
        text: buttonText(btn).replace(/\s+/g, ' ').trim()
      }))
      .filter(x => x.text);

    let puzzleTiles = getPuzzleTiles()
      .map((el, index) => ({
        index,
        text: buttonText(el).replace(/\s+/g, ' ').trim()
      }))
      .filter(x => x.text);

    const localPageText = collectVisiblePageText();
    const bridge = readHostBridge();
    state.bridgeActive = false;

    if (bridge && (!question || choices.length === 0 || questionType === 'unknown')) {
      if (!question && bridge.question) question = bridge.question;
      if ((!choices.length || !readQuestionText()) && Array.isArray(bridge.choices) && bridge.choices.length) {
        choices = bridge.choices.map((x, index) => ({
          index,
          text: String(x?.text || '').trim()
        })).filter(x => x.text);
      }
      if (!puzzleTiles.length && Array.isArray(bridge.puzzle_tiles) && bridge.puzzle_tiles.length) {
        puzzleTiles = bridge.puzzle_tiles.map((x, index) => ({
          index,
          text: String(x?.text || '').trim()
        })).filter(x => x.text);
      }
      if ((questionType === 'unknown' || !readQuestionText()) && bridge.question_type) {
        questionType = bridge.question_type;
      }
      if (!state.pin && bridge.pin) setPin(bridge.pin);
      state.bridgeActive = !!bridge.question;
    }

    const pageText = state.bridgeActive && bridge
      ? `HOST DOM: ${bridge.page_text || ''} PLAYER DOM: ${localPageText}`.slice(0, 4500)
      : localPageText;

    if (state.bridgeActive) {
      setStatus('Using HOST DOM bridge for AI', 'ok');
    }

    return {
      question_type: questionType,
      question,
      choices,
      puzzle_tiles: puzzleTiles,
      page_text: pageText,
      question_number: bridge?.question_number || (getQuestionIndex() >= 0 ? getQuestionIndex() + 1 : null),
      pin: state.pin || bridge?.pin || null
    };
  }

  function aiKey(payload) {
    return JSON.stringify({
      type: payload.question_type,
      question: normalize(payload.question),
      choices: payload.choices.map(x => normalize(x.text)),
      puzzle: payload.puzzle_tiles.map(x => normalize(x.text))
    });
  }

  function requestAI(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CFG.aiEndpoint,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: CFG.aiTimeoutMs,

        onload: response => {
          let data = null;

          try {
            data = JSON.parse(response.responseText || '{}');
          } catch (e) {
            reject(new Error(`Invalid local AI response: ${e.message}`));
            return;
          }

          if (response.status < 200 || response.status >= 300) {
            reject(new Error(data.error || `AI HTTP ${response.status}`));
            return;
          }

          resolve(data);
        },

        ontimeout: () => reject(new Error('AI timeout')),
        onerror: () => reject(new Error('AI server not reachable at 127.0.0.1:8787'))
      });
    });
  }

  function setAIBox(value, kind = 'idle') {
    if (!aiBox) return;

    aiBox.dataset.kind = kind;

    if (typeof value === 'string') {
      aiBox.textContent = `AI: ${value}`;
      return;
    }

    if (!value) {
      aiBox.textContent = 'AI: waiting';
      return;
    }

    const conf = value.confidence || 'unknown';
    let text = '';

    if (value.action === 'choice') {
      const labels = (value.answer_indices || [])
        .map(i => `${String.fromCharCode(65 + i)}${value.answer_texts?.[i] ? ` (${value.answer_texts[i]})` : ''}`)
        .join(', ');

      text = labels || 'no choice';
    } else if (value.action === 'text') {
      text = value.text_answer || 'no text';
    } else if (value.action === 'puzzle') {
      text = (value.puzzle_order || []).join(' → ') || 'no order';
    } else if (value.action === 'poll') {
      text = 'Poll — no objectively correct answer';
    } else {
      text = value.message || 'No confident answer';
    }

    aiBox.textContent =
      `${state.bridgeActive ? 'AI [HOST DOM]' : 'AI'} [${conf}]: ${text}` +
      (value.explanation ? ` — ${value.explanation}` : '');
  }

  function mapAIChoiceButtons(result) {
    const buttons = getAnswerButtons();
    const indices = Array.isArray(result.answer_indices)
      ? [...new Set(result.answer_indices.filter(Number.isInteger))]
      : [];

    if (!indices.length) return [];

    const mapped = [];
    for (const i of indices) {
      if (i < 0 || i >= buttons.length) return [];
      mapped.push(buttons[i]);
    }

    return mapped;
  }

  async function autoApplyAI(result) {
    if (!state.aiAutoAnswer || !state.autoAnswer) return false;
    if (result.confidence !== 'high') return false;

    const wait = randDelay();
    setStatus(`AI high-confidence — answering in ${wait}ms`, 'ok');
    await sleep(wait);

    if (result.action === 'poll' || result.action === 'none') return false;

    if (result.action === 'choice') {
      const buttons = mapAIChoiceButtons(result);
      if (!buttons.length) return false;

      highlightButtons(buttons);

      for (let i = 0; i < buttons.length; i++) {
        if (i) await sleep(CFG.multiGapMs);
        if (!clickElement(buttons[i])) return false;
      }

      const isMulti =
        buttons.length > 1 ||
        detectQuestionType() === 'multiple_select_quiz' ||
        !!document.querySelector('[data-functional-selector^="multi-select-button-"]');

      if (isMulti) {
        await sleep(CFG.submitDelayMs);
        const submit = await waitSubmitButton(1800);
        if (!submit) {
          setStatus('AI MULTI: choices selected, submit not found', 'warn');
          return false;
        }
        return clickElement(submit);
      }

      return true;
    }

    if (result.action === 'text') {
      const input = getTextInput();
      if (!input || !result.text_answer) return false;

      setReactInput(input, result.text_answer);
      await sleep(120);

      const submit = await waitSubmitButton(1200);
      if (submit) clickElement(submit);

      return true;
    }

    if (result.action === 'puzzle') {
      const order = Array.isArray(result.puzzle_order) ? result.puzzle_order : [];
      if (!order.length) return false;

      showPuzzleOrder(order);
      const ok = await answerPuzzleOrder(order);

      if (!ok) {
        setStatus('AI puzzle order shown; automatic drag failed', 'warn');
      }

      return ok;
    }

    return false;
  }

  async function askAI(force = false) {
    if (!state.aiFallback || state.aiBusy) return false;

    const payload = buildAIPayload();

    if (!payload.question && !payload.page_text) return false;

    const key = aiKey(payload);

    if (!force && state.aiLastKey === key && state.aiLastResult) {
      return true;
    }

    if (!force && state.aiCache.has(key)) {
      const cached = state.aiCache.get(key);
      state.aiLastKey = key;
      state.aiLastResult = cached;
      setAIBox(cached, cached.confidence === 'low' ? 'warn' : 'ok');
      return true;
    }

    if (payload.question_type === 'poll') {
      const result = {
        action: 'poll',
        confidence: 'high',
        answer_indices: [],
        answer_texts: [],
        text_answer: '',
        puzzle_order: [],
        explanation: 'Poll questions do not have an objectively correct answer.'
      };

      state.aiLastKey = key;
      state.aiLastResult = result;
      state.aiCache.set(key, result);
      setAIBox(result, 'ok');
      return true;
    }

    state.aiBusy = true;
    setAIBox('thinking…', 'busy');

    try {
      const result = await requestAI(payload);
      state.aiLastKey = key;
      state.aiLastResult = result;
      state.aiCache.set(key, result);

      setAIBox(result, result.confidence === 'low' ? 'warn' : 'ok');
      log(`AI ${result.action} confidence=${result.confidence}`);

      if (
        state.showAnswers &&
        result.action === 'choice' &&
        result.confidence !== 'low'
      ) {
        const buttons = mapAIChoiceButtons(result);
        if (buttons.length) highlightButtons(buttons);
      }

      if (
        state.showAnswers &&
        result.action === 'puzzle' &&
        result.confidence !== 'low'
      ) {
        showPuzzleOrder(result.puzzle_order || []);
      }

      await autoApplyAI(result);
      return true;
    } catch (e) {
      state.aiLastResult = null;
      setAIBox(e.message, 'error');
      log(`AI error: ${e.message}`);
      return false;
    } finally {
      state.aiBusy = false;
    }
  }

  // ---------- Main loop ----------
  function hasInteractable() {
    return (
      getAnswerButtons().length > 0 ||
      !!getTextInput() ||
      getPuzzleTiles().length > 1
    );
  }

  async function handleCurrentQuestion() {
    if (state.busy || !hasInteractable()) return;

    state.busy = true;

    try {
      const detectedType = detectQuestionType();

      if (detectedType === 'poll') {
        clearHighlights();
        setStatus('POLL: no verified correct answer', 'muted');
        if (state.aiFallback) await askAI(false);
        return;
      }

      const matched = matchCurrentQuestion();

      if (matched) {
        const q = matched.q;

        const key = [
          'verified',
          q.index,
          normalize(readQuestionText()),
          q.type,
          getAnswerButtons().length,
          !!getTextInput(),
          getPuzzleTiles().length
        ].join(':');

        if (state.lastHandledKey === key) return;

        state.currentQuizIndex = q.index;
        updateQuestionLabel();

        if (state.showAnswers) {
          const count = showVerified(q);
          setStatus(
            count
              ? `Q${q.index + 1}: VERIFIED [${matched.score.toFixed(2)}]`
              : `Q${q.index + 1}: verified question, mapping failed`,
            count ? 'ok' : 'warn'
          );
        }

        if (state.autoAnswer) {
          const ok = await answerVerified(q);
          if (!ok && state.aiFallback) {
            setStatus('Verified auto-answer failed — trying AI fallback', 'warn');
            await askAI(true);
          }
        }

        state.lastHandledKey = key;
        return;
      }

      // No verified data or no reliable match: use AI from live DOM text.
      clearHighlights();

      if (state.aiFallback) {
        setStatus(
          state.questions.length
            ? 'No verified match — AI fallback'
            : 'No quiz data — AI fallback',
          'warn'
        );
        await askAI(false);
      } else {
        setStatus('No verified match and AI fallback is OFF', 'warn');
      }
    } finally {
      state.busy = false;
    }
  }

  // ---------- UI ----------
  function setStatus(text, kind = 'muted') {
    if (!statusLabel) return;
    statusLabel.textContent = text;
    statusLabel.dataset.kind = kind;
  }

  function updateQuizLabel() {
    if (!quizLabel) return;

    quizLabel.textContent = state.questions.length
      ? `Quiz: ${state.quizTitle} (${state.questions.length} Q) • ${state.source}`
      : 'Quiz: not loaded — AI fallback can still work';

    updateQuestionLabel();
  }

  function updateQuestionLabel() {
    if (!questionLabel) return;

    questionLabel.textContent = state.currentQuizIndex >= 0
      ? `Question: ${state.currentQuizIndex + 1}/${state.questions.length}`
      : `Question: -/${state.questions.length || 0}`;
  }

  function updateDebug() {
    if (!debugBox) return;
    debugBox.textContent = state.diagnostics.slice(-14).join('\n');
    debugBox.scrollTop = debugBox.scrollHeight;
  }

  function buildUI() {
    if (document.getElementById('kth35-panel')) return;

    panel = document.createElement('div');
    panel.id = 'kth35-panel';

    panel.innerHTML = `
      <div class="kth-head">
        <strong>Kahoot Test 3.5.1 Hybrid + Host</strong>
        <button id="kth-min">−</button>
      </div>

      <div id="kth-body">
        <input id="kth-input" placeholder="Current Game PIN / Quiz URL / Quiz ID">

        <div class="kth-buttons">
          <button id="kth-resolve">Resolve</button>
          <button id="kth-scan">Scan current</button>
        </div>

        <div class="kth-row">
          <span>Show answers</span>
          <input id="kth-show" type="checkbox">
        </div>

        <div class="kth-row">
          <span>Auto answer</span>
          <input id="kth-auto" type="checkbox">
        </div>

        <div class="kth-row">
          <span>AI fallback (DOM text)</span>
          <input id="kth-ai" type="checkbox">
        </div>

        <div class="kth-row">
          <span>AI auto-answer (HIGH only)</span>
          <input id="kth-ai-auto" type="checkbox">
        </div>

        <button id="kth-ask-ai">Ask AI now</button>

        <div class="kth-row">
          <span>Debug</span>
          <input id="kth-debug-toggle" type="checkbox">
        </div>

        <div id="kth-quiz">Quiz: not loaded</div>
        <div id="kth-question">Question: -</div>
        <div id="kth-status">Ready</div>
        <div id="kth-ai-box">AI: waiting</div>
        <pre id="kth-debug"></pre>
      </div>
    `;

    const style = document.createElement('style');

    style.textContent = `
      #kth35-panel{
        position:fixed;top:18px;right:18px;width:380px;z-index:2147483647;
        background:rgba(12,10,25,.97);color:#f4f1ff;border:1px solid #765cff;
        border-radius:14px;box-shadow:0 0 28px rgba(118,92,255,.42);
        font-family:Inter,system-ui,Arial,sans-serif;overflow:hidden
      }

      #kth35-panel .kth-head{
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 14px;background:linear-gradient(90deg,#291a59,#171126)
      }

      #kth35-panel button,#kth35-panel input{font:inherit}

      #kth-min{
        width:30px;height:28px;border:0;border-radius:8px;
        background:#30264e;color:#fff;cursor:pointer
      }

      #kth-body{padding:12px;display:grid;gap:8px}

      #kth-input{
        width:100%;box-sizing:border-box;padding:10px;border-radius:9px;
        border:1px solid #57498c;color:#fff;background:#0f0c19;outline:none
      }

      .kth-buttons{
        display:grid;grid-template-columns:1fr 1fr;gap:7px
      }

      #kth-resolve,#kth-scan,#kth-ask-ai{
        padding:9px;border:0;border-radius:9px;background:#7258ff;
        color:#fff;font-weight:700;cursor:pointer
      }

      #kth-scan{background:#3d315f}
      #kth-ask-ai{background:#176b55}

      .kth-row{
        display:flex;justify-content:space-between;align-items:center;padding:3px 1px
      }

      #kth-quiz,#kth-question,#kth-status,#kth-ai-box{
        padding:8px 9px;border-radius:8px;background:rgba(255,255,255,.055);
        font-size:13px;line-height:1.35
      }

      #kth-status[data-kind="ok"],#kth-ai-box[data-kind="ok"]{color:#66ffaf}
      #kth-status[data-kind="warn"],#kth-ai-box[data-kind="warn"]{color:#ffd66b}
      #kth-status[data-kind="error"],#kth-ai-box[data-kind="error"]{color:#ff7c91}
      #kth-status[data-kind="muted"]{color:#aaa4bc}
      #kth-ai-box[data-kind="busy"]{color:#beb5ff}

      #kth-debug{
        display:none;white-space:pre-wrap;max-height:160px;overflow:auto;
        margin:0;padding:8px;border-radius:8px;background:#090711;
        color:#bcb3d7;font-size:11px;line-height:1.35
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    body = document.getElementById('kth-body');
    inputEl = document.getElementById('kth-input');
    quizLabel = document.getElementById('kth-quiz');
    questionLabel = document.getElementById('kth-question');
    statusLabel = document.getElementById('kth-status');
    aiBox = document.getElementById('kth-ai-box');
    debugBox = document.getElementById('kth-debug');

    showToggle = document.getElementById('kth-show');
    autoToggle = document.getElementById('kth-auto');
    aiToggle = document.getElementById('kth-ai');
    aiAutoToggle = document.getElementById('kth-ai-auto');
    debugToggle = document.getElementById('kth-debug-toggle');

    showToggle.checked = state.showAnswers;
    autoToggle.checked = state.autoAnswer;
    aiToggle.checked = state.aiFallback;
    aiAutoToggle.checked = state.aiAutoAnswer;
    debugToggle.checked = state.debug;
    debugBox.style.display = state.debug ? 'block' : 'none';

    document.getElementById('kth-min').addEventListener('click', e => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'grid' : 'none';
      e.currentTarget.textContent = hidden ? '−' : '+';
    });

    document.getElementById('kth-resolve').addEventListener('click', async () => {
      const v = inputEl.value.trim();
      const pin = extractPin(v);
      const id = extractUUID(v);

      if (pin) {
        await resolvePin(pin);
      } else if (id) {
        resetQuiz('manual quiz URL/ID');
        await loadQuizById(id, 'manual');
      } else {
        setStatus('Enter current PIN, Quiz URL, or Quiz ID', 'error');
      }
    });

    document.getElementById('kth-scan').addEventListener('click', () => {
      scanCurrentPage();
      if (state.pin) resolvePin(state.pin);
      state.aiLastKey = '';

      setStatus(
        state.aiFallback
          ? 'Scanning current session + AI fallback ready'
          : 'Scanning current session',
        'muted'
      );
    });

    document.getElementById('kth-ask-ai').addEventListener('click', () => {
      state.aiLastKey = '';
      askAI(true);
    });

    showToggle.addEventListener('change', e => {
      state.showAnswers = e.target.checked;
      localStorage.setItem(`${NS}.showAnswers`, state.showAnswers ? '1' : '0');
      state.lastHandledKey = '';

      if (!state.showAnswers) clearHighlights();
    });

    autoToggle.addEventListener('change', e => {
      state.autoAnswer = e.target.checked;
      localStorage.setItem(`${NS}.autoAnswer`, state.autoAnswer ? '1' : '0');
      state.lastHandledKey = '';

      setStatus(
        state.autoAnswer ? 'AutoAnswer ON' : 'AutoAnswer OFF',
        'muted'
      );
    });

    aiToggle.addEventListener('change', e => {
      state.aiFallback = e.target.checked;
      localStorage.setItem(`${NS}.aiFallback`, state.aiFallback ? '1' : '0');
      state.aiLastKey = '';

      setAIBox(
        state.aiFallback ? 'fallback enabled' : 'fallback disabled',
        'idle'
      );

      if (state.aiFallback) askAI(true);
    });

    aiAutoToggle.addEventListener('change', e => {
      state.aiAutoAnswer = e.target.checked;
      localStorage.setItem(`${NS}.aiAutoAnswer`, state.aiAutoAnswer ? '1' : '0');

      setStatus(
        state.aiAutoAnswer
          ? 'AI auto-answer enabled for HIGH confidence only'
          : 'AI auto-answer disabled',
        'muted'
      );
    });

    debugToggle.addEventListener('change', e => {
      state.debug = e.target.checked;
      localStorage.setItem(`${NS}.debug`, state.debug ? '1' : '0');
      debugBox.style.display = state.debug ? 'block' : 'none';
      updateDebug();
    });

    const urlPin = extractPin(location.href);
    const sessionPin = sessionStorage.getItem(`${NS}.pin`);

    if (urlPin) setPin(urlPin);
    else if (sessionPin) setPin(sessionPin);

    updateQuizLabel();

    setStatus(
      state.aiFallback
        ? 'Ready — verified + AI fallback'
        : 'Ready — verified mode only',
      'muted'
    );

    setTimeout(() => {
      scanCurrentPage();
      if (state.pin) resolvePin(state.pin);
    }, 300);
  }

  function start() {
    const go = () => {
      if (!document.head || !document.body) {
        setTimeout(go, 50);
        return;
      }

      buildUI();

      const obs = new MutationObserver(() => {
        clearTimeout(obs.__t);
        obs.__t = setTimeout(handleCurrentQuestion, 70);
      });

      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });

      setInterval(handleCurrentQuestion, CFG.pollMs);

      if (location.hostname === 'play.kahoot.it') {
        setInterval(publishHostBridge, 250);
        setTimeout(publishHostBridge, 500);
      }

      try {
        GM_addValueChangeListener(BRIDGE_KEY, () => {
          state.aiLastKey = '';
          state.lastHandledKey = '';
          setTimeout(handleCurrentQuestion, 30);
        });
      } catch {}

      window.addEventListener('popstate', () => {
        state.lastHandledKey = '';
        state.aiLastKey = '';
      });

      window.addEventListener('hashchange', () => {
        state.lastHandledKey = '';
        state.aiLastKey = '';
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', go, { once: true });
    } else {
      go();
    }
  }

  window.KahootTest35 = {
    state,
    resetQuiz,
    resolvePin,
    loadQuizById,
    scanCurrentPage,
    matchCurrentQuestion,
    buildAIPayload,
    askAI,
    handleCurrentQuestion
  };

  start();
})();
