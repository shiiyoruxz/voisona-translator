'use client';

import { useEffect, useMemo, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { motion } from 'motion/react';
import { RoomAudioRenderer, RoomContext, StartAudio } from '@livekit/components-react';
import { toastAlert } from '@/components/alert-toast';
import { SessionView } from '@/components/session-view';
import { Toaster } from '@/components/ui/sonner';
import { Welcome } from '@/components/welcome';
import useConnectionDetails from '@/hooks/useConnectionDetails';
// import { useVideoDetection } from '@/hooks/useVideoDetection';
// import type { TrackingState } from '@/lib/detection-types';
import type { AppConfig } from '@/lib/types';

const MotionWelcome = motion.create(Welcome);
const MotionSessionView = motion.create(SessionView);

interface AppProps {
  appConfig: AppConfig;
}

export function App({ appConfig }: AppProps) {
  const room = useMemo(() => new Room(), []);
  const [sessionStarted, setSessionStarted] = useState(true); // Start directly in session mode
  // const [showWelcome, setShowWelcome] = useState(false);
  const { refreshConnectionDetails, existingOrRefreshConnectionDetails } =
    useConnectionDetails(appConfig);

  // // Video detection hook
  // const {
  //   loading,
  //   model,
  //   trackingState,
  //   showCamera,
  //   cameraInitialized,
  //   webcamRef,
  //   canvasRef,
  //   toggleCamera,
  //   handleVideoPlay,
  // } = useVideoDetection({
  //   onTrackingStateChange: (state: TrackingState) => {
  //     // Show welcome when person is detected (avatar state)
  //     setShowWelcome(state === 'avatar');

  //     // Auto-start session when person is detected
  //     if (state === 'avatar' && !sessionStarted) {
  //       setSessionStarted(true);
  //     }

  //     // Auto-end session when person is no longer detected (back to video state)
  //     if (state === 'video' && sessionStarted) {
  //       setSessionStarted(false);
  //     }
  //   },
  // });

  useEffect(() => {
    const onDisconnected = () => {
      // Don't automatically set sessionStarted to false - keep session active
      // setSessionStarted(false);
      refreshConnectionDetails();
    };
    const onMediaDevicesError = (error: Error) => {
      toastAlert({
        title: 'メディアデバイスのエラー',
        description: (
          <div className="space-y-1">
            <p className="text-gray-300">{error.name}</p>
            <p className="text-gray-400 text-xs">{error.message}</p>
          </div>
        ),
      });
    };
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
    };
  }, [room, refreshConnectionDetails]);

  useEffect(() => {
    let aborted = false;
    if (sessionStarted && room.state === 'disconnected') {
      Promise.all([
        room.localParticipant.setMicrophoneEnabled(true, undefined, {
          preConnectBuffer: appConfig.isPreConnectBufferEnabled,
        }),
        existingOrRefreshConnectionDetails().then((connectionDetails) =>
          room.connect(connectionDetails.serverUrl, connectionDetails.participantToken)
        ),
      ]).catch((error) => {
        if (aborted) {
          // Once the effect has cleaned up after itself, drop any errors
          //
          // These errors are likely caused by this effect rerunning rapidly,
          // resulting in a previous run `disconnect` running in parallel with
          // a current run `connect`
          return;
        }

        toastAlert({
          title: 'ルウルへの接続に失敗しました',
          description: (
            <div className="space-y-1">
              <p className="text-gray-300">
                接続中にエラーが発生しました。もう一度お試しください。
              </p>
              <p className="text-gray-400 text-xs font-mono">
                {error.name}: {error.message}
              </p>
            </div>
          ),
        });
      });
    }
    return () => {
      aborted = true;
      // Don't disconnect the room on cleanup - let it stay connected
      // room.disconnect();
    };
  }, [
    room,
    sessionStarted,
    appConfig.isPreConnectBufferEnabled,
    existingOrRefreshConnectionDetails,
  ]);

  const { startButtonText } = appConfig;

  return (
    <main className="relative min-h-[100dvh] h-screen w-full max-w-[100vw] overflow-x-hidden bg-black">
      {/* <main className={`relative h-screen w-screen transition-colors duration-500 ${trackingState === 'avatar' ? 'bg-black' : 'bg-white'
       }`}> */}
      {/* Background Video - Hidden when person is detected */}
      {/* <video
        autoPlay
        muted
        playsInline
        loop
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ease-in-out ${trackingState === 'avatar' ? 'opacity-0' : 'opacity-100'
          }`}
        src="https://pub-72d8ec22eb404760a46c9ab23ca74458.r2.dev/Untitled%20(2).mp4"
      /> */}

      {/* Welcome Component - shown when person is detected */}
      {/* <MotionWelcome
        key="welcome"
        startButtonText={startButtonText}
        onStartCall={() => setSessionStarted(true)}
        disabled={sessionStarted}
        initial={{ opacity: 0 }}
        animate={{ opacity: sessionStarted ? 0 : 1 }}
        transition={{ duration: 0.5, ease: 'linear' }}
      /> */}

      {/* LiveKit Room Context */}
      <div
        className={`absolute inset-0 transition-opacity duration-500 ease-in-out ${sessionStarted ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
      >
        <RoomContext.Provider value={room}>
          <RoomAudioRenderer />
          <StartAudio label="Start Audio" />
          <MotionSessionView
            key="session-view"
            appConfig={appConfig}
            disabled={false}
            sessionStarted={sessionStarted}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              duration: 0.3,
              ease: 'easeOut',
            }}
          />
        </RoomContext.Provider>
      </div>

      {/* Video Detection Controls */}
      {/* <div className="absolute bottom-0 left-0 z-30 p-4">
        <button
          className="rounded-2xl bg-amber-300 px-4 py-2 transition-colors hover:bg-amber-400"
          onClick={toggleCamera}
        >
          {showCamera ? 'Hide Camera' : 'Show Camera'}
        </button>
        <p className="mt-2 text-sm text-white">
          Status: {trackingState} {cameraInitialized ? '(Camera Ready)' : '(Initializing...)'}
        </p>
      </div> */}

      {/* Loading indicator */}
      {/* {(trackingState === 'loading' || !cameraInitialized) && (
        <div className="bg-opacity-50 absolute top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 transform rounded-lg bg-black px-6 py-4 text-white">
          <div className="flex items-center space-x-3">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-white"></div>
            <span>{!cameraInitialized ? 'Initializing Camera...' : 'Loading Avatar...'}</span>
          </div>
        </div>
      )} */}

      {/* Camera Feed - Always rendered for detection, visibility controlled by showCamera and sessionStarted */}
      {/* <div
        className={`absolute top-0 right-0 z-20 ${!showCamera || sessionStarted ? 'pointer-events-none opacity-0' : ''}`}
      >
        {!loading.loading && model.net ? (
          <div className="relative">
            <video
              ref={webcamRef}
              autoPlay
              muted
              playsInline
              onPlay={handleVideoPlay}
              className="h-48 w-64 rounded-lg object-cover"
            />
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 h-full w-full"
              width={model.inputShape[1]}
              height={model.inputShape[2]}
            />
          </div>
        ) : (
          <div className="flex h-48 w-64 items-center justify-center rounded-lg bg-gray-800 text-white">
            {loading.loading
              ? `Loading model... ${Math.round(loading.progress * 100)}%`
              : 'Model failed to load'}
          </div>
        )}
      </div> */}

      <Toaster />
    </main>
  );
}
