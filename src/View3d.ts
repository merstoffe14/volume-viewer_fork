import { AmbientLight, Vector3, Object3D, SpotLight, DirectionalLight, Euler, Scene, Color } from "three";

import { ThreeJsPanel } from "./ThreeJsPanel";
import lightSettings from "./constants/lights";
import VolumeDrawable from "./VolumeDrawable";
import { Light, AREA_LIGHT, SKY_LIGHT } from "./Light";
import Volume from "./Volume";
import { VolumeChannelDisplayOptions, VolumeDisplayOptions, isOrthographicCamera, ViewportCorner } from "./types";

export const RENDERMODE_RAYMARCH = 0;
export const RENDERMODE_PATHTRACE = 1;

export interface View3dOptions {
  parentElement?: HTMLElement;
  useWebGL2?: boolean;
}

/**
 * @class
 */
export class View3d {
  private canvas3d: ThreeJsPanel;
  private scene: Scene;
  private backgroundColor: Color;
  private pixelSamplingRate: number;
  private exposure: number;
  private volumeRenderMode: number;
  private renderUpdateListener?: (iteration: number) => void;
  private image?: VolumeDrawable;

  private lights: Light[];
  private lightContainer: Object3D;
  private ambientLight: AmbientLight;
  private spotLight: SpotLight;
  private reflectedLight: DirectionalLight;
  private fillLight: DirectionalLight;

  /**
   * @param {Object} options Optional options.
   * @param {boolean} options.useWebGL2 Default true
   * @param {HTMLElement} options.parentElement An optional element to which to append the viewer element on creation.
   *   The viewer will attempt to fill this element if provided.
   */
  constructor(options?: View3dOptions) {
    const useWebGL2 = options?.useWebGL2 === undefined ? true : options.useWebGL2;

    this.canvas3d = new ThreeJsPanel(options?.parentElement, useWebGL2);
    this.redraw = this.redraw.bind(this);
    this.scene = new Scene();
    this.backgroundColor = new Color(0x000000);
    this.lights = [];

    this.pixelSamplingRate = 0.75;
    this.exposure = 0.5;
    this.volumeRenderMode = RENDERMODE_RAYMARCH;

    window.addEventListener("resize", () => this.resize(null));

    this.lightContainer = new Object3D();
    this.ambientLight = new AmbientLight();
    this.spotLight = new SpotLight();
    this.reflectedLight = new DirectionalLight();
    this.fillLight = new DirectionalLight();
    this.buildScene();
  }

  // prerender should be called on every redraw and should be the first thing done.
  preRender(): void {
    // TODO: if fps just updated and it's too low, do something:
    // if (this.canvas3d.timer.lastFPS < 7 && this.canvas3d.timer.lastFPS > 0 && this.canvas3d.timer.frames === 0) {
    // }

    const lightContainer = this.scene.getObjectByName("lightContainer");
    if (lightContainer) {
      lightContainer.rotation.setFromRotationMatrix(this.canvas3d.camera.matrixWorld);
    }
    // keep the ortho scale up to date.
    if (this.image && isOrthographicCamera(this.canvas3d.camera)) {
      this.image.setOrthoScale(this.canvas3d.controls.scale);
      this.updateOrthoScaleBar(this.image.volume);
    }
  }

  private updateOrthoScaleBar(volume: Volume): void {
    this.canvas3d.updateOrthoScaleBar(volume.physicalScale, volume.imageInfo.pixel_size_unit);
  }

  private updatePerspectiveScaleBar(volume: Volume): void {
    this.canvas3d.updatePerspectiveScaleBar(volume.tickMarkPhysicalLength, volume.imageInfo.pixel_size_unit);
  }

  /**
   * Capture the contents of this canvas to a data url
   * @param {Object} dataurlcallback function to call when data url is ready; function accepts dataurl as string arg
   */
  capture(dataurlcallback: (name: string) => void): void {
    return this.canvas3d.requestCapture(dataurlcallback);
  }

  getDOMElement(): HTMLDivElement {
    return this.canvas3d.containerdiv;
  }

  /**
   * Force a redraw.
   */
  redraw(): void {
    this.canvas3d.redraw();
  }

  unsetImage(): VolumeDrawable | undefined {
    if (this.image) {
      this.canvas3d.removeControlHandlers();
      this.canvas3d.animateFuncs = [];
      this.scene.remove(this.image.sceneRoot);
    }
    return this.image;
  }

  /**
   * Add a new volume image to the viewer.  (The viewer currently only supports a single image at a time - adding repeatedly, without removing in between, is a potential resource leak)
   * @param {Volume} volume
   * @param {VolumeDisplayOptions} options
   */
  addVolume(volume: Volume, options?: VolumeDisplayOptions): void {
    volume.addVolumeDataObserver(this);
    options = options || {};
    options.renderMode = this.volumeRenderMode === RENDERMODE_PATHTRACE ? 1 : 0;
    this.setImage(new VolumeDrawable(volume, options));
  }

  /**
   * Apply a set of display options to a given channel of a volume
   * @param {Volume} volume
   * @param {number} channelIndex the channel index
   * @param {VolumeChannelDisplayOptions} options
   */
  setVolumeChannelOptions(volume: Volume, channelIndex: number, options: VolumeChannelDisplayOptions): void {
    this.image?.setChannelOptions(channelIndex, options);
    this.redraw();
  }

  /**
   * Apply a set of display options to the given volume
   * @param {Volume} volume
   * @param {VolumeDisplayOptions} options
   */
  setVolumeDisplayOptions(volume: Volume, options: VolumeDisplayOptions): void {
    this.image?.setOptions(options);
    this.redraw();
  }

  /**
   * Remove a volume image from the viewer.  This will clean up the View3D's resources for the current volume
   * @param {Volume} volume
   */
  removeVolume(volume: Volume): void {
    const oldImage = this.unsetImage();
    if (oldImage) {
      oldImage.cleanup();
    }
    if (volume) {
      // assert oldImage.volume === volume!
      volume.removeVolumeDataObserver(this);
    }
  }

  /**
   * Remove all volume images from the viewer.
   */
  removeAllVolumes(): void {
    if (this.image) {
      this.removeVolume(this.image.volume);
    }
  }

  /**
   * @param {function} callback a function that will receive the number of render iterations when it changes
   */
  setRenderUpdateListener(callback: (iteration: number) => void): void {
    this.renderUpdateListener = callback;
    this.image?.setRenderUpdateListener(callback);
  }

  // channels is an array of channel indices for which new data just arrived.
  onVolumeData(volume: Volume, channels: number[]): void {
    this.image?.onChannelLoaded(channels);
  }

  // do fixups for when the volume has had a new empty channel added.
  onVolumeChannelAdded(volume: Volume, newChannelIndex: number): void {
    this.image?.onChannelAdded(newChannelIndex);
  }

  /**
   * Assign a channel index as a mask channel (will multiply its color against the entire visible volume)
   * @param {Object} volume
   * @param {number} maskChannelIndex
   */
  setVolumeChannelAsMask(volume: Volume, maskChannelIndex: number): void {
    this.image?.setChannelAsMask(maskChannelIndex);
    this.redraw();
  }

  /**
   * Set voxel dimensions - controls volume scaling. For example, the physical measurements of the voxels from a biological data set
   * @param {Object} volume
   * @param {number} values Array of x,y,z floating point values for the physical voxel size scaling
   * @param {string} unit The unit of `values`, if different than previous
   */
  setVoxelSize(volume: Volume, values: number[], unit?: string): void {
    if (this.image) {
      this.image.setVoxelSize(values);

      if (unit) {
        this.image.volume.setUnitSymbol(unit);
      }

      this.updatePerspectiveScaleBar(this.image.volume);
    }
    this.redraw();
  }

  setRayStepSizes(volume: Volume, primary: number, secondary: number): void {
    this.image?.setRayStepSizes(primary, secondary);
    this.redraw();
  }

  setShowBoundingBox(volume: Volume, showBoundingBox: boolean): void {
    this.image?.setShowBoundingBox(showBoundingBox);
    this.canvas3d.setShowPerspectiveScaleBar(
      showBoundingBox && this.canvas3d.showOrthoScaleBar && this.volumeRenderMode !== RENDERMODE_PATHTRACE
    );
    this.redraw();
  }

  setBoundingBoxColor(volume: Volume, color: [number, number, number]): void {
    this.image?.setBoundingBoxColor(color);
    this.canvas3d.setPerspectiveScaleBarColor(color);
    this.redraw();
  }

  setBackgroundColor(color: [number, number, number]): void {
    const c = new Color().fromArray(color);
    this.backgroundColor = c;
    this.canvas3d.setClearColor(c, 1);
    this.redraw();
  }

  /**
   * If an isosurface is not already created, then create one.  Otherwise change the isovalue of the existing isosurface.
   * @param {Object} volume
   * @param {number} channel
   * @param {number} isovalue isovalue
   * @param {number=} alpha Opacity
   */
  createIsosurface(volume: Volume, channel: number, isovalue: number, alpha: number): void {
    if (!this.image) {
      return;
    }
    if (this.image.hasIsosurface(channel)) {
      this.image.updateIsovalue(channel, isovalue);
    } else {
      this.image.createIsosurface(channel, isovalue, alpha, alpha < 0.95);
    }
    this.redraw();
  }

  /**
   * Is an isosurface already created for this channel?
   * @param {Object} volume
   * @param {number} channel
   * @return true if there is currently a mesh isosurface for this channel
   */
  hasIsosurface(volume: Volume, channel: number): boolean {
    return this.image?.hasIsosurface(channel) || false;
  }

  /**
   * If an isosurface exists, update its isovalue and regenerate the surface. Otherwise do nothing.
   * @param {Object} volume
   * @param {number} channel
   * @param {number} isovalue
   */
  updateIsosurface(volume: Volume, channel: number, isovalue: number): void {
    if (!this.image || !this.image.hasIsosurface(channel)) {
      return;
    }
    this.image.updateIsovalue(channel, isovalue);
    this.redraw();
  }

  /**
   * Set opacity for isosurface
   * @param {Object} volume
   * @param {number} channel
   * @param {number} opacity Opacity
   */
  updateOpacity(volume: Volume, channel: number, opacity: number): void {
    this.image?.updateOpacity(channel, opacity);
    this.redraw();
  }

  /**
   * If an isosurface exists for this channel, hide it now
   * @param {Object} volume
   * @param {number} channel
   */
  clearIsosurface(volume: Volume, channel: number): void {
    this.image?.destroyIsosurface(channel);
    this.redraw();
  }

  /**
   * Save a channel's isosurface as a triangle mesh to either STL or GLTF2 format.  File will be named automatically, using image name and channel name.
   * @param {Object} volume
   * @param {number} channelIndex
   * @param {string} type Either 'GLTF' or 'STL'
   */
  saveChannelIsosurface(volume: Volume, channelIndex: number, type: string): void {
    this.image?.saveChannelIsosurface(channelIndex, type);
  }

  // Add a new volume image to the viewer.  The viewer currently only supports a single image at a time, and will return any prior existing image.
  setImage(img: VolumeDrawable): VolumeDrawable | undefined {
    const oldImage = this.unsetImage();

    this.image = img;

    this.scene.add(img.sceneRoot);

    // new image picks up current settings
    this.image.setResolution(this.canvas3d);
    this.image.setIsOrtho(isOrthographicCamera(this.canvas3d.camera));
    this.image.setBrightness(this.exposure);

    this.canvas3d.setControlHandlers(
      this.onStartControls.bind(this),
      this.onChangeControls.bind(this),
      this.onEndControls.bind(this)
    );

    this.canvas3d.animateFuncs.push(this.preRender.bind(this));
    this.canvas3d.animateFuncs.push(img.onAnimate.bind(img));

    this.updatePerspectiveScaleBar(img.volume);

    // redraw if not already in draw loop
    this.redraw();

    return oldImage;
  }

  onStartControls(): void {
    if (this.volumeRenderMode !== RENDERMODE_PATHTRACE) {
      // TODO: VR display requires a running renderloop
      this.canvas3d.startRenderLoop();
    }
    this.image?.onStartControls();
  }

  onChangeControls(): void {
    this.image?.onChangeControls();
  }

  onEndControls(): void {
    this.image?.onEndControls();
    // If we are pathtracing or autorotating, then keep rendering. Otherwise stop now.
    if (this.volumeRenderMode !== RENDERMODE_PATHTRACE && !this.canvas3d.controls.autoRotate) {
      // TODO: VR display requires a running renderloop
      this.canvas3d.stopRenderLoop();
    }
    // force a redraw.  This mainly fixes a bug with the way TrackballControls deals with wheel events.
    this.redraw();
  }

  buildScene(): void {
    this.scene = this.canvas3d.scene;

    // background color
    this.canvas3d.setClearColor(this.backgroundColor, 1.0);

    this.lights = [new Light(SKY_LIGHT), new Light(AREA_LIGHT)];

    this.lightContainer = new Object3D();
    this.lightContainer.name = "lightContainer";

    this.ambientLight = new AmbientLight(
      lightSettings.ambientLightSettings.color,
      lightSettings.ambientLightSettings.intensity
    );
    this.lightContainer.add(this.ambientLight);

    // key light
    this.spotLight = new SpotLight(lightSettings.spotlightSettings.color, lightSettings.spotlightSettings.intensity);
    this.spotLight.position.set(
      lightSettings.spotlightSettings.position.x,
      lightSettings.spotlightSettings.position.y,
      lightSettings.spotlightSettings.position.z
    );
    this.spotLight.target = new Object3D(); // this.substrate;
    this.spotLight.angle = lightSettings.spotlightSettings.angle;

    this.lightContainer.add(this.spotLight);

    // reflect light
    this.reflectedLight = new DirectionalLight(lightSettings.reflectedLightSettings.color);
    this.reflectedLight.position.set(
      lightSettings.reflectedLightSettings.position.x,
      lightSettings.reflectedLightSettings.position.y,
      lightSettings.reflectedLightSettings.position.z
    );
    this.reflectedLight.castShadow = lightSettings.reflectedLightSettings.castShadow;
    this.reflectedLight.intensity = lightSettings.reflectedLightSettings.intensity;
    this.lightContainer.add(this.reflectedLight);

    // fill light
    this.fillLight = new DirectionalLight(lightSettings.fillLightSettings.color);
    this.fillLight.position.set(
      lightSettings.fillLightSettings.position.x,
      lightSettings.fillLightSettings.position.y,
      lightSettings.fillLightSettings.position.z
    );
    this.fillLight.castShadow = lightSettings.fillLightSettings.castShadow;
    this.fillLight.intensity = lightSettings.fillLightSettings.intensity;
    this.lightContainer.add(this.fillLight);

    this.scene.add(this.lightContainer);
  }

  /**
   * Change the camera projection to look along an axis, or to view in a 3d perspective camera.
   * @param {string} mode Mode can be "3D", or "XY" or "Z", or "YZ" or "X", or "XZ" or "Y".  3D is a perspective view, and all the others are orthographic projections
   */
  setCameraMode(mode: string): void {
    this.canvas3d.switchViewMode(mode);
    this.image?.setIsOrtho(mode !== "3D");
    this.canvas3d.redraw();
  }

  /**
   * Enable or disable 3d axis display at lower left.
   * @param {boolean} showAxis
   */
  setShowAxis(showAxis: boolean): void {
    this.canvas3d.showAxis = showAxis;
    this.canvas3d.redraw();
  }

  /**
   * Enable or disable scale indicators.
   * @param showScaleBar
   */
  setShowScaleBar(showScaleBar: boolean): void {
    this.canvas3d.setShowOrthoScaleBar(showScaleBar);
    this.canvas3d.setShowPerspectiveScaleBar(
      showScaleBar && !!this.image?.showBoundingBox && this.volumeRenderMode !== RENDERMODE_PATHTRACE
    );
  }

  /**
   * Set the position of the axis indicator, as a corner of the viewport and horizontal and vertical margins from the
   * edge of the viewport.
   * @param {number} marginX
   * @param {number} marginY
   * @param {string} [corner] The corner of the viewport in which the axis appears. Default: `"bottom_left"`.
   *  TypeScript users should use the `ViewportCorner` enum. Otherwise, corner is one of: `"top_left"`, `"top_right"`,
   *  `"bottom_left"`, `"bottom_right"`.
   */
  setAxisPosition(marginX: number, marginY: number, corner: ViewportCorner = ViewportCorner.BOTTOM_LEFT): void {
    this.canvas3d.setAxisPosition(marginX, marginY, corner);
    if (this.canvas3d.showAxis) {
      this.canvas3d.redraw();
    }
  }

  /**
   * Set the position of the scale bar, as a corner of the viewport and horizontal and vertical margins from the edge
   * of the viewport.
   * @param {number} marginX
   * @param {number} marginY
   * @param {string} [corner] The corner of the viewport in which the scale bar appears. Default: `"bottom_right"`.
   *  TypeScript users should use the `ViewportCorner` enum. Otherwise, corner is one of: `"top_left"`, `"top_right"`,
   *  `"bottom_left"`, `"bottom_right"`.
   */
  setScaleBarPosition(marginX: number, marginY: number, corner: ViewportCorner = ViewportCorner.BOTTOM_RIGHT): void {
    this.canvas3d.setScaleBarPosition(marginX, marginY, corner);
  }

  /**
   * Enable or disable a turntable rotation mode. The display will continuously spin about the vertical screen axis.
   * @param {boolean} autorotate
   */
  setAutoRotate(autorotate: boolean): void {
    this.canvas3d.setAutoRotate(autorotate);

    if (autorotate) {
      this.onStartControls();
    } else {
      this.onEndControls();
    }
  }

  /**
   * Set the unit symbol for the scale bar (e.g. µm)
   * @param {string} unit
   */
  setScaleUnit(unit: string): void {
    if (this.image) {
      this.image.volume.setUnitSymbol(unit);
      this.updatePerspectiveScaleBar(this.image.volume);
      if (isOrthographicCamera(this.canvas3d.camera)) {
        this.updateOrthoScaleBar(this.image.volume);
      }
    }
  }

  /**
   * Invert axes of volume. -1 to invert, +1 NOT to invert.
   * @param {Object} volume
   * @param {number} flipX x axis sense
   * @param {number} flipY y axis sense
   * @param {number} flipZ z axis sense
   */
  setFlipVolume(volume: Volume, flipX: number, flipY: number, flipZ: number): void {
    this.image?.setFlipAxes(flipX, flipY, flipZ);
    this.redraw();
  }

  setInterpolationEnabled(volume: Volume, active: boolean): void {
    this.image?.setInterpolationEnabled(active);
    this.redraw();
  }

  /**
   * Notify the view that it has been resized.  This will automatically be connected to the window when the View3d is created.
   * @param {HTMLElement=} comp Ignored.
   * @param {number=} w Width, or parent element's offsetWidth if not specified.
   * @param {number=} h Height, or parent element's offsetHeight if not specified.
   * @param {number=} ow Ignored.
   * @param {number=} oh Ignored.
   * @param {Object=} eOpts Ignored.
   */
  resize(comp: HTMLElement | null, w?: number, h?: number, ow?: number, oh?: number, eOpts?: unknown): void {
    this.canvas3d.resize(comp, w, h, ow, oh, eOpts);
    this.image?.setResolution(this.canvas3d);
    this.redraw();
  }

  /**
   * Set the volume scattering density
   * @param {Object} volume
   * @param {number} density 0..1 UI slider value
   */
  updateDensity(volume: Volume, density: number): void {
    this.image?.setDensity(density);
    this.redraw();
  }

  /**
   * Set the shading method - applies to pathtraced render mode only
   * @param {Object} volume
   * @param {number} isbrdf 0: brdf, 1: isotropic phase function, 2: mixed
   */
  updateShadingMethod(volume: Volume, isbrdf: boolean): void {
    this.image?.updateShadingMethod(isbrdf);
  }

  /**
   * Set gamma levels: this affects the transparency and brightness of the single pass ray march volume render
   * @param {Object} volume
   * @param {number} gmin
   * @param {number} glevel
   * @param {number} gmax
   */
  setGamma(volume: Volume, gmin: number, glevel: number, gmax: number): void {
    this.image?.setGamma(gmin, glevel, gmax);
    this.redraw();
  }

  /**
   * Set max projection on or off - applies to single pass raymarch render mode only
   * @param {Object} volume
   * @param {boolean} isMaxProject true for max project, false for regular volume ray march integration
   */
  setMaxProjectMode(volume: Volume, isMaxProject: boolean): void {
    this.image?.setMaxProjectMode(isMaxProject);
    this.redraw();
  }

  /**
   * Notify the view that the set of active volume channels has been modified.
   * @param {Object} volume
   */
  updateActiveChannels(_volume: Volume): void {
    this.image?.fuse();
    this.redraw();
  }

  /**
   * Notify the view that transfer function lookup table data has been modified.
   * @param {Object} volume
   */
  updateLuts(_volume: Volume): void {
    this.image?.updateLuts();
    this.redraw();
  }

  /**
   * Notify the view that color and appearance settings have been modified.
   * @param {Object} volume
   */
  updateMaterial(_volume: Volume): void {
    this.image?.updateMaterial();
    this.redraw();
  }

  /**
   * Increase or decrease the overall brightness of the rendered image
   * @param {number} e 0..1
   */
  updateExposure(e: number): void {
    this.exposure = e;
    this.image?.setBrightness(e);
    this.redraw();
  }

  /**
   * Set camera focus properties.
   * @param {number} fov Vertical field of view in degrees
   * @param {number} focalDistance view-space units for center of focus
   * @param {number} apertureSize view-space units for radius of camera aperture
   */
  updateCamera(fov: number, focalDistance: number, apertureSize: number): void {
    this.canvas3d.updateCameraFocus(fov, focalDistance, apertureSize);

    this.image?.onCameraChanged(fov, focalDistance, apertureSize);
    this.redraw();
  }

  /**
   * Set clipping range (between 0 and 1, relative to bounds) for the current volume.
   * @param {Object} volume
   * @param {number} xmin 0..1, should be less than xmax
   * @param {number} xmax 0..1, should be greater than xmin
   * @param {number} ymin 0..1, should be less than ymax
   * @param {number} ymax 0..1, should be greater than ymin
   * @param {number} zmin 0..1, should be less than zmax
   * @param {number} zmax 0..1, should be greater than zmin
   */
  updateClipRegion(
    volume: Volume,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
    zmin: number,
    zmax: number
  ): void {
    this.image?.updateClipRegion(xmin, xmax, ymin, ymax, zmin, zmax);
    this.redraw();
  }

  /**
   * Set clipping range (between 0 and 1) for a given axis.
   * Calling this allows the rendering to compensate for changes in thickness in orthographic views that affect how bright the volume is.
   * @param {Object} volume
   * @param {number} axis 0, 1, or 2 for x, y, or z axis
   * @param {number} minval 0..1, should be less than maxval
   * @param {number} maxval 0..1, should be greater than minval
   * @param {boolean} isOrthoAxis is this an orthographic projection or just a clipping of the range for perspective view
   */
  setAxisClip(volume: Volume, axis: "x" | "y" | "z", minval: number, maxval: number, isOrthoAxis: boolean): void {
    this.image?.setAxisClip(axis, minval, maxval, isOrthoAxis);
    this.redraw();
  }

  /**
   * Update lights
   * @param {Array} state array of Lights
   */
  updateLights(state: Light[]): void {
    // TODO flesh this out
    this.lights = state;

    this.image?.updateLights(state);
  }

  /**
   * Set a sampling rate to trade performance for quality.
   * @param {number} value (+epsilon..1) 1 is max quality, ~0.1 for lowest quality and highest speed
   */
  updatePixelSamplingRate(value: number): void {
    if (this.pixelSamplingRate === value) {
      return;
    }
    this.pixelSamplingRate = value;
    this.image?.setPixelSamplingRate(value);
  }

  /**
   * Set the opacity of the mask channel
   * @param {Object} volume
   * @param {number} value (0..1) 0 for full transparent, 1 for fully opaque
   */
  updateMaskAlpha(volume: Volume, value: number): void {
    this.image?.setMaskAlpha(value);
    this.redraw();
  }

  /**
   * Show / hide volume channels
   * @param {Object} volume
   * @param {number} channel
   * @param {boolean} enabled
   */
  setVolumeChannelEnabled(volume: Volume, channel: number, enabled: boolean): void {
    this.image?.setVolumeChannelEnabled(channel, enabled);
    this.redraw();
  }

  /**
   * Set the material for a channel
   * @param {Object} volume
   * @param {number} channelIndex
   * @param {Array.<number>} colorrgb [r,g,b]
   * @param {Array.<number>} specularrgb [r,g,b]
   * @param {Array.<number>} emissivergb [r,g,b]
   * @param {number} glossiness
   */
  updateChannelMaterial(
    volume: Volume,
    channelIndex: number,
    colorrgb: [number, number, number],
    specularrgb: [number, number, number],
    emissivergb: [number, number, number],
    glossiness: number
  ): void {
    this.image?.updateChannelMaterial(channelIndex, colorrgb, specularrgb, emissivergb, glossiness);
  }

  /**
   * Set the color for a channel
   * @param {Object} volume
   * @param {number} channelIndex
   * @param {Array.<number>} colorrgb [r,g,b]
   */
  updateChannelColor(volume: Volume, channelIndex: number, colorrgb: [number, number, number]): void {
    this.image?.updateChannelColor(channelIndex, colorrgb);
  }

  /**
   * Switch between single pass ray-marched volume rendering and progressive path traced rendering.
   * @param {number} mode 0 for single pass ray march, 1 for progressive path trace
   */
  setVolumeRenderMode(mode: number): void {
    if (mode === this.volumeRenderMode) {
      return;
    }

    this.volumeRenderMode = mode;
    if (this.image) {
      if (mode === RENDERMODE_PATHTRACE && this.canvas3d.hasWebGL2) {
        this.image.setVolumeRendering(true);
        this.image.updateLights(this.lights);
        // pathtrace is a continuous rendering mode
        this.canvas3d.startRenderLoop();
      } else {
        this.image.setVolumeRendering(false);
        this.canvas3d.redraw();
      }
      this.updatePixelSamplingRate(this.pixelSamplingRate);
      this.image.setIsOrtho(isOrthographicCamera(this.canvas3d.camera));
      this.image.setResolution(this.canvas3d);
      this.setAutoRotate(this.canvas3d.controls.autoRotate);

      this.image.setRenderUpdateListener(this.renderUpdateListener);
    }

    // TODO remove when pathtrace supports a bounding box
    this.canvas3d.setShowPerspectiveScaleBar(
      this.canvas3d.showOrthoScaleBar && !!this.image?.showBoundingBox && mode !== RENDERMODE_PATHTRACE
    );
  }

  /**
   *
   * @param {Object} volume
   * @param {Array.<number>} xyz
   */
  setVolumeTranslation(volume: Volume, xyz: [number, number, number]): void {
    this.image?.setTranslation(new Vector3().fromArray(xyz));
    this.redraw();
  }

  /**
   *
   * @param {Object} volume
   * @param {Array.<number>} eulerXYZ
   */
  setVolumeRotation(volume: Volume, eulerXYZ: [number, number, number]): void {
    this.image?.setRotation(new Euler().fromArray(eulerXYZ));
    this.redraw();
  }

  /**
   * Reset the camera to its default position
   */
  resetCamera(): void {
    this.canvas3d.resetCamera();
    this.image?.onResetCamera();
    this.redraw();
  }

  hasWebGL2(): boolean {
    return this.canvas3d.hasWebGL2;
  }
}
