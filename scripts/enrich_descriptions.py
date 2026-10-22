#!/usr/bin/env python3
"""Apply conservative, source-linked editorial anatomy descriptions.

This deliberately does not infer a description for every unmatched label. It
only fills records that lack a description and records the source/basis and
editorial review status so the generated data remains auditable.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "public/data/anatomy.json"
DEFAULT_SUPPLEMENTS = ROOT / "public/data/description-supplements.json"
SOURCE_SYSTEMS = {
    "synovial": {"joints"},
    "costalCartilage": {"skeletal"},
    "intervertebralDisc": {"joints"},
    "lymphatic": {"lymphoid"},
    "cardiovascular": {"cardiovascular"},
    "veins": {"cardiovascular"},
    "centralNervousSystem": {"nervous-sense"},
    "regions": {"regions"},
    "skin": {"regions"},
    "muscles": {"muscular"},
    "abdominalMuscles": {"muscular"},
    "upperLimbMuscles": {"muscular"},
    "respiratory": {"visceral"},
}


def normalized_name(value: str) -> str:
    """Remove only exporter side/group suffixes; retain the anatomical name."""
    value = re.sub(r"\s+", " ", value or "").strip()
    value = re.sub(r"\.(?:[lr]|[eo]?\d*[lr]|[gj])$", "", value, flags=re.IGNORECASE)
    return value.strip(" ()[]")


def candidate_for(structure: dict[str, Any], supplements: dict[str, Any]) -> tuple[dict[str, Any], str] | None:
    name = structure.get("name", "")
    normalized = normalized_name(name)
    exact = supplements.get("exact", {}).get(normalized)
    if exact:
        return exact, "exact"
    for rule in supplements.get("rules", []):
        if rule.get("systems") and structure.get("system") not in rule["systems"]:
            continue
        expected_systems = SOURCE_SYSTEMS.get(rule["source"])
        if expected_systems and structure.get("system") not in expected_systems:
            continue
        if re.search(rule["pattern"], normalized, flags=re.IGNORECASE):
            return rule, f"rule:{rule['pattern']}"
    return None


def enrich(manifest: dict[str, Any], supplements: dict[str, Any]) -> dict[str, Any]:
    sources = supplements["sources"]
    coverage = Counter()
    for structure in manifest.get("structures", []):
        if structure.get("description"):
            coverage["already_described"] += 1
            if structure.get("descriptionStatus") == "source_definition_excerpt":
                coverage[f"source_{structure.get('descriptionOrigin') or 'other'}"] += 1
            continue
        match = candidate_for(structure, supplements)
        if not match:
            coverage["unmatched_missing"] += 1
            continue
        entry, match_type = match
        source = sources[entry["source"]]
        is_class_context = "pattern" in entry and entry.get("kind") != "specific"
        if is_class_context:
            # Class-level help must never look like a source-backed description
            # of this particular structure.  Keep the missing description
            # visible and expose optional context in separate fields.
            structure["classContext"] = entry["description"]
            structure["classContextSourceUrls"] = [source["url"]]
            structure["classContextSourceBasis"] = source["basis"]
            structure["classContextMatch"] = match_type
            coverage["class_context_available"] += 1
            coverage["missing_specific"] += 1
            continue
        structure["description"] = entry["description"]
        structure["descriptionStatus"] = supplements["status"]
        structure["descriptionOrigin"] = "description_supplement"
        structure["descriptionAppliesTo"] = structure["name"]
        structure["descriptionSourceUrls"] = [source["url"]]
        structure["descriptionSourceBasis"] = source["basis"]
        structure["descriptionSupplementMatch"] = match_type
        coverage["specific_supplemented"] += 1
    total = len(manifest.get("structures", []))
    return {
        "totalStructures": total,
        "sourceDefinitionsDirect": coverage["source_object_name"],
        "sourceDefinitionsParent": coverage["source_parent_name"],
        "sourceDefinitionsOther": coverage["source_other"],
        "specificSupplemented": coverage["specific_supplemented"],
        "classContextAvailable": coverage["class_context_available"],
        "missingSpecific": coverage["missing_specific"] + coverage["unmatched_missing"],
        "unmatchedNoContext": coverage["unmatched_missing"],
        "descriptionsPresent": total - coverage["missing_specific"] - coverage["unmatched_missing"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--supplements", type=Path, default=DEFAULT_SUPPLEMENTS)
    parser.add_argument("--output", type=Path, help="Write enriched manifest here.")
    parser.add_argument("--in-place", action="store_true", help="Replace --input after enrichment.")
    parser.add_argument("--audit", type=Path, help="Write exact coverage counts as JSON.")
    args = parser.parse_args()
    if args.in_place and args.output:
        parser.error("choose either --output or --in-place")
    if not args.in_place and not args.output:
        parser.error("pass --output or --in-place; the source manifest is not changed by default")

    with args.input.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    with args.supplements.open(encoding="utf-8") as handle:
        supplements = json.load(handle)
    audit = enrich(manifest, supplements)
    output = args.input if args.in_place else args.output
    assert output is not None
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    if args.audit:
        args.audit.parent.mkdir(parents=True, exist_ok=True)
        with args.audit.open("w", encoding="utf-8") as handle:
            json.dump(audit, handle, indent=2)
            handle.write("\n")
    print(json.dumps(audit, indent=2))


if __name__ == "__main__":
    main()
