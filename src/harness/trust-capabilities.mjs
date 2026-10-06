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
      "sha256": "1996c3ac3e7bf22c7d65e29321ca20cacbb06b99f9cfb1eb4b894fedb5a7990a",
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
      "sha256": "2d3486d8b8d9812531ab0db39ee4a0c415d7f664b6ed321446e8fe3afdc49ef8",
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
      "sha256": "b19c6a49b07d5fbe518c53e1eea7cd0a5105a8fec92d4e14256b769049b6246d",
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
      "sha256": "7e7aa9346798f5349f0b017b4732877af07b56d0371a7d003771d0483f5c9684",
      "subjectSha256": "ff2106624390aa13c61c8c2e8227a8d9b779ba7a85c527b57fbdc3144799c454"
    }
  }
]);
