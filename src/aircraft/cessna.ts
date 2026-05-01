import * as THREE from 'three';

/**
 * Procedural Cessna 172-style aircraft.
 *
 * Body-frame convention (matches FlightModel):
 *   +X forward (nose)
 *   +Y up
 *   +Z right (right wing)
 *
 * The returned `group` has its origin at the gear contact point on the ground,
 * so placing the group at world Y = 0 puts the wheels flush with the runway.
 *
 * Hinge axis conventions (so HUD/flight code can match signs):
 *   - leftAileron / rightAileron: hinge along the local Z axis of the pivot
 *     (spanwise). Positive `aileron` deflection (right-roll command) rotates
 *     the right aileron trailing edge UP and the left aileron trailing edge
 *     DOWN. Implemented as: leftAileron.rotation.z = +aileron,
 *     rightAileron.rotation.z = -aileron.
 *   - elevator: hinge along local Z (spanwise). Positive `elevator` deflection
 *     means trailing edge UP (nose-up pitch command).
 *     elevatorPivot.rotation.z = +elevator.
 *   - rudder: hinge along local Y (vertical). Positive `rudder` deflection
 *     means trailing edge RIGHT (nose-right yaw command).
 *     rudderPivot.rotation.y = +rudder.
 *   - flaps: hinge along local Z. Positive `flaps` deflection means trailing
 *     edge DOWN. flapsPivot.rotation.z = -flaps. (Conventionally flaps are
 *     non-negative.)
 *
 * NOTE: because the aircraft frame is +X forward and surfaces sit at the
 *  trailing edge (negative X relative to the hinge), a rotation that brings
 *  the trailing edge UP (towards +Y) is a positive rotation about +Z by
 *  right-hand rule, i.e. rotation.z = +deflection.
 */

export interface CessnaParts {
  propeller: THREE.Object3D;
  leftAileron: THREE.Object3D;
  rightAileron: THREE.Object3D;
  elevator: THREE.Object3D;
  rudder: THREE.Object3D;
  flaps: THREE.Object3D;
}

export interface CessnaBuild {
  group: THREE.Group;
  parts: CessnaParts;
}

// --- Materials -------------------------------------------------------------

const matBody = new THREE.MeshStandardMaterial({
  color: 0xf2f2f2,
  roughness: 0.55,
  metalness: 0.05,
});
const matStripe = new THREE.MeshStandardMaterial({
  color: 0x1a4f9c,
  roughness: 0.45,
  metalness: 0.1,
});
const matAccent = new THREE.MeshStandardMaterial({
  color: 0xc8c8c8,
  roughness: 0.5,
  metalness: 0.2,
});
const matGlass = new THREE.MeshStandardMaterial({
  color: 0x121820,
  roughness: 0.15,
  metalness: 0.4,
  transparent: true,
  opacity: 0.85,
});
const matRubber = new THREE.MeshStandardMaterial({
  color: 0x1a1a1a,
  roughness: 0.9,
  metalness: 0.0,
});
const matMetal = new THREE.MeshStandardMaterial({
  color: 0x444444,
  roughness: 0.4,
  metalness: 0.7,
});
const matPropBlade = new THREE.MeshStandardMaterial({
  color: 0x202020,
  roughness: 0.55,
  metalness: 0.3,
});
const matPropTip = new THREE.MeshStandardMaterial({
  color: 0xf2c43c,
  roughness: 0.5,
  metalness: 0.1,
});
const matSpinner = new THREE.MeshStandardMaterial({
  color: 0xf2f2f2,
  roughness: 0.4,
  metalness: 0.3,
});

// Reused geometry helpers ---------------------------------------------------

/**
 * Build a wing/airfoil-ish slab oriented to the body frame.
 * length is span (along Z), chord is X, thickness is Y.
 * Uses ExtrudeGeometry with a cambered teardrop shape so the leading edge
 * faces +X.
 */
function buildAirfoilSlab(
  span: number,
  chord: number,
  thickness: number,
  segments: number,
): THREE.BufferGeometry {
  // 2D airfoil profile in the X–Y plane (X is chord direction, +X = leading
  //   edge towards aircraft nose). We then extrude along Z by `span`.
  const shape = new THREE.Shape();
  const c = chord;
  const t = thickness;
  // Trailing edge at x = -c/2, leading edge at x = +c/2.
  // Asymmetric (slightly cambered) profile: top arc taller than bottom.
  shape.moveTo(-c * 0.5, 0);
  // upper surface
  shape.bezierCurveTo(
    -c * 0.4, t * 0.55,
    c * 0.1, t * 0.55,
    c * 0.5, 0,
  );
  // lower surface
  shape.bezierCurveTo(
    c * 0.1, -t * 0.3,
    -c * 0.4, -t * 0.3,
    -c * 0.5, 0,
  );

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: span,
    bevelEnabled: false,
    curveSegments: segments,
    steps: 1,
  });
  // Center along the extrusion (Z) axis.
  geom.translate(0, 0, -span * 0.5);
  return geom;
}

/**
 * Build a fuselage as a LatheGeometry rotated to lie along the X axis.
 * Returns a geometry whose long axis is X, with origin at fuselage centroid.
 */
function buildFuselage(length: number, radius: number): THREE.BufferGeometry {
  // Profile points in (r, x) where x is along the fuselage length.
  // We'll define the profile in lathe-local (x = radius axis, y = along axis),
  // then rotate so y -> world X.
  const halfL = length * 0.5;
  const pts: THREE.Vector2[] = [];
  // Sample along the length from nose (+X) to tail (-X).
  const segs = 14;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs; // 0 at nose, 1 at tail
    const x = halfL - t * length; // +halfL at nose, -halfL at tail
    // radius profile: small at nose, max ~30% in, taper to small at tail
    let r: number;
    if (t < 0.18) {
      // nose dome
      const s = t / 0.18;
      r = radius * (0.45 + 0.55 * Math.sin(s * Math.PI * 0.5));
    } else if (t < 0.7) {
      r = radius * (0.95 + 0.05 * Math.sin((t - 0.18) * Math.PI));
    } else {
      // tail boom taper
      const s = (t - 0.7) / 0.3;
      r = radius * (0.95 - 0.7 * s);
    }
    pts.push(new THREE.Vector2(Math.max(r, 0.05), x));
  }
  const lathe = new THREE.LatheGeometry(pts, 18);
  // LatheGeometry rotates points around the y axis with x = radius.
  // After construction, the geometry's "long" axis is Y (the second component
  //   of Vector2). We rotate so that long axis becomes +X.
  lathe.rotateZ(-Math.PI / 2);
  return lathe;
}

// --- Builder ---------------------------------------------------------------

export function buildCessna(): CessnaBuild {
  const root = new THREE.Group();
  root.name = 'CessnaRoot';

  // The "body" group contains everything that should be at body-frame origin
  //   (nominally near the wing root / center of mass area). We then translate
  //   the whole `root` so that its origin sits at the gear contact point.
  const body = new THREE.Group();
  body.name = 'CessnaBody';
  root.add(body);

  // Approximate Cessna 172 dimensions (in meters):
  const FUSE_LEN = 7.0;
  const FUSE_R = 0.62; // radius of widest part
  const WING_SPAN = 11.0;
  const WING_CHORD = 1.5;
  const WING_THICK = 0.16;
  const WING_DIHEDRAL = THREE.MathUtils.degToRad(2.5);
  const WING_Y = 1.05; // wing root above body origin (high-wing)
  const WING_X_OFFSET = 0.35; // wings slightly forward of center of fuselage
  const HSTAB_SPAN = 3.4;
  const HSTAB_CHORD = 0.85;
  const HSTAB_THICK = 0.1;
  const VSTAB_HEIGHT = 1.4;
  const VSTAB_CHORD = 1.1;
  const VSTAB_THICK = 0.1;
  const PROP_DIAM = 1.85;
  const GEAR_HEIGHT = 0.85; // distance from body origin to ground

  // ---- Fuselage ----------------------------------------------------------
  const fuseGeom = buildFuselage(FUSE_LEN, FUSE_R);
  const fuselage = new THREE.Mesh(fuseGeom, matBody);
  fuselage.name = 'fuselage';
  body.add(fuselage);

  // Blue stripe along the side: a thin slab mounted on each side.
  const stripeLen = FUSE_LEN * 0.78;
  const stripeGeom = new THREE.BoxGeometry(stripeLen, 0.12, 0.01);
  const stripeRight = new THREE.Mesh(stripeGeom, matStripe);
  stripeRight.position.set(-0.1, 0.05, FUSE_R + 0.005);
  body.add(stripeRight);
  const stripeLeft = new THREE.Mesh(stripeGeom, matStripe);
  stripeLeft.position.set(-0.1, 0.05, -(FUSE_R + 0.005));
  body.add(stripeLeft);

  // Belly stripe (under fuselage, contrasting): thin accent
  const bellyStripeGeom = new THREE.BoxGeometry(stripeLen * 0.7, 0.01, 0.18);
  const bellyStripe = new THREE.Mesh(bellyStripeGeom, matStripe);
  bellyStripe.position.set(-0.2, -FUSE_R * 0.92, 0);
  body.add(bellyStripe);

  // ---- Cabin / Windshield -----------------------------------------------
  // Windshield: a tilted box just behind the firewall.
  const windshieldGeom = new THREE.BoxGeometry(0.9, 0.55, 1.05);
  const windshield = new THREE.Mesh(windshieldGeom, matGlass);
  windshield.position.set(1.05, 0.55, 0);
  windshield.rotation.z = THREE.MathUtils.degToRad(-22);
  body.add(windshield);

  // Cabin top / greenhouse
  const cabinTopGeom = new THREE.BoxGeometry(1.6, 0.35, 1.1);
  const cabinTop = new THREE.Mesh(cabinTopGeom, matBody);
  cabinTop.position.set(0.4, 0.78, 0);
  body.add(cabinTop);

  // Side windows (left + right)
  const sideWinGeom = new THREE.BoxGeometry(1.45, 0.42, 0.02);
  const sideWinR = new THREE.Mesh(sideWinGeom, matGlass);
  sideWinR.position.set(0.35, 0.55, FUSE_R + 0.01);
  body.add(sideWinR);
  const sideWinL = new THREE.Mesh(sideWinGeom, matGlass);
  sideWinL.position.set(0.35, 0.55, -(FUSE_R + 0.01));
  body.add(sideWinL);

  // Rear windows (small triangles approximated as small boxes)
  const rearWinGeom = new THREE.BoxGeometry(0.55, 0.3, 0.02);
  const rearWinR = new THREE.Mesh(rearWinGeom, matGlass);
  rearWinR.position.set(-0.6, 0.5, FUSE_R + 0.01);
  body.add(rearWinR);
  const rearWinL = new THREE.Mesh(rearWinGeom, matGlass);
  rearWinL.position.set(-0.6, 0.5, -(FUSE_R + 0.01));
  body.add(rearWinL);

  // ---- Wings (high mounted, slight dihedral) -----------------------------
  // Build each wing as an extruded airfoil. Span axis = Z. Right wing
  //   extrudes towards +Z, left wing towards -Z. We put each wing under its
  //   own pivot (at the wing root) so we can apply dihedral cleanly.
  const wingGeom = buildAirfoilSlab(
    WING_SPAN * 0.5 - FUSE_R * 0.6,
    WING_CHORD,
    WING_THICK,
    8,
  );
  // wingGeom is centered on Z; shift it so root is at Z = 0 and tip at +Z.
  const wingHalfSpan = WING_SPAN * 0.5 - FUSE_R * 0.6;
  wingGeom.translate(0, 0, wingHalfSpan * 0.5);

  // Right wing pivot (at root)
  const rightWingPivot = new THREE.Group();
  rightWingPivot.name = 'rightWingPivot';
  rightWingPivot.position.set(WING_X_OFFSET, WING_Y, FUSE_R * 0.6);
  rightWingPivot.rotation.x = -WING_DIHEDRAL; // tip up: rotate about +X (forward)
  // Note: with +X forward, +Y up, +Z right, a positive rotation about +X
  //   tilts +Z down. We want the right tip up, so we use a negative rotation.
  body.add(rightWingPivot);

  const rightWing = new THREE.Mesh(wingGeom, matBody);
  rightWing.name = 'rightWing';
  rightWingPivot.add(rightWing);

  // Right wing blue trim stripe along leading edge top
  const wingStripeGeom = new THREE.BoxGeometry(0.08, 0.02, wingHalfSpan * 0.95);
  const rightWingStripe = new THREE.Mesh(wingStripeGeom, matStripe);
  rightWingStripe.position.set(
    WING_CHORD * 0.32,
    WING_THICK * 0.55,
    wingHalfSpan * 0.5,
  );
  rightWingPivot.add(rightWingStripe);

  // Left wing pivot (mirror)
  const leftWingGeom = wingGeom.clone();
  // mirror across z by flipping its z translation: instead, build pivot
  //   that extrudes towards -Z by using a separate geometry.
  leftWingGeom.translate(0, 0, -wingHalfSpan); // shift so root at z=0, tip at -z
  const leftWingPivot = new THREE.Group();
  leftWingPivot.name = 'leftWingPivot';
  leftWingPivot.position.set(WING_X_OFFSET, WING_Y, -FUSE_R * 0.6);
  leftWingPivot.rotation.x = WING_DIHEDRAL;
  body.add(leftWingPivot);

  const leftWing = new THREE.Mesh(leftWingGeom, matBody);
  leftWing.name = 'leftWing';
  leftWingPivot.add(leftWing);

  const leftWingStripe = new THREE.Mesh(wingStripeGeom, matStripe);
  leftWingStripe.position.set(
    WING_CHORD * 0.32,
    WING_THICK * 0.55,
    -wingHalfSpan * 0.5,
  );
  leftWingPivot.add(leftWingStripe);

  // Wing struts (one each side, from lower fuselage to mid-wing). Cylinders.
  const strutLen = Math.hypot(WING_Y - 0.0, FUSE_R * 0.8);
  const strutGeom = new THREE.CylinderGeometry(0.04, 0.04, strutLen, 8);
  for (const sign of [1, -1]) {
    const strut = new THREE.Mesh(strutGeom, matAccent);
    // Position strut so it visually connects fuselage (at body Y=0,
    //   Z = sign*FUSE_R*0.5) to wing underside at half span.
    const midY = WING_Y * 0.5;
    const midZ = sign * (FUSE_R * 0.5 + wingHalfSpan * 0.4) * 0.5;
    strut.position.set(WING_X_OFFSET, midY, midZ);
    // rotate strut so its long (Y) axis points from lower fuselage to wing tip
    strut.rotation.x = sign * THREE.MathUtils.degToRad(28);
    body.add(strut);
  }

  // ---- Ailerons (on outboard trailing edge of each wing) ------------------
  // Aileron is its own pivot, hinge along Z. Geometry is a thin slab with
  //   leading edge near the hinge (X=0) and trailing edge at -aileronChord.
  const ailSpan = wingHalfSpan * 0.4;
  const ailChord = WING_CHORD * 0.28;
  const ailThick = WING_THICK * 0.7;
  const ailGeom = new THREE.BoxGeometry(ailChord, ailThick, ailSpan);

  const rightAileronPivot = new THREE.Group();
  rightAileronPivot.name = 'rightAileronPivot';
  // Hinge sits at trailing edge of wing, outboard half.
  rightAileronPivot.position.set(
    -WING_CHORD * 0.5 + 0.01,
    0,
    wingHalfSpan * 0.7,
  );
  rightWingPivot.add(rightAileronPivot);
  const rightAileron = new THREE.Mesh(ailGeom, matBody);
  rightAileron.name = 'rightAileron';
  // Move geometry so its leading edge is at the pivot (X=0) and it extends
  //   towards -X (trailing).
  rightAileron.position.set(-ailChord * 0.5, 0, 0);
  rightAileronPivot.add(rightAileron);

  const leftAileronPivot = new THREE.Group();
  leftAileronPivot.name = 'leftAileronPivot';
  leftAileronPivot.position.set(
    -WING_CHORD * 0.5 + 0.01,
    0,
    -wingHalfSpan * 0.7,
  );
  leftWingPivot.add(leftAileronPivot);
  const leftAileron = new THREE.Mesh(ailGeom, matBody);
  leftAileron.name = 'leftAileron';
  leftAileron.position.set(-ailChord * 0.5, 0, 0);
  leftAileronPivot.add(leftAileron);

  // ---- Flaps (inboard trailing edge of each wing, single shared pivot
  //              made up of two halves rotated together) ------------------
  // We create one flapsPivot Object3D that contains two flap meshes (one per
  //   wing) so a single rotation drives both.
  const flapSpan = wingHalfSpan * 0.45;
  const flapChord = WING_CHORD * 0.25;
  const flapThick = WING_THICK * 0.7;
  const flapGeom = new THREE.BoxGeometry(flapChord, flapThick, flapSpan);

  const flapsPivot = new THREE.Group();
  flapsPivot.name = 'flapsPivot';
  // Place at body-frame: at wing root trailing edge, on body centerline.
  flapsPivot.position.set(
    WING_X_OFFSET - WING_CHORD * 0.5 + 0.01,
    WING_Y,
    0,
  );
  body.add(flapsPivot);

  const flapR = new THREE.Mesh(flapGeom, matBody);
  flapR.position.set(-flapChord * 0.5, 0, FUSE_R * 0.6 + flapSpan * 0.5);
  flapsPivot.add(flapR);
  const flapL = new THREE.Mesh(flapGeom, matBody);
  flapL.position.set(-flapChord * 0.5, 0, -(FUSE_R * 0.6 + flapSpan * 0.5));
  flapsPivot.add(flapL);

  // ---- Tail: vertical stabilizer + rudder --------------------------------
  // Vertical stabilizer is a thin slab in the X–Y plane mounted at the tail.
  const vstabShape = new THREE.Shape();
  // tail fin shape (swept). Define in X–Y; will extrude along Z (thickness).
  vstabShape.moveTo(0, 0);
  vstabShape.lineTo(VSTAB_CHORD * 0.85, 0);
  vstabShape.lineTo(VSTAB_CHORD * 0.55, VSTAB_HEIGHT);
  vstabShape.lineTo(0, VSTAB_HEIGHT);
  vstabShape.lineTo(0, 0);
  const vstabGeom = new THREE.ExtrudeGeometry(vstabShape, {
    depth: VSTAB_THICK,
    bevelEnabled: false,
    steps: 1,
  });
  vstabGeom.translate(0, 0, -VSTAB_THICK * 0.5);
  // Currently extrudeShape lies in X–Y, extrudes along +Z. That matches
  //   our convention: vertical fin standing in body Y, with thickness along Z.
  // Translate so that hinge edge of the rudder (the rear of the fin) is at
  //   x = -FUSE_LEN*0.42 (tail boom area). vstabShape's near edge is at x=0
  //   (front), far edge at x = +VSTAB_CHORD*0.85.  Mirror so the swept tip
  //   is at the rear: rotate 180° about Y? Easier: build with leading edge
  //   forward by negating x.
  vstabGeom.scale(-1, 1, 1);
  // After scaling, near edge (was front) is at x=0, far edge at x=-VSTAB_CHORD*0.85
  //   - we want fin attached to the top of the tail: place its base at
  //   x = -FUSE_LEN*0.4, y = FUSE_R*0.4 (top of tail boom).
  const vstab = new THREE.Mesh(vstabGeom, matBody);
  vstab.name = 'verticalStabilizer';
  vstab.position.set(-FUSE_LEN * 0.42, FUSE_R * 0.35, 0);
  body.add(vstab);

  // Rudder: hinge at the rear of the fin, hinge axis along +Y.
  const rudderHeight = VSTAB_HEIGHT * 0.85;
  const rudderChord = VSTAB_CHORD * 0.35;
  const rudderThick = VSTAB_THICK * 0.9;
  const rudderGeom = new THREE.BoxGeometry(rudderChord, rudderHeight, rudderThick);

  const rudderPivot = new THREE.Group();
  rudderPivot.name = 'rudderPivot';
  // Hinge position: at top of tail boom, behind fin.
  rudderPivot.position.set(
    -FUSE_LEN * 0.42 - VSTAB_CHORD * 0.55,
    FUSE_R * 0.35 + rudderHeight * 0.5,
    0,
  );
  body.add(rudderPivot);
  const rudder = new THREE.Mesh(rudderGeom, matBody);
  rudder.name = 'rudder';
  rudder.position.set(-rudderChord * 0.5, 0, 0);
  rudderPivot.add(rudder);

  // ---- Horizontal stabilizer + elevator ----------------------------------
  const hstabGeom = buildAirfoilSlab(HSTAB_SPAN, HSTAB_CHORD, HSTAB_THICK, 6);
  const hstab = new THREE.Mesh(hstabGeom, matBody);
  hstab.name = 'horizontalStabilizer';
  hstab.position.set(-FUSE_LEN * 0.42 + 0.05, FUSE_R * 0.25, 0);
  body.add(hstab);

  // Elevator: single piece spanning the back of hstab; hinge along Z.
  const elevSpan = HSTAB_SPAN * 0.96;
  const elevChord = HSTAB_CHORD * 0.4;
  const elevThick = HSTAB_THICK * 0.7;
  const elevGeom = new THREE.BoxGeometry(elevChord, elevThick, elevSpan);

  const elevatorPivot = new THREE.Group();
  elevatorPivot.name = 'elevatorPivot';
  elevatorPivot.position.set(
    -FUSE_LEN * 0.42 + 0.05 - HSTAB_CHORD * 0.5,
    FUSE_R * 0.25,
    0,
  );
  body.add(elevatorPivot);
  const elevator = new THREE.Mesh(elevGeom, matBody);
  elevator.name = 'elevator';
  elevator.position.set(-elevChord * 0.5, 0, 0);
  elevatorPivot.add(elevator);

  // ---- Engine cowling + spinner + propeller ------------------------------
  // Engine sits slightly above the fuselage centerline so the prop tips
  //   clear the ground. Real Cessna 172 has ~25 cm of prop ground clearance.
  //   With GEAR_HEIGHT=0.85 and PROP_DIAM=1.85 (radius 0.925), we need the
  //   prop hub at body Y >= (0.925 + clearance) - GEAR_HEIGHT.
  //   Choose 0.20 m clearance: prop hub Y = 0.925 + 0.20 - 0.85 = 0.275.
  const PROP_Y = 0.28;
  // Cowling: short cylinder at the nose.
  const cowlGeom = new THREE.CylinderGeometry(FUSE_R * 0.95, FUSE_R * 0.85, 0.6, 14);
  cowlGeom.rotateZ(Math.PI / 2); // long axis -> X
  const cowl = new THREE.Mesh(cowlGeom, matBody);
  cowl.position.set(FUSE_LEN * 0.5 - 0.15, PROP_Y * 0.4, 0);
  body.add(cowl);

  // Spinner: a cone forward of the cowling.
  const spinGeom = new THREE.ConeGeometry(0.18, 0.35, 14);
  spinGeom.rotateZ(-Math.PI / 2); // tip -> +X
  const spinner = new THREE.Mesh(spinGeom, matSpinner);
  spinner.position.set(FUSE_LEN * 0.5 + 0.18, PROP_Y, 0);
  body.add(spinner);

  // Propeller: pivot at the spinner base, two blades along Y.
  const propellerPivot = new THREE.Group();
  propellerPivot.name = 'propellerPivot';
  propellerPivot.position.set(FUSE_LEN * 0.5 + 0.05, PROP_Y, 0);
  body.add(propellerPivot);

  // Hub
  const hubGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.12, 10);
  hubGeom.rotateZ(Math.PI / 2);
  const hub = new THREE.Mesh(hubGeom, matMetal);
  propellerPivot.add(hub);

  // Blades: thin boxes along Y, with yellow tips.
  const bladeLen = PROP_DIAM * 0.5;
  const bladeGeom = new THREE.BoxGeometry(0.05, bladeLen, 0.14);
  const tipGeom = new THREE.BoxGeometry(0.052, bladeLen * 0.18, 0.142);

  const bladeUp = new THREE.Mesh(bladeGeom, matPropBlade);
  bladeUp.position.set(0, bladeLen * 0.5, 0);
  propellerPivot.add(bladeUp);
  const tipUp = new THREE.Mesh(tipGeom, matPropTip);
  tipUp.position.set(0, bladeLen * 0.91, 0);
  propellerPivot.add(tipUp);

  const bladeDown = new THREE.Mesh(bladeGeom, matPropBlade);
  bladeDown.position.set(0, -bladeLen * 0.5, 0);
  propellerPivot.add(bladeDown);
  const tipDown = new THREE.Mesh(tipGeom, matPropTip);
  tipDown.position.set(0, -bladeLen * 0.91, 0);
  propellerPivot.add(tipDown);

  // ---- Tricycle landing gear ---------------------------------------------
  // Gear contact points should sit at world Y = 0 when root is placed at
  //   world Y = 0. We model: front (nose) gear under cowling, two main gear
  //   under wings/fuselage. The gear contact is at body Y = -GEAR_HEIGHT.
  //
  //   Wheels: cylinders with axis along Z (so they roll about Z).

  /**
   * Build a single gear leg + wheel. The gear group's origin is the strut
   * attach point on the fuselage (in body frame); strut hangs down so that
   * the wheel BOTTOM lands at body Y = -GEAR_HEIGHT (i.e. the wheel touches
   * the ground when the body is shifted up by +GEAR_HEIGHT).
   */
  function buildGear(
    xOffset: number,
    yAttach: number,
    zOffset: number,
    wheelRadius: number,
    wheelWidth: number,
  ): THREE.Group {
    const g = new THREE.Group();
    const wheelCenterBodyY = -GEAR_HEIGHT + wheelRadius;
    // Strut length from attach (yAttach) down to wheel center (wheelCenterBodyY).
    const strutLen = yAttach - wheelCenterBodyY;
    const strutG = new THREE.CylinderGeometry(0.05, 0.05, strutLen, 8);
    const s = new THREE.Mesh(strutG, matMetal);
    // Strut center is halfway between attach and wheel center.
    s.position.set(0, -strutLen * 0.5, 0);
    g.add(s);
    // Wheel: cylinder axis Z (so it rolls about Z).
    const wheelG = new THREE.CylinderGeometry(
      wheelRadius,
      wheelRadius,
      wheelWidth,
      14,
    );
    wheelG.rotateX(Math.PI / 2); // axis Y -> Z
    const w = new THREE.Mesh(wheelG, matRubber);
    w.position.set(0, -strutLen, 0);
    g.add(w);
    g.position.set(xOffset, yAttach, zOffset);
    return g;
  }

  const mainWheelR = 0.22;
  const noseWheelR = 0.18;

  // Nose gear: under cowling.
  const noseGear = buildGear(
    FUSE_LEN * 0.36,
    -FUSE_R * 0.6,
    0,
    noseWheelR,
    0.1,
  );
  body.add(noseGear);

  // Main gear: spread under fuselage.
  const mainGearTrack = 1.5; // half-distance between wheels
  const mainL = buildGear(
    -0.1,
    -FUSE_R * 0.55,
    -mainGearTrack,
    mainWheelR,
    0.12,
  );
  body.add(mainL);
  const mainR = buildGear(
    -0.1,
    -FUSE_R * 0.55,
    mainGearTrack,
    mainWheelR,
    0.12,
  );
  body.add(mainR);

  // ---- Door outlines (thin stripes) for visual interest ------------------
  const doorOutlineGeom = new THREE.BoxGeometry(0.02, 0.7, 0.01);
  for (const sign of [1, -1]) {
    const front = new THREE.Mesh(doorOutlineGeom, matStripe);
    front.position.set(1.0, 0.2, sign * (FUSE_R + 0.012));
    body.add(front);
    const back = new THREE.Mesh(doorOutlineGeom, matStripe);
    back.position.set(0.0, 0.2, sign * (FUSE_R + 0.012));
    body.add(back);
  }

  // ---- Place root so origin is at gear contact point --------------------
  // body is currently centered at body-frame origin (with the wheels at
  //   body Y = -GEAR_HEIGHT). We want the root origin at the gear contact
  //   point, so lift the body inside root by +GEAR_HEIGHT.
  body.position.set(0, GEAR_HEIGHT, 0);

  return {
    group: root,
    parts: {
      propeller: propellerPivot,
      leftAileron: leftAileronPivot,
      rightAileron: rightAileronPivot,
      elevator: elevatorPivot,
      rudder: rudderPivot,
      flaps: flapsPivot,
    },
  };
}
