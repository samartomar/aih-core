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
      "sha256": "3126e578b2286aa877010b692284dbe6c17e93a5f7caeafbf8df15e9be643ad7",
      "subjectSha256": "abf61c1d3bba7afb0926dabecf7be9871a07cb0cf312f765e2815a1102394c36"
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
      "sha256": "d23a4443b06c9975e38628ffc86262a65557ad30a5c45579df74833e15368f41",
      "subjectSha256": "40ec46d98899804e6e70c1dfe7b8441d8d7443b946084663c4a013adc705563b"
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
      "sha256": "646c64f83499bf23dc1fb13c64db49babd06ba171eb1f0119d2a0a03420e632c",
      "subjectSha256": "ee4664b5da9bb3a6aeaa5db9114e36d1554967d798696c4f13672f1367c00cc5"
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
      "sha256": "3bbe237d6658ed2f56a018f546bce3bb6cc22fdfd948d78de9d58a8aafd72953",
      "subjectSha256": "cdea005a97cc5c3583acb5574b8b7992a1ca2a5e8111531e835d22ea25aa740b"
    }
  }
]);
