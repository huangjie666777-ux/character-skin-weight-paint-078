# Skeletal Animation 038

TypeScript 5.8 + Three.js 0.180 的可复用骨骼动画库：分层混合（基础层 + 遮罩覆盖层）、根运动播放实例（循环行走推进角色）、混合后两骨骼 IK（角色空间与世界固定目标）末端贴合、CPU 线性蒙皮（角色/世界输出）、跨骨架**动作重定向**（不同骨名、绑定朝向、骨长复用同一动作，目标可插入未映射中间骨），以及自包含 glTF 2.0 **GLB 资产导出**。

## 命令

- `npm run build` — 构建库到 `dist/`（含类型声明）
- `npm test` — 编译并运行全部单元测试
- `npm run example` — 运行“行走 + 局部挥手 + 右手 IK 贴合”示例，打印混合姿态、IK 结果与变形顶点
- `npm run example:target` — 运行“循环根运动行走 + 手部贴合固定世界目标 + 世界蒙皮”完整示例
- `npm run example:retarget` — 运行“源片段重定向到异构目标骨架 + 根运动播放 + 世界 IK + 世界蒙皮”完整示例
- `npm run example:face` — 构建并运行“身体动作 + 微笑/眨眼/口型”，导出 GLB 后用 `GLTFLoader` 回载验证
- `npm run dev` — 启动表面挂件演示页面（Vite 开发服务器，浏览器打开终端提示的地址）
- `npm run build:web` — 类型检查并构建演示页面到 `dist-web/`
- `npm run preview` — 预览构建后的演示页面

## 数据约定

- **坐标系**：右手坐标，Y 向上。向量 `[x, y, z]`，四元数 `[x, y, z, w]` 且必须为单位四元数。
- **骨骼**（`BoneSpec`）：唯一 `id`、`parentId`（根为 `null`）、绑定局部平移/旋转/正缩放。输入允许乱序；构建时校验重复 ID、未知父级、循环与非法数值（NaN/Infinity、非单位四元数、非正缩放）。
- **矩阵**：局部矩阵按 平移×旋转×缩放 组合；世界矩阵由父级向下累乘；逆绑定矩阵在构建时由绑定姿态求逆。
- **片段**（`AnimationClip`）：正时长；每条轨道按骨骼分别给出平移/旋转/缩放关键帧，时间严格递增且位于 `[0, duration]`。平移与缩放线性插值，旋转沿最短弧球面插值并保持单位四元数；轨道两端之外夹取端值；缺失轨道回退绑定值。
- **表情形变**（`MorphTarget` / `MorphWeightTrack`）：`TriangleMesh.morphTargets` 按数组顺序保存唯一命名目标，每个目标给出与绑定顶点一一对应的角色空间位移和可选 `defaultWeight`。默认权重缺省为 0，运行时权重必须在 `[0, 1]`；各目标独立线性叠加，权重和不归一化。`AnimationClip.morphTracks` 按目标名称索引标量权重，关键帧与骨骼通道共用同一时钟，线性插值并在首尾延续；缺失轨道取默认权重。`once` 末帧保持最终权重，`loop` 按时长循环，只有表情轨道的片段也可播放。
- **采样**：时间必须非负。`once` 停在末帧；`loop` 按时长取模。
- **分层混合**（`evaluatePose`）：一个基础层 + 一个可选覆盖层，各自有独立采样时间与循环模式。覆盖层骨骼权重 = `strength × 遮罩权重`（均 ∈ [0,1]）。遮罩未指定的骨骼继承最近祖先权重，根默认 0，显式 0 屏蔽继承。先混合局部姿态，再由父级累乘世界矩阵——不直接混合世界矩阵。
- **两骨骼 IK**（`solveTwoBoneIk`）：接收完整局部姿态与直接相连的 `rootJoint -> middleJoint -> endJoint`，在混合姿态后修改根关节和中间关节的局部旋转。目标点与弯曲参考点均为角色空间；局部平移、缩放、骨段长度、末端局部姿态及其余关节保持不变。IK 链及其祖先仅支持单位缩放，骨段平移长度必须非零。
- **IK 夹取与权重**：目标过远/过近时，沿根关节到目标方向夹到两段长度确定的最近可达位置；结果返回 `reachable`、`distanceToTarget`、`actualEndPosition` 和 `clampedTarget`。目标与根重合或弯曲方向共线时优先使用当前弯曲平面，再退化到确定性参考轴。`weight=0` 保持原姿态，`weight=1` 完整贴合，中间值对输入/求解旋转做最短弧插值。
- **根运动**（`RootMotion` / `RootMotionPlayer`）：从基础片段提取指定**顶层根骨骼**（`parentId === null`）的平移与旋转，以片段起始根变换 M0 为参考，任意时刻的相对运动为 `M(t)·M0⁻¹`（刚体矩阵顺序复合，不直接相加位移，也不夹带绑定位置）。`loop` 跨圈时按 `Kⁿ·D(r)` 复合：整圈运动 K 复合 n 次再乘余段 D(r)，包含末帧；分步推进与一次推进到同一时刻结果一致；`once` 到末帧后不再移动。根及角色仅支持单位缩放（绑定与片段缩放关键帧均校验）。
- **播放实例**（`RootMotionPlayer.advance(dt, overlay?)`）：实例持有骨架、基础片段、根骨骼、播放模式与初始角色刚体变换，以非负有限时间增量推进；非法增量或覆盖层参数抛错且**不推进状态**。返回角色刚体变换（`character` / `characterMatrix`）、完整局部姿态与角色空间骨骼矩阵（`worldMatrices`）。根运动只作用于角色变换，姿态中的根始终钉回片段起始变换，避免双重运动；覆盖层根权重恒为 0，可影响其他骨骼但不能改变根或贡献根运动（旧 `evaluatePose` 接口保持不变）。屏蔽根时仅置零根自身权重，不会误清空后代从遮罩祖先继承的权重（该缺陷已修复）。
- **世界 IK**（`solveWorldTwoBoneIk`）：世界目标与弯曲参考点经当前角色刚体矩阵的逆变换转入角色空间后复用 `solveTwoBoneIk`，再把末端变换回世界，返回世界末端位置、可达性与残差。角色矩阵仅允许单位缩放；目标与根重合时优先沿用当前弯曲平面。
- **蒙皮**（`skinVertices` / `skinVerticesToWorld`）：输入绑定姿态顶点与每顶点至多 4 个骨骼权重；非负权重归一化后做线性混合蒙皮。前者输出角色局部空间位置，后者在角色空间蒙皮后对每个顶点只施加**一次**角色矩阵得到世界坐标，不会把角色世界矩阵重复乘入骨骼矩阵。零总权重顶点保持原位置；未知骨骼与负权重抛错。不修改任何输入，输入与已返回结果不会被后续推进改写，多实例互不共享状态。
- **表情 CPU 求值**（`sampleMorphWeights` / `applyMorphTargets` / `skinTriangleMesh` / `evaluateTriangleMesh`）：可先采样片段权重，再把加权位移加到绑定顶点，最后把形变后的绑定顶点交给现有骨骼姿态执行线性混合蒙皮；因此可直接接 `evaluatePose`、分层混合、根运动播放器或 IK 输出的 `worldMatrices`。输入始终只读，返回新数组，不同角色和不同调用不共享中间状态。
- **动作重定向**（`RetargetPlan` / `retargetPose` / `bakeRetargetedClip`）：`RetargetPlan` 接收源骨架、目标骨架与根相对应的一一骨骼映射（`{sourceBoneId, targetBoneId}`），校验双方均为单根、绑定单位缩放、相同坐标轴约定，映射不含未知骨/重复骨、必须包含双方顶层根且保持祖先/后代次序；目标允许在映射骨之间插入未映射中间骨。计划可重复使用，构造与转换均不改写输入。
  - 姿态转换：映射骨的旋转差为「源当前全局旋转 × 源绑定全局旋转⁻¹」，再左乘目标绑定全局旋转得到目标当前全局旋转，按目标当前父全局旋转还原局部旋转；因此源绑定姿态必定映成目标绑定姿态，且目标自身的绑定朝向偏移被保留。未映射骨保留目标绑定局部旋转，但按目标求值顺序继承已运动父级的全局旋转。非根平移与缩放恒保留目标绑定值（目标骨长不变）。
  - 根运动：根旋转同样按映射规则转换；根平移 = 目标绑定根位置 +（源当前根位置 − 源绑定根位置）× `rootTranslationScale`（有限正倍率，缺省 1），根缩放保留目标绑定值。`retargetPose` 返回全新 `Map`，后续转换不会改写先前结果。
  - 片段烘焙：`bakeRetargetedClip(plan, sourceClip, { sampleTimes, rootTranslationScale, name })` 按调用方给定的**严格递增**采样时刻烘焙，时刻必须从 0 开始并以源片段时长结束（含两端）；终点按末帧直接采样，不会折回首帧。输出片段时长与源相同，轨道使用目标骨 ID（映射骨旋转轨道 + 根平移轨道，无非根平移/缩放轨道），采样点姿态与逐点 `retargetPose` 完全一致，可直接交给现有 `RootMotionPlayer` 播放根运动。
- **GLB 导出**（`exportCharacterGlb`）：接收一个单根 `Skeleton`、一个绑定姿态角色空间 `TriangleMesh` 与多个既有 `AnimationClip`，返回内存中的 GLB `ArrayBuffer`。GLB 使用 glTF 2.0、单个内嵌 BIN 缓冲，无外部 `uri` 引用；无需材质、贴图、法线或相机。节点按骨架求值顺序排列，完整保留乱序输入骨骼的父子层级和绑定局部 TRS；`skin.joints`、逆绑定矩阵、`JOINTS_0`/`WEIGHTS_0` 使用相同关节序号。每顶点最多 4 个影响，导出前校验未知骨、负权重、零总权重、非有限顶点/权重和越界三角索引，权重在复制出的四槽数据中归一化，不修改调用方输入。
- **导出动画语义**：每个输入片段生成同名 glTF animation，导出平移、旋转和缩放三类局部节点通道以及网格节点 `weights` 通道，sampler 均为 `LINEAR`；Three.js 的 `QuaternionKeyframeTrack` 对旋转执行最短弧 SLERP。morph target 写入 `primitive.targets[].POSITION`，顺序不变；名称写入标准 `extras.targetNames`，默认权重写入 mesh `weights`。不同目标的关键帧时刻可不同，导出时在同一 `weights` sampler 中使用这些时刻的并集，并为缺失目标填入其当前默认/端值，保证 Three.js 逐分量线性插值与库内一致。通道关键帧未覆盖 0 或片段时长时自动在首尾延续端值；缺失通道不写入，由 glTF 节点绑定值表达。输入轨道终点保留原末帧，不折回零或首帧。重定向片段中的根位移只作为普通根节点局部平移导出一次，不叠加 `RootMotionPlayer` 的角色世界位移。有限但超出 Float32 范围的坐标或位移会在导出前拒绝，避免写入后变成 `Infinity`。
- **变形表面**（`DeformedCharacter` / `DeformedFrame`）：一个独立角色实例 = 骨架 + 形变网格 + 世界变换（平移、单位四元数旋转、**正的非均匀缩放**）。`evaluateFrame(worldMatrices, morphWeights?)` 复用“先形变后蒙皮”的 `skinTriangleMesh` 结果，再施加一次本实例世界矩阵得到世界坐标快照；多个实例可共用骨架/网格输入但各自持有独立帧缓存，互不串状态，输入不被修改。显示、拾取与挂件必须共用同一 `DeformedFrame`。
- **表面拾取**（`pickTriangle(frames, ray)`）：从屏幕点击生成单位方向射线，在若干角色的同一帧变形表面上做 Möller–Trumbore 求交，只命中**正面**三角形（按顶点绕序法向判定），退化面跳过，返回最近的 `{ characterId, triangleIndex, barycentric, distance }`；空白处返回 `null`（不创建挂件）。不使用绑定姿态或包围盒代替命中。
- **表面挂件**（`SurfaceAttachment` / `evaluateAttachment` / `AttachmentManager`）：挂件只保存角色标识、三角形序号与重心坐标，每帧在同一变形帧上重算世界位置 = 重心插值 + `offset × 世界单位法向`；朝向取变形后三角形**首条边为切向**、**顶点绕序为法向**（X=切向，Z=法向的正交基四元数）。暂停、拖动时间、重新播放都只改变帧输入，挂件始终贴附原三角形，绝不跳到其他面；面退化时 `visible=false`（隐藏并提示），恢复后自动继续。管理器支持添加（`addFromHit`）、选择、删除与偏移调整（`setOffset`）。
- **挂件导入导出**（`AttachmentManager.exportJSON / importJSON`）：导出 JSON 包含每个相关角色的拓扑校验信息（角色标识、顶点数、完整索引序列）与全部挂件。导入时先完整校验格式标识、版本、角色存在性、顶点数与索引序列一致性、三角形序号越界、重心坐标（三个非负有限数且和为 1）与偏移有限性；**任一失败都抛错并完整保留当前挂件**，全部通过后整体替换。

## 快速上手

```ts
import { Skeleton, evaluatePose, solveTwoBoneIk, skinVertices } from './dist/index.js';

const skeleton = new Skeleton(bones);            // BoneSpec[]，可乱序
const pose = evaluatePose(
  skeleton,
  { clip: walkClip, time: t, loop: 'loop' },                       // 基础层
  { clip: waveClip, time: t, loop: 'loop', strength: 1,
    mask: { 'arm.R': 1 } },                                        // 仅右臂覆盖
);
const ik = solveTwoBoneIk(skeleton, pose.localPose, {
  rootJointId: 'spine',
  middleJointId: 'arm.R',
  endJointId: 'hand.R',
  target: [0.52, 1.12, 0.2],
  bendReference: [0.2, 1.65, 0.05],
  weight: 1,
});
const positions = skinVertices(skeleton, bindVertices, skinWeights, ik.worldMatrices);
```

让微笑、眨眼和口型与身体动作同步，再执行 CPU 蒙皮：

```ts
import { evaluatePose, evaluateTriangleMesh } from './dist/index.js';

const faceClip = {
  name: 'walk-face',
  duration: 1,
  tracks: walkClip.tracks,
  morphTracks: [
    { targetName: 'smile', keys: [{ time: 0, value: 0.2 }, { time: 1, value: 1 }] },
    { targetName: 'blink', keys: [{ time: 0.45, value: 0 }, { time: 0.55, value: 1 }] },
  ],
};
const pose = evaluatePose(skeleton, { clip: faceClip, time: t, loop: 'loop' });
const facePositions = evaluateTriangleMesh(skeleton, mesh, faceClip, t, 'loop', pose.worldMatrices);
```

运行 `npm run example:face` 可查看完整的身体动作 + 表情 GLB 导出和 `GLTFLoader` 回载比对。

根运动循环行走并贴合固定世界目标：

```ts
import {
  RootMotionPlayer, solveWorldTwoBoneIk, skinVerticesToWorld,
} from './dist/index.js';

const player = new RootMotionPlayer({
  skeleton, clip: walkClip, rootBoneId: 'hips', mode: 'loop',
  initialTransform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
});
for (const dt of [0.1, 0.1 /* ... */]) {
  const frame = player.advance(dt); // 角色随循环片段推进，姿态根钉在起始变换
  const ik = solveWorldTwoBoneIk(skeleton, frame.localPose, {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    worldTarget: [1.3, 1.35, 0.1],          // 固定世界目标
    worldBendReference: [1.0, 1.85, 0.4],
    characterMatrix: frame.characterMatrix,
    weight: 1,
  });
  // 世界顶点：角色矩阵仅在此应用一次
  const worldPositions = skinVerticesToWorld(
    skeleton, bindVertices, skinWeights, ik.worldMatrices, frame.characterMatrix,
  );
}
```

完整可运行示例见 `examples/walk-wave.ts` 与 `examples/walk-target.ts`，测试用骨架/片段见 `test/helpers.ts`。

动作重定向到骨名、绑定朝向、骨长均不同的目标骨架，烘焙后播放并叠加世界 IK/蒙皮：

```ts
import {
  Skeleton, RetargetPlan, bakeRetargetedClip, RootMotionPlayer,
  solveWorldTwoBoneIk, skinVerticesToWorld, retargetPose,
} from './dist/index.js';

const plan = new RetargetPlan({
  source: sourceSkeleton,
  target: targetSkeleton, // 可含未映射中间骨
  mapping: [
    { sourceBoneId: 'hips', targetBoneId: 'j_hips' },
    { sourceBoneId: 'spine', targetBoneId: 'j_spine' },
    // ...一一对应，必须含双方根
  ],
});

// 逐帧直接转换（例如交互/运行时重定向）。
const targetPose = retargetPose(plan, sourcePose, 0.75);

// 或烘焙为目标片段，时长不变，可直接交给现有根运动播放器。
const targetClip = bakeRetargetedClip(plan, sourceClip, {
  sampleTimes: [0, 0.25, 0.5, 0.75, 1], // 严格递增、含 0 与 duration
  rootTranslationScale: 0.75,
});
const player = new RootMotionPlayer({
  skeleton: targetSkeleton, clip: targetClip, rootBoneId: 'j_hips', mode: 'loop',
});
```

完整示例见 `examples/retarget.ts`（`npm run example:retarget`）。

把转换后的目标骨架、绑定网格和多个烘焙片段打包给 Blender、Maya、Unity、Unreal 等支持 glTF 2.0 的工具：

```ts
import { exportCharacterGlb, type TriangleMesh } from './dist/index.js';

const mesh: TriangleMesh = {
  name: 'retarget-character',
  positions: bindSpaceVertices, // Vec3[]
  indices: triangleIndices,      // number[]，长度为 3 的倍数
  weights: perVertexWeights,      // SkinInfluence[][]，每顶点 1–4 个影响
};

const glb = exportCharacterGlb(targetSkeleton, mesh, [idleClip, walkClip, waveClip]);
await fs.writeFile('character.glb', Buffer.from(glb));
```

`examples/retarget.ts` 会复用 `bakeRetargetedClip` 的目标片段导出 GLB，再用 Three.js `GLTFLoader` 解析、`AnimationMixer` 播放，并把加载后的蒙皮矩阵结果与本库 `sampleClip`/`skinVertices` 在同一时刻对比。

## 演示页面

- 运行 `npm run dev` 后打开终端提示的地址（默认 http://localhost:5173/）。页面内置两个独立角色实例（`alpha` 均匀缩放、`beta` 非均匀缩放），各自做行走 + 挥手骨骼动作并循环播放微笑表情，无需外部模型下载。
- **旋转视角**：鼠标拖动旋转，滚轮缩放。
- **播放控制**：「暂停/播放」按钮与时间滑块可暂停、拖动时间和重新播放，挂件始终贴附。
- **放置徽章**：点击运动中的角色表面，在最近正面三角形上放置徽章（黄色圆徽 + 红色切向箭头）；点击空白不创建。
- **选择/删除/偏移**：点击徽章选中（变绿），用「偏移」滑块沿世界单位法向推拉，「删除选中」移除。
- **退化演示**：勾选「压塌头部」后头部顶面退化为零面积，附着其上的徽章隐藏并在状态栏提示；取消勾选后自动恢复贴附。
- **导入导出**：「导出 JSON」把全部挂件（含角色拓扑校验信息）写入文本框；编辑或粘贴后点「导入 JSON」，校验失败会保留当前挂件并在状态栏说明原因。
- 页面每帧用同一批 `DeformedFrame` 同时驱动网格显示、点击拾取与挂件求值，三者不会看到不同的变形结果。

## 目录

- `src/types.ts` — 公共类型
- `src/skeleton.ts` — 骨架校验、绑定/世界/逆绑定矩阵
- `src/clip.ts` — 片段校验与关键帧采样
- `src/pose.ts` — 姿态采样、遮罩解析、分层混合
- `src/root-motion.ts` — 根运动提取、刚体复合与 loop 跨圈累计
- `src/player.ts` — `RootMotionPlayer` 播放实例（根钉起始、覆盖层不影响根）
- `src/ik.ts` — 两骨骼 IK 求解、可达范围夹取与权重混合
- `src/world-ik.ts` — 世界目标/弯曲参考点的角色空间适配
- `src/skinning.ts` — CPU 线性混合蒙皮
- `src/morph.ts` — 形变目标校验、权重采样、目标叠加与先形变后蒙皮
- `src/world-skin.ts` — 蒙皮结果到世界顶点（角色矩阵只应用一次）
- `src/retarget-plan.ts` — 重定向计划：映射/骨架校验与绑定全局旋转预计算
- `src/retarget-pose.ts` — 完整源局部姿态到完整目标局部姿态的层级转换
- `src/retarget-clip.ts` — 源片段按指定时刻烘焙为目标 `AnimationClip`
- `src/gltf-mesh.ts` — 网格/三角索引/四影响权重校验与 glTF 适配
- `src/gltf-animation.ts` — 库片段到 glTF 局部 TRS 与 morph weights 通道转换
- `src/glb-encoder.ts` — 访问器、bufferView、节点、skin、animation 与 GLB 二进制分块编码
- `src/surface.ts` — 角色世界变换、变形帧求值与射线正面三角形拾取
- `src/attachments.ts` — 表面挂件求值、管理与 JSON 导入导出（拓扑校验）
- `src/index.ts` — 统一导出入口
- `web/rig.ts` — 演示用程序化角色（骨架、盒子网格、行走/挥手/表情片段）
- `web/main.ts` — 演示页面：双实例渲染、点击拾取、挂件可视化与 UI 联动
