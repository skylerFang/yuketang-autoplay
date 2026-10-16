(() => {
  'use strict';
  const course = location.pathname.match(/lms-graph\/([^/]+)/)?.[1];
  if (!course || window.top !== window.self) return;
  const key = 'yt-directory-player-v1:' + course;
  let config = null;
  try { config = JSON.parse(sessionStorage.getItem(key)); } catch {}
  let enabled = false, picking = 0, first = null, video = null;
  let timer = null, pending = null, attempted = '', lastUrl = location.href;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647';
  document.documentElement.append(host);
  const root = host.attachShadow({mode:'closed'});
  root.innerHTML = `<style>
    *{box-sizing:border-box}section{width:260px;max-width:calc(100vw - 24px);max-height:calc(100vh - 80px);overflow:auto;background:#fff;color:#17253d;border:1px solid #d9e2f5;border-radius:16px;box-shadow:0 6px 28px #1c36552b;padding:12px;font:13px/1.5 system-ui}
    strong{font-size:14px}p{margin:10px 0;min-height:0}button{font:inherit;border:0;border-radius:8px;padding:7px 10px;cursor:pointer;background:#edf2fc;color:#244477;margin:3px 4px 3px 0}button.primary{background:#3975fa;color:white}small{display:block;color:#718098;margin-top:8px}button:disabled{opacity:.5;cursor:default}
    [hidden]{display:none!important}#launcher{display:block;margin:0;border:1px solid #dce5fa;border-radius:20px;background:#3975fa;color:white;font:13px/20px system-ui;padding:7px 12px;box-shadow:0 2px 10px #16397025;touch-action:none;cursor:grab}header{display:flex;align-items:center;justify-content:space-between;cursor:move;touch-action:none}#collapse{padding:2px 6px;margin:0}section{margin-bottom:6px}
    </style><section id="panel" hidden><header id="drag"><strong>雨课堂 · 连播 0.5</strong><button id="collapse" aria-label="收起设置">收起</button></header><p id="status" aria-live="polite"></p><button id="setup">① 指定目录</button><button class="primary" id="start">② 开启连播</button><button id="stop">全部停止</button><button id="test-next" title="立即打开下一节，用于检查目录切换">测试下一节</button><label style="display:block;margin-top:10px"><input type="checkbox" id="background"> 切换标签页后继续播放</label><small id="background-status">后台播放未开启，可单独使用。</small><details style="margin-top:8px"><summary>检测详情</summary><small id="diagnostic" style="border-top:1px solid #eee;padding-top:8px">正在检测播放器…</small></details><small>视频结束后等待 3 秒切换。可随时停止。</small></section><button id="launcher" aria-expanded="false" title="点击展开，拖动移动">连播设置</button>`;
  const panel = root.querySelector('#panel'), launcher = root.querySelector('#launcher');
  function clampPosition() {
    const r = host.getBoundingClientRect();
    host.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
    host.style.top = Math.max(8, Math.min(r.top, window.innerHeight - r.height - 8)) + 'px';
    host.style.bottom = 'auto';
  }
  function expand(open) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    clampPosition();
  }
  let dragState = null, suppressClick = false;
  for (const handle of [launcher, root.querySelector('#drag')]) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target === root.querySelector('#collapse')) return;
      const r = host.getBoundingClientRect();
      dragState = {x:e.clientX,y:e.clientY,left:r.left,top:r.top,moved:false};
      suppressClick = false; handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!dragState) return;
      const dx=e.clientX-dragState.x, dy=e.clientY-dragState.y;
      if (Math.abs(dx)+Math.abs(dy)>5) dragState.moved=true;
      if (!dragState.moved) return;
      host.style.left=dragState.left+dx+'px'; host.style.top=dragState.top+dy+'px'; host.style.bottom='auto';
      clampPosition();
    });
    const finishDrag = () => { if (dragState) suppressClick=dragState.moved; dragState=null; };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  }
  launcher.onclick = () => { if (suppressClick) {suppressClick=false;return;} expand(panel.hidden); };
  root.querySelector('#collapse').onclick = () => expand(false);
  window.addEventListener('resize', clampPosition);
  const status = root.querySelector('#status');
  const say = s => status.textContent = s;
  const backgroundToggle = root.querySelector('#background');
  const backgroundStatus = root.querySelector('#background-status');
  let backgroundVideo = null, wantsPlayback = false, backgroundTimer = null;
  let recoveryTimes = [], recovering = false, backgroundGeneration = 0;
  let pauseCheck = null, lastPlayerInput = -Infinity, lastAwayAt = -Infinity;
  let lastProgress = null, backgroundConfirmed = false;
  const diagnostic = root.querySelector('#diagnostic');
  const wired = new WeakSet();
  let scanAt = -Infinity, inventory = {videos:[], frames:0, blocked:0, domains:[]};
  const away = () => document.hidden || !document.hasFocus();
  const recentDeparture = () => away() || Date.now() - lastAwayAt < 10000;
  function clearBackground() {
    backgroundGeneration++;
    clearTimeout(pauseCheck); pauseCheck = null; backgroundConfirmed = false; lastProgress = null;
    clearTimeout(backgroundTimer); backgroundTimer = null;
    wantsPlayback = false; backgroundVideo = null; recoveryTimes = []; recovering = false;
  }
  function disableBackground(message) {
    backgroundToggle.checked = false; clearBackground();
    backgroundStatus.textContent = message;
  }
  function recoverBackground() {
    if (!backgroundToggle.checked || !wantsPlayback || !recentDeparture() || pending || pauseCheck || backgroundTimer || recovering || Date.now() - lastPlayerInput < 1000) return;
    const v = backgroundVideo;
    if (!v || v !== mainVideo() || v.ended || !v.paused || v.error) return;
    const generation = backgroundGeneration;
    backgroundTimer = setTimeout(async () => {
      backgroundTimer = null;
      if (generation !== backgroundGeneration || !backgroundToggle.checked || !wantsPlayback || !recentDeparture() || pending || v !== mainVideo() || v.ended || !v.paused) return;
      recoveryTimes = recoveryTimes.filter(t => Date.now() - t < 15000);
      if (recoveryTimes.length >= 3) {
        disableBackground('页面反复暂停视频，后台恢复已停止。请截图此提示以便适配。'); return;
      }
      recoveryTimes.push(Date.now()); recovering = true;
      try {
        await v.play();
        if (generation !== backgroundGeneration) return;
        backgroundStatus.textContent = '已请求恢复，正在检查播放进度…';
      } catch (error) {
        if (generation === backgroundGeneration) disableBackground('后台播放被阻止（' + (error.name || '未知原因') + '）。请回到视频页手动播放。');
      } finally { if (generation === backgroundGeneration) recovering = false; }
    }, 350);
  }
  backgroundToggle.onchange = () => {
    clearBackground();
    if (!backgroundToggle.checked) { backgroundStatus.textContent = '后台播放已关闭。'; return; }
    backgroundVideo = mainVideo(true);
    if (!backgroundVideo) { disableBackground('未找到播放器，请截图反馈。'); return; }
    wantsPlayback = !backgroundVideo.paused && !backgroundVideo.ended;
    backgroundStatus.textContent = wantsPlayback ? '恢复功能已开启，尚未验证后台播放。请切换标签页测试。' : '恢复功能已开启，请先手动播放，再切换标签页。';
    if (!enabled) say('已找到播放器。可单独测试后台播放；连播需点击“开启连播”。');
  };
  function onPlaying(e) {
    if (!backgroundToggle.checked || e.target !== mainVideo()) return;
    clearTimeout(pauseCheck); pauseCheck = null;
    backgroundVideo = e.target; wantsPlayback = true;
  }
  function onPause(e) {
    if (!backgroundToggle.checked || e.target !== backgroundVideo) return;
    const v = e.target;
    if (away()) lastAwayAt = Date.now();
    if (v.ended) { wantsPlayback = false; return; }
    // Focus/visibility notifications can arrive AFTER the pause notification.
    // Wait briefly before interpreting a foreground pause as user intent.
    clearTimeout(pauseCheck);
    pauseCheck = setTimeout(() => {
      pauseCheck = null;
      if (!backgroundToggle.checked || v !== backgroundVideo || !v.paused || v.ended) return;
      if (recentDeparture() && Date.now() - lastPlayerInput > 700) {
        backgroundStatus.textContent = '检测到切页暂停，正在恢复…'; recoverBackground();
      } else if (Date.now() - lastPlayerInput <= 700) {
        wantsPlayback = false; clearTimeout(backgroundTimer); backgroundTimer = null;
        backgroundStatus.textContent = '已手动暂停；手动播放后重新跟随。';
      } else {
        backgroundStatus.textContent = '检测到暂停，等待切页状态；尚未恢复。';
      }
    }, 450);
  }
  function wireVideo(v) {
    if (wired.has(v)) return;
    wired.add(v);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', () => { if (v === video) finished(); });
    const owner = v.ownerDocument || document;
    owner.addEventListener('pointerdown', e => {
      const r = v.getBoundingClientRect();
      if (e.isTrusted && !v.paused && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) lastPlayerInput = Date.now();
    }, true);
    owner.addEventListener('keydown', e => {
      if (e.isTrusted && !v.paused && [' ', 'k', 'K', 'MediaPlayPause', 'MediaPause'].includes(e.key)) lastPlayerInput = Date.now();
    }, true);
  }
  function onVisibility() {
    if (away()) lastAwayAt = Date.now();
    recoverBackground();
  }
  document.addEventListener('visibilitychange', onVisibility, true);
  window.addEventListener('blur', () => { lastAwayAt=Date.now(); recoverBackground(); }, true);
  window.addEventListener('focus', onVisibility, true);
  const save = () => sessionStorage.setItem(key, JSON.stringify(config));
  const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const text = e => e.textContent.replace(/\s+/g,'').trim();
  const videoLabel = e => /^(视频)?Video$|^Video视频$|^视频$/i.test(text(e));
  function path(e) {
    const bits = [];
    while (e && e !== document.documentElement) {
      if (e.id) { bits.unshift('#' + CSS.escape(e.id)); break; }
      const tag = e.localName;
      const peers = [...e.parentElement.children].filter(n => n.localName === tag);
      bits.unshift(tag + ':nth-of-type(' + (peers.indexOf(e)+1) + ')');
      e = e.parentElement;
    }
    return bits.join(' > ');
  }
  function row(target) {
    let result = null;
    for (let e = target; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (videoLabel(e) && r.width >= 70 && r.width < 600 && r.height > 15 && r.height < 100) result = e;
      if (r.height >= 100 || r.width >= 600) break;
    }
    return result;
  }
  function rows() {
    if (!config) return [];
    try {
      const scope = document.querySelector(config.scope);
      return scope ? [...scope.querySelectorAll(config.selector)].filter(e => videoLabel(e)) : [];
    } catch { return []; }
  }
  function stop(message) {
    enabled = false; clearTimeout(timer); timer = null; pending = null;
    if (message) say(message);
  }
  function endPick() {
    picking = 0; first = null;
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', escape, true);
  }
  function escape(e) { if (e.key === 'Escape') { endPick(); say('已取消指定。'); } }
  function pick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const selected = row(e.target);
    if (!selected) { say('请点左侧带有“视频 / Video”的整行，不要点章节标题。'); return; }
    if (picking === 1) { first = selected; picking = 2; say('再点左侧紧接着的下一个 Video（只记录，不跳转）。'); return; }
    if (selected === first) { say('请点另一行：当前视频之后的下一个 Video。'); return; }
    let scope = first.parentElement;
    while (scope && !scope.contains(selected)) scope = scope.parentElement;
    const shared = [...first.classList].filter(c => selected.classList.contains(c));
    const selector = first.localName + shared.map(c => '.' + CSS.escape(c)).join('');
    if (!scope || first.localName !== selected.localName) { say('两项结构不同，请取消后重新指定。'); return; }
    const candidates = [...scope.querySelectorAll(selector)].filter(videoLabel);
    const a = candidates.indexOf(first), b = candidates.indexOf(selected);
    if (a < 0 || b !== a+1 || candidates.length < 2) { say('无法确认连续顺序，请按 Esc，重新点当前行和紧邻的下一行。'); return; }
    config = {scope:path(scope), selector, clickPath:relativeTarget(selected, e.target), index:a, count:candidates.length, url:location.href};
    save(); endPick();
    say(`已识别 ${candidates.length} 个已展开的视频入口。点击“开启连播”。`);
  }
  root.querySelector('#setup').onclick = () => {
    stop(); endPick(); picking = 1;
    say('先点左侧正在播放的 Video 整行。按 Esc 取消。');
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', escape, true);
  };
  root.querySelector('#stop').onclick = () => { stop('已停止连播。当前视频由你控制。'); disableBackground('后台播放已关闭。'); endPick(); };
  function mainVideo(force = false) {
    if (force || Date.now() - scanAt >= 800) {
      scanAt = Date.now();
      const result = {videos:[], frames:0, blocked:0, domains:[]}, visited = new Set();
      function walk(scope) {
        if (!scope || visited.has(scope)) return;
        visited.add(scope);
        for (const v of scope.querySelectorAll('video')) { result.videos.push(v); wireVideo(v); }
        for (const element of scope.querySelectorAll('*')) if (element.shadowRoot) walk(element.shadowRoot);
        for (const frame of scope.querySelectorAll('iframe')) {
          result.frames++;
          try {
            if (frame.contentDocument) walk(frame.contentDocument);
            else throw new Error('unavailable');
          } catch {
            result.blocked++;
            try { const u = new URL(frame.getAttribute('src'), location.href); if (/^https?:$/.test(u.protocol)) result.domains.push(u.hostname); } catch {}
          }
        }
      }
      walk(document); inventory = result;
    }
    const candidates = inventory.videos.filter(v => v.isConnected !== false);
    const shown = candidates.filter(visible);
    if (shown.length) return shown.sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];
    // A player with a source can temporarily have zero dimensions during navigation.
    const loaded = candidates.filter(v => v.currentSrc || v.readyState >= 1);
    return loaded.length === 1 ? loaded[0] : null;
  }
  function updateDiagnostic(v) {
    const state = !v ? '未找到视频' : v.ended ? '已结束' : v.paused ? '已暂停' : '播放中';
    const seconds = v && Number.isFinite(v.currentTime) ? Math.floor(v.currentTime) : 0;
    diagnostic.textContent = `检测：${inventory.videos.length} 个视频 / ${inventory.frames} 个内嵌页面（${inventory.blocked} 个不可访问）。${state} · ${seconds} 秒 · ${document.hidden ? '后台' : '前台'}`;
    if (inventory.blocked) diagnostic.textContent += '。内嵌域名：' + [...new Set(inventory.domains)].join('、');
    if (backgroundToggle.checked && !v) backgroundStatus.textContent = '暂时找不到播放器，后台恢复无法执行。';
    if (backgroundToggle.checked && v) {
      if (lastProgress && lastProgress.video === v && lastProgress.hidden && document.hidden && !v.paused && v.currentTime > lastProgress.time) {
        backgroundConfirmed = true; backgroundStatus.textContent = '已检测到后台播放进度前进。';
      } else if (!document.hidden && backgroundConfirmed && !v.paused) {
        backgroundStatus.textContent = '上次检查确认后台进度前进；当前播放中。';
      }
      lastProgress = {video:v, hidden:document.hidden, time:v.currentTime};
    }
  }
  async function play(v) {
    if (!enabled || !v || v.ended) return;
    try { await v.play(); if (enabled) say('连播已开启，等待当前视频播放结束。'); }
    catch { if (enabled) say('浏览器暂未允许自动播放，请点一下视频播放键；连播仍开启。'); }
  }
  root.querySelector('#start').onclick = () => {
    endPick();
    if (!config || config.url !== location.href) { say('请先指定当前视频和下一项目录。'); return; }
    const list = rows();
    if (list.length !== config.count || !list[config.index]) { say('目录发生变化，请展开需要的章节，重新指定目录。'); return; }
    video = mainVideo(true);
    if (!video) { say('未找到可控制的播放器，请将此提示截图反馈。'); return; }
    enabled = true; attempted = video.currentSrc;
    if (video.ended) finished(); else play(video);
  };
  function relativeTarget(row, target) {
    if (!target || target === row || !row.contains(target) || !/Video/i.test(text(target))) return '';
    const parts = [];
    for (let n = target; n && n !== row; n = n.parentElement) {
      const peers = [...n.parentElement.children].filter(x => x.localName === n.localName);
      parts.unshift(n.localName + ':nth-of-type(' + (peers.indexOf(n) + 1) + ')');
    }
    return parts.join(' > ');
  }
  function clickTarget(row) {
    if (config.clickPath) {
      try { const target = row.querySelector(config.clickPath); if (target && /Video/i.test(text(target))) return target; } catch {}
    }
    // Click the actual label, so the click bubbles through its clickable ancestors.
    // Clicking an outer wrapper does not dispatch a click to its descendants.
    const labels = [...row.querySelectorAll('*')].filter(n => /^Video$/i.test(text(n)));
    return labels.find(n => ![...n.children].some(child => /^Video$/i.test(text(child)))) || row;
  }
  function navigateNext() {
    if (!enabled || pending) return;
    const list = rows();
    if (list.length !== config.count) { stop('目录发生变化，已停止。请重新指定目录。'); return; }
    const next = list[config.index + 1];
    if (!next) { stop('已到已识别目录的末尾。若还有折叠章节，请展开后重新指定。'); return; }
    const target = clickTarget(next);
    if (next.matches('[disabled],[aria-disabled="true"]') || target.closest('[disabled],[aria-disabled="true"]') || /disabled|locked/i.test(next.className)) { stop('下一视频不可用，已停止。'); return; }
    pending = {url:location.href, source:video.currentSrc, video, time:video.currentTime, at:Date.now(), nextIndex:config.index+1, triedVideo:null};
    say('已点击下一视频的文字入口，正在等待加载……');
    next.scrollIntoView({block:'nearest',inline:'nearest'});
    target.click();
  }
  root.querySelector('#test-next').onclick = () => {
    endPick();
    if (!config || config.url !== location.href) { say('请先指定当前视频和紧邻的下一视频。'); return; }
    if (pending) return;
    video = mainVideo(true);
    if (!video) { say('未找到播放器，请等待视频出现后再试。'); return; }
    clearTimeout(timer); timer = null; enabled = true;
    navigateNext();
  };
  function finished() {
    if (!enabled || timer || pending) return;
    say('本节已结束，3 秒后打开左侧下一视频……');
    timer = setTimeout(() => {
      timer = null;
      if (enabled && video?.ended) navigateNext();
    }, 3000);
  }
  document.addEventListener('click', e => {
    if (picking || pending || e.composedPath().includes(host)) return;
    const list = rows(), i = list.findIndex(n => n.contains(e.target));
    if (i >= 0 && config) {
      stop('已手动切换视频，请重新指定目录后开启连播。');
      config.url = ''; save();
    }
  }, true);
  setInterval(() => {
    const now = location.href;
    if (now !== lastUrl && !pending) { stop('页面已切换，请指定当前视频后开启连播。'); disableBackground('页面已切换，请重新开启后台播放。'); }
    lastUrl = now;
    const v = mainVideo();
    updateDiagnostic(v);
    launcher.textContent = enabled ? '连播中 · 设置' : backgroundToggle.checked ? '后台恢复 · 设置' : '连播设置';
    if (away()) lastAwayAt = Date.now();
    recoverBackground();
    if (!enabled) return;
    if (pending) {
      const routeChanged = now !== pending.url;
      const newPlayer = v && (v !== pending.video || (v.currentSrc && v.currentSrc !== pending.source));
      const resetOnNewRoute = v && routeChanged && Number.isFinite(pending.time) && v.currentTime < pending.time - 1;
      const changed = newPlayer || resetOnNewRoute;
      // preload=none may not load metadata until play() is requested.
      if (changed && !v.ended && pending.triedVideo !== v) {
        pending.triedVideo = v;
        v.play().catch(() => {});
      }
      if (changed && !v.ended && v.readyState >= 1) {
        config.index = pending.nextIndex; config.url = now;
        pending = null; video = v; save(); attempted = v.currentSrc; play(v);
      } else if (Date.now() - pending.at > 20000) {
        const reason = !routeChanged && !changed ? '目录点击未生效：地址和视频均未变化。' : !v ? '页面已切换，但未找到新播放器。' : v.ended ? '页面有变化，但播放器仍停在上一节末尾。' : v.readyState < 1 ? '新播放器尚未加载视频数据。' : '页面有变化，但未能确认是下一视频。';
        stop(reason + ' 已停止，请截图此提示。');
      }
      return;
    }
    if (v && v !== video) { video = v; attempted = ''; }
    if (video?.ended) finished();
    if (video && !video.ended && video.readyState >= 1 && attempted !== video.currentSrc) {
      attempted = video.currentSrc; play(video);
    }
  }, 1000);
  updateDiagnostic(mainVideo(true));
  say(config && config.url === location.href ? '已恢复目录设置。点击“开启连播”。' : '首次使用：先展开左侧章节，再点击“指定目录”。');
})();
