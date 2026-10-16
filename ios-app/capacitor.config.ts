import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor configuration for the standalone ZVYRA iOS app.
 *
 * `webDir` points at the Vite output (ios-app/dist). After `vite build`, run
 * `npx cap sync ios` to copy those assets into the native Xcode project.
 */
const config: CapacitorConfig = {
  appId: 'ai.zvyra.app',
  appName: 'ZVYRA',
  webDir: 'dist',
  ios: {
    // The UI is a dark glass theme; match the native background so there is no
    // white flash on launch or when the keyboard animates.
    backgroundColor: '#03060d',
    contentInset: 'always'
  },
  server: {
    // Served from the bundle; iOS uses the capacitor:// scheme by default.
    iosScheme: 'capacitor'
  }
}

export default config
