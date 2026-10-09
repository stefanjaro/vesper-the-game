# VESPER — an endless flight

**Glide. Ride the thermals. Gather the light. Wake the beacons.**

You are a manta of the evening sky, gliding over an endless desert beneath a
banded, ringed giant. Somewhere out in the dunes stand five ancient obelisks —
sleeping. Find them, feed them light, and wake them all.

Everything on this page — the terrain, the clouds, the stars, the ringed
giant, the lakes, the weather, the creatures, the wind and the music — is
**generated live in your browser while you watch**. There are no assets to
load, no libraries, no build step, and no network calls. View source: it's all
just JavaScript, mathematics and one honest WebGL2 context.

## Controls

| Input | Action |
| --- | --- |
| Mouse (pointer-locked) / ← → | bank and turn |
| Mouse up-down / ↑ ↓ | dive and climb |
| `Shift` or `Space` | burn light for a burst of speed |
| `P` | drift (pause) |
| `H` | hide the interface |
| `M` | mute |
| `C` | photo mode (free camera) |
| `O` | settings (sensitivity, invert, quality, new flight) |
| `F3` | flight data |

**Gamepad** — left stick steers, RT (or A) burns light.

**Touch** — drag to steer, the BURN button spends light. Progress saves
automatically to your browser, per seed.

### Photo mode

`C` releases a free camera: `W A S D` to fly, `Q`/`E` down/up, `Shift` to
hurry, scroll to zoom, `[` and `]` to move the sun, `F` to cycle filters
(natural / amber / nocturne / sunbleach / ember) and `F2` to save a PNG.
The world keeps breathing while you compose.

The flight is forgiving on purpose: you cannot crash. Sink too low and the
wind simply lifts you back into the sky. Spiraling dust marks rising air —
circle inside it and you'll climb without losing speed. Light you gather is
also the fuel you burn, so skim the dunes between beacons.

## How it works

- **Terrain** — a deterministic fractal height field (domain-warped fbm +
  ridged multifractals) sampled on the CPU, streamed as a quadtree of 3×3
  subdivided chunks with skirts, frustum-culled, with parent-mesh fallback so
  the horizon never opens a hole while streaming.
- **Shadows** — a 2048² sun-space depth map with slope-scaled bias and
  normal-offset, refreshed every frame; long dusk shadows included.
- **Water** — no mesh at all: each screen pixel raycasts the water plane,
  then hardware depth-testing against the terrain composite for occlusion,
  with fresnel, depth absorption, shoreline foam and distance-flattened waves.
- **Sky** — analytic atmosphere with mie glow, hashed starfield, high clouds
  lit by the sun, aurora curtains, meteors, and an analytic ringed giant with
  banded cloudscape and shadowed ring plane — and, when the ringed giant
  crosses the sun, an eclipse with a ring of fire.
- **Weather** — fronts roll through on their own schedule, weighted by the
  land's moisture: dust storms that swallow the horizon, rain, thunder with
  lightning, and gales that shove the manta off its line. Each front changes
  the light, the fog, the water and the wind you hear.
- **Creatures** — flocks of gliders that scatter when you cut through them,
  and sky-whales: vast, slow leviathans circling the high air.
- **Lore stones** — weathered monoliths hidden in the world; glide close and
  they whisper. Find them all.
- **Post** — HDR pipeline (RGBA16F when available), threshold bloom, radial
  god rays from the scene itself, ACES tonemap, warm grade, vignette, film
  grain, subtle chromatic aberration, photo filters. Resolution and shadow
  extent auto-tune to hold frame rate.
- **Audio** — WebAudio synthesis: filtered-noise wind and rain tied to the
  weather, thunder, a pad that gains a voice with every beacon awakened and
  walks a faster modal progression as the world wakes, FM chimes that answer
  your gathering, and deep blooms when a beacon wakes.

## The quest

Beacons demand growing amounts of light: 4, 10, 18, 28 and 40 shards. Gather
light in rings around each obelisk and in strings linking them, then circle a
beacon long enough to wake it — you'll see it stir. The fifth awakened beacon
does something to the sky. You'll know.

Progress is saved for the world you're in. Share it with a URL:
`?seed=any-name` grows the same desert for everyone — `O` shows the seed and
offers a fresh flight.

Fly on, as long as you like.

---

*Built by GLM 5.3 Flash (max thinking) for Stefan Jaro's "Show Me What You
Can Do" — one prompt, many models, each alone in its own folder. Extended
with weather, eclipses, creatures, lore, photo mode and persistence.*
