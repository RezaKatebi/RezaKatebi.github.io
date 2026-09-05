#!/usr/bin/env python3
"""
Generate the hero black-hole graphic: Flamm's paraboloid with the horizon at the
throat, the photon sphere, and a body on the innermost stable circular orbit.

Everything is derived from the Schwarzschild metric rather than eyeballed.

  spatial metric (t const, theta = pi/2):  ds^2 = dr^2/(1 - rs/r) + r^2 dphi^2
  embed as z(r):                           ds^2 = (1 + z'^2) dr^2 + r^2 dphi^2
  => z'^2 = 1/(1 - rs/r) - 1 = rs/(r - rs)
  => z(r) = 2 sqrt(rs (r - rs))            inverse: r = z^2/(4 rs) + rs

Units: G = c = 1, rs = 2M = 1.

Radii drawn, all of which are genuine features of the equatorial plane and so are
faithfully represented by this embedding:

  horizon       r = rs   = 1.0    (throat; dz/dr -> infinity)
  photon sphere r = 3M   = 1.5 rs
  ISCO          r = 6M   = 3.0 rs

Deliberately NOT drawn: the black hole "shadow" at b = 3*sqrt(3) M = 2.598 rs.
That is an optical radius for a distant observer looking at the hole, not a
radius in the equatorial plane, so placing it on an embedding diagram would mix
two different pictures. The horizon at the throat is the honest thing to draw.

Orbital rate is Keplerian in Schwarzschild coordinates, Omega = sqrt(M/r^3), so
period scales exactly as r^1.5. With a single orbiting body the absolute period
is a free choice; ORBIT_SECONDS sets it, and PERIOD_REF documents the relation
so any future body can be given a consistent period.

Writes partials/hero-bh.svg.
"""
import math
import os

RS       = 1.0
R_PHOTON = 1.5 * RS      # 3M
R_ISCO   = 3.0 * RS      # 6M
R_MAX    = 16.0 * RS     # how far the sheet is DRAWN (mostly off-frame, faded)
TILT     = math.radians(27.0)
SIN_T, COS_T = math.sin(TILT), math.cos(TILT)

VIEW_W, VIEW_H = 560.0, 400.0
ORBIT_SECONDS = 16.0

# Scale is now explicit rather than solved to fit every point. Fitting the whole
# sheet is exactly what produced a visible outer rim: the sheet stopped inside
# the frame and read as a finite bowl. Now the frame shows VISIBLE_R of sheet and
# the rest runs off the edges under a radial fade, so spacetime just continues.
S = 38.0                          # px per rs
VISIBLE_R = (VIEW_W / 2) / S      # rs visible across the half-width, ~7.4
CX = VIEW_W / 2
CY = VIEW_H * 0.80                # throat sits low; the sheet rises away from it

def z(r):
    """Flamm's paraboloid."""
    return 2.0 * math.sqrt(RS * (r - RS))

def raw(r, phi):
    """Orthographic projection, before fitting to the viewBox."""
    return (r * math.cos(phi), r * math.sin(phi) * SIN_T - z(r) * COS_T)

def radii(n, r0=RS, r1=R_MAX):
    """Lines crowd near the throat, where curvature is strongest. The exponent is
    gentler than quadratic so the outer mesh does not go sparse once R_MAX is large."""
    return [r0 + (r1 - r0) * (i / n) ** 1.7 for i in range(n + 1)]

circle_rs = radii(16)[1:] + [R_PHOTON, R_ISCO]
spoke_phis = [-math.pi + 2 * math.pi * i / 36 for i in range(36)]

def proj(r, phi):
    x, y = raw(r, phi)
    return (CX + x * S, CY + y * S)

def poly(r, a0, a1, n=64):
    return "M" + "L".join(f"{x:.1f},{y:.1f}"
                          for x, y in (proj(r, a0 + (a1 - a0) * k / n) for k in range(n + 1)))

# ---- wireframe, split at the silhouette so the far half can be dimmed -----
back, front = [], []
for r in radii(16)[1:]:
    back.append(poly(r, -math.pi, 0.0))
    front.append(poly(r, 0.0, math.pi))
rr = radii(64)
for phi in spoke_phis:
    line = "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in (proj(r, phi) for r in rr))
    (back if math.sin(phi) < 0 else front).append(line)

def group(paths, opacity, width="0.9"):
    return (f'<g fill="none" stroke="currentColor" stroke-width="{width}"'
            f' opacity="{opacity}" shape-rendering="geometricPrecision">'
            + "".join(f'<path d="{p}"/>' for p in paths) + "</g>")

orbit_path  = poly(R_ISCO, -math.pi, math.pi, 120) + "Z"
photon_path = poly(R_PHOTON, -math.pi, math.pi, 72) + "Z"
horizon_path = poly(RS, -math.pi, math.pi, 72) + "Z"

# horizon centre and projected sizes, used by the browser geometry audit
hy = (proj(RS, -math.pi / 2)[1] + proj(RS, math.pi / 2)[1]) / 2
glow_r = R_ISCO * S * 1.15
glow_ry = glow_r * SIN_T * 1.30

svg = f'''<svg class="bh" viewBox="0 0 {VIEW_W:.0f} {VIEW_H:.0f}" role="img"
     aria-label="Flamm's paraboloid: the curvature of spacetime around a black hole, with a body orbiting at the innermost stable circular orbit"
     data-rs-px="{RS * S:.3f}" data-photon-px="{R_PHOTON * S:.3f}" data-isco-px="{R_ISCO * S:.3f}">
  <defs>
    <radialGradient id="bhGlow" cx="50%" cy="50%">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.5"/>
      <stop offset="45%" stop-color="var(--accent)" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </radialGradient>
    <!-- The throat is a mouth, not a sphere: darkest at the centre, faint warmth
         near the rim where the sheet turns over. No spherical shading. -->
    <radialGradient id="bhThroat" cx="50%" cy="42%">
      <stop offset="0%" stop-color="#000" stop-opacity="1"/>
      <stop offset="72%" stop-color="#000" stop-opacity="1"/>
      <stop offset="100%" stop-color="#2a1608" stop-opacity="1"/>
    </radialGradient>
    <!-- The sheet runs past every edge; fade it out so there is no rim and no
         hard clip line at the viewBox boundary. -->
    <radialGradient id="bhFade" gradientUnits="userSpaceOnUse"
                    cx="{CX:.1f}" cy="{VIEW_H * 0.46:.1f}" r="{VIEW_W * 0.62:.1f}">
      <stop offset="0%" stop-color="#fff"/>
      <stop offset="52%" stop-color="#fff"/>
      <stop offset="96%" stop-color="#000"/>
    </radialGradient>
    <mask id="sheetFade">
      <rect x="0" y="0" width="{VIEW_W:.0f}" height="{VIEW_H:.0f}" fill="url(#bhFade)"/>
    </mask>
  </defs>

  <ellipse cx="{CX + 0:.2f}" cy="{hy:.2f}" rx="{glow_r:.2f}" ry="{glow_ry:.2f}" fill="url(#bhGlow)"/>

  <g mask="url(#sheetFade)">{group(back, "0.22")}</g>

  <circle class="bh-body" r="5" cx="0" cy="0">
    <animateMotion dur="{ORBIT_SECONDS}s" repeatCount="indefinite" rotate="auto" path="{orbit_path}"/>
  </circle>

  <g mask="url(#sheetFade)">{group(front, "0.5")}</g>

  <path class="bh-photon" d="{photon_path}" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5" stroke-dasharray="3 4"/>
  <path id="bhHz" class="bh-horizon" d="{horizon_path}" fill="url(#bhThroat)"/>
  <use class="bh-rim" href="#bhHz" fill="none" stroke="#ffd7a8" stroke-width="2" opacity="1"/>
</svg>
'''

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
out = os.path.join(root, "partials", "hero-bh.svg")
with open(out, "w") as f:
    f.write(svg)

# ---- checks ---------------------------------------------------------------
print(f"wrote {os.path.relpath(out, root)}  ({len(svg)} bytes)")
print(f"  scale S = {S:.3f} px per rs;  viewBox {VIEW_W:.0f}x{VIEW_H:.0f}")
print("  embedding inverts (r -> z -> r):")
for r in (1.0, 1.5, 3.0, 4.0):
    zz = z(r)
    back_r = zz * zz / (4 * RS) + RS
    assert abs(back_r - r) < 1e-9, f"inversion failed at r={r}"
    print(f"    r={r:<5} z={zz:.6f}  ->  r={back_r:.6f}  ok")
print(f"  projected radii px: rs={RS*S:.2f}  photon={R_PHOTON*S:.2f}  isco={R_ISCO*S:.2f}")
print(f"  ratios vs rs: photon={R_PHOTON/RS:.4f} (want 1.5)  isco={R_ISCO/RS:.4f} (want 3.0)")
print(f"  period relation: T proportional to r^1.5; ISCO period set to {ORBIT_SECONDS}s")
print(f"  sheet drawn to {R_MAX:.0f} rs; frame shows ~{VISIBLE_R:.1f} rs, rest fades off-edge")
for name, r in (("horizon", RS), ("photon sphere", R_PHOTON), ("ISCO", R_ISCO)):
    pts_r = [proj(r, -math.pi + 2 * math.pi * k / 120) for k in range(121)]
    x0, x1 = min(p[0] for p in pts_r), max(p[0] for p in pts_r)
    y0, y1 = min(p[1] for p in pts_r), max(p[1] for p in pts_r)
    assert 0 <= x0 and x1 <= VIEW_W and 0 <= y0 and y1 <= VIEW_H, f"{name} clips the viewBox"
    print(f"    {name:<14} x[{x0:6.1f},{x1:6.1f}] y[{y0:6.1f},{y1:6.1f}]  inside")
assert CX - glow_r >= 0 and CX + glow_r <= VIEW_W, "glow clips horizontally"
assert hy - glow_ry >= 0 and hy + glow_ry <= VIEW_H, "glow clips vertically"
print(f"    glow           x[{CX-glow_r:6.1f},{CX+glow_r:6.1f}] y[{hy-glow_ry:6.1f},{hy+glow_ry:6.1f}]  inside")
