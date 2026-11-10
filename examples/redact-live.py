# -*- coding: utf-8 -*-
# Redact personal info from examples/live-*.png
#  A: bottom-left account row (avatar + nickname)
#  S: sidebar workspace items (MES / AutoDeploy / ITSM), 1440x900 layout only
#  B: panel "已登录·昵称" row;  C: panel "已登录 <nickname> 退出登录" row
#     (B/C only on panel-open shots = filenames without peek/background)
import glob, os
from PIL import Image, ImageFilter

BASE = r"D:\Alan\插件\examples"
RECT_A = (0, 843, 215, 897)
RECT_B = (1095, 257, 1340, 289)
RECT_C = (1183, 357, 1302, 394)
RECT_SIDE = [(14, 391, 268, 421),   # MES
             (14, 427, 268, 457),   # AutoDeploy
             (14, 464, 268, 494)]   # ITSM

def redact(img, box, radius=14):
    region = img.crop(box).filter(ImageFilter.GaussianBlur(radius))
    img.paste(region, box)

changed = []
REF = (1440, 900)
for path in sorted(glob.glob(os.path.join(BASE, "live-*.png"))):
    img = Image.open(path).convert("RGB")
    sx, sy = img.width / REF[0], img.height / REF[1]
    def scaled(box):
        return tuple(int(round(v * (sx if i % 2 == 0 else sy))) for i, v in enumerate(box))
    did = ["A"]
    redact(img, scaled(RECT_A))
    if (img.width, img.height) == REF:
        for box in RECT_SIDE:
            redact(img, box)
        did.append("S")
    low = os.path.basename(path).lower()
    if "peek" not in low and "background" not in low:
        redact(img, scaled(RECT_B))
        redact(img, scaled(RECT_C))
        did.append("B+C")
    img.save(path, optimize=True)
    changed.append((os.path.basename(path), "+".join(did)))

for name, what in changed:
    print(f"{name:35s} {what}")
print(f"\n{len(changed)} files processed")
