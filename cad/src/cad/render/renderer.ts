import {
  AmbientLight, AxesHelper, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight,
  DoubleSide, GridHelper, Group, Line3, LineBasicMaterial, LineSegments, MathUtils, Matrix4, Mesh,
  MeshStandardMaterial, Object3D, OrthographicCamera, PerspectiveCamera, Plane, Quaternion,
  Raycaster, Scene, Sphere, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { CadDocument, CadObject, MeshAsset, TessellationResult, Transform, Vec3 } from "../core/types";
import { isEffectivelyVisible } from "../core/objectManager";
import { matrixToTransform } from "../core/transforms";

export type ViewPreset = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";
export type TransformMode = "translate" | "rotate" | "scale";

export interface TransformUpdate {
  id: string;
  transform: Transform;
  scale?: Vec3;
}

interface Entry {
  node: Group;
  mesh: Mesh | null;
  edges: LineSegments | null;
  kind: CadObject["kind"];
  colorHex: string;
  /** Identity of the geometry currently uploaded, to skip redundant uploads. */
  geometryToken: string;
}

const SELECTED_EMISSIVE = 0x2a6ff0;
const HOVER_EMISSIVE = 0x16324f;

/**
 * CADRenderer — owns the three.js scene and nothing else.
 *
 * It never computes geometry: solids arrive as tessellated buffers from the
 * kernel worker and meshes arrive as asset buffers. Its job is placement,
 * materials, picking and camera work. Scaling a solid here would be a lie, so
 * the scale gizmo is only offered for mesh objects.
 */
export class CADRenderer {
  readonly scene = new Scene();
  private renderer: WebGLRenderer;
  private perspective: PerspectiveCamera;
  private ortho: OrthographicCamera;
  private activeCamera: PerspectiveCamera | OrthographicCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private gizmoHelper: Object3D;
  private pivot = new Object3D();
  private root = new Group();
  private grid: Group;
  private axes: AxesHelper;
  private entries = new Map<string, Entry>();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private disposed = false;
  private frame = 0;
  private needsRender = true;

  private dragStartPivot = new Matrix4();
  private dragStartWorld = new Map<string, Matrix4>();
  private dragStartScale = new Map<string, Vec3>();
  private dragging = false;
  private selection: string[] = [];
  private hoverId: string | null = null;

  onSelect: ((id: string | null, additive: boolean) => void) | null = null;
  onTransformCommit: ((updates: TransformUpdate[]) => void) | null = null;
  onDragStateChange: ((dragging: boolean) => void) | null = null;

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    const { clientWidth: w, clientHeight: h } = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(Math.max(w, 1), Math.max(h, 1));
    this.renderer.setClearColor(0x14181f, 1);
    container.appendChild(this.renderer.domElement);

    // Z-up: matches mechanical CAD and the kernel's own frame, so "height" means
    // the same thing in the viewport, the dimension panel and the STEP file.
    Object3D.DEFAULT_UP.set(0, 0, 1);
    this.scene.up.set(0, 0, 1);

    const aspect = Math.max(w, 1) / Math.max(h, 1);
    this.perspective = new PerspectiveCamera(45, aspect, 1, 100000);
    this.perspective.up.set(0, 0, 1);
    this.perspective.position.set(220, -260, 180);

    const frustum = 260;
    this.ortho = new OrthographicCamera(-frustum * aspect, frustum * aspect, frustum, -frustum, -100000, 100000);
    this.ortho.up.set(0, 0, 1);
    this.ortho.position.copy(this.perspective.position);
    this.activeCamera = this.perspective;

    this.scene.add(new AmbientLight(0xffffff, 1.9));
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(300, -400, 600);
    this.scene.add(key);
    const fill = new DirectionalLight(0x9db4d0, 1.0);
    fill.position.set(-350, 300, -200);
    this.scene.add(fill);

    this.grid = buildGrid();
    this.scene.add(this.grid);
    this.axes = buildAxes();
    this.scene.add(this.axes);
    this.scene.add(this.root);
    this.scene.add(this.pivot);

    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => {
      this.needsRender = true;
    });

    this.gizmo = new TransformControls(this.activeCamera, this.renderer.domElement);
    this.gizmo.setSpace("world");
    this.gizmo.size = 0.85;
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.visible = false;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener("dragging-changed", (event) => {
      const value = Boolean((event as unknown as { value: boolean }).value);
      this.controls.enabled = !value;
      if (value) this.beginDrag();
      else this.endDrag();
      this.onDragStateChange?.(value);
      this.needsRender = true;
    });
    this.gizmo.addEventListener("objectChange", () => {
      this.applyDragDelta();
      this.needsRender = true;
    });

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);

    this.resizeObserver.observe(container);
    this.animate();
  }

  /* ----------------------------------------------------------------- loop */

  private resizeObserver = new ResizeObserver(() => this.resize());

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const damped = this.controls.update();
    if (damped || this.needsRender) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.activeCamera);
    }
  };

  invalidate() {
    this.needsRender = true;
  }

  resize() {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, true);
    const aspect = w / h;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const halfHeight = (this.ortho.top - this.ortho.bottom) / 2;
    this.ortho.left = -halfHeight * aspect;
    this.ortho.right = halfHeight * aspect;
    this.ortho.updateProjectionMatrix();
    this.needsRender = true;
  }

  /* ------------------------------------------------------------- scene sync */

  /** Reconciles the three.js tree with the document. Cheap when nothing moved. */
  syncScene(doc: CadDocument) {
    const seen = new Set<string>();

    // Create or update nodes.
    for (const object of Object.values(doc.objects)) {
      seen.add(object.id);
      let entry = this.entries.get(object.id);
      if (!entry || entry.kind !== object.kind) {
        if (entry) this.destroyEntry(object.id);
        entry = this.createEntry(object);
        this.entries.set(object.id, entry);
      }
      const node = entry.node;
      node.name = object.name;
      const t = object.transform;
      node.position.set(t.position[0], t.position[1], t.position[2]);
      node.rotation.set(
        MathUtils.degToRad(t.rotation[0]),
        MathUtils.degToRad(t.rotation[1]),
        MathUtils.degToRad(t.rotation[2]),
        "XYZ",
      );
      if (object.kind === "mesh") node.scale.set(object.scale[0], object.scale[1], object.scale[2]);
      else node.scale.set(1, 1, 1);
      node.visible = isEffectivelyVisible(doc, object.id);
      if (entry.colorHex !== object.color) {
        entry.colorHex = object.color;
        const material = entry.mesh?.material as MeshStandardMaterial | undefined;
        material?.color.set(object.color);
      }
    }

    // Remove deleted nodes.
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.destroyEntry(id);
    }

    // Re-parent according to the document tree.
    for (const object of Object.values(doc.objects)) {
      const entry = this.entries.get(object.id);
      if (!entry) continue;
      const desired = object.parentId ? this.entries.get(object.parentId)?.node ?? this.root : this.root;
      if (entry.node.parent !== desired) desired.add(entry.node);
    }

    this.refreshSelectionVisuals();
    this.needsRender = true;
  }

  private createEntry(object: CadObject): Entry {
    const node = new Group();
    node.userData.objectId = object.id;
    let mesh: Mesh | null = null;
    let edges: LineSegments | null = null;
    if (object.kind !== "group") {
      const material = new MeshStandardMaterial({
        color: new Color(object.color),
        metalness: 0.08,
        roughness: 0.55,
        side: DoubleSide,
        flatShading: false,
      });
      mesh = new Mesh(new BufferGeometry(), material);
      mesh.userData.objectId = object.id;
      mesh.frustumCulled = true;
      node.add(mesh);
      edges = new LineSegments(
        new BufferGeometry(),
        new LineBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.85 }),
      );
      edges.userData.objectId = object.id;
      edges.renderOrder = 1;
      node.add(edges);
    }
    this.root.add(node);
    return { node, mesh, edges, kind: object.kind, colorHex: object.color, geometryToken: "" };
  }

  private destroyEntry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.node.removeFromParent();
    entry.mesh?.geometry.dispose();
    (entry.mesh?.material as MeshStandardMaterial | undefined)?.dispose();
    entry.edges?.geometry.dispose();
    (entry.edges?.material as LineBasicMaterial | undefined)?.dispose();
    this.entries.delete(id);
  }

  /** Uploads kernel output for a solid. `token` identifies the build. */
  setSolidGeometry(id: string, result: TessellationResult, token: string) {
    const entry = this.entries.get(id);
    if (!entry?.mesh) return;
    if (entry.geometryToken === token) return;
    entry.geometryToken = token;

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(result.positions, 3));
    if (result.normals.length === result.positions.length) {
      geometry.setAttribute("normal", new BufferAttribute(result.normals, 3));
    }
    geometry.setIndex(new BufferAttribute(result.indices, 1));
    if (result.normals.length !== result.positions.length) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = geometry;

    const edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute("position", new BufferAttribute(result.edges, 3));
    entry.edges?.geometry.dispose();
    if (entry.edges) entry.edges.geometry = edgeGeometry;
    this.needsRender = true;
  }

  /** Uploads an imported/AI mesh asset. */
  setMeshGeometry(id: string, asset: MeshAsset) {
    const entry = this.entries.get(id);
    if (!entry?.mesh) return;
    if (entry.geometryToken === asset.id) return;
    entry.geometryToken = asset.id;

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(asset.positions, 3));
    if (asset.indices) geometry.setIndex(new BufferAttribute(asset.indices, 1));
    if (asset.normals && asset.normals.length === asset.positions.length) {
      geometry.setAttribute("normal", new BufferAttribute(asset.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingSphere();
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = geometry;
    // Imported meshes carry no B-rep topology, so there are no CAD edges to show.
    entry.edges?.geometry.dispose();
    if (entry.edges) entry.edges.geometry = new BufferGeometry();
    this.needsRender = true;
  }

  setEdgesVisible(visible: boolean) {
    for (const entry of this.entries.values()) {
      if (entry.edges) entry.edges.visible = visible;
    }
    this.needsRender = true;
  }

  setGridVisible(visible: boolean) {
    this.grid.visible = visible;
    this.needsRender = true;
  }

  setAxesVisible(visible: boolean) {
    this.axes.visible = visible;
    this.needsRender = true;
  }

  /* ------------------------------------------------------------- selection */

  setSelection(ids: string[], allowScale: boolean, mode: TransformMode) {
    this.selection = ids.filter((id) => this.entries.has(id));
    this.refreshSelectionVisuals();
    this.updateGizmo(allowScale, mode);
  }

  setHover(id: string | null) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.refreshSelectionVisuals();
  }

  private refreshSelectionVisuals() {
    const selected = new Set(this.selection);
    for (const [id, entry] of this.entries) {
      const material = entry.mesh?.material as MeshStandardMaterial | undefined;
      if (!material) continue;
      const isSelected = selected.has(id);
      const isHover = !isSelected && this.hoverId === id;
      material.emissive.setHex(isSelected ? SELECTED_EMISSIVE : isHover ? HOVER_EMISSIVE : 0x000000);
      material.emissiveIntensity = isSelected ? 0.55 : isHover ? 0.5 : 0;
      const edgeMaterial = entry.edges?.material as LineBasicMaterial | undefined;
      edgeMaterial?.color.setHex(isSelected ? 0x7fd3ff : 0x0d1117);
    }
    this.needsRender = true;
  }

  private updateGizmo(allowScale: boolean, mode: TransformMode) {
    if (this.selection.length === 0) {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
      this.needsRender = true;
      return;
    }
    const effectiveMode = mode === "scale" && !allowScale ? "translate" : mode;
    const centre = new Vector3();
    let count = 0;
    for (const id of this.selection) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.node.updateWorldMatrix(true, false);
      centre.add(new Vector3().setFromMatrixPosition(entry.node.matrixWorld));
      count += 1;
    }
    if (count > 0) centre.divideScalar(count);
    this.pivot.position.copy(centre);
    this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.gizmo.setMode(effectiveMode);
    this.gizmo.attach(this.pivot);
    this.gizmoHelper.visible = true;
    this.needsRender = true;
  }

  setSnap(translate: number, rotateDeg: number) {
    this.gizmo.setTranslationSnap(translate > 0 ? translate : null);
    this.gizmo.setRotationSnap(rotateDeg > 0 ? MathUtils.degToRad(rotateDeg) : null);
    this.gizmo.setScaleSnap(null);
  }

  /* ------------------------------------------------------------------ drag */

  private beginDrag() {
    this.dragging = true;
    this.dragStartPivot.copy(this.pivot.matrixWorld);
    this.dragStartWorld.clear();
    this.dragStartScale.clear();
    for (const id of this.selection) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.node.updateWorldMatrix(true, false);
      this.dragStartWorld.set(id, entry.node.matrixWorld.clone());
      this.dragStartScale.set(id, [entry.node.scale.x, entry.node.scale.y, entry.node.scale.z]);
    }
  }

  /**
   * Applies the gizmo's world-space delta to every selected object. Changes are
   * visual only until the drag ends; the document (and the undo stack) is
   * touched exactly once, on mouse-up.
   */
  private applyDragDelta() {
    if (!this.dragging) return;
    const inverseStart = this.dragStartPivot.clone().invert();
    const delta = this.pivot.matrixWorld.clone().multiply(inverseStart);
    const mode = this.gizmo.getMode();
    for (const id of this.selection) {
      const entry = this.entries.get(id);
      const startWorld = this.dragStartWorld.get(id);
      if (!entry || !startWorld) continue;
      if (mode === "scale") {
        const s = this.dragStartScale.get(id) ?? [1, 1, 1];
        entry.node.scale.set(
          s[0] * this.pivot.scale.x,
          s[1] * this.pivot.scale.y,
          s[2] * this.pivot.scale.z,
        );
        continue;
      }
      const targetWorld = delta.clone().multiply(startWorld);
      const parent = entry.node.parent ?? this.root;
      parent.updateWorldMatrix(true, false);
      const local = parent.matrixWorld.clone().invert().multiply(targetWorld);
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      local.decompose(position, quaternion, scale);
      entry.node.position.copy(position);
      entry.node.quaternion.copy(quaternion);
    }
  }

  private endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    const updates: TransformUpdate[] = [];
    for (const id of this.selection) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const matrix = new Matrix4().compose(entry.node.position, entry.node.quaternion, new Vector3(1, 1, 1));
      updates.push({
        id,
        transform: matrixToTransform(matrix),
        scale: [entry.node.scale.x, entry.node.scale.y, entry.node.scale.z],
      });
    }
    this.pivot.scale.set(1, 1, 1);
    if (updates.length) this.onTransformCommit?.(updates);
  }

  /* --------------------------------------------------------------- picking */

  private downPoint = { x: 0, y: 0, time: 0 };

  private handlePointerDown = (event: PointerEvent) => {
    this.downPoint = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (this.dragging) return;
    const moved = Math.hypot(event.clientX - this.downPoint.x, event.clientY - this.downPoint.y);
    if (moved > 4 || performance.now() - this.downPoint.time > 600) return;
    const hit = this.pick(event);
    this.onSelect?.(hit, event.shiftKey || event.ctrlKey || event.metaKey);
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.dragging) return;
    this.setHover(this.pick(event));
  };

  private handlePointerLeave = () => this.setHover(null);

  private pick(event: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const targets: Mesh[] = [];
    for (const entry of this.entries.values()) {
      if (entry.mesh && entry.node.visible && entry.mesh.geometry.getAttribute("position")) {
        targets.push(entry.mesh);
      }
    }
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const id = hit.object.userData.objectId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  /* --------------------------------------------------------------- cameras */

  setCameraMode(mode: "perspective" | "orthographic") {
    const next = mode === "perspective" ? this.perspective : this.ortho;
    if (next === this.activeCamera) return;
    const target = this.controls.target.clone();
    const offset = this.activeCamera.position.clone().sub(target);
    if (next === this.ortho) {
      // Match the perspective framing so the switch does not jump.
      const distance = offset.length();
      const halfHeight = Math.tan(MathUtils.degToRad(this.perspective.fov / 2)) * distance;
      const aspect = this.perspective.aspect;
      this.ortho.top = halfHeight;
      this.ortho.bottom = -halfHeight;
      this.ortho.left = -halfHeight * aspect;
      this.ortho.right = halfHeight * aspect;
      this.ortho.updateProjectionMatrix();
    }
    next.position.copy(target.clone().add(offset));
    next.up.set(0, 0, 1);
    next.lookAt(target);
    this.activeCamera = next;
    this.controls.object = next;
    this.gizmo.camera = next;
    this.controls.update();
    this.needsRender = true;
  }

  setView(preset: ViewPreset) {
    const target = this.controls.target.clone();
    const distance = this.activeCamera.position.distanceTo(target) || 400;
    const dir: Record<ViewPreset, Vec3> = {
      front: [0, -1, 0],
      back: [0, 1, 0],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
      iso: [0.7, -0.8, 0.6],
    };
    const d = new Vector3(...dir[preset]).normalize().multiplyScalar(distance);
    this.activeCamera.position.copy(target.clone().add(d));
    // Looking straight down needs a different up vector or the view degenerates.
    this.activeCamera.up.set(0, 0, 1);
    if (preset === "top") this.activeCamera.up.set(0, 1, 0);
    if (preset === "bottom") this.activeCamera.up.set(0, 1, 0);
    this.activeCamera.lookAt(target);
    this.controls.update();
    this.needsRender = true;
  }

  /** Frames the given objects, or everything when ids is empty. */
  fit(ids: string[] = []) {
    const box = new Box3();
    let found = false;
    const consider = (entry: Entry) => {
      if (!entry.mesh?.geometry.getAttribute("position")) return;
      entry.node.updateWorldMatrix(true, true);
      const b = new Box3().setFromObject(entry.mesh);
      if (b.isEmpty()) return;
      box.union(b);
      found = true;
    };
    if (ids.length) {
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (entry) consider(entry);
        // A group has no mesh of its own: frame its contents.
        for (const [childId, child] of this.entries) {
          if (childId !== id && this.isDescendantNode(child.node, this.entries.get(id)?.node)) consider(child);
        }
      }
    } else {
      for (const entry of this.entries.values()) consider(entry);
    }
    if (!found) {
      box.set(new Vector3(-100, -100, 0), new Vector3(100, 100, 100));
    }
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 10);
    const target = sphere.center.clone();
    const dirVec = this.activeCamera.position.clone().sub(this.controls.target).normalize();
    if (dirVec.lengthSq() < 1e-6) dirVec.set(0.7, -0.8, 0.6).normalize();
    const distance = radius / Math.sin(MathUtils.degToRad(this.perspective.fov / 2)) * 1.1;
    this.controls.target.copy(target);
    this.activeCamera.position.copy(target.clone().add(dirVec.multiplyScalar(distance)));
    if (this.activeCamera instanceof OrthographicCamera) {
      const aspect = this.perspective.aspect;
      this.ortho.top = radius * 1.3;
      this.ortho.bottom = -radius * 1.3;
      this.ortho.left = -radius * 1.3 * aspect;
      this.ortho.right = radius * 1.3 * aspect;
      this.ortho.updateProjectionMatrix();
    }
    this.controls.update();
    this.needsRender = true;
  }

  private isDescendantNode(node: Object3D, ancestor: Object3D | undefined): boolean {
    if (!ancestor) return false;
    let p: Object3D | null = node.parent;
    while (p) {
      if (p === ancestor) return true;
      p = p.parent;
    }
    return false;
  }

  /** The scene root, for exporters that need world-space geometry. */
  get exportRoot(): Group {
    return this.root;
  }

  getNode(id: string): Object3D | null {
    return this.entries.get(id)?.node ?? null;
  }

  getMesh(id: string): Mesh | null {
    return this.entries.get(id)?.mesh ?? null;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    for (const id of [...this.entries.keys()]) this.destroyEntry(id);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.controls.dispose();
    disposeTree(this.grid);
    disposeTree(this.axes);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/* ------------------------------------------------------------------ helpers */

/** 1 mm fine / 10 mm coarse grid on the XY plane, matching the mm base unit. */
function buildGrid(): Group {
  const group = new Group();
  const fine = new GridHelper(1000, 100, 0x2a3240, 0x222a36);
  fine.rotation.x = Math.PI / 2;
  const coarse = new GridHelper(1000, 10, 0x3d4a5c, 0x33404f);
  coarse.rotation.x = Math.PI / 2;
  coarse.position.z = 0.01;
  group.add(fine, coarse);
  return group;
}

function buildAxes(): AxesHelper {
  const axes = new AxesHelper(120);
  axes.position.z = 0.02;
  return axes;
}

function disposeTree(root: Object3D) {
  root.traverse((child) => {
    const mesh = child as Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as { dispose?: () => void } | undefined;
    material?.dispose?.();
  });
  root.removeFromParent();
}

export { Line3, Plane };
