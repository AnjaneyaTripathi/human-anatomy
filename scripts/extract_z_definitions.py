"""Write raw embedded Z-Anatomy definition texts for metadata enrichment only."""
import bpy
import json
import os

output = os.path.abspath(".source/definitions.json")
os.makedirs(os.path.dirname(output), exist_ok=True)
with open(output, "w", encoding="utf-8") as handle:
    json.dump({text.name: text.as_string() for text in bpy.data.texts}, handle, ensure_ascii=False)
print(output)
