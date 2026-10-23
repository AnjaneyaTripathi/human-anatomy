#!/usr/bin/env node
/** Browser acceptance test against a production build served below /human-anatomy/. */
import { createServer } from 'node:http';
import { existsSync, createReadStream, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const screenshots = resolve(root, 'test-results');
const basePath = '/human-anatomy/';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const run = (command, args) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
});

await run('npm', ['run', 'build']);
if (!existsSync(dist)) throw new Error('production build did not create dist/');
mkdirSync(screenshots, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(root, 'public/data/anatomy.json'), 'utf8'));
const includedSystems = manifest.systems.filter((system) => system.id !== 'regions');
const includedStructures = manifest.structures.filter((structure) => structure.system !== 'regions');
const liver = manifest.structures.find((structure) => /^liver(?:\.|$)/i.test(structure.name));
if (!liver) throw new Error('manifest has no selectable Liver structure for smoke coverage');
const acromialFacet = manifest.landmarks?.find((landmark) => /^acromial facet\.i$/i.test(landmark.name));
if (!acromialFacet) throw new Error('manifest has no Acromial facet landmark for landmark smoke coverage');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(basePath)) { response.writeHead(404); response.end(); return; }
  const relative = url.pathname.slice(basePath.length) || 'index.html';
  const candidate = normalize(resolve(dist, relative));
  const file = candidate.startsWith(dist + '/') && existsSync(candidate) ? candidate : resolve(dist, 'index.html');
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('could not allocate local smoke-test server');
const origin = `http://127.0.0.1:${address.port}${basePath}`;
const stage = (name) => console.log(`[smoke] ${name}`);
let browser;
let page;
const browserErrors = [];
try {
  stage('launching browser');
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const requestedModels = new Set();
  const modelResponses = [];
  const navigationStarted = Date.now();
  page.on('pageerror', (error) => { browserErrors.push(error.message); console.error(`[smoke] page error: ${error.message}`); });
  page.on('console', (message) => { if (message.type() === 'error') { browserErrors.push(message.text()); console.error(`[smoke] console error: ${message.text()}`); } });
  page.on('requestfailed', (request) => console.error(`[smoke] request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown error'})`));
  page.on('request', (request) => {
    const url = request.url();
    if (/\.glb(?:[?#]|$)/i.test(url)) requestedModels.add(url);
  });
  page.on('response', async (response) => {
    if (!/\.glb(?:[?#]|$)/i.test(response.url())) return;
    const sizes = await response.request().sizes().catch(() => null);
    modelResponses.push({ url: response.url(), bytes: (sizes?.responseBodySize ?? 0) + (sizes?.responseHeadersSize ?? 0) });
  });
  stage('navigating to production build');
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
  stage('DOM content loaded');
  const canvas = page.getByLabel('Interactive three dimensional human anatomy model');
  await canvas.waitFor({ timeout: 120000 });
  stage('viewer canvas mounted');
  await page.locator('.viewer-status').waitFor({ state: 'detached', timeout: 120000 });
  const skeletal = manifest.systems.find((system) => system.id === 'skeletal');
  if (!skeletal) throw new Error('skeletal system missing from manifest');
  const initiallyVisibleStructures = skeletal.count;
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, initiallyVisibleStructures, { timeout: 120000 });
  stage(`initial mapped visibility ${initiallyVisibleStructures}`);
  const deferredSystems = includedSystems.filter((system) => system.id !== 'skeletal');
  const eagerlyRequestedDeferred = deferredSystems.flatMap((system) => (system.files?.length ? system.files : [system.file]).filter(Boolean))
    .filter((file) => [...requestedModels].some((url) => url.includes(file.split('/').at(-1))));
  if (eagerlyRequestedDeferred.length) throw new Error(`initial load requested deferred anatomy assets: ${eagerlyRequestedDeferred.join(', ')}`);
  const skeletalFiles = skeletal.files?.length ? skeletal.files : [skeletal.file];
  if (!skeletalFiles.some((file) => file && [...requestedModels].some((url) => url.includes(file.split('/').at(-1))))) throw new Error('initial ready state did not request the skeletal GLB');
  const initialModelBytes = modelResponses.reduce((total, response) => total + response.bytes, 0);
  console.log(`[smoke] initial-ready ${Date.now() - navigationStarted}ms; ${initialModelBytes} transfer bytes across ${modelResponses.length} GLB response(s)`);
  stage('atlas loaded');
  if (await page.locator('.viewer-status.error').count()) throw new Error(`viewer displayed an error: ${await page.locator('.viewer-status.error').innerText()}`);
  await page.screenshot({ path: resolve(screenshots, 'atlas-desktop-initial.png'), fullPage: true });

  const search = page.getByLabel('Search structures');
  if (await page.getByRole('button', { name: /regions of the human body/i }).count()) throw new Error('excluded Regions system is still exposed in the anatomy library');
  if (await page.getByLabel(/hide regions|show regions/i).count()) throw new Error('excluded Regions system still has a visibility control');
  await search.fill('Frontal region');
  if (await page.locator('.structure-row').count()) throw new Error('excluded Frontal region structures remain searchable');
  await search.fill('Liver');
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /^Liver$/i }) }).first().click();
  await page.getByRole('heading', { name: /liver/i }).waitFor();
  await page.getByRole('button', { name: 'Focus' }).click();
  await page.getByRole('button', { name: 'Isolate' }).click();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.visibleStructureCount === '1');
  await page.waitForTimeout(700);
  stage('liver isolated');
  await page.screenshot({ path: resolve(screenshots, 'atlas-liver-isolated.png'), fullPage: true });
  await page.getByRole('button', { name: 'Skeleton' }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, skeletal.count);
  await page.locator('.preset-bar').getByRole('button', { name: 'All structures' }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, includedStructures.length);
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.structureCount) === expected, includedStructures.length, { timeout: 120000 });
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.landmarkCount) === expected, manifest.landmarks.length, { timeout: 120000 });
  const regionFile = manifest.systems.find((system) => system.id === 'regions')?.file;
  if (regionFile && [...requestedModels].some((url) => url.includes(regionFile.split('/').at(-1)))) throw new Error('All structures requested the excluded regions GLB');
  stage(`all ${includedStructures.length} included structures explicitly loaded and mapped`);
  await page.getByRole('button', { name: 'Show all' }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, includedStructures.length);
  if (regionFile && [...requestedModels].some((url) => url.includes(regionFile.split('/').at(-1)))) throw new Error('Show all requested the excluded regions GLB');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected - 1, includedStructures.length);
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /^Liver$/i }) }).first().click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, includedStructures.length);
  await page.getByRole('button', { name: /hide skeletal system/i }).click();
  await page.getByRole('button', { name: /show skeletal system/i }).waitFor();
  await page.getByRole('button', { name: /show skeletal system/i }).click();
  await page.getByRole('button', { name: 'Skeleton' }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, skeletal.count);
  await page.getByLabel('Section plane').selectOption('y');
  const sectionPosition = page.getByLabel('Section position');
  await sectionPosition.focus();
  await sectionPosition.press('Home');
  await sectionPosition.press('ArrowRight');
  if (await sectionPosition.inputValue() !== '1') throw new Error('section position keyboard control did not respond');
  await page.getByLabel('Section plane').selectOption('none');
  stage('system presets and section controls passed');
  await page.locator('.preset-bar').getByRole('button', { name: 'All structures' }).click();
  await search.fill('Acromial facet.i');
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /Acromial facet/i }) }).first().click();
  await page.getByRole('heading', { name: /Acromial facet/i }).waitFor();
  await page.getByText(/landmark/i).first().waitFor();
  await page.getByRole('button', { name: 'Focus' }).click();
  await page.waitForTimeout(700);
  const markerIsVisible = await page.locator('.viewer-mount > div[aria-hidden="true"]').evaluate((marker) => {
    const markerRect = marker.getBoundingClientRect(); const canvasRect = document.querySelector('canvas')?.getBoundingClientRect();
    return getComputedStyle(marker).display !== 'none' && !!canvasRect && markerRect.width > 0 && markerRect.height > 0 && markerRect.left >= canvasRect.left && markerRect.right <= canvasRect.right && markerRect.top >= canvasRect.top && markerRect.bottom <= canvasRect.bottom;
  });
  if (!markerIsVisible) throw new Error('verified Acromial facet landmark did not render a visible canvas marker after focus settled');
  stage('anchored landmark marker visible');
  await page.getByRole('button', { name: /source & coverage/i }).first().click();
  await page.getByRole('dialog', { name: /source & coverage/i }).waitFor();
  const provenance = page.getByRole('dialog').getByRole('link', { name: /z-anatomy/i });
  if (await provenance.count() !== 1) throw new Error('source modal does not expose exactly one geometry provenance link');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: /source & coverage/i }).waitFor({ state: 'detached' });
  stage('source modal passed');
  await page.getByRole('button', { name: 'Reset view' }).click();
  await page.waitForFunction((expected) => Number(document.querySelector('canvas')?.dataset.visibleStructureCount) === expected, skeletal.count);
  stage('reset restored skeletal-only initial view');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle', timeout: 120000 });
  await page.getByLabel('Interactive three dimensional human anatomy model').waitFor({ timeout: 120000 });
  await page.locator('.viewer-status').waitFor({ state: 'detached', timeout: 120000 });
  await page.getByLabel('Open structure library').click();
  await page.getByLabel('Search structures').fill('Liver');
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /^Liver$/i }) }).first().click();
  await page.getByRole('heading', { name: /liver/i }).waitFor();
  await page.getByLabel('Open structure library').click();
  await page.getByLabel('Search structures').fill('Stomach');
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /^Stomach$/i }) }).first().click();
  await page.getByRole('heading', { name: /stomach/i }).waitFor();
  await page.getByLabel('Open structure library').click();
  await page.getByLabel('Search structures').fill('Liver');
  await page.locator('.structure-row').filter({ has: page.locator('b', { hasText: /^Liver$/i }) }).first().click();
  await page.getByRole('heading', { name: /liver/i }).waitFor();
  await page.waitForFunction(() => document.querySelector('.library')?.getBoundingClientRect().right <= 0);
  await page.waitForTimeout(250);
  const mobileAccess = await page.locator('.inspector').evaluate((element) => {
    const rect = element.getBoundingClientRect(); return rect.top < window.innerHeight && rect.bottom > 0 && document.documentElement.scrollWidth <= window.innerWidth;
  });
  if (!mobileAccess) throw new Error('selected mobile description sheet is inaccessible or overflows the viewport');
  await page.screenshot({ path: resolve(screenshots, 'atlas-mobile-liver.png'), fullPage: true });
  stage('mobile library and inspector passed');
  if (browserErrors.length) throw new Error(`browser console/page errors:\n${[...new Set(browserErrors)].join('\n')}`);
  console.log(`Browser smoke passed at ${origin}; screenshots written to test-results/.`);
} catch (error) {
  if (page) {
    const diagnostics = await page.evaluate(() => ({
      status: document.querySelector('.viewer-status')?.textContent?.trim() ?? null,
      canvas: document.querySelector('canvas') ? Object.fromEntries(Object.entries(document.querySelector('canvas').dataset)) : null,
      body: document.body.innerText.slice(0, 2_000),
    })).catch(() => null);
    console.error(`[smoke] failure diagnostics: ${JSON.stringify(diagnostics)}`);
    await page.screenshot({ path: resolve(screenshots, 'smoke-failure.png'), fullPage: true }).catch(() => undefined);
  }
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(resolveClose));
}
