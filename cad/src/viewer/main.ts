import {
  ACESFilmicToneMapping,
  AxesHelper,
  Box3,
  Box3Helper,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices, toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AiModelDescriptor } from "../cad/ai/aiAdapter";
import "./viewer.css";

/**
 * Look-around viewer for generated models. Everything here is display: the
 * asset is shown in its own Y-up frame (sixview and glTF agree, and so does
 * three.js), recentred on the ground and scaled so its longest side is `SIZE`,
 * so a flat car and a tall figure frame alike. Colour comes from the asset: a
 * GLB's texture or vertex colours, or an OBJ's per-vertex colours.
 *
 * The ground carries the input frame — FRONT at +Z, BACK at -Z, LEFT at -X
 * (where the `left` view's camera stands), RIGHT at +X — so any orbit, including
 * straight down, shows which way the model faces.
 */

const SIZE = 2;

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
const select = document.querySelector<HTMLSelectElement>("#model");
const spin = document.querySelector<HTMLButtonElement>("#spin");
const reset = document.querySelector<HTMLButtonElement>("#reset");
const status = document.querySelector<HTMLParagraphElement>("#status");
if (!canvas || !select || !spin || !reset || !status) throw new Error("viewer.html markup is missing an element");

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
// Environment + key light already sum past 1 on a white albedo; this keeps white
// subjects (a white character body) from clipping to a flat, shapeless white.
renderer.toneMappingExposure = 0.8;

const scene = new Scene();
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const key = new DirectionalLight(new Color("#ffffff"), 0.9);
key.position.set(2.5, 4, 3);
scene.add(key);
scene.add(contactShadow());
scene.add(directionMarkers());

const camera = new PerspectiveCamera(35, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.5;

const stage = new Group();
scene.add(stage);

/** Camera offsets per preset, in units of `SIZE`; the orbit target is the model centre. */
const PRESETS: Record<string, readonly [number, number, number]> = {
  front: [0, 0.35, 2.2],
  back: [0, 0.35, -2.2],
  left: [-2.2, 0.35, 0],
  right: [2.2, 0.35, 0],
  // A hair of +Z keeps OrbitControls off its pole; FRONT then sits at the bottom of the screen.
  top: [0, 2.4, 0.001],
};

function frame(preset: readonly [number, number, number] = [1.3, 0.8, 1.9]): void {
  camera.position.set(preset[0] * SIZE, preset[1] * SIZE, preset[2] * SIZE);
  controls.target.set(0, SIZE * 0.15, 0);
  controls.update();
}

/** Flat text label lying on the ground plane, readable from the default camera. */
function groundLabel(text: string, colour: string): Mesh {
  const paint = document.createElement("canvas");
  paint.width = 256;
  paint.height = 64;
  const context = paint.getContext("2d");
  if (context) {
    context.font = "bold 40px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = colour;
    context.fillText(text, 128, 34);
  }
  const label = new Mesh(
    new PlaneGeometry(SIZE * 0.36, SIZE * 0.09),
    new MeshBasicMaterial({ map: new CanvasTexture(paint), transparent: true, depthWrite: false }),
  );
  label.rotation.x = -Math.PI / 2;
  return label;
}

/** FRONT/BACK/LEFT/RIGHT on the ground plus an arrow toward FRONT, fixed in the input frame. */
function directionMarkers(): Group {
  const markers = new Group();
  const reach = SIZE * 0.68;
  const place = (label: Mesh, x: number, z: number): void => {
    label.position.set(x, 0.002, z);
    markers.add(label);
  };
  place(groundLabel("FRONT", "#fbbf24"), 0, reach);
  place(groundLabel("BACK", "#9aa3b2"), 0, -reach);
  place(groundLabel("LEFT", "#9aa3b2"), -reach, 0);
  place(groundLabel("RIGHT", "#9aa3b2"), reach, 0);

  const arrowPaint = document.createElement("canvas");
  arrowPaint.width = arrowPaint.height = 64;
  const context = arrowPaint.getContext("2d");
  if (context) {
    context.fillStyle = "#fbbf24";
    context.beginPath();
    context.moveTo(32, 60);
    context.lineTo(8, 20);
    context.lineTo(56, 20);
    context.closePath();
    context.fill();
  }
  const arrow = new Mesh(
    new PlaneGeometry(SIZE * 0.1, SIZE * 0.1),
    new MeshBasicMaterial({ map: new CanvasTexture(arrowPaint), transparent: true, depthWrite: false }),
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.002, reach - SIZE * 0.11);
  markers.add(arrow);
  return markers;
}

function resize(): void {
  const { clientWidth: width, clientHeight: height } = canvas!;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

/** Soft radial blob under the model: grounds it without a shadow-map pass. */
function contactShadow(): Mesh {
  const size = 128;
  const paint = document.createElement("canvas");
  paint.width = paint.height = size;
  const context = paint.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(0,0,0,0.35)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const plane = new Mesh(
    new PlaneGeometry(SIZE * 1.4, SIZE * 1.4),
    new MeshBasicMaterial({ map: new CanvasTexture(paint), transparent: true, depthWrite: false }),
  );
  plane.rotation.x = -Math.PI / 2;
  return plane;
}

/**
 * OBJ output carries colour per vertex and repeats vertices per face; welding
 * them gives smooth normals, so the surface shades as a surface instead of as
 * faceted clay.
 */
function smoothVertexColoured(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry: BufferGeometry = child.geometry;
    const hasColor = geometry.getAttribute("color") !== undefined;
    geometry.deleteAttribute("normal");
    const welded = mergeVertices(geometry, 1e-5);
    welded.computeVertexNormals();
    child.geometry = welded;
    child.material = new MeshStandardMaterial({ vertexColors: hasColor, roughness: 0.55, metalness: 0 });
  });
}

/** Faces meeting at less than this share a normal; sharper edges (wing tips, tyre walls) stay crisp. */
const CREASE_ANGLE = (50 * Math.PI) / 180;

/**
 * Generated GLBs (TRELLIS) ship positions and UVs but no normals, so GLTFLoader
 * falls back to flat shading and every triangle shows. They also omit
 * `metallicFactor`, whose glTF default of 1 turns the texture into dark metal,
 * and pin roughness to 1. Creased normals plus a dielectric, semi-gloss
 * material show the surface as painted instead of as faceted clay.
 */
function smoothGeneratedGlb(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry: BufferGeometry = child.geometry;
    if (geometry.getAttribute("normal") !== undefined) return;
    child.geometry = toCreasedNormals(geometry, CREASE_ANGLE);
    geometry.dispose();
    const materials: Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      material.flatShading = false;
      if (!material.metalnessMap) material.metalness = 0;
      if (!material.roughnessMap) material.roughness = 0.45;
      material.needsUpdate = true;
    }
  });
}

function dispose(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    const materials: Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

async function load(model: AiModelDescriptor): Promise<void> {
  const asset = model.asset;
  if (!asset?.url) throw new Error(`${model.name}: 3D 파일이 없습니다`);
  status!.textContent = `${model.name} 불러오는 중…`;
  const buffer = await (await fetch(asset.url)).arrayBuffer();

  let root: Object3D;
  if (asset.format === "glb" || asset.format === "gltf") {
    root = (await new GLTFLoader().parseAsync(buffer, "")).scene;
    smoothGeneratedGlb(root);
  } else if (asset.format === "obj") {
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    smoothVertexColoured(root);
  } else {
    throw new Error(`${model.name}: 뷰어가 읽지 못하는 형식 (${asset.format})`);
  }

  // Longest side to SIZE, centred over the origin, resting on the ground plane.
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const scale = SIZE / Math.max(size.x, size.y, size.z, 1e-6);
  root.scale.setScalar(scale);
  const centre = box.getCenter(new Vector3());
  root.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  for (const previous of [...stage.children]) {
    stage.remove(previous);
    dispose(previous);
  }
  stage.add(root);
  current = { id: model.id, root };
  applyDisplay();
  frame();
  status!.textContent = `${model.name} · ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`;
}

/** Display toggles; they restyle whatever is loaded and survive switching models. */
const display = { wireframe: false, flat: false, bbox: false };
let current: { id: string; root: Object3D } | null = null;
const bboxHelper = new Box3Helper(new Box3(), new Color("#fbbf24"));
bboxHelper.visible = false;
scene.add(bboxHelper);

function applyDisplay(): void {
  if (!current) return;
  current.root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const materials: Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      material.wireframe = display.wireframe;
      material.flatShading = display.flat;
      material.needsUpdate = true;
    }
  });
  current.root.updateWorldMatrix(true, true);
  bboxHelper.box.setFromObject(current.root);
  bboxHelper.visible = display.bbox;
}

/** XYZ gizmo at the ground centre: red +X (object right), green +Y (up), blue +Z (front). */
function axesGizmo(): Group {
  const gizmo = new Group();
  const length = SIZE * 0.45;
  gizmo.add(new AxesHelper(length));
  const labels: Array<[string, string, Vector3]> = [
    ["+X", "#f87171", new Vector3(length * 1.08, 0, 0)],
    ["+Y", "#4ade80", new Vector3(0, length * 1.08, 0)],
    ["+Z", "#60a5fa", new Vector3(0, 0, length * 1.08)],
  ];
  for (const [text, colour, at] of labels) {
    const paint = document.createElement("canvas");
    paint.width = paint.height = 64;
    const context = paint.getContext("2d");
    if (context) {
      context.font = "bold 34px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = colour;
      context.fillText(text, 32, 34);
    }
    const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(paint), depthTest: false }));
    sprite.scale.setScalar(SIZE * 0.08);
    sprite.position.copy(at);
    gizmo.add(sprite);
  }
  return gizmo;
}
const gizmo = axesGizmo();
scene.add(gizmo);

async function main(): Promise<void> {
  const response = await fetch("/api/cad/models", { cache: "no-store" });
  if (!response.ok) throw new Error(`모델 목록을 읽지 못했습니다 (${response.status})`);
  const models = ((await response.json()) as AiModelDescriptor[]).filter((model) => model.asset?.url);
  if (models.length === 0) {
    status!.textContent = "보여줄 3D 모델이 없습니다. 미리보기 화면에서 3D 만들기를 먼저 실행하세요.";
    return;
  }
  // The smooth mesh first; the voxel view and anything else follow.
  models.sort((a, b) => Number(b.id === "model-glb") - Number(a.id === "model-glb"));
  for (const model of models) select!.add(new Option(model.name, model.id));
  const show = (id: string): void => {
    const chosen = models.find((model) => model.id === id);
    if (!chosen) return;
    select!.value = id;
    load(chosen).catch(showError);
  };
  select!.addEventListener("change", () => show(select!.value));
  voxelToggle?.addEventListener("click", () => show(current?.id === "voxels" ? "model-glb" : "voxels"));
  const [first] = models;
  if (first) await load(first);
}

function showError(error: unknown): void {
  status!.textContent = error instanceof Error ? error.message : String(error);
  status!.classList.add("status--error");
}

spin.addEventListener("click", () => {
  controls.autoRotate = !controls.autoRotate;
  spin.setAttribute("aria-pressed", String(controls.autoRotate));
});
reset.addEventListener("click", () => frame());
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-view]")) {
  const preset = PRESETS[button.dataset["view"] ?? ""];
  if (!preset) continue;
  button.addEventListener("click", () => {
    controls.autoRotate = false;
    spin.setAttribute("aria-pressed", "false");
    frame(preset);
  });
}
const voxelToggle = document.querySelector<HTMLButtonElement>("#voxels");
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-toggle]")) {
  const key = button.dataset["toggle"];
  if (key !== "wireframe" && key !== "flat" && key !== "bbox" && key !== "axes") continue;
  button.addEventListener("click", () => {
    if (key === "axes") gizmo.visible = !gizmo.visible;
    else display[key] = !display[key];
    button.setAttribute("aria-pressed", String(key === "axes" ? gizmo.visible : display[key]));
    applyDisplay();
  });
}
window.addEventListener("resize", resize);

resize();
frame();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
main().catch(showError);
