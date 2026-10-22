export type DescriptionStatus = 'source_definition_excerpt' | 'editorial_unreviewed' | 'missing_source_definition' | string

export interface AnatomySource {
  name: string
  url?: string
  license?: string
  attribution?: string
  description: string | null
}

export interface AnatomySystem {
  id: string
  label: string
  color: string
  file: string
  count: number
}

export interface AnatomyStructure {
  id: string
  name: string
  system: string
  nodeName: string
  description?: string
  descriptionStatus?: DescriptionStatus
  region?: string
  center?: [number, number, number]
  size?: [number, number, number]
  descriptionOrigin?: 'object_name' | 'parent_name' | string | null
  descriptionAppliesTo?: string | null
  descriptionSourceUrls?: string[]
  parentPath?: string[]
  [key: string]: unknown
}

export interface AnatomyLandmark {
  id: string
  name: string
  system: string
  parentStructureId?: string
  center: [number, number, number]
  description?: string | null
  descriptionStatus?: DescriptionStatus
  descriptionOrigin?: 'object_name' | 'parent_name' | string | null
  descriptionSourceUrls?: string[]
  descriptionAppliesTo?: string | null
}

export interface AnatomyManifest {
  source: AnatomySource
  systems: AnatomySystem[]
  structures: AnatomyStructure[]
  landmarks?: AnatomyLandmark[]
  coverage?: Record<string, unknown>
}

export type ViewDirection = 'anterior' | 'posterior' | 'left' | 'right'
export type ClipAxis = 'none' | 'x' | 'y' | 'z'
