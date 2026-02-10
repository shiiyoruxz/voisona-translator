import * as tf from '@tensorflow/tfjs';
import type {
  DetectionBox,
  DetectionCallback,
  ModelConfig,
  PreprocessResult,
  VideoSource,
} from './detection-types';
import { labels } from './labels';

const numClass = labels.length;

// Timing variables
let personDetectionStartTime: number | null = null;
let noPersonDetectionStartTime: number | null = null;
let loadingTimeoutId: number | null = null;
let noPersonTimeoutId: number | null = null;
let lastPersonDetected: boolean = false;

// Callback for tracking state changes
let onTrackingStateChange: ((state: 'video' | 'loading' | 'avatar') => void) | null = null;

/**
 * Set the callback for tracking state changes
 */
export const setTrackingStateCallback = (
  callback: (state: 'video' | 'loading' | 'avatar') => void
) => {
  onTrackingStateChange = callback;
};

/**
 * Handle timing logic for person detection
 * @param {boolean} personDetected - Whether a person was detected in current frame
 */
const handlePersonDetectionTiming = (personDetected: boolean) => {
  const currentTime = Date.now();

  if (personDetected) {
    // Clear no-person timeout if it exists
    if (noPersonTimeoutId) {
      clearTimeout(noPersonTimeoutId);
      noPersonTimeoutId = null;
    }
    noPersonDetectionStartTime = null;

    // If this is the first detection or person was not detected before, start the loading timer
    if (personDetectionStartTime === null || !lastPersonDetected) {
      personDetectionStartTime = currentTime;
      onTrackingStateChange?.('loading');

      // Set 2-second delay before switching to avatar
      loadingTimeoutId = window.setTimeout(() => {
        onTrackingStateChange?.('avatar');
        loadingTimeoutId = null;
      }, 2000);
    }
  } else {
    // Clear loading timeout if it exists
    if (loadingTimeoutId) {
      clearTimeout(loadingTimeoutId);
      loadingTimeoutId = null;
    }
    personDetectionStartTime = null;

    // If we're currently showing avatar, start the no-person timer
    if (noPersonDetectionStartTime === null) {
      noPersonDetectionStartTime = currentTime;

      // Set 5-second timeout before switching back to video
      noPersonTimeoutId = window.setTimeout(() => {
        onTrackingStateChange?.('video');
        noPersonTimeoutId = null;
        noPersonDetectionStartTime = null;
      }, 5000);
    }
  }

  // Update the last person detected state
  lastPersonDetected = personDetected;
};

// helper: always return [r,g,b] as numbers from whatever `color` is
function toRGBNums(color: string | number[]) {
  if (Array.isArray(color)) return color.map(Number); // already [r,g,b]
  // "rgba(255, 0, 0, 1)" or "rgb(255,0,0)"
  const m = color.match(/\d+/g);
  if (m && m.length >= 3) return m.slice(0, 3).map(Number);
  // "#ff0000" or "#f00"
  const hex = color.replace('#', '');
  const h =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Preprocess image / frame before forwarded into the model
 * @param {HTMLVideoElement|HTMLImageElement} source
 * @param {Number} modelWidth
 * @param {Number} modelHeight
 * @returns input tensor, xRatio and yRatio
 */
const preprocess = (
  source: VideoSource,
  modelWidth: number,
  modelHeight: number
): PreprocessResult => {
  const input = tf.tidy(() => {
    const img = tf.browser.fromPixels(source);

    // padding image to square => [n, m] to [n, n], n > m
    const [h, w] = img.shape.slice(0, 2); // get source width and height
    const maxSize = Math.max(w, h); // get max size
    const imgPadded = img.pad([
      [0, maxSize - h], // padding y [bottom only]
      [0, maxSize - w], // padding x [right only]
      [0, 0],
    ]);

    return tf.image
      .resizeBilinear(imgPadded as tf.Tensor3D, [modelWidth, modelHeight]) // resize frame
      .div(255.0) // normalize
      .expandDims(0); // add batch
  });

  // Calculate ratios outside of tf.tidy
  const img = tf.browser.fromPixels(source);
  const [h, w] = img.shape.slice(0, 2);
  const maxSize = Math.max(w, h);
  const xRatio = maxSize / w;
  const yRatio = maxSize / h;
  img.dispose();

  return [input, xRatio, yRatio];
};

/**
 * Function to detect image.
 * @param {HTMLImageElement} source Source
 * @param {tf.GraphModel} model loaded YOLOv8 tensorflow.js model
 * @param {HTMLCanvasElement} canvasRef canvas reference
 * @param {VoidFunction} callback Callback function to run after detect frame is done
 */
export const detectFrame = async (
  source: VideoSource,
  model: ModelConfig,
  canvasRef: HTMLCanvasElement,
  callback: DetectionCallback = () => {}
) => {
  let personFound = false;

  // Validate video source dimensions before processing
  if ('videoWidth' in source && (source.videoWidth === 0 || source.videoHeight === 0)) {
    callback();
    return;
  }

  const [modelHeight, modelWidth] = model.inputShape.slice(1, 3); // get model width and height
  const outputShape = model.outputShape?.[1]?.slice(1);
  if (!outputShape || outputShape.length < 3) {
    callback();
    return;
  }
  const [modelSegHeight, modelSegWidth, modelSegChannel] = outputShape as [number, number, number];

  tf.engine().startScope(); // start scoping tf engine

  const [input, xRatio, yRatio] = preprocess(source, modelWidth, modelHeight); // do preprocessing

  if (!model.net) {
    callback();
    return;
  }

  const res = model.net.execute(input); // execute model
  const resArray = Array.isArray(res) ? res : [res];
  const transRes = tf.tidy(() => resArray[0].transpose([0, 2, 1]).squeeze()); // transpose main result
  const transSegMask = tf.tidy(() => resArray[1].transpose([0, 3, 1, 2]).squeeze()); // transpose segmentation mask result

  const boxes = tf.tidy(() => {
    const w = transRes.slice([0, 2], [-1, 1]);
    const h = transRes.slice([0, 3], [-1, 1]);
    const x1 = tf.sub(transRes.slice([0, 0], [-1, 1]), tf.div(w, 2)); //x1
    const y1 = tf.sub(transRes.slice([0, 1], [-1, 1]), tf.div(h, 2)); //y1
    return tf
      .concat(
        [
          y1,
          x1,
          tf.add(y1, h), //y2
          tf.add(x1, w), //x2
        ],
        1
      ) // [y1, x1, y2, x2]
      .squeeze(); // [n, 4]
  }); // get boxes [y1, x1, y2, x2]

  const [scores, classes] = tf.tidy(() => {
    const rawScores = transRes.slice([0, 4], [-1, numClass]).squeeze(); // [n, 1]
    return [rawScores.max(1), rawScores.argMax(1)];
  }); // get scores and classes

  const nms = await tf.image.nonMaxSuppressionAsync(
    boxes as tf.Tensor2D,
    scores as tf.Tensor1D,
    500,
    0.45,
    0.2
  ); // do nms to filter boxes
  const detReady = tf.tidy(() =>
    tf.concat(
      [
        boxes.gather(nms, 0),
        scores.gather(nms, 0).expandDims(1),
        classes.gather(nms, 0).expandDims(1),
      ],
      1 // axis
    )
  ); // indexing selected boxes, scores and classes from NMS result
  const masks = tf.tidy(() => {
    const sliced = transRes.slice([0, 4 + numClass], [-1, modelSegChannel]).squeeze(); // slice mask from every detection [m, mask_size]
    return sliced
      .gather(nms, 0) // get selected mask from NMS result
      .matMul(transSegMask.reshape([modelSegChannel, -1])) // matmul mask with segmentation mask result [n, mask_size] x [mask_size, h x w] => [n, h x w]
      .reshape([nms.shape[0], modelSegHeight, modelSegWidth]); // reshape back [n, h x w] => [n, h, w]
  }); // processing mask

  const toDraw: DetectionBox[] = []; // list boxes to draw
  let overlay = tf.zeros([modelHeight, modelWidth, 4]); // initialize overlay to draw mask

  for (let i = 0; i < detReady.shape[0]; i++) {
    const rowData = detReady.slice([i, 0], [1, 6]); // get every first 6 element from every row
    let [y1, x1, y2, x2, score, label] = rowData.dataSync(); // [y1, x1, y2, x2, score, label]
    const color = `#${Math.floor(Math.random() * 16777215).toString(16)}`; // random color

    const downSampleBox = [
      Math.floor((y1 * modelSegHeight) / modelHeight), // y
      Math.floor((x1 * modelSegWidth) / modelWidth), // x
      Math.round(((y2 - y1) * modelSegHeight) / modelHeight), // h
      Math.round(((x2 - x1) * modelSegWidth) / modelWidth), // w
    ]; // downsampled box (box ratio at model output)
    const upSampleBox = [
      Math.floor(y1 * yRatio), // y
      Math.floor(x1 * xRatio), // x
      Math.round((y2 - y1) * yRatio), // h
      Math.round((x2 - x1) * xRatio), // w
    ]; // upsampled box (box ratio to draw)

    const proto = tf.tidy(() => {
      const sliced = masks.slice(
        [
          i,
          downSampleBox[0] >= 0 ? downSampleBox[0] : 0,
          downSampleBox[1] >= 0 ? downSampleBox[1] : 0,
        ],
        [
          1,
          downSampleBox[0] + downSampleBox[2] <= modelSegHeight
            ? downSampleBox[2]
            : modelSegHeight - downSampleBox[0],
          downSampleBox[1] + downSampleBox[3] <= modelSegWidth
            ? downSampleBox[3]
            : modelSegWidth - downSampleBox[1],
        ]
      ); // coordinate to slice mask from proto
      return sliced.squeeze().expandDims(-1); // sliced proto [h, w, 1]
    });
    const upsampleProto = tf.image.resizeBilinear(proto as tf.Tensor3D, [
      upSampleBox[2],
      upSampleBox[3],
    ]); // resizing proto to drawing size
    const mask = tf.tidy(() => {
      const padded = upsampleProto.pad([
        [upSampleBox[0], modelHeight - (upSampleBox[0] + upSampleBox[2])],
        [upSampleBox[1], modelWidth - (upSampleBox[1] + upSampleBox[3])],
        [0, 0],
      ]); // padding proto to canvas size
      return padded.less(0.5); // make boolean mask from proto to indexing overlay
    }); // final boolean mask
    overlay = tf.tidy(() => {
      const [r, g, b] = toRGBNums(color);
      // make a float32 [1,1,4] tensor so it broadcasts to [H,W,4]
      const paint = tf.tensor([r, g, b, 150], [1, 1, 4], 'float32');
      // mask: [H,W,1] (bool) will broadcast to channels; overlay: [H,W,4]
      const next = tf.where(mask, paint, overlay);
      overlay.dispose();
      return next;
    });

    toDraw.push({
      box: upSampleBox as [number, number, number, number],
      score: score,
      klass: label,
      label: labels[label],
      color: color,
    }); // push box information to draw later

    // Check for person detection (class 0 is "person")
    personFound = toDraw.some((detection) => detection.klass === 0);

    tf.dispose([rowData, proto, upsampleProto, mask]); // dispose unused tensor to free memory
  }

  const maskImg = new ImageData(
    new Uint8ClampedArray(await overlay.data()), // tensor to array
    modelHeight,
    modelWidth
  ); // create image data from mask overlay

  const ctx = canvasRef.getContext('2d');
  if (!ctx) {
    callback();
    return;
  }
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); // clean canvas
  ctx.putImageData(maskImg, 0, 0); // render overlay to canvas

  // Render boxes
  toDraw.forEach((detection) => {
    const { box, score, label, color } = detection;
    const [y, x, h, w] = box;

    // Draw box
    ctx.fillStyle = `${color}33`; // 20% opacity
    ctx.fillRect(x, y, w, h);

    // Draw border
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(Math.min(ctx.canvas.width, ctx.canvas.height) / 200, 2.5);
    ctx.strokeRect(x, y, w, h);

    // Draw label background
    ctx.fillStyle = color;
    const font = `${Math.max(Math.round(Math.max(ctx.canvas.width, ctx.canvas.height) / 40), 14)}px Arial`;
    ctx.font = font;
    ctx.textBaseline = 'top';
    const text = `${label} - ${(score * 100).toFixed(1)}%`;
    const textWidth = ctx.measureText(text).width;
    const textHeight = parseInt(font, 10);
    const yText = y - (textHeight + ctx.lineWidth);
    ctx.fillRect(
      x - 1,
      yText < 0 ? 0 : yText,
      textWidth + ctx.lineWidth,
      textHeight + ctx.lineWidth
    );

    // Draw label text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x - 1, yText < 0 ? 0 : yText);
  });

  // Handle timing logic for person detection
  handlePersonDetectionTiming(personFound);

  callback(); // run callback function

  tf.engine().endScope(); // end of scoping
};

/**
 * Function to detect video from every source.
 * @param {HTMLVideoElement} vidSource video source
 * @param {tf.GraphModel} model loaded YOLOv8 tensorflow.js model
 * @param {HTMLCanvasElement} canvasRef canvas reference
 */
export const detectVideo = (
  vidSource: HTMLVideoElement,
  model: ModelConfig,
  canvasRef: HTMLCanvasElement
) => {
  /**
   * Function to detect every frame from video
   */
  const detect = async () => {
    // Check if video is ready and has valid dimensions
    if (vidSource.videoWidth === 0 || vidSource.videoHeight === 0 || vidSource.srcObject === null) {
      if (canvasRef && canvasRef.getContext) {
        const ctx = canvasRef.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); // clean canvas
        }
      }
      requestAnimationFrame(detect); // keep checking until video is ready
      return;
    }

    detectFrame(vidSource, model, canvasRef, () => {
      requestAnimationFrame(detect); // get another frame
    });
  };

  detect(); // initialize to detect every frame
};
