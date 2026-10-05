// ==UserScript==
// @name         KaHack Test 3.1 - Verified + PIN Resolver
// @version      3.1.0
// @namespace    local.kahoot.test
// @description  Test helper for your own Kahoot: quiz/PIN resolver, verified answer viewer, safer auto-answer.
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    pollMs: 120,
    answerDelayMs: 450,
    betweenMultiClicksMs: 120,
    submitDelayMs: 180,
    fetchTimeoutMs: 7000,
  };

  const state = {
    quizId: '',
    pin: '',
    quizTitle: '',
    questions: [],
    currentQuizIndex: -1,
    lastHandledKey: '',
    autoAnswer: false,
    showAnswers: true,
    busy: false,
    interceptedQuizId: '',
    panelReady: false,
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function normalize(s) {
    return String(s ?? '')
      .replace(/<[^>]*>/g, ' ')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
      const u = new URL(s);
      const p = u.searchParams.get('pin') || u.searchParams.get('gameId');
      if (p && /^\d{5,10}$/.test(p)) return p;
    } catch {}

    if (/^\d{5,10}$/.test(s)) return s;

    const m = s.match(/(?:pin|game)[^\d]{0,10}(\d{5,10})/i);
    return m ? m[1] : '';
  }

  function deepFindQuizId(obj, depth = 0) {
    if (!obj || depth > 8) return '';

    if (typeof obj === 'string') return extractUUID(obj);

    if (Array.isArray(obj)) {
      for (const x of obj) {
        const id = deepFindQuizId(x, depth + 1);
        if (id) return id;
      }
      return '';
    }

    if (typeof obj === 'object') {
      const preferred = ['quizId', 'kahootId', 'quizUuid', 'uuid', 'id'];
      for (const k of preferred) {
        if (k in obj) {
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
    if (!obj || depth > 8) return null;

    if (Array.isArray(obj)) {
      for (const x of obj) {
        const q = deepFindQuestions(x, depth + 1);
        if (q) return q;
      }
      return null;
    }

    if (typeof obj === 'object') {
      if (Array.isArray(obj.questions) && obj.questions.length) {
        return {
          title: obj.title || obj.name || 'Untitled',
          questions: obj.questions,
          quizId: deepFindQuizId(obj)
        };
      }
      for (const v of Object.values(obj)) {
        const q = deepFindQuestions(v, depth + 1);
        if (q) return q;
      }
    }
    return null;
  }

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

  function ingestQuizPayload(payload, source = 'network') {
    const found = deepFindQuestions(payload);
    if (found?.questions?.length) {
      state.quizId = found.quizId || state.quizId || deepFindQuizId(payload);
      state.quizTitle = found.title || 'Untitled';
      state.questions = parseQuestions(found.questions);
      state.currentQuizIndex = -1;
      state.lastHandledKey = '';
      if (state.quizId) localStorage.setItem('kahack-test-quiz-id', state.quizId);
      if (state.panelReady) {
        updateQuizLabel();
        setStatus(`QUIZ DATA CAPTURED (${source})`, 'ok');
      }
      return true;
    }

    const id = deepFindQuizId(payload);
    if (id && !state.interceptedQuizId) {
      state.interceptedQuizId = id;
      if (state.panelReady) {
        setStatus(`Quiz ID captured: ${id.slice(0, 8)}…`, 'ok');
      }
      setTimeout(() => loadQuiz(id, `captured-${source}`), 0);
      return true;
    }

    return false;
  }

  // ---------- Network interception ----------
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    const response = await originalFetch(...args);

    try {
      const clone = response.clone();
      const ct = clone.headers.get('content-type') || '';
      if (ct.includes('json')) {
        clone.json().then(data => ingestQuizPayload(data, 'fetch')).catch(() => {});
      } else {
        clone.text().then(text => {
          if (text && text.length < 2_000_000) {
            const id = extractUUID(text);
            if (id && !state.interceptedQuizId) {
              state.interceptedQuizId = id;
              if (state.panelReady) setStatus(`Quiz ID captured: ${id.slice(0,8)}…`, 'ok');
              setTimeout(() => loadQuiz(id, 'fetch-text'), 0);
            }
          }
        }).catch(() => {});
      }
    } catch {}

    return response;
  };

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__khUrl = String(url || '');
    return XHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const text = this.responseText;
        if (!text || typeof text !== 'string' || text.length > 2_000_000) return;
        try {
          ingestQuizPayload(JSON.parse(text), 'xhr');
        } catch {
          const id = extractUUID(text);
          if (id && !state.interceptedQuizId) {
            state.interceptedQuizId = id;
            if (state.panelReady) setStatus(`Quiz ID captured: ${id.slice(0,8)}…`, 'ok');
            setTimeout(() => loadQuiz(id, 'xhr-text'), 0);
          }
        }
      } catch {}
    });
    return XHRSend.apply(this, args);
  };

  // ---------- Quiz / PIN loading ----------
  async function loadQuiz(value, source = 'manual') {
    const id = extractUUID(value);
    if (!id) {
      setStatus('Invalid Quiz ID / URL', 'error');
      return false;
    }

    if (state.quizId === id && state.questions.length) {
      setStatus(`QUIZ DATA ALREADY LOADED (${source})`, 'ok');
      return true;
    }

    setStatus(`Loading quiz… (${source})`, 'muted');
    if (loadBtn) loadBtn.disabled = true;

    const candidates = [
      `https://kahoot.it/rest/kahoots/${id}`,
      `https://play.kahoot.it/rest/kahoots/${id}`,
      `https://create.kahoot.it/rest/kahoots/${id}`,
      `https://kahoot.it/rest/kahoots/${id}/card/?includeKahoot=true`
    ];

    let lastError = '';

    try {
      for (const url of candidates) {
        try {
          const d = await fetchJson(url);
          const payload = d?.questions ? d : (d?.kahoot?.questions ? d.kahoot : d);
          const found = deepFindQuestions(payload);
          if (found?.questions?.length) {
            state.quizId = id;
            state.quizTitle = found.title || payload.title || 'Untitled';
            state.questions = parseQuestions(found.questions);
            state.currentQuizIndex = -1;
            state.lastHandledKey = '';
            localStorage.setItem('kahack-test-quiz-id', id);
            updateQuizLabel();
            setStatus('QUIZ DATA LOADED', 'ok');
            return true;
          }
        } catch (e) {
          lastError = e.message;
        }
      }

      throw new Error(lastError || 'quiz data unavailable');
    } catch (e) {
      if (!state.questions.length) {
        updateQuizLabel();
        setStatus(`LOAD FAILED: ${e.message}`, 'error');
      }
      return false;
    } finally {
      if (loadBtn) loadBtn.disabled = false;
    }
  }

  async function resolvePin(pin) {
    if (!/^\d{5,10}$/.test(pin)) {
      setStatus('Invalid PIN', 'error');
      return false;
    }

    state.pin = pin;
    setStatus(`Resolving PIN ${pin}…`, 'muted');
    localStorage.setItem('kahack-test-pin', pin);

    // Strategy 1: common reservation POST used by Kahoot clients.
    const postTargets = [
      'https://kahoot.it/reserve/session/',
      'https://play.kahoot.it/reserve/session/'
    ];

    for (const url of postTargets) {
      try {
        const d = await fetchJson(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ game: pin })
        });

        if (ingestQuizPayload(d, 'pin-post')) return true;
        const id = deepFindQuizId(d);
        if (id && await loadQuiz(id, 'pin-post')) return true;
      } catch {}
    }

    // Strategy 2: reservation GET variants.
    const getTargets = [
      `https://kahoot.it/reserve/session/${pin}/?${Date.now()}`,
      `https://play.kahoot.it/reserve/session/${pin}/?${Date.now()}`
    ];

    for (const url of getTargets) {
      try {
        const r = await fetchWithTimeout(url);
        if (!r.ok) continue;

        const text = await r.text();
        try {
          const d = JSON.parse(text);
          if (ingestQuizPayload(d, 'pin-get')) return true;
          const id = deepFindQuizId(d);
          if (id && await loadQuiz(id, 'pin-get')) return true;
        } catch {
          const id = extractUUID(text);
          if (id && await loadQuiz(id, 'pin-get-text')) return true;
        }
      } catch {}
    }

    // Strategy 3: current page/network may reveal quizId after joining.
    setStatus(
      `PIN ${pin} found, but quiz ID is not exposed yet. Join the game; network capture is waiting…`,
      'warn'
    );
    return false;
  }

  async function loadFromInput(value) {
    const s = String(value || '').trim();

    const id = extractUUID(s);
    if (id) return loadQuiz(id, 'input');

    const pin = extractPin(s);
    if (pin) return resolvePin(pin);

    setStatus('Enter Quiz ID, Kahoot URL, or PIN', 'error');
    return false;
  }

  function autoDetectFromCurrentPage() {
    const urlId = extractUUID(location.href);
    if (urlId) {
      if (inputEl) inputEl.value = urlId;
      loadQuiz(urlId, 'current-url');
      return;
    }

    try {
      const params = new URLSearchParams(location.search);
      const pin = params.get('pin') || params.get('gameId');
      if (pin && /^\d{5,10}$/.test(pin)) {
        state.pin = pin;
        if (inputEl) inputEl.value = pin;
        resolvePin(pin);
      }
    } catch {}

    // Search scripts/meta for a UUID.
    setTimeout(() => {
      if (state.questions.length) return;
      const candidates = [
        ...document.querySelectorAll('script'),
        ...document.querySelectorAll('meta')
      ];
      for (const el of candidates) {
        const text = el.textContent || el.getAttribute?.('content') || '';
        const id = extractUUID(text);
        if (id) {
          if (inputEl) inputEl.value = id;
          loadQuiz(id, 'page-scan');
          return;
        }
      }
    }, 1200);
  }

  // ---------- Question detection ----------
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
        if (el.closest('#kahack-safe-panel')) continue;
        const t = el.textContent?.trim();
        if (t && t.length >= 3 && t.length < 1000 && el.offsetParent !== null) {
          const nt = normalize(t);
          if (!/^(kahoot|question|submit|next|answer)$/i.test(nt)) return t;
        }
      }
    }
    return '';
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
      '[class*="choice" i] button',
      'main button[aria-label]'
    ];

    const seen = new Set();
    const out = [];

    for (const sel of selectors) {
      for (const b of document.querySelectorAll(sel)) {
        if (b.closest('#kahack-safe-panel')) continue;
        if (
          !seen.has(b) &&
          b.offsetParent !== null &&
          b.offsetWidth > 35 &&
          b.offsetHeight > 25 &&
          !b.disabled
        ) {
          const text = normalize(buttonText(b));
          const fs = b.getAttribute('data-functional-selector') || '';
          const testid = b.getAttribute('data-testid') || '';
          if (
            fs.startsWith('answer-') ||
            fs.startsWith('multi-select-button-') ||
            /answer|choice/i.test(testid) ||
            text
          ) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  function buttonText(btn) {
    return (
      btn.getAttribute('aria-label') ||
      btn.innerText ||
      btn.textContent ||
      ''
    ).trim();
  }

  function getQuestionCounterIndex() {
    const sels = [
      '[data-functional-selector="question-index-counter"]',
      '[data-functional-selector="question-index"]',
      '[data-testid*="question-number"]',
      '[data-testid*="question-index"]',
      '[class*="question-index" i]',
      '[class*="question-count" i]',
      '[class*="progress-counter" i]'
    ];

    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el || el.closest('#kahack-safe-panel')) continue;
      const m = el.textContent?.match(/\d+/);
      if (m) return Math.max(0, parseInt(m[0], 10) - 1);
    }
    return -1;
  }

  function matchCurrentQuestion() {
    if (!state.questions.length) return null;

    const liveRaw = readQuestionText();
    const liveText = normalize(liveRaw);

    if (liveText) {
      const exact = state.questions.find(q => normalize(q.text) === liveText);
      if (exact) return { q: exact, confidence: 'text-exact' };

      const contains = state.questions.filter(q => {
        const qt = normalize(q.text);
        return qt && (qt.includes(liveText) || liveText.includes(qt));
      });
      if (contains.length === 1) {
        return { q: contains[0], confidence: 'text-close' };
      }
    }

    const idx = getQuestionCounterIndex();
    if (idx >= 0 && state.questions[idx]) {
      return { q: state.questions[idx], confidence: liveText ? 'index-fallback' : 'index' };
    }

    return null;
  }

  function mapCorrectButtons(question) {
    const buttons = getAnswerButtons();
    if (!question?.choices?.length || !buttons.length) return [];

    const live = buttons.map((btn, i) => ({
      i,
      btn,
      text: normalize(buttonText(btn)),
      fs: btn.getAttribute('data-functional-selector') || ''
    }));

    const correctChoices = question.choices.filter(c => c.correct);
    if (!correctChoices.length) return [];

    const mapped = [];
    const used = new Set();

    // 1) Text mapping. Best for shuffled answers.
    for (const choice of correctChoices) {
      const ct = normalize(choice.text);
      if (!ct) continue;

      let match = live.find(x => !used.has(x.i) && x.text === ct);

      if (!match) {
        const candidates = live.filter(x =>
          !used.has(x.i) &&
          x.text &&
          (x.text.includes(ct) || ct.includes(x.text))
        );
        if (candidates.length === 1) match = candidates[0];
      }

      if (match) {
        used.add(match.i);
        mapped.push(match.btn);
      }
    }

    if (mapped.length === correctChoices.length) return mapped;

    // 2) Functional selector index.
    const bySelector = [];
    for (const choice of correctChoices) {
      const patterns = [
        `answer-${choice.index}`,
        `multi-select-button-${choice.index}`
      ];
      const found = live.find(x => patterns.includes(x.fs));
      if (found) bySelector.push(found.btn);
    }
    if (bySelector.length === correctChoices.length) return bySelector;

    // 3) Index fallback only when DOM count exactly matches quiz choices.
    if (buttons.length === question.choices.length) {
      const fallback = correctChoices.map(c => buttons[c.index]).filter(Boolean);
      if (fallback.length === correctChoices.length) return fallback;
    }

    return [];
  }

  function clearHighlights() {
    document.querySelectorAll('[data-kahack-highlight="1"]').forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('box-shadow');
      el.removeAttribute('data-kahack-highlight');
    });
  }

  function highlightCorrect(question) {
    clearHighlights();
    const buttons = mapCorrectButtons(question);

    for (const btn of buttons) {
      btn.dataset.kahackHighlight = '1';
      btn.style.setProperty('outline', '4px solid #45ff9a', 'important');
      btn.style.setProperty('outline-offset', '-4px', 'important');
      btn.style.setProperty('box-shadow', '0 0 22px rgba(69,255,154,.75)', 'important');
    }
    return buttons.length;
  }

  function clickElement(el) {
    if (!el || el.disabled || el.offsetParent === null) return false;

    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {}

    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.click();
      return true;
    } catch {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
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
      const buttons = document.querySelectorAll(sel);
      for (const b of buttons) {
        if (
          !b.closest('#kahack-safe-panel') &&
          b.offsetParent !== null &&
          !b.disabled
        ) return b;
      }
    }

    // Text fallback for current Kahoot UI variants.
    const words = [
      'submit', 'confirm', 'done', 'send', 'answer',
      'tasdiq', 'tasdiqlash', 'yuborish',
      'подтвердить', 'готово', 'отправить'
    ];

    for (const b of document.querySelectorAll('button')) {
      if (b.closest('#kahack-safe-panel') || b.offsetParent === null || b.disabled) continue;
      const t = normalize(b.innerText || b.textContent || b.getAttribute('aria-label') || '');
      if (words.some(w => t === normalize(w) || t.includes(normalize(w)))) return b;
    }

    return null;
  }

  async function answerVerified(question) {
    const qType = question.type;

    if (!['quiz', 'true_false', 'multiple_select_quiz', 'survey'].includes(qType)) {
      setStatus(`AUTO SKIP: unsupported type "${qType}"`, 'warn');
      return false;
    }

    const buttons = mapCorrectButtons(question);
    const needed = question.choices.filter(c => c.correct).length;

    if (!needed || buttons.length !== needed) {
      setStatus('AUTO SKIP: verified answer mapping failed', 'warn');
      return false;
    }

    await sleep(CFG.answerDelayMs);

    for (let i = 0; i < buttons.length; i++) {
      if (i > 0) await sleep(CFG.betweenMultiClicksMs);
      if (!clickElement(buttons[i])) {
        setStatus('AUTO SKIP: answer click failed', 'warn');
        return false;
      }
    }

    const isMulti =
      qType === 'multiple_select_quiz' ||
      needed > 1 ||
      !!document.querySelector('[data-functional-selector^="multi-select-button-"]');

    if (isMulti) {
      await sleep(CFG.submitDelayMs);

      let submit = findSubmitButton();
      if (!submit) {
        // UI may render submit after selections.
        for (let i = 0; i < 8 && !submit; i++) {
          await sleep(120);
          submit = findSubmitButton();
        }
      }

      if (!submit) {
        setStatus('MULTI SELECT: answers selected, SUBMIT NOT FOUND', 'warn');
        return false;
      }

      if (!clickElement(submit)) {
        setStatus('MULTI SELECT: SUBMIT CLICK FAILED', 'warn');
        return false;
      }

      setStatus(`Answered Q${question.index + 1} + submitted`, 'ok');
      return true;
    }

    setStatus(`Answered Q${question.index + 1} (verified)`, 'ok');
    return true;
  }

  async function handleCurrentQuestion() {
    if (state.busy || !state.questions.length) return;

    const matched = matchCurrentQuestion();
    if (!matched) {
      if (getAnswerButtons().length) {
        setStatus('Question visible, but not matched to quiz data', 'warn');
      } else {
        setStatus('Waiting for question…', 'muted');
      }
      return;
    }

    const buttons = getAnswerButtons();
    if (!buttons.length) return;

    const key = [
      matched.q.index,
      matched.confidence,
      normalize(readQuestionText()),
      buttons.length
    ].join(':');

    if (state.lastHandledKey === key) return;

    state.busy = true;
    try {
      state.currentQuizIndex = matched.q.index;
      updateQuestionLabel();

      if (state.showAnswers) {
        const count = highlightCorrect(matched.q);
        if (count) {
          setStatus(
            `Q${matched.q.index + 1}: ${count} verified answer(s) shown [${matched.confidence}]`,
            'ok'
          );
        } else {
          setStatus(`Q${matched.q.index + 1}: answer mapping failed`, 'warn');
        }
      }

      if (state.autoAnswer) {
        if (matched.confidence === 'index-fallback') {
          setStatus('AUTO SKIP: question text mismatch', 'warn');
        } else {
          await answerVerified(matched.q);
        }
      }

      state.lastHandledKey = key;
    } finally {
      state.busy = false;
    }
  }

  // ---------- UI ----------
  let panel, inputEl, loadBtn, showToggle, autoToggle, quizLabel, questionLabel, statusLabel, body;

  function setStatus(text, kind = 'muted') {
    if (!statusLabel) return;
    statusLabel.textContent = text;
    statusLabel.dataset.kind = kind;
  }

  function updateQuizLabel() {
    if (!quizLabel) return;
    quizLabel.textContent = state.questions.length
      ? `Quiz: ${state.quizTitle} (${state.questions.length} Q)`
      : 'Quiz: not loaded';
    updateQuestionLabel();
  }

  function updateQuestionLabel() {
    if (!questionLabel) return;
    questionLabel.textContent = state.currentQuizIndex >= 0
      ? `Question: ${state.currentQuizIndex + 1}/${state.questions.length}`
      : `Question: -/${state.questions.length || 0}`;
  }

  function buildUI() {
    if (document.getElementById('kahack-safe-panel')) return;

    panel = document.createElement('div');
    panel.id = 'kahack-safe-panel';
    panel.innerHTML = `
      <div class="kh-head">
        <strong>KaHack Test 3.1</strong>
        <button id="kh-min">−</button>
      </div>
      <div id="kh-body">
        <input id="kh-input" placeholder="Quiz ID / Kahoot URL / Game PIN" />
        <div class="kh-buttons">
          <button id="kh-load">Load / Resolve</button>
          <button id="kh-detect">Auto detect</button>
        </div>
        <div class="kh-row"><span>Show verified answers</span><input id="kh-show" type="checkbox" checked></div>
        <div class="kh-row"><span>Auto answer</span><input id="kh-auto" type="checkbox"></div>
        <div id="kh-quiz">Quiz: not loaded</div>
        <div id="kh-question">Question: -</div>
        <div id="kh-status">Ready</div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #kahack-safe-panel{
        position:fixed;top:18px;right:18px;width:345px;z-index:2147483647;
        background:rgba(12,10,25,.97);color:#f4f1ff;border:1px solid #765cff;
        border-radius:14px;box-shadow:0 0 28px rgba(118,92,255,.42);
        font-family:Inter,system-ui,Arial,sans-serif;overflow:hidden
      }
      #kahack-safe-panel .kh-head{
        display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
        background:linear-gradient(90deg,#291a59,#171126)
      }
      #kahack-safe-panel button,#kahack-safe-panel input{font:inherit}
      #kh-min{
        width:30px;height:28px;border:0;border-radius:8px;background:#30264e;color:#fff;cursor:pointer
      }
      #kh-body{padding:12px;display:grid;gap:9px}
      #kh-input{
        width:100%;box-sizing:border-box;padding:10px;border-radius:9px;border:1px solid #57498c;
        color:#fff;background:#0f0c19;outline:none
      }
      #kahack-safe-panel .kh-buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      #kh-load,#kh-detect{
        padding:9px;border:0;border-radius:9px;background:#7258ff;color:#fff;font-weight:700;cursor:pointer
      }
      #kh-detect{background:#3d315f}
      #kahack-safe-panel .kh-row{
        display:flex;justify-content:space-between;align-items:center;padding:5px 1px
      }
      #kh-quiz,#kh-question,#kh-status{
        padding:8px 9px;border-radius:8px;background:rgba(255,255,255,.055);font-size:13px
      }
      #kh-status[data-kind="ok"]{color:#66ffaf}
      #kh-status[data-kind="warn"]{color:#ffd66b}
      #kh-status[data-kind="error"]{color:#ff7c91}
      #kh-status[data-kind="muted"]{color:#aaa4bc}
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    inputEl = document.getElementById('kh-input');
    loadBtn = document.getElementById('kh-load');
    showToggle = document.getElementById('kh-show');
    autoToggle = document.getElementById('kh-auto');
    quizLabel = document.getElementById('kh-quiz');
    questionLabel = document.getElementById('kh-question');
    statusLabel = document.getElementById('kh-status');
    body = document.getElementById('kh-body');

    state.panelReady = true;

    loadBtn.addEventListener('click', () => loadFromInput(inputEl.value));
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') loadFromInput(inputEl.value);
    });

    document.getElementById('kh-detect').addEventListener('click', autoDetectFromCurrentPage);

    showToggle.addEventListener('change', () => {
      state.showAnswers = showToggle.checked;
      if (!state.showAnswers) clearHighlights();
      state.lastHandledKey = '';
      setStatus(state.showAnswers ? 'Answer viewer ON' : 'Answer viewer OFF', 'muted');
    });

    autoToggle.addEventListener('change', () => {
      state.autoAnswer = autoToggle.checked;
      state.lastHandledKey = '';
      setStatus(
        state.autoAnswer
          ? 'AutoAnswer ON — verified answers only'
          : 'AutoAnswer OFF',
        'muted'
      );
    });

    document.getElementById('kh-min').addEventListener('click', e => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'grid' : 'none';
      e.currentTarget.textContent = hidden ? '−' : '+';
    });

    const savedPin = localStorage.getItem('kahack-test-pin');
    const savedId = localStorage.getItem('kahack-test-quiz-id');
    inputEl.value = extractPin(location.href) || extractUUID(location.href) || savedPin || savedId || '';

    updateQuizLabel();

    if (state.questions.length) {
      setStatus('QUIZ DATA CAPTURED before UI loaded', 'ok');
    } else {
      setStatus('Ready — enter Quiz ID / URL / PIN', 'muted');
    }

    autoDetectFromCurrentPage();
  }

  function startRuntime() {
    const build = () => {
      if (!document.body || !document.head) {
        setTimeout(build, 50);
        return;
      }
      buildUI();

      const observer = new MutationObserver(() => {
        clearTimeout(observer.__khTimer);
        observer.__khTimer = setTimeout(handleCurrentQuestion, 70);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });

      setInterval(handleCurrentQuestion, CFG.pollMs);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', build, { once: true });
    } else {
      build();
    }
  }

  window.KaHackTest = {
    state,
    loadQuiz,
    resolvePin,
    loadFromInput,
    autoDetectFromCurrentPage,
    matchCurrentQuestion,
    mapCorrectButtons,
    findSubmitButton,
    handleCurrentQuestion
  };

  startRuntime();
})();
