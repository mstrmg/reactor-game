// Canvas-drawn textures for panel instruments. Every function takes a palette `p`
// so each art style can recolour the same instruments.
import * as THREE from 'three';

export function canvasTex(w, h, draw, { nearest = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  }
  return t;
}

// deterministic random
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ANN_LABELS = [
  'REACTOR\nTRIP', 'PZR PRESS\nHIGH', 'PZR LEVEL\nLOW', 'SG 1 LEVEL\nLOW', 'RCP 2 SEAL\nLEAKOFF HI', 'CHARGING\nFLOW LOW',
  'TAVG\nHIGH', 'ROD AT\nBOTTOM', 'NIS POWER\nRANGE HI', 'SAFETY INJ\nACTUATED', 'CCW SURGE\nTANK LO', 'TURBINE\nTRIP',
  'CONTMT\nPRESS HI', 'RWST\nLEVEL LO', 'BORON\nDILUTION', 'AUX FW\nPUMP RUN', 'RCP 1\nVIBRATION', 'DNB\nMARGIN LO',
  'OVERTEMP\nΔT', 'MSIV\nCLOSED', 'LOOP A\nFLOW LO', 'LOOP B\nFLOW LO', 'ROD DEV\nALARM', 'VCT LEVEL\nHI/LO',
  'SG 2 LEVEL\nLOW', 'FW PUMP\nTRIP', 'COND VAC\nLOW', 'GEN\nBREAKER', 'DIESEL\nGEN RUN', 'BATTERY\nDISCHARGE',
  'ROD STOP', 'AXIAL FLUX\nDIFF', 'SOURCE RNG\nHIGH FLUX', 'INTERMED\nRANGE HI', 'PORV\nOPEN', 'RHR\nFLOW LO',
];

// A whole annunciator window block: cols x rows of backlit tiles.
// Returns { map, emissive } textures (emissive is black except lit tiles).
export function annunciator(p, cols, rows, seed, litSet) {
  const tw = 128, th = 84;
  const W = cols * tw, H = rows * th;
  const r = rng(seed);
  const lit = new Map();
  for (let i = 0; i < cols * rows; i++) {
    if (litSet ? litSet.includes(i) : r() < (p.annLitChance ?? 0.12)) {
      lit.set(i, p.annLit[Math.floor(r() * p.annLit.length)]);
    }
  }
  const draw = (emissiveOnly) => (g) => {
    g.fillStyle = emissiveOnly ? '#000' : p.annFrame;
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const on = lit.get(i);
      const px = x * tw, py = y * th;
      if (emissiveOnly && !on) continue;
      g.fillStyle = on || p.annBg;
      g.fillRect(px + 4, py + 4, tw - 8, th - 8);
      if (!emissiveOnly && p.annBevel) {
        g.strokeStyle = p.annBevel; g.lineWidth = 2;
        g.strokeRect(px + 5, py + 5, tw - 10, th - 10);
      }
      const label = ANN_LABELS[(i + seed * 7) % ANN_LABELS.length];
      g.fillStyle = on ? p.annLitText : p.annText;
      g.font = `bold 17px ${p.font}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const lines = label.split('\n');
      lines.forEach((l, k) => g.fillText(l, px + tw / 2, py + th / 2 + (k - (lines.length - 1) / 2) * 20));
    }
  };
  return {
    map: canvasTex(W, H, draw(false), { nearest: p.nearest }),
    emissive: canvasTex(W, H, draw(true), { nearest: p.nearest }),
  };
}

// Round analog dial.
export function dial(p, label, units, min, max, value, seed = 1) {
  return canvasTex(256, 256, (g) => {
    const cx = 128, cy = 140, R = 100;
    g.fillStyle = p.dialBezel; g.fillRect(0, 0, 256, 256);
    g.beginPath(); g.arc(128, 128, 122, 0, Math.PI * 2); g.fillStyle = p.dialFace; g.fill();
    g.lineWidth = 6; g.strokeStyle = p.dialRim || p.dialInk; g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    // coloured band
    if (p.dialBand) {
      g.lineWidth = 10; g.strokeStyle = p.dialBand;
      g.beginPath(); g.arc(cx, cy, R - 6, a0 + (a1 - a0) * 0.8, a1); g.stroke();
    }
    g.strokeStyle = p.dialInk; g.fillStyle = p.dialInk;
    for (let i = 0; i <= 50; i++) {
      const a = a0 + (a1 - a0) * (i / 50);
      const major = i % 10 === 0;
      const r0 = R - (major ? 18 : i % 5 === 0 ? 12 : 7);
      g.lineWidth = major ? 3 : 1.5;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
      if (major) {
        const v = Math.round(min + (max - min) * (i / 50));
        g.font = `bold 15px ${p.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(v), cx + Math.cos(a) * (R - 32), cy + Math.sin(a) * (R - 32));
      }
    }
    g.font = `bold 14px ${p.font}`; g.fillText(label, cx, cy + 34);
    g.font = `12px ${p.font}`; g.fillText(units, cx, cy + 52);
    const t = (value - min) / (max - min);
    const a = a0 + (a1 - a0) * t;
    g.strokeStyle = p.dialNeedle; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14);
    g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke();
    g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fillStyle = p.dialNeedle; g.fill();
  }, { nearest: p.nearest });
}

// Vertical edgewise meter (very common on US PWR boards).
export function edgewise(p, label, value) {
  return canvasTex(64, 256, (g) => {
    g.fillStyle = p.edgeBezel || p.dialBezel; g.fillRect(0, 0, 64, 256);
    g.fillStyle = p.dialFace; g.fillRect(6, 26, 52, 200);
    g.fillStyle = p.dialInk; g.strokeStyle = p.dialInk;
    g.font = `bold 11px ${p.font}`; g.textAlign = 'center';
    g.fillStyle = p.labelText || p.dialInk;
    g.fillText(label, 32, 17);
    g.fillStyle = p.dialInk;
    for (let i = 0; i <= 20; i++) {
      const y = 216 - i * 9.5;
      g.lineWidth = i % 5 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(10, y); g.lineTo(i % 5 === 0 ? 30 : 22, y); g.stroke();
      if (i % 5 === 0) { g.font = `10px ${p.font}`; g.textAlign = 'left'; g.fillText(String(i * 5), 34, y + 4); }
    }
    if (p.dialBand) { g.fillStyle = p.dialBand; g.fillRect(8, 216 - 20 * 9.5, 4, 3 * 9.5); }
    const y = 216 - value * 190;
    g.fillStyle = p.dialNeedle;
    g.beginPath(); g.moveTo(8, y); g.lineTo(30, y - 5); g.lineTo(30, y + 5); g.closePath(); g.fill();
    g.fillRect(8, y - 1.5, 46, 3);
    g.fillStyle = p.dialBezel; g.fillRect(0, 232, 64, 24);
  }, { nearest: p.nearest });
}

// Strip chart recorder paper with pen traces.
export function stripChart(p, seed) {
  return canvasTex(256, 192, (g) => {
    g.fillStyle = p.paper; g.fillRect(0, 0, 256, 192);
    g.strokeStyle = p.paperGrid; g.lineWidth = 1;
    for (let x = 0; x <= 256; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 192); g.stroke(); }
    for (let y = 0; y <= 192; y += 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    const r = rng(seed);
    p.paperInk.forEach((ink, k) => {
      g.strokeStyle = ink; g.lineWidth = 2; g.beginPath();
      let x = 40 + k * 70 + r() * 20;
      for (let y = 0; y <= 192; y += 3) {
        x += (r() - 0.5) * 6 + Math.sin(y / 20 + k) * 0.8;
        y === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    });
  }, { nearest: p.nearest });
}

// Rod position indication: core map of rod LEDs.
export function rodMap(p) {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = p.mimicBg; g.fillRect(0, 0, 512, 512);
    const N = 15, cell = 30, off = (512 - N * cell) / 2;
    const c = (N - 1) / 2;
    g.strokeStyle = p.mimicLine; g.lineWidth = 2;
    g.beginPath(); g.arc(256, 256, 7.6 * cell, 0, Math.PI * 2); g.stroke();
    const r = rng(42);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > 7.2) continue;
      const px = off + x * cell, py = off + y * cell;
      const rod = (x + y) % 2 === 0 && (x % 2 === 0) && d < 6.8;
      if (rod) {
        const state = r() < 0.08 ? p.mimicHot : p.mimicCold;
        g.fillStyle = state;
        g.fillRect(px + 5, py + 5, cell - 10, cell - 10);
      } else {
        g.strokeStyle = p.mimicDim || p.mimicLine; g.lineWidth = 1;
        g.strokeRect(px + 9, py + 9, cell - 18, cell - 18);
      }
    }
    g.fillStyle = p.mimicText || p.mimicLine;
    g.font = `bold 20px ${p.font}`; g.textAlign = 'center';
    g.fillText('ROD POSITION INDICATION', 256, 30);
    g.font = `14px ${p.font}`;
    g.fillText('CORE MAP · CONTROL BANKS A–D · SHUTDOWN BANKS SA–SB', 256, 496);
  }, { nearest: p.nearest });
}

// PWR primary/secondary mimic diagram.
export function mimic(p) {
  return canvasTex(512, 256, (g) => {
    g.fillStyle = p.mimicBg; g.fillRect(0, 0, 512, 256);
    g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
    // reactor vessel
    g.strokeStyle = p.mimicLine; g.lineWidth = 4;
    g.beginPath(); g.roundRect(40, 70, 70, 140, 30); g.stroke();
    for (let i = 0; i < 5; i++) { g.fillStyle = p.mimicHot; g.fillRect(55 + i * 9, 120, 5, 60); }
    // hot leg
    g.lineWidth = 8; g.strokeStyle = p.mimicHot;
    g.beginPath(); g.moveTo(110, 110); g.lineTo(220, 110); g.lineTo(220, 70); g.stroke();
    // steam generator
    g.strokeStyle = p.mimicLine; g.lineWidth = 4;
    g.beginPath(); g.roundRect(200, 30, 60, 170, 24); g.stroke();
    // cold leg + pump
    g.lineWidth = 8; g.strokeStyle = p.mimicCold;
    g.beginPath(); g.moveTo(230, 200); g.lineTo(230, 225); g.lineTo(160, 225); g.lineTo(160, 180); g.lineTo(110, 180); g.stroke();
    g.fillStyle = p.mimicBg; g.strokeStyle = p.mimicLine; g.lineWidth = 4;
    g.beginPath(); g.arc(160, 205, 16, 0, Math.PI * 2); g.fill(); g.stroke();
    // pressurizer
    g.beginPath(); g.roundRect(140, 20, 34, 64, 14); g.stroke();
    g.lineWidth = 3; g.beginPath(); g.moveTo(157, 84); g.lineTo(157, 110); g.stroke();
    // steam line to turbine
    g.strokeStyle = p.mimicSteam || p.mimicLine; g.lineWidth = 6;
    g.beginPath(); g.moveTo(260, 50); g.lineTo(350, 50); g.lineTo(350, 80); g.stroke();
    g.strokeStyle = p.mimicLine; g.lineWidth = 4;
    g.beginPath(); g.moveTo(330, 80); g.lineTo(420, 70); g.lineTo(420, 140); g.lineTo(330, 130); g.closePath(); g.stroke();
    // generator
    g.beginPath(); g.arc(470, 105, 24, 0, Math.PI * 2); g.stroke();
    g.font = `bold 20px ${p.font}`; g.fillStyle = p.mimicLine; g.textAlign = 'center'; g.fillText('G', 470, 112);
    // condenser + feed
    g.strokeStyle = p.mimicCold; g.lineWidth = 6;
    g.beginPath(); g.moveTo(375, 135); g.lineTo(375, 215); g.lineTo(290, 215); g.lineTo(290, 170); g.lineTo(260, 170); g.stroke();
    g.fillStyle = p.mimicText || p.mimicLine; g.font = `bold 13px ${p.font}`;
    g.fillText('RX', 75, 62); g.fillText('SG-A', 230, 22); g.fillText('PZR', 157, 14);
    g.fillText('RCP', 160, 250); g.fillText('HP/LP TURB', 375, 160); g.fillText('COND', 330, 240);
  }, { nearest: p.nearest });
}

// Process computer CRT / modern display page.
export function screen(p, kind = 'trend', seed = 3) {
  return canvasTex(512, 384, (g) => {
    g.fillStyle = p.screenBg; g.fillRect(0, 0, 512, 384);
    const fg = p.screenFg, acc = p.screenAccent;
    g.font = `bold 18px ${p.monoFont || p.font}`; g.fillStyle = fg; g.textAlign = 'left';
    if (kind === 'trend') {
      g.fillText('UNIT 1  REACTOR POWER  TREND', 16, 28);
      g.strokeStyle = p.screenGrid || fg; g.globalAlpha = 0.35; g.lineWidth = 1;
      for (let x = 40; x < 500; x += 46) { g.beginPath(); g.moveTo(x, 50); g.lineTo(x, 300); g.stroke(); }
      for (let y = 50; y <= 300; y += 50) { g.beginPath(); g.moveTo(40, y); g.lineTo(500, y); g.stroke(); }
      g.globalAlpha = 1;
      const r = rng(seed);
      [fg, acc].forEach((col, k) => {
        g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath();
        let y = 120 + k * 80;
        for (let x = 40; x <= 500; x += 4) {
          y += (r() - 0.5) * 5; if (x > 380 && k === 0) y += 0.9;
          x === 40 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      });
      g.font = `16px ${p.monoFont || p.font}`; g.fillStyle = fg;
      g.fillText('PWR  98.7 %   TAVG 584.2 F   PZR 2235 PSIG', 16, 330);
      g.fillStyle = acc; g.fillText('ΔI  -2.1 %     BORON 1012 PPM    ROD D 218', 16, 356);
    } else if (kind === 'table') {
      g.fillText('SAFETY PARAMETER DISPLAY SYSTEM', 16, 28);
      const rows = [['RCS PRESSURE', '2235', 'PSIG'], ['RCS TAVG', '584.2', 'F'], ['PZR LEVEL', '57.9', '%'], ['SG A LEVEL', '44.1', '% NR'], ['SG B LEVEL', '43.8', '% NR'], ['CORE EXIT TC', '612', 'F'], ['SUBCOOLING', '41', 'F'], ['CONTMT PRESS', '0.3', 'PSIG'], ['NEUTRON FLUX', '98.7', '%']];
      g.font = `17px ${p.monoFont || p.font}`;
      rows.forEach((row, i) => {
        const y = 70 + i * 32;
        g.fillStyle = fg; g.fillText(row[0], 20, y);
        g.fillStyle = i === 6 ? acc : fg; g.textAlign = 'right'; g.fillText(row[1], 400, y);
        g.textAlign = 'left'; g.fillStyle = fg; g.fillText(row[2], 412, y);
      });
    } else if (kind === 'overview') {
      g.fillText('PLANT OVERVIEW', 16, 28);
      g.fillStyle = acc; g.textAlign = 'right'; g.fillText('MODE 1 · POWER OPERATION', 496, 28); g.textAlign = 'left';
      const tiles = [['REACTOR POWER', '98.7', '%'], ['GROSS ELEC', '1121', 'MWe'], ['RCS PRESS', '2235', 'psig'], ['TAVG', '584', '°F'], ['PZR LEVEL', '58', '%'], ['BORON', '1012', 'ppm']];
      tiles.forEach((t, i) => {
        const x = 16 + (i % 3) * 164, y = 50 + Math.floor(i / 3) * 112;
        g.fillStyle = p.screenTile || 'rgba(255,255,255,0.06)'; g.fillRect(x, y, 152, 100);
        g.fillStyle = fg; g.globalAlpha = 0.7; g.font = `12px ${p.font}`; g.fillText(t[0], x + 10, y + 22); g.globalAlpha = 1;
        g.fillStyle = i === 0 ? acc : fg; g.font = `bold 36px ${p.font}`; g.fillText(t[1], x + 10, y + 68);
        g.font = `14px ${p.font}`; g.fillText(t[2], x + 10 + g.measureText(t[1]).width * 0 + 110, y + 68);
      });
      g.strokeStyle = acc; g.lineWidth = 2.5; g.beginPath();
      const r = rng(seed);
      let y = 330;
      for (let x = 16; x < 496; x += 4) { y += (r() - 0.5) * 4; x === 16 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.stroke();
    }
  }, { nearest: p.nearest });
}

// Engraved label plate.
export function labelPlate(p, text) {
  return canvasTex(512, 64, (g) => {
    g.fillStyle = p.plateBg; g.fillRect(0, 0, 512, 64);
    g.fillStyle = p.plateText; g.font = `bold 30px ${p.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 34);
  }, { nearest: p.nearest });
}

// Generic noise texture (concrete, terrazzo...).
export function noiseTex(base, specks, size = 512, seed = 9, blotch = true) {
  return canvasTex(size, size, (g) => {
    g.fillStyle = base; g.fillRect(0, 0, size, size);
    const r = rng(seed);
    if (blotch) for (let i = 0; i < 260; i++) {
      g.fillStyle = specks[Math.floor(r() * specks.length)];
      g.globalAlpha = 0.06; g.beginPath(); g.arc(r() * size, r() * size, 10 + r() * 60, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 0.5;
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = specks[Math.floor(r() * specks.length)];
      g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
    }
    g.globalAlpha = 1;
  });
}
