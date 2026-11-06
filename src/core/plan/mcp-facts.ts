// Core's own facts about each known client's MCP configuration: where its MCP servers live (`places.mcp`) and the
// field names of one server entry (`mcpFile`), as Catalog 26df4c0's shipped tool profiles describe them. A request's
// profile for one of these clients never redefines them: the MCP binding and labels use these facts.
import type { Json } from '../types.js';

export const MCP_FACTS: Readonly<Record<string, { places: Record<string, Json>; mcpFile: Record<string, Json> }>> = Object.freeze(
  {
    "antigravity": {
      "places": {
        "project": {
          "file": ".agents/mcp_config.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "headers",
            "url": "serverUrl"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env"
        }
      }
    },
    "claude-code": {
      "places": {
        "project": {
          "file": ".mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        },
        "user": {
          "file": ".claude.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "sse": {
            "headers": "headers",
            "set": {
              "type": "sse"
            },
            "url": "url"
          },
          "streamable-http": {
            "headers": "headers",
            "set": {
              "type": "http"
            },
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env",
          "set": {
            "type": "stdio"
          }
        }
      }
    },
    "codex": {
      "places": {
        "project": {
          "file": ".codex/config.toml",
          "format": "toml",
          "key": "mcp_servers.<name>"
        },
        "user": {
          "file": ".codex/config.toml",
          "format": "toml",
          "key": "mcp_servers.<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "http_headers",
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env"
        },
        "tools": {
          "disabled": "disabled_tools",
          "enabled": "enabled_tools"
        }
      }
    },
    "copilot": {
      "places": {
        "project": {
          "file": ".github/mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        },
        "user": {
          "file": ".copilot/mcp-config.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "sse": {
            "headers": "headers",
            "set": {
              "type": "sse"
            },
            "url": "url"
          },
          "streamable-http": {
            "headers": "headers",
            "set": {
              "type": "http"
            },
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env",
          "set": {
            "type": "stdio"
          }
        },
        "tools": {
          "enabled": "tools"
        }
      }
    },
    // dsh keeps no MCP servers (Catalog 26df4c0 gives it no MCP place or entry shape): Core's fixed names only.
    "dsh": { "places": {}, "mcpFile": {} },
    "cursor": {
      "places": {
        "project": {
          "file": ".cursor/mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "headers",
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env"
        }
      }
    },
    "kimi": {
      "places": {
        "project": {
          "file": ".kimi-code/mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "headers",
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env"
        }
      }
    },
    "kiro": {
      "places": {
        "project": {
          "file": ".kiro/settings/mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        },
        "user": {
          "file": ".kiro/settings/mcp.json",
          "format": "json",
          "key": "/mcpServers/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "headers",
            "url": "url"
          }
        },
        "stdio": {
          "args": "args",
          "command": "command",
          "env": "env"
        },
        "tools": {
          "disabled": "disabledTools"
        }
      }
    },
    "opencode": {
      "places": {
        "project": {
          "file": "opencode.json",
          "format": "json",
          "key": "/mcp/<name>"
        }
      },
      "mcpFile": {
        "remote": {
          "streamable-http": {
            "headers": "headers",
            "set": {
              "type": "remote"
            },
            "url": "url"
          }
        },
        "stdio": {
          "argv": "command",
          "env": "environment",
          "set": {
            "type": "local"
          }
        }
      }
    }
  }
);
