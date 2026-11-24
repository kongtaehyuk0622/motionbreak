// MOTION BREAK 웹: 신체 인식을 별도 스레드(웹 워커)에서 돌린다 → 인식하는 동안에도 게임 화면이 끊기지 않음.
// 화면 스레드(motion_vision.js)가 카메라 프레임(ImageBitmap)을 보내면 관절 좌표를 돌려준다.
importScripts('mediapipe/vision_bundle.js', 'motion_pose_engine.js');

const BASE = new URL('./', self.location.href).href;
let ready = false;

self.onmessage = async function (ev) {
  const m = ev.data || {};
  if (m.cmd === 'init') {
    ready = false;
    try {
      const info = await self.MotionPoseEngine.init(m.cfg, BASE);
      ready = true;
      self.postMessage(Object.assign({ type: 'engine' }, info));
    } catch (e) {
      self.postMessage({ type: 'engineError', message: String((e && e.message) || e) });
    }
  } else if (m.cmd === 'frame') {
    const bmp = m.bitmap;
    try {
      if (!ready) throw new Error('not ready');
      const r = self.MotionPoseEngine.detect(bmp, m.ts, m.mirror);
      self.postMessage(
        { type: 'result', ts: m.ts, mirror: m.mirror, w: m.w, h: m.h, inf: r.inf, n: r.n, lm: r.lm, wl: r.wl },
        [r.lm.buffer, r.wl.buffer]
      );
    } catch (e) {
      self.postMessage({ type: 'frameError', ts: m.ts, message: String((e && e.message) || e) });
    } finally {
      try { bmp && bmp.close(); } catch (e) { /* 무시 */ }
    }
  } else if (m.cmd === 'close') {
    self.MotionPoseEngine.close();
    ready = false;
  }
};
