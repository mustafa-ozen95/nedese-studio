"""Farthest point sampling with torch_cluster's fps() signature, in plain torch (no compiled extension)."""
import torch


def fps(src, batch=None, ratio=0.5, random_start=True, batch_size=None):
    if batch is None:
        batch = torch.zeros(src.shape[0], dtype=torch.long, device=src.device)
    out = []
    for b in torch.unique(batch, sorted=True):
        idx = torch.nonzero(batch == b).squeeze(-1)
        pts = src[idx]
        n = pts.shape[0]
        k = max(1, int(torch.ceil(torch.tensor(n * float(ratio))).item()))
        chosen = torch.empty(k, dtype=torch.long, device=src.device)
        dist = torch.full((n,), float('inf'), device=src.device, dtype=pts.dtype)
        cur = int(torch.randint(n, (1,)).item()) if random_start else 0
        for i in range(k):
            chosen[i] = cur
            dist = torch.minimum(dist, ((pts - pts[cur]) ** 2).sum(-1))
            cur = int(torch.argmax(dist))
        out.append(idx[chosen])
    return torch.cat(out)
