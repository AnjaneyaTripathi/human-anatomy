import { BufferAttribute, BufferGeometry } from 'three';
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

interface BuildResult {
  type: 'complete';
  id: number;
  serialized: SerializedBVH;
}

interface BuildFailure {
  type: 'error';
  id: number;
  message: string;
}

self.onmessage = (event: MessageEvent<BuildMessage>) => {
  const message = event.data;
  if (message.type !== 'build') return;

  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(message.position, 3));
    if (message.index) geometry.setIndex(new BufferAttribute(message.index, 1));
    geometry.groups = message.groups;
    geometry.setDrawRange(message.drawRange.start, message.drawRange.count);

    // indirect preserves the source index ordering. The original geometry only receives
    // the resulting traversal buffers back on the main thread.
    const bvh = new MeshBVH(geometry, { indirect: true });
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const transfers: Transferable[] = [...serialized.roots];
    if (serialized.index) transfers.push(serialized.index.buffer);
    if (serialized.indirectBuffer) transfers.push(serialized.indirectBuffer.buffer);
    const result: BuildResult = { type: 'complete', id: message.id, serialized };
    self.postMessage(result, { transfer: transfers });
  } catch (error) {
    const result: BuildFailure = {
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(result);
  }
};
