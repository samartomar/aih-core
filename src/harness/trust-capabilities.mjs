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
      "sha256": "2d64d7b28908c4dd8e673dde609d63a5f28b8baa6b58863e045c59a8861028fa",
      "subjectSha256": "0b43f28b59c7cd627189409f1d210a56e1d99801eea213036d52a7798639b204"
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
      "sha256": "17e14663ae9a10d92158a423a8e5b6769f7467bbf14e23a453ba5b3930a91977",
      "subjectSha256": "57e60aeb4a56ecefafdfba26babe7e80e2a56a7497c5369dcc24a94463251bfd"
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
      "sha256": "16569d02a4cd2bb890fcbbd02f62078aa9225134ea57728258514794de8f7c70",
      "subjectSha256": "61c8571a8bad42f9ca25916596dcbf7a7aec5471dad6b8d9833f00f1c99e70e0"
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
      "sha256": "617cc6b1fae0d9444fba51e2fa857ffac404a47bbf5743488d839f8244684afe",
      "subjectSha256": "7d02cf622208aa6a2e780fdf812e7a898c990a489a0b019d75bc32ed52bd9fb7"
    }
  }
]);
