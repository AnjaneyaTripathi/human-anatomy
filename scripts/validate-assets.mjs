#!/usr/bin/env node
/**
 * Validates the shipped GLB atlas, rather than a hand-maintained list of
 * expected strings. This catches broken exports before they reach Pages.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const manifestPath = resolve(publicRoot, 'data/anatomy.json');
const MAX_GLB_BYTES = 100 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };

function glbJson(file) {
  const data = readFileSync(file);
  if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67) fail(`${file}: not a GLB file`);
  if (data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) fail(`${file}: invalid GLB version or declared length`);
  const jsonLength = data.readUInt32LE(12);
  if (data.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > data.length) fail(`${file}: missing JSON chunk`);
  try { return JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8').trim()); }
  catch { fail(`${file}: invalid JSON chunk`); }
}

function finiteArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || value.some((number) => !Number.isFinite(number))) fail(`${label} must contain ${length} finite numbers`);
}

function assertGeometry(document, node, file) {
  const mesh = document.meshes?.[node.mesh];
  if (!mesh?.primitives?.length) fail(`${file}: node ${node.name ?? node.extras?.anatomyId} has no primitives`);
  for (const primitive of mesh.primitives) {
    const positionIndex = primitive.attributes?.POSITION;
    const position = document.accessors?.[positionIndex];
    if (!position || position.type !== 'VEC3' || !Number.isInteger(position.count) || position.count < 3) fail(`${file}: ${node.name} has no nonempty POSITION geometry`);
    if (primitive.indices !== undefined) {
      const indices = document.accessors?.[primitive.indices];
      if (!indices || !Number.isInteger(indices.count) || indices.count < 3) fail(`${file}: ${node.name} has empty indices`);
    }
    if (position.min !== undefined) finiteArray(position.min, 3, `${file}: ${node.name} POSITION min`);
    if (position.max !== undefined) finiteArray(position.max, 3, `${file}: ${node.name} POSITION max`);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.systems) || !Array.isArray(manifest.structures)) fail('manifest must contain systems and structures arrays');
if (!Number.isInteger(manifest.coverage?.exportedStructures) || manifest.coverage.exportedStructures !== manifest.structures.length) fail(`coverage.exportedStructures must exactly match the ${manifest.structures.length} manifest structures`);
if (!Number.isInteger(manifest.coverage?.sourceGeometry) || !Number.isInteger(manifest.coverage?.eligibleSourceGeometry) || manifest.coverage.sourceGeometry < manifest.coverage.eligibleSourceGeometry || manifest.coverage.eligibleSourceGeometry < manifest.structures.length) fail('coverage must declare coherent source and eligible geometry counts');
const systemIds = new Set(manifest.systems.map((system) => system.id));
if (systemIds.size !== manifest.systems.length) fail('manifest contains duplicate system IDs');
const structureIds = new Set();
const expectedBySystem = new Map(manifest.systems.map((system) => [system.id, new Set()]));
const statuses = new Set(['source_definition_excerpt', 'editorial_unreviewed', 'missing_source_definition']);
for (const structure of manifest.structures) {
  if (!/^za-[a-f0-9]+$/i.test(structure.id) || structureIds.has(structure.id)) fail(`invalid or duplicate structure id: ${structure.id}`);
  structureIds.add(structure.id);
  if (!systemIds.has(structure.system)) fail(`${structure.id}: unknown system ${structure.system}`);
  if (!statuses.has(structure.descriptionStatus)) fail(`${structure.id}: descriptionStatus must explicitly be source, editorial, or missing`);
  if (structure.descriptionStatus === 'missing_source_definition' && structure.description != null) fail(`${structure.id}: missing description status has description text`);
  if (structure.descriptionStatus !== 'missing_source_definition' && (typeof structure.description !== 'string' || !structure.description.trim())) fail(`${structure.id}: described entry has no description`);
  if (structure.descriptionStatus === 'missing_source_definition' && structure.descriptionOrigin != null) fail(`${structure.id}: missing description must not claim an origin`);
  if (structure.descriptionStatus !== 'missing_source_definition' && !['object_name', 'parent_name', 'editorial', 'description_supplement'].includes(structure.descriptionOrigin)) fail(`${structure.id}: description must explicitly identify object, parent, or editorial origin`);
  if (structure.descriptionOrigin === 'parent_name' && (typeof structure.descriptionAppliesTo !== 'string' || !structure.descriptionAppliesTo.trim())) fail(`${structure.id}: parent-derived definition must identify its parent`);
  if (structure.descriptionStatus === 'source_definition_excerpt' && (!Array.isArray(structure.descriptionSourceUrls) || structure.descriptionSourceUrls.some((url) => typeof url !== 'string'))) fail(`${structure.id}: source description must declare source URLs`);
  if (!Array.isArray(structure.parentPath) || !structure.parentPath.length) fail(`${structure.id}: missing provenance parentPath`);
  if (structure.parentPath.some((part) => typeof part !== 'string' || !part.trim())) fail(`${structure.id}: invalid provenance parentPath`);
  if (/\.(?:g|j)$/i.test(structure.name) || /^(?:how to|take a picture)$/i.test(structure.name)) fail(`${structure.id}: parent/UI label leaked into renderable anatomy (${structure.name})`);
  finiteArray(structure.center, 3, `${structure.id} center`);
  finiteArray(structure.size, 3, `${structure.id} size`);
  if (structure.size.some((value) => value < 0)) fail(`${structure.id}: negative bounds`);
  expectedBySystem.get(structure.system).add(structure.id);
}
if (!manifest.coverage?.unassignedEligibleGeometry || !Array.isArray(manifest.coverage.unassignedEligibleGeometry)) fail('manifest must explicitly document unassigned eligible geometry');
if (!manifest.coverage?.excluded?.reason) fail('manifest must document excluded UI/source geometry');
if (manifest.landmarks !== undefined) {
  if (!Array.isArray(manifest.landmarks)) fail('landmarks must be an array when present');
  const landmarkIds = new Set();
  let anchoredLandmarks = 0;
  for (const landmark of manifest.landmarks) {
    if (typeof landmark.id !== 'string' || !landmark.id || landmarkIds.has(landmark.id)) fail('landmarks must have unique IDs');
    landmarkIds.add(landmark.id);
    if (typeof landmark.name !== 'string' || !landmark.name.trim()) fail(`${landmark.id}: landmark must have a name`);
    const anchorStatus = landmark.anchorProvenance?.status;
    if (anchorStatus === 'anchored' || anchorStatus === 'verified') { finiteArray(landmark.center, 3, `${landmark.id} verified landmark center`); anchoredLandmarks += 1; }
    else fail(`${landmark.id}: selectable landmark must explicitly declare anchored provenance`);
    if (landmark.parentStructureId != null && !structureIds.has(landmark.parentStructureId)) fail(`${landmark.id}: landmark points to an unknown parent structure`);
  }
  const extraction = manifest.coverage?.landmarkAnchorExtraction;
  if (!extraction || extraction.anchoredCount !== anchoredLandmarks || extraction.sourceMarkerCount !== anchoredLandmarks + extraction.unavailableCount || !Array.isArray(extraction.unavailable) || extraction.unavailable.length !== extraction.unavailableCount) fail('landmark extraction coverage does not reconcile with landmark metadata');
}

let mappedNodes = 0;
for (const system of manifest.systems) {
  if (!Number.isInteger(system.count) || system.count !== expectedBySystem.get(system.id).size) fail(`${system.id}: declared count does not match manifest structures`);
  const declaredFiles = Array.isArray(system.files) ? system.files : [system.file];
  if (!declaredFiles.length || declaredFiles.some((item) => typeof item !== 'string')) fail(`${system.id}: must declare one or more GLB files`);
  const found = new Map();
  for (const declaredFile of declaredFiles) {
    const file = resolve(resolve(manifestPath, '..'), declaredFile);
    if (!file.startsWith(publicRoot + '/') || !file.endsWith('.glb')) fail(`${system.id}: asset file must resolve within public/ to a GLB`);
    const bytes = statSync(file).size;
    if (bytes > MAX_GLB_BYTES) fail(`${system.id}: ${Math.ceil(bytes / 1024 / 1024)} MiB exceeds 100 MiB Pages asset limit`);
    const document = glbJson(file);
    for (const node of document.nodes ?? []) {
      if (node.translation !== undefined) finiteArray(node.translation, 3, `${file}: ${node.name} translation`);
      if (node.rotation !== undefined) finiteArray(node.rotation, 4, `${file}: ${node.name} rotation`);
      if (node.scale !== undefined) finiteArray(node.scale, 3, `${file}: ${node.name} scale`);
      if (node.matrix !== undefined) finiteArray(node.matrix, 16, `${file}: ${node.name} matrix`);
      const anatomyId = node.extras?.anatomyId;
      if (!anatomyId) continue;
      if (!expectedBySystem.get(system.id).has(anatomyId)) fail(`${system.id}: node references foreign or unknown anatomyId ${anatomyId}`);
      if (found.has(anatomyId)) fail(`${system.id}: anatomyId ${anatomyId} appears on multiple nodes`);
      if (node.mesh === undefined) fail(`${system.id}: mapped ${anatomyId} lacks mesh geometry`);
      assertGeometry(document, node, file);
      found.set(anatomyId, node);
      mappedNodes += 1;
    }
  }
  if (found.size !== expectedBySystem.get(system.id).size) {
    const absent = [...expectedBySystem.get(system.id)].filter((id) => !found.has(id)).slice(0, 5);
    fail(`${system.id}: mapped ${found.size}/${expectedBySystem.get(system.id).size}; absent ${absent.join(', ')}`);
  }
}
if (mappedNodes !== manifest.structures.length) fail(`mapped ${mappedNodes}, expected ${manifest.structures.length}`);
const glbFileCount = manifest.systems.reduce((total, system) => total + (Array.isArray(system.files) ? system.files.length : 1), 0);
console.log(`Validated ${manifest.structures.length} structures across ${glbFileCount} GLB files in ${manifest.systems.length} systems; every manifest ID maps once to nonempty geometry.`);
