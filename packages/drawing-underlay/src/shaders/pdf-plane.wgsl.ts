/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL shaders for the drawing-underlay textured plane.
 *
 * One camera uniform (group 0) is shared by every plane; each plane binds its
 * own opacity uniform + sampler + texture (group 1). The fragment shader
 * writes premultiplied alpha so the standard
 * "src * 1 + dst * (1 - src.a)" blend composites correctly over the scene.
 */

export const PDF_PLANE_WGSL = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
};

struct Plane {
  // x = opacity in [0..1]; yzw = padding (uniform buffers round to 16 B).
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var planeSampler: sampler;
@group(1) @binding(2) var planeTexture: texture_2d<f32>;

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) uv:       vec2<f32>,
};

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0)       uv:      vec2<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.clipPos = camera.viewProj * vec4<f32>(in.position, 1.0);
  out.uv      = in.uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let texel = textureSample(planeTexture, planeSampler, in.uv);
  let alpha = texel.a * plane.params.x;
  return vec4<f32>(texel.rgb * alpha, alpha);
}
`;

/**
 * Mip-generation blit: fullscreen triangle sampling the previous mip level
 * with linear filtering. Run once per level at upload time so minified
 * drawings (the common zoomed-out case) stay crisp instead of shimmering —
 * WebGPU does not auto-generate mip chains.
 */
export const MIP_BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0)       uv:      vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  // Fullscreen triangle: (-1,-1) (3,-1) (-1,3).
  var out: VsOut;
  let x = f32(i32(i) / 2) * 4.0 - 1.0;
  let y = f32(i32(i) % 2) * 4.0 - 1.0;
  out.clipPos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv      = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(srcTexture, srcSampler, in.uv);
}
`;
