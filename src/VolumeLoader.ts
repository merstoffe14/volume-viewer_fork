import { loadZarr } from "@loaders.gl/zarr";
import "regenerator-runtime";
import { slice, openArray } from "zarr";

import Volume from "./Volume.js";

/**
 * @callback PerChannelCallback
 * @param {string} imageurl
 * @param {number} channelindex
 */
type PerChannelCallback = (imageurl: string, channelindex: number) => void;

/**
 * @class
 */
const volumeLoader = {
  /**
   * load per-channel volume data from a batch of image files containing the volume slices tiled across the images
   * @param {Volume} volume
   * @param {Array.<{name:string, channels:Array.<number>}>} imageArray
   * @param {PerChannelCallback} callback Per-channel callback.  Called when each channel's atlased volume data is loaded
   * @returns {Object.<string, Image>} a map(imageurl : Image object) that should be used to cancel the download requests,
   * for example if you need to destroy the image before all data has arrived.
   * as requests arrive, the callback will be called per image, not per channel
   * @example loadVolumeAtlasData(myvolume, [{
   *     "name": "AICS-10_5_5.ome.tif_atlas_0.png",
   *     "channels": [0, 1, 2]
   * }, {
   *     "name": "AICS-10_5_5.ome.tif_atlas_1.png",
   *     "channels": [3, 4, 5]
   * }, {
   *     "name": "AICS-10_5_5.ome.tif_atlas_2.png",
   *     "channels": [6, 7, 8]
   * }], mycallback);
   */
  loadVolumeAtlasData: function (
    volume: Volume,
    imageArray: Array<{ name: string; channels: Array<number> }>,
    callback: PerChannelCallback
  ): Record<string, unknown> {
    const numImages = imageArray.length;

    const requests = {};
    //console.log("BEGIN DOWNLOAD DATA");
    for (let i = 0; i < numImages; ++i) {
      const url = imageArray[i].name;
      const batch = imageArray[i].channels;

      // using Image is just a trick to download the bits as a png.
      // the Image will never be used again.
      const img = new Image();
      img.onerror = function () {
        console.log("ERROR LOADING " + url);
      };
      img.onload = (function (thisbatch) {
        return function (event) {
          //console.log("GOT ch " + me.src);
          // extract pixels by drawing to canvas
          const canvas = document.createElement("canvas");
          // nice thing about this is i could downsample here
          const w = Math.floor(event.target.naturalWidth);
          const h = Math.floor(event.target.naturalHeight);
          canvas.setAttribute("width", w + "px");
          canvas.setAttribute("height", h + "px");
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            console.warn("could not decode image data due to bad canvas");
            return;
          }
          ctx.globalCompositeOperation = "copy";
          ctx.globalAlpha = 1.0;
          ctx.drawImage(event.target, 0, 0, w, h);
          // getImageData returns rgba.
          // optimize: collapse rgba to single channel arrays
          const iData = ctx.getImageData(0, 0, w, h);

          const channelsBits: Uint8Array[] = [];
          // allocate channels in batch
          for (let ch = 0; ch < Math.min(thisbatch.length, 4); ++ch) {
            channelsBits.push(new Uint8Array(w * h));
          }
          // extract the data
          for (let j = 0; j < Math.min(thisbatch.length, 4); ++j) {
            for (let px = 0; px < w * h; px++) {
              channelsBits[j][px] = iData.data[px * 4 + j];
            }
          }

          // done with img, iData, and canvas now.

          for (let ch = 0; ch < Math.min(thisbatch.length, 4); ++ch) {
            volume.setChannelDataFromAtlas(thisbatch[ch], channelsBits[ch], w, h);
            callback(url, thisbatch[ch]);
          }
        };
      })(batch);
      img.crossOrigin = "Anonymous";
      img.src = url;
      requests[url] = img;
    }

    return requests;
  },

  // loadVolumeAICS(url:string, callback:PerChannelCallback) : Promise<Volume> {
  //   // note that volume is returned before channel data is ready.
  //   return fetch(url)
  //     .then(function(response) {
  //       return response.json();
  //     })
  //     .then(function(myJson) {
  //       // if you need to adjust image paths prior to download,
  //       // now is the time to do it:
  //       // myJson.images.forEach(function(element) {
  //       //     element.name = myURLprefix + element.name;
  //       // });
  //       const vol = new Volume(myJson);

  //       volumeLoader.loadVolumeAtlasData(
  //         vol, myJson.images, callback);
  //       return vol;
  //     });
  // },

  /**
   * load 5d ome-zarr into Volume object
   * @param {string} url
   * @param {PerChannelCallback} callback Per-channel callback.  Called when each channel's atlased volume data is loaded
   * @returns {Promise<Volume>}
   */
  loadZarr: function (url: string, callback: PerChannelCallback): Promise<Volume> {
    // return openArray({
    //   store: "http://localhost:9020/example-data/z0.zarr",
    //   path: "image0/0",
    //   mode: "r",
    // }).then((z) => {
    //   console.log(z);
    //   return new Volume();
    // });

    return loadZarr("http://localhost:9020/example-data/z0.zarr/image0").then((data) => {
      //console.log(data);
      const metadata = data.metadata.omero;
      const level0 = data.data[0];
      const level3 = data.data[1];

      const w = level0.shape[4];
      const h = level0.shape[3];
      const tw = level3.shape[4];
      const th = level3.shape[3];
      const z = level0.shape[2];
      const c = level0.shape[1];
      // compute rows and cols and atlas width and ht, given tw and th
      let nextrows = 1;
      let nextcols = z;
      let ratio = (nextcols * tw) / (nextrows * th);
      let nrows = nextrows;
      let ncols = nextcols;
      while (ratio > 1) {
        nrows = nextrows;
        ncols = nextcols;
        nextcols -= 1;
        nextrows = Math.ceil(z / nextcols);
        ratio = (nextcols * tw) / (nextrows * th);
      }
      const atlaswidth = ncols * tw;
      const atlasheight = nrows * th;

      const chnames: string[] = [];
      for (let i = 0; i < metadata.channels.length; ++i) {
        chnames.push(metadata.channels[i].label);
      }
      const imgdata = {
        width: w,
        height: h,
        channels: c,
        channel_names: chnames,
        rows: nrows,
        cols: ncols,
        tiles: z,
        tile_width: tw,
        tile_height: th,
        // for webgl reasons, it is best for atlas_width and atlas_height to be <= 2048
        // and ideally a power of 2.  This generally implies downsampling the original volume data for display in this viewer.
        atlas_width: atlaswidth,
        atlas_height: atlasheight,
        pixel_size_x: metadata.pixel_size.x,
        pixel_size_y: metadata.pixel_size.y,
        pixel_size_z: metadata.pixel_size.z,
        name: metadata.name,
        status: "OK",
        version: metadata.version,
        aicsImageVersion: "4.x",
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0],
        },
      };

      // got some data, now let's construct the volume.
      const vol = new Volume(imgdata);

      // now we get the chunks:
      for (let i = 0; i < c; ++i) {
        level3._data.get([0, i, null, null, null]).then((channel) => {
          const chmin = metadata.channels[i].window.min;
          const chmax = metadata.channels[i].window.max;
          const npixels = channel.shape[0] * channel.shape[1] * channel.shape[2];
          const xy = channel.shape[1] * channel.shape[2];
          // flatten the 3d array and convert to uint8
          const u8 = new Uint8Array(npixels);
          for (let j = 0; j < npixels; ++j) {
            const slice = Math.floor(j / xy);
            const yrow = Math.floor(j / channel.shape[2]) - slice * channel.shape[1];
            const xcol = j % channel.shape[2];
            u8[j] = ((channel.data[slice][yrow][xcol] - chmin) / (chmax - chmin)) * 255;
          }
          vol.setChannelDataFromVolume(i, u8);
          if (callback) {
            callback(url, i);
          }
        });
        // level3.getRaster({ selection: { c: i, t: 0 } }).then((channel) => {
        //   // flatten the 3d array and convert to uint8
        //   const u8 = new Uint8Array(channel.data.length);
        //   vol.setChannelDataFromVolume(i, u8);
        // });
        // level3.get([0, i, null, null, null]).then((channel) => {
        // });
      }
      return vol;
    });
  },
};

export default volumeLoader;
