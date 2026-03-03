# TestClaw — AI-Powered Mobile App Testing

`testclaw` is a CLI tool that uses Claude to automatically understand your mobile app, generate tests from plain English, run them on iOS simulators, and self-heal when tests break.

You describe what to test in natural language. Claude reads your codebase, writes the test code, executes it, and when something breaks, figures out whether it's a real bug or just a UI change — and fixes the test automatically.

## Why this exists

Mobile app testing is painful. You write fragile UI tests that break every time a button moves. You spend more time maintaining tests than writing features. And when tests fail in CI, half the time it's because the test is stale, not because anything is actually broken.

`testclaw` flips this:

- **Write tests in English**, not Dart or YAML. Describe what should happen ("user logs in, sees the home screen") and Claude generates the actual test code.
- **Tests heal themselves.** When your app's UI changes, `testclaw` diffs the code, reads the new UI, and updates selectors and assertions automatically. Only real bugs get flagged.
- **Agentic failure analysis** — every test failure is automatically analyzed by Claude. It takes a screenshot of the simulator, looks at what's on screen, and tells you exactly why the test failed. No more guessing from stack traces.
- **Agentic testing** for flows that can't be scripted — OAuth popups, camera interactions, complex visual flows. Claude takes screenshots, reasons about what's on screen, and drives the app step by step.

It uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) under the hood, so Claude has full access to read your codebase, edit test files, and run commands — the same capabilities as Claude Code, but orchestrated programmatically.

## What it does

```
testclaw init --local ./my-flutter-app     # Analyze codebase, discover flows
testclaw suggest                           # Auto-generate test cases from discovered flows
testclaw add-test-ai "User can log in"     # Add more tests in plain English
testclaw generate                          # Claude writes the actual test code
testclaw build                             # Build app for iOS simulator
testclaw run                               # Run all tests
testclaw heal                              # Auto-fix broken tests
testclaw status                            # See results
```

`testclaw init` analyzes your codebase and discovers testable flows. `testclaw suggest` turns those into structured test cases — complete with steps, preconditions, element mappings, and priority levels. Add more at any time with `testclaw add-test-ai` using plain English.

## Prerequisites

- **macOS** with Xcode and iOS Simulators installed
- **[Bun](https://bun.sh)** v1.2+ — `curl -fsSL https://bun.sh/install | bash`
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** CLI — `npm install -g @anthropic-ai/claude-code`
- **Flutter** (if testing Flutter apps) — [install guide](https://docs.flutter.dev/get-started/install)
- **Maestro** (for Maestro-based and agentic tests) — `curl -fsSL "https://get.maestro.mobile.dev" | bash` (requires Java 17+)
- **Anthropic API key** — set as `ANTHROPIC_API_KEY` environment variable

```bash
# Verify prerequisites
claude --version        # Claude Code CLI
flutter --version       # Flutter SDK
xcrun simctl list       # iOS Simulators
maestro --version       # Maestro CLI
```

## Installation

### From source (recommended)

```bash
git clone https://github.com/agarwal-sumit/testclaw.git
cd testclaw
bun install
bun link                # Makes 'testclaw' available globally
```

Now you can run `testclaw` from anywhere.

### Run without installing

```bash
git clone https://github.com/agarwal-sumit/testclaw.git
cd testclaw
bun install
bun run src/index.ts --help       # Run directly
```

### Standalone binary

You can compile `testclaw` into a self-contained binary (~58 MB, includes the Bun runtime). This requires Claude Code CLI to be installed separately on the target machine.

```bash
bun run compile         # Produces ./testclaw binary
./testclaw --help       # Works anywhere on the same OS/arch
```

The binary embeds all dependencies except the Claude Code subprocess. Set `ANTHROPIC_API_KEY` and ensure the `claude` CLI is on your `PATH`.

## Getting Started

### 1. Initialize a project

```bash
# From an existing Flutter project directory
cd ~/my-flutter-app
testclaw init

# Or point to a directory
testclaw init --local ~/my-flutter-app

# Or clone from a git URL
testclaw init https://github.com/user/flutter-app.git
```

This does three things:
1. **Detects the framework** (Flutter, React Native)
2. **Analyzes the codebase** — Claude reads your source files and produces a map of screens, routes, widgets, API endpoints, and test identifiers
3. **Scaffolds a `.qa/` directory** with config, test case storage, and result directories

The analysis also discovers testable flows and stores them as suggestions. Run `testclaw suggest` next to turn them into test cases.

### 2. Generate test cases from suggestions

```bash
testclaw suggest
```

This takes every suggested flow from the analysis (auth, KYC, checkout, etc.) and asks Claude to produce a complete structured test case for each — with steps, preconditions, element mappings, and priority. Results are saved as YAML files in `.qa/testcases/`.

### 3. Add more test cases

Add tests anytime in plain English — Claude reads your codebase and generates the structured steps, selectors, and assertions:

```bash
testclaw add-test-ai "User can log in with valid email and password"
testclaw add-test-ai "User adds an item to cart and completes checkout"
testclaw add-test-ai "Verify the portfolio screen shows correct holdings after refresh"
```

Claude produces a complete test case YAML — you don't need to know widget keys or route names.

You can also include test data directly in the description:

```bash
testclaw add-test-ai "User logs in with phone 0100100001, receives OTP 0101, enters PIN 1234"
```

For full manual control, use `add-test` to specify every field yourself:

```bash
testclaw add-test \
  --suite auth \
  --name login-happy-path \
  --description "User can log in with valid email and password" \
  --priority critical \
  --type auto \
  --steps '[
    {"action":"input","target":"Email input field","value":"test@example.com","description":"Enter email address"},
    {"action":"tap","target":"Login button","description":"Submit login form"},
    {"action":"assert","target":"Home screen","value":"Welcome","description":"Verify home screen appears"}
  ]'
```

Or create YAML files directly in `.qa/testcases/<suite>/<name>.yaml`. A template is available at `templates/testcase.yaml`.

### 4. Generate test code

```bash
testclaw generate                   # Generate tests for all test cases
testclaw generate --suite auth      # Generate only for the auth suite
```

Claude reads your test cases + the codebase analysis and produces:
- **Flutter integration tests** in `.qa/tests/integration/` (Dart files)
- **Maestro flows** in `.qa/tests/maestro/` (YAML files)
- **Agentic instructions** in `.qa/tests/agentic/` (YAML files with test data and step instructions for Claude's screenshot→act loop)

The `type: auto` setting lets Claude decide the best test format based on complexity.

### 5. Build and install

```bash
testclaw build                      # Build for iOS simulator, auto-selects device
testclaw build --device <udid>      # Target a specific simulator
testclaw build --flavor dev         # Build with a specific flavor
testclaw build --dart-define ENV=staging   # Pass dart-define flags (repeatable)
```

This runs `flutter build ios --simulator --debug --no-codesign`, finds the `.app` bundle, and installs it on the simulator. If the build fails, Claude diagnoses the error.

### 6. Run tests

```bash
testclaw run                        # Run everything
testclaw run --suite auth           # Run one suite
testclaw run --type integration     # Run only integration tests
testclaw run --type maestro         # Run only Maestro tests
testclaw run --type agentic         # Run only agentic (screenshot-driven) tests
```

**When any test fails**, TestClaw automatically takes a screenshot and has Claude analyze what's on screen to give you a clear, visual explanation of the failure — not just a raw stack trace.

Results are saved to `.qa/results/runs/<timestamp>/` with screenshots, logs, agentic analysis, and a `summary.json`.

### 7. Self-heal broken tests

```bash
testclaw heal                       # Classify failures and auto-repair
testclaw heal --dry-run             # Classify only, don't change anything
```

For each failure, Claude:
1. Checks if element fingerprints changed
2. Diffs the source code since the last green run
3. Classifies the failure:
   - **real_bug** — the app has a genuine bug, flagged in results
   - **implementation_change** — UI changed intentionally, test gets updated automatically
   - **flaky** — timing issue, adds waits/retries
4. If confidence >= 80%, applies the fix and optionally re-runs to verify

### 8. Check status

```bash
testclaw status
```

Shows framework info, test case count, and last run results.

## Test types

| Type | How it works | Best for |
|------|-------------|----------|
| `integration` | Generates Dart `integration_test` files, runs via `flutter test` | Widget interactions, navigation, data validation |
| `maestro` | Generates Maestro YAML flows, runs via `maestro test` | Cross-app flows, multi-step UI journeys |
| `agentic` | Claude takes screenshots, reasons about the screen, executes Maestro commands in a loop. Gets an instruction file with test data (phone, OTP, PIN, etc.) | OAuth, camera, complex visual verification, flows that resist scripting |
| `auto` | Claude picks the best type based on test case complexity | Default — let the AI decide |

All test types benefit from **agentic failure analysis** — when any test fails, Claude automatically screenshots the simulator and explains what went wrong visually.

## Project structure

After `testclaw init`, your repo gets a `.qa/` directory:

```
your-app/.qa/
├── config.yaml                  # TestClaw settings
├── CLAUDE.md                    # Auto-generated project context for Claude
├── analysis/
│   └── app-structure.json       # Codebase analysis (screens, routes, etc.)
├── testcases/
│   └── auth/
│       └── login-happy-path.yaml
├── tests/
│   ├── integration/             # Generated Dart test files
│   ├── maestro/                 # Generated Maestro YAML flows
│   └── agentic/                 # Generated instruction files with test data
├── results/
│   ├── runs/<timestamp>/        # Screenshots, logs, analysis, summary per run
│   └── baselines/               # Baseline screenshots for visual regression
├── fingerprints/
│   └── elements.json            # Element fingerprints for self-healing
└── history/
    └── heal-log.json            # Healing audit trail
```

This directory is designed to be committed to git. Test results and healing history create a traceable audit trail.

## Configuration

`.qa/config.yaml`:

```yaml
framework: flutter
repoPath: /path/to/your/app
defaultTestType: auto
healingConfidenceThreshold: 0.8     # Only auto-heal if confidence >= this
maxAgenticTurns: 50                 # Max Claude turns for agentic tests
screenshotOnFailure: true
autoCommitResults: true             # Git commit after each run
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `CLAUDE_PATH` | No | Path to Claude Code executable (default: auto-detect) |
| `QA_USE_SYSTEM_CLAUDE` | No | Set to `1` to force using the system `claude` CLI |

## How it works under the hood

`testclaw` uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) to give Claude access to the same tools that power Claude Code:

- **Code analysis**: Claude uses `Read`, `Glob`, `Grep` to understand your app's structure
- **Test generation**: Claude uses `Read`, `Write`, `Edit` to produce runnable test files
- **Agentic testing**: Claude connects to a custom MCP server with `take_screenshot`, `maestro_execute`, and `get_app_logs` tools. It enters a screenshot-reason-act loop to drive the app
- **Failure analysis**: When any test fails, Claude takes a screenshot of the simulator and visually analyzes what went wrong
- **Self-healing**: Claude uses `Read`, `Grep`, `Edit` to classify failures and repair tests

Each AI operation runs with scoped permissions — the code analyzer can only read files, the test generator can read and write, and only the self-healer can edit existing tests.

## Full CLI reference

```
testclaw init [repo-url]                        Clone + analyze + scaffold
testclaw init --local <path>                    Analyze existing local repo
testclaw analyze                                Re-analyze codebase
testclaw suggest                                Generate test cases from analysis suggestions
testclaw add-test-ai "<description>"            Create a test case from plain English
testclaw add-test --suite <s> --name <n> ...    Create a test case manually with full control
testclaw generate [--suite <name>]              Generate test code from test cases
testclaw build [--device <udid>]                Build + install on simulator
testclaw run [--suite <s>] [--type <t>]         Run tests
testclaw heal [--dry-run]                       Classify + repair failures
testclaw status                                 Show status and last results
```

All commands support `--verbose` for debug logging.

## Limitations

- **iOS only** — no Android SDK support currently. The simulator manager wraps `xcrun simctl`.
- **Flutter-first** — React Native detection exists but test generation is optimized for Flutter.
- **Requires Claude Code CLI** — the Agent SDK spawns Claude Code as a subprocess. You need it installed and an API key set.
- **API costs** — each `analyze`, `generate`, or `heal` operation makes API calls to Claude. Costs depend on codebase size and number of test cases.

## Contributing

Contributions are welcome. The codebase is TypeScript, runs on Bun, and has no build step for development.

```bash
git clone https://github.com/agarwal-sumit/testclaw.git
cd testclaw
bun install
bun run src/index.ts --help     # Start developing
```

Key files:
- `src/orchestrator.ts` — main coordinator, delegates to all managers
- `src/utils/claude-sdk.ts` — thin wrapper around the Agent SDK
- `src/agentic-tester.ts` — the screenshot-reason-act loop with MCP tools + failure analysis
- `src/self-healer.ts` — failure classification and auto-repair pipeline

## License

MIT
