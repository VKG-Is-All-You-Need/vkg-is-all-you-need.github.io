/** 三维场景共用的小工具。 */
import * as THREE from 'three';

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** 与帧率无关的指数阻尼系数：每秒向目标靠近的程度由 rate 决定。 */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 平面四边形的轮廓线（用于各层边框）。 */
export function rectOutline(halfW: number, halfD: number): THREE.Vector3[] {
  return [
    new THREE.Vector3(-halfW, 0, -halfD),
    new THREE.Vector3(halfW, 0, -halfD),
    new THREE.Vector3(halfW, 0, halfD),
    new THREE.Vector3(-halfW, 0, halfD),
    new THREE.Vector3(-halfW, 0, -halfD),
  ];
}

/** 竖向渐隐纹理，用于光柱。 */
export function createBeamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(canvas);
}
