/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PdfPlanePipeline — a self-contained WebGPU pipeline that draws georeferenced
 * drawing underlays as alpha-blended, depth-tested (non-depth-writing)
 * textured quads in world space.
 *
 * Follows the "self-contained overlay pipeline" contract: the pipeline owns
 * its buffers, bind groups, samplers, and textures, and exposes a
 * `render(pass, viewProj)` entry point the host invokes from inside an
 * existing RGBA-blended render pass. The host describes that pass once via
 * the constructor options (color format, MSAA count, depth format/convention,
 * any extra color targets such as a write-masked picker attachment) — the
 * package itself has no dependency on any particular renderer.
 *
 * One pipeline instance manages any number of planes (one per placed
 * drawing), keyed by an opaque id. Textures get a full mip chain generated at
 * upload time (WebGPU has no auto-mipmap) so zoomed-out drawings minify
 * cleanly; GPU resources are destroyed deterministically on replace/remove.
 */

import { MIP_BLIT_WGSL, PDF_PLANE_WGSL } from './shaders/pdf-plane.wgsl.js';
import type { PlacementCorners, Vec3 } from './world-transform.js';

/** Anything `copyExternalImageToTexture` accepts that carries pixel size. */
export type PlaneImageSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface PdfPlanePipelineOptions {
  device: GPUDevice;
  /** Color format of the pass this pipeline renders into. */
  format: GPUTextureFormat;
  /** MSAA sample count of the host pass (1 = no MSAA). */
  sampleCount?: number;
  /** Depth attachment format of the host pass. */
  depthFormat?: GPUTextureFormat;
  /**
   * Depth convention of the host pass. `'reverse'` = depth cleared to 0 and
   * compared with greater-equal (ifc-lite's renderer); `'standard'` =
   * cleared to 1, less-equal.
   */
  depthConvention?: 'reverse' | 'standard';
  /**
   * Extra color targets the host pass declares beyond the presentation
   * target (e.g. a picker attachment). Declared verbatim so the pipeline
   * validates against the pass; write-mask them off in the host's
   * declaration if the underlay must not touch them.
   */
  extraColorTargets?: GPUColorTargetState[];
}

export interface PlaneInput {
  /** World-space quad from `placementWorldCorners`. */
  corners: PlacementCorners;
  /**
   * Rasterized drawing page. Required when creating a plane; optional on
   * update (position/opacity-only changes keep the existing texture).
   */
  image?: PlaneImageSource;
  /** Opacity in [0..1]. Default 1. */
  opacity?: number;
  /** Whether the plane renders. Default true. */
  visible?: boolean;
}

const QUAD_VERTEX_STRIDE_BYTES = (3 + 2) * 4; // pos.xyz + uv.xy
const PLANE_UNIFORM_BYTES = 16; // vec4<f32> params

interface PlaneEntry {
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  opacity: number;
  visible: boolean;
}

function imageSize(image: PlaneImageSource): { width: number; height: number } {
  return { width: image.width, height: image.height };
}

function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** Interleave the quad as a triangle strip: tl, tr, bl, br. */
function quadVertices(c: PlacementCorners): Float32Array {
  const v = (p: Vec3, u: number, w: number) => [p.x, p.y, p.z, u, w];
  return new Float32Array([
    ...v(c.tl, 0, 0),
    ...v(c.tr, 1, 0),
    ...v(c.bl, 0, 1),
    ...v(c.br, 1, 1),
  ]);
}

export class PdfPlanePipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private readonly depthFormat: GPUTextureFormat;
  private readonly depthConvention: 'reverse' | 'standard';
  private readonly extraColorTargets: GPUColorTargetState[];

  private pipeline: GPURenderPipeline | null = null;
  private cameraBindGroupLayout: GPUBindGroupLayout | null = null;
  private planeBindGroupLayout: GPUBindGroupLayout | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private cameraBindGroup: GPUBindGroup | null = null;
  private sampler: GPUSampler | null = null;

  private mipPipeline: GPURenderPipeline | null = null;
  private mipSampler: GPUSampler | null = null;

  private readonly planes = new Map<string, PlaneEntry>();

  constructor(options: PdfPlanePipelineOptions) {
    this.device = options.device;
    this.format = options.format;
    this.sampleCount = options.sampleCount ?? 1;
    this.depthFormat = options.depthFormat ?? 'depth24plus-stencil8';
    this.depthConvention = options.depthConvention ?? 'reverse';
    this.extraColorTargets = options.extraColorTargets ?? [];
  }

  private init(): void {
    if (this.pipeline) return;

    this.cameraBindGroupLayout = this.device.createBindGroupLayout({
      label: 'pdf-plane-camera-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.planeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'pdf-plane-plane-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const module = this.device.createShaderModule({
      label: 'pdf-plane-shader',
      code: PDF_PLANE_WGSL,
    });

    const reverseZ = this.depthConvention === 'reverse';
    this.pipeline = this.device.createRenderPipeline({
      label: 'pdf-plane-pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.cameraBindGroupLayout, this.planeBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: QUAD_VERTEX_STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' }, // uv
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              // Premultiplied-alpha composite over the existing scene.
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
          },
          ...this.extraColorTargets,
        ],
      },
      // No culling: the drawing must read from below the plane too (e.g. a
      // camera under a lifted underlay in section views).
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: {
        format: this.depthFormat,
        // Underlay: tested against model geometry but never occluding it in
        // the depth buffer, so picking and later overlay draws stay intact.
        depthWriteEnabled: false,
        depthCompare: reverseZ ? 'greater-equal' : 'less-equal',
        // Decal bias toward the camera so a plane sitting on a slab face
        // doesn't z-fight (sign flips with the depth convention).
        depthBias: reverseZ ? -4 : 4,
        depthBiasSlopeScale: reverseZ ? -0.5 : 0.5,
        depthBiasClamp: 0,
      },
      multisample: { count: this.sampleCount },
    });

    this.cameraBuffer = this.device.createBuffer({
      label: 'pdf-plane-camera',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraBindGroup = this.device.createBindGroup({
      label: 'pdf-plane-camera-bg',
      layout: this.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.sampler = this.device.createSampler({
      label: 'pdf-plane-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /**
   * Upload an image into a mip-mapped texture. Level 0 comes from
   * `copyExternalImageToTexture`; the remaining levels are blitted with a
   * fullscreen-triangle pass each (WebGPU generates no mips itself).
   */
  private createMippedTexture(image: PlaneImageSource): GPUTexture {
    const { width, height } = imageSize(image);
    const maxDim = this.device.limits.maxTextureDimension2D;
    if (width > maxDim || height > maxDim) {
      // Hosts control raster DPI; exceeding the hard device limit is a
      // programming error, not a soft case to silently downscale.
      throw new Error(
        `PdfPlanePipeline: image ${width}x${height} exceeds device limit ${maxDim}`,
      );
    }

    const levels = mipLevelCount(width, height);
    const texture = this.device.createTexture({
      label: 'pdf-plane-texture',
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      mipLevelCount: levels,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: image, flipY: false },
      { texture },
      { width, height },
    );
    this.generateMips(texture, levels);
    return texture;
  }

  private ensureMipPipeline(): void {
    if (this.mipPipeline) return;
    const module = this.device.createShaderModule({
      label: 'pdf-plane-mip-shader',
      code: MIP_BLIT_WGSL,
    });
    this.mipPipeline = this.device.createRenderPipeline({
      label: 'pdf-plane-mip-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.mipSampler = this.device.createSampler({
      label: 'pdf-plane-mip-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  private generateMips(texture: GPUTexture, levels: number): void {
    if (levels <= 1) return;
    this.ensureMipPipeline();
    const encoder = this.device.createCommandEncoder({ label: 'pdf-plane-mipgen' });
    for (let level = 1; level < levels; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bindGroup = this.device.createBindGroup({
        label: 'pdf-plane-mip-bg',
        layout: this.mipPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.mipSampler! },
          { binding: 1, resource: srcView },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      pass.setPipeline(this.mipPipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Create or update a plane. Creating requires `image`; updates without
   * `image` keep the existing texture (corner/opacity/visibility changes are
   * cheap). Replacing the image destroys the previous texture eagerly.
   */
  upsertPlane(id: string, input: PlaneInput): void {
    this.init();

    const existing = this.planes.get(id);
    if (!existing && !input.image) {
      throw new Error(`PdfPlanePipeline: plane "${id}" does not exist and no image was provided`);
    }

    const vertices = quadVertices(input.corners);

    if (existing) {
      this.device.queue.writeBuffer(existing.vertexBuffer, 0, vertices);
      if (input.opacity !== undefined) {
        existing.opacity = input.opacity;
        this.writePlaneUniform(existing);
      }
      if (input.visible !== undefined) existing.visible = input.visible;
      if (input.image) {
        existing.texture.destroy();
        existing.texture = this.createMippedTexture(input.image);
        existing.bindGroup = this.createPlaneBindGroup(existing.uniformBuffer, existing.texture);
      }
      return;
    }

    const vertexBuffer = this.device.createBuffer({
      label: `pdf-plane-vbuf:${id}`,
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, vertices);

    const uniformBuffer = this.device.createBuffer({
      label: `pdf-plane-ubuf:${id}`,
      size: PLANE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const texture = this.createMippedTexture(input.image!);
    const entry: PlaneEntry = {
      vertexBuffer,
      uniformBuffer,
      texture,
      bindGroup: this.createPlaneBindGroup(uniformBuffer, texture),
      opacity: input.opacity ?? 1,
      visible: input.visible ?? true,
    };
    this.writePlaneUniform(entry);
    this.planes.set(id, entry);
  }

  private createPlaneBindGroup(uniformBuffer: GPUBuffer, texture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'pdf-plane-bg',
      layout: this.planeBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: texture.createView() },
      ],
    });
  }

  private writePlaneUniform(entry: PlaneEntry): void {
    this.device.queue.writeBuffer(
      entry.uniformBuffer,
      0,
      new Float32Array([entry.opacity, 0, 0, 0]),
    );
  }

  setOpacity(id: string, opacity: number): void {
    const entry = this.planes.get(id);
    if (!entry) return;
    entry.opacity = opacity;
    this.writePlaneUniform(entry);
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.planes.get(id);
    if (!entry) return;
    entry.visible = visible;
  }

  removePlane(id: string): void {
    const entry = this.planes.get(id);
    if (!entry) return;
    entry.vertexBuffer.destroy();
    entry.uniformBuffer.destroy();
    entry.texture.destroy();
    this.planes.delete(id);
  }

  /** Ids of all planes currently held (visible or not). */
  planeIds(): string[] {
    return [...this.planes.keys()];
  }

  /**
   * True when at least one visible plane exists. Named to satisfy the
   * `ExternalOverlay` contract shared by self-contained overlay pipelines.
   */
  hasGeometry(): boolean {
    if (this.planes.size === 0) return false;
    for (const entry of this.planes.values()) {
      if (entry.visible) return true;
    }
    return false;
  }

  /** Draw all visible planes. Call from inside the host's blended pass. */
  render(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.pipeline || !this.cameraBuffer || !this.cameraBindGroup) return;
    if (!this.hasGeometry()) return;

    this.device.queue.writeBuffer(this.cameraBuffer, 0, viewProj);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cameraBindGroup);
    for (const entry of this.planes.values()) {
      if (!entry.visible) continue;
      pass.setBindGroup(1, entry.bindGroup);
      pass.setVertexBuffer(0, entry.vertexBuffer);
      pass.draw(4);
    }
  }

  /** Destroy every GPU resource. The instance is unusable afterwards. */
  destroy(): void {
    for (const id of [...this.planes.keys()]) this.removePlane(id);
    this.cameraBuffer?.destroy();
    this.cameraBuffer = null;
    this.cameraBindGroup = null;
    this.pipeline = null;
    this.mipPipeline = null;
    this.mipSampler = null;
    this.sampler = null;
    this.cameraBindGroupLayout = null;
    this.planeBindGroupLayout = null;
  }
}
