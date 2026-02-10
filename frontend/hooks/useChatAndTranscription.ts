import { useEffect, useMemo, useState } from 'react';
import { type ReceivedChatMessage, useChat, useRoomContext, useVoiceAssistant } from '@livekit/components-react';
import { RoomEvent, type TranscriptionSegment } from 'livekit-client';

const LK_CHAT_MESSAGE_TOPIC = 'lk-chat-message';

export default function useChatAndTranscription() {
  const chat = useChat();
  const room = useRoomContext();
  const { agentTranscriptions } = useVoiceAssistant();
  const [dataChannelMessages, setDataChannelMessages] = useState<ReceivedChatMessage[]>([]);
  const [transcriptionMessages, setTranscriptionMessages] = useState<ReceivedChatMessage[]>([]);

  // Receive full JP+EN+CN from agent via lk-chat-message (useChat may not get publish_data on all setups)
  useEffect(() => {
    if (!room) return;
    const handler = (
      payload: Uint8Array,
      participant?: import('livekit-client').RemoteParticipant,
      _kind?: unknown,
      topic?: string
    ) => {
      const isOurTopic = topic === LK_CHAT_MESSAGE_TOPIC;
      const decoded = (() => {
        try {
          return new TextDecoder().decode(payload);
        } catch {
          return '';
        }
      })();
      const looksLikeMultilang = /JP:\s*\S/.test(decoded) && (/EN:\s*\S/.test(decoded) || /中文:\s*\S/.test(decoded) || /CN:\s*\S/.test(decoded));
      if (!isOurTopic && !looksLikeMultilang) return;
      if (!decoded?.trim()) return;
      const sender =
        participant ??
        Array.from(room.remoteParticipants.values())[0];
      setDataChannelMessages((prev) => [
        ...prev,
        {
          id: `lk-chat-${Date.now()}-${prev.length}`,
          timestamp: Date.now(),
          message: decoded,
          from: sender ?? undefined,
        },
      ]);
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room]);

  // Convert agent transcriptions to chat messages for display
  // Note: With translator callback, delta_text is disabled so this mostly receives empty strings
  // Data channel messages (with translations) are the primary source
  useEffect(() => {
    if (!agentTranscriptions || agentTranscriptions.length === 0) return;
    
    const agentParticipant = room ? Array.from(room.remoteParticipants.values())[0] : undefined;
    
    // Only get the LATEST final transcription segment (not all of them to avoid stacking)
    const latestSegments = agentTranscriptions.filter((seg: TranscriptionSegment) => seg.final);
    if (latestSegments.length === 0) return;
    
    // Get only the most recent segment
    const latestSegment = latestSegments[latestSegments.length - 1];
    const text = latestSegment?.text?.trim() || '';
    if (!text || text.length < 5) return;
    
    // Only add if it's multilingual content (has JP: and EN: or 中文:)
    const looksLikeMultilang = /JP:\s*\S/.test(text) && (/EN:\s*\S/.test(text) || /中文:\s*\S/.test(text) || /CN:\s*\S/.test(text));
    
    // Skip non-multilingual content - data channel handles those
    if (!looksLikeMultilang) return;
    
    setTranscriptionMessages((prev) => {
      // Check if we already have this message (by content similarity)
      const lastMsg = prev[prev.length - 1];
      if (lastMsg && lastMsg.message === text) return prev;
      // Check if this text is a substring of or contains the last message (avoid duplicates)
      if (lastMsg && (text.includes(lastMsg.message) || lastMsg.message.includes(text))) return prev;
      
      return [
        ...prev,
        {
          id: `transcription-${Date.now()}-${prev.length}`,
          timestamp: Date.now(),
          message: text,
          from: agentParticipant ?? undefined,
        },
      ];
    });
  }, [agentTranscriptions, room]);

  // History box: merge chat messages, data channel messages, and transcriptions
  const mergedTranscriptions = useMemo(() => {
    const merged: Array<ReceivedChatMessage> = [
      ...chat.chatMessages,
      ...dataChannelMessages,
      ...transcriptionMessages,
    ].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    const hasENandCN = (m: ReceivedChatMessage) =>
      /EN:\s*\S/.test(m.message ?? '') && (/中文:\s*\S/.test(m.message ?? '') || /CN:\s*\S/.test(m.message ?? ''));
    const isFromAgent = (m: ReceivedChatMessage) =>
      m.from?.identity !== room?.localParticipant?.identity;
    // Signature for content-based dedupe (e.g. greeting): first JP line or first 80 chars
    const contentSignature = (msg: ReceivedChatMessage) => {
      const s = (msg.message ?? '').trim();
      const jpMatch = s.match(/JP:\s*([^\n]+)/);
      return (jpMatch ? jpMatch[1] : s).slice(0, 80);
    };
    const sameContent = (a: ReceivedChatMessage, b: ReceivedChatMessage) =>
      contentSignature(a) === contentSignature(b) || (contentSignature(a).length > 20 && contentSignature(b).startsWith(contentSignature(a).slice(0, 30)));

    const deduped: Array<ReceivedChatMessage> = [];
    for (const msg of merged) {
      const prev = deduped[deduped.length - 1];
      const sameIdentity = prev && msg.from?.identity === prev.from?.identity;
      const bothFromAgent = prev && isFromAgent(prev) && isFromAgent(msg);
      const sameSender = prev && (sameIdentity || bothFromAgent);
      const closeTime = prev && Math.abs((msg.timestamp ?? 0) - (prev.timestamp ?? 0)) <= 5000;
      const duplicateContent = sameSender && sameContent(prev, msg);

      // Detect stacked messages (new message contains previous message content)
      const prevContent = prev?.message ?? '';
      const curContent = msg.message ?? '';
      const isStacked = prevContent.length > 20 && curContent.includes(prevContent.slice(0, 50));
      
      // Skip stacked messages that don't have proper multilingual format
      if (isStacked && !hasENandCN(msg)) {
        continue;
      }

      if (sameSender && (closeTime || duplicateContent)) {
        const prevMultilang = hasENandCN(prev);
        const curMultilang = hasENandCN(msg);
        if (curMultilang && !prevMultilang) {
          deduped[deduped.length - 1] = msg;
          continue;
        }
        if (!curMultilang && prevMultilang) continue;
        // For stacked content, prefer the shorter individual message
        if (isStacked) continue;
        if ((msg.message?.length ?? 0) <= (prev.message?.length ?? 0)) continue;
        deduped[deduped.length - 1] = msg;
        continue;
      }
      deduped.push(msg);
    }
    return deduped;
  }, [chat.chatMessages, dataChannelMessages, transcriptionMessages, room]);

  return { messages: mergedTranscriptions, send: chat.send };
}
