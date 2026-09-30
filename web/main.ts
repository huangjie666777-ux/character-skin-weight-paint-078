import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  AttachmentManager,
  DeformedCharacter,
  Skeleton,
  evaluatePose,
  pickTriangle,
  sampleMorphWeights,
  type CharacterTransform,
  type DeformedFrame,
  type Vec3,
} from '../src/index.js';
import { demoBones, demoClip, demoMesh } from './rig.js';

const skeleton = new Skeleton(demoBones());
const clip = demoClip();

// 两个独立实例：各自的世界平移 / 旋转 / 正的非均匀缩放，互不共享状态。
const transforms: Record<string, CharacterTransform> = {
  alpha: { translation: [-1.1, 0, 0], rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)], scale: [1, 1, 1] },
  beta: { translation: [1.1, 0, 0.3], rotation: [0, Math.sin(-0.3), 0, Math.cos(-0.3)], scale: [1.25, 0.9, 1.1] },
};
const characters = [
  new DeformedCharacter('alpha', skeleton, demoMesh(), transforms.alpha),
  new DeformedCharacter('beta', skeleton, demoMesh(), transforms.beta),
];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c2330);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.8, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(3, 6, 4);
scene.add(sun);
scene.add(new THREE.GridHelper(10, 20, 0x445066, 0x2c3547));

// 每个实例一个显示网格；顶点每帧由变形帧（与拾取、挂件同源）写回。
const bodyMeshes = new Map<string, THREE.Mesh>();
const bodyColors: Record<string, number> = { alpha: 0x7fb2e5, beta: 0xe5a37f };
for (const character of characters) {
  const geometry = new THREE.BufferGeometry();
  const count = character.mesh.positions.length;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setIndex([...character.mesh.indices]);
  const material = new THREE.MeshStandardMaterial({
    color: bodyColors[character.id],
    roughness: 0.75,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = character.id;
  scene.add(mesh);
  bodyMeshes.set(character.id, mesh);
}

// 挂件可视化：圆徽 + 切向箭头，朝向完全来自挂件求值结果。
const badgeGroup = new Map<string, THREE.Group>();
const discMaterial = new THREE.MeshBasicMaterial({ color: 0xffd34d, side: THREE.DoubleSide });
const selectedMaterial = new THREE.MeshBasicMaterial({ color: 0x7dff8a, side: THREE.DoubleSide });
function ensureBadge(id: string): THREE.Group {
  let group = badgeGroup.get(id);
  if (group) return group;
  group = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), discMaterial);
  disc.name = 'disc';
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.018, 0.06, 10),
    new THREE.MeshBasicMaterial({ color: 0xff5d5d }),
  );
  // 切向为局部 +X：圆锥默认朝 +Y，绕 Z 转 -90°。
  arrow.rotation.z = -Math.PI / 2;
  arrow.position.x = 0.1;
  group.add(disc, rim, arrow);
  scene.add(group);
  badgeGroup.set(id, group);
  return group;
}

const manager = new AttachmentManager();

// UI
const ui = document.getElementById('ui')!;
ui.innerHTML = [
  '<div class="row">',
  '  <button id="play">暂停</button>',
  '  <input id="time" type="range" min="0" max="' + clip.duration + '" step="0.001" value="0">',
  '  <span id="clock">0.00</span>',
  '</div>',
  '<div class="row">',
  '  <label>偏移 <input id="offset" type="range" min="-0.3" max="0.5" step="0.005" value="0.1"></label>',
  '  <button id="delete">删除选中</button>',
  '  <label><input id="squash" type="checkbox"> 压塌头部（退化演示）</label>',
  '</div>',
  '<div class="row">',
  '  <button id="export">导出 JSON</button>',
  '  <button id="import">导入 JSON</button>',
  '</div>',
  '<textarea id="json" rows="5" placeholder="挂件 JSON"></textarea>',
  '<div id="status">点击角色表面放置徽章；点击徽章选中。</div>',
].join('');
const playButton = document.getElementById('play') as HTMLButtonElement;
const timeSlider = document.getElementById('time') as HTMLInputElement;
const clockLabel = document.getElementById('clock')!;
const offsetSlider = document.getElementById('offset') as HTMLInputElement;
const deleteButton = document.getElementById('delete') as HTMLButtonElement;
const squashToggle = document.getElementById('squash') as HTMLInputElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const importButton = document.getElementById('import') as HTMLButtonElement;
const jsonArea = document.getElementById('json') as HTMLTextAreaElement;
const statusLine = document.getElementById('status')!;

let playing = true;
let time = 0;
playButton.onclick = () => {
  playing = !playing;
  playButton.textContent = playing ? '暂停' : '播放';
};
timeSlider.oninput = () => {
  time = Number(timeSlider.value);
};
offsetSlider.oninput = () => {
  const selected = manager.selected;
  if (!selected) return;
  manager.setOffset(selected.id, Number(offsetSlider.value));
};
deleteButton.onclick = () => {
  const selected = manager.selected;
  if (selected) manager.remove(selected.id);
};
exportButton.onclick = () => {
  jsonArea.value = manager.exportJSON(characters);
  statusLine.textContent = '已导出 ' + manager.list().length + ' 个挂件。';
};
importButton.onclick = () => {
  try {
    const loaded = manager.importJSON(jsonArea.value, characters);
    statusLine.textContent = '导入成功：' + loaded.length + ' 个挂件。';
  } catch (error) {
    statusLine.textContent = '导入失败（已保留当前挂件）：' + (error as Error).message;
  }
};

// 拾取：点击空白不创建；点徽章选中；点表面放置新徽章。
const raycaster = new THREE.Raycaster();
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  downAt = [event.clientX, event.clientY];
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!downAt) return;
  const moved = Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return; // 拖动视角，不触发拾取
  const ndc = new THREE.Vector2(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const badgeHits = raycaster.intersectObjects([...badgeGroup.values()], true);
  if (badgeHits.length > 0) {
    let node: THREE.Object3D | null = badgeHits[0].object;
    while (node && !node.userData.attachmentId) node = node.parent;
    if (node) {
      manager.select(node.userData.attachmentId);
      const selected = manager.selected;
      if (selected) offsetSlider.value = String(selected.offset);
      statusLine.textContent = '已选中 ' + node.userData.attachmentId;
      return;
    }
  }
  const origin = raycaster.ray.origin;
  const direction = raycaster.ray.direction;
  const hit = pickTriangle(currentFrames, {
    origin: [origin.x, origin.y, origin.z],
    direction: [direction.x, direction.y, direction.z],
  });
  if (!hit) {
    statusLine.textContent = '空白处不创建挂件。';
    return;
  }
  const attachment = manager.addFromHit(hit, Number(offsetSlider.value));
  statusLine.textContent = '已在 ' + hit.characterId + ' 的三角形 ' + hit.triangleIndex
    + ' 放置 ' + attachment.id + '。';
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let currentFrames: DeformedFrame[] = [];
const clock = new THREE.Clock();

function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) {
    time = (time + dt) % clip.duration;
    timeSlider.value = String(time);
  }
  clockLabel.textContent = time.toFixed(2);

  // 同一帧姿态同时驱动两个实例的显示、拾取与挂件。
  const pose = evaluatePose(skeleton, { clip, time, loop: 'loop' });
  const weights = sampleMorphWeights(clip, characters[0].mesh.morphTargets ?? [], time, 'loop');
  if (squashToggle.checked) {
    const squashIndex = (characters[0].mesh.morphTargets ?? []).findIndex((t) => t.name === 'squash');
    if (squashIndex >= 0) weights[squashIndex] = 1;
  }

  const framesById = new Map<string, DeformedFrame>();
  currentFrames = characters.map((character) => {
    const frame = character.evaluateFrame(pose.worldMatrices, weights);
    framesById.set(character.id, frame);
    const geometry = bodyMeshes.get(character.id)!.geometry;
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    frame.positions.forEach((p: Vec3, i: number) => attribute.setXYZ(i, p[0], p[1], p[2]));
    attribute.needsUpdate = true;
    geometry.computeVertexNormals();
    return frame;
  });

  // 挂件求值与显示使用同一批帧。
  const poses = manager.evaluate(framesById);
  const alive = new Set<string>();
  let hiddenCount = 0;
  for (const attachmentPose of poses) {
    alive.add(attachmentPose.attachmentId);
    const group = ensureBadge(attachmentPose.attachmentId);
    group.userData.attachmentId = attachmentPose.attachmentId;
    group.visible = attachmentPose.visible;
    if (!attachmentPose.visible) hiddenCount++;
    group.position.set(...attachmentPose.position);
    group.quaternion.copy(attachmentPose.quaternion);
    const disc = group.getObjectByName('disc') as THREE.Mesh;
    disc.material = manager.selected?.id === attachmentPose.attachmentId ? selectedMaterial : discMaterial;
  }
  for (const [id, group] of badgeGroup) {
    if (!alive.has(id)) {
      scene.remove(group);
      badgeGroup.delete(id);
    }
  }
  if (hiddenCount > 0) {
    statusLine.textContent = hiddenCount + ' 个挂件所在面退化，已隐藏（恢复后自动继续）。';
  }

  controls.update();
  renderer.render(scene, camera);
}
tick();
