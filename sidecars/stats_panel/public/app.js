(() => {
  const POLL_MS = 1500;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 6.5; // ~40.84

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  let selectedConvId = '';
  let lastBoundConvId = '';
  let lastEtag = '';
  let pollTimer = null;

  // -------------------------------------------------------------------------
  // Host light/dark theme sync (follows preload.js CSS variables)
  // -------------------------------------------------------------------------

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // -------------------------------------------------------------------------
  // Formatting helpers (match the user's screenshots)
  // -------------------------------------------------------------------------

  function fmtDurationZh(sec) {
    const s = Math.max(0, Number(sec) || 0);
    if (s < 10) return `${s.toFixed(1)}秒`;
    const totalSec = Math.round(s);
    if (totalSec < 60) return `${totalSec}秒`;
    const totalMin = Math.floor(totalSec / 60);
    const remSec = totalSec % 60;
    if (totalMin < 1000) {
      return `${totalMin}分${remSec}秒`;
    }
    const hrs = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    return `${hrs}小时${remMin}分${remSec}秒`;
  }

  function fmtCompactTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return `${m >= 100 ? Math.round(m) : Number(m.toFixed(1))}M`;
    }
    if (v >= 1_000) {
      const k = v / 1_000;
      return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`;
    }
    return String(Math.round(v));
  }

  function fmtInt(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function fmtClock(ms) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Summary bar navigation / highlight
  // -------------------------------------------------------------------------

  for (const btn of document.querySelectorAll('.summary-item[data-target]')) {
    btn.addEventListener('click', () => {
      const card = $(btn.dataset.target);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
      setTimeout(() => card.classList.remove('pulse'), 900);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderConversations(recent, activeId, boundId) {
    const sel = $('conv-select');
    const items = Array.isArray(recent) ? [...recent] : [];
    if (activeId && !items.some((r) => r.id === activeId)) {
      items.unshift({ id: activeId, title: activeId.slice(0, 8) });
    }
    const sig = items.map((i) => `${i.id}:${i.title}`).join('|') + `|${activeId}|${boundId}`;
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;

    sel.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      const prefix = boundId && item.id === boundId ? '当前 · ' : '';
      opt.textContent = `${prefix}${item.title || item.id.slice(0, 8)}`;
      if (item.id === activeId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderStats(payload) {
    const { conversationId, boundConversationId, stats, recent } = payload;
    renderConversations(recent, conversationId, boundConversationId);

    const badge = $('model-badge');
    if (!stats) {
      $('empty-state').classList.remove('hidden');
      $('stats-main').classList.add('hidden');
      $('empty-title').textContent = '暂无当前会话数据';
      $('empty-sub').textContent = conversationId
        ? `等待会话 ${conversationId.slice(0, 8)} 写入日志…`
        : '打开任意 Antigravity 对话后将自动显示统计数据';
      badge.classList.add('hidden');
      return;
    }

    $('empty-state').classList.add('hidden');
    $('stats-main').classList.remove('hidden');

    if (stats.modelName) {
      badge.textContent = stats.modelName;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    const tok = stats.tokenUsage || {};
    const ctx = stats.context || {};

    // Top compact summary bar
    $('pill-session').textContent = `${stats.turns} 轮 ${stats.steps} 步 · ${stats.tps} tok/s`;
    $('pill-tokens').textContent = `${fmtCompactTokens(tok.totalTokens)} tok · 缓存命中 ${tok.cacheHitRate}%`;
    $('pill-context').textContent = `${ctx.pct}%`;

    const offset = RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, ctx.pct)) / 100);
    const ringFill = $('ring-fill');
    ringFill.style.strokeDashoffset = String(offset);
    ringFill.style.stroke =
      ctx.pct >= 85 ? '#ef4444' : ctx.pct >= 65 ? '#f59e0b' : 'var(--sm-fg-muted)';

    // Card 1: Session Stats
    $('val-turns-steps').textContent = `${stats.turns} 轮 ${stats.steps} 步`;
    $('val-model-time').textContent = fmtDurationZh(stats.modelTimeSec);
    $('val-tool-time').textContent = fmtDurationZh(stats.toolTimeSec);
    $('val-ttft').textContent = `${(stats.avgTtftSec || 0).toFixed(1)}秒`;
    const tpsEl = $('val-tps');
    tpsEl.textContent = `${stats.tps || 0} tok/s`;
    tpsEl.title = stats.endToEndTps
      ? `纯流式输出速度 ${stats.tps || 0} tok/s（含首字/思考等待综合吞吐约 ${stats.endToEndTps} tok/s）`
      : '';

    // Card 2: Context Used + Compaction Count
    $('val-ctx-pct').textContent = `${ctx.pct}%`;
    $('val-ctx-ratio').textContent = `~${fmtCompactTokens(ctx.usedTokens)} / ${fmtCompactTokens(ctx.limitTokens)}`;

    const limit = Math.max(1, ctx.limitTokens || 256000);
    const pctOf = (n) => (n > 0 ? Math.max(0.8, (n / limit) * 100) : 0);
    $('seg-sys').style.width = `${pctOf(ctx.systemPromptTokens)}%`;
    $('seg-tools').style.width = `${pctOf(ctx.toolsTokens)}%`;
    $('seg-msg').style.width = `${pctOf(ctx.chatMessagesTokens)}%`;

    const segOther = $('seg-other');
    const rowOther = $('row-other');
    if (ctx.otherTokens > 0) {
      segOther.classList.remove('hidden');
      rowOther.classList.remove('hidden');
      segOther.style.width = `${pctOf(ctx.otherTokens)}%`;
      $('val-other').textContent = `~${fmtCompactTokens(ctx.otherTokens)}`;
    } else {
      segOther.classList.add('hidden');
      rowOther.classList.add('hidden');
    }

    $('val-sys-prompt').textContent = `~${fmtCompactTokens(ctx.systemPromptTokens)}`;
    $('val-tools').textContent = `~${fmtCompactTokens(ctx.toolsTokens)}`;
    $('val-chat-msgs').textContent = `~${fmtCompactTokens(ctx.chatMessagesTokens)}`;

    // Compaction Count & History
    const cpCount = ctx.compactionCount || 0;
    const cpBox = $('compaction-box');
    const cpHist = $('compaction-history');
    $('val-compactions').textContent = `${cpCount} 次`;
    if (cpCount > 0) {
      cpBox.classList.add('has-compactions');
      cpHist.classList.remove('hidden');
      cpHist.innerHTML = '';
      const list = (ctx.compactions || []).slice(-3).reverse();
      for (const cp of list) {
        const div = document.createElement('div');
        div.className = 'cp-item';
        const left = document.createElement('span');
        const t = fmtClock(cp.timestamp);
        left.textContent = `第 ${cp.stepIndex} 步压缩${t ? ` (${t})` : ''}`;
        const right = document.createElement('span');
        const beforeStr = cp.beforeTokens ? fmtCompactTokens(cp.beforeTokens) : '?';
        const afterStr = cp.afterTokens ? fmtCompactTokens(cp.afterTokens) : '?';
        right.textContent = `${beforeStr} → ${afterStr}`;
        div.append(left, right);
        cpHist.appendChild(div);
      }
    } else {
      cpBox.classList.remove('has-compactions');
      cpHist.classList.add('hidden');
      cpHist.innerHTML = '';
    }

    // Card 3: Token Usage
    $('val-total-tokens').textContent = `${fmtInt(tok.totalTokens)} tok`;
    $('val-cache-hit').textContent = `${tok.cacheHitRate || 0}%`;
    $('val-uncached-in').textContent = `${fmtInt(tok.uncachedInputTokens)} tok`;
    $('val-cache-read').textContent = `${fmtInt(tok.cacheReadTokens)} tok`;
    $('val-output-tokens').textContent = `${fmtInt(tok.outputTokens)} tok`;
  }

  // -------------------------------------------------------------------------
  // Polling loop
  // -------------------------------------------------------------------------

  $('conv-select').addEventListener('change', (e) => {
    selectedConvId = e.target.value || '';
    lastEtag = '';
    refreshNow();
  });

  function getActiveBoundConv() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function refreshNow() {
    const bound = getActiveBoundConv();
    if (bound && bound !== lastBoundConvId) {
      lastBoundConvId = bound;
      selectedConvId = bound;
      lastEtag = '';
    }
    const targetConv = selectedConvId || bound;
    const qs = new URLSearchParams();
    if (targetConv) qs.set('conversationId', targetConv);
    if (lastEtag) qs.set('etag', lastEtag);

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/stats?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      $('live-dot').classList.remove('stale');
      if (data.unchanged) return;
      lastEtag = data.etag || '';
      renderStats(data);
    } catch (err) {
      $('live-dot').classList.add('stale');
      console.error('[stats_panel] refresh failed:', err);
    }
  }

  function startPolling() {
    refreshNow();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshNow, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshNow();
  });

  startPolling();
})();
