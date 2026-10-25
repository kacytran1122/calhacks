# James West Alumni Center — concept model

## Repository files

- `build_alumni_center.py` generates the model and the self-contained viewer.
- `../public/3d-tour/index.html` is the browser experience served by Next.js.
- `../public/3d-tour/james-west-alumni-center-concept.glb` is the standard glTF binary model.
- `../app/tour/page.tsx` exposes the full-screen application route at `/tour`.

## Rebuild

From the repository root:

```bash
python3 frontend/3d-tour/build_alumni_center.py
npm run dev --prefix frontend
```

Open `http://127.0.0.1:3000/tour`.

Interactive viewer controls:
- Use the exterior view to orbit, zoom, and click any room label.
- Select Enter the building to begin at check-in.
- Walk with WASD or the arrow keys, look with the mouse, and hold Shift to move faster.
- Up/down move forward and backward; left/right turn.
- The tour identifies the nearest labeled place while walking.

Scope and assumptions:
- No people or human figures are included.
- The main experience begins inside the building as a first-person tour.
- Event furnishings follow the supplied sketch: check-in, sponsor booths, food stations, hacking tables, workshops, networking tables, and restroom wayfinding.
- Two stories, approximately 4 m floor-to-floor.
- Footprints and room relationships are inferred from the supplied event maps.
- Exterior glazing, entrance canopy, patios, stairs, rails, and simple furnishings are conceptual.
- The source maps contain no scale, elevations, structural drawings, or complete door/window schedule; this is not suitable for construction or code review.
