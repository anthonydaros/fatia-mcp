# Agent instructions for bambu-printer-mcp

Read [AGENTS.md](../AGENTS.md) at the repository root. It is the shared source of truth; do not duplicate or override its release ordering, validation requirements, slicer safety, or Blender MCP rules here.

This server holds no printer credentials. Set BAMBU_MODEL explicitly to an empty string when testing missing-model behavior so dotenv cannot supply the user's printer model.
