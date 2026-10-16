// Platform Detection: determines target platform from user input and context
import type { PlatformType, ApplicationType, BuildTarget } from '../../shared/types';

// Platform detection patterns
const PLATFORM_PATTERNS: Record<PlatformType, RegExp[]> = {
  web: [
    /\b(web|website|webapp|web app|web-based)\b/i,
    /\b(html|css|javascript|react|vue|angular|next\.?js|svelte)\b/i,
    /\bbrowser\b/i,
    /\bresponsive\b/i,
    /\bonline\b/i,
  ],
  windows: [
    /\b(windows|win32|winui|wpf|\.exe)\b/i,
    /\bwindows (app|application|desktop|program)\b/i,
    /\bwindows\.?forms?\b/i,
    /\b\.net (desktop|windows)\b/i,
    /\bc#.*windows\b/i,
  ],
  macos: [
    /\b(macos|mac os|osx|os x|cocoa|swift ui|\.app)\b/i,
    /\bmac (app|application|desktop)\b/i,
    /\bswift.*app\b/i,
    /\bxcode\b/i,
  ],
  linux: [
    /\b(linux|gtk|qt|gnome|kde)\b/i,
    /\blinux (app|application|desktop)\b/i,
    /\b\.deb|\.rpm|flatpak|snap\b/i,
  ],
  android: [
    /\b(android|\.apk|\.aab)\b/i,
    /\bandroid (app|application)\b/i,
    /\b(kotlin|java).*android\b/i,
    /\bjetpack compose\b/i,
    /\bgradle\b/i,
  ],
  ios: [
    /\b(ios|iphone|ipad|swift|swiftui|xcode)\b/i,
    /\bios (app|application)\b/i,
    /\b\.ipa\b/i,
    /\bapp ?store\b/i,
  ],
  cli: [
    /\b(cli|command[- ]?line|terminal|console|shell)\b/i,
    /\bcommand[- ]?line (tool|utility|program|app|application)\b/i,
    /\b(bash|shell|powershell|cmd) (script|tool)\b/i,
    /\barguments?|flags?\b.*\b(parse|cli)\b/i,
  ],
  backend: [
    /\b(backend|back[- ]?end|server[- ]?side)\b/i,
    /\b(microservice|service|daemon)\b/i,
    /\b(express|fastapi|flask|django|spring boot|gin)(?! *web)\b/i,
    /\bbackground (job|worker|process)\b/i,
  ],
  api: [
    /\b(api|rest|graphql|grpc)\b/i,
    /\b(rest ?ful|rest api|web api|http api)\b/i,
    /\bendpoints?\b/i,
    /\bopenapi|swagger\b/i,
  ],
  library: [
    /\b(library|package|sdk|npm package|pip package|gem|crate)\b/i,
    /\b(reusable|shared) (library|package|module)\b/i,
    /\bnuget|maven|cargo\b/i,
  ],
  desktop: [
    /\bdesktop (app|application)\b/i,
    /\b(electron|tauri|nw\.js)\b/i,
  ],
  mobile: [
    /\bmobile (app|application)\b/i,
    /\b(react native|flutter|xamarin)\b/i,
    /\bcross[- ]?platform.*mobile\b/i,
  ],
};

// Application type patterns
const APP_TYPE_PATTERNS: Record<ApplicationType, RegExp[]> = {
  website: [
    /\b(website|site|landing page|home ?page|web ?page)\b/i,
    /\b(marketing|blog|portfolio|brochure) (site|website)\b/i,
  ],
  webapp: [
    /\b(web app|webapp|web application|saas)\b/i,
    /\b(dashboard|admin panel|web platform)\b/i,
  ],
  desktop_app: [
    /\bdesktop (app|application|program|software)\b/i,
    /\bnative.*desktop\b/i,
  ],
  mobile_app: [
    /\bmobile (app|application)\b/i,
    /\b(ios|android) app\b/i,
  ],
  cli_tool: [
    /\b(cli|command[- ]?line|terminal) (tool|utility|program)\b/i,
    /\bscript\b/i,
  ],
  service: [
    /\b(service|microservice|daemon|worker)\b/i,
    /\b(backend|api) service\b/i,
  ],
  library: [
    /\b(library|package|module|sdk|framework)\b/i,
  ],
  game: [
    /\b(game|gaming)\b/i,
  ],
  embedded: [
    /\b(embedded|iot|raspberry pi|arduino)\b/i,
  ],
};

/**
 * Detect platform from user input text
 */
export function detectPlatform(input: string): {
  platform: PlatformType;
  confidence: number;
  matches: string[];
} | null {
  const lower = input.toLowerCase();
  
  // Score each platform based on pattern matches
  const scores: Array<{ platform: PlatformType; score: number; matches: string[] }> = [];
  
  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    const matches: string[] = [];
    let score = 0;
    
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        const match = lower.match(pattern)?.[0];
        if (match) matches.push(match);
        score += 1;
      }
    }
    
    if (score > 0) {
      scores.push({ platform: platform as PlatformType, score, matches });
    }
  }
  
  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  
  if (scores.length === 0) {
    return null;
  }
  
  const best = scores[0];
  
  // Calculate confidence based on:
  // - Number of matches
  // - Specificity (more specific platforms get bonus)
  // - Ambiguity (if multiple platforms have similar scores, lower confidence)
  const specificPlatforms = ['android', 'ios', 'windows', 'macos', 'linux', 'cli'];
  const specificityBonus = specificPlatforms.includes(best.platform) ? 0.2 : 0;
  
  const secondBest = scores[1];
  const ambiguityPenalty = secondBest && secondBest.score >= best.score * 0.7 ? 0.2 : 0;
  
  const baseConfidence = Math.min(0.5 + (best.score * 0.15), 0.9);
  const confidence = Math.max(0.3, Math.min(0.95, baseConfidence + specificityBonus - ambiguityPenalty));
  
  return {
    platform: best.platform,
    confidence,
    matches: best.matches,
  };
}

/**
 * Detect application type from user input
 */
export function detectApplicationType(input: string): {
  applicationType: ApplicationType;
  confidence: number;
} | null {
  const lower = input.toLowerCase();
  
  const scores: Array<{ type: ApplicationType; score: number }> = [];
  
  for (const [type, patterns] of Object.entries(APP_TYPE_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        score += 1;
      }
    }
    if (score > 0) {
      scores.push({ type: type as ApplicationType, score });
    }
  }
  
  if (scores.length === 0) {
    return null;
  }
  
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const confidence = Math.min(0.6 + (best.score * 0.15), 0.9);
  
  return {
    applicationType: best.type,
    confidence,
  };
}

/**
 * Infer application type from platform
 */
export function inferApplicationTypeFromPlatform(platform: PlatformType): ApplicationType {
  const mapping: Record<PlatformType, ApplicationType> = {
    web: 'webapp',
    windows: 'desktop_app',
    macos: 'desktop_app',
    linux: 'desktop_app',
    android: 'mobile_app',
    ios: 'mobile_app',
    cli: 'cli_tool',
    backend: 'service',
    api: 'service',
    library: 'library',
    desktop: 'desktop_app',
    mobile: 'mobile_app',
  };
  return mapping[platform];
}

/**
 * Resolve ambiguous platform based on context
 */
export function resolveAmbiguousPlatform(
  input: string,
  currentOS: NodeJS.Platform
): PlatformType {
  // If user says "desktop" without specifying OS, use their current OS
  if (/\bdesktop\b/i.test(input)) {
    switch (currentOS) {
      case 'win32': return 'windows';
      case 'darwin': return 'macos';
      case 'linux': return 'linux';
      default: return 'desktop';
    }
  }
  
  // If user says "mobile" without specifying, default to Android (more open)
  if (/\bmobile\b/i.test(input)) {
    return 'android';
  }
  
  // Default to web for ambiguous cases
  return 'web';
}

/**
 * Create a full build target from detected platform and context
 */
export function createBuildTarget(
  platform: PlatformType,
  applicationType: ApplicationType,
  confidence: number,
  availableToolchains: string[] = []
): BuildTarget {
  return {
    platform,
    applicationType,
    framework: null,
    language: null,
    runtime: null,
    packaging: null,
    validationStrategy: [],
    availableToolchains,
    confidence,
    needsToolchain: [],
  };
}

/**
 * Get recommended framework for platform
 */
export function getRecommendedFramework(platform: PlatformType): string | null {
  const recommendations: Partial<Record<PlatformType, string>> = {
    web: 'React + Vite',
    windows: 'WinUI 3 / Electron',
    macos: 'SwiftUI / Electron',
    linux: 'GTK / Electron',
    android: 'Jetpack Compose',
    ios: 'SwiftUI',
    cli: 'Node.js / Python',
    backend: 'Express / FastAPI',
    api: 'Express / FastAPI',
    library: 'TypeScript / Python',
  };
  return recommendations[platform] || null;
}

/**
 * Get validation strategy for platform
 */
export function getValidationStrategy(platform: PlatformType): string[] {
  const strategies: Record<PlatformType, string[]> = {
    web: ['deps', 'typecheck', 'lint', 'build', 'unit', 'server', 'browser', 'console', 'responsive', 'visual', 'review'],
    windows: ['deps', 'typecheck', 'build', 'unit', 'desktop_launch', 'desktop_package', 'review'],
    macos: ['deps', 'typecheck', 'build', 'unit', 'desktop_launch', 'desktop_package', 'review'],
    linux: ['deps', 'typecheck', 'build', 'unit', 'desktop_launch', 'desktop_package', 'review'],
    android: ['deps', 'lint', 'mobile_build', 'unit', 'mobile_emulator', 'mobile_permissions', 'review'],
    ios: ['deps', 'lint', 'mobile_build', 'unit', 'review'],
    cli: ['deps', 'typecheck', 'build', 'unit', 'cli_args', 'cli_help', 'cli_exit_codes', 'review'],
    backend: ['deps', 'typecheck', 'lint', 'build', 'unit', 'service_start', 'endpoint_tests', 'review'],
    api: ['deps', 'typecheck', 'lint', 'build', 'unit', 'service_start', 'endpoint_tests', 'api_contract', 'review'],
    library: ['deps', 'typecheck', 'lint', 'build', 'unit', 'review'],
    desktop: ['deps', 'typecheck', 'build', 'unit', 'desktop_launch', 'review'],
    mobile: ['deps', 'build', 'unit', 'mobile_build', 'review'],
  };
  return strategies[platform] || ['deps', 'build', 'unit', 'review'];
}

/**
 * Check if platform requires specific toolchain
 */
export function getPlatformToolchainRequirements(platform: PlatformType): string[] {
  const requirements: Partial<Record<PlatformType, string[]>> = {
    web: ['node', 'npm'],
    windows: ['dotnet', 'msbuild'],
    android: ['jdk', 'android-sdk', 'gradle'],
    ios: ['xcode', 'swift'],
    macos: ['xcode', 'swift'],
    cli: ['node', 'python'],
    backend: ['node', 'python'],
    api: ['node', 'python'],
    library: ['node', 'python'],
  };
  return requirements[platform] || [];
}
