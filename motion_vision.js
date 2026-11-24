// MOTION BREAK 웹: 카메라 + 신체 인식 컨트롤러.
// Flutter 앱의 VisionChannel(웹 구현, lib/core/vision/backend/web_vision_backend.dart)이 window.motionVision 을 부른다.
// 안드로이드 네이티브(VisionController.kt)와 같은 이벤트를 보낸다:
//   {type:'frame', ts, lat, inf, w, h, front, rx, skip, done, delegate, n, lm:Float32Array, wl:Float32Array}
//   {type:'status', kind:'camera'|'engine'|'error', ...}
// 영상은 이 기기 안에서만 처리되고 어디에도 전송·저장되지 않는다.
(function () {
  'use strict';

  const DEFAULTS = { frontCamera: true, mirror: 'auto', maxPoses: 1, model: 'lite', useGpu: true, maxInferenceFps: 0, analysisLongSide: 640 };
  let cfg = Object.assign({}, DEFAULTS);

  let stream = null;
  let front = true; // 지금 카메라가 전면인지(좌우 반전 여부)
  let requestedFront = null; // 지금 열린 카메라를 열 때 요청한 방향
  let running = false;
  let scheduled = false;
  let busy = false;
  let lastSent = 0;
  let rx = 0, skip = 0, done = 0;

  let worker = null; // null: 아직, false: 못 씀(화면 스레드에서 인식)
  let pendingInit = null;
  let engineReady = false;
  let engineDelegate = '?';
  let wakeLock = null;

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.autoplay = true;
  Object.assign(video.style, {
    width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000', pointerEvents: 'none',
  });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const api = { onEvent: null };

  // ------------------------------------------------------------------ 알림

  function emit(o) {
    const f = api.onEvent;
    if (typeof f !== 'function') return;
    try { f(o); } catch (e) { console.error('[motionVision] onEvent', e); }
  }

  function status(kind, data) {
    emit(Object.assign({ type: 'status', kind: kind }, data || {}));
  }

  function friendly(e) {
    const n = e && e.name;
    if (!window.isSecureContext || !navigator.mediaDevices) return 'https 주소에서만 카메라를 쓸 수 있습니다.';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return '카메라 권한이 거부되었습니다. 주소창 왼쪽 자물쇠(사이트 설정)에서 카메라를 허용한 뒤 다시 시도해 주세요.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '카메라를 찾지 못했습니다.';
    if (n === 'NotReadableError' || n === 'AbortError') return '다른 앱이나 탭이 카메라를 쓰고 있습니다. 닫고 다시 시도해 주세요.';
    return (e && e.message) ? String(e.message) : String(e);
  }

  // ------------------------------------------------------------------ 카메라

  /** 좌우 반전: auto = 전면만 거울, on = 항상, off = 안 함(빔프로젝터 등에서 방향이 반대일 때) */
  function effectiveMirror() {
    if (cfg.mirror === 'on') return true;
    if (cfg.mirror === 'off') return false;
    return front;
  }

  function applyMirror() {
    video.style.transform = effectiveMirror() ? 'scaleX(-1)' : 'none';
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    requestedFront = null;
    video.srcObject = null;
  }

  function waitFor(cond, ms) {
    return new Promise(function (resolve) {
      const t0 = performance.now();
      (function tick() {
        if (cond() || performance.now() - t0 > ms) resolve();
        else setTimeout(tick, 30);
      })();
    });
  }

  function analysisSize() {
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const L = Math.max(160, cfg.analysisLongSide || 640);
    const k = Math.min(1, L / Math.max(vw, vh));
    return [Math.max(2, Math.round(vw * k)), Math.max(2, Math.round(vh * k))];
  }

  async function openCamera(wantFront) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(friendly(null));
    }
    stopStream();
    const facing = wantFront ? 'user' : 'environment';
    const tries = [
      { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } },
      { audio: false, video: { facingMode: { ideal: facing } } },
      { audio: false, video: true },
    ];
    let last = null;
    for (const c of tries) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        last = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
      }
    }
    if (!stream) throw last || new Error('camera');
    requestedFront = wantFront;
    const track = stream.getVideoTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    // 노트북 웹캠처럼 방향 정보가 없으면 요청한 방향으로 본다
    front = s.facingMode ? s.facingMode !== 'environment' : wantFront;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 소리 없는 영상이라 보통 바로 재생됨 */ }
    await waitFor(function () { return video.videoWidth > 0; }, 5000);
    applyMirror();
    const a = analysisSize();
    status('camera', { previewW: video.videoWidth, previewH: video.videoHeight, analysisW: a[0], analysisH: a[1] });
  }

  async function cameraCount() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(function (d) { return d.kind === 'videoinput'; }).length;
    } catch (e) {
      return 1;
    }
  }

  // ------------------------------------------------------------------ 인식 엔진

  function engineConfig() {
    return {
      model: cfg.model === 'full' ? 'full' : 'lite',
      maxPoses: Math.max(1, Math.min(4, (cfg.maxPoses | 0) || 1)),
      useGpu: cfg.useGpu !== false,
    };
  }

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = src;
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error(src + ' 를 불러오지 못했습니다')); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  function workerInit(ec) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pendingInit = null;
        reject(new Error('워커 응답 없음'));
      }, 120000);
      pendingInit = {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); },
      };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        const p = pendingInit;
        pendingInit = null;
        if (p) p.reject(new Error((e && e.message) || '워커 오류'));
      };
      worker.postMessage({ cmd: 'init', cfg: ec });
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data || {};
    if (m.type === 'result') {
      busy = false;
      deliver(m, m.ts, m.mirror, m.w, m.h);
    } else if (m.type === 'frameError') {
      busy = false;
    } else if (m.type === 'engine') {
      const p = pendingInit;
      pendingInit = null;
      if (p) p.resolve(m);
    } else if (m.type === 'engineError') {
      const p = pendingInit;
      pendingInit = null;
      if (p) p.reject(new Error(m.message));
    }
  }

  async function initEngine() {
    const ec = engineConfig();
    engineReady = false;
    let info = null;
    const canUseWorker = worker !== false && typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
    if (canUseWorker) {
      try {
        if (!worker) {
          worker = new Worker('motion_pose_worker.js');
          worker.onmessage = onWorkerMessage;
        }
        info = await workerInit(ec);
      } catch (e) {
        console.warn('[motionVision] 워커 인식을 못 써서 화면 스레드에서 인식합니다:', e);
        try { if (worker) worker.terminate(); } catch (_) { /* 무시 */ }
        worker = false;
      }
    } else {
      worker = false;
    }
    if (!info) {
      await loadScript('mediapipe/vision_bundle.js');
      await loadScript('motion_pose_engine.js');
      info = await window.MotionPoseEngine.init(ec, new URL('./', document.baseURI).href);
    }
    engineDelegate = info.delegate + (worker ? '·웹' : '·웹(단일)');
    engineReady = true;
    busy = false;
    status('engine', { delegate: engineDelegate, model: info.model });
    if (info.gpuError) console.warn('[motionVision] GPU 사용 불가 → CPU:', info.gpuError);
  }

  // ------------------------------------------------------------------ 프레임 처리

  function schedule() {
    if (!running || scheduled) return;
    scheduled = true;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
  }

  function onFrame() {
    scheduled = false;
    if (!running) return;
    rx++;
    const now = performance.now();
    const minGap = cfg.maxInferenceFps > 0 ? 1000 / cfg.maxInferenceFps : 0;
    if (!engineReady || busy || video.readyState < 2 || video.videoWidth === 0 || now - lastSent < minGap) {
      skip++;
      schedule();
      return;
    }
    busy = true;
    lastSent = now;
    const size = analysisSize();
    const w = size[0], h = size[1];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const ts = now, mirror = effectiveMirror();
    if (worker) {
      createImageBitmap(canvas).then(function (bmp) {
        if (!worker || !running) {
          bmp.close();
          busy = false;
          return;
        }
        worker.postMessage({ cmd: 'frame', bitmap: bmp, ts: ts, mirror: mirror, w: w, h: h }, [bmp]);
      }).catch(function (e) {
        busy = false;
        status('error', { message: '프레임 복사 실패: ' + e });
      });
    } else {
      try {
        deliver(window.MotionPoseEngine.detect(canvas, ts, mirror), ts, mirror, w, h);
      } catch (e) {
        status('error', { message: String((e && e.message) || e) });
      } finally {
        busy = false;
      }
    }
    schedule();
  }

  function deliver(r, ts, mirror, w, h) {
    done++;
    emit({
      type: 'frame',
      ts: Math.round(ts),
      lat: Math.round(performance.now() - ts),
      inf: Math.round(r.inf),
      w: w, h: h, front: !!mirror,
      rx: rx, skip: skip, done: done,
      delegate: engineDelegate,
      n: r.n, lm: r.lm, wl: r.wl,
    });
  }

  // 영상이 화면에서 잠깐 떨어지면 브라우저가 멈추는 경우가 있어 주기적으로 다시 재생·예약
  setInterval(function () {
    if (!running) return;
    if (video.srcObject && video.paused) video.play().catch(function () {});
    if (!scheduled) schedule();
  }, 500);

  async function keepScreenOn(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }

  // ------------------------------------------------------------------ Flutter 에서 부르는 함수

  api.hasPermission = async function () {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const r = await navigator.permissions.query({ name: 'camera' });
        return r.state === 'granted';
      }
    } catch (e) { /* 지원 안 함 */ }
    return false;
  };

  /** 카메라를 열어 허락을 받는다(열린 카메라는 start 에서 그대로 씀) */
  api.requestPermission = async function () {
    try {
      if (!stream) await openCamera(!!cfg.frontCamera);
      return true;
    } catch (e) {
      status('error', { message: friendly(e) });
      return false;
    }
  };

  /** @return '' = 성공, 아니면 오류 문장 */
  api.start = async function (c) {
    cfg = Object.assign({}, DEFAULTS, c || {});
    try {
      if (!stream || requestedFront !== !!cfg.frontCamera) await openCamera(!!cfg.frontCamera);
      await initEngine(); // 이미 준비됐으면 사람 수·모델만 맞추고 바로 끝남
      rx = 0; skip = 0; done = 0; busy = false;
      running = true;
      schedule();
      keepScreenOn(true);
      return '';
    } catch (e) {
      return friendly(e);
    }
  };

  api.stop = async function () {
    running = false;
    stopStream();
    keepScreenOn(false);
  };

  /** @return 바꾼 뒤 전면 카메라인지 */
  api.switchCamera = async function () {
    const want = !front;
    if ((await cameraCount()) < 2) {
      status('error', { message: '이 기기에는 카메라가 하나뿐입니다' });
      return front;
    }
    try {
      await openCamera(want);
    } catch (e) {
      status('error', { message: friendly(e) });
      try { await openCamera(!want); } catch (_) { /* 무시 */ }
    }
    cfg.frontCamera = front;
    return front;
  };

  api.updateConfig = async function (c) {
    cfg = Object.assign({}, cfg, c || {});
    applyMirror();
    try {
      if (stream && requestedFront !== !!cfg.frontCamera) await openCamera(!!cfg.frontCamera);
      await initEngine();
      return '';
    } catch (e) {
      return friendly(e);
    }
  };

  /** Flutter 화면(HtmlElementView)에 넣을 미리보기. 하나뿐인 video 를 새 자리로 옮긴다 */
  api.createPreview = function () {
    const holder = document.createElement('div');
    Object.assign(holder.style, { width: '100%', height: '100%', overflow: 'hidden', background: '#000', pointerEvents: 'none' });
    holder.appendChild(video);
    if (video.srcObject) video.play().catch(function () {});
    return holder;
  };

  /** 휴대폰: 전체 화면 + 가로 고정(브라우저가 허락할 때만) */
  api.fullscreen = function () {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' }).then(function () {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape').catch(function () {});
    }).catch(function () {});
  };

  // 휴대폰·태블릿은 처음 화면을 누를 때 한 번 전체 화면으로
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    window.addEventListener('pointerup', function () { api.fullscreen(); }, { once: true, passive: true });
  }

  // Flutter 첫 화면이 그려지면 "불러오는 중" 표시를 치운다
  window.addEventListener('flutter-first-frame', function () {
    const el = document.getElementById('mb-loading');
    if (el) el.remove();
  });

  /** 문제 확인용(개발자 도구 콘솔에서 motionVision.stats()) */
  api.stats = function () {
    return {
      running: running, engineReady: engineReady, delegate: engineDelegate, worker: !!worker,
      front: front, rx: rx, skip: skip, done: done,
      video: video.videoWidth + 'x' + video.videoHeight, paused: video.paused, inDocument: video.isConnected,
    };
  };

  window.motionVision = api;
})();
