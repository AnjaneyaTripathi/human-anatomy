"""Export the Z-Anatomy Blender atlas without running its bundled add-on.

Run with Blender in background mode.  The script keeps source mesh topology and
materials intact.  It only converts source CURVE objects to meshes because glTF
has no equivalent curve primitive, and excludes atlas UI labels, lights, and
cameras from the browser payload.
"""

import bpy
import hashlib
import json
import os
import re
from mathutils import Vector

ROOT = os.environ.get("ANATOMY_OUTPUT", os.path.abspath("public"))
METADATA_ONLY = os.environ.get("ANATOMY_METADATA_ONLY") == "1"
EXPORT_ONLY = os.environ.get("ANATOMY_EXPORT_ONLY")
CARDIO_PART = os.environ.get("ANATOMY_CARDIO_PART")
MODELS = os.path.join(ROOT, "models")
DATA = os.path.join(ROOT, "data")
os.makedirs(MODELS, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

SYSTEMS = [
    ("1: Skeletal system", "skeletal", "Skeletal system", "#e5d0ae"),
    ("2: Muscular insertions", "muscular-insertions", "Muscular insertions", "#c98a7d"),
    ("3: Joints", "joints", "Joints", "#6e9bb9"),
    ("4: Muscular system", "muscular", "Muscular system", "#b75151"),
    ("5: Cardiovascular system", "cardiovascular", "Cardiovascular system", "#c53f42"),
    ("6: Lymphoid organs", "lymphoid", "Lymphoid organs", "#8eaf55"),
    ("7: Nervous system & Sense organs", "nervous-sense", "Nervous system & sense organs", "#e2b955"),
    ("8: Visceral systems", "visceral", "Visceral systems", "#a779b9"),
    ("9: Regions of human body", "regions", "Regions of the human body", "#b48b67"),
]
ROOT_TO_SYSTEM = {root: (sid, label, color) for root, sid, label, color in SYSTEMS}
TECHNICAL_PROPERTIES = {
    "Cross-section-X", "Cross-section-Y", "Cross-section-Z",
    "Cross-section-X-inverse", "Cross-section-Y-inverse", "Cross-section-Z-inverse",
    "muscle_color", "comic_shader", "key_color", "M3", "SheetGenerator",
}


def clean_name(value):
    return re.sub(r"\s+", " ", value or "").strip()


def normalized(value):
    value = clean_name(value)
    value = re.sub(r"\.(?:[lr]|[eo]?[lr]|j|t)$", "", value, flags=re.I)
    return value.strip(" ()[]")


def short_definition(text, title):
    """Keep a brief, source-provided definition and avoid a copied full article."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if lines and normalized(lines[0]).lower() == normalized(title).lower():
        lines.pop(0)
    body = re.sub(r"\s+", " ", " ".join(lines)).strip()
    body = re.sub(r"\s*https?://\S+.*$", "", body).strip()
    if not body:
        return None
    if len(body) <= 560:
        return body
    cut = body[:560].rsplit(". ", 1)[0].strip()
    return (cut or body[:560]).rstrip(" ,;:") + "."


def description_for(obj, texts):
    candidates = [obj.name, normalized(obj.name)]
    direct_names = set(candidates)
    current = obj.parent
    while current:
        candidates.extend([current.name, normalized(current.name)])
        current = current.parent
    for name in candidates:
        text = texts.get(name) or texts.get(normalized(name))
        description = short_definition(text, name)
        if description:
            origin = "object_name" if name in direct_names else "parent_name"
            urls = re.findall(r"https?://[^\s<>'\"]+", text)
            return description, "source_definition_excerpt", origin, urls, name
    return None, "missing_source_definition", None, [], None


def collection_system(obj):
    # Root collections own the objects directly in this source file.  Use the
    # first root in the fixed atlas order for rare shared objects.
    roots = {collection.name for collection in obj.users_collection}
    for root, sid, label, color in SYSTEMS:
        if root in roots:
            return sid, label, color
    return None


def is_anatomical_geometry(obj):
    """Exclude the source atlas's mesh titles and two-vertex label leaders."""
    if obj.type not in {"MESH", "CURVE", "SURFACE"}:
        return False
    if obj.type == "MESH" and (obj.name.endswith(".g") or obj.name.endswith(".j")):
        return False
    # `.i` source markers are vertex-only landmarks without renderable faces.
    if obj.type == "MESH" and len(obj.data.polygons) == 0:
        return False
    if obj.name in {"Ciliary body-curve.l", "Ciliary body-curve.r"}:
        return False
    return True


def parent_path(obj):
    path = []
    current = obj.parent
    while current:
        path.append(current.name)
        current = current.parent
    return list(reversed(path))


def gltf_point(point):
    # Blender is Z-up; glTF's canonical scene coordinates are Y-up.
    return [round(point.x, 5), round(point.z, 5), round(-point.y, 5)]


def bounds_for(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    corners = [evaluated.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    maximum = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    center = (minimum + maximum) / 2
    size = maximum - minimum
    return gltf_point(center), [round(size.x, 5), round(size.z, 5), round(size.y, 5)]


texts = {}
for text in bpy.data.texts:
    value = text.as_string()
    texts.setdefault(text.name, value)
    texts.setdefault(normalized(text.name), value)

for source_object in bpy.context.scene.objects:
    source_object.hide_set(False)
    source_object.hide_viewport = False
for source_collection in bpy.data.collections:
    source_collection.hide_viewport = False
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
all_geometry = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "CURVE", "SURFACE"}]
annotation_meshes = [obj for obj in all_geometry if not is_anatomical_geometry(obj)]
landmark_markers = [obj for obj in all_geometry if obj.type == "MESH" and len(obj.data.polygons) == 0 and obj.name.endswith(".i")]
eligible = [obj for obj in all_geometry if is_anatomical_geometry(obj)]
records = []
unassigned = []
for obj in eligible:
    system = collection_system(obj)
    if not system:
        unassigned.append(obj.name)
        continue
    sid, _, _ = system
    center, size = bounds_for(obj, depsgraph)
    description, status, description_origin, description_urls, description_applies_to = description_for(obj, texts)
    stable_key = f"z-anatomy:{sid}:{obj.name}"
    records.append({
        "id": f"za-{hashlib.sha1(stable_key.encode()).hexdigest()[:14]}",
        "name": obj.name,
        "nodeName": obj.name,
        "system": sid,
        "parentPath": parent_path(obj),
        "description": description,
        "descriptionStatus": status,
        "descriptionOrigin": description_origin,
        "descriptionAppliesTo": description_applies_to,
        "descriptionSourceUrls": description_urls,
        "region": "Unassigned",
        "center": center,
        "size": size,
        "sourceType": obj.type.lower(),
    })

# Make all atlas geometry visible for the exporter. Blender's glTF exporter
# evaluates CURVE/SURFACE geometry to full-detail meshes during export; doing
# an eager conversion here is unnecessary and repeatedly evaluates a known
# source dependency cycle.
for obj in eligible:
    obj.hide_set(False)
    obj.hide_viewport = False
    obj.hide_render = False
for collection in bpy.data.collections:
    collection.hide_viewport = False

system_output = []
source_scene = bpy.context.window.scene
for root_name, sid, label, color in SYSTEMS:
    objects = [obj for obj in eligible if collection_system(obj) and collection_system(obj)[0] == sid]
    filename = f"z-anatomy-{sid}.glb"
    output = os.path.join(MODELS, filename)
    files = [f"../models/{filename}"]
    if sid == "cardiovascular":
        objects = sorted(objects, key=lambda item: item.name)
        midpoint = (len(objects) + 1) // 2
        files = ["../models/z-anatomy-cardiovascular-01.glb", "../models/z-anatomy-cardiovascular-02.glb"]
        if CARDIO_PART in {"1", "2"}:
            objects = objects[:midpoint] if CARDIO_PART == "1" else objects[midpoint:]
            filename = f"z-anatomy-cardiovascular-0{CARDIO_PART}.glb"
            output = os.path.join(MODELS, filename)
    if METADATA_ONLY:
        entry = {"id": sid, "label": label, "color": color, "file": files[0], "count": len([obj for obj in eligible if collection_system(obj) and collection_system(obj)[0] == sid]), "sourceRootCollection": root_name}
        if sid == "cardiovascular": entry["files"] = files
        system_output.append(entry)
        continue
    if EXPORT_ONLY and sid != EXPORT_ONLY:
        entry = {"id": sid, "label": label, "color": color, "file": files[0], "count": len(objects), "sourceRootCollection": root_name}
        system_output.append(entry)
        continue
    # Export a standalone scene. This prevents selected parents or inherited
    # collection state from adding geometry from a previously exported system.
    temporary_scene = bpy.data.scenes.new(f"Z-Anatomy export {sid}")
    temporary_collection = bpy.data.collections.new(f"Z-Anatomy export {sid}")
    temporary_scene.collection.children.link(temporary_collection)
    clones = []
    for obj in objects:
        if obj.type in {"CURVE", "SURFACE"}:
            # The glTF exporter cannot evaluate a detached source curve when
            # its bevel/profile object lives in the source scene. Freeze its
            # evaluated source geometry into a full-detail mesh first.
            mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
            clone = bpy.data.objects.new(obj.name, mesh)
        else:
            clone = obj.copy()
            clone.data = obj.data
        clone.parent = None
        clone.matrix_world = obj.matrix_world.copy()
        clone.hide_set(False)
        clone.hide_select = False
        record = next((item for item in records if item["nodeName"] == obj.name), None)
        if record:
            clone["anatomyId"] = record["id"]
            clone["anatomyName"] = record["name"]
        temporary_collection.objects.link(clone)
        clones.append(clone)
    bpy.context.window.scene = temporary_scene
    for clone in clones:
        clone.select_set(True)
    bpy.context.view_layer.objects.active = clones[0] if clones else None
    selected = set(bpy.context.selected_objects)
    expected = set(clones)
    if selected != expected:
        extra = sorted(obj.name for obj in selected - expected)
        missing = sorted(obj.name for obj in expected - selected)
        raise RuntimeError(f"Selection mismatch for {sid}; extra={extra[:10]} missing={missing[:10]}")
    if objects:
        bpy.ops.export_scene.gltf(
            filepath=output,
            export_format="GLB",
            use_selection=True,
            export_apply=False,
            export_materials="EXPORT",
            export_normals=True,
            export_tangents=True,
            export_yup=True,
            export_extras=True,
            export_cameras=False,
            export_lights=False,
        )
    bpy.context.window.scene = source_scene
    bpy.data.scenes.remove(temporary_scene)
    entry = {
        "id": sid,
        "label": label,
        "color": color,
        "file": files[0],
        "count": len([obj for obj in eligible if collection_system(obj) and collection_system(obj)[0] == sid]),
        "sourceRootCollection": root_name,
    }
    if sid == "cardiovascular": entry["files"] = files
    system_output.append(entry)

manifest = {
    "source": {
        "name": "Z-Anatomy: The libre 3D atlas of anatomy",
        "url": "https://github.com/Z-Anatomy/Models-of-human-anatomy",
        "commit": "04d15340bad66394659c0e3b3ff9d9bb0924f6ca",
        "archiveUrl": "https://raw.githubusercontent.com/Z-Anatomy/Models-of-human-anatomy/master/Z-Anatomy.zip",
        "archiveSha256": "e029688545627bd0214b269e1063143abb580aad72b2c2445d6d8a9a0d9da736",
        "license": "CC BY-SA 4.0; included components have additional notices and restrictions in public/models/SOURCE.txt",
        "definitions": "Embedded Z-Anatomy source texts, stated by Z-Anatomy to rely heavily on Wikipedia; excerpts are not independently reviewed.",
        "exporter": "Blender 4.3.2, --disable-autoexec",
    },
    "systems": system_output,
    "structures": records,
    "landmarks": [],
    "coverage": {
        "sourceObjectCounts": {"mesh": 4568, "curve": 951, "font": 1660, "light": 3, "camera": 1},
        "sourceGeometry": len(all_geometry),
        "eligibleSourceGeometry": len(eligible),
        "exportedStructures": len(records),
        "unassignedEligibleGeometry": unassigned,
        "excluded": {
            "fontLabels": 1660,
            "meshTitleLabels": len([obj for obj in annotation_meshes if obj.name.endswith(".g")]),
            "meshLabelLeaders": len([obj for obj in annotation_meshes if obj.name.endswith(".j")]),
            "nonrenderableLandmarkMarkers": len(landmark_markers),
            "lights": 3,
            "cameras": 1,
            "reason": "Atlas interface labels, title meshes, two-vertex label-leader meshes, and scene illumination/camera are not anatomical geometry.",
        },
        "landmarkMarkers": [{"name": obj.name, "parentPath": parent_path(obj), "reason": "Source mesh contains no faces and cannot be rendered as an anatomical surface."} for obj in landmark_markers],
        "coordinateSystem": "glTF Y-up; center and size are world-space bounds transformed from Blender Z-up.",
        "limitations": "Z-Anatomy source documentation describes this as a navigable atlas template and does not claim a complete, clinically validated male or female body model. No coverage beyond the source is implied.",
    },
}
record_by_name = {item["nodeName"]: item for item in records}
for marker in landmark_markers:
    hook = next((modifier for modifier in marker.modifiers if modifier.type == "HOOK" and modifier.object and modifier.vertex_indices), None)
    if hook:
        endpoint = marker.data.vertices[hook.vertex_indices[-1]].co
        anchor = hook.object.matrix_world @ hook.matrix_inverse @ endpoint
        center, size = gltf_point(anchor), [0.0, 0.0, 0.0]
    else:
        center, size = bounds_for(marker, depsgraph)
    description, status, origin, urls, applies_to = description_for(marker, texts)
    parent = marker.parent
    parent_record = None
    while parent:
        parent_record = record_by_name.get(parent.name)
        if parent_record:
            break
        parent = parent.parent
    marker_key = f"z-anatomy:landmark:{marker.name}"
    manifest["landmarks"].append({
        "id": f"za-landmark-{hashlib.sha1(marker_key.encode()).hexdigest()[:14]}",
        "name": marker.name,
        "kind": "landmark",
        "system": parent_record["system"] if parent_record else "unassigned",
        "parentStructureId": parent_record["id"] if parent_record else None,
        "parentPath": parent_path(marker),
        "center": center,
        "size": size,
        "description": description,
        "descriptionStatus": status,
        "descriptionOrigin": origin,
        "descriptionAppliesTo": applies_to,
        "descriptionSourceUrls": urls,
        "reason": "Vertex-only source landmark marker; annotate its parent surface rather than load a separate renderable mesh.",
    })
with open(os.path.join(DATA, "anatomy.json"), "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))

print(json.dumps({"systems": [(entry["id"], entry["count"]) for entry in system_output], "records": len(records), "unassigned": len(unassigned)}))
