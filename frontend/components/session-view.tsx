'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  type AgentState,
  type ReceivedChatMessage,
  useRoomContext,
  useVoiceAssistant,
} from '@livekit/components-react';
import { toastAlert } from '@/components/alert-toast';
import { AgentControlBar } from '@/components/livekit/agent-control-bar/agent-control-bar';
import { ChatEntry } from '@/components/livekit/chat/chat-entry';
import { ChatMessageView } from '@/components/livekit/chat/chat-message-view';
import { MediaTiles } from '@/components/livekit/media-tiles';
import useChatAndTranscription from '@/hooks/useChatAndTranscription';
import { useDebugMode } from '@/hooks/useDebug';
import type { AppConfig } from '@/lib/types';
import { cn } from '@/lib/utils';

function isAgentAvailable(agentState: AgentState) {
  return agentState == 'listening' || agentState == 'thinking' || agentState == 'speaking';
}

interface SessionViewProps {
  appConfig: AppConfig;
  disabled: boolean;
  sessionStarted: boolean;
}

export const SessionView = ({
  appConfig,
  disabled,
  sessionStarted,
  ref,
}: React.ComponentProps<'div'> & SessionViewProps) => {
  const { state: agentState } = useVoiceAssistant();
  const [chatOpen, setChatOpen] = useState(true); // always show chat
  const { messages, send } = useChatAndTranscription();
  const room = useRoomContext();

  useDebugMode({
    enabled: process.env.NODE_END !== 'production',
  });

  async function handleSendMessage(message: string) {
    await send(message);
  }

  useEffect(() => {
    if (sessionStarted) {
      // Increased timeout to 60 seconds to allow for agent initialization
      // Agent needs time to connect, initialize TTS, and start session
      const timeout = setTimeout(() => {
        if (!isAgentAvailable(agentState)) {
          const reason =
            agentState === 'connecting'
              ? 'ルウルが接続できませんでした。しばらく待ってから、もう一度お試しください。'
              : 'ルウルが接続しましたが、初期化が完了しませんでした。もう一度お試しください。';

          toastAlert({
            title: 'ルウルとの接続が切れました',
            description: (
              <div className="space-y-2">
                <p className="text-gray-300">
                  {reason}
                </p>
                <p className="text-gray-400 text-xs">
                  問題が続く場合は、
                  <a
                    target="_blank"
                    rel="noopener noreferrer"
                    href="https://docs.livekit.io/agents/start/voice-ai/"
                    className="text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors mx-1"
                  >
                    クイックスタートガイド
                  </a>
                  をご確認ください。
                </p>
              </div>
            ),
          });
          room.disconnect();
        }
      }, 60_000); // Increased from 20 seconds to 60 seconds

      return () => clearTimeout(timeout);
    }
  }, [agentState, sessionStarted, room]);

  const { supportsChatInput, supportsVideoInput, supportsScreenShare } = appConfig;
  const capabilities = {
    supportsChatInput,
    supportsVideoInput,
    supportsScreenShare,
  };

  return (
    <section
      ref={ref}
      inert={disabled}
      className={cn(
        'opacity-100 h-full w-full min-h-[100dvh] max-w-[100vw]',
        // prevent page scrollbar when !chatOpen due to 'translate-y-20'
        !chatOpen && 'max-h-[100dvh] overflow-hidden'
      )}
    >

      <div className="bg-black mp-12 fixed top-0 right-0 left-0 h-24 sm:h-28 md:h-36 safe-area-top safe-area-x">
        {/* skrim */}
        <div className="from-background absolute bottom-0 left-0 h-8 sm:h-12 w-full translate-y-full bg-black" />
      </div>


      <MediaTiles appConfig={appConfig} chatOpen={chatOpen} messages={messages} room={room} />

      {/* Bottom control bar - same horizontal padding as caption/history at all breakpoints */}
      <div
        className={cn(
          'fixed right-0 bottom-0 left-0 z-50',
          'px-3 pt-3 pb-3 sm:px-4 sm:pt-4 sm:pb-4 md:px-6 md:pb-6 lg:px-8 lg:pb-8 xl:px-10 xl:pb-10',
          'bg-gradient-to-t from-black/95 via-black/90 to-transparent safe-area-bottom safe-area-x'
        )}
      >
        <motion.div
          key="control-bar"
          initial={{ opacity: 0, translateY: '100%' }}
          animate={{
            opacity: sessionStarted ? 1 : 0,
            translateY: sessionStarted ? '0%' : '100%',
          }}
          transition={{ duration: 0.3, delay: sessionStarted ? 0.5 : 0, ease: 'easeOut' }}
        >
          <div className="relative z-10 mx-auto w-full max-w-3xl min-w-0">
            <AgentControlBar
              capabilities={capabilities}
              controls={{ chat: true, microphone: true, leave: true }}
              chatOpen={true}
              onChatOpenChange={setChatOpen}
              onSendMessage={handleSendMessage}
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
};
