import { useCallback, useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import { detectVideo, setTrackingStateCallback } from '../lib/detection';
import type { ModelConfig, TrackingState } from '../lib/detection-types';
import { Webcam } from '../lib/webcam';

interface UseVideoDetectionOptions {
  modelName?: string;
  onTrackingStateChange?: (state: TrackingState) => void;
}

export const useVideoDetection = (options: UseVideoDetectionOptions = {}) => {
  const { modelName = 'yolov8n-seg', onTrackingStateChange } = options;

  const [loading, setLoading] = useState({ loading: true, progress: 0 });
  const [model, setModel] = useState<ModelConfig>({
    net: null,
    inputShape: [1, 640, 640, 3], // YOLOv8n expects 640x640 input
  });
  const [trackingState, setTrackingState] = useState<TrackingState>('video');
  const [showCamera, setShowCamera] = useState(false);
  const [cameraInitialized, setCameraInitialized] = useState(false);

  const webcamRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webcam = useRef(new Webcam());

  // Set up tracking state callback
  useEffect(() => {
    setTrackingStateCallback((state: TrackingState) => {
      setTrackingState(state);
      onTrackingStateChange?.(state);
    });
  }, [onTrackingStateChange]);

  // Load model on mount
  useEffect(() => {
    const loadModel = async () => {
      try {
        (tf as any).ready().then(async () => {
          const yolov8 = await (tf as any).loadGraphModel(
            `${window.location.href}${modelName}_web_model/model.json`,
            {
              onProgress: (fractions: number) => {
                setLoading({ loading: true, progress: fractions });
              },
            }
          );

          // Warming up model
          const dummyInput = (tf as any).randomUniform(
            yolov8.inputs[0].shape as number[],
            0,
            1,
            'float32'
          );
          const warmupResults = yolov8.execute(dummyInput);

          setLoading({ loading: false, progress: 1 });
          setModel({
            net: yolov8,
            inputShape: yolov8.inputs[0].shape as number[],
            outputShape: Array.isArray(warmupResults)
              ? warmupResults.map((e: tf.Tensor) => e.shape)
              : [warmupResults.shape],
          });

          (tf as any).dispose([warmupResults, dummyInput]);
        });
      } catch (error) {
        console.error('Failed to load model:', error);
        setLoading({ loading: false, progress: 0 });
      }
    };

    loadModel();
  }, [modelName]);

  // Start camera and detection immediately when model is loaded
  useEffect(() => {
    const startCameraDetection = async () => {
      if (webcamRef.current && model.net && !cameraInitialized) {
        try {
          await webcam.current.open(webcamRef.current);
          setCameraInitialized(true);

          // Start detection immediately after camera opens
          if (canvasRef.current) {
            detectVideo(webcamRef.current, model, canvasRef.current);
          }
        } catch (error) {
          console.error('Failed to initialize camera:', error);
        }
      }
    };

    startCameraDetection();
  }, [model, cameraInitialized]);

  // Start detection when video starts playing
  const handleVideoPlay = useCallback(() => {
    if (webcamRef.current && canvasRef.current && model.net) {
      detectVideo(webcamRef.current, model, canvasRef.current);
    }
  }, [model]);

  const toggleCamera = useCallback(() => {
    setShowCamera((prev) => !prev);
  }, []);

  const closeCamera = useCallback(() => {
    if (webcamRef.current) {
      webcam.current.close(webcamRef.current);
      setShowCamera(false);
    }
  }, []);

  return {
    loading,
    model,
    trackingState,
    showCamera,
    cameraInitialized,
    webcamRef,
    canvasRef,
    toggleCamera,
    closeCamera,
    handleVideoPlay,
  };
};
