import { IVolumeLoader, LoadSpec, PerChannelCallback, VolumeDims } from "./IVolumeLoader";
import { buildDefaultMetadata, computePackedAtlasDims } from "./VolumeLoaderUtils";
import { ImageInfo } from "../Volume";
import Volume from "../Volume";



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

function fetchH5(url) {
    console.log(url)
    url = server + "/api/loadH5?file=" + url;
    fetch(url).then(function (response) {
        return response.arrayBuffer();  
    }).then(async function (buffer) {
      let f = new hdf5.File(buffer, "fileOutput.h5");
      console.log(f.get("image_data"))

      let g = f.get("image_data");
      let image_data_array = math.reshape(g.value, g.shape);
      let b = f.get("mask");
      // there is some issue with b.value in this line.
      // let mask_data_array = math.reshape(b.value, b.shape);
      console.log(g.shape)
      console.log(image_data_array)

      let image = {
        data: image_data_array,
        shape: g.shape
      } 

     

    return image
    });
}


class H5Loader implements IVolumeLoader {
  async loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
      //give it loadSpec.url (put the url in loadspec)
    let data = fetchH5("C:/Users/Xander/Documents/orbits/4x_B4.H5");
    console.log("data:")
    console.log(data)
    const d = new VolumeDims();
    d.subpath = "";
    d.shape = data.shape;
    d.spacing = [1, 1, 1, 1, 1];
    // d.spacing = [1, 1, dims.pixelsizez, dims.pixelsizey, dims.pixelsizex];
    d.spatialUnit = "micron";
    d.dataType = "uint8";
    return [d];
  }


  async createVolume(loadSpec: LoadSpec, onChannelLoaded: PerChannelCallback): Promise<Volume> {
    console.log("called h5 create volume!")
    //give it loadSpec.url (put the url in loadspec)
    let data = fetchH5("C:/Users/Xander/Documents/orbits/4x_B4.H5");
    console.log(data)
    // un hardcode this.
    /* eslint-disable @typescript-eslint/naming-convention */
    const imgdata: ImageInfo = {
      // width: data.shape[3],
      // height: data.shape[2],
      // channels: data.shape[1],
      width: 1950,
      height: 1900,
      channels: 3,
      channel_names: ["0","1","2"],
      rows: 1,
      cols: 1,
      tiles: 1,
      // tile_width: data.shape[3],
      // tile_height: data.shape[2],
      tile_width: 1900,
      tile_height: 1950,
      // for webgl reasons, it is best for atlas_width and atlas_height to be <= 2048
      // and ideally a power of 2.  This generally implies downsampling the original volume data for display in this viewer.
      // atlas_width: data.shape[3],
      // atlas_height: data.shape[2],
      atlas_width: 1900,
      atlas_height: 1950,
      pixel_size_x: 1,
      pixel_size_y: 1,
      pixel_size_z: 2,
      name: "TEST",
      version: "1.0",
      pixel_size_unit: "µm",
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
      },
      times: 1,
    };
    /* eslint-enable @typescript-eslint/naming-convention */

    const vol = new Volume(imgdata);
    vol.imageMetadata = buildDefaultMetadata(imgdata);
    console.log("test_data")
    console.log(data)

    // make a uint8array array with width of 1900 and height of 1950 and all values are random
    // let test_data = new Uint8Array(1900 * 1950)
    // for (let i = 0; i < 1900 * 1950; i++) {
    //   test_data[i] = 100
    // }

   

    //genereta a uint8array of a checkerboard of size 1900 * 1950 with every square taking 10 percent
    let test_data = new Uint8Array(1900 * 1950)
    for (let i = 0; i < 1900 * 1950; i++) {
      if (i % 190 < 55 && i % 190 > 50) {
        test_data[i] = 255
      } else {
        test_data[i] = 0
      }
    }


    

    vol.setChannelDataFromVolume(0, test_data);
    vol.loaded = true;
    console.log("H5 loader vol:")
    console.log(vol)


    vol.setChannelDataFromAtlas(0, test_data, imgdata.width, imgdata.height);
    onChannelLoaded("url", vol, 0);
          

    return vol;
  }
}

export { H5Loader };
