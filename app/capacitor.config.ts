import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.evolvetech.fairground',
  appName: 'Fairground',
  webDir: 'dist',
  android: { allowMixedContent: false },
};

export default config;
