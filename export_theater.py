"""
Re-export 3d_theater.glb after Blender edits.
Run inside Blender: File → Open → 3d_theater.blend, then Scripting → Run Script.

Or from a terminal (if `blender` is on PATH):
  blender 3d_theater.blend --background --python export_theater.py
"""
import bpy
from pathlib import Path

BLEND = Path(bpy.data.filepath)
OUT_GLB = BLEND.with_suffix(".glb")

# Soft emissive strengths for web (realtime)
SOFT_EMISSION = {
    "Mat_Aisle_Light": 2.5,
    "Mat_Bollard": 3.0,
    "Mat_Lamp_Glow": 6.0,
    "Mat_Sign": 5.0,
    "Mat_Screen": 1.5,
    "Mat_Road_Line": 0.3,
    "Mat_Exit": 4.0,
    "Mat_Exit_Sign": 4.0,
    "Mat_Emergency": 3.5,
    "Mat_Aisle_LED": 2.0,
}
for mat_name, strength in SOFT_EMISSION.items():
    mat = bpy.data.materials.get(mat_name)
    if not mat or not mat.node_tree:
        continue
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED" and "Emission Strength" in n.inputs:
            n.inputs["Emission Strength"].default_value = strength

print("Objects in scene:")
for obj in sorted(bpy.data.objects, key=lambda o: o.name):
    if obj.type == "MESH":
        mats = {s.material.name for s in obj.material_slots if s.material}
        print(f"  {obj.name}  →  {', '.join(sorted(mats)) or '(no mat)'}")

print("\nTip: name roof meshes Roof_Back, Roof_Left, Roof_Right, Roof_Front_L, Roof_Front_R")
print("     and cove strips Cove_Back, Cove_Left, Cove_Right, Cove_Front_L, Cove_Front_R")
print("     with Mat_Roof (black) and Mat_Cove (white emissive) for web auto-tuning.")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=str(OUT_GLB),
    export_format="GLB",
    use_selection=False,
    export_apply=True,
    export_animations=True,
    export_lights=False,
    export_cameras=False,
    export_image_format="AUTO",
)
print(f"Exported {OUT_GLB}")
