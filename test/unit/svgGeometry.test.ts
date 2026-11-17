import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeGeometry, type Geometry } from "../../scripts/verify-svg.mjs";

const vb = { x: 0, y: 0, w: 1000, h: 500 };
const t = (i: number, label: string, x: number, y: number, w: number, h = 12) => ({ i, label, x, y, w, h });
const r = (i: number, x: number, y: number, w: number, h: number) => ({ i, x, y, w, h });
const page = r(0, 0, 0, 1000, 500);

describe("SVG geometry checker (catches real layout defects)", () => {
  const ok: Geometry = { viewBox: vb, rects: [page, r(1, 100, 100, 300, 100)], texts: [t(0, "inside", 150, 140, 100)] };

  it("passes a clean layout", () => {
    assert.deepEqual(analyzeGeometry(ok), []);
  });

  it("flags text overflowing its box", () => {
    const g = { ...ok, texts: [t(0, "way too long label", 120, 140, 290)] };
    assert.match(analyzeGeometry(g)[0]!, /does not fit inside its box/);
  });

  it("flags text hugging a box edge (padding)", () => {
    const g = { ...ok, texts: [t(0, "tight", 102, 140, 100)] };
    assert.equal(analyzeGeometry(g).length, 1);
    assert.equal(analyzeGeometry(g, { padding: 1 }).length, 0);
  });

  it("flags overlapping labels but not touching-free neighbours", () => {
    const over = { ...ok, texts: [t(0, "A", 150, 140, 100), t(1, "B", 200, 144, 100)] };
    assert.ok(analyzeGeometry(over).some((i) => /overlaps text/.test(i)));
    const apart = { ...ok, texts: [t(0, "A", 150, 120, 100), t(1, "B", 150, 150, 100)] };
    assert.deepEqual(analyzeGeometry(apart), []);
  });

  it("flags text outside the viewBox", () => {
    const g = { ...ok, texts: [t(0, "off", 950, 140, 100)], rects: [page] };
    assert.match(analyzeGeometry(g)[0]!, /outside the viewBox/);
  });

  it("flags partially overlapping boxes but allows nesting", () => {
    const partial = { ...ok, rects: [page, r(1, 100, 100, 300, 100), r(2, 350, 150, 300, 100)], texts: [] };
    assert.match(analyzeGeometry(partial)[0]!, /partially overlap/);
    const nested = { ...ok, rects: [page, r(1, 100, 100, 300, 200), r(2, 120, 120, 100, 50)], texts: [] };
    assert.deepEqual(analyzeGeometry(nested), []);
  });

  it("checks text against the smallest enclosing box", () => {
    const g = { viewBox: vb, rects: [page, r(1, 100, 100, 600, 300), r(2, 120, 120, 120, 40)], texts: [t(0, "wide", 125, 130, 150)] };
    assert.match(analyzeGeometry(g)[0]!, /does not fit/);
  });
});
