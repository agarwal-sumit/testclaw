# TestClaw — Mobile QA Test Agent

AI-powered mobile app testing CLI using Claude Code Agent SDK.

## Project Structure
- `src/` - TypeScript source code
- `src/utils/` - Shared utilities (Claude SDK wrapper, logger, git helpers)
- `templates/` - Template files for test cases

## Tech Stack
- Runtime: Bun
- Language: TypeScript
- AI: Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- CLI: Commander.js
- Test frameworks: Flutter integration tests, Maestro

## Commands
- `testclaw init <repo-url>` - Initialize TestClaw for a Flutter repo
- `testclaw analyze` - Analyze codebase with Claude
- `testclaw suggest` - Generate test cases from analysis suggestions
- `testclaw add-test` - Create a test case manually
- `testclaw add-test-ai` - Create a test case from plain English
- `testclaw generate` - Generate automated tests from English test cases
- `testclaw build` - Build and install app on simulator
- `testclaw run` - Run tests
- `testclaw heal` - Self-heal broken tests
- `testclaw status` - Show test suite status
