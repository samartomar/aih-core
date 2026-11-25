// Generated finite migration policy; archive hashes live outside this file.
export const trustMigrationV2Policy = Object.freeze({
  "method": "core417-serializer-v4-and-exact-export-hosts-v1",
  "predecessorFiles": [
    {
      "name": "dist/harness/trust.mjs",
      "sha256": "08b74250dc604e7a0c0ce7195ad9b522afe034efdc98e47d3f7f7b577b5e9b32"
    },
    {
      "name": "dist/harness/trust-definitions.mjs",
      "sha256": "dc7f7b0fe33bfdfec6d47901a43480f144832f69a1d68b73bcd1e79a401e2714"
    },
    {
      "name": "dist/harness/trust-encoding.mjs",
      "sha256": "4bbcd045a06dcf5f6e72ca51517da6abcbae37084e77bc310a224a94cb3d244a"
    },
    {
      "name": "dist/harness/trust-source.mjs",
      "sha256": "c27b0a1df8abf829bfbcb2e834ba771f9dea1ea460c6789dd3baec698cb5c65f"
    },
    {
      "name": "dist/harness/trust-os.mjs",
      "sha256": "23447b0e4e83636aa34f52a720442e3f01a11276b74a2fa0bb65b5367bace762"
    },
    {
      "name": "dist/harness/ca.mjs",
      "sha256": "104309705a070de304285de0a70c6fa9aa1ca2c11dec97b9913fbd404e519261"
    },
    {
      "name": "dist/harness/jvm-trust.mjs",
      "sha256": "32e15c4fec8fc54d981bc82251c041b5dfff1d8eb150a4fe955f47545d469d67"
    },
    {
      "name": "dist/harness/trust-migration.mjs",
      "sha256": "0d1fc8f08e1b86a6d3eb6a409b3786d265a367cecdba039f455c32274b0162f8"
    },
    {
      "name": "dist/harness/trust-migration-rules.mjs",
      "sha256": "324ea735dfc503090bd26465b48225c4521adf80abfa92f6ac909a68e3dc29cf"
    },
    {
      "name": "dist/harness/trust-migration-policy.mjs",
      "sha256": "cbf1c0d86d7f195bd467aa7908f1a4ca5cad69f4e6b019073ffd7b70c89808eb"
    },
    {
      "name": "dist/harness/trust-export-platform.mjs",
      "sha256": "4a0c4934fd95cf35a057243e226ef2e738951538737b4d115bfad08e94a3b417"
    },
    {
      "name": "dist/core/trust.js",
      "sha256": "b2316e28354373e0a4261a4967c8e762f6e41c5aee0121823b6fea69bcba2f37"
    }
  ],
  "currentFiles": [
    {
      "name": "dist/harness/trust.mjs",
      "sha256": "ce923a084668f292bb827e3fe8d691ab5ec9447c49816f1dde357b418b4d8247"
    },
    {
      "name": "dist/harness/trust-definitions.mjs",
      "sha256": "f3989d96543c41b8a5d396e1450ccdceab171f3dc09f1ff6e4f3a924f76653b1"
    },
    {
      "name": "dist/harness/trust-encoding.mjs",
      "sha256": "4bbcd045a06dcf5f6e72ca51517da6abcbae37084e77bc310a224a94cb3d244a"
    },
    {
      "name": "dist/harness/trust-source.mjs",
      "sha256": "c27b0a1df8abf829bfbcb2e834ba771f9dea1ea460c6789dd3baec698cb5c65f"
    },
    {
      "name": "dist/harness/trust-os.mjs",
      "sha256": "23447b0e4e83636aa34f52a720442e3f01a11276b74a2fa0bb65b5367bace762"
    },
    {
      "name": "dist/harness/ca.mjs",
      "sha256": "104309705a070de304285de0a70c6fa9aa1ca2c11dec97b9913fbd404e519261"
    },
    {
      "name": "dist/harness/jvm-trust.mjs",
      "sha256": "32e15c4fec8fc54d981bc82251c041b5dfff1d8eb150a4fe955f47545d469d67"
    },
    {
      "name": "dist/harness/trust-migration.mjs",
      "sha256": "b557b9702bc32553b2c9bda5ce2e2b194ec37ca4a2ba03d9b0b097658a11f864"
    },
    {
      "name": "dist/harness/trust-migration-rules.mjs",
      "sha256": "324ea735dfc503090bd26465b48225c4521adf80abfa92f6ac909a68e3dc29cf"
    },
    {
      "name": "dist/harness/trust-migration-policy.mjs",
      "sha256": "cbf1c0d86d7f195bd467aa7908f1a4ca5cad69f4e6b019073ffd7b70c89808eb"
    },
    {
      "name": "dist/harness/trust-export-platform.mjs",
      "sha256": "8f0f07d7c21aa79914b8e3f43520ddf89708973862f6bd48af2d992d4fe67b75"
    },
    {
      "name": "dist/core/trust.js",
      "sha256": "6c208e312080a5e7d3b279246c4b4a047dde8710a8265c413814d42a9f32366e"
    },
    {
      "name": "dist/harness/trust-migration-v2.mjs",
      "sha256": "4dd515840682eed8b56141b6a85ee95dcf9e2acd25a9ac97502a680f5285dc64"
    }
  ],
  "predecessorLibrariesSha256": "ece304995c45e5ec31a24aa33355b707c1d1c4cabe2bb199089d0bd79273e483",
  "currentLibrariesSha256": "fefea11175035d3e7d335b0a1d6daaab5339923b9b21b3c846e0dd4831045861",
  "predecessors": [
    {
      "id": "export-pem-win32-declared",
      "schema": "aih.trust.acceptance-migration.v1",
      "recordSha256": "0176dadd1aa5c481bae9de300aef72ebebe1960b9d7449061af4423a564dfdb9",
      "subjectSha256": "bcb018e0ef54c99d0954eaeb3f08dd13be1128c6ab1293fa80e77d16589d5b9a"
    },
    {
      "id": "export-pem-win32-off",
      "schema": "aih.trust.acceptance-migration.v1",
      "recordSha256": "c9b09ac02acc691158b39d69163f8b737c83cd02b9be259492fe998c0927a7f1",
      "subjectSha256": "67d9c1934a1b3329e54202eba53a4ec2bc11daaf3061bb1dc33964c37e0397a3"
    },
    {
      "id": "export-p7b-win32-declared",
      "schema": "aih.trust.acceptance-migration.v1",
      "recordSha256": "203f2d722f1c875b8ac990071707569024f09aa9fab2fe36f73b33233b4015c9",
      "subjectSha256": "49ad05d98429cdf1c24da141170cd9f82846391d38cad05a5de6a963231c6699"
    },
    {
      "id": "export-p7b-win32-off",
      "schema": "aih.trust.acceptance-migration.v1",
      "recordSha256": "9afcc78f769ce2265e807f994dc335f6edbc59826e85afc01b60df9b34565721",
      "subjectSha256": "9e4b71a23f64bc7a45cbf66343acd454b450ec5271a4d76493eca27c80487c77"
    },
    {
      "id": "export-pem-win32-26340-9767-declared",
      "schema": "aih.trust.acceptance.v1",
      "recordSha256": "99d814929c6dad4ea9ac1b444746e0df29c097ea56f2f19cd4347fe84b75007c",
      "subjectSha256": "b7290090cc617d45024392e7a0637261158324a6efe051eeb289ec162fe1244f"
    },
    {
      "id": "export-pem-win32-26340-9767-off",
      "schema": "aih.trust.acceptance.v1",
      "recordSha256": "f767e5ae622f40904b13877811c9f9dde952bf3ea43383e60cabd72c898064c6",
      "subjectSha256": "4cd083bd25e0fa1e922330db68fa21964b6c1eb6ae5ae89c8afae771abe81a3e"
    },
    {
      "id": "export-p7b-win32-26340-9767-declared",
      "schema": "aih.trust.acceptance.v1",
      "recordSha256": "2deb31be94ef66ce0a24eabaee3891246287f067073cea9eac1c91639e8e48ac",
      "subjectSha256": "bd4c1b2e68cd2414c7a666dfbf191d88d4b325ea2e6f162f82053a8a6bfe2e54"
    },
    {
      "id": "export-p7b-win32-26340-9767-off",
      "schema": "aih.trust.acceptance.v1",
      "recordSha256": "18972c941ff6ad037dd6dea96d0560421db53b15390ee9a8a4bbb82a5a7a3b1a",
      "subjectSha256": "9bc1bf1a2e2734aa25f890cd3090d50b26f7892ef4b0b392a9f607afcd6032e9"
    }
  ],
  "proof": {
    "method": "core417-serializer-v4-and-exact-export-hosts-v1",
    "predecessorCommit": "e0410a0edd3d76cb4bc0615c0f28b56c311fe4a2",
    "predecessorPackage": {
      "name": "@aihq/core",
      "version": "0.0.0-dev.1",
      "tgzSha256": "ffb3c403d0a3f42ee6f4bd354e4415e4742744e42651bd31921cf2dac29c28e9",
      "tgzSize": 7731830
    },
    "predecessorFiles": [
      {
        "name": "dist/harness/trust.mjs",
        "sha256": "08b74250dc604e7a0c0ce7195ad9b522afe034efdc98e47d3f7f7b577b5e9b32"
      },
      {
        "name": "dist/harness/trust-definitions.mjs",
        "sha256": "dc7f7b0fe33bfdfec6d47901a43480f144832f69a1d68b73bcd1e79a401e2714"
      },
      {
        "name": "dist/harness/trust-encoding.mjs",
        "sha256": "4bbcd045a06dcf5f6e72ca51517da6abcbae37084e77bc310a224a94cb3d244a"
      },
      {
        "name": "dist/harness/trust-source.mjs",
        "sha256": "c27b0a1df8abf829bfbcb2e834ba771f9dea1ea460c6789dd3baec698cb5c65f"
      },
      {
        "name": "dist/harness/trust-os.mjs",
        "sha256": "23447b0e4e83636aa34f52a720442e3f01a11276b74a2fa0bb65b5367bace762"
      },
      {
        "name": "dist/harness/ca.mjs",
        "sha256": "104309705a070de304285de0a70c6fa9aa1ca2c11dec97b9913fbd404e519261"
      },
      {
        "name": "dist/harness/jvm-trust.mjs",
        "sha256": "32e15c4fec8fc54d981bc82251c041b5dfff1d8eb150a4fe955f47545d469d67"
      },
      {
        "name": "dist/harness/trust-migration.mjs",
        "sha256": "0d1fc8f08e1b86a6d3eb6a409b3786d265a367cecdba039f455c32274b0162f8"
      },
      {
        "name": "dist/harness/trust-migration-rules.mjs",
        "sha256": "324ea735dfc503090bd26465b48225c4521adf80abfa92f6ac909a68e3dc29cf"
      },
      {
        "name": "dist/harness/trust-migration-policy.mjs",
        "sha256": "cbf1c0d86d7f195bd467aa7908f1a4ca5cad69f4e6b019073ffd7b70c89808eb"
      },
      {
        "name": "dist/harness/trust-export-platform.mjs",
        "sha256": "4a0c4934fd95cf35a057243e226ef2e738951538737b4d115bfad08e94a3b417"
      },
      {
        "name": "dist/core/trust.js",
        "sha256": "b2316e28354373e0a4261a4967c8e762f6e41c5aee0121823b6fea69bcba2f37"
      }
    ],
    "currentFiles": [
      {
        "name": "dist/harness/trust.mjs",
        "sha256": "ce923a084668f292bb827e3fe8d691ab5ec9447c49816f1dde357b418b4d8247"
      },
      {
        "name": "dist/harness/trust-definitions.mjs",
        "sha256": "f3989d96543c41b8a5d396e1450ccdceab171f3dc09f1ff6e4f3a924f76653b1"
      },
      {
        "name": "dist/harness/trust-encoding.mjs",
        "sha256": "4bbcd045a06dcf5f6e72ca51517da6abcbae37084e77bc310a224a94cb3d244a"
      },
      {
        "name": "dist/harness/trust-source.mjs",
        "sha256": "c27b0a1df8abf829bfbcb2e834ba771f9dea1ea460c6789dd3baec698cb5c65f"
      },
      {
        "name": "dist/harness/trust-os.mjs",
        "sha256": "23447b0e4e83636aa34f52a720442e3f01a11276b74a2fa0bb65b5367bace762"
      },
      {
        "name": "dist/harness/ca.mjs",
        "sha256": "104309705a070de304285de0a70c6fa9aa1ca2c11dec97b9913fbd404e519261"
      },
      {
        "name": "dist/harness/jvm-trust.mjs",
        "sha256": "32e15c4fec8fc54d981bc82251c041b5dfff1d8eb150a4fe955f47545d469d67"
      },
      {
        "name": "dist/harness/trust-migration.mjs",
        "sha256": "b557b9702bc32553b2c9bda5ce2e2b194ec37ca4a2ba03d9b0b097658a11f864"
      },
      {
        "name": "dist/harness/trust-migration-rules.mjs",
        "sha256": "324ea735dfc503090bd26465b48225c4521adf80abfa92f6ac909a68e3dc29cf"
      },
      {
        "name": "dist/harness/trust-migration-policy.mjs",
        "sha256": "cbf1c0d86d7f195bd467aa7908f1a4ca5cad69f4e6b019073ffd7b70c89808eb"
      },
      {
        "name": "dist/harness/trust-export-platform.mjs",
        "sha256": "8f0f07d7c21aa79914b8e3f43520ddf89708973862f6bd48af2d992d4fe67b75"
      },
      {
        "name": "dist/core/trust.js",
        "sha256": "6c208e312080a5e7d3b279246c4b4a047dde8710a8265c413814d42a9f32366e"
      },
      {
        "name": "dist/harness/trust-migration-v2.mjs",
        "sha256": "4dd515840682eed8b56141b6a85ee95dcf9e2acd25a9ac97502a680f5285dc64"
      }
    ],
    "transitions": [
      {
        "name": "dist/core/trust.js",
        "steps": 2
      },
      {
        "name": "dist/harness/trust-definitions.mjs",
        "steps": 1
      },
      {
        "name": "dist/harness/trust-export-platform.mjs",
        "steps": 2
      },
      {
        "name": "dist/harness/trust-migration.mjs",
        "steps": 5
      },
      {
        "name": "dist/harness/trust.mjs",
        "steps": 5
      }
    ],
    "coreTransition": {
      "predecessorSourceSha256": "7a0d7b2ef16c340aabb8b60f9deab9d647f061bc8dccd1d7382f055f25abef05",
      "currentSourceSha256": "b83eea5f2409936c40b2c0dc4e986c70130393456cb7c2335fb219828b60485b"
    },
    "libraries": {
      "predecessor": {
        "sha256": "ece304995c45e5ec31a24aa33355b707c1d1c4cabe2bb199089d0bd79273e483",
        "packages": [
          {
            "name": "pkijs",
            "version": "3.4.1",
            "sha256": "0c35341c6914f562af0adac901ee1f0e41436375eda07367b74287b7833e863c"
          },
          {
            "name": "asn1js",
            "version": "3.0.10",
            "sha256": "1a43b6fbaf84994728902a86598d1c10073917da4692eb8944d2142c6f92c29d"
          },
          {
            "name": "pvtsutils",
            "version": "1.3.6",
            "sha256": "847a2ec6dd93068ad5d3edb2009d3834d465bafe9cb678784e3e94d7c15f15cf"
          },
          {
            "name": "pvutils",
            "version": "1.2.0",
            "sha256": "2c94e88a49e5a3efcf165e0fb3c5aa22fca1585387a33d91f8cdb4f8e73d0a16"
          },
          {
            "name": "bytestreamjs",
            "version": "2.0.1",
            "sha256": "7cf730f78ee3c5aa2459c34f02ca10729c81363b26b8ff1adffe4a3a977810a8"
          },
          {
            "name": "tslib",
            "version": "2.8.1",
            "sha256": "0a744016c8bdd0bf34ee037290315a898c1c99b81ab0d2baf9a007cf56f7f992"
          },
          {
            "name": "@noble/hashes",
            "version": "1.8.0",
            "sha256": "42ddb8c6cba80ca7e6b279019879f20b1f1f1d6e85b8890d17b21a0a0274945b"
          }
        ]
      },
      "current": {
        "sha256": "fefea11175035d3e7d335b0a1d6daaab5339923b9b21b3c846e0dd4831045861",
        "packages": [
          {
            "name": "pkijs",
            "version": "4.0.1",
            "sha256": "4f5daea8401d958e1e565207788b9eddf622de716f6e33d2e2bf12505fd9c85e"
          },
          {
            "name": "asn1js",
            "version": "4.1.0",
            "sha256": "0c8b36b7ece99e681d02aab06113903faae90a5d4c5ee24dc62f368c74eec206"
          },
          {
            "name": "bytestreamjs",
            "version": "3.0.0",
            "sha256": "3073278776921976a3b4b793e5689692fae3913ecf162bf99cea934401712f1d"
          },
          {
            "name": "@noble/hashes",
            "version": "2.4.0",
            "sha256": "0e6abb69990f152e3bdea3965a23b0152409ce69e25a958c65cd886671470b02"
          },
          {
            "name": "@peculiar/utils",
            "version": "4.1.1",
            "sha256": "bb6341e54216d5f3cf1411426926f1bfd2a6f2345726f0997363488c4b2d932f"
          }
        ]
      }
    },
    "caseComparison": {
      "fixtures": [
        {
          "name": "root-a.pem",
          "sha256": "b9b6a4c1f037bf97c561e55b55bd70d1e57a2ee566f4b752d43430931697f8c6",
          "fingerprint": "96129307aac06a73826f19834a02b39502e20f5783e566c58864db692e529bc9"
        },
        {
          "name": "root-b.pem",
          "sha256": "fb15c08be41c7c4f6951ac63e84f5cb56b25b4d1511ffd9cddbe78b42acff695",
          "fingerprint": "6c346ecccee9171b8460fa1294cc07faa48c41ce993f4ff95417e4e835ad6c01"
        }
      ],
      "profiles": {
        "export-pem-parse-v1": [
          {
            "id": "pem-deterministic-bytes",
            "kind": "positive",
            "predecessorSha256": "3d74bedf3f106b6e1acd493ed9db24ef771bdff1c49931a9c63842e4c2e6ee23",
            "currentSha256": "3d74bedf3f106b6e1acd493ed9db24ef771bdff1c49931a9c63842e4c2e6ee23",
            "identical": true
          },
          {
            "id": "pem-independent-parse-set",
            "kind": "positive",
            "predecessorSha256": "e968fd49e3f014eae88de80aaf7b9334422c9a91a3a587d84ee926cb7162f2d8",
            "currentSha256": "e968fd49e3f014eae88de80aaf7b9334422c9a91a3a587d84ee926cb7162f2d8",
            "identical": true
          },
          {
            "id": "pem-public-api-write",
            "kind": "positive",
            "predecessorSha256": "c213e6c2e2bc9035bfa34efe6bb2d050ea8eae70c349f311ba2207d466c4bcf0",
            "currentSha256": "c213e6c2e2bc9035bfa34efe6bb2d050ea8eae70c349f311ba2207d466c4bcf0",
            "identical": true
          },
          {
            "id": "pem-reject-key-material",
            "kind": "negative",
            "predecessorSha256": "a783a14695a209ea9f95dfe98fe90db6fcca64e3861d946d4612a104aa1b0b14",
            "currentSha256": "a783a14695a209ea9f95dfe98fe90db6fcca64e3861d946d4612a104aa1b0b14",
            "identical": true
          },
          {
            "id": "pem-reject-output-extension-mismatch",
            "kind": "negative",
            "predecessorSha256": "bd06a5ba9e6b788be982be9057dd67b7898a5512f3235d3f89af5a0655ab5b23",
            "currentSha256": "bd06a5ba9e6b788be982be9057dd67b7898a5512f3235d3f89af5a0655ab5b23",
            "identical": true
          },
          {
            "id": "pem-reject-unsafe-path",
            "kind": "negative",
            "predecessorSha256": "2ee90c4258ef1e7b711e7d0d6e34d33acacfb7f646f5cc9c1f998e5e3fc45bf7",
            "currentSha256": "2ee90c4258ef1e7b711e7d0d6e34d33acacfb7f646f5cc9c1f998e5e3fc45bf7",
            "identical": true
          },
          {
            "id": "pem-custody-recorded",
            "kind": "persistence",
            "predecessorSha256": "25b5816537b4151ba3344bbac8f71bd598c07976d65983f399ba550c9adda594",
            "currentSha256": "25b5816537b4151ba3344bbac8f71bd598c07976d65983f399ba550c9adda594",
            "identical": true
          },
          {
            "id": "pem-refresh-replace-reviewed",
            "kind": "persistence",
            "predecessorSha256": "2511d6aba3fb223ec3366835b43cad6a8a6bd55aa04a029a6dabb2eefaf938c2",
            "currentSha256": "2511d6aba3fb223ec3366835b43cad6a8a6bd55aa04a029a6dabb2eefaf938c2",
            "identical": true
          },
          {
            "id": "pem-removal-reconciled",
            "kind": "persistence",
            "predecessorSha256": "7e7ebbb8a8601e085651046b936003c0cd2e657b12a9867add28084a7c890614",
            "currentSha256": "7e7ebbb8a8601e085651046b936003c0cd2e657b12a9867add28084a7c890614",
            "identical": true
          }
        ],
        "export-p7b-parse-v1": [
          {
            "id": "p7b-deterministic-bytes",
            "kind": "positive",
            "predecessorSha256": "0d2b7a14888832fb8f135318f7c66eaf5ba438047b7ebd8f4c0259672ed8f1c2",
            "currentSha256": "0d2b7a14888832fb8f135318f7c66eaf5ba438047b7ebd8f4c0259672ed8f1c2",
            "identical": true
          },
          {
            "id": "p7b-independent-parse-set",
            "kind": "positive",
            "predecessorSha256": "6028972d83f91375e7e8bb8282d9f5045687e92eec66d85e31935da15f9cf1c4",
            "currentSha256": "6028972d83f91375e7e8bb8282d9f5045687e92eec66d85e31935da15f9cf1c4",
            "identical": true
          },
          {
            "id": "p7b-public-api-write",
            "kind": "positive",
            "predecessorSha256": "8e1d8ae76f22cd6f73c95ed519120463e2fb0423e86b415cd4bd1d17a3d5cd84",
            "currentSha256": "8e1d8ae76f22cd6f73c95ed519120463e2fb0423e86b415cd4bd1d17a3d5cd84",
            "identical": true
          },
          {
            "id": "p7b-custom-store-import",
            "kind": "positive",
            "predecessorSha256": "3f1f4b08a8e1902dcc5c99b5b47ffa9e3bb6dd568fcbeeb611a6d417924e9805",
            "currentSha256": "3f1f4b08a8e1902dcc5c99b5b47ffa9e3bb6dd568fcbeeb611a6d417924e9805",
            "identical": true
          },
          {
            "id": "p7b-reject-key-material",
            "kind": "negative",
            "predecessorSha256": "451243cc163ab62c8a01a50bb745047337724a822ee0c525ae917aedb969e1cb",
            "currentSha256": "451243cc163ab62c8a01a50bb745047337724a822ee0c525ae917aedb969e1cb",
            "identical": true
          },
          {
            "id": "p7b-reject-output-extension-mismatch",
            "kind": "negative",
            "predecessorSha256": "0e72436325f685457edb4327299085656bc15c920103586397188ada4f95f5df",
            "currentSha256": "0e72436325f685457edb4327299085656bc15c920103586397188ada4f95f5df",
            "identical": true
          },
          {
            "id": "p7b-reject-unsafe-path",
            "kind": "negative",
            "predecessorSha256": "1f463f11c0e4bde50ef8c617b51796354c69191a7c901227ba41f0773076907d",
            "currentSha256": "1f463f11c0e4bde50ef8c617b51796354c69191a7c901227ba41f0773076907d",
            "identical": true
          },
          {
            "id": "p7b-serializer-failure-unavailable",
            "kind": "negative",
            "predecessorSha256": "d69bb7457913132a2a97d7ec6a0aace73f4c9ad3de1e6d2a9cd23a734764de7a",
            "currentSha256": "d69bb7457913132a2a97d7ec6a0aace73f4c9ad3de1e6d2a9cd23a734764de7a",
            "identical": true
          },
          {
            "id": "p7b-custody-recorded",
            "kind": "persistence",
            "predecessorSha256": "3acb265dce9c3de725342a613bf0b532adc162b776d3555fee7820709fd9b4df",
            "currentSha256": "3acb265dce9c3de725342a613bf0b532adc162b776d3555fee7820709fd9b4df",
            "identical": true
          },
          {
            "id": "p7b-refresh-replace-reviewed",
            "kind": "persistence",
            "predecessorSha256": "912dfa23ee7400e92261c6513713484027350c724c8a52e773a9470ae6d49792",
            "currentSha256": "912dfa23ee7400e92261c6513713484027350c724c8a52e773a9470ae6d49792",
            "identical": true
          },
          {
            "id": "p7b-removal-reconciled",
            "kind": "persistence",
            "predecessorSha256": "387ac284a03675fd9cc9f02e32e6d363e43d2dc821a0a8ab84f08dc122337006",
            "currentSha256": "387ac284a03675fd9cc9f02e32e6d363e43d2dc821a0a8ab84f08dc122337006",
            "identical": true
          }
        ]
      }
    },
    "supplementaryComparison": {
      "recordedNode": "v26.12.1",
      "nodeBundledRootsSha256": "f65b49101e3ee627d21073de1368a495a36fd3fc75a3b368a932889a2cd75c84",
      "resultsSha256": "dc5bc2a6689303e6e99c7109d70e67a07794fed4e01bb18c3b1fb07e7599e204",
      "sets": [
        {
          "set": "root-a",
          "format": "pem",
          "certificates": 1,
          "bytesSha256": "b9b6a4c1f037bf97c561e55b55bd70d1e57a2ee566f4b752d43430931697f8c6"
        },
        {
          "set": "root-a",
          "format": "pkcs7-der",
          "certificates": 1,
          "bytesSha256": "b061c9b7c43e3ba18c3cab7613b0bcd54998a2f272702a6b508ef261b7612a28"
        },
        {
          "set": "root-b",
          "format": "pem",
          "certificates": 1,
          "bytesSha256": "fb15c08be41c7c4f6951ac63e84f5cb56b25b4d1511ffd9cddbe78b42acff695"
        },
        {
          "set": "root-b",
          "format": "pkcs7-der",
          "certificates": 1,
          "bytesSha256": "9ee682918d243227da2d2bcac6689e55d7769c5552adf67e603de8d209cd16a2"
        },
        {
          "set": "root-a+root-b",
          "format": "pem",
          "certificates": 2,
          "bytesSha256": "5e10c6a206c8331e649cc00a8cef880aae408f85f1c3834f012f8e624ae3f0d5"
        },
        {
          "set": "root-a+root-b",
          "format": "pkcs7-der",
          "certificates": 2,
          "bytesSha256": "2d9cc5511409772c44f5ba1daa0e20ae92bc2c07e21afd96191aa36043bd0e50"
        },
        {
          "set": "node-bundled-roots",
          "format": "pem",
          "certificates": 118,
          "bytesSha256": "448ea15f2d597b3b3124dcb16064c8f31acf1371ef71696b8ed98a5df4800048"
        },
        {
          "set": "node-bundled-roots",
          "format": "pkcs7-der",
          "certificates": 118,
          "bytesSha256": "716ef53657f796e3d59138945aca6cecf3cf4bc1e1581d999f6f419ca50bbd99"
        }
      ]
    },
    "scope": [
      "asn1js 3.0.10 to 4.1.0 and pkijs 3.4.1 to 4.0.1 with the hashed closure following the installed one",
      "hashed closure fails closed on an unhashed dependency",
      "explicit versioned v2 migration verification and v1 predecessor reader",
      "exact Windows 11 Dev build 29695.1001 export-host classification, matrix row and Apply recheck"
    ],
    "limits": [
      "equal outputs are proved only for the recorded finite fixture cases and supplementary sets, not for every possible certificate set",
      "library equivalence is output equivalence; asn1js and pkijs source is not compared",
      "no native, Windows store, Prepare or Apply execution was performed for this proof",
      "historical platforms are not re-executed; their original limitations are retained"
    ],
    "evidenceKind": "equivalence-migration",
    "newNativeExecutionCreated": false
  },
  "proofSha256": "4a262ca6360b5e588a9f7ba1d2671327c68055afea5fd89af3c4aedffe16965e"
});
