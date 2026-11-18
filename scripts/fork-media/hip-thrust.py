# Draws media/gif/f0001.gif + media/img/f0001.jpg (lever hip thrust), which the upstream
# dataset has no animation for. Run from scripts/fork-media/:
#   python3 hip-thrust.py && node render.cjs && python3 assemble.py
import math, json
# Side view, 360x360. Joint chain: ankle fixed on platform, shoulder rests on bench edge.
TH, SH, TO = 92, 84, 100   # thigh, shin, torso
A = (78, 286)
              # ankle on footplate

def knee(H, A, flip=1):
    dx, dy = A[0]-H[0], A[1]-H[1]; d = math.hypot(dx, dy)
    a = (TH**2 - SH**2 + d**2) / (2*d); h = math.sqrt(max(TH**2 - a**2, 0))
    mx, my = H[0]+a*dx/d, H[1]+a*dy/d
    return (mx + flip*h*dy/d, my - flip*h*dx/d)

def pose(t):  # t: 0 bottom, 1 top
    S = (248 - 2*t, 200 - 6*t)
    ang = math.radians(-46 + 46*t)           # torso angle from shoulder toward hips
    H = (S[0] - TO*math.cos(ang), S[1] - TO*math.sin(ang))
    K = knee(H, A, -1)
    return S, H, K

def L(p, q, w, c):  return f'<line x1="{p[0]:.1f}" y1="{p[1]:.1f}" x2="{q[0]:.1f}" y2="{q[1]:.1f}" stroke="{c}" stroke-width="{w}" stroke-linecap="round"/>'
def limb(p, q, w): return L(p, q, w+4, '#8f8f8f') + L(p, q, w, '#e9e9e9')
def lerp(p, q, f): return (p[0]+(q[0]-p[0])*f, p[1]+(q[1]-p[1])*f)

def svg(t):
    S, H, K = pose(t)
    P = (330, 262); pad = (H[0]+4, H[1]-22)
    neck = (S[0]+20, S[1]-6); head = (S[0]+38, S[1]-14)
    hand = (pad[0]+14, pad[1]-4); elbow = lerp(S, hand, .5); elbow = (elbow[0]+6, elbow[1]+22)
    toe = (A[0]-22, A[1]+6)
    # lever: pivots behind the bench, pad rides on the hips, horn with plates beyond
    P = (330, 262); pad = (H[0]+4, H[1]-22)
    dx, dy = pad[0]-P[0], pad[1]-P[1]; d = math.hypot(dx, dy); u = (dx/d, dy/d)
    horn = (pad[0]+u[0]*30, pad[1]+u[1]*30)
    o = ['<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="22 70 326 326"><rect x="0" y="0" width="400" height="400" fill="#fff"/><g>']
    # machine frame
    o.append('<rect x="30" y="298" width="315" height="10" rx="3" fill="#5f6470"/>')
    o.append('<path d="M38 298 L58 230 L74 230 L60 298 Z" fill="#b9bcc4" stroke="#6d717c" stroke-width="2"/>')   # angled footplate
    o.append('<rect x="44" y="288" width="64" height="10" rx="2" fill="#b9bcc4" stroke="#6d717c" stroke-width="2"/>')
    o.append('<rect x="262" y="214" width="12" height="84" fill="#5f6470"/><rect x="306" y="214" width="12" height="84" fill="#5f6470"/>')
    o.append('<rect x="240" y="198" width="98" height="18" rx="7" fill="#2f3340"/>')        # back pad
    o.append('<rect x="150" y="282" width="78" height="14" rx="6" fill="#2f3340"/>')        # seat
    o.append(f'<circle cx="{P[0]}" cy="{P[1]}" r="7" fill="#5f6470"/>')
    o.append(L(P, horn, 10, '#4a4e5a'))
    o.append(f'<circle cx="{horn[0]:.1f}" cy="{horn[1]:.1f}" r="25" fill="#55596a" stroke="#2f3340" stroke-width="3"/><circle cx="{horn[0]:.1f}" cy="{horn[1]:.1f}" r="5" fill="#b9bcc4"/>')
    # figure: far leg darker, near leg normal
    o.append(L(H, K, 26, '#bdbdbd') + L(K, A, 20, '#bdbdbd'))
    o.append(limb(S, H, 36))
    o.append(f'<ellipse cx="{H[0]-2:.1f}" cy="{H[1]+6:.1f}" rx="21" ry="17" fill="#c8634d" stroke="#8f8f8f" stroke-width="2"/>')  # glutes
    o.append(limb(H, K, 28))
    nx, ny = (K[1]-H[1]), -(K[0]-H[0]); n = math.hypot(nx, ny); nx, ny = nx/n*6, ny/n*6
    if ny < 0: nx, ny = -nx, -ny
    o.append(L((lerp(H, K, .2)[0]+nx, lerp(H, K, .2)[1]+ny), (lerp(H, K, .75)[0]+nx, lerp(H, K, .75)[1]+ny), 8, '#d99382'))                  # hamstrings
    o.append(limb(K, A, 21) + L(A, toe, 13, '#8f8f8f') + L(A, toe, 9, '#e9e9e9'))
    o.append(limb(S, neck, 18))
    o.append(f'<circle cx="{head[0]:.1f}" cy="{head[1]:.1f}" r="17" fill="#e9e9e9" stroke="#8f8f8f" stroke-width="2.5"/>')
    o.append(limb(S, elbow, 15) + limb(elbow, hand, 13))
    # hip pad over the hips, belt
    ang = math.degrees(math.atan2(u[1], u[0]))
    o.append(f'<g transform="translate({pad[0]:.1f},{pad[1]:.1f}) rotate({ang:.1f})"><rect x="-26" y="-11" width="52" height="22" rx="10" fill="#2f3340"/></g>')
    o.append('</g></svg>')
    return ''.join(o)

# ease in/out, short hold at the top and bottom
ts = []
for i in range(9): ts.append((1-math.cos(math.pi*i/8))/2)
ts = ts + [1] + ts[::-1][1:] + [0]
json.dump([svg(t) for t in ts], open('frames.json', 'w'))
print(len(ts))
