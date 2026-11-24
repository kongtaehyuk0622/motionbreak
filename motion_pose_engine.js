// MOTION BREAK 웹: MediaPipe 신체 인식 엔진(웹 워커와 화면 스레드에서 같이 쓰는 코드).
// 결과 형식은 안드로이드 VisionController 와 같다:
//   사람마다 33관절 × (x, y, z, visibility, presence), 월드 좌표 33 × (x, y, z)
//   전면 카메라는 x 를 좌우 반전(화면이 거울처럼 보이므로) — 월드 x 도 함께 반전.
(function (g) {
  'use strict';

  let landmarker = null;
  let key = '';
  let delegate = '?';
  let fileset = null;
  let lastTs = -1;
  let base = '';

  function url(path) {
    return new URL(path, base).href;
  }

  /** ec: {model:'lite'|'full', maxPoses:n, useGpu:bool}, baseUrl: 웹 앱 주소(끝이 /) */
  async function init(ec, baseUrl) {
    base = baseUrl;
    const V = g.Vision;
    if (!V) throw new Error('MediaPipe(vision_bundle.js)를 불러오지 못했습니다');
    const want = ec.model + '|' + ec.maxPoses + '|' + ec.useGpu;
    if (landmarker && key === want) return { delegate: delegate, model: ec.model };
    const k = key.split('|');
    if (landmarker && k[0] === ec.model && k[2] === String(ec.useGpu)) {
      // 사람 수만 바뀜: 다시 만들 필요 없음
      await landmarker.setOptions({ numPoses: ec.maxPoses });
      key = want;
      return { delegate: delegate, model: ec.model };
    }
    close();
    if (!fileset) fileset = await V.FilesetResolver.forVisionTasks(url('mediapipe/wasm'));
    const options = function (d) {
      return {
        baseOptions: { modelAssetPath: url('models/pose_landmarker_' + ec.model + '.task'), delegate: d },
        runningMode: 'VIDEO',
        numPoses: ec.maxPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };
    };
    let gpuError = '';
    if (ec.useGpu) {
      try {
        landmarker = await V.PoseLandmarker.createFromOptions(fileset, options('GPU'));
        delegate = 'GPU';
      } catch (e) {
        gpuError = String((e && e.message) || e);
        landmarker = null;
      }
    }
    if (!landmarker) {
      landmarker = await V.PoseLandmarker.createFromOptions(fileset, options('CPU'));
      delegate = 'CPU';
    }
    key = want;
    lastTs = -1;
    return { delegate: delegate, model: ec.model, gpuError: gpuError };
  }

  /** image: ImageBitmap 또는 canvas, ts: ms(계속 커져야 함), mirror: 전면 카메라 */
  function detect(image, ts, mirror) {
    if (!landmarker) throw new Error('인식 엔진 준비 전');
    let t = Math.round(ts);
    if (t <= lastTs) t = lastTs + 1;
    lastTs = t;
    const t0 = performance.now();
    const r = landmarker.detectForVideo(image, t);
    const inf = performance.now() - t0;
    const P = r.landmarks || [];
    const W = r.worldLandmarks || [];
    const n = P.length;
    const lm = new Float32Array(n * 165);
    const wl = new Float32Array(n * 99);
    for (let p = 0; p < n; p++) {
      const L = P[p] || [];
      const WW = W[p] || [];
      for (let i = 0; i < 33; i++) {
        const a = L[i];
        const o = p * 165 + i * 5;
        if (a) {
          const vis = a.visibility == null ? 0 : a.visibility;
          lm[o] = mirror ? 1 - a.x : a.x;
          lm[o + 1] = a.y;
          lm[o + 2] = a.z;
          lm[o + 3] = vis;
          lm[o + 4] = a.presence == null ? vis : a.presence;
        }
        const w = WW[i];
        const q = p * 99 + i * 3;
        if (w) {
          wl[q] = mirror ? -w.x : w.x;
          wl[q + 1] = w.y;
          wl[q + 2] = w.z;
        }
      }
    }
    if (typeof r.close === 'function') {
      try { r.close(); } catch (e) { /* 무시 */ }
    }
    return { n: n, lm: lm, wl: wl, inf: inf };
  }

  function close() {
    if (landmarker) {
      try { landmarker.close(); } catch (e) { /* 무시 */ }
    }
    landmarker = null;
    key = '';
  }

  g.MotionPoseEngine = { init: init, detect: detect, close: close };
})(typeof self !== 'undefined' ? self : window);
