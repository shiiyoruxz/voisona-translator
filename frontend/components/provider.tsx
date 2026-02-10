'use client';

import React from 'react';
import { Room } from 'livekit-client';
import { RoomContext } from '@livekit/components-react';
import { toastAlert } from '@/components/alert-toast';
import useConnectionDetails from '@/hooks/useConnectionDetails';
import { AppConfig } from '@/lib/types';

export function Provider({
  appConfig,
  children,
}: {
  appConfig: AppConfig;
  children: React.ReactNode;
}) {
  const { connectionDetails } = useConnectionDetails(appConfig);
  const room = React.useMemo(() => new Room(), []);

  React.useEffect(() => {
    if (room.state === 'disconnected' && connectionDetails) {
      Promise.all([
        room.localParticipant.setMicrophoneEnabled(true, undefined, {
          preConnectBuffer: true,
        }),
        room.connect(connectionDetails.serverUrl, connectionDetails.participantToken),
      ]).catch((error) => {
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
      room.disconnect();
    };
  }, [room, connectionDetails]);

  return <RoomContext.Provider value={room}>{children}</RoomContext.Provider>;
}
