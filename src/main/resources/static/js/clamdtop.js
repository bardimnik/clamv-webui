(function () {
  let timer = null;
  let controller = null;

  function $(id) {
    return document.getElementById(id);
  }

  function text(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === '' ? '—' : String(value);
  }

  function percent(value, max) {
    const n = Number(value || 0);
    const m = Number(max || 0);
    if (!m || m <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((n / m) * 100)));
  }

  function setBar(id, value, max) {
    const el = $(id);
    if (el) el.style.width = percent(value, max) + '%';
  }

  function setStatus(ok, message) {
    const dot = $('clamdtopStatusDot');
    if (dot) dot.classList.toggle('is-ok', !!ok);
    if (dot) dot.classList.toggle('is-error', !ok);
    text('clamdtopStatusText', message);
  }

  function setCommands(commands) {
    const tbody = $('clamdtopCommands');
    const noCommands = $('clamdtopNoCommands');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (!Array.isArray(commands) || commands.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'text-muted';
      td.textContent = 'No detailed command rows reported by clamd.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      if (noCommands) noCommands.classList.remove('d-none');
      return;
    }

    if (noCommands) noCommands.classList.add('d-none');
    for (const row of commands) {
      const tr = document.createElement('tr');
      for (const key of ['command', 'queuedSince', 'file']) {
        const td = document.createElement('td');
        td.textContent = row && row[key] ? row[key] : '—';
        if (key === 'file') td.className = 'clamdtop-file';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function applySnapshot(data) {
    const parsed = data && data.parsed ? data.parsed : {};
    const threads = parsed.threads || {};
    const queue = parsed.queue || {};
    const memory = parsed.memory || {};
    const version = data && data.versionParsed ? data.versionParsed : {};
    const endpoint = data && data.endpoint ? data.endpoint : {};

    if (!data || !data.ok) {
      setStatus(false, data && data.error ? data.error : 'Unable to read clamd STATS');
      text('clamdtopRaw', data && data.error ? data.error : 'No data');
      return;
    }

    setStatus(true, 'Connected');
    text('clamdtopVersion', version.clamav || data.version || '—');
    text('clamdtopDb', version.dbVersion ? ('DB: ' + version.dbVersion + (version.dbTime ? ' / ' + version.dbTime : '')) : 'DB: —');

    const busy = Number(threads.busy || 0);
    const live = Number(threads.live || 0);
    const idle = Number(threads.idle || 0);
    const max = Number(threads.max || 0);
    text('clamdtopThreads', max ? (busy + ' busy / ' + max + ' max') : '—');
    text('clamdtopThreadsMeta', 'live ' + live + ' / idle ' + idle + ' / max ' + (max || '—'));
    setBar('clamdtopThreadsBar', busy, max);

    const items = Number(queue.items || 0);
    const qmax = Number(queue.max || 0);
    text('clamdtopQueue', qmax ? (items + ' / ' + qmax) : (items + ' items'));
    text('clamdtopQueueMeta', 'items ' + items + ' / max ' + (qmax || '—'));
    setBar('clamdtopQueueBar', items, qmax);

    const used = memory.pools_used || memory.used || '—';
    const total = memory.pools_total || memory.total || '—';
    text('clamdtopMemory', used !== '—' && total !== '—' ? (used + ' / ' + total) : '—');
    text('clamdtopMemoryMeta', 'heap ' + (memory.heap || '—') + ' / mmap ' + (memory.mmap || '—') + ' / pools ' + (memory.pools || parsed.pools || '—'));

    setCommands(parsed.commands || []);
    text('clamdtopRaw', data.stats || 'No raw STATS returned.');
    text('clamdtopEndpointLabel', endpoint.name ? (endpoint.name + ' · ' + endpoint.host + ':' + endpoint.port) : '—');

    const updated = data.timestamp ? new Date(data.timestamp) : new Date();
    text('clamdtopUpdated', 'Updated ' + updated.toLocaleString());
  }

  async function refresh() {
    const page = document.querySelector('[data-page="clamdtop"]');
    if (!page) return;

    const endpoint = $('clamdtopEndpoint');
    const endpointId = endpoint && endpoint.value ? endpoint.value : '';
    const url = endpointId ? ('/api/clamdtop?endpointId=' + encodeURIComponent(endpointId)) : '/api/clamdtop';

    try {
      if (controller) controller.abort();
      controller = new AbortController();
      setStatus(false, 'Refreshing…');
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applySnapshot(await res.json());
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus(false, e && e.message ? e.message : 'Refresh failed');
      text('clamdtopRaw', e && e.message ? e.message : 'Refresh failed');
    }
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
    try { if (controller) controller.abort(); } catch (e) {}
    controller = null;
  }

  function schedule() {
    stop();
    const page = document.querySelector('[data-page="clamdtop"]');
    if (!page) return;

    const auto = $('clamdtopAuto');
    const interval = $('clamdtopInterval');
    const delay = Number(interval && interval.value ? interval.value : 2000);

    if (!auto || auto.checked) {
      timer = window.setInterval(refresh, delay);
    }
  }

  function initClamdTop() {
    stop();
    const page = document.querySelector('[data-page="clamdtop"]');
    if (!page) return;

    const endpoint = $('clamdtopEndpoint');
    const interval = $('clamdtopInterval');
    const auto = $('clamdtopAuto');
    const refreshButton = $('clamdtopRefresh');

    if (endpoint) endpoint.addEventListener('change', function () { refresh(); schedule(); });
    if (interval) interval.addEventListener('change', schedule);
    if (auto) auto.addEventListener('change', schedule);
    if (refreshButton) refreshButton.addEventListener('click', refresh);

    refresh();
    schedule();
  }

  const previousRebind = window.__rebindAfterSwap;
  window.__rebindAfterSwap = function () {
    if (typeof previousRebind === 'function') previousRebind();
    initClamdTop();
  };

  document.addEventListener('DOMContentLoaded', initClamdTop);
  window.addEventListener('beforeunload', stop);
})();
