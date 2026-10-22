/** Shape of `/public/data/anatomy.json`. Coordinates use the GLB's world space. */
export interface AnatomySystem {
  id: string;
  label: string;
  color: string;
  /** Legacy single-asset form. Use files for a split system export. */
  file?: string;
  /** GLBs forming one anatomical system, loaded under the same system id. */
  files?: string[];
  count: number;
}

export interface AnatomyStructure {
  id: string;
  name: string;
  system: string;
  /** Exact object name in the corresponding GLB whenever one is available. */
  nodeName: string;
  description?: string | null;
  descriptionStatus?: 'complete' | 'draft' | string;
  region?: string;
  center?: [number, number, number];
  size?: [number, number, number];
}

/** A source landmark with no renderable faces, anchored to source coordinates. */
export interface AnatomyLandmark {
  id: string;
  name: string;
  system: string;
  parentStructureId?: string;
  center: [number, number, number];
  description?: string | null;
  descriptionStatus?: string;
  descriptionOrigin?: string | null;
  descriptionAppliesTo?: string | null;
  descriptionSourceUrls?: string[];
  kind?: 'landmark';
}

export interface AnatomyManifest {
  systems: AnatomySystem[];
  structures: AnatomyStructure[];
  landmarks?: AnatomyLandmark[];
}

export interface ViewerProgress {
  loaded: number;
  total: number;
  label: string;
}

export interface ViewerCallbacks {
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onProgress?: (progress: ViewerProgress) => void;
  onReady?: (stats: ViewerStats) => void;
  onError?: (message: string) => void;
  onRevealSystem?: (system: string) => void;
}

export type ViewDirection = 'anterior' | 'posterior' | 'left' | 'right';
export type ClipAxis = 'none' | 'x' | 'y' | 'z';

export interface ViewerStats {
  systemsLoaded: number;
  structuresMapped: number;
  meshesMapped: number;
  drawCalls: number;
  triangles: number;
  visibleMeshes: number;
  visibleStructures: number;
  landmarks: number;
}
