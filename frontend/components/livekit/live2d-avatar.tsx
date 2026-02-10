'use client';

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
    PIXI?: unknown;
  }
}

interface Live2DAvatarProps {
  /** URL to .model3.json (e.g. /models/ruuru/model.model3.json). If not set, nothing is rendered. */
  modelUrl: string | null | undefined;
  /** Agent audio track for lip sync (optional). */
  audioTrack?: { mediaStreamTrack?: MediaStreamTrack } | null;
  /** Whether the agent is currently speaking (fallback for mouth movement). */
  isSpeaking?: boolean;
  className?: string;
  /** Width/height of the container (avatar will scale to fit). */
  size?: number;
  /** When Live2D fails to load (e.g. missing Cubism Core), show this image so the avatar area is never empty. */
  fallbackImageUrl?: string;
}

const CUBISM_CORE_SCRIPT = '/live2dcubismcore.min.js';
// mao_pro and many models use ParamA for lip sync; others use ParamMouthOpenY / ParamMouthForm
const MOUTH_PARAM_IDS = ['ParamA', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthOpenX'];
const VOLUME_TO_MOUTH_SCALE = 6.0; // Higher sensitivity so same audio produces larger mouth opening
const MOUTH_EXAGGERATION = 1.2; // Slight boost; keep mouth movement natural
const MOUTH_CAP = 1; // Standard range
/** Stable value for useEffect deps so array length never changes (React requirement). */
const EFFECT_DEPS_STABLE = null;

/**
 * Loads a script by URL and resolves when loaded.
 */
function loadScript(src: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('No document'));
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Live2D avatar with idle motion and lip sync to agent voice.
 * Requires Cubism Core (live2dcubismcore.min.js) in public/ and a Cubism 3/4 model.
 */
export function Live2DAvatar({
  modelUrl,
  audioTrack,
  isSpeaking = false,
  className,
  size = 256,
  fallbackImageUrl,
}: Live2DAvatarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isSpeakingRef = useRef(isSpeaking);
  isSpeakingRef.current = isSpeaking;
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  audioTrackRef.current = audioTrack?.mediaStreamTrack ?? null;
  /** Set by init or by reconnect effect; used so mouth ticker and track changes use same analyser. */
  const audioSetupRef = useRef<{
    audioContext: AudioContext;
    analyserNode: AnalyserNode;
    dataArray: Uint8Array;
    timeDomainArray: Uint8Array;
    streamSource: MediaStreamAudioSourceNode | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const initializingRef = useRef(false);

  useEffect(() => {
    if (!modelUrl || !containerRef.current) return;
    
    // Prevent duplicate initialization in React StrictMode (dev mode double-mount)
    if (initializingRef.current) {
      console.log('[Live2D] Already initializing, skipping duplicate');
      return;
    }
    initializingRef.current = true;

    // Clear any existing content
    const container = containerRef.current;
    while (container.firstChild) container.removeChild(container.firstChild);

    let destroyed = false;
    let app: unknown = null;
    let model: unknown = null;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let streamSource: MediaStreamAudioSourceNode | null = null;
    let mouthValue = 0;
    let rafId = 0;
    let updateTickerFn: ((deltaMS: number) => void) | null = null;
    let mouthTickerFn: ((deltaMS: number) => void) | null = null;

    async function init() {
      try {
        // 1. Load Cubism Core if needed
        if (!window.Live2DCubismCore) {
          await loadScript(CUBISM_CORE_SCRIPT);
        }
        if (destroyed) return;

        // 2. Dynamic import Pixi and Live2D (client-only) - pixi-live2d-display requires PixiJS v6
        const PIXI = await import('pixi.js');
        const { Live2DModel } = await import('pixi-live2d-display/cubism4');
        if (destroyed) return;

        // Register PIXI Ticker so Live2D models auto-update (removes "No Ticker registered" warning)
        if (typeof (Live2DModel as any).registerTicker === 'function' && PIXI.Ticker) {
          (Live2DModel as any).registerTicker(PIXI.Ticker);
        }

        // 3. Create Pixi Application (v6 API: constructor options, canvas is .view)
        const application = new PIXI.Application({
          width: size,
          height: size,
          backgroundColor: 0x000000,
          backgroundAlpha: 0,
          antialias: true,
          resizeTo: containerRef.current ?? undefined,
          autoDensity: true,
          resolution: Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
          autoStart: true, // Ensure ticker starts immediately
        });
        if (destroyed) return;
        
        console.log('[Live2D] PIXI Application created, ticker running:', application.ticker.started);

        app = application;
        const view = application.view as HTMLCanvasElement;
        if (containerRef.current && view) {
          containerRef.current.appendChild(view);
          view.style.display = 'block';
          view.style.width = '100%';
          view.style.height = '100%';
        }

        // 4. Load Live2D model with idle motion, no mouse interaction
        const url = modelUrl as string;
        const live2dModel = (await Live2DModel.from(url, {
          idleMotionGroup: 'Idle',
          autoInteract: false, // Disable mouse tracking - avatar won't follow cursor
        })) as {
          internalModel?: { 
            coreModel?: { 
              setParamFloat?: (id: string | number, value: number) => void; 
              getParamIndex?: (id: string) => number;
            };
            motionManager?: {
              startRandomMotion?: (group: string, priority?: number) => Promise<unknown>;
            };
          };
          scale: { set: (x: number, y: number) => void };
          anchor: { set: (x: number, y: number) => void };
          x: number;
          y: number;
          motion?: (group: string, index?: number, priority?: number) => Promise<unknown>;
        };
        if (destroyed) return;

        // Start idle motion explicitly (try "Idle" then "" for models like Haru Greeter)
        try {
          if (typeof (live2dModel as any).motion === 'function') {
            try {
              console.log('[Live2D] Starting idle motion via motion(Idle)');
              await (live2dModel as any).motion('Idle', 0, 2);
            } catch {
              console.log('[Live2D] Idle group not found, trying default group ""');
              await (live2dModel as any).motion('', 0, 2);
            }
          } else if (live2dModel.internalModel?.motionManager?.startRandomMotion) {
            try {
              await live2dModel.internalModel.motionManager.startRandomMotion('Idle', 2);
            } catch {
              await live2dModel.internalModel.motionManager.startRandomMotion('', 2);
            }
          }

          // Set a natural default expression
          if (typeof (live2dModel as any).expression === 'function') {
            try {
              await (live2dModel as any).expression('exp_01'); // Default happy/neutral expression
              console.log('[Live2D] Default expression set');
            } catch {
              // Expression not available, that's fine
            }
          }
          
          // Ensure the model updates every frame; we'll add the ticker below after mouth params are ready
        } catch (e) {
          console.warn('[Live2D] Idle motion start failed:', e);
        }

        model = live2dModel;
        
        // Position and scale BEFORE adding to stage - bigger, fills more of the frame
        const w = (live2dModel as { width?: number }).width ?? size;
        const h = (live2dModel as { height?: number }).height ?? size;
        // Bigger scale for more prominent character display
        const fitScale = Math.min(size / w, size / h) || 1;
        const halfBodyScale = Math.min(fitScale * 2.4, 3.5);
        const scaleVal = Number.isFinite(halfBodyScale) ? halfBodyScale : 2;
        live2dModel.scale.set(scaleVal, scaleVal);
        live2dModel.anchor.set(0.5, 0.1); // Anchor slightly below top (0.15 instead of 0)
        live2dModel.x = size / 2;
        live2dModel.y = 0;
        
        // Add to stage so ticker updates the model
        application.stage.addChild(live2dModel as never);
        
        console.log('[Live2D] Model loaded and added to stage, idle motion should be playing');

        const internalModel = live2dModel.internalModel as
          | {
              coreModel?: {
                setParamFloat?: (id: string | number, value: number, weight?: number) => void;
                getParamIndex?: (id: string) => number;
                getParameterIndex?: (id: string) => number;
                setParameterValueById?: (id: string, value: number, weight?: number) => void;
                setParameterValueByIndex?: (index: number, value: number, weight?: number) => void;
              };
              lipSync?: boolean;
            }
          | undefined;
        if (internalModel && typeof internalModel.lipSync === 'boolean') {
          internalModel.lipSync = true;
        }
        const coreModel = internalModel?.coreModel;
        // Cubism 4 uses getParameterIndex; Cubism 2 uses getParamIndex
        const getParamIndexFn =
          typeof (coreModel as any)?.getParameterIndex === 'function'
            ? (coreModel as any).getParameterIndex.bind(coreModel)
            : typeof (coreModel as any)?.getParamIndex === 'function'
              ? (coreModel as any).getParamIndex.bind(coreModel)
              : null;

        const applyMouth = (paramId: string, paramIndex: number | null, value: number) => {
          if (!coreModel) return;
          const cm = coreModel as any;
          if (typeof cm.setParameterValueById === 'function') {
            cm.setParameterValueById(paramId, value, 1);
          } else if (paramIndex != null && typeof cm.setParameterValueByIndex === 'function') {
            cm.setParameterValueByIndex(paramIndex, value, 1);
          } else if (typeof cm.setParamFloat === 'function') {
            cm.setParamFloat(paramId, value, 1);
          }
        };

        // 5. Lip sync - resolve mouth params (Cubism 4: getParameterIndex)
        console.log('[Live2D] coreModel:', !!coreModel, 'getParameterIndex:', !!getParamIndexFn);
        const mouthParams: Array<{ id: string; index: number | null }> = [];
        if (getParamIndexFn) {
          for (const id of MOUTH_PARAM_IDS) {
            try {
              const idx = getParamIndexFn(id);
              if (typeof idx === 'number' && idx >= 0) {
                mouthParams.push({ id, index: idx });
              }
            } catch (e) {
              // ignore
            }
          }
        }
        if (mouthParams.length) {
          console.log(
            `[Live2D] Lip sync parameters: ${mouthParams.map((p) => `${p.id}(${p.index})`).join(', ')}`
          );
          // Tell motion manager which params we drive for lip sync so motions don't overwrite them
          const motionMgr = (live2dModel as any).internalModel?.motionManager;
          if (motionMgr && Array.isArray(motionMgr.lipSyncIds)) {
            motionMgr.lipSyncIds = mouthParams.map((p) => p.id);
          }
        } else {
          console.warn('[Live2D] No mouth param indices; applying by id only (ParamA, etc.)');
        }

        let analyserNode: AnalyserNode | null = null;
        let dataArray: Uint8Array | null = null;
        const currentTrack = audioTrackRef.current;
        if (currentTrack && coreModel) {
          try {
            console.log('[Live2D] Setting up audio-based lip sync...');
            const ctx = new AudioContext();
            audioContext = ctx;
            if (ctx.state === 'suspended') {
              ctx.resume().catch(() => undefined);
            }
            const source = ctx.createMediaStreamSource(new MediaStream([currentTrack]));
            streamSource = source;
            analyserNode = ctx.createAnalyser();
            analyserNode.fftSize = 512;
            analyserNode.smoothingTimeConstant = 0.4;
            source.connect(analyserNode);
            analyser = analyserNode;
            dataArray = new Uint8Array(analyserNode.frequencyBinCount);
            const timeDomainArray = new Uint8Array(analyserNode.fftSize);
            audioSetupRef.current = { audioContext: ctx, analyserNode, dataArray, timeDomainArray, streamSource: source };
            console.log('[Live2D] Audio context created, analyser connected');
          } catch (e) {
            console.warn('Live2D lip sync audio setup failed:', e);
          }
        }

        let frameCount = 0;
        let phase = 0;
        let lastSpeechTime = 0; // ms; keep mouth moving briefly after real audio
        const RECENT_SPEECH_MS = 220;

        // Single ticker: update model first, then set mouth params immediately after (same frame).
        // Cubism overwrites params during update; setting mouth after update ensures it's not overwritten before draw.
        const tickerFn = (deltaMS: number) => {
          if (destroyed) return;
          // 1) Update model (motions, expressions, physics)
          if (live2dModel && typeof (live2dModel as any).update === 'function') {
            (live2dModel as any).update(deltaMS * 2.5);
          }
          // 2) Immediately set mouth so nothing overwrites it before render
          const setup = audioSetupRef.current;
          const analyserNodeNow = setup?.analyserNode ?? analyserNode;
          const dataArrayNow = setup?.dataArray ?? dataArray;

          let target = 0;
          const setupFull = audioSetupRef.current;
          const timeDomainArrayNow = setupFull?.timeDomainArray;
          if (analyserNodeNow && dataArrayNow) {
            analyserNodeNow.getByteFrequencyData(dataArrayNow as Uint8Array<ArrayBuffer>);
            const speechStart = Math.floor(150 * dataArrayNow.length / (analyserNodeNow.context.sampleRate / 2));
            const speechEnd = Math.floor(3000 * dataArrayNow.length / (analyserNodeNow.context.sampleRate / 2));
            let sum = 0;
            for (let i = speechStart; i < speechEnd; i++) {
              sum += dataArrayNow[i];
            }
            const avg = (speechEnd - speechStart) > 0 ? sum / (speechEnd - speechStart) : 0;
            const freqTarget = Math.min(1, (avg / 255) * VOLUME_TO_MOUTH_SCALE);

            let timeTarget = 0;
            if (timeDomainArrayNow) {
              analyserNodeNow.getByteTimeDomainData(timeDomainArrayNow as Uint8Array<ArrayBuffer>);
              let peak = 0;
              for (let i = 0; i < timeDomainArrayNow.length; i++) {
                const v = Math.abs((timeDomainArrayNow[i] as number) - 128);
                if (v > peak) peak = v;
              }
              timeTarget = Math.min(1, (peak / 128) * VOLUME_TO_MOUTH_SCALE * 0.7);
            }
            target = Math.max(freqTarget, timeTarget);
            if (target > 0.08) lastSpeechTime = performance.now();
          }

          const now = performance.now();
          const recentlyHadSpeech = (now - lastSpeechTime) < RECENT_SPEECH_MS;
          const speaking = isSpeakingRef.current;
          const noAudioAwhile = (now - lastSpeechTime) > 500;

          if (speaking && target < 0.15) {
            phase += 0.22;
            const wave = Math.sin(phase) * 0.5 + 0.5;
            target = noAudioAwhile
              ? Math.max(target, wave * 0.12 + 0.05)
              : Math.max(target, wave * 0.4 + 0.12);
          }
          if (recentlyHadSpeech && target < 0.15 && mouthValue > 0.08) {
            target = Math.max(target, 0.15);
          }
          if (target > 0.08) {
            target = target * (0.9 + Math.random() * 0.2);
          }

          const smoothing = target > mouthValue ? 0.6 : 0.35;
          mouthValue += (target - mouthValue) * smoothing;
          const appliedValue = Math.min(MOUTH_CAP, mouthValue * MOUTH_EXAGGERATION);

          frameCount++;
          if (mouthParams.length) {
            for (const p of mouthParams) {
              applyMouth(p.id, p.index, appliedValue);
            }
          } else {
            for (const id of MOUTH_PARAM_IDS) {
              applyMouth(id, null, appliedValue);
            }
          }
          if (frameCount % 60 === 0 && coreModel && mouthParams.length > 0) {
            try {
              const cm = coreModel as any;
              const read = typeof cm.getParameterValueById === 'function'
                ? cm.getParameterValueById(mouthParams[0].id)
                : null;
              console.log(`[Live2D] Mouth target=${target.toFixed(2)} value=${mouthValue.toFixed(2)} readback=${read}`);
            } catch (_) {}
          }
        };
        updateTickerFn = tickerFn;
        mouthTickerFn = tickerFn;
        // Run with high priority so we run after any library ticker (mouth set right before render)
        application.ticker.add(tickerFn as any, { priority: 100 });

        setReady(true);
        setError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setReady(false);
      }
    }

    init();

    return () => {
      destroyed = true;
      initializingRef.current = false;
      const setup = audioSetupRef.current;
      if (setup) {
        try {
          setup.streamSource?.disconnect();
        } catch (_) {}
        if (setup.audioContext.state !== 'closed') setup.audioContext.close();
        audioSetupRef.current = null;
      }
      console.log('[Live2D] Cleanup starting');
      
      // Stop ticker (single combined update + mouth callback)
      if (app && typeof (app as any).ticker?.remove === 'function' && updateTickerFn) {
        (app as any).ticker.remove(updateTickerFn);
      }
      
      if (rafId) cancelAnimationFrame(rafId);
      // streamSource/audioContext are same as setup above when init created them; no double-close
      // Remove canvas from DOM before destroying app (v6 uses .view)
      const appWithView = app as { view?: HTMLCanvasElement | null } | null;
      const canvas = appWithView?.view ?? (app as { canvas?: HTMLCanvasElement | null })?.canvas;
      if (containerRef.current && canvas && canvas.parentNode === containerRef.current) {
        try {
          containerRef.current.removeChild(canvas);
        } catch {
          // ignore if already removed
        }
      }
      if (model && app && typeof (app as { stage: { removeChild?: (m: unknown) => void } }).stage?.removeChild === 'function') {
        try {
          (app as { stage: { removeChild: (m: unknown) => void } }).stage.removeChild(model as never);
        } catch {
          // ignore
        }
      }
      if (model && typeof (model as { destroy?: (opts?: { children?: boolean }) => void }).destroy === 'function') {
        try {
          (model as { destroy: (opts?: { children?: boolean }) => void }).destroy({ children: true });
        } catch {
          // ignore
        }
      }
      if (app && typeof (app as { destroy?: (opts?: { removeView?: boolean }) => void }).destroy === 'function') {
        try {
          (app as { destroy: (opts?: { removeView?: boolean }) => void }).destroy({ removeView: true });
        } catch {
          // ignore
        }
      }
    };
    // Do NOT depend on audioTrack: reconnecting when track changes is done in a separate effect.
  }, [modelUrl, size]);

  // Reconnect analyser when track changes, or do initial setup when track appears after init
  useEffect(() => {
    const track = audioTrack?.mediaStreamTrack ?? null;
    if (!track) {
      const setup = audioSetupRef.current;
      if (setup?.streamSource) {
        try {
          setup.streamSource.disconnect();
        } catch (_) {}
        setup.streamSource = null;
      }
      return;
    }

    let setup = audioSetupRef.current;
    if (!setup) {
      try {
        const ctx = new AudioContext();
        if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 512;
        analyserNode.smoothingTimeConstant = 0.4;
        source.connect(analyserNode);
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        const timeDomainArray = new Uint8Array(analyserNode.fftSize);
        audioSetupRef.current = {
          audioContext: ctx,
          analyserNode,
          dataArray,
          timeDomainArray,
          streamSource: source,
        };
        console.log('[Live2D] Audio setup created (track appeared after init)');
      } catch (e) {
        console.warn('[Live2D] Audio setup failed:', e);
      }
      return () => {
        const s = audioSetupRef.current;
        if (s?.streamSource) {
          try {
            s.streamSource.disconnect();
          } catch (_) {}
        }
      };
    }

    if (setup.streamSource) {
      try {
        setup.streamSource.disconnect();
      } catch (_) {}
    }
    const newSource = setup.audioContext.createMediaStreamSource(new MediaStream([track]));
    newSource.connect(setup.analyserNode);
    setup.streamSource = newSource;
    console.log('[Live2D] Audio source reconnected to new track');
    return () => {
      try {
        newSource.disconnect();
      } catch (_) {}
    };
  }, [audioTrack?.mediaStreamTrack]);

  if (!modelUrl) return null;

  return (
    <div
      ref={containerRef}
      className={cn('relative overflow-hidden bg-black/40', className)}
      style={{ width: size, height: size }}
    >
      {error && fallbackImageUrl ? (
        /* Fallback image when Live2D fails (e.g. Cubism Core missing) so avatar area is never empty */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={fallbackImageUrl}
          alt="Avatar"
          className="absolute inset-0 w-full h-full object-contain"
        />
      ) : error ? (
        <div className="absolute inset-0 flex items-center justify-center border border-amber-500/50 bg-black/60 p-2 text-center text-xs text-amber-200">
          Live2D load failed. Add Cubism Core to public/.
        </div>
      ) : null}
    </div>
  );
}
