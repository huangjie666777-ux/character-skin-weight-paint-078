import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEGENERATE_EPSILON, DeformedFrame, type SurfaceHit } from './surface.js';
import type { Vec3 } from './types.js';

/** 表面挂件：锚定在某角色某三角形的重心坐标上，随变形表面逐帧重算。 */
export interface SurfaceAttachment {
  readonly id: string;
  readonly characterId: string;
  readonly triangleIndex: number;
  /** 重心坐标 [w0, w1, w2]，非负且和为 1。 */
  readonly barycentric: Vec3;
  /** 沿世界单位法向的偏移距离。 */
  readonly offset: number;
}

/** 挂件一帧的世界空间求值结果。 */
export interface AttachmentPose {
  readonly attachmentId: string;
  /** 面退化时为 false：挂件应隐藏并提示，恢复后自动继续。 */
  readonly visible: boolean;
  /** 世界位置（含法向偏移）；不可见时为未偏移的重心点。 */
  readonly position: Vec3;
  /** 变形后三角形首条边的世界单位切向；退化时为 [1, 0, 0]。 */
  readonly tangent: Vec3;
  /** 顶点绕序决定的世界单位法向；退化时为 [0, 1, 0]。 */
  readonly normal: Vec3;
  /** 由切向/法向构成的世界朝向（X=切向，Z=法向）。 */
  readonly quaternion: Quaternion;
}

function validateBarycentric(barycentric: readonly number[], what: string): void {
  if (!Array.isArray(barycentric) || barycentric.length !== 3
    || !barycentric.every(Number.isFinite)) {
    throw new Error(what + ' 重心坐标必须是三个有限数');
  }
  const [w0, w1, w2] = barycentric;
  if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) {
    throw new Error(what + ' 重心坐标必须非负');
  }
  if (Math.abs(w0 + w1 + w2 - 1) > 1e-6) {
    throw new Error(what + ' 重心坐标之和必须为 1');
  }
}

/** 由屏幕拾取命中创建挂件（不修改任何帧数据）。 */
export function createAttachment(id: string, hit: SurfaceHit, offset = 0): SurfaceAttachment {
  if (typeof id !== 'string' || id.length === 0) throw new Error('挂件标识必须是非空字符串');
  if (!hit || typeof hit !== 'object') throw new Error('缺少拾取命中');
  if (!Number.isFinite(offset)) throw new Error('挂件偏移必须是有限数');
  validateBarycentric(hit.barycentric, '挂件 ' + id);
  return {
    id,
    characterId: hit.characterId,
    triangleIndex: hit.triangleIndex,
    barycentric: [hit.barycentric[0], hit.barycentric[1], hit.barycentric[2]],
    offset,
  };
}

/**
 * 在同一帧变形表面上求值挂件世界位置与朝向。
 * 位置 = 重心插值 + offset × 世界单位法向；切向取变形后三角形首条边，
 * 法向取顶点绕序方向。面退化时 visible=false（位置退化为未偏移重心点），
 * 挂件保持锚定原三角形，绝不跳到其他面。
 */
export function evaluateAttachment(attachment: SurfaceAttachment, frame: DeformedFrame): AttachmentPose {
  if (!attachment || typeof attachment !== 'object') throw new Error('挂件必须是对象');
  if (!(frame instanceof DeformedFrame)) throw new Error('缺少变形帧');
  if (frame.character.id !== attachment.characterId) {
    throw new Error('挂件 ' + attachment.id + ' 属于角色 ' + attachment.characterId
      + '，不能用在角色 ' + frame.character.id + ' 的帧上');
  }
  const [a, b, c] = frame.triangleVertices(attachment.triangleIndex);
  const [w0, w1, w2] = attachment.barycentric;
  const base: Vec3 = [
    a[0] * w0 + b[0] * w1 + c[0] * w2,
    a[1] * w0 + b[1] * w1 + c[1] * w2,
    a[2] * w0 + b[2] * w1 + c[2] * w2,
  ];
  const e1 = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const e2 = new Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const normalVec = new Vector3().crossVectors(e1, e2);
  const degenerate = e1.length() <= DEGENERATE_EPSILON
    || normalVec.length() <= DEGENERATE_EPSILON;
  if (degenerate) {
    return {
      attachmentId: attachment.id,
      visible: false,
      position: base,
      tangent: [1, 0, 0],
      normal: [0, 1, 0],
      quaternion: new Quaternion(),
    };
  }
  const tangent = e1.normalize();
  const normal = normalVec.normalize();
  // 副法向 = 法向 × 切向，三者构成右手正交基（X=切向，Y=副法向，Z=法向）。
  const bitangent = new Vector3().crossVectors(normal, tangent);
  const quaternion = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(tangent, bitangent, normal),
  );
  const position: Vec3 = [
    base[0] + normal.x * attachment.offset,
    base[1] + normal.y * attachment.offset,
    base[2] + normal.z * attachment.offset,
  ];
  return {
    attachmentId: attachment.id,
    visible: true,
    position,
    tangent: [tangent.x, tangent.y, tangent.z],
    normal: [normal.x, normal.y, normal.z],
    quaternion,
  };
}

/** 导出文件的拓扑校验信息：角色标识 + 顶点数 + 完整索引序列。 */
interface CharacterTopology {
  readonly characterId: string;
  readonly vertexCount: number;
  readonly indices: readonly number[];
}

interface AttachmentFile {
  readonly format: 'surface-attachments';
  readonly version: 1;
  readonly topology: readonly CharacterTopology[];
  readonly attachments: readonly SurfaceAttachment[];
}

/** 管理一组角色的表面挂件：增删选、偏移调整、逐帧求值与 JSON 导入导出。 */
export class AttachmentManager {
  private readonly attachments = new Map<string, SurfaceAttachment>();
  private selectedId: string | null = null;
  private nextSerial = 1;

  /** 当前全部挂件（插入序，只读快照）。 */
  list(): SurfaceAttachment[] {
    return [...this.attachments.values()];
  }

  get(id: string): SurfaceAttachment | undefined {
    return this.attachments.get(id);
  }

  get selected(): SurfaceAttachment | null {
    return this.selectedId ? this.attachments.get(this.selectedId) ?? null : null;
  }

  /** 由拾取命中创建并选中挂件，返回新挂件。 */
  addFromHit(hit: SurfaceHit, offset = 0): SurfaceAttachment {
    let id: string;
    do {
      id = 'badge-' + this.nextSerial++;
    } while (this.attachments.has(id));
    const attachment = createAttachment(id, hit, offset);
    this.attachments.set(id, attachment);
    this.selectedId = id;
    return attachment;
  }

  /** 选中已有挂件；id 为 null 取消选择。 */
  select(id: string | null): void {
    if (id !== null && !this.attachments.has(id)) throw new Error('挂件不存在: ' + id);
    this.selectedId = id;
  }

  /** 删除挂件；删除当前选中项时清空选择。 */
  remove(id: string): boolean {
    const removed = this.attachments.delete(id);
    if (removed && this.selectedId === id) this.selectedId = null;
    return removed;
  }

  /** 调整挂件沿世界单位法向的偏移；非法值抛错且不修改。 */
  setOffset(id: string, offset: number): void {
    if (!Number.isFinite(offset)) throw new Error('挂件偏移必须是有限数: ' + String(offset));
    const current = this.attachments.get(id);
    if (!current) throw new Error('挂件不存在: ' + id);
    this.attachments.set(id, { ...current, offset });
  }

  /** 逐帧求值全部挂件；frames 按角色标识索引，缺失角色的挂件保持隐藏。 */
  evaluate(frames: ReadonlyMap<string, DeformedFrame>): AttachmentPose[] {
    return this.list().map((attachment) => {
      const frame = frames.get(attachment.characterId);
      if (!frame) {
        return {
          attachmentId: attachment.id,
          visible: false,
          position: [0, 0, 0] as Vec3,
          tangent: [1, 0, 0] as Vec3,
          normal: [0, 1, 0] as Vec3,
          quaternion: new Quaternion(),
        };
      }
      return evaluateAttachment(attachment, frame);
    });
  }

  /**
   * 导出 JSON 字符串：包含每个相关角色的拓扑校验信息
   * （角色标识、顶点数、完整索引序列）与全部挂件。
   */
  exportJSON(framesOrCharacters: readonly { id: string; mesh: { positions: readonly Vec3[]; indices: readonly number[] } }[]): string {
    const usedCharacters = new Set(this.list().map((a) => a.characterId));
    const topology: CharacterTopology[] = framesOrCharacters
      .filter((c) => usedCharacters.has(c.id))
      .map((c) => ({
        characterId: c.id,
        vertexCount: c.mesh.positions.length,
        indices: [...c.mesh.indices],
      }));
    const file: AttachmentFile = {
      format: 'surface-attachments',
      version: 1,
      topology,
      attachments: this.list(),
    };
    return JSON.stringify(file, null, 2);
  }

  /**
   * 从 JSON 字符串加载挂件。先完整校验（格式、拓扑、越界、重心坐标、
   * 非有限数），任一失败都抛错且保留当前挂件不变；全部通过后整体替换。
   */
  importJSON(
    json: string,
    characters: readonly { id: string; mesh: { positions: readonly Vec3[]; indices: readonly number[] } }[],
  ): SurfaceAttachment[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('挂件文件不是合法 JSON');
    }
    const file = parsed as Partial<AttachmentFile>;
    if (!file || typeof file !== 'object' || file.format !== 'surface-attachments') {
      throw new Error('挂件文件格式标识错误');
    }
    if (file.version !== 1) throw new Error('不支持的挂件文件版本: ' + String(file.version));
    if (!Array.isArray(file.topology) || !Array.isArray(file.attachments)) {
      throw new Error('挂件文件缺少 topology 或 attachments');
    }
    const byId = new Map(characters.map((c) => [c.id, c]));
    // 拓扑校验：文件中的角色标识、顶点数、索引序列必须与当前角色完全一致。
    for (const topo of file.topology as readonly CharacterTopology[]) {
      if (!topo || typeof topo !== 'object' || typeof topo.characterId !== 'string') {
        throw new Error('挂件文件拓扑条目非法');
      }
      const character = byId.get(topo.characterId);
      if (!character) throw new Error('挂件文件引用了未知角色: ' + topo.characterId);
      if (topo.vertexCount !== character.mesh.positions.length) {
        throw new Error('角色 ' + topo.characterId + ' 顶点数不匹配: '
          + String(topo.vertexCount) + ' vs ' + character.mesh.positions.length);
      }
      const expected = character.mesh.indices;
      if (!Array.isArray(topo.indices) || topo.indices.length !== expected.length
        || !topo.indices.every((value, i) => value === expected[i])) {
        throw new Error('角色 ' + topo.characterId + ' 索引序列不匹配');
      }
    }
    // 挂件校验：全部通过前不触碰当前状态。
    const next = new Map<string, SurfaceAttachment>();
    for (const raw of file.attachments) {
      if (!raw || typeof raw !== 'object') throw new Error('挂件条目非法');
      const { id, characterId, triangleIndex, barycentric, offset } = raw;
      if (typeof id !== 'string' || id.length === 0) throw new Error('挂件标识非法');
      if (next.has(id)) throw new Error('挂件标识重复: ' + id);
      const character = byId.get(characterId);
      if (!character) throw new Error('挂件 ' + id + ' 引用了未知角色: ' + String(characterId));
      const triangleCount = character.mesh.indices.length / 3;
      if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= triangleCount) {
        throw new Error('挂件 ' + id + ' 三角形序号越界: ' + String(triangleIndex));
      }
      validateBarycentric(barycentric, '挂件 ' + id);
      if (!Number.isFinite(offset)) throw new Error('挂件 ' + id + ' 偏移必须是有限数');
      next.set(id, {
        id,
        characterId,
        triangleIndex,
        barycentric: [barycentric[0], barycentric[1], barycentric[2]],
        offset,
      });
    }
    this.attachments.clear();
    for (const [id, attachment] of next) this.attachments.set(id, attachment);
    this.selectedId = null;
    return this.list();
  }
}
