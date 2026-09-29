import * as THREE from 'three';

/** Uniforms shared by every custom material (updated once per frame / resize). */
export const shared = {
  uPxScale: { value: 1 }, // viewport height in px / (2·tan(fov/2)) → world size → pixels
  uPixelRatio: { value: 1 },
  uTime: { value: 0 }, // real seconds, for shimmer
};

// three.js log-depth hooks so custom shaders depth-sort correctly with logarithmicDepthBuffer
export const V_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uPxScale;
uniform float uPixelRatio;
uniform float uTime;
`;
export const V_END = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const F_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
`;
export const F_START = /* glsl */ `
#include <logdepthbuf_fragment>
`;

/** Returns sprite size in px; `fade` dims sprites that would be smaller than minPx (keeps total flux ~constant). */
export const SPRITE_FN = /* glsl */ `
float spriteSize(float worldSize, float viewDepth, float minPx, float maxPx, out float fade) {
  float px = worldSize * uPxScale / max(viewDepth, 1e-9);
  fade = clamp(px / minPx, 0.0, 1.0);
  fade *= fade;
  return clamp(px, minPx, maxPx) * uPixelRatio;
}
`;

/** Soft stellar point-spread: tight core + wide halo. */
export const STAR_FRAG_FN = /* glsl */ `
float starPsf(vec2 pc, float haloAmt) {
  vec2 p = pc * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) return 0.0;
  return exp(-r2 * 9.0) + haloAmt * exp(-r2 * 2.2) * (1.0 - r2);
}
`;

export function material(params: THREE.ShaderMaterialParameters & { uniforms?: Record<string, THREE.IUniform> }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    ...params,
    uniforms: { ...shared, ...(params.uniforms || {}) },
  });
}

export const additive = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false } as const;
