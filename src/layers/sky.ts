import * as THREE from 'three';
import { EQ_TO_GAL, colorFromBV, frameMatrixToThree, radecToVec, D2R } from '../core/astro';
import { material, STAR_FRAG_FN } from '../core/shaders';
import type { StarsData } from '../core/data';

/**
 * Background sky at infinity: ESO Milky Way panorama (sampled in galactic coordinates, so it lines up exactly with
 * the real stars), HYG naked-eye stars, and constellation figures. Geometry is stored in ICRS equatorial; `setFrame`
 * rotates it into the host layer's frame (equatorial for Earth orbit, ecliptic for the Solar System).
 */
export class Sky {
  readonly group = new THREE.Group();
  private eqToScene = { value: new THREE.Matrix3() };
  private sceneToGal = { value: new THREE.Matrix3() };
  readonly milkyWay: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly lines: THREE.LineSegments;
  private brightness = { value: 1 };

  constructor(tex: THREE.Texture, stars: StarsData, constellations: number[][][]) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    const infinity = /* glsl */ `
      vec4 atInfinity(vec3 dir) {
        vec4 p = projectionMatrix * vec4((viewMatrix * vec4(dir, 0.0)).xyz, 1.0);
        return vec4(p.xy, p.w * 0.99999, p.w);
      }`;

    this.milkyWay = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 32),
      material({
        side: THREE.BackSide,
        transparent: false, // opaque + drawn first; transparent objects would render after the planets
        depthTest: false,
        uniforms: { uMap: { value: tex }, uSceneToGal: this.sceneToGal, uBright: this.brightness },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          ${infinity}
          void main() { vDir = position; gl_Position = atInfinity(position); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap; uniform mat3 uSceneToGal; uniform float uBright;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            vec3 g = uSceneToGal * vec3(d.x, -d.z, d.y);          // three → physical → galactic
            float l = atan(g.y, g.x), b = asin(clamp(g.z, -1.0, 1.0));
            vec2 uv = vec2(0.5 - l / 6.2831853, 0.5 + b / 3.14159265);
            vec3 c = texture2D(uMap, uv).rgb;
            c = max(c - 0.012, 0.0) * 0.55 * uBright;             // lift black point, keep it a backdrop
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.milkyWay.renderOrder = -100;
    this.milkyWay.frustumCulled = false;

    // --- stars ---
    const n = stars.sky.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n);
    const v = new THREE.Vector3(), c = new THREE.Color();
    stars.sky.forEach(([ra, dec, m, ci], i) => {
      radecToVec(ra * 15 * D2R, dec * D2R, v).toArray(pos, i * 3);
      colorFromBV(ci, c).toArray(col, i * 3);
      mag[i] = m;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    this.stars = new THREE.Points(
      g,
      material({
        blending: THREE.AdditiveBlending,
        uniforms: { uEqToScene: this.eqToScene, uBright: this.brightness },
        vertexShader: /* glsl */ `
          uniform mat3 uEqToScene; uniform float uPixelRatio; uniform float uBright; uniform float uTime;
          attribute float mag; attribute vec3 color;
          varying vec3 vColor; varying float vI;
          ${infinity}
          void main() {
            gl_Position = atInfinity(uEqToScene * position);
            float flux = pow(10.0, -0.4 * (mag - 1.0));           // relative to a mag-1 star
            float size = clamp(2.2 + 3.0 * sqrt(flux), 1.6, 9.0);
            float tw = 0.92 + 0.08 * sin(uTime * 3.1 + position.x * 400.0 + position.y * 911.0);
            vI = clamp(flux * 2.5, 0.10, 1.0) * uBright * tw;
            vColor = color;
            gl_PointSize = size * uPixelRatio;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor; varying float vI;
          ${STAR_FRAG_FN}
          void main() {
            float a = starPsf(gl_PointCoord, 0.25);
            if (a < 0.004) discard;
            gl_FragColor = vec4(vColor * a * vI * 1.6, 1.0);
          }`,
      }),
    );
    this.stars.renderOrder = -99;
    this.stars.frustumCulled = false;

    // --- constellation figures ---
    const seg: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const line of constellations) {
      for (let i = 0; i < line.length - 1; i++) {
        // d3-celestial stores RA as longitude in [-180, 180]
        radecToVec(line[i][0] * D2R, line[i][1] * D2R, a);
        radecToVec(line[i + 1][0] * D2R, line[i + 1][1] * D2R, b);
        seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.lines = new THREE.LineSegments(
      lg,
      material({
        blending: THREE.AdditiveBlending,
        uniforms: { uEqToScene: this.eqToScene },
        vertexShader: /* glsl */ `
          uniform mat3 uEqToScene;
          ${infinity}
          void main() { gl_Position = atInfinity(uEqToScene * position); }`,
        fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(0.35, 0.55, 0.9, 0.22); }`,
      }),
    );
    this.lines.renderOrder = -98;
    this.lines.frustumCulled = false;
    this.lines.visible = false;

    this.group.add(this.milkyWay, this.stars, this.lines);
  }

  /** `frameFromEq`: physical rotation taking ICRS equatorial vectors into the layer's physical frame. */
  setFrame(frameFromEq: THREE.Matrix3) {
    this.eqToScene.value.copy(frameMatrixToThree(frameFromEq));
    // scene physical → equatorial → galactic
    this.sceneToGal.value.copy(EQ_TO_GAL).multiply(frameFromEq.clone().transpose());
  }

  setBrightness(b: number) {
    this.brightness.value = b;
  }
}
