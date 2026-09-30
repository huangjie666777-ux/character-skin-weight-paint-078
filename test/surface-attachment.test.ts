import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  AttachmentManager,
  DeformedCharacter,
  Skeleton,
  characterTransformToMatrix,
  createAttachment,
  evaluateAttachment,
  evaluatePose,
  pickTriangle,
  skinTriangleMesh,
  type AnimationClip,
  type CharacterTransform,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip, quatY, quatZ } from './helpers.js';

const sk = new Skeleton(humanoidBones());

/** 简单四边形网格 + 一个退化三角形 + 一个形变目标。 */
function quadMesh(): TriangleMesh {
  const positions: Vec3[] = [
    [0, 1.0, 0],
    [0.4, 1.0, 0],
    [0.4, 1.4, 0],
    [0, 1.4, 0],
  ];
  const weights: SkinInfluence[][] = positions.map(() => [{ boneId: 'hips', weight: 1 }]);
  return {
    name: 'quad',
    positions,
    indices: [0, 1, 2, 0, 2, 3, 0, 0, 1],
    weights,
    morphTargets: [{
      name: 'bulge',
      displacements: positions.map((p) => [0, 0, p[1] - 1.2] as Vec3),
    }],
  };
}

function makeCharacter(id: string, transform?: CharacterTransform): DeformedCharacter {
  return new DeformedCharacter(id, sk, quadMesh(), transform);
}

function frameOf(character: DeformedCharacter, time: number, morphWeights?: number[]) {
  const pose = evaluatePose(sk, { clip: walkClip(), time, loop: 'loop' });
  return character.evaluateFrame(pose.worldMatrices, morphWeights);
}

test('角色变换校验：正的非均匀缩放可用，非正缩放拒绝', () => {
  const c = makeCharacter('a', { translation: [1, 0, 0], rotation: quatY(0.3), scale: [2, 1, 0.5] });
  assert.deepEqual(c.getTransform().scale, [2, 1, 0.5]);
  assert.throws(
    () => makeCharacter('b', { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, -1, 1] }),
    /缩放/,
  );
  assert.throws(
    () => c.setTransform({ translation: [0, 0, 0], rotation: [0, 0, 0, 2], scale: [1, 1, 1] }),
    /单位四元数/,
  );
});

test('变形帧复用形变后蒙皮结果并施加一次角色矩阵（含非均匀缩放）', () => {
  const transform: CharacterTransform = {
    translation: [1, 2, 3],
    rotation: quatZ(0.4),
    scale: [2, 1, 0.5],
  };
  const c = makeCharacter('hero', transform);
  const pose = evaluatePose(sk, { clip: walkClip(), time: 0.3, loop: 'loop' });
  const frame = c.evaluateFrame(pose.worldMatrices, [0.5]);
  const skinned = skinTriangleMesh(sk, quadMesh(), pose.worldMatrices, [0.5]);
  const m = characterTransformToMatrix(transform);
  for (let i = 0; i < skinned.length; i++) {
    const expected = new Vector3(...skinned[i]).applyMatrix4(m);
    assert.ok(Math.abs(frame.positions[i][0] - expected.x) < 1e-9);
    assert.ok(Math.abs(frame.positions[i][1] - expected.y) < 1e-9);
    assert.ok(Math.abs(frame.positions[i][2] - expected.z) < 1e-9);
  }
});

test('拾取：命中最近正面三角形并返回角色、序号与重心坐标', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  // 四边形在 z=0 平面，正面朝 +Z（绕序 0->1->2 逆时针）。
  const hit = pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] });
  assert.ok(hit);
  assert.equal(hit.characterId, 'hero');
  assert.equal(hit.triangleIndex, 0);
  const [w0, w1, w2] = hit.barycentric;
  assert.ok(Math.abs(w0 + w1 + w2 - 1) < 1e-9);
  assert.ok(w0 >= 0 && w1 >= 0 && w2 >= 0);
  assert.ok(Math.abs(hit.distance - 5) < 1e-9);
});

test('拾取：背面不命中、空白返回 null、退化面跳过', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  // 从背面（-Z 方向看）不命中。
  assert.equal(pickTriangle([frame], { origin: [0.2, 1.2, -5], direction: [0, 0, 1] }), null);
  // 空白处不命中。
  assert.equal(pickTriangle([frame], { origin: [50, 50, 5], direction: [0, 0, -1] }), null);
  // 退化三角形（索引 2）所在位置只有退化面：不命中。
  assert.equal(pickTriangle([frame], { origin: [0.01, 1.01, 5], direction: [0, 0, -1] })?.triangleIndex ?? 0, 0);
  assert.ok(frame.isDegenerate(2));
  assert.ok(!frame.isDegenerate(0));
});

test('拾取：多实例各自变换，返回最近命中且不串状态', () => {
  const near = makeCharacter('near', { translation: [0, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  const far = makeCharacter('far', { translation: [0, 0, -2], rotation: [0, 0, 0, 1], scale: [2, 1, 1] });
  const frames = [frameOf(near, 0.2), frameOf(far, 0.7)];
  const hit = pickTriangle(frames, { origin: [0.2, 1.2, 10], direction: [0, 0, -1] });
  assert.ok(hit);
  assert.equal(hit.characterId, 'near');
  assert.ok(Math.abs(hit.distance - 8) < 1e-9);
  // 输入帧数据未被修改。
  assert.equal(frames[0].positions.length, 4);
});

test('挂件：位置为重心插值加法向偏移，朝向取首边切向与绕序法向', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const hit = pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!;
  const attachment = createAttachment('b1', hit, 0.3);
  const pose = evaluateAttachment(attachment, frame);
  assert.ok(pose.visible);
  // 绑定姿态下四边形在 z=0 平面，法向 +Z，首边沿 +X。
  assert.ok(Math.abs(pose.normal[2] - 1) < 1e-9);
  assert.ok(Math.abs(pose.tangent[0] - 1) < 1e-9);
  assert.ok(Math.abs(pose.position[2] - 0.3) < 1e-9);
  assert.ok(Math.abs(pose.position[0] - 0.2) < 1e-9);
  assert.ok(Math.abs(pose.position[1] - 1.2) < 1e-9);
  // 四元数把局部 Z 轴转到法向。
  const zAxis = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  assert.ok(Math.abs(zAxis.z - 1) < 1e-9);
});

test('挂件：面退化时隐藏，恢复后继续贴附原三角形', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const degenerateAttachment = createAttachment('dg', {
    characterId: 'hero',
    triangleIndex: 2,
    barycentric: [0.5, 0.5, 0],
    distance: 1,
  });
  const hidden = evaluateAttachment(degenerateAttachment, frame);
  assert.equal(hidden.visible, false);
  // 恢复（此处用正常面模拟同一挂件恢复后的求值）。
  const normal = createAttachment('ok', {
    characterId: 'hero',
    triangleIndex: 0,
    barycentric: [1 / 3, 1 / 3, 1 / 3],
    distance: 1,
  });
  const shown = evaluateAttachment(normal, frame);
  assert.equal(shown.visible, true);
  assert.equal(normal.triangleIndex, 0); // 锚定原面，不跳面
});

test('挂件：跨角色帧求值被拒绝', () => {
  const a = makeCharacter('a');
  const b = makeCharacter('b');
  const hit = pickTriangle([frameOf(a, 0)], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!;
  const attachment = createAttachment('x', hit);
  assert.throws(() => evaluateAttachment(attachment, frameOf(b, 0)), /属于角色/);
});

test('管理器：增删选与偏移调整', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const manager = new AttachmentManager();
  const hit = pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!;
  const first = manager.addFromHit(hit);
  const second = manager.addFromHit(hit, 0.1);
  assert.equal(manager.list().length, 2);
  assert.equal(manager.selected?.id, second.id);
  manager.select(first.id);
  manager.setOffset(first.id, 0.5);
  assert.equal(manager.get(first.id)?.offset, 0.5);
  assert.throws(() => manager.setOffset(first.id, NaN), /有限数/);
  assert.equal(manager.get(first.id)?.offset, 0.5);
  assert.ok(manager.remove(first.id));
  assert.equal(manager.selected, null);
  assert.equal(manager.list().length, 1);
});

test('管理器：逐帧求值，缺失角色的挂件隐藏', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const manager = new AttachmentManager();
  manager.addFromHit(pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!);
  const poses = manager.evaluate(new Map([['hero', frame]]));
  assert.equal(poses.length, 1);
  assert.ok(poses[0].visible);
  const missing = manager.evaluate(new Map());
  assert.equal(missing[0].visible, false);
});

test('导出导入：JSON 往返一致', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const manager = new AttachmentManager();
  manager.addFromHit(pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!, 0.2);
  manager.addFromHit(pickTriangle([frame], { origin: [0.1, 1.3, 5], direction: [0, 0, -1] })!);
  const json = manager.exportJSON([c]);
  const restored = new AttachmentManager();
  const loaded = restored.importJSON(json, [c]);
  assert.deepEqual(loaded, manager.list());
});

test('导入校验：拓扑错配、越界、非法重心、非有限数均拒绝且保留当前挂件', () => {
  const c = makeCharacter('hero');
  const frame = frameOf(c, 0);
  const manager = new AttachmentManager();
  manager.addFromHit(pickTriangle([frame], { origin: [0.2, 1.2, 5], direction: [0, 0, -1] })!);
  const before = manager.list();
  const good = JSON.parse(manager.exportJSON([c]));

  const attempt = (mutate: (file: any) => void, pattern: RegExp) => {
    const file = JSON.parse(JSON.stringify(good));
    mutate(file);
    assert.throws(() => manager.importJSON(JSON.stringify(file), [c]), pattern);
    assert.deepEqual(manager.list(), before);
  };

  attempt((f) => { f.topology[0].vertexCount += 1; }, /顶点数不匹配/);
  attempt((f) => { f.topology[0].indices[0] += 1; }, /索引序列不匹配/);
  attempt((f) => { f.topology[0].characterId = 'ghost'; }, /未知角色/);
  attempt((f) => { f.attachments[0].triangleIndex = 99; }, /越界/);
  attempt((f) => { f.attachments[0].barycentric = [1.5, -0.5, 0]; }, /非负/);
  attempt((f) => { f.attachments[0].barycentric = [0.5, 0.5, 0.5]; }, /之和/);
  attempt((f) => { f.attachments[0].offset = 'x'; }, /有限数/);
  attempt((f) => { f.attachments[0].barycentric = [NaN, 0, 0]; }, /有限数/);
  attempt((f) => { f.format = 'other'; }, /格式标识/);
  assert.throws(() => manager.importJSON('{oops', [c]), /JSON/);
  assert.deepEqual(manager.list(), before);
});

test('变形帧数据独立：后续求值不改写已返回的帧', () => {
  const c = makeCharacter('hero');
  const first = frameOf(c, 0);
  const snapshot = first.positions.map((p) => [...p]);
  frameOf(c, 0.5);
  assert.deepEqual(first.positions, snapshot);
});

// 保持类型引用被使用（编译期检查）。
void ((): AnimationClip | null => null);
void Matrix4;
