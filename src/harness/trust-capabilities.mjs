// Static admission data: excluded from helper/evidence subject hashing.
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
      "reference": "dist/harness/acceptance/migration-export-pem-win32-declared.json",
      "sha256": "f5a3d25212b21c717677d303ab714fb851cd055ab55761f7de6f73a8ed2fdcf7",
      "subjectSha256": "5cead79af2874ec9956ca695339cb807e059cffa95fbb94506ae33af194151cf"
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
      "reference": "dist/harness/acceptance/migration-export-pem-win32-off.json",
      "sha256": "ad86c664d4b16b5642235c02ea7695be0d5b1265d871e7ce9b447a8aa352c010",
      "subjectSha256": "e4be609e7770e9dffe3912f190b5d1f5dbe631e28195736aaae60c9381a37442"
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
      "reference": "dist/harness/acceptance/migration-export-p7b-win32-declared.json",
      "sha256": "a87e411bfdc7b1dcbe8bdbfe31d221e876b2b73e89af1f91da52f2a96177331c",
      "subjectSha256": "a9b2d08e43509877bdaabc5bbb12fc8d153d0ec8295626b909ef68b9986521be"
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
      "reference": "dist/harness/acceptance/migration-export-p7b-win32-off.json",
      "sha256": "78d733214e926bd7739fdc04580bdf0c94755a1a84999178bc05bda9149ffe56",
      "subjectSha256": "b659509452980a92946da6a209c3b8a0d7e1a0fbe9c83a531ecdb9fde22b09ec"
    }
  }
]);
