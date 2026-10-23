import * as THREE from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';

type IndexArray = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array;

interface BuildMessage {
  type: 'build';
  id: number;
  position: Float32Array;
  index?: IndexArray;
  groups: Array<{ start: number; count: number; materialIndex?: number }>;
  drawRange: { start: number; count: number };
}

interface CompleteMessage {
  type: 'complete';
  id: number;
  serialized: SerializedBVH;
}

interface FailureMessage {
  type: 'error';
  id: number;
  message: string;
}

interface QueuedBuild {
  geometry: THREE.BufferGeometry;
  resolve: (built: boolean) => void;
}

/**
 * Builds bounds trees off the main thread without transferring or modifying live GLTF buffers.
 * Calls resolve(false) when construction is unavailable so Mesh.raycast keeps its native fallback.
 */
export class PickingAcceleration {
  private worker: Worker | undefined;
  private readonly queue: QueuedBuild[] = [];
  private readonly builds = new WeakMap<THREE.BufferGeometry, Promise<boolean>>();
  private current: QueuedBuild | undefined;
  private currentId = 0;
  private nextId = 0;
  private disposed = false;

  public constructor(private readonly onError: (error: Error) => void = (error) => console.warn('BVH acceleration unavailable; using native raycasting.', error)) {
    try {
      this.worker = new Worker(new URL('./picking-bvh.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<CompleteMessage | FailureMessage>) => this.finish(event.data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.failWorker(new Error(event.message || 'BVH worker failed.'));
      };
      this.worker.onmessageerror = (event) => {
        event.preventDefault();
        this.failWorker(new Error('BVH worker returned an unreadable message.'));
      };
    } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Queue a geometry once. The promise always fulfills, avoiding fire-and-forget rejections. */
  public enqueue(geometry: THREE.BufferGeometry): Promise<boolean> {
    if (geometry.boundsTree) return Promise.resolve(true);
    const known = this.builds.get(geometry);
    if (known) return known;
    if (this.disposed || !this.worker || !this.canBuild(geometry)) return Promise.resolve(false);

    const result = new Promise<boolean>((resolve) => {
      this.queue.push({ geometry, resolve });
      this.runNext();
    });
    this.builds.set(geometry, result);
    return result;
  }

  /** Stop work and settle queued callers. Native three.js raycasting remains active. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.current?.resolve(false);
    this.current = undefined;
    while (this.queue.length) this.queue.shift()!.resolve(false);
  }

  private canBuild(geometry: THREE.BufferGeometry): boolean {
    const position = geometry.getAttribute('position');
    return Boolean(position && position.count >= 3 && geometry.index && geometry.index.count >= 3);
  }

  private runNext(): void {
    if (this.disposed || this.current) return;
    const build = this.queue.shift();
    if (!build) return;
    this.current = build;
    try {
      const message = this.copyBuildMessage(build.geometry, ++this.nextId);
      this.currentId = message.id;
      const transfers: Transferable[] = [message.position.buffer];
      if (message.index) transfers.push(message.index.buffer);
      this.worker!.postMessage(message, transfers);
    } catch (error) {
      this.failCurrent(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private copyBuildMessage(geometry: THREE.BufferGeometry, id: number): BuildMessage {
    const position = geometry.getAttribute('position');
    // getX/Y/Z makes this safe for unusual/interleaved attributes as well as GLTF attributes.
    const copiedPosition = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      const offset = i * 3;
      copiedPosition[offset] = position.getX(i);
      copiedPosition[offset + 1] = position.getY(i);
      copiedPosition[offset + 2] = position.getZ(i);
    }
    const sourceIndex = geometry.index!;
    const copiedIndex = sourceIndex.array.slice() as IndexArray;
    return {
      type: 'build',
      id,
      position: copiedPosition,
      index: copiedIndex,
      groups: geometry.groups.map((group) => ({ ...group })),
      drawRange: { ...geometry.drawRange },
    };
  }

  private finish(message: CompleteMessage | FailureMessage): void {
    const build = this.current;
    if (!build || this.disposed || message.id !== this.currentId) return;
    if (message.type === 'complete') {
      try {
        // setIndex:false is essential: the live GLTF index is neither replaced nor reordered.
        build.geometry.boundsTree = MeshBVH.deserialize(message.serialized, build.geometry, { setIndex: false });
        build.resolve(true);
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
        build.resolve(false);
      }
    } else {
      this.report(new Error(message.message));
      build.resolve(false);
    }
    this.current = undefined;
    this.currentId = 0;
    this.runNext();
  }

  private failCurrent(error: Error): void {
    if (!this.current || this.disposed) return;
    this.report(error);
    this.current.resolve(false);
    this.current = undefined;
    this.currentId = 0;
    this.runNext();
  }

  private failWorker(error: Error): void {
    if (this.disposed) return;
    this.report(error);
    this.current?.resolve(false);
    this.current = undefined;
    this.currentId = 0;
    this.worker?.terminate();
    this.worker = undefined;
    this.disposed = true;
    while (this.queue.length) this.queue.shift()!.resolve(false);
  }

  private report(error: Error): void {
    try {
      this.onError(error);
    } catch {
      // Reporting must never stop native raycast fallback or the remaining queue.
    }
  }
}
