import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type {
  AnatomyManifest,
  AnatomyLandmark,
  AnatomyStructure,
  ClipAxis,
  ViewerCallbacks,
  ViewerStats,
  ViewDirection,
} from './viewer-types';

type MeshRecord = {
  mesh: THREE.Mesh;
  id: string;
  system: string;
  materials: THREE.Material[];
  base: Array<{ opacity: number; transparent: boolean; depthWrite: boolean; emissive?: THREE.Color; emissiveIntensity?: number }>;
};

const teal = new THREE.Color('#18aaa7');
const DRAG_DISTANCE = 5;

/**
 * A WebGL anatomy canvas driven solely by the asset manifest. It creates no
 * anatomical geometry: every selectable structure comes from a GLB node.
 */
export class AnatomyViewer {
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly loader = new GLTFLoader();
  private readonly records: MeshRecord[] = [];
  private readonly systemRecords = new Map<string, MeshRecord[]>();
  private readonly structures = new Map<string, AnatomyStructure>();
  private readonly landmarks = new Map<string, AnatomyLandmark>();
  private readonly structureMeshes = new Map<string, THREE.Mesh[]>();
  private readonly recordsByMesh = new Map<THREE.Mesh, MeshRecord>();
  private readonly visibleSystems = new Set<string>();
  private readonly hidden = new Set<string>();
  private readonly clippingPlane = new THREE.Plane();
  private readonly label: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private resizeObserver?: ResizeObserver;
  private selected: string | null = null;
  private hovered: string | null = null;
  private labelsEnabled = true;
  private disposed = false;
  private pointerDown?: { x: number; y: number };
  private animationUntil = 0;
  private raf = 0;
  private focusAnimation?: { start: number; duration: number; fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 };
  private bounds = new THREE.Box3();
  private generation = 0;
  private clippingActive = false;
  private lastHoverTest = 0;

  constructor(private readonly container: HTMLElement, private readonly callbacks: ViewerCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.setClearColor('#f5f2eb', 1);
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive three dimensional human anatomy model');
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#f5f2eb');
    this.scene.add(this.world);
    this.camera.position.set(0, 0, 8);
    this.scene.add(new THREE.HemisphereLight('#fffdf8', '#87929a', 1));
    const key = new THREE.DirectionalLight('#fff7e7', 2);
    key.position.set(5, 7, 8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#d9f0f0', 0.6);
    fill.position.set(-7, 2, -5);
    this.scene.add(fill);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 1000;
    this.controls.addEventListener('change', () => this.wake());
    this.controls.addEventListener('start', () => this.wake());
    this.controls.addEventListener('end', () => this.wake(700));
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.label = document.createElement('div');
    this.label.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:2;padding:5px 8px;border-radius:4px;background:rgba(19,31,34,.88);color:#fff;font:500 12px/1.25 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.18);transform:translate(-50%,-125%);white-space:nowrap';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.label);
    this.marker = document.createElement('div');
    this.marker.setAttribute('aria-hidden', 'true');
    this.marker.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:3;width:12px;height:12px;border:2px solid #18aaa7;border-radius:50%;background:rgba(245,242,235,.78);box-shadow:0 0 0 3px rgba(24,170,167,.18);transform:translate(-50%,-50%)';
    container.appendChild(this.marker);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.wake(1000);
  }

  /** Load a manifest URL, or a manifest which the hosting app already fetched. */
  async load(source: string | AnatomyManifest): Promise<void> {
    this.assertUsable();
    const generation = ++this.generation;
    this.clearModel();
    try {
      const manifestUrl = typeof source === 'string' ? source : undefined;
      const manifest = typeof source === 'string' ? await this.fetchManifest(source) : source;
      if (!this.isCurrent(generation)) return;
      this.validateManifest(manifest);
      manifest.structures.forEach((structure) => this.structures.set(structure.id, structure));
      manifest.landmarks?.forEach((landmark) => this.landmarks.set(landmark.id, landmark));
      manifest.systems.forEach((system) => this.visibleSystems.add(system.id));
      const assets = manifest.systems.flatMap((system) => {
        const files = system.files?.length ? system.files : system.file ? [system.file] : [];
        return files.map((file, index) => ({ system, file, label: files.length > 1 ? `${system.label} (${index + 1}/${files.length})` : system.label }));
      });
      let completed = 0;
      await Promise.all(assets.map(async ({ system, file, label }) => {
        const assetUrl = this.resolveAssetUrl(file, manifestUrl);
        const gltf = await this.loadGltf(assetUrl, label, (loaded, total) => {
          if (this.isCurrent(generation)) this.callbacks.onProgress?.({ loaded, total, label });
        });
        if (!this.isCurrent(generation)) { this.disposeObject(gltf.scene); return; }
        gltf.scene.name = system.id;
        this.world.add(gltf.scene);
        this.mapSystem(gltf.scene, system.id);
        completed += 1;
        this.callbacks.onProgress?.({ loaded: completed, total: assets.length, label });
      }));
      if (!this.isCurrent(generation)) return;
      const missing = manifest.structures.filter((structure) => !this.structureMeshes.has(structure.id));
      if (missing.length) throw new Error(`Model mapping is incomplete: ${missing.length} manifest structures were not found in their GLB assets (for example, ${missing.slice(0, 3).map((structure) => structure.name).join(', ')}).`);
      this.updateBounds();
      this.focus();
      this.syncQaData();
      this.callbacks.onReady?.(this.getStats());
      this.wake(1000);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      // Invalidate sibling GLB requests before clearing partial scenes. Their
      // callbacks may still arrive after Promise.all has rejected.
      this.generation += 1;
      this.clearModel();
      const message = error instanceof Error ? error.message : 'Unable to load anatomy assets.';
      this.showError(message);
      this.callbacks.onError?.(message);
      throw error;
    }
  }

  setVisibleSystems(ids: Set<string>): void {
    if (this.disposed) return;
    this.visibleSystems.clear(); ids.forEach((id) => this.visibleSystems.add(id));
    this.systemRecords.forEach((records, system) => records.forEach((record) => { record.mesh.visible = ids.has(system) && !this.hidden.has(record.id); }));
    this.updateBounds(); this.syncQaData(); this.wake();
  }

  setSystemOpacity(system: string, opacity: number): void {
    if (this.disposed) return;
    const value = THREE.MathUtils.clamp(opacity, 0, 1);
    for (const record of this.systemRecords.get(system) ?? []) this.applyMaterialState(record, value, record.id === this.selected);
    this.wake();
  }

  select(id: string | null): void {
    if (this.disposed) return;
    if (id !== null && !this.structures.has(id) && !this.landmarks.has(id)) id = null;
    if (id === this.selected) return;
    const previous = this.selected;
    this.selected = id;
    const previousTarget = previous ? this.targetMeshId(previous) : null;
    const target = id ? this.targetMeshId(id) : null;
    if (previousTarget) for (const record of this.records.filter((item) => item.id === previousTarget)) this.applyMaterialState(record, undefined, false);
    if (target) for (const record of this.records.filter((item) => item.id === target)) this.applyMaterialState(record, undefined, true);
    this.callbacks.onSelect?.(id);
    this.updateLabel(); this.wake();
  }

  focus(id?: string): void {
    if (this.disposed) return;
    if (id) this.reveal(id);
    const meshId = id ? this.targetMeshId(id) : undefined;
    if (id && !meshId) return;
    const targetBox = meshId ? this.structureBox(meshId) : this.bounds.clone();
    if (targetBox.isEmpty()) return;
    const center = targetBox.getCenter(new THREE.Vector3());
    const distance = this.fitDistance(targetBox);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.animateFocus(center.clone().addScaledVector(direction, distance), center);
  }

  isolate(id: string | null): void {
    if (this.disposed) return;
    this.hidden.clear();
    if (id) {
      const meshId = this.targetMeshId(id);
      if (!meshId) return;
      for (const record of this.records) if (record.id !== meshId) this.hidden.add(record.id);
      const source = this.structures.get(id) ?? this.landmarks.get(id);
      if (source) this.visibleSystems.add(source.system);
    }
    this.setVisibleSystems(new Set(this.visibleSystems));
    if (id) this.focus(id);
  }

  hide(id: string): void { if (this.disposed) return; const meshId = this.targetMeshId(id); if (meshId) this.hidden.add(meshId); this.setVisibleSystems(new Set(this.visibleSystems)); }
  /** Reveal one structure (or a landmark's parent mesh) without resetting other hidden anatomy. */
  reveal(id: string): void {
    if (this.disposed) return;
    const meshId = this.targetMeshId(id);
    const source = this.structures.get(id) ?? this.landmarks.get(id);
    if (!meshId || !source) return;
    this.hidden.delete(meshId);
    const next = new Set(this.visibleSystems); next.add(source.system);
    this.setVisibleSystems(next);
    this.callbacks.onRevealSystem?.(source.system);
  }
  showAll(): void { if (this.disposed) return; this.hidden.clear(); this.setVisibleSystems(new Set(this.visibleSystems)); }

  setView(view: ViewDirection): void {
    if (this.disposed) return;
    if (this.bounds.isEmpty()) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const distance = this.fitDistance(this.bounds);
    const directions: Record<ViewDirection, THREE.Vector3> = {
      anterior: new THREE.Vector3(0, 0, 1), posterior: new THREE.Vector3(0, 0, -1),
      left: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(-1, 0, 0),
    };
    this.animateFocus(center.clone().addScaledVector(directions[view], distance), center);
  }

  /** Clips one half-space; GLTF surfaces are intentionally uncapped. */
  setClipping(axis: ClipAxis, fraction = 0.5): void {
    if (this.disposed) return;
    if (axis === 'none' || this.bounds.isEmpty()) {
      for (const record of this.records) record.materials.forEach((material) => { material.clippingPlanes = null; material.needsUpdate = true; });
      this.clippingActive = false; this.wake(); return;
    }
    const normal = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const min = this.bounds.min[axis]; const max = this.bounds.max[axis];
    this.clippingPlane.set(normal, -THREE.MathUtils.lerp(min, max, THREE.MathUtils.clamp(fraction, 0, 1)));
    this.clippingActive = true;
    for (const record of this.records) record.materials.forEach((material) => { material.clippingPlanes = [this.clippingPlane]; material.needsUpdate = true; });
    this.wake();
  }

  setLabels(enabled: boolean): void { if (this.disposed) return; this.labelsEnabled = enabled; this.updateLabel(); this.wake(); }
  setBackground(color: THREE.ColorRepresentation): void { if (this.disposed) return; this.scene.background = new THREE.Color(color); this.renderer.setClearColor(color); this.wake(); }

  getStats(): ViewerStats {
    const info = this.renderer.info.render;
    const visible = this.records.filter((record) => record.mesh.visible);
    return { systemsLoaded: new Set(this.world.children.map((child) => child.name)).size, structuresMapped: this.structureMeshes.size, meshesMapped: this.records.length, drawCalls: info.calls, triangles: info.triangles, visibleMeshes: visible.length, visibleStructures: new Set(visible.map((record) => record.id)).size, landmarks: this.landmarks.size };
  }

  /** Lightweight, framework-agnostic metadata for automated browser QA. */
  private syncQaData(): void {
    const stats = this.getStats();
    this.renderer.domElement.dataset.structureCount = String(stats.structuresMapped);
    this.renderer.domElement.dataset.meshCount = String(stats.meshesMapped);
    this.renderer.domElement.dataset.visibleStructureCount = String(stats.visibleStructures);
    this.renderer.domElement.dataset.visibleMeshCount = String(stats.visibleMeshes);
    this.renderer.domElement.dataset.landmarkCount = String(stats.landmarks);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.generation += 1;
    this.clearModel(); this.renderer.dispose(); this.renderer.domElement.remove(); this.label.remove(); this.marker.remove();
  }

  private async fetchManifest(url: string): Promise<AnatomyManifest> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load anatomy manifest (${response.status}).`);
    return response.json() as Promise<AnatomyManifest>;
  }
  /**
   * Vite's GitHub Pages build can live below a repository path. Treat a leading
   * slash in hand-authored manifests as Vite-app-root-relative, not
   * host-root-relative. Relative paths still resolve beside the manifest.
   */
  private resolveAssetUrl(file: string, manifestUrl?: string): string {
    if (/^(?:https?:|data:|blob:)/i.test(file)) return file;
    const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
    if (file.startsWith('/')) return new URL(file.slice(1), new URL(viteBase, document.baseURI)).href;
    const base = manifestUrl ? new URL(manifestUrl, window.location.href).href : window.location.href;
    return new URL(file, base).href;
  }
  private validateManifest(manifest: AnatomyManifest): void {
    if (!manifest || !Array.isArray(manifest.systems) || !Array.isArray(manifest.structures)) throw new Error('The anatomy manifest must contain systems and structures arrays.');
    const systems = new Set(manifest.systems.map((item) => item.id));
    for (const system of manifest.systems) if (!system.id || !(system.files?.length || system.file)) throw new Error(`Anatomy system ${system.id || '(unnamed)'} has no GLB file.`);
    for (const structure of manifest.structures) if (!structure.id || !structure.nodeName || !systems.has(structure.system)) throw new Error(`Invalid anatomy structure entry: ${structure.id || '(unnamed)'}.`);
    for (const landmark of manifest.landmarks ?? []) if (!landmark.id || (landmark.kind && landmark.kind !== 'landmark') || !systems.has(landmark.system) || !Array.isArray(landmark.center) || landmark.center.length !== 3) throw new Error(`Invalid anatomy landmark entry: ${landmark.id || '(unnamed)'}.`);
  }
  private loadGltf(url: string, label: string, progress: (loaded: number, total: number) => void): Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF> {
    return new Promise((resolve, reject) => this.loader.load(url, resolve, (event) => progress(event.loaded, event.total || 0), () => reject(new Error(`Could not load ${label} model.`))));
  }
  private mapSystem(root: THREE.Object3D, system: string): void {
    const lookup = new Map<string, AnatomyStructure>();
    const normalizedLookup = new Map<string, AnatomyStructure | null>();
    for (const structure of this.structures.values()) if (structure.system === system) {
      lookup.set(structure.nodeName, structure);
      lookup.set(structure.id, structure);
      const normalized = this.normalizeNodeName(structure.nodeName);
      normalizedLookup.set(normalized, normalizedLookup.has(normalized) ? null : structure);
    }
    root.updateWorldMatrix(true, true);
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      let current: THREE.Object3D | null = node; let structure: AnatomyStructure | undefined;
      while (current && !structure) {
        const extras = current.userData as Record<string, unknown>;
        const candidates = [extras.anatomyId, extras.anatomicalId, extras.structureId, extras.id, extras.originalName, current.name]
          .filter((value): value is string => typeof value === 'string');
        structure = candidates.map((value) => lookup.get(value) ?? normalizedLookup.get(this.normalizeNodeName(value)) ?? undefined).find(Boolean);
        current = current.parent;
      }
      if (!structure) { node.visible = false; return; } // No unlabeled geometry in the atlas.
      const original = Array.isArray(node.material) ? node.material : [node.material];
      const materials = original.map((material) => material.clone());
      node.material = Array.isArray(node.material) ? materials : materials[0];
      node.userData.anatomicalId = structure.id;
      const record: MeshRecord = { mesh: node, id: structure.id, system, materials, base: materials.map((material) => ({ opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite, emissive: 'emissive' in material ? (material as THREE.MeshStandardMaterial).emissive.clone() : undefined, emissiveIntensity: 'emissiveIntensity' in material ? (material as THREE.MeshStandardMaterial).emissiveIntensity : undefined })) };
      this.records.push(record);
      this.recordsByMesh.set(node, record);
      const bySystem = this.systemRecords.get(system) ?? []; bySystem.push(record); this.systemRecords.set(system, bySystem);
      const meshes = this.structureMeshes.get(structure.id) ?? []; meshes.push(node); this.structureMeshes.set(structure.id, meshes);
    });
  }
  private applyMaterialState(record: MeshRecord, requestedOpacity?: number, selected = false): void {
    record.materials.forEach((material, index) => {
      const base = record.base[index]; const opacity = requestedOpacity ?? material.opacity;
      material.opacity = opacity;
      material.transparent = base.transparent || opacity < 0.999;
      material.depthWrite = opacity >= 0.999 ? base.depthWrite : false;
      if ('emissive' in material) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.emissive.copy(selected ? teal : base.emissive ?? new THREE.Color());
        standard.emissiveIntensity = selected ? 0.08 : base.emissiveIntensity ?? 0;
      }
      material.needsUpdate = true;
    });
  }
  private structureBox(id: string): THREE.Box3 {
    const box = new THREE.Box3(); const meshes = this.structureMeshes.get(id) ?? [];
    meshes.forEach((mesh) => box.expandByObject(mesh));
    if (box.isEmpty()) {
      const structure = this.structures.get(id);
      if (structure?.center && structure.size) box.setFromCenterAndSize(new THREE.Vector3(...structure.center), new THREE.Vector3(...structure.size));
    }
    return box;
  }
  /** Returns real mesh geometry for a selection; landmarks never create meshes. */
  private targetMeshId(id: string): string | null {
    if (this.structureMeshes.has(id)) return id;
    const parent = this.landmarks.get(id)?.parentStructureId;
    return parent && this.structureMeshes.has(parent) ? parent : null;
  }
  private fitDistance(box: THREE.Box3): number {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const modelScale = Math.max(this.bounds.getSize(new THREE.Vector3()).length(), sphere.radius * 2, 1e-4);
    const radius = Math.max(sphere.radius, modelScale * 0.0015);
    const vertical = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    return radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.18;
  }
  private updateBounds(): void { this.bounds.makeEmpty(); this.world.updateWorldMatrix(true, true); this.records.filter((record) => record.mesh.visible).forEach((record) => this.bounds.expandByObject(record.mesh)); }
  private animateFocus(position: THREE.Vector3, target: THREE.Vector3): void {
    this.focusAnimation = { start: performance.now(), duration: 440, fromPosition: this.camera.position.clone(), toPosition: position, fromTarget: this.controls.target.clone(), toTarget: target };
    this.wake(600);
  }
  private resize(): void { const { width, height } = this.container.getBoundingClientRect(); if (!width || !height) return; this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false); this.wake(); }
  private wake = (duration = 350): void => { if (this.disposed) return; this.animationUntil = Math.max(this.animationUntil, performance.now() + duration); if (!this.raf) this.raf = requestAnimationFrame(this.frame); };
  private frame = (now: number): void => {
    if (this.disposed) { this.raf = 0; return; }
    this.raf = 0;
    if (this.focusAnimation) { const a = this.focusAnimation; const t = THREE.MathUtils.smoothstep((now - a.start) / a.duration, 0, 1); this.camera.position.lerpVectors(a.fromPosition, a.toPosition, t); this.controls.target.lerpVectors(a.fromTarget, a.toTarget, t); if (t >= 1) this.focusAnimation = undefined; else this.animationUntil = Math.max(this.animationUntil, now + 32); }
    this.controls.update(); this.updateLabelPosition(); this.renderer.render(this.scene, this.camera);
    if (!this.disposed && (now < this.animationUntil || this.focusAnimation)) this.raf = requestAnimationFrame(this.frame);
  };
  private hitTest(event: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.records.filter((record) => record.mesh.visible).map((record) => record.mesh), false);
    const hit = hits.find((intersection) => {
      if (this.clippingActive && this.clippingPlane.distanceToPoint(intersection.point) < 0) return false;
      const mesh = intersection.object as THREE.Mesh;
      const record = this.recordsByMesh.get(mesh);
      if (!record) return false;
      const material = record.materials[intersection.face?.materialIndex ?? 0] ?? record.materials[0];
      return material.opacity > 0.001 && material.visible;
    });
    return hit ? (hit.object as THREE.Mesh).userData.anatomicalId as string ?? null : null;
  }
  private onPointerDown = (event: PointerEvent): void => { this.pointerDown = { x: event.clientX, y: event.clientY }; };
  private onPointerUp = (event: PointerEvent): void => { if (!this.pointerDown || Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) <= DRAG_DISTANCE) this.select(this.hitTest(event)); this.pointerDown = undefined; };
  private onPointerMove = (event: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastHoverTest < 45) return;
    this.lastHoverTest = now;
    const id = this.hitTest(event);
    if (id !== this.hovered) { this.hovered = id; this.callbacks.onHover?.(id); this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab'; }
  };
  private onPointerLeave = (): void => { if (this.hovered) { this.hovered = null; this.callbacks.onHover?.(null); } };
  private updateLabel(): void {
    const structure = this.selected ? this.structures.get(this.selected) : undefined;
    const landmark = this.selected ? this.landmarks.get(this.selected) : undefined;
    this.label.textContent = landmark ? `${landmark.name} · landmark` : structure?.name ?? '';
    this.label.style.display = (structure || landmark) && this.labelsEnabled ? 'block' : 'none';
    this.marker.style.display = landmark && this.labelsEnabled ? 'block' : 'none';
  }
  private updateLabelPosition(): void {
    if (!this.selected || !this.labelsEnabled) return;
    const landmark = this.landmarks.get(this.selected);
    const meshId = this.targetMeshId(this.selected);
    const source = this.structures.get(this.selected) ?? landmark;
    const meshVisible = meshId ? (this.structureMeshes.get(meshId) ?? []).some((mesh) => mesh.visible) : false;
    if (!source || !meshVisible || (landmark && !this.visibleSystems.has(landmark.system))) {
      this.label.style.display = 'none'; this.marker.style.display = 'none'; return;
    }
    const box = landmark ? undefined : this.structureBox(this.selected);
    if (!landmark && box?.isEmpty()) { this.label.style.display = 'none'; this.marker.style.display = 'none'; return; }
    const worldPoint = landmark ? new THREE.Vector3(...landmark.center) : box!.getCenter(new THREE.Vector3());
    if (this.clippingActive && this.clippingPlane.distanceToPoint(worldPoint) < 0) { this.label.style.display = 'none'; this.marker.style.display = 'none'; return; }
    const point = worldPoint.project(this.camera);
    if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) { this.label.style.display = 'none'; this.marker.style.display = 'none'; return; }
    const left = `${(point.x * .5 + .5) * this.container.clientWidth}px`;
    const top = `${(-point.y * .5 + .5) * this.container.clientHeight}px`;
    this.label.style.display = 'block'; this.label.style.left = left; this.label.style.top = top;
    if (landmark) { this.marker.style.display = 'block'; this.marker.style.left = left; this.marker.style.top = top; }
  }
  private onContextLost = (event: Event): void => { event.preventDefault(); this.callbacks.onError?.('WebGL context was lost. The anatomy viewer will restore automatically when graphics access returns.'); };
  private onContextRestored = (): void => { this.wake(1000); };
  private normalizeNodeName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }
  private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private disposeObject(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
    root.traverse((node) => { if (node instanceof THREE.Mesh) { geometries.add(node.geometry); (Array.isArray(node.material) ? node.material : [node.material]).forEach((material) => materials.add(material)); } });
    geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose());
  }
  private clearModel(): void { this.world.children.forEach((child) => this.disposeObject(child)); this.world.clear(); this.records.length = 0; this.recordsByMesh.clear(); this.systemRecords.clear(); this.structureMeshes.clear(); this.structures.clear(); this.landmarks.clear(); this.visibleSystems.clear(); this.hidden.clear(); this.bounds.makeEmpty(); this.selected = null; this.hovered = null; this.updateLabel(); this.syncQaData(); }
  private showError(message: string): void { this.label.textContent = message; this.label.style.display = 'block'; this.label.style.left = '50%'; this.label.style.top = '50%'; this.label.style.transform = 'translate(-50%,-50%)'; }
  private assertUsable(): void { if (this.disposed) throw new Error('This AnatomyViewer has been disposed.'); }
}

export default AnatomyViewer;
