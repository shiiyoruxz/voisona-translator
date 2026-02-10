/**
 * Class to handle webcam functionality
 */
export class Webcam {
  /**
   * Open webcam and stream it through video tag.
   */
  open = async (videoRef: HTMLVideoElement): Promise<void> => {
    console.log('opening webcam');
    // Check if we're on HTTPS (required for camera access on mobile)
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      alert('Camera access requires HTTPS. Please use https:// or run on localhost.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Can't open Webcam! MediaDevices not supported. Make sure you're using HTTPS.");
      return;
    }

    // Try different video constraints for better mobile compatibility
    const constraints = [
      // First try with rear camera (ideal for object detection)
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      },
      // Fallback to any camera
      {
        audio: false,
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      },
      // Last resort - basic video
      {
        audio: false,
        video: true,
      },
    ];

    for (const constraint of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraint);
        videoRef.srcObject = stream;

        // Important for mobile: set video properties
        videoRef.playsInline = true;
        videoRef.muted = true;
        videoRef.autoplay = true;

        return;
      } catch (error) {
        console.warn('Failed with constraint:', constraint, error);
        continue;
      }
    }

    // If all constraints failed
    alert("Can't open Webcam! Please check camera permissions.");
  };

  /**
   * Close opened webcam.
   */
  close = (videoRef: HTMLVideoElement): void => {
    if (videoRef.srcObject) {
      const stream = videoRef.srcObject as MediaStream;
      stream.getTracks().forEach((track: MediaStreamTrack) => {
        track.stop();
      });
      videoRef.srcObject = null;
    } else {
      alert('Please open Webcam first!');
    }
  };
}
