// バイザーの出入りの演出。src-tauri/src/visor.rs がパネルを出すと visor-enter、隠し始めると visor-exit を送る。
// 出るときは「背後の画面がぼける → 塗りつぶされて何も見えなくなる → 本文がぼけた状態からピントが合って出る」、
// 消えるときはその逆順。
// 4 つの層をそれぞれ少しずつずらし、expo のイージング（最初に大きく動いて、ゆっくり落ち着く）で動かす。
// どの層も今の値から動き始めるので、途中で反対向きの操作が来ても飛ばずにつながる。
import { invoke } from '@tauri-apps/api/core';

type Layer = 'blur' | 'fill' | 'content' | 'focus';
/** 演出を始めてから何秒後に動き始め、何秒かけるか */
type Track = { delay: number; duration: number };

const ENTER: Record<Layer, Track> = {
  blur: { delay: 0, duration: 1 },
  fill: { delay: 0.2, duration: 0.8 },
  content: { delay: 0.35, duration: 0.65 },
  focus: { delay: 0.45, duration: 0.55 },
};
const EXIT: Record<Layer, Track> = {
  focus: { delay: 0, duration: 0.35 },
  content: { delay: 0.05, duration: 0.4 },
  fill: { delay: 0.1, duration: 0.9 },
  blur: { delay: 0.2, duration: 0.8 },
};
/** 背後の画面をいちばん強くぼかしたときの半径 */
const MAX_BLUR = 30;
/** 本文がいちばんぼけているとき（focus が 0）と、ピントが合う直前の、ぼけた影の半径（px） */
const MAX_TEXT_BLUR = 12;
const MIN_TEXT_BLUR = 2;

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** 各層の今の値（0 で無し、1 で出し切った状態） */
const current: Record<Layer, number> = { blur: 0, fill: 0, content: 0, focus: 0 };
let lastBlur = 0;
let generation = 0;

function apply() {
  const style = document.documentElement.style;
  style.setProperty('--visor-fill', String(current.fill));
  style.setProperty('--visor-content', String(current.content));
  // 本文は、ぼけた影（text-shadow）を薄くしながら、くっきりした文字を濃くして入れ替える。
  // CSS の filter: blur は小さい半径を指定しても一定以上ぼけて描かれ、外す瞬間にカチッと切り替わるので使わない。
  // ピントが合い切るまでは、キャレットもぼけた文字の上でくっきり見えないよう隠す
  if (current.focus >= 1) {
    style.removeProperty('--visor-sharp');
    style.removeProperty('--visor-text-shadow');
    style.removeProperty('--visor-caret');
  } else {
    const radius = MIN_TEXT_BLUR + (1 - current.focus) * (MAX_TEXT_BLUR - MIN_TEXT_BLUR);
    style.setProperty('--visor-sharp', String(current.focus));
    style.setProperty('--visor-text-shadow', `0 0 ${radius}px rgb(var(--text-rgb) / ${1 - current.focus})`);
    style.setProperty('--visor-caret', 'transparent');
  }
  const blur = Math.round(current.blur * MAX_BLUR);
  if (blur !== lastBlur) {
    lastBlur = blur;
    invoke('set_visor_blur', { radius: blur }).catch(() => {});
  }
}

/** 出る（enter）か消える演出を流す。最後まで流れたら true、途中で次の演出に替わったら false */
export function playVisorTransition(enter: boolean): Promise<boolean> {
  // 前の演出は、次のコマで世代が変わったのを見て false で終わる
  const gen = ++generation;
  // パネルを出し直すと macOS 側のぼかしが消えていることがあるので、最初のコマで送り直す
  lastBlur = -1;
  const tracks = enter ? ENTER : EXIT;
  const target = enter ? 1 : 0;
  const from = { ...current };
  const total = Math.max(...Object.values(tracks).map((t) => t.delay + t.duration));
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      if (gen !== generation) return resolve(false);
      const elapsed = (now - start) / 1000;
      for (const layer of Object.keys(tracks) as Layer[]) {
        const { delay, duration } = tracks[layer];
        const t = Math.min(Math.max((elapsed - delay) / duration, 0), 1);
        current[layer] = from[layer] + (target - from[layer]) * easeOutExpo(t);
      }
      apply();
      if (elapsed >= total) return resolve(true);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
