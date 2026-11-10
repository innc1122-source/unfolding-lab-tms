import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React app is a standalone build. In production the existing Node server
// serves the built files from public/dist under the /next mount (see server.js).
// Runtime stays a single `node server.js` with no installed dependencies.
export default defineConfig({
  root: '.',
  base: '/next/',
  plugins: [react()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // During dev, proxy everything the Node API owns to it (run start-tms.bat too).
    // 8767 is the TMS — the main system. It used to be 8765, which is the FROZEN
    // old LMS: editing TMS screens while the API answered from the other database
    // shows up as "the data looks wrong", never as an error, so it is the worst
    // kind of default. Override with API_PORT=8765 if you really mean the old one.
    proxy: (() => {
      const api = 'http://localhost:' + (process.env.API_PORT || '8767');
      return {
        '/api': {
          target: api,
          changeOrigin: false,
          configure: (proxy) => proxy.on('proxyReq', (pr) => {
            if (pr.getHeader('origin')) pr.setHeader('origin', api);
          }),
        },
        '/attachments': api,
        // pdfjs is vendored under public/vendor and loaded by a plain <script src>,
        // so it has to come from the API origin in dev too.
        '/vendor': api,
        '/assets': api,
        '/videos': api,
      };
    })(),
  },
});
