# Physics Lab — Mission Board

A web mechanics lab that turns a described situation into a validated MuJoCo model, previews it paused, then runs and inspects the actual simulation. `physics-lab` is the working repository name; Mission Board names the workspace.

## Development status

The experiment, playback, inspection and responsive workbench are implemented. The production build and 45 behavioral regressions pass. Actual Chromium/WASM checks include authenticated `openrouter/free` generation, native playback/reset, camera recovery, narrow layout and reduced motion. The learner reported an early assembly failure and requested the usability revision; their retry and final hands-on review remain in the [build checklist](devpost/checklist.md). The app is not declared ready to ship. OpenAI and Anthropic have not been exercised live.

The application never loads a pretend model when credentials are missing. Earlier browser checks used synthetic assembly responses only at the test boundary; the subsequent authenticated OpenRouter check used no interception or synthetic response. No fake provider is part of the app.

## Run locally

Requires Node 24.12 or later in the Node 24 line. Install the pinned dependencies:

```sh
npm ci
```

For generation, copy the secret-free `.env.example` to a private location outside this checkout, populate one provider key there, and link that file as the ignored local `.env`. An explicitly authorized process environment also works. Do not use coding-assistant OAuth credentials or a `VITE_` key. Neither keys nor the private learner profile belong in git.

Development uses two terminals:

```sh
npm run api
```

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. The frontend proxies `/api` to the loopback server on port 3001. Restart the API after changing credentials, then reload the page.

For the built local app:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. Do not start another API process on the same port. This is deliberately local-only; exposing an operator-funded model endpoint publicly requires a separate access/spending policy.

```sh
npm test
```

Tests use native Node HTTP and actual MuJoCo WASM, with no live provider calls or GPU requirement. Numerical fixtures are test data, not built-in product experiments.

## Use

1. Describe a mechanics situation, or fill an editable example prompt. Examples do not send a request or load a canned simulation.
2. Press Assemble scene. The configured free route is selected initially; expand Model settings to choose another provider/model. Answer a focused clarification if requested.
3. Check the paused interpretation, assumptions, geometry and initial object properties. Desktop inspection sits directly below the canvas; mobile stacks the workbench.
4. Press Run, use the slider or 0.1×/1×/10× shortcuts, and pause to inspect. Reset restores the initial state and view without another model call; Fit view frames the current objects without changing physics.
5. Submit another situation when needed. Failed or unsupported replacements preserve the previous experiment and prompt. Stop waiting cancels the local wait, not guaranteed upstream processing or billing.

Free models still require a key and have changing quotas, availability and output reliability. Paid models may charge the operator. There are no hidden repair calls, retries or paid fallbacks. Malformed output is rejected and unsupported physical requests are explained, never replaced with an invented simulation.

Complete scene, clarification and limitation decisions share one strict contract. Instructions include explicit branch examples; rejected schema output reports bounded field paths and issue codes, not response values. An elastic-versus-inelastic bounce request is explained as a current modeling limitation rather than silently dropping elasticity. The original reported invalid payload was not retained, so its exact violation is unknown.

## Physics and safety boundaries

- Mechanics only: explicit SI quantities and a Z-up reference frame. Other physics categories are future work, not functioning choices.
- Trusted model blocks include rigid primitives, point particles, articulations, supports, springs, routed tendons/cables, selected constraints and declared forces. The LLM supplies validated data, never unrestricted MJCF, code, plugins or external assets.
- MuJoCo uses regularized contact; independently chosen surface static/kinetic friction and an exact textbook restitution coefficient are not silently mapped to unrelated parameters.
- The current profile uses a 1 ms fixed timestep. Speed changes wall-time playback, not that timestep. Very stiff/high-frequency or extreme-scale models need additional numerical validation; this is not a universal accuracy guarantee.
- Contextual cards read the solver. Force rows, coordinate frames and path buffers are interpreted rather than presented as raw engine internals. Point particles do not acquire invented rotation or collision radii.
- Reference grids are visual aids, infinite planes display as patches, and point markers are not physical radii. Inspection is read-only; camera movement does not change physics.
- Oversized, invalid or numerically unstable models fail with an explanation. The app does not delete excess objects, suppress warnings or substitute another experiment.
- Provider keys stay on the server; prompts go to the selected provider under its policy. No prompt database or default scene persistence is included.

The official MuJoCo JS bindings are still marked WIP. The version is pinned. The viewer has a substantial initial JS bundle and downloads the WASM engine on first model preparation; build-size and upstream Node-branch externalization warnings are not hidden.

## Code and workflow

- `shared/scene.ts`, `shared/catalog.ts`: physical admission, provider decision contract and generated model instructions.
- `server/`: local API, safe built-file serving and the three real provider adapters.
- `src/physics/`: trusted MJCF compiler, MuJoCo lifecycle/observations and fixed-step clock.
- `src/`: Mission Board, actual Three.js canvas and read-only object cards.
- `tests/`: deterministic physical references, frame/force/path regressions, HTTP boundaries and provider error parsing.

Work follows the official [Devpost Learn Skill Pack](https://github.com/challengepost/learn-ai-basics), installed in `.agents/skills/` with source hashes in `skills-lock.json` and its MIT license preserved. [Scope](devpost/scope.md), [PRD](devpost/prd.md), [spec](devpost/spec.md) and [checklist](devpost/checklist.md) carry the decisions/progress. The personal learner profile is private and ignored; an ignore rule does not make AI conversations private or remove previously tracked material.
