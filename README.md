# Tether — 3D Crew Safety

An immersive, single-page demo of **Tether**, a low-cost Man-Overboard (MOB) crew-safety
system: a cheap waterproof band on every crew member, with the brains living on the boat
instead of the band. The moment someone hits the water, the boat and shore are told.

Built as a **DAT620** class project.

## Live demo

Open the page and either:

- Click **Activate Live Demo** in the hero, or
- Scroll to the dashboard and click **Simulate man overboard**.

The simulation runs a real-time MOB sequence for crew member *Tunde A.*: a live
"time in water" clock, drifting GPS coordinates, distance/bearing from the vessel,
and a colour-coded hypothermia-risk countdown. **Stand down** resets it.

## Tech

- **Three.js (r128)** — GPU ocean (custom GLSL wave shaders), 3D sonar sphere, particle field
- **GSAP + ScrollTrigger** — hero entrance, scroll reveals, and the calm-water → blood-water alarm transition
- **2D Canvas** — the dashboard mini-sonar sweep with live crew blips and drift
- **Vanilla CSS** — crystal-water caustic shimmer on cards (`mix-blend-mode: screen`), no framework

No build step. It's a static site — `index.html`, `style.css`, `app.js`.

## Run locally

Any static server works, e.g.:

```bash
python -m http.server 3457
# then open http://localhost:3457
```

## Disclaimer

A student project exploring low-cost marine safety. **Not a certified safety device.**
