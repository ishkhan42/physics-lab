# Physics Lab — Mission Board

A web mechanics lab that turns a described situation into a validated MuJoCo model, previews it paused, then runs and inspects the actual simulation. `physics-lab` is the working repository name; Mission Board names the workspace.

## Development status

The composable mechanics lab, material/contact implementation, physical default ground, playback, inspection and responsive light workbench are implemented. The production build and 62 behavioral regressions pass. Actual browser checks generated the original two-ball request with restitution 1/0, observed rebound versus settling, and exercised a genuine static/kinetic friction comparison, playback/reset and ground reactions. Final learner approval remains in the [build checklist](devpost/checklist.md). OpenAI and Anthropic have not been exercised live.

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
2. Press Assemble scene. A prominent activity panel shows elapsed time and the real interpreting/building phases, without a fabricated percentage. The configured free route is selected initially; expand Model settings to choose another provider/model.
3. Answer a focused question, or review a proposed supported revision. Use this setup only fills the editable draft; Assemble is a separate explicit action. Missing physical details must be clarified or explicitly defaulted with their actual values. Check the paused assumptions, geometry and initial object properties before Run.
   A physical plane at z=0 is included by default (ideal reference restitution 1, zero friction). Its height/material are explicit; `ground: null` is reserved for an explicitly groundless or custom-support setup. The reference grid is not the ground collider.
4. Press Run, use the slider or 0.1×/1×/10× shortcuts, and pause to inspect. Reset restores the initial state and view without another model call; Fit view frames the current objects without changing physics.
5. Submit another situation when needed. Failed or unsupported replacements preserve the previous experiment and prompt. Stop waiting cancels the local wait, not guaranteed upstream processing or billing.

Free models still require a key and have changing quotas, availability and output reliability. Paid models may charge the operator. There are no hidden repair calls, retries or paid fallbacks. Malformed output is rejected and unsupported physical requests are explained, never replaced with an invented simulation.

Scene, clarification and limitation decisions share one contract. Questions, explanations and one optional supported proposal may coexist while no scene is ready. A ready scene cannot include unresolved questions, limitations or proposals and still undergoes strict physical validation. Technical explanations sit behind a disclosure, rather than a raw response dump. The built-in `openrouter/free` route requests native JSON mode and parameter-aware routing; other explicit model IDs retain the JSON-text baseline. No output-repair call or paid fallback is added. Free-model semantic reliability still varies.

## Physics and safety boundaries

- Mechanics only: explicit SI quantities and a Z-up reference frame. Other physics categories are future work, not functioning choices.
- The LLM supplies validated data, never unrestricted MJCF, code, plugins or external assets. Elasticity/friction requests are modeled rather than downgraded to a no-bounce alternative.

| Mechanics family | Implemented model |
| --- | --- |
| Bodies and coordinates | Sphere, box, capsule, cylinder, ellipsoid, infinite plane and point particle; free, hinge, slide, ball and fixed motion; primitive-derived mass/inertia. |
| Materials and contacts | Elastic/partial/inelastic normal restitution targets; independent static and kinetic sliding friction; torsional/rolling resistance lengths. |
| Loads | Uniform gravity, force/torque at declared frames, one-time impulses, linear drag and bounded mutual point-particle gravity. |
| Springs, joints and connections | Joint/tendon springs and damping, limits, connect/weld/scalar couplings, fixed/slack/spring cords, geometric wraps and pulley branches. |
| Readouts | Native state/inertia, material values (including zero), linear momentum, translational kinetic energy, uniform-gravity potential, instantaneous world contact forces, joint spring/damping force/torque and cable tension. |

Pair restitution is `min(eA,eB)` and friction uses the component-wise maximum; the ideal default ground lets the ball's coefficient govern the requested rebound. A stated elastic body is e=1, not an arbitrary 0.8. Static friction prevents slip; an unconstrained sphere can still roll. Ground and model assumptions are inspectable.

The trusted contact profile maps restitution to MuJoCo's direct spring/damping law, with 16 native substeps inside each 1 ms playback tick when collisions are possible. Contact-free scenes retain 1 ms native stepping. Contact coefficients are numerical targets, not an exact hard-impact or universal accuracy guarantee. Regression cases measure e=0/0.5/1, momentum/energy in an isolated elastic collision, Coulomb deceleration, stiction, and elastic impact with friction. Contact forces are instantaneous; contact jitter and finite-step error can occur. Energy rows distinguish kinetic components and uniform gravity rather than claiming a universally conserved total.

- Broad composition is supported, but deformable bodies, adhesive sticking, continuum fluids, arbitrary force histories and arbitrary user solvers are not advertised. High-speed/small-scale, very stiff/high-frequency and large coupled-contact scenes need additional numerical validation. Point particles have no collision surface; contact materials require a colliding primitive.
- Reference grids are visual aids, infinite planes display as patches, and point markers are not physical radii. Inspection is read-only; camera movement does not change physics.
- Oversized, invalid or numerically unstable models fail with an explanation. The app does not delete excess objects, suppress warnings or substitute another experiment.
- Provider keys stay on the server; prompts go to the selected provider under its policy. No prompt database or default scene persistence is included.

The official MuJoCo JS bindings are still marked WIP. The version is pinned. The viewer has a substantial initial JS bundle and downloads the WASM engine on first model preparation; build-size and upstream Node-branch externalization warnings are not hidden.

## Code and workflow

- `shared/scene.ts`, `shared/catalog.ts`: physical admission, provider decision contract and generated model instructions.
- `server/`: local API, safe built-file serving and the three real provider adapters.
- `src/physics/`: trusted MJCF compiler, calibrated material/contact law, MuJoCo lifecycle/observations and playback clock.
- `src/`: Mission Board, actual Three.js canvas and read-only object cards.
- `tests/`: deterministic physical references, frame/force/path regressions, HTTP boundaries and provider error parsing.

Work follows the official [Devpost Learn Skill Pack](https://github.com/challengepost/learn-ai-basics), installed in `.agents/skills/` with source hashes in `skills-lock.json` and its MIT license preserved. [Scope](devpost/scope.md), [PRD](devpost/prd.md), [spec](devpost/spec.md) and [checklist](devpost/checklist.md) carry the decisions/progress. The personal learner profile is private and ignored; an ignore rule does not make AI conversations private or remove previously tracked material.
