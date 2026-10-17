(function () {
  'use strict';

  // Localized status labels injected by the server
  // (see templates/fragments/native-clamdtop.html).
  const i18n = window.__clamdtopI18n || {};
  function t(key, fallback) {
    return i18n[key] || fallback;
  }

  const dom = {
    endpoint: null,
    terminal: null,
    status: null,
    connect: null,
    disconnect: null,
  };

  let socket = null;
  let reconnectTimer = null;
  let renderTimer = null;
  let pendingRender = false;
  let manualDisconnect = false;
  let resizeHandlerBound = false;
  let pendingEscape = "";
  let connectionSerial = 0;

  const state = {
    rows: 42,
    cols: 180,
    row: 0,
    col: 0,
    savedRow: 0,
    savedCol: 0,
    fg: null,
    bg: null,
    bold: false,
    inverse: false,
    altCharset: false,
    buffer: [],
  };

  const altMap = {
    '`': '◆', 'a': '▒', 'b': '␉', 'c': '␌', 'd': '␍', 'e': '␊', 'f': '°', 'g': '±',
    'h': '␤', 'i': '␋', 'j': '┘', 'k': '┐', 'l': '┌', 'm': '└', 'n': '┼', 'o': '⎺',
    'p': '⎻', 'q': '─', 'r': '⎼', 's': '⎽', 't': '├', 'u': '┤', 'v': '┴', 'w': '┬',
    'x': '│', 'y': '≤', 'z': '≥', '{': 'π', '|': '≠', '}': '£', '~': '·'
  };

  function init() {
    const terminalElement = document.getElementById('nativeClamdtopTerminal');
    if (!terminalElement) {
      disconnect(true);
      return;
    }

    if (terminalElement.dataset.nativeClamdtopBound === '1') {
      return;
    }

    disconnect(false);

    dom.endpoint = document.getElementById('nativeClamdtopEndpoint');
    dom.terminal = terminalElement;
    dom.status = document.getElementById('nativeClamdtopStatus');
    dom.connect = document.getElementById('nativeClamdtopConnect');
    dom.disconnect = document.getElementById('nativeClamdtopDisconnect');
    dom.terminal.dataset.nativeClamdtopBound = '1';

    resizeTerminal();
    clearScreen();
    writeText('Starting native clamdtop...\r\n');
    renderNow();

    dom.connect && dom.connect.addEventListener('click', () => connect());
    dom.disconnect && dom.disconnect.addEventListener('click', () => disconnect(true));
    dom.endpoint && dom.endpoint.addEventListener('change', () => connect());

    dom.terminal.addEventListener('keydown', onTerminalKeyDown);
    dom.terminal.addEventListener('paste', onTerminalPaste);
    dom.terminal.addEventListener('mousedown', () => dom.terminal.focus());

    if (!resizeHandlerBound) {
      resizeHandlerBound = true;
      window.addEventListener('resize', debounce(() => {
        if (!document.getElementById('nativeClamdtopTerminal')) {
          return;
        }
        const oldRows = state.rows;
        const oldCols = state.cols;
        resizeTerminal();
        if (oldRows !== state.rows || oldCols !== state.cols) {
          clearScreen();
          writeText('Terminal resized. Reconnecting native clamdtop...\r\n');
          renderNow();
          if (socket && socket.readyState === WebSocket.OPEN) {
            connect();
          }
        }
      }, 400));
    }

    connect();
  }

  function connect() {
    manualDisconnect = false;
    closeSocketSilently();
    clearScreen();
    writeText('Starting native clamdtop...\r\n');
    renderNow();

    if (!dom.endpoint || !dom.endpoint.value) {
      setStatus(t('noEndpoint', 'No endpoint'), 'bad');
      writeText('No clamd endpoint is available.\r\n');
      renderNow();
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      endpointId: dom.endpoint.value,
      rows: String(state.rows),
      cols: String(state.cols),
    });
    const url = `${protocol}//${window.location.host}/ws/clamdtop?${params.toString()}`;

    setStatus(t('connecting', 'Connecting'), 'warn');
    const ws = new WebSocket(url);
    const serial = ++connectionSerial;
    socket = ws;

    const isCurrent = () => socket === ws && serial === connectionSerial;

    ws.onopen = () => {
      if (!isCurrent()) return;
      setStatus(t('connected', 'Connected'), 'ok');
      dom.terminal.focus();
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      // Keep the badge tied to the active websocket only. Older sockets may close
      // asynchronously after a reconnect; they must not overwrite this status.
      setStatus(t('connected', 'Connected'), 'ok');
      feed(String(event.data || ''));
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      setStatus(t('error', 'WebSocket error'), 'bad');
    };

    ws.onclose = (event) => {
      if (!isCurrent()) return;
      socket = null;
      if (!manualDisconnect) {
        const reason = event && event.reason ? `: ${event.reason}` : '';
        setStatus(t('disconnected', 'Disconnected'), 'bad');
        writeText(`\r\n[clamdtop websocket closed${reason}]\r\n`);
        renderNow();
      }
    };
  }

  function closeSocketSilently() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const oldSocket = socket;
    socket = null;
    if (oldSocket) {
      oldSocket.onopen = null;
      oldSocket.onmessage = null;
      oldSocket.onerror = null;
      oldSocket.onclose = null;
      try { oldSocket.close(); } catch (e) { /* no-op */ }
    }
  }

  function disconnect(markManual) {
    manualDisconnect = !!markManual;
    closeSocketSilently();
    if (markManual) {
      setStatus(t('disconnected', 'Disconnected'), 'bad');
    }
  }

  function sendToProcess(data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }

  function onTerminalPaste(event) {
    const text = (event.clipboardData || window.clipboardData).getData('text');
    if (text) {
      sendToProcess(text);
      event.preventDefault();
    }
  }

  function onTerminalKeyDown(event) {
    let data = null;

    if (event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key.length === 1 && key >= 'a' && key <= 'z') {
        data = String.fromCharCode(key.charCodeAt(0) - 96);
      }
    }

    if (data === null) {
      switch (event.key) {
        case 'ArrowUp': data = '\x1b[A'; break;
        case 'ArrowDown': data = '\x1b[B'; break;
        case 'ArrowRight': data = '\x1b[C'; break;
        case 'ArrowLeft': data = '\x1b[D'; break;
        case 'Home': data = '\x1b[H'; break;
        case 'End': data = '\x1b[F'; break;
        case 'PageUp': data = '\x1b[5~'; break;
        case 'PageDown': data = '\x1b[6~'; break;
        case 'Enter': data = '\r'; break;
        case 'Backspace': data = '\x7f'; break;
        case 'Tab': data = '\t'; break;
        case 'Escape': data = '\x1b'; break;
        default:
          if (!event.metaKey && !event.altKey && event.key.length === 1) {
            data = event.key;
          }
      }
    }

    if (data !== null) {
      sendToProcess(data);
      event.preventDefault();
    }
  }

  function resizeTerminal() {
    if (!dom.terminal) {
      return;
    }
    const rect = dom.terminal.getBoundingClientRect();
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.font = window.getComputedStyle(dom.terminal).font;
    document.body.appendChild(probe);
    const charWidth = Math.max(7, probe.getBoundingClientRect().width || 8);
    const lineHeight = Math.max(14, parseFloat(window.getComputedStyle(dom.terminal).lineHeight) || 17);
    document.body.removeChild(probe);

    const wrap = dom.terminal.closest('.native-terminal-wrap');
    const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
    const width = Math.max(
      (wrapRect && wrapRect.width) || rect.width || dom.terminal.clientWidth || window.innerWidth - 20,
      800
    );
    const height = Math.max(
      (wrapRect && wrapRect.height) || rect.height || window.innerHeight - rect.top - 4,
      420
    );
    state.cols = clamp(Math.floor(width / charWidth), 80, 300);
    state.rows = clamp(Math.floor(height / lineHeight), 24, 120);
    dom.terminal.style.minHeight = `${state.rows * lineHeight}px`;
    dom.terminal.style.height = `${state.rows * lineHeight}px`;
    ensureBuffer();
  }

  function ensureBuffer() {
    while (state.buffer.length < state.rows) {
      state.buffer.push(blankLine());
    }
    if (state.buffer.length > state.rows) {
      state.buffer.length = state.rows;
    }
    for (let r = 0; r < state.rows; r++) {
      while (state.buffer[r].length < state.cols) {
        state.buffer[r].push(blankCell());
      }
      if (state.buffer[r].length > state.cols) {
        state.buffer[r].length = state.cols;
      }
    }
    state.row = clamp(state.row, 0, state.rows - 1);
    state.col = clamp(state.col, 0, state.cols - 1);
  }

  function blankCell() {
    return { ch: ' ', cls: '' };
  }

  function blankLine() {
    return Array.from({ length: state.cols }, blankCell);
  }

  function clearScreen() {
    state.buffer = Array.from({ length: state.rows }, blankLine);
    state.row = 0;
    state.col = 0;
    resetAttrs();
  }

  function clearLine(row, from, to) {
    if (row < 0 || row >= state.rows) return;
    const start = clamp(from, 0, state.cols - 1);
    const end = clamp(to, 0, state.cols - 1);
    for (let c = start; c <= end; c++) {
      state.buffer[row][c] = blankCell();
    }
  }

  function scrollUp() {
    state.buffer.shift();
    state.buffer.push(blankLine());
    state.row = state.rows - 1;
  }

  function currentClass() {
    const classes = [];
    if (state.bold) classes.push('ansi-bold');
    if (state.inverse) classes.push('ansi-inverse');
    if (state.fg) classes.push('ansi-fg-' + state.fg);
    if (state.bg) classes.push('ansi-bg-' + state.bg);
    return classes.join(' ');
  }

  function putChar(ch) {
    if (state.altCharset && altMap[ch]) {
      ch = altMap[ch];
    }
    if (state.row < 0 || state.row >= state.rows || state.col < 0 || state.col >= state.cols) {
      return;
    }
    state.buffer[state.row][state.col] = { ch, cls: currentClass() };
    state.col += 1;
    if (state.col >= state.cols) {
      state.col = 0;
      state.row += 1;
      if (state.row >= state.rows) {
        scrollUp();
      }
    }
  }

  function writeText(text) {
    for (const ch of text) {
      switch (ch) {
        case '\r': state.col = 0; break;
        case '\n': state.row += 1; if (state.row >= state.rows) scrollUp(); break;
        case '\b': state.col = Math.max(0, state.col - 1); break;
        case '\t': for (let i = 0; i < 4; i++) putChar(' '); break;
        default: putChar(ch);
      }
    }
    scheduleRender();
  }

  function feed(data) {
    if (pendingEscape) {
      data = pendingEscape + data;
      pendingEscape = '';
    }

    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const next = handleEscape(data, i + 1);
        if (next === -1) {
          pendingEscape = data.slice(i);
          break;
        }
        i = next;
        continue;
      }
      if (ch === '\x0e') { // SO: switch to G1/alternate line-drawing charset
        state.altCharset = true;
      } else if (ch === '\x0f') { // SI: switch back to normal charset
        state.altCharset = false;
      } else if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\b' || ch === '\t') {
        writeText(ch);
      }
      i += 1;
    }
    scheduleRender();
  }

  function handleEscape(data, i) {
    if (i >= data.length) {
      return -1;
    }
    const command = data[i];
    if (command === '[') {
      let seq = '';
      i += 1;
      while (i < data.length) {
        const ch = data[i];
        seq += ch;
        i += 1;
        if (ch >= '@' && ch <= '~') {
          handleCsi(seq);
          return i;
        }
      }
      return -1;
    }
    if (command === ']') {
      // OSC sequence, normally terminal title/color changes. Consume through BEL
      // or ST (ESC \) so ncurses output cannot corrupt the screen buffer.
      i += 1;
      while (i < data.length) {
        if (data[i] === '\x07') return i + 1;
        if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 2;
        i += 1;
      }
      return -1;
    }
    if (command === '(' || command === ')') {
      if (i + 1 >= data.length) {
        return -1;
      }
      const charset = data[i + 1];
      if (command === '(') {
        state.altCharset = charset === '0';
      }
      return i + 2;
    }
    if (command === '7') {
      state.savedRow = state.row;
      state.savedCol = state.col;
      return i + 1;
    }
    if (command === '8') {
      state.row = state.savedRow;
      state.col = state.savedCol;
      return i + 1;
    }
    if (command === 'c') {
      clearScreen();
      return i + 1;
    }
    if (command === 'M') {
      state.row = Math.max(0, state.row - 1);
      return i + 1;
    }
    return i + 1;
  }

  function handleCsi(seq) {
    const finalChar = seq[seq.length - 1];
    let body = seq.slice(0, -1);
    body = body.replace(/[?=><]/g, '');
    const params = body.length ? body.split(';').map(p => p === '' ? null : Number(p)) : [];
    const p = (idx, fallback) => Number.isFinite(params[idx]) && params[idx] !== null ? params[idx] : fallback;

    switch (finalChar) {
      case 'A': state.row = clamp(state.row - p(0, 1), 0, state.rows - 1); break;
      case 'B': state.row = clamp(state.row + p(0, 1), 0, state.rows - 1); break;
      case 'C': state.col = clamp(state.col + p(0, 1), 0, state.cols - 1); break;
      case 'D': state.col = clamp(state.col - p(0, 1), 0, state.cols - 1); break;
      case 'E': state.row = clamp(state.row + p(0, 1), 0, state.rows - 1); state.col = 0; break;
      case 'F': state.row = clamp(state.row - p(0, 1), 0, state.rows - 1); state.col = 0; break;
      case 'G': state.col = clamp(p(0, 1) - 1, 0, state.cols - 1); break;
      case 'H':
      case 'f':
        state.row = clamp(p(0, 1) - 1, 0, state.rows - 1);
        state.col = clamp(p(1, 1) - 1, 0, state.cols - 1);
        break;
      case 'd': state.row = clamp(p(0, 1) - 1, 0, state.rows - 1); break;
      case 'J':
        if (p(0, 0) === 2 || p(0, 0) === 3) {
          clearScreen();
        } else if (p(0, 0) === 0) {
          clearLine(state.row, state.col, state.cols - 1);
          for (let r = state.row + 1; r < state.rows; r++) clearLine(r, 0, state.cols - 1);
        } else if (p(0, 0) === 1) {
          for (let r = 0; r < state.row; r++) clearLine(r, 0, state.cols - 1);
          clearLine(state.row, 0, state.col);
        }
        break;
      case 'K':
        if (p(0, 0) === 2) clearLine(state.row, 0, state.cols - 1);
        else if (p(0, 0) === 1) clearLine(state.row, 0, state.col);
        else clearLine(state.row, state.col, state.cols - 1);
        break;
      case 'L':
        for (let n = 0; n < p(0, 1); n++) {
          state.buffer.splice(state.row, 0, blankLine());
          state.buffer.pop();
        }
        break;
      case 'M':
        for (let n = 0; n < p(0, 1); n++) {
          state.buffer.splice(state.row, 1);
          state.buffer.push(blankLine());
        }
        break;
      case '@': {
        const count = p(0, 1);
        const line = state.buffer[state.row];
        for (let n = 0; n < count; n++) {
          line.splice(state.col, 0, blankCell());
          line.pop();
        }
        break;
      }
      case 'P': {
        const count = p(0, 1);
        const line = state.buffer[state.row];
        for (let n = 0; n < count; n++) {
          line.splice(state.col, 1);
          line.push(blankCell());
        }
        break;
      }
      case 'X': {
        const count = p(0, 1);
        clearLine(state.row, state.col, Math.min(state.cols - 1, state.col + count - 1));
        break;
      }
      case 'S':
        for (let n = 0; n < p(0, 1); n++) scrollUp();
        break;
      case 'T':
        for (let n = 0; n < p(0, 1); n++) {
          state.buffer.pop();
          state.buffer.unshift(blankLine());
        }
        break;
      case 'h':
      case 'l':
        // DEC private mode changes (cursor visibility, alternate screen, etc.) are
        // safe to ignore for this fixed browser terminal.
        break;
      case 'm': handleSgr(params.length ? params : [0]); break;
      case 's': state.savedRow = state.row; state.savedCol = state.col; break;
      case 'u': state.row = state.savedRow; state.col = state.savedCol; break;
      default: break;
    }
  }

  function resetAttrs() {
    state.fg = null;
    state.bg = null;
    state.bold = false;
    state.inverse = false;
  }

  function handleSgr(params) {
    const colorNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    for (let i = 0; i < params.length; i++) {
      const code = params[i] === null ? 0 : params[i];
      if (code === 0) resetAttrs();
      else if (code === 1) state.bold = true;
      else if (code === 22) state.bold = false;
      else if (code === 7) state.inverse = true;
      else if (code === 27) state.inverse = false;
      else if (code === 39) state.fg = null;
      else if (code === 49) state.bg = null;
      else if (code >= 30 && code <= 37) state.fg = colorNames[code - 30];
      else if (code >= 40 && code <= 47) state.bg = colorNames[code - 40];
      else if (code >= 90 && code <= 97) state.fg = 'bright-' + colorNames[code - 90];
      else if (code >= 100 && code <= 107) state.bg = 'bright-' + colorNames[code - 100];
    }
  }

  function scheduleRender() {
    if (pendingRender) return;
    pendingRender = true;
    renderTimer = setTimeout(renderNow, 33);
  }

  function renderNow() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    pendingRender = false;

    const html = state.buffer.map(line => {
      const chunks = [];
      let currentCls = null;
      let currentText = '';

      for (const cell of line) {
        if (cell.cls !== currentCls) {
          if (currentText) {
            chunks.push(span(currentText, currentCls));
          }
          currentCls = cell.cls;
          currentText = cell.ch;
        } else {
          currentText += cell.ch;
        }
      }
      if (currentText) {
        chunks.push(span(currentText, currentCls));
      }
      return chunks.join('');
    }).join('\n');

    dom.terminal.innerHTML = html;
  }

  function span(text, cls) {
    const escaped = escapeHtml(text);
    return cls ? `<span class="${cls}">${escaped}</span>` : escaped;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(text, type) {
    if (!dom.status) return;
    dom.status.textContent = text;
    dom.status.classList.remove('is-ok', 'is-warn', 'is-bad');
    dom.status.classList.add(type === 'ok' ? 'is-ok' : type === 'warn' ? 'is-warn' : 'is-bad');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function debounce(fn, delay) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  const previousRebind = window.__rebindAfterSwap;
  window.__rebindAfterSwap = function () {
    if (typeof previousRebind === 'function') {
      previousRebind();
    }
    init();
  };
  window.__nativeClamdtopCleanup = function () {
    disconnect(true);
  };

  window.addEventListener('beforeunload', () => disconnect(true));
  document.addEventListener('DOMContentLoaded', init);
})();
