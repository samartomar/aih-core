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
      "sha256": "0176dadd1aa5c481bae9de300aef72ebebe1960b9d7449061af4423a564dfdb9",
      "subjectSha256": "bcb018e0ef54c99d0954eaeb3f08dd13be1128c6ab1293fa80e77d16589d5b9a"
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
      "sha256": "c9b09ac02acc691158b39d69163f8b737c83cd02b9be259492fe998c0927a7f1",
      "subjectSha256": "67d9c1934a1b3329e54202eba53a4ec2bc11daaf3061bb1dc33964c37e0397a3"
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
      "sha256": "203f2d722f1c875b8ac990071707569024f09aa9fab2fe36f73b33233b4015c9",
      "subjectSha256": "49ad05d98429cdf1c24da141170cd9f82846391d38cad05a5de6a963231c6699"
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
      "sha256": "9afcc78f769ce2265e807f994dc335f6edbc59826e85afc01b60df9b34565721",
      "subjectSha256": "9e4b71a23f64bc7a45cbf66343acd454b450ec5271a4d76493eca27c80487c77"
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
      "reference": "dist/harness/acceptance/export-pem-win32-26340-9767-declared.json",
      "sha256": "99d814929c6dad4ea9ac1b444746e0df29c097ea56f2f19cd4347fe84b75007c",
      "subjectSha256": "b7290090cc617d45024392e7a0637261158324a6efe051eeb289ec162fe1244f"
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
      "reference": "dist/harness/acceptance/export-pem-win32-26340-9767-off.json",
      "sha256": "f767e5ae622f40904b13877811c9f9dde952bf3ea43383e60cabd72c898064c6",
      "subjectSha256": "4cd083bd25e0fa1e922330db68fa21964b6c1eb6ae5ae89c8afae771abe81a3e"
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
      "reference": "dist/harness/acceptance/export-p7b-win32-26340-9767-declared.json",
      "sha256": "2deb31be94ef66ce0a24eabaee3891246287f067073cea9eac1c91639e8e48ac",
      "subjectSha256": "bd4c1b2e68cd2414c7a666dfbf191d88d4b325ea2e6f162f82053a8a6bfe2e54"
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
      "reference": "dist/harness/acceptance/export-p7b-win32-26340-9767-off.json",
      "sha256": "18972c941ff6ad037dd6dea96d0560421db53b15390ee9a8a4bbb82a5a7a3b1a",
      "subjectSha256": "9bc1bf1a2e2734aa25f890cd3090d50b26f7892ef4b0b392a9f607afcd6032e9"
    }
  }
]);
