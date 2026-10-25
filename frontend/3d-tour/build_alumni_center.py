#!/usr/bin/env python3
"""Generate a person-free concept model of the James West Alumni Center.

The supplied event maps are not dimensioned architectural drawings. Geometry is
therefore proportioned from the maps and uses explicit, easy-to-edit assumptions.
"""

from __future__ import annotations

import base64
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
    """Axis-aligned or rotated rectangular prism, Y up."""
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


# Site, paving, and patios.
box("landscape", 1.5, -1.5, 46, 43, -0.18, -0.08)
box("path", -9, -11, 7, 18, -0.07, 0.0)
box("concrete", 10.7, -14.6, 16.4, 10.5, -0.03, 0.10)
box("concrete", 20.6, 3.0, 7.2, 17.0, -0.03, 0.10)
box("concrete", 8.1, 12.8, 16.0, 7.0, -0.03, 0.10)

# First-floor slabs: entrance/gallery, central hall, Collins room, Founders room.
for cx, cz, sx, sz in [(-8.0, -1.0, 12.0, 11.5), (0.5, 2.2, 12.0, 13.0),
                       (10.5, 3.0, 11.0, 13.0), (2.0, -8.2, 10.0, 8.5)]:
    box("floor", cx, cz, sx, sz, 0.10, 0.28)

# Main first-floor perimeter, composed to reflect the event map's stepped outline.
perim1 = [
    (-14,-6.8), (-14,4.7), (-6.8,4.7), (-6.8,8.7), (4.8,8.7),
    (4.8,9.5), (16.0,9.5), (16.0,-3.5), (7.0,-3.5),
    (7.0,-12.5), (-3.0,-12.5), (-3.0,-6.8), (-14,-6.8)
]
for a, b in zip(perim1, perim1[1:]):
    wall("stucco", *a, *b, 0.28, 3.85, 0.28)

# Interior partitions and restroom core.
for x1,z1,x2,z2 in [(-6.8,-6.8,-6.8,4.7), (-3.0,-3.5,7.0,-3.5),
                    (4.8,-3.5,4.8,8.7), (8.1,-3.5,8.1,5.7),
                    (-1.5,-0.8,3.8,-0.8), (3.8,-0.8,3.8,-3.5)]:
    wall("interior", x1,z1,x2,z2, 0.28, 3.55, 0.18)

# Glass entrance and north/east glazing inspired by the recording.
frame_window(-12.8,-6.65,-7.4,-6.65,0.35,3.35)
frame_window(-5.8,8.55,3.8,8.55,0.8,3.35)
frame_window(15.85,0.0,15.85,8.5,0.7,3.35)

# Entry canopy and UCLA-blue sign panel.
box("frame", -10.1, -7.4, 6.2, 1.5, 3.10, 3.28)
box("accent", -12.15, -6.9, 2.6, 0.12, 2.20, 3.15)

# Exterior stair to second floor, east side.
for i in range(13):
    y0 = 0.10 + i * 0.30
    zc = -3.2 + i * 0.43
    box("concrete", 17.4, zc, 2.8, 0.46, y0, y0 + 0.18)
wall("steel", 16.0,-3.4,16.0,2.4,0.55,4.55,0.08)
wall("steel", 18.8,-3.4,18.8,2.4,0.55,4.55,0.08)

# Second-floor slabs based on three connected areas shown in the second plan.
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

# Second-floor partitions and glazing.
wall("interior", 2.9,2.4,2.9,11.6,4.22,7.45,0.18)
wall("interior", -5.4,-1.6,6.95,-1.6,4.22,7.45,0.18)
frame_window(3.2,11.45,13.1,11.45,4.75,7.25)
frame_window(13.75,3.0,13.75,10.8,4.75,7.25)
frame_window(-10.45,-9.0,-10.45,-2.2,4.75,7.25)

# Flat roof plates.
for cx, cz, sx, sz in [(-6.0,-5.6,9.5,8.3), (0.8,0.0,12.6,10.8),
                       (8.4,7.0,11.3,9.5)]:
    box("roof", cx, cz, sx, sz, 7.72, 7.94)

# Patio rails and scale-neutral furnishings.
for x in [4.2,8.2,12.2,16.2]:
    box("steel", x, -14.8, 0.10, 8.2, 0.10, 1.05)
wall("steel", 2.5,-10.7,18.9,-10.7,0.95,1.05,0.08)
wall("steel", 2.5,-18.7,18.9,-18.7,0.95,1.05,0.08)
for cx, cz in [(7,-14.5),(12,-14.5),(20.5,2.5),(20.5,7.0)]:
    box("concrete", cx, cz, 1.7, 0.8, 0.45, 0.53)
    box("steel", cx, cz, 0.10, 0.10, 0.10, 0.10, 0.45)

# Interior ceilings make the first-person experience read as enclosed rooms.
for cx, cz, sx, sz in [(-8.0, -1.0, 12.0, 11.5), (0.5, 2.2, 12.0, 13.0),
                       (10.5, 3.0, 11.0, 13.0), (2.0, -8.2, 10.0, 8.5)]:
    box("interior", cx, cz, sx, sz, 3.76, 3.94)

# Event setup from the supplied sketch: check-in, sponsor booths, food, hacking,
# workshops and networking furniture. These are deliberately person-free.
def event_table(cx, cz, sx=2.2, sz=0.8, height=0.82, top="accent", y_base=0.12):
    box(top, cx, cz, sx, sz, height-0.10, height)
    for dx in (-sx*.38, sx*.38):
        for dz in (-sz*.32, sz*.32):
            box("steel", cx+dx, cz+dz, 0.09, 0.09, y_base, height-0.10)


def chair(cx, cz, angle=0.0):
    box("frame", cx, cz, 0.45, 0.45, 0.40, 0.48, angle)
    box("frame", cx, cz+0.18, 0.45, 0.08, 0.48, 0.95, angle)


def laptop(cx, cz, angle=0.0, y=0.83):
    """Small open laptop silhouette for hacking and workshop tables."""
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


# Entrance & check-in: welcome carpet, staffed-style counters, information
# screens, and an empty queue system (no people).
box("accent", -10.0, -5.7, 4.7, 1.35, 0.285, 0.315)
for cx in (-11.2, -8.8):
    event_table(cx, -4.7, 2.05, 0.85, 1.0, "accent")
    box("cyan", cx, -5.14, 1.35, 0.08, 1.08, 1.48)
    monitor(cx, -4.62, math.pi, 1.02)
for cx, cz in [(-11.4,-6.1),(-8.6,-6.1),(-11.4,-5.35),(-8.6,-5.35)]:
    stanchion(cx, cz)
wall("cyan", -11.4,-5.35,-8.6,-5.35,0.88,0.94,0.055)
planter(-12.6, -4.8)

# Sponsor Galleria: individual branded booths, demo monitors, counters, and
# a blue route through the gallery matching the sketch's sponsor corridor.
box("accent", -3.7, 2.3, 0.55, 9.7, 0.285, 0.31, -0.36)
booth_colors = ["accent", "cyan", "red", "warm", "accent"]
for i, (cx, cz) in enumerate([(-5.8,3.4),(-5.8,1.6),(-5.8,-.2),(-3.8,5.5),(-1.4,5.5)]):
    color = booth_colors[i]
    event_table(cx, cz, 1.6, 0.62, 0.82, "white")
    box(color, cx, cz+0.36, 1.7, 0.10, 0.88, 2.35)
    box("white", cx, cz+0.29, 1.25, 0.04, 1.72, 2.12)
    monitor(cx, cz-0.05, 0.0, 0.84)
    box("frame", cx, cz+0.40, 1.9, 0.08, 2.35, 2.50)

# Food service row: buffet counters, warming trays, overhead menu band,
# beverage station, and standing café tables.
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

# Collins Room hacking tables and chairs.
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

# Founders' Room hacking setup.
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

# Restrooms: clear wayfinding, privacy partitions, sinks and mirrors.
box("accent", 0.2, -0.94, 0.9, 0.08, 1.45, 2.35)
box("accent", 2.6, -0.94, 0.9, 0.08, 1.45, 2.35)
for x in (0.15, 1.35, 2.55):
    box("white", x, -2.75, 0.95, 1.35, 0.28, 2.25)
for x in (0.4, 1.7, 3.0):
    box("white", x, -1.30, 0.78, 0.42, 0.70, 0.88)
    box("glass", x, -1.53, 0.72, 0.04, 1.12, 2.05)

# Second-floor workshop classroom: presenter stage, screen, podium, and
# laptop-equipped learning tables arranged toward the teaching wall.
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

# Northeast networking patio: cocktail tables, lounge benches, planters, and
# a warm overhead light canopy that makes the social role obvious.
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

# First-floor patios: outdoor hacking tables, shade frames, and planting.
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

encoded = base64.b64encode(glb).decode("ascii")
html = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>James West Alumni Center — Interactive Tour</title>
<style>
:root{--blue:#173f7a;--cyan:#60d9f7;--ink:#10233d;--paper:#f7f4ed}
*{box-sizing:border-box}html,body,#view{margin:0;width:100%;height:100%;overflow:hidden;font:14px Inter,ui-sans-serif,system-ui;color:var(--ink)}
body{background:#dce6ef}canvas{display:block}
.topbar{position:fixed;inset:18px 18px auto 18px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;pointer-events:none}
.brand,.actions,.places,.hud{pointer-events:auto}
.brand{background:#fffef9ee;padding:14px 17px;border:1px solid #fff;border-radius:14px;box-shadow:0 9px 32px #152d4a24;backdrop-filter:blur(14px)}
.brand h1{font-size:18px;letter-spacing:-.02em;margin:0}.brand p{font-size:12px;margin:4px 0 0;color:#536173}
.actions{display:flex;gap:8px}.button,select{border:0;border-radius:11px;padding:11px 14px;background:#fffef5;color:var(--ink);font-weight:700;box-shadow:0 7px 24px #142b4822;cursor:pointer}
.button.primary{background:var(--blue);color:white}.button:hover{transform:translateY(-1px)}
.places{position:fixed;right:18px;top:78px;width:245px;background:#fffef9eb;border:1px solid #fff;padding:12px;border-radius:14px;box-shadow:0 9px 32px #152d4a22;backdrop-filter:blur(14px)}
.places h2{font-size:11px;text-transform:uppercase;letter-spacing:.14em;margin:2px 4px 8px;color:#657489}
.place{width:100%;text-align:left;border:0;border-radius:9px;background:transparent;padding:8px 9px;color:#263850;cursor:pointer}.place:hover{background:#eaf5fa}.place small{display:block;color:#718093;margin-top:2px}
#labels{position:fixed;inset:0;pointer-events:none}.tag{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;border:1px solid #fff;background:#173f7ae8;color:white;border-radius:8px;padding:7px 10px;font-size:12px;font-weight:750;box-shadow:0 6px 18px #0a1e3850;cursor:pointer;white-space:nowrap}.tag:after{content:"";position:absolute;left:50%;top:100%;height:12px;border-left:2px solid #173f7acc}.tag:hover{background:#0e2c59}
.hud{display:none;position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#0f2138dd;color:#fff;padding:11px 15px;border-radius:12px;box-shadow:0 8px 28px #0005;text-align:center;backdrop-filter:blur(10px)}
.hud b{color:#85e5fa}.hud .role{display:inline-block;max-width:520px;margin-top:3px;font-size:12px;color:#dce8f5}.crosshair{display:none;position:fixed;left:50%;top:50%;width:12px;height:12px;margin:-6px}.crosshair:before,.crosshair:after{content:"";position:absolute;background:#fff;box-shadow:0 0 2px #000}.crosshair:before{width:12px;height:2px;top:5px}.crosshair:after{height:12px;width:2px;left:5px}
.welcome{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:linear-gradient(135deg,#0d2440e8,#173f7ad9);padding:24px;backdrop-filter:blur(8px)}.welcome-card{max-width:540px;background:#fffef7;padding:30px;border-radius:22px;box-shadow:0 24px 80px #06162a88;text-align:center}.welcome .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#55718f;font-weight:800}.welcome h2{font-size:30px;line-height:1.05;margin:10px 0}.welcome p{color:#5a6674;line-height:1.55}.welcome .button{font-size:16px;padding:14px 20px;margin-top:10px}.welcome-note{font-size:11px}
.dpad{display:none;position:fixed;z-index:10;left:18px;bottom:18px;grid-template-columns:46px 46px 46px;grid-template-rows:42px 42px;gap:5px;pointer-events:auto}.dpad button{border:1px solid #ffffff88;background:#102b4fd9;color:white;border-radius:10px;font-size:20px;box-shadow:0 5px 18px #0018;touch-action:none;user-select:none}.dpad button:active,.dpad button.active{background:#60d9f7;color:#0b2746}.dpad .up{grid-column:2}.dpad .left{grid-column:1}.dpad .down{grid-column:2}.dpad .right{grid-column:3}
body.immersive .places,body.immersive #labels{display:none}body.immersive .hud,body.immersive .crosshair{display:block}body.immersive .dpad{display:grid}body.immersive .brand{opacity:.16;transition:opacity .2s}body.immersive .brand:hover{opacity:1}
@media(max-width:760px){.places{display:none}.brand p{display:none}.actions{flex-direction:column}.button{padding:9px 11px}.tag{font-size:10px;padding:5px 7px}.hud{bottom:118px}}
</style></head><body>
<div id="view"></div><div id="labels"></div>
<div class="welcome" id="welcome"><div class="welcome-card"><div class="eyebrow">Interior 3D event tour</div><h2>Step inside the<br>James West Alumni Center</h2><p>Walk through the decorated event layout—from check-in and sponsor booths to hacking rooms, food, workshops, and networking areas.</p><button class="button primary" id="startTour">Enter the building</button><p class="welcome-note">No people are included · geometry is an approximate interpretation of the supplied sketch</p></div></div>
<header class="topbar"><div class="brand"><h1>James West Alumni Center</h1><p>Interactive two-floor concept · approximate geometry</p></div>
<div class="actions"><select id="jump" aria-label="Jump to a place"><option value="">Jump to a place…</option></select><button class="button" id="exterior">Exterior view</button><button class="button primary" id="immerse">Start walking</button></div></header>
<aside class="places"><h2>Explore places</h2><div id="placeList"></div></aside>
<div class="dpad" aria-label="Movement controls"><button class="up" data-key="ArrowUp" aria-label="Move forward">↑</button><button class="left" data-key="ArrowLeft" aria-label="Turn left">←</button><button class="down" data-key="ArrowDown" aria-label="Move backward">↓</button><button class="right" data-key="ArrowRight" aria-label="Turn right">→</button></div>
<div class="crosshair"></div><div class="hud"><b id="zone">Entrance & Check-in</b><br><span class="role" id="zoneRole">Welcome desks, information screens and queueing</span><br><span id="walkHint">WASD / arrows to walk · mouse to look · Shift to move faster · Esc releases mouse</span></div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const rooms=[
 {name:"Entrance & Check-in",floor:"First floor",role:"Welcome desks, information screens and queueing",p:[-10,1.4,-7.6],v:[-12.0,-3.8],a:-1.57},
 {name:"Sponsors Galleria",floor:"First floor",role:"Branded demo booths, monitors and sponsor corridor",p:[-5.1,1.5,1.7],v:[-3.3,1.7]},
 {name:"Food",floor:"First floor",role:"Buffet counters, menu band, drink station and café tables",p:[8.6,1.4,8.1],v:[9.8,6.0]},
 {name:"Hacking Area — Collins Room",floor:"First floor",role:"Laptop workstations, shared power and presentation display",p:[10.5,1.5,2.7],v:[7.0,2.5]},
 {name:"Hacking Area — Collins Patio",floor:"First floor · outdoors",role:"Shaded outdoor hacking tables and planting",p:[20.5,1.2,4.0],v:[18.3,4.0]},
 {name:"Hacking Area — Founders’ Room",floor:"First floor",role:"Team tables, laptops, whiteboard and lounge seating",p:[2.1,1.5,-8.1],v:[-1.2,-8.1]},
 {name:"Hacking Area — Founders’ Patio",floor:"First floor · outdoors",role:"Outdoor worktables beneath a shade canopy",p:[10.7,1.2,-15.1],v:[10.7,-12.2]},
 {name:"Restrooms",floor:"First floor",role:"Wayfinding, privacy partitions, sinks and mirrors",p:[1.7,1.5,-2.2],v:[1.7,-4.1]},
 {name:"Stairs to Second Floor",floor:"East side",role:"Exterior stair connecting both event levels",p:[17.5,2.3,-.5],v:[17.5,-2.7]},
 {name:"Workshops",floor:"Second floor",role:"Teaching stage, projection screen and classroom tables",p:[.7,5.6,0],v:[-4.2,0]},
 {name:"Networking — Northeast Patio",floor:"Second floor",role:"Cocktail tables, lounge seating, planters and warm lights",p:[8.4,5.6,7.2],v:[4.2,7.1]}
];
const scene=new THREE.Scene();scene.background=new THREE.Color(0xdce6ef);scene.fog=new THREE.Fog(0xdce6ef,58,108);
const camera=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.08,220);camera.position.set(-10,1.72,-5.9);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;document.querySelector("#view").appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xeaf4ff,0x6b6254,2.15));const sun=new THREE.DirectionalLight(0xfff3db,3.2);sun.position.set(-22,34,-18);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);scene.add(sun);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(-10,1.72,2);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;controls.minDistance=.8;controls.maxDistance=92;controls.update();
const bytes=Uint8Array.from(atob("__MODEL__"),c=>c.charCodeAt(0));new GLTFLoader().parse(bytes.buffer,"",g=>{g.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});scene.add(g.scene)});

const labels=document.querySelector("#labels"),list=document.querySelector("#placeList"),jump=document.querySelector("#jump");
rooms.forEach((r,i)=>{
 const tag=document.createElement("button");tag.className="tag";tag.textContent=r.name;tag.onclick=()=>focusRoom(i);labels.appendChild(tag);r.tag=tag;
 const row=document.createElement("button");row.className="place";row.innerHTML=r.name+"<small>"+r.floor+" · "+r.role+"</small>";row.onclick=()=>focusRoom(i);list.appendChild(row);
 const option=document.createElement("option");option.value=i;option.textContent=r.name;jump.appendChild(option);
});
function focusRoom(i){
 const r=rooms[i];startImmerse(i);
}
function exterior(){exitImmerse();camera.position.set(34,27,38);controls.target.set(1,3,-2);controls.update()}
document.querySelector("#exterior").onclick=exterior;
jump.onchange=()=>{if(jump.value!==""){startImmerse(Number(jump.value));jump.value=""}};

let immersive=false,yaw=Math.PI,pitch=0,last=performance.now();const keys={};
function startImmerse(roomIndex=0){
 immersive=true;document.body.classList.add("immersive");controls.enabled=false;
 const r=rooms[roomIndex],second=r.p[1]>3;camera.position.set(r.v[0],second?5.72:1.72,r.v[1]);yaw=r.a??Math.PI;pitch=0;renderer.domElement.requestPointerLock?.();
 document.querySelector("#immerse").textContent="Exit tour";
 document.querySelector("#welcome").style.display="none";
 renderer.domElement.tabIndex=0;renderer.domElement.focus();
}
function exitImmerse(){
 if(!immersive)return;immersive=false;document.body.classList.remove("immersive");controls.enabled=true;document.exitPointerLock?.();document.querySelector("#immerse").textContent="Immerse in";
}
document.querySelector("#immerse").onclick=()=>immersive?exitImmerse():startImmerse();
document.querySelector("#startTour").onclick=()=>startImmerse(0);
renderer.domElement.addEventListener("click",()=>{if(immersive&&document.pointerLockElement!==renderer.domElement)renderer.domElement.requestPointerLock?.()});
addEventListener("mousemove",e=>{if(immersive&&document.pointerLockElement===renderer.domElement){yaw-=e.movementX*.0022;pitch=Math.max(-1.25,Math.min(1.25,pitch-e.movementY*.0022))}});
const arrowCodes=new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]);
addEventListener("keydown",e=>{if(arrowCodes.has(e.code)){e.preventDefault();e.stopPropagation()}keys[e.code]=true},{capture:true});
addEventListener("keyup",e=>{if(arrowCodes.has(e.code)){e.preventDefault();e.stopPropagation()}keys[e.code]=false},{capture:true});
addEventListener("blur",()=>{for(const k in keys)keys[k]=false});
document.querySelectorAll(".dpad button").forEach(button=>{
 const code=button.dataset.key;
 const down=e=>{e.preventDefault();keys[code]=true;button.classList.add("active")};
 const up=e=>{e.preventDefault();keys[code]=false;button.classList.remove("active")};
 button.addEventListener("pointerdown",down);button.addEventListener("pointerup",up);button.addEventListener("pointercancel",up);button.addEventListener("pointerleave",up);
});
function updateWalk(dt){
 if(keys.ArrowLeft)yaw+=dt*1.9;if(keys.ArrowRight)yaw-=dt*1.9;
 camera.rotation.order="YXZ";camera.rotation.set(pitch,yaw,0);
 const forward=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
 const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
 const move=new THREE.Vector3();
 if(keys.KeyW||keys.ArrowUp)move.add(forward);if(keys.KeyS||keys.ArrowDown)move.sub(forward);
 if(keys.KeyD)move.add(right);if(keys.KeyA)move.sub(right);
 if(move.lengthSq())camera.position.add(move.normalize().multiplyScalar(dt*(keys.ShiftLeft||keys.ShiftRight?8:3.6)));
 const onSecond=camera.position.y>3;
 if(camera.position.x>15.6&&camera.position.x<19.3&&camera.position.z>-3.8&&camera.position.z<2.7){
   camera.position.y=Math.max(1.72,Math.min(5.72,1.72+(camera.position.z+3.2)*.72));
 }else camera.position.y=onSecond?5.72:1.72;
 let nearest=rooms[0],dist=1e9;for(const r of rooms){const dy=Math.abs(camera.position.y-r.p[1]);const d=Math.hypot(camera.position.x-r.p[0],camera.position.z-r.p[2])+dy*2;if(d<dist){dist=d;nearest=r}}
 document.querySelector("#zone").textContent=nearest.name;
 document.querySelector("#zoneRole").textContent=nearest.role;
}
function projectLabels(){
 const w=innerWidth,h=innerHeight;
 for(const r of rooms){const v=new THREE.Vector3(...r.p).project(camera);const visible=v.z>-1&&v.z<1;r.tag.style.display=visible?"block":"none";r.tag.style.left=(v.x*.5+.5)*w+"px";r.tag.style.top=(-v.y*.5+.5)*h+"px";}
}
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
renderer.setAnimationLoop(t=>{const dt=Math.min(.05,(t-last)/1000);last=t;if(immersive)updateWalk(dt);else{controls.update();projectLabels()}renderer.render(scene,camera)});
</script></body></html>""".replace("__MODEL__", encoded)
(OUT / "index.html").write_text(html, encoding="utf-8")

readme = """# James West Alumni Center — concept model

Files:
- james-west-alumni-center-concept.glb — standard glTF binary model
- james-west-alumni-center-viewer.html — interactive orbit/zoom viewer

Interactive viewer controls:
- Use the exterior view to orbit, zoom, and click any room label.
- Select Immerse in to enter at the check-in area.
- Walk with WASD or arrow keys, look with the mouse, and hold Shift to move faster.
- The tour identifies the nearest labeled place while walking.

Scope and assumptions:
- No people or human figures are included.
- The main experience begins inside the building as a first-person tour.
- Event furnishings follow the supplied sketch: check-in, sponsor booths, food stations, hacking tables, workshops, networking tables, and restroom wayfinding.
- Two stories, approximately 4 m floor-to-floor.
- Footprints and room relationships are inferred from the supplied event maps.
- Exterior glazing, entrance canopy, patios, stairs, rails, and simple furnishings are conceptual.
- The source maps contain no scale, elevations, structural drawings, or complete door/window schedule; this is not suitable for construction or code review.
"""
(Path(__file__).with_name("MODEL-NOTES.md")).write_text(readme, encoding="utf-8")
print(glb_path)
print(OUT / "index.html")
