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
| `bop.ts` | balance of plant: CW and condenser vacuum, condensate and MFP suction, FW heaters, turbine warm-up and vibration, generator excitation and synchroscope, house loads, CCW/SW, RCP bearings and seals, letdown HX, batch integrator |
| `alarmHelp.ts` | `ALARM_HELP` fix guide for every annunciator |
| `startupScript.ts` | `scriptedStartup()`: automated hot-standby → on-line sequence (tests) |
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
**Initial state.**
- **Reactor.** 557 °F and 2235 psig. Shutdown banks are out and control banks are in. The plant has been xenon-free for 110 h. The ECP is CD ≈ 130 steps.
- **Secondary.** It is shut down: no circulating water, no vacuum, and condensate and main feed pumps are off. The motor-driven AFW pumps feed the SGs, and the SG ARVs (setpoint 1085 psig) carry decay heat.
- **Turbine and electrical.** The turbine is on the turning gear with a cold rotor (~200 °F). The generator is not excited, and house loads are on the startup transformer (SAT).

1. **Condenser.** Start the circulating water pumps. Put air removal on **HOGGING**. At ~19 in.Hg switch to **SJAE**. Above 22 in.Hg the steam dumps are available (C-9). Raise the **SG ARV setpoint** to 1125 psig so the dumps (pressure mode, 1092 psig) take the heat.
2. **Feedwater.** Start two **condensate pumps**. Once MFP suction pressure exceeds ~250 psig, start **MFP A** with feed valves in AUTO. Then put the AFW pumps to OFF/AUTO (the AFW→MFW transfer).
3. **Reactor to critical.** Rods stay in MANUAL, `MANUAL_SEQ`. Withdraw control banks and track **1/M**. Dilute or borate if the ECP is far off; with a batch set, use the batch integrator and MAKEUP BATCH START. Keep SUR ≤ 1 dpm (the trip is at 5 dpm). Stabilise at IR ≈ 1e-8 A above P-6, then raise power to the point of adding heat and on to ~3–8 %.
4. **Turbine warm-up.** Make sure the turning gear is engaged, so eccentricity is normal. Set SPEED TARGET 500 rpm at 200 rpm/min and press TURBINE LATCH. Soak at 500 rpm until rotor temperature is within ~120 °F of steam temperature (~30–40 min), watching differential expansion.
5. **Roll to speed.** Set the speed target to 1800 rpm with ≥ 300 rpm/min so the rotor passes quickly through the **1000–1300 rpm critical band**. Vibration trips the turbine at 14 mils.
6. **Excite and synchronise.**
   - Close the **FIELD BREAKER** and set the voltage setpoint so terminal kV = grid kV.
   - Set the speed target to ~1801.5 rpm so the **synchroscope** turns slowly clockwise.
   - Close the **generator breaker** with the needle within ±10° of 12 o'clock.

   An out-of-phase close damages the generator and trips the unit.
7. **After synchronising.**
   - Transfer **house loads to UAT**. Put the **feedwater heaters** in service and the steam dumps in **TAVG** mode.
   - Load at a few %/min, holding Tavg = Tref with rods. Above 15 % load (C-5) rods may go to AUTO.
   - Start the second MFP before ~50 % load and the third condensate pump and third CW pump before ~90 %.
   - Dilute (batch) for power defect and xenon while keeping control bank D above the insertion limit.
8. **Hazards.**
   - Losing a CCW pump: start the standby pump before RCP bearings reach ~230 °F. Stop an RCP whose bearing exceeds 195 °F.
   - Low seal injection without CCW causes RCP seal failure, which is a small LOCA.
   - Taking feedwater heaters out at power adds thermal power for the same load.

`src/sim/startupScript.ts` (`scriptedStartup`) performs this whole sequence automatically. The tests use it.

The **low-power** scenario is partly lined up: 2 CW pumps, vacuum on SJAE, 2 condensate pumps, MFP A, turbine on the turning gear with a lukewarm rotor, field open and house loads on SAT. **full-power** and **xenon-challenge** are fully lined up: 3 CW, 3 condensate, 2 MFPs, heaters in service, house on UAT, 1 CCW and 1 SW pump with their partners in standby.

## Tests
`npx vitest run src/sim` covers these cases:
- every scenario is steady for 10 sim-minutes with no trip
- a manual trip drops power below 5 % within seconds, and decay heat follows
- rod withdrawal from hot standby reaches criticality
- a stuck-open PORV leads to SI
- a total loss of feedwater with no AFW leads to fuel damage
- no NaN at timeScale 30
- alarm labels are at most 24 characters and uppercase
- every alarm has a fix guide
- a scripted hot-standby lineup and synchronisation succeeds
- an out-of-phase breaker close damages and trips the generator
- loss of CCW ends in an RCP bearing seizure and a reactor trip
- the batch integrator stops a dilution by itself
