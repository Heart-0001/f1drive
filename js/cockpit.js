// F1Drive - first-person cockpit model + camera rig. See js/README-interfaces.md.
// Car-local frame: +Z forward, +Y up, +X = driver's LEFT (because heading h -> forward (sin h, 0, cos h)).
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var EYE_Y = 0.80, EYE_Z = -0.35;
  var FOV_MIN = 70, FOV_MAX = 82, V_TOP = 330 / 3.6;
  var WHEEL_R = 0.36, WHEEL_W = 0.36, WHEEL_X = 0.82, AXLE_Z = 1.9;
  var WHEEL_STEER_VIS = 0.30;      // rad of visible front-wheel steer at steer = 1
  var HANDWHEEL_VIS = 1.0;         // rad of steering-wheel rotation at steer = 1

  // ---- driver head look (right stick) ---------------------------------------
  // Limits follow what a real F1 driver can do. The helmet is boxed in by the headrest surround and
  // tethered by the HANS device, so the HEAD only turns about 20-25 deg to each side and nods a few
  // degrees; the rest of a mirror check is done with the EYES (comfortably ~30 deg sideways inside the
  // visor opening). Full stick therefore gives head + eyes:
  //   yaw   25 deg head + 30 deg eyes = 55 deg each way (enough to read a mirror, not to look behind)
  //   pitch a few degrees of nod + eyes, cut off by the visor top edge / the chin bar and cockpit rim
  var DEG = Math.PI / 180;
  var LOOK_HEAD_YAW = 25 * DEG;    // part of the yaw done by turning the helmet (moves the eye point)
  var LOOK_EYE_YAW = 30 * DEG;     // part done by the eyes alone
  var LOOK_MAX_YAW = LOOK_HEAD_YAW + LOOK_EYE_YAW;   // 55 deg
  var LOOK_MAX_PITCH_UP = 12 * DEG;
  var LOOK_MAX_PITCH_DOWN = 10 * DEG;
  var LOOK_SMOOTH = 0.12;          // s, critically damped follow time (stick flicks do not snap the view)
  var LOOK_NECK = 0.09;            // m from the neck axis forward to the eyes: turning the head swings
                                   //   the eye point sideways a little, as it does for the driver

  // radians
  F1.COCKPIT_LOOK = { maxYaw: LOOK_MAX_YAW, maxPitchUp: LOOK_MAX_PITCH_UP, maxPitchDown: LOOK_MAX_PITCH_DOWN,
                      headYaw: LOOK_HEAD_YAW, smoothTime: LOOK_SMOOTH };

  F1.createCockpit = function (camera) {
    var THREE = root.THREE;
    var group = new THREE.Group();
    group.name = 'cockpit';
    group.rotation.order = 'YXZ';

    // ---- materials (livery: papaya + carbon black, cyan accents) ----
    var mBody = new THREE.MeshLambertMaterial({ color: 0xff7a14 });
    var mCarbon = new THREE.MeshLambertMaterial({ color: 0x17181c });
    var mDark = new THREE.MeshLambertMaterial({ color: 0x0b0b0d });
    var mTyre = new THREE.MeshLambertMaterial({ color: 0x141414 });
    var mRim = new THREE.MeshLambertMaterial({ color: 0x2a2c31 });
    var mAccent = new THREE.MeshLambertMaterial({ color: 0x19c8e6 });
    var mYellow = new THREE.MeshLambertMaterial({ color: 0xffd21e });
    var mWhite = new THREE.MeshLambertMaterial({ color: 0xe9e9e9 });
    var mMirror = new THREE.MeshLambertMaterial({ color: 0x9fb6cc, emissive: 0x2a3a4a });
    var mScreen = new THREE.MeshLambertMaterial({ color: 0x0a1a12, emissive: 0x1f8a4a });
    var mRed = new THREE.MeshLambertMaterial({ color: 0xe0202a, emissive: 0x400808 });
    var mGreen = new THREE.MeshLambertMaterial({ color: 0x2bd046, emissive: 0x0a3a10 });
    var mBlue = new THREE.MeshLambertMaterial({ color: 0x2a6cff, emissive: 0x081a40 });
    var mGlove = new THREE.MeshLambertMaterial({ color: 0x20242c });

    // ---- helpers ----
    function box(parent, mat, w, h, d, x, y, z) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    }
    // box tapering along Z: back face (w0 x h0) at z0, front face (w1 x h1) at z1; bottoms at yb0 / yb1
    function taper(parent, mat, z0, w0, h0, yb0, z1, w1, h1, yb1) {
      var g = new THREE.BoxGeometry(1, 1, 1);
      var p = g.attributes.position;
      for (var i = 0; i < p.count; i++) {
        var t = p.getZ(i) + 0.5;
        var w = w0 + (w1 - w0) * t, h = h0 + (h1 - h0) * t, yb = yb0 + (yb1 - yb0) * t;
        p.setXYZ(i, p.getX(i) * w, yb + (p.getY(i) + 0.5) * h, z0 + (z1 - z0) * t);
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
      var m = new THREE.Mesh(g, mat);
      parent.add(m);
      return m;
    }
    var UP = new THREE.Vector3(0, 1, 0);
    function rod(parent, mat, ax, ay, az, bx, by, bz, r) {
      var a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
      var dir = b.clone().sub(a), len = dir.length();
      var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, dir.normalize());
      parent.add(m);
      return m;
    }

    // ---- chassis ----
    var body = new THREE.Group();
    group.add(body);
    // floor / tub under the driver
    box(body, mCarbon, 0.9, 0.12, 3.4, 0, 0.12, -0.6);
    // cockpit side walls (rim beside the driver) and dark inner liner
    for (var sx = -1; sx <= 1; sx += 2) {
      box(body, mBody, 0.13, 0.40, 1.55, sx * 0.345, 0.36, -0.30);
      box(body, mDark, 0.02, 0.22, 1.30, sx * 0.275, 0.44, -0.25);
      // sidepods
      taper(body, mBody, -1.9, 0.50, 0.36, 0.10, 0.15, 0.42, 0.30, 0.14).position.x = sx * 0.66;
      box(body, mCarbon, 0.46, 0.02, 1.9, sx * 0.66, 0.085, -0.85);
    }
    // front cowl ahead of the steering wheel, then the long tapered nose
    taper(body, mBody, 0.42, 0.82, 0.44, 0.18, 0.95, 0.62, 0.38, 0.20);
    taper(body, mBody, 0.95, 0.62, 0.38, 0.20, 2.35, 0.26, 0.22, 0.22);
    taper(body, mBody, 2.35, 0.26, 0.22, 0.22, 2.78, 0.16, 0.14, 0.26);
    // centre stripe and accent on the nose top (slightly proud of the surface)
    taper(body, mCarbon, 0.60, 0.16, 0.006, 0.608, 0.95, 0.14, 0.006, 0.582);
    taper(body, mCarbon, 0.95, 0.14, 0.006, 0.582, 2.35, 0.07, 0.006, 0.442);
    taper(body, mAccent, 2.35, 0.26, 0.006, 0.442, 2.78, 0.16, 0.006, 0.402);
    // dash bulkhead behind the steering wheel
    box(body, mDark, 0.80, 0.42, 0.04, 0, 0.385, 0.405);
    // headrest / airbox behind the driver (only seen in lights/shadows, cheap)
    box(body, mCarbon, 0.5, 0.5, 0.6, 0, 0.62, -1.15);

    // ---- front wing ----
    box(body, mCarbon, 1.90, 0.025, 0.42, 0, 0.11, 2.60);
    var flap = box(body, mBody, 1.84, 0.02, 0.20, 0, 0.19, 2.50);
    flap.rotation.x = -0.35;
    var flap2 = box(body, mCarbon, 1.84, 0.02, 0.14, 0, 0.26, 2.40);
    flap2.rotation.x = -0.55;
    for (sx = -1; sx <= 1; sx += 2) {
      box(body, mBody, 0.02, 0.26, 0.50, sx * 0.95, 0.20, 2.56);
      box(body, mAccent, 0.022, 0.05, 0.50, sx * 0.95, 0.31, 2.56);
      // wing pylons
      box(body, mCarbon, 0.02, 0.16, 0.20, sx * 0.06, 0.19, 2.62);
    }

    // ---- front suspension (wishbones, push rod, track rod) ----
    for (sx = -1; sx <= 1; sx += 2) {
      var ox = sx * (WHEEL_X - WHEEL_W / 2 - 0.02);
      rod(body, mCarbon, sx * 0.22, 0.50, 1.55, ox, 0.52, AXLE_Z, 0.014);   // upper rear
      rod(body, mCarbon, sx * 0.17, 0.46, 2.15, ox, 0.52, AXLE_Z, 0.014);   // upper front
      rod(body, mCarbon, sx * 0.22, 0.24, 1.55, ox, 0.22, AXLE_Z, 0.014);   // lower rear
      rod(body, mCarbon, sx * 0.17, 0.24, 2.15, ox, 0.22, AXLE_Z, 0.014);   // lower front
      rod(body, mCarbon, sx * 0.20, 0.50, 1.80, ox, 0.24, AXLE_Z, 0.012);   // push rod
      rod(body, mCarbon, sx * 0.21, 0.42, 1.68, ox, 0.40, AXLE_Z - 0.12, 0.010); // track rod
    }

    // ---- front wheels ----
    var tyreGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 28);
    tyreGeo.rotateZ(Math.PI / 2);                       // axis along X
    var rimGeo = new THREE.CylinderGeometry(0.21, 0.21, WHEEL_W + 0.012, 18);
    rimGeo.rotateZ(Math.PI / 2);
    var bandGeo = new THREE.TorusGeometry(0.295, 0.012, 5, 28);
    bandGeo.rotateY(Math.PI / 2);                       // ring around the X axis
    var markGeo = new THREE.BoxGeometry(0.006, 0.05, 0.16);
    var wheels = [];
    for (sx = -1; sx <= 1; sx += 2) {
      var pivot = new THREE.Group();
      pivot.position.set(sx * WHEEL_X, WHEEL_R, AXLE_Z);
      var spin = new THREE.Group();
      spin.add(new THREE.Mesh(tyreGeo, mTyre));
      spin.add(new THREE.Mesh(rimGeo, mRim));
      for (var f = -1; f <= 1; f += 2) {               // compound band + lettering on both sidewalls
        var band = new THREE.Mesh(bandGeo, mYellow);
        band.position.x = f * (WHEEL_W / 2 - 0.004);
        spin.add(band);
        for (var k = 0; k < 2; k++) {
          var mark = new THREE.Mesh(markGeo, mWhite);
          mark.position.set(f * (WHEEL_W / 2 + 0.001), (k ? -1 : 1) * 0.255, 0);
          spin.add(mark);
        }
      }
      pivot.add(spin);
      group.add(pivot);
      wheels.push({ pivot: pivot, spin: spin });
    }

    // ---- halo: thin central pillar + hoop well above the eye line (front of the hoop sits ~27 deg
    //      above the horizon from the eye, so the road and crests ahead stay open) ----
    var haloPts = [];
    var half = [[0.44, 0.80, -1.00], [0.48, 1.02, -0.55], [0.47, 1.18, -0.10], [0.38, 1.29, 0.30], [0.20, 1.325, 0.56]];
    var i;
    for (i = 0; i < half.length; i++) haloPts.push(new THREE.Vector3(half[i][0], half[i][1], half[i][2]));
    haloPts.push(new THREE.Vector3(0, 1.33, 0.64));
    for (i = half.length - 1; i >= 0; i--) haloPts.push(new THREE.Vector3(-half[i][0], half[i][1], half[i][2]));
    var haloCurve = new THREE.CatmullRomCurve3(haloPts, false, 'catmullrom', 0.5);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(haloCurve, 40, 0.017, 7, false), mCarbon));
    // pillar: thin across the view, deeper along it; from the cowl up to the front of the hoop
    var pillar = box(group, mCarbon, 0.018, 0.77, 0.06, 0, 0.958, 0.770);
    pillar.rotation.x = -0.36;   // leans back toward the driver at the top

    // ---- mirrors on stalks ----
    for (sx = -1; sx <= 1; sx += 2) {
      rod(group, mCarbon, sx * 0.40, 0.56, 0.42, sx * 0.76, 0.685, 0.51, 0.009);
      var housing = box(group, mBody, 0.13, 0.055, 0.05, sx * 0.80, 0.70, 0.52);
      housing.rotation.y = sx * -0.30;                   // angled toward the driver
      var glass = new THREE.Mesh(new THREE.BoxGeometry(0.112, 0.040, 0.006), mMirror);
      glass.position.z = -0.027;
      housing.add(glass);
    }

    // ---- steering wheel ----
    var column = new THREE.Group();
    column.position.set(0, 0.53, 0.22);
    column.scale.setScalar(0.88);
    column.rotation.x = 0.30;                            // face tilted up toward the driver's eyes
    group.add(column);
    rod(column, mDark, 0, 0, 0.0, 0, 0, 0.26, 0.022);    // column into the dash
    var hand = new THREE.Group();
    column.add(hand);
    box(hand, mCarbon, 0.27, 0.125, 0.024, 0, 0, 0);                 // centre plate
    box(hand, mCarbon, 0.20, 0.03, 0.024, 0, 0.072, 0);              // top bar
    box(hand, mScreen, 0.105, 0.058, 0.006, 0, 0.018, -0.014);       // display
    for (sx = -1; sx <= 1; sx += 2) {
      box(hand, mDark, 0.042, 0.17, 0.036, sx * 0.145, -0.005, -0.004);   // grips
      box(hand, mGlove, 0.058, 0.10, 0.060, sx * 0.148, -0.012, -0.012);  // gloves
    }
    function button(mat, x, y, r) {
      var b = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.008, 10), mat);
      b.rotation.x = Math.PI / 2;
      b.position.set(x, y, -0.015);
      hand.add(b);
    }
    button(mRed, 0.090, 0.030, 0.011);
    button(mGreen, -0.090, 0.030, 0.011);
    button(mBlue, 0.088, -0.004, 0.009);
    button(mYellow, -0.088, -0.004, 0.009);
    button(mAccent, 0.040, -0.036, 0.008);
    button(mWhite, -0.040, -0.036, 0.008);
    button(mRed, 0, -0.038, 0.010);
    // shift lights along the top bar
    for (i = 0; i < 7; i++) {
      box(hand, i < 3 ? mGreen : (i < 5 ? mRed : mBlue), 0.014, 0.008, 0.004, (i - 3) * 0.022, 0.074, -0.013);
    }

    // ---- camera rig ----
    camera.near = Math.min(camera.near, 0.06);
    camera.fov = FOV_MIN;
    camera.updateProjectionMatrix();
    camera.position.set(0, EYE_Y, EYE_Z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, Math.PI, 0);                  // look along local +Z
    group.add(camera);

    // ---- animation state ----
    var lastHeading = null, latG = 0, shake = 0, time = 0, fov = FOV_MIN, wheelAngle = 0;
    // head look: target (from setLook) and the smoothed value + its rate, in radians
    var lookYawT = 0, lookPitchT = 0, lookYaw = 0, lookPitch = 0, lookYawV = 0, lookPitchV = 0;

    // Where the driver looks, NORMALISED: x, y in -1..1 (x: +1 = full LEFT, y: +1 = full UP), i.e. the
    // right stick as reported by F1.gamepad (state.lookX, state.lookY). Out-of-range values are clamped;
    // the angles come from F1.COCKPIT_LOOK. The value is kept until the next call, so call it every
    // frame (0, 0 = straight ahead); the view follows smoothly in update().
    function setLook(x, y) {
      x = x > 1 ? 1 : (x < -1 ? -1 : (x === x ? +x || 0 : 0));
      y = y > 1 ? 1 : (y < -1 ? -1 : (y === y ? +y || 0 : 0));
      lookYawT = x * LOOK_MAX_YAW;
      lookPitchT = y > 0 ? y * LOOK_MAX_PITCH_UP : y * LOOK_MAX_PITCH_DOWN;
    }
    // Snap the view straight ahead at once (no easing), e.g. after a reset or on right-stick click.
    function centreLook() {
      lookYawT = lookPitchT = lookYaw = lookPitch = lookYawV = lookPitchV = 0;
    }
    // critically damped spring towards the target (exact for any dt, never overshoots)
    function followLook(dt) {
      if (!(dt > 0)) return;
      var w = 2 / LOOK_SMOOTH, e = Math.exp(-w * dt), d, tmp;
      d = lookYaw - lookYawT; tmp = (lookYawV + w * d) * dt;
      lookYawV = (lookYawV - w * tmp) * e; lookYaw = lookYawT + (d + tmp) * e;
      d = lookPitch - lookPitchT; tmp = (lookPitchV + w * d) * dt;
      lookPitchV = (lookPitchV - w * tmp) * e; lookPitch = lookPitchT + (d + tmp) * e;
      if (lookYawT === 0 && Math.abs(lookYaw) < 1e-5 && Math.abs(lookYawV) < 1e-4) lookYaw = lookYawV = 0;
      if (lookPitchT === 0 && Math.abs(lookPitch) < 1e-5 && Math.abs(lookPitchV) < 1e-4) lookPitch = lookPitchV = 0;
    }

    function update(state, dt) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      time += dt;
      var speed = state.speed || 0, av = Math.abs(speed), steer = state.steer || 0;

      // yaw about world Y, then pitch about the car's lateral (X) axis, then roll about its forward (Z)
      // axis. Local +X is the driver's LEFT, so +rotation.x would tip the nose DOWN (hence -pitch) and
      // +rotation.z lifts the left side (same sign as roll / bank).
      group.position.set(state.x, state.y || 0, state.z);
      group.rotation.set(-(state.pitch || 0), state.heading, state.roll || 0);

      // steering wheel (+steer = left = top of the wheel moves toward +X) and front wheels
      hand.rotation.z = -steer * HANDWHEEL_VIS;
      wheelAngle = (wheelAngle + speed / WHEEL_R * dt) % (Math.PI * 2);
      for (var w = 0; w < 2; w++) {
        wheels[w].pivot.rotation.y = steer * WHEEL_STEER_VIS;
        wheels[w].spin.rotation.x = wheelAngle;
      }

      // FOV widens gently with speed
      var t = Math.min(1, av / V_TOP);
      var target = FOV_MIN + (FOV_MAX - FOV_MIN) * t * t * (3 - 2 * t);
      fov += (target - fov) * Math.min(1, dt * 3);
      if (Math.abs(fov - camera.fov) > 0.02) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // lateral g estimate from yaw rate (positive = turning left), smoothed
      var yawRate = 0;
      if (lastHeading !== null && dt > 0) {
        var dh = state.heading - lastHeading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        yawRate = dh / dt;
      }
      lastHeading = state.heading;
      var g = Math.max(-5, Math.min(5, speed * yawRate / 9.81));
      latG += (g - latG) * Math.min(1, dt * 5);

      // shake: wall hits (decaying) + grass rumble + a whisper of high-speed buzz
      if (state.hit > shake) shake = state.hit;
      shake *= Math.exp(-5 * dt);
      if (shake < 0.002) shake = 0;
      var rumble = state.onGrass ? Math.min(1, av / 25) : 0;
      var buzz = Math.min(1, av / V_TOP);
      var ox = 0, oy = 0, rx = 0, rz = 0;
      if (shake > 0) {
        ox += (Math.random() - 0.5) * 0.05 * shake;
        oy += (Math.random() - 0.5) * 0.05 * shake;
        rx += (Math.random() - 0.5) * 0.030 * shake;
        rz += (Math.random() - 0.5) * 0.040 * shake;
      }
      if (rumble > 0) {
        oy += (Math.sin(time * 61) * 0.6 + Math.sin(time * 37 + 1.3) * 0.4) * 0.010 * rumble;
        ox += Math.sin(time * 47 + 0.7) * 0.004 * rumble;
        rz += Math.sin(time * 29) * 0.004 * rumble;
      }
      oy += Math.sin(time * 83) * 0.0012 * buzz * buzz;

      // head look, on top of the pose / shake / lean. The cockpit model stays put; only the camera turns
      // (order YXZ: yaw about the car's up axis, then pitch about the turned lateral axis). The helmet
      // does the first LOOK_HEAD_YAW of the yaw about the neck, which carries the eyes sideways a bit.
      followLook(dt);
      var headYaw = lookYaw * (LOOK_HEAD_YAW / LOOK_MAX_YAW);
      var hx = LOOK_NECK * Math.sin(headYaw), hz = LOOK_NECK * (Math.cos(headYaw) - 1);

      // head leans slightly into the corner
      camera.position.set(latG * 0.006 + ox + hx, EYE_Y + oy, EYE_Z + hz);
      camera.rotation.set(rx + lookPitch, Math.PI + lookYaw, latG * 0.005 + rz);
    }

    return { group: group, update: update, setLook: setLook, centreLook: centreLook };
  };
})(typeof window !== 'undefined' ? window : globalThis);
