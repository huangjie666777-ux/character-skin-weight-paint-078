import { sampleKeys, validateClip } from './clip.js';
import { assertFloat32Finite } from './morph.js';
import type { PreparedMorphTargets } from './morph.js';
import type { Skeleton } from './skeleton.js';
import type { AnimationClip, Keyframe, Quat, Vec3 } from './types.js';

export type GltfAnimationPath = 'translation' | 'rotation' | 'scale';

export interface GltfAnimationChannel {
  readonly nodeIndex: number;
  readonly path: GltfAnimationPath | 'weights';
  readonly times: Float32Array;
  readonly values: Float32Array;
  readonly valueSize?: number;
}

export interface GltfAnimation {
  readonly name: string;
  readonly duration: number;
  readonly channels: GltfAnimationChannel[];
}

function expandKeys<T extends readonly number[]>(
  keys: readonly Keyframe<T>[],
  duration: number,
  valueSize: number,
  what: string,
): Pick<GltfAnimationChannel, 'times' | 'values'> {
  const prepend = keys[0].time > 0;
  const append = keys[keys.length - 1].time < duration;
  const count = keys.length + (prepend ? 1 : 0) + (append ? 1 : 0);
  const times = new Float32Array(count);
  const values = new Float32Array(count * valueSize);
  let out = 0;
  const write = (time: number, value: T): void => {
    times[out] = time;
    for (let i = 0; i < valueSize; i++) {
      // 有限但超出 FLOAT32 范围的值（如 1e39 的平移）写入后会变成 Infinity，
      // 必须在导出前拒绝，避免生成静默损坏的 GLB。
      assertFloat32Finite(value[i], what);
      values[out * valueSize + i] = value[i];
    }
    out++;
  };
  if (prepend) write(0, keys[0].value);
  for (const key of keys) write(key.time, key.value);
  if (append) write(duration, keys[keys.length - 1].value);
  return { times, values };
}

function assertIncreasingTimes(times: Float32Array, what: string): void {
  for (let i = 1; i < times.length; i++) {
    if (!(times[i] > times[i - 1])) throw new Error(what + ' 时间转成 FLOAT32 后不再严格递增');
  }
}

function prepareMorphChannel(
  clip: AnimationClip,
  meshNodeIndex: number,
  morph: PreparedMorphTargets,
): GltfAnimationChannel | undefined {
  const tracks = clip.morphTracks ?? [];
  if (tracks.length === 0) return undefined;
  const byName = new Map(tracks.map((track) => [track.targetName, track]));
  const timeSet = new Set<number>();
  timeSet.add(0);
  timeSet.add(clip.duration);
  for (const track of tracks) track.keys.forEach((key) => timeSet.add(key.time));
  const timesSource = [...timeSet].sort((a, b) => a - b);
  const times = new Float32Array(timesSource);
  assertIncreasingTimes(times, '片段 ' + clip.name + ' 形变权重');
  const values = new Float32Array(times.length * morph.targets.length);
  morph.targets.forEach((target, targetIndex) => {
    const track = byName.get(target.name);
    timesSource.forEach((time, timeIndex) => {
      const value = track
        ? sampleKeys(track.keys, time, (a, b, t) => a + (b - a) * t) ?? target.defaultWeight ?? 0
        : target.defaultWeight ?? 0;
      values[timeIndex * morph.targets.length + targetIndex] = value;
    });
  });
  return { nodeIndex: meshNodeIndex, path: 'weights', times, values, valueSize: morph.targets.length };
}

/** 把库片段转换为 glTF 节点局部 TRS 通道；不修改输入。 */
export function prepareGlbAnimations(
  skeleton: Skeleton,
  clips: readonly AnimationClip[],
  meshNodeIndex: number,
  morph: PreparedMorphTargets,
): GltfAnimation[] {
  if (!Array.isArray(clips)) throw new Error('GLB clips 必须是数组');
  const nodeIndex = new Map(skeleton.evalOrder.map((id, index) => [id, index]));
  return clips.map((clip) => {
    validateClip(clip, skeleton, morph.targets);
    const channels: GltfAnimationChannel[] = [];
    for (const track of clip.tracks) {
      const node = nodeIndex.get(track.boneId)!;
      if (track.translations && track.translations.length > 0) {
        const data = expandKeys<Vec3>(track.translations, clip.duration, 3,
          '片段 ' + clip.name + ' 骨骼 ' + track.boneId + ' 平移');
        channels.push({ nodeIndex: node, path: 'translation', ...data });
      }
      if (track.rotations && track.rotations.length > 0) {
        const data = expandKeys<Quat>(track.rotations, clip.duration, 4,
          '片段 ' + clip.name + ' 骨骼 ' + track.boneId + ' 旋转');
        channels.push({ nodeIndex: node, path: 'rotation', ...data });
      }
      if (track.scales && track.scales.length > 0) {
        const data = expandKeys<Vec3>(track.scales, clip.duration, 3,
          '片段 ' + clip.name + ' 骨骼 ' + track.boneId + ' 缩放');
        channels.push({ nodeIndex: node, path: 'scale', ...data });
      }
    }
    const morphChannel = prepareMorphChannel(clip, meshNodeIndex, morph);
    if (morphChannel) channels.push(morphChannel);
    if (channels.length === 0) {
      const root = skeleton.evalOrder.find(
        (id) => skeleton.parentIndex.get(id) === null,
      )!;
      const bind = skeleton.bindLocalTransform(root);
      channels.push({
        nodeIndex: nodeIndex.get(root)!,
        path: 'translation',
        times: new Float32Array([0, clip.duration]),
        values: new Float32Array([
          bind.translation[0], bind.translation[1], bind.translation[2],
          bind.translation[0], bind.translation[1], bind.translation[2],
        ]),
      });
    }
    return { name: clip.name, duration: clip.duration, channels };
  });
}
