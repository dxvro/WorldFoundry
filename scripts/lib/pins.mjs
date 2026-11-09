// Pinned third-party components. Changes here are deliberate decisions.

// WinSW (MIT): turns node.exe into a Windows service. Version 2.12.0 is the last stable version
// (3.x is only published as an alpha). The project does not publish checksums; the SHA-256
// was computed from the GitHub release v2.12.0 when it was entered and has been the pinned value ever since.
export const WINSW = {
  version: '2.12.0',
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  fileName: 'WinSW-x64-v2.12.0.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  // github.com redirects to release-assets.githubusercontent.com
  allowedHosts: ['github.com', 'githubusercontent.com'],
  license: 'MIT',
};

export const NODE_ALLOWED_HOSTS = ['nodejs.org'];

export const NPM_REGISTRY_HOSTS = ['registry.npmjs.org'];
