/**
 * Operator fix guide for every annunciator window (shown by the UI when the player presses E).
 * Board sections: SAFETY & ELECTRICAL, CVCS/BORON, PRESSURIZER, RCS/RCPs, REACTOR CONTROL,
 * NUCLEAR INSTRUMENTATION, PLANT COMPUTER, STEAM GENERATORS, FEEDWATER & STEAM DUMP, TURBINE/GENERATOR.
 */
export interface AlarmHelp { meaning: string; causes: string[]; actions: string[] }

const H: Record<string, AlarmHelp> = {
  RX_TRIP: {
    meaning: 'The reactor trip breakers are open and all rods have dropped into the core. Fission has stopped; only decay heat remains.',
    causes: ['An automatic protection trip (see the first-out on the PLANT COMPUTER)', 'Manual REACTOR TRIP button', 'Safety injection actuation'],
    actions: [
      'Verify all rod bottom lights and neutron power falling (NUCLEAR INSTRUMENTATION).',
      'Verify turbine tripped and generator breaker open (TURBINE/GENERATOR).',
      'Check SG levels are recovering — AFW should auto-start (FEEDWATER & STEAM DUMP).',
      'Verify Tavg settling near 557 °F on the steam dumps; borate if it keeps falling (CVCS/BORON).',
      'When the cause is fixed and no trip signal remains, press TRIP RESET (SAFETY & ELECTRICAL).',
    ],
  },
  TURB_TRIP: {
    meaning: 'The main turbine stop valves are shut. No steam goes to the turbine; the generator breaker opens.',
    causes: ['Reactor trip (P-4)', 'Low condenser vacuum', 'Turbine overspeed or high vibration', 'Spurious EHC fault', 'Manual TURBINE TRIP'],
    actions: [
      'Above 50 % power (P-9) this also trips the reactor — follow REACTOR TRIP actions.',
      'Below P-9, the steam dumps take the load: check STEAM DUMP mode is TAVG (FEEDWATER & STEAM DUMP).',
      'Insert rods / reduce power so Tavg returns to program (REACTOR CONTROL).',
      'Fix the cause, then press TURBINE LATCH and roll the turbine again (TURBINE/GENERATOR).',
    ],
  },
  SI_ACT: {
    meaning: 'Safety injection is running: high-head pumps inject borated RWST water, the reactor and feedwater are tripped/isolated and the diesels start.',
    causes: ['Pressurizer pressure below 1807 psig', 'Steam line pressure below 600 psig', 'Containment pressure above 3.5 psig', 'Manual SI ACTUATE'],
    actions: [
      'Verify reactor tripped, diesels running, SI flow indicated (SAFETY & ELECTRICAL).',
      'Find the leak: watch containment pressure, PRT, steam line pressures, SG levels.',
      'Keep AFW feeding the SGs (FEEDWATER & STEAM DUMP); isolate a faulted SG.',
      'When pressure and pressurizer level recover and subcooling > 20 °F, SI may be reset after 60 s (SI RESET).',
      'Do not stop SI while subcooling is low or RVLIS shows core level falling.',
    ],
  },
  PZR_PRESS_HI: {
    meaning: 'Pressurizer pressure is above 2310 psig. At 2335 the PORVs open; at 2385 the reactor trips.',
    causes: ['Loss of heat sink (feedwater or turbine load lost)', 'Heaters stuck on', 'Spray not working (RCPs 1/2 off, spray in manual)', 'Insurge from an RCS heat-up'],
    actions: [
      'Check spray valves are in AUTO and opening (PRESSURIZER).',
      'Turn backup heaters to OFF or AUTO (PRESSURIZER).',
      'Restore heat removal: feedwater, steam dumps (FEEDWATER & STEAM DUMP).',
      'Reduce reactor power if Tavg is rising (REACTOR CONTROL).',
    ],
  },
  PZR_PRESS_LO: {
    meaning: 'Pressurizer pressure is below 2210 psig. At 1865 psig the reactor trips; at 1807 psig safety injection starts.',
    causes: ['Spray valve stuck open', 'PORV open or leaking', 'RCS leak / LOCA', 'Heaters off (low level or switched off)', 'Overcooling (steam dumps, steam leak)'],
    actions: [
      'Check PORVs closed; if one is stuck open, CLOSE its BLOCK VALVE (PRESSURIZER).',
      'Put spray in MANUAL and close it if it is stuck open (PRESSURIZER).',
      'Turn backup heaters ON (PRESSURIZER).',
      'Look for a leak: charging vs letdown, containment pressure, RCS LEAKAGE (CVCS/BORON).',
    ],
  },
  PZR_PRESS_LOLO: {
    meaning: 'Pressurizer pressure is below the 1807 psig safety-injection setpoint.',
    causes: ['LOCA', 'Stuck-open PORV or safety valve', 'Large overcooling (steam line break)'],
    actions: [
      'Verify SI actuated (SAFETY & ELECTRICAL); actuate it manually if not.',
      'Close the PORV block valve if a PORV is open (PRESSURIZER).',
      'Follow SAFETY INJECTION actions.',
    ],
  },
  PZR_LEVEL_HI: {
    meaning: 'Pressurizer water level is above 70 %. At 92 % (above P-7) the reactor trips — a solid pressurizer can lift the safety valves with water.',
    causes: ['Charging greater than letdown (charging in manual)', 'RCS heat-up (insurge)', 'Safety injection flow'],
    actions: [
      'Put charging in AUTO or reduce CHARGING FLOW demand (CVCS/BORON).',
      'Verify letdown is in service (LETDOWN ISOLATED switch off) (CVCS/BORON).',
      'Stop the RCS heat-up: restore feedwater / reduce power.',
    ],
  },
  PZR_LEVEL_LO: {
    meaning: 'Pressurizer level is below 17 %: letdown isolates and heaters trip off to protect them.',
    causes: ['RCS leak or LOCA', 'Letdown greater than charging', 'Cooldown (outsurge) after a trip or overcooling'],
    actions: [
      'Raise CHARGING FLOW (manual) or check charging is in AUTO (CVCS/BORON).',
      'Look for a leak (RCS LEAKAGE, containment pressure, PRT).',
      'Stop overcooling: check steam dumps and feedwater (FEEDWATER & STEAM DUMP).',
      'Once level is above 17 %, put letdown back in service (CVCS/BORON).',
    ],
  },
  PZR_LEVEL_DEV: {
    meaning: 'Pressurizer level is more than 5 % away from its programmed level (25 % at no load → 61.5 % at full power).',
    causes: ['Charging in manual', 'Tavg change in progress', 'Small leak'],
    actions: ['Put charging in AUTO (CVCS/BORON).', 'Check Tavg is on program (REACTOR CONTROL).'],
  },
  PZR_PORV_OPEN: {
    meaning: 'A pressurizer power-operated relief valve is open, discharging steam to the relief tank (PRT).',
    causes: ['Pressure above 2335 psig (normal relief)', 'PORV stuck open (fault)', 'PORV switch in OPEN'],
    actions: [
      'If pressure is below 2315 psig and the PORV is still open, CLOSE its BLOCK VALVE (PRESSURIZER).',
      'Put the PORV switch in AUTO or CLOSED (PRESSURIZER).',
      'Watch PRT pressure/temperature — the rupture disk bursts if relief continues.',
    ],
  },
  PZR_SAFETY_OPEN: {
    meaning: 'A pressurizer code safety valve has lifted (2485 psig). The RCS was over-pressurised.',
    causes: ['Total loss of heat sink with PORVs blocked or failed', 'Water-solid pressurizer heat-up'],
    actions: ['Trip the reactor if not tripped.', 'Restore heat removal (feed SGs, steam dumps).', 'Open PORVs / block valves to relieve pressure (PRESSURIZER).'],
  },
  PRT_HI: {
    meaning: 'The pressurizer relief tank is hot or pressurised from relief valve discharge. Its rupture disk will burst into containment.',
    causes: ['PORV or safety valve discharging'],
    actions: ['Find and stop the open relief path — close the PORV BLOCK VALVE (PRESSURIZER).'],
  },
  PZR_HTR_OFF: {
    meaning: 'Pressurizer heaters are de-energised; pressure will drift down slowly.',
    causes: ['Heater switch OFF', 'Pressurizer level below 17 %', 'Loss of power to heater buses'],
    actions: ['Restore pressurizer level above 17 % (CVCS/BORON).', 'Set heaters to AUTO (PRESSURIZER).'],
  },
  TAVG_TREF_DEV: {
    meaning: 'Average coolant temperature differs from its programmed reference (557 °F at no load → 584.7 °F at full load) by more than 5 °F.',
    causes: ['Turbine load changed faster than rods / boron can follow', 'Rods in manual', 'Xenon or boron change'],
    actions: [
      'Tavg high: insert rods or borate (REACTOR CONTROL, CVCS/BORON). Tavg low: withdraw rods or dilute.',
      'Put rods in AUTO above 15 % load (REACTOR CONTROL).',
      'Slow the turbine ramp rate (TURBINE/GENERATOR).',
    ],
  },
  TAVG_LOLO: {
    meaning: 'Tavg is below 553 °F (P-12): steam dumps are blocked to stop further cooldown.',
    causes: ['Overcooling: steam dumps, ARVs, steam leak, too much AFW'],
    actions: ['Throttle AFW / feed flow (FEEDWATER & STEAM DUMP).', 'Check for a steam leak (steam line pressures).', 'Keep the reactor shut down; borate if needed (CVCS/BORON).'],
  },
  OTDT_STOP: {
    meaning: 'Overtemperature or overpower ΔT is close to its trip setpoint: rods are blocked from withdrawing and the turbine runs back.',
    causes: ['Power too high for current pressure / Tavg', 'Low pressurizer pressure', 'High Tavg'],
    actions: ['Reduce turbine load (TURBINE/GENERATOR).', 'Restore pressurizer pressure to 2235 psig (PRESSURIZER).', 'Insert rods to bring Tavg back to program (REACTOR CONTROL).'],
  },
  IR_ROD_STOP: {
    meaning: 'Intermediate range current is above the C-1 rod-stop setpoint; rod withdrawal is blocked.',
    causes: ['Power rising in the intermediate range without the P-10 permissive'],
    actions: ['Stop withdrawing rods (REACTOR CONTROL).', 'Let power stabilise; continue the power increase carefully once above P-10.'],
  },
  PR_ROD_STOP: {
    meaning: 'Power range flux is above 103 % (C-2): rod withdrawal blocked.',
    causes: ['Overpower from rod withdrawal, dilution or cooldown', 'A failed-high NI channel'],
    actions: ['Reduce power: insert rods or reduce turbine load (REACTOR CONTROL, TURBINE/GENERATOR).', 'Check the NI channels agree (NUCLEAR INSTRUMENTATION).'],
  },
  PR_HI: {
    meaning: 'Power range flux is high (above 103 %). The trip is at 109 %.',
    causes: ['Rod withdrawal, dilution or excess steam demand'],
    actions: ['Insert rods immediately (REACTOR CONTROL).', 'Reduce turbine load (TURBINE/GENERATOR).', 'Stop any dilution (CVCS/BORON).'],
  },
  SUR_HI: {
    meaning: 'Startup rate is above 1 decade per minute. At 5 DPM the reactor trips.',
    causes: ['Rods withdrawn too far / too fast near criticality', 'Dilution while critical', 'Cooldown adding positive reactivity'],
    actions: ['Stop rod withdrawal; insert a few steps until SUR < 1 DPM (REACTOR CONTROL).', 'Stop dilution (CVCS/BORON).'],
  },
  SR_HI_SHUTDOWN: {
    meaning: 'Source range counts have risen by a factor of ~5 while shut down — the core may be approaching criticality.',
    causes: ['Boron dilution', 'Cooldown with negative moderator coefficient', 'Rod withdrawal'],
    actions: ['Stop dilution; borate (CVCS/BORON).', 'Insert rods (REACTOR CONTROL).', 'Check shutdown margin (PLANT COMPUTER).'],
  },
  PR_CHANNEL_DEV: {
    meaning: 'The power range channels disagree by more than 2 %. One detector may have failed, or the flux is tilted.',
    causes: ['Failed NI channel', 'Dropped rod (quadrant tilt)'],
    actions: ['Compare NI channels and thermal power (NUCLEAR INSTRUMENTATION).', 'If a rod dropped, reduce power below 50 % (TURBINE/GENERATOR).', 'Do not use the failed channel for rod control decisions.'],
  },
  AXIAL_FLUX: {
    meaning: 'Axial flux difference (ΔI) is outside its target band — power is skewed to the top or bottom of the core.',
    causes: ['Control rods too deep (bottom-peaked → negative ΔI)', 'Xenon redistribution after a power change'],
    actions: [
      'ΔI too negative: withdraw rods and borate to compensate (REACTOR CONTROL, CVCS/BORON).',
      'ΔI too positive: insert rods and dilute to compensate.',
      'Avoid large, fast power changes while xenon is changing.',
    ],
  },
  ROD_BOTTOM: {
    meaning: 'A control rod is at the bottom of the core while the reactor is not tripped.',
    causes: ['Dropped rod (gripper failure)'],
    actions: ['Put rods in MANUAL (REACTOR CONTROL).', 'Reduce turbine load to below ~50 % (TURBINE/GENERATOR).', 'Trip the reactor if two or more rods dropped.'],
  },
  ROD_DEV: {
    meaning: 'A rod is out of step with the rest of its bank.',
    causes: ['Stuck rod', 'Dropped rod'],
    actions: ['Stop rod motion (REACTOR CONTROL).', 'Reduce power if the deviation is large; keep the stuck rod in mind for shutdown margin (PLANT COMPUTER).'],
  },
  RIL_LO: {
    meaning: 'Control banks are approaching the rod insertion limit for this power level.',
    causes: ['Rods inserted to compensate for boron / xenon / power changes'],
    actions: ['Dilute to let rods withdraw (CVCS/BORON: MAKEUP DILUTE, batch).', 'Reduce turbine load slowly if necessary.'],
  },
  RIL_LOLO: {
    meaning: 'Control banks are below the rod insertion limit: shutdown margin and power distribution limits may be violated.',
    causes: ['Rods driven in by auto rod control after a load reduction or xenon build-in'],
    actions: ['Borate immediately and/or reduce load until rods are above the limit (CVCS/BORON).', 'This is a Technical Specification violation — fix within minutes.'],
  },
  SDM_LO: {
    meaning: 'Shutdown margin is low: if tripped now, the reactor might not be far enough subcritical.',
    causes: ['Boron too low', 'Stuck rod', 'Cooldown'],
    actions: ['Borate (CVCS/BORON: MAKEUP BORATE).', 'Stop any cooldown (FEEDWATER & STEAM DUMP).'],
  },
  BORON_DILUTION: {
    meaning: 'A dilution (or boration) is in progress — the reactor reactivity is changing.',
    causes: ['MAKEUP mode DILUTE or BORATE selected'],
    actions: ['Watch Tavg / SUR while diluting (REACTOR CONTROL).', 'Return MAKEUP to AUTO when done (CVCS/BORON).'],
  },
  CHG_FLOW: {
    meaning: 'Charging flow is abnormally high or low.',
    causes: ['Pressurizer level control demanding maximum (leak)', 'Charging in manual at an extreme'],
    actions: ['Check pressurizer level trend and look for leakage (CVCS/BORON).', 'Return charging to AUTO.'],
  },
  LETDOWN_ISOL: {
    meaning: 'Letdown is isolated: no coolant leaves the RCS through the CVCS, so boron and level control are affected.',
    causes: ['Pressurizer level below 17 %', 'Operator isolated letdown', 'Safety injection'],
    actions: ['Restore pressurizer level above 17 %.', 'Put letdown back in service (CVCS/BORON: LETDOWN ISOLATE off).', 'Reduce charging to avoid overfilling meanwhile.'],
  },
  RCS_LEAK: {
    meaning: 'Unidentified RCS leakage is high: coolant is going somewhere it should not.',
    causes: ['Small LOCA', 'SG tube leak', 'Stuck-open PORV or spray valve', 'RCP seal leakage'],
    actions: [
      'Check containment pressure and radiation (SAFETY & ELECTRICAL).',
      'Check main steam radiation for a tube leak (STEAM GENERATORS).',
      'Check PORVs / block valves (PRESSURIZER).',
      'Raise charging to hold pressurizer level; if level cannot be held, trip and actuate SI.',
    ],
  },
  SUBCOOL_LO: {
    meaning: 'Core exit coolant is within 20 °F of boiling. Bubbles may form in the core and loops.',
    causes: ['Pressure falling (LOCA, PORV)', 'Temperature rising (loss of heat sink)'],
    actions: ['Restore pressure (PRESSURIZER) or remove heat (FEEDWATER & STEAM DUMP).', 'If subcooling is lost after SI, keep SI running; consider stopping RCPs if voiding is severe (RCS/RCPs).'],
  },
  CET_HI: {
    meaning: 'Core exit thermocouples read above 700 °F — the core is not being cooled adequately.',
    causes: ['Core uncovering', 'Loss of all heat removal'],
    actions: ['Ensure SI flow (SAFETY & ELECTRICAL).', 'Restore SG feed (AFW) and depressurise SGs with ARVs/dumps to cool the RCS (FEEDWATER & STEAM DUMP).', 'Open PORVs to allow SI to inject (PRESSURIZER).'],
  },
  INADEQ_CORE_COOL: {
    meaning: 'Core exit temperature is above 1200 °F — fuel damage is imminent or occurring.',
    causes: ['Core uncovered for a prolonged period'],
    actions: ['Maximise injection: SI pumps, open PORVs (feed and bleed).', 'Depressurise SGs to allow accumulator and low-head injection.', 'Restore any RCP only as a last resort.'],
  },
  DNBR_LO: {
    meaning: 'Departure-from-nucleate-boiling ratio is low: the hottest fuel rods are close to losing their water film.',
    causes: ['Power too high', 'RCS pressure low', 'Tavg high', 'Reduced RCS flow'],
    actions: ['Reduce power (REACTOR CONTROL / TURBINE/GENERATOR).', 'Restore pressure to 2235 psig (PRESSURIZER).', 'Restore flow (RCS/RCPs).'],
  },
  FUEL_FAILURE: {
    meaning: 'High radiation in the letdown line: fuel cladding has failed and fission products are in the coolant.',
    causes: ['Overheated core (uncovery, DNB)'],
    actions: ['Restore core cooling at all costs.', 'Keep containment isolated; do not vent.', 'Expect high radiation readings.'],
  },
  CNMT_PRESS_HI: {
    meaning: 'Containment pressure is above 1.5 psig. SI at 3.5 psig, MSIVs close at 18 psig, sprays at 28 psig.',
    causes: ['LOCA', 'Steam line break inside containment', 'PRT rupture disk burst'],
    actions: ['Identify the source (RCS vs steam).', 'Verify fan coolers running; sprays start automatically if needed (SAFETY & ELECTRICAL).'],
  },
  CNMT_RAD_HI: {
    meaning: 'Containment radiation is high.',
    causes: ['Reactor coolant leaking into containment', 'Fuel damage'],
    actions: ['Treat as a LOCA until proven otherwise; check RCS leakage and pressurizer level.'],
  },
  CNMT_SPRAY: {
    meaning: 'Containment spray is running to condense steam and limit containment pressure.',
    causes: ['Containment pressure above 28 psig'],
    actions: ['Verify containment pressure falling.', 'Stop the source of steam (isolate a faulted SG, close PORV block valve).'],
  },
  H2_HI: {
    meaning: 'Hydrogen in containment is above 4 % — it can burn.',
    causes: ['Zirconium–steam reaction in an overheated core'],
    actions: ['Restore core cooling to stop hydrogen generation.', 'Expect pressure spikes from burns; keep sprays available.'],
  },
  MS_RAD_HI: {
    meaning: 'Radiation detected in the main steam lines: reactor coolant is leaking through SG tubes.',
    causes: ['SG tube leak or rupture'],
    actions: [
      'Identify the faulted SG (rising level with less feed) (STEAM GENERATORS).',
      'Reduce power / trip; cool down using the intact SGs.',
      'Isolate the faulted SG: close its MSIV and stop its feed (STEAM GENERATORS, FEEDWATER & STEAM DUMP).',
      'Depressurise the RCS below the faulted SG pressure to stop the leak (PRESSURIZER).',
    ],
  },
  STEAMLINE_P_LO: {
    meaning: 'A steam line pressure is low (below 700 psig). At 600 psig safety injection starts.',
    causes: ['Steam line break', 'Excessive steam demand (dumps stuck open)'],
    actions: ['Find the depressurising SG; close its MSIV (STEAM GENERATORS).', 'Stop feed to the faulted SG.', 'Close steam dumps (FEEDWATER & STEAM DUMP).'],
  },
  MSIV_CLOSED: {
    meaning: 'One or more main steam isolation valves are closed — that SG cannot supply the turbine or dumps.',
    causes: ['Steam line isolation signal (SI on low steam pressure, containment HI-2)', 'Operator closure'],
    actions: ['Remove decay heat with the SG ARVs (STEAM GENERATORS).', 'When the cause is cleared, reopen the MSIVs (STEAM GENERATORS).'],
  },
  SG_PORV_OPEN: {
    meaning: 'An SG atmospheric relief valve or safety valve is open, releasing steam to the atmosphere.',
    causes: ['SG pressure above the ARV setpoint (1125 psig) — loss of steam dumps / turbine', 'MSIV closed'],
    actions: ['Restore the condenser steam dumps (vacuum, MSIVs) (FEEDWATER & STEAM DUMP).', 'Watch SG levels — steam released this way must be made up.'],
  },
  MFP_TRIP: {
    meaning: 'A main feedwater pump has stopped. One pump cannot feed more than ~60 % power.',
    causes: ['Pump fault', 'Loss of condensate / suction pressure', 'Feedwater isolation', 'Loss of power'],
    actions: [
      'Above ~60 % power reduce turbine load quickly to ~55 % (TURBINE/GENERATOR).',
      'Watch SG levels; AFW starts automatically on lo-lo level (FEEDWATER & STEAM DUMP).',
      'Restart the pump when the cause is cleared (FEEDWATER & STEAM DUMP: MFP A/B).',
    ],
  },
  FW_ISOL: {
    meaning: 'Main feedwater is isolated (pumps tripped, regulating valves shut). Only AFW can feed the SGs.',
    causes: ['Safety injection', 'SG level hi-hi (P-14)', 'Reactor trip with low Tavg'],
    actions: ['Verify AFW feeding all SGs (FEEDWATER & STEAM DUMP).', 'Reset SI / clear the hi-hi level before restoring main feed.'],
  },
  AFW_RUNNING: {
    meaning: 'One or more auxiliary feedwater pumps are running.',
    causes: ['SG lo-lo level', 'Loss of main feed pumps', 'Safety injection', 'Manual start'],
    actions: ['Verify SG levels recovering (STEAM GENERATORS).', 'Throttle AFW / put pumps in AUTO to avoid overcooling (FEEDWATER & STEAM DUMP).'],
  },
  STEAM_DUMP: {
    meaning: 'The condenser steam dumps are open, bypassing steam around the turbine.',
    causes: ['Turbine tripped or load rejected', 'Pressure-mode dumps holding no-load steam pressure'],
    actions: ['Normal after a trip or at low power. Check Tavg is stable near program (FEEDWATER & STEAM DUMP).'],
  },
  COND_VAC_LO: {
    meaning: 'Condenser vacuum is low. Below 22 in.Hg the steam dumps are blocked (C-9); below 20 in.Hg the turbine trips.',
    causes: ['Circulating water pumps stopped', 'Air removal (ejectors / vacuum pumps) not in service', 'Loss of offsite power', 'Too much steam to the condenser'],
    actions: ['Start circulating water pumps (FEEDWATER & STEAM DUMP).', 'Put condenser air removal in service (hogging pumps, then SJAEs).', 'Reduce load if vacuum keeps falling (TURBINE/GENERATOR).'],
  },
  GEN_OVERSPEED: {
    meaning: 'The turbine is overspeeding (> 1850 rpm).',
    causes: ['Load rejection with governor valves slow to close'],
    actions: ['Trip the turbine if speed exceeds 1980 rpm (TURBINE/GENERATOR).'],
  },
  TURB_VIB: {
    meaning: 'Turbine vibration is high — rubs, bowed rotor, water induction or rolling through the critical speed too slowly.',
    causes: ['Water carried over from SGs', 'Rolling a cold rotor too fast', 'Holding speed in the 1000–1300 rpm critical band', 'Rotor bowed (turning gear off)'],
    actions: ['Trip the turbine if vibration keeps rising (TURBINE/GENERATOR).', 'Lower SG levels if carry-over is suspected.', 'Next roll: warm up at 500 rpm and pass through the critical band quickly.'],
  },
  SG_CARRYOVER: {
    meaning: 'SG water level is so high that water droplets are carried into the steam lines — this damages the turbine.',
    causes: ['SG overfeeding (feed valve failed open, manual feed)', 'Swell during a fast load increase'],
    actions: ['Reduce feed flow to the high SG (FEEDWATER & STEAM DUMP).', 'Trip the turbine if level reaches hi-hi.'],
  },
  LOOP: {
    meaning: 'Offsite power is lost. RCPs, main feed pumps and circulating water stop; the diesels power the safety buses.',
    causes: ['Grid disturbance / switchyard fault'],
    actions: [
      'Verify reactor and turbine tripped and both diesels running (SAFETY & ELECTRICAL).',
      'Verify AFW feeding and natural circulation (core ΔT < 50 °F, CET falling).',
      'Use SG ARVs to remove decay heat (STEAM GENERATORS).',
    ],
  },
  DG_RUNNING: {
    meaning: 'An emergency diesel generator is running.',
    causes: ['Safety injection', 'Loss of offsite power', 'Bus undervoltage'],
    actions: ['Verify it is loaded and its bus is energised (SAFETY & ELECTRICAL).'],
  },
  ACCUM_INJ: {
    meaning: 'The cold-leg accumulators (600 psig nitrogen-pressurised tanks) are discharging into the RCS.',
    causes: ['RCS pressure below 600 psig — large LOCA or deliberate depressurisation'],
    actions: ['Verify SI flow; continue core cooling.'],
  },
  RCS_OVERPRESS: {
    meaning: 'RCS pressure is above the design limit — the pressure boundary may fail.',
    causes: ['Heat-up with relief valves blocked', 'Reactivity excursion'],
    actions: ['Open PORVs and block valves (PRESSURIZER).', 'Trip the reactor; restore heat removal.'],
  },
  VESSEL_LEVEL_LO: {
    meaning: 'Reactor vessel level (RVLIS) is low — steam is collecting above the core.',
    causes: ['LOCA, loss of inventory', 'Loss of heat sink (boil-off through PORV)'],
    actions: ['Maximise SI (SAFETY & ELECTRICAL).', 'Depressurise (PORVs, SG ARVs) so low-pressure injection can work.'],
  },
  P6: {
    meaning: 'Permissive P-6: intermediate range above 1E-10 A. The source range high-flux trip is blocked and the source range detectors de-energise.',
    causes: ['Normal during a reactor startup'],
    actions: ['Continue the startup using the intermediate range; keep SUR below 1 DPM (NUCLEAR INSTRUMENTATION).'],
  },
  P10: {
    meaning: 'Permissive P-10: power range above 10 %. Low-power trips (IR, PR low setpoint, startup rate) are blocked.',
    causes: ['Normal power ascension'],
    actions: ['None — information only. Above 15 % turbine load rods may go to AUTO.'],
  },
  SI_BLOCKED: {
    meaning: 'Low-pressurizer-pressure safety injection is blocked (allowed below P-11, 1915 psig).',
    causes: ['Operator blocked SI for a planned cooldown/depressurisation'],
    actions: ['Remember: a LOCA will now NOT start SI automatically on pressure. Unblock when the evolution is complete (SAFETY & ELECTRICAL).'],
  },
};

for (let n = 1; n <= 4; n++) {
  H[`SG${n}_LEVEL_LO`] = {
    meaning: `Steam generator ${n} narrow-range level is below 30 %. At 17 % the reactor trips and AFW starts.`,
    causes: ['Feed flow less than steam flow (pump trip, feed valve failed closed, manual feed)', 'Shrink after a load decrease or trip'],
    actions: [`Raise feed to SG ${n}: put its feed valve in AUTO or open it (FEEDWATER & STEAM DUMP).`, 'Start AFW if main feed is not available.', 'Reduce load if feed cannot keep up.'],
  };
  H[`SG${n}_LEVEL_LOLO`] = {
    meaning: `Steam generator ${n} level is below 17 % — the reactor trips to protect the heat sink.`,
    causes: ['Loss of feedwater', 'Feed valve failure'],
    actions: ['Verify reactor trip and AFW running (FEEDWATER & STEAM DUMP).', `Feed SG ${n} until level is back in the narrow range.`],
  };
  H[`SG${n}_LEVEL_HI`] = {
    meaning: `Steam generator ${n} level is above 60 %.`,
    causes: ['Overfeeding', 'Swell during a load increase', 'Tube leak adding water'],
    actions: [`Reduce feed to SG ${n} (feed valve AUTO or close it in manual) (FEEDWATER & STEAM DUMP).`, 'If level rises with no feed, suspect a tube leak (MAIN STEAM RAD).'],
  };
  H[`SG${n}_LEVEL_HIHI`] = {
    meaning: `Steam generator ${n} level is at hi-hi (78 %) — feedwater isolates and the turbine trips to prevent water carry-over.`,
    causes: ['Feed valve failed open', 'Manual overfeed', 'SG tube rupture'],
    actions: [`Stop feed to SG ${n} (FEEDWATER & STEAM DUMP).`, 'Check for a tube rupture (MAIN STEAM RAD HI).'],
  };
  H[`SG${n}_FLOW_MISMATCH`] = {
    meaning: `Steam generator ${n} feed flow and steam flow disagree — level will change.`,
    causes: ['Feed valve failure', 'Feed controller in manual', 'Steam leak'],
    actions: [`Check SG ${n} feed valve position and mode (FEEDWATER & STEAM DUMP).`, 'Take manual control of the feed valve if the controller failed.'],
  };
  H[`RCP${n}_TRIP`] = {
    meaning: `Reactor coolant pump ${n} has stopped. Its loop flow reverses and the other pumps carry the core.`,
    causes: ['Electrical fault', 'High bearing temperature or vibration', 'Loss of component cooling', 'Operator stop', 'Loss of offsite power'],
    actions: ['Above P-8 (48 %) this trips the reactor; between P-7 and P-8 reduce power below ~48 % (TURBINE/GENERATOR).', 'Restart the pump only after the cause is fixed (RCS/RCPs).'],
  };
  H[`LOOP${n}_FLOW_LO`] = {
    meaning: `RCS loop ${n} flow is below 90 % of rated.`,
    causes: [`RCP ${n} stopped or coasting down`, 'Voids in the loop'],
    actions: ['Verify reactor trip if above P-8 (RCS/RCPs).', 'Restart the RCP when conditions allow.'],
  };
}

// ---------------------------------------------------------------- balance of plant / auxiliaries
Object.assign(H, {
  CW_FLOW_LO: {
    meaning: 'Circulating water flow to the condenser is low. The condenser cannot remove the exhaust-steam heat, so vacuum falls. The turbine trips below 20 in.Hg and the steam dumps block below 22 in.Hg.',
    causes: ['A circulating water pump tripped', 'Too few CW pumps for the turbine load', 'Loss of offsite power'],
    actions: ['Start another CIRC WATER PUMP (FEEDWATER & STEAM DUMP).', 'If vacuum keeps falling, reduce turbine load (TURBINE/GENERATOR).', 'Run 3 CW pumps above ~60 % load.'],
  },
  HOTWELL_LEVEL: {
    meaning: 'The condenser hotwell level is outside its normal band. The condensate pumps trip if the hotwell runs dry.',
    causes: ['Feed flow and steam flow badly mismatched for a long time', 'Large AFW use (AFW comes from the storage tank, not the hotwell)'],
    actions: ['Balance feed and steam flow (FEEDWATER & STEAM DUMP).', 'Automatic makeup and reject will recover it slowly.'],
  },
  MFP_SUCTION_LO: {
    meaning: 'Main feed pump suction pressure is low (below 200 psig). Below 100 psig the running MFPs trip after about 15 s.',
    causes: ['Too few condensate pumps running for the feed flow (each carries ~60 % of full flow)', 'Condensate pump trip'],
    actions: ['Start another CONDENSATE PUMP (FEEDWATER & STEAM DUMP).', 'Reduce load if no pump is available.'],
  },
  FW_HTRS_OOS: {
    meaning: 'Feedwater heaters are out of service. Feedwater enters the SGs cold, so the reactor must make more heat for the same steam. Expect thermal power above electrical output and possible overpower.',
    causes: ['FW HEATERS switch OFF'],
    actions: ['Put the FEEDWATER HEATERS in service (FEEDWATER & STEAM DUMP).', 'Before taking heaters out at power, reduce load by about 10 %.'],
  },
  TURB_ECCENTRIC: {
    meaning: 'The turbine rotor is bowed. It sat stationary while hot without the turning gear, and it will vibrate badly when rolled.',
    causes: ['Turning gear disengaged with the turbine stopped'],
    actions: ['Engage the TURNING GEAR and leave it until eccentricity is normal (about 20–30 min) before rolling (TURBINE/GENERATOR).'],
  },
  TURB_DIFF_EXP: {
    meaning: 'Turbine differential expansion is high. The rotor is much colder than the steam (it is heating faster than the casing), and blade rubs and vibration follow.',
    causes: ['Rolling to high speed or loading before the rotor warmed up'],
    actions: ['Lower the SPEED TARGET to 500 rpm and soak until rotor temperature approaches steam temperature (TURBINE/GENERATOR).', 'Load the unit more slowly.'],
  },
  TURB_CRIT_SPEED: {
    meaning: 'The turbine is dwelling in its critical-speed band (1000–1300 rpm), where the rotor resonates and vibration builds quickly.',
    causes: ['Speed target set inside the band', 'Acceleration rate too low'],
    actions: ['Set the SPEED TARGET above 1300 (normally 1800 rpm) with an acceleration of at least 200 rpm/min (TURBINE/GENERATOR).'],
  },
  TURN_GEAR_OFF: {
    meaning: 'The turbine is stopped and the turning gear is not engaged. A hot rotor will start to bow.',
    causes: ['TURNING GEAR switch off'],
    actions: ['Engage the TURNING GEAR (TURBINE/GENERATOR).'],
  },
  GEN_FIELD_OFF: {
    meaning: 'The turbine is at speed but the generator is not excited, so there is no terminal voltage and the unit cannot be synchronised.',
    causes: ['Field breaker open (normal before synchronising)'],
    actions: ['Close the GEN FIELD BREAKER, then adjust the VOLTAGE SETPOINT to match grid voltage (TURBINE/GENERATOR).'],
  },
  GEN_PROTECTION: {
    meaning: 'Generator protection tripped the unit. The breaker was closed out of phase or with a voltage mismatch, which caused a huge torque transient and damaged the generator.',
    causes: ['Breaker closed with the synchroscope away from 12 o\'clock', 'Terminal and grid voltage not matched'],
    actions: [
      'Next time, set the speed target slightly above 1800 (1801–1803 rpm) so the synchroscope turns slowly clockwise (TURBINE/GENERATOR).',
      'Match terminal kV to grid kV with the VOLTAGE SETPOINT.',
      'Close the breaker only when the needle is within about ±10° of 12 o\'clock.',
    ],
  },
  GEN_MVAR: {
    meaning: 'Generator reactive power is near its capability limit (over- or under-excited).',
    causes: ['Voltage setpoint far from grid voltage'],
    actions: ['Move the VOLTAGE SETPOINT toward grid voltage (TURBINE/GENERATOR).'],
  },
  HOUSE_ON_SAT: {
    meaning: 'Plant auxiliary loads are still fed from the startup transformer (offsite) while the generator is on line.',
    causes: ['House loads not transferred after synchronising'],
    actions: ['Press HOUSE LOADS → UAT (SAFETY & ELECTRICAL).'],
  },
  CCW_FLOW_LO: {
    meaning: 'No component cooling water flow. RCP bearings and thermal barriers, the letdown heat exchanger and other coolers have lost their cooling.',
    causes: ['CCW pump trip', 'Loss of power to the CCW pumps'],
    actions: [
      'Start the standby CCW PUMP (SAFETY & ELECTRICAL).',
      'Watch RCP bearing temperatures. Trip any RCP above 195 °F, because bearings fail around 230 °F (RCS/RCPs).',
      'Keep RCP seal injection at about 32 gpm (CVCS/BORON).',
    ],
  },
  CCW_TEMP_HI: {
    meaning: 'Component cooling water temperature is high (above 105 °F).',
    causes: ['Service water pump off', 'Unusually high heat load'],
    actions: ['Start a second SERVICE WATER PUMP (SAFETY & ELECTRICAL).', 'Check RCP bearing temperatures (RCS/RCPs).'],
  },
  SW_FLOW_LO: {
    meaning: 'No service water flow. Nothing is cooling the CCW heat exchangers, so CCW temperature will climb.',
    causes: ['Service water pump trip or switched off'],
    actions: ['Start a SERVICE WATER PUMP (SAFETY & ELECTRICAL).'],
  },
  SEAL_INJ_LO: {
    meaning: 'RCP seal injection flow is low. Without it (and without CCW to the thermal barriers), hot reactor coolant reaches the seals and they fail.',
    causes: ['Seal injection throttled', 'Charging pumps unavailable'],
    actions: ['Raise SEAL INJECTION to about 32 gpm (8 gpm per pump) (CVCS/BORON).', 'Ensure CCW is running (SAFETY & ELECTRICAL).'],
  },
  LD_HX_TEMP_HI: {
    meaning: 'Letdown heat exchanger outlet temperature is high. The ion-exchange resins are damaged above about 140 °F.',
    causes: ['Loss of CCW', 'High letdown flow'],
    actions: ['Restore CCW flow (SAFETY & ELECTRICAL).', 'Isolate letdown if temperature keeps rising (CVCS/BORON).'],
  },
  MAKEUP_BATCH: {
    meaning: 'A boron dilution or boration batch is in progress. It stops automatically when the batch integrator reaches its setpoint.',
    causes: ['MAKEUP BATCH START pressed'],
    actions: ['Watch Tavg and startup rate while it runs (REACTOR CONTROL).', 'Press MAKEUP BATCH STOP to abort (CVCS/BORON).'],
  },
  DG_OVERLOAD: {
    meaning: 'An emergency diesel generator is loaded beyond its rating.',
    causes: ['Too many loads started on the safety bus during a loss of offsite power'],
    actions: ['Stop non-essential loads, such as the second CCW or SW pump or pressurizer heaters (SAFETY & ELECTRICAL).'],
  },
});
for (let n = 1; n <= 4; n++) {
  H[`RCP${n}_BRG_TEMP`] = {
    meaning: `RCP ${n} motor or pump bearing temperature is above 195 °F. Around 230 °F the bearing fails and the shaft seizes (locked rotor).`,
    causes: ['Loss of component cooling water', 'High CCW temperature'],
    actions: ['Restore CCW flow (SAFETY & ELECTRICAL: CCW PUMP).', `If the temperature keeps rising, stop RCP ${n} (RCS/RCPs). Above P-8, trip the reactor first.`],
  };
  H[`RCP${n}_SEAL`] = {
    meaning: `RCP ${n} #1 seal leak-off is high. The seal is overheating or failing, and reactor coolant is escaping to containment.`,
    causes: ['No seal injection and no CCW to the thermal barrier', 'Seal damage'],
    actions: ['Restore SEAL INJECTION (CVCS/BORON) and CCW (SAFETY & ELECTRICAL).', `Stop RCP ${n} to reduce leakage (RCS/RCPs).`, 'Treat a failed seal as a small LOCA. Keep pressurizer level up with charging.'],
  };
}

export const ALARM_HELP: Record<string, AlarmHelp> = H;

/** Fallback for any id without a specific entry. */
export function alarmHelp(id: string): AlarmHelp {
  return ALARM_HELP[id] ?? {
    meaning: 'Plant parameter outside its normal band.',
    causes: ['See the plant computer for the associated parameter.'],
    actions: ['Identify the parameter, restore it to its normal value, then ACKNOWLEDGE and RESET the alarm.'],
  };
}
