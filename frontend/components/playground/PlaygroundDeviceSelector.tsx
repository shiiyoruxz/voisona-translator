import { useEffect, useState } from 'react';
import { useMediaDeviceSelect } from '@livekit/components-react';

type PlaygroundDeviceSelectorProps = {
  kind: MediaDeviceKind;
};

export const PlaygroundDeviceSelector = ({ kind }: PlaygroundDeviceSelectorProps) => {
  const [showMenu, setShowMenu] = useState(false);
  const deviceSelect = useMediaDeviceSelect({ kind: kind });
  const [selectedDeviceName, setSelectedDeviceName] = useState('');

  useEffect(() => {
    deviceSelect.devices.forEach((device) => {
      if (device.deviceId === deviceSelect.activeDeviceId) {
        setSelectedDeviceName(device.label);
      }
    });
  }, [deviceSelect.activeDeviceId, deviceSelect.devices, selectedDeviceName]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showMenu) {
        setShowMenu(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showMenu]);

  return (
    <div>
      <button
        className="flex items-center gap-2 rounded-sm border border-gray-800 bg-gray-900 px-2 py-1 text-gray-300 hover:bg-gray-800"
        onClick={(e) => {
          setShowMenu(!showMenu);
          e.stopPropagation();
        }}
      >
        <span className="max-w-[80px] overflow-hidden overflow-ellipsis whitespace-nowrap">
          {selectedDeviceName}
        </span>
        <ChevronSVG />
      </button>
      <div
        className="absolute top-12 right-4 z-10 rounded-sm border border-gray-800 bg-gray-800 text-gray-300"
        style={{
          display: showMenu ? 'block' : 'none',
        }}
      >
        {deviceSelect.devices.map((device, index) => {
          return (
            <div
              onClick={() => {
                deviceSelect.setActiveMediaDevice(device.deviceId);
                setShowMenu(false);
              }}
              className={`${
                device.deviceId === deviceSelect.activeDeviceId ? 'text-white' : 'text-gray-500'
              } cursor-pointer bg-gray-900 px-2 py-2 text-xs hover:bg-gray-800 hover:text-white`}
              key={index}
            >
              {device.label}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ChevronSVG = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 5H5V7H3V5ZM7 9V7H5V9H7ZM9 9V11H7V9H9ZM11 7V9H9V7H11ZM11 7V5H13V7H11Z"
      fill="currentColor"
      fillOpacity="0.8"
    />
  </svg>
);
