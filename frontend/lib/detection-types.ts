import * as tf from '@tensorflow/tfjs';

// Model types
export interface ModelConfig {
  net: tf.GraphModel | null;
  inputShape: number[];
  outputShape?: tf.Shape[];
}

// Detection types
export interface DetectionBox {
  box: [number, number, number, number]; // [y, x, h, w]
  score: number;
  klass: number;
  label: string;
  color: string;
}

export interface DetectionResult {
  boxes: tf.Tensor2D;
  scores: tf.Tensor1D;
  classes: tf.Tensor1D;
  masks?: tf.Tensor3D;
}

// Video source types
export type VideoSource = HTMLVideoElement | HTMLImageElement;

// Callback types
export type DetectionCallback = () => void;

// Preprocessing result type
export type PreprocessResult = [tf.Tensor, number, number];

// Tracking state type
export type TrackingState = 'video' | 'loading' | 'avatar';
