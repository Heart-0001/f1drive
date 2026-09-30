// F1Drive - exterior low-poly F1 car for the OTHER players' cars. See js/README-interfaces.md.
// Car-local frame as in cockpit.js: origin at ground centre, +Z forward, +Y up, +X = driver's left.
// Draw calls per car: 1 merged body (vertex colours) + 4 wheels (shared geometry) + 1 name sprite.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var WHEEL_R = 0.36, FRONT_Z = 1.9, REAR_Z = -1.7, FRONT_X = 0.82, REAR_X = 0.80;
  var FRONT_W = 0.36, REAR_W = 0.44;
  var STEER_VIS = 0.30;
  var TAG_RANGE = 150;
  var CARBON = 0x17181c, DARK = 0x0b0b0d, HELMET = 0xf2f2f2, VISOR = 0x101418;

  var shared = null;   // geometries / materials shared by every car

  function parseColour(THREE, c) {
    var col = new THREE.Color(0xff7a14);
    try {
      if (typeof c === 'number') col.setHex(c);
      else if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) col.set(c);
    } catch (e) {}
    return col;
  }

  // Collects transformed, non-indexed geometry with a per-vertex colour.
  function Merger(THREE) {
    this.THREE = THREE; this.pos = []; this.nor = []; this.col = []; this.paint = [];
  }
  // colour: hex number, or null for "body colour" (filled in later, recolourable)
  Merger.prototype.add = function (geo, colour, matrix) {
    var THREE = this.THREE;
    var g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    g.computeVertexNormals();
    var p = g.attributes.position.array, n = g.attributes.normal.array, c = new THREE.Color(colour == null ? 0xffffff : colour);
    for (var i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nor.push(n[i], n[i + 1], n[i + 2]);
      this.col.push(c.r, c.g, c.b);
      this.paint.push(colour == null ? 1 : 0);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  };
  Merger.prototype.box = function (colour, w, h, d, x, y, z, rx) {
    var THREE = this.THREE, m = new THREE.Matrix4();
    if (rx) m.makeRotationX(rx);
    m.setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), colour, m);
  };
  // box tapering along Z: back face (w0 x h0, bottom yb0) at z0 -> front face (w1 x h1, bottom yb1) at z1
  Merger.prototype.taper = function (colour, x, z0, w0, h0, yb0, z1, w1, h1, yb1) {
    var g = new this.THREE.BoxGeometry(1, 1, 1);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var t = p.getZ(i) + 0.5;
      var w = w0 + (w1 - w0) * t, h = h0 + (h1 - h0) * t, yb = yb0 + (yb1 - yb0) * t;
      p.setXYZ(i, x + p.getX(i) * w, yb + (p.getY(i) + 0.5) * h, z0 + (z1 - z0) * t);
    }
    this.add(g, colour, null);
  };
  Merger.prototype.rod = function (colour, ax, ay, az, bx, by, bz, r) {
    var THREE = this.THREE;
    var a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    var dir = b.clone().sub(a), len = dir.length();
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    var m = new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(new THREE.CylinderGeometry(r, r, len, 5, 1, true), colour, m);
  };
  Merger.prototype.build = function () {
    var THREE = this.THREE, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  };

  function buildShared(THREE) {
    // one wheel, axis along X: tyre + rim + a light mark on each sidewall so the spin reads
    var m = new Merger(THREE), rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    m.add(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 1, 16), 0x141414, rot);
    m.add(new THREE.CylinderGeometry(0.21, 0.21, 1.03, 10), 0x2a2c31, rot);
    for (var f = -1; f <= 1; f += 2) {
      m.box(0xffd21e, 0.012, 0.05, 0.20, f * 0.506, 0.27, 0);
      m.box(0xffd21e, 0.012, 0.05, 0.20, f * 0.506, -0.27, 0);
    }
    return {
      wheelGeo: m.build(),
      mat: new THREE.MeshLambertMaterial({ vertexColors: true }),
      // "ghost" cars (qualifying, spectators): see-through and not solid
      ghostMat: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false })
    };
  }

  function buildBody(THREE) {
    var m = new Merger(THREE), B = null, sx, i;
    // floor and plank
    m.box(CARBON, 1.50, 0.05, 3.30, 0, 0.085, -0.55);
    m.taper(CARBON, 0, 1.10, 1.50, 0.05, 0.06, 1.55, 0.60, 0.05, 0.06);
    // survival cell around the driver, cowl and the long nose
    m.taper(B, 0, -1.00, 0.80, 0.50, 0.11, 0.45, 0.80, 0.50, 0.11);
    m.taper(B, 0, 0.45, 0.80, 0.50, 0.11, 0.95, 0.62, 0.40, 0.18);
    m.taper(B, 0, 0.95, 0.62, 0.40, 0.18, 2.35, 0.26, 0.22, 0.22);
    m.taper(B, 0, 2.35, 0.26, 0.22, 0.22, 2.80, 0.16, 0.14, 0.26);
    // cockpit opening, driver's helmet
    m.box(DARK, 0.46, 0.02, 0.85, 0, 0.615, -0.30);
    var helmet = new THREE.SphereGeometry(0.15, 8, 6);
    m.add(helmet, HELMET, new THREE.Matrix4().makeTranslation(0, 0.74, -0.38));
    m.box(VISOR, 0.20, 0.06, 0.04, 0, 0.75, -0.245);
    // sidepods with dark inlets
    for (sx = -1; sx <= 1; sx += 2) {
      m.taper(B, sx * 0.62, -2.00, 0.30, 0.22, 0.11, -0.70, 0.52, 0.42, 0.11);
      m.taper(B, sx * 0.62, -0.70, 0.52, 0.42, 0.11, 0.30, 0.50, 0.36, 0.13);
      m.box(DARK, 0.40, 0.22, 0.02, sx * 0.62, 0.33, 0.305);
    }
    // engine cover sloping down to the gearbox, airbox above the driver's head, shark fin
    m.taper(B, 0, -2.30, 0.22, 0.26, 0.14, -0.95, 0.52, 0.86, 0.11);
    m.box(B, 0.34, 0.30, 0.40, 0, 0.82, -0.82);
    m.box(DARK, 0.24, 0.17, 0.02, 0, 0.86, -0.615);
    m.taper(CARBON, 0, -2.10, 0.03, 0.22, 0.48, -1.10, 0.03, 0.10, 0.90);
    // front wing: main plane, two flaps, endplates, pylons
    m.box(CARBON, 1.90, 0.025, 0.42, 0, 0.11, 2.60);
    m.box(B, 1.84, 0.02, 0.20, 0, 0.19, 2.50, -0.35);
    m.box(CARBON, 1.84, 0.02, 0.14, 0, 0.26, 2.40, -0.55);
    for (sx = -1; sx <= 1; sx += 2) {
      m.box(B, 0.02, 0.26, 0.50, sx * 0.95, 0.20, 2.56);
      m.box(CARBON, 0.02, 0.16, 0.20, sx * 0.06, 0.19, 2.62);
    }
    // rear wing: endplates, main plane + flap, beam wing, pylon, rain light
    for (sx = -1; sx <= 1; sx += 2) m.box(CARBON, 0.025, 0.62, 0.62, sx * 0.50, 0.70, -2.42);
    m.box(B, 0.98, 0.035, 0.34, 0, 0.93, -2.40, 0.18);
    m.box(CARBON, 0.98, 0.03, 0.16, 0, 1.00, -2.60, 0.55);
    m.box(CARBON, 0.98, 0.03, 0.22, 0, 0.44, -2.42);
    m.box(CARBON, 0.04, 0.50, 0.22, 0, 0.66, -2.36);
    m.box(0xe0202a, 0.08, 0.10, 0.03, 0, 0.30, -2.44);
    // diffuser
    m.taper(CARBON, 0, -2.45, 1.00, 0.20, 0.10, -2.05, 1.00, 0.04, 0.10);
    // halo: hoop as a few straight tubes + the centre pillar
    var hp = [[0.40, 0.66, -0.95], [0.43, 0.88, -0.45], [0.36, 0.93, 0.10], [0.16, 0.92, 0.42], [0, 0.91, 0.47]];
    for (sx = -1; sx <= 1; sx += 2) {
      for (i = 0; i + 1 < hp.length; i++) {
        m.rod(CARBON, sx * hp[i][0], hp[i][1], hp[i][2], sx * hp[i + 1][0], hp[i + 1][1], hp[i + 1][2], 0.03);
      }
    }
    m.rod(CARBON, 0, 0.91, 0.47, 0, 0.58, 0.72, 0.028);
    // mirrors
    for (sx = -1; sx <= 1; sx += 2) m.box(B, 0.14, 0.06, 0.05, sx * 0.56, 0.70, 0.30);
    // suspension: two wishbones per corner
    for (sx = -1; sx <= 1; sx += 2) {
      var fo = sx * (FRONT_X - FRONT_W / 2), ro = sx * (REAR_X - REAR_W / 2);
      m.rod(CARBON, sx * 0.22, 0.46, 1.55, fo, 0.50, FRONT_Z, 0.018);
      m.rod(CARBON, sx * 0.17, 0.42, 2.15, fo, 0.50, FRONT_Z, 0.018);
      m.rod(CARBON, sx * 0.22, 0.24, 1.55, fo, 0.22, FRONT_Z, 0.018);
      m.rod(CARBON, sx * 0.17, 0.24, 2.15, fo, 0.22, FRONT_Z, 0.018);
      m.rod(CARBON, sx * 0.20, 0.40, -1.35, ro, 0.50, REAR_Z, 0.018);
      m.rod(CARBON, sx * 0.12, 0.34, -2.10, ro, 0.50, REAR_Z, 0.018);
      m.rod(CARBON, sx * 0.22, 0.20, -1.35, ro, 0.22, REAR_Z, 0.018);
      m.rod(CARBON, sx * 0.12, 0.20, -2.10, ro, 0.22, REAR_Z, 0.018);
    }
    return { geo: m.build(), paint: m.paint };
  }

  function drawTag(ctx, w, h, name, colour) {
    ctx.clearRect(0, 0, w, h);
    var text = String(name == null ? '' : name);
    if (!text) return;
    ctx.font = '600 34px "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = Math.min(w - 40, ctx.measureText(text).width);
    var bw = tw + 46, bh = 46, x0 = (w - bw) / 2, y0 = (h - bh) / 2, r = 10;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + bw - r, y0); ctx.arcTo(x0 + bw, y0, x0 + bw, y0 + r, r);
    ctx.lineTo(x0 + bw, y0 + bh - r); ctx.arcTo(x0 + bw, y0 + bh, x0 + bw - r, y0 + bh, r);
    ctx.lineTo(x0 + r, y0 + bh); ctx.arcTo(x0, y0 + bh, x0, y0 + bh - r, r);
    ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,12,15,0.72)';
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillRect(x0 + 8, y0 + 9, 6, bh - 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, w / 2 + 8, h / 2 + 2, w - 60);
  }

  /**
   * F1.createCarModel(colour, name) -> {
   *   group,                        // THREE.Group, add to the scene
   *   update(state, dt, eye),       // state: {x, y?, z, heading, pitch?, roll?, speed, steer}; eye: optional
   *                                 //   world position {x, y, z} of the viewer (name tag range / size)
   *   setColour(colour), setName(name), dispose()
   * }   colour: '#rrggbb' or a hex number
   */
  F1.createCarModel = function (colour, name) {
    var THREE = root.THREE;
    if (!shared) shared = buildShared(THREE);

    var group = new THREE.Group();
    group.name = 'remote-car';
    group.rotation.order = 'YXZ';

    var built = buildBody(THREE);
    var bodyGeo = built.geo, paint = built.paint;
    group.add(new THREE.Mesh(bodyGeo, shared.mat));

    var wheels = [];
    var spec = [[FRONT_X, FRONT_Z, FRONT_W, true], [-FRONT_X, FRONT_Z, FRONT_W, true],
                [REAR_X, REAR_Z, REAR_W, false], [-REAR_X, REAR_Z, REAR_W, false]];
    for (var i = 0; i < spec.length; i++) {
      var pivot = new THREE.Group();
      pivot.position.set(spec[i][0], WHEEL_R, spec[i][1]);
      var spin = new THREE.Mesh(shared.wheelGeo, shared.mat);
      spin.scale.x = spec[i][2];
      pivot.add(spin);
      group.add(pivot);
      wheels.push({ pivot: pivot, spin: spin, front: spec[i][3] });
    }

    // floating name tag
    var canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    var ctx = canvas.getContext('2d');
    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    var tagMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    var tag = new THREE.Sprite(tagMat);
    tag.position.set(0, 1.75, -0.3);
    tag.scale.set(3.2, 0.6, 1);
    tag.renderOrder = 5;
    group.add(tag);

    var curColour = '', curName = null, wheelAngle = 0, ghost = false;

    function setGhost(on) {
      on = !!on;
      if (on === ghost) return;
      ghost = on;
      var mat = on ? shared.ghostMat : shared.mat;
      group.traverse(function (o) { if (o.isMesh) { o.material = mat; o.renderOrder = on ? 3 : 0; } });
      tagMat.opacity = on ? 0.6 : 1;
    }

    function setColour(c) {
      var col = parseColour(THREE, c), key = '#' + col.getHexString();
      if (key === curColour) return;
      curColour = key;
      var a = bodyGeo.attributes.color;
      for (var k = 0; k < paint.length; k++) if (paint[k]) a.setXYZ(k, col.r, col.g, col.b);
      a.needsUpdate = true;
      if (curName !== null) { drawTag(ctx, canvas.width, canvas.height, curName, curColour); tex.needsUpdate = true; }
    }
    function setName(n) {
      n = String(n == null ? '' : n);
      if (n === curName) return;
      curName = n;
      drawTag(ctx, canvas.width, canvas.height, curName, curColour || '#ffffff');
      tex.needsUpdate = true;
    }

    function update(state, dt, eye) {
      if (!state) return;
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      var y = state.y || 0;
      group.position.set(state.x, y, state.z);
      group.rotation.set(-(state.pitch || 0), state.heading || 0, state.roll || 0);
      var steer = state.steer || 0;
      wheelAngle = (wheelAngle + (state.speed || 0) / WHEEL_R * dt) % (Math.PI * 2);
      for (var w = 0; w < 4; w++) {
        if (wheels[w].front) wheels[w].pivot.rotation.y = steer * STEER_VIS;
        wheels[w].spin.rotation.x = wheelAngle;
      }
      if (eye) {
        var dx = eye.x - state.x, dy = (eye.y || 0) - y, dz = eye.z - state.z;
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        tag.visible = d < TAG_RANGE && d > 3;
        if (tag.visible) {
          // keep the tag readable further away: grow it with distance (up to 4x)
          var k = d < 25 ? 1 : (d > 100 ? 4 : d / 25);
          tag.scale.set(3.2 * k, 0.6 * k, 1);
          tag.position.y = 1.55 + 0.3 * k;
        }
      } else {
        tag.visible = true;
      }
    }

    function dispose() {
      bodyGeo.dispose();
      tex.dispose();
      tagMat.dispose();
    }

    setColour(colour);
    setName(name || '');
    return { group: group, update: update, setColour: setColour, setName: setName, setGhost: setGhost, dispose: dispose };
  };
})(typeof window !== 'undefined' ? window : globalThis);
