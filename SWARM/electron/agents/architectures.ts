// Platform-specific architecture prompts and guidance
import type { PlatformType } from '../../shared/types';

export interface PlatformArchitectureGuidance {
  systemPrompt: string;
  stackGuidance: string;
  outputFormat: string;
  runtimeOptions: string[];
  requiresPackageJson: boolean;
  requiresServer: boolean;
}

/**
 * Get architecture guidance for specific platform
 */
export function getArchitectureGuidance(platform: PlatformType | null): PlatformArchitectureGuidance {
  switch (platform) {
    case 'web':
      return getWebArchitecture();
    case 'windows':
      return getWindowsArchitecture();
    case 'android':
      return getAndroidArchitecture();
    case 'ios':
      return getIOSArchitecture();
    case 'macos':
      return getMacOSArchitecture();
    case 'linux':
      return getLinuxArchitecture();
    case 'cli':
      return getCLIArchitecture();
    case 'backend':
    case 'api':
      return getBackendArchitecture();
    case 'library':
      return getLibraryArchitecture();
    default:
      // Default to web for backward compatibility
      return getWebArchitecture();
  }
}

function getWebArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for WEB applications. Define a minimal, robust web architecture that free AI coding agents can implement correctly in one pass and that runs locally.',
    stackGuidance: `Prefer a simple, dependency-light stack that installs in seconds:
- For full-stack web apps: Node.js + Express serving a static frontend (HTML + CSS + vanilla JS modules in public/) and a JSON REST API
- For static sites: Pure HTML/CSS/JS with no backend
- For React apps: Vite + React (JavaScript), add Express API only if needed
- Data storage: JSON files or in-memory for simplicity
- The server MUST listen on process.env.PORT (fallback 3000) and host 127.0.0.1
- "npm start" must start the app
- Use CommonJS or ESM consistently
- Only well-known npm packages with exact versions`,
    outputFormat: `{"stack":"...","summary":"...","runtime":"node|static|python|other","commands":{"install":"npm install","dev":"npm run dev","build":"","test":"","start":"npm start"},"files":[{"path":"server.js","purpose":"Express server"},{"path":"public/index.html","purpose":"Main page"}],"api":[{"method":"GET","path":"/api/products","description":"Get products"}],"conventions":["Use relative paths","Semantic HTML","Responsive CSS"],"packageJson":{"name":"...","version":"1.0.0","scripts":{"start":"node server.js"},"dependencies":{"express":"4.21.2"}}}

Set packageJson to null for static sites. List every file to be created (8-25 files).`,
    runtimeOptions: ['node', 'static', 'python'],
    requiresPackageJson: true,
    requiresServer: true,
  };
}

function getWindowsArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for WINDOWS DESKTOP applications. Define a Windows-native architecture using appropriate technologies (WinUI 3, WPF, .NET, or Electron if cross-platform is needed).',
    stackGuidance: `Choose the appropriate Windows stack:
- For native Windows apps: C# + WinUI 3 or WPF with .NET 6+
- For cross-platform desktop: Electron with Node.js backend
- For simple tools: .NET Console application
- Project structure: Use standard Visual Studio/MSBuild layout
- Entry point: Program.cs or Main.xaml (WPF) or main.js (Electron)
- Packaging: Target .exe output with installer (optional)
- Use standard Windows conventions: AppData for user data, proper window management
- Commands: "dotnet build" for .NET, "npm start" for Electron`,
    outputFormat: `{"stack":"C# + WinUI 3 / .NET 8 / Electron + React","summary":"...","runtime":"dotnet|node|other","commands":{"install":"dotnet restore / npm install","build":"dotnet build / npm run build","test":"dotnet test","start":"dotnet run / npm start"},"files":[{"path":"Program.cs / main.js","purpose":"Application entry point"},{"path":"MainWindow.xaml / index.html","purpose":"Main UI"}],"api":[],"conventions":["Windows file paths","AppData storage","Native UI patterns"],"packageJson":null}

For .NET projects, set packageJson to null. For Electron, include package.json. List 5-15 files.`,
    runtimeOptions: ['dotnet', 'node', 'other'],
    requiresPackageJson: false,
    requiresServer: false,
  };
}

function getAndroidArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for ANDROID mobile applications. Define an Android app architecture using Kotlin and modern Android development practices (Jetpack Compose preferred).',
    stackGuidance: `Android architecture requirements:
- Language: Kotlin (preferred) or Java
- UI: Jetpack Compose for modern apps, XML layouts for traditional
- Build system: Gradle with Android Gradle Plugin
- Project structure: Standard Android Studio layout (app/src/main/java, res/)
- Entry point: MainActivity.kt
- Manifest: AndroidManifest.xml with required permissions
- Build output: app-debug.apk or app-release.apk
- Min SDK: API 24 (Android 7.0) or higher for broad compatibility
- Target SDK: Latest stable Android API
- Dependencies: androidx libraries, Material Design components
- Commands: "./gradlew build" to build, "./gradlew installDebug" to install`,
    outputFormat: `{"stack":"Kotlin + Jetpack Compose + Android SDK","summary":"...","runtime":"android","commands":{"install":"","build":"./gradlew build","test":"./gradlew test","start":""},"files":[{"path":"app/src/main/java/com/example/app/MainActivity.kt","purpose":"Main activity"},{"path":"app/src/main/AndroidManifest.xml","purpose":"App manifest"},{"path":"app/build.gradle","purpose":"App-level Gradle config"},{"path":"build.gradle","purpose":"Project-level Gradle config"}],"api":[],"conventions":["Kotlin coding conventions","Material Design","MVVM architecture"],"packageJson":null}

List 8-15 key files including MainActivity, manifest, Gradle files, and core screens.`,
    runtimeOptions: ['android'],
    requiresPackageJson: false,
    requiresServer: false,
  };
}

function getIOSArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for iOS mobile applications. Define an iOS app architecture using Swift and SwiftUI or UIKit.',
    stackGuidance: `iOS architecture requirements:
- Language: Swift 5+
- UI: SwiftUI (modern, declarative) or UIKit (traditional)
- Build system: Xcode project with Swift Package Manager for dependencies
- Project structure: Xcode project layout
- Entry point: App.swift (SwiftUI) or AppDelegate.swift (UIKit)
- Bundle: Info.plist with app configuration
- Build output: .ipa file or Xcode archive
- Min iOS version: iOS 15+ for SwiftUI, iOS 13+ for broader support
- Dependencies: Swift packages (Alamofire, etc.) or CocoaPods
- Commands: "xcodebuild" for command-line builds`,
    outputFormat: `{"stack":"Swift + SwiftUI + iOS SDK","summary":"...","runtime":"ios","commands":{"install":"","build":"xcodebuild -scheme AppName -sdk iphoneos","test":"xcodebuild test","start":""},"files":[{"path":"AppName/AppNameApp.swift","purpose":"App entry point"},{"path":"AppName/ContentView.swift","purpose":"Main view"},{"path":"AppName/Info.plist","purpose":"App configuration"},{"path":"AppName.xcodeproj/project.pbxproj","purpose":"Xcode project"}],"api":[],"conventions":["Swift style guide","Apple HIG compliance","SwiftUI best practices"],"packageJson":null}

List 6-12 key files including app entry, main views, and Xcode project.`,
    runtimeOptions: ['ios'],
    requiresPackageJson: false,
    requiresServer: false,
  };
}

function getMacOSArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for macOS desktop applications. Define a macOS app architecture using Swift/SwiftUI or Electron.',
    stackGuidance: `macOS architecture requirements:
- For native apps: Swift + SwiftUI or AppKit
- For cross-platform: Electron + Node.js
- Build system: Xcode (native) or npm (Electron)
- Entry point: App.swift or main.js
- Bundle: .app bundle with Info.plist
- Min macOS version: macOS 12+ (Monterey) for SwiftUI
- Native features: Menu bar, dock, notifications, file system access
- Packaging: DMG installer or .app bundle
- Commands: "xcodebuild" or "npm start"`,
    outputFormat: `{"stack":"Swift + SwiftUI / Electron + React","summary":"...","runtime":"macos|node","commands":{"install":"npm install","build":"xcodebuild / npm run build","test":"xcodebuild test","start":"npm start"},"files":[{"path":"AppName/AppNameApp.swift","purpose":"App entry"},{"path":"AppName/ContentView.swift","purpose":"Main view"}],"api":[],"conventions":["macOS HIG","SwiftUI patterns"],"packageJson":null}

For native apps set packageJson to null. For Electron include package.json.`,
    runtimeOptions: ['macos', 'node'],
    requiresPackageJson: false,
    requiresServer: false,
  };
}

function getLinuxArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for LINUX desktop applications. Define a Linux app architecture using GTK, Qt, or Electron.',
    stackGuidance: `Linux desktop architecture:
- For native apps: GTK4 (C/Python/Rust), Qt (C++/Python), or Electron
- Build system: Meson/CMake (native) or npm (Electron)
- Entry point: main.c/main.py or main.js
- Packaging: .deb, .rpm, AppImage, Flatpak, or binary
- Desktop file: .desktop entry for application menu
- Following XDG standards for config and data storage
- Commands depend on toolkit chosen`,
    outputFormat: `{"stack":"Python + GTK4 / Electron + React","summary":"...","runtime":"python|node|other","commands":{"install":"pip install / npm install","build":"meson build / npm run build","test":"pytest / npm test","start":"python main.py / npm start"},"files":[{"path":"main.py","purpose":"Application entry"},{"path":"app.desktop","purpose":"Desktop entry"}],"api":[],"conventions":["XDG standards","GTK/Qt guidelines"],"packageJson":null}

Choose appropriate technology based on requirements. List 5-12 files.`,
    runtimeOptions: ['python', 'node', 'other'],
    requiresPackageJson: false,
    requiresServer: false,
  };
}

function getCLIArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for COMMAND-LINE tools. Define a CLI architecture that is cross-platform, has clear argument parsing, and proper error handling.',
    stackGuidance: `CLI tool architecture:
- Language: Node.js (JavaScript/TypeScript), Python, Rust, or Go
- Entry point: main.js/main.py/main.rs with shebang if needed
- Argument parsing: commander/yargs (Node), argparse (Python), clap (Rust)
- Output: stdout for normal output, stderr for errors
- Exit codes: 0 for success, non-zero for errors
- Help text: --help/-h flag must work
- Version: --version/-v flag
- Configuration: dotfiles, config files, or environment variables
- Installation: npm global, pip install, or standalone binary
- Commands: Define main command and subcommands if needed`,
    outputFormat: `{"stack":"Node.js + Commander / Python + argparse","summary":"...","runtime":"node|python|rust|other","commands":{"install":"npm install -g . / pip install .","build":"","test":"npm test / pytest","start":"node cli.js / python cli.py"},"files":[{"path":"cli.js / cli.py","purpose":"CLI entry point"},{"path":"lib/commands.js","purpose":"Command handlers"},{"path":"package.json / setup.py","purpose":"Package config"}],"api":[],"conventions":["POSIX conventions","Clear error messages","Help documentation"],"packageJson":{"name":"...","bin":{"toolname":"cli.js"}}}

For Node.js CLIs, include bin field in package.json. List 4-10 files.`,
    runtimeOptions: ['node', 'python', 'rust', 'other'],
    requiresPackageJson: true,
    requiresServer: false,
  };
}

function getBackendArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for BACKEND services and APIs. Define a backend architecture for server-side applications, microservices, or REST/GraphQL APIs.',
    stackGuidance: `Backend/API architecture:
- Framework: Express (Node.js), FastAPI (Python), Spring Boot (Java), or similar
- Entry point: server.js/main.py/main.go
- API design: RESTful endpoints or GraphQL schema
- Port: Configurable via environment variable (process.env.PORT)
- Database: SQLite for local dev, or connection to PostgreSQL/MongoDB
- Authentication: JWT or session-based if needed
- CORS: Configure for frontend access
- Logging: Structured logging (Winston, Python logging)
- Error handling: Proper HTTP status codes and error responses
- Testing: Integration tests for endpoints
- Documentation: OpenAPI/Swagger spec
- Commands: start server, run migrations, run tests`,
    outputFormat: `{"stack":"Node.js + Express / Python + FastAPI","summary":"...","runtime":"node|python|other","commands":{"install":"npm install / pip install -r requirements.txt","dev":"npm run dev / uvicorn main:app --reload","build":"","test":"npm test / pytest","start":"node server.js / python main.py"},"files":[{"path":"server.js / main.py","purpose":"Server entry point"},{"path":"routes/api.js","purpose":"API routes"},{"path":"models/","purpose":"Data models"},{"path":".env.example","purpose":"Environment template"}],"api":[{"method":"GET","path":"/api/health","description":"Health check"},{"method":"GET","path":"/api/items","description":"List items"}],"conventions":["REST principles","Error handling","Input validation"],"packageJson":{"name":"...","scripts":{"start":"node server.js"}}}

Define clear API contract. List 8-15 files including routes, models, middleware.`,
    runtimeOptions: ['node', 'python', 'other'],
    requiresPackageJson: true,
    requiresServer: true,
  };
}

function getLibraryArchitecture(): PlatformArchitectureGuidance {
  return {
    systemPrompt: 'You are the SWARM Architect for reusable LIBRARIES and SDKs. Define a library architecture that is well-structured, documented, and easy to consume.',
    stackGuidance: `Library/SDK architecture:
- Entry point: index.js/index.ts/__init__.py/lib.rs
- Module structure: Clear public API with internal modules
- Type definitions: TypeScript .d.ts files or Python type hints
- Build output: Compiled/bundled code for distribution
- Package: npm package, Python package (wheel/sdist), Rust crate, etc.
- Documentation: README, API docs, usage examples
- Testing: Unit tests with good coverage
- Versioning: Semantic versioning
- Export: Clean module exports with clear public API
- No executable: Library doesn't run, it's imported
- Commands: build, test, publish`,
    outputFormat: `{"stack":"TypeScript + Rollup / Python package","summary":"...","runtime":"node|python|rust|other","commands":{"install":"npm install","build":"npm run build / python -m build","test":"npm test / pytest","start":""},"files":[{"path":"src/index.ts","purpose":"Main export"},{"path":"src/core.ts","purpose":"Core functionality"},{"path":"README.md","purpose":"Documentation"},{"path":"package.json / setup.py","purpose":"Package config"}],"api":[],"conventions":["Semantic versioning","Clear exports","Comprehensive tests"],"packageJson":{"name":"...","main":"dist/index.js","types":"dist/index.d.ts"}}

Focus on clean API design and documentation. List 5-12 files.`,
    runtimeOptions: ['node', 'python', 'rust', 'other'],
    requiresPackageJson: true,
    requiresServer: false,
  };
}

/**
 * Get platform-specific file suggestions
 */
export function getPlatformSpecificFiles(platform: PlatformType | null): string[] {
  switch (platform) {
    case 'web':
      return ['index.html', 'styles.css', 'app.js', 'server.js', 'package.json'];
    case 'windows':
      return ['Program.cs', 'MainWindow.xaml', 'App.xaml', 'App.config'];
    case 'android':
      return ['MainActivity.kt', 'AndroidManifest.xml', 'build.gradle', 'strings.xml'];
    case 'ios':
      return ['AppNameApp.swift', 'ContentView.swift', 'Info.plist'];
    case 'cli':
      return ['cli.js', 'commands.js', 'package.json', 'README.md'];
    case 'backend':
    case 'api':
      return ['server.js', 'routes.js', 'models.js', '.env.example', 'package.json'];
    case 'library':
      return ['index.ts', 'package.json', 'README.md', 'test.ts'];
    default:
      return [];
  }
}
