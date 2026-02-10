import React, { useMemo, useState } from 'react';
import { Track } from 'livekit-client';
import { AnimatePresence, motion } from 'motion/react';
import {
  type TrackReference,
  type ReceivedChatMessage,
  useLocalParticipant,
  useTracks,
  useVoiceAssistant,
  useRoomContext,
} from '@livekit/components-react';
import { CaretDown, CaretUp, X } from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';
import type { AppConfig } from '@/lib/types';
import { AgentTile } from './agent-tile';
import { AvatarTile } from './avatar-tile';
import { Live2DAvatar } from './live2d-avatar';
import { VideoTile } from './video-tile';

const MotionVideoTile = motion.create(VideoTile);
const MotionAgentTile = motion.create(AgentTile);
const MotionAvatarTile = motion.create(AvatarTile);

const animationProps = {
  initial: {
    opacity: 0,
    scale: 0,
  },
  animate: {
    opacity: 1,
    scale: 1,
  },
  exit: {
    opacity: 0,
    scale: 0,
  },
  transition: {
    type: 'spring',
    stiffness: 675,
    damping: 75,
    mass: 1,
  },
};

const classNames = {
  // GRID
  // 2 Columns x 3 Rows
  grid: [
    'h-full w-full',
    'grid gap-x-2 place-content-center',
    'grid-cols-[1fr_1fr] grid-rows-[90px_1fr_90px]',
  ],
  // Agent
  // chatOpen: true,
  // hasSecondTile: true
  // layout: Column 1 / Row 1
  // align: x-end y-center
  agentChatOpenWithSecondTile: ['col-start-1 row-start-1', 'self-center justify-self-end'],
  // Agent
  // chatOpen: true,
  // hasSecondTile: false
  // layout: Column 1 / Row 1 / Column-Span 2
  // align: x-center y-center
  agentChatOpenWithoutSecondTile: ['col-start-1 row-start-1', 'col-span-2', 'place-content-center'],
  // Agent
  // chatOpen: false
  // layout: Column 1 / Row 1 / Column-Span 2 / Row-Span 3
  // align: x-center y-center
  agentChatClosed: ['col-start-1 row-start-1', 'col-span-2 row-span-3', 'place-content-center'],
  // Second tile
  // chatOpen: true,
  // hasSecondTile: true
  // layout: Column 2 / Row 1
  // align: x-start y-center
  secondTileChatOpen: ['col-start-2 row-start-1', 'self-center justify-self-start'],
  // Second tile
  // chatOpen: false,
  // hasSecondTile: false
  // layout: Column 2 / Row 2
  // align: x-end y-end
  secondTileChatClosed: ['col-start-2 row-start-3', 'place-content-end'],
};

interface MediaTilesProps {
  appConfig?: AppConfig;
  chatOpen: boolean;
  messages?: ReceivedChatMessage[];
  room?: any;
}

export function useLocalTrackRef(source: Track.Source) {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(source);
  const trackRef = useMemo<TrackReference | undefined>(
    () => (publication ? { source, participant: localParticipant, publication } : undefined),
    [source, publication, localParticipant]
  );
  return trackRef;
}

interface CaptionContentProps {
  messages?: ReceivedChatMessage[];
  room?: any;
  isMinimized?: boolean;
  onToggleMinimize?: () => void;
}

/**
 * Parse translations from message text
 * Expected format: JP:text\n\nEN:text\n\n中文:text
 */
function parseTranslations(message: string): { japanese: string; english: string | null; chinese: string | null } {
  let japanese: string = '';
  let english: string | null = null;
  let chinese: string | null = null;
  
  if (!message || !message.trim()) {
    return { japanese: '', english: null, chinese: null };
  }
  
  // Method 1: Split by double newlines (format: JP:text\n\nEN:text\n\n中文:text or subsets)
  const doubleNewlineParts = message.split(/\n\s*\n/);
  if (doubleNewlineParts.length >= 1) {
    for (const part of doubleNewlineParts) {
      const trimmed = part.trim();
      if (trimmed.startsWith('JP:') && !japanese) {
        japanese = trimmed.substring(3).trim();
      } else if ((trimmed.startsWith('EN:') || trimmed.startsWith('en:')) && !english) {
        english = trimmed.substring(3).trim();
      } else if ((trimmed.startsWith('中文:') || trimmed.startsWith('CN:') || trimmed.startsWith('cn:')) && !chinese) {
        chinese = trimmed.substring(trimmed.indexOf(':') + 1).trim();
      }
    }
  }
  
  // Method 2: Try regex with double newline separator
  if (!japanese || !english || !chinese) {
    const jpRegex = /(?:^|\n)\s*JP:\s*([\s\S]*?)(?:\n\s*\n\s*EN:|$)/i;
    const enRegex = /(?:^|\n)\s*EN:\s*([\s\S]*?)(?:\n\s*\n\s*中文:|$)/i;
    const zhRegex = /(?:^|\n)\s*中文:\s*([\s\S]*?)$/i;
    
    const jpMatch = message.match(jpRegex);
    const enMatch = message.match(enRegex);
    const zhMatch = message.match(zhRegex);
    
    if (jpMatch && !japanese) japanese = jpMatch[1].trim();
    if (enMatch && !english) english = enMatch[1].trim();
    if (zhMatch && !chinese) chinese = zhMatch[1].trim();
  }
  
  // Method 3: Split by single newline and check each line
  if (!japanese || !english || !chinese) {
    const lines = message.split(/\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('JP:') && !japanese) {
        japanese = trimmed.substring(3).trim();
      } else if (trimmed.startsWith('EN:') && !english) {
        english = trimmed.substring(3).trim();
      } else if (trimmed.startsWith('中文:') && !chinese) {
        chinese = trimmed.substring(3).trim();
      }
    }
  }
  
  // Method 4: Try bracket format [JP: ...] [EN: ...] [中文: ...]
  if (!japanese || !english || !chinese) {
    const jpMatch = message.match(/\[JP:\s*([^\]]+)\]/i);
    const enMatch = message.match(/\[EN:\s*([^\]]+)\]/i);
    const zhMatch = message.match(/\[中文:\s*([^\]]+)\]/i);
    
    if (jpMatch && !japanese) japanese = jpMatch[1].trim();
    if (enMatch && !english) english = enMatch[1].trim();
    if (zhMatch && !chinese) chinese = zhMatch[1].trim();
  }
  
  // Method 5: More permissive regex - capture everything until next marker
  if (!japanese || !english || !chinese) {
    const jpPermissive = message.match(/JP:\s*([\s\S]*?)(?:\n\s*(?:EN:|中文:)|$)/i);
    const enPermissive = message.match(/EN:\s*([\s\S]*?)(?:\n\s*(?:JP:|中文:)|$)/i);
    const zhPermissive = message.match(/中文:\s*([\s\S]*?)(?:\n\s*(?:JP:|EN:)|$)/i);
    
    if (jpPermissive && !japanese) japanese = jpPermissive[1].trim();
    if (enPermissive && !english) english = enPermissive[1].trim();
    if (zhPermissive && !chinese) chinese = zhPermissive[1].trim();
  }
  
  // Method 6: Support "CN:" as alias for 中文:
  if (!chinese && message.match(/CN:\s*/i)) {
    const cnMatch = message.match(/CN:\s*([\s\S]*?)(?:\n\s*(?:JP:|EN:)|$)/i);
    if (cnMatch) chinese = cnMatch[1].trim();
  }

  // Fallback: if no markers found, treat entire message as Japanese (strip JP: prefix if present)
  if (!japanese && !english && !chinese) {
    const trimmed = message.trim();
    japanese = trimmed.replace(/^JP:\s*/i, '').trim() || trimmed;
  }
  // If we have JP prefix in message but japanese wasn't set by other methods, strip it
  if (japanese && japanese.startsWith('JP:')) {
    japanese = japanese.replace(/^JP:\s*/i, '').trim();
  }

  return {
    japanese: japanese || '',
    english: english || null,
    chinese: chinese || null,
  };
}

function CaptionContent({ messages, room, isMinimized, onToggleMinimize }: CaptionContentProps & { isMinimized: boolean; onToggleMinimize: () => void }) {
  // Use the same "current" agent message as history: last agent message by timestamp (so caption and history show same text)
  const lastAgentMessage =
    messages && messages.length > 0
      ? [...messages]
          .filter((m) => m.from?.identity !== room?.localParticipant?.identity)
          .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
          .pop() ?? null
      : null;
  const lastMessage = lastAgentMessage ?? (messages && messages.length > 0 ? messages[messages.length - 1] : null);
  const isAgentMessage = lastMessage?.from?.identity !== room?.localParticipant?.identity;
  const messageText = isAgentMessage ? lastMessage?.message : null;

  const { japanese } = messageText
    ? parseTranslations(messageText)
    : { japanese: '' };

    if (isMinimized) {
      return (
        <div className="flex items-center gap-2 text-white/80 text-xs sm:text-sm">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-lg hover:bg-white/10 transition-colors touch-manipulation"
            aria-label="Expand caption"
          >
            <CaretUp weight="bold" className="w-4 h-4" />
          </button>
          <span className="truncate max-w-[120px] sm:max-w-[200px]">
            {japanese || messageText || 'ルウルが待機中...'}
          </span>
        </div>
      );
    }

    return (
      <div className="space-y-3 relative">
        {/* Minimize button - Fixed position */}
        <div className="absolute top-0 right-0 z-10">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-lg hover:bg-white/10 transition-colors text-white/60 hover:text-white backdrop-blur-sm touch-manipulation"
            aria-label="Minimize caption"
          >
            <CaretDown weight="bold" className="w-4 h-4" />
          </button>
        </div>

        {/* Caption content - Music style (no background, smaller text with shadow) - Show all languages together */}
        <div className="space-y-3">
          {messages && messages.length > 0 ? (
            <>
              {isAgentMessage ? (
                <>
                  {/* Live caption: Japanese only. EN/CN shown in history only. */}
                  <div className="space-y-2 sm:space-y-3">
                    {japanese && (
                      <div
                        className="text-base sm:text-xl md:text-2xl lg:text-3xl font-bold leading-relaxed text-white break-words"
                        style={{
                          textShadow: '0 2px 10px rgba(0,0,0,0.9), 0 4px 20px rgba(0,0,0,0.7), 0 0 30px rgba(0,0,0,0.5)',
                          WebkitTextStroke: '1px rgba(0,0,0,0.3)',
                        }}
                      >
                        {japanese}
                      </div>
                    )}
                    {!japanese && (
                      <div
                        className="text-base sm:text-xl md:text-2xl lg:text-3xl font-bold leading-relaxed text-white break-words"
                        style={{
                          textShadow: '0 2px 10px rgba(0,0,0,0.9), 0 4px 20px rgba(0,0,0,0.7), 0 0 30px rgba(0,0,0,0.5)',
                          WebkitTextStroke: '1px rgba(0,0,0,0.3)',
                        }}
                      >
                        {messageText || ''}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-white/70 italic text-base md:text-lg">
                  <div className="w-2 h-2 rounded-full bg-white/50 animate-pulse" />
                  <span>ルウルが聞いています…</span>
                </div>
              )}
            </>
          ) : (
            <div
              className="text-white/70 text-base md:text-lg"
              style={{
                textShadow: '0 1px 5px rgba(0,0,0,0.8)',
              }}
            >
              ルウルが待機中です。話しかけるか、テキストを入力してみてね。
            </div>
          )}
        </div>
      </div>
    );
}

export function MediaTiles({ appConfig, chatOpen, messages = [], room }: MediaTilesProps) {
    const {
      state: agentState,
      audioTrack: agentAudioTrack,
      videoTrack: agentVideoTrack,
    } = useVoiceAssistant();
    const [screenShareTrack] = useTracks([Track.Source.ScreenShare]);
    const cameraTrack: TrackReference | undefined = useLocalTrackRef(Track.Source.Camera);

    const isCameraEnabled = cameraTrack && !cameraTrack.publication.isMuted;
    const isScreenShareEnabled = screenShareTrack && !screenShareTrack.publication.isMuted;
    const hasSecondTile = isCameraEnabled || isScreenShareEnabled;
    const isSpeaking = agentState === 'speaking';

    // Determine agent connection status
    const isAgentConnected = agentState === 'listening' || agentState === 'thinking' || agentState === 'speaking';
    const isAgentConnecting = agentState === 'connecting';
    const isAgentDisconnected = !agentState || (agentState !== 'connecting' && !isAgentConnected);

    // Separate user and agent messages
    const userMessages = useMemo(() => {
      return messages.filter(msg => msg.from?.identity === room?.localParticipant?.identity);
    }, [messages, room]);

    const agentMessages = useMemo(() => {
      return messages.filter(msg => msg.from?.identity !== room?.localParticipant?.identity);
    }, [messages, room]);

    // Combined message history (both user and agent) sorted by timestamp
    const allMessages = useMemo(() => {
      return [...messages].sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB;
      });
    }, [messages]);

    // State for minimize/hide panels
    const [captionMinimized, setCaptionMinimized] = useState(false);
    const [historyMinimized, setHistoryMinimized] = useState(false);
    const [historyHidden, setHistoryHidden] = useState(false);

    const transition = {
      ...animationProps.transition,
      delay: chatOpen ? 0 : 0.15, // delay on close
    };
    const agentAnimate = {
      ...animationProps.animate,
      scale: chatOpen ? 1 : 3,
      transition,
    };
    const avatarAnimate = {
      ...animationProps.animate,
      transition,
    };
    const agentLayoutTransition = transition;
    const avatarLayoutTransition = transition;

    return (
      <div className="fixed inset-0 z-40 pointer-events-none">
        {/* Phone: vertical stack (caption top, avatar center, history above bar). md+: three columns */}
        <div className="relative h-full w-full flex">
          {/* Caption: phone = full width below header; md+ = left column, vertical center */}
          <div
            className={cn(
              'absolute z-50 pointer-events-auto',
              // Phone: top strip, full width, below header
              'left-3 right-3 top-[5rem] w-[calc(100%-1.5rem)]',
              'sm:left-4 sm:right-auto sm:top-1/2 sm:-translate-y-1/2 sm:w-[16rem] sm:bottom-auto',
              'md:left-4 md:top-1/2 md:-translate-y-1/2 md:bottom-auto md:w-auto md:max-w-[300px]',
              'lg:left-6 lg:max-w-[340px] xl:left-8 xl:max-w-[380px]'
            )}
          >
            <motion.div
              initial={{ opacity: 0, x: -50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className={cn(
                'w-full',
                'transition-all duration-300',
                captionMinimized ? 'w-auto max-w-[200px]' : 'w-full'
              )}
            >
              <CaptionContent
                messages={messages}
                room={room}
                isMinimized={captionMinimized}
                onToggleMinimize={() => setCaptionMinimized(!captionMinimized)}
              />
            </motion.div>
          </div>

          {/* History: phone = full width above control bar; md+ = right column. Flex + min-h-0 so scroll works. */}
          {!historyHidden && (
            <div
              className={cn(
                'absolute z-50 pointer-events-auto flex flex-col',
                // Phone: full width strip above control bar (bar + safe area ~10rem)
                'left-3 right-3 bottom-[10rem] w-[calc(100%-1.5rem)] max-h-[38vh] min-h-0',
                'sm:left-auto sm:right-4 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:w-[22rem] sm:max-h-[320px] sm:min-h-0',
                'md:right-4 md:w-[280px] md:max-w-[calc(100vw-8rem)] md:max-h-[min(520px,72vh)]',
                'lg:right-6 lg:w-[320px] xl:right-8 xl:w-[360px]'
              )}
            >
              <motion.div
                initial={{ opacity: 0, x: 50 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className={cn(
                  'flex flex-col w-full min-h-0 rounded-xl sm:rounded-2xl overflow-hidden',
                  'bg-gradient-to-br from-gray-900/95 via-black/95 to-gray-900/95',
                  'backdrop-blur-md border border-gray-600/50 shadow-2xl',
                  'transition-all duration-300',
                  historyMinimized ? 'h-auto' : 'flex-1 min-h-0 max-h-full'
                )}
              >
                {/* Header with minimize/close buttons - touch-friendly, never shrink */}
                <div className="flex shrink-0 items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 border-b border-gray-700/50">
                  <h3 className="text-white font-semibold text-xs sm:text-sm truncate">会話履歴</h3>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setHistoryMinimized(!historyMinimized)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-lg hover:bg-white/10 transition-colors text-white/60 hover:text-white touch-manipulation"
                      aria-label={historyMinimized ? "Expand history" : "Minimize history"}
                    >
                      {historyMinimized ? (
                        <CaretUp weight="bold" className="w-4 h-4" />
                      ) : (
                        <CaretDown weight="bold" className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => setHistoryHidden(true)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-lg hover:bg-red-500/20 transition-colors text-white/60 hover:text-red-400 touch-manipulation"
                      aria-label="Hide history"
                    >
                      <X weight="bold" className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* History content - flex-1 min-h-0 so it scrolls instead of overflowing */}
                {!historyMinimized && (
                  <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2 sm:py-3 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-800/20 [&::-webkit-scrollbar-thumb]:bg-gray-500/60 [&::-webkit-scrollbar-thumb]:rounded-full">
                    {allMessages.length > 0 ? (
                      <div className="space-y-3">
                        {allMessages.map((msg, idx) => {
                          const isUserMessage = msg.from?.identity === room?.localParticipant?.identity;
                          const { japanese, english, chinese } = parseTranslations(msg.message || '');

                          return (
                            <div
                              key={idx}
                              className={cn(
                                'rounded-lg px-3 py-2 border',
                                isUserMessage
                                  ? 'bg-gray-800/50 border-gray-700/30'
                                  : 'bg-sky-900/30 border-sky-700/40'
                              )}
                            >
                              <div className="flex items-center gap-2 mb-2">
                                <span className={cn(
                                  'text-xs font-semibold',
                                  isUserMessage ? 'text-gray-400' : 'text-sky-300'
                                )}>
                                  {isUserMessage ? 'あなた' : 'ルウル'}
                                </span>
                              </div>

                              {/* Display all 3 languages for agent messages, or just user message */}
                              {isUserMessage ? (
                                <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-gray-300">
                                  {msg.message}
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {/* Japanese first, no JP: label */}
                                  {japanese ? (
                                    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-sky-100">
                                      {japanese}
                                    </div>
                                  ) : null}
                                  {/* EN: below Japanese when we have content */}
                                  {english ? (
                                    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-blue-200/90">
                                      <span className="text-xs font-semibold text-blue-300 mr-1.5">EN:</span>
                                      {english}
                                    </div>
                                  ) : null}
                                  {/* CN: below EN when we have content */}
                                  {chinese ? (
                                    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-green-200/90">
                                      <span className="text-xs font-semibold text-green-300 mr-1.5">CN:</span>
                                      {chinese}
                                    </div>
                                  ) : null}
                                  {/* Fallback when no Japanese parsed - show raw message */}
                                  {!japanese && !english && !chinese && (
                                    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-sky-100">
                                      {msg.message}
                                    </div>
                                  )}
                                </div>
                              )}

                              {msg.timestamp && (
                                <div className={cn(
                                  'text-xs mt-2',
                                  isUserMessage ? 'text-gray-500' : 'text-sky-400/70'
                                )}>
                                  {new Date(msg.timestamp).toLocaleTimeString('ja-JP', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-400 text-sm">
                        まだメッセージがありません
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            </div>
          )}

          {/* Show history button when hidden - matches history position */}
          {historyHidden && (
            <div className="absolute right-3 bottom-[10rem] sm:bottom-auto sm:right-4 sm:top-1/2 sm:-translate-y-1/2 z-50 pointer-events-auto md:right-4 lg:right-6 xl:right-8">
              <button
                onClick={() => {
                  setHistoryHidden(false);
                  setHistoryMinimized(false);
                }}
                className="min-h-[48px] min-w-[48px] flex items-center justify-center p-3 rounded-full bg-gray-900/90 backdrop-blur-md border border-gray-700/50 shadow-lg hover:bg-gray-800/90 transition-colors text-white touch-manipulation"
                aria-label="Show history"
              >
                <CaretUp weight="bold" className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Avatar: center - phone = between caption (top) and history (bottom); md+ between columns */}
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center pointer-events-none',
              // Phone: space for caption (top) and history + control bar (bottom)
              'pt-[7rem] pb-[12rem] px-4',
              'sm:pt-[8rem] sm:pb-[12rem]',
              'md:pt-0 md:pb-0 md:pl-[max(2rem,22vw)] md:pr-[max(2rem,22vw)]',
              'lg:pl-[max(2.5rem,24vw)] lg:pr-[max(2.5rem,24vw)]'
            )}
          >
            <div className="flex flex-col items-center justify-center relative w-full max-w-full">
              {/* Main image - phone: slightly smaller to fit; sm+ scale up */}
              <div className="relative w-full h-full flex items-center justify-center shrink-0">
                {/* Main avatar: Live2D (idle + lip sync) when configured, else static image */}
                <div className="relative z-10 w-full h-full flex items-center justify-center">
                  {appConfig?.live2dModelUrl ? (
                    <Live2DAvatar
                      modelUrl={appConfig.live2dModelUrl}
                      audioTrack={
                        agentAudioTrack?.publication?.track?.mediaStreamTrack
                          ? { mediaStreamTrack: agentAudioTrack.publication.track.mediaStreamTrack }
                          : undefined
                      }
                      isSpeaking={isSpeaking}
                      size={480}
                      className="shadow-xl bg-black/40"
                      fallbackImageUrl="/leur.jpg"
                    />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src="/leur.jpg"
                      alt="Avatar"
                      className="w-full h-full object-contain shadow-xl relative z-10 bg-black/40"
                    />
                  )}
                </div>
              </div>

              {/* Status indicator badge - positioned directly below image - responsive text */}
              <div className="flex justify-center mt-2 sm:mt-3 z-20">
                {isAgentConnected ? (
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-500/90 backdrop-blur-sm border border-green-400/50 shadow-lg"
                  >
                    <motion.div
                      className="w-2 h-2 rounded-full bg-green-300"
                      animate={{
                        scale: [1, 1.2, 1],
                        opacity: [1, 0.7, 1],
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                    />
                    <span className="text-white text-xs font-semibold">接続中</span>
                  </motion.div>
                ) : isAgentConnecting ? (
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-yellow-500/90 backdrop-blur-sm border border-yellow-400/50 shadow-lg"
                  >
                    <motion.div
                      className="w-2 h-2 rounded-full bg-yellow-300"
                      animate={{
                        scale: [1, 1.3, 1],
                        opacity: [1, 0.5, 1],
                      }}
                      transition={{
                        duration: 1,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                    />
                    <span className="text-white text-xs font-semibold">接続中...</span>
                  </motion.div>
                ) : (
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/90 backdrop-blur-sm border border-red-400/50 shadow-lg"
                  >
                    <motion.div
                      className="w-2 h-2 rounded-full bg-red-300"
                      animate={{
                        opacity: [1, 0.5, 1],
                      }}
                      transition={{
                        duration: 1.5,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                    />
                    <span className="text-white text-xs font-semibold">未接続</span>
                  </motion.div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
}
