/** Static copy for the title screen, primer and controls sheet. */

export const KEYS_WORLD: [string, string][] = [
  ['Mouse', 'Look around'],
  ['W A S D', 'Walk'],
  ['Shift', 'Walk faster'],
  ['Left click', 'Press button / turn switch or knob clockwise'],
  ['Right click', 'Turn switch or knob counter-clockwise'],
  ['Mouse wheel', 'Fine-adjust the knob or setpoint under the crosshair'],
  ['E', 'Activate the control under the crosshair'],
  ['F or Q', 'Lean in to read a panel (hold)'],
  ['Esc', 'Release the mouse and pause'],
];

export const KEYS_UI: [string, string][] = [
  ['[ and ]', 'Slow down / speed up time (1×, 2×, 5×, 10×, 30×)'],
  ['- and =', 'Same as [ and ]'],
  ['P', 'Pause or resume'],
  ['Tab', 'Procedure binder: startup steps and running checks'],
  ['L', 'Plant logbook: every event and the reactivity balance'],
  ['H or F1', 'This controls sheet'],
  ['M', 'Mute or unmute sound'],
];

/** Primer: short gameplay-oriented sections (HTML allowed). */
export const PRIMER: { h: string; body: string }[] = [
  {
    h: 'What “critical” means',
    body:
      'Each fission releases neutrons that cause more fissions. When exactly one neutron from each fission goes on to cause another, the chain holds steady: the reactor is <em>critical</em> (k = 1.000). A little above and power climbs exponentially; a little below and it dies away. Critical is normal. You are not trying to avoid it, you are trying to control it.',
  },
  {
    h: 'Three ways to change reactivity',
    body:
      '<b>Control rods</b> are fast and local: withdraw to add reactivity, insert to remove it. <b>Boron</b> dissolved in the coolant is slow and even: dilute to add reactivity, borate to remove it. <b>Xenon</b> is the one you don’t control: a fission product that soaks up neutrons, builds in for hours after a power change and can force you to dilute, or shut you down.',
  },
  {
    h: 'Feedback is your friend',
    body:
      'Hotter fuel and hotter water both reduce reactivity. That is why power settles once heat is being removed: the turbine takes steam, Tavg drops, power rises to match. Rods in auto just keep Tavg on its program.',
  },
  {
    h: 'The startup, in short',
    body:
      'Reset the trip breakers. Pull shutdown banks A and B fully out. Pull control banks in sequence while listening to the source range clicks speed up. Stop when the startup rate stays positive with rods still: you are critical. Let power rise to 1–3%, start feed, latch the turbine, sync the generator, then raise load a few MW per minute.',
  },
  {
    h: 'Trips',
    body:
      'The protection system watches flux, pressure, temperature, flow and levels. When a limit is crossed, the trip breakers open and every rod falls in within two seconds. The first-out annunciator tells you why. A trip is not a failure, it is the plant protecting itself. Find the cause, stabilize, reset, and start again.',
  },
  {
    h: 'How you lose',
    body:
      'Defeat the protections, or let heat removal fail with no water behind it. Lose feedwater and the steam generators boil dry. Lose pressure and the core boils. Pull rods too fast and a prompt excursion can rupture the vessel. Overfill a steam generator and water slugs the steam lines. Nothing here is scripted: the plant only does what its physics allow.',
  },
];
