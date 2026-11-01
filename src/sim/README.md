# src/sim — plant model

`ReactorSim` (implements `ReactorSimApi`) is a self-contained, deterministic model of a
4-loop Westinghouse-style PWR (3411 MWt, ~1150 MWe gross). It has no DOM/Three.js
dependencies. Call `update(realDt)` once per frame: it multiplies by `controls.timeScale`
and integrates in fixed 0.05 s steps, up to 1200 steps per call. `state` is republished every 0.25 s of plant time.
Every accident is the result of the physics. Nothing is scripted.

## Files
| file | contents |
|---|---|
| `ReactorSim.ts` | the plant: step order, thermal-hydraulics, secondary, CVCS/ECCS, containment, damage, publish |
| `kinetics.ts` | 6-group point kinetics (backward Euler), source; 8-group decay heat; I/Xe/Pm/Sm |
| `rods.ts` | bank worths, S-curve integral worth, overlap sequence (CA→CB→CC→CD, 100-step overlap) |
| `rps.ts` | RPS trips, permissives P-6…P-13, rod stops C-1…C-5, ESFAS (SI, MSIV, FW isolation), `SETPOINTS` |
| `alarms.ts` | annunciators (ack/reset, `alarm` events), `ALARM_LABELS` |
| `faults.ts` | `FaultManager`: every `FaultId` acts on physics; random faults (first after 5–10 min, then every 10–25 min) |
| `steam.ts`, `steamTables.ts` | IAPWS-IF97 saturation/liquid tables, `props(h,P)`, rigid-container equilibrium solver |
| `plant.ts` | design constants. `scenarios.ts`: initial-condition specs. `describe.ts`: `describeTrip` and `describeFault` |

## Model summary
- **Neutronics**: point kinetics with 6 delayed groups (β = 0.0065, Λ = 20 µs) and a neutron source for subcritical multiplication. The model has rods, boron (−10 pcm/ppm), Doppler (√T), a moderator coefficient that depends on boron and temperature (≈ −24 pcm/°F at 0 ppm, less negative at high boron), a void coefficient, and Xe/Sm. The instruments are source range (cps), intermediate range (A), power range (%), and SUR (dpm).
- **Primary system**: 19 nodes (upper and lower plenum, core, and hot leg / two SG tube halves / cold leg per loop) with upwind enthalpy and boron transport. The flow network uses RCP head and coastdown, natural-circulation buoyancy, a locked-rotor reverse resistance, a voided-pump head loss, and U-tube steam blocking. The pressurizer is a two-phase container in equilibrium with the loop volume (it can go solid or dry). It has heaters, spray, PORVs with a block valve, code safeties, and a PRT with a rupture disk.
- **Core**: two radial/axial regions with fuel and clad temperatures. Heat transfer to coolant covers forced convection, nucleate boiling, film boiling, and steam cooling when uncovered. The model also has DNBR, Zr–steam oxidation (Baker–Just) with hydrogen, clad burst, and fuel melting.
- **Secondary**: each SG is a rigid two-phase/superheated container. Level is narrow/wide range with shrink and swell. The plant has ARVs, SG safety valves, MSIVs, a steam header, turbine and generator (roll, sync, load ramp, MW control), condenser vacuum, steam dumps (Tavg / pressure / plant-trip modes, C-9 interlock), MFPs with 3-element level control, and AFW with auto-start.
- **CVCS/ECCS**: charging with level-program PI, letdown, VCT boron, dilute/borate batches, HPSI/LPSI head curves, accumulators (600 psig), and RWST at 2500 ppm.
- **Containment**: steam + air + H₂ with wall heat sinks, fan coolers, sprays (HI-3), and hydrogen burns. Overpressure damages integrity.
- **Catastrophes** (`state.catastrophe`): meltdown, steam explosion, vessel rupture, turbine missile, and containment failure. Each one is triggered by physical thresholds, never by a timer.

## Units
Internally the model uses MPa abs, °C, kg, kJ and kW. `PlantState` publishes psig, °F, %, gpm, MWe, and fractions of rated power, as documented in `types.ts`. Optional additional readouts are in `state.ext` (see `PlantExt`).

## Key setpoints (`rps.ts → SETPOINTS`)
| function | setpoint |
|---|---|
| PR high flux hi / lo (lo blocked above P-10) | 109 % / 25 % |
| PR positive rate | +5 % in ~2 s |
| IR high flux / SR high flux (blocked above P-6) | 25 % equiv. (5e-5 A) / 1e5 cps |
| Startup rate (below P-10) | 5 dpm |
| OTΔT / OPΔT | K1 1.15, K2 0.0182, K3 0.00083 / K4 1.09, K5 0.2, K6 0.0015 |
| PZR pressure low (above P-7) / high | 1865 / 2385 psig |
| PZR level high (above P-7) | 92 % |
| RCS low flow | 90 % (1 loop above P-8, 2 loops P-7..P-8) |
| SG level lo-lo | 17 % NR |
| Turbine trip → reactor trip | above P-9 (50 %) |
| SI | PZR 1807 psig (blockable below P-11 = 1915 psig), steam line 600 psig, containment 3.5 psig |
| MSIV closure / containment spray | containment 18 / 28 psig |
| P-6 / P-10 / P-8 / P-9 | 1e-10 A / 10 % / 48 % / 50 % |
| PORV / PZR safeties / SG ARV / SG safeties | 2335 / 2485 / 1125 / 1185 psig |
| Tavg program | 557 °F at 0 % → 584.7 °F at 100 % (Tref from turbine load) |

## Startup from hot standby (`hot-standby` scenario)
The scenario starts at 557 °F and 2235 psig. Shutdown banks are out and control banks are in. The plant has been xenon-free for 110 hours. The estimated critical position (ECP) is CD ≈ 130 steps.
1. Leave rods in **manual** with `rodBankSelect = 'MANUAL_SEQ'`. Steam dumps stay in **pressure** mode (1092 psig). One MFP is running with feed in auto.
2. Withdraw control banks in sequence (hold `rodMotion = +1`). Watch the source range rise. Between pulls, plot **1/M** (initial counts divided by current counts). Extrapolate it to zero to predict the critical rod position. If the ECP is far off, dilute (`makeupMode = 'dilute'`) or borate.
3. Near criticality, withdraw in small increments. The reactor is critical when counts keep rising at a steady positive SUR with the rods stopped. Keep SUR below about **1 dpm**. The **startup-rate trip** acts at 5 dpm.
4. Above P-6 (IR > 1e-10 A) the source-range trip is blocked automatically. Stabilize at IR ≈ 1e-8 A, then raise power slowly to **the point of adding heat** (~1–3 %). There, Tavg starts to rise and the steam dumps begin to open.
5. Raise power to ~5–8 %. Press `TURBINE_LATCH`. The turbine rolls at 300 rpm/min to 1800 rpm. When it is at speed (±8 rpm), press `GEN_BREAKER_CLOSE`. Set `turbineLoadSetpointMW` and a ramp rate (≤ 5 %/min ≈ 50 MW/min while learning). As steam demand rises, pull rods to keep Tavg on the Tref program.
6. Above 10 % (P-10) the low-power trips block. Start the second MFP before ~50 % load. Above **15 % turbine load** (C-5) rods may go to **auto**. Borate or dilute to keep control bank D in its band above the insertion limit. That limit is enforced by the ROD INSERTION LIM LO and LO-LO alarms. The adjustment compensates for the power defect and, later, for xenon.
7. Watch out for these: xenon builds after any power change (`xenon-challenge`), SG shrink/swell on fast load changes, and OTΔT/OPΔT runbacks.

## Tests
`npx vitest run src/sim` covers these cases:
- every scenario is steady for 10 sim-minutes with no trip
- a manual trip drops power below 5 % within seconds, and decay heat follows
- rod withdrawal from hot standby reaches criticality
- a stuck-open PORV leads to SI
- a total loss of feedwater with no AFW leads to fuel damage
- no NaN at timeScale 30
- alarm labels are at most 24 characters and uppercase
