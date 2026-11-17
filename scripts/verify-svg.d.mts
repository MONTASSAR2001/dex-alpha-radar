export interface Box { x: number; y: number; w: number; h: number }
export interface Geometry {
  viewBox: Box;
  texts: (Box & { i: number; label: string })[];
  rects: (Box & { i: number })[];
}
export function analyzeGeometry(g: Geometry, opts?: { padding?: number }): string[];
export function verifySvg(
  svgPath: string,
  opts?: { padding?: number; screenshot?: string },
): Promise<{ issues: string[]; geometry: Geometry; browser: string }>;
