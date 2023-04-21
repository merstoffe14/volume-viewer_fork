import { IVolumeLoader, LoadSpec, PerChannelCallback, VolumeDims } from "./IVolumeLoader";
import { buildDefaultMetadata, computePackedAtlasDims } from "./VolumeLoaderUtils";
import { ImageInfo } from "../Volume";
import Volume from "../Volume";

import { fromUrl } from "geotiff";


//remove these two lines
//let server = "https://api.orbits-ongology.xyz";
let server = "http://localhost:3000";


function prepareXML(xml: string): string {
  // trim trailing unicode zeros?
  // eslint-disable-next-line no-control-regex
  const expr = /[\u0000]$/g;
  return xml.trim().replace(expr, "").trim();
}

function getOME(xml: string): Element {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "text/xml");
  const omeEl = xmlDoc.getElementsByTagName("OME")[0];
  return omeEl;
}

class OMEDims {
  sizex = 0;
  sizey = 0;
  sizez = 0;
  sizec = 0;
  sizet = 0;
  unit = "";
  pixeltype = "";
  dimensionorder = "";
  pixelsizex = 0;
  pixelsizey = 0;
  pixelsizez = 0;
  channelnames: string[] = [];
}

function getOMEDims(imageEl: Element): OMEDims {
  const dims = new OMEDims();

  const pixelsEl = imageEl.getElementsByTagName("Pixels")[0];
  dims.sizex = Number(pixelsEl.getAttribute("SizeX"));
  dims.sizey = Number(pixelsEl.getAttribute("SizeY"));
  dims.sizez = Number(pixelsEl.getAttribute("SizeZ"));
  dims.sizec = Number(pixelsEl.getAttribute("SizeC"));
  dims.sizet = Number(pixelsEl.getAttribute("SizeT"));
  dims.unit = pixelsEl.getAttribute("PhysicalSizeXUnit") || "";
  dims.pixeltype = pixelsEl.getAttribute("Type") || "";
  dims.dimensionorder = pixelsEl.getAttribute("DimensionOrder") || "XYZCT";
  dims.pixelsizex = Number(pixelsEl.getAttribute("PhysicalSizeX"));
  dims.pixelsizey = Number(pixelsEl.getAttribute("PhysicalSizeY"));
  dims.pixelsizez = Number(pixelsEl.getAttribute("PhysicalSizeZ"));
  const channelsEls = pixelsEl.getElementsByTagName("Channel");
  for (let i = 0; i < channelsEls.length; ++i) {
    const name = channelsEls[i].getAttribute("Name");
    const id = channelsEls[i].getAttribute("ID");
    dims.channelnames.push(name ? name : id ? id : "Channel" + i);
  }

  return dims;
}

class TiffLoader implements IVolumeLoader {
  async loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const tiff = await fromUrl(loadSpec.url);
    // DO NOT DO THIS, ITS SLOW
    // const imagecount = await tiff.getImageCount();
    // read the FIRST image
    const image = await tiff.getImage();

    const tiffimgdesc = prepareXML(image.getFileDirectory().ImageDescription);
    const omeEl = getOME(tiffimgdesc);

    const image0El = omeEl.getElementsByTagName("Image")[0];
    const dims = getOMEDims(image0El);

    const d = new VolumeDims();
    d.subpath = "";
    d.shape = [dims.sizet, dims.sizec, dims.sizez, dims.sizey, dims.sizex];
    d.spacing = [1, 1, dims.pixelsizez, dims.pixelsizey, dims.pixelsizex];
    d.spatialUnit = dims.unit ? dims.unit : "micron";
    d.dataType = dims.pixeltype ? dims.pixeltype : "uint8";
    return [d];
  }

  async createVolume(loadSpec: LoadSpec, onChannelLoaded: PerChannelCallback): Promise<Volume> {
    const tiff = await fromUrl(loadSpec.url);
    // DO NOT DO THIS, ITS SLOW
    // const imagecount = await tiff.getImageCount();
    // read the FIRST image
    const image = await tiff.getImage();

    const tiffimgdesc = prepareXML(image.getFileDirectory().ImageDescription);
    const omeEl = getOME(tiffimgdesc);

    const image0El = omeEl.getElementsByTagName("Image")[0];
    const dims = getOMEDims(image0El);

    // compare with sizex, sizey
    //const width = image.getWidth();
    //const height = image.getHeight();

    // TODO allow user setting of this downsampling info?
    // TODO allow ROI selection: range of x,y,z,c for a given t
    const { nrows, ncols } = computePackedAtlasDims(dims.sizez, dims.sizex, dims.sizey);
    // fit tiles to max of 2048x2048?
    const targetSize = 2048;
    const tilesizex = Math.floor(targetSize / ncols);
    const tilesizey = Math.floor(targetSize / nrows);

    // load tiff and check metadata

    /* eslint-disable @typescript-eslint/naming-convention */
    const imgdata: ImageInfo = {
      width: dims.sizex,
      height: dims.sizey,
      channels: dims.sizec,
      channel_names: dims.channelnames,
      rows: nrows,
      cols: ncols,
      tiles: dims.sizez,
      tile_width: tilesizex,
      tile_height: tilesizey,
      // for webgl reasons, it is best for atlas_width and atlas_height to be <= 2048
      // and ideally a power of 2.  This generally implies downsampling the original volume data for display in this viewer.
      atlas_width: tilesizex * ncols,
      atlas_height: tilesizey * nrows,
      pixel_size_x: dims.pixelsizex,
      pixel_size_y: dims.pixelsizey,
      pixel_size_z: dims.pixelsizez,
      name: "TEST",
      version: "1.0",
      pixel_size_unit: dims.unit || "",
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
      },
      times: dims.sizet,
    };
    /* eslint-enable @typescript-eslint/naming-convention */

    const vol = new Volume(imgdata);
    vol.imageMetadata = buildDefaultMetadata(imgdata);

    // do each channel on a worker?
    for (let channel = 0; channel < dims.sizec; ++channel) {
      const params = {
        channel: channel,
        // these are target xy sizes for the in-memory volume data
        // they may or may not be the same size as original xy sizes
        tilesizex: tilesizex,
        tilesizey: tilesizey,
        sizec: dims.sizec,
        sizez: dims.sizez,
        dimensionOrder: dims.dimensionorder,
        bytesPerSample: dims.pixeltype === "uint8" ? 1 : dims.pixeltype === "uint16" ? 2 : 4,
        url: loadSpec.url,
      };
      const worker = new Worker(new URL("../workers/FetchTiffWorker", import.meta.url));
      worker.onmessage = function (e) {
        const u8 = e.data.data;
        const channel = e.data.channel;
        vol.setChannelDataFromVolume(channel, u8);
        if (onChannelLoaded) {
          // make up a unique name? or have caller pass this in?
          onChannelLoaded(loadSpec.url, vol, channel);
        }
        worker.terminate();
      };
      worker.onerror = function (e) {
        alert("Error: Line " + e.lineno + " in " + e.filename + ": " + e.message);
      };
      worker.postMessage(params);
    }
    return vol;
  }
}




export { TiffLoader };
