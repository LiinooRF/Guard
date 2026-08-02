import type { ExpoConfig } from 'expo/config';

const production = process.env.NODE_ENV === 'production';

const config: ExpoConfig = {
  name: 'VoxIA Control',
  slug: 'voxia-control',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  scheme: 'voxia',
  plugins: [
    'expo-dev-client',
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: !production,
        },
      },
    ],
  ],
  android: {
    package: 'cl.voxia.control',
    versionCode: 1,
    permissions: ['INTERNET'],
    predictiveBackGestureEnabled: false,
  },
};

export default config;
