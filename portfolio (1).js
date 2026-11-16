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
  var BAR_COUNT = 80;             // number of bars in each visualiser
  var BAR_COLOR = '#ffffff';      // bar colour
  var IDLE_LEVEL = 0.06;          // bar height when paused

  // ---------- STATE ----------
  var items = [];
  var current = null;
  var audioCtx = null;
  var scApiPromise = null;
  var views = {};
  var links = [];
  var root = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ---------- CANVAS ----------
  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 200;
    var h = canvas.clientHeight || 56;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: c, w: w, h: h };
  }

  // A fixed, uneven shape so the resting state reads as a waveform, not a row of dashes
  function makeShape(n, seed) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var v = Math.abs(Math.sin(i * 0.61 + seed * 1.7) * Math.cos(i * 0.23 + seed * 0.4));
      out.push(0.12 + 0.5 * v * v + 0.08 * Math.abs(Math.sin(i * 1.3)));
    }
    return out;
  }

  // ---------- AUDIO PREVIEW SETUP ----------
  function initAudio(box) {
    var type = box.getAttribute('data-type');
    var src = box.getAttribute('data-src');
    var button = box.querySelector('button');
    var canvas = box.querySelector('canvas');
    if (!button || !canvas) return;

    var sh = makeShape(BAR_COUNT, items.length);
    var item = {
      box: box, button: button, canvas: canvas,
      type: type, src: src,
      playing: false, shape: sh, levels: sh.slice(),
      audio: null, analyser: null, widget: null, iframe: null,
      play: null, pause: null, size: null
    };
    items.push(item);
    item.size = setupCanvas(canvas);

    if (!src || !type) { button.disabled = true; return; }
    button.disabled = false;

    if (type === 'file') setupFile(item);
    else if (type === 'soundcloud') setupSoundCloud(item);
    else { button.disabled = true; return; }

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (item.playing) item.pause(); else item.play();
    });
    canvas.addEventListener('click', function () {
      if (item.playing) item.pause(); else item.play();
    });
  }

  // ---------- FILE MODE (real audio reaction) ----------
  function setupFile(item) {
    var audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.src = item.src;
    item.audio = audio;

    audio.addEventListener('ended', function () { stopItem(item); });

    item.play = function () {
      if (current && current !== item) current.pause();
      var ctx = ensureAudioCtx();
      if (ctx && !item.analyser) {
        try {
          var source = ctx.createMediaElementSource(audio);
          item.analyser = ctx.createAnalyser();
          item.analyser.fftSize = 128;
          source.connect(item.analyser);
          item.analyser.connect(ctx.destination);
        } catch (err) { item.analyser = null; }
      }
      audio.play();
      item.playing = true;
      item.button.textContent = '❚❚';
      current = item;
    };
    item.pause = function () { audio.pause(); stopItem(item); };
  }

  // ---------- SOUNDCLOUD MODE (animation follows play state, not the sound) ----------
  function loadScApi() {
    if (scApiPromise) return scApiPromise;
    scApiPromise = new Promise(function (resolve, reject) {
      if (window.SC && window.SC.Widget) return resolve();
      var s = document.createElement('script');
      s.src = 'https://w.soundcloud.com/player/api.js';
      s.onload = function () { resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return scApiPromise;
  }

  function setupSoundCloud(item) {
    var iframe = document.createElement('iframe');
    iframe.className = 'cw-sc';
    iframe.setAttribute('allow', 'autoplay');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(item.src) +
      '&auto_play=false&visual=false&show_artwork=false&show_user=false&show_comments=false&show_reposts=false&show_teaser=false&hide_related=true';
    item.box.appendChild(iframe);
    item.iframe = iframe;

    loadScApi().then(function () {
      item.widget = window.SC.Widget(iframe);
      item.widget.bind(window.SC.Widget.Events.PLAY, function () {
        if (current && current !== item) current.pause();
        item.playing = true;
        item.button.textContent = '❚❚';
        current = item;
      });
      item.widget.bind(window.SC.Widget.Events.PAUSE, function () { stopItem(item); });
      item.widget.bind(window.SC.Widget.Events.FINISH, function () { stopItem(item); });
    }).catch(function () { /* SoundCloud API blocked; the player button stays disabled */ });

    item.play = function () { if (item.widget) item.widget.play(); };
    item.pause = function () { if (item.widget) { item.widget.pause(); } stopItem(item); };
  }

  function stopItem(item) {
    item.playing = false;
    item.button.textContent = '▶';
    if (current === item) current = null;
  }

  // ---------- DRAW LOOP ----------
  var t = 0;
  function frame() {
    requestAnimationFrame(frame);
    t += 0.05;
    items.forEach(function (item) {
      try { drawItem(item); } catch (err) { /* keep the other waveforms running */ }
    });
  }

  function drawItem(item) {
    {
      if (!item.size) return;
      var c = item.size.ctx, w = item.size.w, h = item.size.h;
      c.clearRect(0, 0, w, h);

      var target = new Array(BAR_COUNT);
      if (item.playing && item.analyser) {
        var data = new Uint8Array(item.analyser.frequencyBinCount);
        item.analyser.getByteFrequencyData(data);
        for (var i = 0; i < BAR_COUNT; i++) {
          var idx = Math.floor((i / BAR_COUNT) * data.length);
          target[i] = Math.max(0.1, data[idx] / 255);
        }
      } else if (item.playing) {
        for (var j = 0; j < BAR_COUNT; j++) {
          target[j] = item.shape[j] * (0.55 + 0.45 * Math.abs(Math.sin(t * 2 + j * 0.5)));
        }
      } else {
        for (var k = 0; k < BAR_COUNT; k++) target[k] = item.shape[k];
      }

      for (var m = 0; m < BAR_COUNT; m++) {
        item.levels[m] += (target[m] - item.levels[m]) * 0.25;
      }

      var slot = w / BAR_COUNT, bw = 2;
      c.fillStyle = item.playing ? '#ffffff' : '#5a5a5a';
      for (var n = 0; n < BAR_COUNT; n++) {
        var bh = Math.max(2, item.levels[n] * h);
        c.fillRect(n * slot + (slot - bw) / 2, (h - bh) / 2, bw, bh);
      }
    }
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
    // Canvases in a hidden view measure as zero, so re-measure once shown.
    items.forEach(function (item) {
      if (target.contains(item.box)) item.size = setupCanvas(item.canvas);
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
      viewId = 'home';
      scrollTo = document.getElementById(hash);
    } else if (views[hash]) {
      viewId = hash;
    }

    var target = showView(viewId);
    root.classList.toggle('is-home', viewId === 'home');
    var big = root.querySelector('.cw-big-name');
    if (big) big.style.setProperty('display', viewId === 'home' ? 'block' : 'none', 'important');
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

    route();

    // Each waveform is set up on its own, so one failure can't stop the others.
    root.querySelectorAll('.cw-audio').forEach(function (box) {
      try { initAudio(box); } catch (err) { if (window.console) console.error('Audio setup failed:', err); }
    });

    window.addEventListener('hashchange', route);
    window.addEventListener('resize', fitSub);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSub);
    window.addEventListener('resize', function () {
      items.forEach(function (item) {
        if (item.box.closest('.cw-view.is-active')) item.size = setupCanvas(item.canvas);
      });
    });

    requestAnimationFrame(frame);
  }

  poll();
})();
