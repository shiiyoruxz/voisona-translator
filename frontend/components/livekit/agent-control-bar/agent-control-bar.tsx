'use client';

import * as React from 'react';
import { useCallback } from 'react';
import { Track } from 'livekit-client';
import { BarVisualizer, useRemoteParticipants } from '@livekit/components-react';
import { PhoneDisconnectIcon } from '@phosphor-icons/react/dist/ssr';
import { ChatInput } from '@/components/livekit/chat/chat-input';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { AppConfig } from '@/lib/types';
import { cn } from '@/lib/utils';
import { DeviceSelect } from '../device-select';
import { TrackToggle } from '../track-toggle';
import { UseAgentControlBarProps, useAgentControlBar } from './hooks/use-agent-control-bar';

export interface AgentControlBarProps
  extends React.HTMLAttributes<HTMLDivElement>,
  UseAgentControlBarProps {
  capabilities: Pick<AppConfig, 'supportsChatInput' | 'supportsVideoInput' | 'supportsScreenShare'>;
  chatOpen?: boolean;
  onChatOpenChange?: (open: boolean) => void;
  onSendMessage?: (message: string) => Promise<void>;
  onDisconnect?: () => void;
  onDeviceError?: (error: { source: Track.Source; error: Error }) => void;
}

/**
 * A control bar specifically designed for voice assistant interfaces
 */
export function AgentControlBar({
  controls,
  saveUserChoices = true,
  capabilities,
  className,
  chatOpen: externalChatOpen,
  onSendMessage,
  onChatOpenChange,
  onDisconnect,
  onDeviceError,
  ...props
}: AgentControlBarProps) {
  const participants = useRemoteParticipants();
  const [isSendingMessage, setIsSendingMessage] = React.useState(false);

  // Chat is always open - no toggle needed
  const chatOpen = true;

  const isAgentAvailable = participants.some((p) => p.isAgent);
  const isInputDisabled = !isAgentAvailable || isSendingMessage;

  const [isDisconnecting, setIsDisconnecting] = React.useState(false);

  const {
    micTrackRef,
    visibleControls,
    cameraToggle,
    microphoneToggle,
    screenShareToggle,
    handleAudioDeviceChange,
    handleVideoDeviceChange,
    handleDisconnect,
  } = useAgentControlBar({
    controls,
    saveUserChoices,
  });

  const handleSendMessage = async (message: string) => {
    setIsSendingMessage(true);
    try {
      await onSendMessage?.(message);
    } finally {
      setIsSendingMessage(false);
    }
  };

  const onLeave = async () => {
    setIsDisconnecting(true);
    await handleDisconnect();
    setIsDisconnecting(false);
    onDisconnect?.();
  };

  // Chat is always open, notify parent if needed
  React.useEffect(() => {
    onChatOpenChange?.(true);
  }, [onChatOpenChange]);

  const onMicrophoneDeviceSelectError = useCallback(
    (error: Error) => {
      onDeviceError?.({ source: Track.Source.Microphone, error });
    },
    [onDeviceError]
  );
  const onCameraDeviceSelectError = useCallback(
    (error: Error) => {
      onDeviceError?.({ source: Track.Source.Camera, error });
    },
    [onDeviceError]
  );

  return (
    <div
      aria-label="Voice assistant controls"
      className={cn(
        'flex flex-col rounded-xl sm:rounded-2xl',
        'bg-gradient-to-br from-gray-900/98 via-black/95 to-gray-900/98',
        'backdrop-blur-xl border border-gray-600/40',
        'shadow-2xl shadow-black/50',
        'p-3 sm:p-4 gap-2 sm:gap-3',
        'min-h-0 w-full',
        'transition-all duration-300',
        className
      )}
      {...props}
    >
      {capabilities.supportsChatInput && (
        <div className="w-full min-w-0">
          <ChatInput onSend={handleSendMessage} disabled={isInputDisabled} className="w-full" />
          <div className="h-px bg-gradient-to-r from-transparent via-gray-600/50 to-transparent mt-2 sm:mt-3 mb-1" />
        </div>
      )}

      <div className="flex flex-row justify-between items-center gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {visibleControls.microphone && (
            <div className="flex items-center gap-0 rounded-lg sm:rounded-xl overflow-hidden bg-gray-800/50 border border-gray-700/50">
              <TrackToggle
                variant="primary"
                source={Track.Source.Microphone}
                // Mic is always muted: keep the icon, but disable interaction
                pressed={false}
                disabled={true}
                onPressedChange={() => {}}
                className="peer/track group/track relative w-auto min-h-[44px] min-w-[44px] px-3 sm:px-4 py-2.5 sm:py-3 rounded-l-lg sm:rounded-l-xl rounded-r-none border-r border-gray-700/50 bg-gray-800/30 hover:bg-gray-700/30 transition-colors touch-manipulation"
              >
                <BarVisualizer
                  barCount={3}
                  trackRef={micTrackRef}
                  options={{ minHeight: 5 }}
                  className="flex h-full w-auto items-center justify-center gap-1"
                >
                  <span
                    className={cn([
                      'h-full w-1 origin-center rounded-full',
                      'group-data-[state=on]/track:bg-sky-400 group-data-[state=off]/track:bg-red-400/60',
                      'data-lk-muted:bg-gray-500',
                    ])}
                  ></span>
                </BarVisualizer>
              </TrackToggle>
              <DeviceSelect
                size="sm"
                kind="audioinput"
                requestPermissions={false}
                onMediaDeviceError={onMicrophoneDeviceSelectError}
                onActiveDeviceChange={handleAudioDeviceChange}
                className={cn([
                  'px-3 py-2 rounded-r-xl',
                  'bg-gray-800/30 hover:bg-gray-700/30',
                  'text-gray-300 hover:text-white',
                  'border-0',
                  'peer-data-[state=off]/track:text-red-400/80',
                  'transition-colors',
                  'hidden rounded-l-none md:flex',
                ])}
              />
            </div>
          )}

          {/* Chat toggle button removed - chat input is always visible */}
        </div>
        
        {/* Leave button - touch-friendly min 44px */}
        {visibleControls.leave && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onLeave}
            disabled={isDisconnecting}
            className={cn(
              'text-gray-400 hover:text-red-400',
              'hover:bg-red-500/10 rounded-lg sm:rounded-xl',
              'min-h-[44px] min-w-[44px] aspect-square px-3 sm:px-4 py-2.5 sm:py-3',
              'border border-gray-700/50 hover:border-red-500/50',
              'transition-all duration-200 touch-manipulation',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Leave room"
          >
            <PhoneDisconnectIcon weight="bold" className="w-5 h-5 shrink-0" />
          </Button>
        )}
      </div>
    </div>
  );
}
