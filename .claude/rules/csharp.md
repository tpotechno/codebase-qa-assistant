---
# .claude/rules/csharp.md
# The "paths" field limits this file to C# work, so it isn't loaded for Angular files
paths:
  - "**/*.cs"
  - "**/*.csproj"
---
# C# / .NET 10 standards
- Target net10.0; nullable reference types enabled; treat warnings as errors
- File-scoped namespaces; primary constructors for DI-only classes
- Async all the way: no .Result / .Wait(); pass CancellationToken through
- When unsure about a .NET 10 API, look it up with the Microsoft Learn MCP tools before writing code