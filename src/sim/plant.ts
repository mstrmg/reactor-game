/**
 * Fixed plant design parameters (4-loop Westinghouse-style PWR, 3411 MWt).
 * Internal units: MPa abs, °C, kg, kJ, kW, m³.
 */
export const Q_RATED = 3.411e6; // kW thermal

// ---- primary node layout
export const UP = 0; // upper plenum + upper head
export const LP = 1; // downcomer + lower plenum
export const CORE = 2;
export const HL = (i: number) => 3 + 4 * i;
export const S1 = (i: number) => 4 + 4 * i; // SG tubes, hot half
export const S2 = (i: number) => 5 + 4 * i; // SG tubes, cold half
export const CL = (i: number) => 6 + 4 * i; // crossover + RCP + cold leg
export const NN = 19;
export const NODE_V = new Float64Array([45, 40, 20, 5, 15, 15, 9, 5, 15, 15, 9, 5, 15, 15, 9, 5, 15, 15, 9]);
export const V_LOOPS = NODE_V.reduce((a, b) => a + b, 0); // 281 m³
export const VFRAC = NODE_V.map((v) => v / V_LOOPS);
export const V_PZR = 51; // m³ (1800 ft³)
export const SURGE_LOOP = 3; // surge line on loop 4 hot leg
export const CHARGING_LOOP = 3;
export const LETDOWN_LOOP = 2;
/** void volume that must accumulate above the core before it starts to uncover, m³ */
export const V_ABOVE_CORE = 110;
export const V_CORE_WATER = 20;

// ---- core
export const REGION_VFRAC = [0.7, 0.3]; // bulk (lower), hot (upper)
export const REGION_SHARE = [0.625, 0.375]; // power share
export const FUEL_C = 3.03e4; // kJ/K total UO2 (101 t × 0.30)
export const CLAD_C = 8.25e3; // kJ/K total Zr (25 t × 0.33)
export const UA_FC = 9270; // kW/K fuel→clad (gap + pellet)
export const A_HT = 5100; // m² clad surface
export const H_FC0 = 34; // kW/m²K forced convection at rated flow
export const ZR_MASS = 25000; // kg
export const UO2_MASS = 101000;
export const T_FUEL_MELT = 2815; // °C (5100 °F)
export const UO2_LATENT = 277; // kJ/kg
export const T_CLAD_FAIL_START = 760; // °C (1400 °F) — ballooning / burst begins
export const T_CLAD_FAIL_FULL = 1204; // °C (2200 °F)

// ---- RCPs and flow
export const RCP_HEAT = 5300; // kW per pump at full speed
export const RCP_COAST_TAU = 12; // s (flow halves in ~12 s)
export const R_LOOP = 0.6; // normalised loop resistance
export const R_CORE = 0.025; // normalised vessel resistance (so 4 pumps → w = 1 per loop)
export const R_REVERSE_LOCKED = 10.0; // extra multiplier for reverse flow through a stopped pump
export const NC_COEF = 2.8e-5; // normalised buoyancy head per kg/m³ density difference

// ---- pressurizer
export const PZR_HEATER_PROP = 400; // kW
export const PZR_HEATER_BACKUP = 1400; // kW
export const PZR_HEAT_LOSS = 60; // kW
export const PZR_SPRAY_MAX = 45; // kg/s
export const PZR_SPRAY_BYPASS = 0.12; // kg/s continuous
export const PORV_AREA = 2 * 9.4e-4; // m² (two PORVs operated together)
export const PZR_SV_AREA = 3 * 1.65e-3; // m²

// ---- steam generators
export const V_SG = 167; // m³ secondary side
export const SG_NR_V0 = 58.4; // mixture volume at 0 % narrow range
export const SG_NR_SPAN = 60; // m³ across narrow range
export const SG_WR_SPAN = 150;
export const SG_VOID_FP = 15; // m³ swell volume at full power
export const SG_LEVEL_SP = 44; // % NR program
export const W_STEAM_RATED_SG = 480; // kg/s per SG at 100 %
export const W_STEAM_RATED = 4 * W_STEAM_RATED_SG;
export const MW_PER_KGS = 0.599; // gross MWe per kg/s turbine steam at rated conditions
export const C_TURB = 322; // kg/s per (MPa · valve fraction)
export const C_DUMP = 101; // kg/s per MPa (40 % capacity at no-load pressure)
export const C_ARV = 6.1; // per SG
export const C_SGSV = 58.6; // per SG
export const K_STEAMLINE = 907; // kg/s per sqrt(MPa)
export const MFP_CAP_PER_SG = 288; // kg/s per SG per running MFP
export const AFW_MD_KGS = 27.5; // per motor-driven pump
export const AFW_TD_KGS = 55;

// ---- containment
export const V_CONT = 71000; // m³ free volume
export const CONT_UA_WALL = 8000; // kW/K condensing heat transfer to structures
export const CONT_C_WALL = 8.0e6; // kJ/K
export const CONT_UA_FAN = 2000;
export const CONT_UA_SPRAY = 15000;

// ---- CVCS / ECCS
export const VCT_MASS = 1500; // kg
export const BORIC_ACID_PPM = 7000;
export const RWST_PPM = 2500;
export const ACC_WATER = 24000; // kg per accumulator
export const ACC_GAS_V0 = 14; // m³
export const ACC_P0_PSIG = 600;
export const ACC_K = 424; // kg/s per sqrt(MPa)

// ---- reactivity
export const RHO_FUEL = 14435; // pcm excess reactivity of the fuel load (BOC-ish)
export const BORON_WORTH = -10; // pcm/ppm
export const MTC_A0 = -24; // pcm/°F at 557 °F, 0 ppm
export const MTC_A1 = 0.016; // pcm/°F per ppm
export const MTC_SCALE_F = 105; // °F (thermal-expansion growth scale)
export const DOPPLER_K = 180; // pcm per sqrt(K)
export const VOID_COEF = -100; // pcm per % core void
export const T_REF_F = 557;
