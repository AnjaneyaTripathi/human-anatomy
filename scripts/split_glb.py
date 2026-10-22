#!/usr/bin/env python3
"""Losslessly split a flat, unanimated GLB into independently loadable GLBs.

Each output retains the selected source nodes' mesh geometry, materials, node
transforms and extras.  Buffer-view payloads are copied byte-for-byte; only
the enclosing GLB layout and index references are remapped.
"""

import argparse
import copy
import json
import math
import struct
from pathlib import Path


GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def align4(value):
    return (value + 3) & ~3


def read_glb(path):
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("not a GLB")
    magic, version, declared_len = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or declared_len != len(data):
        raise ValueError("expected a complete GLB 2.0 file")
    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != JSON_CHUNK:
        raise ValueError("GLB has no JSON chunk")
    offset = 20 + json_len
    document = json.loads(data[20:offset].decode("utf-8").rstrip(" \t\r\n\0"))
    if offset + 8 > len(data):
        raise ValueError("GLB has no BIN chunk")
    bin_len, bin_type = struct.unpack_from("<II", data, offset)
    if bin_type != BIN_CHUNK or offset + 8 + bin_len != len(data):
        raise ValueError("expected exactly one BIN chunk")
    return document, data[offset + 8:offset + 8 + bin_len]


def collect_accessor_ids(mesh):
    result = set()
    for primitive in mesh.get("primitives", []):
        result.update(primitive.get("attributes", {}).values())
        if "indices" in primitive:
            result.add(primitive["indices"])
        for target in primitive.get("targets", []):
            result.update(target.values())
    return result


def remap_value(value, mapping):
    if isinstance(value, int):
        return mapping[value]
    return value


def build_part(source, binary, node_indices):
    """Build a standalone document for a subset of source nodes."""
    nodes = source["nodes"]
    meshes = source["meshes"]
    accessors = source["accessors"]
    views = source["bufferViews"]
    mesh_ids = []
    for node_index in node_indices:
        if "mesh" in nodes[node_index] and nodes[node_index]["mesh"] not in mesh_ids:
            mesh_ids.append(nodes[node_index]["mesh"])
    accessor_ids = []
    for mesh_id in mesh_ids:
        for accessor_id in sorted(collect_accessor_ids(meshes[mesh_id])):
            if accessor_id not in accessor_ids:
                accessor_ids.append(accessor_id)
    view_ids = []
    for accessor_id in accessor_ids:
        accessor = accessors[accessor_id]
        for view_id in [accessor.get("bufferView"), accessor.get("sparse", {}).get("indices", {}).get("bufferView"), accessor.get("sparse", {}).get("values", {}).get("bufferView")]:
            if view_id is not None and view_id not in view_ids:
                view_ids.append(view_id)

    mesh_map = {old: new for new, old in enumerate(mesh_ids)}
    accessor_map = {old: new for new, old in enumerate(accessor_ids)}
    view_map = {old: new for new, old in enumerate(view_ids)}
    out_binary = bytearray()
    out_views = []
    for old_id in view_ids:
        old_view = copy.deepcopy(views[old_id])
        old_offset = old_view.get("byteOffset", 0)
        length = old_view["byteLength"]
        payload = binary[old_offset:old_offset + length]
        if len(payload) != length:
            raise ValueError(f"bufferView {old_id} exceeds source BIN chunk")
        new_offset = align4(len(out_binary))
        out_binary.extend(b"\0" * (new_offset - len(out_binary)))
        out_binary.extend(payload)
        old_view["buffer"] = 0
        old_view["byteOffset"] = new_offset
        out_views.append(old_view)

    out_accessors = []
    for old_id in accessor_ids:
        accessor = copy.deepcopy(accessors[old_id])
        if "bufferView" in accessor:
            accessor["bufferView"] = view_map[accessor["bufferView"]]
        sparse = accessor.get("sparse")
        if sparse:
            sparse["indices"]["bufferView"] = view_map[sparse["indices"]["bufferView"]]
            sparse["values"]["bufferView"] = view_map[sparse["values"]["bufferView"]]
        out_accessors.append(accessor)

    out_meshes = []
    for old_id in mesh_ids:
        mesh = copy.deepcopy(meshes[old_id])
        for primitive in mesh.get("primitives", []):
            primitive["attributes"] = {key: accessor_map[value] for key, value in primitive.get("attributes", {}).items()}
            if "indices" in primitive:
                primitive["indices"] = accessor_map[primitive["indices"]]
            if "targets" in primitive:
                primitive["targets"] = [{key: accessor_map[value] for key, value in target.items()} for target in primitive["targets"]]
        out_meshes.append(mesh)

    out_nodes = []
    for old_id in node_indices:
        node = copy.deepcopy(nodes[old_id])
        if "mesh" in node:
            node["mesh"] = mesh_map[node["mesh"]]
        # Inputs for this repository are flat. Children would require bringing
        # their entire hierarchy into the same part, so reject silently unsafe use.
        if node.get("children"):
            raise ValueError("split_glb.py currently requires flat parentless nodes")
        out_nodes.append(node)

    output = {}
    # Keep all document-level metadata and extension declarations intact.
    for key in ("asset", "extensionsUsed", "extensionsRequired", "extensions"):
        if key in source:
            output[key] = copy.deepcopy(source[key])
    # Retain scene extras (the Z-Anatomy export carries useful view metadata
    # there) while replacing each scene's root-node list with this part's roots.
    node_map = {old: new for new, old in enumerate(node_indices)}
    out_scenes = []
    for scene in source.get("scenes", []):
        copied_scene = copy.deepcopy(scene)
        if "nodes" in copied_scene:
            copied_scene["nodes"] = [node_map[node_id] for node_id in copied_scene["nodes"] if node_id in node_map]
        out_scenes.append(copied_scene)
    if not out_scenes:
        out_scenes = [{"name": "Scene", "nodes": list(range(len(out_nodes)))}]
    # If the source default scene did not reference the exported flat objects,
    # expose the part through a new default scene without discarding its extras.
    default_scene = source.get("scene", 0)
    if default_scene >= len(out_scenes) or not out_scenes[default_scene].get("nodes"):
        out_scenes.append({"name": "Split export", "nodes": list(range(len(out_nodes)))})
        default_scene = len(out_scenes) - 1
    output["scene"] = default_scene
    output["scenes"] = out_scenes
    output["nodes"] = out_nodes
    output["meshes"] = out_meshes
    output["accessors"] = out_accessors
    output["bufferViews"] = out_views
    output["buffers"] = [{"byteLength": len(out_binary)}]
    # Materials are small and are intentionally preserved without remapping:
    # primitive material indices remain exactly as in the source.
    for key in ("materials", "samplers", "images", "textures", "cameras"):
        if key in source:
            output[key] = copy.deepcopy(source[key])
    return output, bytes(out_binary)


def encode_glb(document, binary):
    encoded_json = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded_json += b" " * (align4(len(encoded_json)) - len(encoded_json))
    padded_binary = binary + b"\0" * (align4(len(binary)) - len(binary))
    total = 12 + 8 + len(encoded_json) + 8 + len(padded_binary)
    return b"".join((struct.pack("<III", GLB_MAGIC, 2, total), struct.pack("<II", len(encoded_json), JSON_CHUNK), encoded_json, struct.pack("<II", len(padded_binary), BIN_CHUNK), padded_binary))


def validate_lossless(source, source_binary, document, out_binary):
    source_ids = {node.get("extras", {}).get("anatomyId") for node in source["nodes"] if node.get("extras", {}).get("anatomyId")}
    output_ids = {node.get("extras", {}).get("anatomyId") for node in document["nodes"] if node.get("extras", {}).get("anatomyId")}
    if len(output_ids) != len([node for node in document["nodes"] if node.get("extras", {}).get("anatomyId")]):
        raise ValueError("duplicate anatomyId in output")
    if not output_ids <= source_ids:
        raise ValueError("output contains unknown anatomyId")
    for view in document["bufferViews"]:
        payload = out_binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        # Every emitted view must appear byte-for-byte in one source view.
        if not any(payload == source_binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in source["bufferViews"]):
            raise ValueError("output contains changed bufferView data")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--parts", type=int, default=2)
    parser.add_argument("--max-bytes", type=int, default=90 * 1024 * 1024)
    parser.add_argument("--output-prefix", type=Path, help="Default: input path without .glb")
    args = parser.parse_args()
    if args.parts < 2:
        parser.error("--parts must be at least 2")
    source, binary = read_glb(args.input)
    if len(source.get("buffers", [])) != 1:
        raise ValueError("expected one source buffer")
    # A mesh's cost is the unique bufferViews referenced by its accessors.
    mesh_cost = {}
    for mesh_id, mesh in enumerate(source["meshes"]):
        ids = collect_accessor_ids(mesh)
        view_ids = set()
        for accessor_id in ids:
            accessor = source["accessors"][accessor_id]
            if "bufferView" in accessor:
                view_ids.add(accessor["bufferView"])
            if accessor.get("sparse"):
                view_ids.add(accessor["sparse"]["indices"]["bufferView"])
                view_ids.add(accessor["sparse"]["values"]["bufferView"])
        mesh_cost[mesh_id] = sum(align4(source["bufferViews"][view_id]["byteLength"]) for view_id in view_ids)
    groups = [[] for _ in range(args.parts)]
    weights = [0] * args.parts
    for node_id in sorted(range(len(source["nodes"])), key=lambda n: mesh_cost.get(source["nodes"][n].get("mesh"), 0), reverse=True):
        target = min(range(args.parts), key=lambda index: weights[index])
        groups[target].append(node_id)
        weights[target] += mesh_cost.get(source["nodes"][node_id].get("mesh"), 0)
    prefix = args.output_prefix or args.input.with_suffix("")
    all_ids = []
    for index, group in enumerate(groups, 1):
        document, out_binary = build_part(source, binary, group)
        validate_lossless(source, binary, document, out_binary)
        encoded = encode_glb(document, out_binary)
        if len(encoded) > args.max_bytes:
            raise ValueError(f"part {index} is {len(encoded):,} bytes, exceeds --max-bytes {args.max_bytes:,}")
        output_path = Path(f"{prefix}-{index:02d}.glb")
        output_path.write_bytes(encoded)
        all_ids.extend(node.get("extras", {}).get("anatomyId") for node in document["nodes"] if node.get("extras", {}).get("anatomyId"))
        print(f"{output_path}: {len(encoded):,} bytes; {len(document['nodes'])} nodes; {len(document['meshes'])} meshes")
    source_ids = [node.get("extras", {}).get("anatomyId") for node in source["nodes"] if node.get("extras", {}).get("anatomyId")]
    if set(all_ids) != set(source_ids) or len(all_ids) != len(source_ids):
        raise ValueError("anatomyId union does not exactly match source")
    print(f"validated {len(all_ids)} anatomy IDs across {args.parts} lossless parts")


if __name__ == "__main__":
    main()
