(function () {
  // The script waits for the page markup, so it works whether Carrd runs it before or after the markup.
  var tries = 0;
  function poll() {
    var root = document.getElementById('cw-portfolio');
    if (root) {
      try { start(root); } catch (err) { if (window.console) console.error('Portfolio script error:', err); }
    } else if (++tries < 200) {
      setTimeout(poll, 50);
    }
  }

  // ---------- CONFIG ----------
  var BAR_COUNT = 80;             // bars per snippet waveform
  var PLAYED = '#ffffff';         // waveform bars already played
  var UNPLAYED = '#5a5a5a';       // waveform bars still to play
  var EQ_STEP = 5;                // header equaliser: distance between bars in px
  var EQ_BAR = 2;                 // header equaliser: bar width in px
  var EQ_HEIGHT = 14;             // header equaliser: how far bars hang below the header line

  // ---------- STATE ----------
  var root = null;
  var views = {};
  var links = [];
  var items = [];                 // audio snippets
  var loops = [];                 // infinite photo galleries
  var current = null;             // the snippet playing now
  var decodeCtx = null;
  var playCtx = null;
  var eq = null;                  // header equaliser
  var clock = 0;

  // ---------- AUDIO CONTEXT ----------
  function getAudioClass() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function ensurePlayCtx() {
    var AC = getAudioClass();
    if (!AC) return null;
    if (!playCtx) playCtx = new AC();
    if (playCtx.state === 'suspended') playCtx.resume();
    return playCtx;
  }

  // Fallback shape, used only if a snippet can't be decoded
  function makeShape(n, seed) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var v = Math.abs(Math.sin(i * 0.61 + seed * 1.7) * Math.cos(i * 0.23 + seed * 0.4));
      out.push(0.12 + 0.5 * v * v + 0.08 * Math.abs(Math.sin(i * 1.3)));
    }
    return out;
  }

  function setupCanvas(item) {
    var dpr = window.devicePixelRatio || 1;
    var w = item.canvas.clientWidth || 300;
    var h = item.canvas.clientHeight || 56;
    item.canvas.width = Math.round(w * dpr);
    item.canvas.height = Math.round(h * dpr);
    var c = item.canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    item.ctx = c;
    item.w = w;
    item.h = h;
  }

  // Reads the real sound of the snippet and turns it into bar heights
  function loadPeaks(item) {
    if (item.requested) return;
    item.requested = true;
    var AC = getAudioClass();
    if (!AC || !window.fetch) { item.peaks = item.shape; return; }
    decodeCtx = decodeCtx || new AC();
    fetch(item.src)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) { return decodeCtx.decodeAudioData(buf); })
      .then(function (audioBuf) {
        var data = audioBuf.getChannelData(0);
        var step = Math.max(1, Math.floor(data.length / BAR_COUNT));
        var peaks = [], top = 0;
        for (var i = 0; i < BAR_COUNT; i++) {
          var max = 0, start = i * step, end = Math.min(data.length, start + step);
          for (var k = start; k < end; k++) {
            var a = Math.abs(data[k]);
            if (a > max) max = a;
          }
          peaks.push(max);
          if (max > top) top = max;
        }
        for (var m = 0; m < peaks.length; m++) {
          peaks[m] = top ? Math.max(0.08, Math.pow(peaks[m] / top, 0.7)) : 0.08;
        }
        item.peaks = peaks;
        item.canvas.setAttribute('data-wave', 'decoded');
      })
      .catch(function () {
        item.peaks = item.shape;
        item.canvas.setAttribute('data-wave', 'fallback');
      });
  }

  // ---------- SNIPPET PLAYERS ----------
  function initAudio(box) {
    var src = box.getAttribute('data-src');
    var button = box.querySelector('button');
    var canvas = box.querySelector('canvas');
    if (!src || !button || !canvas) return;

    var audio = new Audio();
    audio.crossOrigin = 'anonymous';   // lets the header equaliser read the sound
    audio.preload = 'none';
    audio.src = src;

    var item = {
      box: box, button: button, canvas: canvas, src: src, audio: audio,
      shape: makeShape(BAR_COUNT, items.length + 1), peaks: null,
      requested: false, playing: false, ratio: 0, pendingSeek: null,
      analyser: null, data: null
    };
    items.push(item);
    setupCanvas(item);
    button.disabled = false;

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (item.playing) pause(item); else play(item);
    });
    canvas.addEventListener('click', function (e) { seek(item, e); });

    audio.addEventListener('timeupdate', function () {
      if (audio.duration) item.ratio = audio.currentTime / audio.duration;
    });
    audio.addEventListener('loadedmetadata', function () {
      if (item.pendingSeek !== null && audio.duration) {
        audio.currentTime = item.pendingSeek * audio.duration;
        item.pendingSeek = null;
      }
    });
    audio.addEventListener('ended', function () {
      audio.currentTime = 0;
      item.ratio = 0;
      stop(item);
    });
  }

  // Connects the snippet to an analyser, once, so the header can read its sound
  function connectAnalyser(item) {
    if (item.analyser || item.analyserFailed) return;
    try {
      var ctx = ensurePlayCtx();
      if (!ctx) { item.analyserFailed = true; return; }
      var source = ctx.createMediaElementSource(item.audio);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      item.analyser = analyser;
      item.data = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      item.analyserFailed = true;
    }
  }

  function play(item) {
    if (current && current !== item) pause(current);
    connectAnalyser(item);
    var p = item.audio.play();
    if (p && p.catch) p.catch(function () { stop(item); });
    item.playing = true;
    item.button.textContent = '❚❚';
    current = item;
  }

  function pause(item) {
    item.audio.pause();
    stop(item);
  }

  function stop(item) {
    item.playing = false;
    item.button.textContent = '▶';
    if (current === item) current = null;
  }

  function seek(item, e) {
    var rect = item.canvas.getBoundingClientRect();
    var r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    item.ratio = r;
    if (item.audio.duration) {
      item.audio.currentTime = r * item.audio.duration;
    } else {
      item.pendingSeek = r;
    }
    if (!item.playing) play(item);
  }

  function drawItem(item) {
    if (!item.canvas.offsetParent) return;           // hidden view: nothing to draw
    if (item.canvas.clientWidth !== item.w || item.canvas.clientHeight !== item.h) setupCanvas(item);
    var c = item.ctx, w = item.w, h = item.h;
    var bars = item.peaks || item.shape;
    c.clearRect(0, 0, w, h);
    var slot = w / BAR_COUNT, bw = Math.max(2, Math.floor(slot * 0.6));
    for (var i = 0; i < BAR_COUNT; i++) {
      var bh = Math.max(2, bars[i] * h);
      var played = (i + 0.5) / BAR_COUNT <= item.ratio;
      c.fillStyle = played ? PLAYED : UNPLAYED;
      c.fillRect(i * slot + (slot - bw) / 2, (h - bh) / 2, bw, bh);
    }
  }

  // ---------- HEADER EQUALISER ----------
  // Bars hang down from the header line. They only move while a snippet is playing.
  function setupEq() {
    var canvas = root.querySelector('.cw-eq canvas');
    if (!canvas) return;
    eq = { canvas: canvas, ctx: canvas.getContext('2d'), levels: [], cleared: false };
    sizeEq();
  }

  function sizeEq() {
    if (!eq) return;
    var dpr = window.devicePixelRatio || 1;
    var w = eq.canvas.clientWidth || window.innerWidth;
    var h = eq.canvas.clientHeight || EQ_HEIGHT;
    eq.canvas.width = Math.round(w * dpr);
    eq.canvas.height = Math.round(h * dpr);
    eq.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    eq.w = w;
    eq.h = h;
    eq.count = Math.max(1, Math.floor(w / EQ_STEP));
    eq.levels = new Array(eq.count).fill(0);
  }

  // The level for one bar, taken from the live sound if we have it, otherwise from the decoded peaks
  function eqLevel(item, i) {
    var live = 0;
    if (item.analyser && item.data) {
      var bins = item.data.length;
      var bin = Math.min(bins - 1, Math.floor(Math.pow(bins * 0.5, i / eq.count)));
      live = item.data[bin] / 255;
    }
    var shape = 0;
    if (item.peaks) {
      var idx = Math.floor(item.ratio * BAR_COUNT);
      var wobble = 0.55 + 0.45 * Math.abs(Math.sin(clock * 3 + i * 0.7));
      shape = item.peaks[(idx + i * 3) % BAR_COUNT] * wobble;
    }
    return Math.max(live, shape);
  }

  function drawEq() {
    if (!eq) return;
    if (current && current.analyser && current.data) {
      current.analyser.getByteFrequencyData(current.data);
    }
    var any = false;
    for (var i = 0; i < eq.count; i++) {
      var target = current ? eqLevel(current, i) : 0;
      var rate = target > eq.levels[i] ? 0.5 : 0.12;   // quick rise, slow fall
      eq.levels[i] += (target - eq.levels[i]) * rate;
      if (eq.levels[i] > 0.01) any = true;
    }
    if (!current && !any) {
      if (!eq.cleared) { eq.ctx.clearRect(0, 0, eq.w, eq.h); eq.cleared = true; }
      return;
    }
    eq.cleared = false;
    var c = eq.ctx;
    c.clearRect(0, 0, eq.w, eq.h);
    c.fillStyle = 'rgba(255,255,255,0.75)';
    for (var k = 0; k < eq.count; k++) {
      var bh = eq.levels[k] * eq.h;
      if (bh < 1) continue;
      c.fillRect(k * EQ_STEP, 0, EQ_BAR, bh);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    clock += 0.016;
    items.forEach(function (item) {
      try { drawItem(item); } catch (err) { /* keep the others drawing */ }
    });
    try { drawEq(); } catch (err) { /* the header equaliser is decoration only */ }
  }

  // ---------- INFINITE GALLERY ----------
  // The photos are laid out three times over: copies, the originals, copies. When the reader
  // scrolls into a copy, the view jumps by one full set, so it never runs out in either direction.
  function setupLoop(el) {
    var track = el.querySelector('.cw-loop-track');
    if (!track) return null;
    var originals = Array.prototype.slice.call(track.children);
    var n = originals.length;
    var loop = { el: el, track: track, n: n, setW: 0, step: 0, inited: false };
    if (n < 2) {
      var ctrls = el.querySelector('.cw-ctrls');
      if (ctrls) ctrls.style.display = 'none';
      return loop;
    }
    var before = originals.map(function (x) { return x.cloneNode(true); });
    for (var j = before.length - 1; j >= 0; j--) track.insertBefore(before[j], track.firstChild);
    originals.forEach(function (x) { track.appendChild(x.cloneNode(true)); });

    loop.prev = el.querySelector('.cw-prev');
    loop.next = el.querySelector('.cw-next');
    loop.count = el.querySelector('.cw-count');

    loop.measure = function () {
      var kids = track.children;
      if (kids.length < 2 * n + 1) return;
      loop.setW = kids[2 * n].offsetLeft - kids[n].offsetLeft;
      var gap = parseFloat(getComputedStyle(track).columnGap) || 12;
      loop.step = kids[n].offsetWidth + gap;
    };
    loop.reset = function () {
      loop.measure();
      if (loop.setW) {
        track.scrollLeft = loop.setW;   // start on the originals
        loop.inited = true;
      }
      loop.update();
    };
    loop.update = function () {
      if (!loop.setW || !loop.count) return;
      var x = track.scrollLeft;
      if (x < loop.setW * 0.5) { track.scrollLeft = x + loop.setW; x += loop.setW; }
      else if (x > loop.setW * 1.5) { track.scrollLeft = x - loop.setW; x -= loop.setW; }
      var offset = ((x - loop.setW) % loop.setW + loop.setW) % loop.setW;
      var idx = loop.step ? Math.round(offset / loop.step) % n : 0;
      loop.count.textContent = (idx + 1) + ' / ' + n;
    };

    if (loop.prev) loop.prev.addEventListener('click', function () {
      track.scrollBy({ left: -loop.step, behavior: 'smooth' });
    });
    if (loop.next) loop.next.addEventListener('click', function () {
      track.scrollBy({ left: loop.step, behavior: 'smooth' });
    });
    track.addEventListener('scroll', loop.update, { passive: true });
    return loop;
  }

  // ---------- FILTER: films by role ----------
  function setupFilters() {
    root.querySelectorAll('.cw-filters').forEach(function (bar) {
      var section = bar.closest('.cw-view');
      var buttons = bar.querySelectorAll('.cw-filter');
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          var role = b.getAttribute('data-role');
          buttons.forEach(function (x) {
            var on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          section.querySelectorAll('.cw-item[data-roles]').forEach(function (card) {
            var roles = card.getAttribute('data-roles').split('|');
            card.hidden = !(role === 'all' || roles.indexOf(role) > -1);
          });
        });
      });
    });
  }

  // ---------- ROUTING: one view at a time, driven by the URL hash ----------
  function headerHeight() {
    var h = root.querySelector('.cw-header');
    return h ? h.offsetHeight : 64;
  }

  function showView(id) {
    var target = views[id] || views['home'];
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('is-active', views[k] === target);
    });
    items.forEach(function (item) {
      if (target.contains(item.box)) {
        setupCanvas(item);
        loadPeaks(item);
      }
    });
    loops.forEach(function (loop) {
      if (loop && target.contains(loop.el)) loop.reset();
    });
    return target;
  }

  function fitSub() {
    if (!root) return;
    var theo = root.querySelector('.cw-big-theo');
    var sub = root.querySelector('.cw-big-sub');
    if (!theo || !sub) return;
    sub.style.fontSize = '100px';
    var target = theo.getBoundingClientRect().width;
    var natural = sub.getBoundingClientRect().width;
    if (target && natural) sub.style.fontSize = (100 * target / natural) + 'px';
  }

  function route() {
    var hash = decodeURIComponent((location.hash || '').replace('#', ''));
    var scrollTo = null;
    var viewId = 'home';

    if (hash === 'showreel' || hash === 'selected') {
      scrollTo = document.getElementById(hash);
    } else if (views[hash]) {
      viewId = hash;
    }

    var target = showView(viewId);
    root.classList.toggle('is-home', viewId === 'home');
    fitSub();
    var cat = scrollTo ? 'showreel' : (target.getAttribute('data-cat') || 'showreel');
    links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('data-cat') === cat); });

    if (scrollTo) {
      var y = scrollTo.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - headerHeight();
      root.scrollTo(0, Math.max(0, y));
    } else {
      root.scrollTo(0, 0);
    }
  }

  function start(rootEl) {
    root = rootEl;
    root.classList.add('cw-js');

    root.querySelectorAll('.cw-view').forEach(function (v) { views[v.id] = v; });
    links = Array.prototype.slice.call(root.querySelectorAll('.cw-nav a'));

    // Each piece is set up on its own, so one failure can't stop the others.
    root.querySelectorAll('.cw-audio').forEach(function (box) {
      try { initAudio(box); } catch (err) { if (window.console) console.error('Audio setup failed:', err); }
    });
    root.querySelectorAll('.cw-loop').forEach(function (el) {
      try { loops.push(setupLoop(el)); } catch (err) { if (window.console) console.error('Gallery setup failed:', err); }
    });
    try { setupFilters(); } catch (err) { if (window.console) console.error('Filter setup failed:', err); }
    try { setupEq(); } catch (err) { if (window.console) console.error('Equaliser setup failed:', err); }

    route();

    window.addEventListener('hashchange', route);
    window.addEventListener('resize', fitSub);
    window.addEventListener('resize', function () {
      sizeEq();
      loops.forEach(function (loop) { if (loop) loop.reset(); });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSub);

    requestAnimationFrame(frame);
  }

  poll();
})();
