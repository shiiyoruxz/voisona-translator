import type { AppConfig } from './lib/types';

export const APP_CONFIG_DEFAULTS: AppConfig = {
  companyName: 'ルウル Assistant',
  pageTitle: 'ルウル Assistant',
  pageDescription: 'A Japanese voice Translator',

  supportsChatInput: true,
  supportsVideoInput: true,
  supportsScreenShare: true,
  isPreConnectBufferEnabled: true,

  logo: '/leur.jpg',
  accent: '#00a6ff',
  logoDark: '/leur.jpg',
  accentDark: '#00a6ff',
  startButtonText: 'Start with ルウル',

  agentName: undefined,

  /**
   * Live2D model entry file.
   * If NEXT_PUBLIC_LIVE2D_MODEL_URL is set, that value is used.
   * Otherwise use Hiyori Pro (official sample; lip-sync ParamMouthOpenY).
   */
  live2dModelUrl:
    process.env.NEXT_PUBLIC_LIVE2D_MODEL_URL ?? '/models/hiyori_pro_en/hiyori_pro_t11.model3.json',
};
