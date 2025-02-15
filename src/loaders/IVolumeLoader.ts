import Volume from "../Volume";

export class LoadSpec {
  url = "";
  subpath = "";
  scene = 0;
  time = 0;
  // sub-region; if not specified, the entire volume is loaded
  minx = 0;
  miny = 0;
  minz = 0;
  maxx = 0;
  maxy = 0;
  maxz = 0;
}

export class VolumeDims {
  subpath = "";
  // shape: [t, c, z, y, x]
  shape: number[] = [0, 0, 0, 0, 0];
  // spacing: [t, c, z, y, x]; generally expect 1 for non-spatial dimensions
  spacing: number[] = [1, 1, 1, 1, 1];
  spatialUnit = "micron";
  dataType = "uint8";
}

/**
 * @callback PerChannelCallback
 * @param {string} imageurl
 * @param {Volume} volume
 * @param {number} channelindex
 */
export type PerChannelCallback = (imageurl: string, volume: Volume, channelIndex: number) => void;

export interface IVolumeLoader {
  // use VolumeDims to further refine a LoadSpec for use in createVolume
  loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]>;

  // create a Volume from a LoadSpec; async data download will be initiated here
  // TODO this is not cancellable in the sense that any async requests initiated here are not stored
  // in a way that they can be interrupted.
  createVolume(loadSpec: LoadSpec, onChannelLoaded: PerChannelCallback): Promise<Volume>;
}
