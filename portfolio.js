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
  var BAR_COUNT = 80;             // bars per waveform
  var PLAYED = '#ffffff';         // bars already played
  var UNPLAYED = '#5a5a5a';       // bars still to play

  // ---------- STATE ----------
  var root = null;
  var views = {};
  var links = [];
  var items = [];                 // audio snippets
  var carousels = [];             // photo carousels
  var current = null;             // the snippet playing now
  var decodeCtx = null;

  // ---------- WAVEFORM ----------
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
    var AC = window.AudioContext || window.webkitAudioContext;
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
        // normalise, and lift quiet passages so the shape stays readable
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

  function initAudio(box) {
    var src = box.getAttribute('data-src');
    var button = box.querySelector('button');
    var canvas = box.querySelector('canvas');
    if (!src || !button || !canvas) return;

    var audio = new Audio();
    audio.preload = 'none';
    audio.src = src;

    var item = {
      box: box, button: button, canvas: canvas, src: src, audio: audio,
      shape: makeShape(BAR_COUNT, items.length + 1), peaks: null,
      requested: false, playing: false, ratio: 0, pendingSeek: null
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

  function play(item) {
    if (current && current !== item) pause(current);
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

  // ---------- DRAW LOOP ----------
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

  function frame() {
    requestAnimationFrame(frame);
    items.forEach(function (item) {
      try { drawItem(item); } catch (err) { /* keep the others drawing */ }
    });
  }

  // ---------- CAROUSELS ----------
  function setupCarousel(c) {
    var track = c.querySelector('.cw-track');
    var prev = c.querySelector('.cw-prev');
    var next = c.querySelector('.cw-next');
    var count = c.querySelector('.cw-count');
    if (!track || !prev || !next) return;

    function step() {
      var first = track.firstElementChild;
      return first ? first.offsetWidth + 12 : 0;
    }
    function update() {
      var n = track.children.length;
      var idx = step() ? Math.round(track.scrollLeft / step()) : 0;
      if (count) count.textContent = n ? (Math.min(idx, n - 1) + 1) + ' / ' + n : '';
      prev.disabled = n <= 1 || track.scrollLeft <= 4;
      next.disabled = n <= 1 || track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    }
    prev.addEventListener('click', function () { track.scrollBy({ left: -step(), behavior: 'smooth' }); });
    next.addEventListener('click', function () { track.scrollBy({ left: step(), behavior: 'smooth' }); });
    track.addEventListener('scroll', update, { passive: true });
    carousels.push({ el: c, update: update });
    update();
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
    carousels.forEach(function (c) {
      if (target.contains(c.el)) c.update();
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
    root.querySelectorAll('.cw-carousel').forEach(function (c) {
      try { setupCarousel(c); } catch (err) { if (window.console) console.error('Carousel setup failed:', err); }
    });
    try { setupFilters(); } catch (err) { if (window.console) console.error('Filter setup failed:', err); }

    route();

    window.addEventListener('hashchange', route);
    window.addEventListener('resize', fitSub);
    window.addEventListener('resize', function () { carousels.forEach(function (c) { c.update(); }); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSub);

    requestAnimationFrame(frame);
  }

  poll();
})();
