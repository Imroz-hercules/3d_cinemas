"""
Re-export 3d_theater.glb after Blender edits (includes Soffit_Ring).

In Blender:
  1. File → Open → 3d_theater.blend  (save your work first!)
  2. Scripting workspace → Open this file → Run Script

Or from a terminal (if blender is on PATH):
  blender 3d_theater.blend --background --python export_theater.py

After export, hard-refresh the website (Ctrl+Shift+R).
"""
import bpy
from pathlib import Path

BLEND = Path(bpy.data.filepath)
if not BLEND.name:
    raise SystemExit("Save the .blend file first, then run this script again.")

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
    "Mat_Cove": 5.0,
}
for mat_name, strength in SOFT_EMISSION.items():
    mat = bpy.data.materials.get(mat_name)
    if not mat or not mat.node_tree:
        continue
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED" and "Emission Strength" in n.inputs:
            n.inputs["Emission Strength"].default_value = strength

# Ensure Soffit_Ring is visible and in the export
soffit = bpy.data.objects.get("Soffit_Ring")
if soffit:
    soffit.hide_set(False)
    soffit.hide_render = False
    soffit.hide_viewport = False
    print(f"OK  Soffit_Ring found  verts={len(soffit.data.vertices) if soffit.type == 'MESH' else '?'}")
else:
    print("WARN  Soffit_Ring NOT found — roof will use website fallback until you add/name it")

print("\nMesh objects:")
for obj in sorted(bpy.data.objects, key=lambda o: o.name):
    if obj.type != "MESH":
        continue
    mats = {s.material.name for s in obj.material_slots if s.material}
    flag = " ← ROOF" if "soffit" in obj.name.lower() or obj.name.lower().startswith("roof") else ""
    print(f"  {obj.name}  →  {', '.join(sorted(mats)) or '(no mat)'}{flag}")

# Prefer dark matte for soffit if it has no material
if soffit and soffit.type == "MESH" and not any(s.material for s in soffit.material_slots):
    mat = bpy.data.materials.get("Mat_Soffit")
    if not mat:
        mat = bpy.data.materials.new("Mat_Soffit")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.04, 0.04, 0.05, 1)
            bsdf.inputs["Roughness"].default_value = 0.92
    if soffit.data.materials:
        soffit.data.materials[0] = mat
    else:
        soffit.data.materials.append(mat)
    print("Assigned Mat_Soffit to Soffit_Ring")

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
print(f"\nExported → {OUT_GLB}")
print("Hard-refresh the website (Ctrl+Shift+R). Console should log: soffitRing: true")
