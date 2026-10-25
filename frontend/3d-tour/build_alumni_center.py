
from __future__ import annotations

import json
import math
import struct
from pathlib import Path


OUT = Path(__file__).resolve().parents[1] / "public" / "3d-tour"
OUT.mkdir(parents=True, exist_ok=True)

materials = {
    "stucco": ([0.79, 0.76, 0.69, 1.0], 0.86, 0.0),
    "interior": ([0.91, 0.89, 0.83, 1.0], 0.92, 0.0),
    "floor": ([0.46, 0.34, 0.23, 1.0], 0.7, 0.0),
    "roof": ([0.24, 0.25, 0.27, 1.0], 0.82, 0.0),
    "frame": ([0.08, 0.09, 0.10, 1.0], 0.35, 0.7),
    "glass": ([0.24, 0.48, 0.62, 0.34], 0.12, 0.15),
    "steel": ([0.38, 0.41, 0.43, 1.0], 0.28, 0.82),
    "concrete": ([0.58, 0.57, 0.54, 1.0], 0.95, 0.0),
    "accent": ([0.08, 0.27, 0.57, 1.0], 0.45, 0.0),
    "cyan": ([0.18, 0.76, 0.92, 1.0], 0.38, 0.0),
    "white": ([0.94, 0.95, 0.93, 1.0], 0.72, 0.0),
    "wood": ([0.48, 0.25, 0.10, 1.0], 0.66, 0.0),
    "screen": ([0.025, 0.07, 0.12, 1.0], 0.18, 0.18),
    "warm": ([1.0, 0.58, 0.14, 1.0], 0.40, 0.0),
    "red": ([0.66, 0.08, 0.10, 1.0], 0.52, 0.0),
    "landscape": ([0.18, 0.34, 0.18, 1.0], 1.0, 0.0),
    "plant": ([0.10, 0.44, 0.20, 1.0], 0.96, 0.0),
    "path": ([0.53, 0.49, 0.43, 1.0], 1.0, 0.0),
}

meshes = {name: {"p": [], "n": [], "i": []} for name in materials}


def quad(mat, points, normal):
    m = meshes[mat]
    start = len(m["p"]) // 3
    for p in points:
        m["p"].extend(p)
        m["n"].extend(normal)
    m["i"].extend([start, start + 1, start + 2, start, start + 2, start + 3])


def box(mat, cx, cz, sx, sz, y0, y1, angle=0.0):
    ca, sa = math.cos(angle), math.sin(angle)

    def pt(x, y, z):
        return (cx + x * ca - z * sa, y, cz + x * sa + z * ca)

    x, z = sx / 2, sz / 2
    a, b, c, d = pt(-x, y0, -z), pt(x, y0, -z), pt(x, y0, z), pt(-x, y0, z)
    e, f, g, h = pt(-x, y1, -z), pt(x, y1, -z), pt(x, y1, z), pt(-x, y1, z)

    def rot_n(nx, nz):
        return (nx * ca - nz * sa, 0, nx * sa + nz * ca)

    quad(mat, [a, d, c, b], (0, -1, 0))
    quad(mat, [e, f, g, h], (0, 1, 0))
    quad(mat, [a, b, f, e], rot_n(0, -1))
    quad(mat, [b, c, g, f], rot_n(1, 0))
    quad(mat, [c, d, h, g], rot_n(0, 1))
    quad(mat, [d, a, e, h], rot_n(-1, 0))


def wall(mat, x1, z1, x2, z2, y0, y1, thickness=0.24):
    dx, dz = x2 - x1, z2 - z1
    box(mat, (x1+x2)/2, (z1+z2)/2, math.hypot(dx, dz), thickness,
        y0, y1, math.atan2(dz, dx))


def frame_window(x1, z1, x2, z2, y0, y1, outward=0.0):
    wall("glass", x1, z1, x2, z2, y0, y1, 0.06)
    wall("frame", x1, z1, x2, z2, y0-0.06, y0+0.06, 0.10)
    wall("frame", x1, z1, x2, z2, y1-0.06, y1+0.06, 0.10)
    length = math.hypot(x2-x1, z2-z1)
    count = max(1, round(length/2.2))
    for k in range(count+1):
        t = k/count
        x, z = x1+(x2-x1)*t, z1+(z2-z1)*t
        box("frame", x, z, 0.08, 0.10, y0, y1, outward)
box("landscape", 1.5, -1.5, 46, 43, -0.18, -0.08)
box("path", -9, -11, 7, 18, -0.07, 0.0)
box("concrete", 10.7, -14.6, 16.4, 10.5, -0.03, 0.10)
box("concrete", 20.6, 3.0, 7.2, 17.0, -0.03, 0.10)
box("concrete", 8.1, 12.8, 16.0, 7.0, -0.03, 0.10)
for cx, cz, sx, sz in [(-8.0, -1.0, 12.0, 11.5), (0.5, 2.2, 12.0, 13.0),
                       (10.5, 3.0, 11.0, 13.0), (2.0, -8.2, 10.0, 8.5)]:
    box("floor", cx, cz, sx, sz, 0.10, 0.28)
perim1 = [
    (-14,-6.8), (-14,4.7), (-6.8,4.7), (-6.8,8.7), (4.8,8.7),
    (4.8,9.5), (16.0,9.5), (16.0,-3.5), (7.0,-3.5),
    (7.0,-12.5), (-3.0,-12.5), (-3.0,-6.8), (-14,-6.8)
]
for a, b in zip(perim1, perim1[1:]):
    wall("stucco", *a, *b, 0.28, 3.85, 0.28)
for x1,z1,x2,z2 in [(-6.8,-6.8,-6.8,4.7), (-3.0,-3.5,7.0,-3.5),
                    (4.8,-3.5,4.8,8.7), (8.1,-3.5,8.1,5.7),
                    (-1.5,-0.8,3.8,-0.8), (3.8,-0.8,3.8,-3.5)]:
    wall("interior", x1,z1,x2,z2, 0.28, 3.55, 0.18)
frame_window(-12.8,-6.65,-7.4,-6.65,0.35,3.35)
frame_window(-5.8,8.55,3.8,8.55,0.8,3.35)
frame_window(15.85,0.0,15.85,8.5,0.7,3.35)
box("frame", -10.1, -7.4, 6.2, 1.5, 3.10, 3.28)
box("accent", -12.15, -6.9, 2.6, 0.12, 2.20, 3.15)
for i in range(13):
    y0 = 0.10 + i * 0.30
    zc = -3.2 + i * 0.43
    box("concrete", 17.4, zc, 2.8, 0.46, y0, y0 + 0.18)
wall("steel", 16.0,-3.4,16.0,2.4,0.55,4.55,0.08)
wall("steel", 18.8,-3.4,18.8,2.4,0.55,4.55,0.08)
for cx, cz, sx, sz in [(-6.0,-5.6,9.2,8.0), (0.8,0.0,12.3,10.5),
                       (8.4,7.0,11.0,9.2)]:
    box("floor", cx, cz, sx, sz, 4.02, 4.22)

perim2 = [
    (-10.6,-9.6), (-10.6,-1.6), (-5.4,-1.6), (-5.4,5.25), (2.9,5.25),
    (2.9,11.6), (13.9,11.6), (13.9,2.4), (6.95,2.4),
    (6.95,-5.25), (-1.4,-5.25), (-1.4,-9.6), (-10.6,-9.6)
]
for a, b in zip(perim2, perim2[1:]):
    wall("stucco", *a, *b, 4.22, 7.72, 0.25)
wall("interior", 2.9,2.4,2.9,11.6,4.22,7.45,0.18)
wall("interior", -5.4,-1.6,6.95,-1.6,4.22,7.45,0.18)
frame_window(3.2,11.45,13.1,11.45,4.75,7.25)
frame_window(13.75,3.0,13.75,10.8,4.75,7.25)
frame_window(-10.45,-9.0,-10.45,-2.2,4.75,7.25)
for cx, cz, sx, sz in [(-6.0,-5.6,9.5,8.3), (0.8,0.0,12.6,10.8),
                       (8.4,7.0,11.3,9.5)]:
    box("roof", cx, cz, sx, sz, 7.72, 7.94)
for x in [4.2,8.2,12.2,16.2]:
    box("steel", x, -14.8, 0.10, 8.2, 0.10, 1.05)
wall("steel", 2.5,-10.7,18.9,-10.7,0.95,1.05,0.08)
wall("steel", 2.5,-18.7,18.9,-18.7,0.95,1.05,0.08)
for cx, cz in [(7,-14.5),(12,-14.5),(20.5,2.5),(20.5,7.0)]:
    box("concrete", cx, cz, 1.7, 0.8, 0.45, 0.53)
    box("steel", cx, cz, 0.10, 0.10, 0.10, 0.10, 0.45)
for cx, cz, sx, sz in [(-8.0, -1.0, 12.0, 11.5), (0.5, 2.2, 12.0, 13.0),
                       (10.5, 3.0, 11.0, 13.0), (2.0, -8.2, 10.0, 8.5)]:
    box("interior", cx, cz, sx, sz, 3.76, 3.94)
def event_table(cx, cz, sx=2.2, sz=0.8, height=0.82, top="accent", y_base=0.12):
    box(top, cx, cz, sx, sz, height-0.10, height)
    for dx in (-sx*.38, sx*.38):
        for dz in (-sz*.32, sz*.32):
            box("steel", cx+dx, cz+dz, 0.09, 0.09, y_base, height-0.10)


def chair(cx, cz, angle=0.0):
    box("frame", cx, cz, 0.45, 0.45, 0.40, 0.48, angle)
    box("frame", cx, cz+0.18, 0.45, 0.08, 0.48, 0.95, angle)


def laptop(cx, cz, angle=0.0, y=0.83):
    box("frame", cx, cz, 0.46, 0.34, y, y+0.035, angle)
    ca, sa = math.cos(angle), math.sin(angle)
    sx, sz = cx - 0.14 * sa, cz + 0.14 * ca
    box("screen", sx, sz, 0.46, 0.035, y+0.03, y+0.37, angle)


def monitor(cx, cz, angle=0.0, y=0.88):
    box("steel", cx, cz, 0.08, 0.08, y, y+0.45, angle)
    box("screen", cx, cz, 0.82, 0.08, y+0.40, y+0.92, angle)
    box("cyan", cx, cz-0.046, 0.66, 0.015, y+0.48, y+0.80, angle)


def planter(cx, cz, y=0.1):
    box("concrete", cx, cz, 0.72, 0.72, y, y+0.55)
    box("plant", cx, cz, 0.48, 0.48, y+0.55, y+1.20)


def stanchion(cx, cz):
    box("steel", cx, cz, 0.10, 0.10, 0.12, 1.05)
    box("frame", cx, cz, 0.32, 0.32, 0.10, 0.17)
box("accent", -10.0, -5.7, 4.7, 1.35, 0.285, 0.315)
for cx in (-11.2, -8.8):
    event_table(cx, -4.7, 2.05, 0.85, 1.0, "accent")
    box("cyan", cx, -5.14, 1.35, 0.08, 1.08, 1.48)
    monitor(cx, -4.62, math.pi, 1.02)
for cx, cz in [(-11.4,-6.1),(-8.6,-6.1),(-11.4,-5.35),(-8.6,-5.35)]:
    stanchion(cx, cz)
wall("cyan", -11.4,-5.35,-8.6,-5.35,0.88,0.94,0.055)
planter(-12.6, -4.8)
box("accent", -3.7, 2.3, 0.55, 9.7, 0.285, 0.31, -0.36)
booth_colors = ["accent", "cyan", "red", "warm", "accent"]
for i, (cx, cz) in enumerate([(-5.8,3.4),(-5.8,1.6),(-5.8,-.2),(-3.8,5.5),(-1.4,5.5)]):
    color = booth_colors[i]
    event_table(cx, cz, 1.6, 0.62, 0.82, "white")
    box(color, cx, cz+0.36, 1.7, 0.10, 0.88, 2.35)
    box("white", cx, cz+0.29, 1.25, 0.04, 1.72, 2.12)
    monitor(cx, cz-0.05, 0.0, 0.84)
    box("frame", cx, cz+0.40, 1.9, 0.08, 2.35, 2.50)
box("warm", 9.9, 8.40, 8.1, 0.12, 2.05, 2.42)
for cx in (7.2, 9.9, 12.6):
    event_table(cx, 7.8, 2.1, 0.9, 0.92, "white")
    box("warm", cx, 8.28, 1.45, 0.08, 1.0, 1.55)
    for dx in (-0.52, 0, 0.52):
        box("steel", cx+dx, 7.72, 0.38, 0.44, 0.94, 1.02)
box("steel", 14.1, 7.8, 1.0, 0.95, 0.28, 1.85)
box("cyan", 14.1, 7.28, 0.72, 0.06, 1.05, 1.62)
for cx in (7.5, 10.2, 12.9):
    box("wood", cx, 6.25, 1.05, 1.05, 1.02, 1.12)
    box("steel", cx, 6.25, 0.12, 0.12, 0.28, 1.02)
for cz in (-1.4, 1.1, 3.6, 6.0):
    event_table(11.2, cz, 5.2, 0.95, 0.78, "white")
    for cx in (9.4, 11.2, 13.0):
        chair(cx, cz-0.78)
        chair(cx, cz+0.78, math.pi)
        laptop(cx, cz-0.23, 0.0)
        laptop(cx, cz+0.23, math.pi)
    box("accent", 11.2, cz, 1.05, 0.20, 0.80, 0.87)
box("screen", 15.68, 2.8, 0.08, 3.4, 1.15, 2.85)
box("cyan", 15.63, 2.8, 0.02, 2.85, 1.40, 2.58)
for cz in (-10.2, -7.9, -5.7):
    event_table(2.0, cz, 5.7, 0.88, 0.78, "wood")
    for cx in (-0.1, 2.0, 4.1):
        chair(cx, cz-0.72)
        chair(cx, cz+0.72, math.pi)
        laptop(cx, cz-0.20, 0.0)
        laptop(cx, cz+0.20, math.pi)
box("white", 6.82, -8.1, 0.08, 3.5, 1.0, 2.75)
for x in (5.0, 5.7):
    box("accent", x, -11.5, 0.55, 1.35, 0.34, 0.72)
box("accent", 0.2, -0.94, 0.9, 0.08, 1.45, 2.35)
box("accent", 2.6, -0.94, 0.9, 0.08, 1.45, 2.35)
for x in (0.15, 1.35, 2.55):
    box("white", x, -2.75, 0.95, 1.35, 0.28, 2.25)
for x in (0.4, 1.7, 3.0):
    box("white", x, -1.30, 0.78, 0.42, 0.70, 0.88)
    box("glass", x, -1.53, 0.72, 0.04, 1.12, 2.05)
box("wood", 2.0, 4.45, 5.9, 1.25, 4.22, 4.42)
box("screen", 2.0, 5.10, 4.5, 0.08, 5.05, 7.10)
box("cyan", 2.0, 5.04, 3.95, 0.02, 5.32, 6.82)
box("accent", -0.25, 4.35, 0.85, 0.65, 4.42, 5.62)
for cz in (-3.6, -1.0, 1.6, 4.0):
    event_table(-0.8, cz, 5.5, 0.95, 4.95, "white", 4.22)
    for cx in (-2.8, -0.8, 1.2):
        box("frame", cx, cz-0.75, 0.45, 0.45, 4.52, 4.62)
        box("frame", cx, cz+0.75, 0.45, 0.45, 4.52, 4.62)
        laptop(cx, cz-0.18, 0.0, 5.0)
for cx, cz in [(5.4,5.0),(8.1,5.0),(10.8,5.0),(6.8,8.0),(9.6,8.0),(12.0,9.6)]:
    box("wood", cx, cz, 1.15, 1.15, 5.52, 5.62)
    box("steel", cx, cz, 0.12, 0.12, 4.25, 5.52)
for cx, cz, sx, sz in [(5.1,10.2,2.8,.72),(9.0,10.2,2.8,.72),(12.7,6.4,.72,2.8)]:
    box("accent", cx, cz, sx, sz, 4.58, 4.96)
    box("frame", cx, cz, sx, sz, 4.25, 4.58)
for cx, cz in [(4.0,3.6),(13.0,3.7),(4.1,10.5),(13.0,10.5)]:
    planter(cx, cz, 4.22)
for z in (4.1, 7.1, 10.1):
    wall("warm", 3.6,z,13.2,z,7.05,7.12,0.035)
for cx, cz in [(20.5,0.2),(20.5,4.0),(20.5,7.6),(6.0,-14.6),(10.7,-14.6),(15.2,-14.6)]:
    event_table(cx, cz, 3.2, 0.9, 0.82, "wood")
    laptop(cx-0.75, cz, 0.0)
    laptop(cx+0.75, cz, math.pi)
for cx, cz in [(18.0,-3.0),(23.0,-3.0),(18.0,10.0),(23.0,10.0),(3.2,-18.1),(18.1,-18.1)]:
    planter(cx, cz)
for cx, cz in [(20.5,2.0),(10.7,-14.6)]:
    box("steel", cx, cz, 0.12, 0.12, 0.10, 2.75)
    box("cyan", cx, cz, 5.2, 3.1, 2.68, 2.78)


def pack_f32(values):
    return struct.pack("<" + "f" * len(values), *values)


def pack_u32(values):
    return struct.pack("<" + "I" * len(values), *values)


def align4(data):
    return data + b"\0" * ((-len(data)) % 4)


buffer = bytearray()
buffer_views, accessors, gltf_meshes, nodes = [], [], [], []
mat_names = list(materials)
gltf_materials = []
for name in mat_names:
    color, rough, metal = materials[name]
    item = {
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": color,
            "roughnessFactor": rough,
            "metallicFactor": metal
        },
        "doubleSided": name == "glass",
    }
    if color[3] < 1:
        item.update({"alphaMode": "BLEND", "alphaCutoff": 0.01})
    gltf_materials.append(item)

for mi, name in enumerate(mat_names):
    m = meshes[name]
    if not m["i"]:
        continue
    attrs = {}
    for semantic, values, ctype, typ, packer in [
        ("POSITION", m["p"], 5126, "VEC3", pack_f32),
        ("NORMAL", m["n"], 5126, "VEC3", pack_f32),
        ("INDICES", m["i"], 5125, "SCALAR", pack_u32),
    ]:
        offset = len(buffer)
        raw = packer(values)
        buffer.extend(raw)
        buffer.extend(b"\0" * ((-len(buffer)) % 4))
        view_idx = len(buffer_views)
        target = 34963 if semantic == "INDICES" else 34962
        buffer_views.append({
            "buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target
        })
        acc = {
            "bufferView": view_idx, "componentType": ctype,
            "count": len(values) if typ == "SCALAR" else len(values)//3, "type": typ
        }
        if semantic == "POSITION":
            xyz = list(zip(values[0::3], values[1::3], values[2::3]))
            acc["min"] = [min(v[k] for v in xyz) for k in range(3)]
            acc["max"] = [max(v[k] for v in xyz) for k in range(3)]
        acc_idx = len(accessors)
        accessors.append(acc)
        if semantic != "INDICES":
            attrs[semantic] = acc_idx
        else:
            index_acc = acc_idx
    mesh_idx = len(gltf_meshes)
    gltf_meshes.append({
        "name": name,
        "primitives": [{"attributes": attrs, "indices": index_acc, "material": mi}]
    })
    nodes.append({"name": name, "mesh": mesh_idx})

gltf = {
    "asset": {"version": "2.0", "generator": "Codex concept-model generator"},
    "scene": 0,
    "scenes": [{"nodes": list(range(len(nodes)))}],
    "nodes": nodes,
    "meshes": gltf_meshes,
    "materials": gltf_materials,
    "buffers": [{"byteLength": len(buffer)}],
    "bufferViews": buffer_views,
    "accessors": accessors,
}

json_chunk = align4(json.dumps(gltf, separators=(",", ":")).encode("utf-8")).replace(b"\0", b" ")
bin_chunk = align4(bytes(buffer))
total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
glb = (
    struct.pack("<4sII", b"glTF", 2, total)
    + struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
    + struct.pack("<I4s", len(bin_chunk), b"BIN\0") + bin_chunk
)

glb_path = OUT / "james-west-alumni-center-concept.glb"
glb_path.write_bytes(glb)

print(glb_path)
