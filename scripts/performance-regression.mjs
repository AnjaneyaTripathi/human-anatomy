#!/usr/bin/env node
/**
 * Bounded regression harness for the two interaction hot paths. It runs the
 * actual viewer classes through Vite (including main's source snapshot), then
 * compares ordinary Three raycasts with the BVH raycast used by the viewer.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(root, 'test-results');
const outputFile = resolve(outputDirectory, 'performance-regression.json');
const mainSnapshot = resolve(root, '.cache/performance-baseline');
const baselineViewer = join(mainSnapshot, 'AnatomyViewer.ts');
const baselineTypes = join(mainSnapshot, 'viewer-types.ts');

mkdirSync(outputDirectory, { recursive: true });
let baselineAvailable = false;
try {
  mkdirSync(mainSnapshot, { recursive: true });
  writeFileSync(baselineViewer, execFileSync('git', ['show', '1017e03:src/AnatomyViewer.ts'], { cwd: root, encoding: 'utf8' }));
  writeFileSync(baselineTypes, execFileSync('git', ['show', '1017e03:src/viewer-types.ts'], { cwd: root, encoding: 'utf8' }));
  baselineAvailable = true;
} catch { /* Historical comparison is supplemental; fixed checks still run. */ }
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a local port');
  const origin = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 80, height: 80 }, deviceScaleFactor: 1 });
  // Keep the production app out of this page: the fixture imports only the
  // viewer module and uses a tiny canvas, so software WebGL remains bounded.
  await page.goto(`${origin}performance-fixture.html`, { waitUntil: 'domcontentloaded' });
  const scheduler = await page.evaluate(async ({ fixedUrl, baselineUrl }) => {
    const run = async (url) => {
      const module = await import(/* @vite-ignore */ url);
      const AnatomyViewer = module.default;
      const nativeRaf = window.requestAnimationFrame;
      const nativeCancel = window.cancelAnimationFrame;
      const queued = new Map(); let next = 0;
      window.requestAnimationFrame = (callback) => { const id = ++next; queued.set(id, callback); return id; };
      window.cancelAnimationFrame = (id) => queued.delete(id);
      try {
        const host = document.createElement('div'); host.style.cssText = 'position:absolute;width:32px;height:32px'; document.body.append(host);
        const viewer = new AnatomyViewer(host);
        const internal = viewer;
        queued.clear();
        internal.raf = 0;
        internal.animationUntil = performance.now() + 100;
        internal.controls.update = () => { internal.controls.dispatchEvent({ type: 'change' }); return true; };
        internal.frame(performance.now());
        const afterControlChange = queued.size;
        const [callback] = queued.values(); queued.clear();
        internal.animationUntil = performance.now() - 1;
        internal.controls.update = () => false;
        callback?.(performance.now() + 1_000);
        const afterIdleTick = queued.size;
        viewer.dispose(); host.remove();
        return { afterControlChange, afterIdleTick };
      } finally {
        window.requestAnimationFrame = nativeRaf;
        window.cancelAnimationFrame = nativeCancel;
      }
    };
    return { baseline: baselineUrl ? await run(baselineUrl) : null, fixed: await run(fixedUrl) };
  }, { fixedUrl: `${origin}src/AnatomyViewer.ts`, baselineUrl: baselineAvailable && existsSync(baselineViewer) ? `${origin}@fs${baselineViewer}` : null });

  const lazyLoading = await page.evaluate(async (fixtureUrl) => {
    const { AnatomyViewer, THREE } = await import(/* @vite-ignore */ fixtureUrl);
    const nativeRaycast = THREE.Mesh.prototype.raycast;
    const manifest = {
      systems: [
        { id: 'base', label: 'Base', color: '#fff', file: 'base.glb', count: 1 },
        { id: 'deferred', label: 'Deferred', color: '#fff', file: 'deferred.glb', count: 1 },
      ],
      structures: [
        { id: 'base-id', name: 'Base', nodeName: 'Base', system: 'base' },
        { id: 'deferred-id', name: 'Deferred', nodeName: 'Deferred', system: 'deferred' },
      ],
    };
    const scene = (name) => { const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.name = name; root.add(mesh); return root; };
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;width:32px;height:32px'; document.body.append(host);
    const viewer = new AnatomyViewer(host);
    const pending = new Map(); let deferredAttempts = 0;
    viewer.loadGltf = (url) => new Promise((resolve, reject) => {
      if (url.endsWith('base.glb')) { resolve({ scene: scene('Base') }); return; }
      deferredAttempts += 1;
      if (deferredAttempts === 1) { pending.set('first', { resolve, reject }); return; }
      pending.set('retry', { resolve, reject });
    });
    await viewer.load(manifest, { initialVisibleSystems: new Set(['base']) });
    viewer.camera.position.set(0, 0, 3); viewer.controls.target.set(0, 0, 0); viewer.controls.update();
    const requestedInitially = deferredAttempts;
    viewer.select('deferred-id'); viewer.focus('deferred-id'); viewer.isolate('deferred-id');
    viewer.setSystemOpacity('deferred', 0.35); viewer.setClipping('x', 0.5);
    pending.get('first').reject(new Error('transient fixture failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    viewer.setVisibleSystems(new Set(['deferred']));
    // Take the source index snapshot before the viewer receives the geometry,
    // so a completed worker cannot hide an index mutation from this assertion.
    const retryScene = scene('Deferred');
    const sourceIndex = retryScene.children[0].geometry.index?.array.slice();
    pending.get('retry').resolve({ scene: retryScene });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const record = viewer.records.find((item) => item.id === 'deferred-id');
    const deadline = performance.now() + 1_000;
    while (record && !record.mesh.geometry.boundsTree && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const canvasRect = viewer.renderer.domElement.getBoundingClientRect();
    const fixtureEvent = new PointerEvent('pointerup', { clientX: canvasRect.left + canvasRect.width / 2, clientY: canvasRect.top + canvasRect.height / 2 });
    const acceleratedPick = viewer.hitTest(fixtureEvent);
    const acceleratedRaycast = record?.mesh.raycast;
    if (record) record.mesh.raycast = nativeRaycast;
    const nativePick = viewer.hitTest(fixtureEvent);
    if (record && acceleratedRaycast) record.mesh.raycast = acceleratedRaycast;
    const sourceIndexUnchanged = !!record && (!sourceIndex || sourceIndex.every((value, index) => value === record.mesh.geometry.index?.array[index]));
    // The near, positive-Z sphere surface is rejected; the far surface in the
    // same DoubleSide mesh must remain selectable through the BVH.
    viewer.clippingPlane.set(new THREE.Vector3(0, 0, -1), 0); viewer.clippingActive = true;
    const clippedFarPick = viewer.hitTest(fixtureEvent);
    if (record) record.mesh.raycast = nativeRaycast;
    const clippedFarNativePick = viewer.hitTest(fixtureEvent);
    if (record && acceleratedRaycast) record.mesh.raycast = acceleratedRaycast;
    viewer.clippingActive = false;
    let raycasts = 0;
    if (record) {
      const raycast = record.mesh.raycast;
      record.mesh.raycast = function (...args) { raycasts += 1; return raycast.call(this, ...args); };
    }
    viewer.select(null);
    const down = new PointerEvent('pointerdown', { clientX: fixtureEvent.clientX, clientY: fixtureEvent.clientY });
    const moved = new PointerEvent('pointermove', { clientX: fixtureEvent.clientX + 12, clientY: fixtureEvent.clientY });
    viewer.onPointerDown(down); viewer.onControlsStart(); viewer.onPointerMove(moved); viewer.onPointerUp(new PointerEvent('pointerup', { clientX: moved.clientX, clientY: moved.clientY })); viewer.onControlsEnd();
    const dragRaycasts = raycasts;
    const dragSuppressedHoverAndSelection = dragRaycasts === 0 && viewer.selected === null;
    viewer.onPointerDown(down); viewer.onPointerUp(fixtureEvent);
    const clickSelects = raycasts > 0 && viewer.selected === 'deferred-id';
    const details = {
      attempts: deferredAttempts,
      visible: !!record?.mesh.visible,
      opacity: record?.materials[0].opacity ?? null,
      clippingPlanes: record?.materials[0].clippingPlanes?.length ?? 0,
      workerBuilt: !!record?.mesh.geometry.boundsTree,
      indexUnchanged: sourceIndexUnchanged,
      acceleratedPick,
      nativePick,
      clippedFarPick,
      clippedFarNativePick,
      dragRaycasts,
      dragSuppressedHoverAndSelection,
      clickSelects,
      selected: viewer.selected,
    };
    const retryPreservedState = deferredAttempts === 2 && !!record && record.mesh.visible && record.materials[0].opacity === 0.35 && record.materials[0].clippingPlanes?.length === 1 && viewer.selected === 'deferred-id'
      && !!record.mesh.geometry.boundsTree && sourceIndexUnchanged && acceleratedPick === nativePick && acceleratedPick === 'deferred-id' && dragSuppressedHoverAndSelection && clickSelects;
    viewer.dispose(); host.remove();

    const disposedHost = document.createElement('div'); disposedHost.style.cssText = 'position:absolute;width:32px;height:32px'; document.body.append(disposedHost);
    const disposedViewer = new AnatomyViewer(disposedHost);
    let lateResolve;
    disposedViewer.loadGltf = (url) => url.endsWith('base.glb') ? Promise.resolve({ scene: scene('Base') }) : new Promise((resolve) => { lateResolve = resolve; });
    await disposedViewer.load(manifest, { initialVisibleSystems: new Set(['base']) });
    disposedViewer.setVisibleSystems(new Set(['base', 'deferred']));
    disposedViewer.dispose(); lateResolve({ scene: scene('Deferred') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disposeSafe = disposedViewer.world.children.length === 0;
    disposedHost.remove();
    return { requestedInitially, retryPreservedState, disposeSafe, details };
  }, `${origin}scripts/viewer-test-fixture.ts`);

  const lifecycle = await page.evaluate(async (fixtureUrl) => {
    const { AnatomyViewer, THREE } = await import(/* @vite-ignore */ fixtureUrl);
    const makeScene = (name) => { const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.name = name; root.add(mesh); return root; };
    const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
    const manifest = (systems, structures) => ({ systems, structures });
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;width:32px;height:32px'; document.body.append(host);
    const focusViewer = new AnatomyViewer(host);
    let resolveDeferred;
    focusViewer.loadGltf = (url) => url.endsWith('base.glb') ? Promise.resolve({ scene: makeScene('Base') }) : new Promise((resolve) => { resolveDeferred = resolve; });
    await focusViewer.load(manifest([{ id: 'base', label: 'Base', color: '#fff', file: 'base.glb', count: 1 }, { id: 'later', label: 'Later', color: '#fff', file: 'later.glb', count: 1 }], [{ id: 'base', name: 'Base', nodeName: 'Base', system: 'base' }, { id: 'later', name: 'Later', nodeName: 'Later', system: 'later' }]), { initialVisibleSystems: new Set(['base']) });
    focusViewer.focusAnimation = undefined;
    focusViewer.focus('later');
    focusViewer.setVisibleSystems(new Set(['base'])); focusViewer.showAll();
    const beforeResolvePosition = focusViewer.camera.position.clone();
    resolveDeferred({ scene: makeScene('Later') }); await wait();
    const later = focusViewer.records.find((record) => record.id === 'later');
    const focusCancelled = !!later && !later.mesh.visible && !focusViewer.pendingFocus && focusViewer.camera.position.distanceTo(beforeResolvePosition) < 1e-9;
    focusViewer.dispose(); host.remove();

    const splitHost = document.createElement('div'); splitHost.style.cssText = 'position:absolute;width:32px;height:32px'; document.body.append(splitHost);
    const splitViewer = new AnatomyViewer(splitHost); let secondFileAttempts = 0;
    splitViewer.loadGltf = (url) => {
      if (url.endsWith('base.glb')) return Promise.resolve({ scene: makeScene('Base') });
      if (url.endsWith('split-a.glb')) return Promise.resolve({ scene: makeScene('Part A') });
      secondFileAttempts += 1;
      return secondFileAttempts === 1 ? Promise.reject(new Error('fixture second file failure')) : Promise.resolve({ scene: makeScene('Part B') });
    };
    await splitViewer.load(manifest([{ id: 'base', label: 'Base', color: '#fff', file: 'base.glb', count: 1 }, { id: 'split', label: 'Split', color: '#fff', files: ['split-a.glb', 'split-b.glb'], count: 2 }], [{ id: 'base', name: 'Base', nodeName: 'Base', system: 'base' }, { id: 'part-a', name: 'Part A', nodeName: 'Part A', system: 'split' }, { id: 'part-b', name: 'Part B', nodeName: 'Part B', system: 'split' }]), { initialVisibleSystems: new Set(['base']) });
    splitViewer.setVisibleSystems(new Set(['base', 'split'])); await wait();
    const recordsAfterFailure = splitViewer.records.filter((record) => record.system === 'split').length;
    splitViewer.setVisibleSystems(new Set(['base', 'split'])); await wait();
    const recordsAfterRetry = splitViewer.records.filter((record) => record.system === 'split').length;
    const splitAtomic = recordsAfterFailure === 0 && recordsAfterRetry === 2 && secondFileAttempts === 2;
    splitViewer.dispose(); splitHost.remove();
    return { focusCancelled, splitAtomic, recordsAfterFailure, recordsAfterRetry, secondFileAttempts };
  }, `${origin}scripts/viewer-test-fixture.ts`);

  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0.15, 0.1, 3), new THREE.Vector3(0, 0, -1));
  const measure = (raycast) => {
    mesh.raycast = raycast;
    const started = performance.now(); let hits = 0;
    for (let i = 0; i < 250; i += 1) hits += raycaster.intersectObject(mesh, false).length;
    return { milliseconds: performance.now() - started, hits };
  };
  const ordinary = measure(THREE.Mesh.prototype.raycast);
  computeBoundsTree.call(geometry, { indirect: true });
  const accelerated = measure(acceleratedRaycast);
  disposeBoundsTree.call(geometry);
  geometry.dispose(); (mesh.material).dispose();

  const results = { scheduler, lazyLoading, lifecycle, raycast: { ordinary, accelerated } };
  writeFileSync(outputFile, `${JSON.stringify(results, null, 2)}\n`);
  if ((scheduler.baseline && scheduler.baseline.afterControlChange !== 2) || scheduler.fixed.afterControlChange !== 1 || scheduler.fixed.afterIdleTick !== 0) {
    throw new Error(`RAF regression: ${JSON.stringify(scheduler)}`);
  }
  if (lazyLoading.requestedInitially !== 0 || !lazyLoading.retryPreservedState || !lazyLoading.disposeSafe) throw new Error(`lazy-load regression: ${JSON.stringify(lazyLoading)}`);
  if (lazyLoading.details.clippedFarPick !== 'deferred-id' || lazyLoading.details.clippedFarNativePick !== 'deferred-id' || !lifecycle.focusCancelled || !lifecycle.splitAtomic) throw new Error(`lifecycle regression: ${JSON.stringify({ lazyLoading, lifecycle })}`);
  if (ordinary.hits !== accelerated.hits || !accelerated.hits) throw new Error(`BVH raycast changed hit results: ${JSON.stringify({ ordinary, accelerated })}`);
  console.log(`Performance regression passed; results written to ${outputFile}`);
} finally {
  await browser?.close();
  await vite.close();
}
