# CRITICAL — PWR Control Room

A first-person browser game set in the control room of a 4-loop pressurized water reactor (3411 MWt / ~1150 MWe). Built with Three.js, TypeScript, Vite and Tone.js.

Nothing is scripted. Point kinetics with 6 delayed-neutron groups, xenon/iodine, boron, Doppler and moderator feedback, decay heat, loop thermal-hydraulics, pressurizer, steam generators, turbine/generator and a reactor protection system with real-style setpoints and permissives all run continuously. Meltdowns, steam explosions, vessel ruptures, containment failure and turbine missiles happen only when the physics gets there.

## Run

```
npm install
npm run dev      # http://localhost:5173
npm test         # simulation tests
npm run build
```

## Controls (keyboard + mouse)

| Input | Action |
| --- | --- |
| Mouse | Look |
| WASD / arrows, Shift | Walk, walk faster |
| Left click / E | Press button, turn switch clockwise, knob up |
| Right click / R | Turn switch counter-clockwise, knob down |
| Mouse wheel (Shift = coarse) | Turn knob / switch under the crosshair |
| Hold LMB / RMB on rod lever | Withdraw / insert rods |
| F or Q | Zoom in to read gauges |
| `[` `]` | Time compression 1×–30× |
| Tab | Startup procedure binder (auto-ticks) |
| L | Logbook and reactivity balance |
| H / F1 | Controls sheet |
| P / Esc | Pause |
| M | Mute |

## Layout

- `src/sim` — plant physics (see `src/sim/README.md` for the model and the startup procedure)
- `src/world` — 3D control room, instruments, interaction
- `src/ui` — title, HUD, procedures, pause, game-over overlays
- `src/audio` — fully synthesized sound (alarms, source-range speaker, turbine, rods)
- `src/sim/types.ts` — the shared contract between modules
