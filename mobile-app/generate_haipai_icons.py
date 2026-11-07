#!/usr/bin/env python3
"""Build installed web and Android icons from the owner's uploaded underwater friends illustration.

Source is stored as a compact WebP base64 text asset because the GitHub content
connector only supports UTF-8 file writes. Generate committed binaries in CI.
This does not touch trading code, server state, or credentials.
"""
import base64
import hashlib
import io
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
ASSET=ROOT/"mobile-app/haipai-friends.webp.b64"
blob=base64.b64decode(ASSET.read_text().strip(),validate=True)
digest=hashlib.sha256(blob).hexdigest()
EXPECTED="3ecb9f1c3fb83a5d39ee3c73b6113104f18350da639726317543ade8db85b34c"
assert digest==EXPECTED, "ARTWORK_DIGEST_MISMATCH"
assert blob.startswith(b"RIFF") and blob[8:12]==b"WEBP", "INVALID_ARTWORK_FORMAT"
image=Image.open(io.BytesIO(blob)).convert("RGB")
assert image.size==(96,96),image.size
for size in (192,512):
 out=ROOT/f"mobile-app/icon-{size}.png"
 image.resize((size,size),Image.Resampling.LANCZOS).save(out,format="PNG",optimize=True)
 print("HAIPAI_ICON_READY",out.relative_to(ROOT),out.stat().st_size)
# Android launcher uses the same artwork with original package ID and signature.
android=ROOT/"android-app/app/src/main/res/drawable-nodpi/sea_friends_icon.png"
android.parent.mkdir(parents=True,exist_ok=True)
image.resize((512,512),Image.Resampling.LANCZOS).save(android,format="PNG",optimize=True)
print("HAIPAI_ANDROID_ICON_READY",android.relative_to(ROOT),android.stat().st_size)
# SVG provides browsers a dedicated favicon instead of the previous ZL line chart.
svg=ROOT/"mobile-app/icon.svg"
embedded=base64.b64encode((ROOT/"mobile-app/icon-512.png").read_bytes()).decode("ascii")
svg.write_text(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
  '<image width="512" height="512" href="data:image/png;base64,'+embedded+'"/>'
  '</svg>',encoding="utf-8"
)
print("HAIPAI_FAVICON_READY",svg.relative_to(ROOT),svg.stat().st_size)
