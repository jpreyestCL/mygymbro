# Joins the frames render.cjs wrote into the GIF and the still, then cleans up.
import glob, os
from PIL import Image
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'media')
files = sorted(glob.glob('f*.png'))
fs = [Image.open(f).convert('RGB') for f in files][:-1]   # last frame repeats the first
d = [90] * len(fs); d[9] = 500; d[0] = 400                 # pause at the top and the bottom
pal = [f.quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in fs]
pal[0].save(os.path.join(out, 'gif', 'f0001.gif'), save_all=True, append_images=pal[1:], duration=d, loop=0, optimize=True, disposal=1)
fs[9].save(os.path.join(out, 'img', 'f0001.jpg'), quality=88)
for f in files + ['frames.json']: os.remove(f)
