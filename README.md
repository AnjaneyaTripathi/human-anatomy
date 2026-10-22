# CORPUS

CORPUS is an interactive browser atlas for exploring human anatomy in three dimensions. It uses original Z-Anatomy geometry with selectable anatomical surfaces, searchable landmark labels, system controls, and source-linked descriptions where available.

The current local atlas contains **3,848 anatomical surface records and 314 anchored landmark labels across nine systems**, delivered in ten GLB files (about 205 MiB). Thirty source landmark markers have no usable anchor and remain in the audit rather than receiving guessed positions.

**The requested goal—hyper-realistic anatomy covering every detail in Netter's atlas—has not yet been achieved.** Full-resolution source geometry does not establish exhaustive anatomy. Z-Anatomy is an incomplete adult male model; female anatomy, anatomical validation, individual descriptions, and a plate-by-plate Netter coverage audit remain outstanding.

Browser materials adapt source RGB colours and documented class fallbacks to portable PBR shading, including removal of nonportable white emission. The adapter restores inspected source colours for organs and named material classes that previously received a generic fallback. It does not preserve Blender's procedural shaders or reproduce realistic tissue textures. The result has not been certified photorealistic or anatomically validated.

See [the coverage and acceptance audit](docs/COVERAGE.md) for the current evidence, known gaps, and completion criteria.

## Run locally

Install Node.js 22 and npm, then run from this directory:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Produce and inspect a production build with:

```sh
npm run build
npm run preview
```

A successful application build alone does not prove that the model assets are present, that every source structure was exported, or that the anatomy has passed review. The inventory and review status are recorded in [COVERAGE.md](docs/COVERAGE.md).

## Check the implementation

```sh
npm run check:assets
npx playwright install chromium
npm run test:browser
```

The asset check reconciles model files with the manifest. The browser test builds the production application, serves it below `/human-anatomy/`, and checks interactive behaviour and asset loading. It writes screenshots under the ignored `test-results/` directory. These are software checks, not a medical review or proof of atlas completeness.

## Rebuild anatomy assets

The export script requires Python 3, Blender 4.3.2, and the `Startup.blend` inside the original Z-Anatomy archive. The source revision and archive checksum are recorded in the coverage report and [asset notices](public/models/SOURCE.txt). Verify the archive checksum before regenerating. Keep the original source and intermediate files under the ignored `.source/` directory.

From the repository root, run:

```sh
blender --background --factory-startup --disable-autoexec .source/Startup.blend --python scripts/export_z_anatomy.py
python3 scripts/split_glb.py public/models/z-anatomy-cardiovascular.glb --parts 2 --output-prefix public/models/z-anatomy-cardiovascular
mv public/models/z-anatomy-cardiovascular.glb .source/z-anatomy-cardiovascular-unsplit.glb
python3 scripts/adapt_materials.py public/models --write
blender --background --factory-startup --disable-autoexec .source/Startup.blend --python scripts/finalize_asset_metadata.py -- public/data/anatomy.json
python3 scripts/enrich_descriptions.py --in-place --audit public/data/description-audit.json
npm run check:assets
```

The pipeline writes system GLBs to `public/models/` and the structure manifest to `public/data/anatomy.json`. It converts anatomical source curves to meshes without decimation and preserves anatomical mesh detail. The cardiovascular split preserves geometry buffer data. Source interface annotations, lights, cameras, empty helpers, and meshes without faces are accounted for separately; landmark labels remain searchable rather than being presented as independent anatomical surfaces. Source exclusions, missing landmark anchors, and description availability are recorded in the [coverage audit](docs/COVERAGE.md).

Descriptions distinguish direct source text, parent-structure context, supplementary text, and missing definitions. Optional generic `classContext` text does not count as a description of the selected part. All categories require medical review; missing definitions remain visible as missing.

## GitHub Pages

The user will test locally before making this repository public. After local acceptance, make this repository public, select **GitHub Actions** under **Settings → Pages → Build and deployment → Source**, and push to `main` or manually run the [deployment workflow](.github/workflows/deploy.yml). The workflow builds with Node.js 22 and publishes `dist/` from this repository; its deployment environment reports the published URL.

Vite uses a relative base so the application can run under a repository project path. Model assets in `public/` must be present before the build; the Pages workflow does not download the source atlas or run Blender. Verify 3D loading, selection, and descriptions on the published site before considering deployment complete. Deployment verification is pending.

## Anatomy source and reference scope

The model source is [Z-Anatomy: Models of human anatomy](https://github.com/Z-Anatomy/Models-of-human-anatomy), which incorporates BodyParts3D and additional contributors. Its [upstream task list](https://github.com/Z-Anatomy/Models-of-human-anatomy/blob/master/TO%20DO%20List) includes completing and validating the male model and creating a female model. Source names, descriptions, and geometry require review after conversion.

Netter is the requested anatomical coverage reference. Elsevier provides the [official ninth-edition overview](https://www.us.elsevierhealth.com/netter-atlas-of-human-anatomy) and [plate checklist with 3D correlates](https://www.us.elsevierhealth.com/media/wysiwyg/PDF/NetterAtlas9e_3DcorrelatesCompleteAnatomy.pdf). These references define a review target; they do not establish that this application's geometry or descriptions came from Netter. No Netter artwork or proprietary model library is supplied here.

The linked checklist is a public publisher PDF, not the complete atlas. Public publisher information and samples support scoping; a full plate-level anatomical review remains pending access to the atlas and qualified review.

## Provenance and licenses

Application code is covered by the existing [Apache License 2.0](LICENSE). That license does not replace the licenses attached to anatomical assets or their descriptions.

The [Z-Anatomy README and attribution list](https://github.com/Z-Anatomy/Models-of-human-anatomy/blob/master/Readme.md) identify these upstream notices:

| Material | Upstream attribution / notice |
| --- | --- |
| BodyParts3D anatomy | Database Center for Life Science; CC BY-SA 2.1 Japan |
| Z-Anatomy contributions | Z-Anatomy; CC BY-SA 4.0 |
| Descriptions | Wikipedia; CC BY-SA 3.0; original article links are included upstream |
| Cranial nerves and foramina | University of Dundee, CAHID; CC BY 4.0 |
| Inner-ear reference/included model | University of Dundee School of Medicine; CC BY-NC-SA 4.0 |
| Kidney reference/included model | Lissie Cowley; CC BY-NC 4.0 |
| Brain / white-matter sources | Upstream names Brainder and University of Washington; exact constituent provenance must remain traceable |

Retain contributor, source, attribution, and license information with exported data. The upstream notices include noncommercial components; a blanket open-source or commercial-use claim for the entire anatomy collection would be inaccurate. Per-asset provenance reconciliation is part of the outstanding audit.

Descriptions imported from upstream are source material, not independently reviewed medical guidance. The upstream project acknowledges reliance on Wikipedia and possible translation errors. Original supplementary descriptions, parent-level context, and alias-based source matches are additional categories requiring review; supplying text does not by itself verify that text for the selected structure. The coverage report distinguishes missing information from verified anatomy.
