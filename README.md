# Physics Lab — Mission Board

A web mechanics lab that turns a described situation into a validated MuJoCo model, previews it paused, then runs and inspects the actual simulation. `physics-lab` is the working repository name; Mission Board names the workspace.

## Development status

The composable mechanics lab, restitution/friction, ground, playback, motion graphs and light workbench are implemented. Scenes now have durable, shareable URLs and 24-hour sliding retention. The production build and 89 behavioral checks pass. Browser/API checks exercised saved setup restoration, clean-browser sharing, process restart, run renewal, exact expiry, ground-choice forks and recovery; earlier authenticated mechanics references remain below. Free-provider latency and interpretation still require review. Final learner approval remains in the [build checklist](devpost/checklist.md); OpenAI and Anthropic have not been exercised live.

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
2. Press Assemble scene. A prominent activity panel shows elapsed time and real model generation, validation, correction/reconnection when necessary, and native preparation, without a fabricated percentage. The default is the explicitly named free `nvidia/nemotron-3.5-super-vl:free` model; the random free router remains an opt-in choice in Model settings.
3. Review the paused model, its choices and initial object values before Run. Missing physical details are clarified or sensibly defaulted with actual values and units. When the request cannot be modeled exactly, the app should make the closest meaningful Mechanics approximation and explicitly name what it cannot reproduce in an **Approximate model. Review before running.** notice. Scene notes (summary, assumptions, ground) sit directly below the canvas. A necessary question or editable proposal remains available when no meaningful model can be assembled.
   A physical plane at z=0 is included by default (ideal reference restitution 1, zero friction). Existing upward horizontal planes also count as physical ground, avoiding duplicate floors. If a model proposes neither, the default ground is kept and noted; switch **Ground** off on the canvas for free flight. Toggling rebuilds the paused scene locally with no model request. The reference grid is not the ground collider.
4. Press Run (or Space), use the slider or 0.1×/1×/10× shortcuts, and pause to inspect. Moving bodies leave a trail; small or distant bodies keep a ring marker so they never vanish; **Follow** (on by default) keeps bodies and paths in frame and switches off when you orbit or zoom yourself. The grid grows with the scene and the canvas shows its square size. If a device cannot keep up with the selected speed, the run continues more slowly and says so; no physics step is skipped. **Motion over time** graphs height, speed and translational kinetic energy of each moving body from real solver samples (about 20 per second; brief impacts can fall between samples). Reset (R) restores the initial state, view, trails and graphs without another model call; Fit (F) frames objects and their paths without changing physics.
5. Submit another situation when needed. Failed or unsupported replacements preserve the previous experiment and prompt. Stop waiting cancels the local wait; requests already sent upstream may continue processing or billing, but a disconnected client cannot initiate another automatic correction/recovery call.
6. **Recent scenes** keeps up to eight links on this browser across refreshes. Opening one fetches the current saved record without another model request; a cached expiry never overrides renewal by another viewer.

Free models require a key and have changing quotas, availability and latency. Allow up to two minutes per attempt. Paid models may charge the operator. Assembly makes at most two model calls total, always to your selected model: the initial request plus exactly one of a validation correction (which receives the app's own failed physics rule), a recovery attempt after a temporary HTTP 5xx failure, or a review of an “unsupported” verdict that asks for the closest buildable or labelled approximate model. A failed review keeps the original verdict. This is disclosed before submission and shown in progress. Refusals, quota/auth failures, timeouts and truncated responses are not retried. There is no hidden paid fallback, unconstrained-output retry or canned experiment.

Scene, clarification and limitation decisions share one contract. Questions, explanations and one optional supported proposal may coexist while no scene is ready. A ready scene has no unresolved questions or proposals and still undergoes strict physical validation; an explicit approximation is separate metadata, not permission to weaken that validation. Technical diagnostics sit behind a disclosure rather than becoming the main response. Selecting a proposal only fills the editable draft; it does not send a request.

The provider wire format uses a strict `{decision: ...}` envelope with mutually exclusive scene/clarify/unsupported branches. A ready scene cannot carry unresolved-question/limitation metadata by construction. The server unwraps this to the existing public API decision format.

All adapters request native structured output derived from the shared schema, rather than relying on JSON-only prompting. OpenAI/OpenRouter preserve fixed tuple lengths, enums, patterns and supported numeric limits; Anthropic uses its supported subset with exact tuple-object transport restored before full local validation. Native schemas retain the catalog's physical descriptions. Generated jointed-body poses are initial poses with scalar joint coordinates starting at zero, avoiding double application of initial displacement. OpenRouter requires parameter-capable routing. Discovery is cached five minutes; advertised reasoning controls use a 2048-token reasoning budget, low/minimal effort when available, or disable optional unbounded reasoning when the model explicitly supports that. Unknown capabilities retain provider defaults. Native schema constraints still cannot prove correct interpretation or every physical invariant.

## Saved scenes and sharing

- Ready scenes receive an unguessable `/scenes/<uuid>` URL. **Copy link** shares the saved setup; clipboard-denied browsers get a selectable link instead.
- Records start with 24 hours of retention. Run/Resume renews it, active runs send one-minute heartbeats, and Pause records the final activity. The server uses elapsed hours, not a calendar-day cutoff.
- Opening, sharing, paused Reset and Fit do not renew retention. Expired links become unavailable at the deadline and cannot be resurrected by Run; a still-open local setup can be saved as a new copy.
- Refresh or another browser restores the original prompt, assumptions and actual ground choice at the initial paused state. Current trajectories, graphs, camera and playback position are not saved.
- Setup changes such as Ground create a new URL. Existing shared definitions are immutable, so another viewer cannot overwrite them.
- Link holders can view the prompt, assumptions and setup and run the scene. There is no public directory or account system; treat the link as access permission. Provider settings and credentials are not part of a saved record.

The server uses Node 24's built-in SQLite, with no separate database service. The default is the private OS application-data folder (`~/.local/share/physics-lab/scenes.sqlite` on Linux). `SCENE_DB_PATH` can select another persistent private file **outside the source tree**. Keep that path consistent across restarts. New directories are mode 0700; existing directories must already be private, and database files are mode 0600. Do not commit live data or copy it into public project assets.

Expired rows are purged at startup and once a minute; expired records are inaccessible immediately, independently of cleanup. Storage failures preserve the previous usable preview and offer a local retry without another inference request. Client storage requests have a 15-second deadline. Local browser history contains link metadata only, not scene definitions.

Links work wherever the app is reachable. The default server is still loopback-only: a localhost link is not a public Internet deployment. No Host/Origin guard or provider-spending boundary is relaxed by this feature.

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
- Provider keys stay on the server; prompts go to the selected provider under its policy. Saved-scene records include the source prompt and validated setup until expiry, not credentials, provider settings or a conversation transcript.

The official MuJoCo JS bindings are still marked WIP. The version is pinned. The viewer has a substantial initial JS bundle and downloads the WASM engine on first model preparation; build-size and upstream Node-branch externalization warnings are not hidden.

## Code and workflow

- `shared/scene.ts`, `shared/catalog.ts`: physical admission, provider decision contract and generated model instructions.
- `server/`: local API, safe built-file serving and the three real provider adapters.
- `src/physics/`: trusted MJCF compiler, calibrated material/contact law, MuJoCo lifecycle/observations and playback clock.
- `src/`: Mission Board, actual Three.js canvas and read-only object cards.
- `tests/`: deterministic physical references, frame/force/path regressions, HTTP boundaries and provider error parsing.

Work follows the official [Devpost Learn Skill Pack](https://github.com/challengepost/learn-ai-basics), installed in `.agents/skills/` with source hashes in `skills-lock.json` and its MIT license preserved. [Scope](devpost/scope.md), [PRD](devpost/prd.md), [spec](devpost/spec.md) and [checklist](devpost/checklist.md) carry the decisions/progress. The personal learner profile is private and ignored; an ignore rule does not make AI conversations private or remove previously tracked material.
