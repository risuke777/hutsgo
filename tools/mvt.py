"""Minimal Mapbox Vector Tile decoder (no dependencies). Lines only are needed."""
import struct


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return r, i


def _fields(b):
    i = 0
    while i < len(b):
        key, i = _varint(b, i)
        f, w = key >> 3, key & 7
        if w == 0:
            v, i = _varint(b, i)
        elif w == 2:
            n, i = _varint(b, i); v = b[i:i + n]; i += n
        elif w == 1:
            v = b[i:i + 8]; i += 8
        elif w == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError(w)
        yield f, w, v


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i); out.append(v)
    return out


def _value(b):
    for f, w, v in _fields(b):
        if f == 1: return v.decode("utf-8")
        if f == 2: return struct.unpack("<f", v)[0]
        if f == 3: return struct.unpack("<d", v)[0]
        if f in (4, 5): return v
        if f == 6: return (v >> 1) ^ -(v & 1)
        if f == 7: return bool(v)


def _geom(cmds):
    x = y = 0; parts = []; cur = None; i = 0
    while i < len(cmds):
        c = cmds[i]; i += 1
        op, cnt = c & 7, c >> 3
        if op == 7:
            if cur: cur.append(cur[0])
            continue
        for _ in range(cnt):
            dx, dy = cmds[i], cmds[i + 1]; i += 2
            x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1)
            if op == 1:
                cur = [(x, y)]; parts.append(cur)
            else:
                cur.append((x, y))
    return parts


def decode(data):
    """{layer_name: {"extent": int, "features": [{"type", "props", "parts"}]}}"""
    layers = {}
    for f, w, v in _fields(data):
        if f != 3:
            continue
        name, keys, vals, feats, extent = None, [], [], [], 4096
        for lf, lw, lv in _fields(v):
            if lf == 1: name = lv.decode()
            elif lf == 3: keys.append(lv.decode())
            elif lf == 4: vals.append(_value(lv))
            elif lf == 5: extent = lv
            elif lf == 2: feats.append(lv)
        out = []
        for fb in feats:
            tags, gtype, geom = [], 0, []
            for ff, fw, fv in _fields(fb):
                if ff == 2: tags = _packed(fv)
                elif ff == 3: gtype = fv
                elif ff == 4: geom = _packed(fv)
            props = {keys[tags[k]]: vals[tags[k + 1]] for k in range(0, len(tags), 2)}
            out.append({"type": gtype, "props": props, "parts": _geom(geom)})
        layers[name] = {"extent": extent, "features": out}
    return layers
