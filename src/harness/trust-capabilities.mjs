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
      "reference": "dist/harness/acceptance/migration-v2-export-pem-win32-declared.json",
      "sha256": "f628d4e546188be44da6c541661ced7dec23d32f3e139500bd1d9b2aa8ad5202",
      "subjectSha256": "9662a48d0404fd20bb44185f0549c3e79997c61cd14ba4f3cd327b6be272132e"
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
      "reference": "dist/harness/acceptance/migration-v2-export-pem-win32-off.json",
      "sha256": "2c4798f6dda46ff5c7ac4b797b100567bb1e7b28d44adf1752da977e4019fba5",
      "subjectSha256": "59972164a3300017253baddcee21a896e5b9d69220c80beb6f8c8802d13d483f"
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
      "reference": "dist/harness/acceptance/migration-v2-export-p7b-win32-declared.json",
      "sha256": "0f5493fdef0e0c1fa4379f5e91c829bffc2679534b0e559508064c919e8f04fa",
      "subjectSha256": "395d8d66c323f77294f6eacc297e52bf2aa6b82f41d04f12804b2d307958c169"
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
      "reference": "dist/harness/acceptance/migration-v2-export-p7b-win32-off.json",
      "sha256": "2e50bcc86b37e1c5afe33f40faaaff91e88849df399a6dec0dd893a80a5cb5e3",
      "subjectSha256": "4707d85ba5d5d188e1a33e43768a238a17a51f2906ce0bc45e5da30a3517cb50"
    }
  },
  {
    "id": "export-pem-win32-26340-9767-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 26H2 build 26340.9767",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/migration-v2-export-pem-win32-26340-9767-declared.json",
      "sha256": "6b7706449673bf2865e073efebf9e860a1adf0092f4cdffc1413b76fa7e604f5",
      "subjectSha256": "1c5f80b4761000112a980099ed8375c1c804415f28b634651fa657c854ec64f4"
    }
  },
  {
    "id": "export-pem-win32-26340-9767-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 26H2 build 26340.9767",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/migration-v2-export-pem-win32-26340-9767-off.json",
      "sha256": "a7361071db7fb7c7d02c357e2f512c80f4377c1b52c682c11e8e9eb0abf014a8",
      "subjectSha256": "8b2a53fb3ed5228a7758a9bfcf771427a4a7017d48c138b0b1267893d2cd7b27"
    }
  },
  {
    "id": "export-p7b-win32-26340-9767-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 26H2 build 26340.9767",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/migration-v2-export-p7b-win32-26340-9767-declared.json",
      "sha256": "06791fa319826f4a81543116c38a2ef6a61b0bcb4115641e399441987682d4b8",
      "subjectSha256": "59928e9df849ae31abbc60fc60f4d9612ea1252e5ee08e2b584e8753b9e0afe1"
    }
  },
  {
    "id": "export-p7b-win32-26340-9767-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 26H2 build 26340.9767",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/migration-v2-export-p7b-win32-26340-9767-off.json",
      "sha256": "1302aeddf7d8fae06c22918fb353d3077e48d42795a8ec9ac6469040fdce18bf",
      "subjectSha256": "55e75c5206b0195250b6c38c28c2ca46ff678cc83a02bae6d147074a5f99e12f"
    }
  },
  {
    "id": "export-pem-win32-29695-1001-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 Dev build 29695.1001",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-pem-win32-29695-1001-declared.json",
      "sha256": "f28829b882c152e5085b1e54e54e0da96cfe20ebf4b2fa75bdf18f128961cc1a",
      "subjectSha256": "f761a75169c4f78e90ce0ad5fe9adda5e6231bcd9d4b112a7f566c8b34dc6ebc"
    }
  },
  {
    "id": "export-pem-win32-29695-1001-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 Dev build 29695.1001",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pem-server-ca-v1",
    "probeProfile": "export-pem-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-pem-win32-29695-1001-off.json",
      "sha256": "74de8c8c01b233bb852087111c4b5ff65a992c66e460723722bea09a7e4c0073",
      "subjectSha256": "59473463a0555dbf880a2d341601e5f7996a80792f7b796d07f2fbb1117fcd0a"
    }
  },
  {
    "id": "export-p7b-win32-29695-1001-declared",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 Dev build 29695.1001",
      "architecture": "x64"
    },
    "network": "declared",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-p7b-win32-29695-1001-declared.json",
      "sha256": "b101ed5278a7ccb7a6ceef5ad89f97d8f61f9c870aeca9e244af0acf6e9db4bc",
      "subjectSha256": "521278519bd3204d2651646fc9dae739f523e79393db27a41c0294cc4275d653"
    }
  },
  {
    "id": "export-p7b-win32-29695-1001-off",
    "definitionId": "certificate-export",
    "route": "export",
    "target": null,
    "platform": {
      "os": "win32",
      "release": "Windows 11 Dev build 29695.1001",
      "architecture": "x64"
    },
    "network": "off",
    "projection": "windows-effective-server-auth-v1",
    "client": null,
    "configurationProfile": "pkcs7-certificate-import-v1",
    "probeProfile": "export-p7b-parse-v1",
    "launchContext": "no-client",
    "evidence": {
      "reference": "dist/harness/acceptance/export-p7b-win32-29695-1001-off.json",
      "sha256": "fca20fd0b63aeebcd642b6fdd3c581f8ad55fd6eb99a48ff57d995272fa46d27",
      "subjectSha256": "d8cc1519ba393f013d1af2d492943ae03bb027f0aafc6825cf54198e0112f1b5"
    }
  }
]);
