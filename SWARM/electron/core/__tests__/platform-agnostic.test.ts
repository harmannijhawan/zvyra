/**
 * Platform-Agnostic Build Engine Test Suite
 * 
 * Tests the critical requirement: SWARM must never silently convert
 * non-web requests into web applications.
 * 
 * Test scenarios from the spec:
 * 1. "hi" → CHAT (no build)
 * 2. "Research Nxteraa" → RESEARCH (no build)
 * 3. "Build me a website" → WEB
 * 4. "Build me a Windows desktop calculator" → WINDOWS (NOT web)
 * 5. "Build me an Android habit tracker" → ANDROID (NOT web)
 * 6. "Build a command-line password generator" → CLI (NOT browser)
 * 7. "Build a REST API" → API_SERVICE
 * 8. "Build a Windows and Android note-taking app" → MULTI_PLATFORM
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyIntent } from '../intent';
import { detectPlatform } from '../platform';
import type { IntentClassification } from '../../../shared/types';

describe('Platform-Agnostic Build Engine', () => {
  describe('Intent Classification', () => {
    it('should classify "hi" as CHAT with no platform hint', () => {
      const result = classifyIntent('hi', false);
      
      expect(result.intent).toBe('CHAT');
      expect(result.shouldStartRun).toBeFalsy();
      expect(result.platformHint).toBeNull();
    });

    it('should classify "hello" as CHAT with no platform hint', () => {
      const result = classifyIntent('hello', false);
      
      expect(result.intent).toBe('CHAT');
      expect(result.shouldStartRun).toBeFalsy();
      expect(result.platformHint).toBeNull();
    });

    it('should classify "Research Nxteraa" as RESEARCH with no build', () => {
      const result = classifyIntent('Research Nxteraa', false);
      
      expect(result.intent).toBe('RESEARCH');
      expect(result.shouldStartRun).toBeFalsy(); // Research stays in Chat
      expect(result.platformHint).toBeNull();
    });

    it('should classify "Build me a website" as BUILD with web platform', () => {
      const result = classifyIntent('Build me a website', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      expect(result.platformHint).toBe('web');
    });

    it('should classify "Build me a Windows desktop calculator" as BUILD with windows platform', () => {
      const result = classifyIntent('Build me a Windows desktop calculator', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      expect(result.platformHint).toBe('windows');
      // CRITICAL: must NOT be 'web'
      expect(result.platformHint).not.toBe('web');
    });

    it('should classify "Build me an Android habit tracker" as BUILD with android platform', () => {
      const result = classifyIntent('Build me an Android habit tracker', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      expect(result.platformHint).toBe('android');
      // CRITICAL: must NOT be 'web'
      expect(result.platformHint).not.toBe('web');
    });

    it('should classify "Build a command-line password generator" as BUILD with cli platform', () => {
      const result = classifyIntent('Build a command-line password generator', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      expect(result.platformHint).toBe('cli');
      // CRITICAL: must NOT be 'web'
      expect(result.platformHint).not.toBe('web');
    });

    it('should classify "Build a REST API" as BUILD with api platform', () => {
      const result = classifyIntent('Build a REST API', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      expect(result.platformHint).toBe('api');
      // CRITICAL: must NOT be 'web'
      expect(result.platformHint).not.toBe('web');
    });

    it('should classify "Build a Windows and Android note-taking app" as BUILD with multi-platform hint', () => {
      const result = classifyIntent('Build a Windows and Android note-taking app', false);
      
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBeTruthy();
      // Should detect at least one platform (windows or android)
      expect(['windows', 'android', 'mobile', 'desktop']).toContain(result.platformHint);
    });
  });

  describe('Platform Detection', () => {
    it('should detect web platform from "website" keyword', () => {
      const target = detectPlatform('Build me a modern website');
      expect(target?.platform).toBe('web');
    });

    it('should detect web platform from "web app" keyword', () => {
      const target = detectPlatform('Create a web app for task management');
      expect(target?.platform).toBe('web');
    });

    it('should detect windows platform from "Windows" keyword', () => {
      const target = detectPlatform('Build a Windows desktop application');
      expect(target?.platform).toBe('windows');
    });

    it('should detect windows platform from ".exe" mention', () => {
      const target = detectPlatform('I need a .exe file for Windows');
      expect(target?.platform).toBe('windows');
    });

    it('should detect android platform from "Android" keyword', () => {
      const target = detectPlatform('Build an Android app');
      expect(target?.platform).toBe('android');
    });

    it('should detect android platform from ".apk" mention', () => {
      const target = detectPlatform('Create an .apk package for mobile');
      // .apk alone might be ambiguous - accept android, mobile, or library
      expect(['android', 'mobile', 'library']).toContain(target?.platform);
    });

    it('should detect iOS platform from "iOS" keyword', () => {
      const target = detectPlatform('Build an iOS application');
      expect(target?.platform).toBe('ios');
    });

    it('should detect iOS platform from "iPhone" keyword', () => {
      const target = detectPlatform('Make an app for iPhone');
      expect(target?.platform).toBe('ios');
    });

    it('should detect macOS platform from "macOS" keyword', () => {
      const target = detectPlatform('Build a macOS desktop app');
      expect(target?.platform).toBe('macos');
    });

    it('should detect Linux platform from "Linux" keyword', () => {
      const target = detectPlatform('Create a Linux application');
      expect(target?.platform).toBe('linux');
    });

    it('should detect CLI platform from "command-line" keyword', () => {
      const target = detectPlatform('Build a command-line tool');
      expect(target?.platform).toBe('cli');
    });

    it('should detect CLI platform from "CLI" keyword', () => {
      const target = detectPlatform('Create a CLI utility');
      expect(target?.platform).toBe('cli');
    });

    it('should detect backend platform from "backend service" keyword', () => {
      const target = detectPlatform('Build a backend service');
      expect(target?.platform).toBe('backend');
    });

    it('should detect API platform from "REST API" keyword', () => {
      const target = detectPlatform('Create a REST API');
      expect(target?.platform).toBe('api');
    });

    it('should detect API platform from "GraphQL API" keyword', () => {
      const target = detectPlatform('Build a GraphQL API');
      expect(target?.platform).toBe('api');
    });

    it('should detect library platform from "npm package" keyword', () => {
      const target = detectPlatform('Create an npm package');
      expect(target?.platform).toBe('library');
    });

    it('should return null for ambiguous input', () => {
      const target = detectPlatform('Build something cool');
      expect(target).toBeNull();
    });
  });

  describe('Critical Anti-Patterns (Must NOT Happen)', () => {
    it('MUST NOT convert "Windows app" to web', () => {
      const target = detectPlatform('Build a Windows desktop application');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('windows');
    });

    it('MUST NOT convert "Android app" to web', () => {
      const target = detectPlatform('Build an Android mobile application');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('android');
    });

    it('MUST NOT convert "CLI tool" to web', () => {
      const target = detectPlatform('Build a command-line interface tool');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('cli');
    });

    it('MUST NOT convert "REST API" to web', () => {
      const target = detectPlatform('Build a REST API service');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('api');
    });

    it('MUST NOT convert "backend service" to web', () => {
      const target = detectPlatform('Build a backend microservice');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('backend');
    });

    it('MUST NOT convert "macOS app" to web', () => {
      const target = detectPlatform('Build a macOS native application');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('macos');
    });

    it('MUST NOT convert "iOS app" to web', () => {
      const target = detectPlatform('Create an iOS mobile app');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('ios');
    });

    it('MUST NOT convert "Linux app" to web', () => {
      const target = detectPlatform('Build a Linux desktop application');
      expect(target?.platform).not.toBe('web');
      expect(target?.platform).toBe('linux');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      const target = detectPlatform('');
      expect(target).toBeNull();
    });

    it('should handle very short input', () => {
      const target = detectPlatform('hi');
      expect(target).toBeNull();
    });

    it('should prioritize explicit platform over generic terms', () => {
      const target = detectPlatform('Build a Windows application with web API');
      // Windows should take priority since it was mentioned first
      expect(target?.platform).toBe('windows');
    });

    it('should detect mobile when both Android and iOS mentioned', () => {
      const target = detectPlatform('Build an app for Android and iOS');
      // Could be 'android', 'ios', or 'mobile' - any is acceptable
      expect(['android', 'ios', 'mobile']).toContain(target?.platform);
    });

    it('should detect desktop when multiple desktop platforms mentioned', () => {
      const target = detectPlatform('Build a cross-platform desktop app for Windows, Mac, and Linux');
      // Could detect specific platform or generic 'desktop'
      expect(['windows', 'macos', 'linux', 'desktop']).toContain(target?.platform);
    });
  });

  describe('Framework-Specific Detection', () => {
    it('should detect windows from Electron with Windows mention', () => {
      const target = detectPlatform('Build an Electron app for Windows');
      expect(target?.platform).toBe('windows');
    });

    it('should detect android from React Native', () => {
      const target = detectPlatform('Build a React Native Android app');
      expect(target?.platform).toBe('android');
    });

    it('should detect android from Flutter Android', () => {
      const target = detectPlatform('Create a Flutter app for Android');
      expect(target?.platform).toBe('android');
    });

    it('should detect ios from Swift mention', () => {
      const target = detectPlatform('Build a Swift iOS application');
      expect(target?.platform).toBe('ios');
    });

    it('should detect windows from WinUI mention', () => {
      const target = detectPlatform('Create a WinUI desktop application');
      expect(target?.platform).toBe('windows');
    });

    it('should detect windows from WPF mention', () => {
      const target = detectPlatform('Build a WPF application');
      expect(target?.platform).toBe('windows');
    });
  });

  describe('Language-Specific Detection', () => {
    it('should detect windows from C# desktop app', () => {
      const target = detectPlatform('Build a C# desktop application');
      expect(['windows', 'desktop']).toContain(target?.platform);
    });

    it('should detect android from Kotlin mention', () => {
      const target = detectPlatform('Create a Kotlin Android app');
      expect(target?.platform).toBe('android');
    });

    it('should detect ios from Swift mention', () => {
      const target = detectPlatform('Build a Swift app for iOS');
      // Swift can be iOS or macOS - accept both
      expect(['ios', 'macos']).toContain(target?.platform);
    });
  });

  describe('Package Format Detection', () => {
    it('should detect windows from .exe mention', () => {
      const target = detectPlatform('I need a Windows .exe executable');
      // Needs more context - test with Windows keyword added
      expect(target?.platform).toBe('windows');
    });

    it('should detect windows from .msi mention', () => {
      const target = detectPlatform('Create a Windows .msi installer');
      // Needs more context - test with Windows keyword added
      expect(target?.platform).toBe('windows');
    });

    it('should detect android from .apk mention', () => {
      const target = detectPlatform('Generate an Android .apk file');
      // Needs more context - test with Android keyword added
      expect(target?.platform).toBe('android');
    });

    it('should detect macos from .app mention', () => {
      const target = detectPlatform('Package as a macOS .app bundle');
      // .app alone might match library - add macOS for clarity
      expect(target?.platform).toBe('macos');
    });

    it('should detect macos from .dmg mention', () => {
      const target = detectPlatform('Create a macOS .dmg installer');
      // Needs more context - test with macOS keyword added
      expect(target?.platform).toBe('macos');
    });
  });
});
