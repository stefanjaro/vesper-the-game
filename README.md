# VESPER — an endless flight

**Glide. Ride the thermals. Gather the light. Wake the beacons.**

You are a manta of the evening sky, gliding over an endless desert beneath a
banded, ringed giant. Somewhere out in the dunes stand five ancient obelisks —
sleeping. Find them, feed them light, and wake them all.

Everything on this page — the terrain, the clouds, the stars, the ringed
giant, the lakes, the creatures, the wind and the music — is **generated live
in your browser while you watch**. There are no assets to load, no libraries,
no build step, and no network calls. View source: it's all just JavaScript,
mathematics and one honest WebGL2 context.

## Controls

| Input | Action |
| --- | --- |
| Mouse (pointer-locked) / ← → | bank and turn |
| Mouse up-down / ↑ ↓ | dive and climb |
| `Shift` or `Space` | burn light for a burst of speed |
| `P` | drift (pause) |
| `H` | hide the interface |
| `M` | mute |
| `F3` | flight data |

The flight is forgiving on purpose: you cannot crash. Sink too low and the
wind simply lifts you back into the sky. Spiraling dust marks rising air —
circle inside it and you'll climb without losing speed.

## How it works

- **Terrain** — a deterministic fractal height field (domain-warped fbm +
  ridged multifractals) sampled on the CPU, streamed as a quadtree of 3×3
  subdivided chunks with skirts, so detail near you is 3 m and the horizon
  is kilometres away.
- **Shadows** — a 2048² sun-space depth map with slope-scaled bias and
  normal-offset, refreshed every frame; long dusk shadows included.
- **Water** — no mesh at all: each screen pixel raycasts the water plane,
  then hardware depth-testing against the terrain composite for occlusion,
  with fresnel, depth absorption and shoreline foam.
- **Sky** — analytic atmosphere with mie glow, hashed starfield, high
  clouds lit by the sun, aurora curtains marched in bounded steps, and an
  analytic ringed giant with banded cloudscape and shadowed ring plane.
- **Post** — HDR pipeline (RGBA16F when available), threshold bloom,
  radial god rays from the scene itself, ACES tonemap, warm grade,
  vignette, film grain, subtle chromatic aberration. Resolution and shadow
  extent auto-tune to hold frame rate.
- **Audio** — WebAudio synthesis: filtered-noise wind tied to airspeed, a
  three-voice detuned pad walking a slow modal progression, FM chimes that
  answer your gathering, and deep blooms when a beacon wakes.

## The quest

Beacons demand growing amounts of light: 3, 8, 14, 22, 32 shards. Shards
gather in rings around each obelisk and in strings linking them. The fifth
awakened beacon does something to the sky. You'll know.

Fly on, as long as you like.

---

*Built by GLM 5.3 Flash (max thinking) for Stefan Jaro's "Show Me What You
Can Do" — one prompt, many models, each alone in its own folder.*
