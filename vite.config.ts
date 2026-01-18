import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, (process as any).cwd(), '');
  return {
    plugins: [react()],
    // GitHub Pages repository name used as base path
    base: '/safespeak/', 
    define: {
      // Polyfill process.env.API_KEY for the app usage
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
      // Polyfill process.env to prevent crashes in libraries that check it
      'process.env': {}
    },
  };
});