// Renderizador Canvas 2D com pan (arrastar) e zoom (roda do mouse / pinça).
// A geometria é convertida em Path2D uma única vez, relativa a uma origem local,
// para manter a precisão com coordenadas grandes (ex.: UTM).
const MIN_TEXT_PX = 2;

export class Viewer {
  constructor(canvas, { onPointer, onClick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.paths = [];
    this.hiddenLayers = new Set();
    this.selected = null;
    this.view = { s: 1, cx: 0, cy: 0 }; // escala (px/unidade) e centro em coordenadas locais
    this.origin = { x: 0, y: 0 };
    this.onPointer = onPointer;
    this.onClick = onClick;
    this.frame = 0;
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
  }

  // ---------- Cena
  setScene(scene) {
    this.scene = scene;
    this.selected = null;
    const { bbox } = scene;
    const ox = (bbox.minX + bbox.maxX) / 2, oy = (bbox.minY + bbox.maxY) / 2;
    this.origin = { x: ox, y: oy };

    this.paths = scene.groups.map((g) => {
      const stroke = new Path2D();
      for (const s of g.strokes) addPoly(stroke, s, ox, oy, false);
      for (const rings of g.hatchOutlines) for (const r of rings) addPoly(stroke, r, ox, oy, true);
      const fill = new Path2D();
      for (const rings of g.fills) for (const r of rings) addPoly(fill, r, ox, oy, true);
      const hatch = new Path2D();
      for (const rings of g.hatchOutlines) for (const r of rings) addPoly(hatch, r, ox, oy, true);
      return { layer: g.layer, color: g.color, stroke, fill, hatch, hasFill: g.fills.length > 0, hasHatch: g.hatchOutlines.length > 0 };
    });
    this.fit();
  }

  setLayerVisible(name, visible) {
    if (visible) this.hiddenLayers.delete(name);
    else this.hiddenLayers.add(name);
    this.requestDraw();
  }

  select(polygon) {
    this.selected = polygon;
    if (polygon) {
      const path = new Path2D();
      for (const r of polygon.rings) addPoly(path, r, this.origin.x, this.origin.y, true);
      this.selectedPath = path;
    }
    this.requestDraw();
  }

  // ---------- Navegação
  fit(bbox = this.scene?.bbox, padding = 0.06) {
    if (!bbox) return;
    const w = this.width, h = this.height;
    const bw = Math.max(bbox.maxX - bbox.minX, 1e-9), bh = Math.max(bbox.maxY - bbox.minY, 1e-9);
    this.view.s = Math.min(w / bw, h / bh) * (1 - 2 * padding);
    this.view.cx = (bbox.minX + bbox.maxX) / 2 - this.origin.x;
    this.view.cy = (bbox.minY + bbox.maxY) / 2 - this.origin.y;
    this.requestDraw();
  }

  zoomAt(factor, sx = this.width / 2, sy = this.height / 2) {
    const before = this.screenToLocal(sx, sy);
    this.view.s = Math.min(Math.max(this.view.s * factor, 1e-9), 1e9);
    const after = this.screenToLocal(sx, sy);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.requestDraw();
  }

  screenToLocal(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.view.s + this.view.cx,
      y: -(sy - this.height / 2) / this.view.s + this.view.cy
    };
  }

  screenToWorld(sx, sy) {
    const p = this.screenToLocal(sx, sy);
    return { x: p.x + this.origin.x, y: p.y + this.origin.y };
  }

  // ---------- Desenho
  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const { ctx, dpr, width: w, height: h } = this;
    const bg = getComputedStyle(this.canvas).getPropertyValue('--canvas-bg').trim() || '#1b1f24';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.scene) return;

    const { s, cx, cy } = this.view;
    const worldTf = () => ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (w / 2 - cx * s), dpr * (h / 2 + cy * s));

    worldTf();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const p of this.paths) {
      if (this.hiddenLayers.has(p.layer)) continue;
      if (p.hasFill) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = p.color;
        ctx.fill(p.fill, 'evenodd');
      }
      if (p.hasHatch) {
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = p.color;
        ctx.fill(p.hatch, 'evenodd');
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1 / s;
      ctx.stroke(p.stroke);
    }

    if (this.selected && this.selectedPath) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#ffb000';
      ctx.fill(this.selectedPath, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffb000';
      ctx.lineWidth = 2.5 / s;
      ctx.stroke(this.selectedPath);
    }

    this._drawTexts();
  }

  _drawTexts() {
    const { ctx, dpr, width: w, height: h } = this;
    const { s } = this.view;
    const ox = this.origin.x, oy = this.origin.y;
    const margin = 200;
    ctx.globalAlpha = 1;
    for (const t of this.scene.texts) {
      if (this.hiddenLayers.has(t.layer)) continue;
      const px = t.h * s;
      if (px < MIN_TEXT_PX) continue;
      const lx = t.x - ox, ly = t.y - oy;
      const sx = (lx - this.view.cx) * s + w / 2;
      const sy = -(ly - this.view.cy) * s + h / 2;
      const extent = px * Math.max(...t.lines.map((l) => l.length), 1) + margin;
      if (sx < -extent || sx > w + extent || sy < -extent || sy > h + extent) continue;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(sx, sy);
      ctx.rotate(-t.rot);
      ctx.fillStyle = t.color;
      ctx.font = `${px}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = t.align;
      const step = px * 1.6 * t.lineSpacing;
      const n = t.lines.length;
      let y0 = 0;
      if (n > 1) {
        if (t.baseline === 'middle') y0 = (-(n - 1) * step) / 2;
        else if (t.baseline === 'bottom' || t.baseline === 'alphabetic') y0 = -(n - 1) * step;
      }
      ctx.textBaseline = t.baseline;
      for (let i = 0; i < n; i++) ctx.fillText(t.lines[i], 0, y0 + i * step);
    }
  }

  // ---------- Eventos
  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.requestDraw();
  }

  _bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(factor, p.x, p.y);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      if (pointers.size === 1) drag = { start: pos(e), last: pos(e), moved: false };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt(d / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.dist = d;
      } else if (drag) {
        const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
        if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.cx -= dx / this.view.s;
          this.view.cy += dy / this.view.s;
          c.style.cursor = 'grabbing';
          this.requestDraw();
        }
        drag.last = p;
      }
      if (this.scene) this.onPointer?.(this.screenToWorld(p.x, p.y));
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (drag && !drag.moved && e.type === 'pointerup' && this.scene) {
        const p = pos(e);
        this.onClick?.(this.screenToWorld(p.x, p.y));
      }
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => this.fit());
  }
}

function addPoly(path, pts, ox, oy, close) {
  if (pts.length < 4) return;
  path.moveTo(pts[0] - ox, pts[1] - oy);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i] - ox, pts[i + 1] - oy);
  if (close) path.closePath();
}
