# New controls and indications (balance of plant extension)

This file lists every new control, button and indication the sim provides, for building the board hardware.
- **Controls** are new optional fields on `PlantControls`. The sim always fills them in. Panels read and write them like the existing controls.
- **Buttons** are new `ButtonId`s for `sim.press(id)`.
- **Indications** live under `state.bop` (`BopState` in `types.ts`).
- **Alarms** are new annunciator ids. Each has a fix guide in `alarmHelp.ts`.

## Controls (`sim.controls.*`)
| id | type | board section | what it does |
|---|---|---|---|
| `circWaterPumps[0..2]` | 3 × ON/OFF switch | FEEDWATER & STEAM DUMP | Circulating water pumps that cool the condenser (non-safety bus, needs offsite power). Vacuum needs at least 1 pump. Run 3 above ~60 % load. With none running and steam going to the condenser, vacuum collapses in seconds. |
| `condenserAirRemoval` | 3-position selector OFF / HOGGING / SJAE | FEEDWATER & STEAM DUMP | **HOGGING** mechanical pumps pull vacuum from 0 to ~20 in.Hg in ~10–15 min. **SJAE** steam jet air ejectors hold 28+ in.Hg and need steam (header > ~150 psig), but are very slow below ~18 in.Hg. Normal sequence: hog, then switch to SJAE. |
| `condensatePumps[0..2]` | 3 × ON/OFF switch | FEEDWATER & STEAM DUMP | Supply suction to the main feed pumps. Each carries ~60 % of full feed flow. An MFP cannot start without one. MFPs trip on suction below 100 psig after ~15 s. At 100 % power, 2 pumps give a low-suction alarm, so run 3. |
| `feedwaterHeaters` | ON/OFF switch | FEEDWATER & STEAM DUMP | Extraction-steam feedwater heaters. They are only effective with the generator on line above ~8 % load. Out of service, feedwater is cold, so thermal power runs higher than electrical output (risk of overpower). |
| `turbineSpeedSetpointRpm` | knob 0–1830 rpm (detents at 0, 500, 1800) | TURBINE/GENERATOR | Speed target while the turbine is latched and the breaker is open. Warm up at 500 rpm. Never hold speed in 1000–1300 rpm (critical band). Set 1801–1803 rpm to make the synchroscope turn slowly. |
| `turbineAccelRpmPerMin` | knob 20–400 rpm/min | TURBINE/GENERATOR | Acceleration rate. Use ≥ 300 rpm/min through the critical band. |
| `turningGear` | ENGAGE/DISENGAGE switch | TURBINE/GENERATOR | Keeps the stopped rotor turning at ~3 rpm. If it is disengaged while stopped, the rotor bows over ~40 min (eccentricity) and vibrates when rolled. It disengages automatically when the turbine rolls. |
| `genVoltageSetpointKv` | knob 18–26 kV | TURBINE/GENERATOR | Voltage regulator (AVR) setpoint. Off line it sets terminal voltage, which must match grid kV within 5 % to synchronise. On line it sets MVAR (~300 MVAR per kV above grid). |
| `sealInjectionGpm` | knob 0–40 gpm (normal 32) | CVCS/BORON | Total RCP seal injection (8 gpm per pump keeps the seals cool). Seals overheat if this is < 20 gpm AND there is no CCW to the thermal barriers. An RCP will not start without either. |
| `ccwPumps[0..1]` | 2 × ON/OFF switch | SAFETY & ELECTRICAL | Component cooling water (safety bus, runs on the diesels). Cools RCP bearings, thermal barriers and the letdown HX. Normally 1 runs and 1 is in standby. **The standby pump does not auto-start (except on SI).** |
| `serviceWaterPumps[0..1]` | 2 × ON/OFF switch | SAFETY & ELECTRICAL | Cools the CCW heat exchangers. With none running, CCW temperature climbs. |
| `makeupBatchGallons` | thumbwheel / knob 0–5000 gal | CVCS/BORON | Batch integrator setpoint. When > 0, DILUTE/BORATE flow only runs after MAKEUP BATCH START and stops by itself when the batch is delivered (makeup returns to AUTO). 0 means legacy continuous mode. |
| `sgArvSetpointPsig` | knob 1000–1200 psig (normal 1125) | STEAM GENERATORS | Pressure setpoint of all four SG atmospheric relief valves. At hot standby (no vacuum) it is 1085, so the ARVs carry decay heat. Raise it to 1125 once the condenser steam dumps are available. |

## Buttons (`sim.press(id)`)
| id | type | board section | what it does |
|---|---|---|---|
| `GEN_FIELD_CLOSE` / `GEN_FIELD_OPEN` | pushbutton pair with red/green lamps | TURBINE/GENERATOR | Generator field breaker (excitation). Close only above 1700 rpm. Opening it with the breaker closed trips the generator (loss of field). |
| `HOUSE_XFER_UAT` / `HOUSE_XFER_SAT` | pushbutton pair with lamps | SAFETY & ELECTRICAL | Moves plant auxiliary loads between the unit auxiliary transformer and the startup transformer. Transfer to UAT needs the generator on line. On a generator trip the loads fast-transfer back to SAT automatically. |
| `MAKEUP_BATCH_START` / `MAKEUP_BATCH_STOP` | pushbuttons | CVCS/BORON | Start or stop the dilute/borate batch (select the makeup mode and batch size first). |
| `MSIV_CLOSE_0..3` / `MSIV_OPEN_0..3` | 4 pushbutton pairs with lamps | STEAM GENERATORS | Individual main steam isolation valves. Opening is blocked while a steam-line isolation signal is present or with > 100 psi across the valve. |

The existing `GEN_BREAKER_CLOSE` now also requires the field breaker to be closed. If the synchroscope is more than ~12° from 12 o'clock or voltage differs by more than 5 %, the close **damages the generator**. Protection then trips the unit, and a large error destroys the stator. `TURBINE_LATCH` no longer rolls to 1800 rpm on its own: the turbine follows `turbineSpeedSetpointRpm`.

## Indications (`state.bop`)
| path | type | board section | meaning |
|---|---|---|---|
| `circWaterRunning[3]`, `condensateRunning[3]` | run lamps | FEEDWATER & STEAM DUMP | pump status |
| `condenserAirRemoval` | lamp per position | FEEDWATER & STEAM DUMP | air removal in service |
| `hotwellLevelPct` | meter 0–100 % | FEEDWATER & STEAM DUMP | condenser hotwell level (condensate pumps trip < 5 %) |
| `mfpSuctionPsig` | meter 0–400 psig | FEEDWATER & STEAM DUMP | MFP suction pressure |
| `feedwaterTempF`, `feedwaterHeatersInService` | meter 0–500 °F + lamp | FEEDWATER & STEAM DUMP | final feedwater temperature |
| `turbine.speedSetpointRpm` | digital | TURBINE/GENERATOR | speed target |
| `turbine.rotorTempF`, `turbine.steamInletTempF` | 2 meters 0–700 °F | TURBINE/GENERATOR | warm-up: roll to 1800 only when the rotor is within ~120 °F of the steam |
| `turbine.diffExpansionPct` | meter 0–150 % (red > 60) | TURBINE/GENERATOR | rotor/casing differential expansion |
| `turbine.vibrationMils` | meter 0–20 mils (alarm 7, trip 14) | TURBINE/GENERATOR | bearing vibration |
| `turbine.eccentricityMils` | meter 0–7 mils | TURBINE/GENERATOR | rotor bow |
| `turbine.turningGearEngaged`, `turbine.inCriticalBand` | lamps | TURBINE/GENERATOR | |
| `generator.fieldBreakerClosed` | lamp | TURBINE/GENERATOR | |
| `generator.terminalKv`, `generator.gridKv` | 2 meters 0–30 kV (side by side) | TURBINE/GENERATOR | voltage matching |
| `generator.slipHz` | meter −0.5…+0.5 Hz | TURBINE/GENERATOR | incoming − running frequency |
| `generator.syncPhaseDeg` | **synchroscope** dial (−180…180, 0 = 12 o'clock) | TURBINE/GENERATOR | rotates clockwise when the generator is fast |
| `generator.mvar`, `generator.powerFactor` | meters ±600 MVAR, PF | TURBINE/GENERATOR | |
| `generator.netMWe` | digital | TURBINE/GENERATOR | gross − house loads |
| `generator.damage` | lamp "GEN PROTECTION" (> 0) | TURBINE/GENERATOR | |
| `electrical.houseLoadsOn` | 2 lamps SAT / UAT | SAFETY & ELECTRICAL | |
| `electrical.houseLoadMW` | meter 0–100 MW | SAFETY & ELECTRICAL | |
| `electrical.safetyBusesEnergised[2]` | lamps | SAFETY & ELECTRICAL | |
| `electrical.dieselLoadPct[2]` | 2 meters 0–150 % | SAFETY & ELECTRICAL | |
| `ccw.pumpsRunning[2]`, `ccw.serviceWaterRunning[2]` | run lamps | SAFETY & ELECTRICAL | |
| `ccw.supplyTempF` | meter 50–200 °F (alarm 105) | SAFETY & ELECTRICAL | |
| `ccw.flowPct` | meter 0–200 % | SAFETY & ELECTRICAL | |
| `rcpAux.bearingTempF[4]` | 4 meters 50–300 °F (alarm 195, failure ~230) | RCS/RCPs | |
| `rcpAux.sealTempF[4]`, `rcpAux.sealLeakoffGpm[4]` | 4 + 4 meters (0–600 °F; 0–50 gpm, log above) | RCS/RCPs | #1 seal condition |
| `rcpAux.sealInjectionGpm` | meter 0–40 gpm | CVCS/BORON | |
| `rcpAux.seized[4]` | lamps | RCS/RCPs | bearing failed / locked rotor |
| `letdownHxOutletTempF` | meter 50–300 °F (alarm 145) | CVCS/BORON | |
| `makeupBatch.{active,targetGal,deliveredGal}` | lamp + 2 digital counters | CVCS/BORON | batch integrator |
| `sgArvSetpointPsig` | digital | STEAM GENERATORS | ARV setpoint |

## New alarms (all have entries in `ALARM_HELP`)
`CW_FLOW_LO`, `HOTWELL_LEVEL`, `MFP_SUCTION_LO`, `FW_HTRS_OOS`, `TURB_ECCENTRIC`, `TURB_DIFF_EXP`, `TURB_CRIT_SPEED`,
`TURN_GEAR_OFF`, `GEN_FIELD_OFF`, `GEN_PROTECTION`, `GEN_MVAR`, `HOUSE_ON_SAT`, `CCW_FLOW_LO`, `CCW_TEMP_HI`,
`SW_FLOW_LO`, `SEAL_INJ_LO`, `LD_HX_TEMP_HI`, `MAKEUP_BATCH`, `DG_OVERLOAD`, `RCP1..4_BRG_TEMP`, `RCP1..4_SEAL`.

## New faults
- `CCW_PUMP_TRIP`: running CCW pumps trip and the standby does not auto-start.
- `CIRC_WATER_PUMP_TRIP`: one CW pump trips.
- `CONDENSATE_PUMP_TRIP`: one condensate pump trips.
