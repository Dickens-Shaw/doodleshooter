// Two presentation presets. Numbers are copied from the saved sources and are not shared:
// ballpoint ← sources/old, marker ← sources/new.
// Ink slots 0–5 are the same pen in both files. Slot 6 is the foe ink. The old source has no
// seventh ink: grunts, their shots and their laser are the red pen. The new source paints those
// with a near-black marker so they do not read as blood.
// A theme only changes the paper pass and these colours. It is not sent to other players.

const PENS = [
  [0.10, 0.19, 0.76], // blue ballpoint
  [0.86, 0.12, 0.20], // red pen
  [0.18, 0.20, 0.26], // graphite
  [0.92, 0.55, 0.08], // orange highlighter
  [0.12, 0.60, 0.30], // green
  [0.90, 0.40, 0.66], // pink eraser
];

// sources/old/src/render.js INK_COLORS, LIGHT_WORLD, and the ruled-line literals in its paper pass.
// sources/old/src/enemies.js: default foe ink is RED; solid bits on a black body are RED.
const BALLPOINT_INKS = [...PENS, PENS[1]];

// sources/new/src/render.js INK_COLORS (the seventh entry) and LIGHT_WORLD.
// sources/new/src/enemies.js: default foe ink is FOE; solid bits on a black body are ORANGE.
const MARKER_INKS = [...PENS, [0.09, 0.09, 0.11]];

export const THEMES = {
  ballpoint: {
    id: 'ballpoint',
    paper: [0.965, 0.955, 0.905],
    inks: BALLPOINT_INKS,
    light: [0.38, 0.82, 0.42],
    rule: [0.58, 0.70, 0.92],
    ruleAmt: 0.5,
    margin: [0.92, 0.48, 0.55],
    marginAmt: 0.55,
    wash: 0,
    detailInk: 1, // RED, sources/old solid on black bodies (boss, inkblot, bomber)
  },
  marker: {
    id: 'marker',
    paper: [0.965, 0.955, 0.905],
    inks: MARKER_INKS,
    light: [0.45, 0.72, 0.52],
    rule: [0.58, 0.70, 0.92],
    ruleAmt: 0,
    margin: [0.92, 0.48, 0.55],
    marginAmt: 0,
    wash: 1,
    detailInk: 3, // ORANGE, sources/new solid on black bodies
  },
};

let active = THEMES.marker;

export function themeById(id) {
  return THEMES[id] || THEMES.marker;
}

export function useTheme(id) {
  active = themeById(id);
  return active;
}

export function currentTheme() {
  return active;
}
