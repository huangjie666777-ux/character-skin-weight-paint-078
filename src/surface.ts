import { Matrix4, Quaternion, Vector3 } from 'three';
import { skinTriangleMesh } from './morph.js';
import type { Skeleton } from './skeleton.js';
import type { Quat, TriangleMesh, Vec3 } from './types.js';

/** 角色世界变换：平移、单位四元数旋转、正的非均匀缩放。 */
export interface CharacterTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
  /** 各分量必须为正的有限数（允许非均匀）。 */
  readonly scale: Vec3;
}

export const IDENTITY_TRANSFORM: CharacterTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** 校验角色世界变换，返回防御性副本。 */
export function validateCharacterTransform(t: CharacterTransform, what = '角色变换'): CharacterTransform {
  if (!t || typeof t !== 'object') throw new Error(what + ' 必须是对象');
  const { translation, rotation, scale } = t;
  if (!Array.isArray(translation) || translation.length !== 3 || !translation.every(Number.isFinite)) {
    throw new Error(what + ' 平移必须是三个有限数');
  }
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(Number.isFinite)) {
    throw new Error(what + ' 旋转必须是四个有限数');
  }
  const len = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (Math.abs(len - 1) > 1e-3) throw new Error(what + ' 旋转必须是单位四元数');
  if (!Array.isArray(scale) || scale.length !== 3 || !scale.every((s) => Number.isFinite(s) && s > 0)) {
    throw new Error(what + ' 缩放必须是三个正的有限数');
  }
  return {
    translation: [translation[0], translation[1], translation[2]],
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    scale: [scale[0], scale[1], scale[2]],
  };
}

/** 角色变换转世界矩阵（平移×旋转×缩放，支持非均匀缩放）。 */
export function characterTransformToMatrix(t: CharacterTransform): Matrix4 {
  const valid = validateCharacterTransform(t);
  return new Matrix4().compose(
    new Vector3(...valid.translation),
    new Quaternion(...valid.rotation),
    new Vector3(...valid.scale),
  );
}

/**
 * 一个独立角色实例：骨架 + 形变网格 + 世界变换。
 * 多个实例可共用同一份骨架/网格输入，但各自持有独立的变形帧缓存，
 * 互不串用状态；输入数据不会被修改。
 */
export class DeformedCharacter {
  readonly id: string;
  readonly skeleton: Skeleton;
  readonly mesh: TriangleMesh;
  private transform: CharacterTransform;
  private matrix: Matrix4;

  constructor(id: string, skeleton: Skeleton, mesh: TriangleMesh, transform?: CharacterTransform) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('角色标识必须是非空字符串');
    if (!skeleton) throw new Error('角色 ' + id + ' 缺少骨架');
    if (!mesh) throw new Error('角色 ' + id + ' 缺少网格');
    this.id = id;
    this.skeleton = skeleton;
    this.mesh = mesh;
    this.transform = validateCharacterTransform(transform ?? IDENTITY_TRANSFORM);
    this.matrix = characterTransformToMatrix(this.transform);
  }

  /** 当前角色世界变换（只读副本）。 */
  getTransform(): CharacterTransform {
    return this.transform;
  }

  /** 角色世界矩阵（内部缓存，调用方请勿修改）。 */
  get matrixWorld(): Matrix4 {
    return this.matrix;
  }

  /** 更新世界变换；非法参数抛错且不影响当前状态。 */
  setTransform(transform: CharacterTransform): void {
    const valid = validateCharacterTransform(transform);
    this.transform = valid;
    this.matrix = characterTransformToMatrix(valid);
  }

  /**
   * 求值一帧变形表面：复用“先形变后蒙皮”的 skinTriangleMesh 得到角色空间
   * 顶点，再施加一次本实例的世界矩阵（支持非均匀缩放）得到世界坐标。
   * 返回全新的 DeformedFrame；同一帧应同时用于显示、拾取与挂件求值。
   */
  evaluateFrame(
    worldMatrices: ReadonlyMap<string, Matrix4>,
    morphWeights?: readonly number[],
  ): DeformedFrame {
    const skinned = skinTriangleMesh(this.skeleton, this.mesh, worldMatrices, morphWeights);
    const positions = new Array<Vec3>(skinned.length);
    const tmp = new Vector3();
    for (let i = 0; i < skinned.length; i++) {
      tmp.set(skinned[i][0], skinned[i][1], skinned[i][2]).applyMatrix4(this.matrix);
      positions[i] = [tmp.x, tmp.y, tmp.z];
    }
    return new DeformedFrame(this, positions);
  }
}

/** 三角形退化判定阈值（世界单位，边长/面积下限）。 */
export const DEGENERATE_EPSILON = 1e-8;

/**
 * 某一帧的变形表面快照：世界坐标顶点 + 网格拓扑引用。
 * 帧数据不可变；显示、拾取、挂件必须共用同一帧实例。
 */
export class DeformedFrame {
  readonly character: DeformedCharacter;
  /** 世界空间顶点，顺序与 mesh.positions 一致。 */
  readonly positions: readonly Vec3[];

  constructor(character: DeformedCharacter, positions: readonly Vec3[]) {
    this.character = character;
    this.positions = positions;
  }

  get indices(): readonly number[] {
    return this.character.mesh.indices;
  }

  get triangleCount(): number {
    return this.character.mesh.indices.length / 3;
  }

  /** 三角形三个顶点的世界坐标；越界序号抛错。 */
  triangleVertices(triangleIndex: number): [Vec3, Vec3, Vec3] {
    if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= this.triangleCount) {
      throw new Error('三角形序号越界: ' + String(triangleIndex));
    }
    const idx = this.indices;
    return [
      this.positions[idx[triangleIndex * 3]],
      this.positions[idx[triangleIndex * 3 + 1]],
      this.positions[idx[triangleIndex * 3 + 2]],
    ];
  }

  /** 三角形是否退化（任一边过短或面积为零）。 */
  isDegenerate(triangleIndex: number): boolean {
    const [a, b, c] = this.triangleVertices(triangleIndex);
    return triangleNormalLength(a, b, c) <= DEGENERATE_EPSILON;
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lengthOf(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** |(b-a)×(c-a)|，即两倍三角形面积；退化面为 0。 */
function triangleNormalLength(a: Vec3, b: Vec3, c: Vec3): number {
  return lengthOf(cross(sub(b, a), sub(c, a)));
}

/** 射线参数：原点 + 单位方向。 */
export interface Ray {
  readonly origin: Vec3;
  /** 必须为单位向量。 */
  readonly direction: Vec3;
}

/** 拾取命中结果。 */
export interface SurfaceHit {
  readonly characterId: string;
  readonly triangleIndex: number;
  /** 重心坐标 [w0, w1, w2]，非负且和为 1。 */
  readonly barycentric: Vec3;
  /** 沿射线的距离（> 0）。 */
  readonly distance: number;
}

function validateRay(ray: Ray): void {
  if (!ray || typeof ray !== 'object') throw new Error('射线必须是对象');
  const { origin, direction } = ray;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) {
    throw new Error('射线原点必须是三个有限数');
  }
  if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite)) {
    throw new Error('射线方向必须是三个有限数');
  }
  const len = lengthOf(direction as Vec3);
  if (Math.abs(len - 1) > 1e-3) throw new Error('射线方向必须是单位向量');
}

/**
 * 在若干角色的同一帧变形表面上做射线拾取（Möller–Trumbore）。
 * 只命中正面三角形（按顶点绕序法向朝向射线源），退化面跳过，
 * 返回距离最近的命中；未命中返回 null（空白处不创建挂件）。
 */
export function pickTriangle(frames: readonly DeformedFrame[], ray: Ray): SurfaceHit | null {
  validateRay(ray);
  if (!Array.isArray(frames)) throw new Error('帧列表必须是数组');
  const origin = ray.origin;
  const dir = ray.direction;
  let best: SurfaceHit | null = null;
  for (const frame of frames) {
    if (!(frame instanceof DeformedFrame)) throw new Error('帧列表含非法元素');
    const idx = frame.indices;
    const pos = frame.positions;
    for (let t = 0; t < frame.triangleCount; t++) {
      const a = pos[idx[t * 3]];
      const b = pos[idx[t * 3 + 1]];
      const c = pos[idx[t * 3 + 2]];
      const e1 = sub(b, a);
      const e2 = sub(c, a);
      const p = cross(dir, e2);
      const det = dot(e1, p);
      // det > 0：射线从正面（绕序法向一侧）射入；背面与退化面（det≈0）跳过。
      if (det <= DEGENERATE_EPSILON) continue;
      const tv = sub(origin, a);
      const u = dot(tv, p) / det;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const q = cross(tv, e1);
      const v = dot(dir, q) / det;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const distance = dot(e2, q) / det;
      if (!(distance > 0)) continue;
      if (best && distance >= best.distance) continue;
      const w0 = 1 - u - v;
      best = {
        characterId: frame.character.id,
        triangleIndex: t,
        barycentric: [w0, u, v],
        distance,
      };
    }
  }
  return best;
}
