export declare function observeMacosSessionPlatform(signal?: AbortSignal): Promise<
  { status: 'observed'; platform: { os: 'darwin'; release: string; build: string; architecture: 'arm64' | 'x64' } } |
  { status: 'cancelled'; reason: 'cancelled' } |
  { status: 'unavailable'; reason: 'session-platform-unsupported' }
>;
