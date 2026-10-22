#!/usr/bin/env python3
"""Make Z-Anatomy's Blender material classes portable glTF PBR materials.

Blender's source uses unsupported procedural shader graphs.  The stock glTF
exporter writes many of these with white emissive output and no base colour,
which makes browser renderers display glowing white anatomy.  This post-export
step changes *only* the JSON material definitions in GLB files: buffer views,
accessors, meshes, nodes, skins, and animation bytes are copied unchanged.

Existing exported base colours are kept.  For material classes without one, the
palette uses the source shader socket colours where they could be read (Bone,
Artery, Nerve, etc.), and a restrained class fallback where no source colour
socket exists. It is a portable PBR conversion, not a claim of photorealistic
tissue shading.

Usage:
  python scripts/adapt_materials.py public/models --write
  python scripts/adapt_materials.py public/models --write --provenance public/data/material-provenance.json
"""

from __future__ import annotations

import argparse
import json
import struct
from collections import Counter
from pathlib import Path
from typing import Any


# Linear glTF factors. Values for artery, vein, bone, cartilage, fat, brain,
# gland, heart, intestine, lung, nerve, skin, and biliary material are read
# from the source Blender node sockets (2026-10-22). Other material-class
# fallbacks are documented as fallbacks in the report. All are dielectric:
# source anatomy is not metal and unsupported Blender procedural graphs have
# no portable texture equivalent.
PALETTES: dict[str, tuple[list[float], float]] = {
    "bone": ([0.8, 0.5439, 0.311, 1.0], 0.62),
    "dentine": ([0.77, 0.70, 0.55, 1.0], 0.55),
    "teeth": ([0.82, 0.78, 0.64, 1.0], 0.38),
    "cartilage": ([0.6235, 0.8, 0.8, 1.0], 0.36),
    "ligament": ([0.73, 0.64, 0.48, 1.0], 0.54),
    "tendon": ([0.76, 0.68, 0.51, 1.0], 0.48),
    "fascia": ([0.74, 0.64, 0.52, 1.0], 0.46),
    "muscle": ([0.53, 0.16, 0.14, 1.0], 0.48),
    "artery": ([0.8, 0.1608, 0.1608, 1.0], 0.36),
    "vein": ([0.1922, 0.1757, 0.8, 1.0], 0.42),
    "nerve": ([1.0, 1.0, 0.4056, 1.0], 0.48),
    "brain": ([0.8, 0.279, 0.1951, 1.0], 0.55),
    "white matter": ([0.78, 0.70, 0.55, 1.0], 0.48),
    "lymph": ([0.45, 0.60, 0.19, 1.0], 0.50),
    "fat": ([0.6481, 0.4128, 0.0996, 1.0], 0.44),
    "skin": ([0.5882, 0.3072, 0.19, 1.0], 0.50),
    "heart": ([0.8, 0.0324, 0.0081, 1.0], 0.38),
    "lung": ([0.8, 0.367, 0.3372, 1.0], 0.55),
    "bronchi": ([0.5, 0.5, 0.5, 1.0], 0.50),
    "intestine": ([0.8, 0.2612, 0.2612, 1.0], 0.48),
    "mucosa": ([0.67, 0.19, 0.20, 1.0], 0.32),
    "gallbladder": ([0.30, 0.43, 0.12, 1.0], 0.42),
    "biliary": ([0.0938, 0.1657, 0.0496, 1.0], 0.42),
    "gland": ([0.8, 0.2498, 0.1148, 1.0], 0.47),
    "eye": ([0.76, 0.73, 0.66, 1.0], 0.22),
    "iris": ([0.20, 0.32, 0.18, 1.0], 0.30),
    "cornea": ([0.72, 0.84, 0.87, 0.38], 0.12),
    "default": ([0.54, 0.39, 0.33, 1.0], 0.52),
}

# Exact authored source values read from Startup.blend on 2026-10-22.  The
# Organ variants are liver segments in the atlas; treating their names as a
# generic fallback flattened the liver to a pale grey-brown in the viewer.
# These values come from the Organ group Color2 input or the per-variant RGB
# node, and are intentionally applied again when a prior conversion stored the
# old universal `default` fallback in a GLB.
SOURCE_MATERIALS: dict[str, tuple[list[float], float]] = {
    "Organ": ([0.096373, 0.02252404, 0.0, 1.0], 0.52),
    "Organ-1": ([0.5, 0.0, 0.39024723, 1.0], 0.52),
    "Organ-2": ([0.5, 0.0, 0.02333007, 1.0], 0.52),
    "Organ-3": ([0.5, 0.10196578, 0.00508248, 1.0], 0.52),
    "Organ-4": ([0.5, 0.41507101, 0.00032878, 1.0], 0.52),
    "Organ-5": ([0.04013056, 0.5, 0.0, 1.0], 0.52),
    "Organ-6": ([0.00088105, 0.46655318, 0.5, 1.0], 0.52),
    "Organ-7": ([0.01527864, 0.09058326, 0.5, 1.0], 0.52),
    "Organ-8": ([0.10831526, 0.0, 0.5, 1.0], 0.52),
    "Ductus": ([0.338579, 0.301595, 0.137033, 1.0], 0.38),
    "Articular capsule": ([0.56149101, 0.46286601, 0.8, 1.0], 0.40),
    "Black": ([0.019499, 0.019499, 0.019499, 1.0], 0.44),
    "Temporal lobe": ([1.0, 0.05651637, 0.03712114, 1.0], 0.52),
    "Occipital lobe": ([0.0, 1.0, 0.00595456, 1.0], 0.52),
    "Interlobar sulci": ([1.0, 0.8881917, 0.0014953, 1.0], 0.52),
    "Frontal lobe": ([0.02682437, 0.8249591, 1.0, 1.0], 0.52),
    "Parietal lobe": ([0.5567649, 0.13739878, 1.0, 1.0], 0.52),
    "Insula": ([1.0, 0.21906736, 0.0, 1.0], 0.52),
    "Limbic lobe": ([1.0, 0.030513, 0.98383868, 1.0], 0.52),
    "External rotation": ([0.0, 0.3885588, 0.67954302, 1.0], 0.48),
    "Superficial": ([1.0, 0.2, 0.47688824, 1.0], 0.48),
    "Orbicularis/Constrictor": ([1.0, 0.15744185, 0.0, 1.0], 0.48),
    "Ingestion": ([0.64068258, 0.22334376, 1.0, 1.0], 0.48),
    "Phonation": ([1.0, 1.0, 1.0, 1.0], 0.48),
    "Biarticular": ([0.00275165, 0.14946155, 0.0, 1.0], 0.48),
    "Extensor extremities": ([1.0, 0.1, 0.66064435, 1.0], 0.48),
}
DEFAULT_FALLBACK_COLOR = PALETTES["default"][0]


def palette_for(name: str) -> tuple[str, list[float], float]:
    if name in SOURCE_MATERIALS:
        color, roughness = SOURCE_MATERIALS[name]
        return f"source:{name}", color, roughness
    lowered = name.lower()
    for key in PALETTES:
        if key != "default" and key in lowered:
            color, roughness = PALETTES[key]
            return key, color, roughness
    # Named muscle-action materials (e.g. Flexion, Abductor) belong to the
    # muscular source material class even though their material names omit it.
    if any(word in lowered for word in ("flexion", "extension", "rotator", "abductor", "adductor", "levator", "depressor", "masticator", "trapezius", "diaphragm")):
        color, roughness = PALETTES["muscle"]
        return "muscle", color, roughness
    color, roughness = PALETTES["default"]
    return "default", color, roughness


def is_valid_color(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 4 and all(isinstance(channel, (int, float)) and 0 <= channel <= 1 for channel in value)


def load_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = path.read_bytes()
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise ValueError(f"{path} is not a binary glTF 2 file")
    version, length = struct.unpack_from("<II", raw, 4)
    if version != 2 or length != len(raw):
        raise ValueError(f"{path} has an unsupported or truncated GLB header")
    json_length, json_type = struct.unpack_from("<I4s", raw, 12)
    if json_type != b"JSON":
        raise ValueError(f"{path} has no leading JSON chunk")
    end = 20 + json_length
    document = json.loads(raw[20:end].decode("utf-8"))
    return document, raw[end:]


def write_glb(path: Path, document: dict[str, Any], remainder: bytes) -> None:
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((-len(encoded)) % 4)
    payload = struct.pack("<I4s", len(encoded), b"JSON") + encoded + remainder
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(payload)) + payload)


def adapt(document: dict[str, Any]) -> Counter[str]:
    usage: Counter[str] = Counter()
    for material in document.get("materials", []):
        name = str(material.get("name", "unnamed material"))
        category, fallback, roughness = palette_for(name)
        pbr = material.setdefault("pbrMetallicRoughness", {})
        source_backfill = category.startswith("source:") and pbr.get("baseColorFactor") == DEFAULT_FALLBACK_COLOR
        if not is_valid_color(pbr.get("baseColorFactor")) or source_backfill:
            pbr["baseColorFactor"] = fallback
            usage[f"{category if category.startswith('source:') else f'fallback:{category}'}"] += 1
        else:
            usage["preserved-exported-base-color"] += 1
        pbr["metallicFactor"] = 0.0
        pbr["roughnessFactor"] = roughness
        material["emissiveFactor"] = [0.0, 0.0, 0.0]
        material.pop("emissiveTexture", None)
    return usage


def main() -> int:
    parser = argparse.ArgumentParser(description="Adapt Z-Anatomy GLB materials to portable non-emissive PBR.")
    parser.add_argument("models", type=Path, help="directory containing exported z-anatomy-*.glb files")
    parser.add_argument("--write", action="store_true", help="write converted GLBs (default is a safe dry run)")
    parser.add_argument("--provenance", type=Path, default=Path("public/data/material-provenance.json"), help="conversion report path")
    args = parser.parse_args()

    files = sorted(args.models.glob("z-anatomy-*.glb"))
    if not files:
        raise SystemExit(f"No z-anatomy GLBs found in {args.models}")
    totals: Counter[str] = Counter()
    reports = []
    for path in files:
        document, remainder = load_glb(path)
        usage = adapt(document)
        totals.update(usage)
        reports.append({"file": path.name, "materials": len(document.get("materials", [])), "conversion": dict(sorted(usage.items()))})
        if args.write:
            write_glb(path, document, remainder)

    report = {
        "source": "Z-Anatomy Blender material names, authored node socket colours where available, and existing glTF PBR factors",
        "method": "Existing exported baseColorFactor values are retained. Missing factors receive a portable, non-metallic material-class colour. Named source socket colours are also restored when an earlier conversion recorded the universal default fallback, including Organ and Organ-1 through Organ-8. emissiveFactor is set to [0,0,0]. No geometry, buffers, node transforms, or texture bytes are changed.",
        "limitations": "The Blender source uses procedural shader graphs that do not export faithfully to glTF. This conversion restores legible material classes; it does not recreate procedural shaders, tissue microstructure, textures, or photorealism.",
        "written": args.write,
        "files": reports,
        "totals": dict(sorted(totals.items())),
    }
    if args.write:
        args.provenance.parent.mkdir(parents=True, exist_ok=True)
        args.provenance.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
