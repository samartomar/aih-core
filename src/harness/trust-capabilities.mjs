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
      "sha256": "076b4726df21863ba4124ecdeeec7f4fb650bc8f24d0d2aeee6b4ba875b84fec",
      "subjectSha256": "ee7e8d9339d2c28e6205cec42dd7e483678239e59ffe0627709d38449bb87733"
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
      "sha256": "bebc6c54bb00fb0a57dbcd12e1a9e4ef6b1013b8e43ad35712bdbc9e11028c5e",
      "subjectSha256": "2ee21bc6cbd460c239ee8c6303415e64c6ee6393c44e1187b257c67d627829ec"
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
      "sha256": "39d28d706ab3a2ba64e743656c860397dafdc702eb4db739786a4a6ad0d370a4",
      "subjectSha256": "eb73d8a8a97ce37af425e8011d29ca00694d79fc9bd72f7ad0adc03006dd6a49"
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
      "sha256": "14c0bebd96a2933c03f65c370b8fe5fd84dace6dcadb95c623c9e2e3b0765b56",
      "subjectSha256": "ff2106624390aa13c61c8c2e8227a8d9b779ba7a85c527b57fbdc3144799c454"
    }
  }
]);
