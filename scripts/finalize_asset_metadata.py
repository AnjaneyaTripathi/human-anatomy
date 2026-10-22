"""Finalize metadata after a lossless Z-Anatomy GLB export.

Run this file with Blender so landmark endpoints are obtained from source HOOK
modifiers, rather than from the un-evaluated two-vertex label leaders.  It does
not export, alter, or decimate any model geometry.

Example:
  /private/tmp/blender-app/Blender.app/Contents/MacOS/Blender --background \
    --factory-startup --disable-autoexec .source/Startup.blend \
    --python scripts/finalize_asset_metadata.py -- public/data/anatomy.json
"""

import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector


HELPERS = {"Ciliary body-curve.l", "Ciliary body-curve.r"}
CARDIO_FILES = [
    "../models/z-anatomy-cardiovascular-01.glb",
    "../models/z-anatomy-cardiovascular-02.glb",
]
GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A


def remove_helper_extras(model_path):
    """Remove only helper anatomy extras from an existing GLB, preserving BIN."""
    data = model_path.read_bytes()
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or total != len(data):
        raise ValueError(f"Invalid GLB: {model_path}")
    json_length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != JSON_CHUNK:
        raise ValueError(f"Missing GLB JSON chunk: {model_path}")
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip(" \t\r\n\0"))
    changed = 0
    for node in document.get("nodes", []):
        extras = node.get("extras")
        # Blender can suffix an otherwise empty clone node with `.001`; the
        # source anatomy name is the stable identifier in that case.
        if not extras or extras.get("anatomyName") not in HELPERS:
            continue
        for key in ("anatomyId", "anatomyName"):
            if key in extras:
                del extras[key]
                changed += 1
        if not extras:
            del node["extras"]
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((-len(encoded)) % 4)
    tail = data[20 + json_length:]
    model_path.write_bytes(struct.pack("<III", GLB_MAGIC, version, 12 + 8 + len(encoded) + len(tail)) + struct.pack("<II", len(encoded), JSON_CHUNK) + encoded + tail)
    return changed


def gltf_point(point):
    """Convert Blender Z-up world space to glTF Y-up world space."""
    return [round(point.x, 5), round(point.z, 5), round(-point.y, 5)]


def source_bounds(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    corners = [evaluated.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return (
        Vector((min(point.x for point in corners), min(point.y for point in corners), min(point.z for point in corners))),
        Vector((max(point.x for point in corners), max(point.y for point in corners), max(point.z for point in corners))),
    )


def distance_to_bounds(point, lower, upper):
    """Shortest distance to an axis-aligned source-object world bound."""
    nearest = Vector((
        min(max(point.x, lower.x), upper.x),
        min(max(point.y, lower.y), upper.y),
        min(max(point.z, lower.z), upper.z),
    ))
    return (point - nearest).length


def anchor_for(marker):
    hooks = [modifier for modifier in marker.modifiers if modifier.type == "HOOK"]
    hook = next((item for item in hooks if item.object and item.vertex_indices), None)
    if not hook:
        return None, {"status": "unavailable", "reason": "No HOOK modifier with a target and vertex index."}
    index = hook.vertex_indices[-1]
    if index < 0 or index >= len(marker.data.vertices):
        return None, {"status": "unavailable", "reason": "HOOK vertex index is outside the marker mesh."}
    point = hook.object.matrix_world @ hook.matrix_inverse @ marker.data.vertices[index].co
    return point, {
        "status": "anchored",
        "method": "hook_endpoint",
        "hookTarget": hook.object.name,
        "hookVertexIndex": index,
        "coordinateSystem": "Blender world Z-up transformed to glTF Y-up [x,z,-y].",
    }


def parent_object(marker, structures_by_name):
    current = marker.parent
    while current:
        if current.name in structures_by_name:
            return current
        current = current.parent
    return None


def main(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    existing_landmarks = {record["name"]: record for record in manifest.get("landmarks", [])}
    manifest["structures"] = [record for record in manifest["structures"] if record["nodeName"] not in HELPERS]
    structures_by_name = {record["nodeName"]: record for record in manifest["structures"]}

    for entry in manifest["systems"]:
        if entry["id"] == "cardiovascular":
            entry["file"] = CARDIO_FILES[0]
            entry["files"] = CARDIO_FILES
        elif entry["id"] == "nervous-sense":
            entry["count"] = sum(record["system"] == "nervous-sense" for record in manifest["structures"])

    for collection in bpy.data.collections:
        collection.hide_viewport = False
    for obj in bpy.context.scene.objects:
        obj.hide_set(False)
        obj.hide_viewport = False
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    nervous_model = manifest_path.parent.parent / "models" / "z-anatomy-nervous-sense.glb"
    extras_removed = remove_helper_extras(nervous_model)
    landmarks = []
    unavailable = []
    cache = {}
    for marker in bpy.context.scene.objects:
        if marker.type != "MESH" or not marker.name.endswith(".i") or len(marker.data.polygons) != 0:
            continue
        point, provenance = anchor_for(marker)
        hierarchy_parent = parent_object(marker, structures_by_name)
        # The hook target is the anatomical surface that owns the endpoint.
        # A source label hierarchy can occasionally point to the contralateral
        # surface (Root apex.i is one such source inconsistency).
        hook_parent = bpy.data.objects.get(provenance.get("hookTarget", "")) if point is not None else None
        parent = hook_parent if hook_parent and hook_parent.name in structures_by_name else hierarchy_parent
        parent_record = structures_by_name.get(parent.name) if parent else None
        hierarchy_record = structures_by_name.get(hierarchy_parent.name) if hierarchy_parent else None
        marker_key = f"z-anatomy:landmark:{marker.name}"
        record = dict(existing_landmarks.get(marker.name, {
            "id": f"za-landmark-{hashlib.sha1(marker_key.encode()).hexdigest()[:14]}",
            "name": marker.name,
            "kind": "landmark",
            "reason": "Vertex-only source landmark marker; annotate its parent surface rather than load a separate renderable mesh.",
        }))
        record["system"] = parent_record["system"] if parent_record else "unassigned"
        record["parentStructureId"] = parent_record["id"] if parent_record else None
        if hierarchy_record and parent_record and hierarchy_record["id"] != parent_record["id"]:
            record["sourceHierarchyParentStructureId"] = hierarchy_record["id"]
        else:
            record.pop("sourceHierarchyParentStructureId", None)
        record["size"] = [0.0, 0.0, 0.0]
        record["anchorProvenance"] = provenance
        current = marker.parent
        path = []
        while current:
            path.append(current.name)
            current = current.parent
        record["parentPath"] = list(reversed(path))
        if point is None:
            record["center"] = None
            unavailable.append({
                "id": record["id"],
                "name": record["name"],
                "parentStructureId": record["parentStructureId"],
                "parentPath": record["parentPath"],
                "anchorProvenance": provenance,
                "reason": "Excluded from selectable landmarks because the source marker has no valid HOOK endpoint; no coordinate was inferred from its label leader.",
            })
        else:
            record["center"] = gltf_point(point)
            if parent:
                lower, upper = source_bounds(parent, depsgraph)
                distance = distance_to_bounds(point, lower, upper)
                record["anchorValidation"] = {
                    "parentSourceObject": parent.name,
                    "distanceToParentWorldBounds": round(distance, 6),
                    "nearParentWorldBounds": distance <= 0.01,
                }
        if point is not None:
            landmarks.append(record)
        cache[marker.name] = {
            "center": record["center"],
            "parentStructureId": record["parentStructureId"],
            "provenance": provenance,
            "validation": record.get("anchorValidation"),
        }

    manifest["landmarks"] = sorted(landmarks, key=lambda record: record["name"])
    coverage = manifest.setdefault("coverage", {})
    coverage["exportedStructures"] = len(manifest["structures"])
    coverage["sourceObjectCounts"]["mesh"] = 4568
    coverage["sourceGeometry"] = sum(coverage["sourceObjectCounts"].get(kind, 0) for kind in ("mesh", "curve"))
    coverage["eligibleGeometryReconciliation"] = {
        "eligibleSourceGeometry": coverage.get("eligibleSourceGeometry"),
        "mappedPhysicalStructures": len(manifest["structures"]),
        "unassignedEligibleGeometry": len(coverage.get("unassignedEligibleGeometry", [])),
        "equation": "eligibleSourceGeometry = mappedPhysicalStructures + unassignedEligibleGeometry",
    }
    zero_face_meshes = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and len(obj.data.polygons) == 0
    ]
    zero_face_other = [
        obj.name for obj in zero_face_meshes
        if not obj.name.endswith(".j") and not obj.name.endswith(".i")
    ]
    coverage["nonrenderableZeroFaceMeshes"] = {
        "count": len(zero_face_meshes),
        "labelLeaders": sum(obj.name.endswith(".j") for obj in zero_face_meshes),
        "landmarkMarkers": sum(obj.name.endswith(".i") for obj in zero_face_meshes),
        "other": sorted(zero_face_other),
        "reason": "These source meshes have no faces and cannot produce a renderable anatomical surface. Categories overlap existing label-leader and landmark counts.",
    }
    coverage["excludedConstructionHelpers"] = [
        {"name": name, "reason": "Source construction curve has bevel depth 0 and no bevel object, so it does not render as anatomical tissue."}
        for name in sorted(HELPERS)
    ]
    coverage["landmarkAnchorExtraction"] = {
        "sourceMarkerCount": len(landmarks) + len(unavailable),
        "anchoredCount": len(landmarks),
        "cache": "landmark-anchors.json",
        "method": "HOOK modifier endpoint after unhiding all source collections and objects.",
        "unavailableCount": len(unavailable),
        "unavailable": unavailable,
        "helperExtrasRemovedFromNervousModel": extras_removed,
    }
    anchor_outliers = [
        {"name": record["name"], "parentStructureId": record["parentStructureId"], "distanceToParentWorldBounds": record["anchorValidation"]["distanceToParentWorldBounds"]}
        for record in landmarks
        if record.get("anchorValidation") and not record["anchorValidation"]["nearParentWorldBounds"]
    ]
    coverage["landmarkAnchorBoundsOutliers"] = anchor_outliers
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cache_path = manifest_path.with_name("landmark-anchors.json")
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"structures": len(manifest["structures"]), "landmarks": len(landmarks), "unavailable": len(unavailable)}))


if __name__ == "__main__":
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    main(arguments[0] if arguments else "public/data/anatomy.json")
