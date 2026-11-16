// Converte o DwgDatabase (LibreDWG) em uma "cena" 2D pronta para desenhar:
// traços agrupados por layer/cor, preenchimentos, textos e polígonos com área.
import { aciToCss, rgbIntToCss } from './aci.js';

const TAU = Math.PI * 2;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DEPTH = 12;

// ---------- Matrizes afins 2D: [a, b, c, d, e, f] → x' = a·x + c·y + e ; y' = b·x + d·y + f
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const det = (m) => m[0] * m[3] - m[1] * m[2];

function applyFlat(m, pts) {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

/** Sistema de coordenadas do objeto (OCS): extrusão (0,0,-1) espelha o eixo X. */
function ocs(ent) {
  return ent.extrusionDirection && ent.extrusionDirection.z < 0 ? scale(-1, 1) : IDENTITY;
}

// ---------- Tesselação
function arcSegments(sweep) {
  return Math.max(8, Math.ceil((Math.abs(sweep) / TAU) * 128));
}

function arcPoints(cx, cy, r, a0, a1, out = []) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  const n = arcSegments(sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Ellipse com eixo maior (mx,my) relativo ao centro; parâmetros t0..t1. */
function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, out = [], clockwise = false) {
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += TAU;
  const n = arcSegments(sweep);
  const nx = -my * ratio, ny = mx * ratio;
  for (let i = 0; i <= n; i++) {
    let t = t0 + (sweep * i) / n;
    if (clockwise) t = -t;
    out.push(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t));
  }
  return out;
}

/** Adiciona o arco definido por bulge entre (x1,y1) e (x2,y2), sem repetir o ponto inicial. */
function bulgePoints(out, x1, y1, x2, y2, b) {
  const theta = 4 * Math.atan(b);
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return;
  const r = chord / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const cx = (x1 + x2) / 2 - (h * dy) / chord;
  const cy = (y1 + y2) / 2 + (h * dx) / chord;
  const rad = Math.abs(r);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const n = arcSegments(theta);
  for (let k = 1; k <= n; k++) {
    const a = a1 + (theta * k) / n;
    out.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
  }
}

/** Polilinha com bulges → pontos + área exata (com segmentos circulares) + perímetro. */
function bulgePolyline(verts, closed) {
  const pts = [];
  let shoelace = 0, segArea = 0, perimeter = 0;
  const n = verts.length;
  const count = closed ? n : n - 1;
  if (n === 0) return { pts, area: 0, perimeter: 0 };
  pts.push(verts[0].x, verts[0].y);
  for (let i = 0; i < count; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    const b = p.bulge || 0;
    shoelace += p.x * q.y - q.x * p.y;
    const chord = Math.hypot(q.x - p.x, q.y - p.y);
    if (Math.abs(b) > 1e-10 && chord > 0) {
      const theta = 4 * Math.atan(b);
      const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
      const at = Math.abs(theta);
      segArea += Math.sign(b) * 0.5 * r * r * (at - Math.sin(at));
      perimeter += r * at;
      bulgePoints(pts, p.x, p.y, q.x, q.y, b);
    } else {
      perimeter += chord;
      pts.push(q.x, q.y);
    }
  }
  return { pts, area: Math.abs(shoelace / 2 + segArea), perimeter };
}

/** NURBS por de Boor; fallback para polilinha de controle/ajuste. */
function splinePoints(degree, knots, ctrl, weights, fit) {
  const n = ctrl?.length ?? 0;
  const p = degree || 3;
  if (!n || !knots || knots.length !== n + p + 1) {
    const src = n ? ctrl : fit || [];
    return src.flatMap((c) => [c.x, c.y]);
  }
  const w = (i) => weights?.[i] ?? ctrl[i].weight ?? ctrl[i].w ?? 1;
  const t0 = knots[p], t1 = knots[n];
  const samples = Math.min(2000, Math.max(32, n * 10));
  const out = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 - 1e-12 * Math.abs(t1 - t0) : t0 + ((t1 - t0) * s) / samples;
    let k = p;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[j + k - p], wj = w(j + k - p);
      d.push([c.x * wj, c.y * wj, wj]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = j + k - p;
        const den = knots[i + 1 + p - r] - knots[i];
        const alpha = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = [0, 1, 2].map((q) => (1 - alpha) * d[j - 1][q] + alpha * d[j][q]);
      }
    }
    out.push(d[p][0] / d[p][2], d[p][1] / d[p][2]);
  }
  return out;
}

// ---------- Geometria de polígonos
export function ringArea(pts) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return s / 2;
}

function ringPerimeter(pts, closed = true) {
  let s = 0;
  const n = pts.length;
  const lim = closed ? n : n - 2;
  for (let i = 0; i < lim; i += 2) {
    const j = (i + 2) % n;
    s += Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]);
  }
  return s;
}

export function pointInRing(x, y, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringBBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i];
      if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minY) minY = r[i + 1];
      if (r[i + 1] > maxY) maxY = r[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
    a += f;
    cx += (pts[i] + pts[j]) * f;
    cy += (pts[i + 1] + pts[j + 1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const bb = ringBBox([pts]);
    return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// ---------- Texto
const SPECIAL = { c: 'Ø', d: '°', p: '±' };
function cleanText(s = '') {
  return String(s)
    .replace(/%%([cdp])/gi, (_, k) => SPECIAL[k.toLowerCase()])
    .replace(/\\P/g, '\n')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*);/g, (_, a) => a.replace(/[#^]/, '/'))
    .replace(/\\[ACcFfHhQqTtWwp][^;]*;/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '');
}

const H_ALIGN = ['left', 'center', 'right', 'left', 'center', 'left'];
const V_ALIGN = ['alphabetic', 'bottom', 'middle', 'top'];
const MTEXT_ATTACH = {
  1: ['left', 'top'], 2: ['center', 'top'], 3: ['right', 'top'],
  4: ['left', 'middle'], 5: ['center', 'middle'], 6: ['right', 'middle'],
  7: ['left', 'bottom'], 8: ['center', 'bottom'], 9: ['right', 'bottom']
};

// ---------- Construção da cena
export function buildScene(db) {
  const layerTable = new Map();
  for (const l of db.tables?.LAYER?.entries ?? []) {
    const ci = l.colorIndex ?? 7;
    layerTable.set(l.name, {
      name: l.name,
      color: ci >= 1 && ci <= 255 ? aciToCss(Math.abs(ci)) : l.color ? rgbIntToCss(l.color) : aciToCss(7),
      visible: !l.off && !l.frozen && ci >= 0,
      count: 0
    });
  }
  const blocks = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) blocks.set(b.name, b);

  const groups = new Map();
  const texts = [];
  const polygons = [];
  const counts = {};
  const unsupported = {};

  const layerOf = (name) => {
    if (!layerTable.has(name)) layerTable.set(name, { name, color: aciToCss(7), visible: true, count: 0 });
    return layerTable.get(name);
  };

  const group = (layer, color) => {
    const key = `${layer}\u0000${color}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { layer, color, strokes: [], fills: [], hatchOutlines: [] }));
    return g;
  };

  function resolveColor(ent, layerName, ctx) {
    const ci = ent.colorIndex;
    if (ci >= 1 && ci <= 255) return aciToCss(ci);
    if (ci === 0) return ctx.blockColor ?? layerOf(layerName).color;
    if (ent.color != null && ci !== 256 && ent.color !== 0) return rgbIntToCss(ent.color);
    return layerOf(layerName).color;
  }

  function addPolygon(info) {
    const bb = ringBBox(info.rings);
    if (!isFinite(bb.minX) || !(info.area > 0)) return;
    polygons.push({
      id: polygons.length,
      ...info,
      bbox: bb,
      centroid: centroid(info.rings[0])
    });
  }

  function walk(entities, M, ctx) {
    if (ctx.depth > MAX_DEPTH) return;
    for (const ent of entities) {
      if (!ent || ent.isVisible === false || ent.isInPaperSpace) continue;
      if (ctx.depth === 0) counts[ent.type] = (counts[ent.type] || 0) + 1;
      const layerName = ent.layer === '0' && ctx.blockLayer ? ctx.blockLayer : ent.layer || '0';
      const layer = layerOf(layerName);
      if (ctx.depth === 0) layer.count++;
      const color = resolveColor(ent, layerName, ctx);
      const Mo = mul(M, ocs(ent));
      const scaleAbs = Math.abs(det(Mo));
      const stroke = (pts) => pts.length >= 4 && group(layerName, color).strokes.push(applyFlat(Mo, pts));
      const base = { handle: ent.handle, layer: layerName, source: ctx.depth === 0 ? 'modelo' : 'bloco', color };

      try {
        switch (ent.type) {
          case 'LINE':
            stroke([ent.startPoint.x, ent.startPoint.y, ent.endPoint.x, ent.endPoint.y]);
            break;

          case 'CIRCLE': {
            const pts = arcPoints(ent.center.x, ent.center.y, ent.radius, 0, TAU);
            stroke(pts);
            const ring = applyFlat(Mo, pts.slice(0, -2));
            addPolygon({
              ...base, type: 'Círculo', rings: [ring],
              area: Math.PI * ent.radius * ent.radius * scaleAbs,
              perimeter: ringPerimeter(ring)
            });
            break;
          }

          case 'ARC':
            stroke(arcPoints(ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle));
            break;

          case 'ELLIPSE': {
            const { x: mx, y: my } = ent.majorAxisEndPoint;
            const full = Math.abs(Math.abs(ent.endAngle - ent.startAngle) - TAU) < 1e-6 || ent.endAngle === ent.startAngle;
            const pts = ellipsePoints(ent.center.x, ent.center.y, mx, my, ent.axisRatio, full ? 0 : ent.startAngle, full ? TAU : ent.endAngle);
            stroke(pts);
            if (full) {
              const a = Math.hypot(mx, my);
              const ring = applyFlat(Mo, pts.slice(0, -2));
              addPolygon({
                ...base, type: 'Elipse', rings: [ring],
                area: Math.PI * a * a * ent.axisRatio * scaleAbs,
                perimeter: ringPerimeter(ring)
              });
            }
            break;
          }

          case 'LWPOLYLINE':
          case 'POLYLINE2D':
          case 'POLYLINE3D': {
            if (ent.type === 'POLYLINE2D' && ent.flag & 64) break; // polyface mesh
            const verts = (ent.vertices || []).filter((v) => !(v.flag & 16));
            if (verts.length < 2) break;
            const first = verts[0], last = verts[verts.length - 1];
            const coincident = verts.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
            // LibreDWG: LWPOLYLINE fechada = bit 512; POLYLINE 2D/3D = bit 1 (como no DXF)
            const closedFlag = ent.type === 'LWPOLYLINE' ? ent.flag & 512 : ent.flag & 1;
            const closed = Boolean(closedFlag) || coincident;
            const vv = coincident ? verts.slice(0, -1) : verts;
            const bp = bulgePolyline(ent.type === 'POLYLINE3D' ? vv.map((v) => ({ x: v.x, y: v.y, bulge: 0 })) : vv, closed);
            stroke(bp.pts);
            if (closed && vv.length >= 3) {
              const ring = applyFlat(Mo, bp.pts.slice(0, -2));
              addPolygon({
                ...base, type: 'Polilinha', rings: [ring],
                area: bp.area * scaleAbs,
                perimeter: bp.perimeter * Math.sqrt(scaleAbs),
                vertices: vv.length
              });
            }
            break;
          }

          case 'SPLINE': {
            const pts = splinePoints(ent.degree, ent.knots, ent.controlPoints, ent.weights, ent.fitPoints);
            stroke(pts);
            break;
          }

          case 'SOLID':
          case 'TRACE':
          case '3DFACE': {
            const c = [ent.corner1, ent.corner2, ent.corner4 ?? ent.corner3, ent.corner3].filter(Boolean);
            if (c.length >= 3) {
              const pts = c.flatMap((p) => [p.x, p.y]);
              const g = group(layerName, color);
              if (ent.type === '3DFACE') g.strokes.push(applyFlat(Mo, [...pts, pts[0], pts[1]]));
              else g.fills.push([applyFlat(Mo, pts)]);
            }
            break;
          }

          case 'HATCH': {
            const rings = [];
            for (const path of ent.boundaryPaths || []) {
              let pts = [];
              if (path.vertices) {
                pts = bulgePolyline(path.vertices, true).pts.slice(0, -2);
              } else {
                for (const e of path.edges || []) {
                  if (e.type === 1) pts.push(e.start.x, e.start.y, e.end.x, e.end.y);
                  else if (e.type === 2) {
                    const cw = e.isCCW === false;
                    const seg = arcPoints(0, 0, e.radius, e.startAngle, e.endAngle);
                    for (let i = 0; i < seg.length; i += 2) pts.push(e.center.x + seg[i], e.center.y + (cw ? -seg[i + 1] : seg[i + 1]));
                  } else if (e.type === 3) {
                    ellipsePoints(e.center.x, e.center.y, e.end.x, e.end.y, e.lengthOfMinorAxis, e.startAngle, e.endAngle, pts, e.isCCW === false);
                  } else if (e.type === 4) {
                    pts.push(...splinePoints(e.degree, e.knots, e.controlPoints, null, e.fitDatum));
                  }
                }
              }
              if (pts.length >= 6) rings.push(applyFlat(Mo, pts));
            }
            if (!rings.length) break;
            const g = group(layerName, color);
            if (ent.solidFill === 1) g.fills.push(rings);
            else g.hatchOutlines.push(rings);

            // Área líquida: anéis com profundidade par somam, ímpar subtraem (furos/ilhas).
            let area = 0;
            rings.forEach((r, i) => {
              let depth = 0;
              rings.forEach((o, j) => { if (i !== j && pointInRing(r[0], r[1], o)) depth++; });
              area += (depth % 2 === 0 ? 1 : -1) * Math.abs(ringArea(r));
            });
            const outer = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
            addPolygon({
              ...base, type: `Hachura${ent.solidFill === 1 ? ' (sólida)' : ent.patternName ? ` (${ent.patternName})` : ''}`,
              rings, area: Math.abs(area),
              perimeter: rings.reduce((s, r) => s + ringPerimeter(r), 0),
              outer
            });
            break;
          }

          case 'TEXT':
          case 'ATTRIB':
          case 'ATTDEF': {
            if (ent.type === 'ATTDEF' && ctx.depth > 0) break; // definições não aparecem em blocos inseridos
            const aligned = (ent.halign || 0) !== 0 || (ent.valign || 0) !== 0;
            const useEnd = aligned && ent.endPoint && ent.halign !== 3 && ent.halign !== 5;
            const p = useEnd ? ent.endPoint : ent.startPoint;
            pushText(Mo, p, ent.textHeight, ent.rotation || 0, cleanText(ent.text ?? ent.tag),
              H_ALIGN[ent.halign || 0] || 'left', ent.halign === 4 ? 'middle' : V_ALIGN[ent.valign || 0] || 'alphabetic', layerName, color);
            break;
          }

          case 'MTEXT': {
            const dir = ent.direction;
            const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : ent.rotation || 0;
            const [ha, va] = MTEXT_ATTACH[ent.attachmentPoint] || ['left', 'top'];
            pushText(Mo, ent.insertionPoint, ent.textHeight, rot, cleanText(ent.text), ha, va, layerName, color, ent.lineSpacing);
            break;
          }

          case 'INSERT': {
            const blk = blocks.get(ent.name);
            if (blk?.entities?.length) {
              const bp = blk.basePoint || { x: 0, y: 0 };
              const cols = Math.max(1, ent.columnCount || 1), rows = Math.max(1, ent.rowCount || 1);
              const childCtx = { depth: ctx.depth + 1, blockColor: color, blockLayer: layerName };
              for (let r = 0; r < rows && r * cols < 2000; r++) {
                for (let c = 0; c < cols; c++) {
                  const T = [
                    translate(ent.insertionPoint.x, ent.insertionPoint.y),
                    rotate(ent.rotation || 0),
                    translate(c * (ent.columnSpacing || 0), r * (ent.rowSpacing || 0)),
                    scale(ent.xScale || 1, ent.yScale || 1),
                    translate(-bp.x, -bp.y)
                  ].reduce(mul, Mo);
                  walk(blk.entities, T, childCtx);
                }
              }
            }
            if (ent.attribs?.length) walk(ent.attribs, M, { ...ctx, depth: ctx.depth + 1 });
            break;
          }

          case 'DIMENSION': {
            const blk = blocks.get(ent.name);
            if (blk?.entities?.length) walk(blk.entities, M, { depth: ctx.depth + 1, blockColor: color, blockLayer: layerName });
            break;
          }

          case 'POINT':
          case 'VIEWPORT':
          case 'XLINE':
          case 'RAY':
            break;

          default: {
            if (Array.isArray(ent.vertices) && ent.vertices[0]?.x != null) {
              stroke(ent.vertices.flatMap((v) => [v.x, v.y]));
            } else if (ctx.depth === 0) {
              unsupported[ent.type] = (unsupported[ent.type] || 0) + 1;
            }
          }
        }
      } catch (err) {
        console.warn('Falha ao processar entidade', ent.type, ent.handle, err);
      }
    }
  }

  function pushText(M, p, h, rot, text, align, baseline, layer, color, lineSpacing = 1) {
    if (!p || !text || !(h > 0)) return;
    const x = M[0] * p.x + M[2] * p.y + M[4];
    const y = M[1] * p.x + M[3] * p.y + M[5];
    texts.push({
      x, y,
      h: h * Math.hypot(M[2], M[3]),
      rot: rot + Math.atan2(M[1], M[0]),
      lines: text.split('\n'),
      align, baseline, layer, color,
      lineSpacing: lineSpacing || 1
    });
  }

  walk(db.entities || [], IDENTITY, { depth: 0 });

  // Extensão do desenho (robusta a entidades isoladas muito distantes)
  const xs = [], ys = [];
  for (const g of groups.values()) {
    for (const s of [...g.strokes, ...g.fills.flat(), ...g.hatchOutlines.flat()]) {
      const step = Math.max(2, Math.floor(s.length / 64) * 2);
      for (let i = 0; i < s.length; i += step) { xs.push(s[i]); ys.push(s[i + 1]); }
    }
  }
  for (const t of texts) { xs.push(t.x); ys.push(t.y); }
  const bbox = robustBBox(xs, ys);

  return {
    groups: [...groups.values()],
    texts,
    polygons,
    counts,
    unsupported,
    layers: [...layerTable.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true })),
    bbox,
    header: db.header || {}
  };
}

function robustBBox(xs, ys) {
  if (!xs.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  const full = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < full.minX) full.minX = xs[i];
    if (xs[i] > full.maxX) full.maxX = xs[i];
    if (ys[i] < full.minY) full.minY = ys[i];
    if (ys[i] > full.maxY) full.maxY = ys[i];
  }
  if (xs.length < 50) return full;
  const q = (arr, f) => arr[Math.floor(f * (arr.length - 1))];
  const sx = Float64Array.from(xs).sort(), sy = Float64Array.from(ys).sort();
  const lo = 0.01, hi = 0.99;
  const core = { minX: q(sx, lo), minY: q(sy, lo), maxX: q(sx, hi), maxY: q(sy, hi) };
  const w = core.maxX - core.minX || 1, h = core.maxY - core.minY || 1;
  // Usa a extensão total, a menos que outliers a inflem demais.
  if ((full.maxX - full.minX) > 20 * w || (full.maxY - full.minY) > 20 * h) {
    return { minX: core.minX - 0.1 * w, minY: core.minY - 0.1 * h, maxX: core.maxX + 0.1 * w, maxY: core.maxY + 0.1 * h };
  }
  return full;
}
