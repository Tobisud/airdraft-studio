"""Fit AirDraft's bundled 3D assets to normalized sketch strokes."""
from functools import lru_cache
import json
from pathlib import Path
import struct

import numpy as np
import trimesh

ASSETS = Path(__file__).resolve().parents[1] / "dist" / "assets"


@lru_cache(maxsize=1)
def stickman_data():
    data = (ASSETS / "stickman-default.glb").read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + size])
    binary = memoryview(data)[28 + size:]

    def accessor(index):
        item = doc["accessors"][index]
        view = doc["bufferViews"][item["bufferView"]]
        dtype = np.dtype({5123: "<u2", 5125: "<u4", 5126: "<f4"}[item["componentType"]])
        columns = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}[item["type"]]
        return np.ndarray(
            (item["count"], columns), dtype=dtype, buffer=binary,
            offset=view.get("byteOffset", 0) + item.get("byteOffset", 0),
            strides=(view.get("byteStride", columns * dtype.itemsize), dtype.itemsize),
        )

    skin = doc["skins"][0]
    joints = {doc["nodes"][node]["name"].rsplit("_", 1)[0]: i for i, node in enumerate(skin["joints"])}
    matrices = accessor(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
    pivots = np.linalg.inv(matrices)[:, :3, 3]
    primitive = doc["meshes"][0]["primitives"][0]
    attributes = primitive["attributes"]
    return (
        accessor(attributes["POSITION"]), accessor(primitive["indices"]).reshape(-1, 3),
        accessor(attributes["JOINTS_0"]), accessor(attributes["WEIGHTS_0"]), joints, pivots,
    )


@lru_cache(maxsize=1)
def house_template():
    return trimesh.load_scene(ASSETS / "house-default.glb").to_geometry()


def _limbs(paths):
    loops = [
        path for path in paths
        if len(path) >= 5 and np.linalg.norm(path[0]-path[-1]) < .34*max(np.ptp(path, axis=0))
        and path[:, 1].mean() > .30 and min(np.ptp(path, axis=0)) > .22
        and max(np.ptp(path, axis=0)) < 1.65
    ]
    if not loops:
        return None
    head = max(loops, key=lambda path: path[:, 1].mean())
    rest = [path for path in paths if path is not head]
    if not rest:
        return None
    points = np.vstack(rest)
    neck = np.array([head[:, 0].mean(), head[:, 1].min()])
    span = neck[1] - points[:, 1].min()
    if span < .60:
        return None
    expected = neck + [0, -.48*span]
    candidates = points[
        (np.abs(points[:, 0]-neck[0]) < .42)
        & (points[:, 1] < neck[1]-.25*span)
        & (points[:, 1] > neck[1]-.65*span)
    ]
    hip = min(candidates, key=lambda p: np.linalg.norm((p-expected)*[1.7, 1])) if len(candidates) else expected
    shoulders = neck + .13*(hip-neck)

    def find(side, leg):
        anchor = hip if leg else shoulders
        offset = side*(points[:, 0]-anchor[0])
        if leg:
            eligible = points[(offset > .12) & (points[:, 1] < hip[1]-.16*span)]
        else:
            eligible = points[(offset > .23) & (points[:, 1] > hip[1]+.05) & (points[:, 1] < neck[1]+.35)]
        if not len(eligible):
            return None
        end = max(eligible, key=lambda p: anchor[1]-p[1]+.22*side*(p[0]-anchor[0]) if leg else side*p[0])
        midpoint = (anchor+end)/2
        closest = min(eligible, key=lambda p: np.linalg.norm(p-midpoint))
        bend = closest if np.linalg.norm(closest-midpoint) < .23*np.linalg.norm(end-anchor) else midpoint
        return anchor, bend, end

    return neck, hip, [(find(side, False), find(side, True)) for side in (-1, 1)]


def _segment(start, end, target, delta):
    rest = (end-start)[:2]
    length = np.linalg.norm(rest)
    desired = np.linalg.norm(delta)
    if min(length, desired) < 1e-6:
        return np.eye(3), target-start
    axis = rest/length
    stretch = np.eye(3)
    stretch[:2, :2] += (np.clip(desired/length, .55, 1.55)-1)*np.outer(axis, axis)
    angle = np.arctan2(delta[1], delta[0]) - np.arctan2(rest[1], rest[0])
    c, s = np.cos(angle), np.sin(angle)
    transform = np.array([[c,-s,0],[s,c,0],[0,0,1]]) @ stretch
    return transform, target-transform@start


def _pose_stickman(paths):
    vertices, faces, bones, weights, names, pivots = stickman_data()
    figure = _limbs(paths)
    if figure is None:
        raise ValueError("Draw a closed head above the torso to pose the stick figure.")
    neck, hip, limbs = figure
    matrices = np.repeat(np.eye(3)[None], len(names), axis=0)
    offsets = np.zeros((len(names), 3))
    scale = (pivots[names["Neck"], 1]-pivots[names["Root"], 1])/np.linalg.norm(neck-hip)

    def chain(keys, start, middle, end, limb):
        if limb is None:
            return
        anchor, bend, tip = limb
        upper, upper_offset = _segment(start, middle, start, (bend-anchor)*[-scale, scale])
        lower, lower_offset = _segment(middle, end, upper@middle+upper_offset, (tip-bend)*[-scale, scale])
        for name, matrix, offset in zip(keys, (upper, lower), (upper_offset, lower_offset)):
            matrices[names[name]], offsets[names[name]] = matrix, offset
        if len(keys) == 3:
            # Preserve the hand's shape while carrying it to the new wrist.
            u, _, vt = np.linalg.svd(lower)
            rotation = u @ vt
            matrices[names[keys[2]]] = rotation
            offsets[names[keys[2]]] = lower@end+lower_offset-rotation@end

    for side, (arm, leg) in zip(("Left", "Right"), limbs):
        arm_keys = [side+joint for joint in ("Arm", "ForeArm", "Hand")]
        leg_keys = [side+joint for joint in ("UpLeg", "Leg")]
        shoulder, elbow, wrist = [pivots[names[name]] for name in arm_keys]
        thigh, knee = [pivots[names[name]] for name in leg_keys]
        foot = knee.copy()
        foot[1] = vertices[:, 1].min() + .14*(thigh[1]-knee[1])
        chain(arm_keys, shoulder, elbow, wrist, arm)
        chain(leg_keys, thigh, knee, foot, leg)
    moved = np.einsum("nkij,nj->nki", matrices[bones], vertices) + offsets[bones]
    posed = (moved*weights[..., None]).sum(axis=1) * [-1,1,-1]
    return trimesh.Trimesh(vertices=posed, faces=faces, process=False)


def build_model(strokes, canvas_size, kind):
    width, height = canvas_size
    paths = [np.asarray(stroke["points"], dtype=float)*[width, height] for stroke in strokes]
    if not paths:
        raise ValueError("Draw a sketch first.")
    points = np.vstack(paths)
    minimum, maximum = points.min(axis=0), points.max(axis=0)
    dimensions = maximum-minimum
    if max(dimensions) < 8:
        raise ValueError("Draw a larger sketch first.")
    if kind == "House":
        if min(dimensions) < 8:
            raise ValueError("Draw a house outline with both width and height.")
        mesh = house_template().copy()
        mesh.apply_translation(-mesh.bounds.mean(axis=0))
        fit = dimensions/max(dimensions)*3.8
        mesh.apply_scale([fit[0]/mesh.extents[0], fit[1]/mesh.extents[1], fit[0]/mesh.extents[0]])
    else:
        center = (minimum+maximum)/2
        paths = [(path-center)*[1,-1]*3.8/max(dimensions) for path in paths]
        mesh = _pose_stickman(paths)
        mesh.apply_translation(-mesh.bounds.mean(axis=0))
        mesh.apply_scale(3.8/mesh.extents[1])
    return mesh
