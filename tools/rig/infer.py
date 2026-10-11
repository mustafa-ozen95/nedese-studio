r"""
Character skeleton (Make-It-Animatable v1, CVPR 2025; code MIT, weights Apache-2.0): the 52 Mixamo bones of a humanoid
model and the skin weights of its vertices, from the mesh alone (any proportions, standing in an A- or T-pose).
  python infer.py --input model.glb --output rig.npz [--fingers 0|1]

Environment: AI_RIG_CODE (the folder with the Make-It-Animatable source in mia\ and pytorch3d's transforms in
pytorch3d-transforms\; setup copies both from setup\vendor), AI_RIG_MODEL (the four checkpoints; Settings > Models
"Character skeleton (Make-It-Animatable)").

Writes names, parents, head, tail (the bones in the input's glTF coordinates; the model's own pose is the rest pose),
verts (the analysed vertices) and, for each vertex, its four strongest bones (bones, int16) and their weights (weights).
The bone names are Mixamo's ("mixamorig:Hips" ...): Unity Humanoid, Unreal's IK Retargeter and Godot's BoneMap map them
on their own, and Mixamo animations play on them.
--fingers 0: the hand is one bone for the skin (the finger bones stay, without weights): generated hands are often
closed mittens that a finger animation would tear.
Progress lines: "Joints", "Weights", "Bones", "Done".
"""
import argparse
import os
import sys
import time
import types

import numpy as np

CODE = os.environ.get('AI_RIG_CODE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'rig')
MODEL = os.environ.get('AI_RIG_MODEL') or os.path.join(CODE, '..', 'models', 'rigging')
# The source, pytorch3d's transforms (no compiled part is used) and this folder's torch_cluster (fps in plain torch)
sys.path[:0] = [os.path.join(CODE, 'mia'), os.path.join(CODE, 'pytorch3d-transforms'), os.path.dirname(os.path.abspath(__file__))]

# util.dataset_mixamo reads the Mixamo hierarchy from a template FBX through Blender at import time; the hierarchy is
# Mixamo's fixed one, so a stand-in answers those calls.
PARENT = {'Spine': 'Hips', 'Spine1': 'Spine', 'Spine2': 'Spine1', 'Neck': 'Spine2', 'Head': 'Neck',
          'LeftUpLeg': 'Hips', 'LeftLeg': 'LeftUpLeg', 'LeftFoot': 'LeftLeg', 'LeftToeBase': 'LeftFoot',
          'RightUpLeg': 'Hips', 'RightLeg': 'RightUpLeg', 'RightFoot': 'RightLeg', 'RightToeBase': 'RightFoot'}
FINGERS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')
for _side in ('Left', 'Right'):
    PARENT.update({f'{_side}Shoulder': 'Spine2', f'{_side}Arm': f'{_side}Shoulder', f'{_side}ForeArm': f'{_side}Arm',
                   f'{_side}Hand': f'{_side}ForeArm'})
    for _f in FINGERS:
        PARENT.update({f'{_side}Hand{_f}1': f'{_side}Hand', f'{_side}Hand{_f}2': f'{_side}Hand{_f}1',
                       f'{_side}Hand{_f}3': f'{_side}Hand{_f}2'})


class _Bone:
    def __init__(self, name):
        self.name = 'mixamorig:' + name
        self.children = [_Bone(c) for c, p in PARENT.items() if p == name]


class _Bones(dict):
    def __getitem__(self, name):
        return _Bone(name.split(':', 1)[1])


_stub = types.ModuleType('util.blender_utils')
_stub.bpy = None
_stub.Object = object
_stub.reset = lambda: None
_stub.load_file = lambda path: None
_stub.get_armature_obj = lambda _: types.SimpleNamespace(data=types.SimpleNamespace(bones=_Bones()))
sys.modules['util.blender_utils'] = _stub
import util  # noqa: E402

util.blender_utils = _stub
_isfile = os.path.isfile
os.path.isfile = lambda p: True if str(p).endswith('bones.fbx') else _isfile(p)
import torch  # noqa: E402
import trimesh  # noqa: E402
from pytorch3d.transforms import Transform3d  # noqa: E402

from model import PCAE  # noqa: E402
from util.dataset_mixamo import BONES_IDX_DICT, JOINTS_NUM, KINEMATIC_TREE, MIXAMO_PREFIX, get_hips_transform  # noqa: E402
from util.utils import fix_random, get_normalize_transform, sample_mesh  # noqa: E402

os.path.isfile = _isfile
P = MIXAMO_PREFIX
# Points sampled on the surface; half of them again around the hands (the reference settings of app.py)
POINTS = 32768
HANDS = 0.5
CHUNK = 100000


def conflict_mask(dominant, first, second):
    """Vertices whose strongest bone is in `first`: True at the bones in `second` (their weights there are dropped)."""
    idx1 = torch.tensor([v for k, v in BONES_IDX_DICT.items() if first(k)]).to(dominant)
    idx2 = torch.tensor([v for k, v in BONES_IDX_DICT.items() if second(k)]).to(dominant)
    mask2 = torch.isin(torch.arange(len(BONES_IDX_DICT), device=dominant.device), idx2)
    m = torch.isin(dominant, idx1).unsqueeze(-1).expand([*dominant.shape, len(BONES_IDX_DICT)]).clone()
    m[:, :, ~mask2] = False
    return m


def arm(side):
    return (f'{side}Arm', f'{side}ForeArm', f'{side}Hand') + tuple(f'{side}Hand{f}{i}' for f in FINGERS for i in (1, 2, 3))


def post_process(bw, above_head, fingers):
    """app.py bw_post_process: no weights across parts that move apart (left/right, arms/body), 4 bones per vertex."""
    m = above_head.unsqueeze(-1).tile(bw.shape[-1])
    head = torch.zeros_like(m)
    head[..., BONES_IDX_DICT[P + 'Head']] = True
    bw[m & head] = 1e5
    if not fingers:
        dominant = torch.argmax(bw, dim=-1)
        for hand in ('Left', 'Right'):
            bw[conflict_mask(dominant, lambda k: hand in k and any(x in k for x in FINGERS), lambda k: k.endswith(f'{hand}Hand'))] = 1e5
        bw[conflict_mask(dominant, lambda k: True, lambda k: any(x in k for x in FINGERS))] = 0
    dominant = torch.argmax(bw, dim=-1)
    if fingers:
        for hand, other in (('Left', 'Right'), ('Right', 'Left')):
            bw[conflict_mask(dominant, lambda k: hand in k, lambda k: other in k)] = 0
            for f in FINGERS:
                bw[conflict_mask(dominant, lambda k: hand in k and f in k, lambda k: hand in k and any(x in k for x in FINGERS if x != f))] = 0
    sets = (
        {('Neck', 'Head'), ('LeftLeg', 'LeftFoot', 'LeftToeBase'), ('RightLeg', 'RightFoot', 'RightToeBase'), arm('Left'), arm('Right')},
        {('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'RightUpLeg', 'RightLeg',
          'RightFoot', 'RightToeBase', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'), arm('Right')[1:] + arm('Left')[1:]},
    )
    for parts in sets:
        for part in parts:
            others = parts - {part}
            bw[conflict_mask(dominant, lambda k: any(x in k for x in part), lambda k: any(any(x in k for x in p) for p in others))] = 0
    return bw / (bw.sum(dim=-1, keepdim=True) + 1e-10)


def main():
    p = argparse.ArgumentParser(description='Mixamo skeleton and skin weights of a humanoid model')
    p.add_argument('--input', required=True, help='the model (GLB)')
    p.add_argument('--output', required=True, help='the result (.npz)')
    p.add_argument('--fingers', type=int, default=0, help='1: the fingers get their own weights')
    a = p.parse_args()
    started = time.time()
    fix_random()
    if not torch.cuda.is_available():
        raise SystemExit('No CUDA GPU: the character skeleton needs one.')
    device = torch.device('cuda')

    def load(file, **kw):
        path = os.path.join(MODEL, file)
        if not os.path.isfile(path):
            raise SystemExit(f'Model file missing: {path} (Settings > Models "Character skeleton").')
        m = PCAE(N=POINTS, deterministic=True, output_dim=JOINTS_NUM, **kw)
        m.load(path)
        return m.to(device).eval()

    mesh = trimesh.load(a.input, force='mesh')
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise SystemExit('The model has no surface to put a skeleton in.')
    verts0 = np.asarray(mesh.vertices, dtype=np.float32)
    plain = trimesh.Trimesh(verts0.copy(), np.asarray(mesh.faces), process=False)
    verts = torch.from_numpy(verts0).unsqueeze(0)
    normals = torch.from_numpy(np.asarray(mesh.vertex_normals, dtype=np.float32)).unsqueeze(0)
    print('Joints', flush=True)
    with torch.no_grad():
        # 1) A first guess of the joints puts the hips straight; the hands are sampled again more densely.
        pts = torch.from_numpy(sample_mesh(plain, POINTS, get_normals=True).astype(np.float32)).unsqueeze(0)[..., :3]
        norm = get_normalize_transform(pts, keep_ratio=True, recenter=True)
        coarse = load('joints_coarse.pth', input_normal=False, predict_bw=False, predict_joints=True, predict_joints_tail=True)
        j = coarse(norm.transform_points(pts).to(device)).joints.cpu()
        del coarse
        torch.cuda.empty_cache()
        j, tails = j[..., :3], j[..., 3:]
        hips = get_hips_transform(j[:, BONES_IDX_DICT[P + 'Hips']], j[:, BONES_IDX_DICT[P + 'RightUpLeg']], j[:, BONES_IDX_DICT[P + 'LeftUpLeg']])
        rot = Transform3d(matrix=hips.transpose(-1, -2))
        glob = norm.compose(rot)
        verts = glob.transform_points(verts)
        normals = torch.nn.functional.normalize(rot.transform_normals(normals), dim=-1)
        tails = rot.transform_points(tails).squeeze(0).numpy()
        plain.vertices = verts.squeeze(0).numpy()
        centers = [tails[BONES_IDX_DICT[P + 'LeftHand']], tails[BONES_IDX_DICT[P + 'RightHand']]]
        pts = torch.from_numpy(sample_mesh(plain, POINTS, get_normals=True, attn_ratio=HANDS, attn_centers=centers).astype(np.float32)).unsqueeze(0)
        pts, pts_n = torch.chunk(pts, 2, dim=-1)
        norm2 = get_normalize_transform(pts, keep_ratio=True, recenter=False)
        pts = norm2.transform_points(pts)
        verts = norm2.transform_points(verts)
        glob = glob.compose(norm2)

        # 2) Skin weights of every vertex: the model with normals, the plain one where the arms meet the body
        print('Weights', flush=True)
        bw_model = load('bw.pth', input_normal=False, hierarchical_ratio=HANDS)
        bwn_model = load('bw_normal.pth', input_normal=True, input_attention=True, hierarchical_ratio=HANDS)
        p_, pn = pts.to(device), pts_n.to(device)
        out = []
        for v_, vn_ in zip(torch.split(verts, CHUNK, dim=-2), torch.split(normals, CHUNK, dim=-2)):
            v_, vn_ = v_.to(device), vn_.to(device)
            plain_bw = bw_model(p_, v_).bw
            bw = bwn_model(torch.cat([p_, pn], -1), torch.cat([v_, vn_], -1)).bw
            m = conflict_mask(torch.argmax(plain_bw, -1), lambda k: True, lambda k: any(x in k for x in ('Spine', 'Shoulder', 'Arm')))
            bw[m] = plain_bw[m]
            out.append(bw.cpu())
        bw = torch.cat(out, dim=-2)
        del bw_model, bwn_model
        torch.cuda.empty_cache()

        # 3) The joints (head and tail of each bone), along the kinematic tree
        print('Bones', flush=True)
        joints_model = load('joints.pth', input_normal=False, hierarchical_ratio=HANDS, kinematic_tree=KINEMATIC_TREE,
                            predict_bw=False, predict_joints=True, predict_joints_tail=True, joints_attn_causal=True)
        joints = joints_model(p_).joints.cpu()
        del joints_model
        torch.cuda.empty_cache()

    bw = post_process(bw, verts[..., 1] >= joints[:, [BONES_IDX_DICT[P + 'Head']], 4], bool(a.fingers)).squeeze(0)
    top = torch.topk(bw, k=4, dim=-1)
    weights = top.values / (top.values.sum(dim=-1, keepdim=True) + 1e-10)
    inverse = glob.inverse()
    back = lambda x: inverse.transform_points(x.unsqueeze(0)).squeeze(0).numpy()
    names = [None] * JOINTS_NUM
    for k, i in BONES_IDX_DICT.items():
        names[i] = k
    joints = joints.squeeze(0)
    temp = a.output + '.writing.npz'
    np.savez(temp, names=np.array(names), parents=np.array(KINEMATIC_TREE.parent_indices), head=back(joints[:, :3]),
             tail=back(joints[:, 3:]), verts=verts0, bones=top.indices.numpy().astype(np.int16), weights=weights.numpy().astype(np.float32))
    os.replace(temp, a.output)
    print(f'Done {len(verts0)} vertices, {time.time() - started:.1f} s', flush=True)


if __name__ == '__main__':
    main()
