// Exact tested supplied-format/profile admission; OS/native repair remains unavailable.
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
      "sha256": "19dfc3a9f571cd010fcdd9260696bb77a4a6d9723223f3cb27857d73a1d94617",
      "subjectSha256": "f726cbdd21b762f248091745aeef80ca01ada16bd7f503bb8e4f096b5dd41bfa"
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
      "sha256": "1df805b4d1e320e53137b2ccf5c9c3d8d6e71d622498d6e1df785aa912dcbdc5",
      "subjectSha256": "d0516d20bc2e8c35b72552045afba6c1ab1ceb32752972e8f85d03be25a51060"
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
      "sha256": "c10eb911dc35d2815a73a55fbec9c49350c5e41b1c989261808015fa2f759045",
      "subjectSha256": "5d0a59c9714b1efedadb1a5b4aed3e7858b4279a0521e31dbc41d0e7dbe2aa36"
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
      "sha256": "eaeffa86ab01bc7e8f05c27e281dfe2077f3fa72554e34cdf93ccb8f411c6bd6",
      "subjectSha256": "b58349926f6bf1db01e0f1892d6706beeba6062869fc30b6f2dad8ad7f948c34"
    }
  }
]);
