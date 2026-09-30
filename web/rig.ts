import type { AnimationClip, BoneSpec, Quat, TriangleMesh, Vec3 } from '../src/index.js';

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const UNIT: Vec3 = [1, 1, 1];

function quatZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

/** 与测试一致的简易人形骨架（Y 向上，根 hips 在 y=1）。 */
export function demoBones(): BoneSpec[] {
  const bone = (id: string, parentId: string | null, t: Vec3): BoneSpec => ({
    id,
    parentId,
    translation: t,
    rotation: IDENTITY_QUAT,
    scale: UNIT,
  });
  return [
    bone('hips', null, [0, 1, 0]),
    bone('spine', 'hips', [0, 0.2, 0]),
    bone('head', 'spine', [0, 0.3, 0]),
    bone('arm.L', 'spine', [-0.25, 0.15, 0]),
    bone('hand.L', 'arm.L', [-0.3, 0, 0]),
    bone('arm.R', 'spine', [0.25, 0.15, 0]),
    bone('hand.R', 'arm.R', [0.3, 0, 0]),
    bone('leg.L', 'hips', [0.1, 0, 0]),
    bone('leg.R', 'hips', [-0.1, 0, 0]),
  ];
}

interface BoxSpec {
  readonly center: Vec3;
  readonly size: Vec3;
  readonly boneId: string;
}

const BOXES: BoxSpec[] = [
  { center: [0, 1.0, 0], size: [0.34, 0.2, 0.2], boneId: 'hips' },
  { center: [0, 1.32, 0], size: [0.4, 0.36, 0.22], boneId: 'spine' },
  { center: [0, 1.64, 0], size: [0.26, 0.26, 0.26], boneId: 'head' },
  { center: [-0.4, 1.35, 0], size: [0.3, 0.1, 0.1], boneId: 'arm.L' },
  { center: [-0.62, 1.35, 0], size: [0.14, 0.09, 0.09], boneId: 'hand.L' },
  { center: [0.4, 1.35, 0], size: [0.3, 0.1, 0.1], boneId: 'arm.R' },
  { center: [0.62, 1.35, 0], size: [0.14, 0.09, 0.09], boneId: 'hand.R' },
  { center: [0.1, 0.68, 0], size: [0.13, 0.56, 0.13], boneId: 'leg.L' },
  { center: [-0.1, 0.68, 0], size: [0.13, 0.56, 0.13], boneId: 'leg.R' },
];

/** 由盒子拼成的低多边形角色网格，带 smile（头部前侧）与 squash（压塌头部）形变目标。 */
export function demoMesh(): TriangleMesh {
  const positions: Vec3[] = [];
  const indices: number[] = [];
  const weights: { boneId: string; weight: number }[][] = [];
  const headTopFront: number[] = [];
  const headFront: number[] = [];
  for (const box of BOXES) {
    const [cx, cy, cz] = box.center;
    const [sx, sy, sz] = box.size.map((s) => s / 2);
    const base = positions.length;
    const corners: Vec3[] = [
      [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz],
      [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
      [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz],
      [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz],
    ];
    positions.push(...corners);
    for (let i = 0; i < 8; i++) weights.push([{ boneId: box.boneId, weight: 1 }]);
    // 六个面，绕序朝外。
    const quads: [number, number, number, number][] = [
      [4, 5, 6, 7], // +Z 前
      [1, 0, 3, 2], // -Z 后
      [7, 6, 2, 3], // +Y 顶
      [0, 1, 5, 4], // -Y 底
      [5, 1, 2, 6], // +X 右
      [0, 4, 7, 3], // -X 左
    ];
    for (const [a, b, c, d] of quads) {
      indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
    }
    if (box.boneId === 'head') {
      // 前侧四个顶点（z+ 面）：4,5,6,7；顶部前侧：6,7。
      headFront.push(base + 4, base + 5, base + 6, base + 7);
      headTopFront.push(base + 6, base + 7);
    }
  }
  const zero = (): Vec3[] => positions.map(() => [0, 0, 0]);
  const smile = zero();
  for (const v of headFront) {
    smile[v] = [0, -0.05, 0.06];
  }
  for (const v of headTopFront) {
    smile[v] = [smile[v][0], -0.02, 0.08];
  }
  // squash：把头顶前侧顶点压到底部平面，制造退化三角形用于演示挂件隐藏。
  const squash = zero();
  for (const v of headTopFront) {
    squash[v] = [0, -0.26, 0];
  }
  return {
    name: 'demo-character',
    positions,
    indices,
    weights,
    morphTargets: [
      { name: 'smile', displacements: smile },
      { name: 'squash', displacements: squash },
    ],
  };
}

/** 行走 + 挥手 + 微笑表情，1 秒循环。 */
export function demoClip(): AnimationClip {
  return {
    name: 'walk-wave-smile',
    duration: 1,
    tracks: [
      {
        boneId: 'hips',
        translations: [
          { time: 0, value: [0, 1, 0] },
          { time: 0.5, value: [0, 1.06, 0] },
          { time: 1, value: [0, 1, 0] },
        ],
      },
      {
        boneId: 'leg.L',
        rotations: [
          { time: 0, value: quatZ(0.5) },
          { time: 0.5, value: quatZ(-0.5) },
          { time: 1, value: quatZ(0.5) },
        ],
      },
      {
        boneId: 'leg.R',
        rotations: [
          { time: 0, value: quatZ(-0.5) },
          { time: 0.5, value: quatZ(0.5) },
          { time: 1, value: quatZ(-0.5) },
        ],
      },
      {
        boneId: 'arm.R',
        rotations: [
          { time: 0, value: quatZ(1.1) },
          { time: 0.5, value: quatZ(1.5) },
          { time: 1, value: quatZ(1.1) },
        ],
      },
      {
        boneId: 'hand.R',
        rotations: [
          { time: 0, value: quatZ(0.4) },
          { time: 0.5, value: quatZ(-0.4) },
          { time: 1, value: quatZ(0.4) },
        ],
      },
      {
        boneId: 'arm.L',
        rotations: [
          { time: 0, value: quatZ(-0.2) },
          { time: 0.5, value: quatZ(0.2) },
          { time: 1, value: quatZ(-0.2) },
        ],
      },
    ],
    morphTracks: [
      {
        targetName: 'smile',
        keys: [
          { time: 0, value: 0 },
          { time: 0.5, value: 1 },
          { time: 1, value: 0 },
        ],
      },
    ],
  };
}
