export type RackModule = {
  id: string; name: string; maker: string; family: string;
  hp: number; depthMm: number; plus12Ma: number; minus12Ma: number; plus5Ma: number;
  sourceUrl: string; note?: string;
};

// Curated snapshots, not live specifications. Keep provenance beside every record.
export const CATALOG_VERSION = "2026-10-01";
export const CATALOG: RackModule[] = [
  { id: "maths", name: "MATHS", maker: "Make Noise", family: "Function generator", hp: 20, depthMm: 32, plus12Ma: 60, minus12Ma: 50, plus5Ma: 0, sourceUrl: "https://www.makenoisemusic.com/modules/maths/", note: "Depth includes the power cable." },
  { id: "plaits", name: "Plaits", maker: "Mutable Instruments", family: "Macro oscillator", hp: 12, depthMm: 25, plus12Ma: 50, minus12Ma: 5, plus5Ma: 0, sourceUrl: "https://pichenettes.github.io/mutable-instruments-documentation/modules/plaits/", note: "Specifications apply to the original Mutable Instruments module; verify third-party clones separately." },
  { id: "pams-pro", name: "Pamela's PRO", maker: "ALM Busy Circuits", family: "Clock & modulation", hp: 8, depthMm: 32, plus12Ma: 60, minus12Ma: 10, plus5Ma: 0, sourceUrl: "https://busycircuits.com/pages/alm034", note: "Approximate depth with power header. Original PRO model; expanders are not included." },
  { id: "morphagene", name: "Morphagene", maker: "Make Noise", family: "Stereo sampler", hp: 20, depthMm: 45, plus12Ma: 165, minus12Ma: 20, plus5Ma: 0, sourceUrl: "https://www.makenoisemusic.com/modules/morphagene/", note: "Depth includes the power cable." },
  { id: "disting-ex", name: "Disting EX", maker: "Expert Sleepers", family: "Multifunction", hp: 8, depthMm: 50, plus12Ma: 229, minus12Ma: 50, plus5Ma: 0, sourceUrl: "https://www.expert-sleepers.co.uk/distingEX.html", note: "Leave clearance for the ribbon cable and any expansion headers." },
];

export const CASE = {
  id: "104hp-tps80w-profile", name: "104 HP · TPS80W profile", hp: 104, maxDepthMm: 53,
  plus12Ma: 3000, minus12Ma: 3000, plus5Ma: 1500,
  sourceUrl: "https://intellijel.com/shop/power/tps-power-supply-eurorack/",
  note: "One 3U row; 53 mm is a planning clearance, not a verified case measurement. Power assumes no load from other rows or 1U modules. Confirm your case generation, brick, cable clearance and bus-board position before installation.",
};

export const DEFAULT_MODULE_IDS = ["maths", "pams-pro", "morphagene", "disting-ex"];

export function calculatePlan(moduleIds: string[], headroom = 0.2) {
  if (!Array.isArray(moduleIds) || moduleIds.length > 32) throw new Error("Choose up to 32 modules.");
  if (!Number.isFinite(headroom) || headroom < 0 || headroom > 0.5) throw new Error("Power reserve must be between 0% and 50%.");
  const selected = moduleIds.map((id) => {
    const item = CATALOG.find((module) => module.id === id);
    if (!item) throw new Error("A selected module is not in the catalog.");
    return item;
  });
  const totals = selected.reduce((sum, item) => ({
    hp: sum.hp + item.hp, depthMm: Math.max(sum.depthMm, item.depthMm),
    plus12Ma: sum.plus12Ma + item.plus12Ma, minus12Ma: sum.minus12Ma + item.minus12Ma, plus5Ma: sum.plus5Ma + item.plus5Ma,
  }), { hp: 0, depthMm: 0, plus12Ma: 0, minus12Ma: 0, plus5Ma: 0 });
  const limits = {
    hp: CASE.hp, depthMm: CASE.maxDepthMm,
    plus12Ma: Math.floor(CASE.plus12Ma * (1 - headroom)),
    minus12Ma: Math.floor(CASE.minus12Ma * (1 - headroom)),
    plus5Ma: Math.floor(CASE.plus5Ma * (1 - headroom)),
  };
  const checks = {
    width: totals.hp <= limits.hp, depth: totals.depthMm <= limits.depthMm,
    plus12: totals.plus12Ma <= limits.plus12Ma, minus12: totals.minus12Ma <= limits.minus12Ma, plus5: totals.plus5Ma <= limits.plus5Ma,
  };
  return { case: CASE, modules: selected, totals, limits, headroom, checks, fits: selected.length > 0 && Object.values(checks).every(Boolean) };
}

export type Calculation = ReturnType<typeof calculatePlan>;
