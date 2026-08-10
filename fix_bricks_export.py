"""
Generate glTF-friendly brick image textures and re-export the theater GLB.
Avoids unreliable Cycles bake on multi-material meshes.
"""
import bpy
import struct
import zlib
from pathlib import Path

BLEND = Path(bpy.data.filepath)
OUT_DIR = BLEND.parent / "textures"
OUT_GLB = BLEND.with_suffix(".glb")
OUT_DIR.mkdir(exist_ok=True)

# Brick palette (approx sRGB 0-255) matching Blender Brick Texture colors
COLOR1 = (180, 72, 58)      # main brick
COLOR2 = (140, 48, 40)      # alt brick
MORTAR = (168, 162, 152)    # mortar


def write_png(path, width, height, rgb_bytes):
    """Write an RGB PNG without external deps."""
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter None
        raw.extend(rgb_bytes[y * stride : (y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def make_brick_texture(path, width=1024, height=1024, brick_w=72, brick_h=28, mortar=3):
    pixels = bytearray(width * height * 3)
    for y in range(height):
        row = y // (brick_h + mortar)
        local_y = y % (brick_h + mortar)
        offset = (brick_w // 2) if (row % 2) else 0
        for x in range(width):
            local_x = (x + offset) % (brick_w + mortar)
            i = (y * width + x) * 3
            if local_y >= brick_h or local_x >= brick_w:
                pixels[i:i+3] = bytes(MORTAR)
            else:
                # slight variation by cell
                cell = ((x + offset) // (brick_w + mortar)) + row * 17
                c = COLOR1 if (cell % 3) else COLOR2
                # micro noise
                n = ((x * 13 + y * 7) % 11) - 5
                pixels[i] = max(0, min(255, c[0] + n))
                pixels[i+1] = max(0, min(255, c[1] + n // 2))
                pixels[i+2] = max(0, min(255, c[2] + n // 2))
    write_png(path, width, height, pixels)
    return path


def ensure_uv(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    mesh.uv_layers.active = mesh.uv_layers[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.03)
    bpy.ops.object.mode_set(mode="OBJECT")


def scale_uvs(obj, scale=12.0):
    """Bake tiling into mesh UVs so glTF needs no Mapping node."""
    mesh = obj.data
    uv = mesh.uv_layers.active
    if not uv:
        return
    for loop in uv.data:
        loop.uv *= scale


def assign_image_material(mat, image):
    """Replace material graph with Principled + image texture."""
    mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (300, 0)
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.location = (0, 0)
    principled.inputs["Roughness"].default_value = 0.9
    principled.inputs["Metallic"].default_value = 0.0
    if "Emission Strength" in principled.inputs:
        principled.inputs["Emission Strength"].default_value = 0.0

    tex = nodes.new("ShaderNodeTexImage")
    tex.location = (-350, 0)
    tex.image = image
    tex.extension = "REPEAT"

    links.new(tex.outputs["Color"], principled.inputs["Base Color"])
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])


# Soften emissives for realtime
SOFT_EMISSION = {
    "Mat_Aisle_Light": 2.5,
    "Mat_Bollard": 3.0,
    "Mat_Lamp_Glow": 6.0,
    "Mat_Sign": 5.0,
    "Mat_Screen": 1.5,
    "Mat_Road_Line": 0.3,
}
for mat_name, strength in SOFT_EMISSION.items():
    mat = bpy.data.materials.get(mat_name)
    if not mat or not mat.node_tree:
        continue
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED" and "Emission Strength" in n.inputs:
            n.inputs["Emission Strength"].default_value = strength

tex_path = OUT_DIR / "brick_shared.png"
make_brick_texture(tex_path)
print("Wrote", tex_path)

# Load / reload image in Blender
img_name = "brick_shared"
if img_name in bpy.data.images:
    bpy.data.images.remove(bpy.data.images[img_name])
img = bpy.data.images.load(str(tex_path))
img.name = img_name
img.colorspace_settings.name = "sRGB"
img.pack()

for mat_name, obj_name in (("Mat_Brick_Front", "Wall_Front"), ("Mat_Brick_Out", "Wall_Shell")):
    mat = bpy.data.materials.get(mat_name)
    obj = bpy.data.objects.get(obj_name)
    if not mat or not obj:
        print("Missing", mat_name, obj_name)
        continue
    ensure_uv(obj)
    scale_uvs(obj, scale=14.0)
    assign_image_material(mat, img)
    print("Assigned brick texture to", mat_name)

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
print("Exported", OUT_GLB)
