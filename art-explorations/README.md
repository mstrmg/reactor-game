# Art style explorations (not game code)

13 hypothetical art directions for the first-person PWR control room, rendered from one shared mock scene.
Nothing here is used by the game.

- `src/scene.js`: mock control room geometry (horseshoe benchboard, annunciators, meters, recorders, desk, chair)
- `src/textures.js`: canvas-drawn instrument faces (annunciators, dials, edgewise meters, strip charts, rod map, mimic, screens)
- `src/styles.js`: one entry per style (materials, palette, lights, post-processing)
- `src/glow.js`: separable gaussian glow pass (UnrealBloomPass produced a full-frame haze under headless SwiftShader)
- `shots/`: JPEG screenshots

Run: serve this folder next to a `node_modules/three` (e.g. `npx http-server -p 8123` from a dir with three installed),
open `index.html?style=analog70s`, or run `node shoot.mjs analog70s crt ...` to capture PNGs.
Styles: analog70s eastern modern emergency atompunk brutalist lowpoly toon clay ps1 dither crt blueprint
