# CORPUS anatomy coverage and acceptance audit

## Current result

The requested result is a hyper-realistic human body with all internal organs, a brief description for every part, and anatomical detail comparable to Netter's atlas. **That result is not yet complete.** This document records evidence and outstanding acceptance work without treating an import count as a completeness certificate.

The current implementation contains 3,848 Z-Anatomy surface records at full resolution without decimation, with 314 anchored landmark labels represented separately. Portable browser materials use source RGB colours and documented fallbacks; Blender procedural shaders and realistic tissue textures are not preserved. The model has not been certified photorealistic, medically validated, or audited against every Netter plate.

## Evidence and known limitations

| Area | Evidence | Status / next action |
| --- | --- | --- |
| Adult male source | [Upstream repository](https://github.com/Z-Anatomy/Models-of-human-anatomy) identifies the model as male. | Inspect converted structures and spatial relationships. |
| Female anatomy | [Upstream task list](https://github.com/Z-Anatomy/Models-of-human-anatomy/blob/master/TO%20DO%20List) places creation of a female model in future work. | Missing from the source scope; requires a separately sourced and validated model. |
| Source completeness | The same task list includes completing missing structures and final validation. | Source import cannot establish exhaustive coverage. |
| Named source objects without surfaces | The source contains nonrenderable markers, empty geometry, and construction helpers as well as anatomical meshes. | Record these separately; a name or annotation is not evidence of a modeled anatomical surface. |
| Heart interiors | [Upstream issue #11](https://github.com/Z-Anatomy/Models-of-human-anatomy/issues/11) reports missing anterior atrioventricular valve components. | Verify names, geometry, and interior views locally; document or repair confirmed omissions. |
| Description quality | [Upstream README](https://github.com/Z-Anatomy/Models-of-human-anatomy/blob/master/Readme.md) documents Wikipedia-derived definitions and possible translation errors. | Check source links, relevance, length, terminology, and medical accuracy. |
| Netter correspondence | [Elsevier's ninth-edition plate checklist](https://www.us.elsevierhealth.com/media/wysiwyg/PDF/NetterAtlas9e_3DcorrelatesCompleteAnatomy.pdf) supplies an official scope reference. | Plate-by-plate audit pending. |
| Asset rights | Upstream contributor notices contain several licenses and some unresolved constituent provenance. | Preserve individual notices and establish per-asset mapping. See [README](../README.md#provenance-and-licenses). |

## Inventory reconciliation

The final local metadata records the following inventory. Full machine-readable evidence is in [anatomy.json](../public/data/anatomy.json), [landmark anchors](../public/data/landmark-anchors.json), and the [description audit](../public/data/description-audit.json).

| Measure | Verified value |
| --- | --- |
| Source repository revision | `04d15340bad66394659c0e3b3ff9d9bb0924f6ca` |
| Source archive SHA-256 | `e029688545627bd0214b269e1063143abb580aad72b2c2445d6d8a9a0d9da736` |
| Source scene mesh / curve objects | 4,568 meshes + 951 curves = 5,519 geometry objects |
| Source non-geometry scene objects | 1,660 font labels, 3 lights, 1 camera |
| Eligible geometry reconciliation | 3,900 = 3,848 mapped surface records + 52 unassigned source objects |
| Exported surface records | 3,848 across 9 systems and 10 GLB files |
| Selectable landmark labels | 314 anchored source markers |
| Unavailable landmark anchors | 30 source markers; retained in the audit, without inferred coordinates |
| GLB payload | 214,775,912 bytes, about 205 MiB |
| GLB geometry counters | 4,111,327 POSITION accessor entries; 7,351,646 triangles in mesh primitives |
| Excluded objects and reasons | Source UI labels, nonrenderable geometry, unassigned helpers, and construction curves; detailed below and in manifest coverage |
| Surface descriptions matched to source object names | 2,855; source excerpts, unreviewed |
| Surface descriptions inherited from parents | 487; parent context, not specific part definitions |
| Specific supplementary descriptions | 61; editorial and unreviewed |
| Surfaces with no supplied description | 445; 337 have optional generic class context |
| Landmark description provenance | All 314 inherit parent context |
| Export tools | Blender 4.3.2, Python 3; [reproduction commands](../README.md#rebuild-anatomy-assets) |
| Asset validation | `npm run check:assets` passed after metadata reconciliation |
| Production build / browser validation | `npm run test:browser` passed using the `/human-anatomy/` production prefix; includes the production build |
| Desktop visual inspection | Whole-body layout and isolated liver colours inspected locally; anatomical and photorealism reviews remain outstanding |

Mesh objects are not necessarily individual anatomical structures. Source annotations, repeated instances, combined geometry, and labels must be accounted for separately. Names that fail a text search require synonym and geometry inspection before being classified as missing.

GLB geometry counters describe the delivered payload; they are not counts of unique source vertices or distinct anatomical parts. Mesh splitting, shared geometry, material boundaries, and repeated instances affect those measures.

The source includes 11 title meshes and 1,228 label-leader meshes. Its 1,605 zero-face meshes comprise 1,227 label leaders, 344 landmark markers, and 34 other objects explicitly listed in `coverage.nonrenderableZeroFaceMeshes.other`. These categories overlap the source label counts and must not be added as disjoint exclusions. A label-leader object with faces remains classified as an annotation. The construction curves `Ciliary body-curve.l` and `Ciliary body-curve.r` have zero bevel depth and no bevel object; their empty anatomy identifiers are removed from the browser model. The 52 unassigned eligible objects are listed individually in manifest coverage.

Only 314 of 344 source landmark markers have usable HOOK endpoints. The remaining 30 are excluded from selectable landmarks and retained under `coverage.landmarkAnchorExtraction.unavailable` and in the anchor cache. Their positions are not guessed from annotation lines. Anatomical geometry and interface annotations are distinguished using source evidence rather than object type or filename suffix alone.

Descriptions may be direct source excerpts, source excerpts recovered through an alias, inherited parent-structure context, or supplementary text. An inherited description of a whole bone is not a specific description of every named surface or process on it. Supplementary text and alias matches must carry provenance and remain unreviewed until their correspondence and medical accuracy are checked. Generic `classContext` text remains separate and does not satisfy the per-part description requirement. Missing source prose is a genuine coverage gap even when a supplementary description is supplied.

Material conversion changes JSON material definitions rather than anatomical geometry. Source-exported base colours are retained where appropriate; the adapter restores inspected source RGB values when a prior conversion stored the generic default fallback, including the organ material variants and other named classes. Missing colours use source shader-socket values or documented class fallbacks. The adapter removes white emission that does not transfer correctly from the original procedural shader graphs. Source colours can encode anatomical regions and are not a claim of lifelike tissue appearance. See [the material provenance report](../public/data/material-provenance.json) for the conversion and its limits.

The final local browser pass verified model loading, liver selection and isolation, view presets and section controls, an anchored landmark, source information, and the mobile library and inspector. Screenshots are generated under ignored `test-results/`. These checks establish software behaviour under the tested conditions; they do not complete the anatomical coverage checklist below or verify a public deployment. GitHub Pages has not been published or tested remotely.

## Acceptance criteria

- [ ] Identify the exact source revision and archive checksum; preserve the source and export procedure.
- [ ] Reconcile every source mesh with its exported equivalent. Explain all exclusions and verify no unintended reduction in geometric detail.
- [ ] Preserve coordinates, transforms, left/right identity, source identifiers, hierarchy, and material associations. Validate the anatomical orientation in the browser.
- [ ] Make every included anatomical structure discoverable and selectable. Verify overlapping, very small, deeply situated, and bilateral structures.
- [ ] Provide a brief, relevant description for every part, with an exact source and review status. Report missing text explicitly.
- [ ] Audit spelling, synonyms, modern anatomical terminology, and parent-child relationships.
- [ ] Inspect whole-body proportions and close views of the head, chest, abdomen, pelvis, hands, and feet.
- [ ] Review organ interiors and adjacent vessels, nerves, ducts, membranes, supporting tissues, and tissue layers where required by the reference scope.
- [ ] Add and validate female anatomy and its relationships within a corresponding female body.
- [ ] Complete the plate audit below and resolve missing or unverified requirements before claiming Netter-level coverage.
- [ ] Review realistic surface appearance under close inspection, including materials, fine detail, scale, and lighting; record actual rendering limitations.
- [ ] Complete an independent anatomical review; software tests and source fidelity do not substitute for it.
- [ ] Verify the deployed GitHub Pages site loads its models and supports interactive 3D exploration, including selection and descriptions, using the production asset paths.

## Targeted omission checks

Use English and Latin synonyms and then inspect the corresponding source geometry. These are review targets, not a claim that every item is absent:

| Group | Priority searches / visual checks |
| --- | --- |
| Female anatomy | Ovaries, uterine tubes, uterus, cervix, vagina, clitoris, mammary glands, supporting ligaments and fascia, associated vessels and nerves |
| Cardiac structures | Mitral and tricuspid leaflets, chordae tendineae, papillary muscles, all four chambers, septa, coronary vessels, conduction structures |
| Endocrine / lymphatic | Thyroid, parathyroids, adrenal / suprarenal glands, pituitary, pineal, thymus, thoracic duct, cisterna chyli |
| Sense organs / neural | Retina, cochlea, ossicles, cranial nerves, foramina, roots and branches, autonomic plexuses |
| Thoracic / abdominal relations | Bronchopulmonary segments, pleura, pericardium, mesentery, omenta, portal structures, biliary and pancreatic ducts, renal collecting structures |
| Limb detail | Individual small bones, joint surfaces, ligaments, tendons, sheaths, intrinsic muscles, distal vessels and nerves |

The first manifest name audit identified these high-priority candidates. They are **not validated geometric absences**: combined meshes, synonyms, excluded annotations, and source parent relationships still require inspection.

| Candidate | Initial name-audit evidence | Required verification |
| --- | --- | --- |
| Female reproductive anatomy | No named ovaries, uterus, uterine tubes, cervix, or clitoris in the preliminary inventory; upstream scope is male. A sphenoid bone's vaginal process is not vaginal anatomy. | Supply and validate a female body and its organ relationships. |
| Anterior atrioventricular valve leaflets and support | Named posterior left and inferior/septal right leaflets are present; anterior leaflet and chordae names were not found. This aligns with the upstream cardiac issue. | Inspect cardiac interiors for separate or combined leaflets, chordae, and papillary geometry before determining exact omissions. |
| Main lymphatic drainage | No names matching thoracic duct or cisterna chyli in the initial inventory. | Search synonyms and inspect source lymphatic geometry and drainage pathways. |
| Mesentery | No exact mesentery name found; mesocolon, mesenteric vessels/nodes, and omenta are represented by names. | Inspect the actual peritoneal supporting geometry and source hierarchy; vessels and nodes do not establish mesentery coverage. |
| Individual descriptions | Preliminary missing definitions include costal cartilages and nucleus pulposus levels. Parent text often describes an entire bone rather than a selected landmark. | Reconcile final direct, alias, inherited, supplemental, and missing counts; review each selected part's actual text. |

Synonym checks also recovered positive coverage evidence: the pituitary is named through its constituent hypophyseal structures, retina names occur bilaterally, and segmental pulmonary bronchi and arteries have explicit names. These illustrate why exact-string failure alone cannot establish an omission.

## Plate audit template

Use the official checklist and a legitimately accessed atlas to assess anatomy, interiors, relationships, and views. A matching structure name alone is insufficient. Record the edition and plate numbering consistently. Do not reproduce atlas artwork or long text passages.

The public publisher PDF linked above is a plate checklist with 3D correlations. It is not a public full-text edition of the atlas. Public publisher samples can support initial scope checks; they do not establish access to or completion of a review of every plate.

Allowed status values: **unreviewed**, **covered**, **partial**, **missing**, **not applicable with reason**. Keep a structure's existence, geometry accuracy, description accuracy, and visual quality as separate findings.

| Edition / plate | Required anatomy and view | Model IDs / scene evidence | Description sources | Status | Gaps / owner / verification date |
| --- | --- | --- | --- | --- | --- |
| To be reviewed | To be identified | Not yet recorded | Not yet recorded | Unreviewed | Plate audit pending |

## Completion claim

Until all relevant criteria pass and outstanding anatomy is supplied and reviewed, describe CORPUS as an interactive atlas based on the imported source. Do not describe it as an exhaustive human anatomy model, a validated Netter reproduction, or a certified photorealistic anatomical reference.
