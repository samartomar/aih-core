// Exact tested format/profile admission. OS discovery and actual client admission remain separate gates.
// This data is excluded from its own evidence subject. Records contain only executed outcomes.
export const trustCellRecords = Object.freeze([
  {
    "id": "export-pem-win32-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 25H2",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-pem-win32-declared.json",
      "sha256": "e01023a07cb5cfb8c32f265a16ed1f61d6ffbccfa07222d71de3752626311c77",
      "subjectSha256": "cf66572d342a9730b1d3724b05ebbc24f74e710eb72e27570651c2fdf5e85a3b"
    }
  },
  {
    "id": "export-pem-win32-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 25H2",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-pem-win32-off.json",
      "sha256": "c16070d31bee7f79a83d811654d8fad0a9fab675bc0d604eabe87d16488575c5",
      "subjectSha256": "4416cdb0e4d9d7b16e1af0a7ba395a44284571e1db56555e4bd0f380f03fc473"
    }
  },
  {
    "id": "export-p7b-win32-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 25H2",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-p7b-win32-declared.json",
      "sha256": "a25ca8e963831d38c2ee3f9765df9301660b03739d032b83003bfebf79d09969",
      "subjectSha256": "e120e56f86cf8e665aca0133a4350ed07955ae3e27727aae9e949340ea48230e"
    }
  },
  {
    "id": "export-p7b-win32-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 25H2",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-p7b-win32-off.json",
      "sha256": "83ba63bb6bb250c8947227efc6c7e3bfcef67067f31c2d45f77c32e84e3edcac",
      "subjectSha256": "67c333b60528244d4c6ee847e38db8a0f94771ebab32f2a55493fb5a9370d92c"
    }
  }
]);
